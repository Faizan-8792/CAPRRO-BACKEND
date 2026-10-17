// src/services/audit-pack-engine/caro.engine.js
//
// W10 AP29 (2026-10-17). The clauses of the Companies (Auditor's Report) Order, 2020 that the books can speak to,
// as rows for the auditor to decide: whether the Order applies at all, statutory dues outstanding more than six
// months (clause (vii)(a)), borrowings (ix)(a), whether internal audit is required (xiv), cash losses (xvii), and the
// figures for the going-concern narrative (xix). The conclusion on every row is a person's.
//
// THE CEILING. Nothing here concludes. An applicability verdict is what the thresholds give on the figures; the row
// says which figures, and the person confirms or overrules it. (xix) is the auditor's opinion on material
// uncertainty; the row quotes the indicators and a drafted narrative may be asked for, labelled DRAFT FOR REVIEW,
// but neither the engine nor the draft ever chooses the answer.
//
// THRESHOLDS are constants of this rule version, in paise, stated on the rows that use them. They are the Order's
// and the Companies Act's text as understood when this version was written; the rule version changes if they do, and
// a test names each one so a wrong edit fails loudly. Where a threshold is read one way when the text could be read
// two, the safer reading (the one that does not exempt a company) is used and the row says so.
//
// WHAT THE BOOKS CANNOT SAY. Borrowings "from a bank or financial institution at any point of time" are not a Tally
// group: the books' total borrowings are an upper bound (if they are within the limit, the bank and institution part
// is), and above it the person types the figure. Deposits, the highest borrowings, and the paid-up capital are typed
// where the books cannot give them. Dues are aged from the date of the credit entry plus thirty days (a month-end
// accrual falls due in the following month); the due date itself is not in the books.
//
// PURE: no I/O. A year is measured voucher by voucher (ratios.engine.js createMeasure) and the clause-specific
// ledger movements are collected in the same pass (createCaroBook).

import { choice, hit, rowFactory } from "../audit-pack-kinds/kit.js";
import { STANDARD_GROUPS } from "../books/group-mapping.js";
import { formatRupees } from "./clause21d.engine.js";
import { AMOUNT_COLUMNS, SPECS_BY_CODE, evaluateRatio, formatRatio } from "./ratios.engine.js";
import { addDays, dateInYear, financialYearBounds, indexLedgers, ledgerSource, norm, sumMinor, voucherSource } from "./voucher-kit.js";

export const CARO_RULE_VERSION = "caro-v1";

/** Paise in one crore rupees. */
export const CRORE = 1_000_000_000;

export const THRESHOLDS = Object.freeze({
  // Paragraph 1(2): a private company (not a subsidiary or holding company of a public company) is outside the Order
  // when paid-up capital and reserves and surplus are not more than Rs 1 crore, borrowings from banks and financial
  // institutions at no time in the year exceed Rs 1 crore, and total revenue does not exceed Rs 10 crore.
  PRIVATE_CAPITAL_AND_RESERVES: 1 * CRORE,
  PRIVATE_BORROWINGS: 1 * CRORE,
  PRIVATE_REVENUE: 10 * CRORE,
  // A small company (section 2(85), as notified): paid-up capital not more than Rs 4 crore and turnover not more
  // than Rs 40 crore, and not public, not a holding or subsidiary company, not a section 8 company.
  SMALL_PAID_UP: 4 * CRORE,
  SMALL_TURNOVER: 40 * CRORE,
  // Section 138 and Rule 13: internal audit. Unlisted public company: paid-up capital Rs 50 crore or more, turnover Rs
  // 200 crore or more, borrowings from banks and public financial institutions Rs 100 crore or more at any time, or
  // deposits Rs 25 crore or more at any time, in the preceding year. Private company: turnover Rs 200 crore or more or
  // those borrowings Rs 100 crore or more. ("Exceeding one hundred crore rupees or more" is read as 100 crore or more.)
  INTERNAL_AUDIT_PAID_UP: 50 * CRORE,
  INTERNAL_AUDIT_TURNOVER: 200 * CRORE,
  INTERNAL_AUDIT_BORROWINGS: 100 * CRORE,
  INTERNAL_AUDIT_DEPOSITS: 25 * CRORE,
});

/** Days added to the date of a credit entry to get the date the due became payable (a month-end accrual is paid the next month). */
export const DUE_LAG_DAYS = 30;
/** Calendar months a due may stand unpaid after it became payable before clause (vii)(a) asks for it. */
export const ARREARS_MONTHS = 6;

const makeRow = rowFactory(CARO_RULE_VERSION, "CARO");

export const COMPANY_TYPES = Object.freeze([
  ["UNSPECIFIED", "Not stated"],
  ["PRIVATE", "Private company"],
  ["PUBLIC", "Public company"],
  ["OPC", "One person company"],
  ["SECTION_8", "Company licensed under section 8"],
  ["BANKING_OR_INSURANCE", "Banking or insurance company"],
]);
export const YES_NO = Object.freeze([["UNSPECIFIED", "Not stated"], ["YES", "Yes"], ["NO", "No"]]);

