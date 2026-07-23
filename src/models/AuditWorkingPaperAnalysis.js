import mongoose from "mongoose";

const ANALYSIS_STATUSES = Object.freeze([
  "PROCESSING",
  "SUPPORTED",
  "INSUFFICIENT_EVIDENCE",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_RESULT_INVALID",
]);
const PROPOSAL_DECISIONS = Object.freeze([
  "PENDING",
  "ACCEPTED",
  "REJECTED",
  "EDITED",
]);
const PROVIDER_ADMISSION_VERSION = "durable-consent-v1";
const OUTBOUND_DATA_CLASSES = Object.freeze([
  "ALLOWED_FINDING_CATEGORIES",
  "WORKING_PAPER_ID",
  "WORKING_PAPER_TITLE",
  "WORKING_PAPER_PURPOSE",
  "WORKING_PAPER_PERIOD",
  "SOURCE_ROW_ID",
  "SOURCE_ROW_KEY",
  "SOURCE_ROW_DESCRIPTION",
  "SOURCE_ROW_OBSERVED_VALUE",
  "SOURCE_ROW_CURRENT_AMOUNT_MINOR",
  "SOURCE_ROW_REFERENCE",
  "SOURCE_ROW_ASSERTION_TAGS",
  "SOURCE_ROW_NOTE",
  "SOURCE_ROW_CONTENT_HASH",
]);

const boundedArray = (maximum, label) => ({
  validator: (values) => values.length <= maximum,
  message: `${label} exceeds ${maximum} entries`,
});

const SourceRowCitationSchema = new mongoose.Schema(
  {
    rowId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AuditWorkingPaperRow",
      required: true,
    },
    contentHash: { type: String, match: /^[a-f0-9]{64}$/, required: true },
  },
  { _id: false }
);

const ProposalDispositionSchema = new mongoose.Schema(
  {
    decision: { type: String, enum: PROPOSAL_DECISIONS, default: "PENDING" },
    note: { type: String, trim: true, maxlength: 5000, default: "" },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    decidedAt: { type: Date, default: null },
    linkedFindingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EngagementFinding",
      default: null,
    },
  },
  { _id: false }
);

const FindingProposalSchema = new mongoose.Schema(
  {
    title: { type: String, trim: true, maxlength: 500, required: true },
    description: { type: String, trim: true, maxlength: 10000, required: true },
    category: { type: String, trim: true, uppercase: true, maxlength: 120, required: true },
    risk: {
      type: String,
      enum: ["UNASSESSED", "LOW", "MEDIUM", "HIGH", "CRITICAL"],
      default: "UNASSESSED",
    },
    citedRows: {
      type: [SourceRowCitationSchema],
      required: true,
      validate: [
        boundedArray(50, "Proposal source-row citations"),
        {
          validator: (values) => values.length > 0,
          message: "Every AI proposal must cite at least one source row",
        },
        {
          validator: (values) =>
            new Set(values.map((value) => String(value.rowId))).size === values.length,
          message: "Proposal source-row citations must be unique",
        },
      ],
    },
    disposition: { type: ProposalDispositionSchema, default: () => ({}) },
  },
  { _id: true }
);

