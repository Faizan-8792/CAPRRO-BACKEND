// tests/audit-pack-draft-contract.mjs
//
// W10 AP16 + AP28 (2026-10-17). AI-drafted wording on a pack row: what is asked (pure), what is accepted back
// (pure, with automated breakages), and - with a scratch MongoDB and a stand-in provider - the whole route: a
// reason drafted for each ratio that moved more than 25%, stored beside the row labelled DRAFT FOR REVIEW,
// changing nothing the pack computed, adopted by a person word for word and recorded as drafted, and the pack
// completing with the AI switched off. (The 9C residual drafts are exercised in audit-pack-gstr9c-contract.)
//
// Run: node tests/audit-pack-draft-contract.mjs
//      MONGODB_URI=mongodb://127.0.0.1:27117/scratch-gates-draft node tests/audit-pack-draft-contract.mjs

import { mutantChecks, runMutants } from "./lib/mutants.mjs";
import { AMOUNTS, CURRENT_LEDGERS, PRIOR_LEDGERS, currentVouchers, ledgerDocs, priorVouchers } from "./lib/ratios-fixture.mjs";

const SPEC = {
  purpose: "RATIO_CHANGE_REASON",
  instruction: "Explain the movement.",
  facts: [{ label: "This year", value: "2.35 times" }, { label: "Previous year", value: "1.10 times" }],
};
const CHOICES = [{ code: "TIMING_ADVANCES", label: "Timing: advances" }, { code: "ROUNDING", label: "Rounding" }];
const parse = (text) => {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
};

async function runChecks(draft) {
  const { DRAFT_LABEL, DRAFT_STATUS, DRAFT_SYSTEM, MAX_DRAFT_CHARS, buildDraftPrompt, noteSourceFor, readDraftAnswer, shapeDraft, validateSpec } = draft;
  const checks = [];
  const check = (name, fn) => Promise.resolve().then(fn).then(() => checks.push({ name, pass: true })).catch((error) => checks.push({ name, pass: false, detail: String(error.message).split("\n")[0] }));
  const eq = (actual, expected, what = "") => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${what ? `${what}: ` : ""}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };

  await check("the wording the provider is held to forbids invented figures and causes and sends the cause to management", () => {
    for (const phrase of ["Use only those facts", "Never invent a figure, a cause, a date, a law or a standard", "obtained from management or the client", "no markdown"]) eq(DRAFT_SYSTEM.includes(phrase), true, phrase);
  });
  await check("a spec needs a purpose, an instruction, between one and forty string facts, and well-formed categories", () => {
    eq(validateSpec(SPEC), true);
    eq(validateSpec({ ...SPEC, choices: CHOICES }), true);
    for (const bad of [null, {}, { ...SPEC, purpose: "lowercase" }, { ...SPEC, instruction: "  " }, { ...SPEC, facts: [] }, { ...SPEC, facts: Array.from({ length: 41 }, () => ({ label: "a", value: "b" })) }, { ...SPEC, facts: [{ label: "a", value: 5 }] }, { ...SPEC, choices: [{ code: "", label: "x" }] }, { ...SPEC, choices: "ROUNDING" }]) eq(validateSpec(bad), false, JSON.stringify(bad)?.slice(0, 60));
  });
  await check("the prompt quotes every fact; with categories it lists them by code and asks for JSON, without it asks for plain sentences", () => {
    const plain = buildDraftPrompt(SPEC);
    eq(plain.includes("- This year: 2.35 times") && plain.includes("- Previous year: 1.10 times") && plain.includes("Plain text only"), true);
    eq(plain.includes("Categories") || plain.includes("JSON"), false);
    const withChoices = buildDraftPrompt({ ...SPEC, choices: CHOICES });
    eq(withChoices.includes("- TIMING_ADVANCES: Timing: advances") && withChoices.includes("- ROUNDING: Rounding") && withChoices.includes('"category"') && withChoices.includes("strict JSON"), true);
  });
  await check("plain answers lose their markdown and line breaks, and an empty or link-bearing answer is refused", () => {
    eq(readDraftAnswer("**The debt fell.**\n\n- Loans were repaid.\n# heading", SPEC, parse), { text: "The debt fell. - Loans were repaid. heading", proposedChoice: "" });
    eq(readDraftAnswer("   ", SPEC, parse), null);
    eq(readDraftAnswer("See https://example.com for the reason.", SPEC, parse), null);
  });
  await check("a long answer is cut at its last full sentence, never mid-sentence, and never past the limit", () => {
    const sentence = "The ratio moved because a figure moved. ";
    const long = sentence.repeat(60);
    const cut = readDraftAnswer(long, SPEC, parse);
    eq(cut.text.length <= MAX_DRAFT_CHARS && cut.text.endsWith("moved."), true, cut.text.slice(-30));
  });
  await check("with categories the answer is JSON: a listed category is kept, an unlisted one is dropped with the reason kept, anything else is refused", () => {
    const spec = { ...SPEC, choices: CHOICES };
    eq(readDraftAnswer('{"category":"timing_advances","reason":"Advances were received."}', spec, parse), { text: "Advances were received.", proposedChoice: "TIMING_ADVANCES" });
    eq(readDraftAnswer('{"category":"MADE_UP","reason":"Probably advances."}', spec, parse), { text: "Probably advances.", proposedChoice: "" });
    eq(readDraftAnswer('{"category":"ROUNDING"}', spec, parse), null, "no reason");
    eq(readDraftAnswer("Probably advances.", spec, parse), null, "not JSON");
  });
  await check("what a client is shown carries the label to print and the figures drafted from, and nothing when there is no text", () => {
    eq(DRAFT_LABEL, "DRAFT FOR REVIEW");
    eq(DRAFT_STATUS, "AI_DRAFT");
    const shown = shapeDraft({ text: "Words.", purpose: "RATIO_CHANGE_REASON", proposedChoice: "", quoted: [{ label: "A", value: "B" }], draftedAt: "2026-10-17T00:00:00.000Z" });
    eq([shown.label, shown.status, shown.quoted, shown.text], ["DRAFT FOR REVIEW", "AI_DRAFT", [{ label: "A", value: "B" }], "Words."]);
    eq(shapeDraft(null), null);
    eq(shapeDraft({ text: "" }), null);
  });
  await check("a note is recorded as drafted only when it is the stored draft word for word (spaces at the ends aside)", () => {
    const stored = { text: "The debt fell because loans were repaid." };
    eq(noteSourceFor("The debt fell because loans were repaid.", stored), "AI_DRAFT");
    eq(noteSourceFor("  The debt fell because loans were repaid.  ", stored), "AI_DRAFT");
    eq(noteSourceFor("The debt fell because loans were repaid in full.", stored), "", "edited");
    eq(noteSourceFor("The debt fell because loans were repaid. A new loan was taken.", stored), "", "the draft with more written after it");
    eq(noteSourceFor("", stored), "");
    eq(noteSourceFor("Anything", null), "");
  });
  return checks;
}

