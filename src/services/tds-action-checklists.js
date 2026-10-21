// src/services/tds-action-checklists.js
//
// W11 IN17 (2026-10-21): the correction checklist for each TDS health check status, one list per status instead of
// one per family. Used by the action plan (tds-health.service.js) while the `intelligence` flag is on; with it off
// the action plan keeps its earlier four-step family lists, unchanged.
//
// These are steps, not conclusions: what to look at and record. No rate, threshold, interest, fee or liability is
// stated (the engine is tds-health-v1-no-rate-engine by design), nothing here says what the law requires, and
// nothing describes a local format check as official verification. The wording carries professional meaning and
// is the owner's to approve before the flag goes on (.kiro/OWNER-TODO.md, W11 item 3).
//
// tds-action-checklists-contract pins that every status in the engine's CHECK_META has a list here, so a new
// check status cannot ship without its steps.

export const TDS_CHECKLIST_VERSION = "tds-checklists-v1";

export const TDS_ACTION_CHECKLISTS = Object.freeze({
  RETURN_NOT_FILED: [
    "Confirm on TRACES or the e-filing portal whether the quarterly statement was filed",
    "If it was filed, record the token number and filing date against this run",
    "If not, collect the deduction and challan details for the quarter and prepare the statement",
    "Reviewer checks the statement against the register before it is filed",
    "Record the filing acknowledgement",
  ],
  RETURN_DUE_SOON: [
    "Confirm the due date for this statement from the reviewed deadline catalogue",
    "Check that the register and challans for the quarter are complete",
    "Assign preparation and review with dates before the due date",
  ],
  DEPOSIT_MISSING: [
    "Ask the client for the ITNS 281 challan counterfoil or bank statement entry for this deduction",
    "Match BSR code, challan date and serial number to the deduction's section and quarter",
    "If no deposit was made, record that for the reviewer before any payment is advised",
    "Record the evidence against this check",
  ],
  SHORT_DEPOSIT_ESTIMATE: [
    "List the deductions and challans mapped to this section and quarter",
    "Look for a challan mapped to a different section or quarter",
    "Reviewer confirms whether the difference is real before any payment is advised",
    "Record the conclusion and the evidence it rests on",
  ],
  EXCESS_DEPOSIT_REVIEW: [
    "Check whether a challan was mapped to the wrong section or quarter",
    "Check whether the excess is meant to be carried to a later quarter",
    "Reviewer confirms the treatment and records it",
  ],
  CHALLAN_UNMAPPED: [
    "Read BSR code, challan date, serial number and amount from the challan",
    "Match it to the deductions of the right section and quarter",
    "If the challan was already used in a filed statement, note it for a correction statement",
    "Record the mapping and who confirmed it",
  ],
  DEDUCTION_NOT_REPORTED: [
    "Compare the register rows with the filed statement for this deductee and section",
    "Confirm whether the deduction belongs to this quarter",
    "Prepare a correction statement adding the missing rows if the reviewer agrees",
    "Record the correction token once filed",
  ],
  REPORTED_NOT_IN_REGISTER: [
    "Ask the client for the register entries behind the reported amount",
    "Check whether the statement reported a deduction twice or under the wrong deductee",
    "Prepare a correction statement if the reviewer agrees the statement is wrong",
    "Record what was found",
  ],
  PAN_MISSING: [
    "Ask the client for the deductee's PAN with supporting evidence",
    "Record the PAN and its source",
    "Reviewer decides whether a correction statement is needed once the PAN is known",
  ],
  PAN_FORMAT_INVALID: [
    "Check the PAN as written in the register against the deductee's documents",
    "Correct the register entry, or record evidence that the PAN as written is right",
    "Reviewer decides whether a correction statement is needed",
  ],
  PAN_PORTAL_VERIFICATION_PENDING: [
    "Run the official PAN check on the portal yourself",
    "Record the result, its source, who checked and when",
    "If the official check fails, keep this check open for the reviewer",
  ],
  CREDIT_MISSING_IN_IMPORTED_26AS: [
    "Download the latest 26AS or TRACES statement for the period",
    "Check whether the credit appears under a different PAN, TAN or section",
    "Follow up with the deductor if the credit is still missing",
    "Record the follow-up and its date",
  ],
  CORRECTION_REQUIRED: [
    "List the rows that need correcting and why",
    "Prepare the correction statement from the original filed statement",
    "Reviewer approves the correction before it is filed",
    "Record the correction acknowledgement and keep the original run",
  ],
  CERTIFICATE_PENDING: [
    "Confirm the quarterly statement for the period is processed",
    "Generate Form 16 or 16A from TRACES for the deductees concerned",
    "Issue the certificates and record when and how each was issued",
  ],
  NEEDS_PROFESSIONAL_REVIEW: [
    "Open the source rows linked to this check",
    "Reviewer decides the treatment and records the reasoning",
    "Create any follow-up the reviewer asks for",
  ],
});

/** The steps for a status, or null when this file has no list for it (the caller keeps its own). */
export function checklistForTdsStatus(status) {
  const steps = TDS_ACTION_CHECKLISTS[status];
  return steps ? [...steps] : null;
}
