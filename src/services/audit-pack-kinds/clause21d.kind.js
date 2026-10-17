// src/services/audit-pack-kinds/clause21d.kind.js
//
// W10 AP22 (2026-10-17): Form 3CD clause 21(d), cash payments above the section 40A(3) limit, as a pack. The
// rule and the arithmetic are clause21d.engine.js; this file is the request it accepts and the columns of its
// filing sheet.

import { CHOICES, CLAUSE21D_RULE_VERSION, buildClause21dRows, formatRupees } from "../audit-pack-engine/clause21d.engine.js";
import { defineFindingKind } from "./finding-kind.js";

export const clause21dKind = defineFindingKind({
  kind: "CLAUSE21D",
  label: "Form 3CD clause 21(d): cash payments above the limit (section 40A(3))",
  ruleVersion: CLAUSE21D_RULE_VERSION,
  sections: [
    { code: "CASH_PAYMENTS", label: "Cash payments over the limit" },
    { code: "INPUT_GAPS", label: "What could not be checked" },
  ],
  extraCreateFields: ["transporterLedgers"],

  prepareParams(input, { httpError }) {
    const list = input.transporterLedgers ?? [];
    if (!Array.isArray(list) || list.length > 200 || list.some((n) => typeof n !== "string" || !n.trim() || n.length > 300)) {
      throw httpError(400, "Name the transporter ledgers as a list of ledger names (at most 200).", "AUDIT_PACK_SOURCE_REFUSED");
    }
    return { transporterLedgers: [...new Set(list.map((n) => n.trim()))].sort() };
  },

  async build({ financialYear, masters, vouchers, params, snapshot }) {
    return buildClause21dRows({
      financialYear,
      snapshotId: String(snapshot._id),
      ledgers: masters.ledgers,
      vouchers: vouchers(),
      params,
    });
  },

  reportChoices: ["REPORT"],
  filingColumns: [
    { header: "Date of payment", width: 16, cell: (r) => r.values.date },
    { header: "Payee", width: 40, cell: (r) => r.values.payee },
    { header: "PAN of the payee", width: 16, cell: (r) => r.values.pan || "Not in the books" },
    { header: "Nature of payee's ledger", width: 26, cell: (r) => (r.values.payeeGroup || "Group not known").replace(/_/g, " ").toLowerCase() },
    { header: "Cash paid that day", width: 20, cell: (r) => ({ money: r.values.amountMinor }) },
    { header: "Limit applied", width: 18, cell: (r) => ({ money: r.values.limitMinor }) },
    { header: "Vouchers", width: 30, cell: (r) => (r.values.voucherNumbers || []).join(", ") },
  ],
  choiceWords: Object.fromEntries(Object.values(CHOICES).map((c) => [c.value, c.label])),
  filePrefix: "clause-21d",
  readMe: [
    ["What this is", "Cash payments to one ledger in one day above Rs 10,000 (Rs 35,000 to a transporter you name), found in the day book. Each is a candidate: you decide whether it is reported or falls in an exception."],
    ["Part-cash vouchers", "Where a voucher is part cash and part bank, the cash is shared across the debited ledgers in proportion to their debits; the books do not say which part paid which."],
    ["Not computed", "Section 40A(3A) (a later-year payment of an expense allowed earlier) and whether a Rule 6DD exception applies."],
    ["Limits used", `${formatRupees(1_000_000)} a day; ${formatRupees(3_500_000)} to a transporter. Statutory, fixed by the rule version.`],
  ],
});
