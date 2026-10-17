// src/models/EngagementAssurance.js
//
// W10 AP38 (2026-10-17). What an engagement's file needs to show about WHO did and confirmed what, and
// WHEN the file was assembled: dated independence confirmations per team member, the report date and the
// assembly timer that runs from it, the log of changes after assembly, and the time worked.
//
// One document per engagement (unique on firm + engagement), with every list bounded, because each entry
// is small and the lists are read together. Entries are APPEND-ONLY: a mistaken time entry is voided (it
// stays, marked), a change after assembly is logged (never silently made).
//
// Days are UTC days written "YYYY-MM-DD" (CLAUDE.md section 8): the report date, a time entry's work day.
// Moments of action (confirmedAt, assembledAt, at) are real instants, shown in local time by the clients.

import mongoose from "mongoose";

export const ASSURANCE_LIMITS = Object.freeze({ independence: 400, modifications: 500, timeEntries: 3000, memos: 40 });
export const MEMO_KINDS = Object.freeze(["MATERIALITY", "SAMPLING", "SIGNIFICANT_MATTERS"]);
export const MEMO_STATUSES = Object.freeze(["DRAFT", "SIGNED"]);
export const MODIFICATION_KINDS = Object.freeze(["ADDED_AFTER_ASSEMBLY", "CHANGED_AFTER_ASSEMBLY", "OTHER"]);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const IndependenceSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    confirmedAt: { type: Date, required: true },
    // The words the person confirmed, kept as they were shown (the clients and this model agree on one sentence).
    statement: { type: String, trim: true, maxlength: 500, required: true },
    note: { type: String, trim: true, maxlength: 500, default: "" },
    mutationKey: { type: String, trim: true, maxlength: 120, required: true },
  },
  { _id: true },
);

const ModificationSchema = new mongoose.Schema(
  {
    at: { type: Date, required: true },
    byUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    kind: { type: String, enum: MODIFICATION_KINDS, required: true },
    reason: { type: String, trim: true, maxlength: 1000, required: true },
    mutationKey: { type: String, trim: true, maxlength: 120, required: true },
  },
  { _id: true },
);

const TimeEntrySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    workDay: { type: String, match: ISO_DAY, required: true },
    minutes: { type: Number, min: 1, max: 1440, required: true, validate: Number.isInteger },
    note: { type: String, trim: true, maxlength: 300, default: "" },
    enteredAt: { type: Date, required: true },
    voidedAt: { type: Date, default: null },
    voidedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    mutationKey: { type: String, trim: true, maxlength: 120, required: true },
  },
  { _id: true },
);

// W10 AP37: a drafted memo. Assembled from a fixed template and the engagement team's own inputs - the
// inputs are kept and listed on the memo, the figures are computed from them, and the text is the team's to
// edit. It is a DRAFT until the assigned reviewer signs; a signed memo is frozen (its text hash kept).
const MemoSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: MEMO_KINDS, required: true },
    status: { type: String, enum: MEMO_STATUSES, default: "DRAFT" },
    title: { type: String, trim: true, maxlength: 200, required: true },
    source: { type: String, enum: ["TEMPLATE", "TEMPLATE_EDITED"], default: "TEMPLATE" },
    inputs: { type: mongoose.Schema.Types.Mixed, default: {} },
    inputsListed: { type: [mongoose.Schema.Types.Mixed], default: [] },
    figures: { type: [mongoose.Schema.Types.Mixed], default: [] },
    text: { type: String, maxlength: 20000, required: true },
    createdByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    createdAt: { type: Date, required: true },
    editedAt: { type: Date, default: null },
    editedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    signedAt: { type: Date, default: null },
    signedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    signedTextHash: { type: String, match: /^[a-f0-9]{64}$/, default: null },
    mutationKey: { type: String, trim: true, maxlength: 120, required: true },
  },
  { _id: true },
);

const arrayLimit = (maximum, label) => ({
  validator: (values) => values.length <= maximum,
  message: `${label} exceeds ${maximum} entries`,
});

const EngagementAssuranceSchema = new mongoose.Schema(
  {
    firmId: { type: mongoose.Schema.Types.ObjectId, ref: "Firm", required: true, immutable: true },
    engagementId: { type: mongoose.Schema.Types.ObjectId, ref: "Engagement", required: true, immutable: true },
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: "Client", required: true, immutable: true },
    independence: { type: [IndependenceSchema], default: [], validate: arrayLimit(ASSURANCE_LIMITS.independence, "Independence confirmations") },
    reportDate: { type: String, match: ISO_DAY, default: null },
    reportDateSetByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    reportDateSetAt: { type: Date, default: null },
    assembledAt: { type: Date, default: null },
    assembledByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    assembleMutationKey: { type: String, trim: true, maxlength: 120, default: "" },
    modifications: { type: [ModificationSchema], default: [], validate: arrayLimit(ASSURANCE_LIMITS.modifications, "Modification log") },
    timeEntries: { type: [TimeEntrySchema], default: [], validate: arrayLimit(ASSURANCE_LIMITS.timeEntries, "Time entries") },
    memos: { type: [MemoSchema], default: [], validate: arrayLimit(ASSURANCE_LIMITS.memos, "Memos") },
    revision: { type: Number, min: 1, default: 1 },
  },
  { timestamps: true },
);

EngagementAssuranceSchema.index({ firmId: 1, engagementId: 1 }, { unique: true, name: "unique_engagement_assurance" });

const EngagementAssurance = mongoose.model("EngagementAssurance", EngagementAssuranceSchema);
export default EngagementAssurance;
