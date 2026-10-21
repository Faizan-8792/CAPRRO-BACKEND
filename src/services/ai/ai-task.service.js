// src/services/ai/ai-task.service.js
//
// W11 IN5 (2026-10-21): the one way a W11 feature asks DeepSeek for anything. Before this, every AI feature
// carried its own prompt building, parsing, consent check and storage; a fix to one never reached the others
// (CLAUDE.md section 11). Every W11 task goes through runAiTask, which in order:
//
//   1. refuses before any outbound call unless the `intelligence` flag is on, the firm has opted in
//      (Firm.aiDrafting) and the request says consent: true;
//   2. answers each unit it has answered before (same task, prompt version and facts) from AiDraft, without
//      calling again;
//   3. sends the rest in batches, fixed instructions first and the facts last, so DeepSeek's prefix cache can
//      serve the fixed part (a cache hit is billed at about 1/50 of a miss);
//   4. validates each answer with the task's own validator (ai-validate.js: enums, fields that were sent, no
//      number the server did not send, no link, known slots only) and keeps nothing that fails;
//   5. stores each accepted answer as an AiDraft, PENDING, expiring in 30 days unless adopted.
//
// Abstaining (CANNOT_TELL) is a valid answer and is stored like any other. Nothing here writes to the record a
// draft is about: a draft becomes part of a reconciliation item, an action plan or a mapping only through that
// record's own route, when a person saves it.

import crypto from "node:crypto";
import AppConfig from "../../models/AppConfig.js";
import Firm from "../../models/Firm.js";
import AiDraft, { AI_DRAFT_OUTCOMES, AI_DRAFT_RETENTION_DAYS } from "../../models/AiDraft.js";
import AiSuggestionOutcome, {
  SUGGESTION_OUTCOME_FIELDS,
  SUGGESTION_SURFACES,
} from "../../models/AiSuggestionOutcome.js";
import { callDeepSeek, parseJsonObject } from "../deepseek-provider.service.js";
import { AiAnswerInvalid, isPlainObject } from "./ai-validate.js";
import { getAiTask } from "./tasks/index.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// The rules every task's model is held to, sent first in every system prompt. Fixed text: it is the start of
// the cached prefix, so it must not vary per request.
export const COMMON_SYSTEM = [
  "You assist chartered accountants in India by drafting, never deciding.",
  "Rules that apply to every answer:",
  "1. Answer with one JSON object only, exactly in the shape the instructions give.",
  "2. Use only the facts provided. Never invent a fact, an amount, a date, a name, a section or a case.",
  "3. Never write a number in free text. Refer to amounts and dates by what they are, not by their value.",
  "4. When the facts do not support an answer, answer CANNOT_TELL. A wrong answer costs the user more than no answer.",
  "5. Placeholders written like {{name}} are filled in later by the software. Use only the ones the instructions list.",
  "6. No links, no legal citations, no promises about outcomes.",
].join("\n");

function httpError(statusCode, message, code = "") {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

export function hashFacts(taskName, promptVersion, facts) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical({ task: taskName, promptVersion, facts })))
    .digest("hex");
}

