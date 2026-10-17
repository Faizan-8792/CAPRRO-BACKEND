// src/services/audit-pack-engine/gstr9c.engine.js
//
// W10 AP14 (2026-10-17). The GSTR-9 / GSTR-9C reconciliation working: the year's GSTR-1, GSTR-3B and
// GSTR-2B returns, the trial balance and the GSTR-9 figures as filed, set side by side, with every
// difference shown as a residual a person must explain - never netted away, never read as zero.
//
// WHAT THIS IS NOT. It does not reproduce the lines of the GSTR-9C certificate (Table 5 A-R, Table 12,
// Table 14). Those lines have signs and cross-references a certifying CA owns; reproducing them from
// memory is how a wrong statutory figure reaches a client. It computes the comparisons that feed them -
// turnover by month and by return, ITC by return - names the rule behind each, and leaves "why do these
// differ" to the person. A difference above the rounding tolerance is a COMPUTED row waiting for an
// answer; UNEXPLAINED is a legitimate answer, recorded as such, and is never presented as nil.
//
// PURE: the same inputs always give the same rows in the same order.
//
// THE COMPARATORS (each stated on its row; each can be wrong for a given client, which is why a person
// decides):
//   GSTR-1 and GSTR-3B outward turnover  against  GSTR-9 4N - 4G + 5A + 5B + 5C
//     4N taxable turnover; 4G is inward reverse charge (in Table 4 for tax, not a supply made); 5A/5B are
//     zero-rated supplies without payment of tax and 5C supplies on which the recipient pays - all three
//     are in GSTR-1 and in GSTR-3B 3.1(a)/(b) but not in 4N. A component not entered is read as nil and
//     the row says so.
//   Books turnover (Sales Accounts)       against  GSTR-9 5N total turnover
//   GSTR-3B ITC (4A gross; net when only net is given)  against  GSTR-9 6A (6A less 7I when net)
//   GSTR-2B ITC for documents dated in the year  against  GSTR-9 8A
//   GSTR-2B ITC on documents dated before the year  against  GSTR-9 8C
//   Input-GST ledgers' debit transactions  against  GSTR-9 6A

import {
  calculateGstr1Outward,
  calculateGstr3bOutward,
  normalizeGstr3bCategory,
} from "../gst-normalization.service.js";
import {
  ROUNDING_TOLERANCE_MINOR,
  compare,
  dateInYear,
  financialYearMonths,
  hit,
  norm,
  rowFactory,
  sumMinor,
  RESIDUAL_CHOICE_CODES,
} from "../audit-pack-kinds/kit.js";

export const GSTR9C_RULE_VERSION = "gstr9c-v1";

const makeRow = rowFactory(GSTR9C_RULE_VERSION, "GSTR-9C");

// The table rows of GSTR-9 a figure may be entered for: the ones the comparisons above read, plus the
// neighbours a person naturally copies in. Anything else is refused rather than stored unread.
export const GSTR9_FIGURE_CODES = Object.freeze([
  "4A", "4B", "4C", "4D", "4E", "4F", "4G", "4H", "4I", "4J", "4K", "4L", "4M", "4N",
  "5A", "5B", "5C", "5D", "5E", "5F", "5G", "5H", "5I", "5J", "5K", "5L", "5M", "5N",
  "6A", "6B", "6C", "6D", "6E", "6F", "6G", "6H", "6I", "6J", "6K", "6L", "6M", "6N", "6O",
  "7A", "7B", "7C", "7D", "7E", "7F", "7G", "7H", "7I", "7J",
  "8A", "8B", "8C", "8D", "8E", "8F", "8G", "8H", "8I", "8J", "8K",
]);

const HEADS = ["igstMinor", "cgstMinor", "sgstMinor", "cessMinor"];

/**
 * Checks and normalises the GSTR-9 figures a person typed. Returns { "4N": { taxableMinor, igstMinor, ...,
 * totalTaxMinor } }. Every amount must be a safe integer of paise - a float, a string or a negative number
 * is refused with the figure named, not coerced.
 */
