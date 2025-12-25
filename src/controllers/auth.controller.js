import jwt from "jsonwebtoken";
import crypto from "crypto";
import User from "../models/User.js";
import { sendOtpEmail } from "../services/email.service.js";

const JWT_SECRET = process.env.JWT_SECRET || "changeme";
const OTP_EXPIRY_MINUTES = 10;

function hashOtp(otp) {
  return crypto.createHash("sha256").update(String(otp)).digest("hex");
}

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000);
}

function buildTokenPayload(user) {
  return {
    id: user._id,
    email: user.email,
    role: user.role,
    accountType: user.accountType,
    firmId: user.firmId || null,
    isActive: user.isActive,
  };
}

// POST /api/auth/send-otp
export const sendOtp = async (req, res, next) => {
  try {
    const { email } = req.body || {};
    if (!email) {
      return res.status(400).json({ ok: false, error: "Email is required" });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    let user = await User.findOne({ email: normalizedEmail });

    if (!user) {
      user = await User.create({
        email: normalizedEmail,
        role: "USER",
        accountType: "INDIVIDUAL",
        firmId: null,
      });
    }

    // Pin SUPER_ADMIN
    if (normalizedEmail === "saifullahfaizan786@gmail.com" && user.role !== "SUPER_ADMIN") {
      user.role = "SUPER_ADMIN";
      user.isActive = true;
    }

    const otp = generateOtp();
    user.otpCodeHash = hashOtp(otp);
    user.otpExpiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);
    await user.save();

    await sendOtpEmail(normalizedEmail, otp);
    return res.json({ ok: true, message: "OTP sent to email" });
  } catch (err) {
    next(err);
  }
};

// POST /api/auth/verify-otp
export const verifyOtpAndLogin = async (req, res, next) => {
  try {
    const { email, otpCode, otp } = req.body || {};
    const otpValue = otpCode ?? otp;

    if (!email || !otpValue) {
      return res.status(400).json({ ok: false, error: "Email and OTP are required" });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail });

    if (!user) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }

    // Re-apply SUPER_ADMIN
    if (normalizedEmail === "saifullahfaizan786@gmail.com" && user.role !== "SUPER_ADMIN") {
      user.role = "SUPER_ADMIN";
      user.isActive = true;
      await user.save();
    }

    if (!user.otpCodeHash || !user.otpExpiresAt) {
      return res.status(400).json({ ok: false, error: "No active OTP for this user" });
    }

    if (user.otpExpiresAt.getTime() < Date.now()) {
      return res.status(400).json({ ok: false, error: "OTP expired" });
    }

    const incomingHash = hashOtp(otpValue);
    if (incomingHash !== user.otpCodeHash) {
      return res.status(400).json({ ok: false, error: "Invalid OTP" });
    }

    // clear otp
    user.otpCodeHash = undefined;
    user.otpExpiresAt = undefined;
    await user.save();

    const payload = buildTokenPayload(user);
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });

    return res.json({ ok: true, token, user: payload });
  } catch (err) {
    next(err);
  }
};

// GET /api/auth/me
export const getMe = async (req, res, next) => {
  try {
    const { id } = req.user;
    const user = await User.findById(id).select(
      "email name role accountType firmId createdAt updatedAt isActive"
    );

    if (!user) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }

    return res.json({
      ok: true,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        role: user.role,
        accountType: user.accountType,
        firmId: user.firmId || null,
        isActive: user.isActive,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
    });
  } catch (err) {
    next(err);
  }
};