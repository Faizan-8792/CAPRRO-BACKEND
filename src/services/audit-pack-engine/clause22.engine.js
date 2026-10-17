// src/services/audit-pack-engine/clause22.engine.js
//
// W10 AP23 (2026-10-17). Form 3CD clause 22 with section 43B(h): payments to micro and small enterprise
// suppliers made beyond the time appointed by section 15 of the MSMED Act, 2006, and the interest section 16
// of that Act charges for the delay - found in the day book bill-wise, each bill with the vouchers behind it.
//
// THE RULE (MSMED Act 2005 sections 15 and 16; section 43B(h) of the Income-tax Act 1961 as it applies to
// FY 2025-26; the 45-day and 15-day appointed times are section 15's):
//   a buyer must pay a micro or small enterprise supplier within the period agreed in writing, or, where
//   there is no agreement, within fifteen days of acceptance; an agreed period can never take the payment
//   beyond forty-five days from acceptance. What is paid, or remains payable, beyond the appointed time is
//   deductible only when it is actually paid (section 43B(h)), and interest at three times the bank rate the
//   RBI notifies, from the day after the appointed time until the day of payment, is not deductible at all
//   (MSMED section 16, read with section 23).
//
// WHAT IT DOES. A supplier is a ledger in the Sundry Creditors group. A purchase is a credit to the supplier
// that carries a New Ref bill allocation: the bill's name, its date of acceptance (the voucher's date) and the
// credit period written beside it. A payment is a debit to the supplier with an Agst Ref allocation naming the
// bill; when the debit's other side was neither cash nor bank the allocation is an adjustment (a return or a
// set-off), which reduces the bill without being a payment. The appointed time is min(credit period, 45) from
// acceptance, and where no credit period is anywhere in the books, fifteen days - said so on the row, because
// fifteen days is a default and not the books speaking. Interest is integer paise, BigInt throughout, each
// complete 30-day period compounding at three times the bank rate and a part period accruing day-wise.
//
// WHAT IT DOES NOT DO. It does not know a supplier's Udyam category unless the party master says MICRO or
// SMALL: an unknown category is a pending input per supplier, never read as not-MSME (a certificate the owner
// uploads and confirms is the other way a category is set - not computed here). It does not apply the
// proviso to section 43B (payment before the return is due under section 139(1)): that is offered as the
// person's answer on each row. Where the bank rate is not supplied the interest is unknown, never zero. The
// clause 26(A) register of prior-year disallowances since paid is not computed.
//
// PURE: the same inputs always give the same rows in the same order.

import { choice, hit, rowFactory } from "../audit-pack-kinds/kit.js";
import { formatRupees } from "./clause21d.engine.js";
import { addDays, dateInYear, daysBetween, financialYearBounds, groupOf, hasUnreadableAmount, indexLedgers, legSplit, norm, voucherSource } from "./voucher-kit.js";

export const CLAUSE22_RULE_VERSION = "clause22-v1";

// Statutory, so fixed by the rule version, in days: the outer limit an agreed credit period can reach (MSMED
// s.15), and the appointed time where the books carry no agreement at all.
export const MAX_AGREED_DAYS = 45;
export const DEFAULT_NO_AGREEMENT_DAYS = 15;

const makeRow = rowFactory(CLAUSE22_RULE_VERSION, "Clause 22");

export const CHOICES = Object.freeze({
  REPORT: choice("REPORT", "Report it: paid or payable beyond the appointed time, with the interest"),
  PAID_BEFORE_RETURN: choice("PAID_BEFORE_RETURN", "It was in fact paid in full before the return was due under section 139(1), so the section 43B proviso keeps it deductible this year", { needsNote: true }),
  NOT_PAYABLE: choice("NOT_PAYABLE", "The amount was not payable (returned, disputed or cancelled)", { needsNote: true }),
  OTHER_EXPLAINED: choice("OTHER_EXPLAINED", "Another reason, given in the note", { needsNote: true }),
});
const BILL_CHOICES = Object.freeze(Object.values(CHOICES));

const MSME_CATEGORIES = new Set(["MICRO", "SMALL"]);
const SUPPLIER_GROUP = "SUNDRY_CREDITORS";

/**
 * Interest from the day after the appointed time to `stopDay`, in integer paise: each complete 30-day period
 * compounds at annualBps3 (three times the bank rate, in basis points), and a part period at the end accrues
 * day-wise on what is then outstanding. BigInt throughout; the result is checked back into the safe range.
 */
