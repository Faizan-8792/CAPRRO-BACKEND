// tests/audit-pack-engine-contract.mjs
//
// W10 AP7 (2026-10-15). The Clause 44 engine against hand-worked fixtures, in paise. Pure: no
// database, no network. Every figure below was worked by hand from the fixture, not read back from
// the engine, so a wrong rule shows up as a wrong number here.
//
// The four breakages AP7's gate names each fail a named check below:
//   - drop the depreciation exclusion          -> "monthly: column 2 ..." and "depreciation is excluded"
//   - add credit notes instead of subtracting  -> "monthly: column 5 ..."
//   - treat a missing GSTR-2B month as zero    -> "missing month: ..." checks
//   - swap columns 4 and 5                     -> "monthly: column 4 ..." and "column 5"
//
// Run: node tests/audit-pack-engine-contract.mjs

import assert from "node:assert/strict";
import {
  CLAUSE44_RULE_VERSION,
  buildClause44Rows,
  classifyLedger,
  financialYearMonths,
  ledgerAmountFor,
  summarizeClause44,
} from "../src/services/audit-pack-engine/clause44.engine.js";

const checks = [];
const check = (name, fn) => {
  try {
    fn();
    checks.push({ name, pass: true });
  } catch (error) {
    checks.push({ name, pass: false, detail: error.message.split("\n")[0] });
  }
};

const rupees = (value) => Math.round(value * 100); // fixture amounts in rupees -> paise
const FY = "2025-26";
const MONTHS = financialYearMonths(FY);

let rowId = 0;
const tb = (ledgerName, groupName, closing, extra = {}) => ({
  rowId: `tb${++rowId}`, batchId: "B-TB", sourceRow: rowId + 1, ledgerName, groupName,
  openingMinor: 0, hasOpening: false, debitTotalMinor: 0, creditTotalMinor: 0,
  hasTransactionTotals: false, closingMinor: rupees(closing), ...extra,
});
const purchase = (gstin, date, taxable, tax, documentType = "INVOICE", extra = {}) => ({
  rowId: `p${++rowId}`, batchId: "B-PR", sourceRow: rowId + 1, supplierGstin: gstin,
  documentDate: date, documentType, taxableValueMinor: rupees(taxable),
  igstMinor: rupees(tax), cgstMinor: 0, sgstMinor: 0, cessMinor: 0, reverseCharge: false, ...extra,
});
const twoB = (gstin, period, taxable, documentType = "INVOICE") => ({
  rowId: `b${++rowId}`, batchId: `B-2B-${period}`, sourceRow: rowId + 1, supplierGstin: gstin,
  period, documentDate: `${period}-15`, documentType, taxableValueMinor: rupees(taxable),
  igstMinor: 0, cgstMinor: 0, sgstMinor: 0, cessMinor: 0,
});

const S1 = "27AAAAA1111A1Z1"; // regular, in every month's 2B
const S2 = "27BBBBB2222B1Z2"; // composition, set by a person
const S3 = "27CCCCC3333C1Z3"; // regular; some exempt (untaxed) goods
const S4 = "27DDDDD4444D1Z4"; // never in 2B, no decision