const MUTANTS = [
  { name: "any note that contains the draft counts as the draft", from: "return written && draft?.text && written === String(draft.text).trim() ? DRAFT_STATUS : \"\";", to: "return written && draft?.text && written.includes(String(draft.text).trim()) ? DRAFT_STATUS : \"\";" },
  { name: "a category the pack never offered is kept", from: "if (spec.choices.some((c) => c.code === code)) proposedChoice = code;", to: "proposedChoice = code;" },
  { name: "a link in the answer is allowed", from: "if (/https?:\\/\\//i.test(text)) return null;", to: "" },
  { name: "the answer is not bounded", from: "if (text.length > MAX_DRAFT_CHARS) {", to: "if (false) {" },
  { name: "markdown is left in", from: '.replace(/[*_#>`]+/g, "")', to: "" },
  { name: "the label a client prints is not the one the contract promises", from: 'export const DRAFT_LABEL = "DRAFT FOR REVIEW";', to: 'export const DRAFT_LABEL = "Suggested";' },
  { name: "a spec with no facts is accepted", from: "if (!Array.isArray(spec.facts) || spec.facts.length === 0 || spec.facts.length > MAX_FACTS) return false;", to: "if (!Array.isArray(spec.facts)) return false;" },
  { name: "the prompt does not quote the facts", from: "...spec.facts.map((f) => `- ${f.label}: ${f.value}`), \"\"];", to: "\"\"];" },
  { name: "the system rules lose the ban on invented causes", from: "Never invent a figure, a cause, a date, a law or a standard. ", to: "" },
];

