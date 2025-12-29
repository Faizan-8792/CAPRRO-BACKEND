import mongoose from "mongoose";

const AccountingRecordSchema = new mongoose.Schema(
  {
    // Ownership
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

    // Business identity
    clientName: {
      type: String,
      required: true,
      trim: true,
    },

    periodKey: {
      type: String,
      required: true, // e.g. 2024-04 / FY2023-24
    },

    source: {
      type: String,
      enum: ["MANUAL", "CSV"],
      required: true,
    },

    // Derived metrics
    totalEntries: Number,
    totalDebit: Number,
    totalCredit: Number,
    roundFigureCount: Number,
    lastEntryDate: String,

    // Intelligence output
    health: {
      type: String,
      enum: ["GREEN", "AMBER", "RED"],
      required: true,
    },

    readinessScore: {
      type: Number,
      min: 0,
      max: 100,
      required: true,
    },

    riskFlags: {
      type: [String],
      default: [],
    },

    summaryNotes: {
      type: String,
      default: "",
    },

    // CSV extraction metadata
    csvExtractionMeta: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    // Retention
    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },

    meta: {
      type: mongoose.Schema.Types.Mixed,
    },
  },
  { timestamps: true }
);

export default mongoose.model("AccountingRecord", AccountingRecordSchema);