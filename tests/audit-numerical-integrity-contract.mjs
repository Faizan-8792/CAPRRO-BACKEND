// Contract for the deterministic numerical-integrity check. AA-02 in
// .kiro/audit-assistance-defects.md.
//
// The defect this pins, in the owner's own words: itemised corporate-card transactions totalled
// Rs 4.60 lakh, the narrative said "no reimbursement evidence for Rs 2.86 lakh", and the engine
// repeated 2.86 lakh and tested against it without noticing the population did not reconcile.
//
// Half of this file is about NOT firing. A detector that flags every document where two numbers
// differ would be worse than the defect: it would train a reader to ignore the finding, and the
// one time it mattered they would ignore that too. So the false-positive cases below - a list with
// a correct total, rounding in the source, a discussion of unrelated figures, section numbers and
// years - are as load-bearing as the detection cases.
//
//   node capro-backend/tests/audit-numerical-integrity-contract.mjs

import assert from "node:assert/strict";
import {
  extractRupeeAmounts,
  findNumericalInconsistencies,
  buildNumericalIntegrityInsights,
} from "../src/services/audit-numerical-integrity.service.js";
import { guardFinding } from "../src/services/audit-finding-guard.service.js";

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

const lakh = (n) => Math.round(n * 100000 * 100); // to integer paise

// ── amount recognition ────────────────────────────────────────────────────

check("reads the Indian forms this product actually receives", () => {
  const amounts = extractRupeeAmounts(
    "Rs 2.10 lakh, ₹1,40,000, 2.4 Cr, ₹48,00,000 and Rs 12600000.",
  );
  const paise = amounts.map((a) => a.paise);
  assert.ok(paise.includes(lakh(2.1)), "Rs 2.10 lakh");
  assert.ok(paise.includes(140000 * 100), "₹1,40,000");
  assert.ok(paise.includes(Math.round(2.4 * 10000000 * 100)), "2.4 Cr");
  assert.ok(paise.includes(4800000 * 100), "₹48,00,000");
  assert.ok(paise.includes(12600000 * 100), "bare rupee figure with a currency marker");
});

check("a bare number that is not money is never read as money", () => {
  // "18 sections", "2026", "Test 3" must not enter the arithmetic. This is what stops a section
  // count being summed against a rupee total.
  const amounts = extractRupeeAmounts(
    "The report has 18 sections covering the year 2026, and Test 3 lists 4 matters.",
  );
  assert.equal(amounts.length, 0, `expected no amounts, got ${JSON.stringify(amounts)}`);
});

check("a scale word alone is enough, with no currency marker", () => {
  const amounts = extractRupeeAmounts("The claim is 2.4 crore and the dues are 48 lakh.");
  const paise = amounts.map((a) => a.paise);
  assert.ok(paise.includes(Math.round(2.4 * 10000000 * 100)));
  assert.ok(paise.includes(lakh(48)));
});

// ── the defect itself ─────────────────────────────────────────────────────

const TEST_5_TEXT = `
Corporate credit card review for the year ended 31 March 2026.

The following transactions were identified on the director's corporate card:
  - Restaurant bills of Rs 2.10 lakh
  - Hotel accommodation of Rs 1.40 lakh
  - Electronics purchases of Rs 0.72 lakh
  - Retail purchases of Rs 0.38 lakh

Management could not produce reimbursement evidence for Rs 2.86 lakh of the above.
`;

check("the Test 5 population that does not reconcile is detected", () => {
  const found = findNumericalInconsistencies(TEST_5_TEXT);
  assert.equal(found.length, 1, `expected exactly one inconsistency, got ${found.length}`);

  const [item] = found;
  assert.equal(item.itemCount, 4);
  assert.equal(item.itemisedTotalPaise, lakh(4.6), "itemised amounts total Rs 4.60 lakh");
  assert.equal(item.statedTotalPaise, lakh(2.86), "the narrative states Rs 2.86 lakh");
  assert.equal(item.differencePaise, lakh(1.74), "the gap is Rs 1.74 lakh");
});

