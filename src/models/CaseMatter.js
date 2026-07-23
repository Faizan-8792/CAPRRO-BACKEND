import mongoose from "mongoose";

const CASE_TYPES = Object.freeze([
  "INCOME_TAX_NOTICE_INTIMATION",
  "ASSESSMENT",
  "REASSESSMENT",
  "APPEAL",
  "RECTIFICATION",
  "PENALTY_PROCEEDING",
  "TDS_PROCEEDING",
  "GST_NOTICE_ASSESSMENT",
  "GST_REFUND_MATTER",
  "GST_AUDIT_QUERY",
  "ROC_SECRETARIAL_MATTER",
  "GENERAL_LITIGATION_REPRESENTATION",
]);

const CASE_STATUSES = Object.freeze([
  "INTAKE",
  "EXTRACTION_NEEDS_REVIEW",
  "OPEN",
  "DOCUMENTS_PENDING",
  "ANALYSIS",
  "RESPONSE_DRAFT",
  "INTERNAL_REVIEW",
  "CLIENT_APPROVAL",
  "READY_TO_SUBMIT",
  "SUBMITTED",
  "HEARING_SCHEDULED",
  "ORDER_RECEIVED",
  "APPEAL_REVIEW",
  "CLOSED",
  "ARCHIVED",
]);

const CASE_FIELD_NAMES = Object.freeze([
  "authority",
  "noticeType",
  "sectionReference",
  "assessmentYear",
  "financialYear",
  "period",
  "din",
  "issueDate",
  "receivedDate",
  "responseDueDate",
  "hearingDate",
  "limitationDate",
  "demandMinor",
  "disputedMinor",
  "assessingAuthority",
  "statedReason",
  "requestedDocuments",
]);

const safeMinorUnit = {
  validator: (value) => value == null || (Number.isSafeInteger(value) && value >= 0),
  message: "Amount must be a non-negative safe integer in minor units",
};

