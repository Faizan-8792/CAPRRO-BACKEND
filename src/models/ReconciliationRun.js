import mongoose from "mongoose";

const RECONCILIATION_RUN_STATUSES = Object.freeze([
  "QUEUED",
  "PROCESSING",
  "REVIEW",
  "LOCKING",
  "LOCKED",
  "FAILED",
]);

const OPERATION_ID_PATTERN = /^[a-f0-9]{64}$/;
const LEASE_TOKEN_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

const safeInteger = {
  validator: Number.isSafeInteger,
  message: "{PATH} must be a safe integer in the smallest currency unit",
};

function moneyField() {
  return { type: Number, default: 0, validate: safeInteger };
}

const TaxHeadsSchema = new mongoose.Schema(
  {
    igstMinor: moneyField(),
    cgstMinor: moneyField(),
    sgstMinor: moneyField(),
    cessMinor: moneyField(),
    totalTaxMinor: moneyField(),
  },
  { _id: false }
);

const RunSummarySchema = new mongoose.Schema(
  {
    totalItems: { type: Number, min: 0, default: 0 },
    matchedCount: { type: Number, min: 0, default: 0 },
    missingIn2bCount: { type: Number, min: 0, default: 0 },
    missingInBooksCount: { type: Number, min: 0, default: 0 },
    mismatchCount: { type: Number, min: 0, default: 0 },
    reviewCount: { type: Number, min: 0, default: 0 },
    reviewedCount: { type: Number, min: 0, default: 0 },
    eligible: { type: TaxHeadsSchema, default: () => ({}) },
    ineligible: { type: TaxHeadsSchema, default: () => ({}) },
    deferred: { type: TaxHeadsSchema, default: () => ({}) },
    reviewValueMinor: moneyField(),
  },
  { _id: false }
);

const ReviewCommandPayloadSchema = new mongoose.Schema(
  {
    reason: { type: String, trim: true, maxlength: 500, default: "" },
    note: { type: String, trim: true, maxlength: 1000, default: "" },
    chaseState: {
      type: String,
      enum: ["MARKED", "OPENED", "COPIED", "REQUESTED"],
      default: "MARKED",
    },
    ownerUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    taskId: { type: mongoose.Schema.Types.ObjectId, ref: "Task", default: null },
    candidatePortalRowId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ImportRow",
      default: null,
    },
  },
  { _id: false }
);

const PendingReviewTransitionSchema = new mongoose.Schema(
  {
    operationId: {
      type: String,
      trim: true,
      match: OPERATION_ID_PATTERN,
      maxlength: 64,
      default: null,
    },
    itemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ReconciliationItem",
      default: null,
    },
    action: {
      type: String,
      enum: ["ACCEPT_MATCH", "UNMATCH"],
      default: null,
    },
    candidatePortalRowId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ImportRow",
      default: null,
    },
    expectedDecisionVersion: { type: Number, min: 0, default: null },
    payload: { type: ReviewCommandPayloadSchema, default: () => ({}) },
    actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    requestId: { type: String, trim: true, maxlength: 160, default: "" },
    startedAt: { type: Date, default: null },
  },
  { _id: false }
);

const BulkReviewItemVersionSchema = new mongoose.Schema(
  {
    itemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ReconciliationItem",
      required: true,
    },
    decisionVersion: { type: Number, min: 0, required: true },
  },
  { _id: false }
);

