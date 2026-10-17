// src/services/audit-pack-engine/ledger-scan.engine.js
//
// W10 AP31 (2026-10-17). The ledger scans: mechanical oddities in the day book a person should look at,
// each hit carrying the rule that fired, its threshold and the voucher behind it.
//
// THE SCANS (rule version ledger-scan-v1; every threshold is an exported constant so a change of mind is
// a change of version, never a silent drift):
//   NEGATIVE_CASH     a cash ledger's day-end balance below zero on any day of the year.
//   ROUND_SUM_CASH    a single cash movement of Rs 1,00,000 or more that is an exact multiple of Rs 10,000.
//   DUPLICATE_ENTRY   two vouchers on one day, same party, same amount.
//   DUPLICATE_REFERENCE  the same reference text on two or more vouchers of the same party.
//   BENFORD           the first-digit distribution of the year's entry amounts against Benford's law -
//                     computed only when the population is at least 300 amounts; below that the result is
//                     "too few entries", which is a result and not a number.
//   POST_CLOSE_ENTRY  a voucher dated after the year end that touches an income or expense ledger.
//   PERIOD_END_ENTRY  a journal dated on the last day of the year touching income or expense, at or above
//                     Rs 1,00,000.
//   WEEKEND_ENTRY     a Sunday movement of cash or bank at or above Rs 1,00,000. The books carry no holiday
//                     calendar, so weekends only, and the row says so.
//   UNUSUAL_PAIR      one voucher moving a debtor and a creditor with no cash, bank, income or expense
//                     ledger on it - a party-to-party adjustment with nothing behind it.
//   SUSPENSE_ENTRY    any voucher touching a suspense ledger.
//
// WHAT IT DOES NOT DO. A hit is a question, never a finding of wrong: the person answers each one. The
// scans read no bill allocations and no bank instrument details; the clause packs do that work.
//
// PURE: the same inputs always give the same rows in the same order.

import { choice, hit, rowFactory } from "../audit-pack-kinds/kit.js";
import { formatRupees } from "./clause21d.engine.js";
import { dateInYear, financialYearBounds, groupOf, hasUnreadableAmount, indexLedgers, norm, voucherSource } from "./voucher-kit.js";

export const LEDGER_SCAN_RULE_VERSION = "ledger-scan-v1";

// Statutory-free but fixed by the rule version, in paise.
export const ROUND_SUM_FLOOR_MINOR = 10_000_000;      // Rs 1,00,000
export const ROUND_SUM_MULTIPLE_MINOR = 1_000_000;    // Rs 10,000
export const PERIOD_END_FLOOR_MINOR = 10_000_000;     // Rs 1,00,000
export const WEEKEND_FLOOR_MINOR = 10_000_000;        // Rs 1,00,000
export const BENFORD_MIN_POPULATION = 300;
// Nigrini's bands: a mean absolute deviation above 0.012 is marginal or worse conformity.
export const BENFORD_MAD_LIMIT = 0.012;

const makeRow = rowFactory(LEDGER_SCAN_RULE_VERSION, "Ledger scans");

const PNL_GROUPS = new Set(["SALES", "DIRECT_INCOMES", "INDIRECT_INCOMES", "PURCHASE", "DIRECT_EXPENSES", "INDIRECT_EXPENSES"]);
const LIQUID_GROUPS = new Set(["CASH", "BANK", "BANK_OD"]);

export const SCAN_CHOICES = Object.freeze([
  choice("REPORT", "Report it: look at this in the working papers"),
  choice("EXPECTED_OCCURRENCE", "It is expected for this client - the reason is in the note", { needsNote: true }),
  choice("OTHER_EXPLAINED", "Another reason, given in the note", { needsNote: true }),
]);
const CHOICES = Object.freeze(Object.values(SCAN_CHOICES));

const voucherSourceOf = (snapshotId, voucher) => voucherSource(snapshotId, voucher);
const weekdayOf = (day) => new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sunday

/** Benford's expected share for a leading digit 1..9: log10(1 + 1/d). */
export function benfordShare(digit) {
  return Math.log10(1 + 1 / digit);
}