const ExtractionProposalSchema = new mongoose.Schema(
  {
    field: { type: String, enum: CASE_FIELD_NAMES, required: true },
    value: { type: String, trim: true, maxlength: 4000, default: "" },
    sourceText: { type: String, trim: true, maxlength: 1200, default: "" },
    confidence: { type: Number, min: 0, max: 1, required: true },
    provider: { type: String, trim: true, maxlength: 80, default: "" },
    model: { type: String, trim: true, maxlength: 120, default: "" },
    proposedAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const ConfirmationEvidenceSchema = new mongoose.Schema(
  {
    field: { type: String, enum: CASE_FIELD_NAMES, required: true },
    valueHash: { type: String, match: /^[a-f0-9]{64}$/, required: true },
    sourceText: { type: String, trim: true, maxlength: 1200, default: "" },
    confidence: { type: Number, min: 0, max: 1, default: null },
    confirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    confirmedAt: { type: Date, default: Date.now },
    source: {
      type: String,
      enum: ["AI_PROPOSAL", "SOURCE_TEXT", "MANUAL"],
      required: true,
    },
  },
  { _id: false }
);

const ConfirmedFactsSchema = new mongoose.Schema(
  {
    authority: { type: String, trim: true, maxlength: 300, default: "" },
    noticeType: { type: String, trim: true, maxlength: 300, default: "" },
    sectionReference: { type: String, trim: true, maxlength: 160, default: "" },
    assessmentYear: { type: String, trim: true, maxlength: 20, default: "" },
    financialYear: { type: String, trim: true, maxlength: 20, default: "" },
    period: { type: String, trim: true, maxlength: 80, default: "" },
    din: { type: String, trim: true, maxlength: 200, default: "" },
    issueDate: { type: Date, default: null },
    receivedDate: { type: Date, default: null },
    responseDueDate: { type: Date, default: null },
    hearingDate: { type: Date, default: null },
    limitationDate: { type: Date, default: null },
    demandMinor: { type: Number, default: null, validate: safeMinorUnit },
    disputedMinor: { type: Number, default: null, validate: safeMinorUnit },
    assessingAuthority: { type: String, trim: true, maxlength: 300, default: "" },
    statedReason: { type: String, trim: true, maxlength: 4000, default: "" },
    requestedDocuments: {
      type: [String],
      default: [],
      validate: {
        validator: (values) =>
          values.length <= 100 && values.every((value) => value.length <= 500),
        message: "Requested documents exceed allowed bounds",
      },
    },
  },
  { _id: false }
);

const ReferenceSchema = new mongoose.Schema(
  {
    sourceType: { type: String, enum: ["USER_VERIFIED"], default: "USER_VERIFIED" },
    title: { type: String, trim: true, maxlength: 500, required: true },
    locator: { type: String, trim: true, maxlength: 1000, default: "" },
    excerpt: { type: String, trim: true, maxlength: 5000, default: "" },
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    verifiedAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const ContentTransitionSchema = new mongoose.Schema(
  {
    token: { type: String, trim: true, maxlength: 64, default: "" },
    action: { type: String, trim: true, maxlength: 80, default: "" },
    mutationKey: { type: String, trim: true, maxlength: 120, default: null },
    requestHash: { type: String, match: /^[a-f0-9]{64}$/, default: null },
    draftId: { type: mongoose.Schema.Types.ObjectId, ref: "CaseDraft", default: null },
    targetStatus: { type: String, enum: CASE_STATUSES, default: null },
    startedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
  },
  { _id: false }
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

const CaseMatterSchema = new mongoose.Schema(
  {
    firmId: { type: mongoose.Schema.Types.ObjectId, ref: "Firm", required: true },
    intakeMutationKey: {
      type: String,
      trim: true,
      maxlength: 120,
      default: null,
      immutable: true,
    },
    intakeRequestHash: {
      type: String,
      match: /^[a-f0-9]{64}$/,
      default: null,
      immutable: true,
    },
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: "Client", required: true },
    caseType: { type: String, enum: CASE_TYPES, required: true },
    title: { type: String, trim: true, maxlength: 500, required: true },
    internalReference: { type: String, trim: true, maxlength: 160, default: "" },
    status: { type: String, enum: CASE_STATUSES, default: "INTAKE" },
    priority: {
      type: String,
      enum: ["LOW", "NORMAL", "HIGH", "URGENT"],
      default: "NORMAL",
    },
    risk: {
      type: String,
      enum: ["UNASSESSED", "LOW", "MEDIUM", "HIGH", "CRITICAL"],
      default: "UNASSESSED",
    },
    ownerUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    reviewerUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    escalationOwnerUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    source: {
      method: {
        type: String,
        enum: ["DIGITAL_PDF_LOCAL", "OCR_SPACE", "SCREENSHOT_OCR", "PASTED_TEXT", "MANUAL"],
        required: true,
      },
      sourceName: { type: String, trim: true, maxlength: 240, default: "" },
      mimeType: { type: String, trim: true, maxlength: 120, default: "text/plain" },
      sizeBytes: { type: Number, min: 0, max: 25 * 1024 * 1024, default: 0 },
      extractedText: { type: String, maxlength: 250000, default: "" },
      textHash: { type: String, match: /^[a-f0-9]{64}$/, required: true },
      extractionProvider: {
        type: String,
        enum: ["LOCAL", "OCR_SPACE", "MANUAL"],
        required: true,
      },
      extractedAt: { type: Date, default: Date.now },
      externalProcessingConsentAt: { type: Date, default: null },
      binaryStored: {
        type: Boolean,
        default: false,
        validate: {
          validator: (value) => value === false,
          message: "Case source binary storage is disabled",
        },
      },
    },
    extractionStatus: {
      type: String,
      enum: ["NOT_REQUESTED", "EXTRACTION_NEEDS_REVIEW", "CONFIRMED", "FAILED"],
      default: "NOT_REQUESTED",
    },
    extractionProposals: { type: [ExtractionProposalSchema], default: [] },
    confirmedFacts: { type: ConfirmedFactsSchema, default: () => ({}) },
    confirmationEvidence: {
      type: [ConfirmationEvidenceSchema],
      default: [],
      validate: {
        validator: (values) => values.length <= 500,
        message: "Case confirmation history exceeds 500 entries",
      },
    },
    verifiedReferences: { type: [ReferenceSchema], default: [] },
    deadlineTaskId: { type: mongoose.Schema.Types.ObjectId, ref: "Task", default: null },
    deadlineReminderId: { type: mongoose.Schema.Types.ObjectId, ref: "Reminder", default: null },
    reminderOffsets: {
      type: [Number],
      default: [-15, -7, -2, 0],
      validate: {
        validator: (values) =>
          values.length <= 20 &&
          values.every((value) => Number.isInteger(value) && value >= -365 && value <= 365),
        message: "Reminder offsets must be whole days between -365 and 365",
      },
    },
    outcome: { type: String, trim: true, maxlength: 5000, default: "" },
    contentTransition: {
      type: ContentTransitionSchema,
      default: () => ({}),
    },
    mutationReceipts: {
      type: [MutationReceiptSchema],
      default: [],
      validate: [
        {
          validator: (values) => values.length <= 1000,
          message: "Case mutation receipt limit reached",
        },
        {
          validator: (values) =>
            new Set(values.map((value) => value.key)).size === values.length,
          message: "Case mutation receipt keys must be unique",
        },
      ],
    },
    revision: { type: Number, min: 1, default: 1 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    archivedAt: { type: Date, default: null },
  },
  { timestamps: true, optimisticConcurrency: true }
);

CaseMatterSchema.index(
  { firmId: 1, intakeMutationKey: 1 },
  {
    unique: true,
    partialFilterExpression: { intakeMutationKey: { $type: "string" } },
    name: "unique_case_intake_mutation",
  }
);
CaseMatterSchema.index(
  { firmId: 1, createdAt: -1, _id: -1 },
  { name: "case_firm_created_desc" }
);
CaseMatterSchema.index({ firmId: 1, status: 1, updatedAt: -1, _id: -1 });
CaseMatterSchema.index({ firmId: 1, clientId: 1, updatedAt: -1, _id: -1 });
CaseMatterSchema.index({ firmId: 1, "confirmedFacts.responseDueDate": 1, status: 1 });
CaseMatterSchema.index({ firmId: 1, "source.textHash": 1 });

const CaseMatter = mongoose.model("CaseMatter", CaseMatterSchema);

export { CASE_TYPES, CASE_STATUSES, CASE_FIELD_NAMES };
export default CaseMatter;
