// src/routes/reminder.routes.js
import express from "express";
import { authRequired } from "../middleware/auth.middleware.js";
import {
  createReminder,
  listReminders,
  getTodayReminders,
  updateReminder,
} from "../controllers/reminder.controller.js";

const router = express.Router();

router.use(authRequired);

// Create reminder (extension / admin)
router.post("/", createReminder);

// List all reminders for user/firm
router.get("/", listReminders);

// Today fired reminders (for dashboard) ✅
router.get("/today", getTodayReminders);

// Update / deactivate reminder
router.patch("/:id", updateReminder);

export default router;
