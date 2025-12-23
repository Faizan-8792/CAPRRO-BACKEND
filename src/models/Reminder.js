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

    // Offsets in days relative to due date: e.g. [-7, -3, -1, 0]
    offsets: {
      type: [Number],
      default: [],
    },

    // Whether reminder is active
    isActive: {
      type: Boolean,
      default: true,
    },

    // Track which offsets already fired to avoid duplicate sending
    firedOffsets: {
      type: [Number],
      default: [],
    },

    // Flag: immediate near-due mail already sent at create time
    sentImmediate: {
      type: Boolean,
      default: false,
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

const Reminder = mongoose.model("Reminder", ReminderSchema);

export default Reminder;
