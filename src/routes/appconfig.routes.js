// src/routes/appconfig.routes.js
import { Router } from "express";
import { authRequired } from "../middleware/auth.middleware.js";
import {
  getAppConfig,
  dismissWelcome,
  updateMaintenance,
  updateWelcomeAnnouncement,
} from "../controllers/appconfig.controller.js";

const router = Router();

// Public — clients fetch this to detect maintenance + welcome announcement.
// No auth required so even a logged-out login screen can detect maintenance.
router.get("/", getAppConfig);

// Authenticated — user dismisses the welcome popup permanently for current version.
router.post("/dismiss-welcome", authRequired, dismissWelcome);

// Super-admin only — toggle maintenance + edit welcome message.
router.patch("/maintenance", authRequired, updateMaintenance);
router.patch("/welcome", authRequired, updateWelcomeAnnouncement);

export default router;
