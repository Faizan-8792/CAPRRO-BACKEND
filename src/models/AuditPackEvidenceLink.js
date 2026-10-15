// src/models/AuditPackEvidenceLink.js
//
// W10 AP8 (2026-10-15): every source row behind an audit pack row, in order. A pack row embeds the
// first 100 of its sources for the screen; this holds all of them (a supplier with 2,000 invoices),
// so the evidence count and hash on the row can always be checked against the full list.

import mongoose from "mongoose";

const AuditPackEvidenceLinkSchema = new mongoose.Schema(
  {
    firmId: { type: mongoose.Schema.Types.ObjectId, ref: "Firm", required: true },
    runId: { type: mongoose.Schema.Types.ObjectId, ref: "AuditPackRun", required: true },
    generationAttempt: { type: String, required: true, trim: true, maxlength: 80 },
    rowKey: { type: String, required: true, trim: true, match: /^[a-f0-9]{64}$/ },
    ordinal: { type: Number, required: true, min: 0 },
    kind: { type: String, required: true, trim: true, maxlength: 40 },
    batchId: { type: String, required: true, trim: true, maxlength: 40 },
    rowId: { type: String, required: true, trim: true, maxlength: 40 },
    sourceRow: { type: Number, min: 0, default: 0 },
  },
  { timestamps: true },
);

AuditPackEvidenceLinkSchema.index(
  { firmId: 1, runId: 1, generationAttempt: 1, rowKey: 1, ordinal: 1 },
  { unique: true, name: "unique_audit_pack_evidence_ordinal" },
);

const AuditPackEvidenceLink = mongoose.model("AuditPackEvidenceLink", AuditPackEvidenceLinkSchema);

export default AuditPackEvidenceLink;
