// src/routes/reminder.routes.js
import express from "express";
import { authRequired } from "../middleware/auth.middleware.js";
import { requireFirmAdmin } from "../middleware/authorization.middleware.js";
import { captureOptionalFeatureFlag } from "../middleware/rollout.middleware.js";
import {
  createReminder,
  listReminders,
  getTodayReminders,
  updateReminder,
  resolveReminderDeliveryAttempt,
} from "../controllers/reminder.controller.js";

const router = express.Router();
const captureNoticeCases = captureOptionalFeatureFlag("noticeCases");

router.use(authRequired);

// Create reminder (extension / admin)
router.post("/", createReminder);

// List all reminders for user/firm
router.get("/", captureNoticeCases, listReminders);

// Today fired reminders (for dashboard)
router.get(
  "/today",
  captureNoticeCases,
  getTodayReminders
);

// Resolve an ambiguous provider outcome after external verification.
router.post(
  "/:id/delivery-attempts/:attemptKey/resolve",
  requireFirmAdmin,
  resolveReminderDeliveryAttempt
);

// Update / deactivate reminder
router.patch("/:id", updateReminder);

export default router;
