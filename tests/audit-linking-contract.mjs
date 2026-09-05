// Contract for stratification and cross-issue linking. AA-11, AA-12 and AA-18 in
// .kiro/audit-assistance-defects.md.
//
//   AA-11/12  "Select a sample" for a population the text has already divided. A uniform sample
//             across sub-populations of different risk tests the least risky part hardest.
//   AA-18     A covenant breach in one section and going concern in another are the same problem
//             seen twice. Presented as independent cards, the reader has to notice the connection
//             themselves - and noticing it for them is the whole point of reading the document at
//             once.
//
//   node capro-backend/tests/audit-linking-contract.mjs

import assert from "node:assert/strict";
import {
  buildStratificationPlan,
  findCrossIssueLinks,
  findStrata,
} from "../src/services/audit-linking.service.js";

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

// ── AA-11 / AA-12: the population is already divided ──────────────────────

// The reviewer's own chain: revenue -> March -> last six days -> manual JEs -> related party ->
// unusual terms -> post-year-end credit notes.
const REVIEWER_CHAIN =
  "Revenue testing should consider entries in the last six days of March, manual journal entries, " +
  "transactions with related parties, sales on unusual terms such as sale and repurchase, and " +
  "credit notes raised after the period end.";

check("the reviewer's own sub-populations are all identified", () => {
  const ids = findStrata(REVIEWER_CHAIN).map((s) => s.id);
  for (const required of [
    "period-end-timing",
    "manual-entries",
    "related-party",
    "unusual-terms",
    "credit-notes",
  ]) {
    assert.ok(ids.includes(required), `missing stratum ${required}, got ${JSON.stringify(ids)}`);
  }
});

check("each stratum states why it is different and how to test it", () => {
  // A stratum without a reason is a filter, not a strategy.
  for (const stratum of findStrata(REVIEWER_CHAIN)) {
    assert.ok(stratum.why.length > 30, `${stratum.id}: the reason is too thin`);
    assert.ok(stratum.approach.length > 25, `${stratum.id}: the approach is too thin`);
    assert.doesNotMatch(
      stratum.approach,
      /\bselect a sample\b\.?$/i,
      `${stratum.id}: "select a sample" is the defect, not the fix`,
    );
  }
});

check("the plan names the residual population explicitly", () => {
  // Strata that do not add up to the whole leave a remainder nobody decided about, and that is
  // exactly where an untested item hides.
  const plan = buildStratificationPlan(REVIEWER_CHAIN);
  assert.ok(plan.residual, "the remainder must be named");
  assert.match(plan.residual, /nobody chose to look at|remainder/i);
});

check("a uniform sample is called out when several strata exist", () => {
  const plan = buildStratificationPlan(REVIEWER_CHAIN);
  assert.match(plan.note, /least risky part hardest/i);
});

check("one identifiable stratum is described differently from several", () => {
  const single = buildStratificationPlan("Test the manual journal entries posted this year.");
  assert.equal(single.strata.length, 1);
  assert.match(single.note, /One sub-population/i);
});

const STRATUM_FIXTURES = [
  { id: "period-end-timing", text: "Entries posted in the last six days of the period." },
  { id: "manual-entries", text: "Manual journal entries were posted at the year end." },
  { id: "related-party", text: "Transactions with related parties during the year." },
  { id: "unusual-terms", text: "A sale and repurchase arrangement was identified." },
  { id: "credit-notes", text: "Credit notes were raised in the first week of April." },
  { id: "high-value", text: "All items above Rs 10 lakh were listed." },
  { id: "new-counterparties", text: "Several new suppliers were added during the year." },
];

for (const fixture of STRATUM_FIXTURES) {
  check(`stratum is load-bearing: ${fixture.id}`, () => {
    const ids = findStrata(fixture.text).map((s) => s.id);
    assert.ok(ids.includes(fixture.id), `expected ${fixture.id}, got ${JSON.stringify(ids)}`);
  });
}

check("a population the text does not divide yields no strata", () => {
  // Inventing strata would be worse than offering none: it would tell an auditor the population
  // divides in a way the document never said.
  assert.deepEqual(findStrata("Trade receivables were circularised and replies reconciled."), []);
  assert.equal(buildStratificationPlan("Trade receivables were circularised."), null);
  assert.deepEqual(findStrata(""), []);
  assert.deepEqual(findStrata(null), []);
});

// ── AA-18: the same problem seen twice ────────────────────────────────────

const covenantFinding = {
  title: "Test the net debt to EBITDA covenant",
  detail: "Borrowings of Rs 11.20 crore carry a covenant tested on net debt to EBITDA.",
  evidence: "a covenant tested on net debt to EBITDA",
};
const goingConcernFinding = {
  title: "Assess the going concern assumption",
  detail: "The company was unable to refinance the term loan falling due in June.",
  evidence: "unable to refinance the term loan",
};

check("AA-18 the ledger's own case: a covenant in one finding and going concern in another", () => {
  const links = findCrossIssueLinks([covenantFinding, goingConcernFinding]);
  const link = links.find((l) => l.id === "covenant-to-going-concern");
  assert.ok(link, `expected the covenant link, got ${JSON.stringify(links.map((l) => l.id))}`);
  assert.equal(link.fromIndex, 0);
  assert.equal(link.toIndex, 1);
  assert.match(link.because, /repayable on demand/i, "the link states WHY, not just that");
  assert.match(link.then, /waiver/i, "and what to do about the pair");
});

