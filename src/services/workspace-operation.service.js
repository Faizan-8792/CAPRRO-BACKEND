import crypto from "crypto";
import User from "../models/User.js";
import WorkspaceOperation from "../models/WorkspaceOperation.js";

const OPERATION_ID_PATTERN = /^[a-f0-9]{32}$/;
const KINDS = new Set(["CREATE", "SWITCH", "JOIN"]);
const SUCCESS_RECEIPT_LIMIT = 20;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function serviceError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value instanceof Date ? value.toISOString() : value);
}

function requestHash(kind, payload) {
  return crypto
    .createHash("sha256")
    .update(stableJson({ kind, payload }), "utf8")
    .digest("hex");
}

// Every field operationReceipt() and assertSameRequest() read. Projecting the
// User-only receipts field onto this collection returned bare _id documents,
// which surfaced as "undefined" operation IDs and false reuse conflicts.
const OPERATION_FIELDS =
  "userId operationId kind requestHash status activeFirmId failure startedAt completedAt createdAt";

// Workspace selection must never rewrite account authority. These fields are
// changed only by their own authenticated flows.
const PROTECTED_USER_FIELDS = new Set([
  "_id",
  "email",
  "isActive",
  "tokenVersion",
  "workspaceOperationReceipts",
]);

async function leanQuery(query, projection) {
  if (query && projection && typeof query.select === "function") {
    query = query.select(projection);
  }
  if (query && typeof query.lean === "function") {
    return query.lean();
  }
  return query;
}

function assertSafeUserChanges(userChanges) {
  for (const field of Object.keys(userChanges || {})) {
    if (PROTECTED_USER_FIELDS.has(field)) {
      throw new TypeError(
        `A workspace operation must not change the protected user field: ${field}`,
      );
    }
  }
}

function normalizeOperationId(value) {
  if (typeof value !== "string" || !OPERATION_ID_PATTERN.test(value)) {
    throw serviceError(
      400,
      "operationId must be a 32-character lowercase GUID",
      "INVALID_WORKSPACE_OPERATION_ID",
    );
  }
  return value;
}

function boundedFailureStatus(value) {
  return Number.isInteger(value) && value >= 400 && value <= 599 ? value : 500;
}

function boundedFailureMessage(value) {
  const message = String(value || "Workspace operation was rejected").trim();
  return (message || "Workspace operation was rejected").slice(0, 300);
}

function operationReceipt(source) {
  const status = String(source.status || "PENDING");
  const failure = source.failure || null;
  return {
    operationId: String(source.operationId),
    kind: String(source.kind),
    status,
    activeFirmId: source.activeFirmId ? String(source.activeFirmId) : null,
    startedAt: source.startedAt || source.createdAt || null,
    completedAt: source.completedAt || null,
    ...(status === "REJECTED" && failure
      ? {
          error: {
            httpStatus: Number(failure.httpStatus),
            message: String(failure.message),
          },
        }
      : {}),
  };
}

function assertSameRequest(source, kind, hash) {
  if (source.kind !== kind || source.requestHash !== hash) {
    throw serviceError(
      409,
      "operationId was already used for a different workspace request",
      "WORKSPACE_OPERATION_REUSED",
    );
  }
}

