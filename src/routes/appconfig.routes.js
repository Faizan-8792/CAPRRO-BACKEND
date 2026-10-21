// src/routes/appconfig.routes.js
import { Router } from "express";
import { authRequired } from "../middleware/auth.middleware.js";
import { superLimiter } from "../middleware/rate-limit.middleware.js";
import {
  getAppConfig,
  dismissWelcome,
  dismissDesktopUpdate,
  updateFeatureFlags,
  updateMaintenance,
  updateWelcomeAnnouncement,
  updateDesktopRelease,
  notifyDesktopRelease,
  getDesktopReleaseDraft,
  getControlChanges,
  publishDeadlineCatalogue,
  publishNoticeCatalogue,
} from "../controllers/appconfig.controller.js";

const router = Router();

// Public — clients fetch this to detect maintenance, announcements, and rollout state.
// No auth required so even a logged-out login screen can detect maintenance.
router.get("/", getAppConfig);

// Authenticated — user dismisses the welcome popup permanently for current version.
router.post("/dismiss-welcome", authRequired, dismissWelcome);

// Authenticated — ordinary user action, no superLimiter (mirrors dismiss-welcome above).
// Persists as User.desktopUpdateSeenAnnouncementId (by announcement id, not version).
router.post("/dismiss-desktop-update", authRequired, dismissDesktopUpdate);

// Super-admin only — control rollout, maintenance, and welcome content. All five carry
// superLimiter: these were previously unthrottled (superLimiter was applied only to
// /api/super), swept onto one shared definition in rate-limit.middleware.js.
router.patch("/features", authRequired, superLimiter, updateFeatureFlags);
router.patch("/maintenance", authRequired, superLimiter, updateMaintenance);
// DS24: who moved maintenance mode or a feature flag, what was set and the reason given.
router.get("/control-changes", authRequired, superLimiter, getControlChanges);
// W10 AP40: the owner publishes the statutory calendar; clients read it from the public config above.
router.patch("/deadline-catalogue", authRequired, superLimiter, publishDeadlineCatalogue);
// W11 IN21: reply windows per notice form and the Income-tax Act transition rule, published by the owner.
router.patch("/notice-catalogue", authRequired, superLimiter, publishNoticeCatalogue);
router.patch("/welcome", authRequired, superLimiter, updateWelcomeAnnouncement);
router.get("/desktop-release", authRequired, superLimiter, getDesktopReleaseDraft);
router.patch("/desktop-release", authRequired, superLimiter, updateDesktopRelease);
router.post("/desktop-release/notify", authRequired, superLimiter, notifyDesktopRelease);

export default router;
