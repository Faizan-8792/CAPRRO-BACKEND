// tests/audit-pack-gstr9c-contract.mjs
//
// W10 AP13-AP15 (2026-10-17). The GSTR-9 / 9C reconciliation pack: the engine against a hand-worked year
// (pure, in paise), the deliberate breakages each caught by a named check, and - with a scratch MongoDB -
// the same pack through the real routes, the worker and the workbook.
//
// Every figure in the fixture was worked by hand, not read back from the engine. The year:
//   GSTR-1, every month: B2B 20,00,000 taxable (IGST 3,60,000), credit note 1,00,000  -> 19,00,000 a month,
//     2,28,00,000 for the year (2,280,000,000 paise: above Int32 max 2,147,483,647, on purpose)
//   GSTR-3B, every month: Table 3.1(a) 19,00,000 - April alone 18,90,000               -> 2,27,90,000
//   GSTR-3B ITC 4A: IGST 1,00,000 a month                                              -> 12,00,000
//   GSTR-2B: one IGST 1,00,000 document a month dated in the month, and one 20,000 document dated 20 March 2025
//     reported in April 2025 (late-reported)                                           -> 8A 12,00,000; 8C 20,000
//   Trial balance: Sales -2,39,00,000 (credit); input IGST debit transactions 12,10,000
//   GSTR-9 as filed: 4N 2,28,00,000  4G 0  5A 0  5N 2,40,00,000  6A 12,00,000  8A 12,00,000  8C 20,000
//
// Run: node tests/audit-pack-gstr9c-contract.mjs                       (engine only)
//      MONGODB_URI=mongodb://127.0.0.1:27117/scratch-audit-pack-9c node tests/audit-pack-gstr9c-contract.mjs

import { runMutants, mutantChecks } from "./lib/mutants.mjs";

const rupees = (value) => Math.round(value * 100);
const FY = "2025-26";
const MONTHS = ["2025-04", "2025-05", "2025-06", "2025-07", "2025-08", "2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03"];

let rowId = 0;
const summaryRow = (batchId, category, taxable, igst = 0) => ({
  rowId: `r${++rowId}`, batchId, sourceRow: rowId + 1, summaryCategory: category,
  taxableValueMinor: rupees(taxable), igstMinor: rupees(igst), cgstMinor: 0, sgstMinor: 0, cessMinor: 0, totalTaxMinor: rupees(igst),
});
const doc = (batchId, period, date, igst, documentType = "INVOICE") => ({
  rowId: `d${++rowId}`, batchId, sourceRow: rowId + 1, period, documentDate: date, documentType, supplierGstin: "27AAAAA1111A1Z1",
  taxableValueMinor: 0, igstMinor: rupees(igst), cgstMinor: 0, sgstMinor: 0, cessMinor: 0, totalTaxMinor: rupees(igst),
});
const ledger = (name, group, closing, extra = {}) => ({
  rowId: `l${++rowId}`, batchId: "B-TB", sourceRow: rowId + 1, ledgerName: name, groupName: group, closingMinor: rupees(closing),
  openingMinor: 0, hasOpening: false, debitTotalMinor: 0, creditTotalMinor: 0, hasTransactionTotals: false, ...extra,
});