export const AMOUNT_ROWS = Object.freeze([
  { key: "DEPRECIATION", label: "Depreciation and amortisation", help: "Charged in the year; added back to find a cash loss (clause (xvii)). Needed for both years.", signed: false },
  { key: "OTHER_NON_CASH", label: "Other non-cash items", help: "Impairment, loss on sale of assets and similar (a gain is negative). Optional; blank is read as nil.", signed: true },
  { key: "PAID_UP_CAPITAL", label: "Paid-up share capital", help: "At the year end. Optional; without it the Capital Account in the books is read as paid-up capital.", signed: false },
  { key: "HIGHEST_BORROWINGS", label: "Highest borrowings from banks and financial institutions", help: "At any time in the year. Needed to exempt or require a company when the books' total borrowings are above the limit (the books do not separate banks and institutions).", signed: false },
  { key: "DEPOSITS", label: "Highest deposits outstanding", help: "Deposits accepted, at any time in the year. Optional; only a public company's internal audit test uses it.", signed: false },
]);
export { AMOUNT_COLUMNS };
const AMOUNT_LABEL = Object.freeze(Object.fromEntries(AMOUNT_ROWS.map((r) => [r.key, r.label])));

export const CHOICES = Object.freeze({
  APPLICABLE: choice("APPLICABLE", "The Order applies to this company"),
  NOT_APPLICABLE: choice("NOT_APPLICABLE", "The Order does not apply to this company", { needsNote: true }),
  REGULAR: choice("REGULAR", "Regular in depositing this due: nothing outstanding more than six months"),
  ARREARS: choice("ARREARS", "Arrears outstanding more than six months", { needsNote: true }),
  NO_DEFAULT: choice("NO_DEFAULT", "No default in repayment or interest on this borrowing"),
  DEFAULT: choice("DEFAULT", "Default: report lender, amount and period", { needsNote: true }),
  AUDIT_SYSTEM_OK: choice("AUDIT_SYSTEM_OK", "Internal audit system is commensurate and its reports were considered"),
  AUDIT_SYSTEM_NOT_OK: choice("AUDIT_SYSTEM_NOT_OK", "Internal audit system is not commensurate, or its reports were not considered", { needsNote: true }),
  AUDIT_NOT_REQUIRED: choice("AUDIT_NOT_REQUIRED", "Internal audit is not required for this company", { needsNote: true }),
  NO_CASH_LOSS: choice("NO_CASH_LOSS", "No cash loss in either year"),
  CASH_LOSS: choice("CASH_LOSS", "Cash loss: report the amount for each year", { needsNote: true }),
  NO_MATERIAL_UNCERTAINTY: choice("NO_MATERIAL_UNCERTAINTY", "My conclusion: no material uncertainty exists", { needsNote: true }),
  MATERIAL_UNCERTAINTY: choice("MATERIAL_UNCERTAINTY", "My conclusion: a material uncertainty exists", { needsNote: true }),
});

// ─── three-valued answers: true, false, or null for "the figures given cannot say" ──────────────────────

const and = (...v) => (v.some((x) => x === false) ? false : v.every((x) => x === true) ? true : null);
const or = (...v) => (v.some((x) => x === true) ? true : v.every((x) => x === false) ? false : null);
const atMost = (value, limit) => (Number.isSafeInteger(value) ? value <= limit : null);
const atLeast = (value, limit) => (Number.isSafeInteger(value) ? value >= limit : null);

// ─── clause-specific movements, collected in the same pass as the year's measure ────────────────────────

const STATUTORY_NAME = /\b(gst|igst|cgst|sgst|utgst|tds|tcs|provident|pf|esi|esic|professional tax|labour welfare|income[- ]tax|advance tax|customs|excise|vat|cess)\b/i;
const LOAN_GROUPS = new Set(["LOANS_LIABILITY", "LOANS_SECURED", "LOANS_UNSECURED", "BANK_OD"]);

export function isStatutoryLedger(ledger) {
  if (ledger.standardGroup === "DUTIES_TAXES") return true;
  return ledger.standardGroup === "CURRENT_LIABILITIES" && STATUTORY_NAME.test(ledger.name || "");
}

/**
 * Collects, voucher by voucher, the entries on the statutory-dues ledgers (dated, for the first-in-first-out ageing)
 * and the movement on the borrowing ledgers. The year's own vouchers only.
 */