check("AA-18 a link states its direction", () => {
  // A covenant breach raises going-concern doubt; going-concern doubt does not cause a covenant
  // breach. A link that does not say which way it runs is a hint, not a finding.
  //
  // The INDICES are asserted as well as the titles. A mutation that set fromIndex/toIndex to
  // min/max - losing the direction entirely - survived while only the titles were checked, because
  // the titles are read from the same variables the rule matched rather than from the indices.
  const links = findCrossIssueLinks([goingConcernFinding, covenantFinding]);
  const link = links.find((l) => l.id === "covenant-to-going-concern");
  assert.equal(link.fromTitle, covenantFinding.title, "the covenant is the cause");
  assert.equal(link.toTitle, goingConcernFinding.title, "going concern is the consequence");
  assert.equal(link.fromIndex, 1, "the cause is at index 1 in this ordering");
  assert.equal(link.toIndex, 0, "and the consequence at index 0 - the direction is not min/max");
});

check("AA-18 the same connection is reported once, not from both ends", () => {
  // Both findings must match BOTH ends of the rule for this to test anything. With one matching
  // only `from` and the other only `to`, there is a single ordered pair and the deduplication
  // never runs - which is why a mutation removing it survived the first version of this test.
  const bothEnds = [
    {
      title: "Covenant and refinancing A",
      detail: "The net debt to EBITDA covenant is close to breach and refinancing is uncertain.",
    },
    {
      title: "Covenant and refinancing B",
      detail: "A covenant test falls due while the facility renewal remains unresolved.",
    },
  ];
  const links = findCrossIssueLinks(bothEnds).filter((l) => l.id === "covenant-to-going-concern");
  assert.equal(
    links.length,
    1,
    `the same connection found from both ends is one connection: got ${links.length}`,
  );
});

check("AA-18 a finding is never linked to itself", () => {
  // One finding mentioning both a covenant and going concern is already whole.
  const whole = {
    title: "Covenant and going concern",
    detail: "The covenant breach raises a going concern question about refinancing.",
    evidence: "covenant",
  };
  assert.deepEqual(findCrossIssueLinks([whole]), []);
  assert.deepEqual(
    findCrossIssueLinks([whole, { title: "Unrelated", detail: "Inventory was counted." }]).filter(
      (l) => l.fromIndex === l.toIndex,
    ),
    [],
  );
});

const LINK_FIXTURES = [
  {
    id: "customer-loss-to-recoverability",
    a: { title: "Order book", detail: "The largest distributor reduced its committed order book." },
    b: { title: "Receivables", detail: "Assess the expected credit loss on trade receivables." },
  },
  {
    id: "control-weakness-to-fraud-risk",
    a: { title: "Controls", detail: "There is no segregation of duties in the journal process." },
    b: { title: "Fraud", detail: "Consider the risk of management override of controls." },
  },
  {
    id: "refusal-to-scope",
    a: { title: "Refusal", detail: "Management refused to provide the journal listing." },
    b: { title: "Sufficiency", detail: "Assess whether the evidence obtained is sufficient." },
  },
  {
    id: "statutory-dues-to-going-concern",
    a: { title: "Dues", detail: "Statutory dues of Rs 48 lakh were outstanding beyond six months." },
    b: { title: "Liquidity", detail: "Assess working capital and going concern." },
  },
  {
    id: "estimate-to-management-bias",
    a: { title: "Provision", detail: "A warranty provision of Rs 22 lakh is carried." },
    b: { title: "Incentive", detail: "The managing director's bonus depends on the reported target." },
  },
];

for (const fixture of LINK_FIXTURES) {
  check(`link rule is load-bearing: ${fixture.id}`, () => {
    const links = findCrossIssueLinks([fixture.a, fixture.b]);
    const link = links.find((l) => l.id === fixture.id);
    assert.ok(link, `expected ${fixture.id}, got ${JSON.stringify(links.map((l) => l.id))}`);
    assert.ok(link.because.length > 40, "the reason must be arguable");
    assert.ok(link.then.length > 25, "and it must say what to do about the pair");
  });
}

check("unrelated findings are not linked", () => {
  // If everything links to everything, the links say nothing.
  const links = findCrossIssueLinks([
    { title: "Inventory", detail: "Inventory was counted at three locations." },
    { title: "Depreciation", detail: "Depreciation was recomputed on the register." },
  ]);
  assert.deepEqual(links, []);
});

check("a finding matching only the CONSEQUENCE end links to nothing", () => {
  // The half of "not everything links" that the previous fixture could not reach: neither of those
  // findings matched either end, so removing the cause-end guard changed nothing. Here the second
  // finding matches the `to` side of several rules while nothing matches their `from` side, so a
  // missing cause-end guard would invent links out of one half of a rule.
  const links = findCrossIssueLinks([
    { title: "Inventory", detail: "Inventory was counted at three locations." },
    { title: "Going concern", detail: "Assess the going concern assumption and liquidity." },
  ]);
  assert.deepEqual(
    links,
    [],
    `a consequence with no cause present must link to nothing: ${JSON.stringify(links.map((l) => l.id))}`,
  );
});

check("a single finding produces no links, and malformed input never throws", () => {
  assert.deepEqual(findCrossIssueLinks([covenantFinding]), []);
  for (const value of [null, undefined, 42, "text", {}, []]) {
    assert.deepEqual(findCrossIssueLinks(value), []);
  }
});

// ── report ────────────────────────────────────────────────────────────────

console.log(`\nResult: ${passed} passed, ${failed} failed (out of ${passed + failed})`);
if (failed > 0) {
  console.error("\nAA-11 / AA-12 / AA-18 linking contract FAILED.");
  process.exit(1);
}
console.log("AA-11 / AA-12 / AA-18 linking contract OK");
