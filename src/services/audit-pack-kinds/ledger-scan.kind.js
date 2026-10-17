// src/services/audit-pack-kinds/ledger-scan.kind.js
//
// W10 AP31 (2026-10-17): the ledger scans as a pack. The scans and their thresholds are ledger-scan.engine.js;
// this file is the request it accepts and the columns of its filing sheet.

import { LEDGER_SCAN_RULE_VERSION, SCAN_CHOICES, buildLedgerScanRows } from "../audit-pack-engine/ledger-scan.engine.js";
import { defineFindingKind } from "./finding-kind.js";

const SECTION_WORDS = Object.freeze({
  CASH: "Cash below zero",
  ROUND_SUM: "Round-sum cash",
  DUPLICATES: "Duplicates",
  BENFORD: "First digits (Benford)",
  PERIOD_END: "Period-end and post-close entries",
  WEEKEND: "Sunday movements",
  UNUSUAL: "Unusual account pairs",
  SUSPENSE: "Suspense entries",
  INPUT_GAPS: "What could not be scanned",
});

export const ledgerScanKind = defineFindingKind({
  kind: "LEDGER_SCAN",
  label: "Ledger scans: the day book's oddities, each with the rule that fired",
  ruleVersion: LEDGER_SCAN_RULE_VERSION,
  sections: [
    { code: "CASH", label: "Cash below zero" },
    { code: "ROUND_SUM", label: "Round-sum cash" },
    { code: "DUPLICATES", label: "Duplicates" },
    { code: "BENFORD", label: "First digits (Benford)" },
    { code: "PERIOD_END", label: "Period-end and post-close entries" },
    { code: "WEEKEND", label: "Sunday movements" },
    { code: "UNUSUAL", label: "Unusual account pairs" },
    { code: "SUSPENSE", label: "Suspense entries" },
    { code: "INPUT_GAPS", label: "What could not be scanned" },
  ],

  async build({ financialYear, masters, vouchers, snapshot }) {
    return buildLedgerScanRows({ financialYear, snapshotId: String(snapshot._id), ledgers: masters.ledgers, vouchers: vouchers() });
  },

  reportChoices: ["REPORT"],
  filingColumns: [
    { header: "Scan", width: 26, cell: (r) => SECTION_WORDS[r.section] || r.section },
    { header: "Date", width: 14, cell: (r) => r.values.date || "" },
    { header: "Voucher(s)", width: 22, cell: (r) => r.values.voucherNumber || "" },
    { header: "What it shows", width: 56, cell: (r) => (r.ruleHits || []).map((h) => h.detail).join(" ") },
    { header: "Amount", width: 18, cell: (r) => ({ money: Number.isSafeInteger(r.values.amountMinor) ? r.values.amountMinor : null }) },
  ],
  choiceWords: Object.fromEntries(Object.values(SCAN_CHOICES).map((c) => [c.value, c.label])),
  filePrefix: "ledger-scans",
  readMe: [
    ["What this is", "Mechanical oddities in the day book - cash below zero, round-sum cash, duplicates, the first digits' shape, last-day and after-close entries, Sunday movements, party-to-party set-offs, suspense - each with the rule that fired, its threshold and the voucher behind it. A hit is a question, never a conclusion."],
    ["The thresholds", "Round-sum cash and the Sunday and last-day movements start at Rs 1,00,000, and round-sum means an exact multiple of Rs 10,000. The first-digit test runs only on at least 300 amounts and is measured by the mean absolute deviation from Benford's law. The thresholds are fixed by the rule version on the Read me."],
    ["Who answers", "You do. Report a hit into the working papers, or say why it is expected for this client. Nothing here is a conclusion about anyone."],
    ["Weekends", "The books carry no holiday calendar, so only Sundays are flagged and the row says so."],
    ["Cash below zero", "The day-end balance walks from zero at 1 April within this export; an opening balance is not spread across the days, so a ledger that genuinely opened with cash in hand will not false-positive from it."],
  ],
});
