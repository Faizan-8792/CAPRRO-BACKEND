// Contract for fact-level coverage accounting and the coverage gate. AA-01 in
// .kiro/audit-assistance-defects.md.
//
// The defect: a report with 18 numbered matters received findings for the first several and
// nothing for the rest, and the response said nothing about it. A reader takes the absence of a
// finding as the absence of a problem, and that inference must never be available by accident.
//
// Two properties are pinned here, and the second matters more than the first:
//
//   1. An UNTAGGED document is measurable at all. The pre-existing machinery only measured
//      documents using the [WP Ref: ...] convention, which a client's report does not follow.
//   2. An incomplete answer cannot ship SILENTLY. This module never fabricates a finding for a
//      section nobody reviewed - inventing audit work would be a far worse defect - so the gate
//      forces the omission to be declared instead.
//
//   node capro-backend/tests/audit-coverage-gate-contract.mjs

import assert from "node:assert/strict";
import {
  extractAddressableUnits,
  computeCoverage,
  buildCoverageLedger,
} from "../src/services/audit-coverage.service.js";
import { buildContradictionInsights } from "../src/services/audit-contradiction.service.js";

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

/** A finding whose evidence quote is lifted verbatim from the unit it is about. */
const finding = (evidence, extra = {}) => ({
  title: "A finding",
  detail: "",
  risk: "medium",
  standard: "SA 500",
  evidence,
  why: "",
  nextAction: "",
  amountMinor: null,
  workingPaperRef: null,
  ...extra,
});

// ── the reviewer's failing shape: numbered, untagged ───────────────────────

const TEST_3_SHAPE = `
Audit review notes for the year ended 31 March 2026.

1. Inventory at three locations totals Rs 4.20 crore, with no cycle count performed since October.
2. Fixed assets include plant capitalised on 15 March 2026 where commercial production began later.
3. A warranty provision of Rs 22 lakh is carried against historical claims of Rs 54 lakh.
4. Income tax matters include a disputed demand of Rs 1.80 crore under appeal.
5. A legal claim of Rs 2.40 crore is pending, on which counsel cannot predict the outcome.
6. Statutory dues of Rs 48 lakh were outstanding for more than six months at the year end.
7. Borrowings of Rs 11.20 crore carry a covenant tested on net debt to EBITDA.
8. Management has identified a going concern uncertainty relating to refinancing.
9. Subsequent to the year end a major distributor reduced its committed order book.
`;

check("an untagged numbered report yields one unit per matter", () => {
  const units = extractAddressableUnits(TEST_3_SHAPE);
  assert.equal(units.length, 9, `expected 9 units, got ${units.length}`);
  assert.deepEqual(
    units.map((u) => u.label),
    ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
  );
  assert.ok(units.every((u) => u.kind === "numbered"));
});

check("a document addressed only in part reports exactly what was missed", () => {
  // Findings for matters 1 and 2 only - the shape of the reported defect.
  const insights = [
    finding("Inventory at three locations totals Rs 4.20 crore"),
    finding("plant capitalised on 15 March 2026"),
  ];
  const coverage = computeCoverage(TEST_3_SHAPE, insights);

  assert.equal(coverage.unitCount, 9);
  assert.equal(coverage.coveredCount, 2, "only two matters were addressed");
  assert.equal(coverage.uncoveredCount, 7);
  assert.deepEqual(
    coverage.uncovered.map((u) => u.label),
    ["3", "4", "5", "6", "7", "8", "9"],
  );
});

check("the gate turns a silent omission into a stated one", () => {
  const insights = [finding("Inventory at three locations totals Rs 4.20 crore")];
  const ledger = buildCoverageLedger(TEST_3_SHAPE, insights);

  assert.equal(ledger.complete, false);
  assert.equal(ledger.findings.length, 1, "an incomplete answer must carry a declaration");

  const [declaration] = ledger.findings;
  assert.match(declaration.title, /not reviewed/i);
  assert.match(declaration.detail, /\b9\b/, "names how many matters need attention");
  assert.match(declaration.detail, /\b1\b/, "names how many were addressed");
  // The unaddressed matters must be listed, not merely counted.
  for (const label of ["2", "3", "4", "5", "6", "7", "8", "9"]) {
    assert.ok(
      declaration.detail.includes(label),
      `the declaration must name unaddressed matter ${label}`,
    );
  }
});

check("the gate never fabricates audit work for a section nobody reviewed", () => {
  const ledger = buildCoverageLedger(TEST_3_SHAPE, []);
  assert.equal(ledger.findings.length, 1, "exactly one declaration, not nine invented findings");
  const [declaration] = ledger.findings;
  // It must not read as a conclusion about the client's numbers.
  for (const forbidden of [/is misstated/i, /is fraudulent/i, /we conclude/i, /is incorrect/i]) {
    assert.doesNotMatch(declaration.detail, forbidden);
    assert.doesNotMatch(declaration.nextAction, forbidden);
  }
  assert.match(declaration.detail, /not yet reviewed/i, "says what it actually is");
});

