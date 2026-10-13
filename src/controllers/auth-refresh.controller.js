// src/controllers/auth-refresh.controller.js
//
// POST /api/auth/refresh - sliding session renewal (PHASE 8 section B).
//
// The product's session model is a single signed JWT with a 7-day lifetime
// and a tokenVersion claim for revocation. Before this route, every client
// was signed out at day 7 no matter how actively it was used, and the
// extension lost its session on every browser restart. Renewal closes the
// first gap WITHOUT weakening the model:
//
//   - The PRESENTED token must still verify cryptographically. An expired
//     token is refused - there is no grace window to replay.
//   - The user is re-hydrated from MongoDB on every refresh, and both
//     isActive and the tokenVersion are re-checked, so a force-logout bump,
//     a deactivation, or a deletion kills refresh exactly as fast as it
//     kills any request (the middleware rejects the old token first).
//   - The fresh token carries the CURRENT tokenVersion, so a revocation
//     that lands between the check and the sign is still caught by every
//     later request.
//   - Sessions are not indefinite: the sign-in time (`at` claim) travels
//     through every renewal, and no token is minted past
//     at + SESSION_MAX_AGE_DAYS (default 30). After that the client keeps
//     its current token until it expires, then signs in again.
//   - Hard rate limit per account, and the route is behind the same token
//     verification as everything else (authRequiredForRefresh, which only
//     differs in recording a refusal as a failed renewal).
//
// The client claim is preserved from the presented token, so a desktop token
// refreshes as a desktop token.

import jwt from "jsonwebtoken";
import User from "../models/User.js";
import { recordAuthHealth } from "../services/auth-health.service.js";
import { recordedLimiter } from "../middleware/rate-limit.middleware.js";

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error("JWT_SECRET env var is required");
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";

const DEFAULT_SESSION_MAX_AGE_DAYS = 30;

// SESSION_MAX_AGE_DAYS from the environment, 1..365; anything else is the
// default rather than "unlimited" - a typo must never remove the cap.
export function sessionMaxAgeSeconds(value = process.env.SESSION_MAX_AGE_DAYS) {
  const days = Number(value);
  const bounded = Number.isFinite(days) && days >= 1 && days <= 365
    ? days
    : DEFAULT_SESSION_MAX_AGE_DAYS;
  return Math.floor(bounded * 24 * 60 * 60);
}

// A renewal closer than this to the cap is refused rather than minting a
// token that lives for seconds.
const MIN_RENEWED_LIFETIME_SECONDS = 60;

// A sliding session only needs one successful refresh per day per client;
// 30 per 15 minutes is far above any honest pattern and far below anything
// that could be used to keep a stolen token warm against a revocation the
// attacker cannot see.
// A refusal is recorded as a refused renewal (DS44, recordedLimiter).
export const refreshLimiter = recordedLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id || req.ip,
  message: { ok: false, error: "Too many session refreshes. Wait a few minutes." },
  event: (req) => ({ kind: "refresh_fail", platform: platformOf(req) }),
});

function platformOf(req) {
  if (!req.user) return "unknown";
  return req.user.client === "desktop" ? "desktop" : "extension";
}

function fail(res, status, error, reason, req, code) {
  recordAuthHealth({
    kind: "refresh_fail",
    reason,
    platform: platformOf(req),
    appVersion: req.clientMeta?.version || "",
    userId: req.user?.id || null,
  });
  return res.status(status).json({ ok: false, error, ...(code ? { code } : {}), requestId: req.id || "" });
}

export const refreshToken = async (req, res, next) => {
  try {
    // authRequiredForRefresh has already verified the presented token's
    // signature and expiry, re-hydrated the user, and confirmed the
    // tokenVersion - so a request reaching here IS a live session. What
    // remains is to mint the successor with the same discipline the sign-in
    // routes use.
    const user = await User.findById(req.user.id)
      .select("email role accountType firmId isActive tokenVersion")
      .lean();
    if (!user) {
      return fail(res, 401, "User no longer exists", "missing_user", req);
    }
    if (user.isActive === false) {
      return fail(res, 403, "Account is inactive", "inactive", req);
    }
    if ((user.tokenVersion || 0) !== (req.user.tokenVersion || 0)) {
      // A force-logout landed between the middleware's check and this read.
      return fail(res, 401, "Session revoked. Please sign in again.", "revoked", req);
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const authTime = Number(req.tokenAuthTime) || 0;
    const sessionEndsAt = authTime + sessionMaxAgeSeconds();
    if (!authTime || sessionEndsAt - nowSeconds < MIN_RENEWED_LIFETIME_SECONDS) {
      // Not a verdict on the presented token: it stays valid until its own
      // expiry. The code tells clients to stop renewing, not to sign out.
      return fail(
        res,
        401,
        "This sign-in has reached its maximum age. Sign in again when it expires.",
        "max_age",
        req,
        "SESSION_MAX_AGE",
      );
    }

    const payload = {
      id: user._id,
      email: user.email,
      role: user.role,
      accountType: user.accountType,
      firmId: user.firmId || null,
      isActive: user.isActive,
      client: req.user.client === "desktop" ? "desktop" : "extension",
    };
    const claims = { ...payload, tv: user.tokenVersion || 0, at: authTime };
    let token = jwt.sign(claims, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
    if ((jwt.decode(token)?.exp || 0) > sessionEndsAt) {
      // The standard lifetime would outlive the cap: end exactly at it.
      token = jwt.sign({ ...claims, exp: sessionEndsAt }, JWT_SECRET);
    }

    recordAuthHealth({
      kind: "refresh_success",
      reason: "unknown",
      platform: platformOf(req),
      appVersion: req.clientMeta?.version || "",
      userId: req.user.id,
    });

    return res.json({ ok: true, token, user: payload });
  } catch (err) {
    next(err);
  }
};