check("the finding quotes both real figures rather than saying something is wrong", () => {
  const [insight] = buildNumericalIntegrityInsights(TEST_5_TEXT);
  assert.ok(insight, "an insight is produced");
  assert.match(insight.detail, /4\.60 lakh/, "names the itemised total");
  assert.match(insight.detail, /2\.86 lakh/, "names the stated figure");
  assert.match(insight.detail, /1\.74 lakh/, "names the difference");
});

check("the finding asks for reconciliation and does not assert a misstatement", () => {
  const [insight] = buildNumericalIntegrityInsights(TEST_5_TEXT);
  // AA-04: an indicator must never be worded as a confirmed error.
  for (const forbidden of [
    /is misstated/i,
    /has been misstated/i,
    /is fraudulent/i,
    /confirms? (a )?fraud/i,
    /is incorrect/i,
    /is wrong/i,
  ]) {
    // The TITLE is what a reader sees first and is the easiest place for an over-conclusion to
    // hide. Leaving it out let a mutation retitle the finding "This amount is misstated" and still
    // pass, which is precisely the category error AA-04 exists to prevent.
    for (const [field, value] of [
      ["title", insight.title],
      ["detail", insight.detail],
      ["nextAction", insight.nextAction],
      ["why", insight.why],
    ]) {
      assert.doesNotMatch(value, forbidden, `${field} must not over-conclude (${forbidden})`);
    }
  }
  assert.match(insight.title, /reconcile/i, "the title names the action, not a verdict");
  assert.match(insight.detail, /before/i, "says the reconciliation comes first");
});

check("it leads with reconciliation rather than a test of an unreconciled population", () => {
  const [insight] = buildNumericalIntegrityInsights(TEST_5_TEXT);
  assert.equal(insight.risk, "high");
  assert.equal(insight.amountMinor, lakh(1.74), "carries the difference as the amount");
  assert.match(insight.nextAction, /listing/i, "asks for the underlying listing");
});

check("each aggregate-cue family is independently load-bearing", () => {
  // A mutation that deleted one cue family still passed, because another family happened to match
  // the same sentence. Redundant cover is good design and a bad test: it hides which rule is doing
  // the work. Each phrasing below is chosen so that ONLY its own family can catch it.
  const items = "Items of Rs 1.00 lakh, Rs 2.00 lakh and Rs 3.00 lakh.";
  const phrasings = [
    ["plain total", `${items} Total Rs 9.00 lakh.`],
    ["aggregating", `${items} Aggregating Rs 9.00 lakh.`],
    ["amounting to", `${items} Amounting to Rs 9.00 lakh.`],
    ["sum of", `${items} A sum of Rs 9.00 lakh.`],
    ["altogether", `${items} Altogether Rs 9.00 lakh.`],
    ["evidence for", `${items} There is no evidence for Rs 9.00 lakh.`],
    ["unsupported", `${items} Unsupported Rs 9.00 lakh.`],
    ["could not produce", `${items} Management could not produce vouchers covering Rs 9.00 lakh.`],
    ["unable to", `${items} The company was unable to explain Rs 9.00 lakh.`],
    ["without", `${items} Recorded without approval for Rs 9.00 lakh.`],
    ["to the extent of", `${items} Irregular to the extent of Rs 9.00 lakh.`],
    ["out of which", `${items} Out of which Rs 9.00 lakh is disputed.`],
  ];

  for (const [label, text] of phrasings) {
    const found = findNumericalInconsistencies(text);
    assert.equal(
      found.length,
      1,
      `the "${label}" phrasing must be recognised as an aggregate claim`,
    );
    assert.equal(found[0].itemisedTotalPaise, lakh(6), `${label}: items total Rs 6 lakh`);
    assert.equal(found[0].statedTotalPaise, lakh(9), `${label}: stated Rs 9 lakh`);
  }
});

// ── it must not fire on documents that are fine ────────────────────────────

