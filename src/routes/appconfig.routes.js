// src/routes/appconfig.routes.js
import { Router } from "express";
import { authRequired } from "../middleware/auth.middleware.js";
import {
  getAppConfig,
  dismissWelcome,
  updateFeatureFlags,
  updateMaintenance,
  updateWelcomeAnnouncement,
} from "../controllers/appconfig.controller.js";

const router = Router();

// Public — clients fetch this to detect maintenance, announcements, and rollout state.
// No auth required so even a logged-out login screen can detect maintenance.
router.get("/", getAppConfig);

// Authenticated — user dismisses the welcome popup permanently for current version.
router.post("/dismiss-welcome", authRequired, dismissWelcome);

// Super-admin only — control rollout, maintenance, and welcome content.
router.patch("/features", authRequired, updateFeatureFlags);
router.patch("/maintenance", authRequired, updateMaintenance);
router.patch("/welcome", authRequired, updateWelcomeAnnouncement);

export default router;
