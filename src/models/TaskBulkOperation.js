import mongoose from "mongoose";

const ITEM_STATUSES = Object.freeze(["PENDING", "SUCCEEDED", "FAILED"]);
const OPERATION_STATUSES = Object.freeze([
  "PREVIEWED",
  "COMMITTING",
  "COMPLETED",
  "EXPIRED",
]);

const BulkItemSchema = new mongoose.Schema(
  {
    itemKey: {
      type: String,
      required: true,
      trim: true,
      match: /^[a-f0-9]{64}$/,
    },
    taskId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Task",
      required: true,
    },
    snapshotVersion: { type: Number, min: 0, required: true },
    before: { type: mongoose.Schema.Types.Mixed, required: true },
    patch: { type: mongoose.Schema.Types.Mixed, required: true },
    status: { type: String, enum: ITEM_STATUSES, default: "PENDING" },
    code: { type: String, trim: true, maxlength: 80, default: "" },
    message: { type: String, trim: true, maxlength: 500, default: "" },
    appliedVersion: { type: Number, min: 0, default: null },
    result: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: false }
);

const TaskBulkOperationSchema = new mongoose.Schema(
  {
    firmId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Firm",
      required: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    tokenHash: {
      type: String,
      required: true,
      immutable: true,
      match: /^[a-f0-9]{64}$/,
    },
    contentHash: {
      type: String,
      required: true,
      immutable: true,
      match: /^[a-f0-9]{64}$/,
    },
    status: {
      type: String,
      enum: OPERATION_STATUSES,
      default: "PREVIEWED",
    },
    items: {
      type: [BulkItemSchema],
      required: true,
      validate: {
        validator: (items) => Array.isArray(items) && items.length >= 1 && items.length <= 100,
        message: "Task bulk operations require 1 to 100 items",
      },
    },
    lease: {
      token: { type: String, trim: true, maxlength: 80, default: "" },
      acquiredAt: { type: Date, default: null },
      expiresAt: { type: Date, default: null },
    },
    requestId: { type: String, trim: true, maxlength: 160, default: "" },
    committedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
    purgeAt: { type: Date, required: true },
  },
  { timestamps: true }
);

TaskBulkOperationSchema.index({ firmId: 1, status: 1, createdAt: -1 });
TaskBulkOperationSchema.index(
  { purgeAt: 1 },
  { expireAfterSeconds: 0, name: "purge_task_bulk_operations" }
);

const TaskBulkOperation = mongoose.model(
  "TaskBulkOperation",
  TaskBulkOperationSchema
);

export { ITEM_STATUSES, OPERATION_STATUSES };
export default TaskBulkOperation;