function fixture({ skip3b = [], skip1 = [], figures, net = false } = {}) {
  rowId = 0; // ids restart, so two builds of the same fixture are byte-identical
  const gstr1ByMonth = {};
  const gstr3bByMonth = {};
  const gstr2b = [];
  for (const month of MONTHS) {
    if (!skip1.includes(month)) {
      gstr1ByMonth[month] = { rows: [summaryRow(`B-G1-${month}`, "B2B", 2000000, 360000), summaryRow(`B-G1-${month}`, "CDNR", 100000, 18000)] };
    }
    if (!skip3b.includes(month)) {
      const taxable = month === "2025-04" ? 1890000 : 1900000;
      gstr3bByMonth[month] = {
        rows: [
          summaryRow(`B-G3-${month}`, "OUTWARD_TAXABLE", taxable, 342000),
          net ? summaryRow(`B-G3-${month}`, "ITC_CLAIMED", 0, 100000) : summaryRow(`B-G3-${month}`, "ITC_AVAILABLE", 0, 100000),
        ],
      };
    }
    gstr2b.push(doc(`B-2B-${month}`, month, `${month}-12`, 100000));
  }
  gstr2b.push(doc("B-2B-2025-04", "2025-04", "2025-03-20", 20000));
  const trialBalance = [
    ledger("Sales", "Sales Accounts", -23900000),
    ledger("Input IGST", "Duties & Taxes", 1210000, { hasTransactionTotals: true, debitTotalMinor: rupees(1210000) }),
  ];
  return {
    financialYear: FY,
    gstr1ByMonth,
    gstr3bByMonth,
    gstr2b,
    gstr2bMonths: MONTHS,
    trialBalance,
    gstr9Figures: figures ?? {
      "4N": { taxableMinor: rupees(22800000), igstMinor: 0, cgstMinor: 0, sgstMinor: 0, cessMinor: 0, totalTaxMinor: 0 },
      "5N": { taxableMinor: rupees(24000000), igstMinor: 0, cgstMinor: 0, sgstMinor: 0, cessMinor: 0, totalTaxMinor: 0 },
      "6A": { taxableMinor: null, igstMinor: rupees(1200000), cgstMinor: 0, sgstMinor: 0, cessMinor: 0, totalTaxMinor: rupees(1200000) },
      "8A": { taxableMinor: null, igstMinor: rupees(1200000), cgstMinor: 0, sgstMinor: 0, cessMinor: 0, totalTaxMinor: rupees(1200000) },
      "8C": { taxableMinor: null, igstMinor: rupees(20000), cgstMinor: 0, sgstMinor: 0, cessMinor: 0, totalTaxMinor: rupees(20000) },
    },
  };
}

