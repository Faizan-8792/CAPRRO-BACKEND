import mongoose from "mongoose";

const WorkspaceOperationFailureSchema = new mongoose.Schema(
  {
    httpStatus: { type: Number, min: 400, max: 599, required: true },
    message: { type: String, trim: true, maxlength: 300, required: true },
  },
  { _id: false }
);

const WorkspaceOperationSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    operationId: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      match: /^[a-f0-9]{32}$/,
    },
    kind: {
      type: String,
      enum: ["CREATE", "SWITCH", "JOIN"],
      required: true,
    },
    requestHash: {
      type: String,
      required: true,
      match: /^[a-f0-9]{64}$/,
    },
    status: {
      type: String,
      enum: ["PENDING", "SUCCEEDED", "REJECTED"],
      default: "PENDING",
      required: true,
    },
    activeFirmId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Firm",
      default: null,
    },
    failure: {
      type: WorkspaceOperationFailureSchema,
      default: null,
    },
    completedAt: {
      type: Date,
      default: null,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  { timestamps: true }
);

WorkspaceOperationSchema.index(
  { userId: 1, operationId: 1 },
  { unique: true, name: "workspace_operation_user_id" }
);
WorkspaceOperationSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: "workspace_operation_expiry" }
);

const WorkspaceOperation = mongoose.model(
  "WorkspaceOperation",
  WorkspaceOperationSchema
);

export default WorkspaceOperation;
