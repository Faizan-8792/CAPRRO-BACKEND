// src/services/audit-pack-engine/clause34.engine.js
//
// W10 AP26 (2026-10-17). Form 3CD clause 34: tax deducted or collected at source and not deposited in
// time, with the interest section 201(1A)(ii) charges for the delay and the fee section 234E charges for a
// quarterly statement filed late - computed from the same imported TDS rows the TDS health check reads.
//
// THE RULE (Income-tax Act 1961, sections 200(3), 201(1A)(ii) and 234E, as they apply to FY 2025-26):
//   tax deducted in a month is to be deposited by the seventh day of the following month, except tax
//   deducted in March, for which the thirtieth day of April; a deductor eligible to deposit quarterly may
//   deposit by the end of the month following the quarter (the import does not say whether the client is
//   one, so the monthly rule is applied and every row says so). Interest under section 201(1A)(ii) runs at
//   one and a half per cent for every month or part of a month, from the day the tax was deducted to the
//   day it is deposited. A quarterly statement is due by the last day of the month following the quarter;
//   section 234E charges two hundred rupees for every day it is late, never more than the tax deductible
//   for the quarter.
//
// WHAT IT DOES. Deductions and challans are read per quarter. A challan settles the quarter's deductions
// in the order they were deducted - the books do not say which deduction a challan pays for, so the order
// is stated on every row. What was deposited after its due day, or not deposited at all, is clause 34(a)'s
// amount; the interest on it is computed month-wise in integer paise, and on anything still undeposited it
// runs to 31 March and keeps running. A statement's filing date is set against the quarter's due date and
// the fee is worked out day-wise, capped at the quarter's tax.
//
// WHAT IT DOES NOT DO. It does not know whether the client may deposit quarterly (an answer offered on
// each row); it does not compute section 201(1A)(i) interest for tax never deducted (the deduction register
// cannot see what should have been deducted); a statement recorded as filed but with no filing date gives
// no fee - unknown, never zero, and the row says so.
//
// PURE: the same inputs always give the same rows in the same order.

import { choice, hit, rowFactory } from "../audit-pack-kinds/kit.js";
import { formatRupees } from "./clause21d.engine.js";
import { daysBetween } from "./voucher-kit.js";

export const CLAUSE34_RULE_VERSION = "clause34-v1";

const makeRow = rowFactory(CLAUSE34_RULE_VERSION, "Clause 34");

// Statutory, so fixed by the rule version: 1.5% a month (three two-hundredths) and Rs 200 a day, in paise.
export const INTEREST_MONTH_NUMERATOR = 3n;
export const INTEREST_MONTH_DENOMINATOR = 200n;
export const FEE_PER_DAY_MINOR = 20_000;

export const QUARTER_STATEMENT_DUE = Object.freeze({ Q1: "07-31", Q2: "10-31", Q3: "01-31", Q4: "05-31" });

export const DEPOSIT_CHOICES = Object.freeze([
  choice("REPORT", "Report it: not deposited within the allowed time, with the section 201(1A)(ii) interest"),
  choice("QUARTERLY_DEPOSITOR", "The client deposits quarterly under the proviso, so the deposit was within the allowed time", { needsNote: true }),
  choice("REGULARISED", "The late deposit and its interest were regularised before the return was due", { needsNote: true }),
  choice("OTHER_EXPLAINED", "Another reason, given in the note", { needsNote: true }),
]);

export const STATEMENT_CHOICES = Object.freeze([
  choice("REPORT", "Report it: the statement was filed late, with the section 234E fee"),
  choice("FILED_IN_TIME", "It was in fact filed by the due date (or a correction regularised it)", { needsNote: true }),
  choice("FEE_KNOWN_ELSEWHERE", "It was filed late and the fee is known and paid - the figure is in the note", { needsNote: true }),
  choice("OTHER_EXPLAINED", "Another reason, given in the note", { needsNote: true }),
]);

/** The day a quarterly statement of FY "2025-26" fell due: the last day of the month after the quarter. */
export function statementDueDay(financialYear, quarter) {
  const startYear = Number(financialYear.slice(0, 4));
  if (quarter === "Q1") return `${startYear}-${QUARTER_STATEMENT_DUE.Q1}`;
  if (quarter === "Q2") return `${startYear}-${QUARTER_STATEMENT_DUE.Q2}`;
  if (quarter === "Q3") return `${startYear + 1}-${QUARTER_STATEMENT_DUE.Q3}`;
  if (quarter === "Q4") return `${startYear + 1}-${QUARTER_STATEMENT_DUE.Q4}`;
  return null;
}

