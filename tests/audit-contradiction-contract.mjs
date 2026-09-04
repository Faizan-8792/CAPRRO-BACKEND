// Contract for contradiction detection. AA-03 in .kiro/audit-assistance-defects.md.
//
// The defect: three documents each stated a clean position in one place and the opposite a few
// lines later, and the product reported neither the conflict nor the fact that it had read both.
// A contradiction is the one finding an auditor can act on with no further evidence, because the
// document has already supplied both halves.
//
// The property that matters most here is NEGATIVE: the product must not pick a side. Deciding which
// statement is true is a question for evidence, and quietly resolving it would delete the finding -
// the reader would never learn the document disagreed with itself. So the tests below check that
// BOTH statements are quoted, not that the right one was chosen.
//
//   node capro-backend/tests/audit-contradiction-contract.mjs

import assert from "node:assert/strict";
import {
  splitSentences,
  findContradictions,
  buildContradictionInsights,
} from "../src/services/audit-contradiction.service.js";
import { guardFinding, findOverConclusions } from "../src/services/audit-finding-guard.service.js";

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

// ── the three cases named in the mandate, verbatim in shape ────────────────

const MANDATE_CASES = [
  {
    id: "related-parties",
    text:
      "Management has confirmed that there are no related parties requiring disclosure.\n" +
      "The schedule of shareholders shows that a director's spouse owns 12% of the equity.\n",
    denialContains: "no related parties",
    affirmationContains: "spouse owns 12%",
  },
  {
    id: "statutory-dues",
    text:
      "Management represents that all statutory dues were paid on time during the year.\n" +
      "The TDS reconciliation shows Rs. 5.20 lakh was paid after the due date in November.\n",
    denialContains: "all statutory dues were paid on time",
    affirmationContains: "after the due date",
  },
  {
    id: "litigation",
    text:
      "The representation letter states there is no outstanding legal uncertainty.\n" +
      "Counsel has advised in writing that the outcome cannot be predicted at this stage.\n",
    denialContains: "no outstanding legal uncertainty",
    affirmationContains: "outcome cannot be predicted",
  },
];

for (const testCase of MANDATE_CASES) {
  check(`the mandate's ${testCase.id} case is detected`, () => {
    const found = findContradictions(testCase.text);
    assert.equal(found.length, 1, `expected one contradiction, got ${found.length}`);
    assert.equal(found[0].id, testCase.id);
    assert.ok(
      found[0].denial.quote.toLowerCase().includes(testCase.denialContains.toLowerCase()),
      `denial quote must carry "${testCase.denialContains}", got "${found[0].denial.quote}"`,
    );
    assert.ok(
      found[0].affirmation.quote
        .toLowerCase()
        .includes(testCase.affirmationContains.toLowerCase()),
      `affirmation quote must carry "${testCase.affirmationContains}", got "${found[0].affirmation.quote}"`,
    );
  });

  check(`the ${testCase.id} finding quotes both statements and resolves neither`, () => {
    const [insight] = buildContradictionInsights(testCase.text);
    assert.ok(insight, "a contradiction must produce a finding");

    // Both halves must reach the reader. This is the whole defect: the product previously showed
    // at most one side, or neither.
    assert.ok(
      insight.detail.includes(testCase.denialContains) ||
        insight.detail.toLowerCase().includes(testCase.denialContains.toLowerCase()),
      "the denial must appear in the finding",
    );
    assert.ok(
      insight.detail.toLowerCase().includes(testCase.affirmationContains.toLowerCase()),
      "the affirmation must appear in the finding",
    );

    // And it must not announce which one is right.
    for (const forbidden of [
      /\bthe (?:first|second) statement is (?:false|untrue|incorrect|wrong)\b/i,
      /\bmanagement (?:lied|misrepresented)\b/i,
      /\btherefore the representation is false\b/i,
    ]) {
      assert.doesNotMatch(insight.detail, forbidden, "the finding must not pick a side");
    }
    assert.match(insight.detail, /establish which/i, "it asks the reader to settle it");
  });
}

