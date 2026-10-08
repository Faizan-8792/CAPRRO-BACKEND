// Contract for whole-document section accounting and per-event subsequent-event classification.
// AA-31 and AA-32 in .kiro/audit-assistance-defects.md.
//
// AA-31 - THE DEFECT
// Coverage counts MATTERS: units carrying a monetary amount or an audit-relevant keyword. Anything
// else is dropped before the reader sees it. On a 41-section memorandum that reported 31 units and
// said nothing about the other ten, and the ten were not filler - "segment disclosures were not
// prepared for the year", "IT general controls over the ERP were not tested by management", "the
// board minutes were not made available", "interest under the MSMED Act has not been computed".
// Every one is a real audit matter, dropped for containing no rupee figure and no keyword. AA-01's
// own numbers could not reveal it: 31 of 31 addressed reads as complete.
//
// AA-32 - THE DEFECT
// Two of them, compounding:
//   1. classifySubsequentEvent was only ever reached through a FINDING. An event the model did not
//      write about was never classified, so nine events could produce two classifications and
//      seven silences, and a reader cannot tell a silence from a clean event.
//   2. The window that decides whether an event is even POST-YEAR-END hardcoded "in April" and
//      "in May". On a schedule spanning May to August, seven of nine events were not recognised as
//      subsequent events at all - not misclassified, never seen. A 30 June year-end would have
//      been wrong in the other direction.
//
// Both are now driven from the document: sections are enumerated structurally, and the window is
// derived from the reporting date the document itself states.
//
//   node capro-backend/tests/audit-section-ledger-contract.mjs

import assert from "node:assert/strict";
import {
  SECTION_DISPOSITION,
  buildSectionLedger,
  extractAddressableUnits,
  extractDocumentSections,
} from "../src/services/audit-coverage.service.js";
import {
  buildSubsequentEventRegister,
  classifySubsequentEvent,
  findReportingDate,
} from "../src/services/audit-aggregation.service.js";
import { deriveSampling } from "../src/services/audit-finding-model.service.js";

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

// ── the reported document ─────────────────────────────────────────────────
//
// 41 numbered sections and 9 lettered subsequent events. Ten of the numbered sections carry no
// rupee figure and no keyword, and those ten are the ones that used to disappear.

const numbered = [
  "The company is engaged in manufacturing and distribution of industrial fasteners.",
  "Revenue for the year is Rs 399.41 crore against Rs 342.18 crore in the prior year.",
  "The revenue recognition policy for bill-and-hold arrangements has not been documented.",
  "Trade receivables at the year end are Rs 71 lakh past due beyond 180 days.",
  "No provision has been recognised against the past due balance.",
  "Property, plant and equipment additions during the year were Rs 17.82 crore.",
  "Capital work in progress carries borrowing costs of Rs 86 lakh capitalised during the year.",
  "The rate used for capitalisation was not reconciled to the weighted average borrowing rate.",
  "Inventory is stated at Rs 44.60 crore, of which Rs 3.12 crore is slow moving.",
  "The slow-moving provision policy was changed during the year without disclosure.",
  "Trade payables include Rs 2.40 crore due to micro and small enterprises.",
  "Interest under the MSMED Act has not been computed.",
  "Borrowings of Rs 118.90 crore carry a covenant tested on net debt to EBITDA.",
  "The company was unable to refinance the term loan falling due in June 2026.",
  "Employee benefit obligations are Rs 6.75 crore per the actuarial report.",
  "The actuarial assumptions were not reviewed by management.",
  "Related party sales during the year were Rs 22.30 crore.",
  "The arm's length basis for those sales has not been documented.",
  "A director's spouse owns 12% of the equity of a supplier.",
  "Purchases from that supplier were Rs 9.14 crore.",
  "Deferred tax assets of Rs 4.05 crore are recognised on unabsorbed depreciation.",
  "No convincing evidence of future taxable profit has been provided.",
  "Contingent liabilities disclosed are Rs 31.70 crore.",
  "A GST demand of Rs 5.60 crore raised in February 2026 is not disclosed.",
  "The company has 61 manual journal entries posted after the year end.",
  "Management refused to provide the listing of manual journal entries.",
  "Cash and bank balances are Rs 12.08 crore per the ledger.",
  "Bank confirmations were received for Rs 11.44 crore only.",
  "Segment disclosures were not prepared for the year.",
  "The CSR obligation for the year is Rs 84 lakh.",
  "CSR spend during the year was Rs 51 lakh.",
  "The shortfall has not been transferred to a specified fund.",
  "Reimbursement claims of Rs 2.10 lakh, Rs 1.40 lakh and Rs 0.38 lakh were settled in the year.",
  "Foreign currency payables of Rs 7.30 crore were not restated at the closing rate.",
  "The internal audit function did not cover the procurement cycle.",
  "IT general controls over the ERP were not tested by management.",
  "The company changed its statutory auditor during the year.",
  "Prior period comparatives were restated without a note.",
  "Going concern assessment covers only nine months from the reporting date.",
  "The board minutes for the March 2026 meeting were not made available.",
  "Management representation letter has not been signed.",
];