/** The first-digit counts and mean absolute deviation of a list of positive amounts, in paise. */
export function firstDigitProfile(amounts) {
  const counts = new Array(10).fill(0);
  let total = 0;
  for (const amount of amounts) {
    if (!Number.isSafeInteger(amount) || amount <= 0) continue;
    const first = Number(String(amount)[0]);
    if (first >= 1 && first <= 9) {
      counts[first] += 1;
      total += 1;
    }
  }
  let mad = 0;
  const observed = {};
  for (let d = 1; d <= 9; d += 1) {
    const share = total ? counts[d] / total : 0;
    observed[d] = Number(share.toFixed(4));
    mad += Math.abs(share - benfordShare(d));
  }
  return { counts, total, mad: total ? Number((mad / 9).toFixed(4)) : 0, observed };
}

function scanRow({ snapshotId, section, identity, label, voucher, amountMinor, rule, detail, threshold, extraValues = {}, extraLines = [] }) {
  return makeRow({
    section,
    identity,
    label,
    values: {
      date: voucher?.date || "",
      voucherNumber: voucher?.number || voucher?.map((v) => v.number).filter(Boolean).join(", ") || "",
      amountMinor,
      rule,
      ...extraValues,
      lines: [
        { label: "Date", value: voucher?.date || "", kind: "text" },
        { label: "Voucher", value: voucher?.number || voucher?.map((v) => v.number).join(", ") || "", kind: "text" },
        { label: "Amount", value: Number.isSafeInteger(amountMinor) ? amountMinor : null, kind: "money" },
        ...extraLines,
      ],
      choices: CHOICES,
    },
    ruleHits: [hit(rule, detail, threshold)],
    state: "COMPUTED",
    sources: voucher ? (Array.isArray(voucher) ? voucher.map((v) => voucherSourceOf(snapshotId, v)) : [voucherSourceOf(snapshotId, voucher)]) : [],
  });
}

const totalOf = (amounts) => amounts.reduce((a, b) => a + b, 0);

/**
 * @param {object} input
 * @param {string} input.financialYear
 * @param {string} input.snapshotId
 * @param {object[]} input.ledgers
 * @param {AsyncIterable<object>|Iterable<object>} input.vouchers   the day book, in any order
 */
