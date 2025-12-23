import crypto from 'crypto';
import { Otp } from '../models/Otp.js';
import { OTP_EXPIRY_MINUTES, OTP_PURPOSES } from '../utils/constants.js';

export function generateOtpCode() {
  // 6-digit numeric OTP
  return (Math.floor(100000 + Math.random() * 900000)).toString();
}

export async function createOtp(email, purpose = OTP_PURPOSES.LOGIN) {
  const code = generateOtpCode();
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

  // Optionally: delete old OTPs for same email+purpose
  await Otp.deleteMany({ email, purpose, used: false });

  const otp = await Otp.create({
    email,
    code,
    purpose,
    expiresAt
  });

  return { otp, code };
}

export async function verifyOtp(email, code, purpose = OTP_PURPOSES.LOGIN) {
  const otpDoc = await Otp.findOne({
    email,
    code,
    purpose,
    used: false
  }).sort({ createdAt: -1 });

  if (!otpDoc) {
    return { ok: false, reason: 'Invalid OTP' };
  }

  if (otpDoc.expiresAt < new Date()) {
    return { ok: false, reason: 'OTP expired' };
  }

  otpDoc.used = true;
  await otpDoc.save();

  return { ok: true };
}