export function normalizeGstr9Figures(figures) {
  if (figures == null) return {};
  if (typeof figures !== "object" || Array.isArray(figures)) throw new RangeError("GSTR-9 figures must be an object of table rows");
  const result = {};
  for (const [rawCode, raw] of Object.entries(figures)) {
    const code = String(rawCode).toUpperCase().replace(/[^0-9A-Z]/g, "");
    if (!GSTR9_FIGURE_CODES.includes(code)) throw new RangeError(`"${rawCode}" is not a GSTR-9 table row this pack reads`);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RangeError(`GSTR-9 ${code} must be an object of amounts`);
    const extra = Object.keys(raw).filter((key) => !["taxableMinor", ...HEADS].includes(key));
    if (extra.length) throw new RangeError(`GSTR-9 ${code} does not take: ${extra.join(", ")}`);
    const entry = {};
    for (const key of ["taxableMinor", ...HEADS]) {
      if (raw[key] === undefined || raw[key] === null) {
        entry[key] = key === "taxableMinor" ? null : 0;
        continue;
      }
      if (!Number.isSafeInteger(raw[key]) || raw[key] < 0) {
        throw new RangeError(`GSTR-9 ${code} ${key} must be a whole number of paise, not negative`);
      }
      entry[key] = raw[key];
    }
    entry.totalTaxMinor = sumMinor(HEADS.map((h) => entry[h]), `GSTR-9 ${code}`);
    result[code] = entry;
  }
  return result;
}

const figureTax = (figures, code) => (figures[code] ? figures[code].totalTaxMinor : null);
const figureTaxable = (figures, code) => (figures[code] && figures[code].taxableMinor != null ? figures[code].taxableMinor : null);

const src = (kind, row) => ({ kind, batchId: String(row.batchId), rowId: String(row.rowId), sourceRow: row.sourceRow || 0 });

function moneyOf(row) {
  return sumMinor([row.igstMinor || 0, row.cgstMinor || 0, row.sgstMinor || 0, row.cessMinor || 0], "tax");
}

function signed2b(row) {
  const tax = moneyOf(row);
  return row.documentType === "CREDIT_NOTE" ? -Math.abs(tax) : tax;
}

function safely(fn, rows, onError) {
  try {
    return { value: fn(rows), error: null };
  } catch (error) {
    onError(error);
    return { value: null, error: String(error?.message || error) };
  }
}

/**
 * @param {object} input
 * @param {string} input.financialYear
 * @param {Object<string,{rows:object[]}>} [input.gstr1ByMonth]   GSTR1_SUMMARY ImportRow-shaped rows by yyyy-mm
 * @param {Object<string,{rows:object[]}>} [input.gstr3bByMonth]  GSTR3B_SUMMARY rows by yyyy-mm
 * @param {object[]} [input.gstr2b]                               GSTR2B document rows, each with rowId, batchId
 * @param {string[]} [input.gstr2bMonths]                         the months whose 2B was loaded
 * @param {object[]|null} [input.trialBalance]                    null when no trial balance was chosen
 * @param {object} [input.gstr9Figures]                           normalizeGstr9Figures() output
 */
