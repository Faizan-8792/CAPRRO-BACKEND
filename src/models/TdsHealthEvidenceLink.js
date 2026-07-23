import mongoose from "mongoose";

const TdsHealthEvidenceLinkSchema = new mongoose.Schema(
  {
    firmId: { type: mongoose.Schema.Types.ObjectId, ref: "Firm", required: true },
    runId: { type: mongoose.Schema.Types.ObjectId, ref: "TdsHealthRun", required: true },
    checkId: { type: mongoose.Schema.Types.ObjectId, ref: "TdsHealthCheck", required: true },
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: "Client", required: true },
    generationAttempt: { type: String, required: true, trim: true, maxlength: 80 },
    itemKey: { type: String, required: true, trim: true, maxlength: 160 },
    ordinal: { type: Number, required: true, min: 0 },
    rowId: { type: mongoose.Schema.Types.ObjectId, ref: "TdsImportRow", required: true },
    batchId: { type: mongoose.Schema.Types.ObjectId, ref: "ImportBatch", required: true },
    kind: { type: String, required: true, trim: true, maxlength: 40 },
    sourceRow: { type: Number, required: true, min: 2 },
    label: { type: String, required: true, trim: true, maxlength: 160 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

TdsHealthEvidenceLinkSchema.index(
  { firmId: 1, runId: 1, generationAttempt: 1, itemKey: 1, rowId: 1 },
  { unique: true, name: "unique_tds_check_source_evidence" }
);
TdsHealthEvidenceLinkSchema.index(
  { firmId: 1, runId: 1, checkId: 1, ordinal: 1, _id: 1 },
  { name: "tds_check_evidence_page" }
);

const TdsHealthEvidenceLink = mongoose.model(
  "TdsHealthEvidenceLink",
  TdsHealthEvidenceLinkSchema
);

export default TdsHealthEvidenceLink;
