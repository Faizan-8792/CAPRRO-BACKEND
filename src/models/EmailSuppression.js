// src/models/EmailSuppression.js
// Do-not-email list (IMPROVEMENT-PLAN-V2-2026-09-28 Part 1). Rows are inserted
// on a hard bounce or a complaint webhook, and checked by the shared mailer
// BEFORE any send — so an address that bounced permanently or complained is
// never emailed again from this system.
//
// Like EmailDelivery, the address itself is never stored — only its sha256, so
// the mailer checks membership by hashing the candidate address. Removing a row
// is a deliberate super-admin action (audited), because un-suppressing an
// address that complained is exactly how spam reputation dies.

import mongoose from "mongoose";
import { createHash } from "node:crypto";

export const EMAIL_SUPPRESSION_REASONS = Object.freeze([
  "hard_bounce",
  "complaint",
  "manual",
]);

function hashEmail(email) {
  return createHash("sha256")
    .update(String(email || "").trim().toLowerCase())
    .digest("hex");
}

const EmailSuppressionSchema = new mongoose.Schema(
  {
    emailHash: {
      type: String,
      required: true,
    },
    reason: {
      type: String,
      enum: EMAIL_SUPPRESSION_REASONS,
      required: true,
    },
    // Optional: a suppression may be firm-scoped when a super admin adds one
    // manually for a single firm's sends. Bounce/complaint suppressions are
    // global (null firmId) because the address is unsafe everywhere.
    firmId: { type: mongoose.Schema.Types.ObjectId, ref: "Firm", default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

EmailSuppressionSchema.index({ emailHash: 1 }, { unique: true, name: "unique_email_suppression" });

EmailSuppressionSchema.statics.hashEmail = function (email) {
  return hashEmail(email);
};

EmailSuppressionSchema.statics.isSuppressed = async function (email) {
  const row = await this.findOne({ emailHash: hashEmail(email) })
    .select("_id reason")
    .lean();
  return row
    ? { suppressed: true, reason: row.reason, id: row._id }
    : { suppressed: false };
};

EmailSuppressionSchema.statics.suppress = async function ({
  email,
  reason,
  firmId = null,
  createdBy = null,
}) {
  // Idempotent: a duplicate suppression (two webhooks racing) keeps the first
  // row rather than erroring the caller.
  return this.findOneAndUpdate(
    { emailHash: hashEmail(email) },
    { $setOnInsert: { emailHash: hashEmail(email), reason, firmId, createdBy } },
    { upsert: true, new: true },
  );
};

const EmailSuppression = mongoose.model("EmailSuppression", EmailSuppressionSchema);

export default EmailSuppression;