async function main() {
  const enginePath = new URL("../src/services/audit-pack-kinds/draft.js", import.meta.url);
  const draft = await import(enginePath.href);
  const checks = await runChecks(draft);
  checks.push(...mutantChecks(await runMutants({ enginePath, mutants: MUTANTS, runChecks: (m) => runChecks(m) })));

  const uri = process.env.MONGODB_URI || "";
  const scratch = /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(uri) && /scratch/i.test((uri.split("/").pop() || "").split("?")[0]);
  let note = "pure checks only (no scratch MONGODB_URI)";
  if (scratch) {
    const { runSnapshotPackFlow } = await import("./lib/snapshot-pack-routes.mjs");
    checks.push(...(await runSnapshotPackFlow({
      uri,
      label: "Draft",
      kind: "SCHEDULE3_RATIOS",
      ledgers: ledgerDocs(CURRENT_LEDGERS),
      vouchers: currentVouchers().map(({ _id, ...v }) => v),
      priorSnapshot: { financialYear: "2024-25", ledgers: ledgerDocs(PRIOR_LEDGERS), vouchers: priorVouchers().map(({ _id, ...v }) => v) },
      body: { amounts: AMOUNTS },
      decide: (row) => (row.values?.changeOver25 ? { state: "CONFIRMED", choice: "REPORT_EXPLAINED", note: "Explained in the contract" } : row.choices?.options?.[0] ? { state: "CONFIRMED", choice: row.choices.options[0].value } : null),
      expect: async ({ section, call, A, B, runId, mock, readWorkbookParts }) => {
        const out = [];
        const c = (name, pass, detail = "") => out.push({ name, pass: Boolean(pass), detail });
        const ratios = section("RATIOS");
        const flagged = ratios.filter((r) => r.values.changeOver25 === true);
        const unflagged = ratios.filter((r) => r.values.changeOver25 !== true);
        const path = (row) => `/api/audit-packs/${runId}/rows/${row.rowKey}/draft`;
        const picture = async () => JSON.stringify(((await call("GET", `/api/audit-packs/${runId}/rows?section=RATIOS&limit=100`, A.token)).json?.rows || []).map((r) => ({ key: r.rowKey, values: r.values, computed: r.computedValues, state: r.state, lines: r.lines, choices: r.choices, decision: r.decision })));
        const summary = async () => JSON.stringify((await call("GET", `/api/audit-packs/${runId}`, A.token)).json?.run?.summary);

        c("a draft is offered for exactly the five ratios that moved more than 25%", flagged.length === 5 && flagged.every((r) => r.draftable === true) && unflagged.length === 6 && unflagged.every((r) => r.draftable === false), `${flagged.length} flagged, ${flagged.map((r) => r.draftable).join(",")} / ${unflagged.map((r) => r.draftable).join(",")}`);
        const before = await picture();
        const summaryBefore = await summary();

        const blank = await call("POST", path(flagged[0]), A.token, {});
        c("with the AI key blank a draft is 'not available', the provider is never called and the pack is untouched", blank.status === 200 && blank.json?.available === false && mock.calls.length === 0 && (await picture()) === before, `status ${blank.status}`);

        mock.on((body) => `The ${body.messages[1].content.match(/Ratio: (.+)/)?.[1] || "ratio"} moved because its figures moved; the business reason is to be obtained from management.`);
        for (const row of flagged) {
          const drafted = await call("POST", path(row), A.token, {});
          c(`${row.label}: drafted, labelled DRAFT FOR REVIEW and stored beside the row`, drafted.json?.available === true && drafted.json.row.draft?.label === "DRAFT FOR REVIEW" && drafted.json.row.draft.status === "AI_DRAFT" && drafted.json.row.draft.purpose === "RATIO_CHANGE_REASON" && drafted.json.row.draft.text.length > 20, JSON.stringify(drafted.json)?.slice(0, 200));
        }
        const equity = flagged.find((r) => r.values.ratio === "DEBT_EQUITY");
        await call("POST", path(equity), A.token, {});
        const prompt = mock.calls.at(-1).body.messages[1].content;
        c("the provider is sent the ratio, its formula, both years' ratios, the change and the figures that moved - and asked for plain text", [
          "Ratio: Debt-equity ratio", "Formula: Total debt / Shareholders' equity", "This year: 0.47 times", "Previous year: 0.72 times", "Change: -34.80%",
          "Total debt, this year: ₹4,50,000.00", "Total debt, previous year: ₹5,60,000.00", "Shareholders' equity, this year: ₹9,54,000.00", "Shareholders' equity, previous year: ₹7,74,000.00", "Plain text only",
        ].every((s) => prompt.includes(s)) && mock.calls.at(-1).body.response_format === undefined, prompt.slice(0, 600));
        c("what the provider is sent carries no party name, GSTIN or PAN", !/[A-Z]{5}\d{4}[A-Z]|\b\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z\d]{2}\b/.test(prompt) && !/Customer X|Vendor A/.test(prompt));
        c("a draft never changes a ratio, its figures, its state, its choices or the pack's summary: every value is identical before and after", (await picture()) === before && (await summary()) === summaryBefore);

        const refused = await call("POST", path(unflagged[0]), A.token, {});
        c("a ratio that did not move more than 25% is refused a draft", refused.status === 400, `status ${refused.status}`);
        const gap = section("INPUT_GAPS");
        c("a clean pack has no gap rows to draft for", gap.length === 0);
        const foreign = await call("POST", path(equity), B.token, {});
        c("another firm cannot draft on this pack", foreign.status === 404, `status ${foreign.status}`);
        mock.fail(500);
        const down = await call("POST", path(equity), A.token, {});
        c("a provider that is down gives 'not available' and keeps the earlier draft", down.status === 200 && down.json?.available === false && Boolean(down.json?.row?.draft?.text), `status ${down.status}`);
        mock.off();
        return out;
      },
      // The harness has now decided every row (with its own notes) and exported once. A person adopts each drafted
      // reason word for word, and the sheets say so.
      after: async ({ call, A, runId, readWorkbookParts }) => {
        const out = [];
        const c = (name, pass, detail = "") => out.push({ name, pass: Boolean(pass), detail });
        const reload = async () => (await call("GET", `/api/audit-packs/${runId}/rows?section=RATIOS&limit=100`, A.token)).json.rows;
        const decide = (row, note) => call("POST", `/api/audit-packs/${runId}/rows/${row.rowKey}/decision`, A.token, { expectedVersion: row.decision.version, state: "CONFIRMED", choice: "REPORT_EXPLAINED", note });
        const flagged = (await reload()).filter((r) => r.values.changeOver25 === true);
        c("every flagged ratio still has its stored draft after the pack was decided", flagged.length === 5 && flagged.every((r) => r.draft?.label === "DRAFT FOR REVIEW"), flagged.map((r) => Boolean(r.draft)).join(","));
        c("the notes the harness wrote for itself are recorded as the person's", flagged.every((r) => r.decision.noteSource === ""), flagged.map((r) => r.decision.noteSource).join(","));
        let adoptedAll = true;
        for (const row of flagged.filter((r) => r.values.ratio !== "RETURN_ON_EQUITY")) {
          const answer = await decide(row, row.draft.text);
          if (!(answer.status === 200 && answer.json.row.decision.noteSource === "AI_DRAFT")) adoptedAll = false;
        }
        c("a reason adopted word for word is recorded as drafted by AI", adoptedAll);
        const equity = flagged.find((r) => r.values.ratio === "RETURN_ON_EQUITY");
        const edited = await decide(equity, `${equity.draft.text} Also, a new loan was taken.`);
        c("the same reason edited by the person is recorded as theirs", edited.status === 200 && edited.json.row.decision.noteSource === "", JSON.stringify(edited.json?.row?.decision));
        const done = await call("GET", `/api/audit-packs/${runId}`, A.token);
        c("with every ratio decided the pack is not provisional, and no draft was needed to get there", done.json?.run?.summary?.provisional === false, JSON.stringify(done.json?.run?.summary?.reasons));
        const exported = await call("GET", `/api/audit-packs/${runId}/export`, A.token);
        const parts = exported.bytes ? readWorkbookParts(exported.bytes) : new Map();
        const sheets = [...parts.entries()].filter(([name]) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).map(([, bytes]) => bytes.toString("utf8"));
        const filing = sheets.find((x) => /Reason for a change above 25%/.test(x)) || "";
        const decisions = sheets.find((x) => /Note written by/.test(x)) || "";
        c("the filing sheet carries the reason beside each flagged ratio", /The Debt-equity ratio moved because its figures moved/.test(filing) && /a new loan was taken/.test(filing), filing.slice(0, 200));
        c("the Decisions sheet says which reasons were drafted by AI and adopted as drafted, and which the person wrote", /Drafted by AI, adopted as drafted/.test(decisions) && /The person who decided/.test(decisions));
        return out;
      },
    })));
    note = "scratch Mongo included";
  }

  let failed = 0;
  for (const c of checks) {
    if (c.pass) console.log(`PASS  ${c.name}`);
    else {
      failed += 1;
      console.error(`FAIL  ${c.name}${c.detail ? `\n      ${c.detail}` : ""}`);
    }
  }
  console.log(`\naudit-pack-draft-contract: ${checks.length - failed}/${checks.length} passed (${note})`);
  process.exitCode = failed ? 1 : 0;
}

await main();
