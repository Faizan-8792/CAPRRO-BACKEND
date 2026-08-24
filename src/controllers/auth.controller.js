import jwt from "jsonwebtoken";
import crypto from "crypto";
import { OAuth2Client } from "google-auth-library";
import User from "../models/User.js";
import { sendOtpEmail } from "../services/email.service.js";
import { ensurePersonalFirm } from "../services/firm-provisioning.service.js";
import { safeRecordActivity } from "../services/activity.service.js";
import {
  recordCurrentTermsAcceptance,
  validateCurrentTermsAcceptance,
} from "../services/terms-acceptance.service.js";

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error("JWT_SECRET env var is required");
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";
const OTP_EXPIRY_MINUTES = 10;
// Brute-force + abuse protection for OTP login.
const MAX_OTP_ATTEMPTS = 5; // wrong tries before lockout
const OTP_LOCK_MS = 15 * 60 * 1000; // lockout duration after too many tries
const OTP_RESEND_COOLDOWN_MS = 30 * 1000; // min gap between OTP sends

// Google Sign-In: accept the existing extension/web audience plus the native
// desktop audience. OAuth client IDs are public identifiers.
const DEFAULT_DESKTOP_GOOGLE_CLIENT_ID =
  "978304461373-1ombfrb0ergt0nq942cjbg7jnq9qqb0u.apps.googleusercontent.com";
const DESKTOP_GOOGLE_CLIENT_ID =
  String(process.env.GOOGLE_DESKTOP_CLIENT_ID || DEFAULT_DESKTOP_GOOGLE_CLIENT_ID).trim();
const GOOGLE_CLIENT_IDS = [
  process.env.GOOGLE_CLIENT_ID,
  DESKTOP_GOOGLE_CLIENT_ID,
  ...(process.env.GOOGLE_CLIENT_IDS || "").split(","),
]
  .map((value) => String(value || "").trim())
  .filter(Boolean)
  .filter((value, index, values) => values.indexOf(value) === index);
const googleClient = GOOGLE_CLIENT_IDS.length ? new OAuth2Client() : null;

// Google issues installed-app ("Desktop app") clients a client secret and
// requires it at the token endpoint. Installed apps cannot keep a secret
// confidential, so the secret lives only in this server's environment and the
// desktop app exchanges its authorization code through the route below.
const DESKTOP_GOOGLE_CLIENT_SECRET = String(
  process.env.GOOGLE_DESKTOP_CLIENT_SECRET || ""
).trim();
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const MAX_AUTHORIZATION_CODE_LENGTH = 2048;
const MAX_CODE_VERIFIER_LENGTH = 128;
const MIN_CODE_VERIFIER_LENGTH = 43;
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]+$/;

const SUPER_ADMIN_EMAIL = "saifullahfaizan786@gmail.com";

// ---------------- Helpers ----------------

function hashOtp(otp) {
  return crypto.createHash("sha256").update(String(otp)).digest("hex");
}

