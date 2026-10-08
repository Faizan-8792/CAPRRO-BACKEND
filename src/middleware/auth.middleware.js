// src/middleware/auth.middleware.js
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import { trackUsage } from "./usage-tracker.middleware.js";

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error("JWT_SECRET env var is required");

function reject(req, res, status, error) {
  return res.status(status).json({
    ok: false,
    error,
    requestId: req.id || "",
  });
}

/**
 * Verifies token identity, then hydrates authorization fields from MongoDB.
 * JWT role/firm claims are informational only and may become stale after
 * membership, activation, or role changes.
 */
async function authenticate(req, res, next, { recordUsage }) {
  try {
    const authHeader =
      req.headers.authorization || req.headers.Authorization || "";
    const parts = String(authHeader).trim().split(" ");

    if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") {
      return reject(req, res, 401, "Missing or invalid Authorization header");
    }

    let payload;
    try {
      payload = jwt.verify(parts[1], JWT_SECRET);
    } catch {
      return reject(req, res, 401, "Invalid or expired token");
    }

    if (!payload?.id) {
      return reject(req, res, 401, "Invalid token subject");
    }

    const user = await User.findById(payload.id)
      .select("email role accountType firmId isActive tokenVersion")
      .lean();
    if (!user) {
      return reject(req, res, 401, "User no longer exists");
    }
    if (user.isActive === false) {
      return reject(req, res, 403, "Account is inactive");
    }
    // Session revocation: a token is valid only while its tv claim matches the
    // account's current tokenVersion. Old tokens (no tv) default to 0, so this
    // stays backward-compatible until a force-logout bumps the version.
    if ((user.tokenVersion || 0) !== (payload.tv || 0)) {
      return reject(req, res, 401, "Session revoked. Please sign in again.");
    }

    req.user = {
      id: String(user._id),
      email: user.email,
      role: user.role,
      accountType: user.accountType,
      firmId: user.firmId || null,
      // The version this request was authorized under. Later writes condition on
      // it so a force-logout that lands mid-request cannot be committed through.
      tokenVersion: user.tokenVersion || 0,
      // Client-type claim (IMPROVEMENT-PLAN-V2-2026-09-28 Part 3). 'desktop'
      // enters a token only via the verified Google installed-app audience;
      // absence (older unexpired tokens) means 'extension'. This claim — not
      // any request body field — is what usage analytics records.
      client: payload.client === "desktop" ? "desktop" : "extension",
    };

    // Corroboration, not identity: the desktop has always sent X-CaPro-Client,
    // the extension now sends it too. The claim wins; a disagreement is logged
    // as a coarse anomaly with no identifier attached (PLAN.md: clientType
    // metadata is untrusted, so it is recorded as metadata or ignored, never
    // used to decide anything).
    const headerClient = String(
      req.headers["x-capro-client"] || "",
    ).toLowerCase();
    if (headerClient && headerClient !== req.user.client) {
      console.warn(
        `[client-context] claim/header client mismatch (${req.user.client} vs ${headerClient})`,
      );
    }
    req.clientMeta = {
      version: String(req.headers["x-capro-client-version"] || "").slice(0, 40),
      header: headerClient || null,
    };

    if (recordUsage) {
      // Throttled, fire-and-forget usage tracking receives current firm/role state.
      trackUsage(req, res, () => {});
    }

    return next();
  } catch (error) {
    return next(error);
  }
}

export function authRequired(req, res, next) {
  return authenticate(req, res, next, { recordUsage: true });
}

// Read-only identity path for endpoints whose contract forbids database writes.
export function authRequiredWithoutUsageTracking(req, res, next) {
  return authenticate(req, res, next, { recordUsage: false });
}