/** The last day a deduction of the given day could be deposited: the 7th of the next month, or 30 April for March. */
export function depositDueDay(day) {
  const [y, m] = day.split("-").map(Number);
  if (m === 3) return `${y}-04-30`;
  return m === 12 ? `${y + 1}-01-07` : `${y}-${String(m + 1).padStart(2, "0")}-07`;
}

/** Months or part months between two days, the section's own unit: a part month counts as a whole one. */
export function monthsOrPart(fromDay, toDay) {
  const days = daysBetween(fromDay, toDay);
  if (days <= 0) return 0;
  return Math.ceil(days / 30);
}

/** Simple interest at 1.5% a month (or part) on an amount of paise, in integer paise. */
export function interest201aMinor(amountMinor, months) {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || !Number.isSafeInteger(months) || months <= 0) return 0;
  return Number((BigInt(amountMinor) * BigInt(months) * INTEREST_MONTH_NUMERATOR) / INTEREST_MONTH_DENOMINATOR);
}

const QUARTER_ORDER = Object.freeze(["Q1", "Q2", "Q3", "Q4"]);

/**
 * @param {object} input
 * @param {string} input.financialYear
 * @param {{quarter:string,transactionDate:string,deductedMinor:number,rowId?:string,batchId?:string,sourceRow?:number,sectionCode?:string,deducteeName?:string}[]} input.deductions
 * @param {{quarter:string,challanDate:string,depositedMinor:number,rowId?:string,batchId?:string,sourceRow?:number}[]} input.challans
 * @param {{quarter:string,filingStatus:string,filedDate:string,statementType?:string,rowId?:string,batchId?:string,sourceRow?:number}[]} input.statements
 * @param {string} input.yearEndDay   the day interest on the undeposited stops being computed (31 March)
 */