const events = [
  "A customer with a balance of Rs 4.20 crore entered insolvency in May 2026.",
  "A fire at the Pune warehouse in June 2026 destroyed inventory of Rs 1.90 crore.",
  "The board declared a dividend of Rs 3.00 crore in July 2026.",
  "A court judgment in May 2026 confirmed a claim of Rs 2.75 crore relating to a 2023 dispute.",
  "The company issued equity shares of Rs 25.00 crore in June 2026.",
  "A major customer contract was terminated in July 2026.",
  "The company negotiated a settlement of the GST demand in June 2026.",
  "A subsidiary was sold in August 2026 for Rs 18.00 crore.",
  "Litigation filed against the company in July 2026 claims Rs 6.40 crore.",
];

const MEMORANDUM = [
  "AUDIT REVIEW MEMORANDUM - YEAR ENDED 31 MARCH 2026",
  "",
  ...numbered.map((line, i) => `${i + 1}. ${line}`),
  "",
  "SUBSEQUENT EVENTS",
  ...events.map((line, i) => `${String.fromCharCode(65 + i)}. ${line}`),
].join("\n");

// ── AA-31 ────────────────────────────────────────────────────────────────

check("every one of the 41 sections and 9 events is accounted for", () => {
  const ledger = buildSectionLedger(MEMORANDUM, [], []);
  assert.ok(ledger, "the ledger is missing entirely");

  const numberedItems = ledger.items.filter((i) => i.kind === "numbered");
  const letteredItems = ledger.items.filter((i) => i.kind === "lettered");
  assert.equal(numberedItems.length, 41, `expected 41 numbered sections, got ${numberedItems.length}`);
  assert.equal(letteredItems.length, 9, `expected 9 lettered events, got ${letteredItems.length}`);
  assert.equal(ledger.total, 50);
});

check("no section is left unclassified", () => {
  const ledger = buildSectionLedger(MEMORANDUM, [], []);
  const permitted = new Set(Object.values(SECTION_DISPOSITION));

  assert.equal(ledger.classified, ledger.total, "classified must equal total");
  for (const item of ledger.items) {
    assert.ok(
      permitted.has(item.disposition),
      `${item.label} carries an unknown disposition: ${item.disposition}`,
    );
  }
  const counted = Object.values(ledger.byDisposition).reduce((a, b) => a + b, 0);
  assert.equal(counted, ledger.total, "the dispositions do not sum to the section count");
});

check("the ten keyword-free sections are present and named, not dropped", () => {
  // The exact sections that disappeared. Named individually rather than counted, because a count
  // would pass again the moment a different ten went missing.
  const ledger = buildSectionLedger(MEMORANDUM, [], []);
  const labels = new Set(ledger.items.map((i) => i.label));
  for (const n of [1, 12, 22, 29, 32, 35, 36, 37, 38, 40]) {
    assert.ok(labels.has(`section ${n}`), `section ${n} is missing from the ledger`);
  }
});

