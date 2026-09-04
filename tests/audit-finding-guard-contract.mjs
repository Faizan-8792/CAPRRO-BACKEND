// Contract for the deterministic finding guards. AA-04 and AA-26 in
// .kiro/audit-assistance-defects.md.
//
// AA-04: a risk indicator and a confirmed misstatement are not the same statement, and the product
// must never make the second on the strength of evidence that supports the first. The reviewer's
// case was output that read "revenue is overstated" from a document that showed only an unexplained
// variance. An auditor who repeats that in a report has made an assertion they cannot support.
//
// AA-26: a citation is a claim. "SA 999" looks exactly as authoritative as "SA 500" to a reader
// skimming a draft, and a fabricated reference is worse than no reference, because it survives
// review by looking correct.
//
// The properties pinned here are SAFETY properties: they say what the product may never emit. A
// safety property must hold on every rendered field, not the two somebody remembered to check -
// AA-02's mutation run found an over-conclusion hiding in `title` for exactly that reason.
//
//   node capro-backend/tests/audit-finding-guard-contract.mjs

import assert from "node:assert/strict";
import {
  FINDING_STATUS,
  RENDERED_FIELDS,
  findOverConclusions,
  findUnknownStandardReferences,
  guardFinding,
  guardFindings,
} from "../src/services/audit-finding-guard.service.js";

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

// ── AA-04: every assertion family is independently load-bearing ────────────
//
// One fixture per pattern. With a shared fixture that trips several patterns at once, deleting any
// one of them still leaves the test green and the deletion ships - the equivalent-mutant hole that
// AA-02 hit and that this layout exists to prevent.

const ASSERTION_FIXTURES = [
  { id: "confirmed-misstatement", text: "Revenue is overstated by Rs 40 lakh." },
  { id: "confirmed-misstatement", text: "The closing inventory was understated." },
  { id: "confirmed-misstatement", text: "Funds have been misappropriated by the cashier." },
  { id: "confirmed-fraud", text: "This is fraudulent billing by the vendor." },
  { id: "confirmed-fraud", text: "The pattern confirms fraud in the purchase cycle." },
  { id: "confirmed-fraud", text: "Fraud has occurred in the reimbursement process." },
  { id: "declared-incorrect", text: "The provision is incorrect." },
  { id: "declared-incorrect", text: "The accounting treatment was improper." },
  { id: "asserted-conclusion", text: "We conclude that the balance cannot be relied upon." },
  { id: "asserted-conclusion", text: "This proves the control was absent all year." },
  { id: "management-guilt", text: "Management has deliberately withheld the ageing schedule." },
];

for (const fixture of ASSERTION_FIXTURES) {
  check(`an assertion is caught: "${fixture.text.slice(0, 46)}"`, () => {
    const hits = findOverConclusions(fixture.text);
    assert.ok(hits.length > 0, "this sentence declares a fact about the client");
    assert.ok(
      hits.some((h) => h.id === fixture.id),
      `expected rule ${fixture.id}, got ${JSON.stringify(hits.map((h) => h.id))}`,
    );
  });
}

// ── AA-04: legitimate audit language must survive ─────────────────────────
//
// A guard that downgrades ordinary working-paper phrasing is not a safety feature, it is a
// different defect. These are the sentences an auditor genuinely writes.

const LEGITIMATE = [
  "Revenue may be overstated if the cut-off was not applied at 31 March.",
  "Test whether revenue is overstated by tracing the last ten dispatches.",
  "Consider whether the provision is incorrect in light of the claims history.",
  "The variance indicates a possible cut-off error that requires testing.",
  "Assess whether funds have been misappropriated once the bank confirmations arrive.",
  "It cannot be confirmed that the balance is misstated on the evidence available.",
  "Management could not produce the ageing schedule when it was requested.",
  "Reconcile the population before testing it.",
  "Parts of this document were not reviewed.",
];

for (const sentence of LEGITIMATE) {
  check(`legitimate audit language survives: "${sentence.slice(0, 46)}"`, () => {
    assert.deepEqual(
      findOverConclusions(sentence),
      [],
      "conditional and instructional language is how audit work is actually written",
    );
  });
}

// ── AA-04: the guard covers every rendered field, not two of them ──────────

check("a conditional sentence does not excuse a flat assertion beside it", () => {
  // The reason the check runs sentence by sentence. A paragraph that opens with proper audit
  // hedging and then states a verdict is the most likely real shape of this defect, and a
  // whole-paragraph check would clear it on the strength of the first sentence.
  const paragraph =
    "The variance may indicate a cut-off error and should be tested against dispatch records. " +
    "Revenue is overstated by Rs 40 lakh.";
  const hits = findOverConclusions(paragraph);
  assert.equal(hits.length, 1, "the second sentence asserts a fact and must be caught alone");
  assert.match(hits[0].sentence, /^Revenue is overstated/, "the assertion, not the hedged opener");

  // And the reverse order, so the result does not depend on which sentence comes first.
  const reversed =
    "Revenue is overstated by Rs 40 lakh. " +
    "The variance may indicate a cut-off error and should be tested against dispatch records.";
  assert.equal(findOverConclusions(reversed).length, 1);
});

