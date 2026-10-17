// src/services/audit-pack-kinds/clause26.kind.js
//
// W10 AP24 (2026-10-17): Form 3CD clause 26 with section 43B(a)-(d) and clause 20(b), statutory dues
// payable at the year end, as a pack. The rules and arithmetic are clause26.engine.js; this file is the
// request it accepts and the columns of its filing sheet.

import { CHOICES, CLAUSE26_RULE_VERSION, buildClause26Rows } from "../audit-pack-engine/clause26.engine.js";
import { defineFindingKind } from "./finding-kind.js";
import { dateDayInput, paymentsListInput } from "./inputs.js";

const NATURE = Object.freeze({
  PROVIDENT_FUND: "Provident fund",
  ESI: "Employees' state insurance",
  PROFESSIONAL_TAX: "Professional tax / labour welfare",
  GST: "GST / duty / cess",
  TDS: "Tax deducted at source",
  INCOME_TAX: "Income tax / advance tax / MAT",
  DUTIES_TAXES_GROUP: "Statutory due (by group)",
});

export const clause26Kind = defineFindingKind({
  kind: "CLAUSE26",
  label: "Form 3CD clause 26 / section 43B(a)-(d) and clause 20(b): statutory dues payable at the year end",
  ruleVersion: CLAUSE26_RULE_VERSION,
  sections: [
    { code: "DUES_OUTSTANDING", label: "Dues payable at 31 March" },
    { code: "PF_ESI_MONTHS", label: "Provident fund and ESI, month by month" },
    { code: "INPUT_GAPS", label: "What could not be checked" },
  ],
  extraCreateFields: ["nextYearPayments", "returnDueDay"],
  extraInputs: [
    paymentsListInput("nextYearPayments", "Payments made after the year end", "Optional. Payments from 1 April to the return due date, one per line. Without them a due at the year end is shown as not checked, never as unpaid."),
    dateDayInput("returnDueDay", "Due date of the return of income", "Needed when payments are listed: the date the return is due under section 139(1)."),
  ],

  prepareParams(input, { httpError }) {
    const day = input.returnDueDay ?? null;
    if (day !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(day))) {
      throw httpError(400, "returnDueDay must be the yyyy-mm-dd date the return is due under section 139(1).", "AUDIT_PACK_SOURCE_REFUSED");
    }
    const list = input.nextYearPayments ?? null;
    if (list === null) return { returnDueDay: day, nextYearPayments: null };
    if (!Array.isArray(list) || list.length > 500 || list.length === 0) {
      throw httpError(400, "nextYearPayments is the list of payments made after the year end (ledger, date, amount), no more than five hundred of them.", "AUDIT_PACK_SOURCE_REFUSED");
    }
    const clean = list.map((p) => {
      if (!p || typeof p.ledger !== "string" || !p.ledger.trim() || p.ledger.length > 300) {
        throw httpError(400, "Each next-year payment names a ledger (at most 300 characters).", "AUDIT_PACK_SOURCE_REFUSED");
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(p.date || ""))) {
        throw httpError(400, `The payment for ${p.ledger} needs a yyyy-mm-dd date.`, "AUDIT_PACK_SOURCE_REFUSED");
      }
      if (!Number.isSafeInteger(p.amountMinor) || p.amountMinor === 0) {
        throw httpError(400, `The payment for ${p.ledger} must be integer paise (not zero).`, "AUDIT_PACK_SOURCE_REFUSED");
      }
      return { ledger: p.ledger.trim(), date: String(p.date), amountMinor: p.amountMinor };
    });
    if (!day) {
      throw httpError(400, "returnDueDay is required with nextYearPayments: the date the return is due under section 139(1).", "AUDIT_PACK_SOURCE_REFUSED");
    }
    return { returnDueDay: day, nextYearPayments: clean };
  },

  async build({ financialYear, masters, vouchers, snapshot, params }) {
    return buildClause26Rows({ financialYear, snapshotId: String(snapshot._id), ledgers: masters.ledgers, vouchers: vouchers(), params });
  },

  reportChoices: ["REPORT"],
  filingColumns: [
    { header: "Ledger", width: 40, cell: (r) => r.values.ledger },
    { header: "Nature of the due", width: 26, cell: (r) => NATURE[r.values.matchedRule] || r.values.matchedRule },
    { header: "Opening balance", width: 18, cell: (r) => ({ money: Number.isSafeInteger(r.values.openingMinor) ? r.values.openingMinor : null }) },
    { header: "Accrued in the year", width: 18, cell: (r) => ({ money: r.values.accruedMinor }) },
    { header: "Paid in the year", width: 18, cell: (r) => ({ money: r.values.paidInYearMinor }) },
    { header: "Payable at 31 March", width: 18, cell: (r) => ({ money: r.values.closingMinor }) },
    { header: `Balance on the return's due date`, width: 22, cell: (r) => (Number.isSafeInteger(r.values.carriedForwardMinor) ? { money: r.values.carriedForwardMinor } : "Not loaded - unknown, never read as not paid") },
  ],
  choiceWords: Object.fromEntries(Object.values(CHOICES).map((c) => [c.value, c.label])),
  filePrefix: "clause-26",
  readMe: [
    ["What this is", "Statutory dues - provident fund, ESI, professional tax, GST, TDS, income tax - still payable at 31 March, which section 43B(a) to (d) allows only in the year of payment. Each is a candidate: you decide whether it is reported."],
    ["How a due is found", "By the ledger's name (provident fund, ESI, professional tax, GST, TDS, income tax patterns, in that order) or, when no name matches, by sitting in the Duties-and-Taxes group. The rule that matched is on every row."],
    ["The year-end balance", "Opening balance plus the year's accruals less the year's payments, from the day book. A ledger whose opening balance the export left out is read as nil and says so on its row."],
    ["After 31 March", "Payments between 1 April and the return's due date under section 139(1) are next-year vouchers or the bank statement. Until you type them in (ledger, date, amount), what each due came to on that date is unknown - it is never shown as not paid, and the pack stays provisional."],
    ["Provident fund and ESI months", "Each month's contribution is due by the 15th of the following month. The books do not say which month a challan settled, so payments are applied to the months in order and every month row says so."],
    ["Not computed", "The proviso to section 43B (payment before the return was due) is your answer on each row, not something the day book can prove."],
  ],
});