// The checks, parameterised by the engine module so a mutant can be run through exactly the same ones.
function runChecks(engine) {
  const { buildGstr9cRows, normalizeGstr9Figures, summarizeGstr9c, validateGstr9cDecision } = engine;
  const checks = [];
  const check = (name, fn) => {
    try {
      fn();
      checks.push({ name, pass: true });
    } catch (error) {
      checks.push({ name, pass: false, detail: String(error.message).split("\n")[0] });
    }
  };
  const eq = (actual, expected, what = "") => {
    if (actual !== expected) throw new Error(`${what ? `${what}: ` : ""}expected ${expected}, got ${actual}`);
  };
  const find = (built, identityLabel) => {
    const row = built.rows.find((r) => r.label === identityLabel);
    if (!row) throw new Error(`no row labelled "${identityLabel}"`);
    return row;
  };

  const built = buildGstr9cRows(fixture());
  const monthly = built.rows.filter((r) => r.section === "MONTHLY");

  check("12 monthly rows, one per month of the year, in order", () => {
    eq(monthly.length, 12);
    eq(monthly.map((r) => r.label).join(","), MONTHS.join(","));
  });
  check("monthly: GSTR-1 taxable is B2B less the credit note (19,00,000)", () => {
    eq(monthly[1].values.leftMinor, rupees(1900000), "May GSTR-1");
  });
  check("monthly: April GSTR-3B is 18,90,000, ten thousand rupees under GSTR-1", () => {
    eq(monthly[0].values.rightMinor, rupees(1890000));
    eq(monthly[0].values.differenceMinor, rupees(10000));
    eq(monthly[0].values.withinRounding, false);
  });
  check("monthly: the other eleven months agree exactly", () => {
    eq(monthly.slice(1).every((r) => r.values.differenceMinor === 0 && r.values.withinRounding), true);
  });
  check("turnover: GSTR-1 for the year is 2,28,00,000 rupees, above Int32 paise, kept exactly", () => {
    const row = find(built, "GSTR-1 turnover for the year against GSTR-9");
    eq(row.values.leftMinor, 2_280_000_000);
    eq(row.values.rightMinor, 2_280_000_000);
    eq(row.values.differenceMinor, 0);
  });
  check("turnover: GSTR-3B for the year is 2,27,90,000, ten thousand under the GSTR-9 comparator", () => {
    const row = find(built, "GSTR-3B turnover for the year against GSTR-9");
    eq(row.values.leftMinor, rupees(22790000));
    eq(row.values.differenceMinor, -rupees(10000));
  });
  check("turnover: books 2,39,00,000 against GSTR-9 5N 2,40,00,000 leaves 1,00,000 unexplained", () => {
    const row = find(built, "Books turnover against GSTR-9 total turnover");
    eq(row.values.leftMinor, rupees(23900000));
    eq(row.values.differenceMinor, -rupees(100000));
  });
  check("itc: GSTR-3B gross ITC for the year is 12,00,000 and agrees with 6A", () => {
    const row = find(built, "GSTR-3B ITC against GSTR-9 table 6");
    eq(row.values.leftMinor, rupees(1200000));
    eq(row.values.differenceMinor, 0);
    eq(row.values.basis, "GROSS");
  });
  check("itc: GSTR-2B documents dated in the year are 12,00,000 and agree with 8A", () => {
    const row = find(built, "GSTR-2B ITC against GSTR-9 table 8A");
    eq(row.values.leftMinor, rupees(1200000));
    eq(row.values.differenceMinor, 0);
  });
  check("itc: the document dated 20 March 2025 is isolated as an 8C candidate (20,000) and agrees", () => {
    const row = find(built, "Late-reported GSTR-2B documents against GSTR-9 table 8C");
    eq(row.values.leftMinor, rupees(20000));
    eq(row.values.differenceMinor, 0);
    eq(row.values.documents, 1);
  });
  check("itc: input GST debit transactions 12,10,000 against 6A 12,00,000 leave 10,000", () => {
    const row = find(built, "ITC in the books against GSTR-9 table 6A");
    eq(row.values.leftMinor, rupees(1210000));
    eq(row.values.differenceMinor, rupees(10000));
  });
  check("a credit note in GSTR-2B reduces the year's ITC", () => {
    const input = fixture();
    input.gstr2b.push(doc("B-2B-2025-05", "2025-05", "2025-05-20", 5000, "CREDIT_NOTE"));
    const row = find(buildGstr9cRows(input), "GSTR-2B ITC against GSTR-9 table 8A");
    eq(row.values.leftMinor, rupees(1195000));
  });
  check("a missing GSTR-3B month is named and the year's total is not shown, not zero", () => {
    const b = buildGstr9cRows(fixture({ skip3b: ["2025-09"] }));
    const row = find(b, "GSTR-3B turnover for the year against GSTR-9");
    eq(row.values.leftMinor, null, "total");
    eq(row.values.differenceMinor, null, "difference");
    eq(row.values.monthsMissing.join(","), "2025-09");
    eq(row.state, "PENDING_INPUT");
    eq(row.values.partialLeftMinor, rupees(22790000 - 1900000), "partial working");
    eq(b.monthsMissing.join(","), "2025-09");
  });
  check("a missing month's row is pending, with the return named as not loaded", () => {
    const b = buildGstr9cRows(fixture({ skip3b: ["2025-09"] }));
    const row = b.rows.find((r) => r.section === "MONTHLY" && r.label === "2025-09");
    eq(row.state, "PENDING_INPUT");
    eq(row.ruleHits.some((h) => h.rule === "GSTR3B_NOT_LOADED"), true);
    eq(row.values.differenceMinor, null);
  });
  check("a missing month blocks the summary: provisional, with the month listed", () => {
    const b = buildGstr9cRows(fixture({ skip3b: ["2025-09"] }));
    const s = summarizeGstr9c(b.rows);
    eq(s.provisional, true);
    const reason = s.reasons.find((r) => r.code === "MONTHS_MISSING" && r.what === "GSTR-3B");
    eq(Boolean(reason), true);
    eq(reason.months.join(","), "2025-09");
  });
  check("without table 4N the turnover checks are not made", () => {
    const figs = { "5N": { taxableMinor: rupees(24000000), igstMinor: 0, cgstMinor: 0, sgstMinor: 0, cessMinor: 0, totalTaxMinor: 0 } };
    const row = find(buildGstr9cRows(fixture({ figures: figs })), "GSTR-1 turnover for the year against GSTR-9");
    eq(row.values.rightMinor, null);
    eq(row.values.differenceMinor, null);
    eq(row.ruleHits.some((h) => h.rule === "GSTR9_4N_NOT_ENTERED"), true);
  });
  check("the comparator takes 4G off and adds 5A, 5B and 5C, and says which it used", () => {
    const base = fixture().gstr9Figures;
    const figs = {
      ...base,
      "4G": { taxableMinor: rupees(100000), igstMinor: 0, cgstMinor: 0, sgstMinor: 0, cessMinor: 0, totalTaxMinor: 0 },
      "5A": { taxableMinor: rupees(30000), igstMinor: 0, cgstMinor: 0, sgstMinor: 0, cessMinor: 0, totalTaxMinor: 0 },
    };
    const row = find(buildGstr9cRows(fixture({ figures: figs })), "GSTR-1 turnover for the year against GSTR-9");
    eq(row.values.rightMinor, rupees(22800000 - 100000 + 30000), "4N - 4G + 5A");
    eq(/Entered: 4N, 4G, 5A\./.test(row.ruleHits[0].detail), true, "entered list");
    eq(/Not entered, read as nil: 5B, 5C/.test(row.ruleHits[0].detail), true, "not-entered list");
  });
  check("ITC given only net of reversals is compared with 6A less 7I, and needs 7I", () => {
    const withoutSeven = find(buildGstr9cRows(fixture({ net: true })), "GSTR-3B ITC against GSTR-9 table 6");
    eq(withoutSeven.values.basis, "NET");
    eq(withoutSeven.values.rightMinor, null, "no 7I, no comparison");
    const base = fixture().gstr9Figures;
    const seven = { ...base, "7I": { taxableMinor: null, igstMinor: rupees(10000), cgstMinor: 0, sgstMinor: 0, cessMinor: 0, totalTaxMinor: rupees(10000) } };
    const withSeven = find(buildGstr9cRows(fixture({ net: true, figures: seven })), "GSTR-3B ITC against GSTR-9 table 6");
    eq(withSeven.values.rightMinor, rupees(1190000), "6A - 7I");
  });
  check("a difference of exactly ten rupees is rounding; one paisa more is not", () => {
    const mk = (extraPaise) => {
      const input = fixture();
      input.gstr2b.push({ ...doc("B-2B-2025-06", "2025-06", "2025-06-20", 0), igstMinor: 1000 + extraPaise });
      return find(buildGstr9cRows(input), "GSTR-2B ITC against GSTR-9 table 8A").values;
    };
    eq(mk(0).differenceMinor, 1000);
    eq(mk(0).withinRounding, true, "10 rupees");
    eq(mk(1).withinRounding, false, "10 rupees 1 paisa");
  });
  check("building the same inputs twice gives identical rows", () => {
    eq(JSON.stringify(buildGstr9cRows(fixture())), JSON.stringify(buildGstr9cRows(fixture())));
  });
  check("row keys are unique", () => {
    eq(new Set(built.rows.map((r) => r.rowKey)).size, built.rows.length);
  });
  check("every row that is not derived has a source row behind it", () => {
    eq(built.rows.filter((r) => r.decidable).every((r) => r.sourceEvidenceCount > 0), true);
  });

  // Decisions.
  const residual = find(built, "Books turnover against GSTR-9 total turnover");
  const agreeing = find(built, "GSTR-1 turnover for the year against GSTR-9");
  const rejects = (fn, pattern) => {
    try {
      fn();
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      if (pattern && !pattern.test(error.message)) throw new Error(`refused for the wrong reason: ${error.message}`);
      return;
    }
    throw new Error("was accepted");
  };
  check("decision: a difference cannot be confirmed without a reason", () => {
    rejects(() => validateGstr9cDecision(residual, { state: "CONFIRMED", choice: "", reason: "", note: "" }), /needs a reason/);
  });
  check("decision: 'not explained' is an accepted answer and is recorded as such", () => {
    validateGstr9cDecision(residual, { state: "CONFIRMED", choice: "UNEXPLAINED", reason: "", note: "" });
  });
  check("decision: 'other' needs the note", () => {
    rejects(() => validateGstr9cDecision(residual, { state: "CONFIRMED", choice: "OTHER_EXPLAINED", reason: "", note: "" }), /note/);
    validateGstr9cDecision(residual, { state: "CONFIRMED", choice: "OTHER_EXPLAINED", reason: "", note: "Discount on year-end sales" });
  });
  check("decision: a reason this pack does not know is refused", () => {
    rejects(() => validateGstr9cDecision(residual, { state: "CONFIRMED", choice: "BECAUSE", reason: "", note: "" }), /not a reason/);
  });
  check("decision: a row that agrees confirms without a reason", () => {
    validateGstr9cDecision(agreeing, { state: "CONFIRMED", choice: "", reason: "", note: "" });
  });
  check("decision: a comparison that was not made cannot be confirmed, but can be excluded with a reason", () => {
    const b = buildGstr9cRows(fixture({ skip3b: ["2025-09"] }));
    const row = find(b, "GSTR-3B turnover for the year against GSTR-9");
    rejects(() => validateGstr9cDecision(row, { state: "CONFIRMED", choice: "UNEXPLAINED", reason: "", note: "" }), /not been made/);
    validateGstr9cDecision(row, { state: "EXCLUDED", choice: "", reason: "No GSTR-3B for September: nil return", note: "" });
    rejects(() => validateGstr9cDecision(row, { state: "EXCLUDED", choice: "", reason: "", note: "" }), /why/);
  });

  // Summary.
  check("summary: every row decided and nothing missing is not provisional; unexplained residuals are named", () => {
    const rows = built.rows.map((r) => ({
      ...r,
      decision: r.decidable ? { state: "CONFIRMED", choice: r.values.differenceMinor !== 0 && !r.values.withinRounding ? "UNEXPLAINED" : "" } : null,
    }));
    const s = summarizeGstr9c(rows);
    eq(s.provisional, false, "provisional");
    eq(s.reasons.some((r) => r.code === "UNEXPLAINED_RESIDUALS" && r.blocking === false), true);
    eq(s.counts.undecided, 0);
  });
  check("summary: an undecided row keeps the pack provisional", () => {
    const s = summarizeGstr9c(built.rows.map((r) => ({ ...r, decision: null })));
    eq(s.provisional, true);
    eq(s.reasons.find((r) => r.code === "ROWS_NOT_DECIDED").count, built.rows.filter((r) => r.decidable).length);
  });

  // The GSTR-9 figures a person types.
  check("figures: lower case and spaces in a table row are read; a float is refused", () => {
    const ok = normalizeGstr9Figures({ "4n": { taxableMinor: 100, igstMinor: 5 } });
    eq(ok["4N"].totalTaxMinor, 5);
    rejects(() => normalizeGstr9Figures({ "4N": { taxableMinor: 10.5 } }), /whole number of paise/);
  });
  check("figures: a negative, an unknown row and an unknown key are refused", () => {
    rejects(() => normalizeGstr9Figures({ "4N": { taxableMinor: -1 } }), /not negative/);
    rejects(() => normalizeGstr9Figures({ "12Z": { taxableMinor: 1 } }), /not a GSTR-9 table row/);
    rejects(() => normalizeGstr9Figures({ "4N": { turnover: 1 } }), /does not take/);
  });
  check("figures: a string amount is refused rather than coerced", () => {
    rejects(() => normalizeGstr9Figures({ "4N": { taxableMinor: "100" } }), /whole number of paise/);
  });
  return checks;
}