check("a control that was not operated is reported as a control deficiency", () => {
  const ledger = buildSectionLedger(MEMORANDUM, [], []);
  const byLabel = new Map(ledger.items.map((i) => [i.label, i.disposition]));

  // "Segment disclosures were not prepared", "IT general controls were not tested", "the internal
  // audit function did not cover the procurement cycle". None carries an amount; all three are
  // deficiencies rather than gaps, because nothing was asked for and refused.
  for (const n of [29, 35, 36]) {
    assert.equal(
      byLabel.get(`section ${n}`),
      SECTION_DISPOSITION.CONTROL_DEFICIENCY,
      `section ${n} should be a control deficiency, got ${byLabel.get(`section ${n}`)}`,
    );
  }
});

check("something asked for and not received is reported as an information gap", () => {
  const ledger = buildSectionLedger(MEMORANDUM, [], []);
  const byLabel = new Map(ledger.items.map((i) => [i.label, i.disposition]));

  // The distinction is worth keeping: a gap is closed by obtaining a document, a deficiency by the
  // client fixing how it operates, and the two land on different people.
  assert.equal(byLabel.get("section 26"), SECTION_DISPOSITION.INFORMATION_GAP, "refusal to provide a listing");
  assert.equal(byLabel.get("section 40"), SECTION_DISPOSITION.INFORMATION_GAP, "minutes not made available");
});

check("a section a finding actually reaches is reported as covered", () => {
  const ledger = buildSectionLedger(
    MEMORANDUM,
    [
      {
        title: "Test the covenant",
        evidence: "Borrowings of Rs 118.90 crore carry a covenant tested on net debt to EBITDA",
      },
    ],
    [],
  );
  const byLabel = new Map(ledger.items.map((i) => [i.label, i.disposition]));
  assert.equal(byLabel.get("section 13"), SECTION_DISPOSITION.COVERED);

  // And covering one section does not silently mark the others.
  assert.equal(ledger.byDisposition[SECTION_DISPOSITION.COVERED], 1);
});

check("the section ledger is not a restatement of the matter count", () => {
  // The owner's instruction in as many words: a count of matters may not stand in for a count of
  // sections. If these two ever became the same number the ledger would have stopped answering its
  // own question.
  const ledger = buildSectionLedger(MEMORANDUM, [], []);
  const units = extractAddressableUnits(MEMORANDUM);
  assert.notEqual(
    ledger.total,
    units.length,
    "sections and matters are the same count, so one is standing in for the other",
  );
  assert.ok(ledger.total > units.length, "there must be at least as many sections as matters");
});

check("an unstructured note gets no ledger rather than an invented one", () => {
  // Returning "1 section" for a paragraph would be a worse answer than none: it invites a reader to
  // believe an enumeration happened.
  assert.equal(buildSectionLedger("A short note about the bank balance.", [], []), null);
  assert.equal(buildSectionLedger("", [], []), null);
});

check("a person's initials do not become a section", () => {
  // The cost of accepting "A." as an opener. One lettered line in a document is far more likely a
  // name than a list, so lettered openers are honoured only when at least two of them appear. Two
  // is a list; one is a person.
  const withInitials = [
    "AUDIT NOTES FOR THE YEAR ENDED 31 MARCH 2026",
    "",
    "1. Revenue for the year is Rs 12.00 crore.",
    "R. K. Sharma is the managing director and holds 40% of the equity.",
    "2. Trade receivables are Rs 3.00 crore.",
  ].join("\n");

  const ledger = buildSectionLedger(withInitials, [], []);
  assert.ok(ledger, "the ledger disappeared entirely");
  assert.equal(
    ledger.items.filter((i) => i.kind === "lettered").length,
    0,
    "a name was counted as a lettered section",
  );
  assert.equal(ledger.total, 2, `expected the two numbered sections, got ${ledger.total}`);
});

// ── AA-32 ────────────────────────────────────────────────────────────────

check("all nine subsequent events are individually classified", () => {
  const register = buildSubsequentEventRegister(extractDocumentSections(MEMORANDUM), MEMORANDUM);
  assert.ok(register, "no subsequent-event register at all");

  const items = register.events.filter((e) => /^item [A-I]$/.test(e.label));
  assert.equal(items.length, 9, `expected all nine events, got ${items.length}`);
  assert.equal(register.classified, register.total);

  for (const event of register.events) {
    assert.ok(
      ["ADJUSTING", "NON_ADJUSTING", "UNCLEAR"].includes(event.classification),
      `${event.label} is unclassified`,
    );
    assert.ok(event.basis && event.action, `${event.label} carries no basis or action`);
  }
});

