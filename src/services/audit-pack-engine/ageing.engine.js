// src/services/audit-pack-engine/ageing.engine.js
//
// W10 AP27 (2026-10-17). The ageing schedules Schedule III asks for - trade receivables, trade payables (micro,
// small and medium enterprises apart from the rest) and capital work in progress - worked out from the day book.
//
// THE BASIS. Schedule III ages a receivable or a payable from the due date of payment, and from the date of the
// transaction where there is no due date. So a bill is aged from its bill date plus the credit period the books
// give for it (on the bill, else on the ledger), and from the bill date alone where they give none; each row says
// how many of its bills were aged each way. (The plan said "from the bill date"; the Schedule's own basis is the
// due date, and this follows the Schedule. Recorded as a deviation in the ledger.)
//
// THE COLUMNS. Days from that basis date to the last day of the year:
//   not due        0 or fewer     the due date has not passed
//   under 6 months 1 to 179
//   6 months to 1  180 to 364
//   1 to 2 years   365 to 729
//   2 to 3 years   730 to 1,094
//   over 3 years   1,095 or more
// A bill exactly 180, 365, 730 or 1,095 days past its basis date is placed in the later column; the row says so.
//
// WHAT IT CANNOT KNOW, AND SAYS. The export carries no bill-wise opening balances, so a balance brought forward is
// in no bill unless the previous year's day book is read too. What no bill accounts for is shown as a gap, never
// spread across the columns. A supplier whose Udyam category is unanswered cannot be placed under micro, small and
// medium or under others, so it is a gap rather than a guess. Capital work in progress is aged by project and the
// books do not carry the project: its additions and balance are shown and the ageing is asked for.
//
// PURE: the same inputs always give the same rows in the same order.

import { choice, hit, rowFactory } from "../audit-pack-kinds/kit.js";
import { formatRupees } from "./clause21d.engine.js";
import { chronological, outstandingOf, trackBills } from "./bill-book.js";
import {
  addDays,
  countsInYear,
  daysBetween,
  financialYearBounds,
  indexLedgers,
  ledgerSource,
  norm,
  sumMinor,
  voucherSource,
} from "./voucher-kit.js";

export const AGEING_RULE_VERSION = "ageing-v1";

export const BUCKETS = Object.freeze([
  { code: "NOT_DUE", label: "Not due" },
  { code: "LT_6M", label: "Less than 6 months" },
  { code: "M6_1Y", label: "6 months to 1 year" },
  { code: "Y1_2", label: "1 to 2 years" },
  { code: "Y2_3", label: "2 to 3 years" },
  { code: "GT_3Y", label: "More than 3 years" },
]);

// Statutory edges in days (the Schedule's six months, one, two and three years), fixed by the rule version.
export const EDGES_DAYS = Object.freeze([180, 365, 730, 1_095]);

const MSME_CATEGORIES = new Set(["MICRO", "SMALL", "MEDIUM"]);
const CWIP_NAME = /capital\s*work[\s-]*in[\s-]*progress|\bcwip\b|under\s*development/i;

const makeRow = rowFactory(AGEING_RULE_VERSION, "Ageing");

export const RECEIVABLE_CHOICES = Object.freeze([
  choice("UNDISPUTED_GOOD", "Undisputed, considered good"),
  choice("UNDISPUTED_DOUBTFUL", "Undisputed, considered doubtful", { needsNote: true }),
  choice("DISPUTED_GOOD", "Disputed, considered good", { needsNote: true }),
  choice("DISPUTED_DOUBTFUL", "Disputed, considered doubtful", { needsNote: true }),
]);

export const PAYABLE_CHOICES = Object.freeze([
  choice("UNDISPUTED", "Undisputed"),
  choice("DISPUTED", "Disputed", { needsNote: true }),
]);

/** The column a number of days past the basis date falls in. */
export function bucketOf(days) {
  if (!Number.isSafeInteger(days)) throw new TypeError("bucketOf needs whole days");
  if (days <= 0) return "NOT_DUE";
  if (days < EDGES_DAYS[0]) return "LT_6M";
  if (days < EDGES_DAYS[1]) return "M6_1Y";
  if (days < EDGES_DAYS[2]) return "Y1_2";
  if (days < EDGES_DAYS[3]) return "Y2_3";
  return "GT_3Y";
}

const emptyBuckets = () => Object.fromEntries(BUCKETS.map((b) => [b.code, 0]));

