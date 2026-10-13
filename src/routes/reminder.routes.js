// src/routes/reminder.routes.js
import express from "express";
import { authRequired } from "../middleware/auth.middleware.js";
import {
  requireFirmAdmin,
  requireFirmMember,
  requireFirmWriteAccess,
} from "../middleware/authorization.middleware.js";
import { captureOptionalFeatureFlag } from "../middleware/rollout.middleware.js";
import {
  createReminder,
  listReminders,
  getTodayReminders,
  updateReminder,
  deactivateAllReminders,
  resolveReminderDeliveryAttempt,
} from "../controllers/reminder.controller.js";

const router = express.Router();
const captureNoticeCases = captureOptionalFeatureFlag("noticeCases");

// requireFirmMember gates the mutations too, so an inactive firm or a removed
// membership is refused rather than passed through by the write-access guard.
router.use(authRequired, requireFirmMember, requireFirmWriteAccess);

// Create reminder (extension / admin)
router.post("/", createReminder);

// List all reminders for user/firm
router.get("/", captureNoticeCases, listReminders);

// Today fired reminders (for dashboard)
router.get("/today", captureNoticeCases, getTodayReminders);

// Resolve an ambiguous provider outcome after external verification.
router.post(
  "/:id/delivery-attempts/:attemptKey/resolve",
  requireFirmAdmin,
  resolveReminderDeliveryAttempt,
);

// Turn off every manual reminder this caller can see, in one call.
//
// Above the :id route only for readability - a literal segment cannot be captured by :id, since
// this is a POST and that is a PATCH. It carries the router-wide guard and nothing more: a bulk
// action must not be gated more tightly than the per-row action it saves the person repeating,
// and reminderVisibilityFilter already scopes it to what they could reach one at a time.
router.post("/deactivate-all", deactivateAllReminders);

// Update / deactivate reminder
router.patch("/:id", updateReminder);

export default router;
