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
      .select("email role accountType firmId isActive")
      .lean();
    if (!user) {
      return reject(req, res, 401, "User no longer exists");
    }
    if (user.isActive === false) {
      return reject(req, res, 403, "Account is inactive");
    }

    req.user = {
      id: String(user._id),
      email: user.email,
      role: user.role,
      accountType: user.accountType,
      firmId: user.firmId || null,
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
