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
  createChaseDrafts,
  createResidueCauses,
  showChasePack,
  showRunCauses,
} from "../controllers/gst-intelligence.controller.js";
import {
  authRequiredWithoutUsageTracking,
} from "../middleware/auth.middleware.js";
import { trackWorkflow } from "../middleware/workflow-usage.middleware.js";
import {
  requireFirmMember,
  requireFirmWriteAccess,
} from "../middleware/authorization.middleware.js";
import { requireFeatureFlag } from "../middleware/rollout.middleware.js";

const router = Router();

router.use(
  authRequiredWithoutUsageTracking,
  requireFirmMember,
  requireFirmWriteAccess,
  trackWorkflow("gst_recon"),
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
// W11 IN8-IN12: likely causes and the supplier chase pack, also behind the `intelligence` flag.
router.get("/runs/:id/causes", requireFeatureFlag("intelligence"), showRunCauses);
router.post("/runs/:id/causes/residue", requireFeatureFlag("intelligence"), createResidueCauses);
router.get("/runs/:id/chase-pack", requireFeatureFlag("intelligence"), showChasePack);
router.post("/runs/:id/chase-pack/draft", requireFeatureFlag("intelligence"), createChaseDrafts);
router.get("/runs/:id", showRun);

export default router;
