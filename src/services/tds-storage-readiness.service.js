import mongoose from "mongoose";
import AutomationJob from "../models/AutomationJob.js";
import ImportBatch from "../models/ImportBatch.js";
import Task from "../models/Task.js";
import TdsHealthCheck from "../models/TdsHealthCheck.js";
import TdsHealthEvidenceLink from "../models/TdsHealthEvidenceLink.js";
import TdsHealthRun from "../models/TdsHealthRun.js";
import TdsImportRow from "../models/TdsImportRow.js";

const REQUIRED_IMPORT_INDEXES = Object.freeze([
  {
    Model: ImportBatch,
    label: "shared import fingerprint",
    key: [["firmId", 1], ["kind", 1], ["importFingerprint", 1]],
    unique: true,
    partialFilterExpression: { importFingerprint: { $type: "string" } },
  },
  {
    Model: TdsImportRow,
    label: "TDS import row generation",
    key: [["firmId", 1], ["batchId", 1], ["importGeneration", 1], ["sourceRow", 1]],
    unique: true,
    partialFilterExpression: null,
  },
]);

const REQUIRED_HEALTH_INDEXES = Object.freeze([
  {
    Model: TdsHealthRun,
    label: "TDS root run source revision",
    key: [["firmId", 1], ["sourceFingerprint", 1], ["revision", 1]],
    unique: true,
    partialFilterExpression: { parentRunId: null },
  },
  {
    Model: TdsHealthRun,
    label: "TDS run lineage revision",
    key: [["firmId", 1], ["rootRunId", 1], ["revision", 1]],
    unique: true,
    partialFilterExpression: { rootRunId: { $type: "objectId" } },
  },
  {
    Model: TdsHealthRun,
    label: "TDS run single child",
    key: [["firmId", 1], ["parentRunId", 1]],
    unique: true,
    partialFilterExpression: { parentRunId: { $type: "objectId" } },
  },
  {
    Model: TdsHealthCheck,
    label: "TDS check generation identity",
    key: [["firmId", 1], ["runId", 1], ["generationAttempt", 1], ["itemKey", 1]],
    unique: true,
    partialFilterExpression: null,
  },
  {
    Model: TdsHealthEvidenceLink,
    label: "TDS complete source evidence identity",
    key: [["firmId", 1], ["runId", 1], ["generationAttempt", 1], ["itemKey", 1], ["rowId", 1]],
    unique: true,
    partialFilterExpression: null,
  },
  {
    Model: TdsHealthEvidenceLink,
    label: "TDS source evidence pagination",
    key: [["firmId", 1], ["runId", 1], ["checkId", 1], ["ordinal", 1], ["_id", 1]],
    unique: false,
    partialFilterExpression: null,
  },
  {
    Model: Task,
    label: "generated task identity",
    key: [["firmId", 1], ["generationKey", 1]],
    unique: true,
    partialFilterExpression: { generationKey: { $type: "string" } },
  },
  {
    Model: AutomationJob,
    label: "automation job idempotency",
    key: [["firmId", 1], ["kind", 1], ["idempotencyKey", 1]],
    unique: true,
    partialFilterExpression: null,
  },
]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function matchesIndex(index, spec) {
  const actualKey = Object.entries(index.key || {});
  const keyMatches = actualKey.length === spec.key.length && actualKey.every(
    ([field, direction], indexPosition) => field === spec.key[indexPosition][0] && Number(direction) === spec.key[indexPosition][1]
  );
  return keyMatches &&
    (!spec.unique || index.unique === true) &&
    index.sparse !== true &&
    JSON.stringify(canonical(index.partialFilterExpression || null)) === JSON.stringify(canonical(spec.partialFilterExpression));
}

async function assertIndexes(specs) {
  for (const spec of specs) {
    let indexes;
    try {
      indexes = await spec.Model.collection.listIndexes().toArray();
    } catch (error) {
      const readinessError = new Error(`TDS storage is not ready: ${spec.label} index cannot be verified`);
      readinessError.statusCode = 503;
      readinessError.cause = error;
      throw readinessError;
    }
    if (!indexes.some((index) => matchesIndex(index, spec))) {
      const error = new Error(`TDS storage is not ready: exact ${spec.label} index is missing`);
      error.statusCode = 503;
      throw error;
    }
  }
}

function invalidRequiredType(field, allowedTypes) {
  return {
    $expr: {
      $eq: [{ $in: [{ $type: `$${field}` }, allowedTypes] }, false],
    },
  };
}

function invalidRequiredInteger(
  field,
  minimum = Number.MIN_SAFE_INTEGER,
  maximum = Number.MAX_SAFE_INTEGER
) {
  return {
    $expr: {
      $eq: [
        {
          $cond: [
            { $in: [{ $type: `$${field}` }, ["int", "long", "double", "decimal"]] },
            {
              $and: [
                { $gte: [`$${field}`, minimum] },
                { $lte: [`$${field}`, maximum] },
                { $eq: [{ $mod: [`$${field}`, 1] }, 0] },
              ],
            },
            false,
          ],
        },
        false,
      ],
    },
  };
}

async function assertNoUnsafeLegacyTdsData({ firmId }) {
  if (!mongoose.isValidObjectId(firmId)) {
    const error = new Error("TDS readiness requires a valid firm scope");
    error.statusCode = 400;
    throw error;
  }
  const moneyFields = [
    "amountPaidMinor",
    "deductedMinor",
    "surchargeMinor",
    "cessMinor",
    "depositedMinor",
    "reportedMinor",
    "creditedMinor",
  ];
  const runMoneyFields = [
    "summary.deductedMinor",
    "summary.depositedMinor",
    "summary.reportedMinor",
    "summary.importedCreditMinor",
    "summary.estimatedGapMinor",
  ];
  const [unsafeBatch, unsafeRow, unsafeRun, unsafeCheck, unsafeEvidence, unsafeJob, unsafeTask] = await Promise.all([
    ImportBatch.exists({
      firmId,
      kind: { $in: ["TDS_DEDUCTIONS", "TDS_CHALLANS", "TDS_STATEMENTS", "TDS_26AS"] },
      status: "COMPLETED",
      $or: [
        invalidRequiredType("clientId", ["objectId"]),
        invalidRequiredType("importFingerprint", ["string"]),
        invalidRequiredType("activeImportGeneration", ["string"]),
        invalidRequiredType("tan", ["string"]),
        invalidRequiredType("financialYear", ["string"]),
        invalidRequiredType("quarter", ["string"]),
        invalidRequiredType("statementType", ["string"]),
        invalidRequiredInteger("totalTaxMinor"),
      ],
    }),
    TdsImportRow.exists({
      firmId,
      $or: [
        invalidRequiredType("clientId", ["objectId"]),
        invalidRequiredType("batchId", ["objectId"]),
        invalidRequiredType("importGeneration", ["string"]),
        invalidRequiredInteger("sourceRow", 2),
        invalidRequiredType("sourceHash", ["string"]),
        ...moneyFields.map((field) => invalidRequiredInteger(field)),
      ],
    }),
    TdsHealthRun.exists({
      firmId,
      $or: [
        invalidRequiredType("clientId", ["objectId"]),
        invalidRequiredType("sourceFingerprint", ["string"]),
        invalidRequiredType("generationAttempt", ["string"]),
        {
          $and: [
            { status: { $in: ["REVIEW", "LOCKED"] } },
            invalidRequiredType("activeGenerationAttempt", ["string"]),
          ],
        },
        invalidRequiredInteger("rolloutVersion", 0),
        invalidRequiredInteger("revision", 1),
        ...runMoneyFields.map((field) => invalidRequiredInteger(field)),
      ],
    }),
    TdsHealthCheck.exists({
      firmId,
      $or: [
        invalidRequiredType("runId", ["objectId"]),
        invalidRequiredType("clientId", ["objectId"]),
        invalidRequiredType("itemKey", ["string"]),
        invalidRequiredType("generationAttempt", ["string"]),
        invalidRequiredType("sourceRows", ["array"]),
        invalidRequiredInteger("sourceEvidenceCount", 1),
        invalidRequiredType("sourceEvidenceHash", ["string"]),
        invalidRequiredInteger("expectedMinor"),
        invalidRequiredInteger("actualMinor"),
        invalidRequiredInteger("differenceMinor"),
      ],
    }),
    TdsHealthEvidenceLink.exists({
      firmId,
      $or: [
        invalidRequiredType("runId", ["objectId"]),
        invalidRequiredType("checkId", ["objectId"]),
        invalidRequiredType("clientId", ["objectId"]),
        invalidRequiredType("rowId", ["objectId"]),
        invalidRequiredType("batchId", ["objectId"]),
        invalidRequiredType("generationAttempt", ["string"]),
        invalidRequiredInteger("ordinal", 0),
        invalidRequiredInteger("sourceRow", 2),
      ],
    }),
    AutomationJob.exists({
      firmId,
      kind: "TDS_HEALTH",
      $or: [
        invalidRequiredType("idempotencyKey", ["string"]),
        invalidRequiredType("createdBy", ["objectId"]),
      ],
    }),
    Task.exists({
      firmId,
      serviceType: "TDS",
      source: "RECONCILIATION",
      generationKey: /^tds-action:/,
      $or: [
        invalidRequiredType("clientId", ["objectId"]),
        invalidRequiredType("generationKey", ["string"]),
        invalidRequiredType("automationJobId", ["objectId"]),
      ],
    }),
  ]);
  if (unsafeBatch || unsafeRow || unsafeRun || unsafeCheck || unsafeEvidence || unsafeJob || unsafeTask) {
    const error = new Error("Firm-scoped TDS storage contains malformed records; reviewed remediation is required before writes");
    error.statusCode = 503;
    throw error;
  }
}

async function assertTransactionCapability() {
  try {
    const database = mongoose.connection?.db;
    if (!database) throw new Error("MongoDB connection is unavailable");
    const hello = await database.admin().command({ hello: 1 });
    if (!hello?.setName && hello?.msg !== "isdbgrid") {
      throw new Error("MongoDB deployment does not support multi-document transactions");
    }
  } catch (cause) {
    const error = new Error(`TDS review storage is not ready: ${cause.message}`);
    error.statusCode = 503;
    error.cause = cause;
    throw error;
  }
}

async function assertTdsImportStorageReady({ firmId }) {
  await assertIndexes(REQUIRED_IMPORT_INDEXES);
  await assertNoUnsafeLegacyTdsData({ firmId });
}

async function assertTdsHealthStorageReady({ firmId }) {
  await assertIndexes([...REQUIRED_IMPORT_INDEXES, ...REQUIRED_HEALTH_INDEXES]);
  await assertNoUnsafeLegacyTdsData({ firmId });
}

async function assertTdsReviewStorageReady({ firmId }) {
  await assertTdsHealthStorageReady({ firmId });
  await assertTransactionCapability();
}

export {
  REQUIRED_HEALTH_INDEXES,
  REQUIRED_IMPORT_INDEXES,
  assertNoUnsafeLegacyTdsData,
  assertTdsHealthStorageReady,
  assertTdsImportStorageReady,
  assertTdsReviewStorageReady,
  assertTransactionCapability,
};
