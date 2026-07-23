import mongoose from "mongoose";

const PROVIDER_OPERATION_ACTIONS = Object.freeze([
  "CASE_EXTRACTION",
  "CASE_ANALYSIS",
  "CASE_DRAFT",
]);

const CaseProviderOperationSchema = new mongoose.Schema(
  {
    firmId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Firm",
      required: true,
      immutable: true,
    },
    caseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CaseMatter",
      required: true,
      immutable: true,
    },
    action: {
      type: String,
      enum: PROVIDER_OPERATION_ACTIONS,
      required: true,
      immutable: true,
    },
    mutationKey: {
      type: String,
      trim: true,
      maxlength: 120,
      required: true,
      immutable: true,
    },
    requestHash: {
      type: String,
      match: /^[a-f0-9]{64}$/,
      required: true,
      immutable: true,
    },
    status: {
      type: String,
      enum: ["PROCESSING", "COMPLETED", "FAILED"],
      default: "PROCESSING",
    },
    leaseToken: { type: String, trim: true, maxlength: 80, default: "" },
    leaseExpiresAt: { type: Date, default: null },
    attemptCount: { type: Number, min: 1, default: 1 },
    stagedResult: { type: String, maxlength: 600000, default: "" },
    stagedResultHash: {
      type: String,
      match: /^[a-f0-9]{64}$/,
      default: null,
    },
    stagedAt: { type: Date, default: null },
    resultId: { type: mongoose.Schema.Types.ObjectId, default: null },
    completedAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    failureCode: { type: String, trim: true, maxlength: 80, default: "" },
  },
  { timestamps: true }
);

CaseProviderOperationSchema.index(
  { firmId: 1, caseId: 1, mutationKey: 1 },
  { unique: true, name: "unique_case_provider_operation" }
);
CaseProviderOperationSchema.index(
  { status: 1, leaseExpiresAt: 1 },
  { name: "case_provider_operation_lease" }
);

const CaseProviderOperation = mongoose.model(
  "CaseProviderOperation",
  CaseProviderOperationSchema
);

export { PROVIDER_OPERATION_ACTIONS };
export default CaseProviderOperation;
