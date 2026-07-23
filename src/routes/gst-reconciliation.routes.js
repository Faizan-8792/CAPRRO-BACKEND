import { Router } from "express";
import {
  createRun,
  exportRun,
  listActivity,
  listItems,
  listRuns,
  lockRun,
  recoverRunReview,
  showGstr3bControl,
  showRun,
  showSupplierChase,
  updateItemDisposition,
  updateItemsBulk,
} from "../controllers/gst-reconciliation.controller.js";
import {
  authRequiredWithoutUsageTracking,
} from "../middleware/auth.middleware.js";
import { requireFirmMember } from "../middleware/authorization.middleware.js";
import { requireFeatureFlag } from "../middleware/rollout.middleware.js";

const router = Router();

router.use(
  authRequiredWithoutUsageTracking,
  requireFirmMember,
  requireFeatureFlag("gstReconciliation")
);

router.post("/runs", createRun);
router.get("/runs", listRuns);
router.get("/runs/:id/items", listItems);
router.patch("/runs/:id/items/:itemId", updateItemDisposition);
router.post("/runs/:id/bulk", updateItemsBulk);
router.get("/runs/:id/3b-control", showGstr3bControl);
router.get("/runs/:id/supplier-chase", showSupplierChase);
router.get("/runs/:id/activity", listActivity);
router.post("/runs/:id/recover-review", recoverRunReview);
router.post("/runs/:id/lock", lockRun);
router.get("/runs/:id/export", exportRun);
router.get("/runs/:id", showRun);

export default router;
