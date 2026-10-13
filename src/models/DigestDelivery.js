import mongoose from "mongoose";

const DIGEST_KINDS = Object.freeze(["DAILY_PERSONAL", "WEEKLY_FIRM"]);
const DELIVERY_STATUSES = Object.freeze([
  "QUEUED",
  "DELIVERED",
  "PARTIAL",
  "FAILED",
]);

const DigestDeliverySchema = new mongoose.Schema(
  {
    firmId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Firm",
      required: true,
    },
    recipientUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    kind: { type: String, enum: DIGEST_KINDS, required: true },
    periodKey: { type: String, trim: true, maxlength: 40, required: true },
    timezone: { type: String, trim: true, maxlength: 80, required: true },
    subject: { type: String, trim: true, maxlength: 240, required: true },
    summary: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
      validate: {
        validator(value) {
          try {
            return (
              Buffer.byteLength(JSON.stringify(value), "utf8") <= 32 * 1024
            );
          } catch {
            return false;
          }
        },
        message: "Digest summary must be valid JSON no larger than 32 KiB",
      },
    },
    status: {
      type: String,
      enum: DELIVERY_STATUSES,
      default: "QUEUED",
    },
    email: {
      // SENDING is a claim, not a result. Exactly one worker may hold it, and it
      // exists so a second worker cannot call the email provider for the same
      // delivery while the first call is still in flight. Clients render this
      // value by humanizing it, so a new state is additive for them.
      state: {
        type: String,
        enum: [
          "PENDING",
          "SENDING",
          "DISABLED",
          "ROLLOUT_BLOCKED",
          "SENT",
          "FAILED",
        ],
        default: "PENDING",
      },
      attempts: { type: Number, min: 0, default: 0 },
      idempotencyKey: {
        type: String,
        trim: true,
        maxlength: 240,
        default: null,
      },
      providerMessageId: {
        type: String,
        trim: true,
        maxlength: 240,
        default: "",
      },
      lastError: { type: String, trim: true, maxlength: 600, default: "" },
      sentAt: { type: Date, default: null },
      // Who holds the send claim and since when. claimedAt lets a claim that
      // died mid-send be reclaimed instead of blocking the digest forever.
      claimToken: { type: String, trim: true, maxlength: 64, default: null },
      claimedAt: { type: Date, default: null },
    },
    inApp: {
      state: {
        type: String,
        enum: ["HIDDEN", "AVAILABLE", "READ"],
        default: "HIDDEN",
      },
      availableAt: { type: Date, default: null },
      readAt: { type: Date, default: null },
    },
    automationJobId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AutomationJob",
      default: null,
    },
    jobRecovery: {
      // revision fences stale recovery holders after an expired lease is taken
      // over; token alone identifies ownership only within one lease lifetime.
      token: { type: String, trim: true, maxlength: 64, default: null },
      expiresAt: { type: Date, default: null },
      revision: { type: Number, min: 0, default: 0 },
    },
  },
  { timestamps: true },
);

DigestDeliverySchema.index(
  { firmId: 1, kind: 1, periodKey: 1, recipientUserId: 1 },
  { unique: true, name: "unique_digest_recipient_period" },
);
DigestDeliverySchema.index({
  firmId: 1,
  recipientUserId: 1,
  "inApp.state": 1,
  createdAt: -1,
  _id: -1,
});
DigestDeliverySchema.index({ firmId: 1, status: 1, createdAt: -1 });

const DIGEST_RECOVERY_CURSOR_ID = "digest-delivery-recovery-v1";
const DigestRecoveryCursorSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      enum: [DIGEST_RECOVERY_CURSOR_ID],
      default: DIGEST_RECOVERY_CURSOR_ID,
      required: true,
    },
    afterId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    cycleEndId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    lease: {
      token: { type: String, trim: true, maxlength: 64, default: null },
      expiresAt: { type: Date, default: null },
    },
  },
  {
    collection: "digest_recovery_cursors",
    strict: "throw",
    versionKey: false,
  },
);

const DigestDelivery = mongoose.model("DigestDelivery", DigestDeliverySchema);
const DigestRecoveryCursor =
  mongoose.models.DigestRecoveryCursor ||
  mongoose.model("DigestRecoveryCursor", DigestRecoveryCursorSchema);

export {
  DELIVERY_STATUSES,
  DIGEST_KINDS,
  DIGEST_RECOVERY_CURSOR_ID,
  DigestRecoveryCursor,
};
export default DigestDelivery;
