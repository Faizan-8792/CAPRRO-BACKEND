// tools/ai-eval.mjs
//
// W11 IN6 (2026-10-21): measures each model-backed W11 task against its frozen evaluation set, live, with the key
// already configured (DEEPSEEK_API_KEY in capro-backend/.env - no new variable). "Reliable" is a number here, not
// a claim: precision where the model answered, how often it abstained, and how often it answered where the right
// answer was CANNOT_TELL (false-confident), plus tokens and an estimated cost.
//
// The request is built exactly as production builds it: the same fixed rules (COMMON_SYSTEM), the task's own
// system text, buildTaskPrompt, the same PII redaction, JSON mode, thinking disabled, and the task's validator on
// every answer. Calls are not metered in ProviderUsage (no user, no database): this is a developer tool, like the
// extension's test-classifier --llm.
//
//   node tools/ai-eval.mjs --task gst_cause_residue        one task
//   node tools/ai-eval.mjs --all                            all four
//   node tools/ai-eval.mjs --all --strict                   exit 1 if any task misses the ship bar
//
// Ship bar (INTELLIGENCE-PLAN-2026-10-21.md section 4.3): precision >= 85% and false-confident <= 5%. A task that
// misses it keeps its model half off (`modelOff` in src/services/ai/tasks/index.js).
//
// Ends with process.exitCode, never process.exit(): on Node 24 under Windows process.exit() after fetch aborts with
// 0xC0000409 (CLAUDE.md section 12).

import "dotenv/config";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const only = args.includes("--task") ? args[args.indexOf("--task") + 1] : null;

const { COMMON_SYSTEM, buildTaskPrompt } = await import("../src/services/ai/ai-task.service.js");
const { getAiTask, AI_TASK_NAMES } = await import("../src/services/ai/tasks/index.js");
const { parseJsonObject, redactPII } = await import("../src/services/deepseek-provider.service.js");
const { resolveDeepSeekModel, estimateDeepSeekCostUsd } = await import("../src/services/ai/deepseek-models.js");
const { AiAnswerInvalid } = await import("../src/services/ai/ai-validate.js");

const PRECISION_BAR = 0.85;
const FALSE_CONFIDENT_BAR = 0.05;
const ENDPOINT = process.env.DEEPSEEK_URL || "https://api.deepseek.com/chat/completions";
const MODEL = resolveDeepSeekModel(process.env.DEEPSEEK_MODEL);

