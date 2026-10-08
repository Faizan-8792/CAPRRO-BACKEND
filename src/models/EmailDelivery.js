// src/models/EmailDelivery.js
// One row per outbound email attempt (IMPROVEMENT-PLAN-V2-2026-09-28 Part 1:
// email observability). Written by the shared mailer (services/mailer.js) on
// every send, and updated by the Resend webhook (delivery/bounce/complaint
// signals) — before this model existed, "sent" meant "Resend accepted" and
// nothing more was known.
//
// PRIVACY SHAPE — no raw recipient address is ever stored:
//   recipientEmailHash    sha256(lowercase email), wiped on erasure requests
//   recipientEmailLast4   last four characters of the address, display only
// The panel's recipient search hashes the queried address client-side and
// matches on the hash; there is no raw address to leak or erase-by-copy.
// subjectTemplateName is a coarse enum key (which builder produced the email),
// never the rendered subject line.
//
// Retention: classified RETAIN today — the 180-day raw → aggregate policy in
// IMPROVEMENT-PLAN-V2-2026-09-28 §1.2 needs an aggregation job that has not
// been built; calling this SELF_EXPIRING now would be a false claim (see the
// ProviderUsage note in data-retention.service.js).

import mongoose from "mongoose";
import { createHash } from "node:crypto";

export const EMAIL_DELIVERY_TYPES = Object.freeze([
  "otp",
  "reminder",
  "daily_digest",
  "weekly_digest",
  "test_digest",
  "test_email",
  "reminder_alert",
  "rollout_notice",
  "campaign",
  "digest_activation",
  "other",
]);

export const EMAIL_DELIVERY_STATUSES = Object.freeze([
  "queued",
  "sent",
  "delivered",
  "bounced",
  "complained",
  "failed",
]);

// Coarse, content-free failure classes for the panel's error column. Never a
// provider message body — those can echo addresses or template fragments.
export const EMAIL_DELIVERY_ERROR_CLASSES = Object.freeze([
  "none",
  "suppressed",
  "rejected_by_provider",
  "hard_bounce",
  "soft_bounce",
  "complaint",
  "unknown",
]);

// Coarse builder keys — which template produced the email. Deliberately NOT a
// free string: a rendered subject would leak content into analytics.
export const EMAIL_SUBJECT_TEMPLATES = Object.freeze([
  "otp_code",
  "compliance_reminder",
  "daily_digest",
  "weekly_digest",
  "digest_activation_notice",
  "test_email",
  "test_digest",
  "reminder_alert",
  "rollout_notice",
  "campaign",
  "other",
]);

const EmailDeliverySchema = new mongoose.Schema(
  {
    firmId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Firm",
      default: null,
      index: true,
    },
    // Null for pre-authentication sends (OTP before an account exists).
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    type: {
      type: String,
      enum: EMAIL_DELIVERY_TYPES,
      required: true,
    },
    recipientEmailHash: {
      type: String,
      required: true,
      index: true,
    },
    recipientEmailLast4: { type: String, default: "", maxlength: 4 },
    subjectTemplateName: {
      type: String,
      enum: EMAIL_SUBJECT_TEMPLATES,
      required: true,
    },
    // Resend's email id — the webhook's join key. Sparse unique: a
    // blocked-before-send row has no provider id at all.
    providerMessageId: { type: String, default: null },
    status: {
      type: String,
      enum: EMAIL_DELIVERY_STATUSES,
      required: true,
      default: "queued",
    },
    errorClass: {
      type: String,
      enum: EMAIL_DELIVERY_ERROR_CLASSES,
      required: true,
      default: "none",
    },
    sentAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    lastEventAt: { type: Date, default: null },
    // Narrow, known-key linkage only (a reminder or digest row this email
    // belongs to) — never a free-form payload.
    meta: {
      reminderId: { type: mongoose.Schema.Types.ObjectId, ref: "Reminder", default: null },
      digestDeliveryId: { type: mongoose.Schema.Types.ObjectId, ref: "DigestDelivery", default: null },
    },
    // Set by the one-time backfill from Resend's List Emails API, whose rows
    // carry send time but no delivery history: their status is "sent" forever
    // unless a webhook corrects it.
    backfilled: { type: Boolean, default: false, index: true },
  },
  { timestamps: true },
);

// The date filter is the panel's primary axis (Part 1's whole point).
EmailDeliverySchema.index({ sentAt: -1 });
EmailDeliverySchema.index({ type: 1, sentAt: -1 });
EmailDeliverySchema.index({ firmId: 1, sentAt: -1 });
EmailDeliverySchema.index(
  { providerMessageId: 1 },
  { unique: true, sparse: true, name: "unique_provider_message_id" },
);

EmailDeliverySchema.statics.hashRecipient = function hashRecipient(email) {
  return createHash("sha256")
    .update(String(email || "").trim().toLowerCase())
    .digest("hex");
};

const EmailDelivery = mongoose.model("EmailDelivery", EmailDeliverySchema);

// Legal webhook-driven transitions. Idempotency by construction: an event may
// only move a row FORWARD through the lifecycle, so a duplicated webhook
// delivery matches an already-applied transition and is a no-op. Reversals
// (delivered → sent) and skips (failed → delivered) are refused rather than
// applied — a row that says "failed" stays failed until a real resend happens.
export const EMAIL_DELIVERY_EVENT_TRANSITIONS = Object.freeze({
  "email.sent": { from: ["queued"], to: "sent" },
  "email.delivered": { from: ["queued", "sent"], to: "delivered" },
  "email.bounced": { from: ["queued", "sent", "delivered"], to: "bounced" },
  "email.complained": { from: ["queued", "sent", "delivered"], to: "complained" },
});

export default EmailDelivery;
