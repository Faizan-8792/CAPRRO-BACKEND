// src/services/audit-pack-engine/clause31.engine.js
//
// W10 AP25 (2026-10-17). Form 3CD clause 31: loans, deposits and cash receipts that sections 269SS, 269T and
// 269ST require to go through a bank - found in the day book, each with the vouchers behind it.
//
//   269SS  a loan or deposit accepted otherwise than by an account payee cheque or draft, or an electronic mode
//          through a bank account, where the amount, with what is already outstanding, is Rs 20,000 or more.
//   269T   the repayment of such a loan or deposit the same way, where the amount outstanding is Rs 20,000 or
//          more.
//   269ST  receipts in cash of Rs 2,00,000 or more: (i) from one person in one day, (ii) in a single transaction.
//          The third limb - transactions relating to one event or occasion - needs a person to say which receipts
//          belong together; it is not computed.
//
// WHAT IT DOES. A lender or depositor account is a ledger in a Loans group, or one a person has confirmed as a
// lender. Every credit to it in the year is a loan or deposit taken, every debit a repayment; the entries on the
// other side of the voucher say how it was settled (cash, bank, or neither - a journal or a set-off). A
// movement that was not through a bank, on an account where the balance with the movement is Rs 20,000 or
// more, is a finding. Each lender account in the year also gets a summary row (opening, taken, repaid, closing,
// the highest balance at any time, whether it was squared up), which is what the clause asks for.
//
// WHAT IT DOES NOT DO. It cannot see whether a cheque was account payee (a crossing is not in the books): a
// bank-instrument movement is a finding with that question put to the person, and a bank movement whose channel
// the books do not give is a finding too. It does not decide whether a lender is exempt (a bank, the
// Government); the person says. Bank loans are the usual case: set such a ledger as not a lender.
//
// PURE: the same inputs always give the same rows in the same order.

import { choice, hit, rowFactory } from "../audit-pack-kinds/kit.js";
import { formatRupees } from "./clause21d.engine.js";
import {
  CASH_GROUPS,
  bankChannel,
  dateInYear,
  groupOf,
  hasUnreadableAmount,
  indexLedgers,
  legSplit,
  norm,
  sumMinor,
  voucherSource,
} from "./voucher-kit.js";

export const CLAUSE31_RULE_VERSION = "clause31-v1";

// Statutory, fixed by the rule version: Rs 20,000 (269SS, 269T) and Rs 2,00,000 (269ST), in paise.
export const LOAN_LIMIT_MINOR = 2_000_000;
export const RECEIPT_LIMIT_MINOR = 20_000_000;

export const LENDER_GROUP_CODES = new Set(["LOANS_LIABILITY", "LOANS_SECURED", "LOANS_UNSECURED"]);

const makeRow = rowFactory(CLAUSE31_RULE_VERSION, "Clause 31");

export const LOAN_CHOICES = Object.freeze([
  choice("REPORT", "Report it: not through a bank"),
  choice("EXEMPT_LENDER", "The lender is exempt (a bank, the Government or a notified body)", { needsNote: true }),
  choice("ACCOUNT_PAYEE", "It was an account payee cheque or draft, or an electronic transfer", { needsNote: true }),
  choice("NOT_A_LOAN", "Not a loan or deposit (an adjustment or a payment for something else)", { needsNote: true }),
  choice("OTHER_EXPLAINED", "Another reason, given in the note", { needsNote: true }),
]);

export const RECEIPT_CHOICES = Object.freeze([
  choice("REPORT", "Report it: a cash receipt of Rs 2,00,000 or more"),
  choice("EXEMPT_PAYER", "The payer is exempt (a bank, the Government or a notified body)", { needsNote: true }),
  choice("ONE_EVENT_AGGREGATE", "Report it, with the other receipts for the same event, as one event", { needsNote: true }),
  choice("NOT_A_RECEIPT", "Not a receipt from a person (an internal transfer or a refund)", { needsNote: true }),
  choice("BANK_CHANNEL", "It was in fact received through a banking channel", { needsNote: true }),
  choice("OTHER_EXPLAINED", "Another reason, given in the note", { needsNote: true }),
]);

const MODE_WORDS = Object.freeze({
  CASH: "in cash",
  MIXED_CASH: "partly in cash",
  NON_BANKING: "by an entry that is neither cash nor bank (a journal or a set-off)",
  INSTRUMENT: "by cheque or draft - the books do not say whether it was account payee",
  CASH_AT_BANK: "by cash at the bank",
  UNKNOWN_BANK: "through the bank - the books do not say how",
});

