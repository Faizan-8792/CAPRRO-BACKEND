// src/services/audit-pack-engine/voucher-kit.js
//
// W10 (2026-10-17): what the engines that read a Tally day book share. PURE: no I/O.
//
// Tally's sign is kept everywhere: an entry's amount is NEGATIVE for a debit and POSITIVE for a credit
// (tally-xml.js, tally-canonical-v1). A voucher whose entries do not sum to nil is not balanced; the engines
// do not "fix" it, they name it.

import { dateInYear, financialYearBounds, norm, sumMinor } from "../audit-pack-kinds/kit.js";

export { dateInYear, financialYearBounds, norm, sumMinor };

/** A map from a ledger's name (case and spacing ignored, as Tally treats them) to the ledger. */
export function indexLedgers(ledgers) {
  const map = new Map();
  for (const ledger of ledgers) map.set(norm(ledger.name), ledger);
  return map;
}

export const CASH_GROUPS = new Set(["CASH"]);
export const BANK_GROUPS = new Set(["BANK", "BANK_OD"]);

export function groupOf(index, ledgerName) {
  return index.get(norm(ledgerName))?.standardGroup || null;
}

/** The voucher as evidence: what a row's source list carries. */
export function voucherSource(snapshotId, voucher) {
  return { kind: "BOOKS_VOUCHER", batchId: String(snapshotId), rowId: String(voucher._id), sourceRow: 0 };
}

/** A ledger of the snapshot as evidence: a row that rests on a master record, not on any one voucher. */
export function ledgerSource(snapshotId, ledger) {
  return { kind: "BOOKS_LEDGER", batchId: String(snapshotId), rowId: String(ledger._id ?? ledger.guid ?? ledger.name), sourceRow: 0 };
}

/**
 * True when a voucher is a live entry in the year: not cancelled, not optional (a memorandum Tally keeps out
 * of the books), with a readable date inside the financial year.
 */
export function countsInYear(voucher, financialYear) {
  if (voucher.cancelled || voucher.optional) return false;
  return dateInYear(voucher.date, financialYear);
}

/** True when any entry's amount could not be read - the voucher cannot be relied on for a figure. */
export function hasUnreadableAmount(voucher) {
  return (voucher.entries || []).some((e) => !Number.isSafeInteger(e.amountMinor));
}

/**
 * Splits `total` paise across `weights` in proportion, exactly: the shares sum to `total`. The paise left
 * over after rounding down go to the largest weights first (ties by position), so the same input always
 * gives the same shares.
 */
export function proportionalShares(total, weights) {
  if (!Number.isSafeInteger(total) || total < 0) throw new RangeError("proportionalShares: total must be non-negative paise");
  if (weights.some((w) => !Number.isSafeInteger(w) || w < 0)) throw new RangeError("proportionalShares: weights must be non-negative paise");
  const sum = weights.reduce((a, w) => a + BigInt(w), 0n);
  if (sum === 0n) return weights.map(() => 0);
  const T = BigInt(total);
  const base = weights.map((w) => (T * BigInt(w)) / sum);
  let left = T - base.reduce((a, b) => a + b, 0n);
  const order = weights.map((w, i) => [w, i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  const shares = base.map(Number);
  for (const [, i] of order) {
    if (left === 0n) break;
    shares[i] += 1;
    left -= 1n;
  }
  return shares;
}

/** Whole days between two yyyy-mm-dd dates (UTC days, as every statutory date here is): b minus a. */
export function daysBetween(a, b) {
  const da = Date.UTC(...a.split("-").map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))));
  const db = Date.UTC(...b.split("-").map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))));
  return Math.round((db - da) / 86_400_000);
}

/** yyyy-mm-dd plus n days (UTC). */
export function addDays(date, n) {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

/** Collects an async (or sync) iterable into an array. Engines that need two passes call this once. */
export async function collect(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

/**
 * How one entry of a voucher was settled. The entries on the other side of the voucher are the legs that paid
 * it; their cash, bank and other amounts are shared across the entries on this side in proportion to those
 * entries' amounts (the books do not say which leg settled which). The three parts always sum to the entry's own
 * amount: whatever the legs do not account for is "other" (a journal, a set-off, an unbalanced voucher).
 *
 * @param {{ledger:string,amountMinor:number}[]} entries   every entry of the voucher (amounts must be readable)
 * @param {number} targetIndex
 * @param {(ledgerName:string)=>string|null} groupOfLedger
 */
export function legSplit(entries, targetIndex, groupOfLedger) {
  const target = entries[targetIndex];
  const sign = Math.sign(target.amountMinor);
  const sameSide = entries.map((e, i) => ({ e, i })).filter(({ e }) => Math.sign(e.amountMinor) === sign);
  const opposite = entries.filter((e) => Math.sign(e.amountMinor) === -sign);
  const weights = sameSide.map(({ e }) => Math.abs(e.amountMinor));
  const mine = sameSide.findIndex(({ i }) => i === targetIndex);
  const part = (predicate) =>
    proportionalShares(sumMinor(opposite.filter((e) => predicate(groupOfLedger(e.ledger))).map((e) => Math.abs(e.amountMinor)), "legs"), weights)[mine];
  const total = Math.abs(target.amountMinor);
  const cashMinor = Math.min(total, part((g) => CASH_GROUPS.has(g)));
  const bankMinor = Math.min(total - cashMinor, part((g) => BANK_GROUPS.has(g)));
  return { cashMinor, bankMinor, otherMinor: total - cashMinor - bankMinor };
}

/**
 * The bank allocations of a voucher that sit under bank ledgers, classified by how the money moved:
 * ELECTRONIC (a transfer through the banking system), INSTRUMENT (a cheque or draft - whether it was account
 * payee is not in the books), CASH_AT_BANK (a deposit or withdrawal over the counter), or UNKNOWN.
 */
export function bankChannel(voucher, groupOfLedger) {
  const kinds = new Set();
  for (const bank of voucher.banks || []) {
    if (!BANK_GROUPS.has(groupOfLedger(bank.ledger))) continue;
    const type = String(bank.transactionType || "").toLowerCase();
    if (/e-?fund|neft|rtgs|imps|upi|ecs|nach|online|electronic|transfer/.test(type)) kinds.add("ELECTRONIC");
    else if (/cheque|check|\bdd\b|draft|demand/.test(type)) kinds.add("INSTRUMENT");
    else if (/cash/.test(type)) kinds.add("CASH_AT_BANK");
    else kinds.add("UNKNOWN");
  }
  if (kinds.size === 0) return "UNKNOWN";
  if (kinds.has("CASH_AT_BANK")) return "CASH_AT_BANK";
  if (kinds.has("INSTRUMENT")) return "INSTRUMENT";
  if (kinds.has("UNKNOWN")) return "UNKNOWN";
  return "ELECTRONIC";
}
