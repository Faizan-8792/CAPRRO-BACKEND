import { Router } from "express";
import { resendWebhook } from "../controllers/webhook.controller.js";
import rateLimit from "express-rate-limit";

const router = Router();

// Bursts of provider retries must not become an amplification surface.
const webhookLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

// Public, signature-verified route — see the controller header for the
// verification scheme and why no auth middleware applies here.
router.post("/resend", webhookLimiter, resendWebhook);

export default router;
