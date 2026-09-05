// Contract for the structured finding object. AA-09 in .kiro/audit-assistance-defects.md, with
// the parts of AA-08, AA-10, AA-11/12, AA-14 and AA-21 that the schema itself settles.
//
// The defect: a caller supplied a schema and the pipeline ignored it, because the flat shape WAS
// the output. There was no finding object; there was a paragraph with a title, and anything wanting
// a part of a finding had to parse a sentence to get it.
//
// The governing rule for every derivation is negative, and it is pinned first: a field the document
// does not support is null, never a plausible default. A fabricated assertion set or evidence rank
// is worse inside a schema than outside one, because the schema makes it look authoritative.
//
//   node capro-backend/tests/audit-finding-model-contract.mjs

import assert from "node:assert/strict";
import {
  ASSERTIONS,
  EVIDENCE_RANK,
  FINDING_SCHEMA_VERSION,
  STRUCTURED_SECTIONS,
  deriveAssertions,
  deriveEvidenceRank,
  deriveSampling,
  renderStructuredFinding,
  splitStandards,
  toStructuredFinding,
  validateStructuredFinding,
  withStructure,
  PRIORITY,
  SUFFICIENCY,
  deriveProcedureParts,
} from "../src/services/audit-finding-model.service.js";

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

const FLAT = {
  title: "Attend a count at the three inventory locations",
  detail: "Attend a count at the three locations holding the Rs 4.20 crore of inventory [SA 501].",
  risk: "high",
  standard: "SA 501",
  evidence: "Inventory at three locations totals Rs 4.20 crore",
  why: "Inventory not counted since October may not exist in the quantities recorded.",
  nextAction: "If the count differs from the ledger, quantify the difference and propose an entry.",
};

// ── the object exists, and carries every section ──────────────────────────

// The caller's schema, written out here rather than imported from the code under test.
//
// The first version of this contract iterated STRUCTURED_SECTIONS - the very constant the object is
// built from - so deleting a section deleted the check for it too, and a mutation that dropped
// "missingInformation" passed. A test must not take its expectations from the thing it is testing.
const SCHEMA_THE_CALLER_ASKED_FOR = [
  "fact",
  "risk",
  "assertions",
  "standards",
  "procedure",
  "evidence",
  "sampling",
  "accountingImplication",
  "fraudIndicator",
  "escalation",
  "workingPaperStatus",
  "missingInformation",
  // AA-22 added triage to the schema. Listed here explicitly so growing the schema is a deliberate
  // edit to this file rather than something that happens silently in the code under test.
  "priority",
  // AA-13 and AA-17 joined the schema. Listed explicitly, like every other section, so growing it
  // is a deliberate edit here rather than something the code under test does silently.
  "subsequentEvent",
  "qualitativeMateriality",
  // AA-05, AA-15, AA-23, AA-24 and AA-25 joined the schema. Listed explicitly, like every other
  // section, so growing it stays a deliberate edit here.
  "precedentQuestions",
  "fraudTriangle",
  "estimateFramework",
  "alternativeProcedures",
  // AA-11 / AA-12 joined the schema.
  "stratification",
];

check("every section the caller's schema asked for is present", () => {
  const structured = toStructuredFinding(FLAT);
  for (const section of SCHEMA_THE_CALLER_ASKED_FOR) {
    assert.ok(section in structured, `the schema section "${section}" is missing`);
  }
  assert.equal(structured.schemaVersion, FINDING_SCHEMA_VERSION);
  assert.deepEqual(validateStructuredFinding(structured), []);
});

check("the exported section list still matches the schema that was asked for", () => {
  // Pins the constant itself, independently, so removing a section from it fails here even though
  // the object would then be internally consistent with its own shortened list.
  assert.deepEqual(
    [...STRUCTURED_SECTIONS].sort(),
    [...SCHEMA_THE_CALLER_ASKED_FOR].sort(),
    "STRUCTURED_SECTIONS no longer matches the caller's schema",
  );
});

check("a section with nothing to say is present and null, never absent", () => {
  // The distinction that matters to a consumer: "not applicable" and "this build does not know
  // about that section" must not look the same.
  const sparse = toStructuredFinding({ title: "Something", detail: "" });
  for (const section of STRUCTURED_SECTIONS) {
    assert.ok(section in sparse, `${section} vanished when the finding was sparse`);
  }
  assert.equal(sparse.fact, null);
  assert.equal(sparse.escalation, null);
});