function monthlyFixture({ dropMonth = null } = {}) {
  rowId = 0;
  const trialBalance = [
    tb("Purchase of Goods", "Purchase Accounts", 5000000),
    tb("Freight Inward", "Direct Expenses", 200000),
    tb("Rent", "Indirect Expenses", 600000),
    tb("Salaries", "Indirect Expenses", 1200000),
    tb("Depreciation", "Indirect Expenses", 300000),
    tb("Interest on Term Loan", "Indirect Expenses", 150000),
    tb("Plant and Machinery", "Fixed Assets", 2000000, { debitTotalMinor: rupees(800000), hasTransactionTotals: true }),
    tb("ABC Traders", "Sundry Creditors", -100000),
    tb("Sales", "Sales Accounts", -9000000),
    tb("Output CGST", "Duties & Taxes", -50000),
  ];
  const purchases = [
    purchase(S1, "2025-05-10", 2000000, 360000),
    purchase(S1, "2025-11-20", 2000000, 360000),
    purchase(S1, "2026-01-05", 100000, 18000, "CREDIT_NOTE"),
    purchase(S2, "2025-07-01", 200000, 0),
    purchase(S3, "2025-08-01", 100000, 0),
    purchase(S3, "2025-08-02", 300000, 54000),
    purchase(S4, "2025-12-12", 50000, 9000),
    purchase(S1, "2025-03-31", 999999, 1000), // last year: must be left out
  ];
  const months = MONTHS.filter((m) => m !== dropMonth);
  const gstr2b = [
    twoB(S1, "2025-05", 2000000),
    twoB(S1, "2025-11", 2000000),
    twoB(S1, "2026-01", 100000, "CREDIT_NOTE"),
    twoB(S3, "2025-08", 300000),
  ].filter((r) => months.includes(r.period));
  return { financialYear: FY, trialBalance, purchases, gstr2b, gstr2bMonths: months, parties: [{ gstin: S2, gstStatus: "COMPOSITION" }] };
}

// ─── single rules ───────────────────────────────────────────────────────

const classify = (ledgerName, groupName, closing = 1000, extra = {}) =>
  classifyLedger(tb(ledgerName, groupName, closing, extra));

check("depreciation is excluded from an expense group", () => {
  const r = classify("Depreciation", "Indirect Expenses");
  assert.equal(r.treatment, "EXCLUDED");
  assert.equal(r.exclusion, "DEPRECIATION");
});
check("salaries are excluded as employee costs; staff welfare is not", () => {
  assert.equal(classify("Salaries", "Indirect Expenses").exclusion, "EMPLOYEE");
  assert.equal(classify("Staff Welfare", "Indirect Expenses").treatment, "REVENUE_EXPENDITURE");
});
check("an auditor's remuneration stays in; directors' remuneration is excluded", () => {
  assert.equal(classify("Auditor's Remuneration", "Indirect Expenses").treatment, "REVENUE_EXPENDITURE");
  assert.equal(classify("Directors' Remuneration", "Indirect Expenses").exclusion, "EMPLOYEE");
});
check("a GST or income-tax consultant's fee stays in; rates and taxes and penalties are excluded", () => {
  assert.equal(classify("GST Consultancy Fees", "Indirect Expenses").treatment, "REVENUE_EXPENDITURE");
  assert.equal(classify("Income Tax Return Filing Fees", "Indirect Expenses").treatment, "REVENUE_EXPENDITURE");
  assert.equal(classify("Rates and Taxes", "Indirect Expenses").exclusion, "TAX_OR_LEVY");
  assert.equal(classify("Penalty", "Indirect Expenses").exclusion, "TAX_OR_LEVY");
});
check("provisions, write-offs and rounding are excluded", () => {
  assert.equal(classify("Provision for Expenses", "Indirect Expenses").exclusion, "PROVISION");
  assert.equal(classify("Bad Debts Written Off", "Indirect Expenses").exclusion, "WRITE_OFF");
  assert.equal(classify("Round Off", "Indirect Expenses").exclusion, "ROUNDING");
});
check("balance-sheet and income ledgers are not expenditure", () => {
  assert.equal(classify("ABC Traders", "Sundry Creditors").treatment, "NOT_EXPENDITURE");
  assert.equal(classify("Sales", "Sales Accounts").treatment, "NOT_EXPENDITURE");
  assert.equal(classify("Output CGST", "Duties & Taxes").treatment, "NOT_EXPENDITURE");
});
check("a fixed asset counts its debit transactions, or waits for them", () => {
  const counted = classify("Furniture", "Fixed Assets", 500000, { debitTotalMinor: rupees(70000), hasTransactionTotals: true });
  assert.equal(counted.treatment, "CAPITAL_ADDITIONS");
  assert.equal(counted.amountMinor, rupees(70000));
  const waiting = classify("Furniture", "Fixed Assets", 500000);
  assert.equal(waiting.state, "PENDING_INPUT");
  assert.equal(waiting.amountMinor, 0);
});
check("custom groups are read by their words, in order", () => {
  assert.equal(classify("Repairs", "Administrative Expenses").treatment, "REVENUE_EXPENDITURE");
  assert.equal(classify("Laptops", "Computer Expenses").treatment, "REVENUE_EXPENDITURE");
  assert.equal(classify("Lathe", "Plant and Machinery").treatment, "CAPITAL_ADDITIONS");
  assert.equal(classify("Shed", "Capital Work-in-Progress").treatment, "CAPITAL_ADDITIONS");
});
check("an unknown group, or no group and a name that does not say, waits for a person", () => {
  assert.equal(classify("Miscellaneous", "Others").state, "PENDING_INPUT");
  assert.equal(classify("XYZ", "").state, "PENDING_INPUT");
  assert.equal(classify("Telephone Charges", "").treatment, "REVENUE_EXPENDITURE");
});
check("a row named like a Tally group, with no group column, waits for a person", () => {
  const r = classify("Indirect Expenses", "", 1000, { looksLikeGroupTotal: true });
  assert.equal(r.state, "PENDING_INPUT");
  assert.equal(r.ruleHits[0].rule, "LOOKS_LIKE_GROUP_TOTAL");
});
check("interest is counted and flagged as usually exempt", () => {
  const r = classify("Interest on Term Loan", "Indirect Expenses");
  assert.equal(r.treatment, "REVENUE_EXPENDITURE");
  assert.ok(r.ruleHits.some((h) => h.rule === "INTEREST_USUALLY_EXEMPT"));
});

