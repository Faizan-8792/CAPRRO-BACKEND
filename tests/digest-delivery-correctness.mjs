// tests/digest-delivery-correctness.mjs
//
// Deterministic correctness checks for digest delivery identity, atomic claims,
// current authorization, provider failure recovery, and startup index readiness.
// Pure logic only - no database, network, server import, or live provider.
//
// Run: node tests/digest-delivery-correctness.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import mongoose from "mongoose";
import DigestDelivery, {
  DIGEST_RECOVERY_CURSOR_ID,
  DigestRecoveryCursor,
} from "../src/models/DigestDelivery.js";
import {
  DAILY_KIND,
  DIGEST_AUTHORITY_DEFER_MS,
  DIGEST_JOB_RECOVERY_LEASE_MS,
  DIGEST_RECOVERY_BATCH_SIZE,
  DIGEST_RECOVERY_CURSOR_LEASE_MS,
  DIGEST_RECOVERY_MAX_BATCHES,
  SEND_CLAIM_STALE_MS,
  WEEKLY_KIND,
  buildDigestSummary,
  claimDigestDelivery,
  digestBusinessIdentity,
  digestSendingRecoveryReason,
  drainDigestRecovery,
  enqueueDueDigests,
  enqueueRecipientDigest as enqueueRecipientDigestProduction,
  getDigestPreferences,
  hasWeeklyDigestAuthority,
  previewDigest,
  processDigestDeliveryJob,
  requireActiveDigestAccess,
  sendTestDigestNow,
  summaryLines,
  updateDigestPreferences,
  updateFirmDigestSettings,
} from "../src/services/digest.service.js";
import AutomationJob from "../src/models/AutomationJob.js";
import { retryFailedJob } from "../src/services/automation-job.service.js";
import {
  REQUIRED_DIGEST_INDEXES,
  assertDigestIndexesReady,
  getDigestIndexReadiness,
} from "../src/services/digest-index-readiness.service.js";

mongoose.set("bufferCommands", false);

// Needed from here on, not just at the later app.js import below: sending a
// digest now builds an HMAC-signed unsubscribe link
// (digest.service.js's buildDigestUnsubscribeLinks), which falls back to
// JWT_SECRET when DIGEST_UNSUBSCRIBE_SECRET is unset - exactly the
// production fallback, so this placeholder exercises the real fallback path
// rather than a special test-only branch.
process.env.JWT_SECRET ||= "digest-correctness-placeholder";

const FIXED_NOW = new Date("2026-03-20T12:00:00.000Z");
const DIGEST_RECOVERY_LEGACY_FENCE = new Date(8_640_000_000_000_000);
const DIGEST_RECOVERY_ACTIVE_TOKEN_PATTERN =
  /^drc1:(0|[1-9]\d*):([0-9a-f]{32}):(0|[1-9a-z][0-9a-z]*)$/;

function assertDigestRecoveryLegacyFence(value, message) {
  assert.ok(value instanceof Date, message || "recovery fence must be a Date");
  assert.equal(
    value.getTime(),
    DIGEST_RECOVERY_LEGACY_FENCE.getTime(),
    message || "recovery fence must block legacy workers",
  );
}

function digestRecoveryActiveToken({
  failureCount = 0,
  owner = "00000000000040008000000000000001",
  expiresAt,
}) {
  return `drc1:${failureCount}:${owner}:${expiresAt.getTime().toString(36)}`;
}

function assertDigestRecoveryActiveToken(token, { failureCount } = {}) {
  assert.match(token, DIGEST_RECOVERY_ACTIVE_TOKEN_PATTERN);
  assert.ok(token.length <= 64);
  const match = token.match(DIGEST_RECOVERY_ACTIVE_TOKEN_PATTERN);
  if (failureCount !== undefined) {
    assert.equal(Number(match[1]), failureCount);
  }
  return {
    failureCount: Number(match[1]),
    owner: match[2],
    expiresAt: new Date(Number.parseInt(match[3], 36)),
  };
}

function oldDigestRecoveryLeaseIsClaimable(lease, now) {
  const token = lease?.token;
  const expiresAt = lease?.expiresAt;
  return (
    token === null ||
    token === undefined ||
    token === "" ||
    !(expiresAt instanceof Date) ||
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt.getTime() <= now.getTime()
  );
}

const IDS = Object.freeze({
  firm: "111111111111111111111111",
  recipient: "222222222222222222222222",
  deliveryA: "333333333333333333333333",
  deliveryB: "444444444444444444444444",
  jobA: "cccccccccccccccccccccccc",
  jobB: "dddddddddddddddddddddddd",
  jobC: "eeeeeeeeeeeeeeeeeeeeeeee",
  jobD: "ffffffffffffffffffffffff",
  owner: "555555555555555555555555",
  admin: "666666666666666666666666",
  superAdmin: "777777777777777777777777",
  pointerOnly: "888888888888888888888888",
  removed: "999999999999999999999999",
  otherFirm: "aaaaaaaaaaaaaaaaaaaaaaaa",
  otherRecipient: "bbbbbbbbbbbbbbbbbbbbbbbb",
});

const results = [];
let passed = 0;

let recoverySessionSequence = 0;
async function runInMemoryRecoveryTransaction(work) {
  recoverySessionSequence += 1;
  return work({ id: `digest-recovery-session-${recoverySessionSequence}` });
}

function enqueueRecipientDigest(input, dependencies = {}) {
  return enqueueRecipientDigestProduction(input, {
    runRecoveryTransaction: runInMemoryRecoveryTransaction,
    ...dependencies,
  });
}

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    results.push(`PASS  ${name}`);
  } catch (error) {
    results.push(
      `FAIL  ${name}\n        ${error?.stack || error?.message || error}`,
    );
  }
}

function clone(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof mongoose.Types.ObjectId) {
    return new mongoose.Types.ObjectId(value.toHexString());
  }
  if (Array.isArray(value)) return value.map(clone);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, clone(entry)]),
    );
  }
  return value;
}

function getDotted(object, path) {
  return String(path)
    .split(".")
    .reduce((current, part) => current?.[part], object);
}

function setDotted(object, path, value) {
  const parts = String(path).split(".");
  let current = object;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (!current[part] || typeof current[part] !== "object") current[part] = {};
    current = current[part];
  }
  current[parts.at(-1)] = clone(value);
}

function unsetDotted(object, path) {
  const parts = String(path).split(".");
  let current = object;
  for (let index = 0; index < parts.length - 1; index += 1) {
    current = current?.[parts[index]];
    if (!current || typeof current !== "object") return;
  }
  delete current[parts.at(-1)];
}

function canonicalTestObjectId(value) {
  if (typeof value === "string" && /^[a-f\d]{24}$/i.test(value)) {
    return value.toLowerCase();
  }
  if (value instanceof mongoose.Types.ObjectId) return value.toHexString();
  return null;
}

function objectIdFixture(value) {
  if (
    value === null ||
    value === undefined ||
    value instanceof mongoose.Types.ObjectId
  ) {
    return value;
  }
  const canonical = canonicalTestObjectId(value);
  return canonical === null ? value : new mongoose.Types.ObjectId(canonical);
}

function assertObjectIdEquals(actual, expected, message) {
  assert.equal(
    canonicalTestObjectId(actual),
    canonicalTestObjectId(expected),
    message,
  );
}

function scalarEquals(actual, expected) {
  if (actual instanceof Date || expected instanceof Date) {
    return (
      actual instanceof Date &&
      expected instanceof Date &&
      Object.is(actual.getTime(), expected.getTime())
    );
  }
  if (actual === expected) return true;
  if (
    actual === null ||
    actual === undefined ||
    expected === null ||
    expected === undefined
  ) {
    return false;
  }
  if (
    actual instanceof mongoose.Types.ObjectId ||
    expected instanceof mongoose.Types.ObjectId
  ) {
    const actualId = canonicalTestObjectId(actual);
    const expectedId = canonicalTestObjectId(expected);
    return actualId !== null && expectedId !== null && actualId === expectedId;
  }
  if (typeof actual === "object" || typeof expected === "object") {
    return isDeepStrictEqual(actual, expected);
  }
  return false;
}

function queryEquals(actual, expected) {
  if (Array.isArray(actual) && !Array.isArray(expected)) {
    return actual.some((entry) => scalarEquals(entry, expected));
  }
  return scalarEquals(actual, expected);
}

function expressionFieldPath(expression) {
  return typeof expression === "string" && expression.startsWith("$")
    ? expression.slice(1)
    : "";
}

function strictExpressionEquals(
  actual,
  expected,
  actualExpression = null,
  expectedExpression = null,
) {
  const actualFieldPath = expressionFieldPath(actualExpression);
  const expectedFieldPath = expressionFieldPath(expectedExpression);
  const actualType = bsonType(actual, actualFieldPath);
  const expectedType = bsonType(expected, expectedFieldPath);
  if (actualType !== expectedType) return false;
  if (actualType === "date" || actualType === "invalidDate") {
    return Object.is(actual.getTime(), expected.getTime());
  }
  if (actualType === "objectId") {
    const actualId = canonicalTestObjectId(actual);
    const expectedId = canonicalTestObjectId(expected);
    return actualId !== null && expectedId !== null && actualId === expectedId;
  }
  if (actualType === "array") {
    const actualExpressions = Array.isArray(actualExpression)
      ? actualExpression
      : [];
    const expectedExpressions = Array.isArray(expectedExpression)
      ? expectedExpression
      : [];
    return (
      actual.length === expected.length &&
      actual.every((entry, index) =>
        strictExpressionEquals(
          entry,
          expected[index],
          actualExpressions[index],
          expectedExpressions[index],
        ),
      )
    );
  }
  if (actual === expected) return true;
  if (
    actual === null ||
    actual === undefined ||
    expected === null ||
    expected === undefined
  ) {
    return false;
  }
  if (actualType === "object") {
    return isDeepStrictEqual(actual, expected);
  }
  return Object.is(actual, expected);
}

const TEST_OBJECT_ID_PATHS = new Set([
  "_id",
  "firmId",
  "recipientUserId",
  "automationJobId",
  "ownerUserId",
  "userId",
  "assignedTo",
  "createdBy",
  "afterId",
  "cycleEndId",
]);

function bsonType(value, fieldPath = "") {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  if (value instanceof mongoose.Types.ObjectId) return "objectId";
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "invalidDate" : "date";
  }
  if (Array.isArray(value)) return "array";
  if (typeof value === "string") {
    return TEST_OBJECT_ID_PATHS.has(fieldPath) &&
      canonicalTestObjectId(value) !== null
      ? "objectId"
      : "string";
  }
  if (typeof value === "number") return "double";
  if (typeof value === "boolean") return "bool";
  return "object";
}

function comparable(value) {
  if (value instanceof Date) return value.getTime();
  if (value instanceof mongoose.Types.ObjectId) return value.toHexString();
  return value;
}

function evaluateExpression(expression, document) {
  if (typeof expression === "string" && expression.startsWith("$")) {
    return getDotted(document, expression.slice(1));
  }
  if (Array.isArray(expression)) {
    return expression.map((entry) => evaluateExpression(entry, document));
  }
  if (
    expression === null ||
    expression === undefined ||
    expression instanceof Date ||
    expression instanceof mongoose.Types.ObjectId ||
    typeof expression !== "object"
  ) {
    return expression;
  }
  if (Object.prototype.hasOwnProperty.call(expression, "$literal")) {
    return expression.$literal;
  }
  const entries = Object.entries(expression);
  if (entries.length !== 1 || !entries[0][0].startsWith("$")) {
    return Object.fromEntries(
      entries.map(([key, value]) => [key, evaluateExpression(value, document)]),
    );
  }
  const [operator, operand] = entries[0];
  if (operator === "$and") {
    return operand.every((entry) =>
      Boolean(evaluateExpression(entry, document)),
    );
  }
  if (operator === "$or") {
    return operand.some((entry) =>
      Boolean(evaluateExpression(entry, document)),
    );
  }
  if (operator === "$type") {
    const fieldPath =
      typeof operand === "string" && operand.startsWith("$")
        ? operand.slice(1)
        : "";
    return bsonType(evaluateExpression(operand, document), fieldPath);
  }
  if (["$eq", "$ne", "$lt", "$lte", "$gt", "$gte", "$in"].includes(operator)) {
    const [leftExpression, rightExpression] = operand;
    const left = evaluateExpression(leftExpression, document);
    const right = evaluateExpression(rightExpression, document);
    if (operator === "$eq") {
      return strictExpressionEquals(
        left,
        right,
        leftExpression,
        rightExpression,
      );
    }
    if (operator === "$ne") {
      return !strictExpressionEquals(
        left,
        right,
        leftExpression,
        rightExpression,
      );
    }
    if (operator === "$in") {
      return (
        Array.isArray(right) &&
        right.some((candidate, index) =>
          strictExpressionEquals(
            left,
            candidate,
            leftExpression,
            Array.isArray(rightExpression) ? rightExpression[index] : null,
          ),
        )
      );
    }
    const comparableLeft = comparable(left);
    const comparableRight = comparable(right);
    if (operator === "$lt") return comparableLeft < comparableRight;
    if (operator === "$lte") return comparableLeft <= comparableRight;
    if (operator === "$gt") return comparableLeft > comparableRight;
    return comparableLeft >= comparableRight;
  }
  throw new Error(`Unsupported in-memory expression operator: ${operator}`);
}

function matchesValue(actual, expected, fieldPath = "") {
  if (
    expected &&
    typeof expected === "object" &&
    !Array.isArray(expected) &&
    !(expected instanceof Date) &&
    !(expected instanceof mongoose.Types.ObjectId)
  ) {
    const operators = Object.keys(expected).filter((key) =>
      key.startsWith("$"),
    );
    if (operators.length > 0) {
      return operators.every((operator) => {
        if (operator === "$in" || operator === "$nin") {
          const included = expected[operator].some((candidate) =>
            queryEquals(actual, candidate),
          );
          return operator === "$in" ? included : !included;
        }
        if (operator === "$ne") {
          return !queryEquals(actual, expected.$ne);
        }
        if (operator === "$lt" || operator === "$lte") {
          const actualValue = comparable(actual);
          const operand = comparable(expected[operator]);
          return operator === "$lt"
            ? actualValue < operand
            : actualValue <= operand;
        }
        if (operator === "$gt" || operator === "$gte") {
          const actualValue = comparable(actual);
          const operand = comparable(expected[operator]);
          return operator === "$gt"
            ? actualValue > operand
            : actualValue >= operand;
        }
        if (operator === "$exists") {
          return (actual !== undefined) === Boolean(expected.$exists);
        }
        if (operator === "$type") {
          return bsonType(actual, fieldPath) === expected.$type;
        }
        if (operator === "$not") {
          return !matchesValue(actual, expected.$not, fieldPath);
        }
        throw new Error(`Unsupported in-memory filter operator: ${operator}`);
      });
    }
  }
  return queryEquals(actual, expected);
}

function matchesFilter(document, filter) {
  return Object.entries(filter).every(([field, expected]) => {
    if (field === "$and") {
      return expected.every((candidate) => matchesFilter(document, candidate));
    }
    if (field === "$or") {
      return expected.some((candidate) => matchesFilter(document, candidate));
    }
    if (field === "$expr") {
      return Boolean(evaluateExpression(expected, document));
    }
    if (field.startsWith("$")) {
      throw new Error(`Unsupported in-memory filter operator: ${field}`);
    }
    return matchesValue(getDotted(document, field), expected, field);
  });
}

function queryContains(query, predicate) {
  let found = false;
  const visit = (value) => {
    if (found || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (
      typeof value !== "object" ||
      value instanceof Date ||
      value instanceof mongoose.Types.ObjectId
    ) {
      return;
    }
    if (predicate(value)) {
      found = true;
      return;
    }
    if (Object.prototype.hasOwnProperty.call(value, "$literal")) return;
    for (const entry of Object.values(value)) visit(entry);
  };
  visit(query);
  return found;
}

function queryHasLiteralEquality(query, fieldPath, expected) {
  const fieldReference = `$${fieldPath}`;
  return queryContains(query, (node) => {
    if (!Array.isArray(node.$eq) || node.$eq.length !== 2) return false;
    const [left, right] = node.$eq;
    return [
      [left, right],
      [right, left],
    ].some(
      ([field, literal]) =>
        field === fieldReference &&
        literal &&
        typeof literal === "object" &&
        Object.prototype.hasOwnProperty.call(literal, "$literal") &&
        scalarEquals(literal.$literal, expected),
    );
  });
}

function queryHasTypeCheck(query, fieldPath, expectedType) {
  const typeExpression = { $type: `$${fieldPath}` };
  return queryContains(query, (node) => {
    if (!Array.isArray(node.$eq) || node.$eq.length !== 2) return false;
    const [left, right] = node.$eq;
    return (
      (isDeepStrictEqual(left, typeExpression) && right === expectedType) ||
      (isDeepStrictEqual(right, typeExpression) && left === expectedType)
    );
  });
}

function queryHasDirectCondition(query, fieldPath, predicate) {
  return queryContains(
    query,
    (node) =>
      Object.prototype.hasOwnProperty.call(node, fieldPath) &&
      predicate(node[fieldPath]),
  );
}

function assertLiteralEquality(query, fieldPath, expected, label = fieldPath) {
  assert.equal(
    queryHasLiteralEquality(query, fieldPath, expected),
    true,
    `${label} must use $expr equality with $literal`,
  );
}

// The recovery cursor acquisition is an upsert, and MongoDB rejects it outright:
// "$expr is not allowed in the query predicate for an upsert". So that one filter
// cannot be held to the $expr/$literal form, and asserting that it was is what let
// the defect ship -- the in-memory model accepted the shape and only the real
// server refused it.
//
// It is asserted separately rather than by relaxing assertLiteralEquality, so every
// filter that is not an upsert predicate is still held to the stricter form. The
// property that $literal provided -- a value cannot be reinterpreted as query
// operators -- is preserved in the service, which rejects a non-scalar before
// building the filter.
function assertUpsertScalarEquality(
  query,
  fieldPath,
  expected,
  label = fieldPath,
) {
  assert.equal(
    queryHasDirectCondition(query, fieldPath, (condition) =>
      expected instanceof Date
        ? condition instanceof Date &&
          condition.getTime() === expected.getTime()
        : condition === expected,
    ),
    true,
    `${label} must use direct scalar equality, because an upsert predicate cannot use $expr`,
  );
  // The absence of $expr is asserted here, at every upsert call site, because its
  // presence is what the server rejects and nothing previously checked for it.
  assert.equal(
    queryContains(query, (node) =>
      Object.prototype.hasOwnProperty.call(node, "$expr"),
    ),
    false,
    `${label} must not contain $expr anywhere: MongoDB rejects "$expr is not allowed in the query predicate for an upsert"`,
  );
}

function assertStrictObjectIdEquality(
  query,
  fieldPath,
  expected,
  label = fieldPath,
) {
  assertLiteralEquality(query, fieldPath, expected, label);
  assert.equal(
    queryHasTypeCheck(query, fieldPath, "objectId"),
    true,
    `${label} must enforce BSON objectId`,
  );
  assert.equal(
    queryHasDirectCondition(
      query,
      fieldPath,
      (value) =>
        value instanceof mongoose.Types.ObjectId &&
        scalarEquals(value, expected),
    ),
    true,
    `${label} must include canonical ObjectId equality`,
  );
}

function assertStrictStringEquality(
  query,
  fieldPath,
  expected,
  label = fieldPath,
) {
  assertLiteralEquality(query, fieldPath, expected, label);
  assert.equal(
    queryHasTypeCheck(query, fieldPath, "string"),
    true,
    `${label} must enforce BSON string`,
  );
}

function assertFilterAccepts(filter, document, label = "filter") {
  assert.equal(
    matchesFilter(document, filter),
    true,
    `${label} rejected match`,
  );
}

function assertFilterRejects(filter, document, label = "filter") {
  assert.equal(
    matchesFilter(document, filter),
    false,
    `${label} accepted mismatch`,
  );
}

function assertFullClaimFence(
  filter,
  {
    deliveryId = IDS.deliveryA,
    firmId = IDS.firm,
    automationJobId = IDS.jobA,
    claimToken,
    attempts = 0,
    label = "claim fence",
  },
) {
  assertStrictObjectIdEquality(filter, "_id", deliveryId, `${label} id`);
  assertStrictObjectIdEquality(filter, "firmId", firmId, `${label} firm`);
  assertStrictObjectIdEquality(
    filter,
    "automationJobId",
    automationJobId,
    `${label} job`,
  );
  assertLiteralEquality(
    filter,
    "email.claimToken",
    claimToken,
    `${label} token`,
  );
  assertLiteralEquality(filter, "email.state", "SENDING", `${label} state`);
  assertLiteralEquality(
    filter,
    "email.attempts",
    attempts,
    `${label} attempts`,
  );
  const matching = makeDelivery({
    _id: deliveryId,
    firmId,
    automationJobId,
    email: {
      state: "SENDING",
      claimToken,
      claimedAt: new Date(FIXED_NOW),
      attempts,
    },
  });
  assertFilterAccepts(filter, matching, label);
  assertFilterRejects(
    filter,
    {
      ...matching,
      email: { ...matching.email, claimToken: "replacement-claim" },
    },
    `${label} replacement claim`,
  );
  assertFilterRejects(
    filter,
    {
      ...matching,
      email: {
        ...matching.email,
        attempts: typeof attempts === "number" ? attempts + 1 : 0,
      },
    },
    `${label} replacement attempts`,
  );
}

function assertFullRecoveryFence(
  filter,
  {
    delivery,
    recoveryToken,
    recoveryRevision = 1,
    automationJobId = delivery.automationJobId,
    label = "recovery fence",
  },
) {
  assertStrictObjectIdEquality(filter, "_id", delivery._id, `${label} id`);
  assertStrictObjectIdEquality(
    filter,
    "firmId",
    delivery.firmId,
    `${label} firm`,
  );
  assertStrictObjectIdEquality(
    filter,
    "automationJobId",
    automationJobId,
    `${label} job`,
  );
  assertLiteralEquality(
    filter,
    "jobRecovery.token",
    recoveryToken,
    `${label} recovery token`,
  );
  assertLiteralEquality(
    filter,
    "jobRecovery.revision",
    recoveryRevision,
    `${label} recovery revision`,
  );
  assert.equal(
    queryHasDirectCondition(
      filter,
      "jobRecovery.expiresAt",
      (condition) => condition?.$gt instanceof Date,
    ),
    true,
    `${label} must require a live recovery lease`,
  );
  assertLiteralEquality(
    filter,
    "email.state",
    delivery.email.state,
    `${label} email state`,
  );
  assertLiteralEquality(
    filter,
    "email.claimToken",
    delivery.email.claimToken ?? null,
    `${label} email claim token`,
  );
  assertLiteralEquality(
    filter,
    "email.claimedAt",
    delivery.email.claimedAt ?? null,
    `${label} email claimedAt`,
  );
  const matching = clone(delivery);
  matching.automationJobId = automationJobId;
  matching.jobRecovery = {
    ...(matching.jobRecovery || {}),
    token: recoveryToken,
    revision: recoveryRevision,
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
  };
  assertFilterAccepts(filter, matching, label);
  assertFilterRejects(
    filter,
    {
      ...matching,
      email: {
        ...matching.email,
        claimToken: "replacement-claim",
      },
    },
    `${label} replacement claim`,
  );
}

function applyUpdate(document, update) {
  for (const [path, value] of Object.entries(update.$set || {})) {
    setDotted(document, path, value);
  }
  for (const path of Object.keys(update.$unset || {})) {
    unsetDotted(document, path);
  }
  for (const [path, amount] of Object.entries(update.$inc || {})) {
    const current = getDotted(document, path);
    if (current !== undefined && typeof current !== "number") {
      throw new TypeError(`Cannot apply $inc to non-number at ${path}`);
    }
    if (typeof amount !== "number" || !Number.isFinite(amount)) {
      throw new TypeError(`Invalid $inc amount at ${path}`);
    }
    setDotted(document, path, (current ?? 0) + amount);
  }
}

function makeLeanQuery(value, onSelect, onSession) {
  const query = {
    select(fields) {
      onSelect?.(fields);
      return query;
    },
    session(session) {
      onSession?.(session);
      return query;
    },
    async lean() {
      return clone(value);
    },
  };
  return query;
}

function makeFindQuery(rows, operation) {
  let resultRows = [...rows];
  let resultLimit = resultRows.length;
  const query = {
    select(fields) {
      operation.selection = fields;
      return query;
    },
    sort(sort) {
      operation.sort = clone(sort);
      const entries = Object.entries(sort || {});
      resultRows.sort((left, right) => {
        for (const [path, direction] of entries) {
          const leftValue = getDotted(left, path);
          const rightValue = getDotted(right, path);
          if (scalarEquals(leftValue, rightValue)) continue;
          return (leftValue < rightValue ? -1 : 1) * Number(direction || 1);
        }
        return 0;
      });
      return query;
    },
    limit(limit) {
      operation.limit = limit;
      resultLimit = limit;
      return query;
    },
    async lean() {
      return clone(resultRows.slice(0, resultLimit));
    },
  };
  return query;
}

function createInMemoryDigestDelivery(initialDocuments) {
  const documents = initialDocuments.map(clone);
  const operations = [];

  const model = {
    async findOneAndUpdate(filter, update, options = {}) {
      operations.push({
        method: "findOneAndUpdate",
        filter: clone(filter),
        update: clone(update),
        options: clone(options),
      });
      const document = documents.find((candidate) =>
        matchesFilter(candidate, filter),
      );
      if (!document) return null;
      applyUpdate(document, update);
      return clone(document);
    },

    findOne(filter) {
      const operation = {
        method: "findOne",
        filter: clone(filter),
        selection: null,
        session: null,
      };
      operations.push(operation);
      const document = documents.find((candidate) =>
        matchesFilter(candidate, filter),
      );
      return makeLeanQuery(
        document || null,
        (selection) => {
          operation.selection = selection;
        },
        (session) => {
          operation.session = session;
        },
      );
    },

    find(filter) {
      const operation = {
        method: "find",
        filter: clone(filter),
        selection: null,
        sort: null,
        limit: null,
      };
      operations.push(operation);
      const rows = documents.filter((candidate) =>
        matchesFilter(candidate, filter),
      );
      return makeFindQuery(rows, operation);
    },

    async updateOne(filter, update, options = {}) {
      operations.push({
        method: "updateOne",
        filter: clone(filter),
        update: clone(update),
        options: clone(options),
      });
      const document = documents.find((candidate) =>
        matchesFilter(candidate, filter),
      );
      if (!document) return { matchedCount: 0, modifiedCount: 0 };
      applyUpdate(document, update);
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };

  return {
    model,
    operations,
    get(deliveryId) {
      return clone(
        documents.find((document) => scalarEquals(document._id, deliveryId)) ||
          null,
      );
    },
    insert(delivery) {
      documents.push(clone(delivery));
    },
    snapshot() {
      return clone(documents);
    },
    restore(snapshot) {
      documents.splice(0, documents.length, ...clone(snapshot));
    },
  };
}

function createInMemoryDigestRecoveryCursor(initialDocument = null) {
  let document = initialDocument ? clone(initialDocument) : null;
  const operations = [];
  const model = {
    findOne(filter) {
      const operation = {
        method: "findOne",
        filter: clone(filter),
      };
      operations.push(operation);
      const matched = document && matchesFilter(document, filter);
      return makeLeanQuery(matched ? document : null);
    },
    async findOneAndUpdate(filter, update, options = {}) {
      operations.push({
        method: "findOneAndUpdate",
        filter: clone(filter),
        update: clone(update),
        options: clone(options),
      });
      if (!document) {
        if (!options.upsert) return null;
        document = {
          _id: DIGEST_RECOVERY_CURSOR_ID,
          afterId: null,
          cycleEndId: null,
          lease: { token: null, expiresAt: null },
        };
        applyUpdate(document, { $set: update.$setOnInsert || {} });
      } else if (!matchesFilter(document, filter)) {
        if (options.upsert) {
          const error = new Error("duplicate digest recovery cursor singleton");
          error.code = 11000;
          error.codeName = "DuplicateKey";
          throw error;
        }
        return null;
      }
      applyUpdate(document, update);
      return clone(document);
    },
    async updateOne(filter, update) {
      operations.push({
        method: "updateOne",
        filter: clone(filter),
        update: clone(update),
      });
      if (!document || !matchesFilter(document, filter)) {
        return { matchedCount: 0, modifiedCount: 0 };
      }
      applyUpdate(document, update);
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };
  return {
    model,
    operations,
    get() {
      return clone(document);
    },
  };
}

function createInMemoryAutomationJob(initialDocuments = []) {
  const documents = initialDocuments.map(clone);
  const operations = [];
  const model = {
    findOne(filter) {
      const operation = {
        method: "findOne",
        filter: clone(filter),
        session: null,
      };
      operations.push(operation);
      const document = documents.find((candidate) =>
        matchesFilter(candidate, filter),
      );
      return makeLeanQuery(document || null, null, (session) => {
        operation.session = session;
      });
    },
    async findOneAndUpdate(filter, update, options = {}) {
      operations.push({
        method: "findOneAndUpdate",
        filter: clone(filter),
        update: clone(update),
        options: clone(options),
      });
      const document = documents.find((candidate) =>
        matchesFilter(candidate, filter),
      );
      if (!document) return null;
      applyUpdate(document, update);
      return clone(document);
    },
    async updateOne(filter, update, options = {}) {
      operations.push({
        method: "updateOne",
        filter: clone(filter),
        update: clone(update),
        options: clone(options),
      });
      const document = documents.find((candidate) =>
        matchesFilter(candidate, filter),
      );
      if (!document) return { matchedCount: 0, modifiedCount: 0 };
      applyUpdate(document, update);
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };
  return {
    model,
    operations,
    get(jobId) {
      return clone(
        documents.find((document) => scalarEquals(document._id, jobId)) || null,
      );
    },
    insert(job) {
      documents.push(clone(job));
    },
    snapshot() {
      return clone(documents);
    },
    restore(snapshot) {
      documents.splice(0, documents.length, ...clone(snapshot));
    },
  };
}

function makeAutomationJob(overrides = {}) {
  const job = {
    _id: IDS.jobA,
    firmId: IDS.firm,
    kind: "DIGEST_DELIVERY",
    idempotencyKey: expectedBusinessKey(),
    status: "PENDING",
    attemptCount: 0,
    maxAttempts: 5,
    nextAttemptAt: new Date(FIXED_NOW),
    completedAt: null,
    lease: {},
    payload: { deliveryId: IDS.deliveryA },
    ...clone(overrides),
  };
  job._id = objectIdFixture(job._id);
  return job;
}

function makeDelivery(overrides = {}) {
  const base = {
    _id: IDS.deliveryA,
    firmId: IDS.firm,
    recipientUserId: IDS.recipient,
    kind: DAILY_KIND,
    periodKey: "2026-03-20",
    timezone: "UTC",
    subject: "Daily work digest · 2026-03-20",
    summary: {
      kind: DAILY_KIND,
      counts: {
        open: 3,
        overdue: 1,
        dueSoon: 2,
        waitingDocs: 1,
        case: 0,
        reconciliationReview: 1,
      },
    },
    status: "QUEUED",
    email: {
      state: "PENDING",
      attempts: 0,
      idempotencyKey: null,
      providerMessageId: "",
      lastError: "",
      sentAt: null,
      claimToken: null,
      claimedAt: null,
    },
    inApp: {
      state: "HIDDEN",
      availableAt: null,
      readAt: null,
    },
    automationJobId: IDS.jobA,
    jobRecovery: {
      token: null,
      expiresAt: null,
      revision: 0,
    },
  };

  const delivery = {
    ...base,
    ...clone(overrides),
    summary: {
      ...base.summary,
      ...(overrides.summary || {}),
      counts: {
        ...base.summary.counts,
        ...(overrides.summary?.counts || {}),
      },
    },
    email: { ...base.email, ...(overrides.email || {}) },
    inApp: { ...base.inApp, ...(overrides.inApp || {}) },
    jobRecovery: {
      ...base.jobRecovery,
      ...(overrides.jobRecovery || {}),
    },
  };
  if (
    !Object.prototype.hasOwnProperty.call(
      overrides.email || {},
      "idempotencyKey",
    )
  ) {
    delivery.email.idempotencyKey = digestBusinessIdentity({
      firmId: delivery.firmId,
      kind: delivery.kind,
      periodKey: delivery.periodKey,
      recipientUserId: delivery.recipientUserId,
    });
  }
  delivery.automationJobId = objectIdFixture(delivery.automationJobId);
  return delivery;
}

function orderedObjectId(index) {
  return Number(index).toString(16).padStart(24, "0");
}

function makeRecoverableDelivery(index, overrides = {}) {
  return makeDelivery({
    ...clone(overrides),
    _id: overrides._id || orderedObjectId(index),
    periodKey:
      overrides.periodKey || `recovery-${String(index).padStart(4, "0")}`,
    automationJobId: overrides.automationJobId ?? null,
    email: {
      state: "SENDING",
      claimToken: "",
      claimedAt: new Date(FIXED_NOW),
      ...(overrides.email || {}),
    },
  });
}

async function runDisabledDigestRecovery({
  deliveryModel,
  cursorModel,
  recover,
  recoveryClock = () => new Date(FIXED_NOW),
  reportRecoveryError = async () => {},
  now = FIXED_NOW,
}) {
  return enqueueDueDigests(
    { now: new Date(now) },
    {
      AppConfig: {
        async isFeatureEnabled() {
          return false;
        },
      },
      DigestDelivery: deliveryModel,
      DigestRecoveryCursor: cursorModel,
      recoveryClock,
      reportRecoveryError,
      Firm: {
        find() {
          throw new Error("disabled digest recovery must not scan firms");
        },
      },
      FirmMembership: {
        find() {
          throw new Error("disabled digest recovery must not scan memberships");
        },
      },
      User: {
        find() {
          throw new Error("disabled digest recovery must not scan users");
        },
      },
      enqueueRecipientDigest: recover,
    },
  );
}

function makeUser(overrides = {}) {
  return {
    _id: IDS.recipient,
    __v: 0,
    email: "reviewer@example.test",
    role: "MEMBER",
    digestPreferences: {
      dailyFrequency: "DAILY",
      weeklyEnabled: true,
      emailEnabled: true,
    },
    ...clone(overrides),
    digestPreferences: {
      dailyFrequency: "DAILY",
      weeklyEnabled: true,
      emailEnabled: true,
      ...(overrides.digestPreferences || {}),
    },
  };
}

function makeMembership(overrides = {}) {
  return {
    firmId: IDS.firm,
    userId: IDS.recipient,
    __v: 0,
    status: "ACTIVE",
    role: "OWNER",
    ...clone(overrides),
  };
}

function makeFirm(overrides = {}) {
  return {
    _id: IDS.firm,
    __v: 0,
    isActive: true,
    kind: "BUSINESS",
    ownerUserId: IDS.recipient,
    timezone: "UTC",
    digestSettings: { dailyHour: 8, weeklyDay: 1, weeklyHour: 8 },
    ...clone(overrides),
  };
}

function createLookupModel(value, lookups, lookupError = null) {
  return {
    findOne(filter) {
      const lookup = { filter: clone(filter), selection: null, session: null };
      lookups.push(lookup);
      const resolvedValue = typeof value === "function" ? value(filter) : value;
      const resolvedLookupError =
        typeof lookupError === "function"
          ? lookupError({ filter: clone(filter), callCount: lookups.length })
          : lookupError;
      const query = makeLeanQuery(
        resolvedValue,
        (selection) => {
          lookup.selection = selection;
        },
        (session) => {
          lookup.session = session;
        },
      );
      if (resolvedLookupError) {
        query.lean = async () => {
          throw resolvedLookupError;
        };
      }
      return query;
    },
  };
}

function createProcessHarness({
  delivery = makeDelivery(),
  firm = makeFirm(),
  recipient = makeUser(),
  membership = makeMembership(),
  featureEnabled = true,
  featureError = null,
  firmError = null,
  userError = null,
  membershipError = null,
  beforeProviderAuthorityReload = null,
  leaseAssertion = async () => {},
  provider = async () => ({ data: { id: "provider-message-fixed" } }),
} = {}) {
  const store = createInMemoryDigestDelivery([delivery]);
  const firmLookups = [];
  const userLookups = [];
  const membershipLookups = [];
  const featureCalls = [];
  const providerCalls = [];
  const activityCalls = [];
  const leaseCalls = [];
  let currentFirm = clone(firm);
  let currentRecipient = clone(recipient);
  let currentMembership = clone(membership);

  const Firm = createLookupModel(() => currentFirm, firmLookups, firmError);
  const User = createLookupModel(
    () => currentRecipient,
    userLookups,
    userError,
  );
  const FirmMembership = createLookupModel(
    () => currentMembership,
    membershipLookups,
    membershipError,
  );
  const AppConfig = {
    async isFeatureEnabled(name, options) {
      featureCalls.push({ name, options: clone(options) });
      if (featureError) throw featureError;
      const callCount = featureCalls.length;
      if (typeof featureEnabled === "function") {
        return featureEnabled({
          name,
          options: clone(options),
          callCount,
        });
      }
      if (Array.isArray(featureEnabled)) {
        if (featureEnabled.length === 0) return false;
        return featureEnabled[
          Math.min(callCount - 1, featureEnabled.length - 1)
        ];
      }
      return featureEnabled;
    },
  };

  const job = {
    _id: IDS.jobA,
    firmId: delivery.firmId,
    payload: { deliveryId: delivery._id },
    requestId: "digest-correctness-fixed",
  };

  return {
    store,
    firmLookups,
    userLookups,
    membershipLookups,
    featureCalls,
    providerCalls,
    activityCalls,
    leaseCalls,
    job,
    setFirm(value) {
      currentFirm = clone(value);
    },
    setRecipient(value) {
      currentRecipient = clone(value);
    },
    setMembership(value) {
      currentMembership = clone(value);
    },
    async run(jobOverride = job) {
      return processDigestDeliveryJob(jobOverride, {
        assertLease: async () => {
          leaseCalls.push(FIXED_NOW.toISOString());
          return leaseAssertion({
            callCount: leaseCalls.length,
            store,
            setFirm(value) {
              currentFirm = clone(value);
            },
            setRecipient(value) {
              currentRecipient = clone(value);
            },
            setMembership(value) {
              currentMembership = clone(value);
            },
          });
        },
        DigestDelivery: store.model,
        Firm,
        User,
        FirmMembership,
        AppConfig,
        sendDigestEmail: async (input) => {
          providerCalls.push(clone(input));
          return provider(input);
        },
        safeRecordActivity: async (input) => {
          activityCalls.push(clone(input));
        },
        beforeProviderAuthorityReload:
          typeof beforeProviderAuthorityReload === "function"
            ? async (context) =>
                beforeProviderAuthorityReload({
                  ...context,
                  setFirm(value) {
                    currentFirm = clone(value);
                  },
                  setRecipient(value) {
                    currentRecipient = clone(value);
                  },
                  setMembership(value) {
                    currentMembership = clone(value);
                  },
                })
            : null,
        clock: () => new Date(FIXED_NOW.getTime()),
      });
    },
  };
}

function createFirmSettingsHarness({
  user = makeUser({ isActive: true }),
  membership = makeMembership(),
  firm = {
    _id: IDS.firm,
    __v: 0,
    isActive: true,
    kind: "BUSINESS",
    ownerUserId: IDS.recipient,
    timezone: "Asia/Kolkata",
    digestSettings: { dailyHour: 8, weeklyDay: 1, weeklyHour: 8 },
  },
  firmUpdateReturnsNull = false,
  beforeSettingsWrite = null,
} = {}) {
  const userLookups = [];
  const userWrites = [];
  const membershipLookups = [];
  const membershipWrites = [];
  const firmReads = [];
  const firmWrites = [];
  const activityCalls = [];
  let currentUser = clone(user);
  let currentMembership = clone(membership);
  let currentFirm = clone(firm);
  let transactionRollbackState = null;

  const User = {
    findOne(filter) {
      const operation = {
        filter: clone(filter),
        selection: null,
        session: null,
      };
      userLookups.push(operation);
      const matched =
        currentUser && matchesFilter(currentUser, filter) ? currentUser : null;
      return makeLeanQuery(
        matched,
        (selection) => {
          operation.selection = selection;
        },
        (session) => {
          operation.session = session;
        },
      );
    },
    async updateOne(filter, update, options = {}) {
      const operation = {
        filter: clone(filter),
        update: clone(update),
        options: clone(options),
      };
      userWrites.push(operation);
      if (!currentUser || !matchesFilter(currentUser, filter)) {
        return { matchedCount: 0, modifiedCount: 0 };
      }
      applyUpdate(currentUser, update);
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };
  const FirmMembership = {
    findOne(filter) {
      const operation = {
        filter: clone(filter),
        selection: null,
        session: null,
      };
      membershipLookups.push(operation);
      const matched =
        currentMembership && matchesFilter(currentMembership, filter)
          ? currentMembership
          : null;
      return makeLeanQuery(
        matched,
        (selection) => {
          operation.selection = selection;
        },
        (session) => {
          operation.session = session;
        },
      );
    },
    async updateOne(filter, update, options = {}) {
      const operation = {
        filter: clone(filter),
        update: clone(update),
        options: clone(options),
      };
      membershipWrites.push(operation);
      if (!currentMembership || !matchesFilter(currentMembership, filter)) {
        return { matchedCount: 0, modifiedCount: 0 };
      }
      applyUpdate(currentMembership, update);
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };
  const Firm = {
    findOne(filter) {
      const operation = {
        filter: clone(filter),
        selection: null,
        session: null,
      };
      firmReads.push(operation);
      const matched =
        currentFirm && matchesFilter(currentFirm, filter) ? currentFirm : null;
      return makeLeanQuery(
        matched,
        (selection) => {
          operation.selection = selection;
        },
        (session) => {
          operation.session = session;
        },
      );
    },
    findOneAndUpdate(filter, update, options) {
      const operation = {
        filter: clone(filter),
        update: clone(update),
        options: clone(options),
        selection: null,
      };
      firmWrites.push(operation);
      const updateResult =
        !firmUpdateReturnsNull &&
        currentFirm &&
        matchesFilter(currentFirm, filter)
          ? currentFirm
          : null;
      if (updateResult) applyUpdate(updateResult, update);
      return makeLeanQuery(updateResult, (selection) => {
        operation.selection = selection;
      });
    },
  };

  return {
    userLookups,
    userWrites,
    membershipLookups,
    membershipWrites,
    firmReads,
    firmWrites,
    activityCalls,
    getUser: () => clone(currentUser),
    getMembership: () => clone(currentMembership),
    getFirm: () => clone(currentFirm),
    async run(input = { dailyHour: 9 }) {
      return updateFirmDigestSettings(
        {
          userId: user?._id || IDS.recipient,
          firmId: IDS.firm,
          input,
          requestId: "firm-digest-settings-fixed",
        },
        {
          Firm,
          FirmMembership,
          User,
          runSettingsTransaction: async (work) => {
            transactionRollbackState = {
              user: clone(currentUser),
              membership: clone(currentMembership),
              firm: clone(currentFirm),
            };
            try {
              return await work({ id: "firm-settings-transaction" });
            } catch (error) {
              currentUser = clone(transactionRollbackState.user);
              currentMembership = clone(transactionRollbackState.membership);
              currentFirm = clone(transactionRollbackState.firm);
              throw error;
            } finally {
              transactionRollbackState = null;
            }
          },
          beforeSettingsWrite: beforeSettingsWrite
            ? async (context) =>
                beforeSettingsWrite({
                  ...context,
                  setUser(value) {
                    currentUser = clone(value);
                    if (transactionRollbackState) {
                      transactionRollbackState.user = clone(value);
                    }
                  },
                  setMembership(value) {
                    currentMembership = clone(value);
                    if (transactionRollbackState) {
                      transactionRollbackState.membership = clone(value);
                    }
                  },
                  setFirm(value) {
                    currentFirm = clone(value);
                    if (transactionRollbackState) {
                      transactionRollbackState.firm = clone(value);
                    }
                  },
                })
            : null,
          safeRecordActivity: async (activity) => {
            activityCalls.push(clone(activity));
          },
        },
      );
    },
  };
}

function expectedBusinessKey(delivery = makeDelivery()) {
  return `digest:${delivery.firmId}:${delivery.kind}:${delivery.periodKey}:${delivery.recipientUserId}`;
}

function createMatchedNoOpLinkDeliveryModel(delivery) {
  const store = createInMemoryDigestDelivery([delivery]);
  return {
    model: store.model,
    operations: store.operations,
    get: store.get,
  };
}

function assertMatchedNoOpLinkCas(operations, delivery, jobId) {
  const leaseAcquisition = operations.find(
    (operation) =>
      operation.method === "findOneAndUpdate" &&
      operation.update?.$set?.["jobRecovery.token"],
  );
  const authorityWrite = operations.find(
    (operation) =>
      operation.method === "updateOne" &&
      scalarEquals(operation.update?.$set?.automationJobId, jobId),
  );
  assert.ok(leaseAcquisition, "job recovery lease acquisition is missing");
  assert.ok(authorityWrite, "authoritative job pointer CAS is missing");
  const recoveryToken = leaseAcquisition.update.$set["jobRecovery.token"];
  assert.equal(typeof recoveryToken, "string");
  assertStrictObjectIdEquality(
    authorityWrite.filter,
    "_id",
    delivery._id,
    "delivery id",
  );
  assertStrictObjectIdEquality(
    authorityWrite.filter,
    "firmId",
    delivery.firmId,
    "firm id",
  );
  if (canonicalTestObjectId(delivery.automationJobId) !== null) {
    assertStrictObjectIdEquality(
      authorityWrite.filter,
      "automationJobId",
      delivery.automationJobId,
      "automation job snapshot",
    );
  } else {
    assertLiteralEquality(
      authorityWrite.filter,
      "automationJobId",
      delivery.automationJobId ?? null,
    );
  }
  assertLiteralEquality(
    authorityWrite.filter,
    "jobRecovery.token",
    recoveryToken,
  );
  assertLiteralEquality(authorityWrite.filter, "jobRecovery.revision", 1);
  assert.equal(
    queryHasDirectCondition(
      authorityWrite.filter,
      "jobRecovery.expiresAt",
      (condition) => condition?.$gt instanceof Date,
    ),
    true,
    "recovery lease expiry fence is missing",
  );
  assertLiteralEquality(
    authorityWrite.filter,
    "email.state",
    delivery.email.state,
  );
  assertLiteralEquality(
    authorityWrite.filter,
    "email.claimToken",
    delivery.email.claimToken ?? null,
  );
  assertLiteralEquality(
    authorityWrite.filter,
    "email.claimedAt",
    delivery.email.claimedAt ?? null,
  );
  assertObjectIdEquals(authorityWrite.update.$set.automationJobId, jobId);
  assert.ok(
    authorityWrite.update.$set["jobRecovery.expiresAt"] instanceof Date,
  );
}

function assertRecoveryTerminalized(delivery) {
  assert.equal(delivery.status, "FAILED");
  assert.equal(delivery.email.state, "FAILED");
  assert.equal(delivery.email.claimToken, null);
  assert.equal(delivery.email.claimedAt, null);
  assert.equal(delivery.inApp.state, "HIDDEN");
  assert.equal(delivery.inApp.availableAt, null);
  assert.equal(delivery.inApp.readAt, null);
}

function readyIndex(requirement) {
  return {
    name: `ready_${requirement.model.modelName}`,
    key: { ...requirement.key },
    unique: true,
  };
}

function createSummaryTaskModel() {
  const operations = {
    aggregate: null,
    completedFilter: null,
  };
  const model = {
    async aggregate(pipeline) {
      operations.aggregate = pipeline;
      return [];
    },
    async countDocuments(filter) {
      operations.completedFilter = filter;
      return 0;
    },
    find() {
      const query = {
        select() {
          return query;
        },
        sort() {
          return query;
        },
        limit() {
          return query;
        },
        async lean() {
          return [];
        },
      };
      return query;
    },
  };
  return { model, operations };
}

const READ_AVAILABLE_AT = new Date("2026-03-20T10:00:00.000Z");
const READ_AT = new Date("2026-03-20T10:05:00.000Z");

function makeReadRetryDelivery() {
  return makeDelivery({
    status: "PARTIAL",
    email: {
      state: "FAILED",
      attempts: 1,
      lastError: "Earlier provider failure",
    },
    inApp: {
      state: "READ",
      availableAt: READ_AVAILABLE_AT,
      readAt: READ_AT,
    },
  });
}

function assertReadStatePreserved(delivery) {
  assert.equal(delivery.inApp.state, "READ");
  assert.equal(
    delivery.inApp.availableAt.toISOString(),
    READ_AVAILABLE_AT.toISOString(),
  );
  assert.equal(delivery.inApp.readAt.toISOString(), READ_AT.toISOString());
}

await check(
  "in-memory Mongo equality separates direct array matching from strict expressions",
  () => {
    const deliveryId = new mongoose.Types.ObjectId(IDS.deliveryA);
    const arrayDocument = {
      payload: { deliveryId: [deliveryId] },
    };

    assert.equal(
      queryEquals(arrayDocument.payload.deliveryId, deliveryId),
      true,
    );
    assert.equal(strictExpressionEquals(deliveryId, IDS.deliveryA), false);
    const objectIdDocument = { _id: IDS.deliveryA };
    for (const operands of [
      ["$_id", { $literal: IDS.deliveryA }],
      [{ $literal: IDS.deliveryA }, "$_id"],
    ]) {
      assert.equal(
        evaluateExpression({ $eq: operands }, objectIdDocument),
        false,
      );
    }
    assert.equal(
      evaluateExpression(
        {
          $eq: [{ $literal: deliveryId }, { $literal: IDS.deliveryA }],
        },
        {},
      ),
      false,
    );
    assert.equal(
      evaluateExpression(
        {
          $eq: ["$payload.deliveryId", { $literal: deliveryId }],
        },
        arrayDocument,
      ),
      false,
    );
    assert.equal(
      evaluateExpression(
        {
          $in: ["$payload.deliveryId", [{ $literal: deliveryId }]],
        },
        arrayDocument,
      ),
      false,
    );
  },
);

await check(
  "deadline buckets use UTC day when firm-local date is already next day",
  async () => {
    const tasks = createSummaryTaskModel();
    const now = new Date("2026-03-20T20:00:00.000Z");
    const summary = await buildDigestSummary(
      {
        firmId: IDS.firm,
        userId: IDS.recipient,
        kind: DAILY_KIND,
        periodKey: "2026-03-21",
        timezone: "Asia/Kolkata",
        noticeCasesEnabled: false,
        now,
      },
      { Task: tasks.model },
    );

    const group = tasks.operations.aggregate.find(
      (stage) => stage.$group,
    ).$group;
    assert.deepEqual(group.overdue.$sum.$cond[0], {
      $lt: ["$dueDateISO", "2026-03-20T00:00:00.000Z"],
    });
    assert.deepEqual(group.dueSoon.$sum.$cond[0], {
      $and: [
        { $gte: ["$dueDateISO", "2026-03-20T00:00:00.000Z"] },
        { $lt: ["$dueDateISO", "2026-03-28T00:00:00.000Z"] },
      ],
    });
    assert.equal(summary.periodKey, "2026-03-21");
    assert.equal(summary.generatedAt, now.toISOString());
  },
);

await check(
  "weekly completion window stays anchored to local Monday",
  async () => {
    const mondayStartUtc = "2026-03-15T18:30:00.000Z";
    for (const now of [
      new Date("2026-03-16T02:30:00.000Z"),
      new Date("2026-03-19T10:00:00.000Z"),
    ]) {
      const tasks = createSummaryTaskModel();
      await buildDigestSummary(
        {
          firmId: IDS.firm,
          userId: IDS.recipient,
          kind: WEEKLY_KIND,
          periodKey: "2026-03-16",
          timezone: "Asia/Kolkata",
          noticeCasesEnabled: false,
          now,
        },
        { Task: tasks.model },
      );

      assert.equal(
        tasks.operations.completedFilter.completedAt.$gte.toISOString(),
        mondayStartUtc,
      );
      assert.equal(
        tasks.operations.completedFilter.completedAt.$lte.toISOString(),
        now.toISOString(),
      );
    }
  },
);

await check("weekly completion copy describes the current week", () => {
  const lines = summaryLines({
    kind: WEEKLY_KIND,
    counts: { completedThisWeek: 4 },
  });
  assert.deepEqual(lines.at(-1), {
    label: "Filed/closed this week",
    value: 4,
  });
  assert.equal(
    lines.some((line) => line.label === "Filed/closed in last 7 days"),
    false,
  );
});

await check(
  "ordinary FAILED provider retry is refused and preserves an already-read digest",
  async () => {
    const harness = createProcessHarness({
      delivery: makeReadRetryDelivery(),
      provider: async () => {
        throw new Error("ordinary FAILED delivery reached provider");
      },
    });

    const result = await harness.run();
    const stored = harness.store.get(IDS.deliveryA);
    assert.deepEqual(result, {
      outcome: "DIGEST_EMAIL_NOT_PENDING",
      deliveryId: IDS.deliveryA,
    });
    assert.equal(harness.providerCalls.length, 0);
    assert.equal(stored.email.state, "FAILED");
    assert.equal(stored.email.attempts, 1);
    assertReadStatePreserved(stored);
  },
);

await check(
  "rollout state does not reopen an ordinary FAILED delivery",
  async () => {
    const harness = createProcessHarness({
      delivery: makeReadRetryDelivery(),
      featureEnabled: false,
    });

    const result = await harness.run();
    const stored = harness.store.get(IDS.deliveryA);
    assert.equal(result.outcome, "DIGEST_EMAIL_NOT_PENDING");
    assert.equal(stored.email.state, "FAILED");
    assert.equal(stored.email.attempts, 1);
    assert.equal(harness.featureCalls.length, 0);
    assert.equal(harness.providerCalls.length, 0);
    assertReadStatePreserved(stored);
  },
);

await check(
  "preference state does not reopen an ordinary FAILED delivery",
  async () => {
    const harness = createProcessHarness({
      delivery: makeReadRetryDelivery(),
      recipient: makeUser({
        digestPreferences: { emailEnabled: false },
      }),
    });

    const result = await harness.run();
    const stored = harness.store.get(IDS.deliveryA);
    assert.equal(result.outcome, "DIGEST_EMAIL_NOT_PENDING");
    assert.equal(stored.email.state, "FAILED");
    assert.equal(stored.email.attempts, 1);
    assert.equal(harness.userLookups.length, 0);
    assert.equal(harness.providerCalls.length, 0);
    assertReadStatePreserved(stored);
  },
);

await check(
  "weekly pre-authority failure cannot reopen an ordinary FAILED delivery",
  async () => {
    const delivery = makeDelivery({
      kind: WEEKLY_KIND,
      periodKey: "2026-03-16",
      summary: { kind: WEEKLY_KIND },
      status: "PARTIAL",
      email: {
        state: "FAILED",
        attempts: 1,
        lastError: "Earlier provider failure",
      },
      inApp: {
        state: "READ",
        availableAt: READ_AVAILABLE_AT,
        readAt: READ_AT,
      },
    });
    const store = createInMemoryDigestDelivery([delivery]);
    let featureCalls = 0;
    let providerCalls = 0;
    let activityCalls = 0;

    const result = await processDigestDeliveryJob(
      {
        _id: IDS.jobA,
        firmId: IDS.firm,
        payload: { deliveryId: IDS.deliveryA },
        requestId: "digest-pre-authority-failure-fixed",
      },
      {
        DigestDelivery: store.model,
        Firm: createLookupModel({ _id: IDS.firm, isActive: true }, []),
        User: createLookupModel(makeUser(), []),
        FirmMembership: createLookupModel(makeMembership(), []),
        AppConfig: {
          async isFeatureEnabled() {
            featureCalls += 1;
            throw new Error("feature lookup must not run");
          },
        },
        sendDigestEmail: async () => {
          providerCalls += 1;
          return { data: { id: "must-not-send" } };
        },
        safeRecordActivity: async () => {
          activityCalls += 1;
        },
        clock: () => new Date(FIXED_NOW),
      },
    );

    const stored = store.get(IDS.deliveryA);
    assert.deepEqual(result, {
      outcome: "DIGEST_EMAIL_NOT_PENDING",
      deliveryId: IDS.deliveryA,
    });
    assert.equal(stored.email.state, "FAILED");
    assert.equal(stored.email.attempts, 1);
    assert.equal(stored.email.claimToken, null);
    assertReadStatePreserved(stored);
    assert.equal(featureCalls, 0);
    assert.equal(providerCalls, 0);
    assert.equal(activityCalls, 0);
  },
);

await check(
  "different delivery ids keep the same exact business/provider key",
  () => {
    const business = {
      firmId: IDS.firm,
      kind: DAILY_KIND,
      periodKey: "2026-03-20",
      recipientUserId: IDS.recipient,
    };
    const first = digestBusinessIdentity({
      ...business,
      deliveryId: IDS.deliveryA,
    });
    const second = digestBusinessIdentity({
      ...business,
      deliveryId: IDS.deliveryB,
    });

    assert.equal(first, second);
    assert.equal(first, expectedBusinessKey());
  },
);

await check("each digest business field changes the provider key", () => {
  const base = {
    firmId: IDS.firm,
    kind: DAILY_KIND,
    periodKey: "2026-03-20",
    recipientUserId: IDS.recipient,
  };
  const original = digestBusinessIdentity(base);
  const changed = [
    { ...base, firmId: IDS.otherFirm },
    { ...base, kind: WEEKLY_KIND },
    { ...base, periodKey: "2026-03-21" },
    { ...base, recipientUserId: IDS.otherRecipient },
  ].map(digestBusinessIdentity);

  assert.equal(new Set([original, ...changed]).size, 5);
  for (const key of changed) assert.notEqual(key, original);
});

await check(
  "enqueueRecipientDigest passes the exact business identity to enqueueJob",
  async () => {
    const delivery = makeDelivery({ automationJobId: null });
    const deliveryModel = createMatchedNoOpLinkDeliveryModel(delivery);
    const jobCalls = [];
    const automationJobs = createInMemoryAutomationJob();

    const result = await enqueueRecipientDigest(
      {
        firm: { _id: IDS.firm, timezone: "UTC" },
        recipient: makeUser(),
        kind: DAILY_KIND,
        periodKey: "2026-03-20",
        noticeCasesEnabled: false,
        now: new Date(FIXED_NOW),
      },
      {
        AutomationJob: automationJobs.model,
        DigestDelivery: deliveryModel.model,
        enqueueJob: async (input) => {
          jobCalls.push(clone(input));
          const job = makeAutomationJob({
            idempotencyKey: input.idempotencyKey,
            payload: input.payload,
          });
          automationJobs.insert(job);
          return clone(job);
        },
      },
    );

    assert.equal(result._id, IDS.deliveryA);
    const businessLookup = deliveryModel.operations.find(
      (operation) =>
        operation.method === "findOne" &&
        queryHasLiteralEquality(operation.filter, "periodKey", "2026-03-20") &&
        queryHasLiteralEquality(operation.filter, "kind", DAILY_KIND),
    );
    assert.ok(businessLookup);
    assertStrictObjectIdEquality(businessLookup.filter, "firmId", IDS.firm);
    assertStrictObjectIdEquality(
      businessLookup.filter,
      "recipientUserId",
      IDS.recipient,
    );
    assertStrictStringEquality(businessLookup.filter, "kind", DAILY_KIND);
    assertStrictStringEquality(
      businessLookup.filter,
      "periodKey",
      "2026-03-20",
    );
    assertFilterAccepts(businessLookup.filter, delivery);
    assertFilterRejects(
      businessLookup.filter,
      { ...delivery, firmId: IDS.otherFirm },
      "business lookup cross-firm guard",
    );
    assert.equal(jobCalls.length, 1);
    assert.deepEqual(jobCalls[0], {
      firmId: IDS.firm,
      kind: "DIGEST_DELIVERY",
      idempotencyKey: expectedBusinessKey(),
      payload: { deliveryId: IDS.deliveryA },
      createdBy: IDS.recipient,
      requestId: "digest-scheduler:2026-03-20",
      maxAttempts: 5,
    });
    assertMatchedNoOpLinkCas(deliveryModel.operations, delivery, IDS.jobA);
  },
);

await check(
  "new digest insert persists and enqueues the exact business identity",
  async () => {
    const insertOperations = [];
    const jobCalls = [];
    const automationJobs = createInMemoryAutomationJob();
    let insertedStore = null;
    const DigestDelivery = {
      findOne(filter) {
        return insertedStore
          ? insertedStore.model.findOne(filter)
          : Promise.resolve(null);
      },
      async findOneAndUpdate(filter, update, options) {
        if (!update.$setOnInsert) {
          return insertedStore.model.findOneAndUpdate(filter, update, options);
        }
        insertOperations.push({
          filter: clone(filter),
          update: clone(update),
          options: clone(options),
        });
        const inserted = makeDelivery({
          ...update.$setOnInsert,
          _id: IDS.deliveryA,
          automationJobId: null,
          email: update.$setOnInsert.email,
          inApp: update.$setOnInsert.inApp,
        });
        insertedStore = createInMemoryDigestDelivery([inserted]);
        return clone(inserted);
      },
      async updateOne(filter, update) {
        return insertedStore.model.updateOne(filter, update);
      },
    };

    const delivery = await enqueueRecipientDigest(
      {
        firm: { _id: IDS.firm, timezone: "UTC" },
        recipient: makeUser(),
        kind: DAILY_KIND,
        periodKey: "2026-03-20",
        noticeCasesEnabled: false,
        now: new Date(FIXED_NOW),
      },
      {
        AutomationJob: automationJobs.model,
        DigestDelivery,
        buildDigestSummary: async () => makeDelivery().summary,
        enqueueJob: async (input) => {
          jobCalls.push(clone(input));
          const job = makeAutomationJob({
            _id: IDS.jobA,
            idempotencyKey: input.idempotencyKey,
          });
          automationJobs.insert(job);
          return clone(job);
        },
      },
    );

    assert.equal(
      insertOperations[0].update.$setOnInsert.email.idempotencyKey,
      expectedBusinessKey(),
    );
    assert.equal(delivery.email.idempotencyKey, expectedBusinessKey());
    assert.equal(jobCalls[0].idempotencyKey, expectedBusinessKey());
    assertMatchedNoOpLinkCas(
      insertedStore.operations,
      makeDelivery({ automationJobId: null }),
      IDS.jobA,
    );
  },
);

await check(
  "stale SENDING transaction-fences reactivation of its exact linked FAILED job",
  async () => {
    const failedJob = makeAutomationJob({
      status: "FAILED",
      attemptCount: 5,
      maxAttempts: 6,
      idempotencyKey: `digest-delivery:${IDS.deliveryA}`,
    });
    const automationJobs = createInMemoryAutomationJob([failedJob]);
    const delivery = makeDelivery({
      automationJobId: IDS.jobA,
      email: {
        state: "SENDING",
        claimToken: "dead-worker",
        claimedAt: new Date(FIXED_NOW.getTime() - SEND_CLAIM_STALE_MS - 1),
      },
    });
    const deliveryModel = createMatchedNoOpLinkDeliveryModel(delivery);

    await enqueueRecipientDigest(
      {
        firm: { _id: IDS.firm, timezone: "UTC" },
        recipient: makeUser(),
        kind: DAILY_KIND,
        periodKey: "2026-03-20",
        noticeCasesEnabled: false,
        now: new Date(FIXED_NOW),
      },
      {
        AutomationJob: automationJobs.model,
        DigestDelivery: deliveryModel.model,
        enqueueJob: async () => {
          throw new Error("parallel business job was created");
        },
      },
    );

    assertMatchedNoOpLinkCas(deliveryModel.operations, delivery, IDS.jobA);
    const reactivation = automationJobs.operations.find(
      (operation) =>
        operation.method === "findOneAndUpdate" &&
        operation.update?.$set?.status === "PENDING",
    );
    assert.ok(reactivation);
    assertStrictObjectIdEquality(reactivation.filter, "_id", IDS.jobA);
    assertStrictObjectIdEquality(reactivation.filter, "firmId", IDS.firm);
    assertStrictStringEquality(reactivation.filter, "status", "FAILED");
    assertLiteralEquality(reactivation.filter, "attemptCount", 5);
    assertLiteralEquality(reactivation.filter, "maxAttempts", 6);
    assertStrictStringEquality(
      reactivation.filter,
      "payload.deliveryId",
      IDS.deliveryA,
    );
    assert.equal(reactivation.update.$set.maxAttempts, 10);
    assert.equal(
      reactivation.update.$set.nextAttemptAt.toISOString(),
      FIXED_NOW.toISOString(),
    );
    assert.ok(reactivation.options.session?.id);
    const deliveryFence = deliveryModel.operations.find(
      (operation) =>
        operation.method === "updateOne" &&
        operation.options?.session &&
        operation.update?.$set?.["email.state"] === "PENDING",
    );
    assert.ok(deliveryFence);
    assertStrictObjectIdEquality(
      deliveryFence.filter,
      "automationJobId",
      IDS.jobA,
    );
    assertLiteralEquality(deliveryFence.filter, "jobRecovery.revision", 1);
    assert.equal(
      queryHasDirectCondition(
        deliveryFence.filter,
        "jobRecovery.expiresAt",
        (condition) => condition?.$gt instanceof Date,
      ),
      true,
    );
    assert.equal(automationJobs.get(IDS.jobA).status, "PENDING");
  },
);

await check(
  "recognized active legacy job is linked without a parallel business job",
  async () => {
    const legacyJob = makeAutomationJob({
      idempotencyKey: `digest-delivery:${IDS.deliveryA}`,
      status: "RETRY_SCHEDULED",
    });
    const automationJobs = createInMemoryAutomationJob([legacyJob]);
    const delivery = makeDelivery({ automationJobId: null });
    const deliveryModel = createMatchedNoOpLinkDeliveryModel(delivery);

    await enqueueRecipientDigest(
      {
        firm: { _id: IDS.firm, timezone: "UTC" },
        recipient: makeUser(),
        kind: DAILY_KIND,
        periodKey: "2026-03-20",
        noticeCasesEnabled: false,
        now: new Date(FIXED_NOW),
      },
      {
        AutomationJob: automationJobs.model,
        DigestDelivery: deliveryModel.model,
        enqueueJob: async () => {
          throw new Error("parallel business job was created");
        },
      },
    );

    assertStrictStringEquality(
      automationJobs.operations[0].filter,
      "idempotencyKey",
      `digest-delivery:${IDS.deliveryA}`,
    );
    assertMatchedNoOpLinkCas(deliveryModel.operations, delivery, IDS.jobA);
  },
);

await check(
  "ordinary FAILED delivery is not reactivated by scheduler reconciliation",
  async () => {
    const delivery = makeDelivery({
      automationJobId: IDS.jobA,
      email: { state: "FAILED", lastError: "Provider retries exhausted" },
    });
    await enqueueRecipientDigest(
      {
        firm: { _id: IDS.firm, timezone: "UTC" },
        recipient: makeUser(),
        kind: DAILY_KIND,
        periodKey: "2026-03-20",
        noticeCasesEnabled: false,
        now: new Date(FIXED_NOW),
      },
      {
        AutomationJob: {
          findOne() {
            throw new Error("FAILED delivery must not query jobs");
          },
        },
        DigestDelivery: {
          async findOne() {
            return clone(delivery);
          },
        },
        enqueueJob: async () => {
          throw new Error("FAILED delivery must not enqueue jobs");
        },
        runRecoveryTransaction: async () => {
          throw new Error("FAILED delivery must not open a transaction");
        },
      },
    );
  },
);

await check(
  "same-business SUCCEEDED job terminalizes delivery without duplication or reactivation",
  async () => {
    const terminalJob = makeAutomationJob({
      status: "SUCCEEDED",
      attemptCount: 2,
      maxAttempts: 9,
      completedAt: new Date(FIXED_NOW.getTime() - 60 * 1000),
      resultSummary: { outcome: "completed" },
      lease: { owner: "completed-worker" },
    });
    const activeAlternative = makeAutomationJob({
      _id: IDS.jobB,
      status: "PENDING",
      idempotencyKey: expectedBusinessKey(),
    });
    const automationJobs = createInMemoryAutomationJob([
      terminalJob,
      activeAlternative,
    ]);
    const delivery = makeDelivery({ automationJobId: IDS.jobA });
    const deliveryModel = createMatchedNoOpLinkDeliveryModel(delivery);
    let enqueueCalls = 0;

    await enqueueRecipientDigest(
      {
        firm: { _id: IDS.firm, timezone: "UTC" },
        recipient: makeUser(),
        kind: DAILY_KIND,
        periodKey: "2026-03-20",
        noticeCasesEnabled: false,
        now: new Date(FIXED_NOW),
      },
      {
        AutomationJob: automationJobs.model,
        DigestDelivery: deliveryModel.model,
        enqueueJob: async () => {
          enqueueCalls += 1;
          return clone(terminalJob);
        },
      },
    );

    assert.equal(enqueueCalls, 0);
    assertMatchedNoOpLinkCas(deliveryModel.operations, delivery, IDS.jobA);
    assertRecoveryTerminalized(deliveryModel.get(IDS.deliveryA));
    assert.deepEqual(automationJobs.get(IDS.jobA), terminalJob);
    assert.deepEqual(automationJobs.get(IDS.jobB), activeAlternative);
    assert.equal(
      automationJobs.operations.some((operation) =>
        queryHasLiteralEquality(
          operation.filter,
          "idempotencyKey",
          expectedBusinessKey(),
        ),
      ),
      false,
      "linked terminal job must win before active alternatives",
    );
    assert.equal(
      automationJobs.operations.some(
        (operation) => operation.method === "findOneAndUpdate",
      ),
      false,
    );
    assert.ok(
      deliveryModel.operations.some(
        (operation) =>
          operation.method === "updateOne" &&
          operation.options?.session?.id &&
          operation.update?.$set?.status === "FAILED",
      ),
    );
  },
);

await check(
  "linked active job wins before legacy and business reconciliation",
  async () => {
    const linkedJob = makeAutomationJob({
      status: "PENDING",
      idempotencyKey: `digest-delivery:${IDS.deliveryA}`,
    });
    const businessJob = makeAutomationJob({
      _id: IDS.jobB,
      idempotencyKey: expectedBusinessKey(),
    });
    const automationJobs = createInMemoryAutomationJob([
      linkedJob,
      businessJob,
    ]);
    const delivery = makeDelivery({ automationJobId: IDS.jobA });
    const deliveryModel = createMatchedNoOpLinkDeliveryModel(delivery);
    let enqueueCalls = 0;

    await enqueueRecipientDigest(
      {
        firm: { _id: IDS.firm, timezone: "UTC" },
        recipient: makeUser(),
        kind: DAILY_KIND,
        periodKey: "2026-03-20",
        noticeCasesEnabled: false,
        now: new Date(FIXED_NOW),
      },
      {
        AutomationJob: automationJobs.model,
        DigestDelivery: deliveryModel.model,
        enqueueJob: async () => {
          enqueueCalls += 1;
          throw new Error("linked active job must prevent another enqueue");
        },
        runRecoveryTransaction: async () => {
          throw new Error("active job must not open a recovery transaction");
        },
      },
    );

    assert.equal(enqueueCalls, 0);
    assertMatchedNoOpLinkCas(deliveryModel.operations, delivery, IDS.jobA);
    const jobReads = automationJobs.operations.filter(
      (operation) => operation.method === "findOne",
    );
    assert.equal(jobReads.length, 2);
    for (const [index, operation] of jobReads.entries()) {
      assertStrictObjectIdEquality(
        operation.filter,
        "_id",
        IDS.jobA,
        `linked job read ${index + 1}`,
      );
      assertStrictObjectIdEquality(
        operation.filter,
        "firmId",
        IDS.firm,
        `linked firm read ${index + 1}`,
      );
      assertStrictStringEquality(
        operation.filter,
        "kind",
        "DIGEST_DELIVERY",
        `linked kind read ${index + 1}`,
      );
      assertStrictStringEquality(
        operation.filter,
        "payload.deliveryId",
        IDS.deliveryA,
        `linked payload read ${index + 1}`,
      );
      assert.equal(
        queryHasLiteralEquality(
          operation.filter,
          "idempotencyKey",
          expectedBusinessKey(),
        ),
        false,
      );
      assert.equal(
        queryHasLiteralEquality(
          operation.filter,
          "idempotencyKey",
          `digest-delivery:${IDS.deliveryA}`,
        ),
        false,
      );
    }
  },
);

await check(
  "PENDING delivery terminalizes under its linked FAILED authority",
  async () => {
    const failedJob = makeAutomationJob({
      status: "FAILED",
      attemptCount: 5,
      maxAttempts: 5,
    });
    const automationJobs = createInMemoryAutomationJob([failedJob]);
    const delivery = makeDelivery({ automationJobId: IDS.jobA });
    const deliveryModel = createMatchedNoOpLinkDeliveryModel(delivery);
    let enqueueCalls = 0;
    let transactionCalls = 0;

    await enqueueRecipientDigest(
      {
        firm: { _id: IDS.firm, timezone: "UTC" },
        recipient: makeUser(),
        kind: DAILY_KIND,
        periodKey: "2026-03-20",
        noticeCasesEnabled: false,
        now: new Date(FIXED_NOW),
      },
      {
        AutomationJob: automationJobs.model,
        DigestDelivery: deliveryModel.model,
        enqueueJob: async () => {
          enqueueCalls += 1;
          return clone(failedJob);
        },
        runRecoveryTransaction: async (work) => {
          transactionCalls += 1;
          return work({ id: "pending-linked-failed-transaction" });
        },
      },
    );

    assertMatchedNoOpLinkCas(deliveryModel.operations, delivery, IDS.jobA);
    assertRecoveryTerminalized(deliveryModel.get(IDS.deliveryA));
    assert.equal(automationJobs.get(IDS.jobA).status, "FAILED");
    assert.equal(automationJobs.get(IDS.jobA).attemptCount, 5);
    assert.equal(automationJobs.get(IDS.jobA).maxAttempts, 5);
    assert.equal(transactionCalls, 1);
    assert.equal(enqueueCalls, 0);
    assert.equal(
      automationJobs.operations.some(
        (operation) => operation.method === "findOneAndUpdate",
      ),
      false,
    );
  },
);

await check(
  "PENDING delivery terminalizes FAILED authority despite retry headroom",
  async () => {
    const failedJob = makeAutomationJob({
      status: "FAILED",
      attemptCount: 5,
      maxAttempts: 6,
      lastError: "original terminal failure",
    });
    const automationJobs = createInMemoryAutomationJob([failedJob]);
    const delivery = makeDelivery({ automationJobId: IDS.jobA });
    const deliveryModel = createMatchedNoOpLinkDeliveryModel(delivery);
    let enqueueCalls = 0;

    await enqueueRecipientDigest(
      {
        firm: { _id: IDS.firm, timezone: "UTC" },
        recipient: makeUser(),
        kind: DAILY_KIND,
        periodKey: "2026-03-20",
        noticeCasesEnabled: false,
        now: new Date(FIXED_NOW),
      },
      {
        AutomationJob: automationJobs.model,
        DigestDelivery: deliveryModel.model,
        enqueueJob: async () => {
          enqueueCalls += 1;
          throw new Error("linked FAILED authority must prevent enqueue");
        },
      },
    );

    assert.equal(enqueueCalls, 0);
    assertRecoveryTerminalized(deliveryModel.get(IDS.deliveryA));
    assert.deepEqual(automationJobs.get(IDS.jobA), failedJob);
    assert.equal(
      automationJobs.operations.some(
        (operation) => operation.method === "findOneAndUpdate",
      ),
      false,
    );
  },
);

await check(
  "PENDING delivery links deployed legacy FAILED work then terminalizes",
  async () => {
    const failedJob = makeAutomationJob({
      status: "FAILED",
      attemptCount: 5,
      maxAttempts: 5,
      idempotencyKey: `digest-delivery:${IDS.deliveryA}`,
    });
    const automationJobs = createInMemoryAutomationJob([failedJob]);
    const delivery = makeDelivery({ automationJobId: null });
    const deliveryModel = createMatchedNoOpLinkDeliveryModel(delivery);
    let enqueueCalls = 0;
    let transactionCalls = 0;

    await enqueueRecipientDigest(
      {
        firm: { _id: IDS.firm, timezone: "UTC" },
        recipient: makeUser(),
        kind: DAILY_KIND,
        periodKey: "2026-03-20",
        noticeCasesEnabled: false,
        now: new Date(FIXED_NOW),
      },
      {
        AutomationJob: automationJobs.model,
        DigestDelivery: deliveryModel.model,
        enqueueJob: async () => {
          enqueueCalls += 1;
          return clone(failedJob);
        },
        runRecoveryTransaction: async (work) => {
          transactionCalls += 1;
          return work({ id: "pending-legacy-failed-transaction" });
        },
      },
    );

    assertStrictStringEquality(
      automationJobs.operations[0].filter,
      "idempotencyKey",
      `digest-delivery:${IDS.deliveryA}`,
    );
    assertMatchedNoOpLinkCas(deliveryModel.operations, delivery, IDS.jobA);
    assertRecoveryTerminalized(deliveryModel.get(IDS.deliveryA));
    assert.equal(automationJobs.get(IDS.jobA).status, "FAILED");
    assert.equal(transactionCalls, 1);
    assert.equal(enqueueCalls, 0);
  },
);

await check(
  "stale orphaned SENDING transaction-fences its unlinked legacy FAILED job",
  async () => {
    const failedJob = makeAutomationJob({
      status: "FAILED",
      attemptCount: 5,
      maxAttempts: 6,
      idempotencyKey: `digest-delivery:${IDS.deliveryA}`,
    });
    const automationJobs = createInMemoryAutomationJob([failedJob]);
    const delivery = makeDelivery({
      automationJobId: null,
      email: {
        state: "SENDING",
        claimToken: "dead-worker",
        claimedAt: new Date(FIXED_NOW.getTime() - SEND_CLAIM_STALE_MS - 1),
      },
    });
    const deliveryModel = createMatchedNoOpLinkDeliveryModel(delivery);
    let enqueueCalls = 0;

    await enqueueRecipientDigest(
      {
        firm: { _id: IDS.firm, timezone: "UTC" },
        recipient: makeUser(),
        kind: DAILY_KIND,
        periodKey: "2026-03-20",
        noticeCasesEnabled: false,
        now: new Date(FIXED_NOW),
      },
      {
        AutomationJob: automationJobs.model,
        DigestDelivery: deliveryModel.model,
        enqueueJob: async () => {
          enqueueCalls += 1;
          return clone(failedJob);
        },
      },
    );

    assertStrictStringEquality(
      automationJobs.operations[0].filter,
      "idempotencyKey",
      `digest-delivery:${IDS.deliveryA}`,
    );
    assertMatchedNoOpLinkCas(deliveryModel.operations, delivery, IDS.jobA);
    const reactivation = automationJobs.operations.find(
      (operation) =>
        operation.method === "findOneAndUpdate" &&
        queryHasLiteralEquality(operation.filter, "status", "FAILED"),
    );
    assert.ok(reactivation?.options?.session?.id);
    assertStrictObjectIdEquality(reactivation.filter, "_id", IDS.jobA);
    assert.equal(automationJobs.get(IDS.jobA).status, "PENDING");
    assert.equal(deliveryModel.get(IDS.deliveryA).email.state, "PENDING");
    assert.equal(deliveryModel.get(IDS.deliveryA).email.claimToken, null);
    assert.equal(enqueueCalls, 0);
  },
);

await check(
  "PENDING delivery links business FAILED work then terminalizes",
  async () => {
    const failedJob = makeAutomationJob({
      status: "FAILED",
      attemptCount: 5,
      maxAttempts: 5,
      idempotencyKey: expectedBusinessKey(),
    });
    const automationJobs = createInMemoryAutomationJob([failedJob]);
    const delivery = makeDelivery({ automationJobId: null });
    const deliveryModel = createMatchedNoOpLinkDeliveryModel(delivery);
    const jobCalls = [];
    let transactionCalls = 0;

    await enqueueRecipientDigest(
      {
        firm: { _id: IDS.firm, timezone: "UTC" },
        recipient: makeUser(),
        kind: DAILY_KIND,
        periodKey: "2026-03-20",
        noticeCasesEnabled: false,
        now: new Date(FIXED_NOW),
      },
      {
        AutomationJob: automationJobs.model,
        DigestDelivery: deliveryModel.model,
        enqueueJob: async (input) => {
          jobCalls.push(clone(input));
          return clone(failedJob);
        },
        runRecoveryTransaction: async (work) => {
          transactionCalls += 1;
          return work({ id: "pending-business-failed-transaction" });
        },
      },
    );

    assertStrictStringEquality(
      automationJobs.operations[0].filter,
      "idempotencyKey",
      `digest-delivery:${IDS.deliveryA}`,
    );
    assertStrictStringEquality(
      automationJobs.operations[1].filter,
      "idempotencyKey",
      expectedBusinessKey(),
    );
    assert.equal(jobCalls.length, 0);
    assertMatchedNoOpLinkCas(deliveryModel.operations, delivery, IDS.jobA);
    assertRecoveryTerminalized(deliveryModel.get(IDS.deliveryA));
    assert.equal(automationJobs.get(IDS.jobA).status, "FAILED");
    assert.equal(transactionCalls, 1);
  },
);

await check(
  "orphaned stale SENDING delivery enqueues and links business work",
  async () => {
    const delivery = makeDelivery({
      automationJobId: null,
      email: {
        state: "SENDING",
        claimToken: "dead-worker",
        claimedAt: new Date(FIXED_NOW.getTime() - SEND_CLAIM_STALE_MS - 1),
      },
    });
    const automationJobs = createInMemoryAutomationJob();
    const deliveryModel = createMatchedNoOpLinkDeliveryModel(delivery);
    const jobCalls = [];

    await enqueueRecipientDigest(
      {
        firm: { _id: IDS.firm, timezone: "UTC" },
        recipient: makeUser(),
        kind: DAILY_KIND,
        periodKey: "2026-03-20",
        noticeCasesEnabled: false,
        now: new Date(FIXED_NOW),
      },
      {
        AutomationJob: automationJobs.model,
        DigestDelivery: deliveryModel.model,
        enqueueJob: async (input) => {
          jobCalls.push(clone(input));
          const job = makeAutomationJob({
            idempotencyKey: input.idempotencyKey,
          });
          automationJobs.insert(job);
          return job;
        },
      },
    );

    const legacyLookup = automationJobs.operations.find((operation) =>
      queryHasLiteralEquality(
        operation.filter,
        "idempotencyKey",
        `digest-delivery:${IDS.deliveryA}`,
      ),
    );
    const businessLookups = automationJobs.operations.filter((operation) =>
      queryHasLiteralEquality(
        operation.filter,
        "idempotencyKey",
        expectedBusinessKey(delivery),
      ),
    );
    assert.ok(legacyLookup);
    assert.ok(businessLookups.length >= 2);
    const persistedJobLookup = businessLookups.find((operation) =>
      queryHasLiteralEquality(operation.filter, "_id", IDS.jobA),
    );
    assert.ok(persistedJobLookup);
    assertStrictObjectIdEquality(persistedJobLookup.filter, "_id", IDS.jobA);
    assertStrictObjectIdEquality(persistedJobLookup.filter, "firmId", IDS.firm);
    assertStrictStringEquality(
      persistedJobLookup.filter,
      "kind",
      "DIGEST_DELIVERY",
    );
    assertStrictStringEquality(
      persistedJobLookup.filter,
      "idempotencyKey",
      expectedBusinessKey(delivery),
    );
    assertStrictStringEquality(
      persistedJobLookup.filter,
      "payload.deliveryId",
      IDS.deliveryA,
    );
    assert.equal(jobCalls.length, 1);
    assert.equal(jobCalls[0].idempotencyKey, expectedBusinessKey(delivery));
    assertMatchedNoOpLinkCas(deliveryModel.operations, delivery, IDS.jobA);
    assert.equal(deliveryModel.get(IDS.deliveryA).email.state, "PENDING");
  },
);

await check(
  "same-business exhausted CANCELLED job terminalizes delivery without reactivation",
  async () => {
    const terminalJob = makeAutomationJob({
      status: "CANCELLED",
      attemptCount: 5,
      maxAttempts: 5,
      completedAt: new Date(FIXED_NOW.getTime() - 60 * 1000),
      lease: { owner: "dead-worker" },
    });
    const automationJobs = createInMemoryAutomationJob([terminalJob]);
    const delivery = makeDelivery({ automationJobId: IDS.jobA });
    const deliveryModel = createMatchedNoOpLinkDeliveryModel(delivery);
    let enqueueCalls = 0;

    await enqueueRecipientDigest(
      {
        firm: { _id: IDS.firm, timezone: "UTC" },
        recipient: makeUser(),
        kind: DAILY_KIND,
        periodKey: "2026-03-20",
        noticeCasesEnabled: false,
        now: new Date(FIXED_NOW),
      },
      {
        AutomationJob: automationJobs.model,
        DigestDelivery: deliveryModel.model,
        enqueueJob: async () => {
          enqueueCalls += 1;
          return clone(terminalJob);
        },
      },
    );

    assert.equal(enqueueCalls, 0);
    assertMatchedNoOpLinkCas(deliveryModel.operations, delivery, IDS.jobA);
    assertRecoveryTerminalized(deliveryModel.get(IDS.deliveryA));
    assert.deepEqual(automationJobs.get(IDS.jobA), terminalJob);
    assert.equal(
      automationJobs.operations.some(
        (operation) => operation.method === "findOneAndUpdate",
      ),
      false,
    );
  },
);

await check(
  "stale SENDING delivery terminalizes under SUCCEEDED and CANCELLED authority",
  async () => {
    for (const terminalStatus of ["SUCCEEDED", "CANCELLED"]) {
      const claimedAt = new Date(FIXED_NOW.getTime() - SEND_CLAIM_STALE_MS - 1);
      const delivery = makeDelivery({
        email: {
          state: "SENDING",
          claimToken: `dead-${terminalStatus.toLowerCase()}-worker`,
          claimedAt,
        },
        inApp: {
          state: "READ",
          availableAt: READ_AVAILABLE_AT,
          readAt: READ_AT,
        },
      });
      const terminalJob = makeAutomationJob({
        status: terminalStatus,
        attemptCount: 5,
        maxAttempts: 6,
        completedAt: new Date(FIXED_NOW.getTime() - 60 * 1000),
      });
      const deliveryStore = createInMemoryDigestDelivery([delivery]);
      const automationJobs = createInMemoryAutomationJob([terminalJob]);
      let enqueueCalls = 0;

      await enqueueRecipientDigest(
        {
          firm: { _id: IDS.firm, timezone: "UTC" },
          recipient: makeUser(),
          kind: DAILY_KIND,
          periodKey: delivery.periodKey,
          noticeCasesEnabled: false,
          now: new Date(FIXED_NOW),
        },
        {
          AutomationJob: automationJobs.model,
          DigestDelivery: deliveryStore.model,
          recoveryClock: () => new Date(FIXED_NOW),
          enqueueJob: async () => {
            enqueueCalls += 1;
            throw new Error(
              "terminal authority must prevent duplicate enqueue",
            );
          },
        },
      );

      const terminalWrite = deliveryStore.operations.find(
        (operation) =>
          operation.method === "updateOne" &&
          operation.options?.session?.id &&
          operation.update?.$set?.status === "FAILED",
      );
      const fencedJobRead = automationJobs.operations.find(
        (operation) =>
          operation.method === "findOne" &&
          operation.session?.id &&
          queryHasLiteralEquality(operation.filter, "status", terminalStatus),
      );
      assert.equal(enqueueCalls, 0, terminalStatus);
      assertRecoveryTerminalized(deliveryStore.get(IDS.deliveryA));
      assert.deepEqual(automationJobs.get(IDS.jobA), terminalJob);
      assertStrictObjectIdEquality(
        terminalWrite.filter,
        "firmId",
        IDS.firm,
        terminalStatus,
      );
      assertStrictObjectIdEquality(
        terminalWrite.filter,
        "automationJobId",
        IDS.jobA,
        terminalStatus,
      );
      assertLiteralEquality(
        terminalWrite.filter,
        "email.claimToken",
        delivery.email.claimToken,
        terminalStatus,
      );
      assertLiteralEquality(
        terminalWrite.filter,
        "email.claimedAt",
        claimedAt,
        terminalStatus,
      );
      assertStrictStringEquality(
        fencedJobRead.filter,
        "payload.deliveryId",
        IDS.deliveryA,
        terminalStatus,
      );
      assert.equal(
        automationJobs.operations.some(
          (operation) => operation.method === "findOneAndUpdate",
        ),
        false,
        terminalStatus,
      );
    }
  },
);

await check(
  "disabled post-rollover tick retries old-period SENDING through real enqueue",
  async () => {
    const rolloverNow = new Date("2026-03-21T00:01:00.000Z");
    const claimedBeforeMidnight = new Date("2026-03-20T23:59:00.000Z");
    const oldDelivery = makeDelivery({
      automationJobId: IDS.jobA,
      periodKey: "2026-03-20",
      email: {
        state: "SENDING",
        claimToken: "",
        claimedAt: claimedBeforeMidnight,
      },
    });
    const businessIdentity = expectedBusinessKey(oldDelivery);
    const failedJob = makeAutomationJob({
      _id: IDS.jobA,
      idempotencyKey: businessIdentity,
      status: "FAILED",
      attemptCount: 5,
      maxAttempts: 6,
    });
    const deliveryStore = createInMemoryDigestDelivery([oldDelivery]);
    const automationJobs = createInMemoryAutomationJob([failedJob]);
    const recoveryOperations = [];
    const deliveryLookups = [];
    const linkCasOperations = [];
    const featureCalls = [];
    const recoveryCursor = createInMemoryDigestRecoveryCursor();
    let realEnqueueCalls = 0;

    const DigestDelivery = {
      find(filter) {
        const operation = { method: "find", filter: clone(filter) };
        recoveryOperations.push(operation);
        const current = deliveryStore.get(IDS.deliveryA);
        const rows = current && matchesFilter(current, filter) ? [current] : [];
        return makeFindQuery(rows, operation);
      },
      async findOneAndUpdate(filter, update, options) {
        return deliveryStore.model.findOneAndUpdate(filter, update, options);
      },
      async findOne(filter) {
        deliveryLookups.push(clone(filter));
        const current = deliveryStore.get(IDS.deliveryA);
        return current && matchesFilter(current, filter) ? current : null;
      },
      async updateOne(filter, update) {
        const storedResult = await deliveryStore.model.updateOne(
          filter,
          update,
        );
        const result = {
          matchedCount: storedResult.matchedCount,
          modifiedCount: 0,
        };
        linkCasOperations.push({
          method: "updateOne",
          filter: clone(filter),
          update: clone(update),
          result: clone(result),
        });
        return result;
      },
    };
    const AppConfig = {
      async isFeatureEnabled(name, options) {
        featureCalls.push({ name, options: clone(options) });
        return false;
      },
    };

    const result = await enqueueDueDigests(
      { now: rolloverNow },
      {
        AppConfig,
        DigestDelivery,
        DigestRecoveryCursor: recoveryCursor.model,
        recoveryClock: () => new Date(rolloverNow),
        Firm: {
          find() {
            throw new Error(
              "disabled current-period scheduling must not scan firms",
            );
          },
        },
        FirmMembership: {
          find() {
            throw new Error(
              "rollover recovery must not require a membership scan",
            );
          },
        },
        User: {
          find() {
            throw new Error("rollover recovery must not require a user scan");
          },
        },
        enqueueRecipientDigest: async (input) => {
          realEnqueueCalls += 1;
          return enqueueRecipientDigest(input, {
            AutomationJob: automationJobs.model,
            DigestDelivery,
            enqueueJob: async () => {
              throw new Error("existing failed job must prevent new enqueue");
            },
          });
        },
      },
    );

    assert.deepEqual(result, {
      firms: 0,
      daily: 0,
      weekly: 0,
      disabled: true,
    });
    assert.deepEqual(
      featureCalls.map((call) => call.name),
      ["dailyDigest", "weeklySummary", "noticeCases"],
    );
    assert.equal(realEnqueueCalls, 1);
    assert.equal(recoveryOperations.length, 2);
    assert.deepEqual(recoveryOperations[0].filter, {});
    assert.deepEqual(recoveryOperations[0].sort, { _id: -1 });
    assert.equal(recoveryOperations[0].limit, 1);
    assert.deepEqual(Object.keys(recoveryOperations[1].filter), ["_id"]);
    assert.equal(recoveryOperations[1].filter._id.$lte, IDS.deliveryA);
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        recoveryOperations[1].filter,
        "email.state",
      ),
      false,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(recoveryOperations[1].filter, "$or"),
      false,
    );
    assert.ok(
      claimedBeforeMidnight.getTime() >
        rolloverNow.getTime() - SEND_CLAIM_STALE_MS,
      "empty claim token must recover before claimedAt becomes stale",
    );
    assert.deepEqual(recoveryOperations[1].sort, { _id: 1 });
    assert.equal(recoveryOperations[1].limit, 100);
    assert.ok(deliveryLookups.length >= 2);
    const businessDeliveryLookup = deliveryLookups.find(
      (filter) =>
        queryHasLiteralEquality(filter, "kind", DAILY_KIND) &&
        queryHasLiteralEquality(filter, "periodKey", "2026-03-20"),
    );
    assert.ok(businessDeliveryLookup);
    assertStrictObjectIdEquality(businessDeliveryLookup, "firmId", IDS.firm);
    assertStrictObjectIdEquality(
      businessDeliveryLookup,
      "recipientUserId",
      IDS.recipient,
    );
    const transactionDeliveryLookup = deliveryLookups.find((filter) =>
      queryHasLiteralEquality(filter, "jobRecovery.revision", 1),
    );
    assert.ok(transactionDeliveryLookup);
    assertStrictObjectIdEquality(
      transactionDeliveryLookup,
      "_id",
      IDS.deliveryA,
    );
    assertStrictObjectIdEquality(transactionDeliveryLookup, "firmId", IDS.firm);
    assertStrictObjectIdEquality(
      transactionDeliveryLookup,
      "automationJobId",
      IDS.jobA,
    );
    assert.equal(
      queryContains(transactionDeliveryLookup, (node) =>
        Object.prototype.hasOwnProperty.call(node, "jobRecovery.token"),
      ),
      false,
      "recovery token must be compared through $literal",
    );
    assert.equal(businessIdentity, expectedBusinessKey(oldDelivery));
    const linkedJobRead = automationJobs.operations.find(
      (operation) =>
        operation.method === "findOne" &&
        queryHasLiteralEquality(operation.filter, "_id", IDS.jobA),
    );
    assert.ok(linkedJobRead);
    assertStrictObjectIdEquality(linkedJobRead.filter, "firmId", IDS.firm);
    assertStrictStringEquality(linkedJobRead.filter, "kind", "DIGEST_DELIVERY");
    assertStrictStringEquality(
      linkedJobRead.filter,
      "payload.deliveryId",
      IDS.deliveryA,
    );
    assert.equal(
      queryHasLiteralEquality(
        linkedJobRead.filter,
        "idempotencyKey",
        businessIdentity,
      ),
      false,
      "valid linked authority must win before business-key alternatives",
    );
    const reactivation = automationJobs.operations.find(
      (operation) =>
        operation.method === "findOneAndUpdate" &&
        operation.update?.$set?.status === "PENDING",
    );
    assert.ok(reactivation);
    assertLiteralEquality(reactivation.filter, "attemptCount", 5);
    assert.equal(reactivation.update.$set.maxAttempts, 10);
    assert.ok(reactivation.options.session?.id);
    assertMatchedNoOpLinkCas(deliveryStore.operations, oldDelivery, IDS.jobA);
    assert.equal(automationJobs.get(IDS.jobA).status, "PENDING");
  },
);

await check(
  "durable recovery cursor reaches rows beyond 500 on the next bounded tick",
  async () => {
    const deliveries = Array.from({ length: 550 }, (_, index) =>
      makeRecoverableDelivery(index + 1),
    );
    const deliveryStore = createInMemoryDigestDelivery(deliveries);
    const recoveryCursor = createInMemoryDigestRecoveryCursor();
    const recoveredPeriods = [];

    const firstResult = await runDisabledDigestRecovery({
      deliveryModel: deliveryStore.model,
      cursorModel: recoveryCursor.model,
      recover: async ({ periodKey }) => {
        recoveredPeriods.push(periodKey);
      },
    });

    assert.deepEqual(firstResult, {
      firms: 0,
      daily: 0,
      weekly: 0,
      disabled: true,
    });
    assert.equal(DIGEST_RECOVERY_BATCH_SIZE, 100);
    assert.equal(DIGEST_RECOVERY_MAX_BATCHES, 5);
    assert.equal(recoveredPeriods.length, 500);
    assert.equal(recoveredPeriods[0], "recovery-0001");
    assert.equal(recoveredPeriods.at(-1), "recovery-0500");
    const firstHighWaterFinds = deliveryStore.operations.filter(
      (operation) => operation.method === "find" && operation.sort?._id === -1,
    );
    const firstBatchFinds = deliveryStore.operations.filter(
      (operation) => operation.method === "find" && operation.sort?._id === 1,
    );
    assert.equal(firstHighWaterFinds.length, 1);
    assert.equal(firstHighWaterFinds[0].limit, 1);
    assert.equal(firstBatchFinds.length, DIGEST_RECOVERY_MAX_BATCHES);
    assert.ok(
      firstBatchFinds.every(
        (operation) => operation.limit === DIGEST_RECOVERY_BATCH_SIZE,
      ),
    );
    for (const [batchIndex, operation] of firstBatchFinds.entries()) {
      assert.deepEqual(Object.keys(operation.filter), ["_id"]);
      assert.equal(operation.filter._id.$lte, orderedObjectId(550));
      assert.equal(
        operation.filter._id.$gt,
        batchIndex === 0 ? undefined : orderedObjectId(batchIndex * 100),
      );
    }
    assert.equal(recoveryCursor.get().afterId, orderedObjectId(500));
    assert.equal(recoveryCursor.get().cycleEndId, orderedObjectId(550));
    assert.equal(recoveryCursor.get().lease.token, null);
    assert.equal(recoveryCursor.get().lease.expiresAt, null);

    const batchFindCountBeforeSecondTick = firstBatchFinds.length;
    await runDisabledDigestRecovery({
      deliveryModel: deliveryStore.model,
      cursorModel: recoveryCursor.model,
      recover: async ({ periodKey }) => {
        recoveredPeriods.push(periodKey);
      },
    });

    assert.equal(recoveredPeriods.length, 550);
    assert.deepEqual(
      recoveredPeriods.slice(500),
      Array.from(
        { length: 50 },
        (_, index) => `recovery-${String(index + 501).padStart(4, "0")}`,
      ),
    );
    const allBatchFinds = deliveryStore.operations.filter(
      (operation) => operation.method === "find" && operation.sort?._id === 1,
    );
    const secondTickFinds = allBatchFinds.slice(batchFindCountBeforeSecondTick);
    assert.equal(secondTickFinds.length, 1);
    assert.equal(secondTickFinds[0].limit, DIGEST_RECOVERY_BATCH_SIZE);
    assert.equal(secondTickFinds[0].filter._id.$gt, orderedObjectId(500));
    assert.equal(recoveryCursor.get().afterId, null);
    assert.equal(recoveryCursor.get().cycleEndId, null);
    assert.equal(recoveryCursor.get().lease.token, null);
    assert.equal(recoveryCursor.get().lease.expiresAt, null);
  },
);

await check(
  "moving recovery tail cannot starve a row behind the durable cursor",
  async () => {
    const deliveries = Array.from({ length: 600 }, (_, index) =>
      makeRecoverableDelivery(
        index + 1,
        index + 1 === 250
          ? {
              email: {
                state: "PENDING",
                claimToken: null,
                claimedAt: null,
              },
            }
          : {},
      ),
    );
    const deliveryStore = createInMemoryDigestDelivery(deliveries);
    const recoveryCursor = createInMemoryDigestRecoveryCursor();
    const recoveredPeriods = [];
    const recover = async ({ periodKey }) => {
      recoveredPeriods.push(periodKey);
    };

    await runDisabledDigestRecovery({
      deliveryModel: deliveryStore.model,
      cursorModel: recoveryCursor.model,
      recover,
    });
    assert.equal(recoveredPeriods.length, 500);
    assert.equal(recoveryCursor.get().afterId, orderedObjectId(500));
    assert.equal(recoveryCursor.get().cycleEndId, orderedObjectId(600));

    await deliveryStore.model.updateOne(
      { _id: orderedObjectId(250) },
      {
        $set: {
          "email.state": "SENDING",
          "email.claimToken": "",
          "email.claimedAt": new Date(FIXED_NOW),
        },
      },
    );
    for (let index = 601; index <= 1100; index += 1) {
      deliveryStore.insert(makeRecoverableDelivery(index));
    }

    const beforeSecondTick = recoveredPeriods.length;
    await runDisabledDigestRecovery({
      deliveryModel: deliveryStore.model,
      cursorModel: recoveryCursor.model,
      recover,
    });
    const secondTickPeriods = recoveredPeriods.slice(beforeSecondTick);
    assert.equal(secondTickPeriods.length, 100);
    assert.ok(
      secondTickPeriods.every(
        (periodKey) => Number(periodKey.replace("recovery-", "")) <= 600,
      ),
    );
    assert.equal(recoveryCursor.get().afterId, null);
    assert.equal(recoveryCursor.get().cycleEndId, null);

    const beforeWrappedTick = recoveredPeriods.length;
    await runDisabledDigestRecovery({
      deliveryModel: deliveryStore.model,
      cursorModel: recoveryCursor.model,
      recover,
    });
    const wrappedTickPeriods = recoveredPeriods.slice(beforeWrappedTick);
    assert.equal(wrappedTickPeriods.length, 500);
    assert.ok(wrappedTickPeriods.includes("recovery-0250"));
    assert.equal(recoveryCursor.get().cycleEndId, orderedObjectId(1100));
  },
);

await check(
  "poison recovery row cannot block later rows and is revisited after wrap",
  async () => {
    const deliveries = [1, 2, 3].map((index) => makeRecoverableDelivery(index));
    const deliveryStore = createInMemoryDigestDelivery(deliveries);
    const recoveryCursor = createInMemoryDigestRecoveryCursor();
    const attemptedPeriods = [];
    const reportedErrors = [];
    const recover = async ({ periodKey }) => {
      attemptedPeriods.push(periodKey);
      if (periodKey === "recovery-0002") {
        const error = new Error(
          "poison reviewer@example.test secret payload must not be logged",
        );
        error.code = "POISON_RECOVERY_ROW";
        throw error;
      }
    };

    await runDisabledDigestRecovery({
      deliveryModel: deliveryStore.model,
      cursorModel: recoveryCursor.model,
      recover,
      reportRecoveryError: async (entry) => {
        reportedErrors.push(clone(entry));
      },
    });

    assert.deepEqual(attemptedPeriods, [
      "recovery-0001",
      "recovery-0002",
      "recovery-0003",
    ]);
    assert.deepEqual(reportedErrors, [{ code: "POISON_RECOVERY_ROW" }]);
    const persistedPositions = recoveryCursor.operations
      .filter(
        (operation) =>
          operation.method === "updateOne" &&
          Object.prototype.hasOwnProperty.call(
            operation.update.$set || {},
            "afterId",
          ),
      )
      .map((operation) => operation.update.$set.afterId);
    assert.deepEqual(persistedPositions, [
      null,
      orderedObjectId(1),
      orderedObjectId(2),
      orderedObjectId(3),
      null,
    ]);
    assert.equal(recoveryCursor.get().afterId, null);

    // A persistent poison row must not freeze the original high-water mark.
    // The failed retry expands its next finite cycle to include this later row.
    deliveryStore.insert(makeRecoverableDelivery(4));
    await runDisabledDigestRecovery({
      deliveryModel: deliveryStore.model,
      cursorModel: recoveryCursor.model,
      recover,
      reportRecoveryError: async (entry) => {
        reportedErrors.push(clone(entry));
      },
    });

    assert.deepEqual(attemptedPeriods.slice(3), [
      "recovery-0001",
      "recovery-0002",
      "recovery-0003",
    ]);
    assert.equal(recoveryCursor.get().cycleEndId, orderedObjectId(4));

    await runDisabledDigestRecovery({
      deliveryModel: deliveryStore.model,
      cursorModel: recoveryCursor.model,
      recover,
      reportRecoveryError: async (entry) => {
        reportedErrors.push(clone(entry));
      },
    });

    assert.deepEqual(attemptedPeriods.slice(6), [
      "recovery-0001",
      "recovery-0002",
      "recovery-0003",
      "recovery-0004",
    ]);
    assert.deepEqual(reportedErrors, [
      { code: "POISON_RECOVERY_ROW" },
      { code: "POISON_RECOVERY_ROW" },
      { code: "POISON_RECOVERY_ROW" },
    ]);
  },
);

await check(
  "live legacy recovery lease blocks overlap while expired or implausible leases are reclaimed",
  async () => {
    const deliveryStore = createInMemoryDigestDelivery([
      makeRecoverableDelivery(1),
    ]);
    const liveUntil = new Date(
      FIXED_NOW.getTime() + DIGEST_RECOVERY_CURSOR_LEASE_MS,
    );
    const legacyLeaseToken = "00000000-0000-4000-8000-000000000002";
    const recoveryCursor = createInMemoryDigestRecoveryCursor({
      _id: DIGEST_RECOVERY_CURSOR_ID,
      afterId: null,
      lease: { token: legacyLeaseToken, expiresAt: liveUntil },
    });
    const recoveredPeriods = [];

    await runDisabledDigestRecovery({
      deliveryModel: deliveryStore.model,
      cursorModel: recoveryCursor.model,
      recover: async ({ periodKey }) => {
        recoveredPeriods.push(periodKey);
      },
    });

    assert.deepEqual(recoveredPeriods, []);
    assert.equal(
      deliveryStore.operations.filter(
        (operation) => operation.method === "find",
      ).length,
      0,
    );
    assert.equal(recoveryCursor.get().lease.token, legacyLeaseToken);

    await runDisabledDigestRecovery({
      deliveryModel: deliveryStore.model,
      cursorModel: recoveryCursor.model,
      recoveryClock: () => new Date(liveUntil.getTime() + 1),
      recover: async ({ periodKey }) => {
        recoveredPeriods.push(periodKey);
      },
    });

    assert.deepEqual(recoveredPeriods, ["recovery-0001"]);
    assert.equal(recoveryCursor.get().afterId, null);
    assert.equal(recoveryCursor.get().lease.token, null);
    assert.equal(recoveryCursor.get().lease.expiresAt, null);

    const farFutureDeliveryStore = createInMemoryDigestDelivery([
      makeRecoverableDelivery(2),
    ]);
    const farFutureCursor = createInMemoryDigestRecoveryCursor({
      _id: DIGEST_RECOVERY_CURSOR_ID,
      afterId: null,
      cycleEndId: orderedObjectId(2),
      lease: {
        token: "00000000-0000-4000-8000-000000000003",
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      },
    });
    const farFutureRecovered = [];
    await runDisabledDigestRecovery({
      deliveryModel: farFutureDeliveryStore.model,
      cursorModel: farFutureCursor.model,
      recoveryClock: () => new Date(FIXED_NOW),
      recover: async ({ periodKey }) => farFutureRecovered.push(periodKey),
    });
    assert.deepEqual(farFutureRecovered, ["recovery-0002"]);
    assert.deepEqual(farFutureCursor.get().lease, {
      token: null,
      expiresAt: null,
    });
  },
);

await check(
  "protected recovery states fence legacy workers while clean leases remain rollback-compatible",
  async () => {
    const ordinaryDeliveryStore = createInMemoryDigestDelivery([
      makeRecoverableDelivery(1),
    ]);
    const ordinaryCursor = createInMemoryDigestRecoveryCursor();
    let ordinaryActiveLease = null;
    await runDisabledDigestRecovery({
      deliveryModel: ordinaryDeliveryStore.model,
      cursorModel: ordinaryCursor.model,
      recover: async () => {
        ordinaryActiveLease = clone(ordinaryCursor.get().lease);
      },
    });
    const ordinaryActiveToken = assertDigestRecoveryActiveToken(
      ordinaryActiveLease.token,
      { failureCount: 0 },
    );
    assert.equal(
      ordinaryActiveLease.expiresAt.toISOString(),
      ordinaryActiveToken.expiresAt.toISOString(),
    );
    assert.equal(
      ordinaryActiveLease.expiresAt.toISOString(),
      new Date(
        FIXED_NOW.getTime() + DIGEST_RECOVERY_CURSOR_LEASE_MS,
      ).toISOString(),
    );
    assert.equal(
      oldDigestRecoveryLeaseIsClaimable(ordinaryActiveLease, FIXED_NOW),
      false,
    );
    assert.equal(
      oldDigestRecoveryLeaseIsClaimable(
        ordinaryActiveLease,
        new Date(ordinaryActiveLease.expiresAt.getTime() + 1),
      ),
      true,
    );
    assert.deepEqual(ordinaryCursor.get().lease, {
      token: null,
      expiresAt: null,
    });
    assert.equal(
      oldDigestRecoveryLeaseIsClaimable(ordinaryCursor.get().lease, FIXED_NOW),
      true,
    );

    const idleLease = {
      token: "drc1:0",
      expiresAt: DIGEST_RECOVERY_LEGACY_FENCE,
    };
    assert.equal(
      oldDigestRecoveryLeaseIsClaimable(idleLease, FIXED_NOW),
      false,
    );
    const idleDeliveryStore = createInMemoryDigestDelivery([
      makeRecoverableDelivery(2),
    ]);
    const idleCursor = createInMemoryDigestRecoveryCursor({
      _id: DIGEST_RECOVERY_CURSOR_ID,
      afterId: null,
      cycleEndId: orderedObjectId(2),
      lease: idleLease,
    });
    let protectedActiveLease = null;
    await runDisabledDigestRecovery({
      deliveryModel: idleDeliveryStore.model,
      cursorModel: idleCursor.model,
      recover: async () => {
        protectedActiveLease = clone(idleCursor.get().lease);
      },
    });
    assertDigestRecoveryActiveToken(protectedActiveLease.token, {
      failureCount: 0,
    });
    assertDigestRecoveryLegacyFence(protectedActiveLease.expiresAt);
    assert.equal(
      oldDigestRecoveryLeaseIsClaimable(protectedActiveLease, FIXED_NOW),
      false,
    );
    assert.deepEqual(idleCursor.get().lease, {
      token: null,
      expiresAt: null,
    });

    const activeExpiry = new Date(
      FIXED_NOW.getTime() + DIGEST_RECOVERY_CURSOR_LEASE_MS,
    );
    const activeLease = {
      token: digestRecoveryActiveToken({ expiresAt: activeExpiry }),
      expiresAt: DIGEST_RECOVERY_LEGACY_FENCE,
    };
    assert.equal(
      oldDigestRecoveryLeaseIsClaimable(activeLease, FIXED_NOW),
      false,
    );
    const activeDeliveryStore = createInMemoryDigestDelivery([
      makeRecoverableDelivery(3),
    ]);
    const activeCursor = createInMemoryDigestRecoveryCursor({
      _id: DIGEST_RECOVERY_CURSOR_ID,
      afterId: null,
      cycleEndId: orderedObjectId(3),
      lease: activeLease,
    });
    const activeRecovered = [];
    await runDisabledDigestRecovery({
      deliveryModel: activeDeliveryStore.model,
      cursorModel: activeCursor.model,
      recoveryClock: () => new Date(FIXED_NOW),
      recover: async ({ periodKey }) => activeRecovered.push(periodKey),
    });
    assert.deepEqual(activeRecovered, []);
    assert.deepEqual(activeCursor.get().lease, activeLease);

    await runDisabledDigestRecovery({
      deliveryModel: activeDeliveryStore.model,
      cursorModel: activeCursor.model,
      recoveryClock: () => new Date(activeExpiry.getTime() + 1),
      recover: async ({ periodKey }) => activeRecovered.push(periodKey),
    });
    assert.deepEqual(activeRecovered, ["recovery-0003"]);
    assert.deepEqual(activeCursor.get().lease, {
      token: null,
      expiresAt: null,
    });
    assert.equal(
      oldDigestRecoveryLeaseIsClaimable(activeCursor.get().lease, FIXED_NOW),
      true,
    );
  },
);

await check(
  "implausibly future recovery expiry is reclaimed without losing durable failures",
  async () => {
    const implausibleExpiry = new Date(
      FIXED_NOW.getTime() + 24 * 60 * 60 * 1000,
    );
    const implausibleToken = digestRecoveryActiveToken({
      failureCount: 2,
      expiresAt: implausibleExpiry,
    });
    const deliveryStore = createInMemoryDigestDelivery([
      makeRecoverableDelivery(1),
    ]);
    const recoveryCursor = createInMemoryDigestRecoveryCursor({
      _id: DIGEST_RECOVERY_CURSOR_ID,
      afterId: null,
      cycleEndId: orderedObjectId(1),
      lease: {
        token: implausibleToken,
        expiresAt: DIGEST_RECOVERY_LEGACY_FENCE,
      },
    });
    const recovered = [];
    const recover = async ({ periodKey }) => recovered.push(periodKey);

    await runDisabledDigestRecovery({
      deliveryModel: deliveryStore.model,
      cursorModel: recoveryCursor.model,
      recover,
    });

    assert.deepEqual(recovered, ["recovery-0001"]);
    const acquisition = recoveryCursor.operations.find(
      (operation) => operation.method === "findOneAndUpdate",
    );
    assertUpsertScalarEquality(
      acquisition.filter,
      "lease.token",
      implausibleToken,
      "implausible expiry acquisition snapshot",
    );
    assertDigestRecoveryActiveToken(acquisition.update.$set["lease.token"], {
      failureCount: 2,
    });
    assertDigestRecoveryLegacyFence(acquisition.update.$set["lease.expiresAt"]);
    assert.equal(recoveryCursor.get().afterId, null);
    assert.equal(recoveryCursor.get().cycleEndId, orderedObjectId(1));
    assert.equal(recoveryCursor.get().lease.token, "drc1:0");
    assertDigestRecoveryLegacyFence(recoveryCursor.get().lease.expiresAt);

    await runDisabledDigestRecovery({
      deliveryModel: deliveryStore.model,
      cursorModel: recoveryCursor.model,
      recover,
    });
    assert.deepEqual(recovered, ["recovery-0001", "recovery-0001"]);
    assert.equal(recoveryCursor.get().cycleEndId, null);
    assert.deepEqual(recoveryCursor.get().lease, {
      token: null,
      expiresAt: null,
    });
  },
);

await check(
  "legacy null and empty recovery tokens remain immediately claimable",
  async () => {
    for (const token of [null, ""]) {
      const liveUntil = new Date(
        FIXED_NOW.getTime() + DIGEST_RECOVERY_CURSOR_LEASE_MS,
      );
      const deliveryStore = createInMemoryDigestDelivery([
        makeRecoverableDelivery(1),
      ]);
      const recoveryCursor = createInMemoryDigestRecoveryCursor({
        _id: DIGEST_RECOVERY_CURSOR_ID,
        afterId: null,
        cycleEndId: orderedObjectId(1),
        lease: { token, expiresAt: liveUntil },
      });
      const recovered = [];

      await runDisabledDigestRecovery({
        deliveryModel: deliveryStore.model,
        cursorModel: recoveryCursor.model,
        recoveryClock: () => new Date(FIXED_NOW),
        recover: async ({ periodKey }) => recovered.push(periodKey),
      });
      assert.deepEqual(recovered, ["recovery-0001"], String(token));
      assert.equal(recoveryCursor.get().lease.token, null, String(token));
      assert.equal(recoveryCursor.get().lease.expiresAt, null, String(token));
    }
  },
);

await check(
  "invalid recovery cursor tokens fail closed without cursor mutation",
  async () => {
    const compactOwner = "00000000000040008000000000000001";
    const validExpiry = FIXED_NOW.getTime().toString(36);
    const malformedTokens = [
      7,
      { unexpected: true },
      "x".repeat(65),
      "legacy-short-token",
      "DRC1:0",
      "drc1:",
      "drc1:01",
      `drc1:${Number.MAX_SAFE_INTEGER}0`,
      `drc1:0:${compactOwner.slice(1)}:${validExpiry}`,
      `drc1:0:${compactOwner}:not-valid!`,
      `drc1:0:${compactOwner}:${(Number.MAX_SAFE_INTEGER + 1).toString(36)}`,
      `drc1:0:${compactOwner}:${validExpiry}:extra`,
      "drc1:0:00000000-0000-4000-8000-000000000001",
    ];

    for (const token of malformedTokens) {
      const label = `${typeof token}:${JSON.stringify(token)}`;
      const initial = {
        _id: DIGEST_RECOVERY_CURSOR_ID,
        afterId: orderedObjectId(1),
        cycleEndId: orderedObjectId(2),
        lease: { token, expiresAt: DIGEST_RECOVERY_LEGACY_FENCE },
      };
      const recoveryCursor = createInMemoryDigestRecoveryCursor(initial);
      await assert.rejects(
        () =>
          drainDigestRecovery(
            { now: new Date(FIXED_NOW) },
            {
              AppConfig: {
                async isFeatureEnabled() {
                  return false;
                },
              },
              DigestDelivery: {
                find() {
                  throw new Error("invalid marker must not scan deliveries");
                },
              },
              DigestRecoveryCursor: recoveryCursor.model,
              recoveryClock: () => new Date(FIXED_NOW),
            },
          ),
        (error) => {
          assert.equal(error.code, "DIGEST_RECOVERY_CURSOR_INVALID", label);
          assert.equal(Object.hasOwn(error, "rowFailureCount"), false, label);
          assert.equal(
            Object.hasOwn(error, "rowFailuresComplete"),
            false,
            label,
          );
          return true;
        },
      );
      assert.deepEqual(recoveryCursor.get(), initial, label);
      assert.equal(
        recoveryCursor.operations.some(
          (operation) => operation.method !== "findOne",
        ),
        false,
        label,
      );
    }
  },
);

await check(
  "simultaneous legacy FAILED and business PENDING chooses active business job",
  async () => {
    const legacyFailedJob = makeAutomationJob({
      _id: IDS.jobA,
      idempotencyKey: `digest-delivery:${IDS.deliveryA}`,
      status: "FAILED",
      attemptCount: 5,
      maxAttempts: 5,
    });
    const businessPendingJob = makeAutomationJob({
      _id: IDS.jobB,
      idempotencyKey: expectedBusinessKey(),
      status: "PENDING",
    });
    const automationJobs = createInMemoryAutomationJob([
      legacyFailedJob,
      businessPendingJob,
    ]);
    const delivery = makeDelivery({
      automationJobId: null,
      email: {
        state: "SENDING",
        claimToken: "dead-worker",
        claimedAt: new Date(FIXED_NOW.getTime() - SEND_CLAIM_STALE_MS - 1),
      },
    });
    const deliveryStore = createInMemoryDigestDelivery([delivery]);
    let enqueueCalls = 0;

    const result = await enqueueRecipientDigest(
      {
        firm: { _id: IDS.firm, timezone: "UTC" },
        recipient: makeUser(),
        kind: DAILY_KIND,
        periodKey: delivery.periodKey,
        noticeCasesEnabled: false,
        now: new Date(FIXED_NOW),
      },
      {
        AutomationJob: automationJobs.model,
        DigestDelivery: deliveryStore.model,
        enqueueJob: async () => {
          enqueueCalls += 1;
          throw new Error("existing active business job must prevent enqueue");
        },
      },
    );

    assert.equal(enqueueCalls, 0);
    assertObjectIdEquals(result.automationJobId, IDS.jobB);
    assertObjectIdEquals(
      deliveryStore.get(IDS.deliveryA).automationJobId,
      IDS.jobB,
    );
    assert.equal(deliveryStore.get(IDS.deliveryA).email.state, "PENDING");
    assertMatchedNoOpLinkCas(deliveryStore.operations, delivery, IDS.jobB);
  },
);

await check(
  "link CAS loss adopts concurrently linked business job without legacy retry",
  async () => {
    const legacyFailedJob = makeAutomationJob({
      _id: IDS.jobA,
      idempotencyKey: `digest-delivery:${IDS.deliveryA}`,
      status: "FAILED",
      attemptCount: 5,
      maxAttempts: 5,
    });
    const concurrentWinner = makeAutomationJob({
      _id: IDS.jobB,
      idempotencyKey: expectedBusinessKey(),
      status: "PENDING",
    });
    const automationJobs = createInMemoryAutomationJob([
      legacyFailedJob,
      concurrentWinner,
    ]);
    const initialDelivery = makeDelivery({
      automationJobId: null,
      email: {
        state: "SENDING",
        claimToken: "dead-worker",
        claimedAt: new Date(FIXED_NOW.getTime() - SEND_CLAIM_STALE_MS - 1),
      },
    });
    const deliveryStore = createInMemoryDigestDelivery([initialDelivery]);
    let winnerInjected = false;
    const DigestDelivery = {
      ...deliveryStore.model,
      async updateOne(filter, update) {
        if (
          !winnerInjected &&
          scalarEquals(update.$set?.automationJobId, IDS.jobB)
        ) {
          winnerInjected = true;
          await deliveryStore.model.updateOne(
            { _id: IDS.deliveryA },
            { $set: { automationJobId: objectIdFixture(IDS.jobB) } },
          );
        }
        return deliveryStore.model.updateOne(filter, update);
      },
    };
    let enqueueCalls = 0;

    const result = await enqueueRecipientDigest(
      {
        firm: { _id: IDS.firm, timezone: "UTC" },
        recipient: makeUser(),
        kind: DAILY_KIND,
        periodKey: initialDelivery.periodKey,
        noticeCasesEnabled: false,
        now: new Date(FIXED_NOW),
      },
      {
        AutomationJob: automationJobs.model,
        DigestDelivery,
        enqueueJob: async () => {
          enqueueCalls += 1;
          throw new Error("CAS winner must prevent business enqueue");
        },
      },
    );

    assert.equal(winnerInjected, true);
    assert.equal(enqueueCalls, 0);
    assertObjectIdEquals(
      deliveryStore.get(IDS.deliveryA).automationJobId,
      IDS.jobB,
    );
    assertObjectIdEquals(result.automationJobId, IDS.jobB);
  },
);

await check(
  "stale linked snapshot cannot retry FAILED loser after authoritative relink",
  async () => {
    const linkedFailedJob = makeAutomationJob({
      _id: IDS.jobA,
      idempotencyKey: `digest-delivery:${IDS.deliveryA}`,
      status: "FAILED",
      attemptCount: 5,
      maxAttempts: 5,
    });
    const concurrentWinner = makeAutomationJob({
      _id: IDS.jobB,
      idempotencyKey: "digest:concurrent-linked-winner",
      status: "PENDING",
    });
    const automationJobs = createInMemoryAutomationJob([
      linkedFailedJob,
      concurrentWinner,
    ]);
    const initialDelivery = makeDelivery({
      automationJobId: IDS.jobA,
      email: {
        state: "SENDING",
        claimToken: "dead-worker",
        claimedAt: new Date(FIXED_NOW.getTime() - SEND_CLAIM_STALE_MS - 1),
      },
    });
    const deliveryStore = createInMemoryDigestDelivery([initialDelivery]);
    let winnerInjected = false;
    const DigestDelivery = {
      ...deliveryStore.model,
      async updateOne(filter, update) {
        if (
          !winnerInjected &&
          scalarEquals(update.$set?.automationJobId, IDS.jobA)
        ) {
          winnerInjected = true;
          await deliveryStore.model.updateOne(
            { _id: IDS.deliveryA },
            { $set: { automationJobId: objectIdFixture(IDS.jobB) } },
          );
        }
        return deliveryStore.model.updateOne(filter, update);
      },
    };

    const result = await enqueueRecipientDigest(
      {
        firm: { _id: IDS.firm, timezone: "UTC" },
        recipient: makeUser(),
        kind: DAILY_KIND,
        periodKey: initialDelivery.periodKey,
        noticeCasesEnabled: false,
        now: new Date(FIXED_NOW),
      },
      {
        AutomationJob: automationJobs.model,
        DigestDelivery,
        enqueueJob: async () => {
          throw new Error("authoritative linked winner must prevent enqueue");
        },
      },
    );

    assert.equal(winnerInjected, true);
    assertObjectIdEquals(
      deliveryStore.get(IDS.deliveryA).automationJobId,
      IDS.jobB,
    );
    assertObjectIdEquals(result.automationJobId, IDS.jobB);
  },
);

await check(
  "live recovery lease blocks a competitor while transaction reactivates FAILED authority",
  async () => {
    const failedJob = makeAutomationJob({
      _id: IDS.jobA,
      idempotencyKey: `digest-delivery:${IDS.deliveryA}`,
      status: "FAILED",
      attemptCount: 5,
      maxAttempts: 6,
    });
    const automationJobs = createInMemoryAutomationJob([failedJob]);
    const delivery = makeDelivery({
      automationJobId: IDS.jobA,
      email: {
        state: "SENDING",
        claimToken: "dead-worker",
        claimedAt: new Date(FIXED_NOW.getTime() - SEND_CLAIM_STALE_MS - 1),
      },
    });
    const deliveryStore = createInMemoryDigestDelivery([delivery]);
    let transactionCalls = 0;
    let competingResult = null;

    await enqueueRecipientDigest(
      {
        firm: { _id: IDS.firm, timezone: "UTC" },
        recipient: makeUser(),
        kind: DAILY_KIND,
        periodKey: delivery.periodKey,
        noticeCasesEnabled: false,
        now: new Date(FIXED_NOW),
      },
      {
        AutomationJob: automationJobs.model,
        DigestDelivery: deliveryStore.model,
        enqueueJob: async () => {
          throw new Error("existing FAILED authority must prevent enqueue");
        },
        runRecoveryTransaction: async (work) => {
          transactionCalls += 1;
          const locked = deliveryStore.get(IDS.deliveryA);
          assertObjectIdEquals(locked.automationJobId, IDS.jobA);
          assert.equal(typeof locked.jobRecovery.token, "string");
          assert.ok(locked.jobRecovery.expiresAt > FIXED_NOW);
          assert.equal(locked.jobRecovery.revision, 1);

          automationJobs.insert(
            makeAutomationJob({
              _id: IDS.jobB,
              idempotencyKey: expectedBusinessKey(),
              status: "PENDING",
            }),
          );
          competingResult = await enqueueRecipientDigest(
            {
              firm: { _id: IDS.firm, timezone: "UTC" },
              recipient: makeUser(),
              kind: DAILY_KIND,
              periodKey: delivery.periodKey,
              noticeCasesEnabled: false,
              now: new Date(FIXED_NOW),
            },
            {
              AutomationJob: automationJobs.model,
              DigestDelivery: deliveryStore.model,
              enqueueJob: async () => {
                throw new Error("competing active job must not enqueue");
              },
              runRecoveryTransaction: async () => {
                throw new Error("live lease competitor opened transaction");
              },
            },
          );
          assertObjectIdEquals(
            deliveryStore.get(IDS.deliveryA).automationJobId,
            IDS.jobA,
          );
          return work({ id: "holder-transaction" });
        },
      },
    );

    assert.equal(transactionCalls, 1);
    assertObjectIdEquals(competingResult.automationJobId, IDS.jobA);
    assert.equal(automationJobs.get(IDS.jobA).status, "PENDING");
    assert.equal(automationJobs.get(IDS.jobB).status, "PENDING");
    const stored = deliveryStore.get(IDS.deliveryA);
    assertObjectIdEquals(stored.automationJobId, IDS.jobA);
    assert.equal(stored.email.state, "PENDING");
    assert.equal(stored.jobRecovery.token, null);
    assert.equal(stored.jobRecovery.expiresAt, null);
    assert.equal(stored.jobRecovery.revision, 1);
    assert.equal(
      deliveryStore.operations.some((operation) =>
        scalarEquals(operation.update?.$set?.automationJobId, IDS.jobB),
      ),
      false,
    );
    assert.equal(
      deliveryStore.operations.filter(
        (operation) =>
          operation.method === "findOneAndUpdate" &&
          operation.update?.$set?.["jobRecovery.token"],
      ).length,
      2,
    );
  },
);

await check(
  "authority CAS email snapshot blocks relink after send claim refresh",
  async () => {
    const activeBusinessJob = makeAutomationJob({
      _id: IDS.jobB,
      idempotencyKey: expectedBusinessKey(),
      status: "PENDING",
    });
    const automationJobs = createInMemoryAutomationJob([activeBusinessJob]);
    const staleClaimedAt = new Date(
      FIXED_NOW.getTime() - SEND_CLAIM_STALE_MS - 1,
    );
    const delivery = makeDelivery({
      automationJobId: IDS.pointerOnly,
      email: {
        state: "SENDING",
        claimToken: "dead-worker",
        claimedAt: staleClaimedAt,
      },
    });
    const deliveryStore = createInMemoryDigestDelivery([delivery]);
    const freshClaimedAt = new Date(FIXED_NOW);
    let authorityCas = null;
    const DigestDelivery = {
      ...deliveryStore.model,
      async updateOne(filter, update) {
        if (
          !authorityCas &&
          scalarEquals(update.$set?.automationJobId, IDS.jobB)
        ) {
          const refreshed = await deliveryStore.model.updateOne(
            { _id: IDS.deliveryA, firmId: IDS.firm },
            {
              $set: {
                "email.claimToken": "fresh-worker",
                "email.claimedAt": freshClaimedAt,
              },
            },
          );
          assert.equal(refreshed.matchedCount, 1);

          const refreshedDelivery = deliveryStore.get(IDS.deliveryA);
          assertFilterRejects(
            filter,
            refreshedDelivery,
            "authority CAS after fresh send claim",
          );
          assertLiteralEquality(filter, "email.state", "SENDING");
          assertLiteralEquality(filter, "email.claimToken", "dead-worker");
          assertLiteralEquality(filter, "email.claimedAt", staleClaimedAt);

          const result = await deliveryStore.model.updateOne(filter, update);
          authorityCas = {
            filter: clone(filter),
            update: clone(update),
            result: clone(result),
          };
          return result;
        }
        return deliveryStore.model.updateOne(filter, update);
      },
    };
    let enqueueCalls = 0;

    const result = await enqueueRecipientDigest(
      {
        firm: { _id: IDS.firm, timezone: "UTC" },
        recipient: makeUser(),
        kind: DAILY_KIND,
        periodKey: delivery.periodKey,
        noticeCasesEnabled: false,
        now: new Date(FIXED_NOW),
      },
      {
        AutomationJob: automationJobs.model,
        DigestDelivery,
        recoveryClock: () => new Date(FIXED_NOW),
        enqueueJob: async () => {
          enqueueCalls += 1;
          throw new Error("active business job must prevent enqueue");
        },
        runRecoveryTransaction: async () => {
          throw new Error("fresh claim must block terminal reactivation");
        },
      },
    );

    assert.ok(authorityCas);
    assertLiteralEquality(
      authorityCas.filter,
      "automationJobId",
      IDS.pointerOnly,
    );
    assertLiteralEquality(
      authorityCas.filter,
      "email.claimToken",
      "dead-worker",
    );
    assertLiteralEquality(
      authorityCas.filter,
      "email.claimedAt",
      staleClaimedAt,
    );
    assertObjectIdEquals(authorityCas.update.$set.automationJobId, IDS.jobB);
    assert.deepEqual(authorityCas.result, {
      matchedCount: 0,
      modifiedCount: 0,
    });
    assertObjectIdEquals(result.automationJobId, IDS.pointerOnly);
    assert.equal(enqueueCalls, 0);

    const stored = deliveryStore.get(IDS.deliveryA);
    assertObjectIdEquals(stored.automationJobId, IDS.pointerOnly);
    assert.equal(stored.email.state, "SENDING");
    assert.equal(stored.email.claimToken, "fresh-worker");
    assert.equal(stored.email.claimedAt.toISOString(), FIXED_NOW.toISOString());
  },
);

await check(
  "live job recovery lease blocks a competitor and expired lease is reclaimable",
  async () => {
    const failedJob = makeAutomationJob({
      status: "FAILED",
      attemptCount: 5,
      maxAttempts: 6,
    });
    const staleSending = {
      state: "SENDING",
      claimToken: "dead-worker",
      claimedAt: new Date(FIXED_NOW.getTime() - SEND_CLAIM_STALE_MS - 1),
    };
    const liveDeliveryStore = createInMemoryDigestDelivery([
      makeDelivery({
        email: staleSending,
        jobRecovery: {
          token: "live-recovery",
          expiresAt: new Date(
            FIXED_NOW.getTime() + DIGEST_JOB_RECOVERY_LEASE_MS,
          ),
          revision: 4,
        },
      }),
    ]);
    const liveJobs = createInMemoryAutomationJob([failedJob]);
    let liveTransactionCalls = 0;

    await enqueueRecipientDigest(
      {
        firm: { _id: IDS.firm, timezone: "UTC" },
        recipient: makeUser(),
        kind: DAILY_KIND,
        periodKey: "2026-03-20",
        noticeCasesEnabled: false,
        now: new Date(FIXED_NOW),
      },
      {
        AutomationJob: liveJobs.model,
        DigestDelivery: liveDeliveryStore.model,
        recoveryClock: () => new Date(FIXED_NOW),
        enqueueJob: async () => {
          throw new Error("live lock must not enqueue");
        },
        runRecoveryTransaction: async () => {
          liveTransactionCalls += 1;
          throw new Error("live lock must not open a transaction");
        },
      },
    );

    assert.equal(liveTransactionCalls, 0);
    assert.equal(
      liveDeliveryStore.get(IDS.deliveryA).jobRecovery.token,
      "live-recovery",
    );
    assert.equal(liveDeliveryStore.get(IDS.deliveryA).jobRecovery.revision, 4);
    assert.equal(liveDeliveryStore.get(IDS.deliveryA).email.state, "SENDING");

    const staleDeliveryStore = createInMemoryDigestDelivery([
      makeDelivery({
        email: staleSending,
        jobRecovery: {
          token: "crashed-recovery",
          expiresAt: new Date(FIXED_NOW.getTime() - 1),
          revision: 4,
        },
      }),
    ]);
    const staleJobs = createInMemoryAutomationJob([failedJob]);
    let staleTransactionCalls = 0;

    await enqueueRecipientDigest(
      {
        firm: { _id: IDS.firm, timezone: "UTC" },
        recipient: makeUser(),
        kind: DAILY_KIND,
        periodKey: "2026-03-20",
        noticeCasesEnabled: false,
        now: new Date(FIXED_NOW),
      },
      {
        AutomationJob: staleJobs.model,
        DigestDelivery: staleDeliveryStore.model,
        recoveryClock: () => new Date(FIXED_NOW),
        enqueueJob: async () => {
          throw new Error("stale lock recovery must not enqueue");
        },
        runRecoveryTransaction: async (work) => {
          staleTransactionCalls += 1;
          return work({ id: "reclaimed-lease-transaction" });
        },
      },
    );

    assert.equal(staleTransactionCalls, 1);
    assert.equal(staleJobs.get(IDS.jobA).status, "PENDING");
    const recovered = staleDeliveryStore.get(IDS.deliveryA);
    assert.equal(recovered.email.state, "PENDING");
    assert.equal(recovered.jobRecovery.token, null);
    assert.equal(recovered.jobRecovery.expiresAt, null);
    assert.equal(recovered.jobRecovery.revision, 5);
  },
);

await check(
  "job recovery acquisition, authority CAS, and transaction use fresh recovery time",
  async () => {
    const failedJob = makeAutomationJob({
      status: "FAILED",
      attemptCount: 5,
      maxAttempts: 6,
    });
    const existingLeaseExpiry = new Date(FIXED_NOW.getTime() + 60 * 1000);
    const acquisitionNow = new Date(FIXED_NOW.getTime() + 5 * 60 * 1000);
    const eligibilityNow = new Date(acquisitionNow.getTime() + 10 * 1000);
    const authorityNow = new Date(acquisitionNow.getTime() + 30 * 1000);
    const transactionNow = new Date(acquisitionNow.getTime() + 45 * 1000);
    const delivery = makeDelivery({
      email: {
        state: "SENDING",
        claimToken: "dead-worker",
        claimedAt: new Date(FIXED_NOW.getTime() - SEND_CLAIM_STALE_MS - 1),
      },
      jobRecovery: {
        token: "expired-at-recovery-time",
        expiresAt: existingLeaseExpiry,
        revision: 6,
      },
    });
    const deliveryStore = createInMemoryDigestDelivery([delivery]);
    const automationJobs = createInMemoryAutomationJob([failedJob]);
    const recoveryTimes = [
      acquisitionNow,
      eligibilityNow,
      authorityNow,
      transactionNow,
    ];
    let recoveryClockReads = 0;

    await enqueueRecipientDigest(
      {
        firm: { _id: IDS.firm, timezone: "UTC" },
        recipient: makeUser(),
        kind: DAILY_KIND,
        periodKey: delivery.periodKey,
        noticeCasesEnabled: false,
        now: new Date(FIXED_NOW),
      },
      {
        AutomationJob: automationJobs.model,
        DigestDelivery: deliveryStore.model,
        recoveryClock: () => {
          assert.ok(
            recoveryClockReads < recoveryTimes.length,
            "recovery clock read more than four times",
          );
          const instant = recoveryTimes[recoveryClockReads];
          recoveryClockReads += 1;
          return new Date(instant);
        },
        enqueueJob: async () => {
          throw new Error("existing FAILED authority must prevent enqueue");
        },
      },
    );

    assert.ok(existingLeaseExpiry > FIXED_NOW);
    assert.ok(existingLeaseExpiry < acquisitionNow);
    assert.equal(recoveryClockReads, 4);
    assert.equal(automationJobs.get(IDS.jobA).status, "PENDING");

    const leaseAcquisition = deliveryStore.operations.find(
      (operation) =>
        operation.method === "findOneAndUpdate" &&
        operation.update?.$set?.["jobRecovery.token"],
    );
    assert.ok(leaseAcquisition);
    assert.equal(
      queryHasDirectCondition(
        leaseAcquisition.filter,
        "jobRecovery.expiresAt",
        (condition) =>
          condition?.$lte instanceof Date &&
          condition.$lte.toISOString() === acquisitionNow.toISOString(),
      ),
      true,
      "lease acquisition must use fresh recovery time",
    );
    assert.equal(
      leaseAcquisition.update.$set["jobRecovery.expiresAt"].toISOString(),
      new Date(
        acquisitionNow.getTime() + DIGEST_JOB_RECOVERY_LEASE_MS,
      ).toISOString(),
    );

    const authorityRenewal = deliveryStore.operations.find(
      (operation) =>
        operation.method === "updateOne" &&
        scalarEquals(operation.update?.$set?.automationJobId, IDS.jobA),
    );
    assert.ok(authorityRenewal);
    assert.equal(
      queryHasDirectCondition(
        authorityRenewal.filter,
        "jobRecovery.expiresAt",
        (condition) =>
          condition?.$gt instanceof Date &&
          condition.$gt.toISOString() === authorityNow.toISOString(),
      ),
      true,
      "authority CAS must use fresh recovery time",
    );
    assert.equal(
      authorityRenewal.update.$set["jobRecovery.expiresAt"].toISOString(),
      new Date(
        authorityNow.getTime() + DIGEST_JOB_RECOVERY_LEASE_MS,
      ).toISOString(),
    );

    const transactionFence = deliveryStore.operations.find(
      (operation) =>
        operation.method === "updateOne" &&
        operation.options?.session &&
        operation.update?.$set?.["email.state"] === "PENDING",
    );
    assert.ok(transactionFence);
    assert.equal(
      queryHasDirectCondition(
        transactionFence.filter,
        "jobRecovery.expiresAt",
        (condition) =>
          condition?.$gt instanceof Date &&
          condition.$gt.toISOString() === transactionNow.toISOString(),
      ),
      true,
      "transaction fence must use fresh recovery time",
    );
    assert.equal(
      transactionFence.update.$set["jobRecovery.expiresAt"].toISOString(),
      new Date(
        transactionNow.getTime() + DIGEST_JOB_RECOVERY_LEASE_MS,
      ).toISOString(),
    );

    const recovered = deliveryStore.get(IDS.deliveryA);
    assert.equal(recovered.email.state, "PENDING");
    assert.equal(recovered.jobRecovery.token, null);
    assert.equal(recovered.jobRecovery.expiresAt, null);
    assert.equal(recovered.jobRecovery.revision, 7);
  },
);

async function assertPolicyTakeoverDefers({
  delivery = makeDelivery(),
  firm = { _id: IDS.firm, isActive: true },
  recipient = makeUser(),
  membership = makeMembership(),
  featureEnabled = true,
  featureError = null,
} = {}) {
  const store = createInMemoryDigestDelivery([delivery]);
  let providerCalls = 0;
  let activityCalls = 0;
  const result = await processDigestDeliveryJob(
    {
      _id: IDS.jobA,
      firmId: delivery.firmId,
      payload: { deliveryId: delivery._id },
      requestId: "digest-policy-takeover-fixed",
    },
    {
      DigestDelivery: store.model,
      Firm: createLookupModel(firm, []),
      User: createLookupModel(recipient, []),
      FirmMembership: createLookupModel(membership, []),
      AppConfig: {
        async isFeatureEnabled() {
          const takeover = await store.model.updateOne(
            { _id: delivery._id, "email.state": "SENDING" },
            {
              $set: {
                "email.claimToken": "replacement-worker",
                "email.claimedAt": new Date(FIXED_NOW),
              },
            },
          );
          assert.equal(takeover.matchedCount, 1);
          if (featureError) throw featureError;
          return featureEnabled;
        },
      },
      sendDigestEmail: async () => {
        providerCalls += 1;
        return { data: { id: "must-not-send" } };
      },
      safeRecordActivity: async () => {
        activityCalls += 1;
      },
      clock: () => new Date(FIXED_NOW),
    },
  );

  assert.deepEqual(result, {
    outcome: "DIGEST_CLAIM_LOST",
    deliveryId: IDS.deliveryA,
    defer: true,
    reason: "Digest send claim changed before completion",
    retryAfterMs: 30 * 1000,
  });
  const stored = store.get(IDS.deliveryA);
  assert.equal(stored.email.state, "SENDING");
  assert.equal(stored.email.claimToken, "replacement-worker");
  assert.equal(stored.email.claimedAt.toISOString(), FIXED_NOW.toISOString());
  assert.equal(stored.email.lastError, "");
  assert.equal(stored.email.attempts, 0);
  assert.equal(providerCalls, 0);
  assert.equal(activityCalls, 0);
  return { result, store, providerCalls, activityCalls };
}

await check(
  "missing active firm terminalizes claimed delivery before provider or activity",
  async () => {
    const harness = createProcessHarness({ firm: null });

    const result = await harness.run();

    assert.deepEqual(result, {
      outcome: "DIGEST_FIRM_UNAVAILABLE",
      deliveryId: IDS.deliveryA,
    });
    assert.equal(harness.providerCalls.length, 0);
    assert.equal(harness.activityCalls.length, 0);

    const stored = harness.store.get(IDS.deliveryA);
    assert.equal(stored.status, "FAILED");
    assert.equal(stored.email.state, "FAILED");
    assert.equal(stored.email.lastError, "Firm is inactive or unavailable");
    assert.equal(stored.email.claimToken, null);
    assert.equal(stored.email.claimedAt, null);
    assert.equal(stored.inApp.state, "HIDDEN");
    assert.equal(stored.inApp.availableAt, null);
    assert.equal(stored.inApp.readAt, null);

    assert.equal(harness.firmLookups.length, 1);
    assertStrictObjectIdEquality(
      harness.firmLookups[0].filter,
      "_id",
      IDS.firm,
    );
    assert.equal(
      queryHasDirectCondition(
        harness.firmLookups[0].filter,
        "isActive",
        (value) => value === true,
      ),
      true,
    );
    assert.equal(harness.firmLookups[0].selection, "_id kind ownerUserId");

    const claimOperation = harness.store.operations.find(
      (operation) =>
        operation.method === "findOneAndUpdate" &&
        operation.update?.$set?.["email.state"] === "SENDING",
    );
    const terminalWrite = harness.store.operations.find(
      (operation) =>
        operation.method === "updateOne" &&
        operation.update?.$set?.["email.lastError"] ===
          "Firm is inactive or unavailable",
    );
    assertFullClaimFence(terminalWrite?.filter, {
      claimToken: claimOperation.update.$set["email.claimToken"],
      attempts: 0,
      label: "inactive-firm terminal write",
    });
    assert.deepEqual(terminalWrite?.update, {
      $set: {
        status: "FAILED",
        "email.state": "FAILED",
        "email.lastError": "Firm is inactive or unavailable",
        "email.claimToken": null,
        "email.claimedAt": null,
        "inApp.state": "HIDDEN",
        "inApp.availableAt": null,
        "inApp.readAt": null,
      },
    });
  },
);

await check(
  "missing active firm wins over a rejecting feature lookup",
  async () => {
    const featureError = new Error("feature lookup unavailable");
    const harness = createProcessHarness({ firm: null, featureError });

    const result = await harness.run();

    assert.deepEqual(result, {
      outcome: "DIGEST_FIRM_UNAVAILABLE",
      deliveryId: IDS.deliveryA,
    });
    const stored = harness.store.get(IDS.deliveryA);
    assert.equal(stored.status, "FAILED");
    assert.equal(stored.email.state, "FAILED");
    assert.equal(stored.email.lastError, "Firm is inactive or unavailable");
    assert.equal(stored.email.claimToken, null);
    assert.equal(stored.inApp.state, "HIDDEN");
    assert.equal(stored.inApp.availableAt, null);
    assert.equal(stored.inApp.readAt, null);
    assert.equal(harness.providerCalls.length, 0);
    assert.equal(harness.activityCalls.length, 0);
  },
);

await check(
  "inactive-firm terminal CAS cannot overwrite a replacement claim",
  () => assertPolicyTakeoverDefers({ firm: null }),
);

await check(
  "inactive-firm terminal CAS after rejecting feature cannot overwrite replacement claim",
  async () => {
    const featureError = new Error("feature lookup failed after takeover");
    const { store } = await assertPolicyTakeoverDefers({
      firm: null,
      featureError,
    });
    const claimOperation = store.operations.find(
      (operation) =>
        operation.method === "findOneAndUpdate" &&
        operation.update?.$set?.["email.state"] === "SENDING",
    );
    const terminalAttempt = store.operations.find(
      (operation) =>
        operation.method === "updateOne" &&
        operation.update?.$set?.["email.lastError"] ===
          "Firm is inactive or unavailable",
    );
    assertFullClaimFence(terminalAttempt?.filter, {
      claimToken: claimOperation.update.$set["email.claimToken"],
      attempts: 0,
      label: "inactive-firm takeover terminal write",
    });
    assert.equal(
      store.operations.some(
        (operation) =>
          operation.update?.$set?.["email.lastError"] === featureError.message,
      ),
      false,
    );
  },
);

await check(
  "recipient-unavailable CAS cannot overwrite a replacement claim",
  () => assertPolicyTakeoverDefers({ recipient: null }),
);

await check("weekly-authority CAS cannot overwrite a replacement claim", () =>
  assertPolicyTakeoverDefers({
    delivery: makeDelivery({
      kind: WEEKLY_KIND,
      periodKey: "2026-03-16",
      summary: { kind: WEEKLY_KIND },
    }),
    membership: makeMembership({ role: "MEMBER" }),
  }),
);

await check("rollout-blocked CAS cannot overwrite a replacement claim", () =>
  assertPolicyTakeoverDefers({ featureEnabled: false }),
);

await check(
  "preference-suppression CAS cannot overwrite a replacement claim",
  () =>
    assertPolicyTakeoverDefers({
      recipient: makeUser({
        digestPreferences: { emailEnabled: false },
      }),
    }),
);

await check(
  "one of two concurrent PENDING claims wins atomically",
  async () => {
    const store = createInMemoryDigestDelivery([makeDelivery()]);
    const [first, second] = await Promise.all([
      claimDigestDelivery({
        deliveryId: IDS.deliveryA,
        firmId: IDS.firm,
        automationJobId: IDS.jobA,
        now: new Date(FIXED_NOW),
        claimToken: "claim-one",
        deliveryModel: store.model,
      }),
      claimDigestDelivery({
        deliveryId: IDS.deliveryA,
        firmId: IDS.firm,
        automationJobId: IDS.jobA,
        now: new Date(FIXED_NOW),
        claimToken: "claim-two",
        deliveryModel: store.model,
      }),
    ]);

    const winners = [first, second].filter(Boolean);
    assert.equal(winners.length, 1);
    assert.equal(store.get(IDS.deliveryA).email.state, "SENDING");
    assert.equal(
      store.get(IDS.deliveryA).email.claimToken,
      winners[0].claimToken,
    );
  },
);

await check("non-stale SENDING claim is blocked", async () => {
  const store = createInMemoryDigestDelivery([
    makeDelivery({
      email: {
        state: "SENDING",
        claimToken: "current-worker",
        claimedAt: new Date(FIXED_NOW.getTime() - SEND_CLAIM_STALE_MS + 1),
      },
    }),
  ]);

  const claim = await claimDigestDelivery({
    deliveryId: IDS.deliveryA,
    firmId: IDS.firm,
    automationJobId: IDS.jobA,
    now: new Date(FIXED_NOW),
    claimToken: "second-worker",
    deliveryModel: store.model,
  });

  assert.equal(claim, null);
  assert.equal(store.get(IDS.deliveryA).email.claimToken, "current-worker");
});

await check("SENDING claim older than 15 minutes is reclaimed", async () => {
  const store = createInMemoryDigestDelivery([
    makeDelivery({
      email: {
        state: "SENDING",
        claimToken: "dead-worker",
        claimedAt: new Date(FIXED_NOW.getTime() - SEND_CLAIM_STALE_MS - 1),
      },
    }),
  ]);

  const claim = await claimDigestDelivery({
    deliveryId: IDS.deliveryA,
    firmId: IDS.firm,
    automationJobId: IDS.jobA,
    now: new Date(FIXED_NOW),
    claimToken: "replacement-worker",
    deliveryModel: store.model,
  });

  assert.ok(claim);
  assert.equal(claim.claimToken, "replacement-worker");
  assert.equal(store.get(IDS.deliveryA).email.claimToken, "replacement-worker");
  assert.equal(
    store.get(IDS.deliveryA).email.claimedAt.toISOString(),
    FIXED_NOW.toISOString(),
  );
});

await check(
  "SENDING claim with null or missing claimedAt is reclaimed",
  async () => {
    for (const claimedAtState of ["null", "missing"]) {
      const delivery = makeDelivery({
        email: {
          state: "SENDING",
          claimToken: "orphaned-worker",
          claimedAt: null,
        },
      });
      if (claimedAtState === "missing") delete delivery.email.claimedAt;
      const store = createInMemoryDigestDelivery([delivery]);
      const claimToken = `replacement-${claimedAtState}`;

      const claim = await claimDigestDelivery({
        deliveryId: IDS.deliveryA,
        firmId: IDS.firm,
        automationJobId: IDS.jobA,
        now: new Date(FIXED_NOW),
        claimToken,
        deliveryModel: store.model,
      });

      assert.ok(claim, `${claimedAtState} claimedAt was not reclaimed`);
      assert.equal(claim.claimToken, claimToken);
      assert.equal(store.get(IDS.deliveryA).email.state, "SENDING");
      assert.equal(store.get(IDS.deliveryA).email.claimToken, claimToken);
      assert.equal(
        store.get(IDS.deliveryA).email.claimedAt.toISOString(),
        FIXED_NOW.toISOString(),
      );
    }
  },
);

await check(
  "recovery helper classifies stale, malformed, and orphaned SENDING claims",
  () => {
    assert.equal(
      digestSendingRecoveryReason(
        makeDelivery({
          email: {
            state: "SENDING",
            claimToken: "worker",
            claimedAt: new Date(FIXED_NOW.getTime() - SEND_CLAIM_STALE_MS - 1),
          },
        }),
        FIXED_NOW,
      ),
      "STALE_CLAIM",
    );
    assert.equal(
      digestSendingRecoveryReason(
        makeDelivery({
          email: {
            state: "SENDING",
            claimToken: "worker",
            claimedAt: "not-a-date",
          },
        }),
        FIXED_NOW,
      ),
      "INVALID_CLAIM_TIME",
    );
    assert.equal(
      digestSendingRecoveryReason(
        makeDelivery({
          email: {
            state: "SENDING",
            claimToken: "worker",
            claimedAt: new Date(FIXED_NOW.getTime() - SEND_CLAIM_STALE_MS + 1),
          },
        }),
        FIXED_NOW,
      ),
      null,
    );
  },
);

await check(
  "recent SENDING claim with null, missing, or empty claimToken is reclaimed immediately",
  async () => {
    for (const tokenState of ["null", "missing", "empty"]) {
      const delivery = makeDelivery({
        email: {
          state: "SENDING",
          claimToken: null,
          claimedAt: new Date(FIXED_NOW.getTime() - 1),
        },
      });
      if (tokenState === "missing") delete delivery.email.claimToken;
      if (tokenState === "empty") delivery.email.claimToken = "";
      const store = createInMemoryDigestDelivery([delivery]);
      const replacementToken = `replacement-${tokenState}`;

      const claim = await claimDigestDelivery({
        deliveryId: IDS.deliveryA,
        firmId: IDS.firm,
        automationJobId: IDS.jobA,
        now: new Date(FIXED_NOW),
        claimToken: replacementToken,
        deliveryModel: store.model,
      });

      assert.ok(claim, `${tokenState} claimToken was not reclaimed`);
      assert.equal(claim.claimToken, replacementToken);
      assert.equal(store.get(IDS.deliveryA).email.state, "SENDING");
      assert.equal(store.get(IDS.deliveryA).email.claimToken, replacementToken);
      assert.equal(
        store.get(IDS.deliveryA).email.claimedAt.toISOString(),
        FIXED_NOW.toISOString(),
      );
    }
  },
);

await check(
  "malformed SENDING claimedAt is reclaimed without date arithmetic",
  async () => {
    const store = createInMemoryDigestDelivery([
      makeDelivery({
        email: {
          state: "SENDING",
          claimToken: "orphaned-worker",
          claimedAt: "not-a-date",
        },
      }),
    ]);

    const claim = await claimDigestDelivery({
      deliveryId: IDS.deliveryA,
      firmId: IDS.firm,
      automationJobId: IDS.jobA,
      now: new Date(FIXED_NOW),
      claimToken: "replacement-worker",
      deliveryModel: store.model,
    });

    assert.ok(claim);
    assert.equal(
      store.get(IDS.deliveryA).email.claimToken,
      "replacement-worker",
    );
    assert.equal(
      store.get(IDS.deliveryA).email.claimedAt.toISOString(),
      FIXED_NOW.toISOString(),
    );
  },
);

await check(
  "only authoritative active job reaches provider across failure and retry",
  async () => {
    const providerError = new Error("authoritative provider failure");
    let providerAttempt = 0;
    const harness = createProcessHarness({
      provider: async () => {
        providerAttempt += 1;
        if (providerAttempt === 1) throw providerError;
        return { data: { id: "authoritative-retry-sent" } };
      },
    });
    const losingJob = {
      ...clone(harness.job),
      _id: IDS.jobB,
      status: "PROCESSING",
      attemptCount: 2,
      maxAttempts: 5,
    };

    await assert.rejects(
      () => harness.run(),
      (error) => error === providerError,
    );
    const afterFailure = harness.store.get(IDS.deliveryA);
    assert.equal(afterFailure.email.state, "FAILED");
    assert.equal(afterFailure.email.attempts, 1);
    assert.equal(harness.providerCalls.length, 1);

    const loserResult = await harness.run(losingJob);
    assert.deepEqual(loserResult, {
      outcome: "DIGEST_JOB_SUPERSEDED",
      deliveryId: IDS.deliveryA,
    });
    const afterLoser = harness.store.get(IDS.deliveryA);
    assertObjectIdEquals(afterLoser.automationJobId, IDS.jobA);
    assert.equal(afterLoser.email.state, "FAILED");
    assert.equal(afterLoser.email.attempts, 1);
    assert.equal(afterLoser.email.lastError, providerError.message);
    assert.equal(losingJob.attemptCount, 2);
    assert.equal(losingJob.maxAttempts, 5);
    assert.equal(harness.providerCalls.length, 1);

    const retryResult = await harness.run();
    assert.deepEqual(retryResult, {
      outcome: "DIGEST_EMAIL_NOT_PENDING",
      deliveryId: IDS.deliveryA,
    });
    const afterRetry = harness.store.get(IDS.deliveryA);
    assert.equal(afterRetry.email.state, "FAILED");
    assert.equal(afterRetry.email.attempts, 1);
    assert.equal(afterRetry.email.lastError, providerError.message);
    assert.equal(harness.providerCalls.length, 1);
  },
);

await check(
  "unlinked job authority defers without provider call or retry amplification",
  async () => {
    const harness = createProcessHarness({
      delivery: makeDelivery({ automationJobId: null }),
    });

    const result = await harness.run();

    assert.deepEqual(result, {
      outcome: "DIGEST_JOB_AUTHORITY_PENDING",
      deliveryId: IDS.deliveryA,
      defer: true,
      reason: "Digest job authority is still being linked",
      retryAfterMs: DIGEST_AUTHORITY_DEFER_MS,
    });
    const stored = harness.store.get(IDS.deliveryA);
    assert.equal(stored.automationJobId, null);
    assert.equal(stored.email.state, "PENDING");
    assert.equal(stored.email.attempts, 0);
    assert.equal(harness.providerCalls.length, 0);
    assert.equal(harness.featureCalls.length, 0);
    assert.equal(harness.firmLookups.length, 0);
    assert.equal(harness.userLookups.length, 0);
    assert.equal(harness.membershipLookups.length, 0);
  },
);

await check(
  "full send calls injected provider once with exact business key and clears claim",
  async () => {
    const harness = createProcessHarness();
    const result = await harness.run();
    const stored = harness.store.get(IDS.deliveryA);

    assert.deepEqual(result, {
      outcome: "DIGEST_EMAIL_SENT",
      deliveryId: IDS.deliveryA,
    });
    assert.equal(harness.providerCalls.length, 1);
    assert.equal(
      harness.providerCalls[0].idempotencyKey,
      expectedBusinessKey(),
    );
    assert.equal(stored.email.state, "SENT");
    assert.equal(stored.email.claimToken, null);
    assert.equal(stored.email.claimedAt, null);
    assert.equal(stored.email.attempts, 1);
    assert.equal(stored.email.providerMessageId, "provider-message-fixed");
  },
);

await check(
  "process lookup keeps User global and requests active Firm and membership",
  async () => {
    const harness = createProcessHarness();
    await harness.run();

    assert.equal(harness.firmLookups.length, 2);
    for (const lookup of harness.firmLookups) {
      assertStrictObjectIdEquality(lookup.filter, "_id", IDS.firm);
      assert.equal(
        queryHasDirectCondition(
          lookup.filter,
          "isActive",
          (value) => value === true,
        ),
        true,
      );
      assert.equal(lookup.selection, "_id kind ownerUserId");
    }
    assert.equal(harness.userLookups.length, 2);
    for (const lookup of harness.userLookups) {
      assertStrictObjectIdEquality(lookup.filter, "_id", IDS.recipient);
      assert.equal(
        queryHasDirectCondition(
          lookup.filter,
          "isActive",
          (value) => value === true,
        ),
        true,
      );
      assert.equal(
        queryHasLiteralEquality(lookup.filter, "firmId", IDS.firm),
        false,
      );
      assert.equal(lookup.selection, "email role digestPreferences");
    }
    assert.equal(harness.membershipLookups.length, 2);
    for (const lookup of harness.membershipLookups) {
      assertStrictObjectIdEquality(lookup.filter, "firmId", IDS.firm);
      assertStrictObjectIdEquality(lookup.filter, "userId", IDS.recipient);
      assert.equal(
        queryHasDirectCondition(
          lookup.filter,
          "status",
          (value) => value === "ACTIVE",
        ),
        true,
      );
      assert.equal(lookup.selection, "role status");
    }
  },
);

await check(
  "scheduler selects recipients only through ACTIVE firm memberships",
  async () => {
    const firm = {
      _id: IDS.firm,
      isActive: true,
      timezone: "UTC",
      digestSettings: { dailyHour: 8, weeklyDay: 1, weeklyHour: 8 },
    };
    const memberships = [
      makeMembership({ userId: IDS.recipient, role: "MEMBER" }),
      makeMembership({ userId: IDS.owner, role: "OWNER" }),
      makeMembership({ userId: IDS.admin, role: "ADMIN" }),
      makeMembership({ userId: IDS.superAdmin, role: "MEMBER" }),
      makeMembership({
        userId: IDS.removed,
        status: "REMOVED",
        role: "OWNER",
      }),
    ];
    const users = [
      makeUser({
        _id: IDS.recipient,
        firmId: IDS.otherFirm,
        isActive: true,
        role: "MEMBER",
      }),
      makeUser({
        _id: IDS.owner,
        firmId: IDS.otherFirm,
        isActive: true,
        role: "MEMBER",
      }),
      makeUser({
        _id: IDS.admin,
        firmId: null,
        isActive: true,
        role: "MEMBER",
      }),
      makeUser({
        _id: IDS.superAdmin,
        firmId: IDS.otherFirm,
        isActive: true,
        role: "SUPER_ADMIN",
      }),
      makeUser({
        _id: IDS.pointerOnly,
        firmId: IDS.firm,
        isActive: true,
        role: "SUPER_ADMIN",
      }),
      makeUser({
        _id: IDS.removed,
        firmId: IDS.firm,
        isActive: true,
        role: "MEMBER",
      }),
    ];
    const firmOperations = [];
    const membershipOperations = [];
    const userOperations = [];
    const featureCalls = [];
    const enqueueCalls = [];
    const recoveryCursor = createInMemoryDigestRecoveryCursor();

    const Firm = {
      find(filter) {
        const operation = { filter: clone(filter) };
        firmOperations.push(operation);
        return makeFindQuery([firm], operation);
      },
    };
    const FirmMembership = {
      find(filter) {
        const operation = { filter: clone(filter) };
        membershipOperations.push(operation);
        const rows = memberships.filter((membership) =>
          matchesFilter(membership, filter),
        );
        return makeFindQuery(rows, operation);
      },
    };
    const User = {
      find(filter) {
        const operation = { filter: clone(filter) };
        userOperations.push(operation);
        const rows = users.filter((user) => matchesFilter(user, filter));
        return makeFindQuery(rows, operation);
      },
    };
    const AppConfig = {
      async isFeatureEnabled(name, options) {
        featureCalls.push({ name, options: clone(options) });
        return name === "dailyDigest" || name === "weeklySummary";
      },
    };

    const result = await enqueueDueDigests(
      { now: new Date("2026-03-23T08:00:00.000Z") },
      {
        AppConfig,
        DigestDelivery: {
          find(filter) {
            const operation = { filter: clone(filter) };
            return makeFindQuery([], operation);
          },
        },
        DigestRecoveryCursor: recoveryCursor.model,
        recoveryClock: () => new Date(FIXED_NOW),
        Firm,
        FirmMembership,
        User,
        enqueueRecipientDigest: async (input) => {
          enqueueCalls.push(clone(input));
        },
      },
    );

    assert.deepEqual(result, {
      firms: 1,
      daily: 4,
      weekly: 3,
      disabled: false,
    });
    assert.equal(featureCalls.length, 3);
    assert.deepEqual(firmOperations[0].filter, { isActive: true });
    assert.equal(
      firmOperations[0].selection,
      "timezone digestSettings kind ownerUserId",
    );
    assertStrictObjectIdEquality(
      membershipOperations[0].filter,
      "firmId",
      IDS.firm,
    );
    assert.equal(
      queryHasDirectCondition(
        membershipOperations[0].filter,
        "status",
        (value) => value === "ACTIVE",
      ),
      true,
    );
    assert.equal(membershipOperations[0].selection, "userId role status");
    assert.equal(userOperations.length, 1);
    assert.equal(
      queryHasDirectCondition(userOperations[0].filter, "firmId", () => true),
      false,
    );
    assert.equal(userOperations[0].selection, "role digestPreferences");
    for (const userId of [
      IDS.recipient,
      IDS.owner,
      IDS.admin,
      IDS.superAdmin,
    ]) {
      assertFilterAccepts(
        userOperations[0].filter,
        users.find((user) => String(user._id) === userId),
        `scheduler user ${userId}`,
      );
    }
    assertFilterRejects(
      userOperations[0].filter,
      makeUser({ _id: IDS.pointerOnly }),
      "non-member pointer user",
    );
    assertFilterRejects(
      userOperations[0].filter,
      makeUser({ _id: IDS.removed }),
      "removed membership user",
    );

    const kindsFor = (recipientUserId) =>
      enqueueCalls
        .filter((call) => String(call.recipient._id) === recipientUserId)
        .map((call) => call.kind);
    assert.deepEqual(kindsFor(IDS.recipient), [DAILY_KIND]);
    assert.deepEqual(kindsFor(IDS.owner), [DAILY_KIND, WEEKLY_KIND]);
    assert.deepEqual(kindsFor(IDS.admin), [DAILY_KIND, WEEKLY_KIND]);
    assert.deepEqual(kindsFor(IDS.superAdmin), [DAILY_KIND, WEEKLY_KIND]);
    assert.deepEqual(kindsFor(IDS.pointerOnly), []);
    assert.deepEqual(kindsFor(IDS.removed), []);
  },
);

await check("PERSONAL scheduler queues only its ACTIVE OWNER", async () => {
  const cases = [
    {
      label: "active owner",
      recipientUserId: IDS.owner,
      membershipRole: "OWNER",
      userRole: "MEMBER",
      expectedKinds: [DAILY_KIND, WEEKLY_KIND],
    },
    {
      label: "owner with ADMIN membership",
      recipientUserId: IDS.owner,
      membershipRole: "ADMIN",
      userRole: "MEMBER",
      expectedKinds: [],
    },
    {
      label: "owner with MEMBER membership and global SUPER_ADMIN",
      recipientUserId: IDS.owner,
      membershipRole: "MEMBER",
      userRole: "SUPER_ADMIN",
      expectedKinds: [],
    },
    {
      label: "non-owner with OWNER membership",
      recipientUserId: IDS.admin,
      membershipRole: "OWNER",
      userRole: "MEMBER",
      expectedKinds: [],
    },
  ];

  for (const testCase of cases) {
    const firm = {
      _id: IDS.firm,
      isActive: true,
      kind: "PERSONAL",
      ownerUserId: IDS.owner,
      timezone: "UTC",
      digestSettings: { dailyHour: 8, weeklyDay: 1, weeklyHour: 8 },
    };
    const membership = makeMembership({
      userId: testCase.recipientUserId,
      role: testCase.membershipRole,
    });
    const user = makeUser({
      _id: testCase.recipientUserId,
      isActive: true,
      role: testCase.userRole,
    });
    const firmOperation = { filter: null };
    const enqueueCalls = [];
    const result = await enqueueDueDigests(
      { now: new Date("2026-03-23T08:00:00.000Z") },
      {
        AppConfig: {
          async isFeatureEnabled(name) {
            return name === "dailyDigest" || name === "weeklySummary";
          },
        },
        DigestDelivery: {
          find(filter) {
            return makeFindQuery([], { filter: clone(filter) });
          },
        },
        DigestRecoveryCursor: createInMemoryDigestRecoveryCursor().model,
        recoveryClock: () => new Date(FIXED_NOW),
        Firm: {
          find(filter) {
            firmOperation.filter = clone(filter);
            return makeFindQuery([firm], firmOperation);
          },
        },
        FirmMembership: {
          find(filter) {
            return makeFindQuery([membership], {
              filter: clone(filter),
            });
          },
        },
        User: {
          find(filter) {
            return makeFindQuery([user], { filter: clone(filter) });
          },
        },
        enqueueRecipientDigest: async (input) => {
          enqueueCalls.push(clone(input));
        },
      },
    );

    assert.deepEqual(
      enqueueCalls.map((call) => call.kind),
      testCase.expectedKinds,
      testCase.label,
    );
    assert.deepEqual(
      result,
      {
        firms: 1,
        daily: testCase.expectedKinds.includes(DAILY_KIND) ? 1 : 0,
        weekly: testCase.expectedKinds.includes(WEEKLY_KIND) ? 1 : 0,
        disabled: false,
      },
      testCase.label,
    );
    assert.equal(
      firmOperation.selection,
      "timezone digestSettings kind ownerUserId",
      testCase.label,
    );
  }
});

await check(
  "route access denies active global SUPER_ADMIN without membership",
  async () => {
    const membershipLookups = [];
    const userLookups = [];
    await assert.rejects(
      () =>
        requireActiveDigestAccess(
          { userId: IDS.pointerOnly, firmId: IDS.firm },
          {
            Firm: createLookupModel(makeFirm(), []),
            FirmMembership: createLookupModel(null, membershipLookups),
            User: createLookupModel(
              makeUser({
                _id: IDS.pointerOnly,
                isActive: true,
                role: "SUPER_ADMIN",
              }),
              userLookups,
            ),
          },
        ),
      (error) => {
        assert.equal(error.status, 403);
        assert.equal(error.code, "DIGEST_ACCESS_FORBIDDEN");
        return true;
      },
    );

    assertStrictObjectIdEquality(
      membershipLookups[0].filter,
      "firmId",
      IDS.firm,
    );
    assertStrictObjectIdEquality(
      membershipLookups[0].filter,
      "userId",
      IDS.pointerOnly,
    );
    assert.equal(
      queryHasDirectCondition(
        membershipLookups[0].filter,
        "status",
        (value) => value === "ACTIVE",
      ),
      true,
    );
    assert.equal(membershipLookups[0].selection, "role status");
    assertStrictObjectIdEquality(userLookups[0].filter, "_id", IDS.pointerOnly);
    assert.equal(
      queryHasDirectCondition(
        userLookups[0].filter,
        "isActive",
        (value) => value === true,
      ),
      true,
    );
    assert.equal(userLookups[0].selection, "email role digestPreferences");
  },
);

await check(
  "route access keeps ACTIVE MEMBER global SUPER_ADMIN weekly authority",
  async () => {
    const access = await requireActiveDigestAccess(
      { userId: IDS.superAdmin, firmId: IDS.firm },
      {
        Firm: createLookupModel(makeFirm(), []),
        FirmMembership: createLookupModel(
          makeMembership({
            userId: IDS.superAdmin,
            status: "ACTIVE",
            role: "MEMBER",
          }),
          [],
        ),
        User: createLookupModel(
          makeUser({
            _id: IDS.superAdmin,
            isActive: true,
            role: "SUPER_ADMIN",
          }),
          [],
        ),
      },
    );

    assert.equal(access.membership.status, "ACTIVE");
    assert.equal(access.membership.role, "MEMBER");
    assert.equal(access.weeklyAuthorized, true);
  },
);

await check(
  "firm digest settings deny no-membership global SUPER_ADMIN before Firm access",
  async () => {
    const harness = createFirmSettingsHarness({
      user: makeUser({
        _id: IDS.superAdmin,
        isActive: true,
        role: "SUPER_ADMIN",
      }),
      membership: null,
    });

    await assert.rejects(
      () => harness.run(),
      (error) => {
        assert.equal(error.status, 403);
        assert.equal(error.code, "FIRM_ADMIN_ONLY");
        return true;
      },
    );
    assert.equal(harness.firmReads.length, 1);
    assert.equal(harness.firmWrites.length, 0);
    assert.equal(harness.activityCalls.length, 0);
  },
);

await check(
  "firm digest settings deny ACTIVE MEMBER global SUPER_ADMIN before Firm access",
  async () => {
    const harness = createFirmSettingsHarness({
      user: makeUser({
        _id: IDS.superAdmin,
        isActive: true,
        role: "SUPER_ADMIN",
      }),
      membership: makeMembership({
        userId: IDS.superAdmin,
        status: "ACTIVE",
        role: "MEMBER",
      }),
    });

    await assert.rejects(
      () => harness.run(),
      (error) => {
        assert.equal(error.status, 403);
        assert.equal(error.code, "FIRM_ADMIN_ONLY");
        return true;
      },
    );
    assert.equal(harness.firmReads.length, 1);
    assert.equal(harness.firmWrites.length, 0);
    assert.equal(harness.activityCalls.length, 0);
  },
);

await check(
  "firm digest settings allow ACTIVE OWNER and ACTIVE ADMIN",
  async () => {
    for (const role of ["OWNER", "ADMIN"]) {
      const harness = createFirmSettingsHarness({
        user: makeUser({ isActive: true, role: "MEMBER" }),
        membership: makeMembership({ status: "ACTIVE", role }),
      });

      const result = await harness.run({ dailyHour: 9 });

      assert.equal(result.digestSettings.dailyHour, 9, role);
      assertStrictObjectIdEquality(
        harness.userLookups[0].filter,
        "_id",
        IDS.recipient,
      );
      assert.equal(
        queryHasDirectCondition(
          harness.userLookups[0].filter,
          "isActive",
          (value) => value === true,
        ),
        true,
        role,
      );
      assert.equal(harness.userLookups[0].selection, "_id isActive __v", role);
      assertStrictObjectIdEquality(
        harness.membershipLookups[0].filter,
        "firmId",
        IDS.firm,
      );
      assertStrictObjectIdEquality(
        harness.membershipLookups[0].filter,
        "userId",
        IDS.recipient,
      );
      assert.equal(
        queryHasDirectCondition(
          harness.membershipLookups[0].filter,
          "status",
          (value) => value === "ACTIVE",
        ),
        true,
        role,
      );
      assert.equal(
        harness.membershipLookups[0].selection,
        "role status __v",
        role,
      );
      assert.equal(harness.firmReads.length, 1, role);
      assert.equal(harness.userWrites.length, 1, role);
      assert.equal(harness.membershipWrites.length, 1, role);
      assert.equal(harness.firmWrites.length, 1, role);
      assertLiteralEquality(harness.userWrites[0].filter, "__v", 0, role);
      assertLiteralEquality(harness.membershipWrites[0].filter, "__v", 0, role);
      assertLiteralEquality(harness.firmWrites[0].filter, "__v", 0, role);
      assert.deepEqual(
        harness.userWrites[0].update,
        { $inc: { __v: 1 } },
        role,
      );
      assert.deepEqual(
        harness.membershipWrites[0].update,
        { $inc: { __v: 1 } },
        role,
      );
      assert.deepEqual(
        harness.userWrites[0].options,
        {
          session: { id: "firm-settings-transaction" },
          timestamps: false,
        },
        role,
      );
      assert.deepEqual(
        harness.membershipWrites[0].options,
        {
          session: { id: "firm-settings-transaction" },
          timestamps: false,
        },
        role,
      );
      assert.equal(harness.getUser().__v, 1, role);
      assert.equal(harness.getMembership().__v, 1, role);
      assert.equal(harness.getFirm().__v, 1, role);
      assert.equal(
        harness.firmWrites[0].options.session.id,
        "firm-settings-transaction",
        role,
      );
      assert.deepEqual(harness.firmWrites[0].update, {
        $set: { "digestSettings.dailyHour": 9 },
        $inc: { __v: 1 },
      });
      assert.equal(harness.activityCalls.length, 1, role);
      assert.equal(
        harness.activityCalls[0].action,
        "FIRM_DIGEST_SETTINGS_UPDATED",
        role,
      );
    }
  },
);

await check(
  "route access denies an inactive User even with ACTIVE membership",
  async () => {
    const inactiveUser = makeUser({ isActive: false });
    const userLookups = [];
    const membershipLookups = [];
    const User = {
      findOne(filter) {
        const lookup = { filter: clone(filter), selection: null };
        userLookups.push(lookup);
        const matchedUser = matchesFilter(inactiveUser, filter)
          ? inactiveUser
          : null;
        return makeLeanQuery(matchedUser, (selection) => {
          lookup.selection = selection;
        });
      },
    };

    await assert.rejects(
      () =>
        requireActiveDigestAccess(
          { userId: IDS.recipient, firmId: IDS.firm },
          {
            Firm: createLookupModel(makeFirm(), []),
            FirmMembership: createLookupModel(
              makeMembership({ status: "ACTIVE", role: "OWNER" }),
              membershipLookups,
            ),
            User,
          },
        ),
      (error) => {
        assert.equal(error.status, 403);
        assert.equal(error.code, "DIGEST_ACCESS_FORBIDDEN");
        return true;
      },
    );

    assertStrictObjectIdEquality(userLookups[0].filter, "_id", IDS.recipient);
    assert.equal(
      queryHasDirectCondition(
        userLookups[0].filter,
        "isActive",
        (value) => value === true,
      ),
      true,
    );
    assert.equal(userLookups[0].selection, "email role digestPreferences");
    assertStrictObjectIdEquality(
      membershipLookups[0].filter,
      "firmId",
      IDS.firm,
    );
    assertStrictObjectIdEquality(
      membershipLookups[0].filter,
      "userId",
      IDS.recipient,
    );
    assert.equal(
      queryHasDirectCondition(
        membershipLookups[0].filter,
        "status",
        (value) => value === "ACTIVE",
      ),
      true,
    );
  },
);

await check(
  "firm digest settings deny REMOVED OWNER before Firm access",
  async () => {
    const harness = createFirmSettingsHarness({
      user: makeUser({ isActive: true }),
      membership: makeMembership({ status: "REMOVED", role: "OWNER" }),
    });

    await assert.rejects(
      () => harness.run(),
      (error) => {
        assert.equal(error.status, 403);
        assert.equal(error.code, "FIRM_ADMIN_ONLY");
        return true;
      },
    );
    assertStrictObjectIdEquality(
      harness.membershipLookups[0].filter,
      "firmId",
      IDS.firm,
    );
    assertStrictObjectIdEquality(
      harness.membershipLookups[0].filter,
      "userId",
      IDS.recipient,
    );
    assert.equal(
      queryHasDirectCondition(
        harness.membershipLookups[0].filter,
        "status",
        (value) => value === "ACTIVE",
      ),
      true,
    );
    assert.equal(harness.firmReads.length, 1);
    assert.equal(harness.firmWrites.length, 0);
    assert.equal(harness.activityCalls.length, 0);
  },
);

await check(
  "firm digest settings report deactivation between read and update",
  async () => {
    const harness = createFirmSettingsHarness({
      firmUpdateReturnsNull: true,
    });

    await assert.rejects(
      () => harness.run({ dailyHour: 9 }),
      (error) => {
        assert.equal(
          error.message,
          "Digest settings changed before the update could be applied",
        );
        assert.equal(error.status, 409);
        assert.equal(error.code, "DIGEST_SETTINGS_CONFLICT");
        return true;
      },
    );
    assert.equal(harness.firmReads.length, 1);
    assert.equal(harness.userWrites.length, 1);
    assert.equal(harness.membershipWrites.length, 1);
    assert.equal(harness.firmWrites.length, 1);
    assertStrictObjectIdEquality(harness.firmWrites[0].filter, "_id", IDS.firm);
    assert.equal(
      queryHasDirectCondition(
        harness.firmWrites[0].filter,
        "isActive",
        (value) => value === true,
      ),
      true,
    );
    assertLiteralEquality(harness.firmWrites[0].filter, "kind", "BUSINESS");
    assert.deepEqual(harness.firmWrites[0].options, {
      new: true,
      runValidators: true,
      session: { id: "firm-settings-transaction" },
    });
    assert.equal(harness.getUser().__v, 0);
    assert.equal(harness.getMembership().__v, 0);
    assert.equal(harness.getFirm().__v, 0);
    assert.equal(harness.activityCalls.length, 0);
  },
);

await check(
  "missing active firm wins over rejected User and FirmMembership lookups",
  async () => {
    const cases = [
      {
        label: "User rejection",
        options: { userError: new Error("User lookup unavailable") },
      },
      {
        label: "FirmMembership rejection",
        options: {
          membershipError: new Error("Membership lookup unavailable"),
        },
      },
    ];

    for (const testCase of cases) {
      const harness = createProcessHarness({
        firm: null,
        ...testCase.options,
      });
      const result = await harness.run();
      const stored = harness.store.get(IDS.deliveryA);

      assert.deepEqual(
        result,
        {
          outcome: "DIGEST_FIRM_UNAVAILABLE",
          deliveryId: IDS.deliveryA,
        },
        testCase.label,
      );
      assert.equal(stored.status, "FAILED", testCase.label);
      assert.equal(stored.email.state, "FAILED", testCase.label);
      assert.equal(
        stored.email.lastError,
        "Firm is inactive or unavailable",
        testCase.label,
      );
      assert.equal(stored.email.claimToken, null, testCase.label);
      assert.equal(stored.email.claimedAt, null, testCase.label);
      assert.equal(stored.inApp.state, "HIDDEN", testCase.label);
      assert.equal(stored.inApp.availableAt, null, testCase.label);
      assert.equal(stored.inApp.readAt, null, testCase.label);
      assert.equal(harness.providerCalls.length, 0, testCase.label);
      assert.equal(harness.activityCalls.length, 0, testCase.label);

      const claimOperation = harness.store.operations.find(
        (operation) =>
          operation.method === "findOneAndUpdate" &&
          operation.update?.$set?.["email.state"] === "SENDING",
      );
      const terminalWrite = harness.store.operations.find(
        (operation) =>
          operation.method === "updateOne" &&
          operation.update?.$set?.["email.lastError"] ===
            "Firm is inactive or unavailable",
      );
      const claimToken = claimOperation?.update?.$set?.["email.claimToken"];
      assert.equal(typeof claimToken, "string", testCase.label);
      assertFullClaimFence(terminalWrite?.filter, {
        claimToken,
        attempts: 0,
        label: testCase.label,
      });
    }
  },
);

await check(
  "daily digest denies removed membership before provider delivery",
  async () => {
    const harness = createProcessHarness({ membership: null });
    const result = await harness.run();
    const stored = harness.store.get(IDS.deliveryA);

    assert.equal(result.outcome, "DIGEST_MEMBERSHIP_UNAVAILABLE");
    assert.equal(harness.providerCalls.length, 0);
    assert.equal(stored.email.state, "FAILED");
    assert.equal(stored.email.claimToken, null);
    assert.equal(stored.inApp.state, "HIDDEN");
    assert.equal(stored.inApp.availableAt, null);
  },
);

await check(
  "daily digest rejects a non-ACTIVE membership before provider delivery",
  async () => {
    const harness = createProcessHarness({
      membership: makeMembership({ status: "REMOVED", role: "OWNER" }),
    });
    const result = await harness.run();
    const stored = harness.store.get(IDS.deliveryA);

    assert.equal(result.outcome, "DIGEST_MEMBERSHIP_UNAVAILABLE");
    assert.equal(harness.providerCalls.length, 0);
    assert.equal(stored.email.state, "FAILED");
    assert.equal(stored.email.claimToken, null);
    assert.equal(stored.inApp.state, "HIDDEN");
  },
);

await check(
  "PERSONAL provider boundary denies non-owner and wrong owner role under full claim CAS",
  async () => {
    const cases = [
      {
        label: "non-owner",
        delivery: makeDelivery(),
        firm: {
          _id: IDS.firm,
          isActive: true,
          kind: "PERSONAL",
          ownerUserId: IDS.owner,
        },
        recipient: makeUser(),
        membership: makeMembership({ role: "OWNER" }),
        outcome: "DIGEST_PERSONAL_RECIPIENT_NOT_OWNER",
        lastError: "Personal firm digest recipient is not the firm owner",
      },
      {
        label: "owner with ADMIN membership",
        delivery: makeDelivery({ recipientUserId: IDS.owner }),
        firm: {
          _id: IDS.firm,
          isActive: true,
          kind: "PERSONAL",
          ownerUserId: IDS.owner,
        },
        recipient: makeUser({ _id: IDS.owner }),
        membership: makeMembership({ userId: IDS.owner, role: "ADMIN" }),
        outcome: "DIGEST_PERSONAL_OWNER_AUTHORITY_REVOKED",
        lastError:
          "Personal firm owner no longer has an active OWNER membership",
      },
    ];

    for (const testCase of cases) {
      const harness = createProcessHarness(testCase);
      const result = await harness.run();
      const stored = harness.store.get(IDS.deliveryA);

      assert.deepEqual(
        result,
        { outcome: testCase.outcome, deliveryId: IDS.deliveryA },
        testCase.label,
      );
      assert.equal(stored.status, "FAILED", testCase.label);
      assert.equal(stored.email.state, "DISABLED", testCase.label);
      assert.equal(stored.email.lastError, testCase.lastError, testCase.label);
      assert.equal(stored.email.claimToken, null, testCase.label);
      assert.equal(stored.email.claimedAt, null, testCase.label);
      assert.equal(stored.inApp.state, "HIDDEN", testCase.label);
      assert.equal(stored.inApp.availableAt, null, testCase.label);
      assert.equal(stored.inApp.readAt, null, testCase.label);
      assert.equal(harness.providerCalls.length, 0, testCase.label);
      assert.equal(harness.activityCalls.length, 0, testCase.label);

      const claimOperation = harness.store.operations.find(
        (operation) =>
          operation.method === "findOneAndUpdate" &&
          operation.update?.$set?.["email.state"] === "SENDING",
      );
      const policyWrite = harness.store.operations.find(
        (operation) =>
          operation.method === "updateOne" &&
          operation.update?.$set?.["email.lastError"] === testCase.lastError,
      );
      assertFullClaimFence(policyWrite?.filter, {
        claimToken: claimOperation.update.$set["email.claimToken"],
        attempts: 0,
        label: testCase.label,
      });
      assert.deepEqual(
        policyWrite?.update,
        {
          $set: {
            status: "FAILED",
            "email.state": "DISABLED",
            "email.lastError": testCase.lastError,
            "email.claimToken": null,
            "email.claimedAt": null,
            "inApp.state": "HIDDEN",
            "inApp.availableAt": null,
            "inApp.readAt": null,
          },
        },
        testCase.label,
      );
    }
  },
);

await check(
  "weekly MEMBER with global FIRM_ADMIN is denied and hidden",
  async () => {
    const delivery = makeDelivery({
      kind: WEEKLY_KIND,
      periodKey: "2026-03-16",
      subject: "Weekly firm summary · 2026-03-16",
      summary: { kind: WEEKLY_KIND },
    });
    const harness = createProcessHarness({
      delivery,
      recipient: makeUser({ role: "FIRM_ADMIN" }),
      membership: makeMembership({ role: "MEMBER" }),
    });
    const result = await harness.run();
    const stored = harness.store.get(IDS.deliveryA);

    assert.equal(result.outcome, "DIGEST_WEEKLY_AUTHORITY_REVOKED");
    assert.equal(harness.providerCalls.length, 0);
    assert.equal(stored.email.state, "DISABLED");
    assert.equal(stored.email.claimToken, null);
    assert.equal(stored.inApp.state, "HIDDEN");
    assert.equal(stored.inApp.availableAt, null);
  },
);

await check("ACTIVE OWNER has weekly digest authority", () => {
  assert.equal(
    hasWeeklyDigestAuthority({
      membership: makeMembership({ status: "ACTIVE", role: "OWNER" }),
      user: makeUser({ role: "MEMBER" }),
    }),
    true,
  );
});

await check("ACTIVE ADMIN has weekly digest authority", () => {
  assert.equal(
    hasWeeklyDigestAuthority({
      membership: makeMembership({ status: "ACTIVE", role: "ADMIN" }),
      user: makeUser({ role: "MEMBER" }),
    }),
    true,
  );
});

await check(
  "ACTIVE MEMBER with global SUPER_ADMIN has weekly digest authority",
  () => {
    assert.equal(
      hasWeeklyDigestAuthority({
        membership: makeMembership({ status: "ACTIVE", role: "MEMBER" }),
        user: makeUser({ role: "SUPER_ADMIN" }),
      }),
      true,
    );
  },
);

await check("non-ACTIVE membership has no weekly digest authority", () => {
  assert.equal(
    hasWeeklyDigestAuthority({
      membership: makeMembership({ status: "REMOVED", role: "OWNER" }),
      user: makeUser({ role: "SUPER_ADMIN" }),
    }),
    false,
  );
});

await check(
  "global SUPER_ADMIN without membership has no weekly digest authority",
  () => {
    assert.equal(
      hasWeeklyDigestAuthority({
        membership: null,
        user: makeUser({ role: "SUPER_ADMIN" }),
      }),
      false,
    );
  },
);

await check(
  "provider failure is token-guarded, recoverable in-app, counted, and rethrown",
  async () => {
    const providerError = new Error("Injected provider failure");
    const harness = createProcessHarness({
      provider: async () => {
        throw providerError;
      },
    });

    let thrown;
    try {
      await harness.run();
    } catch (error) {
      thrown = error;
    }

    assert.equal(thrown, providerError);
    assert.equal(harness.providerCalls.length, 1);
    const stored = harness.store.get(IDS.deliveryA);
    assert.equal(stored.status, "PARTIAL");
    assert.equal(stored.email.state, "FAILED");
    assert.equal(stored.email.claimToken, null);
    assert.equal(stored.email.claimedAt, null);
    assert.equal(stored.email.attempts, 1);
    assert.equal(stored.email.lastError, providerError.message);
    assert.equal(stored.inApp.state, "AVAILABLE");
    assert.equal(
      stored.inApp.availableAt.toISOString(),
      FIXED_NOW.toISOString(),
    );

    const claimOperation = harness.store.operations.find(
      (operation) =>
        operation.method === "findOneAndUpdate" &&
        operation.update?.$set?.["email.state"] === "SENDING",
    );
    const failureOperation = harness.store.operations.find(
      (operation) =>
        operation.method === "updateOne" &&
        operation.update?.$set?.["email.state"] === "FAILED",
    );
    assert.ok(claimOperation?.update?.$set?.["email.claimToken"]);
    assertFullClaimFence(failureOperation?.filter, {
      claimToken: claimOperation.update.$set["email.claimToken"],
      attempts: 0,
      label: "provider failure",
    });
    assert.equal(
      harness.activityCalls[0]?.action,
      "DIGEST_EMAIL_FAILED_IN_APP_AVAILABLE",
    );
  },
);

await check(
  "process defers a non-stale SENDING claim without calling provider",
  async () => {
    const claimedAt = new Date(FIXED_NOW.getTime() - SEND_CLAIM_STALE_MS + 1);
    const harness = createProcessHarness({
      delivery: makeDelivery({
        email: {
          state: "SENDING",
          claimToken: "current-worker",
          claimedAt,
        },
      }),
    });

    const result = await harness.run();
    const stored = harness.store.get(IDS.deliveryA);

    assert.deepEqual(result, {
      outcome: "DIGEST_SEND_IN_PROGRESS",
      deliveryId: IDS.deliveryA,
      defer: true,
      reason: "Another worker owns the digest send claim",
      retryAfterMs: 30 * 1000,
    });
    assert.equal(harness.providerCalls.length, 0);
    assert.equal(stored.email.state, "SENDING");
    assert.equal(stored.email.claimToken, "current-worker");
    assert.equal(stored.email.claimedAt.toISOString(), claimedAt.toISOString());
  },
);

await check("process reclaims a stale SENDING claim and sends it", async () => {
  const harness = createProcessHarness({
    delivery: makeDelivery({
      email: {
        state: "SENDING",
        claimToken: "dead-worker",
        claimedAt: new Date(FIXED_NOW.getTime() - SEND_CLAIM_STALE_MS - 1),
      },
    }),
  });

  const result = await harness.run();
  const stored = harness.store.get(IDS.deliveryA);
  const claimOperation = harness.store.operations.find(
    (operation) =>
      operation.method === "findOneAndUpdate" &&
      operation.update?.$set?.["email.state"] === "SENDING",
  );

  assert.equal(result.outcome, "DIGEST_EMAIL_SENT");
  assert.equal(harness.providerCalls.length, 1);
  assert.ok(claimOperation?.update?.$set?.["email.claimToken"]);
  assert.notEqual(
    claimOperation.update.$set["email.claimToken"],
    "dead-worker",
  );
  assert.equal(stored.email.state, "SENT");
  assert.equal(stored.email.claimToken, null);
  assert.equal(stored.email.claimedAt, null);
  assert.equal(stored.email.attempts, 1);
});

await check("process refuses an ordinary FAILED delivery", async () => {
  const availableAt = new Date(FIXED_NOW.getTime() - 60 * 1000);
  const harness = createProcessHarness({
    delivery: makeDelivery({
      status: "PARTIAL",
      email: {
        state: "FAILED",
        attempts: 1,
        lastError: "Earlier provider failure",
      },
      inApp: {
        state: "AVAILABLE",
        availableAt,
      },
    }),
  });

  const result = await harness.run();
  const stored = harness.store.get(IDS.deliveryA);

  assert.deepEqual(result, {
    outcome: "DIGEST_EMAIL_NOT_PENDING",
    deliveryId: IDS.deliveryA,
  });
  assert.equal(harness.providerCalls.length, 0);
  assert.equal(stored.email.state, "FAILED");
  assert.equal(stored.email.attempts, 1);
  assert.equal(stored.email.claimToken, null);
  assert.equal(stored.inApp.state, "AVAILABLE");
  assert.equal(
    stored.inApp.availableAt.toISOString(),
    availableAt.toISOString(),
  );
});

await check(
  "successful send update is guarded by id, generated claim token, and SENDING",
  async () => {
    const harness = createProcessHarness();
    await harness.run();

    const claimOperation = harness.store.operations.find(
      (operation) =>
        operation.method === "findOneAndUpdate" &&
        operation.update?.$set?.["email.state"] === "SENDING",
    );
    const successOperation = harness.store.operations.find(
      (operation) =>
        operation.method === "updateOne" &&
        operation.update?.$set?.["email.state"] === "SENT",
    );
    const generatedClaimToken =
      claimOperation?.update?.$set?.["email.claimToken"];

    assert.equal(typeof generatedClaimToken, "string");
    assert.ok(generatedClaimToken.length > 0);
    assertFullClaimFence(successOperation?.filter, {
      claimToken: generatedClaimToken,
      attempts: 0,
      label: "successful send",
    });
  },
);

await check(
  "successful provider response cannot terminalize a replacement claim",
  async () => {
    let harness;
    harness = createProcessHarness({
      provider: async () => {
        await harness.store.model.updateOne(
          { _id: IDS.deliveryA, "email.state": "SENDING" },
          {
            $set: {
              "email.claimToken": "replacement-worker",
              "email.claimedAt": new Date(FIXED_NOW),
            },
          },
        );
        return { data: { id: "provider-accepted-before-takeover" } };
      },
    });

    const result = await harness.run();
    const stored = harness.store.get(IDS.deliveryA);

    assert.deepEqual(result, {
      outcome: "DIGEST_CLAIM_LOST",
      deliveryId: IDS.deliveryA,
      defer: true,
      reason: "Digest send claim changed before completion",
      retryAfterMs: 30 * 1000,
    });
    assert.equal(stored.email.state, "SENDING");
    assert.equal(stored.email.claimToken, "replacement-worker");
    assert.equal(stored.email.attempts, 0);
    assert.equal(harness.activityCalls.length, 0);
  },
);

await check(
  "provider failure cannot fail or clear a replacement claim",
  async () => {
    const providerError = new Error("old worker provider failure");
    let harness;
    harness = createProcessHarness({
      provider: async () => {
        await harness.store.model.updateOne(
          { _id: IDS.deliveryA, "email.state": "SENDING" },
          {
            $set: {
              "email.claimToken": "replacement-worker",
              "email.claimedAt": new Date(FIXED_NOW),
            },
          },
        );
        throw providerError;
      },
    });

    const result = await harness.run();
    const stored = harness.store.get(IDS.deliveryA);

    assert.equal(result.outcome, "DIGEST_CLAIM_LOST");
    assert.equal(result.defer, true);
    assert.equal(stored.email.state, "SENDING");
    assert.equal(stored.email.claimToken, "replacement-worker");
    assert.equal(stored.email.lastError, "");
    assert.equal(stored.email.attempts, 0);
    assert.equal(harness.activityCalls.length, 0);
  },
);

await check(
  "provider failure then retry reuses business key and preserves in-app availability",
  async () => {
    const providerError = new Error("Injected first-attempt failure");
    let providerAttempt = 0;
    const harness = createProcessHarness({
      provider: async () => {
        providerAttempt += 1;
        if (providerAttempt === 1) throw providerError;
        return { data: { id: "provider-message-retry" } };
      },
    });

    await assert.rejects(
      () => harness.run(),
      (error) => error === providerError,
    );

    const afterFailure = harness.store.get(IDS.deliveryA);
    assert.equal(harness.providerCalls.length, 1);
    assert.equal(afterFailure.status, "PARTIAL");
    assert.equal(afterFailure.email.state, "FAILED");
    assert.equal(afterFailure.email.claimToken, null);
    assert.equal(afterFailure.email.claimedAt, null);
    assert.equal(afterFailure.email.attempts, 1);
    assert.equal(afterFailure.inApp.state, "AVAILABLE");
    assert.equal(
      afterFailure.inApp.availableAt.toISOString(),
      FIXED_NOW.toISOString(),
    );

    const retryResult = await harness.run();
    const afterRetry = harness.store.get(IDS.deliveryA);

    assert.deepEqual(retryResult, {
      outcome: "DIGEST_EMAIL_NOT_PENDING",
      deliveryId: IDS.deliveryA,
    });
    assert.equal(harness.providerCalls.length, 1);
    assert.equal(
      harness.providerCalls[0].idempotencyKey,
      expectedBusinessKey(),
    );
    assert.equal(afterRetry.status, "PARTIAL");
    assert.equal(afterRetry.email.state, "FAILED");
    assert.equal(afterRetry.email.claimToken, null);
    assert.equal(afterRetry.email.claimedAt, null);
    assert.equal(afterRetry.email.attempts, 1);
    assert.equal(afterRetry.email.lastError, providerError.message);
    assert.equal(afterRetry.inApp.state, "AVAILABLE");
    assert.equal(
      afterRetry.inApp.availableAt.toISOString(),
      afterFailure.inApp.availableAt.toISOString(),
    );
  },
);

await check(
  "legacy delivery retries reuse exact digest-delivery provider key",
  async () => {
    const providerError = new Error("legacy provider attempt failed");
    let providerAttempt = 0;
    const harness = createProcessHarness({
      delivery: makeDelivery({ email: { idempotencyKey: null } }),
      provider: async () => {
        providerAttempt += 1;
        if (providerAttempt === 1) throw providerError;
        return { data: { id: "legacy-provider-retry" } };
      },
    });

    await assert.rejects(
      () => harness.run(),
      (error) => error === providerError,
    );
    const result = await harness.run();

    assert.deepEqual(result, {
      outcome: "DIGEST_EMAIL_NOT_PENDING",
      deliveryId: IDS.deliveryA,
    });
    assert.equal(harness.providerCalls.length, 1);
    assert.equal(
      harness.providerCalls[0].idempotencyKey,
      `digest-delivery:${IDS.deliveryA}`,
    );
    assert.equal(harness.store.get(IDS.deliveryA).email.state, "FAILED");
  },
);

await check(
  "ACTIVE OWNER passes the full weekly process and provider path",
  async () => {
    const delivery = makeDelivery({
      kind: WEEKLY_KIND,
      periodKey: "2026-03-16",
      subject: "Weekly firm summary · 2026-03-16",
      summary: { kind: WEEKLY_KIND },
    });
    const harness = createProcessHarness({
      delivery,
      membership: makeMembership({ status: "ACTIVE", role: "OWNER" }),
    });

    const result = await harness.run();

    assert.equal(result.outcome, "DIGEST_EMAIL_SENT");
    assert.equal(harness.providerCalls.length, 1);
    assert.equal(
      harness.providerCalls[0].idempotencyKey,
      expectedBusinessKey(delivery),
    );
    assert.equal(harness.store.get(IDS.deliveryA).email.state, "SENT");
  },
);

await check(
  "ACTIVE ADMIN passes the full weekly process and provider path",
  async () => {
    const delivery = makeDelivery({
      kind: WEEKLY_KIND,
      periodKey: "2026-03-16",
      subject: "Weekly firm summary · 2026-03-16",
      summary: { kind: WEEKLY_KIND },
    });
    const harness = createProcessHarness({
      delivery,
      membership: makeMembership({ status: "ACTIVE", role: "ADMIN" }),
    });

    const result = await harness.run();

    assert.equal(result.outcome, "DIGEST_EMAIL_SENT");
    assert.equal(harness.providerCalls.length, 1);
    assert.equal(
      harness.providerCalls[0].idempotencyKey,
      expectedBusinessKey(delivery),
    );
    assert.equal(harness.store.get(IDS.deliveryA).email.state, "SENT");
  },
);

await check(
  "ACTIVE MEMBER with global SUPER_ADMIN passes the full weekly process",
  async () => {
    const delivery = makeDelivery({
      kind: WEEKLY_KIND,
      periodKey: "2026-03-16",
      subject: "Weekly firm summary · 2026-03-16",
      summary: { kind: WEEKLY_KIND },
    });
    const harness = createProcessHarness({
      delivery,
      recipient: makeUser({ role: "SUPER_ADMIN" }),
      membership: makeMembership({ status: "ACTIVE", role: "MEMBER" }),
    });

    const result = await harness.run();

    assert.equal(result.outcome, "DIGEST_EMAIL_SENT");
    assert.equal(harness.providerCalls.length, 1);
    assert.equal(
      harness.providerCalls[0].idempotencyKey,
      expectedBusinessKey(delivery),
    );
    assert.equal(harness.store.get(IDS.deliveryA).email.state, "SENT");
  },
);

await check(
  "global SUPER_ADMIN without ACTIVE membership is denied in full weekly process",
  async () => {
    const delivery = makeDelivery({
      kind: WEEKLY_KIND,
      periodKey: "2026-03-16",
      subject: "Weekly firm summary · 2026-03-16",
      summary: { kind: WEEKLY_KIND },
    });
    const harness = createProcessHarness({
      delivery,
      recipient: makeUser({ role: "SUPER_ADMIN" }),
      membership: null,
    });

    const result = await harness.run();
    const stored = harness.store.get(IDS.deliveryA);

    assert.equal(result.outcome, "DIGEST_MEMBERSHIP_UNAVAILABLE");
    assert.equal(harness.providerCalls.length, 0);
    assert.equal(stored.email.state, "DISABLED");
    assert.equal(stored.email.claimToken, null);
    assert.equal(stored.inApp.state, "HIDDEN");
    assert.equal(stored.inApp.availableAt, null);
  },
);

await check("valid simple-collation exact index passes alone", async () => {
  const requirement = REQUIRED_DIGEST_INDEXES[0];
  const readiness = await getDigestIndexReadiness({
    requirements: [requirement],
    indexLoader: async () => [
      {
        name: "valid_simple_collation",
        key: { ...requirement.key },
        unique: true,
        collation: { locale: "simple" },
      },
    ],
  });

  assert.deepEqual(readiness, {
    ready: true,
    checked: 1,
    missing: [],
    diagnostics: [],
  });
});

await check(
  "valid exact index fails closed with malformed lookalike",
  async () => {
    const requirement = REQUIRED_DIGEST_INDEXES[0];
    const coexistenceCases = [
      {
        label: "partial",
        reason: "partial",
        code: "INDEX_PARTIAL_FILTER",
        index: {
          name: "lookalike_partial",
          key: { ...requirement.key },
          unique: true,
          partialFilterExpression: { firmId: { $exists: true } },
        },
      },
      {
        label: "sparse",
        reason: "sparse",
        code: "INDEX_SPARSE",
        index: {
          name: "lookalike_sparse",
          key: { ...requirement.key },
          unique: true,
          sparse: true,
        },
      },
      {
        label: "non-simple collation",
        reason: "non-simple-collation",
        code: "INDEX_COLLATION_NOT_SIMPLE",
        index: {
          name: "lookalike_non_simple_collation",
          key: { ...requirement.key },
          unique: true,
          collation: { locale: "en", strength: 2 },
        },
      },
      {
        label: "hidden",
        reason: "hidden",
        code: "INDEX_HIDDEN",
        index: {
          name: "lookalike_hidden",
          key: { ...requirement.key },
          unique: true,
          hidden: true,
        },
      },
      {
        label: "prepareUnique",
        reason: "prepare-unique",
        code: "INDEX_PREPARE_UNIQUE",
        index: {
          name: "lookalike_prepare_unique",
          key: { ...requirement.key },
          unique: true,
          prepareUnique: true,
        },
      },
      {
        label: "TTL",
        reason: "ttl",
        code: "INDEX_TTL",
        index: {
          name: "lookalike_ttl",
          key: { ...requirement.key },
          unique: true,
          expireAfterSeconds: 3600,
        },
      },
      {
        label: "wildcard",
        reason: "wildcard",
        code: "INDEX_WILDCARD",
        index: {
          name: "lookalike_wildcard",
          key: { ...requirement.key },
          unique: true,
          wildcardProjection: { firmId: 1 },
        },
      },
      {
        label: "nonunique",
        reason: "non-unique",
        code: "INDEX_NOT_UNIQUE",
        index: {
          name: "lookalike_non_unique",
          key: { ...requirement.key },
          unique: false,
        },
      },
    ];

    for (const testCase of coexistenceCases) {
      const readiness = await getDigestIndexReadiness({
        requirements: [requirement],
        indexLoader: async () => [
          {
            name: "valid_simple_collation",
            key: { ...requirement.key },
            unique: true,
            collation: { locale: "simple" },
          },
          testCase.index,
        ],
      });

      assert.equal(readiness.ready, false, testCase.label);
      assert.equal(readiness.diagnostics.length, 1, testCase.label);
      assert.equal(
        readiness.diagnostics[0].reason,
        testCase.reason,
        testCase.label,
      );
      assert.equal(
        readiness.diagnostics[0].code,
        testCase.code,
        testCase.label,
      );
      assert.equal(
        readiness.diagnostics[0].actualIndex.name,
        testCase.index.name,
        testCase.label,
      );
    }
  },
);

await check(
  "valid exact index fails closed with wrong order for both required descriptors",
  async () => {
    assert.equal(REQUIRED_DIGEST_INDEXES.length, 2);
    for (const requirement of REQUIRED_DIGEST_INDEXES) {
      const wrongOrderKey = Object.fromEntries(
        Object.entries(requirement.key).reverse(),
      );
      const wrongOrderIndex = {
        name: `wrong_order_${requirement.model.modelName}`,
        key: wrongOrderKey,
        unique: true,
      };
      const readiness = await getDigestIndexReadiness({
        requirements: [requirement],
        indexLoader: async () => [readyIndex(requirement), wrongOrderIndex],
      });

      assert.equal(readiness.ready, false, requirement.label);
      assert.equal(readiness.checked, 1, requirement.label);
      assert.equal(readiness.diagnostics.length, 1, requirement.label);
      assert.equal(
        readiness.diagnostics[0].reason,
        "wrong-order",
        requirement.label,
      );
      assert.equal(
        readiness.diagnostics[0].code,
        "INDEX_KEY_ORDER_MISMATCH",
        requirement.label,
      );
      assert.deepEqual(
        readiness.diagnostics[0].actualIndex.key,
        wrongOrderKey,
        requirement.label,
      );
    }
  },
);

await check(
  "valid exact index fails closed with wrong direction for both required descriptors",
  async () => {
    assert.equal(REQUIRED_DIGEST_INDEXES.length, 2);
    for (const requirement of REQUIRED_DIGEST_INDEXES) {
      const keyEntries = Object.entries(requirement.key);
      const wrongDirectionKey = Object.fromEntries(
        keyEntries.map(([field, direction], index) => [
          field,
          index === keyEntries.length - 1
            ? -Number(direction)
            : Number(direction),
        ]),
      );
      const wrongDirectionIndex = {
        name: `wrong_direction_${requirement.model.modelName}`,
        key: wrongDirectionKey,
        unique: true,
      };
      const readiness = await getDigestIndexReadiness({
        requirements: [requirement],
        indexLoader: async () => [readyIndex(requirement), wrongDirectionIndex],
      });

      assert.equal(readiness.ready, false, requirement.label);
      assert.equal(readiness.checked, 1, requirement.label);
      assert.equal(readiness.diagnostics.length, 1, requirement.label);
      assert.equal(
        readiness.diagnostics[0].reason,
        "wrong-direction",
        requirement.label,
      );
      assert.equal(
        readiness.diagnostics[0].code,
        "INDEX_KEY_DIRECTION_MISMATCH",
        requirement.label,
      );
      assert.deepEqual(
        readiness.diagnostics[0].actualIndex.key,
        wrongDirectionKey,
        requirement.label,
      );
    }
  },
);

await check(
  "digest index readiness rejects a partial exact unique index",
  async () => {
    const requirement = REQUIRED_DIGEST_INDEXES[0];
    const partialFilterExpression = { firmId: { $exists: true } };
    const readiness = await getDigestIndexReadiness({
      requirements: [requirement],
      indexLoader: async () => [
        {
          name: "partial_unique",
          key: { ...requirement.key },
          unique: true,
          partialFilterExpression,
        },
      ],
    });

    assert.equal(readiness.ready, false);
    assert.equal(readiness.diagnostics.length, 1);
    assert.equal(readiness.diagnostics[0].reason, "partial");
    assert.equal(readiness.diagnostics[0].code, "INDEX_PARTIAL_FILTER");
    assert.deepEqual(
      readiness.diagnostics[0].actualIndex.partialFilterExpression,
      partialFilterExpression,
    );
    assert.equal(readiness.diagnostics[0].actualIndex.sparse, false);
    assert.equal(readiness.diagnostics[0].actualIndex.collation, null);
  },
);

await check(
  "digest index readiness rejects a sparse exact unique index",
  async () => {
    const requirement = REQUIRED_DIGEST_INDEXES[0];
    const readiness = await getDigestIndexReadiness({
      requirements: [requirement],
      indexLoader: async () => [
        {
          name: "sparse_unique",
          key: { ...requirement.key },
          unique: true,
          sparse: true,
        },
      ],
    });

    assert.equal(readiness.ready, false);
    assert.equal(readiness.diagnostics.length, 1);
    assert.equal(readiness.diagnostics[0].reason, "sparse");
    assert.equal(readiness.diagnostics[0].code, "INDEX_SPARSE");
    assert.equal(readiness.diagnostics[0].actualIndex.sparse, true);
    assert.equal(
      readiness.diagnostics[0].actualIndex.partialFilterExpression,
      null,
    );
    assert.equal(readiness.diagnostics[0].actualIndex.collation, null);
  },
);

await check(
  "digest index readiness rejects a non-simple collation",
  async () => {
    const requirement = REQUIRED_DIGEST_INDEXES[0];
    const collation = { locale: "en", strength: 2 };
    const readiness = await getDigestIndexReadiness({
      requirements: [requirement],
      indexLoader: async () => [
        {
          name: "collated_unique",
          key: { ...requirement.key },
          unique: true,
          collation,
        },
      ],
    });

    assert.equal(readiness.ready, false);
    assert.equal(readiness.diagnostics.length, 1);
    assert.equal(readiness.diagnostics[0].reason, "non-simple-collation");
    assert.equal(readiness.diagnostics[0].code, "INDEX_COLLATION_NOT_SIMPLE");
    assert.deepEqual(readiness.diagnostics[0].actualIndex.collation, collation);
    assert.equal(readiness.diagnostics[0].actualIndex.sparse, false);
    assert.equal(
      readiness.diagnostics[0].actualIndex.partialFilterExpression,
      null,
    );
  },
);

await check(
  "digest index readiness rejects hidden, prepareUnique, TTL, and wildcard options",
  async () => {
    const requirement = REQUIRED_DIGEST_INDEXES[0];
    const incompatibleCases = [
      {
        option: { hidden: true },
        reason: "hidden",
        code: "INDEX_HIDDEN",
      },
      {
        option: { prepareUnique: true },
        reason: "prepare-unique",
        code: "INDEX_PREPARE_UNIQUE",
      },
      {
        option: { expireAfterSeconds: 3600 },
        reason: "ttl",
        code: "INDEX_TTL",
      },
      {
        option: { wildcardProjection: { firmId: 1 } },
        reason: "wildcard",
        code: "INDEX_WILDCARD",
      },
    ];

    for (const incompatible of incompatibleCases) {
      const readiness = await getDigestIndexReadiness({
        requirements: [requirement],
        indexLoader: async () => [
          {
            name: `incompatible_${incompatible.reason}`,
            key: { ...requirement.key },
            unique: true,
            ...incompatible.option,
          },
        ],
      });

      assert.equal(readiness.ready, false);
      assert.equal(readiness.diagnostics.length, 1);
      assert.equal(readiness.diagnostics[0].reason, incompatible.reason);
      assert.equal(readiness.diagnostics[0].code, incompatible.code);
    }
  },
);

await check("required digest indexes expose exactly two descriptors", () => {
  const descriptors = REQUIRED_DIGEST_INDEXES.map(
    ({ model, label, key, unique }) => ({
      model: model.modelName,
      label,
      key,
      unique,
    }),
  );

  assert.deepEqual(descriptors, [
    {
      model: "DigestDelivery",
      label: "DigestDelivery recipient-period uniqueness",
      key: { firmId: 1, kind: 1, periodKey: 1, recipientUserId: 1 },
      unique: true,
    },
    {
      model: "AutomationJob",
      label: "AutomationJob idempotency uniqueness",
      key: { firmId: 1, kind: 1, idempotencyKey: 1 },
      unique: true,
    },
  ]);
});

await check(
  "digest index readiness succeeds for exact ordered unique indexes",
  async () => {
    const readiness = await getDigestIndexReadiness({
      indexLoader: async (_model, requirement) => [
        { name: "_id_", key: { _id: 1 } },
        readyIndex(requirement),
      ],
    });

    assert.deepEqual(readiness, {
      ready: true,
      checked: 2,
      missing: [],
      diagnostics: [],
    });
  },
);

await check("digest index readiness reports a missing index", async () => {
  const missingRequirement = REQUIRED_DIGEST_INDEXES[1];
  const readiness = await getDigestIndexReadiness({
    indexLoader: async (_model, requirement) =>
      requirement === missingRequirement
        ? [{ name: "_id_", key: { _id: 1 } }]
        : [readyIndex(requirement)],
  });

  assert.equal(readiness.ready, false);
  assert.equal(readiness.checked, 2);
  assert.equal(readiness.diagnostics.length, 1);
  assert.equal(readiness.diagnostics[0].label, missingRequirement.label);
  assert.equal(readiness.diagnostics[0].reason, "missing");
  assert.equal(readiness.diagnostics[0].code, "INDEX_MISSING");
  assert.equal(readiness.diagnostics[0].actualIndex, null);
});

await check(
  "digest index readiness treats NamespaceNotFound as missing",
  async () => {
    const requirement = REQUIRED_DIGEST_INDEXES[0];
    const readiness = await getDigestIndexReadiness({
      requirements: [requirement],
      indexLoader: async () => {
        const error = new Error("namespace is absent");
        error.codeName = "NamespaceNotFound";
        error.code = 26;
        throw error;
      },
    });

    assert.equal(readiness.ready, false);
    assert.equal(readiness.checked, 1);
    assert.equal(readiness.diagnostics.length, 1);
    assert.equal(readiness.diagnostics[0].reason, "missing");
    assert.equal(readiness.diagnostics[0].code, "INDEX_MISSING");
  },
);

await check(
  "digest index readiness rejects the right fields in the wrong order",
  async () => {
    const requirement = REQUIRED_DIGEST_INDEXES[0];
    const readiness = await getDigestIndexReadiness({
      requirements: [requirement],
      indexLoader: async () => [
        {
          name: "wrong_order",
          key: { recipientUserId: 1, periodKey: 1, kind: 1, firmId: 1 },
          unique: true,
        },
      ],
    });

    assert.equal(readiness.ready, false);
    assert.equal(readiness.diagnostics.length, 1);
    assert.equal(readiness.diagnostics[0].reason, "wrong-order");
    assert.equal(readiness.diagnostics[0].code, "INDEX_KEY_ORDER_MISMATCH");
    assert.deepEqual(readiness.diagnostics[0].actualIndex.key, {
      recipientUserId: 1,
      periodKey: 1,
      kind: 1,
      firmId: 1,
    });
  },
);

await check(
  "digest index readiness rejects an exact non-unique index",
  async () => {
    const requirement = REQUIRED_DIGEST_INDEXES[0];
    const readiness = await getDigestIndexReadiness({
      requirements: [requirement],
      indexLoader: async () => [
        {
          name: "not_unique",
          key: { ...requirement.key },
          unique: false,
        },
      ],
    });

    assert.equal(readiness.ready, false);
    assert.equal(readiness.diagnostics.length, 1);
    assert.equal(readiness.diagnostics[0].reason, "non-unique");
    assert.equal(readiness.diagnostics[0].code, "INDEX_NOT_UNIQUE");
    assert.equal(readiness.diagnostics[0].actualIndex.unique, false);
  },
);

await check(
  "digest index assertion exposes 503, code, and readiness diagnostics",
  async () => {
    const requirement = REQUIRED_DIGEST_INDEXES[0];
    await assert.rejects(
      () =>
        assertDigestIndexesReady({
          requirements: [requirement],
          indexLoader: async () => [],
        }),
      (error) => {
        assert.equal(error.statusCode, 503);
        assert.equal(error.code, "DIGEST_INDEXES_NOT_READY");
        assert.equal(error.readiness.ready, false);
        assert.equal(error.readiness.checked, 1);
        assert.equal(error.readiness.diagnostics.length, 1);
        assert.equal(error.readiness.diagnostics[0].code, "INDEX_MISSING");
        return true;
      },
    );
  },
);

await check(
  "digest recovery cursor is a strict durable singleton with expiring lease",
  () => {
    assert.equal(
      DigestRecoveryCursor.collection.name,
      "digest_recovery_cursors",
    );
    assert.equal(DigestRecoveryCursor.schema.options.strict, "throw");
    assert.equal(DigestRecoveryCursor.schema.options.versionKey, false);
    assert.deepEqual(DigestRecoveryCursor.schema.path("_id").enumValues, [
      DIGEST_RECOVERY_CURSOR_ID,
    ]);
    assert.equal(
      DigestRecoveryCursor.schema.path("afterId").instance,
      "ObjectId",
    );
    assert.equal(
      DigestRecoveryCursor.schema.path("cycleEndId").instance,
      "ObjectId",
    );
    assert.equal(
      DigestRecoveryCursor.schema.path("lease.token").instance,
      "String",
    );
    assert.equal(
      DigestRecoveryCursor.schema.path("lease.token").options.maxlength,
      64,
    );
    assert.equal(
      DigestRecoveryCursor.schema.path("lease.token").options.trim,
      true,
    );
    assert.equal(
      DigestRecoveryCursor.schema.path("lease.expiresAt").instance,
      "Date",
    );
    assert.equal(
      DigestDelivery.schema.path("jobRecovery.token").instance,
      "String",
    );
    assert.equal(
      DigestDelivery.schema.path("jobRecovery.expiresAt").instance,
      "Date",
    );
    assert.equal(
      DigestDelivery.schema.path("jobRecovery.revision").instance,
      "Number",
    );
  },
);

await check(
  "digest delivery schema keeps optional persisted provider idempotency key",
  () => {
    const idempotencyKeyPath = DigestDelivery.schema.path(
      "email.idempotencyKey",
    );

    assert.ok(idempotencyKeyPath);
    assert.equal(idempotencyKeyPath.instance, "String");
    assert.equal(idempotencyKeyPath.defaultValue, null);
    assert.equal(idempotencyKeyPath.options.maxlength, 240);
    assert.equal(idempotencyKeyPath.options.required, undefined);
    assert.equal(idempotencyKeyPath.isRequired, undefined);
  },
);

await check(
  "server source guards bootstrap retries and ordered digest startup",
  () => {
    const serverSource = readFileSync(
      new URL("../src/server.js", import.meta.url),
      "utf8",
    );
    const startupDefinition = serverSource.indexOf(
      "export async function completeDigestStartup",
    );
    const readinessCall = serverSource.indexOf(
      "await assertIndexes();",
      startupDefinition,
    );
    const shutdownAfterIndexes = serverSource.indexOf(
      "if (isShuttingDown()) return false;",
      readinessCall,
    );
    const drainCall = serverSource.indexOf(
      "await drainRecovery();",
      shutdownAfterIndexes,
    );
    const shutdownAfterDrain = serverSource.indexOf(
      "if (isShuttingDown()) return false;",
      shutdownAfterIndexes + 1,
    );
    const schedulerCall = serverSource.indexOf(
      "await startSchedulers();",
      drainCall,
    );
    const readyCall = serverSource.indexOf("setReady(true);", schedulerCall);
    const initializingCall = serverSource.indexOf(
      "setBackgroundReadiness(false);",
    );
    const listenCall = serverSource.indexOf("app.listen(");

    assert.ok(startupDefinition >= 0, "digest startup seam is missing");
    assert.ok(readinessCall > startupDefinition, "index phase is missing");
    assert.ok(
      shutdownAfterIndexes > readinessCall,
      "shutdown guard after index phase is missing",
    );
    assert.ok(
      drainCall > shutdownAfterIndexes,
      "recovery drain phase is missing",
    );
    assert.ok(
      shutdownAfterDrain > drainCall,
      "shutdown guard after drain phase is missing",
    );
    assert.ok(
      schedulerCall > shutdownAfterDrain,
      "scheduler starts before recovery drain completes",
    );
    assert.ok(
      readyCall > schedulerCall,
      "background readiness is set before schedulers start",
    );
    assert.match(
      serverSource,
      /return completeDigestStartup\(\{\s*assertIndexes: assertDigestIndexesReady,\s*drainRecovery: drainDigestRecovery,\s*startSchedulers,\s*setReady: setBackgroundReadiness,\s*isShuttingDown: \(\) => shuttingDown,\s*\}\);/,
      "bootstrap does not inject the complete digest startup phases",
    );
    assert.ok(
      initializingCall >= 0 && initializingCall < listenCall,
      "server does not mark background initialization before listen",
    );
    assert.match(serverSource, /const BOOTSTRAP_RETRY_DELAY_MS = 30 \* 1000;/);
    assert.match(serverSource, /let databaseConnectionInitialized = false;/);
    assert.match(
      serverSource,
      /if \(!databaseConnectionInitialized\) \{\s*await connectDB\(\);\s*databaseConnectionInitialized = true;\s*\}/,
      "database initialization is not guarded across bootstrap retries",
    );
    assert.equal(
      serverSource.match(/\bconnectDB\(\);/g)?.length,
      1,
      "bootstrap contains an additional unguarded connectDB call",
    );
    assert.match(
      serverSource,
      /if \(shuttingDown \|\| bootstrapRetryTimer\) return;/,
    );
    assert.match(
      serverSource,
      /if \(shuttingDown \|\| bootstrapPromise\) return bootstrapPromise;/,
    );
    assert.match(
      serverSource,
      /if \(shuttingDown \|\| schedulersStarted\) return false;/,
    );
    assert.match(serverSource, /clearTimeout\(bootstrapRetryTimer\);/);
    assert.match(serverSource, /scheduleBootstrapRetry\(\);/);
    assert.match(serverSource, /void runBootstrap\(\);/);
  },
);

await check(
  "stale job pointer is repaired to an existing business job without enqueue",
  async () => {
    const delivery = makeDelivery({ automationJobId: IDS.pointerOnly });
    const businessJob = makeAutomationJob({
      _id: IDS.jobB,
      idempotencyKey: expectedBusinessKey(delivery),
      status: "PENDING",
    });
    const deliveryStore = createInMemoryDigestDelivery([delivery]);
    const automationJobs = createInMemoryAutomationJob([businessJob]);
    let enqueueCalls = 0;

    const result = await enqueueRecipientDigest(
      {
        firm: { _id: IDS.firm, timezone: "UTC" },
        recipient: makeUser(),
        kind: DAILY_KIND,
        periodKey: delivery.periodKey,
        noticeCasesEnabled: false,
        now: new Date(FIXED_NOW),
      },
      {
        AutomationJob: automationJobs.model,
        DigestDelivery: deliveryStore.model,
        recoveryClock: () => new Date(FIXED_NOW),
        enqueueJob: async () => {
          enqueueCalls += 1;
          throw new Error("existing business job must prevent enqueue");
        },
      },
    );

    assert.equal(enqueueCalls, 0);
    assertObjectIdEquals(result.automationJobId, IDS.jobB);
    assertObjectIdEquals(
      deliveryStore.get(IDS.deliveryA).automationJobId,
      IDS.jobB,
    );
    assert.equal(automationJobs.get(IDS.jobB).status, "PENDING");
    assert.ok(
      automationJobs.operations.some((operation) =>
        queryHasLiteralEquality(
          operation.filter,
          "idempotencyKey",
          expectedBusinessKey(delivery),
        ),
      ),
    );
  },
);

await check(
  "stale job pointer is repaired to one newly enqueued business job",
  async () => {
    const delivery = makeDelivery({ automationJobId: IDS.pointerOnly });
    const deliveryStore = createInMemoryDigestDelivery([delivery]);
    const automationJobs = createInMemoryAutomationJob();
    const enqueueInputs = [];

    const result = await enqueueRecipientDigest(
      {
        firm: { _id: IDS.firm, timezone: "UTC" },
        recipient: makeUser(),
        kind: DAILY_KIND,
        periodKey: delivery.periodKey,
        noticeCasesEnabled: false,
        now: new Date(FIXED_NOW),
      },
      {
        AutomationJob: automationJobs.model,
        DigestDelivery: deliveryStore.model,
        recoveryClock: () => new Date(FIXED_NOW),
        enqueueJob: async (input) => {
          enqueueInputs.push(clone(input));
          const job = makeAutomationJob({
            _id: IDS.jobB,
            idempotencyKey: input.idempotencyKey,
            status: "PENDING",
          });
          automationJobs.insert(job);
          return clone(job);
        },
      },
    );

    assert.equal(enqueueInputs.length, 1);
    assert.equal(
      enqueueInputs[0].idempotencyKey,
      expectedBusinessKey(delivery),
    );
    assert.equal(enqueueInputs[0].payload.deliveryId, IDS.deliveryA);
    assertObjectIdEquals(result.automationJobId, IDS.jobB);
    assertObjectIdEquals(
      deliveryStore.get(IDS.deliveryA).automationJobId,
      IDS.jobB,
    );
    assert.equal(automationJobs.get(IDS.jobB).status, "PENDING");
  },
);

await check(
  "post-enqueue same-business race repairs only safe scalar payloads and quarantines absent payload without a second insert",
  async () => {
    const cases = [
      {
        label: "repairable wrong scalar",
        payload: { deliveryId: IDS.deliveryB },
        duplicateKey: false,
        expectedRepaired: true,
      },
      {
        label: "absent deliveryId",
        payload: {},
        duplicateKey: true,
        expectedRepaired: false,
      },
    ];

    for (const testCase of cases) {
      const delivery = makeDelivery({ automationJobId: null });
      const racedJob = makeAutomationJob({
        _id: IDS.jobB,
        idempotencyKey: expectedBusinessKey(delivery),
        payload: testCase.payload,
        status: "PENDING",
      });
      const deliveryStore = createInMemoryDigestDelivery([delivery]);
      const automationJobs = createInMemoryAutomationJob();
      let enqueueCalls = 0;
      let secondInsertAttempts = 0;
      let transactionCalls = 0;
      let postEnqueueReadStart = -1;

      const result = await enqueueRecipientDigest(
        {
          firm: makeFirm(),
          recipient: makeUser(),
          kind: DAILY_KIND,
          periodKey: delivery.periodKey,
          noticeCasesEnabled: false,
          now: new Date(FIXED_NOW),
        },
        {
          AutomationJob: automationJobs.model,
          DigestDelivery: deliveryStore.model,
          recoveryClock: () => new Date(FIXED_NOW),
          runRecoveryTransaction: async (work) => {
            transactionCalls += 1;
            return work({ id: `post-enqueue-race-${testCase.label}` });
          },
          enqueueJob: async () => {
            enqueueCalls += 1;
            if (enqueueCalls > 1) secondInsertAttempts += 1;
            postEnqueueReadStart = automationJobs.operations.length;
            automationJobs.insert(racedJob);
            if (testCase.duplicateKey) {
              const duplicate = new Error("duplicate digest business key");
              duplicate.code = 11000;
              throw duplicate;
            }
            return clone(racedJob);
          },
        },
      );

      const postEnqueueUnfilteredRead = automationJobs.operations
        .slice(postEnqueueReadStart)
        .find(
          (operation) =>
            operation.method === "findOne" &&
            queryHasLiteralEquality(
              operation.filter,
              "idempotencyKey",
              expectedBusinessKey(delivery),
            ) &&
            !queryHasTypeCheck(
              operation.filter,
              "payload.deliveryId",
              "string",
            ) &&
            !queryHasTypeCheck(
              operation.filter,
              "payload.deliveryId",
              "objectId",
            ),
        );
      assert.equal(enqueueCalls, 1, testCase.label);
      assert.equal(secondInsertAttempts, 0, testCase.label);
      assert.equal(transactionCalls, 1, testCase.label);
      assert.ok(postEnqueueUnfilteredRead, testCase.label);
      assertStrictObjectIdEquality(
        postEnqueueUnfilteredRead.filter,
        "firmId",
        IDS.firm,
        `${testCase.label} firm`,
      );
      assertStrictStringEquality(
        postEnqueueUnfilteredRead.filter,
        "kind",
        "DIGEST_DELIVERY",
        `${testCase.label} kind`,
      );

      if (testCase.expectedRepaired) {
        assertObjectIdEquals(result.automationJobId, IDS.jobB);
        assertObjectIdEquals(
          deliveryStore.get(IDS.deliveryA).automationJobId,
          IDS.jobB,
        );
        assert.equal(
          automationJobs.get(IDS.jobB).payload.deliveryId,
          IDS.deliveryA,
        );
        const repairWrite = automationJobs.operations.find(
          (operation) =>
            operation.method === "updateOne" &&
            operation.update?.$set?.["payload.deliveryId"] === IDS.deliveryA,
        );
        assert.ok(repairWrite, testCase.label);
        assert.equal(
          repairWrite.options.session.id,
          `post-enqueue-race-${testCase.label}`,
        );
        assertLiteralEquality(
          repairWrite.filter,
          "payload.deliveryId",
          IDS.deliveryB,
          testCase.label,
        );
      } else {
        const stored = deliveryStore.get(IDS.deliveryA);
        assertRecoveryTerminalized(stored);
        assert.equal(stored.jobRecovery.token, null);
        assert.equal(stored.jobRecovery.expiresAt, null);
        assert.equal(
          Object.prototype.hasOwnProperty.call(
            automationJobs.get(IDS.jobB).payload,
            "deliveryId",
          ),
          false,
          testCase.label,
        );
        assert.equal(
          automationJobs.operations.some(
            (operation) =>
              operation.method === "updateOne" &&
              Object.prototype.hasOwnProperty.call(
                operation.update?.$set || {},
                "payload.deliveryId",
              ),
          ),
          false,
          testCase.label,
        );
        const terminalWrite = deliveryStore.operations.find(
          (operation) =>
            operation.method === "updateOne" &&
            operation.options?.session?.id ===
              `post-enqueue-race-${testCase.label}` &&
            operation.update?.$set?.["email.lastError"] ===
              "Digest automation job payload conflicts with another delivery",
        );
        const leaseAcquisition = deliveryStore.operations.find(
          (operation) =>
            operation.method === "findOneAndUpdate" &&
            operation.update?.$set?.["jobRecovery.token"],
        );
        assert.ok(terminalWrite, testCase.label);
        assert.equal(terminalWrite.update.$inc, undefined, testCase.label);
        const recoveryToken = leaseAcquisition.update.$set["jobRecovery.token"];
        assertStrictObjectIdEquality(
          terminalWrite.filter,
          "_id",
          IDS.deliveryA,
          `${testCase.label} id`,
        );
        assertStrictObjectIdEquality(
          terminalWrite.filter,
          "firmId",
          IDS.firm,
          `${testCase.label} firm`,
        );
        assertLiteralEquality(
          terminalWrite.filter,
          "automationJobId",
          null,
          `${testCase.label} authority snapshot`,
        );
        assertLiteralEquality(
          terminalWrite.filter,
          "jobRecovery.token",
          recoveryToken,
          `${testCase.label} recovery token`,
        );
        assertLiteralEquality(
          terminalWrite.filter,
          "jobRecovery.revision",
          1,
          `${testCase.label} recovery revision`,
        );
        assert.equal(
          queryHasDirectCondition(
            terminalWrite.filter,
            "jobRecovery.expiresAt",
            (condition) => condition?.$gt instanceof Date,
          ),
          true,
          testCase.label,
        );
        assertLiteralEquality(
          terminalWrite.filter,
          "email.state",
          "PENDING",
          `${testCase.label} email state`,
        );
        assertLiteralEquality(
          terminalWrite.filter,
          "email.claimToken",
          null,
          `${testCase.label} email claim`,
        );
        assertLiteralEquality(
          terminalWrite.filter,
          "email.claimedAt",
          null,
          `${testCase.label} email claimedAt`,
        );
        const fencedDelivery = makeDelivery({
          automationJobId: null,
          jobRecovery: {
            token: recoveryToken,
            revision: 1,
            expiresAt: new Date("2099-01-01T00:00:00.000Z"),
          },
        });
        assertFilterAccepts(
          terminalWrite.filter,
          fencedDelivery,
          testCase.label,
        );
        assertFilterRejects(
          terminalWrite.filter,
          {
            ...fencedDelivery,
            email: {
              ...fencedDelivery.email,
              claimToken: "replacement-claim",
            },
          },
          `${testCase.label} replacement claim`,
        );
      }
    }
  },
);

await check(
  "disabled rollover recovery creates and links work for an old PENDING delivery",
  async () => {
    const rolloverNow = new Date("2026-03-21T00:01:00.000Z");
    const delivery = makeDelivery({
      periodKey: "2026-03-20",
      automationJobId: null,
      email: { state: "PENDING", claimToken: null, claimedAt: null },
    });
    const deliveryStore = createInMemoryDigestDelivery([delivery]);
    const automationJobs = createInMemoryAutomationJob();
    const recoveryCursor = createInMemoryDigestRecoveryCursor();
    const reportedErrors = [];
    let recoveryCalls = 0;
    let enqueueCalls = 0;

    await runDisabledDigestRecovery({
      now: rolloverNow,
      deliveryModel: deliveryStore.model,
      cursorModel: recoveryCursor.model,
      reportRecoveryError: async (entry) => {
        reportedErrors.push(clone(entry));
      },
      recover: async (input) => {
        recoveryCalls += 1;
        return enqueueRecipientDigest(input, {
          AutomationJob: automationJobs.model,
          DigestDelivery: deliveryStore.model,
          recoveryClock: () => new Date(rolloverNow),
          enqueueJob: async (jobInput) => {
            enqueueCalls += 1;
            const job = makeAutomationJob({
              _id: IDS.jobB,
              idempotencyKey: jobInput.idempotencyKey,
              status: "PENDING",
            });
            automationJobs.insert(job);
            return clone(job);
          },
        });
      },
    });

    assert.deepEqual(reportedErrors, []);
    assert.equal(recoveryCalls, 1);
    assert.equal(enqueueCalls, 1);
    assertObjectIdEquals(
      deliveryStore.get(IDS.deliveryA).automationJobId,
      IDS.jobB,
    );
    assert.equal(deliveryStore.get(IDS.deliveryA).email.state, "PENDING");
    assert.equal(automationJobs.get(IDS.jobB).status, "PENDING");
  },
);

await check(
  "disabled rollover recovery terminalizes old PENDING delivery with FAILED authority",
  async () => {
    const rolloverNow = new Date("2026-03-21T00:01:00.000Z");
    const delivery = makeDelivery({
      periodKey: "2026-03-20",
      automationJobId: IDS.jobA,
      email: { state: "PENDING", claimToken: null, claimedAt: null },
    });
    const failedJob = makeAutomationJob({
      idempotencyKey: expectedBusinessKey(delivery),
      status: "FAILED",
      attemptCount: 5,
      maxAttempts: 5,
    });
    const deliveryStore = createInMemoryDigestDelivery([delivery]);
    const automationJobs = createInMemoryAutomationJob([failedJob]);
    const recoveryCursor = createInMemoryDigestRecoveryCursor();
    const reportedErrors = [];
    let recoveryCalls = 0;
    let enqueueCalls = 0;
    let transactionCalls = 0;

    await runDisabledDigestRecovery({
      now: rolloverNow,
      deliveryModel: deliveryStore.model,
      cursorModel: recoveryCursor.model,
      reportRecoveryError: async (entry) => {
        reportedErrors.push(clone(entry));
      },
      recover: async (input) => {
        recoveryCalls += 1;
        return enqueueRecipientDigest(input, {
          AutomationJob: automationJobs.model,
          DigestDelivery: deliveryStore.model,
          recoveryClock: () => new Date(rolloverNow),
          enqueueJob: async () => {
            enqueueCalls += 1;
            throw new Error("linked FAILED job must prevent enqueue");
          },
          runRecoveryTransaction: async (work) => {
            transactionCalls += 1;
            return work({ id: "rollover-pending-failed-transaction" });
          },
        });
      },
    });

    assert.deepEqual(reportedErrors, []);
    assert.equal(recoveryCalls, 1);
    assert.equal(enqueueCalls, 0);
    assert.equal(transactionCalls, 1);
    assertObjectIdEquals(
      deliveryStore.get(IDS.deliveryA).automationJobId,
      IDS.jobA,
    );
    assertRecoveryTerminalized(deliveryStore.get(IDS.deliveryA));
    assert.equal(automationJobs.get(IDS.jobA).status, "FAILED");
    assert.equal(automationJobs.get(IDS.jobA).maxAttempts, 5);
  },
);

await check(
  "freshly leased state overrides the initial stale SENDING snapshot",
  async () => {
    const transitions = [
      {
        label: "fresh SENDING",
        update: {
          "email.state": "SENDING",
          "email.claimToken": "fresh-worker",
          "email.claimedAt": new Date(FIXED_NOW),
        },
        expectedState: "SENDING",
        expectedClaimToken: "fresh-worker",
      },
      {
        label: "PENDING",
        update: {
          "email.state": "PENDING",
          "email.claimToken": null,
          "email.claimedAt": null,
        },
        expectedState: "PENDING",
        expectedClaimToken: null,
      },
      {
        label: "ordinary FAILED",
        update: {
          "email.state": "FAILED",
          "email.claimToken": null,
          "email.claimedAt": null,
        },
        expectedState: "FAILED",
        expectedClaimToken: null,
      },
      {
        label: "SENT",
        update: {
          "email.state": "SENT",
          "email.claimToken": null,
          "email.claimedAt": null,
        },
        expectedState: "SENT",
        expectedClaimToken: null,
      },
    ];

    for (const transition of transitions) {
      const initialDelivery = makeDelivery({
        email: {
          state: "SENDING",
          claimToken: "dead-worker",
          claimedAt: new Date(FIXED_NOW.getTime() - SEND_CLAIM_STALE_MS - 1),
        },
      });
      const failedJob = makeAutomationJob({
        status: "FAILED",
        attemptCount: 5,
        maxAttempts: 5,
      });
      const deliveryStore = createInMemoryDigestDelivery([initialDelivery]);
      const automationJobs = createInMemoryAutomationJob([failedJob]);
      let transitionInjected = false;
      let enqueueCalls = 0;
      let transactionCalls = 0;
      const DigestDelivery = {
        ...deliveryStore.model,
        async findOneAndUpdate(filter, update, options) {
          if (!transitionInjected && update.$set?.["jobRecovery.token"]) {
            transitionInjected = true;
            const changed = await deliveryStore.model.updateOne(
              { _id: IDS.deliveryA, firmId: IDS.firm },
              { $set: transition.update },
            );
            assert.equal(changed.matchedCount, 1, transition.label);
          }
          return deliveryStore.model.findOneAndUpdate(filter, update, options);
        },
      };

      await enqueueRecipientDigest(
        {
          firm: { _id: IDS.firm, timezone: "UTC" },
          recipient: makeUser(),
          kind: DAILY_KIND,
          periodKey: initialDelivery.periodKey,
          noticeCasesEnabled: false,
          now: new Date(FIXED_NOW),
        },
        {
          AutomationJob: automationJobs.model,
          DigestDelivery,
          recoveryClock: () => new Date(FIXED_NOW),
          enqueueJob: async () => {
            enqueueCalls += 1;
            throw new Error(`${transition.label} must not enqueue`);
          },
          runRecoveryTransaction: async (work) => {
            transactionCalls += 1;
            return work({ id: `freshly-leased-${transition.label}` });
          },
        },
      );

      const stored = deliveryStore.get(IDS.deliveryA);
      assert.equal(transitionInjected, true, transition.label);
      assert.equal(
        stored.email.state,
        transition.expectedState,
        transition.label,
      );
      assert.equal(
        stored.email.claimToken,
        transition.expectedClaimToken,
        transition.label,
      );
      assert.equal(stored.jobRecovery.token, null, transition.label);
      assert.equal(enqueueCalls, 0, transition.label);
      assert.equal(transactionCalls, 0, transition.label);
      assert.equal(automationJobs.get(IDS.jobA).status, "FAILED");
      assert.equal(
        automationJobs.operations.some(
          (operation) => operation.method === "findOneAndUpdate",
        ),
        false,
        transition.label,
      );
    }
  },
);

await check(
  "new recovery revision blocks an expired holder after authority CAS",
  async () => {
    const acquisitionNow = new Date(FIXED_NOW);
    const eligibilityNow = new Date(FIXED_NOW.getTime() + 10 * 1000);
    const authorityNow = new Date(FIXED_NOW.getTime() + 20 * 1000);
    const transactionNow = new Date(
      authorityNow.getTime() + DIGEST_JOB_RECOVERY_LEASE_MS + 1,
    );
    const recoveryTimes = [
      acquisitionNow,
      eligibilityNow,
      authorityNow,
      transactionNow,
    ];
    let clockReads = 0;
    const delivery = makeDelivery({
      email: {
        state: "SENDING",
        claimToken: "dead-worker",
        claimedAt: new Date(FIXED_NOW.getTime() - SEND_CLAIM_STALE_MS - 1),
      },
    });
    const failedJob = makeAutomationJob({
      status: "FAILED",
      attemptCount: 5,
      maxAttempts: 5,
    });
    const deliveryStore = createInMemoryDigestDelivery([delivery]);
    const automationJobs = createInMemoryAutomationJob([failedJob]);
    let transactionCalls = 0;

    await enqueueRecipientDigest(
      {
        firm: { _id: IDS.firm, timezone: "UTC" },
        recipient: makeUser(),
        kind: DAILY_KIND,
        periodKey: delivery.periodKey,
        noticeCasesEnabled: false,
        now: new Date(FIXED_NOW),
      },
      {
        AutomationJob: automationJobs.model,
        DigestDelivery: deliveryStore.model,
        recoveryClock: () => {
          assert.ok(clockReads < recoveryTimes.length);
          return new Date(recoveryTimes[clockReads++]);
        },
        enqueueJob: async () => {
          throw new Error("linked FAILED job must prevent enqueue");
        },
        runRecoveryTransaction: async (work) => {
          transactionCalls += 1;
          const locked = deliveryStore.get(IDS.deliveryA);
          assert.ok(transactionNow > locked.jobRecovery.expiresAt);
          const takeover = await deliveryStore.model.updateOne(
            {
              _id: IDS.deliveryA,
              "jobRecovery.token": locked.jobRecovery.token,
              "jobRecovery.revision": locked.jobRecovery.revision,
            },
            {
              $set: {
                "jobRecovery.token": "newer-recovery-holder",
                "jobRecovery.expiresAt": new Date(
                  transactionNow.getTime() + DIGEST_JOB_RECOVERY_LEASE_MS,
                ),
              },
              $inc: { "jobRecovery.revision": 1 },
            },
          );
          assert.equal(takeover.matchedCount, 1);
          return work({ id: "expired-holder-transaction" });
        },
      },
    );

    const stored = deliveryStore.get(IDS.deliveryA);
    assert.equal(clockReads, 4);
    assert.equal(transactionCalls, 1);
    assert.equal(stored.jobRecovery.token, "newer-recovery-holder");
    assert.equal(stored.jobRecovery.revision, 2);
    assert.equal(stored.email.state, "SENDING");
    assert.equal(automationJobs.get(IDS.jobA).status, "FAILED");
    assert.equal(
      automationJobs.operations.some(
        (operation) => operation.method === "findOneAndUpdate",
      ),
      false,
    );
  },
);

await check(
  "expired recovery holder fails closed without a takeover",
  async () => {
    const acquisitionNow = new Date(FIXED_NOW);
    const eligibilityNow = new Date(FIXED_NOW.getTime() + 10 * 1000);
    const authorityNow = new Date(FIXED_NOW.getTime() + 20 * 1000);
    const transactionNow = new Date(
      authorityNow.getTime() + DIGEST_JOB_RECOVERY_LEASE_MS + 1,
    );
    const recoveryTimes = [
      acquisitionNow,
      eligibilityNow,
      authorityNow,
      transactionNow,
    ];
    let clockReads = 0;
    const delivery = makeDelivery({
      email: {
        state: "SENDING",
        claimToken: "dead-worker",
        claimedAt: new Date(FIXED_NOW.getTime() - SEND_CLAIM_STALE_MS - 1),
      },
    });
    const failedJob = makeAutomationJob({
      status: "FAILED",
      attemptCount: 5,
      maxAttempts: 5,
    });
    const deliveryStore = createInMemoryDigestDelivery([delivery]);
    const automationJobs = createInMemoryAutomationJob([failedJob]);
    let transactionCalls = 0;

    await enqueueRecipientDigest(
      {
        firm: { _id: IDS.firm, timezone: "UTC" },
        recipient: makeUser(),
        kind: DAILY_KIND,
        periodKey: delivery.periodKey,
        noticeCasesEnabled: false,
        now: new Date(FIXED_NOW),
      },
      {
        AutomationJob: automationJobs.model,
        DigestDelivery: deliveryStore.model,
        recoveryClock: () => {
          assert.ok(clockReads < recoveryTimes.length);
          return new Date(recoveryTimes[clockReads++]);
        },
        enqueueJob: async () => {
          throw new Error("linked FAILED job must prevent enqueue");
        },
        runRecoveryTransaction: async (work) => {
          transactionCalls += 1;
          return work({ id: "expired-without-takeover-transaction" });
        },
      },
    );

    const stored = deliveryStore.get(IDS.deliveryA);
    assert.equal(clockReads, 4);
    assert.equal(transactionCalls, 1);
    assert.equal(stored.jobRecovery.token, null);
    assert.equal(stored.jobRecovery.expiresAt, null);
    assert.equal(stored.jobRecovery.revision, 1);
    assert.equal(stored.email.state, "SENDING");
    assert.equal(stored.email.claimToken, "dead-worker");
    assert.equal(automationJobs.get(IDS.jobA).status, "FAILED");
    assert.equal(
      automationJobs.operations.some(
        (operation) => operation.method === "findOneAndUpdate",
      ),
      false,
    );
  },
);

await check(
  "transaction failure rolls back delivery fencing and never retries outside it",
  async () => {
    const transactionError = new Error("forced recovery transaction failure");
    const delivery = makeDelivery({
      email: {
        state: "SENDING",
        claimToken: "dead-worker",
        claimedAt: new Date(FIXED_NOW.getTime() - SEND_CLAIM_STALE_MS - 1),
      },
    });
    const failedJob = makeAutomationJob({
      status: "FAILED",
      attemptCount: 5,
      maxAttempts: 6,
      lastError: "original failure",
    });
    const deliveryStore = createInMemoryDigestDelivery([delivery]);
    const automationJobs = createInMemoryAutomationJob([failedJob]);
    let enqueueCalls = 0;
    let reactivationAttempts = 0;
    const AutomationJob = {
      ...automationJobs.model,
      async findOneAndUpdate(filter, update, options) {
        if (options?.session && update.$set?.status === "PENDING") {
          reactivationAttempts += 1;
          throw transactionError;
        }
        return automationJobs.model.findOneAndUpdate(filter, update, options);
      },
    };

    await assert.rejects(
      () =>
        enqueueRecipientDigest(
          {
            firm: { _id: IDS.firm, timezone: "UTC" },
            recipient: makeUser(),
            kind: DAILY_KIND,
            periodKey: delivery.periodKey,
            noticeCasesEnabled: false,
            now: new Date(FIXED_NOW),
          },
          {
            AutomationJob,
            DigestDelivery: deliveryStore.model,
            recoveryClock: () => new Date(FIXED_NOW),
            enqueueJob: async () => {
              enqueueCalls += 1;
              throw new Error("linked FAILED job must prevent enqueue");
            },
            runRecoveryTransaction: async (work) => {
              const deliverySnapshot = deliveryStore.snapshot();
              const jobSnapshot = automationJobs.snapshot();
              try {
                return await work({ id: "rollback-transaction" });
              } catch (error) {
                deliveryStore.restore(deliverySnapshot);
                automationJobs.restore(jobSnapshot);
                throw error;
              }
            },
          },
        ),
      (error) => error === transactionError,
    );

    const storedDelivery = deliveryStore.get(IDS.deliveryA);
    const storedJob = automationJobs.get(IDS.jobA);
    assert.equal(enqueueCalls, 0);
    assert.equal(reactivationAttempts, 1);
    assert.equal(storedDelivery.email.state, "SENDING");
    assert.equal(storedDelivery.email.claimToken, "dead-worker");
    assert.equal(storedDelivery.jobRecovery.token, null);
    assert.equal(storedDelivery.jobRecovery.expiresAt, null);
    assert.equal(storedJob.status, "FAILED");
    assert.equal(storedJob.attemptCount, 5);
    assert.equal(storedJob.maxAttempts, 6);
    assert.equal(storedJob.lastError, "original failure");
    assert.ok(
      deliveryStore.operations.some(
        (operation) =>
          operation.method === "updateOne" &&
          operation.options?.session?.id === "rollback-transaction" &&
          operation.update.$set?.["email.state"] === "PENDING",
      ),
    );
  },
);

await check(
  "SUCCEEDED and CANCELLED jobs stay terminal after delivery eligibility loss",
  async () => {
    for (const terminalStatus of ["SUCCEEDED", "CANCELLED"]) {
      const delivery = makeDelivery({ email: { state: "PENDING" } });
      const terminalJob = makeAutomationJob({
        status: terminalStatus,
        completedAt: new Date(FIXED_NOW.getTime() - 60 * 1000),
      });
      const deliveryStore = createInMemoryDigestDelivery([delivery]);
      const automationJobs = createInMemoryAutomationJob([terminalJob]);
      let transactionCalls = 0;

      await enqueueRecipientDigest(
        {
          firm: { _id: IDS.firm, timezone: "UTC" },
          recipient: makeUser(),
          kind: DAILY_KIND,
          periodKey: delivery.periodKey,
          noticeCasesEnabled: false,
          now: new Date(FIXED_NOW),
        },
        {
          AutomationJob: automationJobs.model,
          DigestDelivery: deliveryStore.model,
          recoveryClock: () => new Date(FIXED_NOW),
          enqueueJob: async () => {
            throw new Error("linked terminal job must prevent enqueue");
          },
          runRecoveryTransaction: async (work) => {
            transactionCalls += 1;
            const lost = await deliveryStore.model.updateOne(
              { _id: IDS.deliveryA, firmId: IDS.firm },
              {
                $set: {
                  "email.state": "SENT",
                  "email.claimToken": null,
                  "email.claimedAt": null,
                },
              },
            );
            assert.equal(lost.matchedCount, 1, terminalStatus);
            return work({ id: `eligibility-loss-${terminalStatus}` });
          },
        },
      );

      const stored = deliveryStore.get(IDS.deliveryA);
      assert.equal(transactionCalls, 1, terminalStatus);
      assert.equal(stored.email.state, "SENT", terminalStatus);
      assert.equal(stored.jobRecovery.token, null, terminalStatus);
      assert.equal(
        automationJobs.get(IDS.jobA).status,
        terminalStatus,
        terminalStatus,
      );
      assert.equal(
        automationJobs.operations.some(
          (operation) => operation.method === "findOneAndUpdate",
        ),
        false,
        terminalStatus,
      );
    }
  },
);

await check(
  "SUCCEEDED and CANCELLED jobs stay terminal after recovery lease loss",
  async () => {
    for (const terminalStatus of ["SUCCEEDED", "CANCELLED"]) {
      const delivery = makeDelivery({ email: { state: "PENDING" } });
      const terminalJob = makeAutomationJob({
        status: terminalStatus,
        completedAt: new Date(FIXED_NOW.getTime() - 60 * 1000),
      });
      const deliveryStore = createInMemoryDigestDelivery([delivery]);
      const automationJobs = createInMemoryAutomationJob([terminalJob]);
      let transactionCalls = 0;

      await enqueueRecipientDigest(
        {
          firm: { _id: IDS.firm, timezone: "UTC" },
          recipient: makeUser(),
          kind: DAILY_KIND,
          periodKey: delivery.periodKey,
          noticeCasesEnabled: false,
          now: new Date(FIXED_NOW),
        },
        {
          AutomationJob: automationJobs.model,
          DigestDelivery: deliveryStore.model,
          recoveryClock: () => new Date(FIXED_NOW),
          enqueueJob: async () => {
            throw new Error("linked terminal job must prevent enqueue");
          },
          runRecoveryTransaction: async (work) => {
            transactionCalls += 1;
            const locked = deliveryStore.get(IDS.deliveryA);
            const lost = await deliveryStore.model.updateOne(
              {
                _id: IDS.deliveryA,
                "jobRecovery.token": locked.jobRecovery.token,
                "jobRecovery.revision": locked.jobRecovery.revision,
              },
              {
                $set: {
                  "jobRecovery.token": `new-holder-${terminalStatus}`,
                  "jobRecovery.expiresAt": new Date(
                    FIXED_NOW.getTime() + 2 * DIGEST_JOB_RECOVERY_LEASE_MS,
                  ),
                },
                $inc: { "jobRecovery.revision": 1 },
              },
            );
            assert.equal(lost.matchedCount, 1, terminalStatus);
            return work({ id: `lease-loss-${terminalStatus}` });
          },
        },
      );

      const stored = deliveryStore.get(IDS.deliveryA);
      assert.equal(transactionCalls, 1, terminalStatus);
      assert.equal(
        stored.jobRecovery.token,
        `new-holder-${terminalStatus}`,
        terminalStatus,
      );
      assert.equal(stored.jobRecovery.revision, 2, terminalStatus);
      assert.equal(
        automationJobs.get(IDS.jobA).status,
        terminalStatus,
        terminalStatus,
      );
      assert.equal(
        automationJobs.operations.some(
          (operation) => operation.method === "findOneAndUpdate",
        ),
        false,
        terminalStatus,
      );
    }
  },
);

await check(
  "recoverable SENDING reactivation preserves headroom and caps maxAttempts",
  async () => {
    const cases = [
      { attemptCount: 5, maxAttempts: 20, expectedMaxAttempts: 20 },
      {
        attemptCount: 99998,
        maxAttempts: 99999,
        expectedMaxAttempts: 100000,
      },
      {
        attemptCount: 99999,
        maxAttempts: 100000,
        expectedMaxAttempts: 100000,
      },
      {
        attemptCount: 99999,
        maxAttempts: 100005,
        expectedMaxAttempts: 100000,
      },
    ];

    for (const testCase of cases) {
      const delivery = makeDelivery({
        email: {
          state: "SENDING",
          claimToken: "dead-worker",
          claimedAt: new Date(FIXED_NOW.getTime() - SEND_CLAIM_STALE_MS - 1),
        },
      });
      const failedJob = makeAutomationJob({
        status: "FAILED",
        attemptCount: testCase.attemptCount,
        maxAttempts: testCase.maxAttempts,
      });
      const deliveryStore = createInMemoryDigestDelivery([delivery]);
      const automationJobs = createInMemoryAutomationJob([failedJob]);

      await enqueueRecipientDigest(
        {
          firm: { _id: IDS.firm, timezone: "UTC" },
          recipient: makeUser(),
          kind: DAILY_KIND,
          periodKey: delivery.periodKey,
          noticeCasesEnabled: false,
          now: new Date(FIXED_NOW),
        },
        {
          AutomationJob: automationJobs.model,
          DigestDelivery: deliveryStore.model,
          recoveryClock: () => new Date(FIXED_NOW),
          enqueueJob: async () => {
            throw new Error("linked FAILED job must prevent enqueue");
          },
        },
      );

      const reactivated = automationJobs.get(IDS.jobA);
      const reactivationOperation = automationJobs.operations.find(
        (operation) => operation.method === "findOneAndUpdate",
      );
      assert.equal(reactivated.status, "PENDING");
      assert.equal(reactivated.attemptCount, testCase.attemptCount);
      assert.equal(reactivated.maxAttempts, testCase.expectedMaxAttempts);
      assertLiteralEquality(
        reactivationOperation.filter,
        "attemptCount",
        testCase.attemptCount,
        `${testCase.attemptCount} attemptCount`,
      );
      assertLiteralEquality(
        reactivationOperation.filter,
        "maxAttempts",
        testCase.maxAttempts,
        `${testCase.maxAttempts} maxAttempts`,
      );
      assert.equal(reactivationOperation.options.session?.id?.length > 0, true);
      assert.equal(deliveryStore.get(IDS.deliveryA).email.state, "PENDING");
    }
  },
);

await check(
  "recoverable SENDING FAILED authority terminalizes invalid retry counters",
  async () => {
    const cases = [
      {
        label: "mismatched max at hard cap",
        attemptCount: 100000,
        maxAttempts: 99999,
      },
      {
        label: "attempts over hard cap",
        attemptCount: 100001,
        maxAttempts: 100002,
      },
      { label: "no retry headroom", attemptCount: 5, maxAttempts: 5 },
      {
        label: "attempt count exceeds max attempts",
        attemptCount: 6,
        maxAttempts: 5,
      },
      {
        label: "numeric-string attempt count",
        attemptCount: "5",
        maxAttempts: 6,
      },
      {
        label: "numeric-string max attempts",
        attemptCount: 5,
        maxAttempts: "6",
      },
      {
        label: "malformed attempt count",
        attemptCount: "not-an-integer",
        maxAttempts: 6,
      },
      {
        label: "malformed max attempts",
        attemptCount: 5,
        maxAttempts: "not-an-integer",
      },
      { label: "negative attempt count", attemptCount: -1, maxAttempts: 6 },
      { label: "fractional max attempts", attemptCount: 5, maxAttempts: 6.5 },
      {
        label: "non-finite attempt count",
        attemptCount: Number.POSITIVE_INFINITY,
        maxAttempts: 6,
      },
      { label: "null max attempts", attemptCount: 5, maxAttempts: null },
      { label: "blank max attempts", attemptCount: 5, maxAttempts: " " },
      {
        label: "missing max attempts",
        attemptCount: 5,
        maxAttempts: undefined,
      },
    ];

    for (const testCase of cases) {
      const claimedAt = new Date(FIXED_NOW.getTime() - SEND_CLAIM_STALE_MS - 1);
      const delivery = makeDelivery({
        email: {
          state: "SENDING",
          claimToken: `counter-${testCase.label}`,
          claimedAt,
        },
        inApp: {
          state: "AVAILABLE",
          availableAt: READ_AVAILABLE_AT,
          readAt: null,
        },
      });
      const failedJob = makeAutomationJob({
        status: "FAILED",
        attemptCount: testCase.attemptCount,
        maxAttempts: testCase.maxAttempts,
        lastError: "original terminal failure",
        completedAt: new Date(FIXED_NOW.getTime() - 60 * 1000),
        lease: { owner: "terminal-worker" },
      });
      const deliveryStore = createInMemoryDigestDelivery([delivery]);
      const automationJobs = createInMemoryAutomationJob([failedJob]);
      let enqueueCalls = 0;
      let transactionCalls = 0;

      await enqueueRecipientDigest(
        {
          firm: { _id: IDS.firm, timezone: "UTC" },
          recipient: makeUser(),
          kind: DAILY_KIND,
          periodKey: delivery.periodKey,
          noticeCasesEnabled: false,
          now: new Date(FIXED_NOW),
        },
        {
          AutomationJob: automationJobs.model,
          DigestDelivery: deliveryStore.model,
          recoveryClock: () => new Date(FIXED_NOW),
          enqueueJob: async () => {
            enqueueCalls += 1;
            throw new Error("linked FAILED authority must prevent enqueue");
          },
          runRecoveryTransaction: async (work) => {
            transactionCalls += 1;
            return work({ id: `invalid-counters-${testCase.label}` });
          },
        },
      );

      const terminalWrite = deliveryStore.operations.find(
        (operation) =>
          operation.method === "updateOne" &&
          operation.options?.session?.id ===
            `invalid-counters-${testCase.label}` &&
          operation.update?.$set?.status === "FAILED",
      );
      const leaseAcquisition = deliveryStore.operations.find(
        (operation) =>
          operation.method === "findOneAndUpdate" &&
          operation.update?.$set?.["jobRecovery.token"],
      );
      const transactionJobRead = automationJobs.operations.find(
        (operation) =>
          operation.method === "findOne" &&
          operation.session?.id === `invalid-counters-${testCase.label}` &&
          queryHasLiteralEquality(operation.filter, "status", "FAILED"),
      );
      assert.equal(enqueueCalls, 0, testCase.label);
      assert.equal(transactionCalls, 1, testCase.label);
      assertRecoveryTerminalized(deliveryStore.get(IDS.deliveryA));
      assert.deepEqual(automationJobs.get(IDS.jobA), failedJob, testCase.label);
      assertFullRecoveryFence(terminalWrite.filter, {
        delivery,
        recoveryToken: leaseAcquisition.update.$set["jobRecovery.token"],
        label: testCase.label,
      });
      assertStrictObjectIdEquality(
        transactionJobRead.filter,
        "_id",
        IDS.jobA,
        `${testCase.label} job read id`,
      );
      assertStrictObjectIdEquality(
        transactionJobRead.filter,
        "firmId",
        IDS.firm,
        `${testCase.label} job read firm`,
      );
      assertStrictStringEquality(
        transactionJobRead.filter,
        "payload.deliveryId",
        IDS.deliveryA,
        `${testCase.label} job read payload`,
      );
      assert.equal(
        automationJobs.operations.some(
          (operation) => operation.method === "findOneAndUpdate",
        ),
        false,
        testCase.label,
      );
    }
  },
);

await check(
  "recovery uses deployed digest-delivery legacy idempotency identity",
  async () => {
    const obsoleteLegacyJob = makeAutomationJob({
      _id: IDS.jobA,
      idempotencyKey: `digest:${IDS.deliveryA}`,
      status: "PENDING",
    });
    const deployedLegacyJob = makeAutomationJob({
      _id: IDS.jobB,
      idempotencyKey: `digest-delivery:${IDS.deliveryA}`,
      status: "RETRY_SCHEDULED",
    });
    const automationJobs = createInMemoryAutomationJob([
      obsoleteLegacyJob,
      deployedLegacyJob,
    ]);
    const delivery = makeDelivery({ automationJobId: null });
    const deliveryStore = createInMemoryDigestDelivery([delivery]);
    let enqueueCalls = 0;

    const result = await enqueueRecipientDigest(
      {
        firm: { _id: IDS.firm, timezone: "UTC" },
        recipient: makeUser(),
        kind: DAILY_KIND,
        periodKey: delivery.periodKey,
        noticeCasesEnabled: false,
        now: new Date(FIXED_NOW),
      },
      {
        AutomationJob: automationJobs.model,
        DigestDelivery: deliveryStore.model,
        enqueueJob: async () => {
          enqueueCalls += 1;
          throw new Error("deployed legacy job must prevent enqueue");
        },
      },
    );

    assert.equal(enqueueCalls, 0);
    assertObjectIdEquals(result.automationJobId, IDS.jobB);
    assertObjectIdEquals(
      deliveryStore.get(IDS.deliveryA).automationJobId,
      IDS.jobB,
    );
    assert.ok(
      automationJobs.operations.some((operation) =>
        queryHasLiteralEquality(
          operation.filter,
          "idempotencyKey",
          `digest-delivery:${IDS.deliveryA}`,
        ),
      ),
    );
    assert.equal(
      automationJobs.operations.some((operation) =>
        queryHasLiteralEquality(
          operation.filter,
          "idempotencyKey",
          `digest:${IDS.deliveryA}`,
        ),
      ),
      false,
    );
  },
);

await check(
  "legacy ObjectId payload is selected by strict BSON candidate filtering",
  async () => {
    const delivery = makeDelivery({ automationJobId: null });
    const legacyJob = makeAutomationJob({
      _id: IDS.jobB,
      idempotencyKey: `digest-delivery:${IDS.deliveryA}`,
      payload: {
        deliveryId: new mongoose.Types.ObjectId(IDS.deliveryA),
      },
      status: "RETRY_SCHEDULED",
    });
    const automationJobs = createInMemoryAutomationJob([legacyJob]);
    const deliveryStore = createInMemoryDigestDelivery([delivery]);
    let enqueueCalls = 0;

    const result = await enqueueRecipientDigest(
      {
        firm: makeFirm(),
        recipient: makeUser(),
        kind: DAILY_KIND,
        periodKey: delivery.periodKey,
        noticeCasesEnabled: false,
        now: new Date(FIXED_NOW),
      },
      {
        AutomationJob: automationJobs.model,
        DigestDelivery: deliveryStore.model,
        enqueueJob: async () => {
          enqueueCalls += 1;
          throw new Error("valid legacy ObjectId payload must prevent enqueue");
        },
      },
    );

    const legacyRead = automationJobs.operations.find(
      (operation) =>
        operation.method === "findOne" &&
        queryHasLiteralEquality(
          operation.filter,
          "idempotencyKey",
          `digest-delivery:${IDS.deliveryA}`,
        ) &&
        queryHasTypeCheck(operation.filter, "payload.deliveryId", "objectId"),
    );
    assert.equal(enqueueCalls, 0);
    assertObjectIdEquals(result.automationJobId, IDS.jobB);
    assertObjectIdEquals(
      deliveryStore.get(IDS.deliveryA).automationJobId,
      IDS.jobB,
    );
    assert.ok(legacyRead);
    assert.equal(
      queryHasTypeCheck(legacyRead.filter, "payload.deliveryId", "string"),
      true,
    );
    assert.equal(
      queryHasTypeCheck(legacyRead.filter, "payload.deliveryId", "objectId"),
      true,
    );
    assertLiteralEquality(
      legacyRead.filter,
      "payload.deliveryId",
      IDS.deliveryA,
      "legacy ObjectId payload",
    );
    assertFilterAccepts(
      legacyRead.filter,
      legacyJob,
      "legacy ObjectId payload",
    );

    const arrayPayloadJob = makeAutomationJob({
      ...legacyJob,
      payload: {
        deliveryId: [new mongoose.Types.ObjectId(IDS.deliveryA)],
      },
    });
    const directPayloadFilter = {
      "payload.deliveryId": new mongoose.Types.ObjectId(IDS.deliveryA),
    };
    assertFilterAccepts(
      directPayloadFilter,
      arrayPayloadJob,
      "Mongo direct scalar equality against array element",
    );
    assertFilterAccepts(
      {
        "payload.deliveryId": {
          $in: [new mongoose.Types.ObjectId(IDS.deliveryA)],
        },
      },
      arrayPayloadJob,
      "Mongo $in equality against array element",
    );
    assertFilterRejects(
      {
        "payload.deliveryId": {
          $ne: new mongoose.Types.ObjectId(IDS.deliveryA),
        },
      },
      arrayPayloadJob,
      "Mongo $ne equality against array element",
    );
    assertFilterRejects(
      {
        "payload.deliveryId": {
          $nin: [new mongoose.Types.ObjectId(IDS.deliveryA)],
        },
      },
      arrayPayloadJob,
      "Mongo $nin equality against array element",
    );
    assertFilterRejects(
      legacyRead.filter,
      arrayPayloadJob,
      "strict BSON payload candidate filter",
    );
  },
);

await check(
  "malformed same-business payloads quarantine without mutation or enqueue",
  async () => {
    const cases = [
      {
        label: "array",
        value: [new mongoose.Types.ObjectId(IDS.deliveryB)],
      },
      { label: "plain object", value: { deliveryId: IDS.deliveryB } },
      { label: "number", value: 7 },
    ];

    for (const testCase of cases) {
      const delivery = makeDelivery({ automationJobId: null });
      const otherDelivery = makeDelivery({
        _id: IDS.deliveryB,
        periodKey: "2026-03-19",
        automationJobId: null,
      });
      const malformedJob = makeAutomationJob({
        _id: IDS.jobC,
        idempotencyKey: expectedBusinessKey(delivery),
        payload: { deliveryId: testCase.value },
        status: "PENDING",
      });
      const deliveryStore = createInMemoryDigestDelivery([
        delivery,
        otherDelivery,
      ]);
      const automationJobs = createInMemoryAutomationJob([malformedJob]);
      const uniqueRows = [clone(malformedJob)];
      let enqueueCallbackCalls = 0;

      await enqueueRecipientDigest(
        {
          firm: makeFirm(),
          recipient: makeUser(),
          kind: DAILY_KIND,
          periodKey: delivery.periodKey,
          noticeCasesEnabled: false,
          now: new Date(FIXED_NOW),
        },
        {
          AutomationJob: automationJobs.model,
          DigestDelivery: deliveryStore.model,
          recoveryClock: () => new Date(FIXED_NOW),
          runRecoveryTransaction: async (work) =>
            work({ id: `malformed-payload-${testCase.label}` }),
          enqueueJob: async (input) => {
            enqueueCallbackCalls += 1;
            const duplicate = uniqueRows.some(
              (row) =>
                scalarEquals(row.firmId, input.firmId) &&
                row.kind === input.kind &&
                row.idempotencyKey === input.idempotencyKey,
            );
            if (duplicate) {
              const error = new Error("duplicate digest business key");
              error.code = 11000;
              throw error;
            }
            const inserted = makeAutomationJob(input);
            uniqueRows.push(inserted);
            return clone(inserted);
          },
        },
      );

      const stored = deliveryStore.get(IDS.deliveryA);
      const leaseAcquisition = deliveryStore.operations.find(
        (operation) =>
          operation.method === "findOneAndUpdate" &&
          operation.update?.$set?.["jobRecovery.token"],
      );
      const terminalWrite = deliveryStore.operations.find(
        (operation) =>
          operation.method === "updateOne" &&
          operation.options?.session?.id ===
            `malformed-payload-${testCase.label}` &&
          operation.update?.$set?.["email.lastError"] ===
            "Digest automation job payload conflicts with another delivery",
      );
      const strictBusinessRead = automationJobs.operations.find(
        (operation) =>
          operation.method === "findOne" &&
          queryHasLiteralEquality(
            operation.filter,
            "idempotencyKey",
            expectedBusinessKey(delivery),
          ) &&
          queryHasTypeCheck(operation.filter, "payload.deliveryId", "objectId"),
      );

      assert.equal(enqueueCallbackCalls, 0, testCase.label);
      assert.equal(uniqueRows.length, 1, testCase.label);
      assertRecoveryTerminalized(stored);
      assert.equal(stored.jobRecovery.token, null, testCase.label);
      assert.equal(stored.jobRecovery.expiresAt, null, testCase.label);
      assert.deepEqual(
        automationJobs.get(IDS.jobC),
        malformedJob,
        testCase.label,
      );
      assert.equal(
        automationJobs.operations.some(
          (operation) => operation.method === "updateOne",
        ),
        false,
        testCase.label,
      );
      assert.ok(strictBusinessRead, testCase.label);
      assert.equal(
        queryHasTypeCheck(
          strictBusinessRead.filter,
          "payload.deliveryId",
          "string",
        ),
        true,
        testCase.label,
      );
      assert.equal(
        queryHasTypeCheck(
          strictBusinessRead.filter,
          "payload.deliveryId",
          "objectId",
        ),
        true,
        testCase.label,
      );
      assertLiteralEquality(
        strictBusinessRead.filter,
        "payload.deliveryId",
        IDS.deliveryA,
        testCase.label,
      );
      assertFilterRejects(
        strictBusinessRead.filter,
        malformedJob,
        `${testCase.label} strict candidate`,
      );
      assert.ok(terminalWrite, testCase.label);
      assert.equal(terminalWrite.update.$inc, undefined, testCase.label);
      assertStrictObjectIdEquality(
        terminalWrite.filter,
        "_id",
        IDS.deliveryA,
        testCase.label,
      );
      assertStrictObjectIdEquality(
        terminalWrite.filter,
        "firmId",
        IDS.firm,
        testCase.label,
      );
      assertLiteralEquality(
        terminalWrite.filter,
        "automationJobId",
        null,
        testCase.label,
      );
      assertLiteralEquality(
        terminalWrite.filter,
        "jobRecovery.token",
        leaseAcquisition.update.$set["jobRecovery.token"],
        testCase.label,
      );
      assertLiteralEquality(
        terminalWrite.filter,
        "jobRecovery.revision",
        1,
        testCase.label,
      );
      assertLiteralEquality(
        terminalWrite.filter,
        "email.state",
        "PENDING",
        testCase.label,
      );
      const fencedSnapshot = makeDelivery({
        automationJobId: null,
        jobRecovery: {
          token: leaseAcquisition.update.$set["jobRecovery.token"],
          revision: 1,
          expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        },
      });
      assertFilterAccepts(
        terminalWrite.filter,
        fencedSnapshot,
        `${testCase.label} quarantine fence`,
      );
      assertFilterRejects(
        terminalWrite.filter,
        {
          ...fencedSnapshot,
          email: {
            ...fencedSnapshot.email,
            claimToken: "replacement-claim",
          },
        },
        `${testCase.label} replacement claim`,
      );

      if (testCase.label === "array") {
        assertFilterAccepts(
          {
            "payload.deliveryId": new mongoose.Types.ObjectId(IDS.deliveryB),
          },
          malformedJob,
          "array direct equality",
        );
      }
    }
  },
);

await check(
  "mixed-case digest payload strings quarantine without mutation or enqueue",
  async () => {
    const deliveryId = "abcdefabcdefabcdefabcdef";
    const cases = [
      {
        label: "same delivery",
        payloadDeliveryId: deliveryId.toUpperCase(),
      },
      {
        label: "wrong delivery without target",
        payloadDeliveryId: "fedcbafedcbafedcbafedcba".toUpperCase(),
      },
    ];

    for (const testCase of cases) {
      const delivery = makeDelivery({
        _id: deliveryId,
        automationJobId: null,
      });
      const mixedCaseJob = makeAutomationJob({
        _id: IDS.jobC,
        idempotencyKey: expectedBusinessKey(delivery),
        payload: { deliveryId: testCase.payloadDeliveryId },
        status: "PENDING",
      });
      const deliveryStore = createInMemoryDigestDelivery([delivery]);
      const automationJobs = createInMemoryAutomationJob([mixedCaseJob]);
      let enqueueCallbackCalls = 0;

      await enqueueRecipientDigest(
        {
          firm: makeFirm(),
          recipient: makeUser(),
          kind: DAILY_KIND,
          periodKey: delivery.periodKey,
          noticeCasesEnabled: false,
          now: new Date(FIXED_NOW),
        },
        {
          AutomationJob: automationJobs.model,
          DigestDelivery: deliveryStore.model,
          recoveryClock: () => new Date(FIXED_NOW),
          runRecoveryTransaction: async (work) =>
            work({ id: `mixed-case-payload-${testCase.label}` }),
          enqueueJob: async () => {
            enqueueCallbackCalls += 1;
            return clone(mixedCaseJob);
          },
        },
      );

      const stored = deliveryStore.get(deliveryId);
      const leaseAcquisition = deliveryStore.operations.find(
        (operation) =>
          operation.method === "findOneAndUpdate" &&
          operation.update?.$set?.["jobRecovery.token"],
      );
      const terminalWrite = deliveryStore.operations.find(
        (operation) =>
          operation.method === "updateOne" &&
          operation.options?.session?.id ===
            `mixed-case-payload-${testCase.label}` &&
          operation.update?.$set?.["email.lastError"] ===
            "Digest automation job payload conflicts with another delivery",
      );
      const payloadWrites = automationJobs.operations.filter(
        (operation) =>
          operation.method === "updateOne" &&
          Object.prototype.hasOwnProperty.call(
            operation.update?.$set || {},
            "payload.deliveryId",
          ),
      );

      assert.equal(enqueueCallbackCalls, 0, testCase.label);
      assertRecoveryTerminalized(stored);
      assert.equal(stored.jobRecovery.token, null, testCase.label);
      assert.equal(stored.jobRecovery.expiresAt, null, testCase.label);
      assert.deepEqual(
        automationJobs.get(IDS.jobC),
        mixedCaseJob,
        testCase.label,
      );
      assert.equal(
        automationJobs.get(IDS.jobC).payload.deliveryId,
        testCase.payloadDeliveryId,
        testCase.label,
      );
      assert.equal(
        automationJobs.get(IDS.jobC).status,
        "PENDING",
        testCase.label,
      );
      assert.equal(payloadWrites.length, 0, testCase.label);
      assert.ok(terminalWrite, testCase.label);
      assertStrictObjectIdEquality(
        terminalWrite.filter,
        "_id",
        deliveryId,
        `${testCase.label} id`,
      );
      assertStrictObjectIdEquality(
        terminalWrite.filter,
        "firmId",
        IDS.firm,
        `${testCase.label} firm`,
      );
      assertLiteralEquality(
        terminalWrite.filter,
        "automationJobId",
        null,
        `${testCase.label} authority snapshot`,
      );
      assertLiteralEquality(
        terminalWrite.filter,
        "jobRecovery.token",
        leaseAcquisition.update.$set["jobRecovery.token"],
        `${testCase.label} recovery token`,
      );
      assertLiteralEquality(
        terminalWrite.filter,
        "jobRecovery.revision",
        1,
        `${testCase.label} recovery revision`,
      );
      assertLiteralEquality(
        terminalWrite.filter,
        "email.state",
        "PENDING",
        `${testCase.label} email state`,
      );
      const fencedSnapshot = makeDelivery({
        _id: deliveryId,
        automationJobId: null,
        jobRecovery: {
          token: leaseAcquisition.update.$set["jobRecovery.token"],
          revision: 1,
          expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        },
      });
      assertFilterAccepts(
        terminalWrite.filter,
        fencedSnapshot,
        `${testCase.label} quarantine fence`,
      );
      assertFilterRejects(
        terminalWrite.filter,
        {
          ...fencedSnapshot,
          email: {
            ...fencedSnapshot.email,
            claimToken: "replacement-claim",
          },
        },
        `${testCase.label} replacement claim`,
      );
    }
  },
);

await check(
  "wrong-payload candidates and enqueue result cannot become authority",
  async () => {
    const wrongPayload = { deliveryId: IDS.deliveryB };
    const linkedWrongJob = makeAutomationJob({
      _id: IDS.jobA,
      idempotencyKey: "digest:wrong-linked",
      payload: wrongPayload,
      status: "PENDING",
    });
    const legacyWrongJob = makeAutomationJob({
      _id: IDS.jobB,
      idempotencyKey: `digest-delivery:${IDS.deliveryA}`,
      payload: wrongPayload,
      status: "RETRY_SCHEDULED",
    });
    const businessWrongJob = makeAutomationJob({
      _id: IDS.jobC,
      idempotencyKey: expectedBusinessKey(),
      payload: wrongPayload,
      status: "PENDING",
    });
    const automationJobs = createInMemoryAutomationJob([
      linkedWrongJob,
      legacyWrongJob,
      businessWrongJob,
    ]);
    const delivery = makeDelivery({ automationJobId: IDS.jobA });
    const deliveryStore = createInMemoryDigestDelivery([delivery]);
    const uniqueRows = [clone(businessWrongJob)];
    let enqueueCalls = 0;

    const result = await enqueueRecipientDigest(
      {
        firm: { _id: IDS.firm, timezone: "UTC" },
        recipient: makeUser(),
        kind: DAILY_KIND,
        periodKey: delivery.periodKey,
        noticeCasesEnabled: false,
        now: new Date(FIXED_NOW),
      },
      {
        AutomationJob: automationJobs.model,
        DigestDelivery: deliveryStore.model,
        recoveryClock: () => new Date(FIXED_NOW),
        runRecoveryTransaction: async (work) =>
          work({ id: "wrong-payload-repair-transaction" }),
        enqueueJob: async (input) => {
          enqueueCalls += 1;
          const duplicate = uniqueRows.some(
            (row) =>
              scalarEquals(row.firmId, input.firmId) &&
              row.kind === input.kind &&
              row.idempotencyKey === input.idempotencyKey,
          );
          if (duplicate) {
            const error = new Error("duplicate digest business key");
            error.code = 11000;
            throw error;
          }
          const inserted = makeAutomationJob(input);
          uniqueRows.push(inserted);
          return clone(inserted);
        },
      },
    );

    assert.deepEqual(businessWrongJob.payload, wrongPayload);
    assert.equal(enqueueCalls, 0);
    assert.equal(uniqueRows.length, 1);
    assert.equal(uniqueRows[0].idempotencyKey, expectedBusinessKey(delivery));
    assertObjectIdEquals(result.automationJobId, IDS.jobC);
    assertObjectIdEquals(
      deliveryStore.get(IDS.deliveryA).automationJobId,
      IDS.jobC,
    );
    assert.equal(
      automationJobs.get(IDS.jobC).payload.deliveryId,
      IDS.deliveryA,
    );
    assert.deepEqual(automationJobs.get(IDS.jobA).payload, wrongPayload);
    assert.deepEqual(automationJobs.get(IDS.jobB).payload, wrongPayload);
    const repairWrite = automationJobs.operations.find(
      (operation) =>
        operation.method === "updateOne" &&
        operation.update?.$set?.["payload.deliveryId"] === IDS.deliveryA,
    );
    assert.ok(repairWrite);
    assert.equal(
      repairWrite.options.session.id,
      "wrong-payload-repair-transaction",
    );
    assertStrictObjectIdEquality(repairWrite.filter, "_id", IDS.jobC);
    assertStrictObjectIdEquality(repairWrite.filter, "firmId", IDS.firm);
    assertStrictStringEquality(
      repairWrite.filter,
      "idempotencyKey",
      expectedBusinessKey(),
    );
    assertLiteralEquality(
      repairWrite.filter,
      "payload.deliveryId",
      IDS.deliveryB,
      "wrong payload snapshot",
    );
    const linkedRead = automationJobs.operations.find(
      (operation) =>
        operation.method === "findOne" &&
        queryHasLiteralEquality(operation.filter, "_id", IDS.jobA) &&
        queryHasLiteralEquality(
          operation.filter,
          "payload.deliveryId",
          IDS.deliveryA,
        ),
    );
    const legacyRead = automationJobs.operations.find(
      (operation) =>
        operation.method === "findOne" &&
        queryHasLiteralEquality(
          operation.filter,
          "idempotencyKey",
          `digest-delivery:${IDS.deliveryA}`,
        ) &&
        queryHasLiteralEquality(
          operation.filter,
          "payload.deliveryId",
          IDS.deliveryA,
        ),
    );
    const businessRead = automationJobs.operations.find(
      (operation) =>
        operation.method === "findOne" &&
        queryHasLiteralEquality(
          operation.filter,
          "idempotencyKey",
          expectedBusinessKey(),
        ) &&
        queryHasLiteralEquality(
          operation.filter,
          "payload.deliveryId",
          IDS.deliveryA,
        ),
    );
    assert.ok(linkedRead);
    assert.ok(legacyRead);
    assert.ok(businessRead);
    for (const [label, operation] of [
      ["linked", linkedRead],
      ["legacy", legacyRead],
      ["business", businessRead],
    ]) {
      assertStrictObjectIdEquality(operation.filter, "firmId", IDS.firm, label);
      assertStrictStringEquality(
        operation.filter,
        "payload.deliveryId",
        IDS.deliveryA,
        `${label} payload`,
      );
    }
  },
);

await check(
  "truthy exact-payload enqueue return is only a persisted lookup hint",
  async () => {
    const delivery = makeDelivery({ automationJobId: null });
    const businessIdentity = expectedBusinessKey(delivery);
    const wrongScopeJob = makeAutomationJob({
      _id: IDS.jobB,
      firmId: IDS.otherFirm,
      idempotencyKey: businessIdentity,
      payload: { deliveryId: IDS.deliveryA },
      status: "PENDING",
    });
    const persistedJob = makeAutomationJob({
      _id: IDS.jobD,
      idempotencyKey: businessIdentity,
      payload: { deliveryId: IDS.deliveryA },
      status: "PENDING",
    });
    const automationJobs = createInMemoryAutomationJob([wrongScopeJob]);
    const deliveryStore = createInMemoryDigestDelivery([delivery]);
    let postEnqueueReadStart = null;

    const result = await enqueueRecipientDigest(
      {
        firm: { _id: IDS.firm, timezone: "UTC" },
        recipient: makeUser(),
        kind: DAILY_KIND,
        periodKey: delivery.periodKey,
        noticeCasesEnabled: false,
        now: new Date(FIXED_NOW),
      },
      {
        AutomationJob: automationJobs.model,
        DigestDelivery: deliveryStore.model,
        recoveryClock: () => new Date(FIXED_NOW),
        enqueueJob: async () => {
          postEnqueueReadStart = automationJobs.operations.length;
          automationJobs.insert(persistedJob);
          return clone(wrongScopeJob);
        },
      },
    );

    const postEnqueueFilters = automationJobs.operations
      .slice(postEnqueueReadStart, postEnqueueReadStart + 2)
      .map((operation) => operation.filter);
    assert.equal(postEnqueueFilters.length, 2);
    assertStrictObjectIdEquality(
      postEnqueueFilters[0],
      "_id",
      IDS.jobB,
      "enqueue hint id",
    );
    for (const [label, filter] of [
      ["enqueue hint", postEnqueueFilters[0]],
      ["persisted business", postEnqueueFilters[1]],
    ]) {
      assertStrictObjectIdEquality(filter, "firmId", IDS.firm, `${label} firm`);
      assertStrictStringEquality(
        filter,
        "kind",
        "DIGEST_DELIVERY",
        `${label} kind`,
      );
      assertStrictStringEquality(
        filter,
        "idempotencyKey",
        businessIdentity,
        `${label} key`,
      );
      assertFilterRejects(filter, wrongScopeJob, `${label} wrong firm`);
    }
    assertStrictStringEquality(
      postEnqueueFilters[0],
      "payload.deliveryId",
      IDS.deliveryA,
      "enqueue hint payload",
    );
    assert.equal(
      queryHasLiteralEquality(
        postEnqueueFilters[1],
        "payload.deliveryId",
        IDS.deliveryA,
      ),
      false,
      "persisted same-business reread must not payload-filter",
    );
    assert.equal(
      queryHasTypeCheck(postEnqueueFilters[1], "payload.deliveryId", "string"),
      false,
    );
    assert.equal(
      queryHasTypeCheck(
        postEnqueueFilters[1],
        "payload.deliveryId",
        "objectId",
      ),
      false,
    );
    assertFilterAccepts(
      postEnqueueFilters[1],
      persistedJob,
      "persisted same-business reread",
    );
    assertObjectIdEquals(result.automationJobId, IDS.jobD);
    assertObjectIdEquals(
      deliveryStore.get(IDS.deliveryA).automationJobId,
      IDS.jobD,
    );
    assert.equal(automationJobs.get(IDS.jobB).firmId, IDS.otherFirm);
    const authorityWrite = deliveryStore.operations.find(
      (operation) => operation.update?.$set?.automationJobId,
    );
    assertObjectIdEquals(authorityWrite.update.$set.automationJobId, IDS.jobD);
  },
);

await check(
  "CAS-loss authority reread rejects a wrong-delivery concurrent pointer",
  async () => {
    const candidateJob = makeAutomationJob({
      _id: IDS.jobA,
      idempotencyKey: expectedBusinessKey(),
      status: "PENDING",
    });
    const wrongWinner = makeAutomationJob({
      _id: IDS.jobB,
      idempotencyKey: "digest:concurrent-wrong-delivery",
      payload: { deliveryId: IDS.deliveryB },
      status: "PENDING",
    });
    const automationJobs = createInMemoryAutomationJob([
      candidateJob,
      wrongWinner,
    ]);
    const delivery = makeDelivery({ automationJobId: null });
    const deliveryStore = createInMemoryDigestDelivery([delivery]);
    let casLost = false;
    const DigestDelivery = {
      ...deliveryStore.model,
      async updateOne(filter, update, options) {
        if (!casLost && scalarEquals(update.$set?.automationJobId, IDS.jobA)) {
          casLost = true;
          const concurrentLink = await deliveryStore.model.updateOne(
            { _id: IDS.deliveryA, firmId: IDS.firm },
            { $set: { automationJobId: objectIdFixture(IDS.jobB) } },
          );
          assert.equal(concurrentLink.matchedCount, 1);
        }
        return deliveryStore.model.updateOne(filter, update, options);
      },
    };

    const result = await enqueueRecipientDigest(
      {
        firm: { _id: IDS.firm, timezone: "UTC" },
        recipient: makeUser(),
        kind: DAILY_KIND,
        periodKey: delivery.periodKey,
        noticeCasesEnabled: false,
        now: new Date(FIXED_NOW),
      },
      {
        AutomationJob: automationJobs.model,
        DigestDelivery,
        enqueueJob: async () => {
          throw new Error("existing business candidate must prevent enqueue");
        },
      },
    );

    const authorityReread = automationJobs.operations.findLast(
      (operation) =>
        operation.method === "findOne" &&
        queryHasLiteralEquality(operation.filter, "_id", IDS.jobB),
    );
    assert.equal(casLost, true);
    assertObjectIdEquals(result.automationJobId, IDS.jobB);
    assert.ok(authorityReread);
    assertStrictObjectIdEquality(authorityReread.filter, "firmId", IDS.firm);
    assertStrictStringEquality(
      authorityReread.filter,
      "kind",
      "DIGEST_DELIVERY",
    );
    assertStrictStringEquality(
      authorityReread.filter,
      "payload.deliveryId",
      IDS.deliveryA,
    );
    assertFilterRejects(
      authorityReread.filter,
      wrongWinner,
      "concurrent wrong-delivery pointer",
    );
    assert.equal(
      automationJobs.operations.some(
        (operation) => operation.method === "findOneAndUpdate",
      ),
      false,
    );
  },
);

await check(
  "PENDING plus FAILED terminalization keeps full recovery and email fences",
  async () => {
    const delivery = makeDelivery({
      inApp: {
        state: "READ",
        availableAt: READ_AVAILABLE_AT,
        readAt: READ_AT,
      },
    });
    const failedJob = makeAutomationJob({
      status: "FAILED",
      attemptCount: 5,
      maxAttempts: 5,
    });
    const deliveryStore = createInMemoryDigestDelivery([delivery]);
    const automationJobs = createInMemoryAutomationJob([failedJob]);
    let transactionCalls = 0;

    await enqueueRecipientDigest(
      {
        firm: { _id: IDS.firm, timezone: "UTC" },
        recipient: makeUser(),
        kind: DAILY_KIND,
        periodKey: delivery.periodKey,
        noticeCasesEnabled: false,
        now: new Date(FIXED_NOW),
      },
      {
        AutomationJob: automationJobs.model,
        DigestDelivery: deliveryStore.model,
        enqueueJob: async () => {
          throw new Error("linked FAILED authority must prevent enqueue");
        },
        runRecoveryTransaction: async (work) => {
          transactionCalls += 1;
          return work({ id: "pending-failed-fence-transaction" });
        },
      },
    );

    const terminalWrite = deliveryStore.operations.find(
      (operation) =>
        operation.method === "updateOne" &&
        operation.options?.session?.id === "pending-failed-fence-transaction" &&
        operation.update?.$set?.status === "FAILED",
    );
    const leaseAcquisition = deliveryStore.operations.find(
      (operation) =>
        operation.method === "findOneAndUpdate" &&
        operation.update?.$set?.["jobRecovery.token"],
    );
    const transactionJobRead = automationJobs.operations.find(
      (operation) =>
        operation.method === "findOne" &&
        operation.session?.id === "pending-failed-fence-transaction" &&
        queryHasLiteralEquality(operation.filter, "status", "FAILED"),
    );
    assert.equal(transactionCalls, 1);
    assertRecoveryTerminalized(deliveryStore.get(IDS.deliveryA));
    assert.equal(automationJobs.get(IDS.jobA).status, "FAILED");
    assert.equal(automationJobs.get(IDS.jobA).attemptCount, 5);
    assert.equal(automationJobs.get(IDS.jobA).maxAttempts, 5);
    assert.ok(terminalWrite);
    assertFullRecoveryFence(terminalWrite.filter, {
      delivery,
      recoveryToken: leaseAcquisition.update.$set["jobRecovery.token"],
      label: "PENDING terminalization",
    });
    assertStrictStringEquality(
      transactionJobRead.filter,
      "payload.deliveryId",
      IDS.deliveryA,
      "PENDING terminalization job payload",
    );
    assert.equal(
      automationJobs.operations.some(
        (operation) => operation.method === "findOneAndUpdate",
      ),
      false,
    );
  },
);

await check(
  "exact 100000 FAILED hard cap terminalizes recoverable SENDING delivery",
  async () => {
    const claimedAt = new Date(FIXED_NOW.getTime() - SEND_CLAIM_STALE_MS - 1);
    const delivery = makeDelivery({
      email: {
        state: "SENDING",
        claimToken: "hard-cap-worker",
        claimedAt,
      },
      inApp: {
        state: "AVAILABLE",
        availableAt: READ_AVAILABLE_AT,
        readAt: null,
      },
    });
    const failedJob = makeAutomationJob({
      status: "FAILED",
      attemptCount: 100000,
      maxAttempts: 100000,
    });
    const deliveryStore = createInMemoryDigestDelivery([delivery]);
    const automationJobs = createInMemoryAutomationJob([failedJob]);
    let transactionCalls = 0;

    await enqueueRecipientDigest(
      {
        firm: { _id: IDS.firm, timezone: "UTC" },
        recipient: makeUser(),
        kind: DAILY_KIND,
        periodKey: delivery.periodKey,
        noticeCasesEnabled: false,
        now: new Date(FIXED_NOW),
      },
      {
        AutomationJob: automationJobs.model,
        DigestDelivery: deliveryStore.model,
        enqueueJob: async () => {
          throw new Error("linked FAILED authority must prevent enqueue");
        },
        runRecoveryTransaction: async (work) => {
          transactionCalls += 1;
          return work({ id: "hard-cap-failed-transaction" });
        },
      },
    );

    const terminalWrite = deliveryStore.operations.find(
      (operation) =>
        operation.options?.session?.id === "hard-cap-failed-transaction" &&
        operation.update?.$set?.status === "FAILED",
    );
    const leaseAcquisition = deliveryStore.operations.find(
      (operation) =>
        operation.method === "findOneAndUpdate" &&
        operation.update?.$set?.["jobRecovery.token"],
    );
    assert.equal(transactionCalls, 1);
    assertRecoveryTerminalized(deliveryStore.get(IDS.deliveryA));
    assert.equal(automationJobs.get(IDS.jobA).status, "FAILED");
    assert.equal(automationJobs.get(IDS.jobA).attemptCount, 100000);
    assert.equal(automationJobs.get(IDS.jobA).maxAttempts, 100000);
    assertFullRecoveryFence(terminalWrite.filter, {
      delivery,
      recoveryToken: leaseAcquisition.update.$set["jobRecovery.token"],
      label: "100000 hard cap",
    });
    assert.equal(
      automationJobs.operations.some(
        (operation) => operation.method === "findOneAndUpdate",
      ),
      false,
    );
  },
);

await check(
  "malformed claimedAt uses non-date recovery predicates and literal snapshots",
  async () => {
    const cases = [
      { label: "string", claimedAt: "not-a-date" },
      { label: "invalid Date", claimedAt: new Date(Number.NaN) },
    ];

    for (const testCase of cases) {
      const claimToken = `malformed-${testCase.label}`;
      const delivery = makeDelivery({
        email: {
          state: "SENDING",
          claimToken,
          claimedAt: testCase.claimedAt,
        },
      });
      const activeJob = makeAutomationJob({ status: "PENDING" });
      const deliveryStore = createInMemoryDigestDelivery([delivery]);
      const automationJobs = createInMemoryAutomationJob([activeJob]);

      await enqueueRecipientDigest(
        {
          firm: { _id: IDS.firm, timezone: "UTC" },
          recipient: makeUser(),
          kind: DAILY_KIND,
          periodKey: delivery.periodKey,
          noticeCasesEnabled: false,
          now: new Date(FIXED_NOW),
        },
        {
          AutomationJob: automationJobs.model,
          DigestDelivery: deliveryStore.model,
          recoveryClock: () => new Date(FIXED_NOW),
          enqueueJob: async () => {
            throw new Error("linked active authority must prevent enqueue");
          },
        },
      );

      const leaseAcquisition = deliveryStore.operations.find(
        (operation) =>
          operation.method === "findOneAndUpdate" &&
          operation.update?.$set?.["jobRecovery.token"],
      );
      const authorityWrite = deliveryStore.operations.find(
        (operation) =>
          operation.method === "updateOne" &&
          scalarEquals(operation.update?.$set?.automationJobId, IDS.jobA),
      );
      const claimReleaseWrite = deliveryStore.operations.find(
        (operation) =>
          operation.method === "updateOne" &&
          operation.update?.$set?.["email.state"] === "PENDING",
      );
      assert.ok(
        leaseAcquisition,
        `${testCase.label} lease acquisition missing`,
      );
      assert.ok(authorityWrite, `${testCase.label} authority CAS missing`);
      assert.ok(claimReleaseWrite, `${testCase.label} claim release missing`);
      assert.notEqual(authorityWrite, claimReleaseWrite, testCase.label);

      const recoveryToken = leaseAcquisition.update.$set["jobRecovery.token"];
      assert.equal(typeof recoveryToken, "string", testCase.label);
      assert.ok(recoveryToken.length > 0, testCase.label);
      const assertFullDeliveryFence = (operation, label) => {
        assertStrictObjectIdEquality(
          operation.filter,
          "_id",
          IDS.deliveryA,
          `${label} id`,
        );
        assertStrictObjectIdEquality(
          operation.filter,
          "firmId",
          IDS.firm,
          `${label} firm`,
        );
        assertLiteralEquality(
          operation.filter,
          "automationJobId",
          IDS.jobA,
          `${label} job snapshot`,
        );
        assertLiteralEquality(
          operation.filter,
          "jobRecovery.token",
          recoveryToken,
          `${label} recovery token`,
        );
        assertLiteralEquality(
          operation.filter,
          "jobRecovery.revision",
          1,
          `${label} recovery revision`,
        );
        assert.equal(
          queryHasDirectCondition(
            operation.filter,
            "jobRecovery.expiresAt",
            (condition) => condition?.$gt instanceof Date,
          ),
          true,
          label,
        );
        assertLiteralEquality(
          operation.filter,
          "email.state",
          "SENDING",
          `${label} state`,
        );
        assertLiteralEquality(
          operation.filter,
          "email.claimToken",
          claimToken,
          `${label} claim token`,
        );
        assert.equal(
          queryHasDirectCondition(
            operation.filter,
            "email.claimedAt",
            (condition) =>
              isDeepStrictEqual(condition, { $not: { $type: "date" } }),
          ),
          true,
          `${label} non-date claimedAt`,
        );
        const matching = makeDelivery({
          automationJobId: IDS.jobA,
          email: {
            state: "SENDING",
            claimToken,
            claimedAt: testCase.claimedAt,
          },
          jobRecovery: {
            token: recoveryToken,
            revision: 1,
            expiresAt: new Date("2099-01-01T00:00:00.000Z"),
          },
        });
        assertFilterAccepts(operation.filter, matching, label);
        assertFilterRejects(
          operation.filter,
          {
            ...matching,
            email: { ...matching.email, claimToken: "replacement-claim" },
          },
          `${label} replacement claim`,
        );
        assertLiteralEquality(
          operation.filter,
          "email.claimedAt",
          testCase.claimedAt,
          `${label} claimedAt snapshot`,
        );
        assert.equal(
          queryHasDirectCondition(
            operation.filter,
            "email.claimedAt",
            (condition) => scalarEquals(condition, testCase.claimedAt),
          ),
          false,
          `${label} must not put malformed claimedAt directly in an operator`,
        );
      };
      assertFullDeliveryFence(
        authorityWrite,
        `${testCase.label} authority CAS`,
      );
      assertFullDeliveryFence(
        claimReleaseWrite,
        `${testCase.label} claim release`,
      );
      assertObjectIdEquals(
        authorityWrite.update.$set.automationJobId,
        IDS.jobA,
      );
      assert.equal(claimReleaseWrite.update.$set["email.state"], "PENDING");
      assert.equal(
        deliveryStore.get(IDS.deliveryA).email.state,
        "PENDING",
        testCase.label,
      );
    }
  },
);

await check(
  "PERSONAL daily missing active User hides existing in-app payload under full claim CAS",
  async () => {
    const cases = [
      {
        label: "AVAILABLE",
        inApp: {
          state: "AVAILABLE",
          availableAt: READ_AVAILABLE_AT,
          readAt: null,
        },
      },
      {
        label: "READ",
        inApp: {
          state: "READ",
          availableAt: READ_AVAILABLE_AT,
          readAt: READ_AT,
        },
      },
    ];

    for (const testCase of cases) {
      const delivery = makeDelivery({
        recipientUserId: IDS.owner,
        status: "PENDING",
        email: {
          state: "PENDING",
          attempts: 1,
          lastError: "",
        },
        inApp: testCase.inApp,
      });
      const harness = createProcessHarness({
        delivery,
        firm: {
          _id: IDS.firm,
          isActive: true,
          kind: "PERSONAL",
          ownerUserId: IDS.owner,
        },
        recipient: null,
        membership: makeMembership({
          userId: IDS.owner,
          status: "ACTIVE",
          role: "OWNER",
        }),
      });

      const result = await harness.run();
      const stored = harness.store.get(IDS.deliveryA);

      assert.deepEqual(
        result,
        {
          outcome: "DIGEST_RECIPIENT_UNAVAILABLE",
          deliveryId: IDS.deliveryA,
        },
        testCase.label,
      );
      assert.equal(stored.status, "FAILED", testCase.label);
      assert.equal(stored.email.state, "FAILED", testCase.label);
      assert.equal(
        stored.email.lastError,
        "Recipient is inactive or unavailable",
        testCase.label,
      );
      assert.equal(stored.email.claimToken, null, testCase.label);
      assert.equal(stored.email.claimedAt, null, testCase.label);
      assert.equal(stored.inApp.state, "HIDDEN", testCase.label);
      assert.equal(stored.inApp.availableAt, null, testCase.label);
      assert.equal(stored.inApp.readAt, null, testCase.label);
      assert.equal(harness.providerCalls.length, 0, testCase.label);
      assert.equal(harness.activityCalls.length, 0, testCase.label);
      assertStrictObjectIdEquality(
        harness.userLookups[0].filter,
        "_id",
        IDS.owner,
      );
      assert.equal(
        queryHasDirectCondition(
          harness.userLookups[0].filter,
          "isActive",
          (value) => value === true,
        ),
        true,
        testCase.label,
      );
      assertStrictObjectIdEquality(
        harness.membershipLookups[0].filter,
        "firmId",
        IDS.firm,
      );
      assertStrictObjectIdEquality(
        harness.membershipLookups[0].filter,
        "userId",
        IDS.owner,
      );
      assert.equal(
        queryHasDirectCondition(
          harness.membershipLookups[0].filter,
          "status",
          (value) => value === "ACTIVE",
        ),
        true,
        testCase.label,
      );

      const claimOperation = harness.store.operations.find(
        (operation) =>
          operation.method === "findOneAndUpdate" &&
          operation.update?.$set?.["email.state"] === "SENDING",
      );
      const terminalWrite = harness.store.operations.find(
        (operation) =>
          operation.method === "updateOne" &&
          operation.update?.$set?.["email.lastError"] ===
            "Recipient is inactive or unavailable",
      );
      const claimToken = claimOperation?.update?.$set?.["email.claimToken"];
      assert.equal(typeof claimToken, "string", testCase.label);
      assertFullClaimFence(terminalWrite?.filter, {
        claimToken,
        attempts: 1,
        label: testCase.label,
      });
      assert.deepEqual(
        terminalWrite?.update,
        {
          $set: {
            status: "FAILED",
            "email.state": "FAILED",
            "email.lastError": "Recipient is inactive or unavailable",
            "email.claimToken": null,
            "email.claimedAt": null,
            "inApp.state": "HIDDEN",
            "inApp.availableAt": null,
            "inApp.readAt": null,
          },
        },
        testCase.label,
      );
    }
  },
);

await check(
  "SHARED and legacy daily missing active User preserve existing in-app payload",
  async () => {
    const cases = [
      {
        label: "SHARED AVAILABLE",
        firm: { _id: IDS.firm, isActive: true, kind: "SHARED" },
        inApp: {
          state: "AVAILABLE",
          availableAt: READ_AVAILABLE_AT,
          readAt: null,
        },
      },
      {
        label: "legacy READ",
        firm: { _id: IDS.firm, isActive: true },
        inApp: {
          state: "READ",
          availableAt: READ_AVAILABLE_AT,
          readAt: READ_AT,
        },
      },
    ];

    for (const testCase of cases) {
      const harness = createProcessHarness({
        delivery: makeDelivery({
          status: "PENDING",
          email: {
            state: "PENDING",
            attempts: 1,
            lastError: "",
          },
          inApp: testCase.inApp,
        }),
        firm: testCase.firm,
        recipient: null,
        membership: makeMembership({ status: "ACTIVE", role: "OWNER" }),
      });

      const result = await harness.run();
      const stored = harness.store.get(IDS.deliveryA);

      assert.deepEqual(
        result,
        {
          outcome: "DIGEST_RECIPIENT_UNAVAILABLE",
          deliveryId: IDS.deliveryA,
        },
        testCase.label,
      );
      assert.equal(stored.status, "FAILED", testCase.label);
      assert.equal(stored.email.state, "FAILED", testCase.label);
      assert.equal(stored.inApp.state, testCase.inApp.state, testCase.label);
      assert.equal(
        stored.inApp.availableAt.toISOString(),
        testCase.inApp.availableAt.toISOString(),
        testCase.label,
      );
      assert.equal(
        stored.inApp.readAt?.toISOString() ?? null,
        testCase.inApp.readAt?.toISOString() ?? null,
        testCase.label,
      );
      assert.equal(harness.providerCalls.length, 0, testCase.label);
      assert.equal(harness.activityCalls.length, 0, testCase.label);

      const claimOperation = harness.store.operations.find(
        (operation) =>
          operation.method === "findOneAndUpdate" &&
          operation.update?.$set?.["email.state"] === "SENDING",
      );
      const terminalWrite = harness.store.operations.find(
        (operation) =>
          operation.method === "updateOne" &&
          operation.update?.$set?.["email.lastError"] ===
            "Recipient is inactive or unavailable",
      );
      assertFullClaimFence(terminalWrite?.filter, {
        claimToken: claimOperation.update.$set["email.claimToken"],
        attempts: 1,
        label: testCase.label,
      });
      assert.deepEqual(
        terminalWrite?.update,
        {
          $set: {
            status: "FAILED",
            "email.state": "FAILED",
            "email.lastError": "Recipient is inactive or unavailable",
            "email.claimToken": null,
            "email.claimedAt": null,
          },
        },
        testCase.label,
      );
    }
  },
);

await check(
  "firm digest settings deny inactive User with ACTIVE OWNER before Firm access",
  async () => {
    const inactiveUser = makeUser({ isActive: false });
    const userLookups = [];
    const membershipLookups = [];
    const firmReads = [];
    const firmWrites = [];
    const activityCalls = [];
    const User = {
      findOne(filter) {
        const lookup = { filter: clone(filter), selection: null };
        userLookups.push(lookup);
        const matchedUser = matchesFilter(inactiveUser, filter)
          ? inactiveUser
          : null;
        return makeLeanQuery(matchedUser, (selection) => {
          lookup.selection = selection;
        });
      },
    };
    const Firm = {
      findOne(filter) {
        const operation = { filter: clone(filter), selection: null };
        firmReads.push(operation);
        return makeLeanQuery(null, (selection) => {
          operation.selection = selection;
        });
      },
      findOneAndUpdate(filter, update, options) {
        const operation = {
          filter: clone(filter),
          update: clone(update),
          options: clone(options),
          selection: null,
        };
        firmWrites.push(operation);
        return makeLeanQuery(null, (selection) => {
          operation.selection = selection;
        });
      },
    };

    await assert.rejects(
      () =>
        updateFirmDigestSettings(
          {
            userId: IDS.recipient,
            firmId: IDS.firm,
            input: { dailyHour: 9 },
            requestId: "inactive-user-firm-settings-fixed",
          },
          {
            Firm,
            FirmMembership: createLookupModel(
              makeMembership({ status: "ACTIVE", role: "OWNER" }),
              membershipLookups,
            ),
            User,
            runSettingsTransaction: async (work) =>
              work({ id: "inactive-user-settings-transaction" }),
            safeRecordActivity: async (activity) => {
              activityCalls.push(clone(activity));
            },
          },
        ),
      (error) => {
        assert.equal(error.status, 403);
        assert.equal(error.code, "FIRM_ADMIN_ONLY");
        return true;
      },
    );

    assertStrictObjectIdEquality(userLookups[0].filter, "_id", IDS.recipient);
    assert.equal(
      queryHasDirectCondition(
        userLookups[0].filter,
        "isActive",
        (value) => value === true,
      ),
      true,
    );
    assert.equal(userLookups[0].selection, "_id isActive __v");
    assert.equal(matchesFilter(inactiveUser, userLookups[0].filter), false);
    assertStrictObjectIdEquality(
      membershipLookups[0].filter,
      "firmId",
      IDS.firm,
    );
    assertStrictObjectIdEquality(
      membershipLookups[0].filter,
      "userId",
      IDS.recipient,
    );
    assert.equal(
      queryHasDirectCondition(
        membershipLookups[0].filter,
        "status",
        (value) => value === "ACTIVE",
      ),
      true,
    );
    assert.equal(membershipLookups[0].selection, "role status __v");
    assert.equal(firmReads.length, 1);
    assert.equal(firmWrites.length, 0);
    assert.equal(activityCalls.length, 0);
  },
);

await check(
  "PERSONAL direct, preferences, preview, send-test, and firm settings require exact ACTIVE OWNER",
  async () => {
    const summary = {
      kind: DAILY_KIND,
      periodKey: "2026-03-20",
      counts: {
        open: 1,
        overdue: 0,
        dueSoon: 0,
        waitingDocs: 0,
        case: 0,
        reconciliationReview: 0,
      },
    };
    const cases = [
      {
        label: "exact active owner",
        user: makeUser({ _id: IDS.owner, isActive: true }),
        membership: makeMembership({
          userId: IDS.owner,
          status: "ACTIVE",
          role: "OWNER",
        }),
        allowed: true,
      },
      {
        label: "non-owner with OWNER membership",
        user: makeUser({ _id: IDS.recipient, isActive: true }),
        membership: makeMembership({
          userId: IDS.recipient,
          status: "ACTIVE",
          role: "OWNER",
        }),
        allowed: false,
      },
      {
        label: "non-owner ACTIVE ADMIN",
        user: makeUser({ _id: IDS.admin, isActive: true, role: "MEMBER" }),
        membership: makeMembership({
          userId: IDS.admin,
          status: "ACTIVE",
          role: "ADMIN",
        }),
        allowed: false,
      },
      {
        label: "owner with ADMIN membership",
        user: makeUser({ _id: IDS.owner, isActive: true }),
        membership: makeMembership({
          userId: IDS.owner,
          status: "ACTIVE",
          role: "ADMIN",
        }),
        allowed: false,
      },
      {
        label: "global SUPER_ADMIN on another user's PERSONAL firm",
        user: makeUser({
          _id: IDS.superAdmin,
          isActive: true,
          role: "SUPER_ADMIN",
        }),
        membership: makeMembership({
          userId: IDS.superAdmin,
          status: "ACTIVE",
          role: "ADMIN",
        }),
        allowed: false,
      },
    ];

    for (const testCase of cases) {
      const firm = makeFirm({
        kind: "PERSONAL",
        ownerUserId: IDS.owner,
      });
      let currentUser = clone(testCase.user);
      const preferenceWrites = [];
      const preferenceActivityCalls = [];
      const User = {
        findOne(filter) {
          const matched =
            currentUser && matchesFilter(currentUser, filter)
              ? currentUser
              : null;
          return makeLeanQuery(matched);
        },
        findOneAndUpdate(filter, update, options = {}) {
          const operation = {
            filter: clone(filter),
            update: clone(update),
            options: clone(options),
            selection: null,
          };
          preferenceWrites.push(operation);
          const matched =
            currentUser && matchesFilter(currentUser, filter)
              ? currentUser
              : null;
          if (matched) applyUpdate(currentUser, update);
          return makeLeanQuery(matched, (selection) => {
            operation.selection = selection;
          });
        },
      };
      const models = () => ({
        Firm: createLookupModel(firm, []),
        FirmMembership: createLookupModel(testCase.membership, []),
        User,
      });
      const appConfig = {
        async getFeatureFlags() {
          return {
            dailyDigest: true,
            weeklySummary: true,
            noticeCases: false,
          };
        },
      };
      const accessCall = () =>
        requireActiveDigestAccess(
          { userId: testCase.user._id, firmId: IDS.firm },
          models(),
        );
      const getPreferencesCall = () =>
        getDigestPreferences(
          { userId: testCase.user._id, firmId: IDS.firm },
          { ...models(), AppConfig: appConfig },
        );
      const updatePreferencesCall = () =>
        updateDigestPreferences(
          {
            userId: testCase.user._id,
            firmId: IDS.firm,
            input: { dailyFrequency: "EVERY_3_DAYS" },
            requestId: `personal-preferences-${testCase.label}`,
          },
          {
            ...models(),
            safeRecordActivity: async (activity) => {
              preferenceActivityCalls.push(clone(activity));
            },
          },
        );
      const previewCall = () =>
        previewDigest(
          {
            userId: testCase.user._id,
            firmId: IDS.firm,
            kind: DAILY_KIND,
            dailyEnabled: true,
            weeklyEnabled: true,
            noticeCasesEnabled: false,
            now: new Date(FIXED_NOW),
          },
          {
            ...models(),
            buildDigestSummary: async () => clone(summary),
          },
        );
      let providerCalls = 0;
      const sendTestCall = () =>
        sendTestDigestNow(
          {
            userId: testCase.user._id,
            firmId: IDS.firm,
            role: "SUPER_ADMIN",
            toEmail: testCase.user.email,
            kind: DAILY_KIND,
            now: new Date(FIXED_NOW),
          },
          {
            AppConfig: {
              async getFeatureFlags() {
                return {
                  dailyDigest: true,
                  weeklySummary: true,
                  noticeCases: false,
                };
              },
              async isFeatureEnabled() {
                return true;
              },
            },
            ...models(),
            User: createLookupModel(
              () =>
                currentUser
                  ? { ...clone(currentUser), role: "SUPER_ADMIN" }
                  : null,
              [],
            ),
            previewDigest: (input, dependencies) =>
              previewDigest(input, {
                ...dependencies,
                buildDigestSummary: async () => clone(summary),
              }),
            sendDigestEmail: async () => {
              providerCalls += 1;
              return { data: { id: "personal-test-message" } };
            },
          },
        );
      const settingsHarness = createFirmSettingsHarness({
        firm,
        user: testCase.user,
        membership: testCase.membership,
      });

      if (testCase.allowed) {
        const access = await accessCall();
        assert.equal(access.firm.kind, "PERSONAL", testCase.label);
        assert.equal(access.membership.role, "OWNER", testCase.label);
        const preferences = await getPreferencesCall();
        assert.equal(
          preferences.preferences.dailyFrequency,
          "DAILY",
          testCase.label,
        );
        const updatedPreferences = await updatePreferencesCall();
        assert.equal(
          updatedPreferences.dailyFrequency,
          "EVERY_3_DAYS",
          testCase.label,
        );
        assert.equal(updatedPreferences.dailyEnabled, true, testCase.label);
        assert.equal(preferenceWrites.length, 1, testCase.label);
        assertStrictObjectIdEquality(
          preferenceWrites[0].filter,
          "_id",
          IDS.owner,
          `${testCase.label} preference user`,
        );
        assert.equal(
          queryHasDirectCondition(
            preferenceWrites[0].filter,
            "isActive",
            (value) => value === true,
          ),
          true,
          testCase.label,
        );
        assert.deepEqual(
          preferenceWrites[0].options,
          { new: true, runValidators: true },
          testCase.label,
        );
        assert.equal(
          preferenceWrites[0].selection,
          "digestPreferences",
          testCase.label,
        );
        assert.equal(preferenceActivityCalls.length, 1, testCase.label);
        assert.equal(
          preferenceActivityCalls[0].action,
          "DIGEST_PREFERENCES_UPDATED",
          testCase.label,
        );
        assert.deepEqual(await previewCall(), summary, testCase.label);
        const sent = await sendTestCall();
        assert.equal(
          sent.providerMessageId,
          "personal-test-message",
          testCase.label,
        );
        assert.equal(providerCalls, 1, testCase.label);
        const settings = await settingsHarness.run({ dailyHour: 9 });
        assert.equal(settings.digestSettings.dailyHour, 9, testCase.label);
      } else {
        for (const operation of [
          accessCall,
          getPreferencesCall,
          updatePreferencesCall,
          previewCall,
          sendTestCall,
        ]) {
          await assert.rejects(operation, (error) => {
            assert.equal(error.status, 403, testCase.label);
            assert.equal(error.code, "DIGEST_ACCESS_FORBIDDEN", testCase.label);
            return true;
          });
        }
        await assert.rejects(
          () => settingsHarness.run({ dailyHour: 9 }),
          (error) => {
            assert.equal(error.status, 403, testCase.label);
            assert.equal(error.code, "FIRM_ADMIN_ONLY", testCase.label);
            return true;
          },
        );
        assert.equal(providerCalls, 0, testCase.label);
        assert.equal(preferenceWrites.length, 0, testCase.label);
        assert.equal(preferenceActivityCalls.length, 0, testCase.label);
        assert.equal(settingsHarness.firmWrites.length, 0, testCase.label);
      }
    }
  },
);

await check(
  "BUSINESS and legacy firms preserve active-member digest access",
  async () => {
    const summary = {
      kind: DAILY_KIND,
      periodKey: "2026-03-20",
      counts: {
        open: 1,
        overdue: 0,
        dueSoon: 0,
        waitingDocs: 0,
        case: 0,
        reconciliationReview: 0,
      },
    };
    for (const [label, kind] of [
      ["BUSINESS", "BUSINESS"],
      ["legacy", undefined],
    ]) {
      const firm = makeFirm({ kind });
      const user = makeUser({ isActive: true });
      const membership = makeMembership({ status: "ACTIVE", role: "MEMBER" });
      const models = () => ({
        Firm: createLookupModel(firm, []),
        FirmMembership: createLookupModel(membership, []),
        User: createLookupModel(user, []),
      });
      const access = await requireActiveDigestAccess(
        { userId: IDS.recipient, firmId: IDS.firm },
        models(),
      );
      assert.equal(access.membership.role, "MEMBER", label);
      assert.deepEqual(
        await previewDigest(
          {
            userId: IDS.recipient,
            firmId: IDS.firm,
            kind: DAILY_KIND,
            dailyEnabled: true,
            weeklyEnabled: true,
            noticeCasesEnabled: false,
            now: new Date(FIXED_NOW),
          },
          {
            ...models(),
            buildDigestSummary: async () => clone(summary),
          },
        ),
        summary,
        label,
      );
      let providerCalls = 0;
      await sendTestDigestNow(
        {
          userId: IDS.recipient,
          firmId: IDS.firm,
          role: "SUPER_ADMIN",
          toEmail: user.email,
          kind: DAILY_KIND,
          now: new Date(FIXED_NOW),
        },
        {
          AppConfig: {
            async getFeatureFlags() {
              return {
                dailyDigest: true,
                weeklySummary: true,
                noticeCases: false,
              };
            },
            async isFeatureEnabled() {
              return true;
            },
          },
          ...models(),
          User: createLookupModel({ ...clone(user), role: "SUPER_ADMIN" }, []),
          previewDigest: (input, dependencies) =>
            previewDigest(input, {
              ...dependencies,
              buildDigestSummary: async () => clone(summary),
            }),
          sendDigestEmail: async () => {
            providerCalls += 1;
            return { data: { id: `${label}-test-message` } };
          },
        },
      );
      assert.equal(providerCalls, 1, label);
      const settingsHarness = createFirmSettingsHarness({
        firm,
        user,
        membership: makeMembership({ status: "ACTIVE", role: "ADMIN" }),
      });
      const settings = await settingsHarness.run({ dailyHour: 10 });
      assert.equal(settings.digestSettings.dailyHour, 10, label);
    }
  },
);

await check(
  "process pre-reload hook revocation prevents provider call",
  async () => {
    const cases = [
      {
        label: "firm revoked",
        outcome: "DIGEST_FIRM_UNAVAILABLE",
        mutate: ({ setFirm }) => setFirm(null),
      },
      {
        label: "recipient revoked",
        outcome: "DIGEST_RECIPIENT_UNAVAILABLE",
        mutate: ({ setRecipient }) => setRecipient(null),
      },
      {
        label: "membership revoked",
        outcome: "DIGEST_MEMBERSHIP_UNAVAILABLE",
        mutate: ({ setMembership }) => setMembership(null),
      },
      {
        label: "final email preference revoked",
        outcome: "DIGEST_EMAIL_DISABLED_IN_APP_AVAILABLE",
        mutate: ({ setRecipient }) =>
          setRecipient(
            makeUser({
              isActive: true,
              digestPreferences: { emailEnabled: false },
            }),
          ),
      },
      {
        label: "weekly OWNER downgraded to MEMBER",
        outcome: "DIGEST_WEEKLY_AUTHORITY_REVOKED",
        weekly: true,
        initialMembershipRole: "OWNER",
        mutate: ({ setMembership }) =>
          setMembership(makeMembership({ role: "MEMBER" })),
      },
      {
        label: "weekly ADMIN downgraded to MEMBER",
        outcome: "DIGEST_WEEKLY_AUTHORITY_REVOKED",
        weekly: true,
        initialMembershipRole: "ADMIN",
        mutate: ({ setMembership }) =>
          setMembership(makeMembership({ role: "MEMBER" })),
      },
      {
        label: "weekly preference revoked",
        outcome: "DIGEST_UNSUBSCRIBED_IN_APP_AVAILABLE",
        weekly: true,
        mutate: ({ setRecipient }) =>
          setRecipient(
            makeUser({
              isActive: true,
              digestPreferences: { weeklyEnabled: false },
            }),
          ),
      },
      {
        label: "personal owner changed",
        outcome: "DIGEST_PERSONAL_RECIPIENT_NOT_OWNER",
        personal: true,
        mutate: ({ setFirm }) =>
          setFirm(
            makeFirm({
              kind: "PERSONAL",
              ownerUserId: IDS.otherRecipient,
            }),
          ),
      },
    ];

    for (const testCase of cases) {
      const recipientUserId = testCase.personal ? IDS.owner : IDS.recipient;
      const delivery = makeDelivery({
        recipientUserId,
        ...(testCase.weekly
          ? {
              kind: WEEKLY_KIND,
              periodKey: "2026-03-16",
              subject: "Weekly firm summary · 2026-03-16",
              summary: { kind: WEEKLY_KIND },
            }
          : {}),
      });
      const harness = createProcessHarness({
        delivery,
        firm: testCase.personal
          ? makeFirm({ kind: "PERSONAL", ownerUserId: IDS.owner })
          : makeFirm(),
        recipient: makeUser({ _id: recipientUserId, isActive: true }),
        membership: makeMembership({
          userId: recipientUserId,
          status: "ACTIVE",
          role: testCase.initialMembershipRole || "OWNER",
        }),
        beforeProviderAuthorityReload: testCase.mutate,
      });

      const result = await harness.run();
      assert.equal(result.outcome, testCase.outcome, testCase.label);
      assert.equal(harness.providerCalls.length, 0, testCase.label);
      assert.equal(harness.leaseCalls.length, 1, testCase.label);
      assert.equal(harness.firmLookups.length, 2, testCase.label);
      assert.equal(harness.userLookups.length, 2, testCase.label);
      assert.equal(harness.membershipLookups.length, 2, testCase.label);
    }
  },
);

await check(
  "final authority revocation wins over companion lookup rejections",
  async () => {
    const finalOnlyError =
      (message) =>
      ({ callCount }) =>
        callCount === 2 ? new Error(message) : null;
    const cases = [
      {
        label: "membership revoked",
        outcome: "DIGEST_MEMBERSHIP_UNAVAILABLE",
        lastError: "Recipient no longer has an active firm membership",
        mutate: ({ setMembership }) => setMembership(null),
        errors: {
          firmError: finalOnlyError("final Firm lookup unavailable"),
          userError: finalOnlyError("final User lookup unavailable"),
        },
      },
      {
        label: "recipient revoked",
        outcome: "DIGEST_RECIPIENT_UNAVAILABLE",
        lastError: "Recipient is inactive or unavailable",
        mutate: ({ setRecipient }) => setRecipient(null),
        errors: {
          firmError: finalOnlyError("final Firm lookup unavailable"),
          membershipError: finalOnlyError(
            "final FirmMembership lookup unavailable",
          ),
        },
      },
    ];

    for (const testCase of cases) {
      const harness = createProcessHarness({
        ...testCase.errors,
        beforeProviderAuthorityReload: testCase.mutate,
      });

      const result = await harness.run();
      const stored = harness.store.get(IDS.deliveryA);

      assert.deepEqual(
        result,
        { outcome: testCase.outcome, deliveryId: IDS.deliveryA },
        testCase.label,
      );
      assert.equal(harness.firmLookups.length, 2, testCase.label);
      assert.equal(harness.userLookups.length, 2, testCase.label);
      assert.equal(harness.membershipLookups.length, 2, testCase.label);
      assert.equal(harness.providerCalls.length, 0, testCase.label);
      assert.equal(harness.activityCalls.length, 0, testCase.label);
      assert.equal(stored.status, "FAILED", testCase.label);
      assert.equal(stored.email.state, "FAILED", testCase.label);
      assert.equal(stored.email.lastError, testCase.lastError, testCase.label);
      assert.equal(stored.email.claimToken, null, testCase.label);
      assert.equal(stored.email.claimedAt, null, testCase.label);
      assert.equal(stored.inApp.state, "HIDDEN", testCase.label);
      assert.equal(stored.inApp.availableAt, null, testCase.label);
      assert.equal(stored.inApp.readAt, null, testCase.label);
    }
  },
);

await check(
  "send-test pre-reload hook revocation prevents provider call",
  async () => {
    const summary = {
      kind: DAILY_KIND,
      periodKey: "2026-03-20",
      counts: {
        open: 1,
        overdue: 0,
        dueSoon: 0,
        waitingDocs: 0,
        case: 0,
        reconciliationReview: 0,
      },
    };
    const cases = [
      {
        label: "firm revoked",
        code: "DIGEST_ACCESS_FORBIDDEN",
        mutate: (state) => {
          state.firm = null;
        },
      },
      {
        label: "recipient revoked",
        code: "DIGEST_ACCESS_FORBIDDEN",
        mutate: (state) => {
          state.user = null;
        },
      },
      {
        label: "membership revoked",
        code: "DIGEST_ACCESS_FORBIDDEN",
        mutate: (state) => {
          state.membership = null;
        },
      },
      {
        label: "email disabled",
        code: "DIGEST_EMAIL_DISABLED",
        mutate: (state) => {
          state.user = makeUser({
            isActive: true,
            role: "SUPER_ADMIN",
            digestPreferences: { emailEnabled: false },
          });
        },
      },
      {
        label: "weekly OWNER membership deactivated",
        code: "DIGEST_ACCESS_FORBIDDEN",
        weekly: true,
        initialMembershipRole: "OWNER",
        mutate: (state) => {
          state.membership = makeMembership({
            status: "REMOVED",
            role: "OWNER",
          });
        },
      },
      {
        label: "weekly ADMIN membership deactivated",
        code: "DIGEST_ACCESS_FORBIDDEN",
        weekly: true,
        initialMembershipRole: "ADMIN",
        mutate: (state) => {
          state.membership = makeMembership({
            status: "REMOVED",
            role: "ADMIN",
          });
        },
      },
      {
        label: "weekly preference revoked",
        code: "DIGEST_UNSUBSCRIBED",
        weekly: true,
        mutate: (state) => {
          state.user = makeUser({
            isActive: true,
            role: "SUPER_ADMIN",
            digestPreferences: { weeklyEnabled: false },
          });
        },
      },
      {
        label: "personal owner changed",
        code: "DIGEST_ACCESS_FORBIDDEN",
        personal: true,
        mutate: (state) => {
          state.firm = makeFirm({
            kind: "PERSONAL",
            ownerUserId: IDS.otherRecipient,
          });
        },
      },
    ];

    for (const testCase of cases) {
      const userId = testCase.personal ? IDS.owner : IDS.recipient;
      const caseSummary = testCase.weekly
        ? {
            ...summary,
            kind: WEEKLY_KIND,
            periodKey: "2026-03-16",
          }
        : summary;
      const state = {
        firm: testCase.personal
          ? makeFirm({ kind: "PERSONAL", ownerUserId: IDS.owner })
          : makeFirm(),
        user: makeUser({
          _id: userId,
          isActive: true,
          role: "SUPER_ADMIN",
        }),
        membership: makeMembership({
          userId,
          status: "ACTIVE",
          role: testCase.initialMembershipRole || "OWNER",
        }),
      };
      const firmLookups = [];
      const userLookups = [];
      const membershipLookups = [];
      const Firm = createLookupModel(() => state.firm, firmLookups);
      const User = createLookupModel(() => state.user, userLookups);
      const FirmMembership = createLookupModel(
        () => state.membership,
        membershipLookups,
      );
      let providerCalls = 0;
      let leaseAssertionCalls = 0;
      const leaseAssertion = async () => {
        leaseAssertionCalls += 1;
        testCase.mutate(state);
      };

      await assert.rejects(
        () =>
          sendTestDigestNow(
            {
              userId,
              firmId: IDS.firm,
              role: "SUPER_ADMIN",
              toEmail: "test@example.test",
              kind: testCase.weekly ? WEEKLY_KIND : DAILY_KIND,
              now: new Date(FIXED_NOW),
            },
            {
              AppConfig: {
                async getFeatureFlags() {
                  return {
                    dailyDigest: true,
                    weeklySummary: true,
                    noticeCases: false,
                  };
                },
                async isFeatureEnabled() {
                  return true;
                },
              },
              Firm,
              User,
              FirmMembership,
              previewDigest: (input, dependencies) =>
                previewDigest(input, {
                  ...dependencies,
                  buildDigestSummary: async () => clone(caseSummary),
                }),
              beforeProviderAuthorityReload: leaseAssertion,
              sendDigestEmail: async () => {
                providerCalls += 1;
                return { data: { id: "must-not-send" } };
              },
            },
          ),
        (error) => {
          assert.equal(error.code, testCase.code, testCase.label);
          return true;
        },
      );
      assert.equal(providerCalls, 0, testCase.label);
      assert.equal(leaseAssertionCalls, 1, testCase.label);
      assert.equal(firmLookups.length, 2, testCase.label);
      assert.equal(userLookups.length, 2, testCase.label);
      assert.equal(membershipLookups.length, 2, testCase.label);
    }
  },
);

await check(
  "settings transaction snapshot-fences User, Membership, then Firm CAS",
  async () => {
    const cases = [
      {
        label: "user deactivated",
        expectedWrites: [1, 0, 0],
        mutate: ({ user, setUser }) => setUser({ ...user, isActive: false }),
      },
      {
        label: "user version changed",
        expectedWrites: [1, 0, 0],
        mutate: ({ user, setUser }) => setUser({ ...user, __v: user.__v + 1 }),
      },
      {
        label: "membership revoked between check and write",
        expectedWrites: [1, 1, 0],
        mutate: ({ membership, setMembership }) =>
          setMembership({ ...membership, status: "REMOVED" }),
      },
      {
        label: "membership role downgraded",
        expectedWrites: [1, 1, 0],
        mutate: ({ membership, setMembership }) =>
          setMembership({ ...membership, role: "MEMBER" }),
      },
      {
        label: "membership version changed",
        expectedWrites: [1, 1, 0],
        mutate: ({ membership, setMembership }) =>
          setMembership({ ...membership, __v: membership.__v + 1 }),
      },
      {
        label: "firm deactivated",
        expectedWrites: [1, 1, 1],
        mutate: ({ firm, setFirm }) => setFirm({ ...firm, isActive: false }),
      },
      {
        label: "firm version changed",
        expectedWrites: [1, 1, 1],
        mutate: ({ firm, setFirm }) => setFirm({ ...firm, __v: firm.__v + 1 }),
      },
      {
        label: "PERSONAL owner changed",
        personal: true,
        expectedWrites: [1, 1, 1],
        mutate: ({ firm, setFirm }) =>
          setFirm({ ...firm, ownerUserId: IDS.otherRecipient }),
      },
    ];

    for (const testCase of cases) {
      const userId = testCase.personal ? IDS.owner : IDS.recipient;
      const harness = createFirmSettingsHarness({
        user: makeUser({ _id: userId, isActive: true }),
        membership: makeMembership({
          userId,
          status: "ACTIVE",
          role: "OWNER",
        }),
        firm: makeFirm({
          kind: testCase.personal ? "PERSONAL" : "BUSINESS",
          ownerUserId: userId,
        }),
        beforeSettingsWrite: testCase.mutate,
      });

      await assert.rejects(
        () => harness.run({ dailyHour: 9 }),
        (error) => {
          assert.equal(error.status, 409, testCase.label);
          assert.equal(error.code, "DIGEST_SETTINGS_CONFLICT", testCase.label);
          return true;
        },
      );
      assert.deepEqual(
        [
          harness.userWrites.length,
          harness.membershipWrites.length,
          harness.firmWrites.length,
        ],
        testCase.expectedWrites,
        testCase.label,
      );
      if (harness.userWrites[0]) {
        assertLiteralEquality(
          harness.userWrites[0].filter,
          "__v",
          0,
          `${testCase.label} user version`,
        );
      }
      if (harness.membershipWrites[0]) {
        assertLiteralEquality(
          harness.membershipWrites[0].filter,
          "__v",
          0,
          `${testCase.label} membership version`,
        );
      }
      if (harness.firmWrites[0]) {
        assertLiteralEquality(
          harness.firmWrites[0].filter,
          "__v",
          0,
          `${testCase.label} firm version`,
        );
        assert.deepEqual(
          harness.firmWrites[0].update,
          {
            $set: { "digestSettings.dailyHour": 9 },
            $inc: { __v: 1 },
          },
          testCase.label,
        );
      }
      for (const versionWrite of [
        ...harness.userWrites,
        ...harness.membershipWrites,
      ]) {
        assert.deepEqual(
          versionWrite.update,
          { $inc: { __v: 1 } },
          testCase.label,
        );
        assert.deepEqual(
          versionWrite.options,
          {
            session: { id: "firm-settings-transaction" },
            timestamps: false,
          },
          testCase.label,
        );
      }
      assert.equal(harness.activityCalls.length, 0, testCase.label);
      assert.equal(
        harness.getFirm().digestSettings.dailyHour,
        8,
        testCase.label,
      );
      if (testCase.label === "membership revoked between check and write") {
        assert.equal(harness.getMembership().status, "REMOVED");
        assert.equal(harness.firmWrites.length, 0);
      }
    }
  },
);

await check(
  "manual job retry reopens work while ordinary FAILED delivery stays terminal",
  async () => {
    const originalFindOne = AutomationJob.findOne;
    const originalFindOneAndUpdate = AutomationJob.findOneAndUpdate;
    const now = new Date(FIXED_NOW);
    let storedJob = makeAutomationJob({
      status: "FAILED",
      attemptCount: 5,
      maxAttempts: 5,
      lastError: "provider failed",
      completedAt: new Date(FIXED_NOW.getTime() - 60 * 1000),
    });
    const operations = [];

    AutomationJob.findOne = (filter) => ({
      async lean() {
        operations.push({ method: "findOne", filter: clone(filter) });
        return matchesFilter(storedJob, filter) ? clone(storedJob) : null;
      },
    });
    AutomationJob.findOneAndUpdate = async (filter, update, options) => {
      operations.push({
        method: "findOneAndUpdate",
        filter: clone(filter),
        update: clone(update),
        options: clone(options),
      });
      if (!matchesFilter(storedJob, filter)) return null;
      applyUpdate(storedJob, update);
      return clone(storedJob);
    };

    try {
      const reopened = await retryFailedJob({
        jobId: IDS.jobA,
        firmId: IDS.firm,
        now,
      });
      assert.equal(reopened.status, "PENDING");
      assert.equal(reopened.attemptCount, 5);
      assert.equal(reopened.maxAttempts, 10);
      assert.equal(
        reopened.nextAttemptAt.toISOString(),
        FIXED_NOW.toISOString(),
      );
      assert.equal(reopened.lastError, "");
      assert.equal(reopened.completedAt, null);
      assert.equal(operations.length, 2);

      const delivery = makeDelivery({
        status: "PARTIAL",
        email: {
          state: "FAILED",
          attempts: 1,
          lastError: "provider failed",
        },
        inApp: {
          state: "AVAILABLE",
          availableAt: READ_AVAILABLE_AT,
          readAt: READ_AT,
        },
      });
      const harness = createProcessHarness({ delivery });
      const processResult = await harness.run(reopened);
      assert.deepEqual(processResult, {
        outcome: "DIGEST_EMAIL_NOT_PENDING",
        deliveryId: IDS.deliveryA,
      });
      assert.equal(harness.providerCalls.length, 0);
      assert.equal(harness.store.get(IDS.deliveryA).email.state, "FAILED");
      assert.equal(harness.store.get(IDS.deliveryA).email.attempts, 1);
      assert.equal(harness.store.get(IDS.deliveryA).inApp.state, "AVAILABLE");
    } finally {
      AutomationJob.findOne = originalFindOne;
      AutomationJob.findOneAndUpdate = originalFindOneAndUpdate;
    }
  },
);

await check(
  "provider acceptance followed by SENT persistence error never writes FAILED",
  async () => {
    const persistenceError = new Error("SENT persistence unavailable");
    const harness = createProcessHarness();
    const persistUpdate = harness.store.model.updateOne;
    harness.store.model.updateOne = async (filter, update, options) => {
      if (update?.$set?.["email.state"] === "SENT") {
        throw persistenceError;
      }
      return persistUpdate(filter, update, options);
    };

    await assert.rejects(
      () => harness.run(),
      (error) => error === persistenceError,
    );

    const stored = harness.store.get(IDS.deliveryA);
    assert.equal(harness.providerCalls.length, 1);
    assert.equal(harness.activityCalls.length, 0);
    assert.equal(stored.status, "QUEUED");
    assert.equal(stored.email.state, "SENDING");
    assert.equal(typeof stored.email.claimToken, "string");
    assert.ok(stored.email.claimToken.length > 0);
    assert.equal(stored.email.claimedAt.toISOString(), FIXED_NOW.toISOString());
    assert.equal(stored.email.attempts, 0);
    assert.equal(stored.email.lastError, "");
    assert.equal(
      harness.store.operations.some(
        (operation) => operation.update?.$set?.["email.state"] === "FAILED",
      ),
      false,
    );
  },
);

await check(
  "job lease loss after provider acceptance still persists SENT immediately",
  async () => {
    let harness;
    let operationsAtProvider = -1;
    let leaseValid = true;
    harness = createProcessHarness({
      leaseAssertion: async () => {
        if (!leaseValid) {
          throw new Error("post-provider lease assertion must not run");
        }
      },
      provider: async () => {
        assert.equal(harness.leaseCalls.length, 1);
        operationsAtProvider = harness.store.operations.length;
        leaseValid = false;
        return { data: { id: "single-lease-provider-message" } };
      },
    });

    const result = await harness.run();
    assert.equal(result.outcome, "DIGEST_EMAIL_SENT");
    assert.equal(leaseValid, false);
    assert.equal(harness.leaseCalls.length, 1);
    assert.equal(harness.providerCalls.length, 1);
    const sentWriteIndex = harness.store.operations.findIndex(
      (operation) =>
        operation.method === "updateOne" &&
        operation.update?.$set?.["email.state"] === "SENT",
    );
    assert.ok(sentWriteIndex >= operationsAtProvider);
    assert.equal(harness.store.get(IDS.deliveryA).email.state, "SENT");
    assert.equal(
      harness.store.get(IDS.deliveryA).email.providerMessageId,
      "single-lease-provider-message",
    );

    const replay = await harness.run();
    assert.deepEqual(replay, {
      outcome: "DIGEST_ALREADY_SENT",
      deliveryId: IDS.deliveryA,
    });
    assert.equal(harness.store.get(IDS.deliveryA).email.state, "SENT");
    assert.equal(harness.leaseCalls.length, 1);
    assert.equal(harness.providerCalls.length, 1);
  },
);

await check("digest entry points accept canonical IDs only", async () => {
  const firm = makeFirm();
  const user = makeUser({ isActive: true });
  const membership = makeMembership({ status: "ACTIVE", role: "OWNER" });
  for (const [label, userId, firmId] of [
    ["canonical strings", IDS.recipient, IDS.firm],
    [
      "ObjectIds",
      new mongoose.Types.ObjectId(IDS.recipient),
      new mongoose.Types.ObjectId(IDS.firm),
    ],
  ]) {
    const access = await requireActiveDigestAccess(
      { userId, firmId },
      {
        Firm: createLookupModel(firm, []),
        FirmMembership: createLookupModel(membership, []),
        User: createLookupModel(user, []),
      },
    );
    assert.equal(access.membership.status, "ACTIVE", label);
  }

  const invalidValues = [123, [IDS.recipient], { value: IDS.recipient }];
  const untouchedModel = {
    findOne() {
      throw new Error("model must not run for invalid canonical IDs");
    },
    findOneAndUpdate() {
      throw new Error("model must not run for invalid canonical IDs");
    },
  };
  for (const invalid of invalidValues) {
    const assertCanonicalFailure = async (operation, label) => {
      await assert.rejects(operation, (error) => {
        assert.notEqual(
          error.message,
          "model must not run for invalid canonical IDs",
          label,
        );
        return true;
      });
    };
    await assertCanonicalFailure(
      () =>
        requireActiveDigestAccess(
          { userId: invalid, firmId: IDS.firm },
          {
            Firm: untouchedModel,
            FirmMembership: untouchedModel,
            User: untouchedModel,
          },
        ),
      "direct access userId",
    );
    await assertCanonicalFailure(
      () =>
        previewDigest(
          {
            userId: invalid,
            firmId: IDS.firm,
            kind: DAILY_KIND,
            dailyEnabled: true,
            weeklyEnabled: true,
            noticeCasesEnabled: false,
            now: new Date(FIXED_NOW),
          },
          {
            Firm: untouchedModel,
            FirmMembership: untouchedModel,
            User: untouchedModel,
            buildDigestSummary: async () => {
              throw new Error("summary must not run for invalid IDs");
            },
          },
        ),
      "preview userId",
    );
    let providerCalls = 0;
    await assertCanonicalFailure(
      () =>
        sendTestDigestNow(
          {
            userId: invalid,
            firmId: IDS.firm,
            role: "SUPER_ADMIN",
            toEmail: "test@example.test",
            kind: DAILY_KIND,
            now: new Date(FIXED_NOW),
          },
          {
            AppConfig: {
              async isFeatureEnabled() {
                return true;
              },
            },
            Firm: untouchedModel,
            FirmMembership: untouchedModel,
            User: untouchedModel,
            sendDigestEmail: async () => {
              providerCalls += 1;
            },
          },
        ),
      "send-test userId",
    );
    assert.equal(providerCalls, 0);
    let settingsTransactions = 0;
    await assertCanonicalFailure(
      () =>
        updateFirmDigestSettings(
          {
            userId: IDS.recipient,
            firmId: invalid,
            input: { dailyHour: 9 },
          },
          {
            Firm: untouchedModel,
            FirmMembership: untouchedModel,
            User: untouchedModel,
            runSettingsTransaction: async () => {
              settingsTransactions += 1;
            },
          },
        ),
      "settings firmId",
    );
    assert.equal(settingsTransactions, 0);

    for (const [label, job] of [
      [
        "process deliveryId",
        {
          _id: IDS.jobA,
          firmId: IDS.firm,
          payload: { deliveryId: invalid },
        },
      ],
      [
        "process jobId",
        {
          _id: invalid,
          firmId: IDS.firm,
          payload: { deliveryId: IDS.deliveryA },
        },
      ],
      [
        "process firmId",
        {
          _id: IDS.jobA,
          firmId: invalid,
          payload: { deliveryId: IDS.deliveryA },
        },
      ],
    ]) {
      await assertCanonicalFailure(
        () =>
          processDigestDeliveryJob(job, {
            DigestDelivery: untouchedModel,
            sendDigestEmail: async () => {
              providerCalls += 1;
            },
          }),
        label,
      );
    }
    assert.equal(providerCalls, 0);
    await assertCanonicalFailure(
      () =>
        enqueueRecipientDigest(
          {
            firm: { _id: invalid, timezone: "UTC" },
            recipient: user,
            kind: DAILY_KIND,
            periodKey: "2026-03-20",
            noticeCasesEnabled: false,
            now: new Date(FIXED_NOW),
          },
          { DigestDelivery: untouchedModel },
        ),
      "enqueue firmId",
    );
    await assertCanonicalFailure(
      () =>
        enqueueRecipientDigest(
          {
            firm,
            recipient: { ...user, _id: invalid },
            kind: DAILY_KIND,
            periodKey: "2026-03-20",
            noticeCasesEnabled: false,
            now: new Date(FIXED_NOW),
          },
          { DigestDelivery: untouchedModel },
        ),
      "enqueue recipientUserId",
    );
  }
});

await check(
  "owned and immutable wrong-payload jobs quarantine without mutation",
  async () => {
    const cases = [
      { label: "SUCCEEDED immutable", status: "SUCCEEDED" },
      { label: "CANCELLED immutable", status: "CANCELLED" },
      {
        label: "FAILED immutable for ordinary PENDING delivery",
        status: "FAILED",
      },
      { label: "PROCESSING immutable", status: "PROCESSING" },
      {
        label: "payload points to another delivery",
        status: "PENDING",
        targetExists: true,
      },
      { label: "owned by another delivery", status: "PENDING", owned: true },
    ];
    for (const testCase of cases) {
      const delivery = makeDelivery({ automationJobId: null });
      const wrongJob = makeAutomationJob({
        _id: IDS.jobC,
        idempotencyKey: expectedBusinessKey(delivery),
        payload: { deliveryId: IDS.deliveryB },
        status: testCase.status,
      });
      const rows = [delivery];
      if (testCase.owned || testCase.targetExists) {
        rows.push(
          makeDelivery({
            _id: IDS.deliveryB,
            periodKey: "2026-03-19",
            automationJobId: testCase.owned ? IDS.jobC : null,
          }),
        );
      }
      const deliveryStore = createInMemoryDigestDelivery(rows);
      const automationJobs = createInMemoryAutomationJob([wrongJob]);
      let enqueueCalls = 0;

      await enqueueRecipientDigest(
        {
          firm: makeFirm(),
          recipient: makeUser(),
          kind: DAILY_KIND,
          periodKey: delivery.periodKey,
          noticeCasesEnabled: false,
          now: new Date(FIXED_NOW),
        },
        {
          AutomationJob: automationJobs.model,
          DigestDelivery: deliveryStore.model,
          recoveryClock: () => new Date(FIXED_NOW),
          runRecoveryTransaction: async (work) =>
            work({ id: `wrong-payload-${testCase.label}` }),
          enqueueJob: async () => {
            enqueueCalls += 1;
            throw new Error("conflicting job must prevent enqueue");
          },
        },
      );

      const stored = deliveryStore.get(IDS.deliveryA);
      const terminalWrite = deliveryStore.operations.find(
        (operation) =>
          operation.method === "updateOne" &&
          operation.update?.$set?.["email.lastError"] ===
            "Digest automation job payload conflicts with another delivery",
      );
      const leaseAcquisition = deliveryStore.operations.find(
        (operation) =>
          operation.method === "findOneAndUpdate" &&
          operation.update?.$set?.["jobRecovery.token"],
      );
      assert.equal(enqueueCalls, 0, testCase.label);
      assertRecoveryTerminalized(stored);
      assert.deepEqual(automationJobs.get(IDS.jobC), wrongJob, testCase.label);
      assert.equal(
        automationJobs.operations.some(
          (operation) => operation.method === "updateOne",
        ),
        false,
        testCase.label,
      );
      assert.ok(terminalWrite, testCase.label);
      assertStrictObjectIdEquality(
        terminalWrite.filter,
        "_id",
        IDS.deliveryA,
        `${testCase.label} id`,
      );
      assertStrictObjectIdEquality(
        terminalWrite.filter,
        "firmId",
        IDS.firm,
        `${testCase.label} firm`,
      );
      assertLiteralEquality(
        terminalWrite.filter,
        "automationJobId",
        null,
        `${testCase.label} authority snapshot`,
      );
      assertLiteralEquality(
        terminalWrite.filter,
        "jobRecovery.token",
        leaseAcquisition.update.$set["jobRecovery.token"],
        `${testCase.label} recovery token`,
      );
      assertLiteralEquality(
        terminalWrite.filter,
        "jobRecovery.revision",
        1,
        `${testCase.label} revision`,
      );
      const matching = makeDelivery({
        automationJobId: null,
        jobRecovery: {
          token: leaseAcquisition.update.$set["jobRecovery.token"],
          revision: 1,
          expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        },
      });
      assertFilterAccepts(terminalWrite.filter, matching, testCase.label);
      assertFilterRejects(
        terminalWrite.filter,
        {
          ...matching,
          email: { ...matching.email, claimToken: "replacement-claim" },
        },
        `${testCase.label} replacement claim`,
      );
    }
  },
);

await check(
  "malformed email attempts and recovery revisions quarantine without increment",
  async () => {
    const malformedNumericCases = [
      { label: "null", value: null },
      { label: "negative", value: -1 },
      { label: "fractional", value: 1.5 },
      { label: "maximum safe integer", value: Number.MAX_SAFE_INTEGER },
      { label: "numeric string", value: "1" },
      { label: "array", value: [] },
      { label: "plain object", value: { malformed: true } },
    ];
    for (const testCase of malformedNumericCases) {
      const rawAttempts = testCase.value;
      const label = `attempts ${testCase.label}`;
      const harness = createProcessHarness({
        delivery: makeDelivery({
          email: { state: "PENDING", attempts: rawAttempts },
        }),
      });
      const result = await harness.run();
      const stored = harness.store.get(IDS.deliveryA);
      const claimOperation = harness.store.operations.find(
        (operation) =>
          operation.method === "findOneAndUpdate" &&
          operation.update?.$set?.["email.state"] === "SENDING",
      );
      const terminalWrite = harness.store.operations.find(
        (operation) =>
          operation.method === "updateOne" &&
          operation.update?.$set?.["email.lastError"] ===
            "Digest email attempts is invalid",
      );
      assert.deepEqual(
        result,
        {
          outcome: "DIGEST_DELIVERY_QUARANTINED",
          deliveryId: IDS.deliveryA,
        },
        label,
      );
      assertRecoveryTerminalized(stored);
      assert.deepEqual(stored.email.attempts, rawAttempts, label);
      assert.equal(stored.jobRecovery.token, null, label);
      assert.equal(stored.jobRecovery.expiresAt, null, label);
      assert.equal(harness.providerCalls.length, 0, label);
      assert.equal(terminalWrite.update.$inc, undefined, label);
      assertFullClaimFence(terminalWrite.filter, {
        claimToken: claimOperation.update.$set["email.claimToken"],
        attempts: rawAttempts,
        label,
      });
      assert.equal(
        harness.store.operations.some(
          (operation) =>
            operation.update?.$inc?.["email.attempts"] !== undefined,
        ),
        false,
        label,
      );
    }

    for (const testCase of malformedNumericCases) {
      const rawRevision = testCase.value;
      const label = `revision ${testCase.label}`;
      const delivery = makeDelivery({
        automationJobId: null,
        jobRecovery: { revision: rawRevision },
      });
      const deliveryStore = createInMemoryDigestDelivery([delivery]);
      const automationJobs = createInMemoryAutomationJob();
      let enqueueCalls = 0;
      await enqueueRecipientDigest(
        {
          firm: makeFirm(),
          recipient: makeUser(),
          kind: DAILY_KIND,
          periodKey: delivery.periodKey,
          noticeCasesEnabled: false,
          now: new Date(FIXED_NOW),
        },
        {
          AutomationJob: automationJobs.model,
          DigestDelivery: deliveryStore.model,
          recoveryClock: () => new Date(FIXED_NOW),
          enqueueJob: async () => {
            enqueueCalls += 1;
            throw new Error("invalid revision must not enqueue");
          },
        },
      );
      const stored = deliveryStore.get(IDS.deliveryA);
      const terminalWrite = deliveryStore.operations.find(
        (operation) =>
          operation.method === "updateOne" &&
          operation.update?.$set?.["email.lastError"] ===
            "Digest recovery revision is invalid",
      );
      assert.equal(enqueueCalls, 0, label);
      assertRecoveryTerminalized(stored);
      assert.deepEqual(stored.jobRecovery.revision, rawRevision, label);
      assert.equal(stored.jobRecovery.token, null, label);
      assert.equal(stored.jobRecovery.expiresAt, null, label);
      assert.equal(terminalWrite.update.$inc, undefined, label);
      assertLiteralEquality(
        terminalWrite.filter,
        "jobRecovery.revision",
        rawRevision,
        label,
      );
      assertStrictObjectIdEquality(terminalWrite.filter, "_id", IDS.deliveryA);
      assertStrictObjectIdEquality(terminalWrite.filter, "firmId", IDS.firm);
      assertLiteralEquality(terminalWrite.filter, "email.state", "PENDING");
      assertLiteralEquality(terminalWrite.filter, "email.claimToken", null);
      assertLiteralEquality(terminalWrite.filter, "email.claimedAt", null);
      assertFilterAccepts(terminalWrite.filter, delivery, label);
      assertFilterRejects(
        terminalWrite.filter,
        {
          ...delivery,
          email: { ...delivery.email, claimToken: "replacement-claim" },
        },
        `${label} replacement claim`,
      );
      assertFilterRejects(
        terminalWrite.filter,
        {
          ...delivery,
          jobRecovery: { ...delivery.jobRecovery, revision: 7 },
        },
        `${label} replacement revision`,
      );
      assert.equal(
        deliveryStore.operations.some(
          (operation) =>
            operation.update?.$inc?.["jobRecovery.revision"] !== undefined,
        ),
        false,
        label,
      );
    }
  },
);

await check(
  "send-test reloads revocations after the final selected-feature read",
  async () => {
    const cases = [
      {
        label: "SUPER_ADMIN role revoked",
        kind: DAILY_KIND,
        periodKey: "2026-03-20",
        code: "SUPER_ADMIN_ONLY",
        mutate: (state) => {
          state.user = makeUser({ isActive: true, role: "MEMBER" });
        },
      },
      {
        label: "active membership revoked",
        kind: WEEKLY_KIND,
        periodKey: "2026-03-16",
        code: "DIGEST_ACCESS_FORBIDDEN",
        mutate: (state) => {
          state.membership = null;
        },
      },
      {
        label: "email preference revoked",
        kind: DAILY_KIND,
        periodKey: "2026-03-20",
        code: "DIGEST_EMAIL_DISABLED",
        mutate: (state) => {
          state.user = makeUser({
            isActive: true,
            role: "SUPER_ADMIN",
            digestPreferences: { emailEnabled: false },
          });
        },
      },
      {
        label: "daily preference revoked",
        kind: DAILY_KIND,
        periodKey: "2026-03-20",
        code: "DIGEST_UNSUBSCRIBED",
        mutate: (state) => {
          state.user = makeUser({
            isActive: true,
            role: "SUPER_ADMIN",
            digestPreferences: { dailyFrequency: "OFF" },
          });
        },
      },
      {
        label: "weekly preference revoked",
        kind: WEEKLY_KIND,
        periodKey: "2026-03-16",
        code: "DIGEST_UNSUBSCRIBED",
        mutate: (state) => {
          state.user = makeUser({
            isActive: true,
            role: "SUPER_ADMIN",
            digestPreferences: { weeklyEnabled: false },
          });
        },
      },
    ];

    for (const testCase of cases) {
      const state = {
        firm: makeFirm(),
        user: makeUser({ isActive: true, role: "SUPER_ADMIN" }),
        membership: makeMembership({ status: "ACTIVE", role: "OWNER" }),
      };
      const firmLookups = [];
      const userLookups = [];
      const membershipLookups = [];
      const selectedFlag =
        testCase.kind === DAILY_KIND ? "dailyDigest" : "weeklySummary";
      const featureCalls = [];
      let selectedReads = 0;
      let providerCalls = 0;

      await assert.rejects(
        () =>
          sendTestDigestNow(
            {
              userId: IDS.recipient,
              firmId: IDS.firm,
              role: "SUPER_ADMIN",
              toEmail: "stale@example.test",
              kind: testCase.kind,
              now: new Date(FIXED_NOW),
            },
            {
              AppConfig: {
                async isFeatureEnabled(name, options) {
                  assert.deepEqual(options, { fresh: true }, testCase.label);
                  featureCalls.push(name);
                  if (name === selectedFlag) {
                    selectedReads += 1;
                    if (selectedReads === 2) testCase.mutate(state);
                  }
                  return true;
                },
              },
              Firm: createLookupModel(() => state.firm, firmLookups),
              FirmMembership: createLookupModel(
                () => state.membership,
                membershipLookups,
              ),
              User: createLookupModel(() => state.user, userLookups),
              previewDigest: (input, dependencies) =>
                previewDigest(input, {
                  ...dependencies,
                  buildDigestSummary: async () => ({
                    kind: testCase.kind,
                    periodKey: testCase.periodKey,
                    counts: { open: 1 },
                  }),
                }),
              sendDigestEmail: async () => {
                providerCalls += 1;
                return { data: { id: "must-not-send" } };
              },
            },
          ),
        (error) => {
          assert.equal(error.code, testCase.code, testCase.label);
          return true;
        },
      );

      assert.equal(selectedReads, 2, testCase.label);
      assert.deepEqual(
        featureCalls,
        [
          "dailyDigest",
          "weeklySummary",
          "noticeCases",
          selectedFlag,
          "noticeCases",
        ],
        testCase.label,
      );
      assert.equal(firmLookups.length, 2, testCase.label);
      assert.equal(userLookups.length, 2, testCase.label);
      assert.equal(membershipLookups.length, 2, testCase.label);
      assert.equal(providerCalls, 0, testCase.label);
    }
  },
);

await check(
  "send-test reloads SUPER_ADMIN authority after all final feature reads",
  async () => {
    const summary = {
      kind: DAILY_KIND,
      periodKey: "2026-03-20",
      counts: { open: 1 },
    };
    let currentUser = makeUser({ isActive: true, role: "SUPER_ADMIN" });
    let noticeReads = 0;
    const providerCalls = [];

    await assert.rejects(
      () =>
        sendTestDigestNow(
          {
            userId: IDS.recipient,
            firmId: IDS.firm,
            role: "SUPER_ADMIN",
            toEmail: "stale@example.test",
            kind: DAILY_KIND,
            now: new Date(FIXED_NOW),
          },
          {
            AppConfig: {
              async getFeatureFlags() {
                return {
                  dailyDigest: true,
                  weeklySummary: true,
                  noticeCases: false,
                };
              },
              async isFeatureEnabled(name) {
                if (name === "noticeCases") {
                  noticeReads += 1;
                  if (noticeReads === 2) {
                    currentUser = makeUser({
                      isActive: true,
                      role: "MEMBER",
                    });
                  }
                }
                return true;
              },
            },
            Firm: createLookupModel(makeFirm(), []),
            FirmMembership: createLookupModel(makeMembership(), []),
            User: createLookupModel(() => currentUser, []),
            previewDigest: async () => clone(summary),
            sendDigestEmail: async (input) => {
              providerCalls.push(clone(input));
              return { data: { id: "must-not-send" } };
            },
          },
        ),
      (error) => {
        assert.equal(error.status, 403);
        assert.equal(error.code, "SUPER_ADMIN_ONLY");
        return true;
      },
    );

    assert.equal(noticeReads, 2);
    assert.equal(providerCalls.length, 0);
  },
);

await check(
  "send-test uses fresh normalized user email and rejects invalid or missing reload email",
  async () => {
    const summary = {
      kind: DAILY_KIND,
      periodKey: "2026-03-20",
      counts: { open: 1 },
    };
    const createCase = ({ finalEmail, missing = false }) => {
      let currentUser = makeUser({
        isActive: true,
        role: "SUPER_ADMIN",
        email: "initial@example.test",
      });
      const providerCalls = [];
      const featureCalls = [];
      return {
        providerCalls,
        featureCalls,
        run: () =>
          sendTestDigestNow(
            {
              userId: IDS.recipient,
              firmId: IDS.firm,
              role: "SUPER_ADMIN",
              toEmail: "stale-caller@example.test",
              kind: DAILY_KIND,
              now: new Date(FIXED_NOW),
            },
            {
              AppConfig: {
                async getFeatureFlags() {
                  return {
                    dailyDigest: true,
                    weeklySummary: true,
                    noticeCases: false,
                  };
                },
                async isFeatureEnabled(name, options) {
                  featureCalls.push({ name, options: clone(options) });
                  return true;
                },
              },
              Firm: createLookupModel(makeFirm(), []),
              FirmMembership: createLookupModel(makeMembership(), []),
              User: createLookupModel(() => currentUser, []),
              previewDigest: async () => clone(summary),
              beforeProviderAuthorityReload: async () => {
                const reloaded = makeUser({
                  isActive: true,
                  role: "SUPER_ADMIN",
                  email: finalEmail,
                });
                if (missing) delete reloaded.email;
                currentUser = reloaded;
              },
              sendDigestEmail: async (input) => {
                providerCalls.push(clone(input));
                return { data: { id: "fresh-email-message" } };
              },
            },
          ),
      };
    };

    const fresh = createCase({ finalEmail: "  Fresh.User@Example.TEST  " });
    const result = await fresh.run();
    assert.equal(result.providerMessageId, "fresh-email-message");
    assert.equal(fresh.providerCalls.length, 1);
    assert.equal(fresh.providerCalls[0].toEmail, "fresh.user@example.test");
    assert.notEqual(
      fresh.providerCalls[0].toEmail,
      "stale-caller@example.test",
    );
    assert.deepEqual(fresh.featureCalls, [
      { name: "dailyDigest", options: { fresh: true } },
      { name: "weeklySummary", options: { fresh: true } },
      { name: "noticeCases", options: { fresh: true } },
      { name: "dailyDigest", options: { fresh: true } },
      { name: "noticeCases", options: { fresh: true } },
    ]);

    for (const testCase of [
      { label: "invalid", finalEmail: "not-an-email" },
      { label: "missing", finalEmail: undefined, missing: true },
    ]) {
      const blocked = createCase(testCase);
      await assert.rejects(blocked.run, (error) => {
        assert.equal(error.status, 400, testCase.label);
        assert.equal(error.code, "DIGEST_EMAIL_INVALID", testCase.label);
        return true;
      });
      assert.equal(blocked.providerCalls.length, 0, testCase.label);
      assert.equal(blocked.featureCalls.length, 5, testCase.label);
      assert.deepEqual(
        blocked.featureCalls.map((call) => call.name),
        [
          "dailyDigest",
          "weeklySummary",
          "noticeCases",
          "dailyDigest",
          "noticeCases",
        ],
        testCase.label,
      );
    }
  },
);

await check(
  "new digest upsert explicitly persists zero attempts with nested insert defaults",
  async () => {
    const insertOperations = [];
    const DigestDeliveryModel = {
      findOne() {
        return Promise.resolve(null);
      },
      async findOneAndUpdate(filter, update, options) {
        insertOperations.push({
          filter: clone(filter),
          update: clone(update),
          options: clone(options),
        });
        return {
          _id: IDS.deliveryA,
          ...clone(update.$setOnInsert),
          automationJobId: null,
          email: clone(update.$setOnInsert.email),
          inApp: clone(update.$setOnInsert.inApp),
        };
      },
    };

    const delivery = await enqueueRecipientDigest(
      {
        firm: makeFirm(),
        recipient: makeUser({
          digestPreferences: { emailEnabled: false },
        }),
        kind: DAILY_KIND,
        periodKey: "2026-03-20",
        noticeCasesEnabled: false,
        now: new Date(FIXED_NOW),
      },
      {
        DigestDelivery: DigestDeliveryModel,
        buildDigestSummary: async () => clone(makeDelivery().summary),
        enqueueJob: async () => {
          throw new Error("disabled email insert must not enqueue");
        },
      },
    );

    assert.equal(insertOperations.length, 1);
    assert.deepEqual(insertOperations[0].options, {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    });
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        insertOperations[0].update.$setOnInsert.email,
        "attempts",
      ),
      true,
    );
    assert.equal(insertOperations[0].update.$setOnInsert.email.attempts, 0);
    assert.equal(delivery.email.attempts, 0);
  },
);

await check(
  "BSON-missing email attempts normalize under full claim CAS then persist one",
  async () => {
    const delivery = makeDelivery();
    delete delivery.email.attempts;
    const harness = createProcessHarness({ delivery });

    const result = await harness.run();
    const stored = harness.store.get(IDS.deliveryA);
    const claimOperation = harness.store.operations.find(
      (operation) =>
        operation.method === "findOneAndUpdate" &&
        operation.update?.$set?.["email.state"] === "SENDING",
    );
    const normalization = harness.store.operations.find(
      (operation) =>
        operation.method === "updateOne" &&
        operation.update?.$set?.["email.attempts"] === 0,
    );
    const sentWrite = harness.store.operations.find(
      (operation) =>
        operation.method === "updateOne" &&
        operation.update?.$set?.["email.state"] === "SENT",
    );

    assert.deepEqual(result, {
      outcome: "DIGEST_EMAIL_SENT",
      deliveryId: IDS.deliveryA,
    });
    assert.equal(harness.providerCalls.length, 1);
    assert.equal(stored.email.attempts, 1);
    assert.equal(stored.email.state, "SENT");
    assert.ok(normalization);
    assertStrictObjectIdEquality(normalization.filter, "_id", IDS.deliveryA);
    assertStrictObjectIdEquality(normalization.filter, "firmId", IDS.firm);
    assertStrictObjectIdEquality(
      normalization.filter,
      "automationJobId",
      IDS.jobA,
    );
    assertLiteralEquality(
      normalization.filter,
      "email.claimToken",
      claimOperation.update.$set["email.claimToken"],
    );
    assertLiteralEquality(normalization.filter, "email.state", "SENDING");
    assert.equal(
      queryHasDirectCondition(
        normalization.filter,
        "email.attempts",
        (condition) => condition?.$exists === false,
      ),
      true,
    );
    assert.deepEqual(normalization.update, {
      $set: { "email.attempts": 0 },
    });
    assert.equal(sentWrite.update.$set["email.attempts"], 1);
    assert.equal(sentWrite.update.$inc, undefined);
    assert.equal(
      harness.store.operations.some(
        (operation) => operation.update?.$inc?.["email.attempts"] !== undefined,
      ),
      false,
    );
  },
);

await check(
  "BSON-missing attempts normalization loses safely to a replacement claim",
  async () => {
    const delivery = makeDelivery();
    delete delivery.email.attempts;
    const harness = createProcessHarness({ delivery });
    const persistUpdate = harness.store.model.updateOne;
    let replacementInjected = false;
    let normalizationFilter = null;
    harness.store.model.updateOne = async (filter, update, options) => {
      if (!replacementInjected && update?.$set?.["email.attempts"] === 0) {
        replacementInjected = true;
        normalizationFilter = clone(filter);
        const replaced = await persistUpdate(filter, {
          $set: { "email.claimToken": "replacement-missing-attempts-claim" },
        });
        assert.equal(replaced.matchedCount, 1);
      }
      return persistUpdate(filter, update, options);
    };

    const result = await harness.run();
    const stored = harness.store.get(IDS.deliveryA);

    assert.deepEqual(result, {
      outcome: "DIGEST_CLAIM_LOST",
      deliveryId: IDS.deliveryA,
      defer: true,
      reason: "Digest send claim changed before completion",
      retryAfterMs: 30 * 1000,
    });
    assert.equal(replacementInjected, true);
    assert.equal(harness.providerCalls.length, 0);
    assert.equal(stored.email.state, "SENDING");
    assert.equal(stored.email.claimToken, "replacement-missing-attempts-claim");
    assert.equal(
      Object.prototype.hasOwnProperty.call(stored.email, "attempts"),
      false,
    );
    assert.equal(
      queryHasDirectCondition(
        normalizationFilter,
        "email.attempts",
        (condition) => condition?.$exists === false,
      ),
      true,
    );
    assert.equal(
      harness.store.operations.some(
        (operation) => operation.update?.$inc?.["email.attempts"] !== undefined,
      ),
      false,
    );
  },
);

await check(
  "legacy missing recovery revision acquires as zero and persists revision one",
  async () => {
    const delivery = makeDelivery({ automationJobId: null });
    delete delivery.jobRecovery.revision;
    const deliveryStore = createInMemoryDigestDelivery([delivery]);
    const automationJobs = createInMemoryAutomationJob();
    const enqueueCalls = [];

    await enqueueRecipientDigest(
      {
        firm: makeFirm(),
        recipient: makeUser(),
        kind: DAILY_KIND,
        periodKey: delivery.periodKey,
        noticeCasesEnabled: false,
        now: new Date(FIXED_NOW),
      },
      {
        AutomationJob: automationJobs.model,
        DigestDelivery: deliveryStore.model,
        recoveryClock: () => new Date(FIXED_NOW),
        enqueueJob: async (input) => {
          enqueueCalls.push(clone(input));
          const job = makeAutomationJob({
            _id: IDS.jobA,
            idempotencyKey: input.idempotencyKey,
            payload: input.payload,
          });
          automationJobs.insert(job);
          return clone(job);
        },
      },
    );

    const acquisition = deliveryStore.operations.find(
      (operation) =>
        operation.method === "findOneAndUpdate" &&
        operation.update?.$set?.["jobRecovery.token"] &&
        operation.update?.$set?.["jobRecovery.revision"] === 1,
    );
    const stored = deliveryStore.get(IDS.deliveryA);
    assert.ok(acquisition);
    assert.equal(
      queryHasDirectCondition(
        acquisition.filter,
        "jobRecovery.revision",
        (condition) => condition?.$exists === false,
      ),
      true,
    );
    assert.equal(acquisition.update.$set["jobRecovery.revision"], 1);
    assert.equal(acquisition.update.$inc, undefined);
    assert.equal(enqueueCalls.length, 1);
    assertObjectIdEquals(stored.automationJobId, IDS.jobA);
    assert.equal(stored.email.state, "PENDING");
    assert.equal(stored.jobRecovery.revision, 1);
    assert.equal(stored.jobRecovery.token, null);
    assert.equal(stored.jobRecovery.expiresAt, null);
    assert.equal(
      deliveryStore.operations.some(
        (operation) =>
          operation.update?.$inc?.["jobRecovery.revision"] !== undefined,
      ),
      false,
    );
  },
);

await check(
  "background delivery rechecks rollout and terminalizes before provider",
  async () => {
    const cases = [
      {
        kind: DAILY_KIND,
        periodKey: "2026-03-20",
        subject: "Daily work digest · 2026-03-20",
        flag: "dailyDigest",
      },
      {
        kind: WEEKLY_KIND,
        periodKey: "2026-03-16",
        subject: "Weekly firm summary · 2026-03-16",
        flag: "weeklySummary",
      },
    ];

    for (const testCase of cases) {
      const delivery = makeDelivery({
        kind: testCase.kind,
        periodKey: testCase.periodKey,
        subject: testCase.subject,
        summary: { kind: testCase.kind },
      });
      const harness = createProcessHarness({
        delivery,
        featureEnabled: [true, false],
      });

      const result = await harness.run();
      const stored = harness.store.get(IDS.deliveryA);
      const claimOperation = harness.store.operations.find(
        (operation) =>
          operation.method === "findOneAndUpdate" &&
          operation.update?.$set?.["email.state"] === "SENDING",
      );
      const rolloutWrite = harness.store.operations.find(
        (operation) =>
          operation.method === "updateOne" &&
          operation.update?.$set?.["email.state"] === "ROLLOUT_BLOCKED",
      );

      assert.deepEqual(
        result,
        {
          outcome: "DIGEST_ROLLOUT_BLOCKED",
          deliveryId: IDS.deliveryA,
        },
        testCase.kind,
      );
      assert.deepEqual(
        harness.featureCalls,
        [
          { name: testCase.flag, options: { fresh: true } },
          { name: testCase.flag, options: { fresh: true } },
        ],
        testCase.kind,
      );
      assert.equal(harness.providerCalls.length, 0, testCase.kind);
      assert.equal(stored.status, "PARTIAL", testCase.kind);
      assert.equal(stored.email.state, "ROLLOUT_BLOCKED", testCase.kind);
      assert.equal(
        stored.email.lastError,
        "Feature rollout disabled before email delivery",
        testCase.kind,
      );
      assert.equal(stored.email.claimToken, null, testCase.kind);
      assert.equal(stored.email.claimedAt, null, testCase.kind);
      assert.equal(stored.email.attempts, 0, testCase.kind);
      assert.equal(stored.inApp.state, "AVAILABLE", testCase.kind);
      assert.equal(
        stored.inApp.availableAt.toISOString(),
        FIXED_NOW.toISOString(),
        testCase.kind,
      );
      assert.equal(stored.inApp.readAt, null, testCase.kind);
      assertFullClaimFence(rolloutWrite.filter, {
        claimToken: claimOperation.update.$set["email.claimToken"],
        attempts: 0,
        label: `${testCase.kind} final rollout fence`,
      });
      assert.equal(rolloutWrite.update.$inc, undefined, testCase.kind);
    }
  },
);

await check(
  "rollout terminal CAS cannot overwrite a replacement delivery claim",
  async () => {
    const cases = [
      {
        kind: DAILY_KIND,
        periodKey: "2026-03-20",
        subject: "Daily work digest · 2026-03-20",
        flag: "dailyDigest",
      },
      {
        kind: WEEKLY_KIND,
        periodKey: "2026-03-16",
        subject: "Weekly firm summary · 2026-03-16",
        flag: "weeklySummary",
      },
    ];

    for (const testCase of cases) {
      let harness;
      let replacementWrites = 0;
      const replacementToken = `replacement-${testCase.flag}-claim`;
      const delivery = makeDelivery({
        kind: testCase.kind,
        periodKey: testCase.periodKey,
        subject: testCase.subject,
        summary: { kind: testCase.kind },
      });
      harness = createProcessHarness({
        delivery,
        featureEnabled: async ({ callCount }) => {
          if (callCount === 1) return true;
          const current = harness.store.get(IDS.deliveryA);
          const replaced = await harness.store.model.updateOne(
            {
              _id: current._id,
              firmId: current.firmId,
              automationJobId: current.automationJobId,
              "email.state": "SENDING",
              "email.claimToken": current.email.claimToken,
            },
            { $set: { "email.claimToken": replacementToken } },
          );
          replacementWrites += replaced.matchedCount;
          return false;
        },
      });

      const result = await harness.run();
      const stored = harness.store.get(IDS.deliveryA);
      const claimOperation = harness.store.operations.find(
        (operation) =>
          operation.method === "findOneAndUpdate" &&
          operation.update?.$set?.["email.state"] === "SENDING",
      );
      const rolloutWrite = harness.store.operations.find(
        (operation) =>
          operation.method === "updateOne" &&
          operation.update?.$set?.["email.state"] === "ROLLOUT_BLOCKED",
      );

      assert.deepEqual(
        result,
        {
          outcome: "DIGEST_CLAIM_LOST",
          deliveryId: IDS.deliveryA,
          defer: true,
          reason: "Digest send claim changed before completion",
          retryAfterMs: 30 * 1000,
        },
        testCase.kind,
      );
      assert.equal(replacementWrites, 1, testCase.kind);
      assert.equal(harness.featureCalls.length, 2, testCase.kind);
      assert.ok(
        harness.featureCalls.every(
          (call) => call.name === testCase.flag && call.options?.fresh === true,
        ),
        testCase.kind,
      );
      assert.equal(harness.providerCalls.length, 0, testCase.kind);
      assert.equal(stored.status, "QUEUED", testCase.kind);
      assert.equal(stored.email.state, "SENDING", testCase.kind);
      assert.equal(stored.email.claimToken, replacementToken, testCase.kind);
      assert.equal(stored.email.attempts, 0, testCase.kind);
      assert.equal(stored.inApp.state, "HIDDEN", testCase.kind);
      assertFullClaimFence(rolloutWrite.filter, {
        claimToken: claimOperation.update.$set["email.claimToken"],
        attempts: 0,
        label: `${testCase.kind} replacement rollout fence`,
      });
      assert.equal(rolloutWrite.update.$inc, undefined, testCase.kind);
    }
  },
);

await check(
  "interactive send-test fresh-reads preview flags and closes selected rollout boundary",
  async () => {
    const cases = [
      {
        kind: DAILY_KIND,
        periodKey: "2026-03-20",
        flag: "dailyDigest",
        code: "DAILY_DIGEST_DISABLED",
        message: "Daily digest is unavailable",
        previewFlags: {
          dailyEnabled: true,
          weeklyEnabled: false,
          noticeCasesEnabled: true,
        },
      },
      {
        kind: WEEKLY_KIND,
        periodKey: "2026-03-16",
        flag: "weeklySummary",
        code: "WEEKLY_SUMMARY_DISABLED",
        message: "Weekly summary is unavailable",
        previewFlags: {
          dailyEnabled: false,
          weeklyEnabled: true,
          noticeCasesEnabled: false,
        },
      },
    ];

    for (const testCase of cases) {
      let cachedFlagCalls = 0;
      let selectedFlagReads = 0;
      const actualFlagCalls = [];
      const previewInputs = [];
      const providerCalls = [];
      const boundaryEvents = [];
      await assert.rejects(
        () =>
          sendTestDigestNow(
            {
              userId: IDS.recipient,
              firmId: IDS.firm,
              role: "SUPER_ADMIN",
              toEmail: "stale-caller@example.test",
              kind: testCase.kind,
              now: new Date(FIXED_NOW),
            },
            {
              AppConfig: {
                async getFeatureFlags() {
                  cachedFlagCalls += 1;
                  throw new Error("cached feature flags must not be read");
                },
                async isFeatureEnabled(name, options) {
                  actualFlagCalls.push({ name, options: clone(options) });
                  if (name === testCase.flag) {
                    selectedFlagReads += 1;
                    boundaryEvents.push(`flag:${name}:${selectedFlagReads}`);
                    return selectedFlagReads === 1;
                  }
                  boundaryEvents.push(`flag:${name}:1`);
                  if (name === "dailyDigest") {
                    return testCase.previewFlags.dailyEnabled;
                  }
                  if (name === "weeklySummary") {
                    return testCase.previewFlags.weeklyEnabled;
                  }
                  return testCase.previewFlags.noticeCasesEnabled;
                },
              },
              previewDigest: async (input) => {
                boundaryEvents.push("preview");
                previewInputs.push(clone(input));
                return {
                  kind: testCase.kind,
                  periodKey: testCase.periodKey,
                  counts: { open: 1 },
                };
              },
              requireActiveDigestAccess: async () => {
                boundaryEvents.push("authority");
                return {
                  user: makeUser({
                    isActive: true,
                    role: "SUPER_ADMIN",
                  }),
                  weeklyAuthorized: true,
                };
              },
              sendDigestEmail: async (input) => {
                boundaryEvents.push("provider");
                providerCalls.push(clone(input));
                return { data: { id: "must-not-send" } };
              },
            },
          ),
        (error) => {
          assert.equal(error.status, 404, testCase.kind);
          assert.equal(error.code, testCase.code, testCase.kind);
          assert.equal(error.message, testCase.message, testCase.kind);
          return true;
        },
      );

      assert.equal(cachedFlagCalls, 0, testCase.kind);
      assert.equal(previewInputs.length, 1, testCase.kind);
      assert.deepEqual(
        {
          dailyEnabled: previewInputs[0].dailyEnabled,
          weeklyEnabled: previewInputs[0].weeklyEnabled,
          noticeCasesEnabled: previewInputs[0].noticeCasesEnabled,
        },
        testCase.previewFlags,
        testCase.kind,
      );
      assert.deepEqual(
        actualFlagCalls,
        [
          { name: "dailyDigest", options: { fresh: true } },
          { name: "weeklySummary", options: { fresh: true } },
          { name: "noticeCases", options: { fresh: true } },
          { name: testCase.flag, options: { fresh: true } },
          { name: "noticeCases", options: { fresh: true } },
        ],
        testCase.kind,
      );
      assert.equal(selectedFlagReads, 2, testCase.kind);
      assert.deepEqual(
        boundaryEvents.slice(-3),
        ["preview", `flag:${testCase.flag}:2`, "flag:noticeCases:1"],
        testCase.kind,
      );
      assert.equal(boundaryEvents.includes("authority"), false, testCase.kind);
      assert.equal(providerCalls.length, 0, testCase.kind);
    }
  },
);

await check(
  "interactive send-test rejects notice-case changes during the final selected read",
  async () => {
    let dailyReads = 0;
    let noticeReads = 0;
    let noticeEnabled = true;
    let providerCalls = 0;
    const flagCalls = [];

    await assert.rejects(
      () =>
        sendTestDigestNow(
          {
            userId: IDS.recipient,
            firmId: IDS.firm,
            role: "SUPER_ADMIN",
            toEmail: "diagnostic-caller@example.test",
            kind: DAILY_KIND,
            now: new Date(FIXED_NOW),
          },
          {
            AppConfig: {
              async isFeatureEnabled(name, options) {
                flagCalls.push({ name, options: clone(options) });
                if (name === "dailyDigest") {
                  dailyReads += 1;
                  if (dailyReads === 2) noticeEnabled = false;
                  return true;
                }
                if (name === "noticeCases") {
                  noticeReads += 1;
                  return noticeEnabled;
                }
                return false;
              },
            },
            previewDigest: async (input) => {
              assert.equal(input.noticeCasesEnabled, true);
              return {
                kind: DAILY_KIND,
                periodKey: "2026-03-20",
                counts: { open: 1 },
              };
            },
            requireActiveDigestAccess: async () => ({
              user: makeUser({ isActive: true, role: "SUPER_ADMIN" }),
              weeklyAuthorized: true,
            }),
            sendDigestEmail: async () => {
              providerCalls += 1;
              return { data: { id: "must-not-send" } };
            },
          },
        ),
      (error) => {
        assert.equal(error.status, 409);
        assert.equal(error.code, "DIGEST_PREVIEW_STALE");
        assert.equal(
          error.message,
          "Digest inputs changed after preview; preview the current digest again",
        );
        return true;
      },
    );

    assert.equal(dailyReads, 2);
    assert.equal(noticeReads, 2);
    assert.equal(providerCalls, 0);
    assert.deepEqual(flagCalls, [
      { name: "dailyDigest", options: { fresh: true } },
      { name: "weeklySummary", options: { fresh: true } },
      { name: "noticeCases", options: { fresh: true } },
      { name: "dailyDigest", options: { fresh: true } },
      { name: "noticeCases", options: { fresh: true } },
    ]);
  },
);

await check(
  "interactive send-test rejects notice-case version and publication-fence ABA changes",
  async () => {
    let noticeReads = 0;
    let authorityCalls = 0;
    let providerCalls = 0;

    await assert.rejects(
      () =>
        sendTestDigestNow(
          {
            userId: IDS.recipient,
            firmId: IDS.firm,
            role: "SUPER_ADMIN",
            toEmail: "diagnostic-caller@example.test",
            kind: DAILY_KIND,
            now: new Date(FIXED_NOW),
          },
          {
            AppConfig: {
              async getFeatureFlagState(name, options) {
                assert.deepEqual(options, { fresh: true });
                if (name === "noticeCases") {
                  noticeReads += 1;
                  return {
                    enabled: true,
                    version: noticeReads,
                    publicationFence: `notice-fence-${noticeReads}`,
                  };
                }
                return {
                  enabled: name === "dailyDigest",
                  version: 0,
                  publicationFence: "",
                };
              },
              async isFeatureEnabled() {
                throw new Error("state-aware reads must not use booleans");
              },
            },
            previewDigest: async (input) => {
              assert.equal(input.noticeCasesEnabled, true);
              return {
                kind: DAILY_KIND,
                periodKey: "2026-03-20",
                counts: { open: 1 },
              };
            },
            requireActiveDigestAccess: async () => {
              authorityCalls += 1;
              return {
                user: makeUser({ isActive: true, role: "SUPER_ADMIN" }),
                weeklyAuthorized: true,
              };
            },
            sendDigestEmail: async () => {
              providerCalls += 1;
              return { data: { id: "must-not-send" } };
            },
          },
        ),
      (error) => {
        assert.equal(error.status, 409);
        assert.equal(error.code, "DIGEST_PREVIEW_STALE");
        return true;
      },
    );

    assert.equal(noticeReads, 2);
    assert.equal(authorityCalls, 0);
    assert.equal(providerCalls, 0);
  },
);

await check(
  "interactive send-test keeps final authority adjacent to provider after same-enabled rollout republish",
  async () => {
    const cases = [
      {
        kind: DAILY_KIND,
        periodKey: "2026-03-20",
        flag: "dailyDigest",
        previewFlags: {
          dailyEnabled: true,
          weeklyEnabled: false,
          noticeCasesEnabled: true,
        },
      },
      {
        kind: WEEKLY_KIND,
        periodKey: "2026-03-16",
        flag: "weeklySummary",
        previewFlags: {
          dailyEnabled: false,
          weeklyEnabled: true,
          noticeCasesEnabled: false,
        },
      },
    ];

    for (const testCase of cases) {
      let cachedFlagCalls = 0;
      let selectedFlagReads = 0;
      let noticeReads = 0;
      const events = [];
      const providerCalls = [];
      const result = await sendTestDigestNow(
        {
          userId: IDS.recipient,
          firmId: IDS.firm,
          role: "SUPER_ADMIN",
          toEmail: "diagnostic-caller@example.test",
          kind: testCase.kind,
          now: new Date(FIXED_NOW),
        },
        {
          AppConfig: {
            async getFeatureFlags() {
              cachedFlagCalls += 1;
              throw new Error("cached feature flags must not be read");
            },
            async getFeatureFlagState(name, options) {
              assert.deepEqual(options, { fresh: true });
              if (name === testCase.flag) selectedFlagReads += 1;
              if (name === "noticeCases") noticeReads += 1;
              const readNumber =
                name === testCase.flag
                  ? selectedFlagReads
                  : name === "noticeCases"
                    ? noticeReads
                    : 1;
              events.push(`flag:${name}:${readNumber}`);
              const enabled =
                name === "dailyDigest"
                  ? testCase.previewFlags.dailyEnabled
                  : name === "weeklySummary"
                    ? testCase.previewFlags.weeklyEnabled
                    : testCase.previewFlags.noticeCasesEnabled;
              return {
                enabled,
                // dailyDigest/weeklySummary have no schema-backed identity.
                // A same-enabled republish therefore remains sendable.
                version: name === testCase.flag ? selectedFlagReads : 7,
                publicationFence:
                  name === testCase.flag
                    ? `selected-publication-${selectedFlagReads}`
                    : "stable-publication",
              };
            },
            async isFeatureEnabled() {
              throw new Error("state-aware reads must not use booleans");
            },
          },
          previewDigest: async (input) => {
            events.push("preview");
            assert.deepEqual(
              {
                dailyEnabled: input.dailyEnabled,
                weeklyEnabled: input.weeklyEnabled,
                noticeCasesEnabled: input.noticeCasesEnabled,
              },
              testCase.previewFlags,
            );
            return {
              kind: testCase.kind,
              periodKey: testCase.periodKey,
              counts: {
                open: 1,
                overdue: 0,
                dueSoon: 0,
                waitingDocs: 0,
                case: 0,
                reconciliationReview: 0,
              },
              topTasks: [],
            };
          },
          requireActiveDigestAccess: async () => {
            events.push("authority");
            return {
              user: makeUser({ isActive: true, role: "SUPER_ADMIN" }),
              weeklyAuthorized: true,
            };
          },
          sendDigestEmail: async (input) => {
            events.push("provider");
            providerCalls.push(clone(input));
            return { data: { id: `provider-${testCase.kind}` } };
          },
        },
      );

      assert.equal(cachedFlagCalls, 0, testCase.kind);
      assert.equal(selectedFlagReads, 2, testCase.kind);
      assert.equal(noticeReads, 2, testCase.kind);
      assert.deepEqual(
        events.slice(-4),
        [
          `flag:${testCase.flag}:2`,
          "flag:noticeCases:2",
          "authority",
          "provider",
        ],
        testCase.kind,
      );
      assert.deepEqual(
        events.slice(-2),
        ["authority", "provider"],
        testCase.kind,
      );
      assert.equal(providerCalls.length, 1, testCase.kind);
      assert.equal(
        result.providerMessageId,
        `provider-${testCase.kind}`,
        testCase.kind,
      );
    }
  },
);

await check(
  "completeDigestStartup executes ordered phases and propagates failures",
  async () => {
    const serverSource = readFileSync(
      new URL("../src/server.js", import.meta.url),
      "utf8",
    );
    const match = serverSource.match(
      /export (async function completeDigestStartup\([\s\S]*?\r?\n\})\r?\n\r?\n\/\/ Start listening/,
    );
    assert.ok(match, "completeDigestStartup source extraction failed");
    const completeDigestStartup = Function(
      `"use strict"; return (${match[1]});`,
    )();

    const order = [];
    let releaseSchedulers;
    const schedulerGate = new Promise((resolve) => {
      releaseSchedulers = resolve;
    });
    const completion = completeDigestStartup({
      assertIndexes: async () => order.push("indexes"),
      drainRecovery: async () => order.push("drain"),
      startSchedulers: async () => {
        order.push("start");
        await schedulerGate;
        order.push("start-complete");
      },
      setReady: (ready) => order.push(`ready:${ready}`),
      isShuttingDown: () => {
        order.push("shutdown-check");
        return false;
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(order, [
      "indexes",
      "shutdown-check",
      "drain",
      "shutdown-check",
      "start",
    ]);
    assert.equal(order.includes("ready:true"), false);
    releaseSchedulers();
    const completed = await completion;
    assert.equal(completed, true);
    assert.deepEqual(order, [
      "indexes",
      "shutdown-check",
      "drain",
      "shutdown-check",
      "start",
      "start-complete",
      "ready:true",
    ]);

    const indexFailure = new Error("index phase failed");
    const indexFailureEvents = [];
    await assert.rejects(
      () =>
        completeDigestStartup({
          assertIndexes: async () => {
            indexFailureEvents.push("indexes");
            throw indexFailure;
          },
          drainRecovery: async () => indexFailureEvents.push("drain"),
          startSchedulers: async () => indexFailureEvents.push("start"),
          setReady: () => indexFailureEvents.push("ready"),
          isShuttingDown: () => false,
        }),
      (error) => error === indexFailure,
    );
    assert.deepEqual(indexFailureEvents, ["indexes"]);

    const drainFailure = new Error("drain phase failed");
    const drainFailureEvents = [];
    await assert.rejects(
      () =>
        completeDigestStartup({
          assertIndexes: async () => drainFailureEvents.push("indexes"),
          drainRecovery: async () => {
            drainFailureEvents.push("drain");
            throw drainFailure;
          },
          startSchedulers: async () => drainFailureEvents.push("start"),
          setReady: () => drainFailureEvents.push("ready"),
          isShuttingDown: () => {
            drainFailureEvents.push("shutdown-check");
            return false;
          },
        }),
      (error) => error === drainFailure,
    );
    assert.deepEqual(drainFailureEvents, [
      "indexes",
      "shutdown-check",
      "drain",
    ]);

    const schedulerFailure = new Error("scheduler phase failed");
    const schedulerFailureEvents = [];
    await assert.rejects(
      () =>
        completeDigestStartup({
          assertIndexes: async () => schedulerFailureEvents.push("indexes"),
          drainRecovery: async () => schedulerFailureEvents.push("drain"),
          startSchedulers: async () => {
            schedulerFailureEvents.push("start");
            throw schedulerFailure;
          },
          setReady: () => schedulerFailureEvents.push("ready"),
          isShuttingDown: () => {
            schedulerFailureEvents.push("shutdown-check");
            return false;
          },
        }),
      (error) => error === schedulerFailure,
    );
    assert.deepEqual(schedulerFailureEvents, [
      "indexes",
      "shutdown-check",
      "drain",
      "shutdown-check",
      "start",
    ]);

    for (const stopAfterCheck of [1, 2]) {
      const shutdownEvents = [];
      let shutdownChecks = 0;
      const result = await completeDigestStartup({
        assertIndexes: async () => shutdownEvents.push("indexes"),
        drainRecovery: async () => shutdownEvents.push("drain"),
        startSchedulers: async () => shutdownEvents.push("start"),
        setReady: () => shutdownEvents.push("ready"),
        isShuttingDown: () => {
          shutdownChecks += 1;
          shutdownEvents.push(`shutdown-${shutdownChecks}`);
          return shutdownChecks === stopAfterCheck;
        },
      });
      assert.equal(result, false, `shutdown check ${stopAfterCheck}`);
      assert.equal(
        shutdownEvents.includes("start"),
        false,
        `shutdown check ${stopAfterCheck}`,
      );
      assert.equal(
        shutdownEvents.includes("ready"),
        false,
        `shutdown check ${stopAfterCheck}`,
      );
      assert.deepEqual(
        shutdownEvents,
        stopAfterCheck === 1
          ? ["indexes", "shutdown-1"]
          : ["indexes", "shutdown-1", "drain", "shutdown-2"],
      );
    }
  },
);

await check(
  "completeDigestStartup gates readiness until durable recovery completes a clean retry",
  async () => {
    const serverSource = readFileSync(
      new URL("../src/server.js", import.meta.url),
      "utf8",
    );
    const match = serverSource.match(
      /export (async function completeDigestStartup\([\s\S]*?\r?\n\})\r?\n\r?\n\/\/ Start listening/,
    );
    assert.ok(match, "completeDigestStartup source extraction failed");
    const completeDigestStartup = Function(
      `"use strict"; return (${match[1]});`,
    )();
    const deliveryId = orderedObjectId(1);
    const deliveryStore = createInMemoryDigestDelivery([
      makeRecoverableDelivery(1, {
        email: { state: "PENDING", claimToken: null, claimedAt: null },
      }),
    ]);
    const recoveryCursor = createInMemoryDigestRecoveryCursor({
      _id: DIGEST_RECOVERY_CURSOR_ID,
      afterId: deliveryId,
      cycleEndId: deliveryId,
      lease: {
        token: "drc1:1",
        expiresAt: DIGEST_RECOVERY_LEGACY_FENCE,
      },
    });
    const recovered = [];
    const drainRecovery = () =>
      drainDigestRecovery(
        { now: new Date(FIXED_NOW) },
        {
          AppConfig: {
            async isFeatureEnabled() {
              return false;
            },
          },
          DigestDelivery: deliveryStore.model,
          DigestRecoveryCursor: recoveryCursor.model,
          enqueueRecipientDigest: async ({ periodKey }) => {
            recovered.push(periodKey);
          },
          recoveryClock: () => new Date(FIXED_NOW),
          reportRecoveryError: async () => {},
        },
      );
    const events = [];
    const startupDependencies = {
      assertIndexes: async () => events.push("indexes"),
      drainRecovery: async () => {
        events.push("drain");
        return drainRecovery();
      },
      startSchedulers: async () => events.push("start"),
      setReady: (ready) => events.push(`ready:${ready}`),
      isShuttingDown: () => false,
    };

    await assert.rejects(
      () => completeDigestStartup(startupDependencies),
      (error) => {
        assert.equal(error.code, "DIGEST_RECOVERY_ROWS_FAILED");
        assert.equal(error.rowFailureCount, 1);
        assert.equal(error.rowFailuresComplete, false);
        return true;
      },
    );
    assert.deepEqual(events, ["indexes", "drain"]);
    assert.deepEqual(recovered, []);
    assert.equal(recoveryCursor.get().afterId, null);
    assert.equal(recoveryCursor.get().cycleEndId, deliveryId);

    const completed = await completeDigestStartup(startupDependencies);
    assert.equal(completed, true);
    assert.deepEqual(events, [
      "indexes",
      "drain",
      "indexes",
      "drain",
      "start",
      "ready:true",
    ]);
    assert.deepEqual(recovered, ["recovery-0001"]);
    assert.equal(recoveryCursor.get().cycleEndId, null);
    assert.equal(recoveryCursor.get().lease.token, null);
    assert.equal(recoveryCursor.get().lease.expiresAt, null);
  },
);

await check(
  "drainDigestRecovery completes a finite high-water set beyond 500",
  async () => {
    const rowsPerPass =
      DIGEST_RECOVERY_BATCH_SIZE * DIGEST_RECOVERY_MAX_BATCHES;
    const total = rowsPerPass + 50;
    assert.ok(total > 500);
    const deliveries = Array.from({ length: total }, (_, index) =>
      makeRecoverableDelivery(index + 1, {
        email: { state: "PENDING", claimToken: null, claimedAt: null },
      }),
    );
    const deliveryStore = createInMemoryDigestDelivery(deliveries);
    const recoveryCursor = createInMemoryDigestRecoveryCursor();
    const recoveredPeriods = [];
    const featureCalls = [];
    let yieldCalls = 0;
    const movingTailPeriod = `recovery-${String(total + 100).padStart(4, "0")}`;

    const result = await drainDigestRecovery(
      { now: new Date(FIXED_NOW) },
      {
        AppConfig: {
          async isFeatureEnabled(name, options) {
            featureCalls.push({ name, options: clone(options) });
            return false;
          },
        },
        DigestDelivery: deliveryStore.model,
        DigestRecoveryCursor: recoveryCursor.model,
        enqueueRecipientDigest: async ({ periodKey }) => {
          recoveredPeriods.push(periodKey);
          if (recoveredPeriods.length === 1) {
            deliveryStore.insert(
              makeRecoverableDelivery(total + 100, {
                email: {
                  state: "PENDING",
                  claimToken: null,
                  claimedAt: null,
                },
              }),
            );
          }
        },
        recoveryClock: () => new Date(FIXED_NOW),
        reportRecoveryError: async () => {},
        yieldControl: async () => {
          yieldCalls += 1;
        },
      },
    );

    assert.deepEqual(result, {
      completed: true,
      passes: 2,
      rowsProcessed: total,
      rowFailures: [],
    });
    assert.equal(recoveredPeriods.length, total);
    assert.equal(recoveredPeriods.includes(movingTailPeriod), false);
    assert.equal(yieldCalls, 1);
    assert.deepEqual(featureCalls, [
      { name: "noticeCases", options: { fresh: true } },
    ]);
    assert.equal(recoveryCursor.get().afterId, null);
    assert.equal(recoveryCursor.get().cycleEndId, null);
    assert.equal(recoveryCursor.get().lease.token, null);
    assert.equal(recoveryCursor.get().lease.expiresAt, null);
  },
);

await check(
  "recovery lease acquisition cannot overwrite a newer marker snapshot",
  async () => {
    const deliveryStore = createInMemoryDigestDelivery([
      makeRecoverableDelivery(1),
    ]);
    const recoveryCursor = createInMemoryDigestRecoveryCursor({
      _id: DIGEST_RECOVERY_CURSOR_ID,
      afterId: null,
      cycleEndId: orderedObjectId(1),
      lease: {
        token: "drc1:2",
        expiresAt: DIGEST_RECOVERY_LEGACY_FENCE,
      },
    });
    let newerMarkerInjected = false;
    const DigestRecoveryCursorModel = {
      ...recoveryCursor.model,
      async findOneAndUpdate(filter, update, options) {
        if (!newerMarkerInjected) {
          newerMarkerInjected = true;
          const changed = await recoveryCursor.model.updateOne(
            {
              _id: DIGEST_RECOVERY_CURSOR_ID,
              "lease.token": "drc1:2",
            },
            { $set: { "lease.token": "drc1:3" } },
          );
          assert.equal(changed.matchedCount, 1);
        }
        return recoveryCursor.model.findOneAndUpdate(filter, update, options);
      },
    };
    const recoveredPeriods = [];

    await runDisabledDigestRecovery({
      deliveryModel: deliveryStore.model,
      cursorModel: DigestRecoveryCursorModel,
      recover: async ({ periodKey }) => {
        recoveredPeriods.push(periodKey);
      },
    });

    const acquisition = recoveryCursor.operations.find(
      (operation) => operation.method === "findOneAndUpdate",
    );
    assert.equal(newerMarkerInjected, true);
    assert.deepEqual(recoveredPeriods, []);
    assert.equal(recoveryCursor.get().lease.token, "drc1:3");
    assertUpsertScalarEquality(
      acquisition.filter,
      "lease.token",
      "drc1:2",
      "recovery marker acquisition snapshot",
    );
    assertUpsertScalarEquality(
      acquisition.filter,
      "lease.expiresAt",
      DIGEST_RECOVERY_LEGACY_FENCE,
      "recovery expiry acquisition snapshot",
    );
    const proposedToken = assertDigestRecoveryActiveToken(
      acquisition.update.$set["lease.token"],
      { failureCount: 2 },
    );
    assert.equal(
      proposedToken.expiresAt.toISOString(),
      new Date(
        FIXED_NOW.getTime() + DIGEST_RECOVERY_CURSOR_LEASE_MS,
      ).toISOString(),
    );
    assertDigestRecoveryLegacyFence(acquisition.update.$set["lease.expiresAt"]);
  },
);

await check(
  "durable recovery failure survives interruption and expiry until full retry",
  async () => {
    const rowsPerPass =
      DIGEST_RECOVERY_BATCH_SIZE * DIGEST_RECOVERY_MAX_BATCHES;
    const total = rowsPerPass + 1;
    const deliveryStore = createInMemoryDigestDelivery(
      Array.from({ length: total }, (_, index) =>
        makeRecoverableDelivery(index + 1, {
          email: { state: "PENDING", claimToken: null, claimedAt: null },
        }),
      ),
    );
    const recoveryCursor = createInMemoryDigestRecoveryCursor();
    const attemptedPeriods = [];
    let rowTwoFails = true;
    const runDrain = (yieldControl = async () => {}) =>
      drainDigestRecovery(
        { now: new Date(FIXED_NOW) },
        {
          AppConfig: {
            async isFeatureEnabled() {
              return false;
            },
          },
          DigestDelivery: deliveryStore.model,
          DigestRecoveryCursor: recoveryCursor.model,
          enqueueRecipientDigest: async ({ periodKey }) => {
            attemptedPeriods.push(periodKey);
            if (rowTwoFails && periodKey === "recovery-0002") {
              const error = new Error("row two failed before interruption");
              error.code = "ROW_TWO_FAILED";
              throw error;
            }
          },
          recoveryClock: () => new Date(FIXED_NOW),
          reportRecoveryError: async () => {},
          yieldControl,
        },
      );
    const interruption = new Error("stop after first bounded pass");
    let interruptionYields = 0;

    await assert.rejects(
      () =>
        runDrain(async () => {
          interruptionYields += 1;
          throw interruption;
        }),
      (error) => error === interruption,
    );

    assert.equal(interruptionYields, 1);
    assert.equal(attemptedPeriods.length, rowsPerPass);
    assert.equal(attemptedPeriods.includes("recovery-0002"), true);
    assert.equal(attemptedPeriods.includes("recovery-0501"), false);
    assert.equal(recoveryCursor.get().afterId, orderedObjectId(rowsPerPass));
    assert.equal(recoveryCursor.get().cycleEndId, orderedObjectId(total));
    assert.equal(recoveryCursor.get().lease.token, "drc1:1");
    assertDigestRecoveryLegacyFence(recoveryCursor.get().lease.expiresAt);

    const crashedExpiry = new Date(FIXED_NOW.getTime() - 1);
    const crashedToken = digestRecoveryActiveToken({
      failureCount: 1,
      expiresAt: crashedExpiry,
    });
    const crashed = await recoveryCursor.model.updateOne(
      {
        _id: DIGEST_RECOVERY_CURSOR_ID,
        "lease.token": "drc1:1",
      },
      {
        $set: {
          "lease.token": crashedToken,
          "lease.expiresAt": DIGEST_RECOVERY_LEGACY_FENCE,
        },
      },
    );
    assert.equal(crashed.matchedCount, 1);
    const secondOperationStart = recoveryCursor.operations.length;

    await assert.rejects(
      () => runDrain(),
      (error) => {
        assert.equal(error.code, "DIGEST_RECOVERY_ROWS_FAILED");
        assert.equal(error.passes, 1);
        assert.equal(error.rowsProcessed, 1);
        assert.equal(error.rowFailureCount, 1);
        assert.equal(error.rowFailuresComplete, false);
        assert.deepEqual(error.rowFailures, []);
        return true;
      },
    );

    assert.deepEqual(attemptedPeriods.slice(rowsPerPass), ["recovery-0501"]);
    const reclaimedAcquisition = recoveryCursor.operations
      .slice(secondOperationStart)
      .find((operation) => operation.method === "findOneAndUpdate");
    const reclaimedToken = reclaimedAcquisition.update.$set["lease.token"];
    assertUpsertScalarEquality(
      reclaimedAcquisition.filter,
      "lease.token",
      crashedToken,
      "expired recovery marker snapshot",
    );
    assertUpsertScalarEquality(
      reclaimedAcquisition.filter,
      "lease.expiresAt",
      DIGEST_RECOVERY_LEGACY_FENCE,
      "expired recovery lease snapshot",
    );
    const reclaimed = assertDigestRecoveryActiveToken(reclaimedToken, {
      failureCount: 1,
    });
    assert.equal(
      reclaimed.expiresAt.toISOString(),
      new Date(
        FIXED_NOW.getTime() + DIGEST_RECOVERY_CURSOR_LEASE_MS,
      ).toISOString(),
    );
    assert.notEqual(reclaimedToken, crashedToken);
    assertDigestRecoveryLegacyFence(
      reclaimedAcquisition.update.$set["lease.expiresAt"],
    );
    assert.equal(recoveryCursor.get().afterId, null);
    assert.equal(recoveryCursor.get().cycleEndId, orderedObjectId(total));
    assert.equal(recoveryCursor.get().lease.token, "drc1:0");
    assertDigestRecoveryLegacyFence(recoveryCursor.get().lease.expiresAt);

    rowTwoFails = false;
    const retryAttemptStart = attemptedPeriods.length;
    const retryResult = await runDrain();
    const retryPeriods = attemptedPeriods.slice(retryAttemptStart);

    assert.deepEqual(retryResult, {
      completed: true,
      passes: 2,
      rowsProcessed: total,
      rowFailures: [],
    });
    assert.equal(retryPeriods.length, total);
    assert.equal(retryPeriods[0], "recovery-0001");
    assert.equal(retryPeriods[1], "recovery-0002");
    assert.equal(retryPeriods.at(-1), "recovery-0501");
    assert.equal(recoveryCursor.get().afterId, null);
    assert.equal(recoveryCursor.get().cycleEndId, null);
    assert.equal(recoveryCursor.get().lease.token, null);
    assert.equal(recoveryCursor.get().lease.expiresAt, null);
  },
);

await check(
  "applied failure advance survives lost acknowledgement and still forces retry",
  async () => {
    const deliveryId = orderedObjectId(1);
    const deliveryStore = createInMemoryDigestDelivery([
      makeRecoverableDelivery(1, {
        email: { state: "PENDING", claimToken: null, claimedAt: null },
      }),
    ]);
    const recoveryCursor = createInMemoryDigestRecoveryCursor();
    const acknowledgementLost = new Error(
      "failure advance acknowledgement was lost",
    );
    let injectLostAcknowledgement = true;
    const cursorModel = {
      ...recoveryCursor.model,
      async updateOne(filter, update) {
        const result = await recoveryCursor.model.updateOne(filter, update);
        const nextToken = update?.$set?.["lease.token"];
        if (
          injectLostAcknowledgement &&
          scalarEquals(update?.$set?.afterId, deliveryId) &&
          typeof nextToken === "string" &&
          nextToken.startsWith("drc1:1:")
        ) {
          injectLostAcknowledgement = false;
          throw acknowledgementLost;
        }
        return result;
      },
    };
    let recoveryNow = new Date(FIXED_NOW);
    let rowFails = true;
    const attempts = [];
    const runDrain = () =>
      drainDigestRecovery(
        { now: new Date(FIXED_NOW) },
        {
          AppConfig: {
            async isFeatureEnabled() {
              return false;
            },
          },
          DigestDelivery: deliveryStore.model,
          DigestRecoveryCursor: cursorModel,
          enqueueRecipientDigest: async ({ periodKey }) => {
            attempts.push(periodKey);
            if (rowFails) {
              const error = new Error("row failed before acknowledgement loss");
              error.code = "ROW_FAILED_BEFORE_ACK";
              throw error;
            }
          },
          recoveryClock: () => new Date(recoveryNow),
          reportRecoveryError: async () => {},
        },
      );

    await assert.rejects(
      () => runDrain(),
      (error) => error === acknowledgementLost,
    );
    assert.equal(injectLostAcknowledgement, false);
    assert.deepEqual(attempts, ["recovery-0001"]);
    assert.equal(recoveryCursor.get().afterId, deliveryId);
    assert.equal(recoveryCursor.get().cycleEndId, deliveryId);
    const active = assertDigestRecoveryActiveToken(
      recoveryCursor.get().lease.token,
      { failureCount: 1 },
    );
    assertDigestRecoveryLegacyFence(recoveryCursor.get().lease.expiresAt);

    recoveryNow = new Date(active.expiresAt.getTime() + 1);
    await assert.rejects(
      () => runDrain(),
      (error) => {
        assert.equal(error.code, "DIGEST_RECOVERY_ROWS_FAILED");
        assert.equal(error.rowFailureCount, 1);
        assert.equal(error.rowFailuresComplete, false);
        assert.deepEqual(error.rowFailures, []);
        return true;
      },
    );
    assert.deepEqual(attempts, ["recovery-0001"]);
    assert.equal(recoveryCursor.get().afterId, null);
    assert.equal(recoveryCursor.get().cycleEndId, deliveryId);
    assert.equal(recoveryCursor.get().lease.token, "drc1:0");
    assertDigestRecoveryLegacyFence(recoveryCursor.get().lease.expiresAt);

    rowFails = false;
    const retry = await runDrain();
    assert.deepEqual(retry, {
      completed: true,
      passes: 1,
      rowsProcessed: 1,
      rowFailures: [],
    });
    assert.deepEqual(attempts, ["recovery-0001", "recovery-0001"]);
    assert.equal(recoveryCursor.get().cycleEndId, null);
    assert.equal(recoveryCursor.get().lease.token, null);
    assert.equal(recoveryCursor.get().lease.expiresAt, null);
  },
);

await check(
  "applied failed-cycle transition survives lost acknowledgement and requires full scan",
  async () => {
    const deliveryId = orderedObjectId(1);
    const deliveryStore = createInMemoryDigestDelivery([
      makeRecoverableDelivery(1, {
        email: { state: "PENDING", claimToken: null, claimedAt: null },
      }),
    ]);
    const recoveryCursor = createInMemoryDigestRecoveryCursor({
      _id: DIGEST_RECOVERY_CURSOR_ID,
      afterId: deliveryId,
      cycleEndId: deliveryId,
      lease: {
        token: "drc1:1",
        expiresAt: DIGEST_RECOVERY_LEGACY_FENCE,
      },
    });
    const acknowledgementLost = new Error(
      "failed-cycle completion acknowledgement was lost",
    );
    let injectLostAcknowledgement = true;
    const cursorModel = {
      ...recoveryCursor.model,
      async updateOne(filter, update) {
        const result = await recoveryCursor.model.updateOne(filter, update);
        if (
          injectLostAcknowledgement &&
          update?.$set?.afterId === null &&
          scalarEquals(update?.$set?.cycleEndId, deliveryId) &&
          update?.$set?.["lease.token"] === "drc1:0"
        ) {
          injectLostAcknowledgement = false;
          throw acknowledgementLost;
        }
        return result;
      },
    };
    const attempts = [];
    const runDrain = () =>
      drainDigestRecovery(
        { now: new Date(FIXED_NOW) },
        {
          AppConfig: {
            async isFeatureEnabled() {
              return false;
            },
          },
          DigestDelivery: deliveryStore.model,
          DigestRecoveryCursor: cursorModel,
          enqueueRecipientDigest: async ({ periodKey }) => {
            attempts.push(periodKey);
          },
          recoveryClock: () => new Date(FIXED_NOW),
          reportRecoveryError: async () => {},
        },
      );

    await assert.rejects(
      () => runDrain(),
      (error) => error === acknowledgementLost,
    );
    assert.equal(injectLostAcknowledgement, false);
    assert.deepEqual(attempts, []);
    assert.equal(recoveryCursor.get().afterId, null);
    assert.equal(recoveryCursor.get().cycleEndId, deliveryId);
    assert.equal(recoveryCursor.get().lease.token, "drc1:0");
    assertDigestRecoveryLegacyFence(recoveryCursor.get().lease.expiresAt);

    const retry = await runDrain();
    assert.deepEqual(retry, {
      completed: true,
      passes: 1,
      rowsProcessed: 1,
      rowFailures: [],
    });
    assert.deepEqual(attempts, ["recovery-0001"]);
    assert.equal(recoveryCursor.get().afterId, null);
    assert.equal(recoveryCursor.get().cycleEndId, null);
    assert.equal(recoveryCursor.get().lease.token, null);
    assert.equal(recoveryCursor.get().lease.expiresAt, null);
  },
);

await check(
  "durable recovery failure count saturates within safe token bounds",
  async () => {
    const maximumCount = Number.MAX_SAFE_INTEGER;
    const deliveryStore = createInMemoryDigestDelivery([
      makeRecoverableDelivery(1, {
        email: { state: "PENDING", claimToken: null, claimedAt: null },
      }),
    ]);
    const recoveryCursor = createInMemoryDigestRecoveryCursor({
      _id: DIGEST_RECOVERY_CURSOR_ID,
      afterId: null,
      cycleEndId: orderedObjectId(1),
      lease: {
        token: `drc1:${maximumCount}`,
        expiresAt: DIGEST_RECOVERY_LEGACY_FENCE,
      },
    });

    await assert.rejects(
      () =>
        drainDigestRecovery(
          { now: new Date(FIXED_NOW) },
          {
            AppConfig: {
              async isFeatureEnabled() {
                return false;
              },
            },
            DigestDelivery: deliveryStore.model,
            DigestRecoveryCursor: recoveryCursor.model,
            enqueueRecipientDigest: async () => {
              const error = new Error("failure count must saturate");
              error.code = "SATURATED_FAILURE";
              throw error;
            },
            recoveryClock: () => new Date(FIXED_NOW),
            reportRecoveryError: async () => {},
          },
        ),
      (error) => {
        assert.equal(error.code, "DIGEST_RECOVERY_ROWS_FAILED");
        assert.equal(error.rowFailureCount, maximumCount);
        assert.equal(error.rowFailuresComplete, false);
        assert.equal(error.rowFailures.length, 1);
        return true;
      },
    );

    const activeTokens = recoveryCursor.operations
      .map((operation) => operation.update?.$set?.["lease.token"])
      .filter(
        (token) =>
          typeof token === "string" &&
          token.startsWith(`drc1:${maximumCount}:`),
      );
    assert.ok(activeTokens.length >= 2);
    for (const token of activeTokens) {
      assertDigestRecoveryActiveToken(token, { failureCount: maximumCount });
    }
    assert.equal(recoveryCursor.get().afterId, null);
    assert.equal(recoveryCursor.get().cycleEndId, orderedObjectId(1));
    assert.equal(recoveryCursor.get().lease.token, "drc1:0");
    assertDigestRecoveryLegacyFence(recoveryCursor.get().lease.expiresAt);
  },
);

await check(
  "drainDigestRecovery preserves detailed row failures and prepares full retry",
  async () => {
    const rowsPerPass =
      DIGEST_RECOVERY_BATCH_SIZE * DIGEST_RECOVERY_MAX_BATCHES;
    const total = rowsPerPass + 1;
    const deliveryStore = createInMemoryDigestDelivery(
      Array.from({ length: total }, (_, index) =>
        makeRecoverableDelivery(index + 1, {
          email: { state: "PENDING", claimToken: null, claimedAt: null },
        }),
      ),
    );
    const recoveryCursor = createInMemoryDigestRecoveryCursor();
    const attemptedPeriods = [];
    const reported = [];
    let yieldCalls = 0;

    await assert.rejects(
      () =>
        drainDigestRecovery(
          { now: new Date(FIXED_NOW) },
          {
            AppConfig: {
              async isFeatureEnabled() {
                return false;
              },
            },
            DigestDelivery: deliveryStore.model,
            DigestRecoveryCursor: recoveryCursor.model,
            enqueueRecipientDigest: async ({ periodKey }) => {
              attemptedPeriods.push(periodKey);
              if (periodKey === "recovery-0002") {
                const error = new Error("row two failed");
                error.code = "ROW_TWO_FAILED";
                throw error;
              }
              if (periodKey === `recovery-${String(total).padStart(4, "0")}`) {
                const error = new Error("last row failed");
                error.code = "LAST_ROW_FAILED";
                throw error;
              }
            },
            recoveryClock: () => new Date(FIXED_NOW),
            reportRecoveryError: async (entry) => {
              reported.push(clone(entry));
            },
            yieldControl: async () => {
              yieldCalls += 1;
            },
          },
        ),
      (error) => {
        assert.equal(error.code, "DIGEST_RECOVERY_ROWS_FAILED");
        assert.equal(error.passes, 2);
        assert.equal(error.rowsProcessed, total);
        assert.equal(error.rowFailureCount, 2);
        assert.equal(error.rowFailuresComplete, true);
        assert.deepEqual(error.rowFailures, [
          { deliveryId: orderedObjectId(2), code: "ROW_TWO_FAILED" },
          {
            deliveryId: orderedObjectId(total),
            code: "LAST_ROW_FAILED",
          },
        ]);
        return true;
      },
    );

    assert.equal(attemptedPeriods.length, total);
    assert.equal(yieldCalls, 1);
    assert.deepEqual(reported, [
      { code: "ROW_TWO_FAILED" },
      { code: "LAST_ROW_FAILED" },
    ]);
    assert.equal(recoveryCursor.get().afterId, null);
    assert.equal(recoveryCursor.get().cycleEndId, orderedObjectId(total));
    assert.equal(recoveryCursor.get().lease.token, "drc1:0");
    assertDigestRecoveryLegacyFence(recoveryCursor.get().lease.expiresAt);
  },
);

await check(
  "drainDigestRecovery rejects busy and lease-loss passes without completion",
  async () => {
    const cases = [
      {
        state: "busy",
        flag: "busy",
        code: "DIGEST_RECOVERY_BUSY",
      },
      {
        state: "leaseLost",
        flag: "leaseLost",
        code: "DIGEST_RECOVERY_CURSOR_LEASE_LOST",
      },
    ];

    for (const testCase of cases) {
      let passCalls = 0;
      let yieldCalls = 0;
      await assert.rejects(
        () =>
          drainDigestRecovery(
            { now: new Date(FIXED_NOW) },
            {
              AppConfig: {
                async isFeatureEnabled() {
                  return false;
                },
              },
              reconcileRecoveryPass: async () => {
                passCalls += 1;
                return {
                  state: testCase.state,
                  [testCase.flag]: true,
                  completed: true,
                  rowsProcessed: 7,
                  rowFailures: [],
                };
              },
              yieldControl: async () => {
                yieldCalls += 1;
              },
            },
          ),
        (error) => {
          assert.equal(error.code, testCase.code, testCase.state);
          assert.equal(error.passes, 1, testCase.state);
          assert.equal(error.rowsProcessed, 7, testCase.state);
          assert.equal(error.completed, undefined, testCase.state);
          assert.equal(
            Object.hasOwn(error, "rowFailureCount"),
            false,
            testCase.state,
          );
          assert.equal(
            Object.hasOwn(error, "rowFailuresComplete"),
            false,
            testCase.state,
          );
          return true;
        },
      );
      assert.equal(passCalls, 1, testCase.state);
      assert.equal(yieldCalls, 0, testCase.state);
    }
  },
);

await check(
  "provider attempts persist only through explicit set on success and failure",
  async () => {
    const successHarness = createProcessHarness();
    const success = await successHarness.run();
    const successWrite = successHarness.store.operations.find(
      (operation) => operation.update?.$set?.["email.state"] === "SENT",
    );
    assert.equal(success.outcome, "DIGEST_EMAIL_SENT");
    assert.equal(successHarness.providerCalls.length, 1);
    assert.equal(successWrite.update.$set["email.attempts"], 1);
    assert.equal(successWrite.update.$inc, undefined);
    assert.equal(
      successHarness.store.get(IDS.deliveryA).email.providerMessageId,
      "provider-message-fixed",
    );

    const providerError = new Error("provider rejected digest");
    const failureHarness = createProcessHarness({
      provider: async () => {
        throw providerError;
      },
    });
    await assert.rejects(
      () => failureHarness.run(),
      (error) => error === providerError,
    );
    const failureWrite = failureHarness.store.operations.find(
      (operation) => operation.update?.$set?.["email.state"] === "FAILED",
    );
    assert.equal(failureHarness.providerCalls.length, 1);
    assert.equal(failureWrite.update.$set["email.attempts"], 1);
    assert.equal(failureWrite.update.$inc, undefined);
    assert.equal(failureHarness.store.get(IDS.deliveryA).email.attempts, 1);

    for (const harness of [successHarness, failureHarness]) {
      assert.equal(
        harness.store.operations.some(
          (operation) =>
            operation.update?.$inc?.["email.attempts"] !== undefined,
        ),
        false,
      );
    }
  },
);

process.env.JWT_SECRET ||= "digest-correctness-placeholder";
process.env.MONGODB_URI ||=
  "mongodb://127.0.0.1:27017/digest-correctness-placeholder";
const {
  default: healthApp,
  isHealthReady,
  setBackgroundReadiness,
} = await import("../src/app.js");

await check("health readiness is a strict DB/background conjunction", () => {
  assert.equal(isHealthReady({ dbOk: true, backgroundReady: true }), true);
  assert.equal(isHealthReady({ dbOk: false, backgroundReady: true }), false);
  assert.equal(isHealthReady({ dbOk: true, backgroundReady: false }), false);
  assert.equal(isHealthReady({ dbOk: false, backgroundReady: false }), false);
  assert.equal(isHealthReady({ dbOk: 1, backgroundReady: true }), false);
});

await check(
  "direct app import stays side-effect free and defaults health to initializing",
  async () => {
    const appSource = readFileSync(
      new URL("../src/app.js", import.meta.url),
      "utf8",
    );
    assert.equal(appSource.includes("app.listen("), false);
    assert.match(appSource, /isHealthReady\(\{\s*dbOk,\s*backgroundReady:/);

    const httpServer = healthApp.listen(0, "127.0.0.1");
    await new Promise((resolve, reject) => {
      httpServer.once("listening", resolve);
      httpServer.once("error", reject);
    });

    try {
      const address = httpServer.address();
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const defaultResponse = await fetch(`${baseUrl}/health`);
      const defaultBody = await defaultResponse.json();
      assert.equal(defaultResponse.status, 503);
      assert.equal(defaultBody.status, "degraded");
      assert.equal(defaultBody.db.state, "disconnected");
      assert.equal(defaultBody.background, "initializing");
      assert.deepEqual(Object.keys(defaultBody).sort(), [
        "background",
        "db",
        "status",
        "uptime",
      ]);
      assert.equal(
        Object.prototype.hasOwnProperty.call(defaultBody, "error"),
        false,
      );

      setBackgroundReadiness(true);
      const readyResponse = await fetch(`${baseUrl}/health`);
      const readyBody = await readyResponse.json();
      assert.equal(readyResponse.status, 503);
      assert.equal(readyBody.status, "degraded");
      assert.equal(readyBody.db.state, "disconnected");
      assert.equal(readyBody.background, "ready");

      setBackgroundReadiness(false);
      const initializingResponse = await fetch(`${baseUrl}/health`);
      const initializingBody = await initializingResponse.json();
      assert.equal(initializingResponse.status, 503);
      assert.equal(initializingBody.status, "degraded");
      assert.equal(initializingBody.background, "initializing");
    } finally {
      setBackgroundReadiness(false);
      await new Promise((resolve) => httpServer.close(resolve));
    }
  },
);

console.log(results.join("\n"));
console.log(`\n${passed}/${results.length} checks passed`);
if (passed !== results.length) process.exitCode = 1;
