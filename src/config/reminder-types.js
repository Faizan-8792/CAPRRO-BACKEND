// The compliance activities a reminder can be for, in the words a person reads.
//
// A reminder stores only its type's id. The extension offers exactly these twenty when a reminder is
// set (audit-nlp-extension/reminder-types.js, same ids and labels), so everything the server
// writes for a person names the activity from here - the compliance calendar's title, the reminder
// email - never from the id itself. Found while recording the tutorials (2026-10-13): the calendar
// read "Tax Audit 3cd" and "Mca Aoc4", and the email's subject "Compliance Reminder: TAX_AUDIT_3CD".

export const REMINDER_TYPE_LABELS = Object.freeze({
  GST_GSTR1: "GST: GSTR-1 filing",
  GST_GSTR3B: "GST: GSTR-3B filing",
  GST_CMP08: "GST: CMP-08 (Composition)",
  GST_GSTR9: "GST: GSTR-9 (Annual return)",
  GST_GSTR9C: "GST: GSTR-9C (Reconciliation)",
  TDS_PAYMENT: "TDS: Monthly payment",
  TDS_RETURN_24Q: "TDS: Return 24Q (Quarterly)",
  TDS_RETURN_26Q: "TDS: Return 26Q (Quarterly)",
  TDS_RETURN_27Q: "TDS: Return 27Q (Quarterly)",
  TDS_FORM16: "TDS: Form 16 issuance",
  TDS_FORM16A: "TDS: Form 16A issuance",
  IT_ADV_TAX: "Income Tax: Advance tax installment",
  IT_ITR_NON_AUDIT: "Income Tax: ITR (Non-audit)",
  IT_ITR_AUDIT: "Income Tax: ITR (Audit cases)",
  TAX_AUDIT_3CD: "Tax Audit: 3CD / Audit report",
  MCA_DIR3KYC: "MCA/ROC: DIR-3 KYC",
  MCA_AOC4: "MCA/ROC: AOC-4",
  MCA_MGT7: "MCA/ROC: MGT-7 / 7A",
  MCA_DPT3: "MCA/ROC: DPT-3",
  PF_ESI_MONTHLY: "Payroll: PF/ESI monthly",
  // Written by the server itself: case-deadline.service.js, when a case's response due date is
  // confirmed; GENERIC, a reminder saved with no type.
  CASE_RESPONSE_DUE: "Notice case: response due",
  GENERIC: "Reminder",
});

// Abbreviations kept in capitals when an id outside the list (a compliance rule's code, a newer
// client's type) is turned into words.
const ACRONYMS = new Set(["GST", "GSTR", "TDS", "TCS", "ITR", "IT", "MCA", "ROC", "PF", "ESI", "DIR", "KYC", "CMP", "AOC", "MGT", "DPT", "PAN", "TAN", "LLP", "CSR", "UDIN"]);

export function reminderTypeLabel(typeId) {
  const id = String(typeId || "").trim();
  if (Object.prototype.hasOwnProperty.call(REMINDER_TYPE_LABELS, id)) return REMINDER_TYPE_LABELS[id];
  return readableCode(id) || "Reminder";
}

// An id turned into words for a person: "TDS_RETURN_26Q" reads "TDS return 26Q", where a plain
// title-casing read "Tds Return 26q". A form or section number (3CD, 26Q, 9C) and a known
// abbreviation stay as they are written. Empty for an empty id.
export function readableCode(value) {
  const words = String(value || "").trim().split(/[_\s-]+/).filter(Boolean);
  return words
    .map((word, index) => {
      const upper = word.toUpperCase();
      if (/\d/.test(word) || ACRONYMS.has(upper)) return upper;
      const lower = word.toLowerCase();
      return index === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(" ");
}
