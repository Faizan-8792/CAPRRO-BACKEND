// src/models/AuditPackRun.js
//
// W10 AP8 (2026-10-15): one audit pack computed for one client and year from a fixed set of
// imported batches (its source fingerprint). The automation worker writes the pack's rows under a
// fresh generation attempt and publishes the run to REVIEW with that attempt as its active one only
// after verifying them, so a reader never sees a half-written pack. Nothing here is ever "complete":
// people decide the rows, and the clause's figures are recomputed from rows and decisions on read.

import mongoose from "mongoose";

const AUDIT_PACK_KINDS = Object.freeze([
  "CLAUSE44", "GSTR9C", "CLAUSE21D", "CLAUSE22", "CLAUSE26", "CLAUSE31", "CLAUSE34", "SCHEDULE3_AGEING", "SCHEDULE3_RATIOS", "CARO", "LEDGER_SCAN",
]);
const AUDIT_PACK_RUN_STATUSES = Object.freeze(["QUEUED", "PROCESSING", "REVIEW", "FAILED"]);

const SourceBatchSchema = new mongoose.Schema(
  {
    batchId: { type: mongoose.Schema.Types.ObjectId, ref: "ImportBatch", required: true },
    kind: { type: String, required: true, trim: true, maxlength: 40 },
    importGeneration: { type: String, required: true, trim: true, maxlength: 80 },
    sourceHash: { type: String, required: true, trim: true, maxlength: 128 },
    period: { type: String, trim: true, maxlength: 7, default: "" },
  },
  { _id: false },
);

const AuditPackRunSchema = new mongoose.Schema(
  {
    firmId: { type: mongoose.Schema.Types.ObjectId, ref: "Firm", required: true },
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: "Client", required: true },
    kind: { type: String, enum: AUDIT_PACK_KINDS, required: true },
    financialYear: { type: String, required: true, trim: true, match: /^\d{4}-\d{2}$/ },
    sourceBatches: { type: [SourceBatchSchema], default: () => [] },
    sourceFingerprint: { type: String, required: true, trim: true, match: /^[a-f0-9]{64}$/ },
    revision: { type: Number, required: true, min: 1, default: 1 },
    // What a pack beyond Clause 44 was asked to compute, stored with the run and part of its fingerprint
    // (GSTR-9 figures as typed, which annexure, which snapshot). Content-free for Clause 44.
    params: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    ruleVersion: { type: String, required: true, trim: true, maxlength: 80 },
    status: { type: String, enum: AUDIT_PACK_RUN_STATUSES, default: "QUEUED" },
    rolloutVersion: { type: Number, required: true, min: 0, default: 0 },
    generationAttempt: { type: String, trim: true, maxlength: 80, default: null },
    activeGenerationAttempt: { type: String, trim: true, maxlength: 80, default: null },
    rowCount: { type: Number, min: 0, default: 0 },
    monthsLoaded: { type: [String], default: () => [] },
    monthsMissing: { type: [String], default: () => [] },
    jobId: { type: mongoose.Schema.Types.ObjectId, ref: "AutomationJob", default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    lastError: { type: String, trim: true, maxlength: 600, default: "" },
    publishedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

AuditPackRunSchema.index(
  { firmId: 1, kind: 1, sourceFingerprint: 1, revision: 1 },
  { unique: true, name: "unique_audit_pack_run_source_revision" },
);
AuditPackRunSchema.index({ firmId: 1, clientId: 1, kind: 1, financialYear: -1, createdAt: -1 });

const AuditPackRun = mongoose.model("AuditPackRun", AuditPackRunSchema);

export { AUDIT_PACK_KINDS, AUDIT_PACK_RUN_STATUSES };
export default AuditPackRun;