check("the finding names the conflict in its title", () => {
  const [insight] = buildContradictionInsights(MANDATE_CASES[0].text);
  assert.match(insight.title, /cannot both be true/i);
  assert.match(insight.title, /related parties/i, "the subject is named, not just 'a conflict'");
});

// ── every family independently load-bearing ────────────────────────────────
//
// One fixture per family. A shared fixture that trips several families at once lets the deletion of
// any one of them stay green - the equivalent-mutant hole AA-02 hit, and the reason this file is
// laid out the long way.

const FAMILY_FIXTURES = [
  {
    id: "related-parties",
    text:
      "The company has no related party transactions during the year under review.\n" +
      "A common directorship exists with the supplier that billed Rs 84 lakh.\n",
  },
  {
    id: "statutory-dues",
    text:
      "There are no outstanding statutory dues as at the balance sheet date.\n" +
      "Provident fund contributions were remitted belatedly in three of the twelve months.\n",
  },
  {
    id: "litigation",
    text:
      "The company confirms there is no pending litigation against it.\n" +
      "A show cause notice was received from the department in February 2026.\n",
  },
  {
    id: "going-concern",
    text:
      "There is no material uncertainty relating to the going concern assumption.\n" +
      "The company was unable to refinance the term loan falling due in June 2026.\n",
  },
  {
    id: "internal-controls",
    text:
      "The internal financial controls were operating effectively throughout the year.\n" +
      "There is no segregation of duties in the cash receipts process at the branch.\n",
  },
  {
    id: "physical-verification",
    text:
      "Physical verification of inventory was carried out at all four locations.\n" +
      "The godown at Bhiwandi has had no cycle count performed since October 2025.\n",
  },
  {
    id: "subsequent-events",
    text:
      "There are no material subsequent events requiring adjustment or disclosure.\n" +
      "Subsequent to the year end the largest distributor cancelled its committed order book.\n",
  },
  {
    id: "borrowing-default",
    text:
      "All loan repayments were made on time and no covenant was breached.\n" +
      "The net debt to EBITDA covenant was breached at 31 March 2026 and remains unwaived.\n",
  },
];

for (const fixture of FAMILY_FIXTURES) {
  check(`the ${fixture.id} family is independently load-bearing`, () => {
    const found = findContradictions(fixture.text);
    assert.ok(
      found.some((item) => item.id === fixture.id),
      `expected family ${fixture.id}, got ${JSON.stringify(found.map((f) => f.id))}`,
    );
  });
}

// ── inflected forms, because this bug class has now appeared three times ───
//
// A closing \b after a stem or a singular noun silently refuses the form the document actually
// uses. AA-01 had /\bcapitalis\b/ against "capitalised" and dropped two real matters. This module
// shipped /\bbelated\b/ against "remitted belatedly" and dropped a whole family. Reading the
// patterns did not catch either one - both times the fixture caught it - so the inflections are
// pinned here rather than trusted to review.

