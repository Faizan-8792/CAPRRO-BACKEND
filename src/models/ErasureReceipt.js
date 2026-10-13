import mongoose from "mongoose";

/**
 * The record of a firm erasure — and, deliberately, the cascade's durable progress state.
 *
 * WHY THESE ARE THE SAME DOCUMENT
 * -------------------------------
 * L12 requires the cascade to survive a process kill without leaving a half-erased firm, and its
 * Verify includes an interruption test. Two separate stores (one for progress, one for the receipt)
 * could themselves disagree after a crash, so there is one: each step is marked COMPLETED as it
 * finishes, and a resumed run skips whatever is already marked. The receipt you read afterwards is
 * the same document the cascade was steering by, so it cannot claim work it did not do.
 *
 * WHY NOT ONE TRANSACTION INSTEAD
 * -------------------------------
 * Transactions are available here — `withTransaction` is used in seven other services. They are not
 * used for the whole cascade because MongoDB caps a transaction at 16MB of oplog and 60 seconds by
 * default, and this spans 32 collections with unbounded per-firm volume. A cascade that works for a
 * small firm and aborts for a large one is worse than one that is honestly resumable. Individual
 * steps are single statements; the receipt makes the sequence recoverable.
 *
 * WHAT IT DELIBERATELY DOES NOT HOLD
 * ----------------------------------
 * No erased content, no email addresses, no names. A receipt proving an erasure happened must not
 * become the last surviving copy of what was erased. It holds collection names, counts and status.
 */

const StepSchema = new mongoose.Schema(
  {
    collectionName: { type: String, required: true, trim: true, maxlength: 100 },
    strategy: {
      type: String,
      required: true,
      enum: ["PURGE", "PSEUDONYMISE", "RETAIN"],
    },
    status: {
      type: String,
      required: true,
      enum: ["PENDING", "COMPLETED", "FAILED"],
      default: "PENDING",
    },
    /** Documents purged, pseudonymised, or counted-and-kept for RETAIN. */
    affected: { type: Number, default: 0, min: 0 },
    /** A stable error code, never a driver message — those can carry connection detail. */
    errorCode: { type: String, default: null, trim: true, maxlength: 120 },
    completedAt: { type: Date, default: null },
  },
  { _id: false },
);

const ErasureReceiptSchema = new mongoose.Schema(
  {
    /**
     * Caller-supplied and unique. Retrying an interrupted erasure means re-invoking with the SAME
     * operationId, which is what makes the operation idempotent rather than merely repeatable: a
     * second call resumes the existing receipt instead of starting a parallel cascade.
     */
    operationId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      maxlength: 120,
    },
    firmId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Firm",
      required: true,
      index: true,
    },
    /** Kept for provenance. The firm row itself is gone by the end, so the name would be too. */
    firmDisplayName: { type: String, default: "", trim: true, maxlength: 200 },
    /** The super administrator who authorised it. An erasure with no named authoriser is not auditable. */
    authorisedByUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    /** Free-text reference to the written request L9 requires, e.g. a ticket id. Not the request itself. */
    requestReference: { type: String, default: "", trim: true, maxlength: 200 },
    status: {
      type: String,
      required: true,
      enum: ["IN_PROGRESS", "COMPLETED", "FAILED"],
      default: "IN_PROGRESS",
      index: true,
    },
    /** Incremented on every invocation for this operationId, so a resumed run is visible as one. */
    attempts: { type: Number, default: 0, min: 0 },
    steps: { type: [StepSchema], default: [] },
    startedAt: { type: Date, default: Date.now },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "erasurereceipts" },
);

ErasureReceiptSchema.index({ firmId: 1, createdAt: -1 });

/** True once every step has reached COMPLETED. Derived, so it cannot disagree with the steps. */
ErasureReceiptSchema.methods.isComplete = function isComplete() {
  return this.steps.length > 0 && this.steps.every((s) => s.status === "COMPLETED");
};

/**
 * The shape handed back to a caller. Explicitly built rather than returning the document, so a
 * later schema addition cannot start leaking something into an API response by accident.
 */
ErasureReceiptSchema.methods.toReceipt = function toReceipt() {
  const purged = this.steps.filter((s) => s.strategy === "PURGE");
  const pseudonymised = this.steps.filter((s) => s.strategy === "PSEUDONYMISE");
  const retained = this.steps.filter((s) => s.strategy === "RETAIN");
  const sum = (rows) => rows.reduce((total, s) => total + (s.affected || 0), 0);

  return {
    operationId: this.operationId,
    firmId: String(this.firmId),
    firmDisplayName: this.firmDisplayName,
    authorisedByUserId: this.authorisedByUserId ? String(this.authorisedByUserId) : null,
    requestReference: this.requestReference,
    status: this.status,
    attempts: this.attempts,
    startedAt: this.startedAt,
    completedAt: this.completedAt,
    totals: {
      collections: this.steps.length,
      purgedDocuments: sum(purged),
      pseudonymisedDocuments: sum(pseudonymised),
      retainedDocuments: sum(retained),
    },
    steps: this.steps.map((s) => ({
      collection: s.collectionName,
      strategy: s.strategy,
      status: s.status,
      affected: s.affected,
      errorCode: s.errorCode,
      completedAt: s.completedAt,
    })),
  };
};

export default mongoose.model("ErasureReceipt", ErasureReceiptSchema);
