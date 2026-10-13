// Contract for population boundaries in the numerical-integrity check. AA-29 in
// .kiro/audit-assistance-defects.md.
//
// THE DEFECT
// AA-02 asked whether a stated aggregate agrees with the items it summarises. It did not ask
// whether those items are one population. Runs were grouped by PROXIMITY alone - any three amounts
// within 400 characters, none carrying an aggregate cue - so on a 41-section audit memorandum the
// engine swept twenty-four unrelated figures (revenue, receivables, capital work in progress,
// inventory, payables, borrowings, gratuity, related-party sales, deferred tax, contingent
// liabilities, CSR) into a single "population" of Rs 1,034.46 crore and reconciled it against the
// Rs 2.86 lakh of unsupported reimbursement claims in section 33.
//
// Two things were wrong with that, and the second is the worse one:
//   1. It reported a Rs 1,034.43 crore difference that does not exist. A fabricated reconciliation
//      sends a reviewer looking for a difference that was never there.
//   2. It DESTROYED the one real reconciliation in the document. The runaway run swallowed section
//      33's four itemised claims, so the genuine Rs 1.74 lakh finding never appeared at all.
//
// WHY THIS FILE IS SEPARATE FROM audit-numerical-integrity-contract.mjs
// AA-02's contract passes both before and after the fix - every one of its sixteen checks was
// green while the defect above was live. That is precisely why this is a different defect with a
// different criterion, and not a ledger edit to AA-02.
//
// WHY THE FIXTURES ARE WORDED DIFFERENTLY FROM EACH OTHER
// A fix that recognised the words "Reimbursement claims" would be an overfit to one document. So
// the same structural failure is presented three ways - numbered sections, unnumbered narrative
// sentences, and a lettered schedule - with no shared vocabulary between them. All three must be
// silent. And three legitimate reconciliations, also worded differently from each other and from
// the negatives, must still fire: a rule that achieves silence by never firing is not a fix.
//
//   node capro-backend/tests/audit-population-boundary-contract.mjs

import assert from "node:assert/strict";
import {
  findNumericalInconsistencies,
} from "../src/services/audit-numerical-integrity.service.js";

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

const lakh = (n) => Math.round(n * 100000 * 100);

// ── the negatives: three shapes of "unrelated amounts, one after another" ──

/**
 * A numbered memorandum. This is the reported document's shape: many sections, each with its own
 * subject and its own figure, and one section that genuinely contains an itemised list.
 */
const NUMBERED_MEMORANDUM = `AUDIT REVIEW MEMORANDUM - YEAR ENDED 31 MARCH 2026

1. The company manufactures and distributes industrial fasteners.
2. Revenue for the year is Rs 399.41 crore against Rs 342.18 crore in the prior year.
3. Trade receivables at the year end include Rs 71 lakh past due beyond 180 days.
4. Property, plant and equipment additions during the year were Rs 17.82 crore.
5. Capital work in progress carries borrowing costs of Rs 86 lakh capitalised during the year.
6. Inventory is stated at Rs 44.60 crore.
7. Trade payables include Rs 2.40 crore due to micro and small enterprises.
8. Borrowings of Rs 118.90 crore carry a covenant tested on net debt to EBITDA.
9. Employee benefit obligations are Rs 6.75 crore per the actuarial report.
10. Related party sales during the year were Rs 22.30 crore.
11. Deferred tax assets of Rs 4.05 crore are recognised on unabsorbed depreciation.
12. Contingent liabilities disclosed are Rs 31.70 crore.
13. Reimbursement claims of Rs 2.10 lakh, Rs 1.40 lakh, Rs 0.72 lakh and Rs 0.38 lakh were
    settled during the year. Evidence for Rs 2.86 lakh could not be produced.
14. Foreign currency payables of Rs 7.30 crore were not restated at the closing rate.
`;

/**
 * The same failure with no enumeration anywhere - consecutive sentences in one paragraph. This
 * isolates the sentence-boundary rule: if only the numbering rule worked, this would still group.
 * Not one word is shared with the memorandum above.
 */