const INFLECTION_FIXTURES = [
  {
    id: "statutory-dues",
    why: "belatedly, not belated",
    text:
      "There are no outstanding statutory dues as at the balance sheet date.\n" +
      "Provident fund contributions were remitted belatedly in three of the twelve months.\n",
  },
  {
    id: "statutory-dues",
    why: "plural payments",
    text:
      "There are no outstanding statutory dues as at the balance sheet date.\n" +
      "There were delays in the payments of tax deducted at source during the year.\n",
  },
  {
    id: "litigation",
    why: "plural notices",
    text:
      "The company confirms there is no pending litigation against it.\n" +
      "Two show cause notices were received from the department during February 2026.\n",
  },
  {
    id: "litigation",
    why: "plural demands",
    text:
      "The company confirms there is no pending litigation against it.\n" +
      "Disputed demands of Rs 1.80 crore are carried forward under appeal.\n",
  },
  {
    id: "going-concern",
    why: "exceeded, not exceed",
    text:
      "There is no material uncertainty relating to the going concern assumption.\n" +
      "Accumulated losses at the year end exceeded the paid up capital and reserves.\n",
  },
  {
    id: "going-concern",
    why: "plural cash flows",
    text:
      "There is no material uncertainty relating to the going concern assumption.\n" +
      "The company reported negative operating cash flows for the second successive year.\n",
  },
  {
    id: "internal-controls",
    why: "plural weaknesses",
    text:
      "The internal financial controls were operating effectively throughout the year.\n" +
      "Two material weaknesses were noted in the approval of vendor master changes.\n",
  },
  {
    id: "internal-controls",
    why: "lack of segregation, not no segregation",
    text:
      "The internal financial controls were operating effectively throughout the year.\n" +
      "There is a lack of segregation of duties in the cash receipts process.\n",
  },
  {
    id: "physical-verification",
    why: "plural counts",
    text:
      "Physical verification of inventory was carried out at all four locations.\n" +
      "The Bhiwandi godown has had no counts performed since October 2025.\n",
  },
  {
    id: "related-parties",
    why: "plural directorships",
    text:
      "The company has no related party transactions during the year under review.\n" +
      "Common directorships exist with two of the suppliers billing above Rs 50 lakh.\n",
  },
  {
    id: "borrowing-default",
    why: "plural repayments",
    text:
      "There has been no default in the repayment of principal or interest.\n" +
      "The company defaulted on the repayments falling due in January and February.\n",
  },
];

for (const fixture of INFLECTION_FIXTURES) {
  check(`${fixture.id} matches an inflected form (${fixture.why})`, () => {
    const found = findContradictions(fixture.text);
    assert.ok(
      found.some((item) => item.id === fixture.id),
      `expected ${fixture.id}, got ${JSON.stringify(found.map((f) => f.id))}`,
    );
  });
}

// ── it must not cry wolf ───────────────────────────────────────────────────

check("a properly qualified denial is not a contradiction", () => {
  // This is how a well-drafted note reads. Firing here would make the check useless on good
  // documents, and a check that flags correct work teaches the reader to ignore it.
  const text =
    "There are no related parties other than those disclosed in Note 32 to the accounts.\n" +
    "The director's spouse owns 12% of the equity, as set out in that note.\n";
  assert.deepEqual(findContradictions(text), []);
});

check("both halves in one sentence is one statement, not a conflict", () => {
  // The document needs a second sentence for this to test anything. With only one sentence the
  // `sentences.length < 2` early return does the work and the different-sentence rule is never
  // reached - the first version of this test passed for that reason and would have stayed green if
  // the rule were deleted.
  const text =
    "Inventory of Rs 4.20 crore was verified against the count sheets without exception.\n" +
    "Although there are no related parties, a director's spouse owns 12% of the equity.\n";
  assert.equal(splitSentences(text).length, 2, "the fixture must have two sentences to be a test");
  assert.deepEqual(
    findContradictions(text),
    [],
    "one sentence cannot contradict itself across two quotes",
  );
});

check("a denial with nothing to contradict it is left alone", () => {
  const text =
    "Management has confirmed that there are no related parties requiring disclosure.\n" +
    "Inventory of Rs 4.20 crore was verified against the count sheets without exception.\n";
  assert.deepEqual(findContradictions(text), []);
});

check("an adverse fact with no denial beside it is left alone", () => {
  // Not every bad fact is a contradiction. Without a clean assertion to conflict with, this is
  // ordinary audit content and belongs to the other checks.
  const text =
    "A show cause notice was received from the department in February 2026.\n" +
    "Rs 5.20 lakh of TDS was paid after the due date in November.\n";
  assert.deepEqual(findContradictions(text), []);
});

check("a clean document produces nothing", () => {
  const text =
    "Inventory of Rs 4.20 crore was verified against the count sheets without exception.\n" +
    "Trade receivables of Rs 2.80 crore were circularised and all replies were reconciled.\n" +
    "Depreciation was recomputed on the fixed asset register and agreed to the ledger.\n";
  assert.deepEqual(findContradictions(text), []);
});