check("the mandatory-field gate names exactly what is wrong", () => {
  const structured = toStructuredFinding(FLAT);
  assert.deepEqual(validateStructuredFinding(structured), []);

  const broken = { ...structured };
  delete broken.assertions;
  assert.ok(validateStructuredFinding(broken).some((v) => /assertions/.test(v)));

  assert.ok(
    validateStructuredFinding({ ...structured, schemaVersion: 99 }).some((v) =>
      /schemaVersion/.test(v),
    ),
  );
  assert.ok(
    validateStructuredFinding({
      ...structured,
      risk: { ...structured.risk, status: "CONFIRMED_MISSTATEMENT" },
    }).some((v) => /not a permitted status/.test(v)),
  );
  assert.ok(validateStructuredFinding(null).length > 0);
});

check("a fabricated standard cannot hide inside the structured object", () => {
  const structured = toStructuredFinding({ ...FLAT, standard: "SA 999" });
  assert.ok(
    validateStructuredFinding(structured).some((v) => /unrecognised/.test(v)),
    "AA-26 must reach inside the schema too",
  );
});

// ── AA-09's other half: rendering is a separate step ──────────────────────

check("a finding round-trips through the object without a word changing", () => {
  // This is what makes the shape data rather than prose. If rendering cannot reproduce the
  // reader-facing text from the object, then the object is a decoration and the prose is still
  // the source of truth.
  const rendered = renderStructuredFinding(toStructuredFinding(FLAT), FLAT);
  for (const field of ["detail", "risk", "standard", "evidence", "why", "nextAction"]) {
    assert.equal(rendered[field], FLAT[field], `${field} changed on the round trip`);
  }
});

check("the flat fields the desktop and extension read are never removed", () => {
  // Both products consume the flat shape. Replacing it to satisfy an internal refactor would break
  // two shipped clients, so the structured object is added ALONGSIDE.
  const withObject = withStructure(FLAT);
  for (const field of Object.keys(FLAT)) {
    assert.equal(withObject[field], FLAT[field], `${field} was altered`);
  }
  assert.ok(withObject.structured, "the structured object is attached");
});

// ── AA-08: assertions, and only the ones the subject supports ─────────────

const ASSERTION_FIXTURES = [
  { what: "inventory", text: "Attend the inventory count at the godown", expect: ASSERTIONS.EXISTENCE },
  { what: "revenue cut-off", text: "Test dispatch cut-off against the bill of lading", expect: ASSERTIONS.CUTOFF },
  { what: "receivables", text: "Circularise the debtor and review the ageing", expect: ASSERTIONS.VALUATION },
  { what: "provisions", text: "Evaluate the warranty provision against claims", expect: ASSERTIONS.COMPLETENESS },
  { what: "related parties", text: "Confirm the related party disclosure is complete", expect: ASSERTIONS.PRESENTATION },
  { what: "fixed assets", text: "Recompute depreciation on the fixed asset register", expect: ASSERTIONS.VALUATION },
  { what: "statutory dues", text: "Vouch the TDS remittance dates", expect: ASSERTIONS.ACCURACY },
  { what: "litigation", text: "Obtain counsel's view on the legal claim", expect: ASSERTIONS.PRESENTATION },
  { what: "journal entries", text: "Test the manual journal entries posted at year end", expect: ASSERTIONS.ACCURACY },
  { what: "borrowings", text: "Test the covenant on the borrowings", expect: ASSERTIONS.CLASSIFICATION },
];

for (const fixture of ASSERTION_FIXTURES) {
  check(`assertions are derived for ${fixture.what}`, () => {
    const derived = deriveAssertions(fixture.text);
    assert.ok(
      derived.includes(fixture.expect),
      `expected ${fixture.expect}, got ${JSON.stringify(derived)}`,
    );
  });
}

check("a finding about nothing recognisable claims no assertions at all", () => {
  // The alternative - defaulting to a plausible set - would tell an auditor the procedure was
  // directed at completeness when nobody established that.
  assert.deepEqual(deriveAssertions("Review the position and document the outcome."), []);
  assert.deepEqual(deriveAssertions(""), []);
  assert.deepEqual(deriveAssertions(null), []);
});

