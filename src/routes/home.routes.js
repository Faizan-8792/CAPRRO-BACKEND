import { Router } from "express";
import { getHomeSummary } from "../controllers/workspace.controller.js";
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

export default router;
