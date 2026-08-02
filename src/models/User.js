// User.js
import mongoose from "mongoose";

const WorkspaceOperationReceiptSchema = new mongoose.Schema(
  {
    operationId: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      match: /^[a-f0-9]{32}$/,
    },
    kind: {
      type: String,
      enum: ["CREATE", "SWITCH", "JOIN"],
      required: true,
    },
    requestHash: {
      type: String,
      required: true,
      match: /^[a-f0-9]{64}$/,
    },
    activeFirmId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Firm",
      required: true,
    },
    startedAt: { type: Date, required: true },
    completedAt: { type: Date, required: true },
  },
  { _id: false },
);

const UserSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    name: {
      type: String,
      trim: true,
    },
    role: {
      type: String,
      enum: ["USER", "FIRM_ADMIN", "SUPER_ADMIN"], // ✅ yahan underscore + caps
      default: "USER",
    },
    accountType: {
      type: String,
      enum: ["INDIVIDUAL", "FIRM_USER"],
      default: "INDIVIDUAL",
    },
    // Active workspace. Firm-scoped features read this, so switching workspaces
    // means updating this pointer. Retained for backward compatibility.
    firmId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Firm",
      default: null,
    },
    // The user's own personal workspace. Never overwritten when creating or
    // joining a shared firm, so a usable home workspace always exists.
    personalFirmId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Firm",
      default: null,
    },
    // Bounded terminal receipts make active-firm change and operation success
    // one atomic User-document update. Status reads check these before the
    // secondary operation record, closing the delayed-response race.
    workspaceOperationReceipts: {
      type: [WorkspaceOperationReceiptSchema],
      default: [],
      validate: {
        validator: (values) =>
          values.length <= 20 &&
          new Set(values.map((value) => value.operationId)).size ===
            values.length,
        message: "Workspace operation receipts must be unique and bounded",
      },
    },
    // When the user asked to become a firm admin. Pending approval is tracked
    // here rather than by clearing isActive: overloading the activation flag let
    // a suspended account look pending, and let a pending account be locked out
    // with no route back once its role was recomputed on the next sign-in.
    firmAdminRequestedAt: {
      type: Date,
      default: null,
    },
    otpCodeHash: String,
    otpExpiresAt: Date,
    // Brute-force protection: failed OTP attempts + lockout window + resend throttle.
    otpAttempts: {
      type: Number,
      default: 0,
    },
    otpLockedUntil: {
      type: Date,
      default: null,
    },
    otpLastSentAt: {
      type: Date,
      default: null,
    },
    // Session revocation: incrementing this invalidates every previously issued
    // JWT for this user (compromised token, force-logout). Tokens carry the tv
    // claim; auth middleware rejects any token whose tv is stale.
    tokenVersion: {
      type: Number,
      default: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    // ─── Usage tracking (super admin analytics) ─────────────────────
    lastActiveAt: {
      type: Date,
      default: null,
      index: true,
    },
    lastSeenIp: {
      type: String,
      default: null,
    },
    totalApiCalls: {
      type: Number,
      default: 0,
    },
    // One-time welcome announcement tracking (persists across logout/reinstall)
    welcomeSeenVersion: {
      type: String,
      default: null,
    },
    digestPreferences: {
      // Cadence for the personal "daily work digest" email.
      // DAILY = every day, EVERY_3_DAYS, WEEKLY = once a week, OFF = never.
      dailyFrequency: {
        type: String,
        enum: ["DAILY", "EVERY_3_DAYS", "WEEKLY", "OFF"],
        default: "DAILY",
      },
      // Retained for backward compatibility and kept in sync with
      // dailyFrequency (false === OFF). New clients use dailyFrequency.
      dailyEnabled: { type: Boolean, default: true },
      weeklyEnabled: { type: Boolean, default: true },
      emailEnabled: { type: Boolean, default: true },
    },
  },
  { timestamps: true },
);

const User = mongoose.model("User", UserSchema);

export default User;