export function createCaroBook({ financialYear, ledgers }) {
  const index = indexLedgers(ledgers);
  const statutory = new Map();
  const loans = new Map();
  const keep = (map, ledger, init) => {
    const key = norm(ledger.name);
    if (!map.has(key)) map.set(key, { ledger, ...init() });
    return map.get(key);
  };
  return {
    add(voucher) {
      if (voucher.cancelled || voucher.optional || !voucher.date || !dateInYear(voucher.date, financialYear)) return;
      const entries = voucher.entries || [];
      if (entries.some((e) => !Number.isSafeInteger(e.amountMinor) || !index.has(norm(e.ledger)))) return; // the measure counts it as unreadable
      for (const entry of entries) {
        const ledger = index.get(norm(entry.ledger));
        if (isStatutoryLedger(ledger)) keep(statutory, ledger, () => ({ entries: [], vouchers: [] })).entries.push({ date: voucher.date, amountMinor: entry.amountMinor, order: voucher.alterId ?? 0, id: String(voucher._id ?? voucher.guid ?? "") });
        if (isStatutoryLedger(ledger)) {
          const held = statutory.get(norm(ledger.name));
          if (held.vouchers.length < 200) held.vouchers.push(voucher);
        }
        if (LOAN_GROUPS.has(ledger.standardGroup)) {
          const book = keep(loans, ledger, () => ({ additionsMinor: 0, repaymentsMinor: 0, vouchers: [] }));
          if (entry.amountMinor > 0) book.additionsMinor = sumMinor([book.additionsMinor, entry.amountMinor], "borrowings taken");
          else book.repaymentsMinor = sumMinor([book.repaymentsMinor, -entry.amountMinor], "borrowings repaid");
          if (book.vouchers.length < 200) book.vouchers.push(voucher);
        }
      }
    },
    finish: () => ({ statutory, loans }),
  };
}

/** yyyy-mm-dd plus n calendar months (the day clamped to the month's length), UTC. */
export function addMonths(day, months) {
  const [y, m, d] = day.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

/**
 * Ages a statutory dues ledger first-in-first-out. What stands in the opening balance became payable before the
 * year began, so it is more than six months old at the year end. Each credit in the year becomes payable
 * DUE_LAG_DAYS later; a payment settles the oldest first; a payment ahead of any due is held to settle the next.
 * Returns { closingMinor, arrearsMinor, oldestPayableDay, prepaidMinor }.
 */
export function ageStatutory({ openingMinor, entries, yearEndDay }) {
  const opening = Number.isSafeInteger(openingMinor) ? openingMinor : 0;
  const buckets = [];
  let prepaid = 0;
  if (opening > 0) buckets.push({ payableDay: null, amountMinor: opening });
  else if (opening < 0) prepaid = -opening;
  const ordered = [...entries].sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order || a.id.localeCompare(b.id));
  const pay = (amount) => {
    let left = amount;
    while (left > 0 && buckets.length) {
      const take = Math.min(left, buckets[0].amountMinor);
      buckets[0].amountMinor -= take;
      left -= take;
      if (buckets[0].amountMinor === 0) buckets.shift();
    }
    prepaid += left;
  };
  for (const entry of ordered) {
    if (entry.amountMinor > 0) {
      let credit = entry.amountMinor;
      const absorbed = Math.min(prepaid, credit);
      prepaid -= absorbed;
      credit -= absorbed;
      if (credit > 0) buckets.push({ payableDay: addDays(entry.date, DUE_LAG_DAYS), amountMinor: credit });
    } else if (entry.amountMinor < 0) {
      pay(-entry.amountMinor);
    }
  }
  const stale = (bucket) => bucket.payableDay === null || addMonths(bucket.payableDay, ARREARS_MONTHS) < yearEndDay;
  const standing = sumMinor(buckets.map((b) => b.amountMinor), "dues standing");
  const arrears = sumMinor(buckets.filter(stale).map((b) => b.amountMinor), "arrears");
  return {
    closingMinor: standing - prepaid,
    arrearsMinor: arrears,
    oldestPayableDay: buckets.find((b) => b.payableDay !== null)?.payableDay ?? null,
    prepaidMinor: prepaid,
  };
}

// ─── applicability (paragraph 1(2)) ─────────────────────────────────────────────────────────────────────

const YEAR_WORDS = { current: "this year", prior: "the previous year" };

/** The figures the tests below stand on, with where each came from. */
export function companyFacts({ current, prior, typed }) {
  const t = (key, column) => typed?.[key]?.[column];
  const paidUpTyped = t("PAID_UP_CAPITAL", "current");
  const priorPaidUpTyped = t("PAID_UP_CAPITAL", "prior");
  const paidUp = Number.isSafeInteger(paidUpTyped) ? paidUpTyped : current.capitalClosing;
  const priorPaidUp = Number.isSafeInteger(priorPaidUpTyped) ? priorPaidUpTyped : prior.capitalClosing;
  return {
    paidUp: { minor: paidUp, source: Number.isSafeInteger(paidUpTyped) ? "typed" : "books" },
    priorPaidUp: { minor: priorPaidUp, source: Number.isSafeInteger(priorPaidUpTyped) ? "typed" : "books" },
    capitalAndReserves: sumMinor([paidUp, current.reservesClosing, current.netProfit], "capital and reserves"),
    revenue: current.totalIncome,
    turnover: current.netSales,
    priorTurnover: prior.netSales,
    // The books' total borrowings are an upper bound for the bank and institution part.
    booksBorrowingsHigh: Math.max(current.debt, current.debtOpening),
    priorBooksBorrowingsHigh: Math.max(prior.debt, prior.debtOpening),
    bankBorrowingsHigh: t("HIGHEST_BORROWINGS", "current"),
    priorBankBorrowingsHigh: t("HIGHEST_BORROWINGS", "prior"),
    deposits: t("DEPOSITS", "current"),
    priorDeposits: t("DEPOSITS", "prior"),
  };
}

