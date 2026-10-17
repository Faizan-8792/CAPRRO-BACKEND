// src/services/audit-pack-engine/clause21d.engine.js
//
// W10 AP22 (2026-10-17). Form 3CD clause 21(d): amounts inadmissible under section 40A(3) - expenditure paid
// in cash above the limit - found in the client's day book, one finding per payee per day, each with the
// vouchers behind it.
//
// THE RULE (Income-tax Act 1961, section 40A(3) and Rule 6DD; the Act in force for FY 2025-26):
//   a payment, or the aggregate of payments, to one person in one day, above Rs 10,000 otherwise than by an
//   account payee cheque or draft, or an electronic mode through a bank account, is not deductible. The limit
//   is Rs 35,000 for a payment to a transporter for plying, hiring or leasing goods carriages. Rule 6DD lists
//   the cases where the rule does not apply (payments to a bank or the Government among them).
//
// WHAT IT DOES. A cash payment is a voucher that credits a ledger in the Cash-in-Hand group. The ledgers it
// debits are the payees; if the voucher is part cash and part bank, the cash is shared across the debited
// ledgers in proportion to their debits (the books do not say which part paid which, so this is stated on
// every row). Cash paid to one ledger in one day is added up and compared with the limit.
//
// WHAT IT DOES NOT DO. It does not decide whether a Rule 6DD exception applies, whether a payee is a
// transporter, or whether the payment was in fact by a banking channel: those are the person's answers, offered
// as choices with the hint the books suggest. A ledger whose group is not known, a voucher whose date or amount
// could not be read, are listed as inputs missing - never skipped. Section 40A(3A) (payment in a later year of
// an expense allowed earlier) is not computed.
//
// PURE: the same inputs always give the same rows in the same order.

import { choice, hit, rowFactory } from "../audit-pack-kinds/kit.js";
import {
  BANK_GROUPS,
  CASH_GROUPS,
  dateInYear,
  groupOf,
  hasUnreadableAmount,
  indexLedgers,
  norm,
  proportionalShares,
  sumMinor,
  voucherSource,
} from "./voucher-kit.js";

export const CLAUSE21D_RULE_VERSION = "clause21d-v1";

// Statutory, so fixed by the rule version and not a parameter: Rs 10,000 and Rs 35,000 in paise.
export const CASH_LIMIT_MINOR = 1_000_000;
export const TRANSPORTER_LIMIT_MINOR = 3_500_000;

const makeRow = rowFactory(CLAUSE21D_RULE_VERSION, "Clause 21(d)");