const UNNUMBERED_NARRATIVE = `Site visit notes. The godown lease carries an annual rent of Rs 18 lakh.
A generator was purchased in October for Rs 9 lakh. The transformer upgrade cost Rs 24 lakh.
Insurance premium for the plant was Rs 6 lakh. The watchman's gratuity provision stands at
Rs 3 lakh. The proprietor could not produce bills for Rs 4 lakh.
`;

/**
 * A lettered schedule. Different marker style, different subject matter, different vocabulary
 * again - and the aggregate cue is a different family ("aggregating to") from either document
 * above.
 */
const LETTERED_SCHEDULE = `Schedule of matters arising:
(a) Excise duty refund receivable is Rs 12 lakh.
(b) The disputed electricity demand is Rs 30 lakh.
(c) The security deposit with the port trust is Rs 45 lakh.
(d) Unreconciled items in the suspense account aggregating to Rs 15 lakh remain open.
`;

check("a numbered memorandum does not sum figures from different sections", () => {
  const found = findNumericalInconsistencies(NUMBERED_MEMORANDUM);

  // Exactly one reconciliation, and it is section 13's - the only itemised population present.
  assert.equal(found.length, 1, `expected 1 reconciliation, got ${found.length}`);
  assert.equal(found[0].itemCount, 4, "the run must be section 13's four claims, nothing else");
  assert.equal(found[0].itemisedTotalPaise, lakh(4.6));
  assert.equal(found[0].statedTotalPaise, lakh(2.86));
  assert.equal(found[0].differencePaise, lakh(1.74));
});

check("the runaway cross-section population is gone, by figure not by count", () => {
  // Naming the actual wrong number, so this cannot pass because the engine happens to produce a
  // different wrong answer of the same shape.
  const found = findNumericalInconsistencies(NUMBERED_MEMORANDUM);
  for (const item of found) {
    assert.notEqual(
      item.itemisedTotalPaise,
      Math.round(1034.46 * 10000000 * 100),
      "the twenty-four-figure population is back",
    );
    assert.ok(
      item.itemCount <= 6,
      `a ${item.itemCount}-item population in a document whose longest list has four members`,
    );
  }
});

check("consecutive unrelated sentences are not one population", () => {
  const found = findNumericalInconsistencies(UNNUMBERED_NARRATIVE);
  assert.equal(
    found.length,
    0,
    `five unrelated site-visit figures were grouped: ${JSON.stringify(found[0] ?? null)}`,
  );
});

check("a lettered schedule is not one population", () => {
  const found = findNumericalInconsistencies(LETTERED_SCHEDULE);
  assert.equal(
    found.length,
    0,
    `four unrelated schedule items were grouped: ${JSON.stringify(found[0] ?? null)}`,
  );
});

// ── the positives: silence must not be achieved by never firing ────────────

check("an inline list still reconciles against a total stated in the next sentence", () => {
  const text =
    "Consultancy fees paid during the year were Rs 3.50 lakh, Rs 2.25 lakh and Rs 1.15 lakh. " +
    "The company was unable to produce agreements for Rs 5.00 lakh.";

  const found = findNumericalInconsistencies(text);
  assert.equal(found.length, 1, "a genuine three-item list stopped reconciling");
  assert.equal(found[0].itemisedTotalPaise, lakh(6.9));
  assert.equal(found[0].statedTotalPaise, lakh(5));
  assert.equal(found[0].differencePaise, lakh(1.9));
});

check("a bulleted list still reconciles - bullets are members, not sections", () => {
  // The distinction the boundary rule turns on. A number or letter marks a distinct section of a
  // memorandum; a bullet marks a member of the list it hangs under. Losing this case would be a
  // real cost of the fix, so it is pinned rather than assumed.
  const text = [
    "Travel and conveyance comprises:",
    "- air fare Rs 4.00 lakh",
    "- hotel Rs 2.50 lakh",
    "- local travel Rs 1.20 lakh",
    "Vouchers could not be produced for Rs 5.00 lakh.",
  ].join("\n");

  const found = findNumericalInconsistencies(text);
  assert.equal(found.length, 1, "a bulleted list stopped reconciling");
  assert.equal(found[0].itemCount, 3);
  assert.equal(found[0].itemisedTotalPaise, lakh(7.7));
  assert.equal(found[0].differencePaise, lakh(2.7));
});

