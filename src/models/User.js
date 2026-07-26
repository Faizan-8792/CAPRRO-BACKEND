// User.js
import mongoose from "mongoose";

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
      enum: ["USER", "FIRM_ADMIN", "SUPER_ADMIN"],   // ✅ yahan underscore + caps
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
      dailyEnabled: { type: Boolean, default: true },
      weeklyEnabled: { type: Boolean, default: true },
      emailEnabled: { type: Boolean, default: true },
    },
  },
  { timestamps: true }
);

const User = mongoose.model("User", UserSchema);

export default User;