export function buildGstr9cRows({
  financialYear,
  gstr1ByMonth = {},
  gstr3bByMonth = {},
  gstr2b = [],
  gstr2bMonths = [],
  trialBalance = null,
  gstr9Figures = {},
}) {
  const months = financialYearMonths(financialYear);
  const figures = gstr9Figures;
  const rows = [];

  // ─── month by month: GSTR-1 against GSTR-3B ────────────────────────────────────
  const monthly = [];
  for (const month of months) {
    const g1 = gstr1ByMonth[month];
    const g3 = gstr3bByMonth[month];
    const ruleHits = [];
    const sources = [];
    let g1Out = null;
    let g3Out = null;
    if (g1) {
      const read = safely(calculateGstr1Outward, g1.rows, (e) => ruleHits.push(hit("GSTR1_UNREADABLE", `GSTR-1 for ${month} could not be read: ${e.message}`)));
      g1Out = read.error ? undefined : read.value ?? { taxableValueMinor: 0, totalTaxMinor: 0, empty: true };
      if (read.value === null && !read.error) ruleHits.push(hit("GSTR1_NO_TAXABLE_SECTIONS", `The GSTR-1 file for ${month} has no taxable outward section, so it is read as no taxable outward supply.`));
      for (const row of g1.rows) sources.push(src("GSTR1_SUMMARY", row));
    }
    if (g3) {
      const read = safely(calculateGstr3bOutward, g3.rows, (e) => ruleHits.push(hit("GSTR3B_UNREADABLE", `GSTR-3B for ${month} could not be read: ${e.message}`)));
      g3Out = read.error ? undefined : read.value ?? { taxableValueMinor: 0, totalTaxMinor: 0, empty: true };
      if (read.value === null && !read.error) ruleHits.push(hit("GSTR3B_NO_OUTWARD_ROWS", `The GSTR-3B file for ${month} has no Table 3.1 taxable or zero-rated row, so it is read as no taxable outward supply.`));
      for (const row of g3.rows) sources.push(src("GSTR3B_SUMMARY", row));
    }
    const loaded1 = Boolean(g1) && g1Out !== undefined;
    const loaded3 = Boolean(g3) && g3Out !== undefined;
    if (!g1) ruleHits.push(hit("GSTR1_NOT_LOADED", `GSTR-1 for ${month} is not loaded.`));
    if (!g3) ruleHits.push(hit("GSTR3B_NOT_LOADED", `GSTR-3B for ${month} is not loaded.`));

    const taxable = compare(loaded1 ? g1Out.taxableValueMinor : null, loaded3 ? g3Out.taxableValueMinor : null);
    const tax = compare(loaded1 ? g1Out.totalTaxMinor : null, loaded3 ? g3Out.totalTaxMinor : null);
    if (taxable.known && !taxable.withinRounding) {
      ruleHits.push(hit("DIFFERENCE_ABOVE_ROUNDING", "GSTR-1 and GSTR-3B declare different taxable outward supply this month. Say why.", ROUNDING_TOLERANCE_MINOR));
    }
    const state = loaded1 && loaded3 ? "COMPUTED" : "PENDING_INPUT";
    const row = makeRow({
      section: "MONTHLY",
      identity: `monthly:${month}`,
      label: month,
      values: {
        month,
        leftLabel: "GSTR-1 taxable outward supply",
        leftMinor: taxable.leftMinor,
        rightLabel: "GSTR-3B Table 3.1 taxable and zero-rated supply",
        rightMinor: taxable.rightMinor,
        differenceMinor: taxable.differenceMinor,
        withinRounding: taxable.withinRounding,
        taxLeftMinor: tax.leftMinor,
        taxRightMinor: tax.rightMinor,
        taxDifferenceMinor: tax.differenceMinor,
        gstr1Loaded: loaded1,
        gstr3bLoaded: loaded3,
      },
      ruleHits,
      state,
      sources,
      derived: sources.length === 0,
    });
    monthly.push({ month, loaded1, loaded3, g1Out, g3Out, row });
    rows.push(row);
  }

  const missing1 = monthly.filter((m) => !m.loaded1).map((m) => m.month);
  const missing3 = monthly.filter((m) => !m.loaded3).map((m) => m.month);
  const monthsLoaded2b = [...new Set(gstr2bMonths)].filter((m) => months.includes(m)).sort();
  const missing2b = months.filter((m) => !monthsLoaded2b.includes(m));

  // ─── turnover against GSTR-9 ───────────────────────────────────────────────────
  const four = figureTaxable(figures, "4N");
  const comparatorHits = [];
  let comparator = null;
  if (four !== null) {
    const parts = { "4G": figureTaxable(figures, "4G"), "5A": figureTaxable(figures, "5A"), "5B": figureTaxable(figures, "5B"), "5C": figureTaxable(figures, "5C") };
    const used = ["4N"];
    const notEntered = [];
    for (const code of ["4G", "5A", "5B", "5C"]) (parts[code] === null ? notEntered : used).push(code);
    comparator = sumMinor([four, -(parts["4G"] ?? 0), parts["5A"] ?? 0, parts["5B"] ?? 0, parts["5C"] ?? 0], "GSTR-9 comparator");
    comparatorHits.push(hit("GSTR9_COMPARATOR", `Compared with GSTR-9 4N less 4G plus 5A, 5B and 5C. Entered: ${used.join(", ")}.${notEntered.length ? ` Not entered, read as nil: ${notEntered.join(", ")}.` : ""}`));
  } else {
    comparatorHits.push(hit("GSTR9_4N_NOT_ENTERED", "GSTR-9 table 4N (taxable turnover) is not entered, so this cannot be compared."));
  }

  const sumMonths = (side) => {
    const list = monthly.filter((m) => (side === 1 ? m.loaded1 : m.loaded3));
    const key = "taxableValueMinor";
    return sumMinor(list.map((m) => (side === 1 ? m.g1Out[key] : m.g3Out[key])), "monthly turnover");
  };
  const returnSources = (kind, side) => monthly.flatMap((m) => {
    const entry = side === 1 ? m.row : m.row;
    return entry.allSources.filter((s) => s.kind === kind);
  });

  for (const [side, kind, label, missing] of [[1, "GSTR1_SUMMARY", "GSTR-1", missing1], [3, "GSTR3B_SUMMARY", "GSTR-3B", missing3]]) {
    const ruleHits = [...comparatorHits];
    const complete = missing.length === 0;
    const partialMinor = monthly.some((m) => (side === 1 ? m.loaded1 : m.loaded3)) ? sumMonths(side) : null;
    if (!complete) ruleHits.push(hit("MONTHS_MISSING", `${label} is not loaded for ${missing.join(", ")}; the year's total is not shown as complete.`));
    const c = compare(complete ? partialMinor : null, comparator);
    if (c.known && !c.withinRounding) ruleHits.push(hit("DIFFERENCE_ABOVE_ROUNDING", `${label} turnover for the year differs from GSTR-9. Say why.`, ROUNDING_TOLERANCE_MINOR));
    const sources = returnSources(kind, side);
    rows.push(makeRow({
      section: "TURNOVER",
      identity: `turnover:${label}`,
      label: `${label} turnover for the year against GSTR-9`,
      values: {
        leftLabel: `${label}, taxable outward supply for the year`,
        leftMinor: c.leftMinor,
        rightLabel: "GSTR-9 comparator (4N less 4G plus 5A, 5B, 5C)",
        rightMinor: c.rightMinor,
        differenceMinor: c.differenceMinor,
        withinRounding: c.withinRounding,
        monthsMissing: missing,
        partialLeftMinor: complete ? null : partialMinor,
      },
      ruleHits,
      state: c.known ? "COMPUTED" : "PENDING_INPUT",
      sources,
      derived: sources.length === 0,
    }));
  }

  // Books turnover.
  {
    const ruleHits = [];
    let books = null;
    const sources = [];
    if (trialBalance === null) {
      ruleHits.push(hit("TRIAL_BALANCE_NOT_CHOSEN", "No trial balance was chosen, so books turnover is not shown."));
    } else {
      const sales = trialBalance.filter((l) => /^sales accounts?$/.test(norm(l.groupName)) || (!l.groupName && /\bsales\b/.test(norm(l.ledgerName))));
      if (sales.length === 0) ruleHits.push(hit("NO_SALES_LEDGERS", "No ledger in the Sales Accounts group was found, so books turnover is not shown."));
      else {
        books = -sumMinor(sales.map((l) => l.closingMinor || 0), "sales ledgers");
        for (const l of sales) sources.push({ kind: "TRIAL_BALANCE", batchId: String(l.batchId), rowId: String(l.rowId), sourceRow: l.sourceRow || 0 });
        ruleHits.push(hit("BOOKS_SALES_GROUP", `${sales.length} ledger(s) in Sales Accounts; a credit balance is turnover, a debit balance (returns) reduces it.`));
      }
    }
    const five = figureTaxable(figures, "5N");
    if (five === null) ruleHits.push(hit("GSTR9_5N_NOT_ENTERED", "GSTR-9 table 5N (total turnover) is not entered, so this cannot be compared."));
    const c = compare(books, five);
    if (c.known && !c.withinRounding) ruleHits.push(hit("DIFFERENCE_ABOVE_ROUNDING", "Books turnover differs from the turnover GSTR-9 declares. Say why: timing of advances, credit notes, discounts, unbilled revenue, exempt supplies.", ROUNDING_TOLERANCE_MINOR));
    rows.push(makeRow({
      section: "TURNOVER",
      identity: "turnover:books",
      label: "Books turnover against GSTR-9 total turnover",
      values: {
        leftLabel: "Turnover in the books (Sales Accounts)",
        leftMinor: c.leftMinor,
        rightLabel: "GSTR-9 5N, total turnover",
        rightMinor: c.rightMinor,
        differenceMinor: c.differenceMinor,
        withinRounding: c.withinRounding,
      },
      ruleHits,
      state: c.known ? "COMPUTED" : "PENDING_INPUT",
      sources,
      derived: sources.length === 0,
    }));
  }

  // ─── ITC against GSTR-9 ────────────────────────────────────────────────────────
  {
    // GSTR-3B ITC: gross (4A) when the file has it, net (4C) when it only has that.
    const ruleHits = [];
    const sources = [];
    let leftMinor = null;
    let basis = null;
    if (missing3.length === 0) {
      let gross = 0;
      let reversed = 0;
      let net = 0;
      let sawGross = false;
      let sawNet = false;
      try {
        for (const m of monthly) {
          for (const row of gstr3bByMonth[m.month].rows) {
            const category = normalizeGstr3bCategory(row.summaryCategory);
            const tax = moneyOf(row);
            if (category === "ITC_AVAILABLE") { gross = sumMinor([gross, tax]); sawGross = true; sources.push(src("GSTR3B_SUMMARY", row)); }
            else if (category === "ITC_REVERSED") { reversed = sumMinor([reversed, tax]); sources.push(src("GSTR3B_SUMMARY", row)); }
            else if (category === "ITC_CLAIMED") { net = sumMinor([net, tax]); sawNet = true; sources.push(src("GSTR3B_SUMMARY", row)); }
          }
        }
        if (sawGross) { leftMinor = gross; basis = "GROSS"; }
        else if (sawNet) { leftMinor = net; basis = "NET"; }
        else ruleHits.push(hit("NO_ITC_ROWS", "The GSTR-3B files carry no ITC row, so ITC cannot be compared."));
      } catch (error) {
        ruleHits.push(hit("GSTR3B_UNREADABLE", `GSTR-3B ITC could not be read: ${error.message}`));
      }
    } else {
      ruleHits.push(hit("MONTHS_MISSING", `GSTR-3B is not loaded for ${missing3.join(", ")}; the year's ITC is not shown as complete.`));
    }
    let rightMinor = figureTax(figures, "6A");
    let rightLabel = "GSTR-9 6A, ITC availed through GSTR-3B";
    if (rightMinor === null) ruleHits.push(hit("GSTR9_6A_NOT_ENTERED", "GSTR-9 table 6A is not entered, so this cannot be compared."));
    if (basis === "NET") {
      const seven = figureTax(figures, "7I");
      if (rightMinor !== null && seven !== null) {
        rightMinor = sumMinor([rightMinor, -seven], "6A less 7I");
        rightLabel = "GSTR-9 6A less 7I (the GSTR-3B file gives ITC net of reversals)";
        ruleHits.push(hit("NET_BASIS", "The GSTR-3B files give ITC net of reversals, so GSTR-9 7I (total reversed) is taken off 6A for a like-for-like comparison."));
      } else {
        rightMinor = null;
        ruleHits.push(hit("NET_BASIS_NEEDS_7I", "The GSTR-3B files give ITC net of reversals; enter GSTR-9 7I so 6A can be compared like for like."));
      }
    }
    const c = compare(leftMinor, rightMinor);
    if (c.known && !c.withinRounding) ruleHits.push(hit("DIFFERENCE_ABOVE_ROUNDING", "ITC in the GSTR-3B files differs from GSTR-9 table 6. Say why.", ROUNDING_TOLERANCE_MINOR));
    rows.push(makeRow({
      section: "ITC",
      identity: "itc:3b-vs-6a",
      label: "GSTR-3B ITC against GSTR-9 table 6",
      values: { leftLabel: `GSTR-3B ITC for the year (${basis === "NET" ? "net of reversals" : "gross, Table 4A"})`, leftMinor: c.leftMinor, rightLabel, rightMinor: c.rightMinor, differenceMinor: c.differenceMinor, withinRounding: c.withinRounding, basis },
      ruleHits,
      state: c.known ? "COMPUTED" : "PENDING_INPUT",
      sources,
      derived: sources.length === 0,
    }));
  }

  {
    // GSTR-2B: documents dated in the year (8A) and documents dated earlier but reported in this year's
    // statements (8C candidates). The 2B import rows carry no eligibility flag, so every document counts.
    const inYear = [];
    const earlier = [];
    for (const row of gstr2b) {
      if (!months.includes(row.period)) continue;
      if (dateInYear(row.documentDate, financialYear)) inYear.push(row);
      else if (/^\d{4}-\d{2}-\d{2}$/.test(String(row.documentDate || "")) && row.documentDate < `${months[0]}-01`) earlier.push(row);
    }
    const complete = missing2b.length === 0;
    const base = [hit("NO_ELIGIBILITY_FLAG", "GSTR-2B import rows carry no ITC-available flag, so every document counts here; the portal's 8A counts only ITC available. A difference can be ineligible documents.")];
    const left8a = complete ? sumMinor(inYear.map(signed2b), "2B in year") : null;
    const ruleHits = [...base];
    if (!complete) ruleHits.push(hit("MONTHS_MISSING", `GSTR-2B is not loaded for ${missing2b.join(", ")}; the year's ITC is not shown as complete.`));
    const right8a = figureTax(figures, "8A");
    if (right8a === null) ruleHits.push(hit("GSTR9_8A_NOT_ENTERED", "GSTR-9 table 8A is not entered, so this cannot be compared."));
    const c = compare(left8a, right8a);
    if (c.known && !c.withinRounding) ruleHits.push(hit("DIFFERENCE_ABOVE_ROUNDING", "GSTR-2B ITC differs from GSTR-9 table 8A. Say why.", ROUNDING_TOLERANCE_MINOR));
    const sources8a = inYear.map((r) => src("GSTR2B", r));
    rows.push(makeRow({
      section: "ITC",
      identity: "itc:2b-vs-8a",
      label: "GSTR-2B ITC against GSTR-9 table 8A",
      values: { leftLabel: "GSTR-2B ITC on documents dated in the year", leftMinor: c.leftMinor, rightLabel: "GSTR-9 8A, ITC as per GSTR-2B", rightMinor: c.rightMinor, differenceMinor: c.differenceMinor, withinRounding: c.withinRounding, monthsMissing: missing2b, documents: inYear.length },
      ruleHits,
      state: c.known ? "COMPUTED" : "PENDING_INPUT",
      sources: sources8a,
      derived: sources8a.length === 0,
    }));

    const left8c = complete || earlier.length ? sumMinor(earlier.map(signed2b), "2B earlier") : null;
    const hits8c = [hit("LATE_REPORTED", "Documents dated before the year that appear in this year's GSTR-2B statements: candidates for GSTR-9 table 8C (late-reported). The portal decides which it reports.")];
    const right8c = figureTax(figures, "8C");
    if (right8c === null) hits8c.push(hit("GSTR9_8C_NOT_ENTERED", "GSTR-9 table 8C is not entered; the candidates are shown without a comparison."));
    const c8 = compare(left8c, right8c);
    if (c8.known && !c8.withinRounding) hits8c.push(hit("DIFFERENCE_ABOVE_ROUNDING", "Late-reported GSTR-2B ITC differs from GSTR-9 table 8C. Say why.", ROUNDING_TOLERANCE_MINOR));
    const sources8c = earlier.map((r) => src("GSTR2B", r));
    rows.push(makeRow({
      section: "ITC",
      identity: "itc:2b-vs-8c",
      label: "Late-reported GSTR-2B documents against GSTR-9 table 8C",
      values: { leftLabel: "GSTR-2B ITC on documents dated before the year", leftMinor: c8.leftMinor, rightLabel: "GSTR-9 8C", rightMinor: c8.rightMinor, differenceMinor: c8.differenceMinor, withinRounding: c8.withinRounding, documents: earlier.length },
      ruleHits: hits8c,
      state: c8.known ? "COMPUTED" : "PENDING_INPUT",
      sources: sources8c,
      derived: sources8c.length === 0,
    }));
  }

  {
    const ruleHits = [];
    const sources = [];
    let leftMinor = null;
    if (trialBalance === null) {
      ruleHits.push(hit("TRIAL_BALANCE_NOT_CHOSEN", "No trial balance was chosen, so ITC in the books is not shown."));
    } else {
      const ledgers = trialBalance.filter((l) => {
        const name = norm(l.ledgerName);
        return /\binput\b/.test(name) && /(igst|cgst|sgst|utgst|\bgst\b|cess)/.test(name) && !/(output|payable|liabilit|reverse charge)/.test(name);
      });
      if (ledgers.length === 0) ruleHits.push(hit("NO_INPUT_GST_LEDGERS", "No ledger named like an input GST ledger was found."));
      else if (ledgers.some((l) => !l.hasTransactionTotals)) ruleHits.push(hit("DEBIT_TRANSACTIONS_MISSING", "ITC availed in the year is the debit transactions of the input GST ledgers; the trial balance has no Debit transactions column, so it is not shown."));
      else {
        leftMinor = sumMinor(ledgers.map((l) => l.debitTotalMinor || 0), "input ledgers");
        for (const l of ledgers) sources.push({ kind: "TRIAL_BALANCE", batchId: String(l.batchId), rowId: String(l.rowId), sourceRow: l.sourceRow || 0 });
        ruleHits.push(hit("BOOKS_INPUT_LEDGERS", `${ledgers.length} input GST ledger(s); the debit transactions of the year are the ITC booked.`));
      }
    }
    const right = figureTax(figures, "6A");
    if (right === null) ruleHits.push(hit("GSTR9_6A_NOT_ENTERED", "GSTR-9 table 6A is not entered, so this cannot be compared."));
    const c = compare(leftMinor, right);
    if (c.known && !c.withinRounding) ruleHits.push(hit("DIFFERENCE_ABOVE_ROUNDING", "ITC booked differs from ITC availed in GSTR-9. Say why: timing, reversals booked separately, ITC availed on a later return.", ROUNDING_TOLERANCE_MINOR));
    rows.push(makeRow({
      section: "ITC",
      identity: "itc:books-vs-6a",
      label: "ITC in the books against GSTR-9 table 6A",
      values: { leftLabel: "Input GST ledgers, debit transactions of the year", leftMinor: c.leftMinor, rightLabel: "GSTR-9 6A", rightMinor: c.rightMinor, differenceMinor: c.differenceMinor, withinRounding: c.withinRounding },
      ruleHits,
      state: c.known ? "COMPUTED" : "PENDING_INPUT",
      sources,
      derived: sources.length === 0,
    }));
  }

  return {
    ruleVersion: GSTR9C_RULE_VERSION,
    financialYear,
    monthsLoaded: months.filter((m) => !missing1.includes(m) && !missing3.includes(m) && monthsLoaded2b.includes(m)),
    monthsMissing: months.filter((m) => missing1.includes(m) || missing3.includes(m) || missing2b.includes(m)),
    rows,
  };
}

