// src/services/audit-pack-kinds/ageing.kind.js
//
// W10 AP27 (2026-10-17): the Schedule III ageing schedules - trade receivables, trade payables (micro, small and
// medium enterprises apart from the rest) and capital work in progress - as a pack. The rules and arithmetic are
// ageing.engine.js; this file is the request it accepts and the columns of its filing sheet.

import BooksParty from "../../models/BooksParty.js";
import { AGEING_RULE_VERSION, BUCKETS, PAYABLE_CHOICES, RECEIVABLE_CHOICES, buildAgeingRows } from "../audit-pack-engine/ageing.engine.js";
import { collect, norm } from "../audit-pack-engine/voucher-kit.js";
import { defineFindingKind, previousFinancialYear } from "./finding-kind.js";

const SECTION_WORDS = Object.freeze({
  RECEIVABLES: "Trade receivables",
  PAYABLES_MSME: "Trade payables: micro, small and medium",
  PAYABLES_OTHERS: "Trade payables: others",
});

// A day book can run to a hundred thousand vouchers; only those that touch a debtor, a creditor or a work-in-progress
// ledger can matter here, and they are held (the bills are settled in date order) up to this many.
const MAX_HELD_VOUCHERS = 300_000;

function keysOf(ledgers) {
  return new Set(
    ledgers
      .filter((l) => ["SUNDRY_DEBTORS", "SUNDRY_CREDITORS"].includes(l.standardGroup) || (l.standardGroup === "FIXED_ASSETS" && /capital\s*work[\s-]*in[\s-]*progress|\bcwip\b|under\s*development/i.test(l.name || "")))
      .map((l) => norm(l.name)),
  );
}

async function heldVouchers(stream, keys) {
  const kept = [];
  for await (const voucher of stream) {
    if (!(voucher.entries || []).some((e) => keys.has(norm(e.ledger)))) continue;
    kept.push(voucher);
    if (kept.length > MAX_HELD_VOUCHERS) {
      throw Object.assign(new Error(`This day book has more than ${MAX_HELD_VOUCHERS} vouchers on debtor and creditor ledgers; the ageing reads at most that many.`), { statusCode: 413, code: "AUDIT_PACK_TOO_LARGE" });
    }
  }
  return kept;
}

export const ageingKind = defineFindingKind({
  kind: "SCHEDULE3_AGEING",
  label: "Schedule III ageing: trade receivables, trade payables and capital work in progress",
  ruleVersion: AGEING_RULE_VERSION,
  optionalPrior: true,
  sections: [
    { code: "RECEIVABLES", label: "Trade receivables" },
    { code: "PAYABLES_MSME", label: "Trade payables: micro, small and medium enterprises" },
    { code: "PAYABLES_OTHERS", label: "Trade payables: others" },
    { code: "CWIP", label: "Capital work in progress" },
    { code: "INPUT_GAPS", label: "What could not be placed" },
  ],

  async build({ financialYear, masters, vouchers, priorVouchers, snapshot, params }) {
    const parties = await BooksParty.find({ firmId: snapshot.firmId, clientId: snapshot.clientId }).select("nameKey udyamCategory").lean();
    const partyMap = new Map(parties.map((p) => [p.nameKey, { udyamCategory: p.udyamCategory }]));
    const keys = keysOf(masters.ledgers);
    const current = await heldVouchers(vouchers(), keys);
    const prior = priorVouchers ? await heldVouchers(priorVouchers(), keys) : null;
    return buildAgeingRows({
      financialYear,
      snapshotId: String(snapshot._id),
      ledgers: masters.ledgers,
      vouchers: current,
      priorVouchers: prior,
      priorFinancialYear: prior ? previousFinancialYear(financialYear) : null,
      parties: partyMap,
    });
  },

  reportChoices: [...RECEIVABLE_CHOICES, ...PAYABLE_CHOICES].map((c) => c.value),
  filingColumns: [
    { header: "Schedule", width: 36, cell: (r) => SECTION_WORDS[r.section] || r.section },
    { header: "Party", width: 40, cell: (r) => r.values.party },
    { header: "Your classification", width: 34, cell: (r) => r.choice },
    ...BUCKETS.map((b) => ({ header: b.label, width: 20, cell: (r) => ({ money: r.values.buckets?.[b.code] ?? null }) })),
    { header: "Outstanding in bills", width: 22, cell: (r) => ({ money: r.values.amountMinor }) },
    { header: "Bills aged from the due date / the bill date", width: 30, cell: (r) => `${r.values.billsAgedFromDueDate ?? 0} / ${r.values.billsAgedFromBillDate ?? 0}` },
  ],
  choiceWords: Object.fromEntries([...RECEIVABLE_CHOICES, ...PAYABLE_CHOICES].map((c) => [c.value, c.label])),
  filePrefix: "schedule-iii-ageing",
  readMe: [
    ["What this is", "The balances of the year's debtors and creditors in the columns Schedule III asks for, from the bills in the day book. Each party is a row for you to classify."],
    ["The basis", "Each bill is aged from its due date of payment (the bill date plus the credit period the books give) and from the bill date where the books give no credit period, as Schedule III allows. The last day of the year is the day aged to."],
    ["The columns", "Not due; under six months; six months to one year; one to two years; two to three years; over three years. A bill exactly 180, 365, 730 or 1,095 days past its basis date is in the later column."],
    ["Balances brought forward", "The export has no bill-wise opening balances. What is in no bill is shown as a gap, never spread over the columns. Read the previous year's books as the prior-year snapshot to trace it to its bills."],
    ["Micro, small and medium", "A creditor is under micro, small and medium enterprises only where its Udyam category has been answered as one; a creditor with no answer is a gap."],
    ["Capital work in progress", "Schedule III ages it by project. The books do not carry projects, so its movement is shown and the ageing is for you to give."],
    ["Not decided here", "Disputed and considered-doubtful are your answers; the books do not say."],
  ],
});
