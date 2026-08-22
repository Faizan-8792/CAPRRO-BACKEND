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
router.patch("/welcome", authRequired, superLimiter, updateWelcomeAnnouncement);
router.get("/desktop-release", authRequired, superLimiter, getDesktopReleaseDraft);
router.patch("/desktop-release", authRequired, superLimiter, updateDesktopRelease);
router.post("/desktop-release/notify", authRequired, superLimiter, notifyDesktopRelease);

export default router;