const MUTANTS = [
  { name: "the comparator forgets to take 4G off", from: 'sumMinor([four, -(parts["4G"] ?? 0), parts["5A"] ?? 0, parts["5B"] ?? 0, parts["5C"] ?? 0], "GSTR-9 comparator")', to: 'sumMinor([four, 0, parts["5A"] ?? 0, parts["5B"] ?? 0, parts["5C"] ?? 0], "GSTR-9 comparator")' },
  { name: "a missing month is read as zero in the year's total", from: "compare(complete ? partialMinor : null, comparator)", to: "compare(partialMinor, comparator)" },
  { name: "a credit note adds to GSTR-2B ITC instead of reducing it", from: 'return row.documentType === "CREDIT_NOTE" ? -Math.abs(tax) : tax;', to: "return tax;" },
  { name: "the rounding tolerance is ten times too wide", from: "ROUNDING_TOLERANCE_MINOR = 1_000", to: "ROUNDING_TOLERANCE_MINOR = 10_000" },
  { name: "documents dated before the year are counted in 8A", from: "if (dateInYear(row.documentDate, financialYear)) inYear.push(row);", to: "if (row.documentDate) inYear.push(row);" },
  { name: "the books turnover has the wrong sign", from: 'books = -sumMinor(sales.map((l) => l.closingMinor || 0), "sales ledgers");', to: 'books = sumMinor(sales.map((l) => l.closingMinor || 0), "sales ledgers");' },
  { name: "an unexplained difference is confirmed without a reason", from: 'if (differs && !choice) throw new RangeError("This difference needs a reason.', to: 'if (false) throw new RangeError("This difference needs a reason.' },
];

