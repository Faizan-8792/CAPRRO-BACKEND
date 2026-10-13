// src/middleware/rate-limit.middleware.js
// Rate limiters shared across route files. superLimiter used to be defined inline in app.js
// and applied only to /api/super, leaving every super-admin write route on /api/app-config
// unthrottled. One definition here, applied everywhere a super-admin write route is mounted,
// so the config cannot drift out of sync between the two places it is needed.

import rateLimit from "express-rate-limit";
import { recordAuthHealth } from "../services/auth-health.service.js";

// Super admin endpoints: moderate - 50 requests per 15 minutes.
export const superLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Rate limit exceeded for admin operations." },
});

// DS44: a rate limiter whose refusals reach the admin panel's Sign-in health page. Before this, a
// sign-in refused with "Too many sign-in attempts" (or by the API-wide limit of 200 requests per
// 15 minutes, which a busy office sharing one address can reach) left no trace at all, so the
// failure counts missed exactly the refusals a person cannot fix by trying again. `event(req)` says
// what a refusal means on this request - { kind, platform } - or null to record nothing. The
// answer itself is unchanged: the same status and body the library would send.
export function recordedLimiter({ event, ...options }) {
  return rateLimit({
    ...options,
    async handler(req, res, _next, used) {
      try {
        const what = typeof event === "function" ? event(req) : null;
        if (what) {
          recordAuthHealth({
            kind: what.kind,
            reason: "rate_limited",
            platform: what.platform,
            appVersion: req.get?.("X-CaPro-Client-Version") || "",
            userId: req.user?.id || null,
          });
        }
      } catch {
        // Recording must never change the answer.
      }
      res.status(used.statusCode);
      const message = typeof used.message === "function" ? await used.message(req, res) : used.message;
      if (!res.writableEnded) res.send(message);
    },
  });
}
