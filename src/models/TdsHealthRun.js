import mongoose from "mongoose";

const TDS_RUN_STATUSES = Object.freeze(["QUEUED", "PROCESSING", "REVIEW", "LOCKED", "FAILED"]);
const TDS_STATEMENT_TYPES = Object.freeze(["24Q", "26Q", "27Q", "27EQ"]);
const TDS_QUARTERS = Object.freeze(["Q1", "Q2", "Q3", "Q4"]);

const safeInteger = {
  validator: Number.isSafeInteger,
  message: "{PATH} must be a safe integer in the smallest currency unit",
};

const SourceImportsSchema = new mongoose.Schema(
  {
    deductionsBatchId: { type: mongoose.Schema.Types.ObjectId, ref: "ImportBatch", required: true },
    challansBatchId: { type: mongoose.Schema.Types.ObjectId, ref: "ImportBatch", required: true },
    statementsBatchId: { type: mongoose.Schema.Types.ObjectId, ref: "ImportBatch", required: true },
    creditBatchId: { type: mongoose.Schema.Types.ObjectId, ref: "ImportBatch", default: null },
  },
  { _id: false }
);

const SummarySchema = new mongoose.Schema(
  {
    deductedMinor: { type: Number, default: 0, validate: safeInteger },
    depositedMinor: { type: Number, default: 0, validate: safeInteger },
    reportedMinor: { type: Number, default: 0, validate: safeInteger },
    importedCreditMinor: { type: Number, default: 0, validate: safeInteger },
    estimatedGapMinor: { type: Number, default: 0, validate: safeInteger },
    totalChecks: { type: Number, min: 0, default: 0 },
    openChecks: { type: Number, min: 0, default: 0 },
    actionPlannedChecks: { type: Number, min: 0, default: 0 },
    resolvedChecks: { type: Number, min: 0, default: 0 },
  },
  { _id: false }
);

const CalculationPolicySchema = new mongoose.Schema(
  {
    version: { type: String, required: true, trim: true, maxlength: 80 },
    sourceLabel: { type: String, required: true, trim: true, maxlength: 240 },
    sourceReference: { type: String, required: true, trim: true, maxlength: 1000 },
    estimate: { type: Boolean, default: true },
    professionalConfirmed: { type: Boolean, default: false },
    ratesApplied: { type: Boolean, default: false },
  },
  { _id: false }
);

const TdsHealthRunSchema = new mongoose.Schema(
  {
    firmId: { type: mongoose.Schema.Types.ObjectId, ref: "Firm", required: true },
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: "Client", required: true },
    tan: { type: String, required: true, uppercase: true, trim: true, match: /^[A-Z]{4}[0-9]{5}[A-Z]$/ },
    financialYear: { type: String, required: true, trim: true, match: /^\d{4}-\d{2}$/ },
    quarter: { type: String, enum: TDS_QUARTERS, required: true },
    statementType: { type: String, enum: TDS_STATEMENT_TYPES, required: true },
    sourceImports: { type: SourceImportsSchema, required: true },
    sourceFingerprint: { type: String, required: true, trim: true, match: /^[a-f0-9]{64}$/i },
    rootRunId: { type: mongoose.Schema.Types.ObjectId, ref: "TdsHealthRun", default: null },
    parentRunId: { type: mongoose.Schema.Types.ObjectId, ref: "TdsHealthRun", default: null },
    revision: { type: Number, required: true, min: 1 },
    correctionReason: { type: String, trim: true, maxlength: 500, default: "" },
    status: { type: String, enum: TDS_RUN_STATUSES, default: "QUEUED" },
    rolloutVersion: { type: Number, required: true, min: 0 },
    generationAttempt: { type: String, required: true, trim: true, maxlength: 80 },
    activeGenerationAttempt: { type: String, trim: true, maxlength: 80, default: null },
    checkVersion: { type: Number, min: 0, default: 0 },
    summary: { type: SummarySchema, default: () => ({}) },
    calculationPolicy: { type: CalculationPolicySchema, required: true },
    jobId: { type: mongoose.Schema.Types.ObjectId, ref: "AutomationJob", default: null },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    reviewedAt: { type: Date, default: null },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    lockedAt: { type: Date, default: null },
    lockedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    lastError: { type: String, trim: true, maxlength: 600, default: "" },
  },
  { timestamps: true }
);

TdsHealthRunSchema.index(
  { firmId: 1, sourceFingerprint: 1, revision: 1 },
  {
    unique: true,
    partialFilterExpression: { parentRunId: null },
    name: "unique_tds_root_run_source_revision",
  }
);
TdsHealthRunSchema.index(
  { firmId: 1, rootRunId: 1, revision: 1 },
  { unique: true, partialFilterExpression: { rootRunId: { $type: "objectId" } }, name: "unique_tds_run_lineage_revision" }
);
TdsHealthRunSchema.index(
  { firmId: 1, parentRunId: 1 },
  { unique: true, partialFilterExpression: { parentRunId: { $type: "objectId" } }, name: "unique_tds_run_child" }
);
TdsHealthRunSchema.index({ firmId: 1, clientId: 1, financialYear: -1, quarter: 1, statementType: 1, createdAt: -1 });
TdsHealthRunSchema.index({ firmId: 1, status: 1, updatedAt: -1 });

const TdsHealthRun = mongoose.model("TdsHealthRun", TdsHealthRunSchema);

export { TDS_QUARTERS, TDS_RUN_STATUSES, TDS_STATEMENT_TYPES };
export default TdsHealthRun;
