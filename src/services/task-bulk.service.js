import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import mongoose from "mongoose";
import Task from "../models/Task.js";
import TaskBulkOperation from "../models/TaskBulkOperation.js";
import User from "../models/User.js";
import { safeRecordActivity } from "./activity.service.js";

const MAX_ITEMS = 100;
const PREVIEW_TTL_MS = 15 * 60 * 1000;
const COMMIT_LEASE_MS = 5 * 60 * 1000;
const OPERATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function retentionDeadline(now = new Date()) {
  return new Date(now.getTime() + OPERATION_RETENTION_MS);
}
const TASK_STATUSES = new Set([
  "NOT_STARTED",
  "WAITING_DOCS",
  "IN_PROGRESS",
  "FILED",
  "CLOSED",
]);
const DOCUMENT_READINESS = new Set(["UNKNOWN", "PENDING", "PARTIAL", "READY"]);
const REVIEW_STATUSES = new Set([
  "NOT_REQUIRED",
  "PENDING",
  "APPROVED",
  "CHANGES_REQUESTED",
]);
const PATCH_FIELDS = Object.freeze([
  "status",
  "assignedTo",
  "dueDateISO",
  "documentReadiness",
  "reviewStatus",
]);

class TaskBulkError extends Error {
  constructor(message, status = 400, code = "TASK_BULK_INVALID", details = null) {
    super(message);
    this.name = "TaskBulkError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function validObjectId(value) {
  return /^[a-f\d]{24}$/i.test(String(value || ""));
}

function normalizePatch(rawPatch, index) {
  if (!rawPatch || typeof rawPatch !== "object" || Array.isArray(rawPatch)) {
    throw new TaskBulkError(`items[${index}].patch must be an object`);
  }
  const unknown = Object.keys(rawPatch).filter((key) => !PATCH_FIELDS.includes(key));
  if (unknown.length) {
    throw new TaskBulkError(
      `items[${index}].patch contains unsupported fields: ${unknown.join(", ")}`
    );
  }

  const patch = {};
  if (Object.prototype.hasOwnProperty.call(rawPatch, "status")) {
    const status = String(rawPatch.status || "").trim().toUpperCase();
    if (!TASK_STATUSES.has(status)) {
      throw new TaskBulkError(`items[${index}].patch.status is invalid`);
    }
    patch.status = status;
  }
  if (Object.prototype.hasOwnProperty.call(rawPatch, "assignedTo")) {
    if (rawPatch.assignedTo == null || rawPatch.assignedTo === "") {
      patch.assignedTo = null;
    } else if (validObjectId(rawPatch.assignedTo)) {
      patch.assignedTo = String(rawPatch.assignedTo).toLowerCase();
    } else {
      throw new TaskBulkError(`items[${index}].patch.assignedTo is invalid`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(rawPatch, "dueDateISO")) {
    const parsed = new Date(rawPatch.dueDateISO);
    const year = parsed.getUTCFullYear();
    if (Number.isNaN(parsed.getTime()) || year < 2000 || year > 2200) {
      throw new TaskBulkError(`items[${index}].patch.dueDateISO is invalid`);
    }
    patch.dueDateISO = parsed.toISOString();
  }
  if (Object.prototype.hasOwnProperty.call(rawPatch, "documentReadiness")) {
    const value = String(rawPatch.documentReadiness || "").trim().toUpperCase();
    if (!DOCUMENT_READINESS.has(value)) {
      throw new TaskBulkError(
        `items[${index}].patch.documentReadiness is invalid`
      );
    }
    patch.documentReadiness = value;
  }
  if (Object.prototype.hasOwnProperty.call(rawPatch, "reviewStatus")) {
    const value = String(rawPatch.reviewStatus || "").trim().toUpperCase();
    if (!REVIEW_STATUSES.has(value)) {
      throw new TaskBulkError(`items[${index}].patch.reviewStatus is invalid`);
    }
    patch.reviewStatus = value;
  }

  if (!Object.keys(patch).length) {
    throw new TaskBulkError(`items[${index}].patch must change at least one field`);
  }
  return patch;
}

function normalizeItems(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length < 1 || rawItems.length > MAX_ITEMS) {
    throw new TaskBulkError(`items must contain 1 to ${MAX_ITEMS} entries`);
  }
  const seen = new Set();
  return rawItems.map((rawItem, index) => {
    if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
      throw new TaskBulkError(`items[${index}] must be an object`);
    }
    const taskId = String(rawItem.taskId || rawItem.id || "").trim().toLowerCase();
    if (!validObjectId(taskId)) {
      throw new TaskBulkError(`items[${index}].taskId is invalid`);
    }
    if (seen.has(taskId)) {
      throw new TaskBulkError(`items[${index}].taskId is duplicated`);
    }
    seen.add(taskId);
    return { taskId, patch: normalizePatch(rawItem.patch, index) };
  });
}

function taskBefore(task) {
  return {
    status: task.status,
    assignedTo: task.assignedTo ? String(task.assignedTo) : null,
    dueDateISO: task.dueDateISO,
    documentReadiness: task.documentReadiness || "UNKNOWN",
    reviewStatus: task.reviewStatus || "NOT_REQUIRED",
    filedAt: task.filedAt || null,
    filedBy: task.filedBy ? String(task.filedBy) : null,
    completedAt: task.completedAt || null,
    completedBy: task.completedBy ? String(task.completedBy) : null,
    mutationVersion: Number(task.mutationVersion || 0),
  };
}

function publicItem(item) {
  return {
    itemKey: item.itemKey,
    taskId: String(item.taskId),
    patch: item.patch,
    status: item.status,
    code: item.code || "",
    message: item.message || "",
    appliedVersion: item.appliedVersion ?? null,
    result: item.result || null,
  };
}

function publicOperation(operation) {
  const items = (operation.items || []).map(publicItem);
  const summary = items.reduce(
    (acc, item) => {
      acc.total += 1;
      if (item.status === "SUCCEEDED") acc.succeeded += 1;
      else if (item.status === "FAILED") acc.failed += 1;
      else acc.pending += 1;
      return acc;
    },
    { total: 0, pending: 0, succeeded: 0, failed: 0 }
  );
  return {
    id: String(operation._id),
    contentHash: operation.contentHash,
    status: operation.status,
    expiresAt: operation.expiresAt,
    committedAt: operation.committedAt || null,
    summary,
    items,
  };
}

function hashMatches(rawValue, expectedHash) {
  const actual = Buffer.from(sha256(rawValue), "hex");
  const expected = Buffer.from(String(expectedHash || ""), "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function previewTaskBulk({
  firmId,
  actorUserId,
  rawItems,
  requestId = "",
  now = new Date(),
}) {
  const items = normalizeItems(rawItems);
  const contentHash = sha256(JSON.stringify(items));
  const [tasks, assignees] = await Promise.all([
    Task.find({ firmId, _id: { $in: items.map((item) => item.taskId) } })
      .select(
        "status assignedTo dueDateISO documentReadiness reviewStatus filedAt filedBy completedAt completedBy mutationVersion source isActive"
      )
      .lean(),
    User.find({
      firmId,
      isActive: true,
      _id: {
        $in: items
          .map((item) => item.patch.assignedTo)
          .filter((value) => value != null),
      },
    })
      .select("_id")
      .lean(),
  ]);
  const taskById = new Map(tasks.map((task) => [String(task._id), task]));
  const validAssignees = new Set(assignees.map((user) => String(user._id)));

  const operationItems = items.map((item, index) => {
    const task = taskById.get(item.taskId);
    const base = {
      itemKey: sha256(`${contentHash}:${index}:${item.taskId}`),
      taskId: new mongoose.Types.ObjectId(item.taskId),
      snapshotVersion: Number(task?.mutationVersion || 0),
      before: task ? taskBefore(task) : {},
      patch: item.patch,
      status: "PENDING",
      code: "",
      message: "",
    };
    if (!task || task.isActive !== true) {
      return {
        ...base,
        status: "FAILED",
        code: "TASK_NOT_FOUND",
        message: "Task not found in active firm scope",
      };
    }
    if (task.source === "CASE") {
      return {
        ...base,
        status: "FAILED",
        code: "CASE_PROJECTION_READ_ONLY",
        message: "Case-generated tasks are server-managed",
      };
    }
    if (
      item.patch.assignedTo &&
      !validAssignees.has(String(item.patch.assignedTo))
    ) {
      return {
        ...base,
        status: "FAILED",
        code: "ASSIGNEE_NOT_IN_FIRM",
        message: "Assigned user is not an active member of this firm",
      };
    }
    return base;
  });

  if (!operationItems.some((item) => item.status === "PENDING")) {
    return {
      committable: false,
      contentHash,
      items: operationItems.map(publicItem),
    };
  }

  const previewToken = randomBytes(32).toString("base64url");
  const operation = await TaskBulkOperation.create({
    firmId,
    createdBy: actorUserId,
    tokenHash: sha256(previewToken),
    contentHash,
    items: operationItems,
    requestId,
    expiresAt: new Date(now.getTime() + PREVIEW_TTL_MS),
    purgeAt: retentionDeadline(now),
  });

  return {
    committable: true,
    previewToken,
    operation: publicOperation(operation.toObject()),
  };
}

function mutationUpdate(item, actorUserId, operationId, now) {
  const patch = item.patch || {};
  const before = item.before || {};
  const set = {
    ...patch,
    "lastBulkMutation.operationId": operationId,
    "lastBulkMutation.itemKey": item.itemKey,
    "lastBulkMutation.appliedAt": now,
  };
  if (Object.prototype.hasOwnProperty.call(patch, "status")) {
    const wasComplete = ["FILED", "CLOSED"].includes(before.status);
    const becomesComplete = ["FILED", "CLOSED"].includes(patch.status);
    if (becomesComplete && (!wasComplete || !before.completedAt)) {
      set.completedAt = now;
      set.completedBy = actorUserId;
    } else if (!becomesComplete && wasComplete) {
      set.completedAt = null;
      set.completedBy = null;
    }

    if (patch.status === "FILED" && !before.filedAt) {
      set.filedAt = now;
      set.filedBy = actorUserId;
    } else if (!becomesComplete && before.filedAt) {
      set.filedAt = null;
      set.filedBy = null;
    }
  }
  return { $set: set, $inc: { mutationVersion: 1 } };
}

function taskResult(task) {
  return {
    id: String(task._id),
    status: task.status,
    assignedTo: task.assignedTo ? String(task.assignedTo) : null,
    dueDateISO: task.dueDateISO,
    documentReadiness: task.documentReadiness || "UNKNOWN",
    reviewStatus: task.reviewStatus || "NOT_REQUIRED",
    filedAt: task.filedAt || null,
    filedBy: task.filedBy ? String(task.filedBy) : null,
    mutationVersion: Number(task.mutationVersion || 0),
  };
}

async function applyItem({ operation, item, actorUserId, leaseToken, now }) {
  let outcome;
  if (item.patch?.assignedTo) {
    const activeAssignee = await User.exists({
      _id: item.patch.assignedTo,
      firmId: operation.firmId,
      isActive: true,
    });
    if (!activeAssignee) {
      const recovered = await Task.findOne({
        _id: item.taskId,
        firmId: operation.firmId,
        "lastBulkMutation.operationId": operation._id,
        "lastBulkMutation.itemKey": item.itemKey,
      })
        .select(
          "status assignedTo dueDateISO documentReadiness reviewStatus filedAt filedBy mutationVersion"
        )
        .lean();
      outcome = recovered
        ? {
            status: "SUCCEEDED",
            code: "ALREADY_APPLIED",
            message: "Task update recovered from prior commit attempt",
            appliedVersion: Number(recovered.mutationVersion || 0),
            result: taskResult(recovered),
          }
        : {
            status: "FAILED",
            code: "ASSIGNEE_NO_LONGER_ACTIVE",
            message: "Assigned user is no longer an active member of this firm",
            appliedVersion: null,
            result: null,
          };
    }
  }

  if (!outcome) {
    const versionFilter =
      item.snapshotVersion === 0
        ? { $or: [{ mutationVersion: 0 }, { mutationVersion: { $exists: false } }] }
        : { mutationVersion: item.snapshotVersion };
    const updated = await Task.findOneAndUpdate(
      {
        _id: item.taskId,
        firmId: operation.firmId,
        isActive: true,
        source: { $ne: "CASE" },
        ...versionFilter,
      },
      mutationUpdate(item, actorUserId, operation._id, now),
      { new: true, runValidators: true }
    ).lean();

    if (updated) {
      outcome = {
        status: "SUCCEEDED",
        code: "APPLIED",
        message: "Task updated",
        appliedVersion: Number(updated.mutationVersion || 0),
        result: taskResult(updated),
      };
    } else {
      const current = await Task.findOne({
        _id: item.taskId,
        firmId: operation.firmId,
      })
        .select(
          "status assignedTo dueDateISO documentReadiness reviewStatus filedAt filedBy mutationVersion source isActive lastBulkMutation"
        )
        .lean();
      const alreadyApplied =
        current &&
        String(current.lastBulkMutation?.operationId || "") === String(operation._id) &&
        current.lastBulkMutation?.itemKey === item.itemKey;
      if (alreadyApplied) {
        outcome = {
          status: "SUCCEEDED",
          code: "ALREADY_APPLIED",
          message: "Task update recovered from prior commit attempt",
          appliedVersion: Number(current.mutationVersion || 0),
          result: taskResult(current),
        };
      } else {
        const code = !current || current.isActive !== true
          ? "TASK_NOT_FOUND"
          : current.source === "CASE"
            ? "CASE_PROJECTION_READ_ONLY"
            : "STALE_TASK_VERSION";
        const message = code === "STALE_TASK_VERSION"
          ? "Task changed after preview; no update was applied"
          : code === "CASE_PROJECTION_READ_ONLY"
            ? "Case-generated tasks are server-managed"
            : "Task not found in active firm scope";
        outcome = {
          status: "FAILED",
          code,
          message,
          appliedVersion: null,
          result: current ? taskResult(current) : null,
        };
      }
    }
  }

  const leaseExpiresAt = new Date(now.getTime() + COMMIT_LEASE_MS);
  const persisted = await TaskBulkOperation.findOneAndUpdate(
    {
      _id: operation._id,
      status: "COMMITTING",
      "lease.token": leaseToken,
      "items.itemKey": item.itemKey,
      "items.status": "PENDING",
    },
    {
      $set: {
        "items.$.status": outcome.status,
        "items.$.code": outcome.code,
        "items.$.message": outcome.message,
        "items.$.appliedVersion": outcome.appliedVersion,
        "items.$.result": outcome.result,
        "lease.expiresAt": leaseExpiresAt,
        purgeAt: retentionDeadline(now),
      },
    },
    { new: true }
  );
  if (!persisted) {
    throw new TaskBulkError(
      "Bulk commit ownership was lost; retry with the same preview token",
      409,
      "TASK_BULK_LEASE_LOST"
    );
  }

  if (outcome.status === "SUCCEEDED") {
    await safeRecordActivity({
      firmId: operation.firmId,
      actorUserId,
      source: "USER",
      action: "TASK_BULK_UPDATED",
      entityType: "Task",
      entityId: item.taskId,
      beforeSummary: item.before,
      afterSummary: outcome.result,
      requestId: operation.requestId,
      batchId: String(operation._id),
      metadata: { itemKey: item.itemKey, resultCode: outcome.code },
    });
  }
}

export async function commitTaskBulk({
  operationId,
  firmId,
  actorUserId,
  previewToken,
  contentHash,
  now = new Date(),
}) {
  if (!validObjectId(operationId)) {
    throw new TaskBulkError("Bulk operation id is invalid");
  }
  if (!previewToken || !/^[a-f0-9]{64}$/.test(String(contentHash || ""))) {
    throw new TaskBulkError("previewToken and contentHash are required");
  }

  let operation = await TaskBulkOperation.findOne({
    _id: operationId,
    firmId,
    createdBy: actorUserId,
  }).lean();
  if (!operation) {
    throw new TaskBulkError("Bulk operation not found", 404, "TASK_BULK_NOT_FOUND");
  }
  if (
    operation.contentHash !== contentHash ||
    !hashMatches(previewToken, operation.tokenHash)
  ) {
    throw new TaskBulkError(
      "Bulk preview binding is invalid",
      409,
      "TASK_BULK_BINDING_MISMATCH"
    );
  }
  if (operation.status === "COMPLETED") return publicOperation(operation);
  const previewExpired =
    operation.status === "PREVIEWED" && new Date(operation.expiresAt) <= now;
  if (operation.status === "EXPIRED" || previewExpired) {
    await TaskBulkOperation.updateOne(
      { _id: operation._id, status: "PREVIEWED" },
      {
        $set: {
          status: "EXPIRED",
          purgeAt: retentionDeadline(now),
        },
        $unset: { lease: "" },
      }
    );
    throw new TaskBulkError(
      "Bulk preview expired; create a new preview",
      410,
      "TASK_BULK_EXPIRED"
    );
  }

  const leaseToken = randomUUID();
  operation = await TaskBulkOperation.findOneAndUpdate(
    {
      _id: operation._id,
      firmId,
      createdBy: actorUserId,
      tokenHash: operation.tokenHash,
      contentHash,
      $or: [
        { status: "PREVIEWED" },
        { status: "COMMITTING", "lease.expiresAt": { $lte: now } },
      ],
    },
    {
      $set: {
        status: "COMMITTING",
        "lease.token": leaseToken,
        "lease.acquiredAt": now,
        "lease.expiresAt": new Date(now.getTime() + COMMIT_LEASE_MS),
        purgeAt: retentionDeadline(now),
      },
    },
    { new: true }
  ).lean();

  if (!operation) {
    const current = await TaskBulkOperation.findById(operationId).lean();
    if (current?.status === "COMPLETED") return publicOperation(current);
    throw new TaskBulkError(
      "Bulk commit is already in progress; retry with the same preview token",
      409,
      "TASK_BULK_COMMIT_IN_PROGRESS"
    );
  }

  for (const item of operation.items) {
    if (item.status !== "PENDING") continue;
    await applyItem({ operation, item, actorUserId, leaseToken, now: new Date() });
  }

  const committedAt = new Date();
  const completed = await TaskBulkOperation.findOneAndUpdate(
    {
      _id: operation._id,
      status: "COMMITTING",
      "lease.token": leaseToken,
      "items.status": { $ne: "PENDING" },
    },
    {
      $set: {
        status: "COMPLETED",
        committedAt,
        purgeAt: retentionDeadline(committedAt),
      },
      $unset: { lease: "" },
    },
    { new: true }
  ).lean();
  if (!completed) {
    throw new TaskBulkError(
      "Bulk commit could not be finalized; retry with the same preview token",
      409,
      "TASK_BULK_FINALIZE_RETRY"
    );
  }
  return publicOperation(completed);
}

export async function getTaskBulkOperation({ operationId, firmId, actorUserId }) {
  if (!validObjectId(operationId)) {
    throw new TaskBulkError("Bulk operation id is invalid");
  }
  const operation = await TaskBulkOperation.findOne({
    _id: operationId,
    firmId,
    createdBy: actorUserId,
  }).lean();
  if (!operation) {
    throw new TaskBulkError("Bulk operation not found", 404, "TASK_BULK_NOT_FOUND");
  }
  return publicOperation(operation);
}

export {
  COMMIT_LEASE_MS,
  MAX_ITEMS,
  PATCH_FIELDS,
  PREVIEW_TTL_MS,
  TaskBulkError,
};
