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
    firmId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Firm",
      default: null,
    },
    otpCodeHash: String,
    otpExpiresAt: Date,
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

const User = mongoose.model("User", UserSchema);

export default User;