check("an unclaimed assertion set is reported as missing information", () => {
  const structured = toStructuredFinding({
    title: "Review the position",
    detail: "Review the position and document the outcome.",
  });
  assert.ok(
    structured.missingInformation.some((m) => /assertions/i.test(m)),
    "a finding with no derivable assertions must say so",
  );
});

check("the assertion list comes back in one canonical order", () => {
  // Comparing two runs of the same input was too weak: any deterministic-but-wrong order passes it,
  // and a mutation that reversed the list survived. The canonical order is asserted directly, so a
  // working paper does not list assertions differently depending on which cue matched first.
  const derived = deriveAssertions(
    "inventory and revenue cut-off and the related party disclosure",
  );
  const canonical = Object.values(ASSERTIONS).filter((a) => derived.includes(a));
  assert.deepEqual(derived, canonical, "the list must follow the declared assertion order");

  // And the order must not depend on the order the subjects appear in the text.
  const reversedSubject = deriveAssertions(
    "the related party disclosure and revenue cut-off and inventory",
  );
  assert.deepEqual(derived, reversedSubject, "the order must not follow the wording");
});

// ── AA-10: three kinds of authority, kept apart ───────────────────────────

check("audit, accounting and legal references are separated", () => {
  const split = splitStandards("SA 501, Ind AS 2 and section 143(3)(i) of the Companies Act, 2013");
  assert.match(split.audit, /SA 501/);
  assert.match(split.accounting, /Ind AS 2/);
  assert.match(split.legal, /section 143/i);
});

check("a citation of one kind does not populate the other two", () => {
  // SA 500 is an audit-evidence standard and cannot answer a recognition question. Repeating it in
  // every field so none looks empty was the shape of the original defect.
  const split = splitStandards("SA 500");
  assert.match(split.audit, /SA 500/);
  assert.equal(split.accounting, null);
  assert.equal(split.legal, null);
});

check("an accounting question yields an accounting implication, an audit one does not", () => {
  const accounting = toStructuredFinding({ ...FLAT, standard: "Ind AS 2" });
  assert.ok(accounting.accountingImplication, "Ind AS 2 governs measurement, so say so");

  const auditOnly = toStructuredFinding({ ...FLAT, standard: "SA 501" });
  assert.equal(
    auditOnly.accountingImplication,
    null,
    "an audit standard must not be presented as accounting guidance",
  );
});

check("an empty or absent citation yields three nulls, not three empty strings", () => {
  for (const value of ["", null, undefined, 42]) {
    assert.deepEqual(splitStandards(value), { audit: null, accounting: null, legal: null });
  }
});

// ── AA-14: evidence has a rank, or honestly has none ──────────────────────

check("evidence received directly outranks evidence routed through the client", () => {
  assert.equal(
    deriveEvidenceRank("A confirmation received directly from the bank"),
    EVIDENCE_RANK.EXTERNAL_DIRECT,
  );
  assert.equal(
    deriveEvidenceRank("A confirmation forwarded by the finance manager"),
    EVIDENCE_RANK.EXTERNAL_INDIRECT,
  );
  assert.equal(
    deriveEvidenceRank("The purchase ledger and the supplier invoice"),
    EVIDENCE_RANK.INTERNAL_DOCUMENT,
  );
  assert.equal(
    deriveEvidenceRank("Management has confirmed that no related parties exist"),
    EVIDENCE_RANK.MANAGEMENT_REPRESENTATION,
  );
});

check("a finding resting only on management's word says so explicitly", () => {
  const structured = toStructuredFinding({
    ...FLAT,
    evidence: "Management has confirmed that there are no related parties",
  });
  assert.equal(structured.evidence.restsOnManagementRepresentationAlone, true);
});

check("an unclassifiable evidence quote ranks null and is reported missing", () => {
  const structured = toStructuredFinding({
    title: "Something",
    detail: "Do the thing.",
    evidence: "Rs 4.20 crore at three locations",
  });
  assert.equal(structured.evidence.rank, null, "guessing a rank would be a fabrication");
  assert.ok(structured.missingInformation.some((m) => /evidence/i.test(m)));
});

