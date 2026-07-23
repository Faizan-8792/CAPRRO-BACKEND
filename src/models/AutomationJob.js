import mongoose from "mongoose";

const JOB_STATUSES = Object.freeze([
  "PENDING",
  "PROCESSING",
  "RETRY_SCHEDULED",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
]);

const LeaseSchema = new mongoose.Schema(
  {
    token: { type: String, default: null },
    owner: { type: String, default: null, maxlength: 160 },
    acquiredAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
  },
  { _id: false }
);

const AutomationJobSchema = new mongoose.Schema(
  {
    firmId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Firm",
      required: true,
      index: true,
    },
    kind: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      maxlength: 100,
    },
    status: { type: String, enum: JOB_STATUSES, default: "PENDING", index: true },
    idempotencyKey: { type: String, required: true, trim: true, maxlength: 240 },
    payload: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    resultSummary: { type: mongoose.Schema.Types.Mixed, default: null },
    attemptCount: { type: Number, min: 0, default: 0 },
    maxAttempts: { type: Number, min: 1, max: 100000, default: 5 },
    nextAttemptAt: { type: Date, default: Date.now, index: true },
    lease: { type: LeaseSchema, default: () => ({}) },
    lastError: { type: String, maxlength: 600, default: "" },
    requestId: { type: String, maxlength: 160, default: "" },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

AutomationJobSchema.index(
  { firmId: 1, kind: 1, idempotencyKey: 1 },
  { unique: true }
);
AutomationJobSchema.index({ status: 1, nextAttemptAt: 1, "lease.expiresAt": 1 });
AutomationJobSchema.index({ firmId: 1, status: 1, createdAt: -1 });
AutomationJobSchema.index({ firmId: 1, _id: -1 });

const AutomationJob = mongoose.model("AutomationJob", AutomationJobSchema);

export { JOB_STATUSES };
export default AutomationJob;
