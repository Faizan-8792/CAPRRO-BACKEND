// src/models/AiDraft.js
//
// W11 IN5 (2026-10-21): one model-drafted suggestion for one thing a person is looking at - a reconciliation
// item's likely cause, a chase-message template, a column mapping, a TDS check's reviewer note. Kept so that:
//   - the same question asked again (same task, prompt version and facts) is answered from here, not paid twice;
//   - what the person did with it (adopted unchanged, edited, discarded) can be counted, which is how the plan
//     decides whether a feature's model half stays (INTELLIGENCE-PLAN-2026-10-21.md section 10.3);
//   - what was drafted is on record beside what was adopted.
// It never holds a name, GSTIN, PAN or invoice number: the facts sent are shapes and counts, and the output is
// either free of them or carries {{slots}} the server fills when it answers. A draft nobody adopted expires
// after 30 days (PLAN.md section 33.6); an adopted one is kept as long as the firm keeps its records.

import mongoose from "mongoose";

export const AI_DRAFT_RETENTION_DAYS = 30;
export const AI_DRAFT_OUTCOMES = Object.freeze(["PENDING", "ADOPTED_UNCHANGED", "EDITED", "DISCARDED"]);

const AiDraftSchema = new mongoose.Schema(
  {
    firmId: { type: mongoose.Schema.Types.ObjectId, ref: "Firm", required: true, immutable: true, index: true },
    task: { type: String, required: true, trim: true, maxlength: 40, immutable: true },
    promptVersion: { type: String, required: true, trim: true, maxlength: 60, immutable: true },
    // sha-256 of the canonical facts for this one unit. Same task + version + hash = same question.
    inputHash: { type: String, required: true, match: /^[a-f0-9]{64}$/, immutable: true },
    subject: {
      kind: { type: String, trim: true, maxlength: 40, default: "" },
      id: { type: String, trim: true, maxlength: 200, default: "" },
    },
    // The validated answer, in slot form. Shape depends on the task; never contains anything the facts did not.
    output: { type: mongoose.Schema.Types.Mixed, required: true },
    abstained: { type: Boolean, default: false },
    model: { type: String, trim: true, maxlength: 60, default: "" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    outcome: { type: String, enum: AI_DRAFT_OUTCOMES, default: "PENDING" },
    outcomeAt: { type: Date, default: null },
    outcomeBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    // TTL: set 30 days out at creation, cleared when the draft is adopted (edited or not).
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true },
);

AiDraftSchema.index(
  { firmId: 1, task: 1, promptVersion: 1, inputHash: 1 },
  { unique: true, name: "unique_ai_draft_question" },
);
AiDraftSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "ai_draft_ttl" });

export default mongoose.model("AiDraft", AiDraftSchema);
