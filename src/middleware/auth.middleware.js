// src/middleware/auth.middleware.js
import jwt from "jsonwebtoken";
import User from "../models/User.js";

const JWT_SECRET = process.env.JWT_SECRET || "changeme";

/**
 * authRequired
 * Checks Bearer token, verifies JWT, and attaches user info to req.user.
 * Now also accepts token from query string for browser tab openings.
 */
export const authRequired = async (req, res, next) => {
  try {
    // Log what actually arrives (temporary debug, remove later if noisy)
    console.log("Auth middleware headers.authorization:", req.headers.authorization);

    // CHANGED: Accept token from Authorization header OR query string
    let authHeader = req.headers.authorization || req.headers.Authorization || "";
    
    // If no Authorization header, check for query token
    if (!authHeader && req.query && req.query.token) {
      // Construct a fake Bearer token string for consistent processing
      authHeader = `Bearer ${req.query.token}`;
      console.log("Auth: Using token from query string");
    }

    const parts = String(authHeader).trim().split(" ");

    // Tolerant: only require 2 parts and 'bearer' (case-insensitive)
    if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") {
      return res
        .status(401)
        .json({ ok: false, error: "Missing or invalid Authorization header or token" });
    }

    const token = parts[1];

    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      return res
        .status(401)
        .json({ ok: false, error: "Invalid or expired token" });
    }

    // Optional: verify user still exists
    if (payload.id) {
      const user = await User.findById(payload.id).lean();
      if (!user) {
        return res
          .status(401)
          .json({ ok: false, error: "User no longer exists" });
      }
    }

    // Expecting payload built in auth.controller: { id, email, role, accountType, firmId }
    req.user = {
      id: payload.id,
      email: payload.email,
      role: payload.role,
      accountType: payload.accountType,
      firmId: payload.firmId || null,
    };

    return next();
  } catch (err) {
    return next(err);
  }
};