check("a fully addressed document is complete and adds nothing", () => {
  const insights = [
    finding("Inventory at three locations totals Rs 4.20 crore"),
    finding("plant capitalised on 15 March 2026"),
    finding("warranty provision of Rs 22 lakh"),
    finding("disputed demand of Rs 1.80 crore"),
    finding("legal claim of Rs 2.40 crore is pending"),
    finding("Statutory dues of Rs 48 lakh were outstanding"),
    finding("Borrowings of Rs 11.20 crore carry a covenant"),
    finding("going concern uncertainty relating to refinancing"),
    finding("major distributor reduced its committed order book"),
  ];
  const ledger = buildCoverageLedger(TEST_3_SHAPE, insights);
  assert.equal(ledger.coverage.uncoveredCount, 0);
  assert.equal(ledger.complete, true);
  assert.deepEqual(ledger.findings, [], "a complete answer carries no declaration");
});

// ── the pre-existing tagged convention must keep working ───────────────────

check("a tagged document still measures by its own refs", () => {
  const tagged = `
[WP Ref: A-1] Inventory of Rs 4.20 crore has had no cycle count since October.
[WP Ref: B-2] Borrowings of Rs 11.20 crore carry a net-debt covenant.
[WP Ref: C-3] A legal claim of Rs 2.40 crore is pending with an uncertain outcome.
`;
  const units = extractAddressableUnits(tagged);
  assert.deepEqual(units.map((u) => u.label), ["A-1", "B-2", "C-3"]);
  assert.ok(units.every((u) => u.kind === "working-paper-ref"));

  // A ref match alone is decisive, which is how the existing controller accounts for coverage.
  const coverage = computeCoverage(tagged, [
    finding("", { workingPaperRef: "B-2" }),
    finding("Inventory of Rs 4.20 crore has had no cycle count"),
  ]);
  assert.equal(coverage.uncoveredCount, 1);
  assert.equal(coverage.uncovered[0].label, "C-3");
});

// ── deterministic findings must earn coverage credit too ──────────────────

check("a deterministic finding covers the matters it is about", () => {
  // Found by live verification, not by any local test. The controller measured coverage against
  // the MODEL's findings only, so a document whose first matters carried a contradiction finding
  // and a numerical finding was still told "the following were not reviewed: 1, 2, 3". The
  // response contradicted itself - the exact failure AA-03 exists to report - in the one finding
  // whose entire purpose is to be trustworthy about what was and was not covered.
  const text = `
1. Management has confirmed that there are no related parties requiring disclosure.
2. The shareholders schedule shows a director's spouse owns 12% of the equity.
3. Statutory dues of Rs 48 lakh were outstanding for more than six months at the year end.
`;
  const contradictions = buildContradictionInsights(text);
  assert.equal(contradictions.length, 1, "the fixture must produce a contradiction to be a test");

  const bare = computeCoverage(text, []);
  assert.equal(bare.uncoveredCount, 3, "with no findings at all, nothing is covered");

  const withDeterministic = computeCoverage(text, contradictions);
  assert.ok(
    withDeterministic.coveredCount >= 1,
    "the contradiction's evidence quote comes verbatim from matter 1, so matter 1 is addressed",
  );
  assert.ok(
    !withDeterministic.uncovered.some((unit) => unit.label === "1"),
    `matter 1 has a finding about it and must not be listed as unreviewed: ${JSON.stringify(
      withDeterministic.uncovered.map((u) => u.label),
    )}`,
  );
});

check("an elided evidence quote still credits the matters it quotes", () => {
  // Found by diagnosing a live response rather than by any local test. A model reasoning across
  // two passages joins them in one quote: "first passage ... second passage". That joined string
  // exists nowhere in the document, so a single containment test could never place it and the
  // finding earned no coverage credit at all - which is how a live response came to name matters
  // as unreviewed directly above findings about them.
  //
  // Each fragment is still verbatim, so each is checked separately. This only ever ADDS credit,
  // and only for text the document actually contains.
  const elided = finding(
    "Inventory at three locations totals Rs 4.20 crore ... plant capitalised on 15 March 2026",
  );
  const coverage = computeCoverage(TEST_3_SHAPE, [elided]);
  assert.equal(coverage.coveredCount, 2, "both quoted matters are addressed by this one finding");
  assert.ok(!coverage.uncovered.some((u) => u.label === "1"));
  assert.ok(!coverage.uncovered.some((u) => u.label === "2"));

  // The unicode ellipsis and the bracketed form are the other two shapes models produce.
  for (const join of ["…", "[...]"]) {
    const other = computeCoverage(TEST_3_SHAPE, [
      finding(
        `Inventory at three locations totals Rs 4.20 crore ${join} plant capitalised on 15 March 2026`,
      ),
    ]);
    assert.equal(other.coveredCount, 2, `the "${join}" form must split too`);
  }
});

