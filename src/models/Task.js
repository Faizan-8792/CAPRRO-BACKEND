// src/models/Task.js

import mongoose from "mongoose";

const TaskSchema = new mongoose.Schema(
  {
    // Firm-level board: har task kisi firm ka hoga
    firmId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Firm",
      required: true,
    },

    // Kisne create kiya
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // Client ka naam / label
    clientName: {
      type: String,
      required: true,
      trim: true,
    },

    // Service type: GST, TDS, ITR, ROC, AUDIT, OTHER
    serviceType: {
      type: String,
      enum: ["GST", "TDS", "ITR", "ROC", "AUDIT", "OTHER"],
      default: "OTHER",
    },

    // Short title: e.g. "GSTR-3B Apr 2025"
    title: {
      type: String,
      required: true,
      trim: true,
    },

    // Due date for this task
    dueDateISO: {
      type: String,
      required: true,
    },

    // Assigned staff
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    // Board columns
    status: {
      type: String,
      enum: [
        "NOT_STARTED",
        "WAITING_DOCS",
        "IN_PROGRESS",
        "FILED",
        "CLOSED",
      ],
      default: "NOT_STARTED",
    },

    // Explicit workflow transition evidence; edits after completion do not move it.
    completedAt: {
      type: Date,
      default: null,
    },
    completedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    filedAt: {
      type: Date,
      default: null,
    },
    filedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    documentReadiness: {
      type: String,
      enum: ["UNKNOWN", "PENDING", "PARTIAL", "READY"],
      default: "UNKNOWN",
    },
    reconciliationExceptionCount: {
      type: Number,
      min: 0,
      default: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: "reconciliationExceptionCount must be a nonnegative safe integer",
      },
    },
    reviewStatus: {
      type: String,
      enum: ["NOT_REQUIRED", "PENDING", "APPROVED", "CHANGES_REQUESTED"],
      default: "NOT_REQUIRED",
    },
    mutationVersion: {
      type: Number,
      min: 0,
      default: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: "mutationVersion must be a nonnegative safe integer",
      },
    },
    lastBulkMutation: {
      operationId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "TaskBulkOperation",
        default: null,
      },
      itemKey: { type: String, trim: true, maxlength: 64, default: "" },
      appliedAt: { type: Date, default: null },
    },

    // Soft delete / archive
    isActive: {
      type: Boolean,
      default: true,
    },

    // Optional link to reminder
    reminderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Reminder",
      default: null,
    },

    // Additive links and provenance for rule-generated work.
    source: {
      type: String,
      enum: [
        "MANUAL",
        "COMPLIANCE_RULE",
        "IMPORT",
        "RECONCILIATION",
        "CASE",
        "ENGAGEMENT",
      ],
      default: "MANUAL",
    },
    clientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      default: null,
    },
    caseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CaseMatter",
      default: null,
    },
    taxWorkSessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TaxWorkSession",
      default: null,
    },
    complianceRuleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ComplianceRule",
      default: null,
    },
    complianceRuleVersion: { type: Number, min: 1, default: null },
    complianceCode: {
      type: String,
      trim: true,
      uppercase: true,
      maxlength: 80,
      default: null,
    },
    period: { type: String, trim: true, maxlength: 80, default: null },
    ruleSourceReference: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: null,
    },
    generationKey: {
      type: String,
      trim: true,
      maxlength: 200,
      default: null,
    },
    automationJobId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AutomationJob",
      default: null,
    },

    // Extra data
    // Meta field conventions:
    // docsStatus: "PENDING" / "RECEIVED"
    // periodKey: e.g. "2025-04_GSTR1_ABC" (client + period identify karne ke liye)
    // delayDays: number (days late, 0 ya negative matlab time par / early)
    meta: {
      type: mongoose.Schema.Types.Mixed,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes for performance
TaskSchema.index({ firmId: 1, isActive: 1 });
TaskSchema.index({ firmId: 1, status: 1 });
TaskSchema.index({ firmId: 1, assignedTo: 1 });
TaskSchema.index({ firmId: 1, dueDateISO: 1 });
TaskSchema.index(
  { firmId: 1, isActive: 1, status: 1, dueDateISO: 1, _id: 1 },
  { name: "workspace_task_firm_due" }
);
TaskSchema.index(
  { firmId: 1, assignedTo: 1, isActive: 1, status: 1, dueDateISO: 1, _id: 1 },
  { name: "workspace_task_assignee_due" }
);
TaskSchema.index(
  { firmId: 1, createdBy: 1, isActive: 1, status: 1, dueDateISO: 1, _id: 1 },
  { name: "workspace_task_creator_due" }
);
TaskSchema.index(
  { firmId: 1, completedAt: -1, _id: 1 },
  { name: "workspace_task_completion" }
);
TaskSchema.index({ firmId: 1, clientId: 1, period: 1 });
TaskSchema.index({ firmId: 1, caseId: 1, isActive: 1 });
TaskSchema.index(
  {
    firmId: 1,
    isActive: 1,
    clientId: 1,
    complianceCode: 1,
    dueDateISO: 1,
    _id: 1,
  },
  { name: "filing_dashboard_task_matrix" }
);
TaskSchema.index(
  {
    firmId: 1,
    isActive: 1,
    assignedTo: 1,
    status: 1,
    source: 1,
    dueDateISO: 1,
  },
  { name: "team_workload_task_counts" }
);
TaskSchema.index(
  { firmId: 1, isActive: 1, reviewStatus: 1, updatedAt: -1, _id: -1 },
  { name: "task_review_queue" }
);
TaskSchema.index(
  { firmId: 1, generationKey: 1 },
  {
    unique: true,
    partialFilterExpression: { generationKey: { $type: "string" } },
    name: "unique_generated_task_per_firm",
  }
);

TaskSchema.pre("save", function incrementMutationVersion() {
  if (this.isNew) return;
  const changed = this.modifiedPaths().some(
    (path) => !["mutationVersion", "updatedAt"].includes(path)
  );
  if (changed) this.mutationVersion += 1;
});

const Task = mongoose.model("Task", TaskSchema);

export default Task;
