// src/middleware/usage-tracker.middleware.js
// Throttled "last seen" tracker: updates User.lastActiveAt at most once per 5 min per user.
// Skips DB write entirely if within the window — keeps overhead negligible.

import User from "../models/User.js";

const TOUCH_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const memoryCache = new Map(); // userId -> lastTouchedMs

export function trackUsage(req, res, next) {
  // Only track authenticated requests
  if (!req.user?.id) return next();

  const userId = String(req.user.id);
  const now = Date.now();
  const last = memoryCache.get(userId) || 0;

  if (now - last < TOUCH_WINDOW_MS) {
    return next();
  }
  memoryCache.set(userId, now);

  // Fire-and-forget DB write; don't block the request
  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.ip ||
    req.socket?.remoteAddress ||
    null;

  User.updateOne(
    { _id: userId },
    {
      $set: { lastActiveAt: new Date(), lastSeenIp: ip },
      $inc: { totalApiCalls: 1 },
    }
  ).catch((err) => {
    console.warn("trackUsage update failed:", err?.message);
  });

  next();
}

// Periodic cleanup to prevent unbounded growth
setInterval(() => {
  const now = Date.now();
  const cutoff = TOUCH_WINDOW_MS * 2;
  for (const [k, v] of memoryCache.entries()) {
    if (now - v > cutoff) memoryCache.delete(k);
  }
}, 10 * 60 * 1000).unref();
