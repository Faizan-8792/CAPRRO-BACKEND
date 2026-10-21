// src/services/ai/tasks/tds-action-draft.js
//
// W11 IN18: a reviewer note and a chase message for one TDS health check, from what the check computed: its
// status and plain label, dimension, severity, section label, period, whether the difference is a shortfall or
// an excess, and the fixed correction checklist for that status (tds-action-checklists.js). No PAN, no name and
// no amount is sent; the chase message uses {{slots}} the server fills. Nothing is stored on the check: the
// drafts land in the action-plan preview, and only the existing commit stores what a person keeps.

import { fail, readFreeText, digitTokensIn } from "../ai-validate.js";

export const TDS_CHASE_SLOTS = Object.freeze(["deductee", "client", "period", "amount", "section", "sender"]);

export default {
  name: "tds_action_draft",
  operation: "tds_action_draft",
  surface: "tds_action",
  promptVersion: "tds-action-v1",
  batchSize: 10,
  maxUnits: 30,
  temperature: 0.2,
  timeoutMs: 25000,
  maxTokensFor: (count) => Math.min(4000, 200 + count * 330),
  system: [
    "Task: for one defect found in a client's TDS records, draft two things for a chartered accountant's office.",
    "1. reviewerNote: one to three sentences for the reviewer: what the check found and what to verify before acting. Plain words, no numbers.",
    "2. chaseMessage: a short, courteous message to the client asking for what is needed to fix it, or empty when the fix is entirely the office's own work.",
    "Placeholders you may use in chaseMessage: {{client}}, {{deductee}}, {{period}}, {{amount}}, {{section}}, {{sender}}.",
    "Do not compute interest, fees or penalties, and do not say what the law requires beyond the checklist given.",
  ].join("\n"),
  instructions: [
    'Answer as {"items":[{"id":"<the item id>","cannotTell":false,"reviewerNote":"<text>","chaseMessage":"<text or empty>"}]}.',
    "Set cannotTell to true, with both texts empty, when the facts are not enough to say anything useful.",
  ].join("\n"),
  validate(item, facts) {
    if (typeof item.cannotTell !== "boolean") fail("cannotTell is not true or false");
    if (item.cannotTell) return { output: { reviewerNote: "", chaseMessage: "" }, abstained: true };
    // Every string the server sent may be repeated (the status label says "ITNS 281", the section "194J"); an
    // amount never reaches the model as text, so it cannot be repeated.
    const allowedTokens = digitTokensIn(facts);
    const reviewerNote = readFreeText(item.reviewerNote, { max: 600, allowedTokens, label: "reviewerNote" });
    const chaseMessage = readFreeText(item.chaseMessage, {
      max: 1000,
      slots: TDS_CHASE_SLOTS,
      allowedTokens,
      label: "chaseMessage",
      required: false,
    });
    return { output: { reviewerNote, chaseMessage }, abstained: false };
  },
};
