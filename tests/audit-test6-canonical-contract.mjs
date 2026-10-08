// The reviewer's Test #6, run against the deterministic services as a committed fixture.
// AA-36, AA-37 and AA-38 in .kiro/audit-assistance-defects.md.
//
// WHY THE WHOLE DOCUMENT IS COMMITTED
// Every defect in this file was found by running one real 35 KB document, and none of them was
// reachable from a hand-written fixture - each hand-written fixture encodes what its author already
// knew. The document is committed verbatim, hash-pinned, so a future change is measured against the
// thing that actually exposed the defects rather than against a summary of it.
//
// THE THREE DEFECTS
//   AA-36  The document declares its reporting date as "The following occurred after 31 March
//          2026". That family was missing from the reporting-date patterns, so the date read as
//          null, the window fell back to the April/May default, and five of the nine subsequent
//          events were never recognised.
//   AA-37  Two of the nine events - "Bank issued no formal covenant waiver" and "Former distributor
//          legal claim remains unresolved" - carry no date of any kind. No date rule can ever reach
//          them. The document declares the boundary once and lists the items under it, which is how
//          an SA 560 schedule is written, and classifying each item in isolation threw that away.
//   AA-38  A 60-section document reported 202 sections, because every bullet and nested list item
//          counted as one. Section 41 contains a numbered list of ten management explanations and
//          section 56 a list of twenty-two output headings; those are content inside a section.
//
// WHAT THIS FILE DELIBERATELY DOES NOT ASSERT
// That sections 42-60 are excluded as task instructions. They are instructions, and it is tempting:
// the document even says "Every numbered section from 1 through 41 MUST be accounted for". Trusting
// that would let text inside the document decide what the product examines, which is exactly AA-30.
// A hostile document saying "sections 1 through 3" would silently erase thirty-eight real sections,
// and silent incompleteness is the defect this whole ledger exists to prevent. Classifying all
// sixty and letting a reader see them is the safe answer, and the count is honest.
//
//   node capro-backend/tests/audit-test6-canonical-contract.mjs

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  SECTION_DISPOSITION,
  buildSectionLedger,
  extractAddressableUnits,
  extractDocumentSections,
} from "../src/services/audit-coverage.service.js";
import {
  buildSubsequentEventRegister,
  findReportingDate,
} from "../src/services/audit-aggregation.service.js";
import { findInstructionSpans, isOnlyInsideInstructions } from "../src/services/audit-injection.service.js";

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`[PASS] ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`[FAIL] ${name}: ${error.message}`);
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "fixtures", "test6-original-exact.md");
const bytes = readFileSync(FIXTURE);
const TEXT = bytes.toString("utf8");

// ── the fixture is the document, unchanged ────────────────────────────────

check("the committed fixture is the reviewer's document, byte for byte", () => {
  // Hash-pinned so an edit to the fixture is a deliberate, visible act rather than a quiet way of
  // making a failing assertion pass.
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "2a83ab335fc3ab310ba8e5f30b7ed34ed4a56f3d8f8c9546c004a398e3e4b1ab",
    "the canonical Test #6 fixture has been modified",
  );
  assert.equal(bytes.length, 35207);
});

// ── AA-38: what counts as a section ───────────────────────────────────────

check("the document's sixty numbered sections are counted once each", () => {
  const ledger = buildSectionLedger(TEXT, [], []);
  assert.ok(ledger, "no section ledger");

  const numbered = ledger.items.filter((i) => i.kind === "numbered");
  assert.equal(numbered.length, 60, `expected 60 numbered sections, got ${numbered.length}`);

  // Not 202. The nested lists inside sections 41 and 56 are content, not sections.
  assert.equal(ledger.total, 69, `expected 69 units (60 numbered + 9 lettered), got ${ledger.total}`);
});

check("all 41 client sections are present and named", () => {
  const labels = new Set(buildSectionLedger(TEXT, [], []).items.map((i) => i.label));
  const missing = [];
  for (let n = 1; n <= 41; n += 1) if (!labels.has(`section ${n}`)) missing.push(n);
  assert.deepEqual(missing, [], `client sections missing from the ledger: ${missing.join(",")}`);
});

check("zero sections are left unclassified", () => {
  const ledger = buildSectionLedger(TEXT, [], []);
  const permitted = new Set(Object.values(SECTION_DISPOSITION));
  assert.equal(ledger.classified, ledger.total);
  for (const item of ledger.items) {
    assert.ok(permitted.has(item.disposition), `${item.label}: ${item.disposition}`);
  }
});

check("a nested list item does not become a section", () => {
  // Section 41 lists ten management explanations as "1." to "10.", after section 41 itself. If the
  // ordinal rule were dropped they would reappear as sections 1-10 a second time.
  const labels = buildSectionLedger(TEXT, [], []).items.map((i) => i.label);
  const duplicates = labels.filter((l, i) => labels.indexOf(l) !== i);
  assert.deepEqual(duplicates, [], `sections counted twice: ${[...new Set(duplicates)].join(",")}`);
});

check("coverage units are NOT reduced by the section rule", () => {
  // Sections and matters are different questions. A bullet carrying a rupee amount is a genuine
  // matter and AA-01 depends on it staying countable, so the top-level rule must not touch this.
  const units = extractAddressableUnits(TEXT);
  assert.ok(units.length > 69, `coverage units collapsed to ${units.length}`);
});

// ── AA-36: the reporting date the document states ─────────────────────────

check("the reporting date is read from the schedule's own declaration", () => {
  // The document never says "year ended". It says "The following occurred after 31 March 2026",
  // which is the most explicit statement of a reporting date a document ever makes.
  assert.deepEqual(findReportingDate(TEXT), { month: 2, year: 2026 });
});

// ── AA-37: every event in a declared schedule ─────────────────────────────

check("all nine subsequent events are recognised", () => {
  const register = buildSubsequentEventRegister(extractDocumentSections(TEXT), TEXT);
  assert.ok(register, "no subsequent-event register");

  const labels = new Set(register.events.map((e) => e.label));
  const missing = ["A", "B", "C", "D", "E", "F", "G", "H", "I"].filter((l) => !labels.has(`item ${l}`));
  assert.deepEqual(missing, [], `events not recognised: ${missing.join(",")}`);
  assert.equal(register.classified, register.total);
});

check("the register is the declared schedule, not every April mention in the file", () => {
  // Twenty-six "events" for a document that lists nine is noise that buries the nine. Depreciation
  // beginning 1 April and a bank email of 20 April are facts in their own sections, already
  // accounted for by the section ledger.
  const register = buildSubsequentEventRegister(extractDocumentSections(TEXT), TEXT);
  assert.equal(register.total, 9, `expected exactly the nine declared events, got ${register.total}`);
});

check("the two events with no date of their own are still recognised", () => {
  // "Bank issued no formal covenant waiver" and "Former distributor legal claim remains unresolved".
  // No date rule can reach either; only the declared context can.
  const register = buildSubsequentEventRegister(extractDocumentSections(TEXT), TEXT);
  const byLabel = new Map(register.events.map((e) => [e.label, e]));
  for (const letter of ["E", "G"]) {
    assert.ok(byLabel.has(`item ${letter}`), `item ${letter} has no date and was dropped`);
  }
});

check("events are classified differently from one another, and safely", () => {
  const register = buildSubsequentEventRegister(extractDocumentSections(TEXT), TEXT);
  const byLabel = new Map(register.events.map((e) => [e.label, e]));

  // B: a customer entering insolvency after the year end is evidence the receivable was already
  // doubtful at it. H: goods returned for a defect that existed when they were despatched.
  assert.equal(byLabel.get("item B").classification, "ADJUSTING");
  assert.equal(byLabel.get("item H").classification, "ADJUSTING");

  // F: a borrowing facility obtained in July is a new condition - the figures stand.
  assert.equal(byLabel.get("item F").classification, "NON_ADJUSTING");

  // And UNCLEAR survives as a real answer rather than being guessed away.
  const kinds = new Set(register.events.map((e) => e.classification));
  assert.ok(kinds.size >= 3, `events collapsed to ${[...kinds].join(",")}`);
  assert.ok(kinds.has("UNCLEAR"), "no event was left honestly unclear");
});

check("a decimal amount does not break a classification cue", () => {
  // "returned ₹9.8 lakh of goods ... due to defects" - the period inside 9.8 terminated the gap in
  // every cue, so an amount anywhere between two halves of a phrase hid the match. Audit text is
  // made of decimal amounts, so this was not an edge case.
  const register = buildSubsequentEventRegister(extractDocumentSections(TEXT), TEXT);
  const h = register.events.find((e) => e.label === "item H");
  assert.equal(h.classification, "ADJUSTING", "the amount in item H still breaks the cue");
});

// ── AA-30 still holds on this document ────────────────────────────────────

check("the task preamble is not quotable as client evidence", () => {
  const spans = findInstructionSpans(TEXT);
  assert.ok(spans.length > 0, "no instruction spans found in a document that opens with them");
  assert.equal(
    isOnlyInsideInstructions("Analyze this entire document as an AI audit assistant", TEXT, spans),
    true,
  );
});

check("client facts in the same document remain quotable", () => {
  const spans = findInstructionSpans(TEXT);
  for (const phrase of [
    "Revenue for the final 10 days of March was",
    "The five disagreements total",
    "Total borrowings = ",
  ]) {
    assert.equal(
      isOnlyInsideInstructions(phrase, TEXT, spans),
      false,
      `client text was treated as instruction: ${phrase}`,
    );
  }
});

// ── report ────────────────────────────────────────────────────────────────

console.log(`\nResult: ${passed} passed, ${failed} failed (out of ${passed + failed})`);
if (failed > 0) {
  console.error("\nTest #6 canonical contract FAILED.");
  process.exit(1);
}
console.log("Test #6 canonical contract OK");