check("empty and non-string input is handled without throwing", () => {
  for (const value of ["", "   ", null, undefined, 42, {}, []]) {
    assert.deepEqual(findContradictions(value), []);
    assert.deepEqual(buildContradictionInsights(value), []);
    assert.deepEqual(splitSentences(value), []);
  }
});

// ── the sentence splitter, because the finding IS the two quotes ───────────

check("an abbreviation's full stop does not split a quote", () => {
  // "Rs. 5.20 lakh was paid after the due date" must survive as one sentence, or the quote shown
  // to the reader is a fragment and the finding loses the amount that makes it matter.
  const sentences = splitSentences("Rs. 5.20 lakh was paid after the due date in November.");
  assert.equal(sentences.length, 1, `expected one sentence, got ${sentences.length}`);
  assert.match(sentences[0].text, /^Rs\. 5\.20 lakh/);
});

check("sentence offsets locate the statement in the original text", () => {
  const text = "First sentence here. Second sentence here. Third sentence here.";
  for (const sentence of splitSentences(text)) {
    assert.equal(
      text.slice(sentence.start, sentence.start + sentence.text.length),
      sentence.text,
      "the offset must point at the sentence it came from",
    );
  }
});

check("a quote is verbatim from the submitted text", () => {
  // The controller's grounding rule: an evidence quote must appear in the document. A finding whose
  // evidence cannot be found would be indistinguishable from an invented one.
  const { text } = MANDATE_CASES[1];
  const [insight] = buildContradictionInsights(text);
  const normalise = (v) => String(v).replace(/\s+/g, " ").trim();
  assert.ok(
    normalise(text).includes(normalise(insight.evidence)),
    `evidence must appear verbatim in the text: "${insight.evidence}"`,
  );
});

// ── volume and ordering ───────────────────────────────────────────────────

check("a document full of conflicts is capped rather than flooding the response", () => {
  const text = FAMILY_FIXTURES.map((f) => f.text).join("\n");
  const found = findContradictions(text);
  assert.ok(found.length > 1, "several families genuinely conflict in this document");
  assert.ok(found.length <= 4, `capped at four, got ${found.length}`);
  // The cap must not silently drop everything either.
  assert.equal(found.length, 4);
});

check("each reported contradiction is a distinct subject", () => {
  const text = FAMILY_FIXTURES.map((f) => f.text).join("\n");
  const ids = findContradictions(text).map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length, "no subject is reported twice");
});

// ── cross-defect regression protection ────────────────────────────────────

check("the contradiction finding passes the AA-04 guard unchanged", () => {
  // If the AA-04 over-conclusion guard has to rewrite this wording, the wording asserts something
  // it should not. Pinning it here means neither defect can drift into the other.
  for (const testCase of MANDATE_CASES) {
    for (const insight of buildContradictionInsights(testCase.text)) {
      assert.deepEqual(
        findOverConclusions(insight.detail),
        [],
        `detail over-concludes: ${insight.detail}`,
      );
      assert.equal(
        guardFinding(insight),
        insight,
        "the guard must return the identical object, having found nothing to soften",
      );
    }
  }
});

check("the cited standard is a real one, so AA-26 has nothing to replace", () => {
  const text = FAMILY_FIXTURES.map((f) => f.text).join("\n");
  for (const insight of buildContradictionInsights(text)) {
    const guarded = guardFinding(insight);
    assert.equal(
      guarded.standard,
      insight.standard,
      `${insight.standard} was replaced, so it is not in the known families`,
    );
  }
});

// ── report ───────────────────────────────────────────────────────────────

console.log(`\nResult: ${passed} passed, ${failed} failed (out of ${passed + failed})`);
if (failed > 0) {
  console.error("\nAA-03 contradiction contract FAILED.");
  process.exit(1);
}
console.log("AA-03 contradiction contract OK");