// ── AA-11 / AA-12: whether sampling is the right instrument at all ────────

check("a small named population is tested in full rather than sampled", () => {
  // The reviewer's case: "select a sample" from seventeen year-end journal entries.
  const sampling = deriveSampling("Test the 17 journal entries posted at the year end.");
  assert.equal(sampling.populationSize, 17);
  assert.equal(sampling.applicable, false, "seventeen items are tested in full");
  assert.match(sampling.basis, /all of them/i);
});

check("a large named population may be sampled, with the basis recorded", () => {
  const sampling = deriveSampling("Test the 4200 invoices raised during the year.");
  assert.equal(sampling.populationSize, 4200);
  assert.equal(sampling.applicable, true);
  assert.match(sampling.basis, /record the method/i);
});

check("an unstated population is null, not false", () => {
  // null and false say different things: "nobody established the size" versus "sampling is not
  // appropriate". Collapsing them would assert something nobody checked.
  const sampling = deriveSampling("Test the journal entries posted at the year end.");
  assert.equal(sampling.populationSize, null);
  assert.equal(sampling.applicable, null);
});

check("a whole-population phrase with no size asks for the size", () => {
  const sampling = deriveSampling("Test all the journal entries posted at the year end.");
  assert.equal(sampling.applicable, null);
  assert.match(sampling.note, /establish the size/i);
});

// ── AA-21: what is missing is data, not an omission ───────────────────────

check("a complete finding reports little missing; a bare one reports a lot", () => {
  const complete = toStructuredFinding(FLAT);
  const bare = toStructuredFinding({ title: "Look into it" });
  assert.ok(
    bare.missingInformation.length > complete.missingInformation.length,
    "a finding with nothing behind it must say more is missing, not less",
  );
  for (const entry of bare.missingInformation) {
    assert.equal(typeof entry, "string");
    assert.ok(entry.length > 10, "each entry names the input, rather than a code");
  }
});

// ── AA-08: changing the subject must change the assertion set ─────────────

check("a cut-off finding and an existence finding carry different assertions", () => {
  // The mandate's own mutation shape: "wrong period" and "nonexistent transaction" are different
  // failures and must not produce the same answer. An assertion set that never changes is a label,
  // not an analysis.
  const wrongPeriod = deriveAssertions(
    "Test dispatch cut-off: goods dispatched on 31 March were recognised in the year under audit",
  );
  const nonexistent = deriveAssertions(
    "Attend the inventory count at the godown to establish the stock physically exists",
  );
  assert.notDeepEqual(wrongPeriod, nonexistent, "two different failures gave one answer");
  assert.ok(wrongPeriod.includes(ASSERTIONS.CUTOFF), "a period problem is a cut-off assertion");
  assert.ok(
    !nonexistent.includes(ASSERTIONS.CUTOFF),
    "an existence problem is not a cut-off assertion",
  );
  assert.ok(nonexistent.includes(ASSERTIONS.EXISTENCE));
});

check("a completeness finding and a valuation finding carry different assertions", () => {
  const completeness = deriveAssertions("Search for unrecorded liabilities among the creditors");
  const valuation = deriveAssertions("Review the debtor ageing for recoverability");
  assert.notDeepEqual(completeness, valuation);
  assert.ok(completeness.includes(ASSERTIONS.COMPLETENESS));
  assert.ok(valuation.includes(ASSERTIONS.VALUATION));
});

// ── AA-19: the risk statement has three parts, not one platitude ──────────

check("the risk names the mechanism, the statement impact and the audit consequence", () => {
  const structured = toStructuredFinding(FLAT);
  assert.ok(structured.risk.mechanism, "why this happens");
  assert.ok(structured.risk.statementImpact, "what it does to the accounts");
  assert.ok(structured.risk.auditConsequence, "what it means for the audit");
  // "This could misstate assets" was the defect. The impact must be specific to the assertions.
  assert.match(structured.risk.statementImpact, /do not exist|wrong amount|does not control/i);
});

