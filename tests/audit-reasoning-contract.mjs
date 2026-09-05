// Contract for the reasoning frameworks. AA-05, AA-15, AA-23, AA-24 and AA-25 in
// .kiro/audit-assistance-defects.md.
//
// Each is the same failure in a different subject: a conclusion reached before the question that
// decides it has been asked. So the tests below are mostly NEGATIVE - they assert that the tempting
// conclusion does NOT appear, and that the question which should have come first does.
//
//   node capro-backend/tests/audit-reasoning-contract.mjs

import assert from "node:assert/strict";
import {
  ESCALATION_LADDER,
  ESTIMATE_DIMENSIONS,
  PROHIBITED_CONCLUSIONS,
  assessFraudTriangle,
  buildAlternativeProcedures,
  buildEscalationPath,
  buildEstimateFramework,
  findPrecedentQuestions,
} from "../src/services/audit-reasoning.service.js";

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

// ── AA-05: the question that comes first ──────────────────────────────────

const AA05_CASES = [
  {
    id: "depreciation-start",
    text:
      "Plant was capitalised on 15 March 2026 and the invoice is dated 12 March. Depreciation was charged from 15 March.",
    mustAsk: /available for use/i,
    mustNotConclude: /\bdepreciation (?:should|must) (?:start|commence|begin) (?:on|from) \d/i,
  },
  {
    id: "related-party-price",
    text:
      "A purchase of Rs 84 lakh was made from a related party. A quotation from another supplier shows a lower rate.",
    mustAsk: /comparab/i,
    mustNotConclude: /\bthe (?:related[- ]party )?price (?:is|was) excessive\b/i,
  },
  {
    id: "provision-adequacy",
    text:
      "A warranty provision of Rs 22 lakh is carried. Claims of Rs 19 lakh were settled after the year end.",
    mustAsk: /same period and the same obligation/i,
    mustNotConclude: /\bthe provision (?:is|was) (?:inadequate|insufficient|understated)\b/i,
  },
];

for (const testCase of AA05_CASES) {
  check(`AA-05 ${testCase.id}: the precedent question is asked`, () => {
    const found = findPrecedentQuestions(testCase.text);
    const entry = found.find((f) => f.id === testCase.id);
    assert.ok(entry, `expected ${testCase.id}, got ${JSON.stringify(found.map((f) => f.id))}`);
    assert.match(entry.question, testCase.mustAsk);
    assert.ok(entry.factors.length >= 3, "the comparability factors must be named, not gestured at");
    for (const factor of entry.factors) {
      assert.ok(factor.length > 20, `a factor is too short to act on: "${factor}"`);
    }
  });

  check(`AA-05 ${testCase.id}: the prohibited conclusion never appears`, () => {
    const found = findPrecedentQuestions(testCase.text);
    const entry = found.find((f) => f.id === testCase.id);
    const everything = [entry.question, ...entry.factors].join(" ");
    assert.doesNotMatch(everything, testCase.mustNotConclude, "it must ask, never conclude");
  });
}

check("AA-05: the subject alone raises no question without the circumstance", () => {
  // "Depreciation was recomputed and agreed" raises nothing. Producing a precedent question for
  // every mention of depreciation would bury the cases that matter.
  assert.deepEqual(
    findPrecedentQuestions("Depreciation was recomputed on the register and agreed to the ledger."),
    [],
  );
  assert.deepEqual(findPrecedentQuestions("A provision of Rs 22 lakh is carried."), []);
  assert.deepEqual(findPrecedentQuestions(""), []);
  assert.deepEqual(findPrecedentQuestions(null), []);
});

check("AA-05: every prohibited conclusion is expressible, so the guards are real", () => {
  // A guard against a pattern that could never match anything is decoration. Each prohibited
  // pattern is checked against a sentence that DOES trip it, proving the guard has a target.
  const tripping = {
    "depreciation-start": "Depreciation should start from 15 March 2026.",
    "related-party-price": "The related-party price was excessive.",
    "provision-adequacy": "The provision is inadequate.",
  };
  for (const { id, pattern } of PROHIBITED_CONCLUSIONS) {
    assert.match(tripping[id], pattern, `the ${id} guard matches nothing, so it guards nothing`);
  }
});

