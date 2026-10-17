// src/services/audit-pack-engine/clause26.engine.js
//
// W10 AP24 (2026-10-17). Form 3CD clause 26 with section 43B(a)-(d), and clause 20(b): statutory dues
// outstanding at the year end - provident fund, ESI, tax, duty, cess or fee - found in the day book, one
// finding per dues ledger, each with the vouchers behind it.
//
// THE RULE (Income-tax Act 1961, section 43B clauses (a) to (d), as they apply to FY 2025-26): a
// contribution to a provident fund or ESI, a tax, duty, cess or fee by whatever name called, and the
// interest on any of them, is deductible only in the year it is actually paid. Clause 26 of Form 3CD asks
// for the sums still payable at 31 March and what was carried into the next year on the date the return is
// due under section 139(1); the proviso to section 43B keeps a due deductible in the year of accrual when
// it is paid before that date.
//
// WHAT IT DOES. A dues ledger is found by its name (provident fund, ESI, professional tax, GST, TDS, income
// tax patterns, in that order) or, when no name matches, by sitting in the Duties-and-Taxes group; the rule
// that matched is on every row. Its closing balance at 31 March is its opening balance plus the year's
// credits (accrued) less the year's debits (paid) - Tally's sign, a credit being money owed. A credit
// balance is a due outstanding; a debit balance is an advance and says so. For provident fund and ESI
// ledgers the month-wise story clause 26 wants is worked out too: each month's contribution is due by the
// 15th of the following month, and payments are applied to the months in order (the books do not say which
// month a challan settles, so the order is stated on every month row).
//
// WHAT IT DOES NOT DO. Payments between 1 April and the return's due date are next-year vouchers or the
// bank statement, and a day book of the year has neither. Until they are supplied (as a typed list with
// dates, from the bank statement), what each due came to on the return's due date is UNKNOWN: the row says
// so, a pending input blocks the pack, and nothing anywhere reads as "not paid". It does not decide the
// section 43B proviso - whether a due was paid before the return was due is offered as the person's answer.
// A ledger whose opening balance the export left out is read as nil and says so, because a nil opening can
// understate the closing balance.
//
// PURE: the same inputs always give the same rows in the same order.

import { choice, hit, rowFactory } from "../audit-pack-kinds/kit.js";
import { formatRupees } from "./clause21d.engine.js";
import { dateInYear, daysBetween, hasUnreadableAmount, indexLedgers, norm, voucherSource } from "./voucher-kit.js";

export const CLAUSE26_RULE_VERSION = "clause26-v1";

const makeRow = rowFactory(CLAUSE26_RULE_VERSION, "Clause 26");

export const CHOICES = Object.freeze({
  REPORT: choice("REPORT", "Report it: payable at 31 March under section 43B(a) to (d)"),
  PAID_BEFORE_RETURN: choice("PAID_BEFORE_RETURN", "It was in fact paid in full before the return was due under section 139(1), so the section 43B proviso keeps it deductible this year", { needsNote: true }),
  NOT_A_DUE: choice("NOT_A_DUE", "This ledger is not a statutory due (a party, a provision or a costing account)", { needsNote: true }),
  OTHER_EXPLAINED: choice("OTHER_EXPLAINED", "Another reason, given in the note", { needsNote: true }),
});
const DUES_CHOICES = Object.freeze(Object.values(CHOICES));

// Name rules, in order: the first that matches a ledger's name names the due. Versioned with the rule
// version, because moving an entry here moves which ledgers the clause reaches.
export const DUE_NAME_RULES = Object.freeze([
  ["PROVIDENT_FUND", /provident\s*fund|\bepf\b|\bpf\b/i],
  ["ESI", /employees?\s*state\s*insurance|\besi\b/i],
  ["PROFESSIONAL_TAX", /professional\s*tax|\blpt\b|\blbt\b|labour\s*welfare/i],
  ["GST", /goods\s*and\s*services\s*tax|\bgst\b/i],
  ["TDS", /tax\s*deducted\s*at\s*source|\btds\b/i],
  ["INCOME_TAX", /income\s*tax|advance\s*tax|minimum\s*alternate\s*tax/i],
]);

const DUE_WORDS = Object.freeze({
  PROVIDENT_FUND: "Provident fund (section 43B(a))",
  ESI: "Employees' state insurance (section 43B(b))",
  PROFESSIONAL_TAX: "Professional tax or labour welfare (section 43B(c))",
  GST: "GST, a duty or a cess (section 43B(c))",
  TDS: "Tax deducted at source (clause 20(b), section 43B(c))",
  INCOME_TAX: "Income tax, advance tax or MAT (section 43B(c))",
  DUTIES_TAXES_GROUP: "In the Duties-and-Taxes group (a statutory due by its group)",
});