check("the statement impact cannot disagree with the assertions beside it", () => {
  // Derived from the assertions rather than written, so a finding that claims to test completeness
  // and then describes an existence impact is not expressible.
  const completeness = toStructuredFinding({
    ...FLAT,
    title: "Search for unrecorded liabilities",
    detail: "Search for unrecorded liabilities among the creditors at the year end.",
    evidence: "creditors at the year end",
  });
  assert.ok(completeness.assertions.includes(ASSERTIONS.COMPLETENESS));
  assert.match(completeness.risk.statementImpact, /not recorded/i);
});

// ── AA-20: a procedure somebody can carry out ─────────────────────────────

check("the executable parts of a procedure are pulled out of the sentence", () => {
  const parts = deriveProcedureParts(
    "Agree the closing balance to the bank statement obtained directly from the bank and recompute the interest.",
  );
  assert.ok(parts.document, "the document is named");
  assert.match(parts.document, /bank statement/i);
  assert.ok(parts.comparison, "the comparison is named");
  assert.match(parts.comparison, /agree/i);
  assert.ok(parts.recalculation, "the recalculation is named");
  assert.match(parts.recalculation, /recompute/i);
});

check("a vague procedure yields nulls and is reported as missing", () => {
  // "Investigate further" and "obtain evidence" are the defect. They must not be dressed up.
  const parts = deriveProcedureParts("Investigate further and obtain evidence.");
  assert.deepEqual(parts, {
    document: null,
    source: null,
    comparison: null,
    recalculation: null,
  });
  const structured = toStructuredFinding({
    title: "Investigate",
    detail: "Investigate further and obtain evidence.",
  });
  assert.ok(
    structured.missingInformation.some((m) => /document to inspect/i.test(m)),
    "a procedure naming no document and no comparison must say so",
  );
});

// ── AA-21: how far the evidence gets you, and what is missing ─────────────

check("evidence obtained independently can be sufficient; the client's word never is", () => {
  const external = toStructuredFinding({
    ...FLAT,
    detail: "Agree the balance to the confirmation received directly from the bank.",
    evidence: "A confirmation received directly from the bank",
    nextAction: "If it disagrees, quantify the difference.",
    standard: "SA 505",
  });
  assert.equal(external.evidence.sufficiency.level, SUFFICIENCY.SUFFICIENT);
  assert.equal(external.evidence.sufficiency.minimumAdditionalEvidence, null);

  const representation = toStructuredFinding({
    ...FLAT,
    evidence: "Management has confirmed that there are no related parties",
  });
  assert.equal(representation.evidence.sufficiency.level, SUFFICIENCY.INSUFFICIENT);
  assert.match(
    representation.evidence.sufficiency.minimumAdditionalEvidence,
    /independently of management/i,
    "it must name what would actually close the gap",
  );
});

check("a document the client generated is only partially sufficient", () => {
  // The middle of the range, and the case that was missing: a mutation making every ranked finding
  // "sufficient" survived, because only the two ends were tested. A ledger or an invoice is the
  // client's own record - it establishes what was written down, not that it is right.
  const internal = toStructuredFinding({
    ...FLAT,
    detail: "Agree the balance to the purchase ledger and the supplier invoice.",
    evidence: "the purchase ledger and the supplier invoice",
    standard: "SA 500",
  });
  assert.equal(internal.evidence.rank, EVIDENCE_RANK.INTERNAL_DOCUMENT);
  assert.equal(internal.evidence.sufficiency.level, SUFFICIENCY.PARTIALLY_SUFFICIENT);
  assert.match(
    internal.evidence.sufficiency.minimumAdditionalEvidence,
    /outside the client|independently/i,
    "it must name what would actually raise the evidence, not gesture at more of it",
  );
});

check("a partially sufficient finding names the specific gap holding it back", () => {
  // This branch - ranked evidence, but something evidence-related still missing - was reached by
  // none of the fixtures, so a mutation replacing its message with "Obtain further evidence as
  // appropriate" survived. The finding below has a rankable quote but a procedure that names no
  // document and no comparison, which is exactly how a real finding lands here.
  const structured = toStructuredFinding({
    title: "Look at the balance",
    detail: "Investigate the position.",
    risk: "medium",
    standard: "SA 500",
    evidence: "the purchase ledger",
    why: "The balance may not be right.",
    nextAction: "Record the outcome.",
  });
  assert.equal(structured.evidence.rank, EVIDENCE_RANK.INTERNAL_DOCUMENT);
  assert.equal(structured.evidence.sufficiency.level, SUFFICIENCY.PARTIALLY_SUFFICIENT);
  assert.match(
    structured.evidence.sufficiency.minimumAdditionalEvidence,
    /Still required before this can be concluded on/i,
    "the message must quote the actual outstanding input",
  );
  assert.match(
    structured.evidence.sufficiency.minimumAdditionalEvidence,
    /document to inspect/i,
    "and must name which one it is",
  );
});

