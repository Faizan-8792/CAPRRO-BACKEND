// src/models/Reminder.js

import mongoose from "mongoose";

const ReminderSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // Optional: firm link so admin can see firm-wide reminders
    firmId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Firm",
      default: null,
    },

    // e.g. "GST_GSTR1", "ITR_AUDIT", "GENERIC"
    typeId: {
      type: String,
      required: true,
      trim: true,
    },

    clientLabel: {
      type: String,
      trim: true,
    },

    // Due date in ISO e.g. "2025-04-20T00:00:00.000Z"
    dueDateISO: {
      type: String,
      required: true,
    },

    // Relative offsets: -7 is seven days before due date, 0 is due date.
    offsets: {
      type: [Number],
      default: [],
    },

    isActive: {
      type: Boolean,
      default: true,
    },

    // Schedule changes increment this value so old attempt history cannot
    // suppress or collide with the active schedule.
    scheduleVersion: {
      type: Number,
      default: 1,
      min: 1,
    },

    // Success-only dedup evidence retained for compatibility.
    firedOffsets: {
      type: [Number],
      default: [],
    },

    // Legacy-compatible immediate-send success flag.
    sentImmediate: {
      type: Boolean,
      default: false,
    },

    // Last successful delivery timestamp.
    sentAt: {
      type: Date,
      default: null,
    },

    // Controlled map keyed by "immediate" or "offset_m7"/"offset_0".
    // Each value stores status, claim token, retry timing, provider, and error.
    deliveryAttempts: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },

    // Additive links and provenance for rule-generated schedules.
    source: {
      type: String,
      enum: ["MANUAL", "COMPLIANCE_RULE", "CASE", "ENGAGEMENT"],
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
    taskId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Task",
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

    // Any extra metadata from extension
    meta: {
      type: mongoose.Schema.Types.Mixed,
    },
  },
  {
    timestamps: true,
  }
);

ReminderSchema.index({ userId: 1, isActive: 1 });
ReminderSchema.index({ firmId: 1, isActive: 1 });
ReminderSchema.index({ dueDateISO: 1, isActive: 1 });
ReminderSchema.index(
  { firmId: 1, isActive: 1, dueDateISO: 1, _id: 1 },
  { name: "workspace_reminder_firm_due" }
);
ReminderSchema.index(
  { firmId: 1, userId: 1, isActive: 1, dueDateISO: 1, _id: 1 },
  { name: "workspace_reminder_user_due" }
);
ReminderSchema.index({ firmId: 1, clientId: 1, period: 1 });
ReminderSchema.index({ firmId: 1, caseId: 1, isActive: 1 });
ReminderSchema.index(
  { firmId: 1, generationKey: 1 },
  {
    unique: true,
    partialFilterExpression: { generationKey: { $type: "string" } },
    name: "unique_generated_reminder_per_firm",
  }
);

const Reminder = mongoose.model("Reminder", ReminderSchema);

export default Reminder;