const PF_ESI_RULES = new Set(["PROVIDENT_FUND", "ESI"]);

/** The day a provident fund or ESI contribution for month "YYYY-MM" fell due: the 15th of the next month. */
export function pfEsiDueDay(month) {
  const [y, m] = month.split("-").map(Number);
  const next = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
  return `${next.y}-${String(next.m).padStart(2, "0")}-15`;
}

/**
 * @param {object} input
 * @param {string} input.financialYear
 * @param {string} input.snapshotId
 * @param {object[]} input.ledgers                     snapshot ledgers with standardGroup resolved
 * @param {AsyncIterable<object>|Iterable<object>} input.vouchers   the day book, in any order
 * @param {{nextYearPayments?:{ledger:string,date:string,amountMinor:number}[], returnDueDay?:string}} [input.params]
 */
export async function buildClause26Rows({ financialYear, snapshotId, ledgers, vouchers, params = {} }) {
  const index = indexLedgers(ledgers);
  const nextYearPayments = Array.isArray(params.nextYearPayments) ? params.nextYearPayments : null;
  const returnDueDay = typeof params.returnDueDay === "string" && /^\d{4}-\d{2}-\d{2}$/.test(params.returnDueDay) ? params.returnDueDay : null;
  const nextYearLoaded = Boolean(nextYearPayments && returnDueDay);

  // Which ledgers the clause reaches, and the rule that reached each.
  const dueLedgers = [];
  for (const ledger of ledgers) {
    let rule = null;
    for (const [code, pattern] of DUE_NAME_RULES) {
      if (pattern.test(ledger.name)) { rule = code; break; }
    }
    if (!rule && ledger.standardGroup === "DUTIES_TAXES") rule = "DUTIES_TAXES_GROUP";
    if (!rule) continue;
    dueLedgers.push({ ledger, rule, byName: rule !== "DUTIES_TAXES_GROUP" });
  }
  const dueNames = new Set(dueLedgers.map((d) => norm(d.ledger.name)));

  const movements = new Map(dueNames.size ? [...dueNames].map((n) => [n, { credits: 0, debits: 0, creditsByMonth: new Map(), payments: [], sources: [] }]) : []);
  let unreadable = 0;

  for await (const voucher of vouchers) {
    if (voucher.cancelled || voucher.optional) continue;
    const entries = (voucher.entries || []).filter((e) => dueNames.has(norm(e.ledger)));
    if (entries.length === 0) continue;
    if (voucher.date && !dateInYear(voucher.date, financialYear)) continue;
    if (!voucher.date || hasUnreadableAmount(voucher)) { unreadable += 1; continue; }
    for (const entry of entries) {
      const record = movements.get(norm(entry.ledger));
      record.sources.push(voucher);
      if (entry.amountMinor > 0) {
        record.credits += entry.amountMinor;
        const month = voucher.date.slice(0, 7);
        record.creditsByMonth.set(month, (record.creditsByMonth.get(month) || 0) + entry.amountMinor);
      } else if (entry.amountMinor < 0) {
        record.debits += -entry.amountMinor;
        record.payments.push({ day: voucher.date, amountMinor: -entry.amountMinor, voucher });
      }
    }
  }

  const rows = [];

  // ─── clause 26: the dues outstanding at 31 March ─────────────────────────────
  const nextYearByLedger = new Map();
  if (nextYearPayments) {
    for (const payment of nextYearPayments) {
      // Only a payment dated on or before the return's due date keeps the due deductible for this year;
      // one after it does not, and stays out of this figure.
      if (returnDueDay && payment.date > returnDueDay) continue;
      nextYearByLedger.set(norm(payment.ledger), (nextYearByLedger.get(norm(payment.ledger)) || 0) + Math.abs(payment.amountMinor || 0));
    }
  }
  let nextYearUnknownRows = 0;

  const ledgerSource = (ledger) => ({ kind: "BOOKS_LEDGER", batchId: String(snapshotId), rowId: String(ledger._id), sourceRow: 0 });
  const sourcesOf = (record, ledger) => {
    const sources = record.sources.map((v) => voucherSource(snapshotId, v));
    // A due that exists only through its opening balance has no voucher behind it: the ledger master is
    // where that balance lives, so it stands as the evidence.
    return sources.length ? sources : [ledgerSource(ledger)];
  };

  const ordered = [...dueLedgers].sort((a, b) => norm(a.ledger.name).localeCompare(norm(b.ledger.name)));
  for (const { ledger, rule, byName } of ordered) {
    const record = movements.get(norm(ledger.name));
    const opening = Number.isSafeInteger(ledger.openingMinor) ? ledger.openingMinor : null;
    const closing = (opening ?? 0) + record.credits - record.debits;
    if (closing <= 0) {
      // Nothing payable: an advance or squared up, worked out from the vouchers - not a finding, but the
      // month-wise story below still shows it.
      if (closing < 0) {
        rows.push(makeRow({
          section: "DUES_OUTSTANDING",
          identity: `advance|${norm(ledger.name)}`,
          label: `${ledger.name}: a debit balance, not a due`,
          values: { ledger: ledger.name, matchedRule: rule, closingMinor: closing, amountMinor: 0, lines: [
            { label: "Closing balance", value: closing, kind: "money" },
            { label: "What this is", value: "The ledger closed in debit (an advance or a recoverable), so nothing is payable under clause 26.", kind: "text" },
          ], choices: [CHOICES.NOT_A_DUE, CHOICES.OTHER_EXPLAINED] },
          ruleHits: [hit("DEBIT_BALANCE", `${ledger.name} closed the year ${formatRupees(-closing)} in debit. If this is really a statutory due, a debit balance means an advance - check the books.`)],
          state: "COMPUTED",
          sources: sourcesOf(record, ledger),
          derived: true,
        }));
      }
      continue;
    }

    const paidByReturnDay = nextYearLoaded ? (nextYearByLedger.get(norm(ledger.name)) || 0) : null;
    const carriedForward = nextYearLoaded ? closing - paidByReturnDay : null;
    const nextYearUnknown = !nextYearLoaded;
    if (nextYearUnknown) nextYearUnknownRows += 1;

    const ruleHits = [
      hit("DUE_OUTSTANDING", `${ledger.name} closed ${financialYear} owing ${formatRupees(closing)} (${DUE_WORDS[rule]}). Section 43B allows it only in the year it is paid.`, closing),
      hit("MATCHED_BY", byName && ledger.standardGroup !== "DUTIES_TAXES"
        ? `Recognised as a statutory due by its name (rule ${rule}), though its group is ${ledger.standardGroup || "not set"}. If it is a party or a provision, exclude it with a note.`
        : `Recognised by ${byName ? `its name (rule ${rule})` : "the Duties-and-Taxes group"}.`),
    ];
    if (opening === null) ruleHits.push(hit("OPENING_NOT_GIVEN", "The export gives no opening balance for this ledger (Tally leaves the tag out when it is nil), so it is read as nil. If it was not nil, the amount outstanding is understated."));
    if (nextYearUnknown) ruleHits.push(hit("NEXT_YEAR_NOT_LOADED", `Payments between 1 April and the return's due date under section 139(1) are next-year vouchers or the bank statement, and neither is loaded. What this due came to on that date is UNKNOWN - it is not shown as not paid. Load them (typed from the bank statement) and run the pack again, or answer below.`));

    rows.push(makeRow({
      section: "DUES_OUTSTANDING",
      identity: `due|${norm(ledger.name)}`,
      label: `${ledger.name}: payable at 31 March`,
      values: {
        ledger: ledger.name,
        matchedRule: rule,
        openingMinor: opening,
        accruedMinor: record.credits,
        paidInYearMinor: record.debits,
        closingMinor: closing,
        carriedForwardMinor: carriedForward,
        nextYearUnknown,
        returnDueDay: returnDueDay || "",
        amountMinor: closing,
        lines: [
          { label: "Nature of the due", value: DUE_WORDS[rule], kind: "text" },
          { label: "Opening balance", value: opening, kind: "money" },
          { label: "Accrued in the year", value: record.credits, kind: "money" },
          { label: "Paid in the year", value: record.debits, kind: "money" },
          { label: "Payable at 31 March", value: closing, kind: "money" },
          { label: nextYearUnknown ? "Paid after 31 March, before the return was due" : `Paid by ${returnDueDay}`, value: nextYearUnknown ? "Not loaded - unknown, never read as not paid" : paidByReturnDay, kind: nextYearUnknown ? "text" : "money" },
          { label: nextYearUnknown ? "Carried into the next year" : `Balance on ${returnDueDay}`, value: nextYearUnknown ? "Unknown until the next-year payments are loaded" : carriedForward, kind: nextYearUnknown ? "text" : "money" },
        ],
        choices: DUES_CHOICES,
      },
      ruleHits,
      state: "COMPUTED",
      sources: sourcesOf(record, ledger),
    }));
  }

  // ─── provident fund and ESI: the month-wise story ────────────────────────────
  for (const { ledger, rule } of ordered.filter((d) => PF_ESI_RULES.has(d.rule))) {
    const record = movements.get(norm(ledger.name));
    // Payments are applied to the months in order: the books do not say which month a challan settled.
    let purse = 0;
    let purseDay = null;
    const months = [...record.creditsByMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const payments = [...record.payments].sort((a, b) => a.day.localeCompare(b.day) || String(a.voucher.number).localeCompare(String(b.voucher.number)));
    const settled = months.map(([month, accrued]) => {
      const dueDay = pfEsiDueDay(month);
      let settledOn = null;
      let left = accrued;
      while (left > 0) {
        if (purse === 0) {
          const payment = payments.shift();
          if (!payment) break;
          purse = payment.amountMinor;
          purseDay = payment.day;
        }
        const take = Math.min(purse, left);
        purse -= take;
        left -= take;
        if (left === 0) settledOn = purseDay;
      }
      return { month, accrued, dueDay, settledOn };
    });
    for (const m of settled) {
      const late = Boolean(m.settledOn && m.settledOn > m.dueDay);
      const delayDays = late ? daysBetween(m.dueDay, m.settledOn) : 0;
      rows.push(makeRow({
        section: "PF_ESI_MONTHS",
        identity: `month|${norm(ledger.name)}|${m.month}`,
        label: `${ledger.name}: ${m.month}`,
        values: {
          ledger: ledger.name,
          matchedRule: rule,
          month: m.month,
          dueDay: m.dueDay,
          accruedMinor: m.accrued,
          settledOn: m.settledOn || "",
          delayDays,
          late,
          amountMinor: null,
          lines: [
            { label: "Contribution for", value: m.month, kind: "text" },
            { label: "Due by", value: m.dueDay, kind: "text" },
            { label: "Accrued", value: m.accrued, kind: "money" },
            { label: "Settled on", value: m.settledOn || "Not settled within the year", kind: "text" },
            { label: "Days after the 15th", value: m.settledOn ? delayDays : null, kind: "text" },
          ],
          choices: [],
        },
        ruleHits: [
          hit("MONTH_DUE_15TH", `The ${rule === "ESI" ? "ESI" : "provident fund"} contribution for ${m.month} was due by ${m.dueDay} and ${m.settledOn ? `the challan that settled it was ${m.settledOn}${late ? `, ${delayDays} day(s) late` : ", in time"}` : "it was not settled within the year"}.`),
          hit("FIFO_APPLIED", "Payments are applied to the months in order; the books do not say which month a challan settled. Check the EPFO/ESIC portal if the order was different."),
        ],
        state: "COMPUTED",
        sources: sourcesOf(record, ledger),
        derived: true,
      }));
    }
  }

  // ─── what could not be checked ───────────────────────────────────────────────
  if (dueLedgers.length === 0) {
    rows.push(makeRow({
      section: "INPUT_GAPS",
      identity: "gap:no-dues-ledgers",
      label: "No statutory-dues ledger was found",
      values: { amountMinor: null },
      ruleHits: [hit("NO_DUES_LEDGERS", "No ledger matches a statutory-dues name (provident fund, ESI, professional tax, GST, TDS, income tax) and none sits in the Duties-and-Taxes group, so clause 26 could not be checked. Map the groups, or confirm the client owes no statutory dues.")],
      state: "PENDING_INPUT",
      derived: true,
    }));
  }
  if (nextYearUnknownRows) {
    rows.push(makeRow({
      section: "INPUT_GAPS",
      identity: "gap:next-year-payments",
      label: "PENDING_INPUT: next-year payments not loaded",
      values: { amountMinor: null, count: nextYearUnknownRows },
      ruleHits: [hit("NEXT_YEAR_PAYMENTS_NOT_LOADED", `${nextYearUnknownRows} due ledger(s) have an amount payable at 31 March, and whether they were paid between 1 April and the return's due date under section 139(1) is not loaded. Nothing is shown as not paid. Type the payments from the bank statement (ledger, date, amount) and run the pack again, or answer on each row.`)],
      state: "PENDING_INPUT",
      derived: true,
    }));
  }
  if (unreadable) {
    rows.push(makeRow({
      section: "INPUT_GAPS",
      identity: "gap:unreadable-vouchers",
      label: `${unreadable} voucher(s) could not be read`,
      values: { amountMinor: null, count: unreadable },
      ruleHits: [hit("UNREADABLE_VOUCHERS", `${unreadable} voucher(s) that touch a statutory-dues ledger have a date or an amount the export did not give clearly. They are not counted.`)],
      state: "PENDING_INPUT",
      derived: true,
    }));
  }

  return { rows };
}
