// src/services/audit-pack-engine/bill-book.js
//
// W10 AP27 (2026-10-17). What the engines that look at bills share: which bills a party ledger had, how much of
// each is still outstanding after the settlements the day book records, and what part of the ledger's balance is
// in no bill at all. PURE: no I/O.
//
// TALLY'S WAY. A party ledger has a natural side - a debtor owes us (debit), a creditor is owed (credit). A voucher
// entry on that side with a "New Ref" allocation creates a bill; an entry on the other side with an "Agst Ref"
// allocation settles the named bill; an entry or part of an entry with no allocation is "on account". A "New Ref"
// on the other side is an advance (a credit balance of a debtor, a debit balance of a creditor), which is not a
// bill to be aged. Tally's sign is kept: an amount is NEGATIVE for a debit and POSITIVE for a credit.
//
// WHAT IT CANNOT KNOW. The export carries no opening bill-wise allocations, so a bill raised before the day book
// begins is invisible unless the previous year's day book is read too (the caller passes it first). Whatever part
// of the closing balance no bill accounts for is reported as `unplacedMinor`, never spread over the buckets.

import { norm, sumMinor } from "./voucher-kit.js";

const NEW_REF = /new\s*ref/i;
const AGST_REF = /agst\s*ref/i;

/** The order vouchers are applied in: by date, then by Tally's alter id, then by identity - deterministic. */
export function chronological(vouchers) {
  return [...vouchers].sort(
    (a, b) =>
      String(a.date).localeCompare(String(b.date))
      || (a.alterId ?? 0) - (b.alterId ?? 0)
      || String(a._id ?? a.guid ?? "").localeCompare(String(b._id ?? b.guid ?? "")),
  );
}

/**
 * @param {object} input
 * @param {Iterable<object>} input.vouchers          already in chronological order, already filtered to live entries
 * @param {Map<string,"DEBIT"|"CREDIT">} input.sides  normalised ledger name -> the side its bills are on
 * @returns {{ ledgers: Map<string, object>, unreadable: number }}
 */
export function trackBills({ vouchers, sides }) {
  const ledgers = new Map();
  let unreadable = 0;
  const book = (name) => {
    const key = norm(name);
    let entry = ledgers.get(key);
    if (!entry) {
      entry = {
        name,
        side: sides.get(key),
        bills: new Map(),
        advances: new Map(),
        onAccountNaturalMinor: 0,
        onAccountOppositeMinor: 0,
        unmatchedSettlementMinor: 0,
        advanceAdjustedMinor: 0,
        naturalMovementMinor: 0,
        oppositeMovementMinor: 0,
        vouchers: [],
      };
      ledgers.set(key, entry);
    }
    return entry;
  };

  for (const voucher of vouchers) {
    const entries = voucher.entries || [];
    if (!entries.some((e) => sides.has(norm(e.ledger)))) continue;
    if (!voucher.date || entries.some((e) => !Number.isSafeInteger(e.amountMinor))) {
      unreadable += 1;
      continue;
    }
    for (const entry of entries) {
      const side = sides.get(norm(entry.ledger));
      if (!side || entry.amountMinor === 0) continue;
      const mine = book(entry.ledger);
      const amount = Math.abs(entry.amountMinor);
      const onNaturalSide = side === "CREDIT" ? entry.amountMinor > 0 : entry.amountMinor < 0;
      const allocations = (voucher.bills || []).filter((b) => norm(b.ledger) === norm(entry.ledger));
      if (!mine.vouchers.includes(voucher)) mine.vouchers.push(voucher);

      if (onNaturalSide) {
        mine.naturalMovementMinor = sumMinor([mine.naturalMovementMinor, amount], "natural movement");
        const newRefs = allocations.filter((b) => NEW_REF.test(b.billType || ""));
        let allocated = 0;
        for (const ref of newRefs) {
          const refAmount = Math.abs(ref.amountMinor || 0);
          allocated += refAmount;
          const existing = mine.bills.get(norm(ref.name));
          if (existing) {
            // The same bill name raised again: the earliest date stands, the amounts add, and the row says so.
            existing.principalMinor = sumMinor([existing.principalMinor, refAmount], "bill");
            existing.duplicated = true;
            if (!existing.vouchers.includes(voucher)) existing.vouchers.push(voucher);
          } else {
            mine.bills.set(norm(ref.name), {
              name: ref.name,
              day: voucher.date,
              creditPeriodDays: Number.isSafeInteger(ref.creditPeriodDays) ? ref.creditPeriodDays : null,
              principalMinor: refAmount,
              settledMinor: 0,
              settlements: [],
              duplicated: false,
              vouchers: [voucher],
            });
          }
        }
        // An invoice that uses up an advance the party paid earlier names it "Agst Ref" on the same side as the bill.
        for (const ref of allocations.filter((b) => AGST_REF.test(b.billType || ""))) {
          const advance = mine.advances.get(norm(ref.name));
          if (!advance) continue;
          const applied = Math.min(advance.amountMinor, Math.abs(ref.amountMinor || 0));
          advance.amountMinor = sumMinor([advance.amountMinor, -applied], "advance");
          mine.advanceAdjustedMinor = sumMinor([mine.advanceAdjustedMinor, applied], "advance adjusted");
          allocated += applied;
        }
        mine.onAccountNaturalMinor = sumMinor([mine.onAccountNaturalMinor, Math.max(0, amount - allocated)], "on account");
        continue;
      }

      mine.oppositeMovementMinor = sumMinor([mine.oppositeMovementMinor, amount], "opposite movement");
      let allocated = 0;
      for (const ref of allocations) {
        const refAmount = Math.abs(ref.amountMinor || 0);
        if (AGST_REF.test(ref.billType || "")) {
          allocated += refAmount;
          const bill = mine.bills.get(norm(ref.name));
          if (!bill) {
            mine.unmatchedSettlementMinor = sumMinor([mine.unmatchedSettlementMinor, refAmount], "unmatched settlement");
            continue;
          }
          const room = bill.principalMinor - bill.settledMinor;
          const applied = Math.min(room, refAmount);
          bill.settledMinor = sumMinor([bill.settledMinor, applied], "settled");
          bill.settlements.push({ day: voucher.date, amountMinor: applied, voucher });
          if (!bill.vouchers.includes(voucher)) bill.vouchers.push(voucher);
          if (refAmount > room) mine.unmatchedSettlementMinor = sumMinor([mine.unmatchedSettlementMinor, refAmount - room], "unmatched settlement");
        } else if (NEW_REF.test(ref.billType || "")) {
          allocated += refAmount;
          const key = norm(ref.name);
          const advance = mine.advances.get(key) || { name: ref.name, day: voucher.date, amountMinor: 0, vouchers: [] };
          advance.amountMinor = sumMinor([advance.amountMinor, refAmount], "advance");
          advance.vouchers.push(voucher);
          mine.advances.set(key, advance);
        }
      }
      mine.onAccountOppositeMinor = sumMinor([mine.onAccountOppositeMinor, Math.max(0, amount - allocated)], "on account");
    }
  }
  return { ledgers, unreadable };
}

/** What is still outstanding on a bill after its settlements; never negative (a bill cannot be owed twice). */
export const outstandingOf = (bill) => Math.max(0, bill.principalMinor - bill.settledMinor);
