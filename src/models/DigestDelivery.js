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
            return Buffer.byteLength(JSON.stringify(value), "utf8") <= 32 * 1024;
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
      state: {
        type: String,
        enum: ["PENDING", "DISABLED", "ROLLOUT_BLOCKED", "SENT", "FAILED"],
        default: "PENDING",
      },
      attempts: { type: Number, min: 0, default: 0 },
      providerMessageId: { type: String, trim: true, maxlength: 240, default: "" },
      lastError: { type: String, trim: true, maxlength: 600, default: "" },
      sentAt: { type: Date, default: null },
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
  },
  { timestamps: true }
);

DigestDeliverySchema.index(
  { firmId: 1, kind: 1, periodKey: 1, recipientUserId: 1 },
  { unique: true, name: "unique_digest_recipient_period" }
);
DigestDeliverySchema.index({
  firmId: 1,
  recipientUserId: 1,
  "inApp.state": 1,
  createdAt: -1,
  _id: -1,
});
DigestDeliverySchema.index({ firmId: 1, status: 1, createdAt: -1 });

const DigestDelivery = mongoose.model("DigestDelivery", DigestDeliverySchema);

export { DELIVERY_STATUSES, DIGEST_KINDS };
export default DigestDelivery;
