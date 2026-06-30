// src/middleware/maintenance.middleware.js
// Blocks protected API routes with 503 when maintenance mode is ON.
// Allowlist: /api/auth/*, /api/app-config, /api/super/*, /health — these must
// always stay reachable so admins can disable maintenance and users can sign in.

import AppConfig from "../models/AppConfig.js";

const ALLOW_PREFIXES = [
  "/api/auth/",
  "/api/app-config",
  "/api/super/",
  "/health",
];

function isAllowed(path) {
  return ALLOW_PREFIXES.some((p) => path.startsWith(p));
}

export async function maintenanceGate(req, res, next) {
  try {
    // Quick path: skip non-API requests entirely
    if (!req.path.startsWith("/api/")) return next();
    if (isAllowed(req.path)) return next();

    const cfg = await AppConfig.getInstance();
    if (cfg?.maintenanceMode) {
      return res.status(503).json({
        ok: false,
        error: "maintenance",
        message: cfg.maintenanceMessage || "Service under maintenance. Please try again later.",
      });
    }
    return next();
  } catch (err) {
    // If config fetch fails, fail OPEN (don't block traffic on a DB blip)
    return next();
  }
}
