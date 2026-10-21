// src/services/ai/tasks/gst-cause-residue.js
//
// W11 IN11: the likely cause of a reconciliation item no server rule explained (gst-cause.service.js runs
// first; only what it leaves comes here). The model sees, per item: its status, document type, the books and
// 2B amounts in rupees, the day gap, an invoice-number SHAPE (letters as A, digits as 9 - never the number),
// which rules were tried, and up to five other items of the same supplier described the same way. It never
// sees a name, a GSTIN or an invoice number.
//
// The answer is a cause from a fixed list (or CANNOT_TELL), a disposition from the ones a person could choose
// (or NONE), a reason of at most 300 characters with no number in it, and the facts it relied on.

import { fail, readEnum, readFieldList, readFreeText, digitTokensIn } from "../ai-validate.js";

export const RESIDUE_CAUSES = Object.freeze([
  "SUPPLIER_NOT_FILED",
  "SUPPLIER_FILED_LATE",
  "BOOKED_IN_EARLIER_PERIOD",
  "GSTIN_TYPO",
  "INVOICE_NUMBER_FORMAT",
  "TAX_HEAD_SWAP",
  "GOODS_RECEIPT_DATE_IN_BOOKS",
  "DOCUMENT_TYPE",
  "DUPLICATE_IN_BOOKS",
  "SPLIT_OR_CLUBBED_INVOICE",
  "RATE_ERROR",
  "ROUNDING",
  "CANNOT_TELL",
]);

// What a person could do with the item, as the reconciliation route names it. ACCEPT_MATCH, UNMATCH, ASSIGN
// and ADD_NOTE are left out: they are mechanical choices, not a judgement a cause can suggest.
export const RESIDUE_DISPOSITIONS = Object.freeze([
  "SUPPLIER_FOLLOW_UP",
  "BOOKS_CORRECTION",
  "PORTAL_CORRECTION",
  "MARK_INELIGIBLE",
  "DEFER",
  "ACCEPT_EXCEPTION",
  "NONE",
]);

const FACT_FIELDS = Object.freeze([
  "status",
  "documentType",
  "books",
  "portal",
  "difference",
  "dateGapDays",
  "invoiceShape",
  "rulesTried",
  "sameSupplier",
]);

export default {
  name: "gst_cause_residue",
  operation: "gst_cause_residue",
  surface: "gst_cause",
  promptVersion: "gst-cause-residue-v1",
  batchSize: 20,
  maxUnits: 60,
  temperature: 0,
  timeoutMs: 25000,
  maxTokensFor: (count) => Math.min(4000, 200 + count * 140),
  system: [
    "Task: name the likely reason a purchase invoice in the client's books and the supplier's GSTR-2B data do not agree.",
    "Statuses: MISSING_IN_2B (in books, not in 2B), MISSING_IN_BOOKS (in 2B, not in books), TAX_MISMATCH, TAXABLE_MISMATCH, DATE_MISMATCH, DUPLICATE_IN_BOOKS, POSSIBLE_AMENDMENT and similar.",
    "Amounts are in rupees: taxable, igst, cgst, sgst, cess. invoiceShape replaces letters with A and digits with 9.",
    "sameSupplier lists other items from the same supplier, each with a ref, status, amounts and the day gap to this item.",
    "Causes you may choose: " + RESIDUE_CAUSES.join(", ") + ".",
    "Dispositions you may suggest: " + RESIDUE_DISPOSITIONS.join(", ") + ". Use NONE when unsure.",
    "If cause is CANNOT_TELL, suggestedDisposition must be NONE.",
  ].join("\n"),
  instructions: [
    'Answer as {"items":[{"id":"<the item id>","cause":"<one cause>","suggestedDisposition":"<one disposition>","reason":"<one or two plain sentences, no numbers>","factsUsed":["<field names from: ' +
      FACT_FIELDS.join(", ") +
      '>"],"relatedRef":"<a sameSupplier ref the cause relies on, or empty>"}]}.',
    "Answer every item once. Write the reason so a chartered accountant can check it against the row in a few seconds.",
  ].join("\n"),
  validate(item, facts) {
    const cause = readEnum(item.cause, RESIDUE_CAUSES, "cause");
    let disposition = readEnum(item.suggestedDisposition, RESIDUE_DISPOSITIONS, "suggestedDisposition");
    if (cause === "CANNOT_TELL") disposition = "NONE";
    const reason = readFreeText(item.reason, {
      max: 300,
      allowedTokens: digitTokensIn({ invoiceShape: facts.invoiceShape }),
      label: "reason",
      required: cause !== "CANNOT_TELL",
    });
    const factsUsed = readFieldList(item.factsUsed, FACT_FIELDS, "factsUsed");
    const refs = new Set((facts.sameSupplier || []).map((other) => other.ref));
    const relatedRef = typeof item.relatedRef === "string" ? item.relatedRef.trim() : "";
    if (relatedRef && !refs.has(relatedRef)) fail("relatedRef names an item that was not sent");
    return {
      output: { cause, suggestedDisposition: disposition, reason, factsUsed, relatedRef },
      abstained: cause === "CANNOT_TELL",
    };
  },
};
