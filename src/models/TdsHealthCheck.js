import mongoose from "mongoose";

const TDS_CHECK_STATUSES = Object.freeze([
  "RETURN_NOT_FILED",
  "RETURN_DUE_SOON",
  "DEPOSIT_MISSING",
  "SHORT_DEPOSIT_ESTIMATE",
  "EXCESS_DEPOSIT_REVIEW",
  "CHALLAN_UNMAPPED",
  "DEDUCTION_NOT_REPORTED",
  "REPORTED_NOT_IN_REGISTER",
  "PAN_MISSING",
  "PAN_FORMAT_INVALID",
  "PAN_PORTAL_VERIFICATION_PENDING",
  "CREDIT_MISSING_IN_IMPORTED_26AS",
  "CORRECTION_REQUIRED",
  "CERTIFICATE_PENDING",
  "NEEDS_PROFESSIONAL_REVIEW",
]);
const TDS_CHECK_DIMENSIONS = Object.freeze([
  "DEDUCTION",
  "DEPOSIT",
  "STATEMENT",
  "PAN",
  "CREDIT",
  "CERTIFICATE",
]);
const TDS_CHECK_STATES = Object.freeze(["OPEN", "ACTION_PLANNED", "RESOLVED", "ACCEPTED"]);

const safeInteger = {
  validator: Number.isSafeInteger,
  message: "{PATH} must be a safe integer in the smallest currency unit",
};

const SourceRowSchema = new mongoose.Schema(
  {
    rowId: { type: mongoose.Schema.Types.ObjectId, ref: "TdsImportRow", required: true },
    batchId: { type: mongoose.Schema.Types.ObjectId, ref: "ImportBatch", required: true },
    kind: { type: String, required: true, trim: true, maxlength: 40 },
    sourceRow: { type: Number, required: true, min: 2 },
    label: { type: String, required: true, trim: true, maxlength: 160 },
  },
  { _id: false }
);

const ResolutionSchema = new mongoose.Schema(
  {
    version: { type: Number, min: 0, default: 0 },
    action: { type: String, enum: [null, "RESOLVE", "ACCEPT_REVIEW", "REOPEN"], default: null },
    note: { type: String, trim: true, maxlength: 1000, default: "" },
    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { _id: false }
);

const PanVerificationSchema = new mongoose.Schema(
  {
    method: { type: String, enum: [null, "MANUAL_OFFICIAL_PORTAL_RECORD"], default: null },
    status: { type: String, enum: [null, "VERIFIED", "FAILED"], default: null },
    sourceReference: { type: String, trim: true, maxlength: 1000, default: "" },
    verifiedAt: { type: Date, default: null },
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { _id: false }
);

const ActionPlanSchema = new mongoose.Schema(
  {
    taskId: { type: mongoose.Schema.Types.ObjectId, ref: "Task", default: null },
    ownerUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    dueDateISO: { type: String, trim: true, default: "" },
    priority: { type: String, enum: ["", "LOW", "MEDIUM", "HIGH", "URGENT"], default: "" },
    clientChaseMessage: { type: String, trim: true, maxlength: 1000, default: "" },
    deducteeFollowUp: { type: String, trim: true, maxlength: 1000, default: "" },
    correctionChecklist: { type: [String], default: [] },
    reviewerNote: { type: String, trim: true, maxlength: 1000, default: "" },
    plannedAt: { type: Date, default: null },
    plannedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { _id: false }
);

const TdsHealthCheckSchema = new mongoose.Schema(
  {
    firmId: { type: mongoose.Schema.Types.ObjectId, ref: "Firm", required: true },
    runId: { type: mongoose.Schema.Types.ObjectId, ref: "TdsHealthRun", required: true },
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: "Client", required: true },
    generationAttempt: { type: String, required: true, trim: true, maxlength: 80 },
    itemKey: { type: String, required: true, trim: true, maxlength: 160 },
    checkVersion: { type: Number, required: true, min: 1 },
    status: { type: String, enum: TDS_CHECK_STATUSES, required: true },
    dimension: { type: String, enum: TDS_CHECK_DIMENSIONS, required: true },
    severity: { type: String, enum: ["INFO", "WARNING", "ERROR"], default: "WARNING" },
    state: { type: String, enum: TDS_CHECK_STATES, default: "OPEN" },
    title: { type: String, required: true, trim: true, maxlength: 240 },
    explanation: { type: String, required: true, trim: true, maxlength: 1500 },
    recommendedAction: { type: String, required: true, trim: true, maxlength: 1000 },
    deducteePan: { type: String, trim: true, uppercase: true, maxlength: 20, default: "" },
    sectionCode: { type: String, trim: true, uppercase: true, maxlength: 30, default: "" },
    expectedMinor: { type: Number, default: 0, validate: safeInteger },
    actualMinor: { type: Number, default: 0, validate: safeInteger },
    differenceMinor: { type: Number, default: 0, validate: safeInteger },
    sourceRows: {
      type: [SourceRowSchema],
      required: true,
      validate: {
        validator: (rows) => Array.isArray(rows) && rows.length > 0 && rows.length <= 100,
        message: "Health-check preview requires 1 to 100 source-row references",
      },
    },
    sourceEvidenceCount: { type: Number, required: true, min: 1 },
    sourceEvidenceHash: { type: String, required: true, trim: true, match: /^[a-f0-9]{64}$/i },
    sourceEvidenceStorage: { type: String, enum: ["TdsHealthEvidenceLink"], default: "TdsHealthEvidenceLink" },
    calculation: {
      estimate: { type: Boolean, default: true },
      ruleVersion: { type: String, required: true, trim: true, maxlength: 80 },
      sourceLabel: { type: String, required: true, trim: true, maxlength: 240 },
      sourceReference: { type: String, required: true, trim: true, maxlength: 1000 },
      professionalConfirmed: { type: Boolean, default: false },
    },
    resolution: { type: ResolutionSchema, default: () => ({}) },
    panVerification: { type: PanVerificationSchema, default: () => ({}) },
    actionPlan: { type: ActionPlanSchema, default: () => ({}) },
  },
  { timestamps: true }
);

TdsHealthCheckSchema.index(
  { firmId: 1, runId: 1, generationAttempt: 1, itemKey: 1 },
  { unique: true, name: "unique_tds_check_generation_item" }
);
TdsHealthCheckSchema.index({ firmId: 1, runId: 1, dimension: 1, state: 1, status: 1, _id: 1 });
TdsHealthCheckSchema.index({ firmId: 1, runId: 1, deducteePan: 1, state: 1 });
TdsHealthCheckSchema.index({ firmId: 1, "actionPlan.taskId": 1 });

const TdsHealthCheck = mongoose.model("TdsHealthCheck", TdsHealthCheckSchema);

export { TDS_CHECK_DIMENSIONS, TDS_CHECK_STATES, TDS_CHECK_STATUSES };
export default TdsHealthCheck;
