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
