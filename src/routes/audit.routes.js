// src/routes/audit.routes.js
import { Router } from "express";
import { authRequired } from "../middleware/auth.middleware.js";
import { refineAuditClassification } from "../controllers/audit.controller.js";

const router = Router();

router.use(authRequired);

// POST /api/audit/refine - Hybrid NLP + LLM audit text classifier
router.post("/refine", refineAuditClassification);

export default router;
