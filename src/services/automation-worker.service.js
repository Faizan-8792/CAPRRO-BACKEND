import {
  DEFAULT_LEASE_MS,
  claimNextJob,
  completeJob,
  deferJob,
  failJob,
  renewJobLease,
} from "./automation-job.service.js";
import {
  COMPLIANCE_GENERATION_JOB_KIND,
  processComplianceGenerationJob,
} from "./compliance-generation.service.js";
import {
  GST_RECONCILIATION_JOB_KIND,
  processGstReconciliationJob,
} from "./gst-reconciliation.service.js";
import {
  TDS_HEALTH_JOB_KIND,
  processTdsHealthJob,
} from "./tds-health.service.js";
import {
  DIGEST_JOB_KIND,
  processDigestDeliveryJob,
} from "./digest.service.js";

const DEFAULT_BATCH_SIZE = 5;
const MAX_BATCH_SIZE = 20;
const JOB_HANDLERS = new Map([
  [COMPLIANCE_GENERATION_JOB_KIND, processComplianceGenerationJob],
  [GST_RECONCILIATION_JOB_KIND, processGstReconciliationJob],
  [TDS_HEALTH_JOB_KIND, processTdsHealthJob],
  [DIGEST_JOB_KIND, processDigestDeliveryJob],
]);

function boundedBatchSize(value) {
  const parsed = Number(value ?? DEFAULT_BATCH_SIZE);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_BATCH_SIZE;
  return Math.min(parsed, MAX_BATCH_SIZE);
}

function workerShouldContinue(callback) {
  try {
    return callback() !== false;
  } catch (error) {
    console.error("[AUTOMATION] Worker cancellation check failed:", error.message);
    return false;
  }
}

function leaseLostError() {
  const error = new Error("Automation job lease was lost during processing");
  error.code = "AUTOMATION_LEASE_LOST";
  return error;
}

function createLeaseGuard({ jobId, token }) {
  let stopped = false;
  let lostError = null;
  let renewalInFlight = null;

  const renew = async () => {
    if (stopped) return null;
    if (lostError) throw lostError;
    if (!renewalInFlight) {
      renewalInFlight = renewJobLease({ jobId, token })
        .then((job) => {
          if (!job) {
            lostError = leaseLostError();
            throw lostError;
          }
          return job;
        })
        .catch((error) => {
          lostError = error;
          throw error;
        })
        .finally(() => {
          renewalInFlight = null;
        });
    }
    return renewalInFlight;
  };

  const timer = setInterval(() => {
    renew().catch((error) => {
      console.error("[AUTOMATION] Lease heartbeat failed:", error.message);
    });
  }, Math.max(30_000, Math.floor(DEFAULT_LEASE_MS / 3)));
  timer.unref?.();

  return {
    assertOwned: renew,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

export async function runAutomationWorkerBatch({
  workerId,
  maxJobs = DEFAULT_BATCH_SIZE,
  shouldContinue = () => true,
}) {
  if (!workerId) throw new Error("Automation worker requires workerId");
  if (typeof shouldContinue !== "function") {
    throw new Error("Automation worker shouldContinue must be a function");
  }

  const limit = boundedBatchSize(maxJobs);
  const summary = {
    claimed: 0,
    succeeded: 0,
    deferred: 0,
    failed: 0,
    outcomes: {},
  };

  for (let index = 0; index < limit; index += 1) {
    if (!workerShouldContinue(shouldContinue)) break;

    const claim = await claimNextJob({
      workerId,
      kinds: [...JOB_HANDLERS.keys()],
    });
    if (!claim) break;

    summary.claimed += 1;
    const leaseGuard = createLeaseGuard({
      jobId: claim.job._id,
      token: claim.token,
    });
    try {
      const handler = JOB_HANDLERS.get(claim.job.kind);
      if (!handler) throw new Error(`No automation handler for ${claim.job.kind}`);
      await leaseGuard.assertOwned();
      const result = await handler(claim.job, {
        leaseToken: claim.token,
        assertLease: leaseGuard.assertOwned,
      });
      const outcome = String(result?.outcome || "UNKNOWN");

      if (result?.defer === true) {
        const reason = new Error(
          String(result.reason || "Automation prerequisite is temporarily unavailable")
        );
        reason.code = outcome;
        const deferred = await deferJob({
          jobId: claim.job._id,
          token: claim.token,
          reason,
          delayMs: result.retryAfterMs,
        });
        if (!deferred) {
          throw new Error("Automation job lease was lost before deferral");
        }
        summary.deferred += 1;
        summary.outcomes[outcome] = (summary.outcomes[outcome] || 0) + 1;
        continue;
      }

      await leaseGuard.assertOwned();
      const completed = await completeJob({
        jobId: claim.job._id,
        token: claim.token,
        resultSummary: result,
      });
      if (!completed) {
        throw new Error("Automation job lease was lost before completion");
      }
      summary.succeeded += 1;
      summary.outcomes[outcome] = (summary.outcomes[outcome] || 0) + 1;
    } catch (error) {
      if (error.defer === true) {
        const deferred = await deferJob({
          jobId: claim.job._id,
          token: claim.token,
          reason: error,
          delayMs: error.retryAfterMs,
        });
        if (deferred) {
          const outcome = String(error.code || "DEFERRED");
          summary.deferred += 1;
          summary.outcomes[outcome] = (summary.outcomes[outcome] || 0) + 1;
          continue;
        }
      }

      summary.failed += 1;
      const failed = await failJob({
        jobId: claim.job._id,
        token: claim.token,
        error,
      });
      if (!failed) {
        console.error(
          "[AUTOMATION] Failed to record job failure after lease loss:",
          String(claim.job._id)
        );
      }
      console.error(
        "[AUTOMATION] Job processing failed:",
        String(claim.job._id),
        error.message
      );
    } finally {
      leaseGuard.stop();
    }
  }

  return summary;
}

export { DEFAULT_BATCH_SIZE, JOB_HANDLERS, MAX_BATCH_SIZE };
