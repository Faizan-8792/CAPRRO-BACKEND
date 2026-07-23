import { Router } from "express";
import {
  getDigestInbox,
  getDigestPreview,
  patchDigestPreferences,
  patchFirmDigestSettings,
  readDigestInboxItem,
  readDigestPreferences,
} from "../controllers/digest.controller.js";
import { authRequired } from "../middleware/auth.middleware.js";
import {
  requireFirmAdmin,
  requireFirmMember,
} from "../middleware/authorization.middleware.js";
import { captureOptionalFeatureFlag } from "../middleware/rollout.middleware.js";

const router = Router();
const captureDaily = captureOptionalFeatureFlag("dailyDigest");
const captureWeekly = captureOptionalFeatureFlag("weeklySummary");
const captureNoticeCases = captureOptionalFeatureFlag("noticeCases");

router.use(authRequired, requireFirmMember);
router.get("/preferences", readDigestPreferences);
router.patch("/preferences", patchDigestPreferences);
router.patch("/settings", requireFirmAdmin, patchFirmDigestSettings);
router.get(
  "/preview",
  captureDaily,
  captureWeekly,
  captureNoticeCases,
  getDigestPreview
);
router.get("/inbox", getDigestInbox);
router.post("/inbox/:deliveryId/read", readDigestInboxItem);

export default router;
