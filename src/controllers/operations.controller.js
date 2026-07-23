import mongoose from "mongoose";
import ActivityEvent, { ACTIVITY_SOURCES } from "../models/ActivityEvent.js";
import AutomationJob, { JOB_STATUSES } from "../models/AutomationJob.js";
import AppConfig from "../models/AppConfig.js";
import { retryFailedJob } from "../services/automation-job.service.js";
import { safeRecordActivity } from "../services/activity.service.js";

const MAX_PAGE_SIZE = 100;
const COMPLIANCE_PROFILE_ACTIVITY_PATTERN =
  /^(CLIENT_COMPLIANCE_PROFILE_|COMPLIANCE_)/;

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function parsePageSize(value) {
  const parsed = Number(value ?? 50);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw httpError(400, "limit must be a positive integer");
  }
  return Math.min(parsed, MAX_PAGE_SIZE);
}

function applyCursor(filter, cursor) {
  if (!cursor) return;
  if (!mongoose.Types.ObjectId.isValid(String(cursor))) {
    throw httpError(400, "Invalid cursor");
  }
  filter._id = { $lt: cursor };
}

function jobView(job) {
  return {
    id: job._id,
    kind: job.kind,
    status: job.status,
    idempotencyKey: job.idempotencyKey,
    attemptCount: job.attemptCount,
    maxAttempts: job.maxAttempts,
    nextAttemptAt: job.nextAttemptAt || null,
    lease: job.lease
      ? {
          owner: job.lease.owner || null,
          acquiredAt: job.lease.acquiredAt || null,
          expiresAt: job.lease.expiresAt || null,
        }
      : null,
    lastError: job.lastError || "",
    requestId: job.requestId || "",
    resultSummary: job.resultSummary || null,
    createdBy: job.createdBy,
    completedAt: job.completedAt || null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function forwardKnownError(error, next) {
  if (!error.statusCode && error.name === "CastError") error.statusCode = 400;
  return next(error);
}

export async function listActivityEvents(req, res, next) {
  try {
    const limit = parsePageSize(req.query.limit);
    const featureFlags = await AppConfig.getFeatureFlags();
    const filter = { firmId: req.user.firmId };
    if (featureFlags.clientComplianceProfile !== true) {
      filter.action = { $not: COMPLIANCE_PROFILE_ACTIVITY_PATTERN };
    }
    applyCursor(filter, req.query.cursor);

    if (req.query.source) {
      const source = String(req.query.source).toUpperCase();
      if (!ACTIVITY_SOURCES.includes(source)) {
        throw httpError(400, "Invalid activity source");
      }
      filter.source = source;
    }
    if (req.query.entityType) {
      filter.entityType = String(req.query.entityType).trim().slice(0, 100);
    }
    if (req.query.entityId) {
      filter.entityId = String(req.query.entityId).trim().slice(0, 160);
    }
    if (req.query.actorUserId) {
      if (!mongoose.Types.ObjectId.isValid(String(req.query.actorUserId))) {
        throw httpError(400, "Invalid actorUserId");
      }
      filter.actorUserId = req.query.actorUserId;
    }

    const events = await ActivityEvent.find(filter)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .populate("actorUserId", "name email")
      .lean();

    const hasMore = events.length > limit;
    if (hasMore) events.pop();

    return res.json({
      ok: true,
      events,
      pagination: {
        limit,
        hasMore,
        nextCursor: hasMore ? String(events.at(-1)._id) : null,
      },
      requestId: req.id || "",
    });
  } catch (error) {
    return forwardKnownError(error, next);
  }
}

export async function listAutomationJobs(req, res, next) {
  try {
    const limit = parsePageSize(req.query.limit);
    const filter = { firmId: req.user.firmId };
    applyCursor(filter, req.query.cursor);

    if (req.query.status) {
      const status = String(req.query.status).toUpperCase();
      if (!JOB_STATUSES.includes(status)) {
        throw httpError(400, "Invalid job status");
      }
      filter.status = status;
    }
    if (req.query.kind) {
      filter.kind = String(req.query.kind).trim().toUpperCase().slice(0, 100);
    }

    const jobs = await AutomationJob.find(filter)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .select("-payload")
      .lean();

    const hasMore = jobs.length > limit;
    if (hasMore) jobs.pop();

    return res.json({
      ok: true,
      jobs: jobs.map(jobView),
      pagination: {
        limit,
        hasMore,
        nextCursor: hasMore ? String(jobs.at(-1)._id) : null,
      },
      requestId: req.id || "",
    });
  } catch (error) {
    return forwardKnownError(error, next);
  }
}

export async function retryAutomationJob(req, res, next) {
  try {
    const { jobId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(String(jobId))) {
      throw httpError(400, "Invalid job id");
    }

    const before = await AutomationJob.findOne({
      _id: jobId,
      firmId: req.user.firmId,
    }).lean();
    if (!before) throw httpError(404, "Automation job not found");
    if (before.status !== "FAILED") {
      throw httpError(409, "Only failed jobs can be retried manually");
    }

    const job = await retryFailedJob({
      jobId,
      firmId: req.user.firmId,
    });
    if (!job) {
      throw httpError(409, "Job state changed; refresh before retrying");
    }

    await safeRecordActivity({
      firmId: req.user.firmId,
      actorUserId: req.user.id,
      source: "USER",
      action: "AUTOMATION_JOB_RETRIED",
      entityType: "AutomationJob",
      entityId: job._id,
      beforeSummary: {
        status: before.status,
        attemptCount: before.attemptCount,
        lastError: before.lastError,
      },
      afterSummary: {
        status: job.status,
        attemptCount: job.attemptCount,
        nextAttemptAt: job.nextAttemptAt,
      },
      requestId: req.id,
    });

    return res.json({
      ok: true,
      job: jobView(job.toObject()),
      requestId: req.id || "",
    });
  } catch (error) {
    return forwardKnownError(error, next);
  }
}
