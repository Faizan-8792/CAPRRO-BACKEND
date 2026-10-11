import { Router } from "express";
import rateLimit from "express-rate-limit";
import {
  sendOtp,
  verifyOtpAndLogin,
  googleLogin,
  googleDesktopToken,
  getMe,
  updateMe,
} from "../controllers/auth.controller.js";
import { getCurrentTerms } from "../controllers/terms.controller.js";
import { refreshToken, refreshLimiter } from "../controllers/auth-refresh.controller.js";
import { postSessionEvent } from "../controllers/auth-session-events.controller.js";
import { authRequired, authRequiredForRefresh } from "../middleware/auth.middleware.js";

const router = Router();

router.get("/terms/current", getCurrentTerms);

// Rate limit: max 5 OTP sends per IP per 15 minutes
const sendOtpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many OTP requests. Try again in 15 minutes." },
});

// Rate limit: max 10 verify attempts per IP per 15 minutes
const verifyOtpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many verification attempts. Try again in 15 minutes." },
});

// Rate limit: max 20 Google sign-in attempts per IP per 15 minutes
const googleLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many sign-in attempts. Try again in 15 minutes." },
});

router.post("/send-otp", sendOtpLimiter, sendOtp);
router.post("/verify-otp", verifyOtpLimiter, verifyOtpAndLogin);
router.post("/google", googleLoginLimiter, googleLogin);
router.post("/google/desktop-token", googleLoginLimiter, googleDesktopToken);
// Sliding-session renewal (PHASE 8): a still-valid token trades for a fresh
// one, with the user re-hydrated and the revocation version re-checked on
// every call. Refuses expired tokens outright - no replay grace.
router.post("/refresh", authRequiredForRefresh, refreshLimiter, refreshToken);
// Client-known authentication facts (explicit sign-out, restart recovery,
// refresh retry). Authenticated: a signed-out client has nothing to report.
router.post("/session-event", authRequired, postSessionEvent);
router.get("/me", authRequired, getMe);
router.patch("/me", authRequired, updateMe);

export default router;
