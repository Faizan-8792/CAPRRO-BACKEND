// src/server.js
import dotenv from "dotenv";
import morgan from "morgan";
import connectDB from "./config/db.js";
import Reminder from "./models/Reminder.js";
import { processReminderForNow } from "./controllers/reminder.controller.js";
import app from "./app.js"; // ✅ use existing app.js

// ----- Setup -----
dotenv.config();
connectDB();

// Extra logging if needed (app already has morgan, optional)
app.use(morgan("dev"));

// Root check (JSON response)
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

export default server;