function generateOtp() {
  // Cryptographically secure 6-digit OTP (100000–999999). Math.random is not
  // suitable for security tokens.
  return crypto.randomInt(100000, 1000000);
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

    // Resend throttle: block OTP flooding / email bombing of an address.
    if (
      user.otpLastSentAt &&
      Date.now() - user.otpLastSentAt.getTime() < OTP_RESEND_COOLDOWN_MS
    ) {
      return res.status(429).json({
        ok: false,
        error: "Please wait a moment before requesting another OTP.",
      });
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
    // A fresh OTP clears the brute-force counter/lock and records the send time.
    user.otpAttempts = 0;
    user.otpLockedUntil = null;
    user.otpLastSentAt = new Date();
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

    // Brute-force lockout: too many wrong OTPs → temporary hard stop.
    if (user.otpLockedUntil && user.otpLockedUntil.getTime() > Date.now()) {
      return res.status(429).json({
        ok: false,
        error: "Too many incorrect attempts. Please request a new OTP shortly.",
      });
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
      user.otpAttempts = (user.otpAttempts || 0) + 1;
      const locked = user.otpAttempts >= MAX_OTP_ATTEMPTS;
      if (locked) {
        // Burn the OTP and start the lockout window.
        user.otpLockedUntil = new Date(Date.now() + OTP_LOCK_MS);
        user.otpCodeHash = undefined;
        user.otpExpiresAt = undefined;
      }
      await user.save();
      return res.status(locked ? 429 : 400).json({
        ok: false,
        error: locked
          ? "Too many incorrect attempts. Please request a new OTP shortly."
          : "Invalid OTP",
      });
    }

    // Success — clear OTP + reset brute-force state.
    user.otpCodeHash = undefined;
    user.otpExpiresAt = undefined;
    user.otpAttempts = 0;
    user.otpLockedUntil = null;
    await user.save();

    // Ensure the user has a personal workspace so the product is usable
    // immediately, without being forced to create or join a firm.
    await ensurePersonalFirm(user);

    const payload = buildTokenPayload(user);
    const token = jwt.sign(
      { ...payload, tv: user.tokenVersion || 0 },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

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

    const {
      idToken,
      credential,
      accessToken,
      clientType,
      termsAcceptance,
    } = req.body || {};
    const oidcToken = idToken || credential;

    if (!oidcToken && !accessToken) {
      return res
        .status(400)
        .json({ ok: false, error: "A Google ID token or access token is required" });
    }

    let email;
    let emailVerified;
    let name;
    let googleAudience;

    try {
      if (oidcToken) {
        // Web / GIS path: verify the ID token (JWT) and read its claims.
        const ticket = await googleClient.verifyIdToken({
          idToken: oidcToken,
          audience: GOOGLE_CLIENT_IDS,
        });
        const payload = ticket.getPayload();
        email = payload?.email;
        emailVerified = payload?.email_verified;
        name = payload?.name;
        googleAudience = payload?.aud;
      } else {
        // Chrome extension path (chrome.identity.getAuthToken): validate the
        // access token, ensure it was minted for OUR client, then read profile.
        const info = await googleClient.getTokenInfo(accessToken);
        if (!GOOGLE_CLIENT_IDS.includes(info.aud)) {
          return res
            .status(401)
            .json({ ok: false, error: "Google token audience mismatch" });
        }
        email = info.email;
        emailVerified = info.email_verified;
        googleAudience = info.aud;

        // getTokenInfo omits the display name - fetch it from userinfo (best-effort).
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
          // Name is optional - ignore userinfo failures.
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

    // Only the audience from Google's verified token can identify a desktop
    // sign-in. clientType is untrusted request metadata and may only detect a
    // misconfigured or forged desktop declaration; it cannot author evidence.
    const declaredClientType =
      typeof clientType === "string" ? clientType.trim().toUpperCase() : "";
    if (
      declaredClientType === "DESKTOP" &&
      googleAudience !== DESKTOP_GOOGLE_CLIENT_ID
    ) {
      return res.status(401).json({
        ok: false,
        code: "GOOGLE_DESKTOP_AUDIENCE_REQUIRED",
        error: "Google token was not issued for the desktop application.",
        requestId: req.id || "",
      });
    }

    const isDesktopSignIn = googleAudience === DESKTOP_GOOGLE_CLIENT_ID;

    if (isDesktopSignIn) {
      const acceptanceError = validateCurrentTermsAcceptance(termsAcceptance);
      if (acceptanceError) {
        return res.status(acceptanceError.status).json({
          ok: false,
          code: acceptanceError.code,
          error: acceptanceError.error,
          ...(acceptanceError.details
            ? { details: acceptanceError.details }
            : {}),
          requestId: req.id || "",
        });
      }
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

    // This write happens before JWT issuance. acceptedAt comes from the server,
    // and the unique user/version key makes sign-in retries idempotent.
    const termsAcceptanceReceipt = isDesktopSignIn
      ? await recordCurrentTermsAcceptance({
          userId: user._id,
          email: normalizedEmail,
        })
      : null;

    const tokenPayload = buildTokenPayload(user);
    const jwtToken = jwt.sign(
      { ...tokenPayload, tv: user.tokenVersion || 0 },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    return res.json({
      ok: true,
      token: jwtToken,
      user: tokenPayload,
      ...(termsAcceptanceReceipt ? { termsAcceptanceReceipt } : {}),
    });
  } catch (err) {
    next(err);
  }
};

// ---------------- GOOGLE DESKTOP CODE EXCHANGE ----------------
// POST /api/auth/google/desktop-token
// Body: { code, codeVerifier, redirectUri }
// Completes the installed-app authorization-code exchange on the server so the
// Google client secret never ships inside the desktop build. Only the resulting
// OpenID Connect ID token is returned; Google access and refresh tokens are
// discarded here and never persisted.
export const googleDesktopToken = async (req, res, next) => {
  try {
    if (!DESKTOP_GOOGLE_CLIENT_SECRET) {
      return res.status(500).json({
        ok: false,
        error: "Desktop Google sign-in is not configured on the server",
      });
    }

    const { code, codeVerifier, redirectUri } = req.body || {};

    const authorizationCode = String(code || "").trim();
    const verifier = String(codeVerifier || "").trim();
    const redirect = String(redirectUri || "").trim();

    if (!authorizationCode || authorizationCode.length > MAX_AUTHORIZATION_CODE_LENGTH) {
      return res
        .status(400)
        .json({ ok: false, error: "A Google authorization code is required" });
    }

    if (
      verifier.length < MIN_CODE_VERIFIER_LENGTH ||
      verifier.length > MAX_CODE_VERIFIER_LENGTH ||
      !CODE_VERIFIER_PATTERN.test(verifier)
    ) {
      return res
        .status(400)
        .json({ ok: false, error: "A valid PKCE code verifier is required" });
    }

    if (!isLoopbackRedirectUri(redirect)) {
      return res.status(400).json({
        ok: false,
        error: "The redirect URI must be an HTTP loopback address",
      });
    }

    let googleResponse;
    try {
      googleResponse = await fetch(GOOGLE_TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: DESKTOP_GOOGLE_CLIENT_ID,
          client_secret: DESKTOP_GOOGLE_CLIENT_SECRET,
          code: authorizationCode,
          code_verifier: verifier,
          grant_type: "authorization_code",
          redirect_uri: redirect,
        }),
      });
    } catch {
      return res
        .status(502)
        .json({ ok: false, error: "Google could not be reached. Try again." });
    }

    let payload = {};
    try {
      payload = await googleResponse.json();
    } catch {
      payload = {};
    }

    if (!googleResponse.ok) {
      // Surface only Google's short description, never the secret or request body.
      const description = String(payload?.error_description || "").slice(0, 240);
      return res.status(401).json({
        ok: false,
        error: description || "Google rejected the sign-in request. Try again.",
      });
    }

    const idToken = payload?.id_token;
    if (typeof idToken !== "string" || !idToken) {
      return res
        .status(502)
        .json({ ok: false, error: "Google did not return an identity token" });
    }

    return res.json({ ok: true, idToken });
  } catch (err) {
    next(err);
  }
};

function isLoopbackRedirectUri(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  if (parsed.protocol !== "http:") return false;

  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

// ---------------- GET ME ----------------
// GET /api/auth/me
export const getMe = async (req, res, next) => {
  try {
    const { id } = req.user;

    const user = await User.findById(id).select(
      "email name role accountType firmId personalFirmId createdAt updatedAt isActive welcomeSeenVersion desktopUpdateSeenAnnouncementId erasureRequestedAt"
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
        erasureRequestedAt: user.erasureRequestedAt || null,
        welcomeSeenVersion: user.welcomeSeenVersion || null,
        desktopUpdateSeenAnnouncementId: user.desktopUpdateSeenAnnouncementId || null,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ---------------- UPDATE ME (display name) ----------------
// PATCH /api/auth/me   Body: { name }
// Self-service update of the signed-in user's display name. Email, role, and
// firm membership are never changed here.
// The erasure request path (L12 step 6).
//
// This is a write on the route that already exists for a user editing their own account, not a new
// destructive endpoint. Setting the flag ASKS for erasure; it does not perform one. PLAN.md section
// 37 rules out self-service deletion outright, so the request and the erasure stay two separate
// acts by two different people: the user records the request here, and a super administrator
// honours it through the grievance channel after checking the firm's statutory retention duties.
//
// Reversible on purpose. A request that cannot be withdrawn is a trap, and withdrawing costs
// nothing because nothing has been destroyed.
export const ERASURE_GRIEVANCE_URL = "caprotoolkit.in/privacy.html";

export const updateMe = async (req, res, next) => {
  try {
    const { id } = req.user;
    const { name, requestErasure } = req.body || {};

    const wantsErasureChange = typeof requestErasure === "boolean";
    if (requestErasure !== undefined && !wantsErasureChange) {
      return res
        .status(400)
        .json({ ok: false, error: "requestErasure must be true or false" });
    }

    // `name` stays required for an ordinary profile update, exactly as before. It becomes optional
    // only when the caller is toggling the erasure request, so no existing client can break.
    const set = {};
    if (!wantsErasureChange || name !== undefined) {
      if (typeof name !== "string") {
        return res.status(400).json({ ok: false, error: "name must be a string" });
      }
      const trimmed = name.trim();
      if (trimmed.length < 1 || trimmed.length > 120) {
        return res
          .status(400)
          .json({ ok: false, error: "name must be between 1 and 120 characters" });
      }
      set.name = trimmed;
    }

    if (wantsErasureChange) {
      const existing = await User.findById(id).select("erasureRequestedAt firmId").lean();
      if (!existing) {
        return res.status(404).json({ ok: false, error: "User not found" });
      }
      // Re-requesting must not move the timestamp: the date the request was first made is the date
      // the obligation to answer it starts running from.
      if (requestErasure) {
        if (!existing.erasureRequestedAt) set.erasureRequestedAt = new Date();
      } else {
        set.erasureRequestedAt = null;
      }

      await safeRecordActivity({
        firmId: existing.firmId,
        actorUserId: id,
        source: "USER",
        action: requestErasure ? "ERASURE_REQUESTED" : "ERASURE_REQUEST_WITHDRAWN",
        entityType: "User",
        entityId: String(id),
      });
    }

    const user = await User.findByIdAndUpdate(
      id,
      { $set: set },
      { new: true, runValidators: true }
    ).select(
      "email name role accountType firmId personalFirmId isActive createdAt updatedAt welcomeSeenVersion desktopUpdateSeenAnnouncementId erasureRequestedAt"
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
        personalFirmId: user.personalFirmId || null,
        isActive: user.isActive,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        welcomeSeenVersion: user.welcomeSeenVersion || null,
        desktopUpdateSeenAnnouncementId: user.desktopUpdateSeenAnnouncementId || null,
        erasureRequestedAt: user.erasureRequestedAt || null,
      },
      // Returned on the profile write so a client never hard-codes the address, and so the app and
      // the published policy cannot drift apart.
      erasureGrievanceUrl: ERASURE_GRIEVANCE_URL,
    });
  } catch (err) {
    next(err);
  }
};
