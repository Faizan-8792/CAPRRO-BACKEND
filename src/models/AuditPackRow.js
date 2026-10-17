// src/models/AuditPackRow.js
//
// W10 AP8 (2026-10-15): one row of an audit pack - a ledger, a supplier or a tie-out - as the engine
// computed it (values, the rules that fired, the source rows behind it) plus the decision a person
// made about it. The decision is version-fenced: a write names the version it read, and a stale one
// is refused rather than overwriting somebody else's decision.

import mongoose from "mongoose";

const AUDIT_PACK_ROW_SECTIONS = Object.freeze(["LEDGER", "SUPPLIER", "TIEOUT", "MONTHLY", "TURNOVER", "ITC"]);
const AUDIT_PACK_ROW_STATES = Object.freeze(["COMPUTED", "CONFIRMED", "EXCLUDED", "PENDING_INPUT"]);
const AUDIT_PACK_DECISION_STATES = Object.freeze(["CONFIRMED", "EXCLUDED"]);

const RuleHitSchema = new mongoose.Schema(
  {
    rule: { type: String, required: true, trim: true, maxlength: 80 },
    threshold: { type: mongoose.Schema.Types.Mixed, default: null },
    detail: { type: String, trim: true, maxlength: 600, default: "" },
  },
  { _id: false },
);

const SourceRowSchema = new mongoose.Schema(
  {
    kind: { type: String, required: true, trim: true, maxlength: 40 },
    batchId: { type: String, required: true, trim: true, maxlength: 40 },
    rowId: { type: String, required: true, trim: true, maxlength: 40 },
    sourceRow: { type: Number, min: 0, default: 0 },
  },
  { _id: false },
);

const DecisionSchema = new mongoose.Schema(
  {
    version: { type: Number, min: 0, default: 0 },
    state: { type: String, enum: [null, ...AUDIT_PACK_DECISION_STATES], default: null },
    treatment: { type: String, trim: true, maxlength: 40, default: "" },
    status: { type: String, trim: true, maxlength: 40, default: "" },
    // A pack beyond Clause 44 asks for one named reason per row (why two figures differ, which category).
    choice: { type: String, trim: true, maxlength: 60, default: "" },
    reason: { type: String, trim: true, maxlength: 500, default: "" },
    note: { type: String, trim: true, maxlength: 2000, default: "" },
    // "AI_DRAFT" when the note is the row's stored draft word for word; the person's own words are "".
    noteSource: { type: String, enum: ["", "AI_DRAFT"], default: "" },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    decidedAt: { type: Date, default: null },
  },
  { _id: false },
);

// W10 AP16/AP28: wording an AI drafted for this row, for a person to read and adopt. It is never part of the row's
// values and never moves a state or an amount; see audit-pack-kinds/draft.js.
const DraftSchema = new mongoose.Schema(
  {
    text: { type: String, trim: true, maxlength: 1500, required: true },
    status: { type: String, enum: ["AI_DRAFT"], default: "AI_DRAFT" },
    purpose: { type: String, trim: true, maxlength: 40, default: "" },
    proposedChoice: { type: String, trim: true, maxlength: 60, default: "" },
    quoted: { type: [new mongoose.Schema({ label: { type: String, maxlength: 200 }, value: { type: String, maxlength: 400 } }, { _id: false })], default: () => [] },
    draftedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    draftedAt: { type: Date, default: null },
  },
  { _id: false },
);

const AuditPackRowSchema = new mongoose.Schema(
  {
    firmId: { type: mongoose.Schema.Types.ObjectId, ref: "Firm", required: true },
    runId: { type: mongoose.Schema.Types.ObjectId, ref: "AuditPackRun", required: true },
    generationAttempt: { type: String, required: true, trim: true, maxlength: 80 },
    ordinal: { type: Number, required: true, min: 0 },
    // Each pack names its own sections (audit-pack-kinds/); the service checks them against the pack.
    section: { type: String, required: true, trim: true, match: /^[A-Z0-9_]{1,40}$/ },
    rowKey: { type: String, required: true, trim: true, match: /^[a-f0-9]{64}$/ },
    label: { type: String, required: true, trim: true, maxlength: 300 },
    party: {
      gstin: { type: String, trim: true, uppercase: true, maxlength: 15, default: "" },
    },
    // The engine's computed values (amounts in integer paise). Mixed because each section has its
    // own shape; clause44.engine.js and the readers in both clients pin those shapes in tests.
    values: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    ruleHits: { type: [RuleHitSchema], default: () => [] },
    state: { type: String, enum: AUDIT_PACK_ROW_STATES, required: true },
    decidable: { type: Boolean, default: true },
    sourceRows: { type: [SourceRowSchema], default: () => [] },
    sourceEvidenceCount: { type: Number, min: 0, default: 0 },
    sourceEvidenceHash: { type: String, trim: true, match: /^[a-f0-9]{64}$/ },
    decision: { type: DecisionSchema, default: () => ({}) },
    draft: { type: DraftSchema, default: null },
  },
  { timestamps: true },
);

AuditPackRowSchema.index(
  { firmId: 1, runId: 1, generationAttempt: 1, rowKey: 1 },
  { unique: true, name: "unique_audit_pack_row_generation" },
);
AuditPackRowSchema.index({ firmId: 1, runId: 1, generationAttempt: 1, section: 1, ordinal: 1 });

const AuditPackRow = mongoose.model("AuditPackRow", AuditPackRowSchema);

export { AUDIT_PACK_DECISION_STATES, AUDIT_PACK_ROW_SECTIONS, AUDIT_PACK_ROW_STATES };
export default AuditPackRow;
