// src/server.js - FIXED
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import morgan from "morgan";
import path from "path";
import { fileURLToPath } from "url";
import connectDB from "./config/db.js";
import taskRoutes from "./routes/task.routes.js";
import authRoutes from "./routes/auth.routes.js";
import firmRoutes from "./routes/firm.routes.js";
import reminderRoutes from "./routes/reminder.routes.js";
import superRoutes from "./routes/super.routes.js";
import statsRoutes from "./routes/stats.routes.js";

import Reminder from "./models/Reminder.js";
import { processReminderForNow } from "./controllers/reminder.controller.js";

// ----- Setup -----
dotenv.config();
connectDB();

// __dirname resolve for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

// ✅ Serve static admin panel from /public
app.use(express.static(path.join(__dirname, "..", "public")));

// ----- API Routes -----
app.use("/api/auth", authRoutes);
app.use("/api/firms", firmRoutes);
app.use("/api/reminders", reminderRoutes);
app.use("/api/super", superRoutes);
app.use("/api/stats", statsRoutes);  // ✅ SINGLE mount point
app.use("/api/tasks", taskRoutes);

app.get("/", (req, res) => {
  res.json({ ok: true, message: "CA PRO Toolkit backend running" });
});

// ----- Server start -----
const PORT = process.env.PORT || 4001;
const server = app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

// ----- SIMPLE SCHEDULER -----
const SCHEDULER_INTERVAL_MS = 15 * 60 * 1000;

async function runReminderScheduler() {
  const nowUtc = new Date();
  console.log("[REMINDER] Scheduler tick at", nowUtc.toISOString());

  try {
    // ✅ FIXED: Removed .lean(false)
    const activeReminders = await Reminder.find({ isActive: true });

    for (const r of activeReminders) {
      try {
        await processReminderForNow(r, nowUtc);
      } catch (e) {
        console.error("[REMINDER] Error processing reminder", r._id, e);
      }
    }
  } catch (err) {
    console.error("[REMINDER] Scheduler top-level error", err);
  }
}

setInterval(runReminderScheduler, SCHEDULER_INTERVAL_MS);
runReminderScheduler();
