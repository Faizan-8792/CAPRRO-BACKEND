import { randomUUID } from "node:crypto";
import AutomationJob from "../models/AutomationJob.js";

const DEFAULT_LEASE_MS = 10 * 60 * 1000;
const DEFAULT_DEFER_MS = 5 * 60 * 1000;
const RETRY_DELAYS_MS = Object.freeze([
  60 * 1000,
  5 * 60 * 1000,
  30 * 60 * 1000,
  2 * 60 * 60 * 1000,
  12 * 60 * 60 * 1000,
]);

function retryDelay(attemptCount) {
  const index = Math.min(
    Math.max(Number(attemptCount || 1) - 1, 0),
    RETRY_DELAYS_MS.length - 1
  );
  return RETRY_DELAYS_MS[index];
}

function safeJobError(error) {
  const code = String(error?.code || error?.name || "JOB_FAILED").slice(0, 80);
  const message = String(error?.message || "Automation job failed")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 500);
  return `${code}: ${message}`;
}

function boundedDelayMs(value) {
  const parsed = Number(value ?? DEFAULT_DEFER_MS);
  if (!Number.isFinite(parsed)) return DEFAULT_DEFER_MS;
  return Math.min(Math.max(Math.round(parsed), 30_000), 24 * 60 * 60 * 1000);
}

