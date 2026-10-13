import { Router } from "express";
import {
  getGstDownloadSettings,
  listGstDownloads,
  listGstFilingStatus,
  listGstFrequency,
  patchGstDownloadSettings,
  recordGstDownloads,
} from "../controllers/gst-downloads.controller.js";
import { authRequiredWithoutUsageTracking } from "../middleware/auth.middleware.js";
import { trackWorkflow } from "../middleware/workflow-usage.middleware.js";
import {
  requireFirmAdmin,
  requireFirmMember,
  requireFirmWriteAccess,
} from "../middleware/authorization.middleware.js";

// The GST downloader's run records, per firm (GD30; owner decision OD4, 2026-10-04). Every route
// is the signed-in member's own firm. Recording a run is a write and counts one downloader_run;
// the firm's recording switch is changed by its admins only. The filing board (decision D4, GD33)
// is read by any member.
const router = Router();

router.use(authRequiredWithoutUsageTracking, requireFirmMember);

router.post("/records/bulk", requireFirmWriteAccess, trackWorkflow("downloader_run"), recordGstDownloads);
router.get("/records", listGstDownloads);
router.get("/frequency", listGstFrequency);
router.get("/filing-status", listGstFilingStatus);
router.get("/settings", getGstDownloadSettings);
router.patch("/settings", requireFirmAdmin, patchGstDownloadSettings);

export default router;
