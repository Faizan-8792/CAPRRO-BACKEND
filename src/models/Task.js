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

    // Extra data
    // Meta field conventions:
    // docsStatus: "PENDING" / "RECEIVED"
    // periodKey: e.g. "2025-04_GSTR1_ABC" (client + period identify karne ke liye)
    // delayDays: number (days late, 0 ya negative matlab time par / early)
    // delayReason: String,        // "CLIENT", "DOCS", "INTERNAL", "PORTAL"
    // lastFollowUpAt: Date,       // last chase kab hua
    // waitingSince: Date,         // WAITING_DOCS start date
    // escalated: Boolean          // partner ko escalate hua ya nahi
    meta: {
      type: mongoose.Schema.Types.Mixed,
    },
  },
  {
    timestamps: true,
  }
);

const Task = mongoose.model("Task", TaskSchema);

export default Task;