function modeOf(split, channel) {
  if (split.cashMinor > 0) return split.bankMinor + split.otherMinor === 0 ? "CASH" : "MIXED_CASH";
  if (split.otherMinor > 0 && split.bankMinor === 0) return "NON_BANKING";
  if (split.bankMinor > 0) {
    if (channel === "ELECTRONIC") return "ELECTRONIC";
    if (channel === "INSTRUMENT") return "INSTRUMENT";
    if (channel === "CASH_AT_BANK") return "CASH_AT_BANK";
    return "UNKNOWN_BANK";
  }
  return "NON_BANKING";
}

/**
 * @param {object} input
 * @param {string} input.financialYear
 * @param {string} input.snapshotId
 * @param {object[]} input.ledgers
 * @param {AsyncIterable<object>|Iterable<object>} input.vouchers
 * @param {Map<string,{lenderOrDepositor:boolean|null}>} [input.partyFlags]   by normalised ledger name
 */
export async function buildClause31Rows({ financialYear, snapshotId, ledgers, vouchers, partyFlags = new Map() }) {
  const index = indexLedgers(ledgers);
  const groupOfName = (name) => groupOf(index, name);
  const isLender = (ledger) => {
    const flag = partyFlags.get(norm(ledger.name))?.lenderOrDepositor;
    if (flag === false) return false;
    return flag === true || LENDER_GROUP_CODES.has(ledger.standardGroup);
  };
  const lenders = new Map(ledgers.filter(isLender).map((l) => [norm(l.name), l]));
  const movements = new Map();
  const receipts = new Map();
  let unreadable = 0;

  for await (const voucher of vouchers) {
    if (voucher.cancelled || voucher.optional) continue;
    if (voucher.date && !dateInYear(voucher.date, financialYear)) continue;
    const entries = voucher.entries || [];
    const touches = entries.some((e) => lenders.has(norm(e.ledger)) || CASH_GROUPS.has(groupOfName(e.ledger)));
    if (!touches) continue;
    if (!voucher.date || hasUnreadableAmount(voucher)) {
      unreadable += 1;
      continue;
    }
    const channel = bankChannel(voucher, groupOfName);

    // 269SS and 269T: movements on lender accounts.
    entries.forEach((entry, i) => {
      const lender = lenders.get(norm(entry.ledger));
      if (lender && entry.amountMinor !== 0) {
        const split = legSplit(entries, i, groupOfName);
        const list = movements.get(norm(lender.name)) || [];
        list.push({ voucher, entry, split, mode: modeOf(split, channel), channel, order: list.length });
        movements.set(norm(lender.name), list);
      }
    });

    // 269ST: cash received, by the ledger it was credited to.
    entries.forEach((entry, i) => {
      if (!(entry.amountMinor > 0)) return;
      const group = groupOfName(entry.ledger);
      if (CASH_GROUPS.has(group) || group === "BANK") return;
      const split = legSplit(entries, i, groupOfName);
      if (split.cashMinor === 0) return;
      const key = `${voucher.date}|${norm(entry.ledger)}`;
      const day = receipts.get(key) || { date: voucher.date, name: entry.ledger, group, cashMinor: 0, largestMinor: 0, vouchers: [] };
      day.cashMinor = sumMinor([day.cashMinor, split.cashMinor], "cash received in a day");
      day.largestMinor = Math.max(day.largestMinor, split.cashMinor);
      day.vouchers.push(voucher);
      receipts.set(key, day);
    });
  }

  const rows = [];

  // ─── 269SS / 269T ───────────────────────────────────────────────────────────
  const summaries = [];
  const loanFindings = [];
  for (const [key, list] of [...movements.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const lender = lenders.get(key);
    // Credits increase what is owed; Tally's opening balance is positive for a credit.
    const opening = Number.isSafeInteger(lender.openingMinor) ? lender.openingMinor : null;
    let balance = opening ?? 0;
    let highest = Math.max(balance, 0);
    let taken = 0;
    let repaid = 0;
    const ordered = [...list].sort((a, b) => a.voucher.date.localeCompare(b.voucher.date) || (a.voucher.alterId ?? 0) - (b.voucher.alterId ?? 0) || a.order - b.order);
    for (const move of ordered) {
      const amount = move.entry.amountMinor;
      const outstandingBefore = Math.max(balance, 0);
      const absolute = Math.abs(amount);
      const credit = amount > 0;
      const nonBanking = move.mode !== "ELECTRONIC";
      const aggregate = credit ? sumMinor([outstandingBefore, absolute], "loan with outstanding") : outstandingBefore;
      const overLimit = credit ? aggregate >= LOAN_LIMIT_MINOR : outstandingBefore >= LOAN_LIMIT_MINOR;
      if (nonBanking && overLimit) {
        const section = credit ? "LOANS_RECEIVED" : "LOANS_REPAID";
        const words = MODE_WORDS[move.mode] || move.mode;
        const ruleHits = [
          hit(credit ? "LOAN_NOT_THROUGH_BANK" : "REPAYMENT_NOT_THROUGH_BANK",
            credit
              ? `${formatRupees(absolute)} was taken from ${lender.name} on ${move.voucher.date} ${words}. With ${formatRupees(outstandingBefore)} already outstanding that is ${formatRupees(aggregate)}, at or above the Rs 20,000 in section 269SS.`
              : `${formatRupees(absolute)} was repaid to ${lender.name} on ${move.voucher.date} ${words}, while ${formatRupees(outstandingBefore)} was outstanding, at or above the Rs 20,000 in section 269T.`,
            LOAN_LIMIT_MINOR),
        ];
        if (move.mode === "INSTRUMENT") ruleHits.push(hit("ACCOUNT_PAYEE_UNKNOWN", "A cheque or draft counts only if it was account payee. The books do not show the crossing; check the instrument."));
        if (move.mode === "UNKNOWN_BANK") ruleHits.push(hit("CHANNEL_UNKNOWN", "The voucher touches a bank ledger but gives no transaction type. Check the bank statement for how it moved."));
        if (move.mode === "MIXED_CASH") ruleHits.push(hit("PART_CASH_SHARE", "Part of this voucher was cash and part bank; the cash is shared across the entries on this side in proportion."));
        if (lender.standardGroup === "LOANS_SECURED" || /\bbank\b/.test(norm(lender.name))) ruleHits.push(hit("HINT_BANK_LENDER", "A loan from a bank is outside these sections. If this lender is a bank, answer 'exempt' and set it as not a lender."));
        loanFindings.push({ date: move.voucher.date, party: norm(lender.name), order: move.order, row: makeRow({
          section,
          identity: `${section}|${move.voucher.guid || move.voucher._id}|${key}|${move.order}`,
          label: `${move.voucher.date}: ${lender.name}`,
          values: {
            date: move.voucher.date,
            party: lender.name,
            pan: lender.pan || "",
            amountMinor: absolute,
            cashMinor: move.split.cashMinor,
            mode: move.mode,
            outstandingBeforeMinor: outstandingBefore,
            outstandingAfterMinor: Math.max(balance + amount, 0),
            voucherNumber: move.voucher.number || "",
            lines: [
              { label: "Date", value: move.voucher.date, kind: "text" },
              { label: credit ? "Taken from" : "Repaid to", value: lender.name, kind: "text" },
              { label: "Amount", value: absolute, kind: "money" },
              { label: "How it moved", value: words, kind: "text" },
              { label: "Outstanding before", value: outstandingBefore, kind: "money" },
              { label: "Voucher", value: move.voucher.number || "", kind: "text" },
            ],
            choices: LOAN_CHOICES,
          },
          ruleHits,
          state: "COMPUTED",
          sources: [voucherSource(snapshotId, move.voucher)],
        }) });
      }
      balance = sumMinor([balance, amount], "lender balance");
      if (credit) taken = sumMinor([taken, absolute], "taken");
      else repaid = sumMinor([repaid, absolute], "repaid");
      highest = Math.max(highest, balance);
    }
    summaries.push({ lender, opening, taken, repaid, closing: balance, highest, ordered });
  }
  // Findings in date order, whichever lender they belong to.
  loanFindings.sort((a, b) => a.date.localeCompare(b.date) || a.party.localeCompare(b.party) || a.order - b.order);
  for (const f of loanFindings) rows.push(f.row);
  for (const s of summaries) {
    const squaredUp = s.closing === 0 && (s.opening ?? 0) + s.taken > 0;
    rows.push(makeRow({
      section: "LENDERS",
      identity: `lender|${norm(s.lender.name)}`,
      label: s.lender.name,
      values: {
        party: s.lender.name,
        pan: s.lender.pan || "",
        openingMinor: s.opening,
        takenMinor: s.taken,
        repaidMinor: s.repaid,
        closingMinor: s.closing,
        highestMinor: s.highest,
        squaredUp,
        amountMinor: null,
        lines: [
          { label: "Opening balance", value: s.opening, kind: "money" },
          { label: "Taken in the year", value: s.taken, kind: "money" },
          { label: "Repaid in the year", value: s.repaid, kind: "money" },
          { label: "Closing balance", value: s.closing, kind: "money" },
          { label: "Highest balance at any time", value: s.highest, kind: "money" },
          { label: "Squared up in the year", value: squaredUp ? "Yes" : "No", kind: "text" },
        ],
        choices: [],
      },
      ruleHits: s.opening === null ? [hit("OPENING_NOT_GIVEN", "The export gives no opening balance for this ledger (Tally leaves the tag out when it is nil), so it is read as nil. If it was not nil, the highest balance is understated.")] : [],
      state: "COMPUTED",
      sources: s.ordered.map((m) => voucherSource(snapshotId, m.voucher)),
      // A summary of the account, worked out from its vouchers: evidence is kept, nothing to decide.
      derived: true,
    }));
  }

  // ─── 269ST ──────────────────────────────────────────────────────────────────
  const ordered = [...receipts.values()].sort((a, b) => a.date.localeCompare(b.date) || norm(a.name).localeCompare(norm(b.name)));
  for (const day of ordered) {
    const dayLimb = day.cashMinor >= RECEIPT_LIMIT_MINOR;
    const singleLimb = day.largestMinor >= RECEIPT_LIMIT_MINOR;
    if (!dayLimb && !singleLimb) continue;
    const ledger = index.get(norm(day.name));
    const ruleHits = [
      hit("CASH_RECEIPT_OVER_LIMIT", `Cash received from ${day.name} on ${day.date} totals ${formatRupees(day.cashMinor)}${singleLimb ? `, and ${formatRupees(day.largestMinor)} was in a single transaction` : ""}; section 269ST is Rs 2,00,000 or more.`, RECEIPT_LIMIT_MINOR),
      hit("LIMBS", `In one day: ${dayLimb ? "yes" : "no"}. In a single transaction: ${singleLimb ? "yes" : "no"}. One event or occasion: for you to say.`),
    ];
    if (LENDER_GROUP_CODES.has(day.group)) ruleHits.push(hit("ALSO_269SS", "This is a loan account; the receipt is also tested under section 269SS above."));
    if (day.group === "DUTIES_TAXES") ruleHits.push(hit("HINT_GOVERNMENT", "A refund from the Government is not a receipt from a person."));
    rows.push(makeRow({
      section: "RECEIPTS_269ST",
      identity: `receipt|${day.date}|${norm(day.name)}`,
      label: `${day.date}: ${day.name}`,
      values: {
        date: day.date,
        party: day.name,
        pan: ledger?.pan || "",
        payerGroup: day.group,
        amountMinor: day.cashMinor,
        largestMinor: day.largestMinor,
        dayLimb,
        singleLimb,
        voucherCount: day.vouchers.length,
        lines: [
          { label: "Date", value: day.date, kind: "text" },
          { label: "Received from", value: day.name, kind: "text" },
          { label: "Cash received that day", value: day.cashMinor, kind: "money" },
          { label: "Largest single receipt", value: day.largestMinor, kind: "money" },
          { label: "Over the limit in", value: [dayLimb ? "one day" : "", singleLimb ? "a single transaction" : ""].filter(Boolean).join(" and "), kind: "text" },
        ],
        choices: RECEIPT_CHOICES,
      },
      ruleHits,
      state: "COMPUTED",
      sources: day.vouchers.map((v) => voucherSource(snapshotId, v)),
    }));
  }

  // ─── what could not be checked ─────────────────────────────────────────────────
  if (lenders.size === 0) {
    rows.push(makeRow({
      section: "INPUT_GAPS",
      identity: "gap:no-lenders",
      label: "No lender or depositor account was found",
      values: { amountMinor: null },
      ruleHits: [hit("NO_LENDER_ACCOUNTS", "No ledger resolves to a Loans group and no party is confirmed as a lender, so sections 269SS and 269T could not be checked. Map the loan groups, or confirm the company took no loans or deposits.")],
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
      ruleHits: [hit("UNREADABLE_VOUCHERS", `${unreadable} voucher(s) that touch cash or a lender account have a date or an amount the export did not give clearly. They are not counted.`)],
      state: "PENDING_INPUT",
      derived: true,
    }));
  }
  return { rows };
}
