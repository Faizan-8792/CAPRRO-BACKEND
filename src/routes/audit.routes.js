// src/routes/audit.routes.js
import { Router } from "express";
import { authRequired } from "../middleware/auth.middleware.js";
import {
  refineAuditClassification,
  generateInsights,
  generateReminderMessage,
} from "../controllers/audit.controller.js";

const router = Router();

router.use(authRequired);

// Hybrid NLP + LLM classifier
router.post("/refine", refineAuditClassification);

// AI insights from extracted text + topic
router.post("/insights", generateInsights);

// Personalized reminder/chase message generation
router.post("/reminder-message", generateReminderMessage);

export default router;
