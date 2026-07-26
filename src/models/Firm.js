import mongoose from "mongoose";
import crypto from "crypto";

const FirmSchema = new mongoose.Schema({
  displayName: {
    type: String,
    required: true,
    trim: true,
  },
  handle: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true,
  },
  ownerUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  // PERSONAL — an auto-provisioned single-user home workspace.
  // SHARED   — a collaborative firm created for a team (joinable by code).
  kind: {
    type: String,
    enum: ["PERSONAL", "SHARED"],
    default: "SHARED",
  },
  description: {
    type: String,
    trim: true,
  },
  practiceAreas: {
    type: [String],
    default: [],
  },
  joinCode: {
    type: String,
    required: true,
    unique: true,
  },
  planType: {
    type: String,
    enum: ["FREE", "PREMIUM"],
    default: "FREE",
  },
  planExpiry: {
    type: Date,
    default: null,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  // When false, the firm is private: the invite/join code will not admit new
  // members. Existing members and the owner are unaffected. Absent on legacy
  // documents, which are treated as sharing-enabled (backward compatible).
  sharingEnabled: {
    type: Boolean,
    default: true,
  },
  // EDIT       — members can change this firm's data (default; collaborative).
  // READ_ONLY  — only the owner and firm admins can write; members view only.
  // Absent on legacy documents, which are treated as EDIT (backward compatible).
  memberAccess: {
    type: String,
    enum: ["EDIT", "READ_ONLY"],
    default: "EDIT",
  },
  timezone: {
    type: String,
    trim: true,
    maxlength: 80,
    default: "Asia/Kolkata",
    validate: {
      validator(value) {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
          return true;
        } catch {
          return false;
        }
      },
      message: "timezone must be a valid IANA time zone",
    },
  },
  digestSettings: {
    dailyHour: { type: Number, min: 0, max: 23, default: 8 },
    weeklyDay: { type: Number, min: 0, max: 6, default: 1 },
    weeklyHour: { type: Number, min: 0, max: 23, default: 8 },
  },
}, { timestamps: true });

// Cryptographically secure 6-char join code
FirmSchema.statics.generateJoinCode = function () {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(6);
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return code;
};

// FIXED: Model definition moved OUTSIDE static method
const Firm = mongoose.model("Firm", FirmSchema);

export default Firm;