check("the additional evidence is always named, never gestured at", () => {
  // "Obtain further evidence as appropriate" is the AA-20 defect wearing an AA-21 hat, and a
  // mutation that replaced the specific text with exactly that survived the first run.
  const cases = [
    toStructuredFinding({ title: "a", detail: "Look into it." }),
    toStructuredFinding({ ...FLAT, evidence: "Management has confirmed the position" }),
    toStructuredFinding({
      ...FLAT,
      detail: "Agree the balance to the purchase ledger.",
      evidence: "the purchase ledger",
    }),
  ];
  for (const structured of cases) {
    const text = structured.evidence.sufficiency.minimumAdditionalEvidence;
    if (text === null) continue;
    assert.doesNotMatch(
      text,
      /\bas (?:appropriate|necessary|required)\b|\bfurther evidence\b(?!\s+is)/i,
      `vague: "${text}"`,
    );
    assert.ok(text.length > 30, `too short to be actionable: "${text}"`);
  }
});

check("a finding with nothing behind it is insufficient, and says what is needed", () => {
  const bare = toStructuredFinding({ title: "Look into it", detail: "Look into it." });
  assert.equal(bare.evidence.sufficiency.level, SUFFICIENCY.INSUFFICIENT);
  assert.ok(bare.evidence.sufficiency.minimumAdditionalEvidence.length > 20);
});

check("the audit consequence follows the sufficiency rather than being asserted", () => {
  const bare = toStructuredFinding({ title: "Look into it", detail: "Look into it." });
  assert.match(bare.risk.auditConsequence, /cannot be concluded on/i);
});

// ── AA-22: triage on every finding ────────────────────────────────────────

check("every finding carries one of the four triage levels", () => {
  for (const fixture of [FLAT, { title: "x" }, { title: "y", risk: "low" }]) {
    const structured = toStructuredFinding(fixture);
    assert.ok(
      Object.values(PRIORITY).includes(structured.priority),
      `${structured.priority} is not a triage level`,
    );
  }
});

check("a fraud indicator outranks its risk rating, and so does an information gap", () => {
  // Both outrank an ordinary rating, for different reasons: what the first might be, and the fact
  // that an area nobody has looked at cannot be signed off however small it looks.
  const fraud = toStructuredFinding({
    title: "Management override of the approval limit",
    detail: "Three orders were released without the second approval.",
    risk: "low",
  });
  assert.equal(fraud.priority, PRIORITY.CRITICAL);

  const gap = toStructuredFinding({
    title: "Parts of this document were not reviewed",
    detail: "Matters 3, 4 and 5 were not reviewed.",
    risk: "low",
  });
  assert.equal(gap.priority, PRIORITY.HIGH);
});

check("an ordinary finding takes its triage from its risk rating", () => {
  assert.equal(toStructuredFinding({ title: "a", detail: "b", risk: "high" }).priority, PRIORITY.HIGH);
  assert.equal(toStructuredFinding({ title: "a", detail: "b", risk: "low" }).priority, PRIORITY.LOW);
  assert.equal(toStructuredFinding({ title: "a", detail: "b", risk: "medium" }).priority, PRIORITY.MEDIUM);
});

check("malformed input never throws", () => {
  for (const value of [null, undefined, 42, "text", [], {}]) {
    toStructuredFinding(value);
    validateStructuredFinding(value);
    withStructure(value);
  }
  assert.equal(toStructuredFinding(null), null);
  assert.equal(renderStructuredFinding(null), null);
});

// ── report ────────────────────────────────────────────────────────────────

console.log(`\nResult: ${passed} passed, ${failed} failed (out of ${passed + failed})`);
if (failed > 0) {
  console.error("\nAA-09 structured finding contract FAILED.");
  process.exit(1);
}
console.log("AA-09 structured finding contract OK");