/**
 * @param {object} input
 * @param {string} input.financialYear
 * @param {string} input.snapshotId
 * @param {object[]} input.ledgers                     snapshot ledgers with standardGroup resolved
 * @param {Iterable<object>} input.vouchers            the year's day book (any order)
 * @param {Iterable<object>|null} [input.priorVouchers]  the previous year's day book, when one was supplied
 * @param {string|null} [input.priorFinancialYear]
 * @param {Map<string,{udyamCategory:string}>} [input.parties]    by normalised ledger name
 */
export function buildAgeingRows({
  financialYear,
  snapshotId,
  ledgers,
  vouchers,
  priorVouchers = null,
  priorFinancialYear = null,
  parties = new Map(),
}) {
  const index = indexLedgers(ledgers);
  const yearEnd = addDays(financialYearBounds(financialYear).endDayExclusive, -1);

  const sides = new Map();
  for (const ledger of ledgers) {
    if (ledger.standardGroup === "SUNDRY_DEBTORS") sides.set(norm(ledger.name), "DEBIT");
    else if (ledger.standardGroup === "SUNDRY_CREDITORS") sides.set(norm(ledger.name), "CREDIT");
  }

  const live = (list, year) => [...list].filter((v) => countsInYear(v, year));
  const current = live(vouchers, financialYear);
  const prior = priorVouchers && priorFinancialYear ? live(priorVouchers, priorFinancialYear) : [];
  // A voucher with no readable date is in no year, so `live` drops it; it is handed to the bill book anyway so it
  // is counted as unread (and named in the gaps) rather than vanishing. It moves no balance and ages no bill.
  const undated = [...vouchers, ...(priorVouchers || [])].filter((v) => !v.cancelled && !v.optional && !v.date);
  const { ledgers: book, unreadable } = trackBills({ vouchers: chronological([...prior, ...current, ...undated]), sides });

  // The year's own movement on each party ledger, in Tally's sign, for the closing balance.
  const movement = new Map();
  const cwipMovement = new Map();
  const cwipLedgers = ledgers.filter((l) => l.standardGroup === "FIXED_ASSETS" && CWIP_NAME.test(l.name || ""));
  const cwipKeys = new Set(cwipLedgers.map((l) => norm(l.name)));
  for (const voucher of current) {
    for (const entry of voucher.entries || []) {
      if (!Number.isSafeInteger(entry.amountMinor)) continue;
      const key = norm(entry.ledger);
      if (sides.has(key)) movement.set(key, sumMinor([movement.get(key) || 0, entry.amountMinor], "movement"));
      if (cwipKeys.has(key)) {
        const m = cwipMovement.get(key) || { additionsMinor: 0, transfersMinor: 0, vouchers: [] };
        if (entry.amountMinor < 0) m.additionsMinor = sumMinor([m.additionsMinor, -entry.amountMinor], "additions");
        else m.transfersMinor = sumMinor([m.transfersMinor, entry.amountMinor], "transfers");
        m.vouchers.push(voucher);
        cwipMovement.set(key, m);
      }
    }
  }

  const rows = [];
  const partyList = ledgers
    .filter((l) => sides.has(norm(l.name)))
    .sort((a, b) => norm(a.name).localeCompare(norm(b.name)));

  for (const ledger of partyList) {
    const key = norm(ledger.name);
    const side = sides.get(key);
    const mine = book.get(key);
    const openingGiven = Number.isSafeInteger(ledger.openingMinor);
    const signedClosing = sumMinor([ledger.openingMinor ?? 0, movement.get(key) || 0], "closing");
    const naturalClosing = side === "CREDIT" ? signedClosing : -signedClosing;

    const outstanding = [...(mine?.bills.values() || [])].filter((b) => outstandingOf(b) > 0);
    const buckets = emptyBuckets();
    let fromDue = 0;
    let fromBillDate = 0;
    let placed = 0;
    let duplicated = false;
    const sources = [];
    for (const bill of outstanding) {
      const creditDays = bill.creditPeriodDays ?? (Number.isSafeInteger(ledger.creditPeriodDays) ? ledger.creditPeriodDays : null);
      const basisDay = creditDays === null ? bill.day : addDays(bill.day, creditDays);
      if (creditDays === null) fromBillDate += 1;
      else fromDue += 1;
      const amount = outstandingOf(bill);
      const code = bucketOf(daysBetween(basisDay, yearEnd));
      buckets[code] = sumMinor([buckets[code], amount], "bucket");
      placed = sumMinor([placed, amount], "placed");
      duplicated ||= bill.duplicated;
      for (const v of bill.vouchers) sources.push(voucherSource(snapshotId, v));
    }
    const advances = [...(mine?.advances.values() || [])].filter((a) => a.amountMinor > 0);
    const advancesMinor = sumMinor(advances.map((a) => a.amountMinor), "advances");
    const unplaced = sumMinor([naturalClosing, -placed], "unplaced");
    if (outstanding.length === 0 && naturalClosing === 0 && advancesMinor === 0) continue;

    const isReceivable = side === "DEBIT";
    const udyam = parties.get(key)?.udyamCategory || "UNKNOWN";
    const msme = MSME_CATEGORIES.has(udyam);
    const classified = isReceivable || msme || udyam === "NOT_MSME";
    const section = isReceivable ? "RECEIVABLES" : msme ? "PAYABLES_MSME" : "PAYABLES_OTHERS";

    const lines = BUCKETS.map((b) => ({ label: b.label, value: buckets[b.code], kind: "money" }));
    lines.unshift({ label: isReceivable ? "Debtor" : `Creditor${classified ? ` (${msme ? "micro, small or medium" : "others"})` : ""}`, value: ledger.name, kind: "text" });
    lines.push({ label: "Outstanding in bills", value: placed, kind: "money" });
    if (advancesMinor > 0) lines.push({ label: "Advances not yet adjusted (not aged)", value: advancesMinor, kind: "money" });
    if (unplaced < 0) lines.push({ label: "Credit balance not in any bill (on account or an advance)", value: -unplaced, kind: "money" });

    const ruleHits = [
      hit("AGEING_BASIS", `Aged from the due date of payment for ${fromDue} bill(s) (the bill date plus the credit period the books give) and from the bill date for ${fromBillDate} bill(s) that carry no credit period, as Schedule III allows. The last day of the year, ${yearEnd}, is the day aged to.`),
      hit("COLUMN_EDGES", "A bill exactly 180, 365, 730 or 1,095 days past its basis date is placed in the later column; a bill whose due date has not passed is not due."),
    ];
    if (duplicated) ruleHits.push(hit("BILL_NAME_TWICE", "Two entries in the books carry the same bill name for this party; their amounts were added. Check whether they are one bill."));
    if (!openingGiven) ruleHits.push(hit("OPENING_NOT_GIVEN", "The export gives no opening balance for this ledger (Tally leaves the tag out when it is nil), so it is read as nil."));

    if (outstanding.length > 0 && classified) {
      rows.push(makeRow({
        section,
        identity: `${section}|${key}`,
        label: ledger.name,
        values: {
          party: ledger.name,
          pan: ledger.pan || "",
          udyamCategory: isReceivable ? "" : udyam,
          buckets,
          billCount: outstanding.length,
          billsAgedFromDueDate: fromDue,
          billsAgedFromBillDate: fromBillDate,
          advancesMinor,
          unplacedMinor: unplaced,
          amountMinor: placed,
          lines,
          choices: isReceivable ? RECEIVABLE_CHOICES : PAYABLE_CHOICES,
        },
        ruleHits,
        state: "COMPUTED",
        sources,
      }));
    }

    if (!isReceivable && !classified) {
      rows.push(makeRow({
        section: "INPUT_GAPS",
        identity: `unclassified|${key}`,
        label: `${ledger.name}: micro, small or medium enterprise?`,
        values: { party: ledger.name, amountMinor: null, bucketsMinor: buckets, outstandingMinor: placed, lines, choices: [] },
        ruleHits: [hit("UDYAM_CATEGORY_UNANSWERED", `${ledger.name} owes ${formatRupees(placed)} in bills, but nobody has said whether it is a micro, small or medium enterprise. Schedule III lists those apart from other creditors, so it cannot be placed. Answer on the supplier under Tally books and create the pack again.`)],
        state: "PENDING_INPUT",
        derived: true,
      }));
    }

    if (unplaced > 0) {
      rows.push(makeRow({
        section: "INPUT_GAPS",
        identity: `unplaced|${key}`,
        label: `${ledger.name}: ${formatRupees(unplaced)} of the closing balance is in no bill`,
        values: {
          party: ledger.name,
          amountMinor: null,
          unplacedMinor: unplaced,
          openingMinor: ledger.openingMinor ?? null,
          closingMinor: naturalClosing,
          lines: [
            { label: "Closing balance", value: naturalClosing, kind: "money" },
            { label: "In bills", value: placed, kind: "money" },
            { label: "In no bill", value: unplaced, kind: "money" },
          ],
          choices: [],
        },
        ruleHits: [hit("BALANCE_NOT_IN_BILLS", priorVouchers
          ? `${formatRupees(unplaced)} of ${ledger.name}'s closing balance is not in any bill the two years' day books show - it is an opening balance with no bill behind it, or an entry on account. Its age cannot be worked out here.`
          : `${formatRupees(unplaced)} of ${ledger.name}'s closing balance is not in any bill this year's day book shows - most likely a balance brought forward, whose bills are not in the export. Read the previous year's books too (the prior-year snapshot) to age it, or give its age from your own records.`)],
        state: "PENDING_INPUT",
        derived: true,
      }));
    }
  }

  // Capital work in progress: the books give the movement, not the projects it belongs to.
  for (const ledger of cwipLedgers.sort((a, b) => norm(a.name).localeCompare(norm(b.name)))) {
    const key = norm(ledger.name);
    const m = cwipMovement.get(key) || { additionsMinor: 0, transfersMinor: 0, vouchers: [] };
    const opening = Number.isSafeInteger(ledger.openingMinor) ? -ledger.openingMinor : 0;
    const closing = sumMinor([opening, m.additionsMinor, -m.transfersMinor], "work in progress");
    if (closing === 0 && m.additionsMinor === 0) continue;
    rows.push(makeRow({
      section: "CWIP",
      identity: `cwip|${key}`,
      label: ledger.name,
      values: {
        ledger: ledger.name,
        openingMinor: opening,
        additionsMinor: m.additionsMinor,
        transfersMinor: m.transfersMinor,
        closingMinor: closing,
        amountMinor: null,
        lines: [
          { label: "Opening balance", value: opening, kind: "money" },
          { label: "Added in the year (under one year)", value: m.additionsMinor, kind: "money" },
          { label: "Capitalised or transferred in the year", value: m.transfersMinor, kind: "money" },
          { label: "Closing balance", value: closing, kind: "money" },
        ],
        choices: [],
      },
      ruleHits: [hit("CWIP_AGEING_BY_PROJECT", `Schedule III ages capital work in progress by project, from when each project's cost was incurred. The books give this ledger's movement (${formatRupees(m.additionsMinor)} added in the year, ${formatRupees(opening)} brought forward, ${formatRupees(m.transfersMinor)} capitalised), not its projects, and do not say which cost a capitalisation used up. Give the ageing by project from your records.`)],
      state: "PENDING_INPUT",
      // The ledger itself is evidence, so a person can leave the row out with a reason ("the ageing is in the
      // notes") - the books alone can never fill it.
      sources: [ledgerSource(snapshotId, ledger), ...m.vouchers.map((v) => voucherSource(snapshotId, v))],
    }));
  }

  // Ledgers sitting under a group nobody has mapped could be debtors or creditors.
  const unmapped = ledgers.filter((l) => !l.standardGroup);
  if (unmapped.length > 0) {
    rows.push(makeRow({
      section: "INPUT_GAPS",
      identity: "unmapped-groups",
      label: `${unmapped.length} ledger(s) sit under a group that is not mapped yet`,
      values: { count: unmapped.length, amountMinor: null, lines: [{ label: "Ledgers whose group is not read", value: String(unmapped.length), kind: "text" }], choices: [] },
      ruleHits: [hit("GROUPS_NOT_MAPPED", `${unmapped.length} ledger(s) are under a Tally group that is not read as a standard group yet, so they cannot be told from debtors or creditors. Map the groups under Tally books and create the pack again.`)],
      state: "PENDING_INPUT",
      derived: true,
    }));
  }
  if (unreadable > 0) {
    rows.push(makeRow({
      section: "INPUT_GAPS",
      identity: "unreadable-vouchers",
      label: `${unreadable} voucher(s) on debtor or creditor ledgers could not be read`,
      values: { count: unreadable, amountMinor: null, lines: [{ label: "Vouchers not read", value: String(unreadable), kind: "text" }], choices: [] },
      ruleHits: [hit("UNREADABLE_VOUCHERS", `${unreadable} voucher(s) touching a debtor or creditor have no readable date or an amount that could not be read. They are not counted in any bill.`)],
      state: "PENDING_INPUT",
      derived: true,
    }));
  }

  return { rows };
}