check("an over-conclusion is caught in every field a person reads", () => {
  for (const field of RENDERED_FIELDS) {
    const guarded = guardFinding({ [field]: "Revenue is overstated by Rs 40 lakh." });
    assert.ok(
      guarded.guard?.downgraded?.some((note) => note.field === field),
      `field ${field} is rendered to the user and must be guarded`,
    );
    assert.doesNotMatch(
      String(guarded[field]),
      /is overstated/i,
      `field ${field} still asserts the client is overstated`,
    );
  }
});

check("the downgrade is recorded rather than applied invisibly", () => {
  const guarded = guardFinding({
    title: "Revenue is overstated",
    detail: "We conclude that the balance is unusable.",
  });
  assert.ok(Array.isArray(guarded.guard.downgraded));
  assert.equal(guarded.guard.downgraded.length, 2, "one note per assertion, both fields");
  const fields = guarded.guard.downgraded.map((n) => n.field).sort();
  assert.deepEqual(fields, ["detail", "title"]);
  // The note must carry enough to audit the change after the fact.
  for (const note of guarded.guard.downgraded) {
    assert.ok(note.rule, "the note names which rule fired");
    assert.ok(note.sentence.length > 0, "the note quotes what was changed");
  }
});

check("a guarded finding can no longer claim to be a confirmed misstatement", () => {
  const guarded = guardFinding({
    status: FINDING_STATUS.CONFIRMED_MISSTATEMENT,
    detail: "Revenue is overstated by Rs 40 lakh.",
  });
  assert.equal(guarded.status, FINDING_STATUS.POTENTIAL_MISSTATEMENT);
});

check("a clean finding is returned untouched, object identity included", () => {
  const clean = {
    title: "Reconcile the population before testing it",
    detail: "The four components sum to Rs 4.60 lakh against a stated total of Rs 2.86 lakh.",
    standard: "SA 500",
  };
  assert.equal(guardFinding(clean), clean, "no allocation, no guard note, nothing changed");
});

check("the guard drops nothing and preserves order", () => {
  const input = [
    { title: "First" },
    { title: "Revenue is overstated" },
    { title: "Third" },
  ];
  const out = guardFindings(input);
  assert.equal(out.length, 3, "a finding is never removed - only softened");
  assert.equal(out[0].title, "First");
  assert.equal(out[2].title, "Third");
  assert.ok(out[1].guard, "the middle one was guarded in place");
});

check("malformed input never throws", () => {
  for (const value of [null, undefined, 42, "text", [], {}]) {
    guardFinding(value);
  }
  assert.deepEqual(guardFindings(null), []);
  assert.deepEqual(guardFindings("not a list"), []);
  assert.deepEqual(findOverConclusions(null), []);
  assert.deepEqual(findUnknownStandardReferences(undefined), []);
});

// ── AA-26: fabricated standards ───────────────────────────────────────────

check("real standards are accepted across every family", () => {
  const real = [
    "SA 200", "SA 240", "SA 315", "SA 500", "SA 530", "SA 560", "SA 570", "SA 580", "SA 810",
    "SQC 1", "SRE 2400", "SRE 2410", "SAE 3000", "SAE 3420", "SRS 4400", "SRS 4410",
    "AS 2", "AS 29", "IND AS 115", "IND AS 36", "IFRS 15", "IAS 37",
  ];
  for (const reference of real) {
    assert.deepEqual(
      findUnknownStandardReferences(reference),
      [],
      `${reference} is a real standard and must not be flagged`,
    );
  }
});

check("a plausible but non-existent standard is caught", () => {
  const fabricated = ["SA 999", "SA 101", "AS 88", "IND AS 999", "IFRS 42", "IAS 99", "SQC 7"];
  for (const reference of fabricated) {
    const hits = findUnknownStandardReferences(reference);
    assert.equal(hits.length, 1, `${reference} does not exist and must be flagged`);
  }
});

check("a fabricated citation is replaced, never echoed to the reader", () => {
  const guarded = guardFinding({ title: "Sampling", standard: "SA 999" });
  assert.doesNotMatch(guarded.standard, /999/, "the fabricated reference must not survive");
  assert.match(guarded.standard, /verification/i, "it says plainly that it needs checking");
  assert.ok(
    guarded.guard.downgraded.some((n) => n.rule === "unknown-standard-reference"),
    "the substitution is recorded",
  );
});