check("a list with a correct total is not flagged", () => {
  const text = `
    Statutory dues outstanding at 31 March:
      - PF Rs 1.20 lakh
      - ESI Rs 0.30 lakh
      - TDS Rs 3.70 lakh
    Total statutory dues Rs 5.20 lakh.
  `;
  assert.deepEqual(findNumericalInconsistencies(text), []);
});

check("rounding in the source document is tolerated", () => {
  // Three items stated to the rupee, with a total rounded by a couple of rupees. Real reports do
  // this, and flagging it would be noise.
  const text = `
    Expenses: ₹1,00,001, ₹2,00,001 and ₹3,00,001.
    Totalling ₹6,00,000.
  `;
  assert.deepEqual(findNumericalInconsistencies(text), []);
});

check("two unrelated figures with no aggregate claim are not compared", () => {
  // The whole point of requiring an aggregate cue. Without it, any document mentioning several
  // amounts would be flagged.
  const text = `
    Revenue was ₹84.6 crore. Profit before tax was ₹2.74 crore.
    Total assets were ₹52.8 crore. Borrowings stood at ₹11.2 crore.
  `;
  assert.deepEqual(findNumericalInconsistencies(text), []);
});

check("fewer than three items is not treated as a list", () => {
  const text = "Two payments of Rs 1.00 lakh and Rs 2.00 lakh, totalling Rs 5.00 lakh.";
  assert.deepEqual(
    findNumericalInconsistencies(text),
    [],
    "two items and a total is too thin to call a population",
  );
});

check("an aggregate far away from the list is not roped in", () => {
  const filler = "This paragraph discusses an unrelated matter. ".repeat(20);
  const text = `
    Items: Rs 1.00 lakh, Rs 2.00 lakh, Rs 3.00 lakh.
    ${filler}
    Separately, the total contract value is Rs 90.00 lakh.
  `;
  assert.deepEqual(findNumericalInconsistencies(text), []);
});

check("empty and non-string input is handled without throwing", () => {
  for (const value of ["", "   ", null, undefined, 42, {}]) {
    assert.deepEqual(findNumericalInconsistencies(value), []);
    assert.deepEqual(buildNumericalIntegrityInsights(value), []);
  }
});

// ── the shape the controller expects ──────────────────────────────────────

check("the insight matches the shape the audit controller already emits", () => {
  const [insight] = buildNumericalIntegrityInsights(TEST_5_TEXT);
  for (const field of [
    "title",
    "detail",
    "risk",
    "standard",
    "evidence",
    "why",
    "nextAction",
    "amountMinor",
    "workingPaperRef",
  ]) {
    assert.ok(field in insight, `missing ${field}`);
  }
  assert.equal(typeof insight.amountMinor, "number", "amountMinor is integer paise");
  assert.ok(Number.isInteger(insight.amountMinor), "money never touches a float");
});

check("the numerical finding is a confirmed fact, never a confirmed misstatement", () => {
  // AA-04 cross-check. The difference is arithmetic - anyone with a calculator reaches the same
  // answer - so the finding is a fact about the document. Whether the accounts are wrong is a
  // conclusion only a person can reach, and the status must not pre-empt it.
  const insights = buildNumericalIntegrityInsights(TEST_5_TEXT);
  assert.ok(insights.length > 0, "Test 5 must still produce a finding");
  for (const insight of insights) {
    assert.equal(insight.deterministic, true, "the finding is deterministic and must say so");
    const status = guardFinding(insight).status;
    assert.equal(status, "CONFIRMED_FACT", `expected CONFIRMED_FACT, got ${status}`);
    assert.notEqual(status, "CONFIRMED_MISSTATEMENT");
  }
});

// ── report ────────────────────────────────────────────────────────────────

console.log(`\nResult: ${passed} passed, ${failed} failed (out of ${passed + failed})`);
if (failed > 0) {
  console.error("\nAA-02 numerical-integrity contract FAILED.");
  process.exit(1);
}
console.log("AA-02 numerical-integrity contract OK");