function utcDay(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/**
 * Whether model drafts may be asked for at all, for this firm, right now. Throws the public refusal; returns
 * nothing when allowed. Called before any outbound call, and also by the settings route to describe the state.
 */
export async function assertAiAllowed({ firmId, consent }) {
  // Read fresh, not from the settings cache: switching the flag off must stop the next call, not one a
  // cache lifetime later.
  if (!(await AppConfig.isFeatureEnabled("intelligence", { fresh: true }))) {
    throw httpError(404, "Feature unavailable", "AI_FEATURE_OFF");
  }
  const firm = await Firm.findOne({ _id: firmId, isActive: true }).select("aiDrafting").lean();
  if (!firm?.aiDrafting?.enabled) {
    // One line, so the public-code scan (tests/error-contract-invariants.mjs) can see the code is thrown.
    throw httpError(403, "Model drafts are not switched on for this firm. A firm owner or admin can switch them on in firm settings.", "AI_DRAFTING_OFF_FOR_FIRM");
  }
  if (consent !== true) {
    throw httpError(400, "Confirm that these facts may be sent to DeepSeek before asking for a draft.", "AI_CONSENT_REQUIRED");
  }
}

function serializeDraft(draft, { replayed = false } = {}) {
  return {
    id: String(draft._id),
    task: draft.task,
    promptVersion: draft.promptVersion,
    subject: { kind: draft.subject?.kind || "", id: draft.subject?.id || "" },
    output: draft.output,
    abstained: Boolean(draft.abstained),
    outcome: draft.outcome,
    model: draft.model || "",
    createdAt: draft.createdAt ? new Date(draft.createdAt).toISOString() : null,
    replayed,
    label: "DRAFT FOR REVIEW",
  };
}

async function storeDraft({ firmId, userId, task, unit, inputHash, output, abstained, model }) {
  const now = new Date();
  try {
    const created = await AiDraft.create({
      firmId,
      task: task.name,
      promptVersion: task.promptVersion,
      inputHash,
      subject: { kind: unit.subject?.kind || "", id: String(unit.subject?.id || unit.id).slice(0, 200) },
      output,
      abstained,
      model: model || "",
      createdBy: userId || null,
      expiresAt: new Date(now.getTime() + AI_DRAFT_RETENTION_DAYS * DAY_MS),
    });
    return created.toObject();
  } catch (error) {
    // Two requests asked the same question at once: the other one's draft is the answer.
    if (error?.code === 11000) {
      const existing = await AiDraft.findOne({
        firmId,
        task: task.name,
        promptVersion: task.promptVersion,
        inputHash,
      }).lean();
      if (existing) return existing;
    }
    throw error;
  }
}

// Exported for tools/ai-eval.mjs, so the evaluation sends exactly what production sends.
export function buildTaskPrompt(task, batch) {
  const input = { items: batch.map((unit) => ({ id: unit.id, ...unit.facts })) };
  return `${task.instructions}\n\nINPUT (json):\n${JSON.stringify(input)}`;
}
const buildPrompt = buildTaskPrompt;

/**
 * Runs one AI task over a list of units, each { id, facts, subject: { kind, id } }. `id` must be unique in the
 * list and is what the model answers against. Returns:
 *   { available, results: [{ unitId, draft }], failed: [{ unitId, reason }], note }
 * `available` is false when the model could not be reached or answered nothing usable for any unit; the
 * caller then shows its rule-based or template answer and says so.
 */
export async function runAiTask({ taskName, firmId, userId, consent, units }) {
  const task = getAiTask(taskName);
  if (!task) throw new Error(`Unknown AI task ${taskName}`);
  if (!Array.isArray(units) || !units.length) {
    throw httpError(400, "Choose at least one item to draft for.", "AI_NOTHING_SELECTED");
  }
  if (units.length > task.maxUnits) {
    throw httpError(400, `Choose at most ${task.maxUnits} items at a time.`, "AI_TOO_MANY_ITEMS");
  }
  const ids = units.map((unit) => String(unit.id));
  if (new Set(ids).size !== ids.length) throw new Error("runAiTask: unit ids must be unique");

  await assertAiAllowed({ firmId, consent });

  if (task.modelOff) {
    return { available: false, results: [], failed: [], note: task.modelOffNote || "Drafts are not offered for this yet." };
  }

  const hashed = units.map((unit) => ({ ...unit, id: String(unit.id), inputHash: hashFacts(task.name, task.promptVersion, unit.facts) }));
  const existing = await AiDraft.find({
    firmId,
    task: task.name,
    promptVersion: task.promptVersion,
    inputHash: { $in: hashed.map((unit) => unit.inputHash) },
  }).lean();
  const byHash = new Map(existing.map((draft) => [draft.inputHash, draft]));

  const results = [];
  const failed = [];
  const pending = [];
  for (const unit of hashed) {
    const stored = byHash.get(unit.inputHash);
    if (stored) results.push({ unitId: unit.id, draft: serializeDraft(stored, { replayed: true }) });
    else pending.push(unit);
  }

  let reachedModel = pending.length === 0;
  for (let start = 0; start < pending.length; start += task.batchSize) {
    const batch = pending.slice(start, start + task.batchSize);
    let answer = null;
    let model = "";
    try {
      const response = await callDeepSeek({
        system: `${COMMON_SYSTEM}\n\n${task.system}`,
        prompt: buildPrompt(task, batch),
        jsonResponse: true,
        maxTokens: task.maxTokensFor(batch.length),
        temperature: task.temperature,
        timeoutMs: task.timeoutMs || 25000,
        maxAttemptsPerModel: 1,
        userId,
        operation: task.operation,
      });
      if (response.ok) {
        reachedModel = true;
        model = response.model || "";
        answer = parseJsonObject(response.content);
      }
    } catch {
      answer = null;
    }
    const items = isPlainObject(answer) && Array.isArray(answer.items) ? answer.items : null;
    if (!items) {
      for (const unit of batch) failed.push({ unitId: unit.id, reason: "No usable answer came back." });
      continue;
    }
    const answered = new Map();
    for (const item of items) {
      if (isPlainObject(item) && typeof item.id === "string" && !answered.has(item.id)) answered.set(item.id, item);
    }
    for (const unit of batch) {
      const item = answered.get(unit.id);
      if (!item) {
        failed.push({ unitId: unit.id, reason: "The model did not answer this item." });
        continue;
      }
      try {
        const { output, abstained } = task.validate(item, unit.facts);
        const draft = await storeDraft({ firmId, userId, task, unit, inputHash: unit.inputHash, output, abstained, model });
        results.push({ unitId: unit.id, draft: serializeDraft(draft) });
      } catch (error) {
        if (error instanceof AiAnswerInvalid) {
          failed.push({ unitId: unit.id, reason: "The answer did not pass the checks and was not kept." });
        } else {
          throw error;
        }
      }
    }
  }

  const available = results.length > 0 || (reachedModel && failed.length === 0);
  return {
    available,
    results,
    failed,
    note: available
      ? "Drafted by AI from the facts shown. Check each one before you use it."
      : "Drafts are unavailable right now. Everything else on this page works.",
  };
}

export async function getAiDraft({ firmId, draftId }) {
  if (!/^[a-f0-9]{24}$/i.test(String(draftId || ""))) throw httpError(400, "Draft id is not valid.");
  const draft = await AiDraft.findOne({ _id: draftId, firmId }).lean();
  if (!draft) throw httpError(404, "That draft could not be found.");
  return serializeDraft(draft);
}

async function countOutcome({ firmId, surface, source, key, outcome }) {
  const field = SUGGESTION_OUTCOME_FIELDS[outcome];
  if (!field) return;
  await AiSuggestionOutcome.updateOne(
    { firmId, day: utcDay(), surface, source, key },
    { $inc: { [field]: 1 } },
    { upsert: true },
  );
}

/**
 * Records what a person did with a model draft. A draft is decided once: the same answer again is accepted
 * (a retried request), a different one is refused. Adopting (edited or not) keeps the draft past its 30 days.
 */
export async function markAiDraftOutcome({ firmId, userId, draftId, input = {} }) {
  if (!isPlainObject(input)) throw httpError(400, "An outcome must be an object.");
  const extra = Object.keys(input).filter((key) => key !== "outcome");
  if (extra.length) throw httpError(400, `An outcome does not accept: ${extra.join(", ")}`);
  const outcome = input.outcome;
  if (!AI_DRAFT_OUTCOMES.includes(outcome) || outcome === "PENDING") {
    throw httpError(400, "Outcome must be ADOPTED_UNCHANGED, EDITED or DISCARDED.");
  }
  if (!/^[a-f0-9]{24}$/i.test(String(draftId || ""))) throw httpError(400, "Draft id is not valid.");
  const adopted = outcome !== "DISCARDED";
  const updated = await AiDraft.findOneAndUpdate(
    { _id: draftId, firmId, outcome: "PENDING" },
    {
      $set: {
        outcome,
        outcomeAt: new Date(),
        outcomeBy: userId || null,
        ...(adopted ? { expiresAt: null } : {}),
      },
    },
    { new: true },
  ).lean();
  if (!updated) {
    const current = await AiDraft.findOne({ _id: draftId, firmId }).lean();
    if (!current) throw httpError(404, "That draft could not be found.");
    if (current.outcome === outcome) return serializeDraft(current);
    throw httpError(409, "What was done with this draft is already recorded.", "AI_DRAFT_ALREADY_DECIDED");
  }
  const task = getAiTask(updated.task);
  if (task?.surface) {
    await countOutcome({ firmId, surface: task.surface, source: "MODEL", key: task.name, outcome });
  }
  return serializeDraft(updated);
}

/**
 * Counts what a person did with a rule's suggestion (no draft is stored for rules: the rule is code).
 * Accepts only a known surface and a rule id shaped like the engines' own ("R4", "TDS_CHALLAN_UNMAPPED").
 */
export async function recordRuleOutcome({ firmId, input = {} }) {
  if (!isPlainObject(input)) throw httpError(400, "An outcome must be an object.");
  const allowed = new Set(["surface", "ruleId", "outcome"]);
  const extra = Object.keys(input).filter((key) => !allowed.has(key));
  if (extra.length) throw httpError(400, `An outcome does not accept: ${extra.join(", ")}`);
  const { surface, ruleId, outcome } = input;
  if (!SUGGESTION_SURFACES.includes(surface)) throw httpError(400, "Surface is not recognised.");
  if (typeof ruleId !== "string" || !/^[A-Za-z0-9_]{1,40}$/.test(ruleId)) throw httpError(400, "Rule id is not valid.");
  if (!SUGGESTION_OUTCOME_FIELDS[outcome]) throw httpError(400, "Outcome must be ADOPTED_UNCHANGED, EDITED or DISCARDED.");
  await countOutcome({ firmId, surface, source: "RULE", key: ruleId, outcome });
  return { recorded: true };
}

export async function getAiSettings({ firmId, canAdminister }) {
  const [intelligence, firm] = await Promise.all([
    AppConfig.isFeatureEnabled("intelligence", { fresh: true }),
    Firm.findOne({ _id: firmId, isActive: true }).select("aiDrafting").lean(),
  ]);
  return {
    intelligence: Boolean(intelligence),
    firmOptIn: {
      enabled: Boolean(firm?.aiDrafting?.enabled),
      changedAt: firm?.aiDrafting?.changedAt ? new Date(firm.aiDrafting.changedAt).toISOString() : null,
    },
    canChange: Boolean(canAdminister),
    whatIsSent:
      "Only shapes and counts: statuses, differences, day gaps, document types, heading names and column types. Client and supplier names, GSTINs, PANs and invoice numbers are never sent; the software fills them in after the draft comes back.",
    provider: "DeepSeek",
  };
}

export async function setAiDrafting({ firmId, userId, input = {} }) {
  if (!isPlainObject(input)) throw httpError(400, "Settings must be an object.");
  const extra = Object.keys(input).filter((key) => key !== "enabled");
  if (extra.length) throw httpError(400, `Settings do not accept: ${extra.join(", ")}`);
  if (typeof input.enabled !== "boolean") throw httpError(400, "enabled must be true or false.");
  const updated = await Firm.findOneAndUpdate(
    { _id: firmId, isActive: true },
    { $set: { "aiDrafting.enabled": input.enabled, "aiDrafting.changedBy": userId || null, "aiDrafting.changedAt": new Date() } },
    { new: true },
  )
    .select("aiDrafting")
    .lean();
  if (!updated) throw httpError(404, "The firm could not be found.");
  return {
    enabled: Boolean(updated.aiDrafting?.enabled),
    changedAt: updated.aiDrafting?.changedAt ? new Date(updated.aiDrafting.changedAt).toISOString() : null,
  };
}