check("every field that can carry a citation is checked, not just the first", () => {
  // A fabricated reference is no safer for sitting in `auditStandard` than in `standard`, and the
  // original contract only ever populated `standard` - so narrowing the list to that one field was
  // invisible to the tests.
  for (const field of ["standard", "auditStandard", "accountingGuidance"]) {
    const guarded = guardFinding({ title: "Sampling", [field]: "SA 999" });
    assert.doesNotMatch(
      String(guarded[field]),
      /999/,
      `a fabricated citation in ${field} reaches the reader just the same`,
    );
    assert.ok(
      guarded.guard?.downgraded?.some(
        (n) => n.field === field && n.rule === "unknown-standard-reference",
      ),
      `the substitution in ${field} must be recorded`,
    );
  }
});

check("a real citation passes through the guard unchanged", () => {
  const guarded = guardFinding({ title: "Sampling", standard: "SA 530" });
  assert.equal(guarded.standard, "SA 530");
  assert.equal(guarded.guard, undefined);
});

check("a fabricated standard planted in the submitted document is not repeated", () => {
  // Prompt-injection shape: the document itself asserts an authority that does not exist. Echoing
  // it would let a client's own text dictate the standard the working paper cites.
  const guarded = guardFinding({
    title: "Related parties",
    standard: "SA 1200",
    detail: "The note states that disclosure follows the applicable framework.",
  });
  assert.doesNotMatch(guarded.standard, /1200/);
});

check("statutory section references are left alone", () => {
  // "section 188" is a Companies Act reference whose validity this list cannot judge. Flagging it
  // would be a worse failure than silence, because it would train the reader to ignore the guard.
  for (const text of [
    "Refer section 188 of the Companies Act, 2013.",
    "Clause 3(i)(a) of the CARO report.",
    "Rule 11(e) requires the disclosure.",
    "Section 34(3) of the CGST Act applies to the debit note.",
  ]) {
    assert.deepEqual(findUnknownStandardReferences(text), [], text);
  }
});

check("an unrecognised prefix is not treated as a fabrication", () => {
  // The list can only judge the families it knows. "ISA 500" is the international numbering and
  // "PCAOB 2201" the US one - both real, both outside this list - and asserting they do not exist
  // would itself be a false statement. This test was vacuous in its first form: the pattern only
  // matched the nine known prefixes, so nothing here reached the decision it claimed to test. The
  // pattern now captures any capitalised prefix, which is what makes the assertion real.
  for (const text of ["ISA 500", "PCAOB 2201", "ISQM 1", "GAAS 300", "GSTR 3"]) {
    assert.deepEqual(
      findUnknownStandardReferences(text),
      [],
      `${text} uses a numbering this module cannot judge, so it must stay silent`,
    );
  }
});

check("ordinary prose that reads like a citation is not flagged", () => {
  // Case is the discriminator. Matching case-insensitively made "such as 88 vouchers" resolve to
  // AS 88, which is outside the AS range, and the guard reported the client's own sentence as a
  // fabricated accounting standard. A citation is capitalised; prose is not.
  for (const text of [
    "We inspected items such as 88 vouchers and 12 delivery challans.",
    "The sample was selected as 40 items from the ledger.",
    "Balances as 31 March were agreed to the confirmations.",
  ]) {
    assert.deepEqual(findUnknownStandardReferences(text), [], text);
  }
});

// ── the AA-02 finding must still pass through untouched ───────────────────

check("the AA-02 numerical finding survives the guard unchanged", () => {
  // Regression protection across defects: AA-02 is closed and live, and its wording was chosen
  // precisely so it states an arithmetic fact without asserting a misstatement. If the AA-04 guard
  // starts rewriting it, the guard has become too broad.
  const aa02 = {
    title: "Reconcile the population before testing it",
    detail:
      "Four amounts in this passage sum to Rs 4.60 lakh, against a stated total of Rs 2.86 lakh - " +
      "a difference of Rs 1.74 lakh.",
    risk: "high",
    standard: "SA 500",
    why: "A population that does not reconcile cannot support a conclusion drawn from it.",
    nextAction: "Agree the components to the total before performing any further procedure.",
  };
  assert.equal(guardFinding(aa02), aa02, "AA-02's wording must pass through untouched");
});

check("the AA-01 coverage declaration survives the guard unchanged", () => {
  const aa01 = {
    title: "Parts of this document were not reviewed",
    detail:
      "This text contains 9 matters that call for audit attention. 2 of them have a finding " +
      "above. The following did not: 3, 4, 5. Treat those as not yet reviewed rather than as " +
      "reviewed and clear.",
    standard: "SA 230",
    nextAction: "Re-run the review on the sections named above, or record your own conclusion.",
  };
  assert.equal(guardFinding(aa01), aa01);
});

// ── report ───────────────────────────────────────────────────────────────

console.log(`\nResult: ${passed} passed, ${failed} failed (out of ${passed + failed})`);
if (failed > 0) {
  console.error("\nAA-04 / AA-26 finding-guard contract FAILED.");
  process.exit(1);
}
console.log("AA-04 / AA-26 finding-guard contract OK");
