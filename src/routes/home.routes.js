import { Router } from "express";
import { getHomeSummary } from "../controllers/workspace.controller.js";
import { getTodayPriorities } from "../services/priority-engine.service.js";
import { authRequired } from "../middleware/auth.middleware.js";
import { requireFirmMember } from "../middleware/authorization.middleware.js";
import {
  captureOptionalFeatureFlag,
  requireFeatureFlag,
} from "../middleware/rollout.middleware.js";

const router = Router();
const fullTabWorkspaceEnabled = requireFeatureFlag("fullTabWorkspace");
const homeWorkspaceEnabled = requireFeatureFlag("homeWorkspace");
const captureNoticeCases = captureOptionalFeatureFlag("noticeCases");

router.use(authRequired);
router.get(
  "/summary",
  requireFirmMember,
  fullTabWorkspaceEnabled,
  homeWorkspaceEnabled,
  captureNoticeCases,
  getHomeSummary
);

// W11 IN22: today's priorities across tasks, reminders, notices, reconciliations, TDS checks and client requests,
// ranked on the server with a reason per line. No model. Behind the `intelligence` flag.
router.get("/priorities", requireFirmMember, requireFeatureFlag("intelligence"), async (req, res, next) => {
  try {
    return res.json({ ok: true, ...(await getTodayPriorities({ firmId: req.user.firmId, userId: req.user.id })) });
  } catch (error) {
    return next(error);
  }
});

export default router;
