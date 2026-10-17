// src/services/audit-pack-kinds/clause22.kind.js
//
// W10 AP23 (2026-10-17): Form 3CD clause 22 with section 43B(h), payments to micro and small enterprise
// suppliers beyond the appointed time and the MSMED Act's interest, as a pack. The rules and arithmetic are
// clause22.engine.js; this file is the request it accepts and the columns of its filing sheet.

import BooksParty from "../../models/BooksParty.js";
import { CHOICES, CLAUSE22_RULE_VERSION, buildClause22Rows } from "../audit-pack-engine/clause22.engine.js";
import { defineFindingKind } from "./finding-kind.js";

const DUE_BASIS = Object.freeze({
  AGREED: "agreed credit period",
  CAPPED_45: "agreed period capped at 45 days",
  DEFAULT_15: "15 days (no agreement found)",
});

export const clause22Kind = defineFindingKind({
  kind: "CLAUSE22",
  label: "Form 3CD clause 22 / section 43B(h): payments to micro and small enterprises beyond the appointed time",
  ruleVersion: CLAUSE22_RULE_VERSION,
  sections: [
    { code: "MSME_LATE", label: "Bills paid beyond the appointed time or unpaid" },
    { code: "SUPPLIERS", label: "Micro and small suppliers for the year" },
    { code: "INPUT_GAPS", label: "What could not be checked" },
  ],
  extraCreateFields: ["bankRates"],

  prepareParams(input, { httpError }) {
    const rates = input.bankRates ?? {};
    if (typeof rates !== "object" || Array.isArray(rates) || Object.keys(rates).length > 4) {
      throw httpError(400, "Supply the bank rate as at most four financial years in basis points, e.g. {\"2025-26\": 625}.", "AUDIT_PACK_SOURCE_REFUSED");
    }
    const clean = {};
    for (const [fy, bps] of Object.entries(rates)) {
      if (!/^\d{4}-\d{2}$/.test(fy) || !Number.isSafeInteger(bps) || bps < 0 || bps > 3000) {
        throw httpError(400, `The bank rate for ${fy || "an unnamed year"} must be whole basis points between 0 and 3000.`, "AUDIT_PACK_SOURCE_REFUSED");
      }
      clean[fy] = bps;
    }
    return { bankRates: clean };
  },

  async build({ financialYear, masters, vouchers, snapshot, params }) {
    const parties = await BooksParty.find({ firmId: snapshot.firmId, clientId: snapshot.clientId }).select("nameKey udyamCategory creditPeriodDays").lean();
    const partyMap = new Map(parties.map((p) => [p.nameKey, { udyamCategory: p.udyamCategory, creditPeriodDays: p.creditPeriodDays }]));
    return buildClause22Rows({ financialYear, snapshotId: String(snapshot._id), ledgers: masters.ledgers, vouchers: vouchers(), parties: partyMap, params });
  },

  reportChoices: ["REPORT"],
  filingColumns: [
    { header: "Supplier", width: 40, cell: (r) => r.values.supplier },
    { header: "PAN of the supplier", width: 16, cell: (r) => r.values.pan || "Not in the books" },
    { header: "Bill / reference", width: 20, cell: (r) => r.values.billName },
    { header: "Accepted on", width: 14, cell: (r) => r.values.acceptanceDate },
    { header: "Appointed time expired on", width: 18, cell: (r) => r.values.dueDate },
    { header: "How the time was set", width: 34, cell: (r) => DUE_BASIS[r.values.dueBasis] || r.values.dueBasis },
    { header: "Paid beyond the appointed time", width: 22, cell: (r) => ({ money: r.values.paidLateMinor }) },
    { header: "Unpaid at the year end", width: 20, cell: (r) => ({ money: r.values.unpaidMinor }) },
    { header: "Interest at three times the bank rate", width: 24, cell: (r) => (Number.isSafeInteger(r.values.interestMinor) ? { money: r.values.interestMinor } : "Unknown - no bank rate supplied") },
  ],
  choiceWords: Object.fromEntries(Object.values(CHOICES).map((c) => [c.value, c.label])),
  filePrefix: "clause-22",
  readMe: [
    ["What this is", "Bills of micro and small enterprise suppliers paid beyond the appointed time, or still unpaid at the year end, with the interest the MSMED Act charges for the delay. Each is a candidate: you decide whether it is reported."],
    ["Who counts", "Only suppliers whose Udyam category is micro or small in the party master. An unknown category is listed as a pending input for that supplier - never read as not-MSME. Medium and non-MSME suppliers are left out and named."],
    ["The appointed time", "The credit period agreed in the books (the party master's answer wins over the bill's), capped at forty-five days from acceptance; with no credit period anywhere, the statutory fifteen days - said on each row."],
    ["How bills settle", "A purchase with a New Ref bill allocation creates the bill; payments with an Agst Ref allocation naming the bill settle it. A debit whose other side was neither cash nor bank is an adjustment (a return or set-off): it reduces the bill but is not a payment."],
    ["The interest", "Three times the RBI bank rate you supply for the year, from the day after the appointed time: each complete 30-day period compounds, a part period accrues day-wise. Without a bank rate the interest is unknown, never nil."],
    ["Not computed", "The proviso to section 43B (payment before the return is due under section 139(1)) is your answer on each row. The clause 26(A) register of prior-year disallowances since paid."],
  ],
});
