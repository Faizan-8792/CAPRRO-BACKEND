// Contract for the checks that only exist across findings. AA-13, AA-16 and AA-17 in
// .kiro/audit-assistance-defects.md.
//
// Each of these is invisible to a per-finding check by construction, which is why none of them was
// caught by any amount of per-finding testing:
//
//   AA-16  Rs 10L + Rs 15L + Rs 3L + Rs 4.6L + Rs 2.3L = Rs 34.9L. Each is small; the total is not.
//   AA-17  A Rs 4 crore related-party item under a Rs 20 crore threshold is not immaterial.
//   AA-13  Whether a post-year-end event changes the figures or only a note depends on when the
//          underlying condition arose, and that question was being skipped entirely.
//
//   node capro-backend/tests/audit-aggregation-contract.mjs

import assert from "node:assert/strict";
import {
  SUBSEQUENT_EVENT,
  buildMisstatementRegister,
  classifySubsequentEvent,
  findQualitativeMateriality,
  mayBeFilteredAsImmaterial,
} from "../src/services/audit-aggregation.service.js";

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

const lakh = (n) => Math.round(n * 100000 * 100); // rupees-lakh -> integer paise
const crore = (n) => Math.round(n * 10000000 * 100);

// ── AA-16: the ledger's own arithmetic ────────────────────────────────────

check("the reviewer's five small items are accumulated to Rs 34.9 lakh", () => {
  // The exact figures from the ledger. Each is individually unremarkable.
  const findings = [
    { title: "A", amountMinor: lakh(10), status: "RISK_INDICATOR" },
    { title: "B", amountMinor: lakh(15), status: "RISK_INDICATOR" },
    { title: "C", amountMinor: lakh(3), status: "RISK_INDICATOR" },
    { title: "D", amountMinor: lakh(4.6), status: "RISK_INDICATOR" },
    { title: "E", amountMinor: lakh(2.3), status: "RISK_INDICATOR" },
  ];
  const register = buildMisstatementRegister(findings, lakh(20));

  assert.equal(register.count, 5);
  assert.equal(register.totalMinor, lakh(34.9), "10 + 15 + 3 + 4.6 + 2.3 = 34.9 lakh");
  assert.equal(register.individuallyBelowMateriality, true, "every one is below Rs 20 lakh");
  assert.equal(register.exceedsMateriality, true, "together they are not");
});

check("the register is produced even when no materiality figure exists", () => {
  // The total is a fact whether or not a threshold exists to compare it with, and null is not the
  // same as "immaterial".
  const register = buildMisstatementRegister([{ title: "A", amountMinor: lakh(10) }], null);
  assert.equal(register.totalMinor, lakh(10));
  assert.equal(register.exceedsMateriality, null, "null, never false");
  assert.equal(register.individuallyBelowMateriality, null);
});

check("a clearly trivial amount is not accumulated", () => {
  const register = buildMisstatementRegister(
    [
      { title: "trivial", amountMinor: 50000 }, // Rs 500
      { title: "real", amountMinor: lakh(10) },
    ],
    lakh(20),
  );
  assert.equal(register.count, 1, "the Rs 500 item is not part of a misstatement total");
  assert.equal(register.totalMinor, lakh(10));
});

check("a confirmed fact about the document is not accumulated as a misstatement", () => {
  // AA-02's reconciliation difference is a gap to explain, not an amount that misstates anything.
  // Adding it to a misstatement total would inflate the total with something already known to be
  // an arithmetic observation.
  const register = buildMisstatementRegister(
    [
      { title: "Reconcile the population", amountMinor: lakh(1.74), status: "CONFIRMED_FACT" },
      { title: "A real one", amountMinor: lakh(10), status: "RISK_INDICATOR" },
    ],
    lakh(20),
  );
  assert.equal(register.count, 1);
  assert.equal(register.totalMinor, lakh(10));
});

check("findings without an amount do not disturb the total", () => {
  const register = buildMisstatementRegister(
    [{ title: "no amount", amountMinor: null }, { title: "A", amountMinor: lakh(10) }],
    lakh(20),
  );
  assert.equal(register.count, 1);
  assert.equal(register.totalMinor, lakh(10));
});