async function main() {
  const engine = await import("../src/services/audit-pack-engine/gstr9c.engine.js");
  const checks = runChecks(engine);

  const mutants = await runMutants({
    enginePath: new URL("../src/services/audit-pack-engine/gstr9c.engine.js", import.meta.url),
    // The tolerance lives in kit.js, the rest in the engine: run each mutant against its own file.
    mutants: MUTANTS.filter((m) => !m.from.startsWith("ROUNDING_TOLERANCE_MINOR")),
    runChecks: async (module) => runChecks(module),
  });
  const kitMutants = await runMutants({
    enginePath: new URL("../src/services/audit-pack-kinds/kit.js", import.meta.url),
    mutants: MUTANTS.filter((m) => m.from.startsWith("ROUNDING_TOLERANCE_MINOR")),
    runChecks: async (module) => {
      // The rounding rule lives in the kit, so a kit mutant is checked on the kit itself.
      const results = [];
      const within = module.compare(1_001, 0).withinRounding;
      results.push({ name: "kit: one paisa over ten rupees is not rounding", pass: within === false });
      results.push({ name: "kit: exactly ten rupees is rounding", pass: module.compare(1_000, 0).withinRounding === true });
      return results;
    },
  });
  checks.push(...mutantChecks([...mutants, ...kitMutants]));

  // Section 2: the pack through the routes, when a scratch database is given.
  const uri = process.env.MONGODB_URI || "";
  const scratch = /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(uri) && /scratch/i.test((uri.split("/").pop() || "").split("?")[0]);
  let routeNote = "engine only (no scratch MONGODB_URI)";
  if (scratch) {
    const { runRouteChecks } = await import("./lib/gstr9c-routes.mjs");
    checks.push(...(await runRouteChecks({ uri, fixture, MONTHS, rupees })));
    routeNote = "scratch Mongo included";
  }

  let failed = 0;
  for (const c of checks) {
    if (c.pass) console.log(`PASS  ${c.name}`);
    else {
      failed += 1;
      console.error(`FAIL  ${c.name}${c.detail ? `\n      ${c.detail}` : ""}`);
    }
  }
  console.log(`\naudit-pack-gstr9c-contract: ${checks.length - failed}/${checks.length} passed (${routeNote})`);
  process.exitCode = failed ? 1 : 0;
}

await main();