// ─── the monthly filer, worked by hand ─────────────────────────────────────

const monthly = buildClause44Rows(monthlyFixture());
const monthlySummary = summarizeClause44(monthly.rows);
const supplier = (built, gstin) => built.rows.find((r) => r.section === "SUPPLIER" && r.party?.gstin === gstin);

check("rule version is stamped", () => assert.equal(monthly.ruleVersion, CLAUSE44_RULE_VERSION));
check("monthly: column 2 is the year's expenditure, exclusions out, capital additions in (Rs 67,50,000)", () => {
  // 50,00,000 + 2,00,000 + 6,00,000 + 1,50,000 + 8,00,000 additions; salaries and depreciation out.
  assert.equal(monthlySummary.columns.col2, rupees(6750000));
});
check("monthly: column 3 is the exempt goods from a regular supplier (Rs 1,00,000)", () => {
  assert.equal(monthlySummary.columns.col3, rupees(100000));
});
check("monthly: column 4 is the composition supplier (Rs 2,00,000)", () => {
  assert.equal(monthlySummary.columns.col4, rupees(200000));
});
check("monthly: column 5 nets the credit note (S1 39,00,000 + S3 3,00,000 = Rs 42,00,000)", () => {
  assert.equal(monthlySummary.columns.col5, rupees(4200000));
});
check("monthly: column 6 is 3 + 4 + 5 and column 7 the balance (Rs 45,00,000 and Rs 22,50,000)", () => {
  assert.equal(monthlySummary.columns.col6, rupees(4500000));
  assert.equal(monthlySummary.columns.col7, rupees(2250000));
  assert.equal(monthlySummary.col7IsBalancing, true);
});
check("monthly: last year's purchase is left out and counted as such", () => {
  const tie = monthly.rows.find((r) => r.rowKey && r.section === "TIEOUT" && r.label.startsWith("Purchase register"));
  assert.equal(tie.values.purchaseRowsOutsideYear, 1);
  assert.equal(supplier(monthly, S1).values.documentCount, 3);
});
check("monthly: a supplier never in GSTR-2B waits for a person, with its reason", () => {
  const s4 = supplier(monthly, S4);
  assert.equal(s4.values.status, "NOT_IN_2B");
  assert.equal(s4.state, "PENDING_INPUT");
  assert.ok(s4.ruleHits.some((h) => h.rule === "NOT_IN_GSTR2B"));
});
check("monthly: the figures are provisional until every row is decided", () => {
  assert.equal(monthlySummary.provisional, true);
  const codes = monthlySummary.reasons.map((r) => r.code);
  assert.ok(codes.includes("ROWS_NOT_DECIDED"));
  assert.ok(codes.includes("SUPPLIER_STATUS_UNKNOWN"));
});
check("monthly: purchase register against 2B ties to the paisa when every month is loaded", () => {
  const tie = monthly.rows.find((r) => r.section === "TIEOUT" && r.label.startsWith("Purchase register"));
  // register: S1 39,00,000 + S2 2,00,000 + S3 4,00,000 + S4 50,000 = 45,50,000; 2B: S1 39,00,000 + S3 3,00,000.
  assert.equal(tie.values.leftMinor, rupees(4550000));
  assert.equal(tie.values.rightMinor, rupees(4200000));
  assert.equal(tie.values.differenceMinor, rupees(350000));
  assert.deepEqual(tie.values.monthsMissing, []);
});
check("monthly: every ledger and supplier row carries its source rows", () => {
  for (const row of monthly.rows.filter((r) => r.decidable)) {
    assert.ok(row.sourceEvidenceCount > 0, row.label);
    assert.match(row.sourceEvidenceHash, /^[a-f0-9]{64}$/);
  }
});