export async function buildLedgerScanRows({ financialYear, snapshotId, ledgers, vouchers }) {
  const index = indexLedgers(ledgers);
  const { endDayExclusive, startDay } = financialYearBounds(financialYear);
  const yearEnd = new Date(Date.parse(endDayExclusive) - 86_400_000).toISOString().slice(0, 10);
  const group = (name) => groupOf(index, name);

  const cashLedgers = ledgers.filter((l) => l.standardGroup === "CASH");
  const suspenseNames = new Set(ledgers.filter((l) => l.standardGroup === "SUSPENSE" || /suspense/i.test(l.name || "")).map((l) => norm(l.name)));

  const rows = [];

  // ─── pass one: everything the scans share ────────────────────────────────
  const cashByDay = new Map();          // norm(cash ledger) -> Map(day -> balance)
  const roundSum = [];
  const byDayPartyAmount = new Map();   // "day|party|amount" -> vouchers[]
  const byPartyReference = new Map();   // "party|reference" -> vouchers[]
  const benfordAmounts = [];
  const postClose = [];
  const periodEnd = [];
  const weekend = [];
  const unusual = [];
  const suspense = [];
  let unreadable = 0;
  let scanned = 0;

  for await (const voucher of vouchers) {
    if (voucher.cancelled || voucher.optional) continue;
    const entries = voucher.entries || [];
    if (!entries.length) continue;
    if (hasUnreadableAmount(voucher)) { unreadable += 1; continue; }
    scanned += 1;
    const day = voucher.date;
    const inYear = day && dateInYear(day, financialYear);

    // cash day-book balances (in-year movements only; the opening balance the export gives is a ledger's,
    // not a day's, so the balance walks from zero within the year and says so on the row). Tally's sign is
    // negative for a debit, and an asset's balance is its debits less its credits - so the walk negates.
    for (const entry of entries) {
      if (!LIQUID_GROUPS.has(group(entry.ledger))) continue;
      if (!inYear || !day) continue;
      const key = norm(entry.ledger);
      const days = cashByDay.get(key) || new Map();
      const dayRecord = days.get(day) || { move: 0, vouchers: [] };
      dayRecord.move -= entry.amountMinor;
      dayRecord.vouchers.push(voucher);
      days.set(day, dayRecord);
      cashByDay.set(key, days);
    }

    const movements = entries.filter((e) => LIQUID_GROUPS.has(group(e.ledger)) && e.amountMinor !== 0);
    const cashMoves = movements.filter((e) => group(e.ledger) === "CASH");
    const liquidTotal = totalOf(movements.map((e) => Math.abs(e.amountMinor)));

    // ROUND_SUM_CASH
    for (const move of cashMoves) {
      const amount = Math.abs(move.amountMinor);
      if (amount >= ROUND_SUM_FLOOR_MINOR && amount % ROUND_SUM_MULTIPLE_MINOR === 0) {
        roundSum.push({ voucher, amount });
      }
    }

    // DUPLICATE_ENTRY and DUPLICATE_REFERENCE (same party: any debtor or creditor ledger on the voucher).
    // A journal moving only a party and an expense is exactly where both duplicates live, so no liquid leg
    // is required.
    const parties = entries.map((e) => e.ledger).filter((name) => ["SUNDRY_DEBTORS", "SUNDRY_CREDITORS"].includes(group(name)));
    if (inYear && parties.length) {
      const party = norm(parties[0]);
      const voucherTotal = totalOf(entries.map((e) => Math.abs(e.amountMinor)));
      const dayKey = `${day}|${party}|${voucherTotal}`;
      (byDayPartyAmount.get(dayKey) || byDayPartyAmount.set(dayKey, []).get(dayKey)).push(voucher);
      const reference = norm(voucher.reference);
      if (reference) {
        const refKey = `${party}|${reference}`;
        (byPartyReference.get(refKey) || byPartyReference.set(refKey, []).get(refKey)).push(voucher);
      }
    }

    // BENFORD: the first digits of every positive entry amount, whatever the ledger.
    for (const entry of entries) {
      if (entry.amountMinor > 0) benfordAmounts.push(entry.amountMinor);
    }

    // POST_CLOSE_ENTRY and PERIOD_END_ENTRY
    if (day) {
      const touchesPnl = entries.some((e) => PNL_GROUPS.has(group(e.ledger)));
      if (touchesPnl) {
        if (day > yearEnd) postClose.push(voucher);
        else if (inYear && day === yearEnd && (voucher.type || "").toLowerCase() === "journal" && totalOf(entries.map((e) => Math.abs(e.amountMinor))) >= PERIOD_END_FLOOR_MINOR) {
          periodEnd.push(voucher);
        }
      }
      // WEEKEND_ENTRY
      if (weekdayOf(day) === 0 && liquidTotal >= WEEKEND_FLOOR_MINOR) weekend.push({ voucher, amount: liquidTotal });
    }

    // UNUSUAL_PAIR: a debtor and a creditor with no liquid, income or expense ledger on the voucher.
    if (parties.length) {
      const hasDebtor = entries.some((e) => group(e.ledger) === "SUNDRY_DEBTORS");
      const hasCreditor = entries.some((e) => group(e.ledger) === "SUNDRY_CREDITORS");
      const onlyParties = entries.every((e) => ["SUNDRY_DEBTORS", "SUNDRY_CREDITORS"].includes(group(e.ledger)));
      if (hasDebtor && hasCreditor && onlyParties) unusual.push(voucher);
    }

    // SUSPENSE_ENTRY
    if (entries.some((e) => suspenseNames.has(norm(e.ledger)))) suspense.push(voucher);
  }

  // ─── NEGATIVE_CASH ───────────────────────────────────────────────────────
  for (const [key, days] of [...cashByDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    let running = 0;
    let worstDay = null;
    let worstBalance = 0;
    let negativeDays = 0;
    const negativeVouchers = [];
    for (const [day, record] of [...days.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      running += record.move;
      if (running < 0) {
        negativeDays += 1;
        negativeVouchers.push(...record.vouchers);
        if (running < worstBalance) { worstBalance = running; worstDay = day; }
      }
    }
    if (negativeDays === 0) continue;
    rows.push(makeRow({
      section: "CASH",
      identity: `negative-cash|${key}`,
      label: `${index.get(key)?.name || key}: cash below zero on ${negativeDays} day(s)`,
      values: {
        ledger: index.get(key)?.name || key,
        firstNegativeDay: worstDay,
        worstBalanceMinor: worstBalance,
        negativeDays,
        amountMinor: worstBalance,
        lines: [
          { label: "Ledger", value: index.get(key)?.name || key, kind: "text" },
          { label: "Most negative balance", value: worstBalance, kind: "money" },
          { label: "On", value: worstDay, kind: "text" },
          { label: "Days below zero in the year", value: negativeDays, kind: "text" },
          { label: "Basis", value: "The balance walks from zero at 1 April within this export; an opening balance is not distributed across the days.", kind: "text" },
        ],
        choices: CHOICES,
      },
      ruleHits: [hit("NEGATIVE_CASH", `${index.get(key)?.name || key} was overdrawn on ${negativeDays} day(s) of ${financialYear}, at its worst ${formatRupees(worstBalance)} on ${worstDay}. Cash cannot be negative: the entries or their dates need a look.`, 0)],
      state: "COMPUTED",
      sources: negativeVouchers.map((v) => voucherSourceOf(snapshotId, v)),
    }));
  }

  // ─── ROUND_SUM_CASH ──────────────────────────────────────────────────────
  for (const { voucher, amount } of roundSum.sort((a, b) => a.voucher.date.localeCompare(b.voucher.date) || String(a.voucher._id).localeCompare(String(b.voucher._id)))) {
    rows.push(scanRow({
      snapshotId, section: "ROUND_SUM", identity: `round-sum|${voucher.guid || voucher._id}`, label: `${voucher.date}: cash of ${formatRupees(amount)}`,
      voucher, amountMinor: amount, rule: "ROUND_SUM_CASH", threshold: ROUND_SUM_FLOOR_MINOR,
      detail: `A cash movement of ${formatRupees(amount)} on ${voucher.date} - at or above ${formatRupees(ROUND_SUM_FLOOR_MINOR)} and an exact multiple of ${formatRupees(ROUND_SUM_MULTIPLE_MINOR)}. Round-sum cash is where the books are asked to agree with what was not paid in cash.`,
    }));
  }

  // ─── DUPLICATE_ENTRY and DUPLICATE_REFERENCE ─────────────────────────────
  for (const [key, group_] of [...byDayPartyAmount.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (group_.length < 2) continue;
    const [day, party, amount] = key.split("|");
    rows.push(scanRow({
      snapshotId, section: "DUPLICATES", identity: `dup-day|${key}`, label: `${day}: ${group_.length} vouchers of ${formatRupees(Number(amount))} on ${party}`,
      voucher: group_, amountMinor: Number(amount), rule: "DUPLICATE_ENTRY", threshold: 0,
      detail: `${group_.length} voucher(s) on ${day} for ${party} of exactly ${formatRupees(Number(amount))} each. The same party, day and amount twice is either one entry booked twice or a genuine repeat; the books do not say which.`,
      extraLines: [{ label: "Vouchers", value: group_.map((v) => v.number).join(", "), kind: "text" }],
    }));
  }
  for (const [key, group_] of [...byPartyReference.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (group_.length < 2) continue;
    const [party, reference] = key.split("|");
    const distinctDates = new Set(group_.map((v) => v.date)).size;
    if (distinctDates < 2) continue; // same-day repeats are the duplicate-entry scan's work
    rows.push(scanRow({
      snapshotId, section: "DUPLICATES", identity: `dup-ref|${key}`, label: `Reference "${group_[0].reference}" on ${group_.length} vouchers of ${party}`,
      voucher: group_, amountMinor: null, rule: "DUPLICATE_REFERENCE", threshold: 0,
      detail: `The reference "${group_[0].reference}" appears on ${group_.length} vouchers of ${party} across ${distinctDates} dates. A repeated reference with different dates and amounts can be instalments - or the same bill paid twice.`,
      extraLines: [
        { label: "Vouchers", value: group_.map((v) => `${v.date} ${v.number}`).join(", "), kind: "text" },
        { label: "Amounts", value: group_.map((v) => formatRupees(totalOf((v.entries || []).map((e) => Math.abs(e.amountMinor))))).join(", "), kind: "text" },
      ],
    }));
  }

  // ─── BENFORD ─────────────────────────────────────────────────────────────
  if (benfordAmounts.length < BENFORD_MIN_POPULATION) {
    rows.push(makeRow({
      section: "BENFORD",
      identity: "benford-population",
      label: `Benford: too few entries (${benfordAmounts.length})`,
      values: { amountMinor: null, population: benfordAmounts.length, lines: [{ label: "Amounts read", value: benfordAmounts.length, kind: "text" }, { label: "Needed", value: BENFORD_MIN_POPULATION, kind: "text" }], choices: [] },
      ruleHits: [hit("BENFORD_TOO_FEW", `${benfordAmounts.length} amounts were read; the first-digit test needs at least ${BENFORD_MIN_POPULATION} before its shape says anything. Too few entries - not a result of zero.`)],
      state: "COMPUTED",
      sources: [{ kind: "BOOKS_SNAPSHOT", batchId: String(snapshotId), rowId: "benford", sourceRow: 0 }],
      derived: true,
    }));
  } else {
    const profile = firstDigitProfile(benfordAmounts);
    if (profile.mad > BENFORD_MAD_LIMIT) {
      rows.push(makeRow({
        section: "BENFORD",
        identity: "benford-deviation",
        label: `Benford: the first digits deviate (MAD ${profile.mad})`,
        values: {
          amountMinor: null, population: profile.total, mad: profile.mad, observed: profile.observed,
          lines: [
            { label: "Amounts read", value: profile.total, kind: "text" },
            { label: "Mean absolute deviation", value: profile.mad, kind: "text" },
            ...Object.entries(profile.observed).map(([d, share]) => ({ label: `Digit ${d}: observed`, value: `${share} against ${benfordShare(Number(d)).toFixed(4)} expected`, kind: "text" })),
          ],
          choices: CHOICES,
        },
        ruleHits: [hit("BENFORD_DEVIATION", `Across ${profile.total} amounts the first-digit distribution's mean absolute deviation from Benford's law is ${profile.mad}, above the ${BENFORD_MAD_LIMIT} band. Made-up amounts, round-sum habits and clustered pricing all show here; it is a reason to look, never a conclusion.`, BENFORD_MAD_LIMIT)],
        state: "COMPUTED",
        sources: [{ kind: "BOOKS_SNAPSHOT", batchId: String(snapshotId), rowId: "benford", sourceRow: 0 }],
        derived: true,
      }));
    }
  }

  // ─── POST_CLOSE_ENTRY and PERIOD_END_ENTRY ───────────────────────────────
  for (const voucher of postClose.sort((a, b) => a.date.localeCompare(b.date))) {
    const amount = totalOf((voucher.entries || []).map((e) => Math.abs(e.amountMinor)));
    rows.push(scanRow({
      snapshotId, section: "PERIOD_END", identity: `post-close|${voucher.guid || voucher._id}`, label: `${voucher.date}: an entry after the year end touches income or expense`,
      voucher, amountMinor: amount, rule: "POST_CLOSE_ENTRY", threshold: 0,
      detail: `A voucher dated ${voucher.date}, after ${yearEnd}, moves an income or expense ledger. The year's books were already closed on paper when it was entered; what it moves belongs to somebody's year.`,
    }));
  }
  for (const voucher of periodEnd.sort((a, b) => String(a._id).localeCompare(String(b._id)))) {
    const amount = totalOf((voucher.entries || []).map((e) => Math.abs(e.amountMinor)));
    rows.push(scanRow({
      snapshotId, section: "PERIOD_END", identity: `period-end|${voucher.guid || voucher._id}`, label: `${yearEnd}: a period-end journal of ${formatRupees(amount)}`,
      voucher, amountMinor: amount, rule: "PERIOD_END_ENTRY", threshold: PERIOD_END_FLOOR_MINOR,
      detail: `A journal dated on the last day of the year moves income or expense by ${formatRupees(amount)} - at or above ${formatRupees(PERIOD_END_FLOOR_MINOR)}. The last-day journals are where the year is made to look how it looks.`,
    }));
  }

  // ─── WEEKEND_ENTRY ───────────────────────────────────────────────────────
  for (const { voucher, amount } of weekend.sort((a, b) => a.voucher.date.localeCompare(b.voucher.date))) {
    rows.push(scanRow({
      snapshotId, section: "WEEKEND", identity: `weekend|${voucher.guid || voucher._id}`, label: `${voucher.date} (a Sunday): ${formatRupees(amount)} of cash or bank`,
      voucher, amountMinor: amount, rule: "WEEKEND_ENTRY", threshold: WEEKEND_FLOOR_MINOR,
      detail: `A movement of ${formatRupees(amount)} through cash or a bank on a Sunday, ${voucher.date} - at or above ${formatRupees(WEEKEND_FLOOR_MINOR)}. The books carry no holiday calendar, so only Sundays are flagged; whether the day was a working day is for you.`,
    }));
  }

  // ─── UNUSUAL_PAIR ────────────────────────────────────────────────────────
  for (const voucher of unusual.sort((a, b) => a.date.localeCompare(b.date) || String(a._id).localeCompare(String(b._id)))) {
    const amount = totalOf((voucher.entries || []).map((e) => Math.abs(e.amountMinor)));
    rows.push(scanRow({
      snapshotId, section: "UNUSUAL", identity: `unusual|${voucher.guid || voucher._id}`, label: `${voucher.date}: a debtor and a creditor set off against each other`,
      voucher, amountMinor: amount, rule: "UNUSUAL_PAIR", threshold: 0,
      detail: `A voucher of ${formatRupees(amount)} moves a debtor and a creditor with no cash, bank, income or expense ledger on it. A party-to-party set-off needs its own paper: whose claim moved, and why.`,
    }));
  }

  // ─── SUSPENSE_ENTRY ──────────────────────────────────────────────────────
  for (const voucher of suspense.sort((a, b) => a.date.localeCompare(b.date) || String(a._id).localeCompare(String(b._id)))) {
    const amount = totalOf((voucher.entries || []).map((e) => Math.abs(e.amountMinor)));
    rows.push(scanRow({
      snapshotId, section: "SUSPENSE", identity: `suspense|${voucher.guid || voucher._id}`, label: `${voucher.date}: an entry through suspense`,
      voucher, amountMinor: amount, rule: "SUSPENSE_ENTRY", threshold: 0,
      detail: `A voucher of ${formatRupees(amount)} touches a suspense ledger on ${voucher.date}. Suspense is where entries wait for an answer; every one of them needs its answer before the books close.`,
    }));
  }

  // ─── what could not be scanned ───────────────────────────────────────────
  if (scanned === 0) {
    rows.push(makeRow({
      section: "INPUT_GAPS",
      identity: "gap:no-vouchers",
      label: "No vouchers were in the day book",
      values: { amountMinor: null },
      ruleHits: [hit("NO_VOUCHERS", "The sealed export holds no live vouchers, so nothing could be scanned. Upload the year's day book and seal it.")],
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
      ruleHits: [hit("UNREADABLE_VOUCHERS", `${unreadable} voucher(s) have an amount the export did not give clearly. They are not counted in any scan.`)],
      state: "PENDING_INPUT",
      derived: true,
    }));
  }

  return { rows, scanned };
}