export function formatRupees(paise) {
  const negative = paise < 0;
  const abs = BigInt(Math.abs(paise));
  const rupees = String(abs / 100n);
  const fraction = String(abs % 100n).padStart(2, "0");
  const last3 = rupees.slice(-3);
  const rest = rupees.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}` : last3;
  return `${negative ? "-" : ""}₹${grouped}.${fraction}`;
}

export const CHOICES = Object.freeze({
  REPORT: choice("REPORT", "Report it: disallow under section 40A(3)"),
  EXCEPTION_6DD: choice("EXCEPTION_6DD", "An exception in Rule 6DD applies", { needsNote: true }),
  NOT_EXPENDITURE: choice("NOT_EXPENDITURE", "Not an expenditure (a loan, deposit, drawing, tax or similar)", { needsNote: true }),
  BANK_CHANNEL: choice("BANK_CHANNEL", "It was in fact paid through a banking channel", { needsNote: true }),
  OTHER_EXPLAINED: choice("OTHER_EXPLAINED", "Another reason, given in the note", { needsNote: true }),
});
const PAYMENT_CHOICES = Object.freeze(Object.values(CHOICES));

const EMPLOYEE_NAME = /\b(salary|salaries|wages|bonus|staff|stipend|gratuity)\b/;

function hintsFor(group, name) {
  const hints = [];
  if (group === "DUTIES_TAXES" || group === "BANK" || group === "BANK_OD") {
    hints.push(hit("HINT_GOVERNMENT_OR_BANK", "A payment to the Government or to a bank is among the cases Rule 6DD excepts. Check which applies before reporting."));
  }
  if (group === "LOANS_LIABILITY" || group === "LOANS_SECURED" || group === "LOANS_UNSECURED" || group === "BANK_OD") {
    hints.push(hit("HINT_LOAN_REPAYMENT", "A repayment of a loan is not an expenditure; cash repayments are checked under clause 31 (section 269T)."));
  }
  if (group === "FIXED_ASSETS") {
    hints.push(hit("HINT_CAPITAL", "Section 40A(3) reaches expenditure on which a deduction or depreciation is claimed, including a capital asset."));
  }
  if (group === "CAPITAL_ACCOUNT" || group === "RESERVES_SURPLUS") {
    hints.push(hit("HINT_DRAWINGS", "A withdrawal by the proprietor or a partner is not an expenditure."));
  }
  if (group === "SUNDRY_CREDITORS") {
    hints.push(hit("HINT_SETTLES_LIABILITY", "This settles a liability booked earlier; the expenditure itself was booked on an earlier voucher."));
  }
  if (EMPLOYEE_NAME.test(norm(name))) {
    hints.push(hit("HINT_EMPLOYEE", "The name reads like a payment to an employee. Rule 6DD has a case for salary paid where the employee has no bank facility; say if it applies."));
  }
  if (group === null) {
    hints.push(hit("HINT_GROUP_UNKNOWN", "This ledger's group is not known, so nothing can be suggested about it. Map its group."));
  }
  return hints;
}

/**
 * @param {object} input
 * @param {string} input.financialYear
 * @param {string} input.snapshotId
 * @param {object[]} input.ledgers            snapshot ledgers with standardGroup resolved (readSnapshotMasters)
 * @param {AsyncIterable<object>|Iterable<object>} input.vouchers   the day book, in any order
 * @param {{transporterLedgers?: string[]}} [input.params]
 */
export async function buildClause21dRows({ financialYear, snapshotId, ledgers, vouchers, params = {} }) {
  const index = indexLedgers(ledgers);
  const transporters = new Set((params.transporterLedgers || []).map(norm));
  const cashLedgerCount = ledgers.filter((l) => CASH_GROUPS.has(l.standardGroup)).length;

  const days = new Map();
  const unmapped = new Map();
  let cashVouchers = 0;
  let unreadable = 0;

  for await (const voucher of vouchers) {
    if (voucher.cancelled || voucher.optional) continue;
    const entries = voucher.entries || [];
    const touchesCash = entries.some((e) => CASH_GROUPS.has(groupOf(index, e.ledger)));
    if (!touchesCash) continue;
    // Outside the year (its date is known): not this year's.
    if (voucher.date && !dateInYear(voucher.date, financialYear)) continue;
    // A date that could not be read, or an amount that could not be read, on a voucher that moves cash.
    if (!voucher.date || hasUnreadableAmount(voucher)) {
      unreadable += 1;
      continue;
    }

    const cashOut = sumMinor(entries.filter((e) => CASH_GROUPS.has(groupOf(index, e.ledger)) && e.amountMinor > 0).map((e) => e.amountMinor), "cash out");
    if (cashOut === 0) continue;
    cashVouchers += 1;
    const debits = entries.filter((e) => e.amountMinor < 0 && !CASH_GROUPS.has(groupOf(index, e.ledger)));
    if (debits.length === 0) continue;
    const shares = proportionalShares(cashOut, debits.map((e) => -e.amountMinor));
    debits.forEach((entry, i) => {
      const group = groupOf(index, entry.ledger);
      // Cash moved into a bank account (a contra) is not a payment to anyone.
      if (group === "BANK") return;
      if (shares[i] === 0) return;
      if (group === null) unmapped.set(norm(entry.ledger), entry.ledger);
      const key = `${voucher.date}|${norm(entry.ledger)}`;
      const day = days.get(key) || { date: voucher.date, name: entry.ledger, group, cashMinor: 0, vouchers: [] };
      day.cashMinor = sumMinor([day.cashMinor, shares[i]], "cash to one payee in a day");
      day.vouchers.push({ voucher, share: shares[i] });
      days.set(key, day);
    });
  }

  const rows = [];
  const ordered = [...days.values()].sort((a, b) => a.date.localeCompare(b.date) || norm(a.name).localeCompare(norm(b.name)));
  for (const day of ordered) {
    const transporter = transporters.has(norm(day.name));
    const limit = transporter ? TRANSPORTER_LIMIT_MINOR : CASH_LIMIT_MINOR;
    if (day.cashMinor <= limit) continue;
    const ledger = index.get(norm(day.name));
    const numbers = day.vouchers.map((p) => p.voucher.number).filter(Boolean);
    const partCash = day.vouchers.some((p) => (p.voucher.entries || []).some((e) => BANK_GROUPS.has(groupOf(index, e.ledger)) && e.amountMinor > 0));
    const ruleHits = [
      hit("CASH_OVER_LIMIT", `Cash paid to ${day.name} on ${day.date} totals ${formatRupees(day.cashMinor)} across ${day.vouchers.length} voucher(s), against a limit of ${formatRupees(limit)}${transporter ? " (a transporter)" : ""}.`, limit),
      ...(partCash ? [hit("PART_CASH_SHARE", "A voucher here is partly cash and partly bank. The books do not say which part paid which ledger, so the cash is shared across the debited ledgers in proportion to their debits.")] : []),
      ...hintsFor(day.group, day.name),
    ];
    rows.push(makeRow({
      section: "CASH_PAYMENTS",
      identity: `${day.date}|${norm(day.name)}`,
      label: `${day.date}: ${day.name}`,
      values: {
        date: day.date,
        payee: day.name,
        payeeGroup: day.group,
        pan: ledger?.pan || "",
        amountMinor: day.cashMinor,
        limitMinor: limit,
        transporter,
        voucherCount: day.vouchers.length,
        voucherNumbers: numbers.slice(0, 20),
        lines: [
          { label: "Date", value: day.date, kind: "text" },
          { label: "Paid to", value: `${day.name}${day.group ? ` (${day.group.toLowerCase().replace(/_/g, " ")})` : " (group not known)"}`, kind: "text" },
          { label: "Cash paid that day", value: day.cashMinor, kind: "money" },
          { label: "Limit that applies", value: limit, kind: "money" },
          { label: "Vouchers", value: numbers.slice(0, 10).join(", ") || `${day.vouchers.length}`, kind: "text" },
        ],
        choices: PAYMENT_CHOICES,
      },
      ruleHits,
      state: "COMPUTED",
      sources: day.vouchers.map((p) => voucherSource(snapshotId, p.voucher)),
    }));
  }

  // Inputs the finding list could not be complete without.
  if (cashLedgerCount === 0) {
    rows.push(makeRow({
      section: "INPUT_GAPS",
      identity: "gap:no-cash-ledger",
      label: "No cash ledger was found",
      values: { amountMinor: null },
      ruleHits: [hit("NO_CASH_LEDGER", "No ledger in the books resolves to the Cash-in-Hand group, so no cash payment can be found. Map the group of the cash ledger, or confirm the company holds none.")],
      state: "PENDING_INPUT",
      derived: true,
    }));
  }
  if (unmapped.size) {
    rows.push(makeRow({
      section: "INPUT_GAPS",
      identity: "gap:unmapped-payees",
      label: `${unmapped.size} payee ledger(s) have no known group`,
      values: { amountMinor: null, names: [...unmapped.values()].slice(0, 20) },
      ruleHits: [hit("UNMAPPED_PAYEES", `Cash was paid to ledgers whose group is not known: ${[...unmapped.values()].slice(0, 5).join(", ")}${unmapped.size > 5 ? ", ..." : ""}. Map their groups so Rule 6DD hints can be given.`)],
      state: "PENDING_INPUT",
      derived: true,
    }));
  }
  if (unreadable) {
    rows.push(makeRow({
      section: "INPUT_GAPS",
      identity: "gap:unreadable-cash-vouchers",
      label: `${unreadable} cash voucher(s) could not be read`,
      values: { amountMinor: null, count: unreadable },
      ruleHits: [hit("UNREADABLE_CASH_VOUCHERS", `${unreadable} voucher(s) that move cash have a date or an amount the export did not give clearly. They are not counted. Export the day book again, or check them in the books.`)],
      state: "PENDING_INPUT",
      derived: true,
    }));
  }

  return { rows, cashVouchers };
}