export function msmedInterestMinor(amountMinor, dueDay, stopDay, annualBps3) {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) return 0;
  if (!Number.isSafeInteger(annualBps3) || annualBps3 < 0) throw new RangeError("msmedInterestMinor: the bank rate must be basis points");
  const delay = daysBetween(dueDay, stopDay);
  if (delay <= 0) return 0;
  const months = Math.floor(delay / 30);
  const days = delay % 30;
  let outstanding = BigInt(amountMinor);
  let interest = 0n;
  for (let i = 0; i < months; i += 1) {
    const inc = (outstanding * BigInt(annualBps3)) / 120_000n;
    interest += inc;
    outstanding += inc;
  }
  if (days > 0) interest += (outstanding * BigInt(annualBps3) * BigInt(days)) / 3_600_000n;
  if (interest > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("msmedInterestMinor: the interest exceeds the safe currency range");
  return Number(interest);
}

/**
 * The appointed time of a bill: min(credit period, 45) days from acceptance, or 15 days where the books and
 * the party master carry no credit period at all. Returns the days and how they were decided.
 */
export function appointedTime(creditPeriodDays) {
  if (!Number.isSafeInteger(creditPeriodDays) || creditPeriodDays <= 0) {
    return { days: DEFAULT_NO_AGREEMENT_DAYS, basis: "DEFAULT_15" };
  }
  if (creditPeriodDays > MAX_AGREED_DAYS) return { days: MAX_AGREED_DAYS, basis: "CAPPED_45" };
  return { days: creditPeriodDays, basis: "AGREED" };
}

const BASIS_WORDS = Object.freeze({
  AGREED: "the credit period agreed in the books",
  CAPPED_45: "the agreed credit period capped at the statutory 45 days",
  DEFAULT_15: "no credit period anywhere in the books, so the statutory 15 days",
});

/**
 * @param {object} input
 * @param {string} input.financialYear
 * @param {string} input.snapshotId
 * @param {object[]} input.ledgers                     snapshot ledgers with standardGroup resolved
 * @param {AsyncIterable<object>|Iterable<object>} input.vouchers   the day book, in any order
 * @param {Map<string,{udyamCategory:string,creditPeriodDays:number|null}>} [input.parties]  by normalised ledger name
 * @param {{bankRates?: Record<string,number>}} [input.params]   financial year -> bank rate in basis points
 */
