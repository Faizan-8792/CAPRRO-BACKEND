import "./config/load-env.js";
import { hostname } from "node:os";
import mongoose from "mongoose";

import connectDB from "./config/db.js";
import AppConfig from "./models/AppConfig.js";
import Reminder from "./models/Reminder.js";
import { processReminderForNow } from "./controllers/reminder.controller.js";
import { assertCaseIndexesReady } from "./services/case-index-readiness.service.js";
import { assertEngagementIndexesReady } from "./services/engagement-index-readiness.service.js";
import { assertAuditWorkingPaperIndexesReady } from "./services/audit-working-paper-index-readiness.service.js";
import { runAutomationWorkerBatch } from "./services/automation-worker.service.js";
import { enqueueDueDigests } from "./services/digest.service.js";
import app from "./app.js";

const PORT = Number(process.env.PORT || 4001);
const REMINDER_SCHEDULER_INTERVAL_MS = 15 * 60 * 1000;
const DIGEST_SCHEDULER_INTERVAL_MS = 15 * 60 * 1000;
const AUTOMATION_WORKER_INTERVAL_MS = 30 * 1000;
const AUTOMATION_WORKER_BATCH_SIZE = 5;
const automationWorkerId = `${hostname()}:${process.pid}`;

let shuttingDown = false;
let automationWorkerPromise = null;
let digestSchedulerPromise = null;
let reminderSchedulerTimer = null;
let digestSchedulerTimer = null;
let automationWorkerTimer = null;

// Start listening synchronously (no top-level await) so process managers such
// as Phusion Passenger — which do not reliably support top-level await in the
// entry module — detect the server immediately. Database connection, rollout
// readiness checks, and background schedulers are initialized asynchronously in
// bootstrap() after the server is already accepting connections.
const server = app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

async function runReminderScheduler() {
  const nowUtc = new Date();
  console.log("REMINDER Scheduler tick at", nowUtc.toISOString());

  try {
    const noticeCasesEnabled = await AppConfig.isFeatureEnabled("noticeCases", {
      fresh: true,
    });
    const activeReminders = await Reminder.find({
      isActive: true,
      ...(noticeCasesEnabled ? {} : { source: { $ne: "CASE" } }),
    });

    for (const reminder of activeReminders) {
      try {
        await processReminderForNow(reminder, nowUtc);
      } catch (error) {
        console.error(
          "REMINDER Error processing reminder",
          reminder?.id,
          error
        );
      }
    }
  } catch (error) {
    console.error("REMINDER Scheduler top-level error", error);
  }
}

function runDigestScheduler() {
  if (shuttingDown || digestSchedulerPromise) return digestSchedulerPromise;

  digestSchedulerPromise = enqueueDueDigests()
    .then((summary) => {
      if (!summary.disabled && (summary.daily || summary.weekly)) {
        console.log("[DIGEST] Scheduler tick complete", summary);
      }
      return summary;
    })
    .catch((error) => {
      console.error("[DIGEST] Scheduler tick failed", error);
      return null;
    })
    .finally(() => {
      digestSchedulerPromise = null;
    });

  return digestSchedulerPromise;
}

function runAutomationWorker() {
  if (shuttingDown || automationWorkerPromise) return automationWorkerPromise;

  automationWorkerPromise = runAutomationWorkerBatch({
    workerId: automationWorkerId,
    maxJobs: AUTOMATION_WORKER_BATCH_SIZE,
    shouldContinue: () => !shuttingDown,
  })
    .then((summary) => {
      if (summary.claimed) {
        console.log("[AUTOMATION] Worker batch complete", summary);
      }
      return summary;
    })
    .catch((error) => {
      console.error("[AUTOMATION] Worker batch failed", error);
      return null;
    })
    .finally(() => {
      automationWorkerPromise = null;
    });

  return automationWorkerPromise;
}

function startSchedulers() {
  reminderSchedulerTimer = setInterval(
    runReminderScheduler,
    REMINDER_SCHEDULER_INTERVAL_MS
  );
  digestSchedulerTimer = setInterval(
    runDigestScheduler,
    DIGEST_SCHEDULER_INTERVAL_MS
  );
  automationWorkerTimer = setInterval(
    runAutomationWorker,
    AUTOMATION_WORKER_INTERVAL_MS
  );
  reminderSchedulerTimer.unref();
  digestSchedulerTimer.unref();
  automationWorkerTimer.unref();
  runReminderScheduler();
  runDigestScheduler();
  runAutomationWorker();
}

async function bootstrap() {
  await connectDB();

  if (process.env.NODE_ENV === "production") {
    const [noticeRollout, engagementRollout, workingPaperRollout] =
      await Promise.all([
        AppConfig.getFeatureFlagState("noticeCases", { fresh: true }),
        AppConfig.getFeatureFlagState("assuranceEngagements", { fresh: true }),
        AppConfig.getFeatureFlagState("auditWorkingPapers", { fresh: true }),
      ]);
    if (workingPaperRollout.enabled && !engagementRollout.enabled) {
      const error = new Error(
        "auditWorkingPapers cannot start enabled while assuranceEngagements is disabled"
      );
      error.code = "INVALID_AUDIT_WORKING_PAPER_ROLLOUT";
      throw error;
    }
    const readinessChecks = [];
    if (noticeRollout.enabled) readinessChecks.push(assertCaseIndexesReady());
    if (engagementRollout.enabled)
      readinessChecks.push(assertEngagementIndexesReady());
    if (workingPaperRollout.enabled) {
      readinessChecks.push(assertAuditWorkingPaperIndexesReady());
    }
    await Promise.all(readinessChecks);
  }

  startSchedulers();
}

bootstrap().catch((error) => {
  // Keep the HTTP server accepting connections so the platform does not
  // crash-loop and /health can report a degraded state. Mongoose retries the
  // connection in the background.
  console.error("[BOOT] Startup initialization error:", error?.message || error);
});

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[${signal}] Graceful shutdown starting...`);

  if (reminderSchedulerTimer) clearInterval(reminderSchedulerTimer);
  if (digestSchedulerTimer) clearInterval(digestSchedulerTimer);
  if (automationWorkerTimer) clearInterval(automationWorkerTimer);

  server.close((error) => {
    if (error) console.error("HTTP server close error:", error);
    else console.log("HTTP server closed");
  });

  const forceTimer = setTimeout(() => {
    console.error("Forced shutdown after 10s timeout");
    process.exit(1);
  }, 10_000);
  forceTimer.unref();

  try {
    const activeWorker = automationWorkerPromise;
    if (activeWorker) await activeWorker;
  } catch (error) {
    console.error("Automation worker shutdown error:", error.message);
  }

  try {
    const activeDigestScheduler = digestSchedulerPromise;
    if (activeDigestScheduler) await activeDigestScheduler;
  } catch (error) {
    console.error("Digest scheduler shutdown error:", error.message);
  }

  try {
    await mongoose.connection.close(false);
    console.log("MongoDB connection closed");
  } catch (error) {
    console.error("Mongo close error:", error.message);
  }

  clearTimeout(forceTimer);
  console.log("Graceful shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("uncaughtException", (error) => {
  console.error("UNCAUGHT EXCEPTION:", error);
  gracefulShutdown("uncaughtException");
});
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});

export default server;