check("malformed input never throws", () => {
  for (const value of [null, undefined, 42, "text", {}]) {
    const register = buildMisstatementRegister(value, null);
    assert.equal(register.count, 0);
    assert.equal(register.totalMinor, 0);
  }
});

// ── AA-17: material for reasons that are not the amount ───────────────────

check("a related-party item under the threshold is NOT filtered out", () => {
  // The ledger's own case: Rs 4 crore related party, Rs 20 crore threshold.
  const finding = {
    title: "A sale of Rs 4 crore was made to a related party",
    detail: "The party is disclosed in the related party note.",
    amountMinor: crore(4),
  };
  const verdict = mayBeFilteredAsImmaterial(finding, crore(20));
  assert.equal(verdict.filterable, false, "size is not what makes a related-party item matter");
  assert.ok(verdict.reasons.some((r) => r.id === "related-party"));
  assert.match(verdict.reasons[0].reason, /relationship and the disclosure/i);
});

const QUALITATIVE_FIXTURES = [
  { id: "related-party", text: "A payment to a director's spouse" },
  { id: "fraud-adjacent", text: "Three backdated delivery challans were noted" },
  { id: "covenant", text: "The net debt to EBITDA covenant is affected" },
  { id: "regulatory", text: "TDS of Rs 40,000 was deposited late" },
  { id: "going-concern", text: "The facility renewal bears on going concern" },
  { id: "management-remuneration", text: "Managerial remuneration exceeded the limit" },
  { id: "earnings-threshold", text: "The adjustment turns a loss into a profit" },
];

for (const fixture of QUALITATIVE_FIXTURES) {
  check(`qualitative cue is load-bearing: ${fixture.id}`, () => {
    const found = findQualitativeMateriality(fixture.text);
    assert.ok(
      found.some((f) => f.id === fixture.id),
      `expected ${fixture.id}, got ${JSON.stringify(found.map((f) => f.id))}`,
    );
    for (const entry of found) {
      assert.ok(entry.reason.length > 25, "the reason must be arguable, not a category label");
    }
  });
}

check("an ordinary small difference IS filterable", () => {
  // The other half of the check. If everything is qualitatively material then nothing is, and the
  // gate stops meaning anything.
  const finding = {
    title: "A rounding difference of Rs 2,000 in the depreciation schedule",
    detail: "The recomputation differs by Rs 2,000.",
    amountMinor: 200000,
  };
  assert.equal(mayBeFilteredAsImmaterial(finding, lakh(20)).filterable, true);
});

check("an item at or above the threshold is never filtered", () => {
  const finding = { title: "A difference", detail: "A plain difference.", amountMinor: lakh(25) };
  const verdict = mayBeFilteredAsImmaterial(finding, lakh(20));
  assert.equal(verdict.filterable, false);
  assert.ok(verdict.reasons.some((r) => r.id === "above-threshold"));
});

check("nothing is filtered when no materiality figure has been set", () => {
  const finding = { title: "A difference", detail: "A plain difference.", amountMinor: 200000 };
  const verdict = mayBeFilteredAsImmaterial(finding, null);
  assert.equal(verdict.filterable, false, "you cannot filter against a threshold nobody has set");
  assert.ok(verdict.reasons.some((r) => r.id === "no-threshold"));
});

check("nothing qualitative applies to a genuinely ordinary item", () => {
  assert.deepEqual(findQualitativeMateriality("A rounding difference in the depreciation"), []);
  assert.deepEqual(findQualitativeMateriality(""), []);
  assert.deepEqual(findQualitativeMateriality(null), []);
});

// ── AA-13: adjusting, non-adjusting, or honestly unclear ──────────────────

check("an event revealing a condition that already existed is ADJUSTING", () => {
  const result = classifySubsequentEvent(
    "Subsequent to the year end the customer was admitted to insolvency proceedings.",
  );
  assert.equal(result.classification, SUBSEQUENT_EVENT.ADJUSTING);
  assert.match(result.basis, /already existed at the reporting date/i);
  assert.match(result.action, /adjusting entry/i, "the figures change, not just a note");
});