// ─── decisions ──────────────────────────────────────────────────────────

/** The row as a person has left it: the decision's state and choice laid over the proposal. */
export function effectiveRow(row) {
  const decision = row.decision || null;
  return { ...row, state: decision?.state || row.state, choice: decision?.choice || "" };
}

/**
 * Whether a person's decision on a row is acceptable. Throws a message the CA can act on.
 * A difference above rounding cannot be confirmed without saying what it is - UNEXPLAINED is an answer.
 */
export function validateGstr9cDecision(row, { state, choice, reason, note }) {
  if (state === "EXCLUDED") {
    if (!reason) throw new RangeError("Say why this row is excluded.");
    return;
  }
  if (choice && !RESIDUAL_CHOICE_CODES.includes(choice)) throw new RangeError("That is not a reason this pack knows.");
  // A comparison that has not been made cannot be confirmed: confirming it would certify nothing.
  if (!Number.isSafeInteger(row.values?.differenceMinor)) {
    throw new RangeError("This check has not been made yet because an input is not loaded. Load it and create the pack again, or exclude this row with a reason.");
  }
  const differs = !row.values.withinRounding;
  if (differs && !choice) throw new RangeError("This difference needs a reason. If you cannot explain it, choose \"Not explained\"; that is recorded as such.");
  if (differs && choice === "OTHER_EXPLAINED" && !note) throw new RangeError("Say what the difference is in the note.");
}