check("splitting on an ellipsis never credits a unit for text the document lacks", () => {
  // The safety side of the same change: fragments are still matched against the document's own
  // units, so an invented quote earns nothing however it is punctuated.
  const coverage = computeCoverage(TEST_3_SHAPE, [
    finding("a sentence that appears nowhere ... another sentence that appears nowhere either"),
  ]);
  assert.equal(coverage.coveredCount, 0);
});

// ── it must not cry wolf ───────────────────────────────────────────────────

check("headings with no audit substance are not counted against coverage", () => {
  const text = `
1. Introduction. These notes accompany the audit file for the current period.
2. Basis of preparation. Prepared on the historical cost convention throughout.
3. Statutory dues of Rs 48 lakh were outstanding for more than six months.
`;
  const units = extractAddressableUnits(text);
  assert.equal(units.length, 1, "only the matter with audit substance counts");
  assert.equal(units[0].label, "3");
});

check("a year at the start of a sentence is not a numbered matter", () => {
  const text =
    "2026 was a difficult year for the industry, and revenue of Rs 84.6 crore reflects that.\n" +
    "2025 comparatives are restated.\n";
  const units = extractAddressableUnits(text);
  assert.ok(
    units.every((u) => u.kind !== "numbered"),
    `a bare year must not open a unit: ${JSON.stringify(units.map((u) => u.label))}`,
  );
});

check("an ungrounded evidence quote never counts as coverage", () => {
  // The controller guarantees a quote appears verbatim in the submitted text. A quote that does
  // not appear cannot be proof a section was addressed, or a model could claim coverage by
  // inventing a plausible sentence.
  const coverage = computeCoverage(TEST_3_SHAPE, [
    finding("a sentence that appears nowhere in the submitted document at all"),
  ]);
  assert.equal(coverage.coveredCount, 0);
});

check("empty and non-string input is handled without throwing", () => {
  for (const value of ["", "   ", null, undefined, 42, {}]) {
    assert.deepEqual(extractAddressableUnits(value), []);
    const ledger = buildCoverageLedger(value, []);
    assert.equal(ledger.coverage.unitCount, 0);
    assert.deepEqual(ledger.findings, [], "no units means nothing to declare");
    assert.equal(ledger.complete, false, "no units is not the same as fully covered");
  }
  assert.equal(computeCoverage("", []).ratio, null, "ratio is null, never a misleading 1");
});

// ── scale: the mandated 20-section, 50-section and 100-fact fixtures ────────

function syntheticReport(count) {
  const lines = ["Audit review notes.", ""];
  for (let i = 1; i <= count; i += 1) {
    lines.push(
      `${i}. Matter ${i}: a provision of Rs ${i}.00 lakh is carried, unique marker MK${i}X.`,
    );
  }
  return lines.join("\n");
}

for (const count of [20, 50, 100]) {
  check(`a ${count}-matter report is measured completely, with no drift`, () => {
    const text = syntheticReport(count);
    const units = extractAddressableUnits(text);
    assert.equal(units.length, count, `expected ${count} units, got ${units.length}`);

    // Address every other matter and confirm the arithmetic exactly.
    const insights = [];
    for (let i = 1; i <= count; i += 2) insights.push(finding(`unique marker MK${i}X`));

    const coverage = computeCoverage(text, insights);
    assert.equal(coverage.coveredCount, insights.length);
    assert.equal(coverage.uncoveredCount, count - insights.length);
    assert.equal(
      coverage.coveredCount + coverage.uncoveredCount,
      count,
      "every unit is accounted for either way - this is what makes omission detectable",
    );
  });
}

check("dropping a single fact from a 100-matter report is detected", () => {
  // The mandated coverage-mutation shape: address all but one, and the one must be named.
  const text = syntheticReport(100);
  const insights = [];
  for (let i = 1; i <= 100; i += 1) {
    if (i === 73) continue; // the deliberately dropped matter
    insights.push(finding(`unique marker MK${i}X`));
  }

  const ledger = buildCoverageLedger(text, insights);
  assert.equal(ledger.coverage.uncoveredCount, 1);
  assert.equal(ledger.coverage.uncovered[0].label, "73");
  assert.equal(ledger.complete, false);
  assert.ok(
    ledger.findings[0].detail.includes("73"),
    "the one dropped matter must be named, not just counted",
  );
});

// ── report ────────────────────────────────────────────────────────────────

console.log(`\nResult: ${passed} passed, ${failed} failed (out of ${passed + failed})`);
if (failed > 0) {
  console.error("\nAA-01 coverage-gate contract FAILED.");
  process.exit(1);
}
console.log("AA-01 coverage-gate contract OK");
