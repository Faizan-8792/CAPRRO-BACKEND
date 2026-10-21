// tests/ai-eval-fixtures.mjs
//
// W11 IN6 (2026-10-21): the frozen evaluation sets tools/ai-eval.mjs scores the model against, checked in the gates
// with no network. Pinned: one set per model-backed task; at least 40 cases each; at least 10 cases whose right
// answer is CANNOT_TELL for every task that can abstain; unique ids; expectations drawn from the task's own lists;
// and no GSTIN, PAN or e-mail address anywhere in a fact - the sets are built the way the server builds facts.
//
// Run: node tests/ai-eval-fixtures.mjs

import { readFileSync } from "node:fs";
import { AI_TASK_NAMES, getAiTask } from "../src/services/ai/tasks/index.js";
import { RESIDUE_CAUSES } from "../src/services/ai/tasks/gst-cause-residue.js";

const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass: Boolean(pass), detail });
const CAN_ABSTAIN = new Set(["gst_cause_residue", "import_mapping_suggest", "tds_action_draft"]);
const isCannot = {
  gst_cause_residue: (expect) => expect.acceptable.length === 1 && expect.acceptable[0] === "CANNOT_TELL",
  import_mapping_suggest: (expect) => expect.mappings.ledgerName === "NONE",
  tds_action_draft: (expect) => expect.cannotTell === true,
  supplier_chase_draft: () => false,
};

for (const name of AI_TASK_NAMES) {
  let set = null;
  try {
    set = JSON.parse(readFileSync(new URL(`./fixtures/ai/${name}.json`, import.meta.url), "utf8"));
  } catch (error) {
    check(`${name}: the evaluation set exists and parses`, false, error.message);
    continue;
  }
  const cases = Array.isArray(set.cases) ? set.cases : [];
  check(`${name}: the set names its task`, set.task === name && Boolean(getAiTask(name)));
  check(`${name}: at least 40 cases`, cases.length >= 40, String(cases.length));
  check(`${name}: case ids are unique`, new Set(cases.map((c) => c.id)).size === cases.length);
  if (CAN_ABSTAIN.has(name)) {
    const cannot = cases.filter((c) => isCannot[name](c.expect)).length;
    check(`${name}: at least 10 cases where the right answer is to abstain`, cannot >= 10, String(cannot));
  }
  const text = JSON.stringify(cases.map((c) => c.facts));
  check(`${name}: no GSTIN, PAN or e-mail address in any fact`, !/\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/.test(text) && !/\b[A-Z]{5}\d{4}[A-Z]\b/.test(text) && !/@[a-z0-9-]+\./i.test(text));
  if (name === "gst_cause_residue") {
    check(`${name}: every expected cause is on the task's list`, cases.every((c) => c.expect.acceptable.every((cause) => RESIDUE_CAUSES.includes(cause))));
  }
  if (name === "import_mapping_suggest") {
    check(`${name}: every expected heading ref is one the case sends, or NONE`, cases.every((c) => c.expect.mappings.ledgerName === "NONE" || c.facts.headings.some((h) => h.ref === c.expect.mappings.ledgerName)));
  }
}

const failed = checks.filter((c) => !c.pass);
for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.pass || !c.detail ? "" : ` -- ${c.detail}`}`);
console.log(`\nai-eval-fixtures: ${checks.length - failed.length}/${checks.length} passed`);
process.exitCode = failed.length ? 1 : 0;