// Decisions: every row confirmed, S4 set to composition by a person.
check("decided: once every row is confirmed and S4's status is set, the figures stand", () => {
  const decided = monthly.rows.map((row) => {
    if (!row.decidable) return row;
    const decision = { state: "CONFIRMED" };
    if (row.section === "SUPPLIER" && row.party?.gstin === S4) decision.status = "COMPOSITION";
    return { ...row, decision };
  });
  const summary = summarizeClause44(decided);
  assert.equal(summary.provisional, false, JSON.stringify(summary.reasons));
  assert.equal(summary.columns.col4, rupees(250000));
  assert.equal(summary.columns.col6, rupees(4550000));
  assert.equal(summary.columns.col7, rupees(2200000));
});
check("decided: a person's treatment for a ledger moves its amount, never the amount itself", () => {
  const decided = monthly.rows.map((row) => {
    if (row.section === "LEDGER" && row.label === "Interest on Term Loan") {
      return { ...row, decision: { state: "CONFIRMED", treatment: "COL3_EXEMPT", amountMinor: 1 } };
    }
    return row;
  });
  const summary = summarizeClause44(decided);
  assert.equal(summary.columns.col3, rupees(250000)); // 1,00,000 + 1,50,000 interest
  assert.equal(summary.columns.col2, rupees(6750000)); // unchanged: the decision cannot set an amount
});
check("every amount the engine computes is the books' figure for its treatment", () => {
  // One rule for the amount, whether the engine or a person chose the treatment.
  const computed = monthly.rows.filter((r) => r.section === "LEDGER" && r.state === "COMPUTED");
  assert.ok(computed.length >= 8, `${computed.length} computed ledgers`);
  for (const row of computed) assert.equal(ledgerAmountFor(row.values.treatment, row.values), row.values.amountMinor, row.label);
});
const allConfirmed = (rows) => rows.map((row) => {
  if (!row.decidable) return row;
  const decision = { state: "CONFIRMED" };
  if (row.section === "SUPPLIER" && row.party?.gstin === S4) decision.status = "COMPOSITION";
  return { ...row, decision };
});
check("decided: an unclassified ledger confirmed as expenditure counts its closing balance, not the nil it waited with", () => {
  const fixture = monthlyFixture();
  fixture.trialBalance.push(tb("Kappa Ledger", "Zeta Heads", 45000));
  const built = buildClause44Rows(fixture);
  const kappa = built.rows.find((r) => r.section === "LEDGER" && r.label === "Kappa Ledger");
  assert.deepEqual([kappa.state, kappa.values.treatment, kappa.values.amountMinor], ["PENDING_INPUT", "UNCLASSIFIED", 0]);
  const decided = allConfirmed(built.rows).map((r) => (r.rowKey === kappa.rowKey ? { ...r, decision: { state: "CONFIRMED", treatment: "REVENUE_EXPENDITURE" } } : r));
  const summary = summarizeClause44(decided);
  assert.equal(summary.provisional, false, JSON.stringify(summary.reasons));
  assert.equal(summary.columns.col2, rupees(6750000 + 45000));
});
check("decided: a ledger confirmed while still unclassified is not decided", () => {
  const fixture = monthlyFixture();
  fixture.trialBalance.push(tb("Kappa Ledger", "Zeta Heads", 45000));
  const summary = summarizeClause44(allConfirmed(buildClause44Rows(fixture).rows));
  assert.equal(summary.provisional, true);
  assert.deepEqual(summary.reasons, [{ code: "ROWS_NOT_DECIDED", count: 1 }]);
});
check("decided: a fixed asset whose additions the export does not give stays provisional until excluded", () => {
  const fixture = monthlyFixture();
  fixture.trialBalance.push(tb("Office Equipment", "Fixed Assets", 300000));
  const built = buildClause44Rows(fixture);
  const asset = built.rows.find((r) => r.section === "LEDGER" && r.label === "Office Equipment");
  assert.deepEqual([asset.state, asset.values.treatment, asset.values.additionsMinor], ["PENDING_INPUT", "CAPITAL_ADDITIONS", null]);
  const confirmed = summarizeClause44(allConfirmed(built.rows));
  assert.equal(confirmed.provisional, true);
  assert.deepEqual(confirmed.reasons, [{ code: "LEDGER_AMOUNT_UNKNOWN", count: 1 }]);
  const excluded = allConfirmed(built.rows).map((r) => (r.rowKey === asset.rowKey ? { ...r, decision: { state: "EXCLUDED", reason: "No additions this year" } } : r));
  const summary = summarizeClause44(excluded);
  assert.equal(summary.provisional, false, JSON.stringify(summary.reasons));
  assert.equal(summary.columns.col2, rupees(6750000));
});
check("decided: a ledger the rules excluded that a person treats as expenditure counts its closing balance", () => {
  const decided = allConfirmed(monthly.rows).map((r) => (r.section === "LEDGER" && r.label === "Depreciation"
    ? { ...r, decision: { state: "CONFIRMED", treatment: "REVENUE_EXPENDITURE" } } : r));
  assert.equal(summarizeClause44(decided).columns.col2, rupees(6750000 + 300000));
});
check("a duplicated ledger names the row that confirming would count", () => {
  const fixture = monthlyFixture();
  fixture.trialBalance.push(tb("Rent", "Indirect Expenses", 50000));
  const rent = buildClause44Rows(fixture).rows.find((r) => r.section === "LEDGER" && r.label === "Rent");
  assert.equal(rent.state, "PENDING_INPUT");
  assert.match(rent.ruleHits.find((h) => h.rule === "DUPLICATE_LEDGER").detail, /counts the first, on row 4;/);
});

