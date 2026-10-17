// src/services/audit-pack-kinds/clause31.kind.js
//
// W10 AP25 (2026-10-17): Form 3CD clause 31, loans, deposits and cash receipts that sections 269SS, 269T and
// 269ST require to go through a bank, as a pack. The rules and arithmetic are clause31.engine.js.

import BooksParty from "../../models/BooksParty.js";
import { CLAUSE31_RULE_VERSION, LOAN_CHOICES, RECEIPT_CHOICES, buildClause31Rows } from "../audit-pack-engine/clause31.engine.js";
import { defineFindingKind } from "./finding-kind.js";

const NATURE = Object.freeze({ LOANS_RECEIVED: "Loan or deposit taken", LOANS_REPAID: "Loan or deposit repaid", RECEIPTS_269ST: "Cash receipt" });
const MODE = Object.freeze({
  CASH: "Cash",
  MIXED_CASH: "Part cash",
  NON_BANKING: "Journal or set-off",
  INSTRUMENT: "Cheque or draft (account payee not shown)",
  CASH_AT_BANK: "Cash at the bank",
  UNKNOWN_BANK: "Bank (channel not shown)",
});

export const clause31Kind = defineFindingKind({
  kind: "CLAUSE31",
  label: "Form 3CD clause 31: loans, deposits and cash receipts (sections 269SS, 269T, 269ST)",
  ruleVersion: CLAUSE31_RULE_VERSION,
  sections: [
    { code: "LOANS_RECEIVED", label: "Loans and deposits taken" },
    { code: "LOANS_REPAID", label: "Repayments" },
    { code: "RECEIPTS_269ST", label: "Cash receipts of Rs 2,00,000 or more" },
    { code: "LENDERS", label: "Lender accounts for the year" },
    { code: "INPUT_GAPS", label: "What could not be checked" },
  ],

  async build({ financialYear, masters, vouchers, snapshot }) {
    const parties = await BooksParty.find({ firmId: snapshot.firmId, clientId: snapshot.clientId }).select("nameKey lenderOrDepositor").lean();
    const partyFlags = new Map(parties.map((p) => [p.nameKey, { lenderOrDepositor: p.lenderOrDepositor }]));
    return buildClause31Rows({ financialYear, snapshotId: String(snapshot._id), ledgers: masters.ledgers, vouchers: vouchers(), partyFlags });
  },

  reportChoices: ["REPORT", "ONE_EVENT_AGGREGATE"],
  filingColumns: [
    { header: "Nature", width: 24, cell: (r) => NATURE[r.section] || r.section },
    { header: "Date", width: 14, cell: (r) => r.values.date },
    { header: "Name of the lender, depositor or payer", width: 40, cell: (r) => r.values.party },
    { header: "PAN", width: 14, cell: (r) => r.values.pan || "Not in the books" },
    { header: "Amount", width: 20, cell: (r) => ({ money: r.values.amountMinor }) },
    { header: "How it moved", width: 38, cell: (r) => MODE[r.values.mode] || (r.section === "RECEIPTS_269ST" ? "Cash" : "") },
    { header: "Outstanding before", width: 20, cell: (r) => ({ money: r.values.outstandingBeforeMinor ?? null }) },
    { header: "Voucher", width: 16, cell: (r) => r.values.voucherNumber || "" },
  ],
  choiceWords: Object.fromEntries([...LOAN_CHOICES, ...RECEIPT_CHOICES].map((c) => [c.value, c.label])),
  filePrefix: "clause-31",
  readMe: [
    ["What this is", "Loans and deposits taken or repaid, and cash receipts of Rs 2,00,000 or more, that did not go through a bank, found in the day book. Each is a candidate for you to answer."],
    ["Lender accounts", "A ledger in a Loans group, or one you have confirmed as a lender. Set a bank loan as not a lender so it is left out. The Lender accounts sheet rows give the opening, taken, repaid, closing and highest balance, and whether the account was squared up."],
    ["Account payee", "The books do not show whether a cheque was account payee. A cheque or draft is listed with that question put to you."],
    ["One event or occasion", "The third limb of section 269ST needs you to say which receipts belong to one event. Use the answer 'Report it, with the other receipts for the same event' and say which in the note."],
    ["Limits", "Rs 20,000 with what is already outstanding (269SS, 269T); Rs 2,00,000 in a day or in a single transaction (269ST). Statutory, fixed by the rule version."],
  ],
});
