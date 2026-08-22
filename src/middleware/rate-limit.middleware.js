// src/middleware/rate-limit.middleware.js
// Rate limiters shared across route files. superLimiter used to be defined inline in app.js
// and applied only to /api/super, leaving every super-admin write route on /api/app-config
// unthrottled. One definition here, applied everywhere a super-admin write route is mounted,
// so the config cannot drift out of sync between the two places it is needed.

import rateLimit from "express-rate-limit";

// Super admin endpoints: moderate - 50 requests per 15 minutes.
export const superLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Rate limit exceeded for admin operations." },
});
