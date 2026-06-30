import dotenv from "dotenv";
import connectDB from "./config/db.js";

import Reminder from "./models/Reminder.js";
import { processReminderForNow } from "./controllers/reminder.controller.js";
import app from "./app.js";

dotenv.config();

await connectDB();

const PORT = Number(process.env.PORT || 4001);

const server = app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

// ----- SIMPLE SCHEDULER -----
const SCHEDULER_INTERVAL_MS = 15 * 60 * 1000;

async function runReminderScheduler() {
  const nowUtc = new Date();
  console.log("REMINDER Scheduler tick at", nowUtc.toISOString());

  try {
    const activeReminders = await Reminder.find({ isActive: true });

    for (const r of activeReminders) {
      try {
        await processReminderForNow(r, nowUtc);
      } catch (e) {
        console.error("REMINDER Error processing reminder", r?.id, e);
      }
    }
  } catch (err) {
    console.error("REMINDER Scheduler top-level error", err);
  }
}

const schedulerTimer = setInterval(runReminderScheduler, SCHEDULER_INTERVAL_MS);
schedulerTimer.unref();
runReminderScheduler();

// ───────────── Graceful shutdown ─────────────
import mongoose from "mongoose";

let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[${signal}] Graceful shutdown starting...`);

  // Stop accepting new HTTP connections; let in-flight finish
  server.close((err) => {
    if (err) console.error("HTTP server close error:", err);
    else console.log("HTTP server closed");
  });

  // Stop scheduler
  clearInterval(schedulerTimer);

  // Give in-flight requests up to 10s
  const forceTimer = setTimeout(() => {
    console.error("Forced shutdown after 10s timeout");
    process.exit(1);
  }, 10_000);
  forceTimer.unref();

  // Close DB connection
  try {
    await mongoose.connection.close(false);
    console.log("MongoDB connection closed");
  } catch (e) {
    console.error("Mongo close error:", e.message);
  }

  clearTimeout(forceTimer);
  console.log("Graceful shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
  gracefulShutdown("uncaughtException");
});
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});

export default server;