export function buildClause34Rows({ financialYear, deductions, challans, statements, yearEndDay }) {
  if (!/^\d{4}-\d{2}$/.test(String(financialYear || ""))) throw new RangeError("buildClause34Rows: the financial year must be like 2025-26");
  // Interest on what is not deposited is computed to the year end and marked as still running.
  const yearEndFinal = yearEndDay && /^\d{4}-\d{2}-\d{2}$/.test(yearEndDay) ? yearEndDay : `${Number(financialYear.slice(0, 4)) + 1}-03-31`;
  const source = (row, kind) => ({ kind: kind || "TDS_IMPORT", batchId: String(row.batchId || ""), rowId: String(row.rowId || row._id || ""), sourceRow: row.sourceRow ?? 0 });

  const rows = [];
  const gaps = [];

  const byQuarter = (list) => {
    const map = new Map(QUARTER_ORDER.map((q) => [q, []]));
    for (const row of list) if (map.has(row.quarter)) map.get(row.quarter).push(row);
    return map;
  };
  const deductionsByQuarter = byQuarter(deductions);
  const challansByQuarter = byQuarter(challans);
  const statementsByQuarter = byQuarter(statements);

  const yearEnd = yearEndFinal;
  let unreadableDates = 0;

  for (const quarter of QUARTER_ORDER) {
    const qDeductions = deductionsByQuarter.get(quarter);
    const qChallans = challansByQuarter.get(quarter);
    const qStatements = statementsByQuarter.get(quarter);

    // ─── clause 34(a) and section 201(1A)(ii): deposits ────────────────────────
    if (qDeductions.length) {
      const readable = qDeductions.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d.transactionDate || "")) && Number.isSafeInteger(d.deductedMinor));
      unreadableDates += qDeductions.length - readable.length;
      const ordered = [...readable].sort((a, b) => a.transactionDate.localeCompare(b.transactionDate) || String(a.rowId ?? "").localeCompare(String(b.rowId ?? "")));
      const purse = [...qChallans]
        .filter((c) => /^\d{4}-\d{2}-\d{2}$/.test(String(c.challanDate || "")) && Number.isSafeInteger(c.depositedMinor))
        .sort((a, b) => a.challanDate.localeCompare(b.challanDate) || String(a.rowId ?? "").localeCompare(String(b.rowId ?? "")));
      // A challan settles the quarter's deductions in deduction order; the books do not say which deduction
      // a challan pays for, so this order is stated on the row.
      let purseIndex = 0;
      let purseLeft = purse.length ? purse[0].depositedMinor : 0;
      let deductedTotal = 0;
      let inTimeMinor = 0;
      let lateDepositedMinor = 0;
      let lateDepositInterestMinor = 0;
      let undepositedMinor = 0;
      let runningInterestMinor = 0;
      for (const deduction of ordered) {
        deductedTotal += deduction.deductedMinor;
        let left = deduction.deductedMinor;
        while (left > 0) {
          if (purseLeft <= 0) {
            purseIndex += 1;
            purseLeft = purseIndex < purse.length ? purse[purseIndex].depositedMinor : 0;
            if (purseIndex >= purse.length) break;
          }
          const take = Math.min(purseLeft, left);
          const challan = purse[purseIndex];
          purseLeft -= take;
          left -= take;
          if (challan.challanDate <= depositDueDay(deduction.transactionDate)) inTimeMinor += take;
          else {
            lateDepositedMinor += take;
            lateDepositInterestMinor += interest201aMinor(take, monthsOrPart(deduction.transactionDate, challan.challanDate));
          }
        }
        if (left > 0) {
          undepositedMinor += left;
          runningInterestMinor += interest201aMinor(left, monthsOrPart(deduction.transactionDate, yearEndFinal));
        }
      }

      if (lateDepositedMinor > 0 || undepositedMinor > 0) {
        const interestMinor = lateDepositInterestMinor + runningInterestMinor;
        rows.push(makeRow({
          section: "DEPOSIT_TIMING",
          identity: `deposit|${quarter}`,
          label: `${quarter}: tax not deposited within the allowed time`,
          values: {
            quarter,
            deductedMinor: deductedTotal,
            inTimeMinor,
            lateDepositedMinor,
            undepositedMinor,
            lateDepositInterestMinor,
            runningInterestMinor,
            interestMinor,
            stillAccruing: undepositedMinor > 0,
            amountMinor: lateDepositedMinor + undepositedMinor,
            lines: [
              { label: "Tax deducted in the quarter", value: deductedTotal, kind: "money" },
              { label: "Deposited within the allowed time", value: inTimeMinor, kind: "money" },
              { label: "Deposited after the allowed time", value: lateDepositedMinor, kind: "money" },
              { label: "Not deposited at 31 March", value: undepositedMinor, kind: "money" },
              { label: "Interest section 201(1A)(ii), late deposits", value: lateDepositInterestMinor, kind: "money" },
              { label: "Interest on what is not deposited (runs on)", value: runningInterestMinor, kind: "money" },
            ],
            choices: DEPOSIT_CHOICES,
          },
          ruleHits: [
            hit("TDS_NOT_DEPOSITED_IN_TIME",
              `${formatRupees(lateDepositedMinor)} of ${quarter}'s tax was deposited after its due day and ${formatRupees(undepositedMinor)} was not deposited at 31 March. Section 201(1A)(ii) charges one and a half per cent a month or part: ${formatRupees(interestMinor)} in all${undepositedMinor > 0 ? `, of which ${formatRupees(runningInterestMinor)} is only to 31 March and it keeps running` : ""}.`,
              FEE_PER_DAY_MINOR),
            hit("DEPOSIT_DUE_DAYS", "The allowed time is the seventh day of the month after deduction, and 30 April for tax deducted in March. The import does not say whether the client may deposit quarterly; if it may, answer so on this row."),
            hit("FIFO_DEPOSITS", "Challans settle the quarter's deductions in deduction order; the books do not say which deduction a challan pays for."),
          ],
          state: "COMPUTED",
          sources: [...ordered.map((d) => source(d)), ...purse.map((c) => source(c))],
        }));
      }
    }

    // ─── clause 34(c): statements and the section 234E fee ─────────────────────
    if (qDeductions.length || qStatements.length) {
      const dueDay = statementDueDay(financialYear, quarter);
      // The 234E cap is the quarter's tax: the deduction register where it was imported, else what the
      // statement rows themselves report.
      const reportedMinor = qStatements.reduce((a, s) => a + (Number.isSafeInteger(s.reportedMinor) ? s.reportedMinor : 0), 0);
      const deductedMinorTotal = qDeductions.reduce((a, d) => a + (Number.isSafeInteger(d.deductedMinor) ? d.deductedMinor : 0), 0);
      const quarterTaxMinor = Math.max(reportedMinor, deductedMinorTotal);
      const filedDates = qStatements
        .filter((s) => ["FILED", "CORRECTED"].includes(s.filingStatus) && /^\d{4}-\d{2}-\d{2}$/.test(String(s.filedDate || "")))
        .map((s) => s.filedDate)
        .sort();
      const anyFiled = qStatements.some((s) => ["FILED", "CORRECTED"].includes(s.filingStatus));
      if (anyFiled && filedDates.length) {
        const filedOn = filedDates[0];
        if (filedOn > dueDay) {
          const days = daysBetween(dueDay, filedOn);
          const uncapped = days * FEE_PER_DAY_MINOR;
          const feeMinor = Math.min(uncapped, quarterTaxMinor);
          rows.push(makeRow({
            section: "STATEMENT_TIMING",
            identity: `statement|${quarter}`,
            label: `${quarter}: statement filed ${days} day(s) late`,
            values: {
              quarter,
              dueDay,
              filedOn,
              daysLate: days,
              quarterTaxMinor,
              feeMinor,
              feeCapped: uncapped > quarterTaxMinor,
              amountMinor: feeMinor,
              lines: [
                { label: "Statement due by", value: dueDay, kind: "text" },
                { label: "Earliest filing recorded", value: filedOn, kind: "text" },
                { label: "Days late", value: days, kind: "text" },
                { label: "Tax deductible for the quarter (the cap)", value: quarterTaxMinor, kind: "money" },
                { label: "Fee at Rs 200 a day", value: feeMinor, kind: "money" },
              ],
              choices: STATEMENT_CHOICES,
            },
            ruleHits: [
              hit("STATEMENT_FILED_LATE", `The ${quarter} statement was filed on ${filedOn}, ${days} day(s) after ${dueDay}. Section 234E charges ${formatRupees(FEE_PER_DAY_MINOR)} a day, capped at the quarter's tax: ${formatRupees(feeMinor)}${uncapped > quarterTaxMinor ? " (the cap binds)" : ""}.`, FEE_PER_DAY_MINOR),
              hit("EARLIEST_FILING_USED", qStatements.length > 1 ? `Several statement rows exist for ${quarter}; the earliest recorded filing (${filedOn}) is used.` : ""),
            ].filter((h) => h.detail),
            state: "COMPUTED",
            sources: qStatements.map((s) => source(s)),
          }));
        }
      } else if (anyFiled || qStatements.length) {
        // Filed (or partly recorded as filed) with no filing date, or recorded as not filed: the fee cannot
        // be known from what was imported. Unknown, never zero.
        rows.push(makeRow({
          section: "STATEMENT_TIMING",
          identity: `statement|${quarter}`,
          label: `${quarter}: the filing date is not known`,
          values: {
            quarter,
            dueDay,
            filedOn: "",
            daysLate: null,
            quarterTaxMinor,
            feeMinor: null,
            amountMinor: null,
            lines: [
              { label: "Statement due by", value: dueDay, kind: "text" },
              { label: "Filing recorded", value: anyFiled ? "Filed, but the filing date was not imported" : "Not recorded as filed", kind: "text" },
              { label: "Fee at Rs 200 a day", value: "Unknown - and it runs on while the statement is late", kind: "text" },
              { label: "Tax deductible for the quarter (the cap)", value: quarterTaxMinor, kind: "money" },
            ],
            choices: STATEMENT_CHOICES,
          },
          ruleHits: [
            hit("FILING_DATE_UNKNOWN", `The ${quarter} statement's filing date is not in the imported rows, so the section 234E fee is unknown - unknown, not nil. Import the filing date (or record the filing) and run the pack again, or answer below.`),
          ],
          state: "PENDING_INPUT",
          sources: qStatements.map((s) => source(s)),
        }));
      } else {
        gaps.push({ quarter, quarterTaxMinor });
      }
    }
  }

  // ─── what could not be checked ───────────────────────────────────────────────
  if (deductions.length === 0 && challans.length === 0 && statements.length === 0) {
    rows.push(makeRow({
      section: "INPUT_GAPS",
      identity: "gap:no-tds-rows",
      label: "No TDS rows were imported",
      values: { amountMinor: null },
      ruleHits: [hit("NO_TDS_ROWS", "No deduction, challan or statement row was imported for this year, so clause 34 could not be checked. Import the TDS registers, or confirm the client deducted nothing.")],
      state: "PENDING_INPUT",
      derived: true,
    }));
  }
  for (const gap of gaps) {
    rows.push(makeRow({
      section: "INPUT_GAPS",
      identity: `gap:no-statement|${gap.quarter}`,
      label: `${gap.quarter}: no statement row was imported`,
      values: { amountMinor: null, quarter: gap.quarter },
      ruleHits: [hit("NO_STATEMENT_ROW", `Tax was deducted in ${gap.quarter} but no quarterly statement row was imported, so the section 234E fee could not be checked for it. Import the statement status, or confirm it was filed.`)],
      state: "PENDING_INPUT",
      derived: true,
    }));
  }
  if (unreadableDates) {
    rows.push(makeRow({
      section: "INPUT_GAPS",
      identity: "gap:unreadable-deductions",
      label: `${unreadableDates} deduction row(s) could not be read`,
      values: { amountMinor: null, count: unreadableDates },
      ruleHits: [hit("UNREADABLE_DEDUCTIONS", `${unreadableDates} deduction row(s) have no readable date or amount. They are not counted.`)],
      state: "PENDING_INPUT",
      derived: true,
    }));
  }

  return { rows };
}