// ── AA-15: a ladder, climbed in order ─────────────────────────────────────

check("AA-15 a refusal produces the whole ladder, in order", () => {
  const path = buildEscalationPath(
    "Management refused to provide the listing of manual journal entries posted at the year end.",
  );
  assert.ok(path, "a refusal must produce an escalation path");
  assert.equal(path.steps.length, 6);
  assert.match(path.steps[0], /understand why/i, "the first rung is understanding, not reporting");
  assert.match(path.steps[1], /management/i);
  assert.match(path.steps[2], /those charged with governance/i);
  assert.match(path.steps[3], /another source|alternative/i);
  assert.match(path.steps[4], /sufficient/i);
  assert.match(path.steps[5], /only if/i, "the reporting consequence is conditional");
});

check("AA-15 the reporting consequence is never presented as automatic", () => {
  const path = buildEscalationPath("The client declined to give us access to the bank statements.");
  // The defect was arriving at the last rung first.
  assert.match(path.note, /not itself a qualification/i);
  for (const step of path.steps.slice(0, 5)) {
    assert.doesNotMatch(
      step,
      /\b(?:qualif|disclaim|adverse opinion)\w*/i,
      `a reporting outcome appears at rung "${step.slice(0, 40)}", before the ladder is climbed`,
    );
  }
});

check("AA-15 text with no refusal produces no escalation", () => {
  assert.equal(buildEscalationPath("The listing was provided and agreed to the ledger."), null);
  assert.equal(buildEscalationPath(""), null);
  assert.equal(buildEscalationPath(null), null);
});

const REFUSAL_FIXTURES = [
  "Management refused to provide the schedule.",
  "The finance manager declined to share the reconciliation.",
  "The listing was withheld from us.",
  "The client would not provide the bank statements.",
  "We were denied access to the subsidiary ledger.",
  "The schedule was not made available to us.",
];
for (const text of REFUSAL_FIXTURES) {
  check(`AA-15 refusal cue is load-bearing: "${text.slice(0, 42)}"`, () => {
    assert.ok(buildEscalationPath(text), text);
  });
}

// ── AA-23: name the mechanism, and what is missing from it ────────────────

check("AA-23 all three legs present is the strongest form, and still an indicator", () => {
  const assessment = assessFraudTriangle(
    "The covenant is close to breach. There is no segregation of duties over manual journal entries, " +
      "and the entries are described as a year-end adjustment that will be reversed.",
  );
  assert.deepEqual(assessment.present.sort(), ["opportunity", "pressure", "rationalisation"]);
  assert.deepEqual(assessment.missing, []);
  assert.match(assessment.note, /still an indicator/i, "three legs is not a conclusion");
});

check("AA-23 a missing leg is named, with what would establish it", () => {
  // The useful half. Pressure and opportunity without rationalisation is a weaker thing, and an
  // assessment that does not say which legs it rests on cannot be argued with.
  const assessment = assessFraudTriangle(
    "The covenant is close to breach and there is no segregation of duties in the journal process.",
  );
  assert.deepEqual(assessment.present.sort(), ["opportunity", "pressure"]);
  assert.equal(assessment.missing.length, 1);
  assert.equal(assessment.missing[0].leg, "rationalisation");
  assert.match(assessment.missing[0].prompt, /story|acceptable/i);
  assert.match(assessment.note, /Not established from this text/i);
});

check("AA-23 removing an indicator changes the assessment", () => {
  // The ledger's own requirement, stated as a differential test.
  const withOpportunity = assessFraudTriangle(
    "The bonus target was missed. There is no segregation of duties in the journal process.",
  );
  const withoutOpportunity = assessFraudTriangle("The bonus target was missed.");
  assert.notDeepEqual(
    withOpportunity.present.sort(),
    withoutOpportunity.present.sort(),
    "taking away the opportunity must change what the assessment rests on",
  );
  assert.ok(withoutOpportunity.missing.some((m) => m.leg === "opportunity"));
});

check("AA-23 no leg at all produces nothing rather than an empty triangle", () => {
  assert.equal(assessFraudTriangle("Inventory was counted at three locations."), null);
  assert.equal(assessFraudTriangle(""), null);
});

