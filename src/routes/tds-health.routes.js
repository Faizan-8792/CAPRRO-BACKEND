import { Router } from "express";
import {
  commitActionPlan,
  createRun,
  createTasksCompatibility,
  exportRun,
  listChecks,
  listEvidence,
  listHistory,
  listRows,
  listRuns,
  lockRun,
  previewActionPlan,
  resolveCheck,
  showActionPlan,
  showRun,
  verifyPan,
  verifyPanCompatibility,
} from "../controllers/tds-health.controller.js";
import { authRequiredWithoutUsageTracking } from "../middleware/auth.middleware.js";
import {
  requireFirmAdmin,
  requireFirmMember,
} from "../middleware/authorization.middleware.js";
import { requireFeatureFlag } from "../middleware/rollout.middleware.js";

const router = Router();

router.use(
  authRequiredWithoutUsageTracking,
  requireFirmMember,
  requireFeatureFlag("tdsHealth")
);

router.post("/runs", createRun);
router.get("/runs", listRuns);
router.post("/pan-verifications", verifyPanCompatibility);
router.get("/runs/:id/checks", listChecks);
router.get("/runs/:id/checks/:checkId/evidence", listEvidence);
router.patch("/runs/:id/checks/:checkId", resolveCheck);
router.post("/runs/:id/checks/:checkId/pan-verification", verifyPan);
router.get("/runs/:id/rows", listRows);
router.get("/runs/:id/action-plan", showActionPlan);
router.post("/runs/:id/action-plan/preview", previewActionPlan);
router.post("/runs/:id/action-plan/commit", commitActionPlan);
router.post("/runs/:id/create-tasks", createTasksCompatibility);
router.get("/runs/:id/history", listHistory);
router.post("/runs/:id/lock", requireFirmAdmin, lockRun);
router.get("/runs/:id/export", requireFirmAdmin, exportRun);
router.get("/runs/:id", showRun);

export default router;
