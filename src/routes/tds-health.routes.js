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
import { trackWorkflow } from "../middleware/workflow-usage.middleware.js";
import {
  requireFirmAdmin,
  requireFirmMember,
  requireFirmWriteAccess,
} from "../middleware/authorization.middleware.js";
import { requireFeatureFlag } from "../middleware/rollout.middleware.js";
import { draftTdsActions } from "../services/tds-intelligence.service.js";

async function createActionDrafts(req, res, next) {
  try {
    const result = await draftTdsActions({ firmId: req.user.firmId, userId: req.user.id, runId: req.params.id, input: req.body || {} });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return next(error);
  }
}

const router = Router();

router.use(
  authRequiredWithoutUsageTracking,
  requireFirmMember,
  requireFirmWriteAccess,
  trackWorkflow("tds_health"),
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
// W11 IN18: drafted reviewer notes and chase messages for the action-plan preview; nothing is stored by drafting.
router.post("/runs/:id/action-drafts", requireFeatureFlag("intelligence"), createActionDrafts);
router.post("/runs/:id/create-tasks", createTasksCompatibility);
router.get("/runs/:id/history", listHistory);
router.post("/runs/:id/lock", requireFirmAdmin, lockRun);
router.get("/runs/:id/export", requireFirmAdmin, exportRun);
router.get("/runs/:id", showRun);

export default router;
