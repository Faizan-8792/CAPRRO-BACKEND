import { createHash, randomUUID } from "node:crypto";
import CaseProviderOperation, {
  PROVIDER_OPERATION_ACTIONS,
} from "../models/CaseProviderOperation.js";
import {
  assertMutationRequestHash,
  httpError,
} from "./case-validation.service.js";

const PROVIDER_OPERATION_LEASE_MS = 10 * 60 * 1000;
const PROVIDER_RESULT_MAX_BYTES = 550000;
const PROVIDER_ACTION_SET = new Set(PROVIDER_OPERATION_ACTIONS);

function serializeProviderResult(result) {
  const serialized = JSON.stringify(result);
  if (typeof serialized !== "string") {
    throw httpError(
      500,
      "Provider result is not serializable",
      "CASE_PROVIDER_RESULT_INVALID"
    );
  }
  if (Buffer.byteLength(serialized, "utf8") > PROVIDER_RESULT_MAX_BYTES) {
    throw httpError(
      413,
      "Provider result exceeds the durable staging limit",
      "CASE_PROVIDER_RESULT_TOO_LARGE"
    );
  }
  return {
    serialized,
    hash: createHash("sha256").update(serialized, "utf8").digest("hex"),
  };
}

function readCaseProviderOperationResult(operation) {
  if (!operation?.stagedResult) return null;
  const serialized = operation.stagedResult;
  const hash = createHash("sha256").update(serialized, "utf8").digest("hex");
  if (
    Buffer.byteLength(serialized, "utf8") > PROVIDER_RESULT_MAX_BYTES ||
    hash !== operation.stagedResultHash
  ) {
    throw httpError(
      409,
      "Staged provider result failed its integrity check",
      "CASE_PROVIDER_RESULT_CORRUPT"
    );
  }
  try {
    return JSON.parse(serialized);
  } catch {
    throw httpError(
      409,
      "Staged provider result is not valid JSON",
      "CASE_PROVIDER_RESULT_CORRUPT"
    );
  }
}

function validateOperation(operation, { action, requestHash }) {
  if (!operation) return;
  if (operation.action !== action) {
    throw httpError(
      409,
      "mutationKey was already used for another provider operation",
      "MUTATION_KEY_REUSED"
    );
  }
  assertMutationRequestHash(operation.requestHash, requestHash);
}

function operationInProgress() {
  const error = httpError(
    409,
    "An identical provider operation is already in progress; retry with the same mutationKey",
    "CASE_PROVIDER_OPERATION_IN_PROGRESS"
  );
  error.retryAfterSeconds = 5;
  return error;
}

async function reserveCaseProviderOperation({
  firmId,
  caseId,
  action,
  mutationKey,
  requestHash,
}) {
  if (!PROVIDER_ACTION_SET.has(action)) {
    throw new Error(`Unsupported Case provider operation: ${action}`);
  }

  const now = new Date();
  const leaseToken = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + PROVIDER_OPERATION_LEASE_MS);
  let operation = await CaseProviderOperation.findOne({
    firmId,
    caseId,
    mutationKey,
  });

  if (!operation) {
    try {
      operation = await CaseProviderOperation.create({
        firmId,
        caseId,
        action,
        mutationKey,
        requestHash,
        status: "PROCESSING",
        leaseToken,
        leaseExpiresAt,
        attemptCount: 1,
      });
      return { operation, completed: false };
    } catch (error) {
      if (error?.code !== 11000) throw error;
      operation = await CaseProviderOperation.findOne({
        firmId,
        caseId,
        mutationKey,
      });
      if (!operation) throw error;
    }
  }

  validateOperation(operation, { action, requestHash });
  if (operation.status === "COMPLETED") {
    return { operation, completed: true };
  }

  const leaseExpired =
    !operation.leaseExpiresAt || new Date(operation.leaseExpiresAt) <= now;
  if (operation.status === "PROCESSING" && !leaseExpired) {
    throw operationInProgress();
  }

  const claimed = await CaseProviderOperation.findOneAndUpdate(
    {
      _id: operation._id,
      action,
      requestHash,
      $or: [
        { status: "FAILED" },
        { status: "PROCESSING", leaseExpiresAt: { $lte: now } },
        { status: "PROCESSING", leaseExpiresAt: null },
      ],
    },
    {
      $set: {
        status: "PROCESSING",
        leaseToken,
        leaseExpiresAt,
        failedAt: null,
        failureCode: "",
      },
      $inc: { attemptCount: 1 },
    },
    { new: true, runValidators: true }
  );
  if (claimed) return { operation: claimed, completed: false };

  const current = await CaseProviderOperation.findById(operation._id);
  validateOperation(current, { action, requestHash });
  if (current?.status === "COMPLETED") {
    return { operation: current, completed: true };
  }
  throw operationInProgress();
}

async function stageCaseProviderOperationResult(operation, result) {
  const { serialized, hash } = serializeProviderResult(result);
  const staged = await CaseProviderOperation.findOneAndUpdate(
    {
      _id: operation._id,
      status: "PROCESSING",
      leaseToken: operation.leaseToken,
    },
    {
      $set: {
        stagedResult: serialized,
        stagedResultHash: hash,
        stagedAt: new Date(),
      },
    },
    { new: true, runValidators: true }
  );
  if (staged) return staged;

  const current = await CaseProviderOperation.findById(operation._id);
  if (
    current?.status === "PROCESSING" &&
    current.leaseToken === operation.leaseToken &&
    current.stagedResult === serialized &&
    current.stagedResultHash === hash
  ) {
    return current;
  }
  throw httpError(
    409,
    "Provider operation lease changed before result staging; retry the original mutation",
    "CASE_PROVIDER_OPERATION_LEASE_LOST"
  );
}

async function completeCaseProviderOperation(operation, resultId) {
  const completed = await CaseProviderOperation.findOneAndUpdate(
    {
      _id: operation._id,
      status: "PROCESSING",
      leaseToken: operation.leaseToken,
    },
    {
      $set: {
        status: "COMPLETED",
        resultId,
        completedAt: new Date(),
        leaseToken: "",
        leaseExpiresAt: null,
        failedAt: null,
        failureCode: "",
        stagedResult: "",
        stagedResultHash: null,
        stagedAt: null,
      },
    },
    { new: true, runValidators: true }
  );
  if (completed) return completed;

  const current = await CaseProviderOperation.findById(operation._id);
  if (
    current?.status === "COMPLETED" &&
    String(current.resultId || "") === String(resultId || "")
  ) {
    return current;
  }
  throw httpError(
    409,
    "Provider operation lease changed before completion; retry the original mutation",
    "CASE_PROVIDER_OPERATION_LEASE_LOST"
  );
}

async function failCaseProviderOperation(operation, error) {
  if (!operation?._id || !operation.leaseToken) return;
  await CaseProviderOperation.updateOne(
    {
      _id: operation._id,
      status: "PROCESSING",
      leaseToken: operation.leaseToken,
    },
    {
      $set: {
        status: "FAILED",
        failedAt: new Date(),
        failureCode: String(error?.code || "CASE_PROVIDER_OPERATION_FAILED").slice(0, 80),
        leaseToken: "",
        leaseExpiresAt: null,
      },
    }
  );
}

export {
  completeCaseProviderOperation,
  failCaseProviderOperation,
  readCaseProviderOperationResult,
  reserveCaseProviderOperation,
  stageCaseProviderOperationResult,
};