// ─── a month of GSTR-2B missing ───────────────────────────────────────────

const missing = buildClause44Rows(monthlyFixture({ dropMonth: "2025-08" }));
const missingSummary = summarizeClause44(missing.rows);
check("missing month: the month is named, never read as zero", () => {
  assert.deepEqual(missing.monthsMissing, ["2025-08"]);
  assert.ok(missingSummary.reasons.some((r) => r.code === "GSTR2B_MONTHS_MISSING" && r.months.includes("2025-08")));
  assert.equal(missingSummary.provisional, true);
});
check("missing month: S3, whose only 2B month is missing, waits for a person rather than being called unregistered", () => {
  const s3 = supplier(missing, S3);
  assert.equal(s3.values.status, "NOT_IN_2B");
  assert.equal(s3.state, "PENDING_INPUT");
});

// ─── a quarterly filer ──────────────────────────────────────────────────

function quarterlyFixture() {
  rowId = 0;
  return {
    financialYear: FY,
    trialBalance: [
      tb("Purchases", "Purchase Accounts", 1200000),
      tb("Telephone Charges", "", 24000),
    ],
    purchases: [
      purchase(S1, "2025-04-15", 300000, 54000),
      purchase(S1, "2025-10-15", 300000, 54000),
      purchase(S3, "2026-02-01", 100000, 0),
    ],
    // GSTR-2BQ lists each quarter's documents once, under the quarter's last month.
    gstr2b: [twoB(S1, "2025-06", 300000), twoB(S1, "2025-12", 300000), twoB(S3, "2026-03", 100000)],
    gstr2bMonths: MONTHS,
    parties: [],
  };
}
const quarterly = buildClause44Rows(quarterlyFixture());
const quarterlySummary = summarizeClause44(quarterly.rows);
check("quarterly: suppliers in a quarter's 2B are registered; every month counts as loaded", () => {
  assert.equal(supplier(quarterly, S1).values.status, "REGISTERED");
  assert.equal(supplier(quarterly, S3).values.status, "REGISTERED");
  assert.deepEqual(quarterly.monthsMissing, []);
});
check("quarterly: columns (2 = 12,24,000; 3 = 1,00,000; 5 = 6,00,000; 7 = 5,24,000)", () => {
  assert.equal(quarterlySummary.columns.col2, rupees(1224000));
  assert.equal(quarterlySummary.columns.col3, rupees(100000));
  assert.equal(quarterlySummary.columns.col4, 0);
  assert.equal(quarterlySummary.columns.col5, rupees(600000));
  assert.equal(quarterlySummary.columns.col7, rupees(524000));
});