const MutationReceiptSchema = new mongoose.Schema(
  {
    key: { type: String, trim: true, maxlength: 120, required: true },
    action: { type: String, trim: true, maxlength: 80, required: true },
    requestHash: { type: String, match: /^[a-f0-9]{64}$/, required: true },
    resultId: { type: String, trim: true, maxlength: 120, default: "" },
    appliedRevision: { type: Number, min: 1, required: true },
    appliedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const AuditWorkingPaperAnalysisSchema = new mongoose.Schema(
  {
    firmId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Firm",
      required: true,
      immutable: true,
    },
    workingPaperId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AuditWorkingPaper",
      required: true,
      immutable: true,
    },
    engagementId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Engagement",
      required: true,
      immutable: true,
    },
    clientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      required: true,
      immutable: true,
    },
    status: { type: String, enum: ANALYSIS_STATUSES, required: true },
    selectedRows: {
      type: [SourceRowCitationSchema],
      required: true,
      immutable: true,
      validate: [
        boundedArray(50, "Selected source rows"),
        {
          validator: (values) => values.length > 0,
          message: "An analysis requires selected source rows",
        },
      ],
    },
    proposals: {
      type: [FindingProposalSchema],
      default: [],
      validate: boundedArray(10, "AI finding proposals"),
    },
    insufficientEvidenceReason: {
      type: String,
      trim: true,
      maxlength: 5000,
      default: "",
    },
    providerFailureReason: {
      type: String,
      trim: true,
      maxlength: 500,
      default: "",
    },
    provider: { type: String, trim: true, maxlength: 80, default: "" },
    model: { type: String, trim: true, maxlength: 120, default: "" },
    promptVersion: {
      type: String,
      trim: true,
      maxlength: 80,
      required: true,
      immutable: true,
    },
    providerResultHash: {
      type: String,
      match: /^[a-f0-9]{64}$/,
      default: null,
    },
    providerAdmissionVersion: {
      type: String,
      trim: true,
      maxlength: 80,
      default: "",
      immutable: true,
    },
    processingAttemptId: {
      type: String,
      trim: true,
      maxlength: 80,
      default: "",
      immutable: true,
      select: false,
    },
    processingStartedAt: { type: Date, default: null, immutable: true },
    providerCompletedAt: { type: Date, default: null },
    outboundDataClasses: {
      type: [{ type: String, enum: OUTBOUND_DATA_CLASSES }],
      default: [],
      immutable: true,
      validate: [
        boundedArray(OUTBOUND_DATA_CLASSES.length, "Outbound data classes"),
        {
          validator: (values) => new Set(values).size === values.length,
          message: "Outbound data classes must be unique",
        },
      ],
    },
    outboundPayloadHash: {
      type: String,
      match: /^[a-f0-9]{64}$/,
      default: null,
      immutable: true,
    },
    externalProcessingConsentAt: { type: Date, required: true, immutable: true },
    externalProcessingConsentBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },
    creationMutationKey: {
      type: String,
      trim: true,
      maxlength: 120,
      required: true,
      immutable: true,
    },
    creationRequestHash: {
      type: String,
      match: /^[a-f0-9]{64}$/,
      required: true,
      immutable: true,
    },
    mutationReceipts: {
      type: [MutationReceiptSchema],
      default: [],
      validate: [
        boundedArray(500, "Analysis mutation receipts"),
        {
          validator: (values) => new Set(values.map((value) => value.key)).size === values.length,
          message: "Analysis mutation receipt keys must be unique",
        },
      ],
    },
    revision: { type: Number, min: 1, default: 1 },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true, optimisticConcurrency: true }
);

AuditWorkingPaperAnalysisSchema.pre("validate", function validateDurableProviderAdmission(next) {
  if (this.providerAdmissionVersion !== PROVIDER_ADMISSION_VERSION) return next();
  const missingAdmissionMetadata =
    !this.processingAttemptId ||
    !this.processingStartedAt ||
    !this.outboundPayloadHash ||
    this.outboundDataClasses.length !== OUTBOUND_DATA_CLASSES.length;
  if (missingAdmissionMetadata) {
    return next(new Error("Durable provider admission metadata is incomplete"));
  }
  if (this.status === "PROCESSING") {
    if (this.proposals.length || this.providerCompletedAt) {
      return next(new Error("Processing analysis cannot contain a completed provider result"));
    }
    return next();
  }
  if (!this.providerCompletedAt) {
    return next(new Error("Completed analysis requires provider completion time"));
  }
  if (this.status === "SUPPORTED" && !this.proposals.length) {
    return next(new Error("Supported analysis requires at least one cited proposal"));
  }
  if (this.status === "INSUFFICIENT_EVIDENCE" && !this.insufficientEvidenceReason) {
    return next(new Error("Insufficient-evidence analysis requires an explicit provider reason"));
  }
  if (
    ["PROVIDER_UNAVAILABLE", "PROVIDER_RESULT_INVALID"].includes(this.status) &&
    !this.providerFailureReason
  ) {
    return next(new Error("Provider failure analysis requires a reason"));
  }
  return next();
});

AuditWorkingPaperAnalysisSchema.index(
  { firmId: 1, workingPaperId: 1, creationMutationKey: 1 },
  { unique: true, name: "unique_audit_working_paper_analysis_creation" }
);
AuditWorkingPaperAnalysisSchema.index(
  { firmId: 1, workingPaperId: 1, createdAt: -1, _id: -1 },
  { name: "audit_working_paper_analysis_created_desc" }
);

const AuditWorkingPaperAnalysis = mongoose.model(
  "AuditWorkingPaperAnalysis",
  AuditWorkingPaperAnalysisSchema
);

export {
  ANALYSIS_STATUSES,
  OUTBOUND_DATA_CLASSES,
  PROPOSAL_DECISIONS,
  PROVIDER_ADMISSION_VERSION,
};
export default AuditWorkingPaperAnalysis;
