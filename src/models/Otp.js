import mongoose from 'mongoose';
import { OTP_PURPOSES } from '../utils/constants.js';

const otpSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true
    },
    code: {
      type: String,
      required: true
    },
    purpose: {
      type: String,
      enum: Object.values(OTP_PURPOSES),
      required: true
    },
    expiresAt: {
      type: Date,
      required: true
    },
    used: {
      type: Boolean,
      default: false
    }
  },
  {
    timestamps: true
  }
);

otpSchema.index({ email: 1, purpose: 1, createdAt: -1 });

export const Otp = mongoose.model('Otp', otpSchema);
