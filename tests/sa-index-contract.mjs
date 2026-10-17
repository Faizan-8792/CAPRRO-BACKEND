// tests/sa-index-contract.mjs
//
// W10 AP33 (2026-10-17). The Standards on Auditing index answers a citation with no model call, so the
// gate is that nothing the server cites can miss it:
//   - every standard number the backend names anywhere in src (an engine's `standard:` field, a rule's
//     comment, a prompt) resolves in the index;
//   - the index is well formed (unique ascending numbers, a title and a known group each, an effective
//     date only as an ISO day, and null while none has been checked against the Institute's text);
//   - the two client copies are the ones the generator writes from this table (drift fails);
//   - the citation parser reads the shapes the server emits ("SA 320, SA 530", "SA 320/530") and gives
//     nothing for text that is not a standard ("Ind AS 115", "");
//   - the "every citation resolves" check really bites: with one entry removed it must fail.
//
//   node tests/sa-index-contract.mjs
//
// Pure engine checks, no database.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { NOT_RECORDED, SA_GROUPS, SA_INDEX, findStandard, resolveCitation, standardNumbers } from "../src/data/sa-index.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
let passed = 0;
let failed = 0;
const check = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`[PASS] ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`[FAIL] ${name}: ${String(error.message).split("\n")[0]}`);
  }
};

function* sourceFiles(folder) {
  for (const name of readdirSync(folder)) {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) yield* sourceFiles(path);
    else if (name.endsWith(".js")) yield path;
  }
}

/** Every standard number named in backend source, with where, ignoring the index file itself. */
function citedInSource() {
  const cited = [];
  const indexFile = join(root, "src", "data", "sa-index.js");
  for (const file of sourceFiles(join(root, "src"))) {
    if (file === indexFile) continue;
    const text = readFileSync(file, "utf8");
    for (const number of standardNumbers(text)) cited.push({ number, file: relative(root, file).replaceAll("\\", "/") });
  }
  return cited;
}

// "SA 999" is the deliberate example of a standard that does not exist: the prompt-injection guard in the
// insights prompt and the fabricated-standards guard (AA-26) both use it to say what must never be repeated.
// It is excused in exactly those two files, so a real citation of it anywhere else still fails.
const DELIBERATELY_NONEXISTENT = new Map([
  [999, new Set(["src/controllers/audit.controller.js", "src/services/audit-finding-guard.service.js"])],
]);

/** The numbers the source names that `index` does not hold. */
const unresolvedAgainst = (index) => {
  const held = new Set(index.map((e) => e.number));
  return citedInSource().filter((c) => !held.has(c.number) && !DELIBERATELY_NONEXISTENT.get(c.number)?.has(c.file));
};

await check("the index is well formed: unique ascending three-digit numbers, a title and a known group each", () => {
  assert.ok(SA_INDEX.length >= 30, `only ${SA_INDEX.length} entries`);
  let previous = 0;
  for (const e of SA_INDEX) {
    assert.ok(Number.isInteger(e.number) && e.number >= 100 && e.number <= 999, `SA ${e.number} is not a three-digit number`);
    assert.ok(e.number > previous, `SA ${e.number} is not after SA ${previous}`);
    previous = e.number;
    assert.ok(typeof e.title === "string" && e.title.trim().length >= 5, `SA ${e.number} has no title`);
    assert.ok(SA_GROUPS.includes(e.group), `SA ${e.number} has the unknown group "${e.group}"`);
    assert.ok(/^[\x20-\x7e]+$/.test(e.title), `SA ${e.number}'s title is not plain ASCII`);
  }
});

await check("no entry carries an effective date that was not checked: null, or a valid ISO day", () => {
  for (const e of SA_INDEX) {
    assert.ok(e.effectiveDate === null || /^\d{4}-\d{2}-\d{2}$/.test(e.effectiveDate), `SA ${e.number} has the effective date "${e.effectiveDate}"`);
  }
  assert.equal(NOT_RECORDED, "Not recorded in this index");
});

await check("every standard the backend names anywhere in src resolves in the index", () => {
  const missing = unresolvedAgainst(SA_INDEX);
  assert.deepEqual(missing, [], `SA numbers named in source but missing from the index: ${missing.map((m) => `SA ${m.number} (${m.file})`).join(", ")}`);
  assert.ok(citedInSource().length >= 20, "the source scan found almost nothing - the scan itself is broken");
});

await check("every `standard:` literal an engine emits resolves completely (no unresolved part)", () => {
  let literals = 0;
  for (const file of sourceFiles(join(root, "src"))) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/\bstandard:\s*"([^"\n]*)"/g)) {
      literals += 1;
      const r = resolveCitation(m[1]);
      assert.ok(r.resolved.length > 0 && r.unresolved.length === 0, `"${m[1]}" in ${relative(root, file)} does not resolve`);
    }
  }
  assert.ok(literals >= 10, `found only ${literals} standard: literals`);
});

await check("the 'every citation resolves' check bites: with SA 530 removed it must fail", () => {
  const without = SA_INDEX.filter((e) => e.number !== 530);
  assert.ok(unresolvedAgainst(without).some((m) => m.number === 530), "removing SA 530 did not surface a missing citation");
});

await check("the parser reads the shapes the server emits", () => {
  assert.deepEqual(standardNumbers("SA 320, SA 530"), [320, 530]);
  assert.deepEqual(standardNumbers("SA 320/530"), [320, 530]);
  assert.deepEqual(standardNumbers("SA 560 and 570"), [560, 570]);
  assert.deepEqual(standardNumbers("see SA 505 (external confirmations) and SA 505 again"), [505]);
  assert.deepEqual(standardNumbers("sa 580"), [580]);
});

await check("text that is not a standard gives nothing, and never throws", () => {
  assert.deepEqual(standardNumbers("Ind AS 115"), []);
  assert.deepEqual(standardNumbers("320"), [], "a bare number is not a standard");
  assert.deepEqual(standardNumbers(""), []);
  assert.deepEqual(standardNumbers(null), []);
  assert.deepEqual(standardNumbers(undefined), []);
  assert.deepEqual(resolveCitation("Section 44AB"), { numbers: [], resolved: [], unresolved: [] });
});

await check("a standard the index does not hold is reported unresolved, never invented (SA 600, SA 999)", () => {
  const r = resolveCitation("SA 600 and SA 999 and SA 320");
  assert.deepEqual(r.unresolved, [600, 999]);
  assert.deepEqual(r.resolved.map((e) => e.number), [320]);
  assert.equal(findStandard("SA 600"), null);
  assert.equal(findStandard(999), null);
  assert.equal(findStandard("SA 320")?.title, "Materiality in Planning and Performing an Audit");
});

await check("the two client copies are the ones the generator writes from this table (no drift)", () => {
  const run = spawnSync(process.execPath, [join(root, "tools", "generate-sa-index.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(run.status, 0, `${run.stderr.trim() || run.stdout.trim()}`);
});

console.log(`\nsa-index-contract: ${passed}/${passed + failed} passed`);
if (failed) process.exitCode = 1;