check("events after June are recognised, not only April and May", () => {
  // The hardcoded-month defect, stated as its own case. Seven of the nine used to be invisible.
  const register = buildSubsequentEventRegister(extractDocumentSections(MEMORANDUM), MEMORANDUM);
  const byLabel = new Map(register.events.map((e) => [e.label, e.classification]));
  for (const letter of ["B", "C", "E", "F", "G", "H", "I"]) {
    assert.ok(byLabel.has(`item ${letter}`), `item ${letter} (June-August) was not recognised`);
  }
});

check("each event's treatment says what happens to the accounts", () => {
  const register = buildSubsequentEventRegister(extractDocumentSections(MEMORANDUM), MEMORANDUM);
  const byLabel = new Map(register.events.map((e) => [e.label, e]));

  // A: customer insolvency after the year end is evidence the receivable was already doubtful.
  assert.equal(byLabel.get("item A").classification, "ADJUSTING");
  assert.equal(byLabel.get("item A").treatment, "adjustment");
  assert.equal(byLabel.get("item A").conditionAtReportingDate, true);

  // B: a fire is a new condition. The figures stand; the note is the question.
  assert.equal(byLabel.get("item B").classification, "NON_ADJUSTING");
  assert.equal(byLabel.get("item B").treatment, "disclosure");
  assert.equal(byLabel.get("item B").conditionAtReportingDate, false);

  // F: a terminated contract could be either, and UNCLEAR is the honest answer - it asks for the
  // date the condition arose instead of guessing. Keeping a real third answer is the point.
  assert.equal(byLabel.get("item F").classification, "UNCLEAR");
  assert.equal(byLabel.get("item F").conditionAtReportingDate, null);
  assert.match(byLabel.get("item F").action, /date the underlying condition arose/i);

  // H: "a subsidiary was sold" and "sold the subsidiary" are the same event in two word orders.
  // Written one-directional, the first fell to UNCLEAR - the same adjacency mistake this file's own
  // comments describe, made again while fixing it.
  assert.equal(byLabel.get("item H").classification, "NON_ADJUSTING");
  assert.equal(byLabel.get("item H").treatment, "disclosure");

  // E: "issued equity shares" versus "share issue", same class of miss, same fix.
  assert.equal(byLabel.get("item E").classification, "NON_ADJUSTING");
});

check("an event dated IN the reporting month is not after the reporting date", () => {
  // 31 March 2026 year end. A March 2026 board meeting is ON the reporting date, not after it, and
  // treating it as a subsequent event would put SA 560 questions to a matter that belongs in the
  // year under audit. Strictly-after is the whole comparison.
  const register = buildSubsequentEventRegister(extractDocumentSections(MEMORANDUM), MEMORANDUM);
  const labels = register.events.map((e) => e.label);
  assert.ok(
    !labels.includes("section 40"),
    "the March 2026 board minutes were treated as a subsequent event",
  );
  assert.ok(
    !labels.includes("section 24"),
    "the February 2026 GST demand was treated as a subsequent event",
  );
});

check("the window follows the document's stated year end, not a fixed month list", () => {
  // A 30 June year-end. July is subsequent and May is not - the reverse of the hardcoded
  // assumption, and no list of month names can express it.
  assert.deepEqual(findReportingDate("Financial statements for the year ended 30 June 2025"), {
    month: 5,
    year: 2025,
  });

  const juneYearEnd = [
    "AUDIT NOTES FOR THE YEAR ENDED 30 JUNE 2025",
    "",
    "1. A customer with a balance of Rs 2.00 crore entered insolvency in September 2025.",
    "2. The company purchased a warehouse in February 2025 for Rs 8.00 crore.",
  ].join("\n");

  const register = buildSubsequentEventRegister(extractDocumentSections(juneYearEnd), juneYearEnd);
  const labels = register.events.map((e) => e.label);
  assert.ok(labels.includes("section 1"), "a September event was not treated as subsequent");
  assert.ok(
    !labels.includes("section 2"),
    "a February event BEFORE a June year end was treated as subsequent",
  );
});