check("AA-23 never returns a score", () => {
  // "Two of three" would be read as a probability. It is not one.
  const assessment = assessFraudTriangle("The covenant is close to breach and controls are weak.");
  assert.doesNotMatch(assessment.note, /\d+\s*%|\b\d\s*(?:of|out of)\s*3\b/i);
});

// ── AA-24: the eight questions an estimate has to answer ──────────────────

check("AA-24 an estimate produces all eight dimensions", () => {
  const framework = buildEstimateFramework(
    "A warranty provision of Rs 22 lakh is carried against historical claims of Rs 54 lakh.",
  );
  assert.ok(framework);
  assert.equal(framework.dimensions.length, 8);
  const ids = framework.dimensions.map((d) => d.id);
  for (const required of [
    "method",
    "data",
    "assumptions",
    "historical-accuracy",
    "subsequent-outcome",
    "bias-indicators",
    "sensitivity",
    "independent-expectation",
  ]) {
    assert.ok(ids.includes(required), `the ${required} dimension is missing`);
  }
});

check("AA-24 historical accuracy is present and explained, being the one most often skipped", () => {
  const framework = buildEstimateFramework("The ECL provision was computed on the ageing.");
  const historical = framework.dimensions.find((d) => d.id === "historical-accuracy");
  assert.match(historical.question, /last year/i);
  assert.match(historical.question, /consistently/i, "consistency is not correctness");
  assert.match(framework.note, /most often skipped/i);
});

check("AA-24 bias is framed as the combination, not one assumption", () => {
  const framework = buildEstimateFramework("The impairment assessment uses a discount rate.");
  const bias = framework.dimensions.find((d) => d.id === "bias-indicators");
  assert.match(bias.question, /favourable end/i);
  assert.match(bias.question, /combination/i, "each assumption may be defensible alone");
});

check("AA-24 text with no estimate produces nothing", () => {
  assert.equal(buildEstimateFramework("The bank balance was confirmed directly."), null);
  assert.equal(buildEstimateFramework(""), null);
});

// ── AA-25: what to do when it does not come back ──────────────────────────

check("AA-25 an unanswered confirmation produces the alternative branch", () => {
  const branch = buildAlternativeProcedures(
    "The balance confirmation from Orion Traders has not been received.",
  );
  assert.ok(branch);
  assert.ok(branch.steps.length >= 5);
  assert.match(branch.steps.join(" "), /subsequent cash|receipts or payments after/i);
  assert.match(branch.steps.join(" "), /underlying document/i);
});

check("AA-25 the branch ends in documenting the limitation", () => {
  // The step that was missing. An unanswered confirmation that leaves no trace is
  // indistinguishable from one that was never sent.
  const branch = buildAlternativeProcedures("No reply was received to the circularisation.");
  const last = branch.steps[branch.steps.length - 1];
  assert.match(last, /document the limitation/i);
  assert.match(last, /never sent/i);
});

check("AA-25 a received confirmation produces no branch", () => {
  assert.equal(
    buildAlternativeProcedures("The confirmation was received directly from the bank and agreed."),
    null,
  );
  assert.equal(buildAlternativeProcedures("The balance was agreed to the ledger."), null);
  assert.equal(buildAlternativeProcedures(""), null);
});

check("AA-25 requires BOTH a confirmation and a non-response", () => {
  // Either alone is not this situation, and producing the branch for either would attach it to
  // findings that have nothing to do with confirmations.
  assert.equal(buildAlternativeProcedures("The confirmation was sent on 3 April."), null);
  assert.equal(buildAlternativeProcedures("No reply was received to our email about the count."), null);
});

// ── report ────────────────────────────────────────────────────────────────

console.log(`\nResult: ${passed} passed, ${failed} failed (out of ${passed + failed})`);
if (failed > 0) {
  console.error("\nAA-05 / AA-15 / AA-23 / AA-24 / AA-25 reasoning contract FAILED.");
  process.exit(1);
}
console.log("AA-05 / AA-15 / AA-23 / AA-24 / AA-25 reasoning contract OK");
