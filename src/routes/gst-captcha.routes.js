// src/routes/gst-captcha.routes.js
//
// Captcha solving for the GST auto sign-in, proxied through the server so the
// browser extension never needs a CaptchaKings key of its own and never hits
// captchakings.com cross-origin (newer Chromium builds no longer grant
// extensions the host-permission CORS bypass, which made the direct call die
// on TypeError: Failed to fetch).
//
// The firm's key lives in the server env (CAPTCHA_API). Each solve is billed
// to that key, so the route is signed-in-users-only, rate-limited hard, and
// refuses anything that is not a small inline JPEG/PNG.
//
// Hardening (2026-10-09, owner decision to keep the relay):
//   - The express-rate-limit window is per account (the authenticated user
//     id), not per internet address — a shared office connection cannot turn
//     one firm's budget into everyone's ceiling, and one account cannot
//     multiply theirs across addresses.
//   - A daily per-account cap on top of the burst window, so a leaked
//     credential cannot drain the key around the clock.
//   - The reply never carries the service balance. What the key is worth is
//     the operator's business, not the caller's.

import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authRequired } from "../middleware/auth.middleware.js";

const router = Router();

const ENDPOINT = "https://captchakings.com/api/process.php";
const MAX_BASE64_LENGTH = 400_000; // ~300 KB of image — a captcha is ~10 KB
const DATA_URL_SHAPE = /^data:image\/(jpeg|jpg|png|gif);base64,([A-Za-z0-9+/=]+)$/i;

// Captcha solves are bursty by nature (one per client per login). 60 per
// 15 minutes per account is far above a real firm's needs and far below
// anything that could drain the shared key if an account leaked.
const solveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id || req.ip,
  message: { ok: false, error: "Too many captcha solves from this account. Wait a few minutes." },
});

// The daily ceiling. One hundred solves is a full month of sign-ins for a
// large firm, and far short of anything worth scripting against.
const DAILY_SOLVE_CAP = 100;

// Today's solves per account, in this process. Resets at midnight UTC. A
// restart clears the counter — acceptable for a cost guard whose real bound
// is the express limiter above plus the key's own dashboard.
const solvesToday = new Map();
let solvesTodayDate = new Date().toISOString().slice(0, 10);

function dailyCountAndBump(userId) {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== solvesTodayDate) {
    solvesToday.clear();
    solvesTodayDate = today;
  }
  const next = (solvesToday.get(userId) || 0) + 1;
  solvesToday.set(userId, next);
  return next;
}

router.post("/captcha-solve", authRequired, solveLimiter, async (req, res) => {
  const apiKey = process.env.CAPTCHA_API;
  if (!apiKey) {
    return res.status(503).json({ ok: false, error: "Captcha solving is not configured on this server." });
  }

  const userId = req.user?.id || req.ip || "unknown";
  const usedToday = dailyCountAndBump(userId);
  if (usedToday > DAILY_SOLVE_CAP) {
    return res.status(429).json({
      ok: false,
      error: `This account has reached its captcha limit for today (${DAILY_SOLVE_CAP}). It resets at midnight UTC.`,
    });
  }

  const dataUrl = String(req.body?.dataUrl || "");
  const match = DATA_URL_SHAPE.exec(dataUrl);
  if (!match) {
    return res.status(400).json({ ok: false, error: "The captcha image must arrive as an inline JPEG or PNG data URL." });
  }
  if (dataUrl.length > MAX_BASE64_LENGTH) {
    return res.status(413).json({ ok: false, error: "That image is too large to be a captcha." });
  }

  const bytes = Buffer.from(match[2], "base64");
  const form = new FormData();
  form.append("captcha", new Blob([bytes], { type: `image/${match[1] === "jpg" ? "jpeg" : match[1]}` }), "captcha.jpg");

  let httpCode = 0;
  let answer = null;
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(45_000),
    });
    httpCode = response.status;
    answer = await response.json().catch(() => null);
  } catch (error) {
    return res.status(502).json({ ok: false, error: `The captcha service could not be reached: ${error.message}` });
  }

  if (httpCode === 401 || httpCode === 403 || httpCode === 400) {
    const detail = answer?.error || "";
    if (/invalid api key/i.test(detail)) {
      return res.status(502).json({ ok: false, error: "The server's captcha key was rejected. The operator must check it." });
    }
    if (/insufficient|balance|credits/i.test(detail)) {
      return res.status(402).json({ ok: false, error: "The captcha service balance is too low. The operator must top it up." });
    }
    return res.status(502).json({ ok: false, error: answer?.error || `The captcha service failed (HTTP ${httpCode}).` });
  }
  if (httpCode === 429) {
    return res.status(429).json({ ok: false, error: "The captcha service is rate-limiting this key. Wait a moment and retry." });
  }
  if (!answer?.success || !answer?.data?.prediction) {
    return res.status(502).json({ ok: false, error: answer?.error || `The captcha service failed (HTTP ${httpCode}).` });
  }

  return res.json({
    ok: true,
    prediction: String(answer.data.prediction),
    confidence: String(answer.data.confidence || ""),
  });
});

export default router;
