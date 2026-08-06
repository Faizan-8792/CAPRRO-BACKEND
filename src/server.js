import "./config/load-env.js";
import { hostname } from "node:os";
import mongoose from "mongoose";

import connectDB from "./config/db.js";
import AppConfig from "./models/AppConfig.js";
import Reminder from "./models/Reminder.js";
import { processReminderForNow } from "./controllers/reminder.controller.js";
import { assertCaseIndexesReady } from "./services/case-index-readiness.service.js";
import { assertDigestIndexesReady } from "./services/digest-index-readiness.service.js";
import { assertEngagementIndexesReady } from "./services/engagement-index-readiness.service.js";
import { assertAuditWorkingPaperIndexesReady } from "./services/audit-working-paper-index-readiness.service.js";
import { runAutomationWorkerBatch } from "./services/automation-worker.service.js";
import { ensureRequiredIndexes } from "./services/index-provisioning.service.js";
import {
  drainDigestRecovery,
  enqueueDueDigests,
} from "./services/digest.service.js";
import app, {
  setBackgroundInitializationError,
  setBackgroundReadiness,
} from "./app.js";

const PORT = Number(process.env.PORT || 4001);
const REMINDER_SCHEDULER_INTERVAL_MS = 15 * 60 * 1000;
const DIGEST_SCHEDULER_INTERVAL_MS = 15 * 60 * 1000;
const AUTOMATION_WORKER_INTERVAL_MS = 30 * 1000;
const BOOTSTRAP_RETRY_DELAY_MS = 30 * 1000;
const AUTOMATION_WORKER_BATCH_SIZE = 5;
const automationWorkerId = `${hostname()}:${process.pid}`;

let shuttingDown = false;
let schedulersStarted = false;
let bootstrapPromise = null;
let bootstrapRetryTimer = null;
// Names the phase boot is currently in, so a failure reports where it happened
// and not only what the error code was. Several phases can raise the same driver
// error code, and without the phase the code does not identify the cause.
let bootstrapStage = null;
let databaseConnectionInitialized = false;
let automationWorkerPromise = null;
let digestSchedulerPromise = null;
let reminderSchedulerTimer = null;
let digestSchedulerTimer = null;
let automationWorkerTimer = null;

export async function completeDigestStartup({
  assertIndexes,
  drainRecovery,
  startSchedulers,
  setReady,
  isShuttingDown,
}) {
  // This body deliberately touches nothing but its injected parameters. A test
  // extracts this function's source and evaluates it in isolation, so a reference
  // to any module-level binding here is a crash rather than a test failure. That
  // is also why bootstrap() names the stage before calling this rather than the
  // phases naming themselves: within digest startup the error code distinguishes
  // them -- DIGEST_INDEXES_NOT_READY for the index phase, DIGEST_RECOVERY_* for
  // the drain.
  await assertIndexes();
  if (isShuttingDown()) return false;
  await drainRecovery();
  if (isShuttingDown()) return false;
  await startSchedulers();
  setReady(true);
  return true;
}

// Start listening synchronously (no top-level await) so process managers such
// as Phusion Passenger — which do not reliably support top-level await in the
// entry module — detect the server immediately. Database connection, rollout
// readiness checks, and background schedulers are initialized asynchronously in
// bootstrap() after the server is already accepting connections. Health stays
// degraded until database and background readiness checks both complete.
setBackgroundReadiness(false);
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
          error,
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
  if (shuttingDown || schedulersStarted) return false;
  schedulersStarted = true;
  reminderSchedulerTimer = setInterval(
    runReminderScheduler,
    REMINDER_SCHEDULER_INTERVAL_MS,
  );
  digestSchedulerTimer = setInterval(
    runDigestScheduler,
    DIGEST_SCHEDULER_INTERVAL_MS,
  );
  automationWorkerTimer = setInterval(
    runAutomationWorker,
    AUTOMATION_WORKER_INTERVAL_MS,
  );
  reminderSchedulerTimer.unref();
  digestSchedulerTimer.unref();
  automationWorkerTimer.unref();
  runReminderScheduler();
  runDigestScheduler();
  runAutomationWorker();
  return true;
}

