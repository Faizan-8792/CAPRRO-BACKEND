// src/routes/audit.routes.js
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authRequired } from "../middleware/auth.middleware.js";
import {
  refineAuditClassification,
  generateInsights,
  generateReminderMessage,
  generateStandardGuidance,
} from "../controllers/audit.controller.js";

const router = Router();

router.use(authRequired);

// O10: cheap second line of defense on every DeepSeek-backed route here, on top
// of (not instead of) the per-user/monthly/global quota enforced inside
// callDeepSeek itself (deepseek-provider.service.js) -- this bounds how fast a
// burst can run, the quota bounds the total spend that burst can rack up in a
// day. Same express-rate-limit pattern and per-IP keying as auth.routes.js;
// 30/5min is generous for genuine interactive use (a handful of documents in a
// short session) while still cutting off a tight retry loop long before it can
// exhaust a day's quota in seconds.
const deepSeekRouteLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many AI requests. Wait a few minutes and try again." },
});
router.use(deepSeekRouteLimiter);

// Hybrid NLP + LLM classifier
router.post("/refine", refineAuditClassification);

// AI insights from extracted text + topic
router.post("/insights", generateInsights);

// Personalized reminder/chase message generation
router.post("/reminder-message", generateReminderMessage);

// On-demand LLM-generated guidance for any standard/section code
router.post("/standard-guidance", generateStandardGuidance);

export default router;