// ─── determinism and refusals ─────────────────────────────────────────────

check("the same inputs twice give identical output", () => {
  assert.deepEqual(buildClause44Rows(monthlyFixture()), buildClause44Rows(monthlyFixture()));
});
check("row keys are unique", () => {
  const keys = monthly.rows.map((r) => r.rowKey);
  assert.equal(new Set(keys).size, keys.length);
});
check("a duplicated ledger waits for a person instead of being counted twice", () => {
  const fixture = monthlyFixture();
  fixture.trialBalance.push(tb("Rent", "Indirect Expenses", 600000));
  const built = buildClause44Rows(fixture);
  const rent = built.rows.filter((r) => r.section === "LEDGER" && r.label === "Rent");
  assert.equal(rent.length, 1);
  assert.equal(rent[0].state, "PENDING_INPUT");
  assert.equal(rent[0].sourceEvidenceCount, 2);
});
check("a financial year that is not consecutive is refused", () => {
  assert.throws(() => buildClause44Rows({ financialYear: "2025-27" }), /financial year/);
});
check("an amount that is not integer paise is refused", () => {
  const fixture = monthlyFixture();
  fixture.purchases[0].taxableValueMinor = 10.5;
  assert.throws(() => buildClause44Rows(fixture), /integer paise/);
});

const failed = checks.filter((c) => !c.pass);
for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.pass ? "" : ` -- ${c.detail}`}`);
console.log(`\naudit-pack-engine-contract: ${checks.length - failed.length}/${checks.length} passed`);
process.exitCode = failed.length ? 1 : 0;