export async function buildClause22Rows({ financialYear, snapshotId, ledgers, vouchers, parties = new Map(), params = {} }) {
  const index = indexLedgers(ledgers);
  const supplierSet = new Set(ledgers.filter((l) => l.standardGroup === SUPPLIER_GROUP).map((l) => norm(l.name)));
  const isSupplier = (name) => supplierSet.has(norm(name));

  const bankRateBps = params.bankRates?.[financialYear];
  const bankRateKnown = Number.isSafeInteger(bankRateBps) && bankRateBps >= 0;
  const annualBps3 = bankRateKnown ? bankRateBps * 3 : null;
  const yearEnd = addDays(financialYearBounds(financialYear).endDayExclusive, -1);

  const bills = new Map();
  const unbilled = new Map();
  const unattributed = new Map();
  const purchases = new Map();
  let unreadable = 0;
  let interestUnknownBills = 0;

  const partyOf = (name) => parties.get(norm(name)) || {};

  for await (const voucher of vouchers) {
    if (voucher.cancelled || voucher.optional) continue;
    const entries = voucher.entries || [];
    const allocations = (voucher.bills || []).filter((b) => isSupplier(b.ledger));
    if (!entries.some((e) => isSupplier(e.ledger)) && allocations.length === 0) continue;
    // Outside the year (its date is known): not this year's. A payment dated after the year end must never
    // reduce "unpaid at the year end" - whether it was made before the return was due is the person's answer.
    if (voucher.date && !dateInYear(voucher.date, financialYear)) continue;
    if (!voucher.date || hasUnreadableAmount(voucher)) { unreadable += 1; continue; }

    entries.forEach((entry, i) => {
      if (!isSupplier(entry.ledger)) return;
      const mine = allocations.filter((b) => norm(b.ledger) === norm(entry.ledger));
      const credit = entry.amountMinor > 0;
      if (credit) {
        const newRefs = mine.filter((b) => /new\s*ref/i.test(b.billType || ""));
        const allocated = newRefs.reduce((a, b) => a + Math.abs(b.amountMinor || 0), 0);
        const onAccount = Math.abs(entry.amountMinor) - allocated;
        purchases.set(norm(entry.ledger), (purchases.get(norm(entry.ledger)) || 0) + Math.abs(entry.amountMinor));
        if (newRefs.length === 0) {
          unbilled.set(norm(entry.ledger), (unbilled.get(norm(entry.ledger)) || 0) + Math.abs(entry.amountMinor));
          return;
        }
        for (const bill of newRefs) {
          const key = `${norm(entry.ledger)}|${norm(bill.name)}`;
          const existing = bills.get(key);
          if (existing) {
            // The same bill name credited again: the earliest acceptance stands, the amounts add, and the
            // row will say the books carried the name twice.
            existing.principalMinor += Math.abs(bill.amountMinor || 0);
            existing.duplicated = true;
          } else {
            bills.set(key, {
              supplier: entry.ledger, name: bill.name, acceptanceDay: voucher.date, principalMinor: Math.abs(bill.amountMinor || 0),
              creditPeriodOnBill: Number.isSafeInteger(bill.creditPeriodDays) ? bill.creditPeriodDays : null,
              duplicated: false, createdVoucher: voucher, reductions: [],
            });
          }
        }
        if (onAccount > 0.5) unbilled.set(norm(entry.ledger), (unbilled.get(norm(entry.ledger)) || 0) + Math.round(onAccount));
        return;
      }
      if (entry.amountMinor === 0) return;
      // A debit to the supplier: what of it was money (cash or bank on the other side), and which bills it settled.
      const split = legSplit(entries, i, (name) => groupOf(index, name));
      const total = Math.abs(entry.amountMinor);
      const paidFraction = total > 0 ? Math.min(1, (split.cashMinor + split.bankMinor) / total) : 0;
      const agstRefs = mine.filter((b) => /agst\s*ref/i.test(b.billType || ""));
      const allocated = agstRefs.reduce((a, b) => a + Math.abs(b.amountMinor || 0), 0);
      for (const allocation of agstRefs) {
        const amount = Math.abs(allocation.amountMinor || 0);
        const key = `${norm(entry.ledger)}|${norm(allocation.name)}`;
        const bill = bills.get(key);
        if (!bill) {
          // A payment against a bill this year's book never saw created (a prior-year purchase).
          unattributed.set(norm(entry.ledger), (unattributed.get(norm(entry.ledger)) || 0) + Math.round(amount * paidFraction));
          continue;
        }
        bill.reductions.push({ day: voucher.date, paymentMinor: Math.round(amount * paidFraction), adjustmentMinor: amount - Math.round(amount * paidFraction), voucher });
      }
      const onAccount = total - allocated;
      if (onAccount > 0.5) unattributed.set(norm(entry.ledger), (unattributed.get(norm(entry.ledger)) || 0) + Math.round(onAccount * paidFraction));
    });
  }

  const rows = [];
  const findings = [];
  const supplierTotals = new Map();

  for (const [key, bill] of [...bills.entries()].sort((a, b) => a[1].acceptanceDay.localeCompare(b[1].acceptanceDay) || a[0].localeCompare(b[0]))) {
    const party = partyOf(bill.supplier);
    const udyam = party.udyamCategory || "UNKNOWN";
    const creditPeriod = Number.isSafeInteger(party.creditPeriodDays) ? party.creditPeriodDays : bill.creditPeriodOnBill;
    const { days, basis } = appointedTime(creditPeriod);
    const dueDay = addDays(bill.acceptanceDay, days);

    const reductions = [...bill.reductions].sort((a, b) => a.day.localeCompare(b.day));
    let paidInTime = 0;
    let paidLate = 0;
    let adjustments = 0;
    for (const reduction of reductions) {
      if (reduction.day <= dueDay) paidInTime += reduction.paymentMinor;
      else paidLate += reduction.paymentMinor;
      adjustments += reduction.adjustmentMinor;
    }
    const settled = paidInTime + paidLate + adjustments;
    let unpaid = bill.principalMinor - settled;
    let overpaid = false;
    if (unpaid < 0) { overpaid = true; unpaid = 0; }
    const isMsme = MSME_CATEGORIES.has(udyam);
    const late = paidLate > 0 || unpaid > 0;

    // Interest: each part of the bill bears it from the day after the appointed time to the day it was paid
    // (a part period included); the unpaid remainder bears it to the year end and is still accruing.
    let interestMinor = 0;
    let interestKnown = true;
    if (isMsme && late && bankRateKnown) {
      if (unpaid > 0) interestMinor += msmedInterestMinor(unpaid, dueDay, yearEnd, annualBps3);
      for (const reduction of reductions) {
        if (reduction.paymentMinor > 0 && reduction.day > dueDay) {
          interestMinor += msmedInterestMinor(reduction.paymentMinor, dueDay, reduction.day, annualBps3);
        }
      }
    } else if (isMsme && late && !bankRateKnown) {
      interestKnown = false;
      interestMinor = null;
      interestUnknownBills += 1;
    } else {
      // Paid within the appointed time: no interest runs at all, so the bank rate is not needed here.
      interestMinor = 0;
    }

    const totals = supplierTotals.get(norm(bill.supplier)) || {
      supplier: bill.supplier, udyam, isMsme, bills: 0, purchaseMinor: 0, paidInTimeMinor: 0, paidLateMinor: 0, unpaidMinor: 0,
      adjustmentsMinor: 0, interestMinor: bankRateKnown ? 0 : null, anyUnknown: false, sources: [],
    };
    totals.bills += 1;
    totals.purchaseMinor += bill.principalMinor;
    totals.paidInTimeMinor += paidInTime;
    totals.paidLateMinor += paidLate;
    totals.unpaidMinor += unpaid;
    totals.adjustmentsMinor += adjustments;
    if (isMsme && bankRateKnown) totals.interestMinor = (totals.interestMinor || 0) + interestMinor;
    if (isMsme && !interestKnown) totals.anyUnknown = true;
    totals.sources.push(voucherSource(snapshotId, bill.createdVoucher), ...reductions.map((r) => voucherSource(snapshotId, r.voucher)));
    supplierTotals.set(norm(bill.supplier), totals);

    if (!isMsme || !late) continue;

    const stillAccruing = unpaid > 0;
    const ruleHits = [
      hit("PAID_BEYOND_APPOINTED_TIME",
        unpaid > 0
          ? `${formatRupees(unpaid)} of ${bill.supplier}'s bill ${bill.name} (accepted ${bill.acceptanceDay}, appointed time ${dueDay}) was still unpaid at ${yearEnd}. Section 43B(h) allows it only in the year it is paid.`
          : `${formatRupees(paidLate)} of ${bill.supplier}'s bill ${bill.name} (accepted ${bill.acceptanceDay}, appointed time ${dueDay}) was paid after the appointed time.`,
        MAX_AGREED_DAYS),
      hit("DUE_BASIS", `The appointed time is ${days} day(s) from acceptance: ${BASIS_WORDS[basis]}.`),
    ];
    if (basis === "DEFAULT_15") ruleHits.push(hit("NO_AGREEMENT_15_DAYS", "No credit period was found on the bill or in the party master, so the statutory fifteen days was applied. If an agreement in writing exists, set the credit period on the party."));
    if (basis === "CAPPED_45") ruleHits.push(hit("CAPPED_AT_45", `The credit period in the books is ${creditPeriod} days; a micro or small supplier cannot be paid later than forty-five days from acceptance, so the appointed time is ${dueDay}.`, MAX_AGREED_DAYS));
    if (stillAccruing) ruleHits.push(hit("STILL_ACCRUING", interestKnown
      ? `The MSMED Act's interest on the unpaid part runs to the day of payment; ${formatRupees(interestMinor)} is what had accrued by ${yearEnd} and it keeps running.`
      : `The MSMED Act's interest on the unpaid part runs to the day of payment and past ${yearEnd}; it cannot be stated without the bank rate.`));
    if (!interestKnown) ruleHits.push(hit("INTEREST_UNKNOWN", "No bank rate was supplied for this year, so the interest section 16 charges is unknown - not nil. Supply the RBI bank rate when the pack is created."));
    if (overpaid) ruleHits.push(hit("OVERPAID", "The payments recorded against this bill add up to more than the bill, so something was settled on account or the books carry the bill twice. Check the bill in the books."));
    if (bill.duplicated) ruleHits.push(hit("BILL_NAME_TWICE", "Two purchases in this year's book carry this bill name; their amounts were added. Check whether they are one bill."));
    findings.push({
      dueDay, supplier: norm(bill.supplier), row: makeRow({
        section: "MSME_LATE",
        identity: `${norm(bill.supplier)}|${norm(bill.name)}`,
        label: `${bill.supplier}: bill ${bill.name}`,
        values: {
          supplier: bill.supplier,
          pan: index.get(norm(bill.supplier))?.pan || "",
          udyamCategory: udyam,
          billName: bill.name,
          acceptanceDate: bill.acceptanceDay,
          dueDate: dueDay,
          dueBasis: basis,
          creditPeriodDays: days,
          billMinor: bill.principalMinor,
          paidInTimeMinor: paidInTime,
          paidLateMinor: paidLate,
          adjustmentsMinor: adjustments,
          unpaidMinor: unpaid,
          interestMinor,
          stillAccruing,
          voucherNumber: bill.createdVoucher.number || "",
          amountMinor: paidLate + unpaid,
          lines: [
            { label: "Supplier", value: `${bill.supplier} (${udyam.toLowerCase()})`, kind: "text" },
            { label: "Bill", value: bill.name, kind: "text" },
            { label: "Accepted on", value: bill.acceptanceDay, kind: "text" },
            { label: "Appointed time", value: dueDay, kind: "text" },
            { label: "How the time was set", value: BASIS_WORDS[basis], kind: "text" },
            { label: "Bill amount", value: bill.principalMinor, kind: "money" },
            { label: "Paid after the appointed time", value: paidLate, kind: "money" },
            { label: "Unpaid at the year end", value: unpaid, kind: "money" },
            { label: "Interest at three times the bank rate", value: interestMinor, kind: interestKnown ? "money" : "text" },
          ],
          choices: BILL_CHOICES,
        },
        ruleHits,
        state: "COMPUTED",
        sources: [voucherSource(snapshotId, bill.createdVoucher), ...reductions.map((r) => voucherSource(snapshotId, r.voucher))],
      }),
    });
  }

  findings.sort((a, b) => a.dueDay.localeCompare(b.dueDay) || a.supplier.localeCompare(b.supplier));
  for (const f of findings) rows.push(f.row);

  // Supplier summaries: what the clause asks for per micro or small supplier, worked out from the bills.
  for (const t of [...supplierTotals.values()].filter((t) => t.isMsme).sort((a, b) => norm(a.supplier).localeCompare(norm(b.supplier)))) {
    rows.push(makeRow({
      section: "SUPPLIERS",
      identity: `supplier|${norm(t.supplier)}`,
      label: t.supplier,
      values: {
        supplier: t.supplier,
        pan: index.get(norm(t.supplier))?.pan || "",
        udyamCategory: t.udyam,
        billCount: t.bills,
        purchaseMinor: t.purchaseMinor,
        paidInTimeMinor: t.paidInTimeMinor,
        paidLateMinor: t.paidLateMinor,
        adjustmentsMinor: t.adjustmentsMinor,
        unpaidMinor: t.unpaidMinor,
        interestMinor: t.interestMinor,
        amountMinor: null,
        lines: [
          { label: "Udyam category", value: t.udyam.toLowerCase(), kind: "text" },
          { label: "Bills in the year", value: t.bills, kind: "text" },
          { label: "Purchases", value: t.purchaseMinor, kind: "money" },
          { label: "Paid within the appointed time", value: t.paidInTimeMinor, kind: "money" },
          { label: "Paid beyond the appointed time", value: t.paidLateMinor, kind: "money" },
          { label: "Returned or adjusted against bills", value: t.adjustmentsMinor, kind: "money" },
          { label: "Unpaid at the year end", value: t.unpaidMinor, kind: "money" },
          { label: "Interest at three times the bank rate", value: t.interestMinor, kind: t.anyUnknown ? "text" : "money" },
        ],
        choices: [],
      },
      ruleHits: [],
      state: "COMPUTED",
      sources: t.sources,
      derived: true,
    }));
  }

  // ─── what could not be checked ─────────────────────────────────────────────────
  const unknownSuppliers = [...supplierTotals.values()].filter((t) => t.udyam === "UNKNOWN");
  for (const t of unknownSuppliers.sort((a, b) => norm(a.supplier).localeCompare(norm(b.supplier)))) {
    rows.push(makeRow({
      section: "INPUT_GAPS",
      identity: `gap:udyam|${norm(t.supplier)}`,
      label: `${t.supplier}: micro, small or neither is not known`,
      values: { amountMinor: null, supplier: t.supplier, purchaseMinor: t.purchaseMinor },
      ruleHits: [hit("UDYAM_UNKNOWN", `${t.supplier} supplied ${formatRupees(t.purchaseMinor)} in ${t.bills} bill(s), but the party master does not say whether it is a micro or small enterprise. The clause applies only to micro and small suppliers, so nothing was guessed: set the category (an Udyam certificate you confirm is evidence), then run the pack again.`)],
      state: "PENDING_INPUT",
      derived: true,
    }));
  }
  const outOfScope = [...supplierTotals.values()].filter((t) => !t.isMsme && t.udyam !== "UNKNOWN");
  if (outOfScope.length) {
    rows.push(makeRow({
      section: "INPUT_GAPS",
      identity: "gap:not-msme",
      label: `${outOfScope.length} supplier(s) are outside the clause (medium or not an MSME)`,
      values: { amountMinor: null, names: outOfScope.map((t) => t.supplier).slice(0, 20) },
      ruleHits: [hit("NOT_MSME_SUPPLIERS", `Left out because the party master says they are not micro or small: ${outOfScope.map((t) => t.supplier).slice(0, 5).join(", ")}${outOfScope.length > 5 ? ", ..." : ""}. Section 43B(h) and clause 22 do not reach them.`)],
      state: "PENDING_INPUT",
      derived: true,
    }));
  }
  for (const [name, amount] of [...unbilled.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    rows.push(makeRow({
      section: "INPUT_GAPS",
      identity: `gap:unbilled|${name}`,
      label: `${index.get(name)?.name || name}: purchases with no bill detail`,
      values: { amountMinor: null, purchaseMinor: amount },
      ruleHits: [hit("PURCHASES_NOT_BILLWISE", `${formatRupees(amount)} was credited to this supplier with no New Ref bill allocation, so no appointed time can be worked out for it. Set the ledger bill-wise in the books, or check the timing by hand.`)],
      state: "PENDING_INPUT",
      derived: true,
    }));
  }
  for (const [name, amount] of [...unattributed.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    rows.push(makeRow({
      section: "INPUT_GAPS",
      identity: `gap:unattributed|${name}`,
      label: `${index.get(name)?.name || name}: payments that name no bill`,
      values: { amountMinor: null, paidMinor: amount },
      ruleHits: [hit("PAYMENTS_NOT_AGAINST_BILLS", `${formatRupees(amount)} was paid to this supplier without an Agst Ref allocation (or against a bill this year's book never saw created), so it could not reduce any bill's appointed-time test. Match the payments to bills in the books, or check the timing by hand.`)],
      state: "PENDING_INPUT",
      derived: true,
    }));
  }
  if (interestUnknownBills) {
    rows.push(makeRow({
      section: "INPUT_GAPS",
      identity: "gap:bank-rate",
      label: "No bank rate was supplied",
      values: { amountMinor: null, count: interestUnknownBills },
      ruleHits: [hit("BANK_RATE_NOT_SUPPLIED", `The interest section 16 of the MSMED Act charges is unknown on ${interestUnknownBills} bill(s) - unknown, not nil. Supply the RBI bank rate in basis points for ${financialYear} when the pack is created.`)],
      state: "PENDING_INPUT",
      derived: true,
    }));
  }
  if (supplierSet.size === 0) {
    rows.push(makeRow({
      section: "INPUT_GAPS",
      identity: "gap:no-suppliers",
      label: "No supplier ledger was found",
      values: { amountMinor: null },
      ruleHits: [hit("NO_SUPPLIERS", "No ledger resolves to the Sundry Creditors group, so clause 22 could not be checked at all. Map the creditors' group, or confirm the client buys for cash only.")],
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
      ruleHits: [hit("UNREADABLE_VOUCHERS", `${unreadable} voucher(s) touching a supplier have a date or an amount the export did not give clearly. They are not counted.`)],
      state: "PENDING_INPUT",
      derived: true,
    }));
  }

  return { rows };
}
