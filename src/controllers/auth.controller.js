import jwt from "jsonwebtoken";
import crypto from "crypto";
import { OAuth2Client } from "google-auth-library";
import User from "../models/User.js";
import { sendOtpEmail } from "../services/email.service.js";
import { ensurePersonalFirm } from "../services/firm-provisioning.service.js";

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error("JWT_SECRET env var is required");
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";
const OTP_EXPIRY_MINUTES = 10;

// Google Sign-In: verifier for the Google-issued ID token.
// GOOGLE_CLIENT_ID must match the client ID used by the extension/web to
// obtain the token, since it is validated as the token audience.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

const SUPER_ADMIN_EMAIL = "saifullahfaizan786@gmail.com";

// ---------------- Helpers ----------------

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

// ---------------- SEND OTP ----------------
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
        isActive: true,
      });
    }

    // Pin SUPER_ADMIN
    if (
      normalizedEmail === "saifullahfaizan786@gmail.com" &&
      user.role !== "SUPER_ADMIN"
    ) {
      user.role = "SUPER_ADMIN";
      user.isActive = true;
    }

    const otp = generateOtp();

    // Dev-only OTP log — never log OTPs in production
    if (process.env.NODE_ENV !== "production") {
      console.log("🔐 OTP GENERATED for", normalizedEmail, "=>", otp);
    }

    user.otpCodeHash = hashOtp(otp);
    user.otpExpiresAt = new Date(
      Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000
    );
    await user.save();

    // ✅ ONLY CHANGE: OTP email now goes via Resend
    await sendOtpEmail(normalizedEmail, otp);

    return res.json({
      ok: true,
      message: "OTP sent to email",
    });
  } catch (err) {
    next(err);
  }
};

// ---------------- VERIFY OTP ----------------
// POST /api/auth/verify-otp
export const verifyOtpAndLogin = async (req, res, next) => {
  try {
    const { email, otpCode, otp } = req.body || {};
    const otpValue = otpCode ?? otp;

    if (!email || !otpValue) {
      return res
        .status(400)
        .json({ ok: false, error: "Email and OTP are required" });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail });

    if (!user) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }

    // Re-apply SUPER_ADMIN
    if (
      normalizedEmail === "saifullahfaizan786@gmail.com" &&
      user.role !== "SUPER_ADMIN"
    ) {
      user.role = "SUPER_ADMIN";
      user.isActive = true;
      await user.save();
    }

    if (!user.otpCodeHash || !user.otpExpiresAt) {
      return res
        .status(400)
        .json({ ok: false, error: "No active OTP for this user" });
    }

    if (user.otpExpiresAt.getTime() < Date.now()) {
      return res.status(400).json({ ok: false, error: "OTP expired" });
    }

    const incomingHash = hashOtp(otpValue);
    if (incomingHash !== user.otpCodeHash) {
      return res.status(400).json({ ok: false, error: "Invalid OTP" });
    }

    // Clear OTP
    user.otpCodeHash = undefined;
    user.otpExpiresAt = undefined;
    await user.save();

    // Ensure the user has a personal workspace so the product is usable
    // immediately, without being forced to create or join a firm.
    await ensurePersonalFirm(user);

    const payload = buildTokenPayload(user);
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

    return res.json({ ok: true, token, user: payload });
  } catch (err) {
    next(err);
  }
};

// ---------------- GOOGLE SIGN-IN ----------------
// POST /api/auth/google
// Body: { idToken } (Google OpenID Connect ID token / GIS credential)
// Same login outcome as OTP: finds/creates the user, pins SUPER_ADMIN,
// and returns { ok, token, user } with an identical JWT payload.
export const googleLogin = async (req, res, next) => {
  try {
    if (!googleClient) {
      return res
        .status(500)
        .json({ ok: false, error: "Google sign-in is not configured on the server" });
    }

    const { idToken, credential, accessToken } = req.body || {};
    const oidcToken = idToken || credential;

    if (!oidcToken && !accessToken) {
      return res
        .status(400)
        .json({ ok: false, error: "A Google ID token or access token is required" });
    }

    let email;
    let emailVerified;
    let name;

    try {
      if (oidcToken) {
        // Web / GIS path: verify the ID token (JWT) and read its claims.
        const ticket = await googleClient.verifyIdToken({
          idToken: oidcToken,
          audience: GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        email = payload?.email;
        emailVerified = payload?.email_verified;
        name = payload?.name;
      } else {
        // Chrome extension path (chrome.identity.getAuthToken): validate the
        // access token, ensure it was minted for OUR client, then read profile.
        const info = await googleClient.getTokenInfo(accessToken);
        if (info.aud !== GOOGLE_CLIENT_ID) {
          return res
            .status(401)
            .json({ ok: false, error: "Google token audience mismatch" });
        }
        email = info.email;
        emailVerified = info.email_verified;

        // getTokenInfo omits the display name — fetch it from userinfo (best-effort).
        try {
          const uiRes = await fetch(
            "https://www.googleapis.com/oauth2/v3/userinfo",
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );
          if (uiRes.ok) {
            const ui = await uiRes.json();
            name = ui.name;
            if (!email) email = ui.email;
            if (emailVerified === undefined) emailVerified = ui.email_verified;
          }
        } catch {
          // Name is optional — ignore userinfo failures.
        }
      }
    } catch {
      return res.status(401).json({ ok: false, error: "Invalid Google token" });
    }

    if (!email || emailVerified === false) {
      return res
        .status(401)
        .json({ ok: false, error: "Google account email is not verified" });
    }

    const normalizedEmail = String(email).trim().toLowerCase();

    let user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      user = await User.create({
        email: normalizedEmail,
        name: name || undefined,
        role: "USER",
        accountType: "INDIVIDUAL",
        firmId: null,
        isActive: true,
      });
    } else if (name && !user.name) {
      user.name = name;
    }

    // Pin SUPER_ADMIN
    if (normalizedEmail === SUPER_ADMIN_EMAIL && user.role !== "SUPER_ADMIN") {
      user.role = "SUPER_ADMIN";
      user.isActive = true;
    }

    await user.save();

    // Ensure the user has a personal workspace so the product is usable
    // immediately, without being forced to create or join a firm.
    await ensurePersonalFirm(user);

    const tokenPayload = buildTokenPayload(user);
    const jwtToken = jwt.sign(tokenPayload, JWT_SECRET, {
      expiresIn: JWT_EXPIRES_IN,
    });

    return res.json({ ok: true, token: jwtToken, user: tokenPayload });
  } catch (err) {
    next(err);
  }
};

// ---------------- GET ME ----------------
// GET /api/auth/me
export const getMe = async (req, res, next) => {
  try {
    const { id } = req.user;

    const user = await User.findById(id).select(
      "email name role accountType firmId personalFirmId createdAt updatedAt isActive welcomeSeenVersion"
    );

    if (!user) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }

    // Heal existing accounts that predate auto-provisioning: ensure a personal
    // workspace so firm-scoped features are immediately usable on next load.
    await ensurePersonalFirm(user);

    return res.json({
      ok: true,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        role: user.role,
        accountType: user.accountType,
        firmId: user.firmId || null,
        personalFirmId: user.personalFirmId || null,
        isActive: user.isActive,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        welcomeSeenVersion: user.welcomeSeenVersion || null,
      },
    });
  } catch (err) {
    next(err);
  }
};