check("a document with no subsequent events gets no register rather than an empty one", () => {
  const plain = [
    "AUDIT NOTES FOR THE YEAR ENDED 31 MARCH 2026",
    "",
    "1. Revenue for the year is Rs 12.00 crore.",
    "2. Trade receivables are Rs 3.00 crore.",
  ].join("\n");
  assert.equal(buildSubsequentEventRegister(extractDocumentSections(plain), plain), null);
});

// ── AA-34: the fallback month is recognised however the date is written ───
//
// Found by running the owner's own Test #6 OUTPUT file through production. "In April the customer
// returned goods" was recognised and "On 12 April the customer returned goods" was not, because
// the no-year-end fallback required the preposition "in" to sit immediately before the month. A
// date written the ordinary way was invisible - the same one-surface-form brittleness as AA-32's
// hardcoded months, one level down.

check("a fallback month is recognised however the date is written", () => {
  // No stated reporting date in any of these, so only the fallback can reach them. Every one is
  // the same event written the way a real document writes a date.
  const forms = [
    "On 12 April the customer returned Rs 9.8 lakh of goods.",
    "In April the customer returned Rs 9.8 lakh of goods.",
    "The return occurred on 12 April 2026.",
    "12 April 2026 - the customer returned the goods.",
    "April 2026 saw the customer return the goods.",
  ];
  for (const text of forms) {
    const verdict = classifySubsequentEvent(text);
    assert.notEqual(
      verdict.classification,
      null,
      `not recognised as a subsequent event: ${text}`,
    );
  }
});

check("the fallback still refuses text that names no post-March date", () => {
  // The over-block half. A month inside the year under audit, or no date at all, must stay out -
  // for an Indian financial year running 1 April to 31 March, March is IN the year, not after it.
  for (const text of [
    "Revenue for the year is Rs 12 crore.",
    "The March invoice was settled in full.",
    "The company operates from April premises leased in 2019.",
  ]) {
    assert.equal(
      classifySubsequentEvent(text).classification,
      null,
      `wrongly treated as a subsequent event: ${text}`,
    );
  }
});

// ── AA-35: a population size written as a word ────────────────────────────

check("a population size written as a word is read", () => {
  // "five disputed receivable balances totalling Rs 86 lakh" is how an audit file says it at least
  // as often as "5", and reading it as null left the product with no view on whether five items
  // should be tested in full rather than sampled.
  assert.equal(deriveSampling("five disputed receivable balances totaling Rs 86 lakh").populationSize, 5);
  assert.equal(deriveSampling("seventeen journal entries posted at the year end").populationSize, 17);
  assert.equal(deriveSampling("twenty items were selected").populationSize, 20);

  // Digits keep working, including the AA-33 case with a qualifier in the way.
  assert.equal(deriveSampling("61 manual journal entries posted after the year end").populationSize, 61);
});

check("a small worded population is reported as test-in-full, not sampled", () => {
  // The point of reading the number at all. Five items is not a sampling problem.
  const sampling = deriveSampling("five disputed receivable balances totaling Rs 86 lakh");
  assert.equal(sampling.applicable, false, "sampling was proposed for a population of five");
  assert.match(sampling.basis, /Testing all of them/i);
});

check("a word that is not a count does not become a population", () => {
  // The over-block half again. Without the population noun there is no population, whatever
  // numbers appear nearby.
  assert.equal(deriveSampling("a five-year plan was approved").populationSize, null);
  assert.equal(deriveSampling("Inventory is stated at Rs 44.60 crore of inventory items").populationSize, null);
  assert.equal(deriveSampling("the four directors signed the accounts").populationSize, null);
});

// ── report ────────────────────────────────────────────────────────────────

console.log(`\nResult: ${passed} passed, ${failed} failed (out of ${passed + failed})`);
if (failed > 0) {
  console.error("\nAA-31 / AA-32 section-ledger contract FAILED.");
  process.exit(1);
}
console.log("AA-31 / AA-32 section-ledger contract OK");
