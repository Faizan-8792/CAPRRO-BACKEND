import { Router } from "express";
import {
  getFilingDashboard,
  getReviewQueue,
  getTeamWorkload,
  getWorkspaceSearch,
} from "../controllers/firm-operations.controller.js";
import { authRequired } from "../middleware/auth.middleware.js";
import {
  requireFirmAdmin,
  requireFirmMember,
} from "../middleware/authorization.middleware.js";
import {
  captureOptionalFeatureFlag,
  requireFeatureFlag,
} from "../middleware/rollout.middleware.js";

const router = Router();
const captureNoticeCases = captureOptionalFeatureFlag("noticeCases");
const captureGst = captureOptionalFeatureFlag("gstReconciliation");
const captureTds = captureOptionalFeatureFlag("tdsHealth");

router.use(authRequired);
router.get(
  "/workspace/search",
  requireFirmMember,
  captureNoticeCases,
  getWorkspaceSearch
);
router.get(
  "/filing-dashboard",
  requireFirmMember,
  requireFeatureFlag("filingDashboard"),
  getFilingDashboard
);
router.get(
  "/team-workload",
  requireFirmAdmin,
  requireFeatureFlag("teamWorkload"),
  captureNoticeCases,
  getTeamWorkload
);
router.get(
  "/review-queue",
  requireFirmAdmin,
  captureNoticeCases,
  captureGst,
  captureTds,
  getReviewQueue
);

export default router;