check("a list inside one numbered section still reconciles", () => {
  // The boundary must bound sections, not everything. A list that lives entirely inside section 7
  // is one population and must still be checked.
  const text = [
    "6. The plant was revalued during the year.",
    "7. Repairs charged to revenue were Rs 1.10 lakh, Rs 2.40 lakh and Rs 0.90 lakh, and the",
    "   supporting invoices totalled Rs 3.00 lakh.",
    "8. The revaluation surplus was not disclosed.",
  ].join("\n");

  const found = findNumericalInconsistencies(text);
  assert.equal(found.length, 1, "a list inside one section stopped reconciling");
  assert.equal(found[0].itemCount, 3);
  assert.equal(found[0].itemisedTotalPaise, lakh(4.4));
  assert.equal(found[0].statedTotalPaise, lakh(3));
});

check("a genuine list is not reconciled against a total from the next section", () => {
  // The other half of the boundary, and the half a run-only rule leaves open. Section 4's list is
  // real; the figure in section 5 is about a different subject and merely happens to carry a cue.
  // Pairing them produces a Rs 55.60 lakh difference out of nothing.
  const text = [
    "4. Repairs of Rs 1.10 lakh, Rs 2.40 lakh and Rs 0.90 lakh were charged to revenue.",
    "5. The company could not produce the fixed asset register for Rs 60 lakh of additions.",
  ].join("\n");

  const found = findNumericalInconsistencies(text);
  assert.equal(
    found.length,
    0,
    `a list was reconciled against the next section's figure: ${JSON.stringify(found[0] ?? null)}`,
  );
});

// ── the boundary must not be reachable by wording alone ───────────────────

check("the same list reconciles whatever the population is called", () => {
  // Point 8. If the rule were keyed to vocabulary, renaming the population would change the
  // answer. The three wordings below share no noun, and must produce the identical arithmetic.
  const wordings = [
    "Reimbursement claims of Rs 2.10 lakh, Rs 1.40 lakh and Rs 0.50 lakh were settled. " +
      "Evidence for Rs 3.00 lakh could not be produced.",
    "Godown repairs of Rs 2.10 lakh, Rs 1.40 lakh and Rs 0.50 lakh were incurred. " +
      "Evidence for Rs 3.00 lakh could not be produced.",
    "Legal retainers of Rs 2.10 lakh, Rs 1.40 lakh and Rs 0.50 lakh were charged. " +
      "Evidence for Rs 3.00 lakh could not be produced.",
  ];

  const answers = wordings.map((text) => {
    const found = findNumericalInconsistencies(text);
    assert.equal(found.length, 1, `wording produced ${found.length} reconciliations: ${text}`);
    return found[0].differencePaise;
  });

  assert.deepEqual(answers, [lakh(1), lakh(1), lakh(1)], "the answer depends on the wording");
});

check("and silence is also independent of wording", () => {
  // The mirror of the check above, and the one that matters more: three unrelated figures in three
  // sentences must stay silent whatever they are called.
  const wordings = [
    "The lease is Rs 18 lakh. The generator cost Rs 9 lakh. The transformer was Rs 24 lakh. " +
      "Bills for Rs 4 lakh are missing.",
    "The retainer is Rs 18 lakh. The software cost Rs 9 lakh. The fit-out was Rs 24 lakh. " +
      "Bills for Rs 4 lakh are missing.",
    "The premium is Rs 18 lakh. The freight cost Rs 9 lakh. The duty was Rs 24 lakh. " +
      "Bills for Rs 4 lakh are missing.",
  ];

  for (const text of wordings) {
    const found = findNumericalInconsistencies(text);
    assert.equal(found.length, 0, `unrelated figures were grouped: ${text}`);
  }
});

// ── report ────────────────────────────────────────────────────────────────

console.log(`\nResult: ${passed} passed, ${failed} failed (out of ${passed + failed})`);
if (failed > 0) {
  console.error("\nAA-29 population-boundary contract FAILED.");
  process.exit(1);
}
console.log("AA-29 population-boundary contract OK");