/** Is the highest bank and institution borrowing at most / at least the limit? true, false, or null when the books cannot say. */
function borrowingsAtMost(limit, typedHigh, booksHigh) {
  if (Number.isSafeInteger(typedHigh)) return typedHigh <= limit;
  return booksHigh <= limit ? true : null;
}
function borrowingsAtLeast(limit, typedHigh, booksHigh) {
  if (Number.isSafeInteger(typedHigh)) return typedHigh >= limit;
  return booksHigh < limit ? false : null;
}

/** Whether the Order applies. verdict: APPLICABLE | NOT_APPLICABLE | UNKNOWN, with the sentences that led to it. */
export function applicability({ facts, companyType, group }) {
  const because = [];
  const missing = [];
  const isPrivate = companyType === "PRIVATE" ? true : companyType === "UNSPECIFIED" ? null : false;
  const inGroup = group === "YES" ? true : group === "NO" ? false : null;
  if (companyType === "UNSPECIFIED") missing.push("the kind of company");
  if (isPrivate === true && inGroup === null) missing.push("whether it is a subsidiary or holding company of a public company");

  // An unstated kind could be any of them, so it cannot be ruled out by size.
  const excluded = companyType === "UNSPECIFIED" ? null : ["BANKING_OR_INSURANCE", "SECTION_8", "OPC"].includes(companyType);
  if (excluded === true) because.push(`A ${COMPANY_TYPES.find(([c]) => c === companyType)[1].toLowerCase()} is outside the Order (paragraph 1(2)).`);

  const small = and(isPrivate, inGroup === null ? null : !inGroup, atMost(facts.paidUp.minor, THRESHOLDS.SMALL_PAID_UP), atMost(facts.turnover, THRESHOLDS.SMALL_TURNOVER));
  if (small === true) because.push(`A small company is outside the Order: private, not a subsidiary or holding company of a public company, paid-up capital ${formatRupees(facts.paidUp.minor)} (${facts.paidUp.source}) not more than ${formatRupees(THRESHOLDS.SMALL_PAID_UP)} and turnover ${formatRupees(facts.turnover)} not more than ${formatRupees(THRESHOLDS.SMALL_TURNOVER)}.`);

  const borrowingsOk = borrowingsAtMost(THRESHOLDS.PRIVATE_BORROWINGS, facts.bankBorrowingsHigh, facts.booksBorrowingsHigh);
  const exempt = and(isPrivate, inGroup === null ? null : !inGroup, atMost(facts.capitalAndReserves, THRESHOLDS.PRIVATE_CAPITAL_AND_RESERVES), borrowingsOk, atMost(facts.revenue, THRESHOLDS.PRIVATE_REVENUE));
  if (exempt === true) because.push(`A small private company is outside the Order: paid-up capital and reserves ${formatRupees(facts.capitalAndReserves)} not more than ${formatRupees(THRESHOLDS.PRIVATE_CAPITAL_AND_RESERVES)}, borrowings from banks and institutions not above ${formatRupees(THRESHOLDS.PRIVATE_BORROWINGS)} at any time, and total revenue ${formatRupees(facts.revenue)} not more than ${formatRupees(THRESHOLDS.PRIVATE_REVENUE)} (paragraph 1(2)).`);
  if (isPrivate === true && borrowingsOk === null && inGroup === false) missing.push(`the highest borrowings from banks and financial institutions in the year (the books' total, ${formatRupees(facts.booksBorrowingsHigh)}, is above ${formatRupees(THRESHOLDS.PRIVATE_BORROWINGS)} and may include other lenders)`);

  const outside = or(excluded, small, exempt);
  if (outside === true) return { verdict: "NOT_APPLICABLE", because, missing: [] };
  if (outside === false) {
    because.push(isPrivate === false ? "A company of this kind is within the Order." : "On the figures given, no exclusion in paragraph 1(2) is met, so the Order applies.");
    return { verdict: "APPLICABLE", because, missing: [] };
  }
  return { verdict: "UNKNOWN", because, missing: [...new Set(missing)] };
}