check("an event arising afterwards is NON_ADJUSTING", () => {
  const result = classifySubsequentEvent(
    "After the year end a fire destroyed the finished goods warehouse.",
  );
  assert.equal(result.classification, SUBSEQUENT_EVENT.NON_ADJUSTING);
  assert.match(result.action, /disclosure/i, "a note, not a number");
});

check("an event that cannot be placed is UNCLEAR, and says why that matters", () => {
  // The most important of the three. Guessing between adjusting and non-adjusting would put a
  // confident wrong number in the accounts.
  const result = classifySubsequentEvent(
    "Subsequent to the year end the largest distributor reduced its committed order book.",
  );
  assert.equal(result.classification, SUBSEQUENT_EVENT.UNCLEAR);
  assert.match(result.basis, /does not establish whether/i);
  assert.match(result.action, /date the underlying condition arose/i);
  assert.match(result.action, /approved/i, "the report date is the other half of the test");
});

check("an event described both ways is UNCLEAR rather than resolved", () => {
  const result = classifySubsequentEvent(
    "After the year end the company completed an acquisition and the earlier claim was settled by the court.",
  );
  assert.equal(
    result.classification,
    SUBSEQUENT_EVENT.UNCLEAR,
    "two events in one sentence is not a licence to pick one",
  );
});

check("text with no post-year-end event is not classified at all", () => {
  const result = classifySubsequentEvent("Inventory of Rs 4.20 crore was counted at three sites.");
  assert.equal(result.classification, SUBSEQUENT_EVENT.NOT_A_SUBSEQUENT_EVENT);
  assert.equal(result.basis, null);
  for (const value of ["", null, undefined, 42]) {
    assert.equal(
      classifySubsequentEvent(value).classification,
      SUBSEQUENT_EVENT.NOT_A_SUBSEQUENT_EVENT,
    );
  }
});

// One fixture per cue. Six cues had none, so neutralising them changed nothing and the mutation
// run reported them as untested - a cue nobody has exercised is a cue nobody has checked works.
const ADJUSTING_FIXTURES = [
  "Subsequent to the year end the debtor was declared insolvent.",
  "After the year end the court delivered its judgment on the claim.",
  "After the year end the parties settled the dispute out of court.",
  "After the year end the company negotiated a settlement of the warranty claim.",
  "After the year end the inventory was sold below cost, establishing realisable value.",
  "Subsequent to the year end the determination of the director's bonus was completed.",
  "Subsequent to the year end a fraud was discovered in the purchase cycle.",
  "After the year end the receivable from Orion Traders was written off as irrecoverable.",
];
for (const text of ADJUSTING_FIXTURES) {
  check(`adjusting cue is load-bearing: "${text.slice(20, 60)}"`, () => {
    assert.equal(classifySubsequentEvent(text).classification, SUBSEQUENT_EVENT.ADJUSTING);
  });
}

const NON_ADJUSTING_FIXTURES = [
  "After the year end a flood damaged the plant.",
  "Subsequent to the year end the company announced a restructuring plan.",
  "After the year end a rights issue was completed.",
  "Subsequent to the year end a new borrowing facility was taken.",
  "After the year end a change in tax rate was notified by the government.",
  "Subsequent to the year end a strike halted production at the Pune unit.",
];
for (const text of NON_ADJUSTING_FIXTURES) {
  check(`non-adjusting cue is load-bearing: "${text.slice(20, 60)}"`, () => {
    assert.equal(classifySubsequentEvent(text).classification, SUBSEQUENT_EVENT.NON_ADJUSTING);
  });
}

// ── report ────────────────────────────────────────────────────────────────

console.log(`\nResult: ${passed} passed, ${failed} failed (out of ${passed + failed})`);
if (failed > 0) {
  console.error("\nAA-13 / AA-16 / AA-17 aggregation contract FAILED.");
  process.exit(1);
}
console.log("AA-13 / AA-16 / AA-17 aggregation contract OK");
