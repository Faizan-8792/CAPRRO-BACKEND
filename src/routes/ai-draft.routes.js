// src/routes/ai-draft.routes.js
//
// W11 IN5 (2026-10-21). Mounted at /api/ai-drafts. Every route needs a signed-in firm member. Reading the
// settings answers whatever the flag says (so a client can tell "switched off" from "not opted in"); changing
// the firm's opt-in needs a firm owner or admin; everything else answers 404 naming the `intelligence` flag
// while it is off.
import { Router } from "express";
import {
  createRuleOutcome,
  showDraft,
  showSettings,
  updateDraftOutcome,
  updateSettings,
} from "../controllers/ai-draft.controller.js";
import { authRequired } from "../middleware/auth.middleware.js";
import {
  requireFirmAdmin,
  requireFirmMember,
  requireFirmWriteAccess,
} from "../middleware/authorization.middleware.js";
import { requireFeatureFlag } from "../middleware/rollout.middleware.js";

const router = Router();

router.use(authRequired, requireFirmMember);

router.get("/settings", showSettings);
router.put("/settings", requireFeatureFlag("intelligence"), requireFirmAdmin, updateSettings);
router.post("/rule-outcomes", requireFeatureFlag("intelligence"), requireFirmWriteAccess, createRuleOutcome);
router.get("/:id", requireFeatureFlag("intelligence"), showDraft);
router.patch("/:id/outcome", requireFeatureFlag("intelligence"), requireFirmWriteAccess, updateDraftOutcome);

export default router;