/** Whether section 138 and Rule 13 require an internal audit, on the preceding year's figures. */
export function internalAuditRequired({ facts, companyType, listed }) {
  const because = [];
  const missing = [];
  if (listed === "YES") return { verdict: "REQUIRED", because: ["A listed company must have an internal audit (Rule 13)."], missing };
  if (companyType === "UNSPECIFIED") missing.push("the kind of company");
  const borrowings = borrowingsAtLeast(THRESHOLDS.INTERNAL_AUDIT_BORROWINGS, facts.priorBankBorrowingsHigh, facts.priorBooksBorrowingsHigh);
  const turnover = atLeast(facts.priorTurnover, THRESHOLDS.INTERNAL_AUDIT_TURNOVER);
  if (borrowings === null) missing.push(`the highest borrowings from banks and financial institutions in the previous year (the books' total, ${formatRupees(facts.priorBooksBorrowingsHigh)}, is at or above ${formatRupees(THRESHOLDS.INTERNAL_AUDIT_BORROWINGS)} and may include other lenders)`);
  let required;
  if (companyType === "PUBLIC") {
    const paidUp = atLeast(facts.priorPaidUp.minor, THRESHOLDS.INTERNAL_AUDIT_PAID_UP);
    const deposits = Number.isSafeInteger(facts.priorDeposits) ? facts.priorDeposits >= THRESHOLDS.INTERNAL_AUDIT_DEPOSITS : facts.priorBooksBorrowingsHigh < THRESHOLDS.INTERNAL_AUDIT_DEPOSITS ? false : null;
    if (deposits === null) missing.push("the highest deposits outstanding in the previous year");
    required = or(paidUp, turnover, borrowings, deposits);
    // A listed public company needs an internal audit whatever the thresholds say, so "not required" is only safe once it is known not to be listed.
    if (required === false && listed === "UNSPECIFIED") {
      required = null;
      missing.push("whether the company is listed");
    }
  } else if (companyType === "PRIVATE") {
    required = or(turnover, borrowings);
  } else {
    required = companyType === "UNSPECIFIED" ? null : false;
    if (required === false) because.push("Rule 13 names listed companies, unlisted public companies and private companies; this kind of company is not among them.");
  }
  if (required === true) return { verdict: "REQUIRED", because: [`On the previous year's figures a threshold in Rule 13 is met (turnover ${formatRupees(facts.priorTurnover)}, paid-up capital ${formatRupees(facts.priorPaidUp.minor)} (${facts.priorPaidUp.source}), borrowings in the books up to ${formatRupees(facts.priorBooksBorrowingsHigh)}).`], missing: [] };
  if (required === false) return { verdict: "NOT_REQUIRED", because: [...because, `On the previous year's figures no threshold in Rule 13 is met (turnover ${formatRupees(facts.priorTurnover)}, paid-up capital ${formatRupees(facts.priorPaidUp.minor)} (${facts.priorPaidUp.source}), borrowings in the books up to ${formatRupees(facts.priorBooksBorrowingsHigh)}).`], missing: [] };
  return { verdict: "UNKNOWN", because, missing: [...new Set(missing)] };
}

/** Cash profit = net profit + depreciation + other non-cash items, for one year; null when a required amount was not typed. */
export function cashProfit({ measure, typed, column }) {
  const dep = typed?.DEPRECIATION?.[column];
  if (!Number.isSafeInteger(dep)) return { profitMinor: null, missing: [AMOUNT_LABEL.DEPRECIATION], netProfit: measure.netProfit, depreciation: null, otherNonCash: null };
  const other = typed?.OTHER_NON_CASH?.[column];
  const otherMinor = Number.isSafeInteger(other) ? other : 0;
  return { profitMinor: sumMinor([measure.netProfit, dep, otherMinor], "cash profit"), missing: [], netProfit: measure.netProfit, depreciation: dep, otherNonCash: Number.isSafeInteger(other) ? other : null };
}

// ─── rows ──────────────────────────────────────────────────────────────────

const money = (label, value) => ({ label, value, kind: "money" });
const text = (label, value) => ({ label, value, kind: "text" });
const LIMIT = 2_000;

/**
 * @param {object} input
 * @param {string} input.financialYear
 * @param {string} input.snapshotId
 * @param {string} input.priorFinancialYear
 * @param {object} input.current    createMeasure(...).finish() for this year
 * @param {object} input.prior      the same for the year before
 * @param {{statutory:Map,loans:Map}} input.book   createCaroBook(...).finish() for this year
 * @param {string} input.companyType
 * @param {string} input.group      "YES" | "NO" | "UNSPECIFIED": subsidiary or holding company of a public company
 * @param {string} input.listed
 * @param {Object<string,Object<string,number>>} [input.amounts]
 */