export function summarizeGstr9c(rows) {
  const effective = rows.map(effectiveRow);
  const decidable = effective.filter((r) => r.decidable);
  const undecided = decidable.filter((r) => !["CONFIRMED", "EXCLUDED"].includes(r.state));
  const blockedInputs = effective.filter((r) => !r.decidable && r.state === "PENDING_INPUT");
  const missing = {
    "GSTR-1": new Set(),
    "GSTR-3B": new Set(),
    "GSTR-2B": new Set(),
  };
  for (const r of effective) {
    if (r.section === "MONTHLY") {
      if (!r.values.gstr1Loaded) missing["GSTR-1"].add(r.values.month);
      if (!r.values.gstr3bLoaded) missing["GSTR-3B"].add(r.values.month);
    }
    if (r.values.monthsMissing?.length && r.section === "ITC") for (const m of r.values.monthsMissing) missing["GSTR-2B"].add(m);
  }
  const reasons = [];
  if (undecided.length) reasons.push({ code: "ROWS_NOT_DECIDED", count: undecided.length, blocking: true });
  if (blockedInputs.length) reasons.push({ code: "INPUTS_MISSING", count: blockedInputs.length, blocking: true });
  for (const [what, set] of Object.entries(missing)) {
    if (set.size) reasons.push({ code: "MONTHS_MISSING", what, months: [...set].sort(), count: set.size, blocking: true });
  }
  const unexplained = effective.filter((r) => r.state === "CONFIRMED" && r.choice === "UNEXPLAINED" && Number.isSafeInteger(r.values.differenceMinor) && !r.values.withinRounding);
  if (unexplained.length) reasons.push({ code: "UNEXPLAINED_RESIDUALS", count: unexplained.length, blocking: false });

  const residuals = effective
    .filter((r) => r.section !== "MONTHLY" && Number.isSafeInteger(r.values.differenceMinor) && !r.values.withinRounding)
    .map((r) => ({ rowKey: r.rowKey, label: r.label, differenceMinor: r.values.differenceMinor, state: r.state, choice: r.choice || "" }));

  return {
    ruleVersion: GSTR9C_RULE_VERSION,
    provisional: reasons.some((r) => r.blocking),
    reasons,
    residuals,
    counts: {
      rows: effective.length,
      decidable: decidable.length,
      undecided: undecided.length,
      inputsMissing: blockedInputs.length,
      withinRounding: effective.filter((r) => r.values.withinRounding).length,
      residuals: residuals.length,
    },
  };
}