export function createWorkspaceOperationService({
  OperationModel = WorkspaceOperation,
  UserModel = User,
  now = () => new Date(),
} = {}) {
  async function findSuccessReceipt(userId, operationId) {
    const user = await leanQuery(
      UserModel.findById(userId),
      "workspaceOperationReceipts",
    );
    return (
      user?.workspaceOperationReceipts?.find(
        (item) => String(item.operationId) === operationId,
      ) || null
    );
  }

  function findOperation(userId, operationId) {
    return leanQuery(
      OperationModel.findOne({ userId, operationId }),
      OPERATION_FIELDS,
    );
  }

  async function statusFor(userId, operationIdValue) {
    const operationId = normalizeOperationId(operationIdValue);
    const success = await findSuccessReceipt(userId, operationId);
    if (success) {
      return operationReceipt({ ...success, status: "SUCCEEDED" });
    }

    const operation = await findOperation(userId, operationId);
    if (!operation) {
      throw serviceError(
        404,
        "Workspace operation was not found",
        "WORKSPACE_OPERATION_NOT_FOUND",
      );
    }
    return operationReceipt(operation);
  }

  async function claim({
    userId,
    operationId: operationIdValue,
    kind,
    payload,
  }) {
    if (operationIdValue === undefined || operationIdValue === null) {
      return { tracked: false, isNew: false, operation: null, receipt: null };
    }

    const operationId = normalizeOperationId(operationIdValue);
    if (!KINDS.has(kind)) {
      throw new TypeError(`Unsupported workspace operation kind: ${kind}`);
    }
    const hash = requestHash(kind, payload);

    const success = await findSuccessReceipt(userId, operationId);
    if (success) {
      assertSameRequest(success, kind, hash);
      return {
        tracked: true,
        isNew: false,
        operation: null,
        receipt: operationReceipt({ ...success, status: "SUCCEEDED" }),
      };
    }

    const startedAt = now();
    try {
      const operation = await OperationModel.create({
        userId,
        operationId,
        kind,
        requestHash: hash,
        status: "PENDING",
        expiresAt: new Date(startedAt.getTime() + RETENTION_MS),
      });
      return {
        tracked: true,
        isNew: true,
        operation,
        receipt: operationReceipt(operation),
      };
    } catch (error) {
      if (error?.code !== 11000) {
        throw error;
      }
    }

    const existing = await findOperation(userId, operationId);
    if (!existing) {
      throw serviceError(
        409,
        "Workspace operation could not be claimed",
        "WORKSPACE_OPERATION_CLAIM_CONFLICT",
      );
    }
    assertSameRequest(existing, kind, hash);
    return {
      tracked: true,
      isNew: false,
      operation: existing,
      receipt: operationReceipt(existing),
    };
  }

  async function succeed(
    claimResult,
    { userId, activeFirmId, userChanges, expectedTokenVersion },
  ) {
    if (
      !claimResult?.tracked ||
      !claimResult?.isNew ||
      !claimResult.operation
    ) {
      throw new TypeError("A newly claimed workspace operation is required");
    }
    assertSafeUserChanges(userChanges);

    const completedAt = now();
    const receipt = {
      operationId: claimResult.operation.operationId,
      kind: claimResult.operation.kind,
      requestHash: claimResult.operation.requestHash,
      activeFirmId,
      startedAt: claimResult.operation.createdAt || completedAt,
      completedAt,
    };
    // A request admitted before a suspension or force-logout must not commit
    // afterwards, so the commit is conditional on the authority it was
    // authorized under rather than on the user id alone.
    const filter = { _id: userId, isActive: { $ne: false } };
    if (Number.isInteger(expectedTokenVersion)) {
      // A document written before tokenVersion existed has no such field, and
      // { tokenVersion: 0 } would not match it. null matches a missing field.
      filter.tokenVersion =
        expectedTokenVersion === 0 ? { $in: [0, null] } : expectedTokenVersion;
    }
    const user = await UserModel.findOneAndUpdate(
      filter,
      {
        $set: { ...userChanges, firmId: activeFirmId },
        $push: {
          workspaceOperationReceipts: {
            $each: [receipt],
            $slice: -SUCCESS_RECEIPT_LIMIT,
          },
        },
      },
      { new: true, runValidators: true },
    );
    if (!user) {
      const current = await leanQuery(
        UserModel.findById(userId),
        "isActive tokenVersion",
      );
      if (!current) {
        throw serviceError(
          404,
          "User not found",
          "WORKSPACE_OPERATION_USER_NOT_FOUND",
        );
      }

      // Say what the server actually did. Telling a suspended user to sign in
      // again would be wrong: signing in will not restore their access.
      throw serviceError(
        409,
        current.isActive === false
          ? "This account is no longer active, so the workspace change was not applied. Contact your firm administrator."
          : "This session was signed out on the server, so the workspace change was not applied. Sign in again, then retry.",
        "WORKSPACE_OPERATION_AUTHORITY_CHANGED",
      );
    }

    try {
      await OperationModel.updateOne(
        { _id: claimResult.operation._id, status: "PENDING" },
        {
          $set: {
            status: "SUCCEEDED",
            activeFirmId,
            completedAt,
            failure: null,
          },
        },
      );
    } catch {
      // User receipt and active firm were committed in one document update. The
      // status endpoint checks that receipt first, so this secondary write is
      // not part of the safety decision.
    }

    return {
      user,
      receipt: operationReceipt({ ...receipt, status: "SUCCEEDED" }),
    };
  }

  // Undoes a committed workspace change whose authority was lost immediately
  // afterwards. The success receipt is removed and the operation becomes
  // terminally REJECTED, so a client waiting on the exact receipt is released
  // instead of blocking on a firm it no longer holds.
  async function rollback(claimResult, { userId, httpStatus, message }) {
    if (
      !claimResult?.tracked ||
      !claimResult?.isNew ||
      !claimResult.operation
    ) {
      return null;
    }

    const operationId = claimResult.operation.operationId;
    await UserModel.updateOne(
      { _id: userId },
      { $pull: { workspaceOperationReceipts: { operationId } } },
    );
    await OperationModel.updateOne(
      { _id: claimResult.operation._id },
      {
        $set: {
          status: "REJECTED",
          activeFirmId: null,
          completedAt: now(),
          failure: {
            httpStatus: boundedFailureStatus(httpStatus),
            message: boundedFailureMessage(message),
          },
        },
      },
    );

    return statusFor(String(userId), operationId);
  }

  async function reject(claimResult, httpStatus, message) {
    if (
      !claimResult?.tracked ||
      !claimResult?.isNew ||
      !claimResult.operation
    ) {
      return claimResult?.receipt || null;
    }

    const completedAt = now();
    const failure = {
      httpStatus: boundedFailureStatus(httpStatus),
      message: boundedFailureMessage(message),
    };
    await OperationModel.updateOne(
      { _id: claimResult.operation._id, status: "PENDING" },
      { $set: { status: "REJECTED", failure, completedAt } },
    );

    return statusFor(
      String(claimResult.operation.userId),
      claimResult.operation.operationId,
    );
  }

  return {
    claim,
    reject,
    rollback,
    statusFor,
    succeed,
  };
}

const workspaceOperationService = createWorkspaceOperationService();
export default workspaceOperationService;