export function buildCaroRows({ financialYear, snapshotId, priorFinancialYear, current, prior, book, companyType = "UNSPECIFIED", group = "UNSPECIFIED", listed = "UNSPECIFIED", amounts = {} }) {
  const rows = [];
  const bounds = financialYearBounds(financialYear);
  const yearEndDay = addDays(bounds.endDayExclusive, -1);
  const facts = companyFacts({ current, prior, typed: amounts });
  const anyLedger = (measure) => measure.ledgers.slice(0, 1).map((l) => ledgerSource(snapshotId, l));

  // ── applicability
  const verdict = applicability({ facts, companyType, group });
  rows.push(makeRow({
    section: "APPLICABILITY",
    identity: "applicability",
    label: "Does the Order apply to this company?",
    values: {
      clause: "1(2)",
      verdict: verdict.verdict,
      companyType,
      group,
      paidUpMinor: facts.paidUp.minor,
      paidUpSource: facts.paidUp.source,
      capitalAndReservesMinor: facts.capitalAndReserves,
      revenueMinor: facts.revenue,
      turnoverMinor: facts.turnover,
      booksBorrowingsHighMinor: facts.booksBorrowingsHigh,
      amountMinor: null,
      lines: [
        text("What the thresholds give", verdict.verdict === "APPLICABLE" ? "The Order applies" : verdict.verdict === "NOT_APPLICABLE" ? "The Order does not apply" : "Cannot be told from the figures given"),
        text("Kind of company", COMPANY_TYPES.find(([c]) => c === companyType)?.[1] || companyType),
        money(`Paid-up capital (${facts.paidUp.source})`, facts.paidUp.minor),
        money("Paid-up capital and reserves and surplus", facts.capitalAndReserves),
        money("Total revenue (Schedule III, with other income)", facts.revenue),
        money("Turnover (net sales)", facts.turnover),
        money("Total borrowings in the books, at their highest of the year's two ends", facts.booksBorrowingsHigh),
      ],
      choices: [CHOICES.APPLICABLE, CHOICES.NOT_APPLICABLE],
    },
    ruleHits: [
      ...verdict.because.map((detail) => hit("APPLICABILITY", detail)),
      ...(verdict.missing.length ? [hit("APPLICABILITY_UNKNOWN", `The thresholds cannot give an answer because they need: ${verdict.missing.join("; ")}. Your answer decides; or create the pack again with them.`)] : []),
      hit("THRESHOLDS", `Paragraph 1(2): private company within ${formatRupees(THRESHOLDS.PRIVATE_CAPITAL_AND_RESERVES)} capital and reserves, ${formatRupees(THRESHOLDS.PRIVATE_BORROWINGS)} borrowings and ${formatRupees(THRESHOLDS.PRIVATE_REVENUE)} revenue; small company within ${formatRupees(THRESHOLDS.SMALL_PAID_UP)} paid-up capital and ${formatRupees(THRESHOLDS.SMALL_TURNOVER)} turnover. A company governed by a special Act is outside the small-company definition; the books do not say.`),
    ],
    state: "COMPUTED",
    sources: anyLedger(current),
  }));

  // ── (vii)(a) statutory dues
  // Every statutory ledger, not only those with entries: a balance brought forward and never paid is the clearest arrear.
  const statutory = current.ledgers
    .filter(isStatutoryLedger)
    .map((ledger) => book.statutory.get(norm(ledger.name)) || { ledger, entries: [], vouchers: [] })
    .sort((a, b) => norm(a.ledger.name).localeCompare(norm(b.ledger.name)));
  for (const item of statutory.slice(0, LIMIT)) {
    const aged = ageStatutory({ openingMinor: item.ledger.openingMinor, entries: item.entries, yearEndDay });
    if (aged.closingMinor === 0 && aged.arrearsMinor === 0 && item.entries.length === 0) continue;
    rows.push(makeRow({
      section: "CLAUSES",
      identity: `vii-a|${norm(item.ledger.name)}`,
      label: `Clause (vii)(a): ${item.ledger.name}`,
      values: {
        clause: "(vii)(a)",
        ledger: item.ledger.name,
        closingMinor: aged.closingMinor,
        arrearsMinor: aged.arrearsMinor,
        prepaidMinor: aged.prepaidMinor,
        oldestPayableDay: aged.oldestPayableDay,
        amountMinor: aged.arrearsMinor,
        lines: [
          money("Standing at the year end", aged.closingMinor),
          money(`Outstanding more than ${ARREARS_MONTHS} months after it became payable`, aged.arrearsMinor),
          ...(aged.oldestPayableDay ? [text("Oldest due in the year became payable", aged.oldestPayableDay)] : []),
          ...(aged.prepaidMinor ? [money("Paid ahead of any due", aged.prepaidMinor)] : []),
        ],
        choices: [CHOICES.REGULAR, CHOICES.ARREARS],
      },
      ruleHits: [
        hit("DUES_AGEING", `Payments settle the oldest due first. A credit in the year is read as payable ${DUE_LAG_DAYS} days after its date (the due date is not in the books); what stood in the opening balance became payable before the year began. A due is in arrears if ${ARREARS_MONTHS} months have passed since it became payable by ${yearEndDay}. Whether a due is undisputed, and the extent of arrears, are your answers.`),
        ...(item.ledger.standardGroup === "DUTIES_TAXES" ? [] : [hit("READ_AS_STATUTORY", "This ledger is not under Duties & Taxes; it is read as a statutory due because of its name.")]),
      ],
      state: "COMPUTED",
      sources: [ledgerSource(snapshotId, item.ledger), ...item.vouchers.map((v) => voucherSource(snapshotId, v))],
    }));
  }

  // ── (ix)(a) borrowings
  const loans = current.ledgers
    .filter((ledger) => LOAN_GROUPS.has(ledger.standardGroup))
    .map((ledger) => book.loans.get(norm(ledger.name)) || { ledger, additionsMinor: 0, repaymentsMinor: 0, vouchers: [] })
    .sort((a, b) => norm(a.ledger.name).localeCompare(norm(b.ledger.name)));
  for (const item of loans.slice(0, LIMIT)) {
    const opening = Number.isSafeInteger(item.ledger.openingMinor) ? item.ledger.openingMinor : 0;
    const closing = sumMinor([opening, item.additionsMinor, -item.repaymentsMinor], "borrowing");
    if (closing === 0 && opening === 0 && item.additionsMinor === 0 && item.repaymentsMinor === 0) continue;
    rows.push(makeRow({
      section: "CLAUSES",
      identity: `ix-a|${norm(item.ledger.name)}`,
      label: `Clause (ix)(a): ${item.ledger.name}`,
      values: {
        clause: "(ix)(a)",
        ledger: item.ledger.name,
        group: item.ledger.standardGroup,
        openingMinor: opening,
        additionsMinor: item.additionsMinor,
        repaymentsMinor: item.repaymentsMinor,
        closingMinor: closing,
        amountMinor: null,
        lines: [
          money("Owed at the start of the year", opening),
          money("Taken in the year", item.additionsMinor),
          money("Repaid in the year", item.repaymentsMinor),
          money("Owed at the year end", closing),
          text("Kind of borrowing", STANDARD_GROUPS[item.ledger.standardGroup].label),
        ],
        choices: [CHOICES.NO_DEFAULT, CHOICES.DEFAULT],
      },
      ruleHits: [hit("NO_SCHEDULE_IN_BOOKS", "The books carry no repayment schedule, so a default cannot be read from them: the movement is shown and the answer is yours. If there was a default, the clause asks for the lender, the amount and the period of default.")],
      state: "COMPUTED",
      sources: [ledgerSource(snapshotId, item.ledger), ...item.vouchers.map((v) => voucherSource(snapshotId, v))],
    }));
  }

  // ── (xiv) internal audit
  const audit = internalAuditRequired({ facts, companyType, listed });
  rows.push(makeRow({
    section: "CLAUSES",
    identity: "xiv",
    label: "Clause (xiv): internal audit system",
    values: {
      clause: "(xiv)",
      verdict: audit.verdict,
      amountMinor: null,
      lines: [
        text("Section 138 and Rule 13 require an internal audit", audit.verdict === "REQUIRED" ? "Yes, on the previous year's figures" : audit.verdict === "NOT_REQUIRED" ? "No, on the previous year's figures" : "Cannot be told from the figures given"),
        money(`Turnover, ${YEAR_WORDS.prior}`, facts.priorTurnover),
        money(`Paid-up capital, ${YEAR_WORDS.prior} (${facts.priorPaidUp.source})`, facts.priorPaidUp.minor),
        money(`Total borrowings in the books at their highest of ${YEAR_WORDS.prior}'s two ends`, facts.priorBooksBorrowingsHigh),
      ],
      choices: [CHOICES.AUDIT_SYSTEM_OK, CHOICES.AUDIT_SYSTEM_NOT_OK, CHOICES.AUDIT_NOT_REQUIRED],
    },
    ruleHits: [
      ...audit.because.map((detail) => hit("INTERNAL_AUDIT_REQUIRED", detail)),
      ...(audit.missing.length ? [hit("INTERNAL_AUDIT_UNKNOWN", `The thresholds cannot give an answer because they need: ${audit.missing.join("; ")}. Your answer decides.`)] : []),
      hit("THRESHOLDS", `Rule 13: a listed company; an unlisted public company with paid-up capital of ${formatRupees(THRESHOLDS.INTERNAL_AUDIT_PAID_UP)} or more, turnover of ${formatRupees(THRESHOLDS.INTERNAL_AUDIT_TURNOVER)} or more, borrowings from banks and public financial institutions of ${formatRupees(THRESHOLDS.INTERNAL_AUDIT_BORROWINGS)} or more at any time, or deposits of ${formatRupees(THRESHOLDS.INTERNAL_AUDIT_DEPOSITS)} or more at any time; a private company with turnover of ${formatRupees(THRESHOLDS.INTERNAL_AUDIT_TURNOVER)} or more or those borrowings of ${formatRupees(THRESHOLDS.INTERNAL_AUDIT_BORROWINGS)} or more, in the preceding year. Whether the system is commensurate and its reports were considered is not in the books.`),
    ],
    state: "COMPUTED",
    sources: anyLedger(current),
  }));

  // ── (xvii) cash losses
  const now = cashProfit({ measure: current, typed: amounts, column: "current" });
  const before = cashProfit({ measure: prior, typed: amounts, column: "prior" });
  const missingCash = [...(now.missing.length ? [`${AMOUNT_LABEL.DEPRECIATION} for ${YEAR_WORDS.current}`] : []), ...(before.missing.length ? [`${AMOUNT_LABEL.DEPRECIATION} for ${YEAR_WORDS.prior}`] : [])];
  const lossNow = now.profitMinor === null ? null : now.profitMinor < 0;
  const lossBefore = before.profitMinor === null ? null : before.profitMinor < 0;
  rows.push(makeRow({
    section: "CLAUSES",
    identity: "xvii",
    label: "Clause (xvii): cash losses",
    values: {
      clause: "(xvii)",
      cashProfitMinor: now.profitMinor,
      priorCashProfitMinor: before.profitMinor,
      cashLoss: lossNow,
      priorCashLoss: lossBefore,
      amountMinor: null,
      lines: [
        money(`Net profit, ${YEAR_WORDS.current}`, current.netProfit),
        money(`Depreciation and amortisation, ${YEAR_WORDS.current}`, now.depreciation),
        money(`Cash profit, ${YEAR_WORDS.current}`, now.profitMinor),
        money(`Net profit, ${YEAR_WORDS.prior}`, prior.netProfit),
        money(`Depreciation and amortisation, ${YEAR_WORDS.prior}`, before.depreciation),
        money(`Cash profit, ${YEAR_WORDS.prior}`, before.profitMinor),
      ],
      choices: missingCash.length ? [] : lossNow || lossBefore ? [CHOICES.CASH_LOSS] : [CHOICES.NO_CASH_LOSS],
    },
    ruleHits: [
      hit("CASH_LOSS", "A cash loss is a loss after adding back depreciation, amortisation and other non-cash items to the net result. The clause asks about this year and the year before and, if there is one, its amount."),
      ...(missingCash.length ? [hit("INPUT_MISSING", `Type ${missingCash.join(" and ")} to work this out. Create the pack again with the amounts, or exclude the row with a reason.`)] : []),
      ...(now.otherNonCash === null && !missingCash.length ? [hit("INPUT_READ_AS_NIL", `${AMOUNT_LABEL.OTHER_NON_CASH} was not typed for ${YEAR_WORDS.current} and is read as nil.`)] : []),
    ],
    state: missingCash.length ? "PENDING_INPUT" : "COMPUTED",
    sources: anyLedger(current),
  }));

  // ── (xix) material uncertainty: the indicators, never the conclusion
  const currentRatio = evaluateRatio(SPECS_BY_CODE.CURRENT_RATIO, current, amounts, "current");
  const currentRatioBefore = evaluateRatio(SPECS_BY_CODE.CURRENT_RATIO, prior, amounts, "prior");
  const shown = (e, unit) => (e.status === "OK" ? formatRatio(e.valueBp, unit) : e.status === "NOT_APPLICABLE" ? "Not applicable" : "Not available");
  const workingCapital = sumMinor([current.currentAssets, -current.currentLiabilities], "working capital");
  rows.push(makeRow({
    section: "CLAUSES",
    identity: "xix",
    label: "Clause (xix): material uncertainty on meeting liabilities within a year",
    values: {
      clause: "(xix)",
      currentRatioBp: currentRatio.status === "OK" ? currentRatio.valueBp : null,
      priorCurrentRatioBp: currentRatioBefore.status === "OK" ? currentRatioBefore.valueBp : null,
      workingCapitalMinor: workingCapital,
      cashProfitMinor: now.profitMinor,
      debtMinor: current.debt,
      amountMinor: null,
      lines: [
        text(`Current ratio, ${YEAR_WORDS.current}`, shown(currentRatio, "TIMES")),
        text(`Current ratio, ${YEAR_WORDS.prior}`, shown(currentRatioBefore, "TIMES")),
        money("Working capital at the year end", workingCapital),
        money("Net profit for the year", current.netProfit),
        money("Cash profit for the year", now.profitMinor),
        money("Total borrowings at the year end", current.debt),
      ],
      choices: [CHOICES.NO_MATERIAL_UNCERTAINTY, CHOICES.MATERIAL_UNCERTAINTY],
    },
    ruleHits: [
      hit("OPINION_IS_YOURS", "The clause asks for the auditor's opinion, on the ratios, ageing and expected dates of realisation and payment, other information, and the board's plans, whether a material uncertainty exists. The books give the indicators above; they do not give the expected dates or the plans, and no figure here concludes. A draft narrative can be asked for; it describes the indicators and does not choose the answer."),
    ],
    state: "COMPUTED",
    sources: anyLedger(current),
  }));

  // ── gaps shared with every pack that reads a year's books
  const unmapped = current.ledgers.filter((l) => !l.standardGroup);
  if (unmapped.length) {
    rows.push(makeRow({
      section: "INPUT_GAPS",
      identity: "unmapped-groups",
      label: `${unmapped.length} ledger(s) sit under a group that is not mapped yet`,
      values: { count: unmapped.length, amountMinor: null, lines: [text("Ledgers whose group is not read", String(unmapped.length))], choices: [] },
      ruleHits: [hit("GROUPS_NOT_MAPPED", `${unmapped.length} ledger(s) are under a Tally group that is not read as a standard group yet, so their balances are in no figure here. Map the groups under Tally books and create the pack again.`)],
      state: "PENDING_INPUT",
      derived: true,
    }));
  }
  for (const [measure, year] of [[current, financialYear], [prior, priorFinancialYear]]) {
    if (measure.unreadable) {
      rows.push(makeRow({
        section: "INPUT_GAPS",
        identity: `unreadable-vouchers|${year}`,
        label: `FY ${year}: ${measure.unreadable} voucher(s) could not be read`,
        values: { count: measure.unreadable, amountMinor: null, lines: [text("Vouchers not read", String(measure.unreadable))], choices: [] },
        ruleHits: [hit("UNREADABLE_VOUCHERS", `${measure.unreadable} voucher(s) in the FY ${year} books have no readable date, an amount that could not be read, or a ledger that is not in the masters. They are in no figure, so what the clauses show may be wrong.`)],
        state: "PENDING_INPUT",
        derived: true,
      }));
    }
  }
  return { rows };
}
