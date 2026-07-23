import mongoose from "mongoose";

const RECONCILIATION_ITEM_STATUSES = Object.freeze([
  "MATCHED",
  "MISSING_IN_2B",
  "MISSING_IN_BOOKS",
  "TAX_AMOUNT_MISMATCH",
  "TAXABLE_VALUE_MISMATCH",
  "DATE_MISMATCH",
  "GSTIN_MISMATCH",
  "DUPLICATE_IN_BOOKS",
  "DUPLICATE_IN_2B",
  "POSSIBLE_AMENDMENT",
  "AMBIGUOUS_MATCH",
  "INELIGIBLE_OR_BLOCKED",
  "DEFERRED_TO_NEXT_PERIOD",
  "USER_ACCEPTED_EXCEPTION",
  "NEEDS_REVIEW",
]);

const DISPOSITION_ACTIONS = Object.freeze([
  "ACCEPT_MATCH",
  "UNMATCH",
  "SUPPLIER_FOLLOW_UP",
  "BOOKS_CORRECTION",
  "PORTAL_CORRECTION",
  "MARK_INELIGIBLE",
  "DEFER",
  "ACCEPT_EXCEPTION",
  "ADD_NOTE",
  "ASSIGN",
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

const MoneyBreakdownSchema = new mongoose.Schema(
  {
    taxableValueMinor: moneyField(),
    igstMinor: moneyField(),
    cgstMinor: moneyField(),
    sgstMinor: moneyField(),
    cessMinor: moneyField(),
    totalTaxMinor: moneyField(),
  },
  { _id: false }
);

const ReconciliationItemSchema = new mongoose.Schema(
  {
    firmId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Firm",
      required: true,
      index: true,
    },
    runId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ReconciliationRun",
      required: true,
      index: true,
    },
    clientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      required: true,
      index: true,
    },
    generationAttempt: {
      type: Number,
      min: 1,
      default: 1,
      index: true,
      validate: {
        validator: Number.isInteger,
        message: "Generation attempt must be an integer",
      },
    },
    itemKey: { type: String, trim: true, maxlength: 160, required: true },
    isActive: { type: Boolean, default: true },
    retiredPortalRowId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ImportRow",
      default: null,
    },
    lastLifecycleOperationId: {
      type: String,
      trim: true,
      match: OPERATION_ID_PATTERN,
      maxlength: 64,
      default: null,
    },
    booksRowId: { type: mongoose.Schema.Types.ObjectId, ref: "ImportRow", default: null },
    portalRowId: { type: mongoose.Schema.Types.ObjectId, ref: "ImportRow", default: null },
    candidatePortalRowIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "ImportRow" }],
      default: () => [],
    },
    candidateHistoryPortalRowIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "ImportRow" }],
      default: () => [],
    },
    booksSourceRow: { type: Number, min: 2, default: null },
    portalSourceRow: { type: Number, min: 2, default: null },
    supplierGstin: { type: String, trim: true, uppercase: true, maxlength: 15, default: "" },
    invoiceNumberOriginal: { type: String, trim: true, maxlength: 120, default: "" },
    invoiceNumberNormalized: { type: String, trim: true, uppercase: true, maxlength: 120, default: "" },
    documentType: { type: String, trim: true, uppercase: true, maxlength: 40, default: "" },
    documentDate: { type: String, match: /^\d{4}-\d{2}-\d{2}$/, default: null },
    booksAmounts: { type: MoneyBreakdownSchema, default: () => ({}) },
    portalAmounts: { type: MoneyBreakdownSchema, default: () => ({}) },
    differences: { type: MoneyBreakdownSchema, default: () => ({}) },
    dateDifferenceDays: { type: Number, default: null },
    status: { type: String, enum: RECONCILIATION_ITEM_STATUSES, required: true, index: true },
    originalStatus: { type: String, enum: RECONCILIATION_ITEM_STATUSES, required: true },
    matchRule: {
      type: String,
      enum: ["EXACT", "TOLERANT", "CANDIDATE", "NONE", "USER"],
      default: "NONE",
    },
    autoAccepted: { type: Boolean, default: false },
    resolutionState: {
      type: String,
      enum: ["OPEN", "RESOLVED"],
      default: "OPEN",
      index: true,
    },
    decisionVersion: {
      type: Number,
      min: 0,
      default: 0,
      validate: {
        validator: Number.isInteger,
        message: "Decision version must be an integer",
      },
    },
    lastReviewOperationId: {
      type: String,
      trim: true,
      match: OPERATION_ID_PATTERN,
      maxlength: 64,
      default: null,
    },
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
    pendingTransition: {
      operationId: {
        type: String,
        trim: true,
        match: OPERATION_ID_PATTERN,
        maxlength: 64,
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
      startedAt: { type: Date, default: null },
    },
    userDisposition: {
      action: { type: String, enum: DISPOSITION_ACTIONS, default: null },
      reason: { type: String, trim: true, maxlength: 500, default: "" },
      note: { type: String, trim: true, maxlength: 1000, default: "" },
      ownerUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      updatedAt: { type: Date, default: null },
    },
    chase: {
      required: { type: Boolean, default: false },
      state: {
        type: String,
        enum: ["NONE", "MARKED", "OPENED", "COPIED", "REQUESTED"],
        default: "NONE",
      },
      lastActionAt: { type: Date, default: null },
    },
    taskId: { type: mongoose.Schema.Types.ObjectId, ref: "Task", default: null },
    reviewedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

ReconciliationItemSchema.pre("validate", function enforceReviewSafety(next) {
  const isRetiredPortalTombstone =
    this.isActive === false && Boolean(this.retiredPortalRowId) && !this.portalRowId;
  if (!this.booksRowId && !this.portalRowId && !isRetiredPortalTombstone) {
    return next(new Error("Reconciliation item must reference at least one source row"));
  }
  if (this.isActive === false && !isRetiredPortalTombstone) {
    return next(new Error("Inactive reconciliation items must retain only a retired portal row"));
  }
  if (this.isActive !== false && this.retiredPortalRowId) {
    return next(new Error("Active reconciliation items cannot retain a retired portal row"));
  }
  if (this.status === "AMBIGUOUS_MATCH" && this.autoAccepted) {
    return next(new Error("Ambiguous matches cannot be auto-accepted"));
  }
  if (this.autoAccepted && (this.status !== "MATCHED" || this.matchRule !== "EXACT")) {
    return next(new Error("Only exact zero-difference matches can be auto-accepted"));
  }
  if (this.resolutionState === "RESOLVED" && this.status === "AMBIGUOUS_MATCH") {
    return next(new Error("Ambiguous matches require an explicit disposition"));
  }
  return next();
});

ReconciliationItemSchema.index(
  { firmId: 1, runId: 1, generationAttempt: 1, itemKey: 1 },
  { unique: true }
);
ReconciliationItemSchema.index(
  { firmId: 1, runId: 1, generationAttempt: 1, portalRowId: 1 },
  {
    unique: true,
    partialFilterExpression: { portalRowId: { $type: "objectId" } },
  }
);
ReconciliationItemSchema.index({ firmId: 1, runId: 1, generationAttempt: 1, status: 1, _id: 1 });
ReconciliationItemSchema.index({ firmId: 1, runId: 1, generationAttempt: 1, supplierGstin: 1, _id: 1 });

const ReconciliationItem = mongoose.model(
  "ReconciliationItem",
  ReconciliationItemSchema
);

export { DISPOSITION_ACTIONS, RECONCILIATION_ITEM_STATUSES, MoneyBreakdownSchema };
export default ReconciliationItem;