export async function enqueueJob({
  firmId,
  kind,
  idempotencyKey,
  payload = {},
  createdBy,
  requestId = "",
  maxAttempts = 5,
}) {
  if (!firmId || !kind || !idempotencyKey || !createdBy) {
    throw new Error("Job requires firmId, kind, idempotencyKey, and createdBy");
  }

  return AutomationJob.findOneAndUpdate(
    { firmId, kind: String(kind).toUpperCase(), idempotencyKey },
    {
      $setOnInsert: {
        firmId,
        kind: String(kind).toUpperCase(),
        idempotencyKey,
        payload,
        createdBy,
        requestId,
        maxAttempts,
        status: "PENDING",
        nextAttemptAt: new Date(),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

async function terminalizeExhaustedJobs({
  kinds = [],
  firmId = null,
  now = new Date(),
}) {
  const scope = {
    ...(firmId ? { firmId } : {}),
    ...(kinds.length
      ? { kind: { $in: kinds.map((kind) => String(kind).toUpperCase()) } }
      : {}),
  };

  await AutomationJob.updateMany(
    {
      ...scope,
      $expr: { $gte: ["$attemptCount", "$maxAttempts"] },
      $or: [
        {
          status: { $in: ["PENDING", "RETRY_SCHEDULED"] },
          nextAttemptAt: { $lte: now },
        },
        {
          status: "PROCESSING",
          "lease.expiresAt": { $lte: now },
        },
      ],
    },
    {
      $set: {
        status: "FAILED",
        completedAt: now,
        lastError:
          "JOB_LEASE_EXHAUSTED: Maximum attempts reached before a worker completed the job",
      },
      $unset: { lease: "", nextAttemptAt: "" },
    }
  );
}

export async function claimNextJob({
  workerId,
  kinds = [],
  firmId = null,
  now = new Date(),
  leaseMs = DEFAULT_LEASE_MS,
}) {
  if (!workerId) throw new Error("workerId is required");

  await terminalizeExhaustedJobs({ kinds, firmId, now });

  const token = randomUUID();
  const filter = {
    ...(firmId ? { firmId } : {}),
    ...(kinds.length
      ? { kind: { $in: kinds.map((kind) => String(kind).toUpperCase()) } }
      : {}),
    $expr: { $lt: ["$attemptCount", "$maxAttempts"] },
    $or: [
      {
        status: { $in: ["PENDING", "RETRY_SCHEDULED"] },
        nextAttemptAt: { $lte: now },
      },
      {
        status: "PROCESSING",
        "lease.expiresAt": { $lte: now },
      },
    ],
  };

  const job = await AutomationJob.findOneAndUpdate(
    filter,
    {
      $set: {
        status: "PROCESSING",
        "lease.token": token,
        "lease.owner": String(workerId).slice(0, 160),
        "lease.acquiredAt": now,
        "lease.expiresAt": new Date(now.getTime() + leaseMs),
        lastError: "",
      },
      $inc: { attemptCount: 1 },
    },
    { new: true, sort: { nextAttemptAt: 1, createdAt: 1 } }
  );

  return job ? { job, token } : null;
}

export async function renewJobLease({
  jobId,
  token,
  now = new Date(),
  leaseMs = DEFAULT_LEASE_MS,
  session = null,
}) {
  return AutomationJob.findOneAndUpdate(
    {
      _id: jobId,
      status: "PROCESSING",
      "lease.token": token,
      "lease.expiresAt": { $gt: now },
    },
    {
      $set: {
        "lease.expiresAt": new Date(now.getTime() + leaseMs),
      },
    },
    { new: true, session }
  );
}

export async function completeJob({
  jobId,
  token,
  resultSummary = {},
  now = new Date(),
}) {
  return AutomationJob.findOneAndUpdate(
    {
      _id: jobId,
      status: "PROCESSING",
      "lease.token": token,
      "lease.expiresAt": { $gt: now },
    },
    {
      $set: {
        status: "SUCCEEDED",
        resultSummary,
        completedAt: now,
      },
      $unset: { lease: "", nextAttemptAt: "", lastError: "" },
    },
    { new: true }
  );
}

export async function deferJob({
  jobId,
  token,
  reason,
  delayMs = DEFAULT_DEFER_MS,
  now = new Date(),
}) {
  return AutomationJob.findOneAndUpdate(
    {
      _id: jobId,
      status: "PROCESSING",
      "lease.token": token,
      "lease.expiresAt": { $gt: now },
      attemptCount: { $gte: 1 },
    },
    {
      $set: {
        status: "RETRY_SCHEDULED",
        nextAttemptAt: new Date(now.getTime() + boundedDelayMs(delayMs)),
        lastError: safeJobError(reason),
        completedAt: null,
      },
      $inc: { attemptCount: -1 },
      $unset: { lease: "", resultSummary: "" },
    },
    { new: true }
  );
}

export async function failJob({ jobId, token, error, now = new Date() }) {
  const leaseFilter = {
    _id: jobId,
    status: "PROCESSING",
    "lease.token": token,
    "lease.expiresAt": { $gt: now },
  };
  const claimed = await AutomationJob.findOne(leaseFilter).lean();
  if (!claimed) return null;

  const exhausted = claimed.attemptCount >= claimed.maxAttempts;
  return AutomationJob.findOneAndUpdate(
    leaseFilter,
    {
      $set: {
        status: exhausted ? "FAILED" : "RETRY_SCHEDULED",
        completedAt: exhausted ? now : null,
        lastError: safeJobError(error),
        nextAttemptAt: exhausted
          ? now
          : new Date(now.getTime() + retryDelay(claimed.attemptCount)),
      },
      $unset: { lease: "" },
    },
    { new: true }
  );
}

export async function retryFailedJob({ jobId, firmId, now = new Date() }) {
  if (!jobId || !firmId) {
    throw new Error("Manual retry requires jobId and firmId");
  }

  const failed = await AutomationJob.findOne({
    _id: jobId,
    firmId,
    status: "FAILED",
  }).lean();
  if (!failed) return null;
  const maxAttempts = Math.min(
    100000,
    Math.max(Number(failed.maxAttempts || 1), Number(failed.attemptCount || 0) + 5)
  );
  return AutomationJob.findOneAndUpdate(
    {
      _id: jobId,
      firmId,
      status: "FAILED",
      attemptCount: failed.attemptCount,
    },
    {
      $set: {
        status: "PENDING",
        maxAttempts,
        nextAttemptAt: now,
        lastError: "",
        completedAt: null,
        resultSummary: null,
      },
      $unset: { lease: "" },
    },
    { new: true, runValidators: true }
  );
}

export {
  DEFAULT_DEFER_MS,
  DEFAULT_LEASE_MS,
  RETRY_DELAYS_MS,
  safeJobError,
  terminalizeExhaustedJobs,
};