function currentBootstrapStage() {
  return bootstrapStage;
}

async function bootstrap() {
  bootstrapStage = "connect";
  if (!databaseConnectionInitialized) {
    await connectDB();
    databaseConnectionInitialized = true;
  }

  // Create the indexes the assertions below require. connectDB() disables
  // autoIndex in production, and nothing else created them, so a release that
  // declared a new index could never reach readiness: the assertion threw, boot
  // retried every 30 seconds indefinitely, and the schedulers below never
  // started. This never fails the boot -- the assertions remain the authority on
  // readiness and report precisely what is missing.
  bootstrapStage = "provision-indexes";
  try {
    const provisioning = await ensureRequiredIndexes();
    if (provisioning.created.length > 0) {
      console.log(
        "[BOOT] Created indexes:",
        provisioning.created
          .map((entry) => `${entry.collection}.${entry.name}`)
          .join(", "),
      );
    }
    for (const failure of provisioning.failures) {
      console.error(
        `[BOOT] Index provisioning failed for ${failure.collection}: ${failure.reason}`,
      );
    }
  } catch (error) {
    console.error("[BOOT] Index provisioning error:", error?.message || error);
  }

  if (process.env.NODE_ENV === "production") {
    bootstrapStage = "rollout-flags";
    const [noticeRollout, engagementRollout, workingPaperRollout] =
      await Promise.all([
        AppConfig.getFeatureFlagState("noticeCases", { fresh: true }),
        AppConfig.getFeatureFlagState("assuranceEngagements", { fresh: true }),
        AppConfig.getFeatureFlagState("auditWorkingPapers", { fresh: true }),
      ]);
    if (workingPaperRollout.enabled && !engagementRollout.enabled) {
      const error = new Error(
        "auditWorkingPapers cannot start enabled while assuranceEngagements is disabled",
      );
      error.code = "INVALID_AUDIT_WORKING_PAPER_ROLLOUT";
      throw error;
    }
    bootstrapStage = "feature-index-readiness";
    const readinessChecks = [];
    if (noticeRollout.enabled) readinessChecks.push(assertCaseIndexesReady());
    if (engagementRollout.enabled)
      readinessChecks.push(assertEngagementIndexesReady());
    if (workingPaperRollout.enabled) {
      readinessChecks.push(assertAuditWorkingPaperIndexesReady());
    }
    await Promise.all(readinessChecks);
  }

  bootstrapStage = "digest-startup";
  return completeDigestStartup({
    assertIndexes: assertDigestIndexesReady,
    drainRecovery: drainDigestRecovery,
    startSchedulers,
    setReady: setBackgroundReadiness,
    isShuttingDown: () => shuttingDown,
  });
}

function clearBootstrapRetryTimer() {
  if (!bootstrapRetryTimer) return;
  clearTimeout(bootstrapRetryTimer);
  bootstrapRetryTimer = null;
}

function scheduleBootstrapRetry() {
  if (shuttingDown || bootstrapRetryTimer) return;
  bootstrapRetryTimer = setTimeout(() => {
    bootstrapRetryTimer = null;
    void runBootstrap();
  }, BOOTSTRAP_RETRY_DELAY_MS);
  bootstrapRetryTimer.unref();
}

function runBootstrap() {
  if (shuttingDown || bootstrapPromise) return bootstrapPromise;
  setBackgroundReadiness(false);
  bootstrapPromise = bootstrap()
    .catch((error) => {
      // Keep HTTP accepting connections so /health can report degraded while
      // fixed-delay retries wait for database/index readiness to recover.
      console.error(
        "[BOOT] Startup initialization error:",
        error?.message || error,
      );
      setBackgroundInitializationError(error, currentBootstrapStage());
      scheduleBootstrapRetry();
      return false;
    })
    .finally(() => {
      bootstrapPromise = null;
    });
  return bootstrapPromise;
}

void runBootstrap();

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  setBackgroundReadiness(false);
  clearBootstrapRetryTimer();
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