async function ask(task, batch) {
  const body = {
    model: MODEL,
    messages: [
      { role: "system", content: `${COMMON_SYSTEM}\n\n${task.system}` },
      { role: "user", content: redactPII(buildTaskPrompt(task, batch)) },
    ],
    temperature: task.temperature,
    max_tokens: task.maxTokensFor(batch.length),
    thinking: { type: "disabled" },
    response_format: { type: "json_object" },
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      const response = await fetch(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` }, body: JSON.stringify(body), signal: controller.signal });
      if (response.status === 429 || response.status >= 500) {
        await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
        continue;
      }
      if (!response.ok) return { ok: false, status: response.status, usage: null };
      const payload = await response.json();
      return { ok: true, content: payload?.choices?.[0]?.message?.content || "", usage: payload?.usage || null };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, status: 0, usage: null };
}

// ─── scorers: { answered, correct, cannotCase, falseConfident, valid } per case ───
const SCORERS = {
  gst_cause_residue(expect, result) {
    const cannotCase = expect.acceptable.length === 1 && expect.acceptable[0] === "CANNOT_TELL";
    if (!result.valid) return { valid: false, answered: false, correct: false, cannotCase, falseConfident: false };
    const answered = result.output.cause !== "CANNOT_TELL";
    return { valid: true, answered, correct: answered && expect.acceptable.includes(result.output.cause), cannotCase, falseConfident: cannotCase && answered };
  },
  import_mapping_suggest(expect, result) {
    const want = expect.mappings.ledgerName;
    const cannotCase = want === "NONE";
    if (!result.valid) return { valid: false, answered: false, correct: false, cannotCase, falseConfident: false };
    const got = result.output.mappings.find((entry) => entry.field === "ledgerName")?.headingRef || "NONE";
    const answered = got !== "NONE";
    return { valid: true, answered, correct: answered && got === want, cannotCase, falseConfident: cannotCase && answered };
  },
  supplier_chase_draft(expect, result) {
    if (!result.valid) return { valid: false, answered: false, correct: false, cannotCase: false, falseConfident: false };
    const text = `${result.output.subject || ""} ${result.output.message}`;
    const devanagari = /[ऀ-ॿ]/.test(text);
    let correct = expect.script === "devanagari" ? devanagari : !devanagari;
    if (expect.hinglish) correct = correct && /\b(kripya|aapke|aapka|hai|hain|nahi|karein|kar|ji|humare|hamare|abhi|mein)\b/i.test(text);
    return { valid: true, answered: true, correct, cannotCase: false, falseConfident: false };
  },
  tds_action_draft(expect, result) {
    const cannotCase = expect.cannotTell === true;
    if (!result.valid) return { valid: false, answered: false, correct: false, cannotCase, falseConfident: false };
    const answered = !result.abstained;
    return { valid: true, answered, correct: answered && !cannotCase && result.output.reviewerNote.length > 0, cannotCase, falseConfident: cannotCase && answered };
  },
};

async function evaluate(taskName) {
  const task = getAiTask(taskName);
  const set = JSON.parse(readFileSync(new URL(`../tests/fixtures/ai/${taskName}.json`, import.meta.url), "utf8"));
  const tokens = { promptTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, completionTokens: 0 };
  const scores = [];
  let calls = 0;
  let failedCalls = 0;
  const examples = [];
  for (let start = 0; start < set.cases.length; start += task.batchSize) {
    const batch = set.cases.slice(start, start + task.batchSize).map((entry) => ({ id: entry.id, facts: entry.facts, expect: entry.expect }));
    const response = await ask(task, batch);
    calls += 1;
    if (response.usage) {
      tokens.promptTokens += response.usage.prompt_tokens || 0;
      tokens.cacheHitTokens += response.usage.prompt_cache_hit_tokens || 0;
      tokens.cacheMissTokens += response.usage.prompt_cache_miss_tokens || 0;
      tokens.completionTokens += response.usage.completion_tokens || 0;
    }
    if (!response.ok) failedCalls += 1;
    const parsed = response.ok ? parseJsonObject(response.content) : null;
    const items = new Map((Array.isArray(parsed?.items) ? parsed.items : []).filter((item) => item && typeof item.id === "string").map((item) => [item.id, item]));
    for (const entry of batch) {
      const item = items.get(entry.id);
      let result = { valid: false };
      if (item) {
        try {
          const { output, abstained } = task.validate(item, entry.facts);
          result = { valid: true, output, abstained };
        } catch (error) {
          if (!(error instanceof AiAnswerInvalid)) throw error;
          result = { valid: false, reason: error.message };
        }
      }
      const score = SCORERS[taskName](entry.expect, result);
      scores.push(score);
      if ((!score.correct && score.answered) || score.falseConfident || !score.valid) {
        if (examples.length < 4) examples.push({ id: entry.id, valid: score.valid, reason: result.reason || "", got: result.output ? JSON.stringify(result.output).slice(0, 160) : "(no answer)" });
      }
    }
  }
  const answered = scores.filter((s) => s.answered);
  const cannot = scores.filter((s) => s.cannotCase);
  const precision = answered.length ? answered.filter((s) => s.correct).length / answered.length : 0;
  const falseConfident = cannot.length ? cannot.filter((s) => s.falseConfident).length / cannot.length : null;
  const abstainRate = scores.filter((s) => s.valid && !s.answered).length / scores.length;
  const invalidRate = scores.filter((s) => !s.valid).length / scores.length;
  const meetsBar = precision >= PRECISION_BAR && (falseConfident === null || falseConfident <= FALSE_CONFIDENT_BAR);
  return { task: taskName, model: MODEL, cases: scores.length, calls, failedCalls, precision, answered: answered.length, abstainRate, invalidRate, falseConfident, cannotCases: cannot.length, tokens, estimatedUsd: estimateDeepSeekCostUsd(tokens), meetsBar, examples };
}

async function main() {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error("DEEPSEEK_API_KEY is not set in capro-backend/.env; nothing was evaluated.");
    return 2;
  }
  const names = only ? [only] : args.includes("--all") ? AI_TASK_NAMES : [];
  if (!names.length || names.some((name) => !getAiTask(name))) {
    console.error(`Choose --task <${AI_TASK_NAMES.join("|")}> or --all.`);
    return 2;
  }
  let missed = 0;
  for (const name of names) {
    const r = await evaluate(name);
    const pct = (value) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);
    console.log(`${r.task} (${r.model}): ${r.cases} cases, ${r.calls} calls (${r.failedCalls} failed)`);
    console.log(`  precision ${pct(r.precision)} of ${r.answered} answered | abstained ${pct(r.abstainRate)} | refused by validation ${pct(r.invalidRate)} | false-confident ${pct(r.falseConfident)} of ${r.cannotCases} CANNOT_TELL cases`);
    console.log(`  tokens ${r.tokens.promptTokens} in (${r.tokens.cacheHitTokens} cache hit) / ${r.tokens.completionTokens} out | about $${r.estimatedUsd.toFixed(4)} at deepseek-flash peak prices`);
    console.log(`  ship bar (precision >= 85%, false-confident <= 5%): ${r.meetsBar ? "MET" : "NOT MET"}`);
    for (const example of r.examples) console.log(`    e.g. ${example.id}: ${example.valid ? "" : `refused (${example.reason}) `}${example.got}`);
    if (!r.meetsBar) missed += 1;
  }
  return strict && missed ? 1 : 0;
}

process.exitCode = await main();