const BulkReviewOperationSchema = new mongoose.Schema(
  {
    operationId: {
      type: String,
      trim: true,
      match: OPERATION_ID_PATTERN,
      maxlength: 64,
      default: null,
    },
    state: { type: String, enum: ["PENDING", "COMPLETED"], default: null },
    action: { type: String, trim: true, maxlength: 80, default: null },
    previewToken: { type: String, trim: true, maxlength: 128, default: "" },
    payload: { type: ReviewCommandPayloadSchema, default: () => ({}) },
    actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    itemVersions: {
      type: [BulkReviewItemVersionSchema],
      default: () => [],
      validate: {
        validator(entries) {
          const itemIds = (entries || []).map((entry) => String(entry.itemId || ""));
          return itemIds.length === new Set(itemIds).size;
        },
        message: "Bulk review item versions must contain unique item IDs",
      },
    },
    affectedByStatus: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    affectedCount: { type: Number, min: 0, default: 0 },
    requestId: { type: String, trim: true, maxlength: 160, default: "" },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { _id: false }
);

const ReconciliationRunSchema = new mongoose.Schema(
  {
    firmId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Firm",
      required: true,
      index: true,
    },
    clientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      required: true,
      index: true,
    },
    kind: { type: String, enum: ["GST_ITC"], default: "GST_ITC", required: true },
    gstin: { type: String, trim: true, uppercase: true, maxlength: 15, required: true },
    period: { type: String, match: /^\d{4}-(0[1-9]|1[0-2])$/, required: true },
    sourceImports: {
      booksBatchId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "ImportBatch",
        required: true,
      },
      portalBatchId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "ImportBatch",
        required: true,
      },
      gstr3bBatchId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "ImportBatch",
        default: null,
      },
    },
    sourceFingerprint: { type: String, trim: true, maxlength: 128, required: true },
    revision: {
      type: Number,
      min: 1,
      default: 1,
      validate: {
        validator: Number.isInteger,
        message: "Revision must be an integer",
      },
    },
    rootRunId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ReconciliationRun",
      default: null,
    },
    parentRunId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ReconciliationRun",
      default: null,
    },
    status: {
      type: String,
      enum: RECONCILIATION_RUN_STATUSES,
      default: "QUEUED",
      index: true,
    },
    reviewVersion: {
      type: Number,
      min: 0,
      default: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: "reviewVersion must be a nonnegative safe integer",
      },
    },
    reviewMutationActive: { type: Boolean, default: false },
    reviewMutationToken: {
      type: String,
      trim: true,
      match: LEASE_TOKEN_PATTERN,
      maxlength: 36,
      default: null,
    },
    reviewMutationFence: {
      type: Number,
      min: 0,
      default: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: "reviewMutationFence must be a nonnegative safe integer",
      },
    },
    reviewMutationExpiresAt: { type: Date, default: null },
    summaryDirty: { type: Boolean, default: false },
    pendingReviewTransition: {
      type: PendingReviewTransitionSchema,
      default: () => ({}),
    },
    bulkReviewOperation: {
      type: BulkReviewOperationSchema,
      default: () => ({}),
    },
    lastCompletedReviewOperationId: {
      type: String,
      trim: true,
      match: OPERATION_ID_PATTERN,
      maxlength: 64,
      default: null,
    },
    lockStartedAt: { type: Date, default: null },
    lockToken: {
      type: String,
      trim: true,
      match: LEASE_TOKEN_PATTERN,
      maxlength: 36,
      default: null,
    },
    lockExpiresAt: { type: Date, default: null },
    activeGenerationAttempt: {
      type: Number,
      min: 0,
      default: 0,
      validate: {
        validator: Number.isInteger,
        message: "Active generation attempt must be an integer",
      },
    },
    processingJobId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AutomationJob",
      default: null,
    },
    processingAttempt: { type: Number, min: 0, default: 0 },
    matchingConfig: {
      version: { type: String, trim: true, maxlength: 80, default: "gst-match-v1" },
      roundingToleranceMinor: { type: Number, min: 0, max: 10000, default: 100 },
      dateToleranceDays: { type: Number, min: 0, max: 31, default: 3 },
    },
    priorPeriodAdjustment: { type: TaxHeadsSchema, default: () => ({}) },
    summary: { type: RunSummarySchema, default: () => ({}) },
    jobId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AutomationJob",
      default: null,
    },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    reviewer: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    reviewedAt: { type: Date, default: null },
    lockedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    lockedAt: { type: Date, default: null },
    lastError: { type: String, trim: true, maxlength: 600, default: "" },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

ReconciliationRunSchema.index(
  { firmId: 1, sourceFingerprint: 1, revision: 1 },
  { unique: true }
);
ReconciliationRunSchema.index(
  { firmId: 1, rootRunId: 1, revision: 1 },
  {
    unique: true,
    partialFilterExpression: { rootRunId: { $type: "objectId" } },
  }
);
ReconciliationRunSchema.index(
  { firmId: 1, parentRunId: 1 },
  {
    unique: true,
    partialFilterExpression: { parentRunId: { $type: "objectId" } },
  }
);
ReconciliationRunSchema.index({ firmId: 1, clientId: 1, period: -1, createdAt: -1 });
ReconciliationRunSchema.index({ firmId: 1, status: 1, updatedAt: -1 });

const ReconciliationRun = mongoose.model(
  "ReconciliationRun",
  ReconciliationRunSchema
);

export { RECONCILIATION_RUN_STATUSES, TaxHeadsSchema };
export default ReconciliationRun;
