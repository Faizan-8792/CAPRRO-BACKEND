import mongoose from "mongoose";

const RUN_STATUSES = Object.freeze([
  "QUEUED",
  "RUNNING",
  "RECOVERING",
  "CLEANUP_FAILED",
  "COMPLETED",
  "CRASHED",
]);

const OVERALL_STATUSES = Object.freeze(["PENDING", "PASS", "WARN", "FAIL"]);

const SeedRecordSchema = new mongoose.Schema(
  {
    modelName: { type: String, required: true, trim: true, maxlength: 100 },
    id: { type: mongoose.Schema.Types.ObjectId, required: true },
  },
  { _id: false }
);

const SystemTestRunSchema = new mongoose.Schema(
  {
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: RUN_STATUSES,
      default: "QUEUED",
      index: true,
    },
    activeKey: {
      type: String,
      trim: true,
      maxlength: 40,
      default: "GLOBAL",
    },
    executionToken: {
      type: String,
      trim: true,
      maxlength: 100,
      default: null,
    },
    phase: { type: String, trim: true, maxlength: 160, default: "Queued" },
    progress: {
      completed: { type: Number, min: 0, default: 0 },
      total: { type: Number, min: 0, default: 0 },
      percent: { type: Number, min: 0, max: 100, default: 0 },
      currentCheck: { type: String, trim: true, maxlength: 240, default: "" },
    },
    summary: {
      total: { type: Number, min: 0, default: 0 },
      passed: { type: Number, min: 0, default: 0 },
      failed: { type: Number, min: 0, default: 0 },
      warned: { type: Number, min: 0, default: 0 },
      sectionsCovered: { type: Number, min: 0, default: 0 },
      sectionsExpected: { type: Number, min: 0, default: 0 },
      overall: {
        type: String,
        enum: OVERALL_STATUSES,
        default: "PENDING",
      },
    },
    groups: { type: [mongoose.Schema.Types.Mixed], default: [] },
    deepSeekReview: { type: mongoose.Schema.Types.Mixed, default: null },
    cleanup: { type: mongoose.Schema.Types.Mixed, default: null },
    cleanupManifest: { type: [SeedRecordSchema], default: [] },
    error: { type: String, trim: true, maxlength: 1200, default: "" },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    expiresAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

SystemTestRunSchema.index(
  { activeKey: 1 },
  {
    unique: true,
    partialFilterExpression: { activeKey: { $type: "string" } },
    name: "one_active_system_test",
  }
);
SystemTestRunSchema.index({ createdAt: -1, _id: -1 });
SystemTestRunSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const SystemTestRun = mongoose.model("SystemTestRun", SystemTestRunSchema);

export { OVERALL_STATUSES, RUN_STATUSES };
export default SystemTestRun;
