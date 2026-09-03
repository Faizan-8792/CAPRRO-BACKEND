import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import mongoose from "mongoose";
import ActivityEvent from "../models/ActivityEvent.js";
import Client from "../models/Client.js";
import ImportBatch from "../models/ImportBatch.js";
import ImportRow from "../models/ImportRow.js";
import ReconciliationItem, {
  DISPOSITION_ACTIONS,
  RECONCILIATION_ITEM_STATUSES,
} from "../models/ReconciliationItem.js";
import FirmMembership from "../models/FirmMembership.js";
import ReconciliationRun from "../models/ReconciliationRun.js";
import Task from "../models/Task.js";
import User from "../models/User.js";
import { enqueueJob } from "./automation-job.service.js";
import { recordActivity, safeRecordActivity } from "./activity.service.js";
import { assertGstStorageIndexes } from "./gst-storage-readiness.service.js";
import {
  addSafeIntegers,
  calculateCreditLedgerBalance,
  calculateGstr1Outward,
  calculateGstr3bControlTotals,
  dateDifferenceDays,
  formatMoneyMinor,
  isValidGstin,
  isValidPeriod,
  normalizeGstin,
} from "./gst-normalization.service.js";
import {
  amountDifferences,
  buildReconciliationItems,
  summarizeReconciliationItems,
  TAX_HEAD_FIELDS,
} from "./gst-matching.service.js";
import { userFacingMessage } from "../utils/user-facing-error.js";

const GST_RECONCILIATION_JOB_KIND = "GST_RECONCILIATION";
const MATCHING_CONFIG_VERSION = "gst-match-v1";
const DEFAULT_ROUNDING_TOLERANCE_MINOR = 100;
const DEFAULT_DATE_TOLERANCE_DAYS = 3;
const MAX_PAGE_SIZE = 100;
const MAX_BULK_ITEMS = 200;
const REVIEW_MUTATION_LEASE_MS = 10 * 60 * 1000;
const RUN_LOCK_LEASE_MS = 10 * 60 * 1000;
const BULK_ACTIONS = new Set([
  "SUPPLIER_FOLLOW_UP",
  "MARK_INELIGIBLE",
  "DEFER",
  "ACCEPT_EXCEPTION",
]);
const CHASE_STATES = new Set(["MARKED", "OPENED", "COPIED", "REQUESTED"]);

function serviceError(message, statusCode = 400, details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (details) error.details = details;
  return error;
}

function assertObjectId(value, label) {
  if (!mongoose.isValidObjectId(value)) {
    throw serviceError(`${label} must be a valid ID`);
  }
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw serviceError(
      `${label} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return parsed;
}

function safeMinor(value, label) {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed)) {
    throw serviceError(
      `${label} must be a safe integer in the smallest currency unit`,
    );
  }
  return parsed;
}

function normalizeTaxHeads(value = {}, label = "Tax heads") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw serviceError(`${label} must be an object`);
  }
  const unknown = Object.keys(value).filter(
    (field) =>
      ![
        "igstMinor",
        "cgstMinor",
        "sgstMinor",
        "cessMinor",
        "totalTaxMinor",
      ].includes(field),
  );
  if (unknown.length)
    throw serviceError(`${label} has unknown fields: ${unknown.join(", ")}`);
  const heads = {
    igstMinor: safeMinor(value.igstMinor, `${label}.igstMinor`),
    cgstMinor: safeMinor(value.cgstMinor, `${label}.cgstMinor`),
    sgstMinor: safeMinor(value.sgstMinor, `${label}.sgstMinor`),
    cessMinor: safeMinor(value.cessMinor, `${label}.cessMinor`),
  };
  heads.totalTaxMinor = addSafeIntegers([
    heads.igstMinor,
    heads.cgstMinor,
    heads.sgstMinor,
    heads.cessMinor,
  ]);
  if (
    value.totalTaxMinor != null &&
    safeMinor(value.totalTaxMinor, `${label}.totalTaxMinor`) !==
      heads.totalTaxMinor
  ) {
    throw serviceError(`${label}.totalTaxMinor must equal tax-head sum`);
  }
  return heads;
}

function plain(document) {
  return typeof document?.toObject === "function"
    ? document.toObject()
    : document;
}

function reviewFinalizationForRun(
  run,
  { includeRecoveryCommand = false } = {},
) {
  const transition = run.pendingReviewTransition || {};
  const bulk = run.bulkReviewOperation || {};
  let state = "CLEAN";
  let kind = null;
  let operationId = null;
  let action = null;
  let itemId = null;
  let affectedCount = 0;
  let startedAt = null;

  if (transition.operationId) {
    state = "ITEM_PENDING";
    kind = "ITEM";
    operationId = String(transition.operationId);
    action = transition.action || null;
    itemId = transition.itemId ? String(transition.itemId) : null;
    startedAt = transition.startedAt || null;
  } else if (bulk.state === "PENDING" && bulk.operationId) {
    state = "BULK_PENDING";
    kind = "BULK";
    operationId = String(bulk.operationId);
    action = bulk.action || null;
    affectedCount = Number(bulk.affectedCount || 0);
    startedAt = bulk.startedAt || null;
  } else if (run.summaryDirty) {
    state = "SUMMARY_REPAIR_REQUIRED";
  }

  const summaryProvisional = state !== "CLEAN";
  const recoverable = summaryProvisional && run.status === "REVIEW";
  const finalization = {
    state,
    summaryProvisional,
    recoverable,
    operationId,
    kind,
    action,
    itemId,
    affectedCount,
    startedAt,
  };
  if (includeRecoveryCommand && recoverable) {
    finalization.recoveryCommand = {
      method: "POST",
      path: `/api/gst-reconciliation/runs/${run._id}/recover-review`,
      body: operationId ? { operationId } : {},
    };
  }
  return finalization;
}

function serializeRun(document, { includeRecoveryCommand = false } = {}) {
  const run = plain(document);
  if (!run) return null;
  const reviewFinalization = reviewFinalizationForRun(run, {
    includeRecoveryCommand,
  });
  return {
    id: String(run._id),
    clientId: String(run.clientId),
    kind: run.kind,
    gstin: run.gstin,
    period: run.period,
    status: run.status,
    revision: run.revision,
    reviewVersion: Number(run.reviewVersion || 0),
    activeGenerationAttempt: Number(run.activeGenerationAttempt || 0),
    rootRunId: run.rootRunId ? String(run.rootRunId) : null,
    parentRunId: run.parentRunId ? String(run.parentRunId) : null,
    sourceImports: {
      booksBatchId: String(run.sourceImports.booksBatchId),
      portalBatchId: String(run.sourceImports.portalBatchId),
      gstr3bBatchId: run.sourceImports.gstr3bBatchId
        ? String(run.sourceImports.gstr3bBatchId)
        : null,
      gstr1BatchId: run.sourceImports.gstr1BatchId
        ? String(run.sourceImports.gstr1BatchId)
        : null,
      creditLedgerBatchId: run.sourceImports.creditLedgerBatchId
        ? String(run.sourceImports.creditLedgerBatchId)
        : null,
    },
    matchingConfig: run.matchingConfig,
    priorPeriodAdjustment: run.priorPeriodAdjustment,
    summary: reviewFinalization.summaryProvisional ? null : run.summary,
    reviewFinalization,
    jobId: run.jobId ? String(run.jobId) : null,
    assignedTo: run.assignedTo ? String(run.assignedTo) : null,
    reviewer: run.reviewer ? String(run.reviewer) : null,
    reviewedAt: run.reviewedAt || null,
    lockedBy: run.lockedBy ? String(run.lockedBy) : null,
    lockedAt: run.lockedAt || null,
    lastError: run.lastError || "",
    createdBy: String(run.createdBy),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function serializeItem(document) {
  const item = plain(document);
  return {
    id: String(item._id),
    runId: String(item.runId),
    generationAttempt: Number(item.generationAttempt || 1),
    booksRowId: item.booksRowId ? String(item.booksRowId) : null,
    portalRowId: item.portalRowId ? String(item.portalRowId) : null,
    candidatePortalRowIds: (item.candidatePortalRowIds || []).map(String),
    candidateHistoryPortalRowIds: (item.candidateHistoryPortalRowIds || []).map(
      String,
    ),
    booksSourceRow: item.booksSourceRow,
    portalSourceRow: item.portalSourceRow,
    supplierGstin: item.supplierGstin,
    invoiceNumberOriginal: item.invoiceNumberOriginal,
    invoiceNumberNormalized: item.invoiceNumberNormalized,
    documentType: item.documentType,
    documentDate: item.documentDate,
    booksAmounts: item.booksAmounts,
    portalAmounts: item.portalAmounts,
    differences: item.differences,
    dateDifferenceDays: item.dateDifferenceDays,
    status: item.status,
    originalStatus: item.originalStatus,
    matchRule: item.matchRule,
    autoAccepted: item.autoAccepted,
    resolutionState: item.resolutionState || "OPEN",
    decisionVersion: Number(item.decisionVersion || 0),
    pendingTransition: item.pendingTransition?.action
      ? {
          operationId: item.pendingTransition.operationId || null,
          action: item.pendingTransition.action,
          candidatePortalRowId: item.pendingTransition.candidatePortalRowId
            ? String(item.pendingTransition.candidatePortalRowId)
            : null,
          expectedDecisionVersion: Number(
            item.pendingTransition.expectedDecisionVersion || 0,
          ),
          startedAt: item.pendingTransition.startedAt || null,
        }
      : null,
    userDisposition: item.userDisposition,
    chase: item.chase,
    taskId: item.taskId ? String(item.taskId) : null,
    reviewedAt: item.reviewedAt,
    updatedAt: item.updatedAt,
  };
}

function fingerprintForRun({
  clientId,
  gstin,
  period,
  booksBatchId,
  portalBatchId,
  gstr3bBatchId,
  gstr1BatchId,
  creditLedgerBatchId,
  matchingConfig,
  priorPeriodAdjustment,
  assignedTo,
  parentRunId,
}) {
  const source = JSON.stringify({
    fingerprintVersion: "gst-run-v2",
    clientId: String(clientId),
    gstin,
    period,
    booksBatchId: String(booksBatchId),
    portalBatchId: String(portalBatchId),
    gstr3bBatchId: gstr3bBatchId ? String(gstr3bBatchId) : null,
    matchingConfig,
    priorPeriodAdjustment,
    assignedTo: assignedTo ? String(assignedTo) : null,
    parentRunId: parentRunId ? String(parentRunId) : null,

    // Appended, and ONLY when set. The fingerprint is the idempotency key behind a unique
    // {firmId, sourceFingerprint, revision} index: two runs that hash alike are treated as one
    // create being retried. Without these, a run created WITH a GSTR-1 attached would collide with
    // an earlier run over the same books and portal batches and be replayed as that run, silently
    // discarding the source the person had just chosen.
    //
    // Conditional rather than always-present so that every fingerprint written before these
    // sources existed still hashes to exactly the same value. Making them unconditional nulls
    // would change the hash of every run in the field, and a create retried across the deploy
    // would produce a duplicate run instead of replaying the original.
    ...(gstr1BatchId ? { gstr1BatchId: String(gstr1BatchId) } : {}),
    ...(creditLedgerBatchId ? { creditLedgerBatchId: String(creditLedgerBatchId) } : {}),
  });
  return createHash("sha256").update(source).digest("hex");
}

async function requireRun({ firmId, runId }) {
  assertObjectId(runId, "Reconciliation run");
  const run = await ReconciliationRun.findOne({ _id: runId, firmId });
  if (!run) throw serviceError("Reconciliation run not found", 404);
  return run;
}

function generationItemScope(run) {
  const attempt = Number(run?.activeGenerationAttempt || 0);
  return {
    generationAttempt: Number.isInteger(attempt) && attempt > 0 ? attempt : -1,
  };
}

function activeItemScope(run) {
  return {
    ...generationItemScope(run),
    isActive: { $ne: false },
  };
}

function requireGenerationItemScope(run) {
  const scope = generationItemScope(run);
  if (scope.generationAttempt < 1) {
    throw serviceError(
      "Reconciliation item generation is unavailable; recreate the run after the approved GST storage rollout",
      409,
    );
  }
  return scope;
}

function requireActiveItemScope(run) {
  const scope = activeItemScope(run);
  if (scope.generationAttempt < 1) {
    throw serviceError(
      "Reconciliation item generation is unavailable; recreate the run after the approved GST storage rollout",
      409,
    );
  }
  return scope;
}

async function ensureRunJob(run, requestId = "") {
  if (run.status !== "QUEUED") return null;
  const job = await enqueueJob({
    firmId: run.firmId,
    kind: GST_RECONCILIATION_JOB_KIND,
    idempotencyKey: `gst-run:${run._id}:revision:${run.revision}`,
    payload: { runId: String(run._id) },
    createdBy: run.createdBy,
    requestId,
    maxAttempts: 5,
  });
  if (!run.jobId || String(run.jobId) !== String(job._id)) {
    run.jobId = job._id;
    await run.save();
  }
  return job;
}

function validateBatchContext(
  batch,
  { firmId, clientId, gstin, period, kind },
) {
  if (
    !batch ||
    String(batch.firmId) !== String(firmId) ||
    batch.status !== "COMPLETED"
  ) {
    throw serviceError(
      `${kind} import must be a completed batch in active firm`,
      409,
    );
  }
  if (
    batch.kind !== kind ||
    String(batch.clientId) !== String(clientId) ||
    batch.gstin !== gstin ||
    batch.period !== period
  ) {
    throw serviceError(
      `${kind} import does not match selected client, GSTIN, or period`,
      409,
    );
  }
  if (
    !batch.importFingerprint ||
    !batch.activeImportGeneration ||
    batch.normalizationVersion === "legacy"
  ) {
    throw serviceError(
      `${kind} import predates generation-safe GST storage; re-import it after the approved storage rollout`,
      409,
    );
  }
}

export async function createReconciliationRun({
  firmId,
  actorUserId,
  requestId = "",
  clientId,
  gstin,
  period,
  booksBatchId,
  portalBatchId,
  gstr3bBatchId = null,
  gstr1BatchId = null,
  creditLedgerBatchId = null,
  revisionOf = null,
  roundingToleranceMinor = DEFAULT_ROUNDING_TOLERANCE_MINOR,
  dateToleranceDays = DEFAULT_DATE_TOLERANCE_DAYS,
  priorPeriodAdjustment = {},
  assignedTo = undefined,
}) {
  assertObjectId(firmId, "Firm");
  assertObjectId(actorUserId, "User");
  assertObjectId(clientId, "Client");
  assertObjectId(booksBatchId, "Purchase Register batch");
  assertObjectId(portalBatchId, "GSTR-2B batch");
  if (gstr3bBatchId) assertObjectId(gstr3bBatchId, "GSTR-3B batch");
  if (gstr1BatchId) assertObjectId(gstr1BatchId, "GSTR-1 batch");
  if (creditLedgerBatchId) assertObjectId(creditLedgerBatchId, "Credit ledger batch");
  if (revisionOf) assertObjectId(revisionOf, "Parent run");
  if (assignedTo) assertObjectId(assignedTo, "Assignee");

  const normalizedGstin = normalizeGstin(gstin);
  if (!isValidGstin(normalizedGstin))
    throw serviceError("A valid GSTIN is required");
  if (!isValidPeriod(period)) throw serviceError("Period must use YYYY-MM");
  const matchingConfig = {
    version: MATCHING_CONFIG_VERSION,
    roundingToleranceMinor: boundedInteger(
      roundingToleranceMinor,
      DEFAULT_ROUNDING_TOLERANCE_MINOR,
      0,
      10000,
      "Rounding tolerance",
    ),
    dateToleranceDays: boundedInteger(
      dateToleranceDays,
      DEFAULT_DATE_TOLERANCE_DAYS,
      0,
      31,
      "Date tolerance",
    ),
  };
  const adjustment = normalizeTaxHeads(
    priorPeriodAdjustment,
    "Prior-period adjustment",
  );
  await assertGstStorageIndexes({ reconciliation: true });

  const clientExists = await Client.exists({ _id: clientId, firmId });
  if (!clientExists) throw serviceError("Client not found in active firm", 404);

  const requestedBatchIds = [
    booksBatchId,
    portalBatchId,
    gstr3bBatchId,
    gstr1BatchId,
    creditLedgerBatchId,
  ].filter(Boolean);
  const batches = await ImportBatch.find({
    _id: { $in: requestedBatchIds },
    firmId,
  }).lean();
  const byId = new Map(batches.map((batch) => [String(batch._id), batch]));
  validateBatchContext(byId.get(String(booksBatchId)), {
    firmId,
    clientId,
    gstin: normalizedGstin,
    period,
    kind: "GST_PURCHASE",
  });
  validateBatchContext(byId.get(String(portalBatchId)), {
    firmId,
    clientId,
    gstin: normalizedGstin,
    period,
    kind: "GSTR2B",
  });
  if (gstr3bBatchId) {
    validateBatchContext(byId.get(String(gstr3bBatchId)), {
      firmId,
      clientId,
      gstin: normalizedGstin,
      period,
      kind: "GSTR3B_SUMMARY",
    });
  }
  // Same firm, same client, same GSTIN, same period as every other source. A turnover
  // reconciliation against another period would compare two unrelated returns and call the
  // difference an exception.
  if (gstr1BatchId) {
    validateBatchContext(byId.get(String(gstr1BatchId)), {
      firmId,
      clientId,
      gstin: normalizedGstin,
      period,
      kind: "GSTR1_SUMMARY",
    });
  }
  if (creditLedgerBatchId) {
    validateBatchContext(byId.get(String(creditLedgerBatchId)), {
      firmId,
      clientId,
      gstin: normalizedGstin,
      period,
      kind: "ECREDIT_LEDGER",
    });
  }

  let revision = 1;
  let rootRunId = null;
  let parentRunId = null;
  let parent = null;
  let effectiveAssignedTo = assignedTo;
  if (revisionOf) {
    parent = await requireRun({ firmId, runId: revisionOf });
    if (parent.status !== "LOCKED") {
      throw serviceError("Only a locked run can be revised", 409);
    }
    if (
      String(parent.clientId) !== String(clientId) ||
      parent.gstin !== normalizedGstin ||
      parent.period !== period
    ) {
      throw serviceError("Revision context must match locked parent run", 409);
    }
    revision = parent.revision + 1;
    rootRunId = parent.rootRunId || parent._id;
    parentRunId = parent._id;
  }
  if (effectiveAssignedTo === undefined) {
    effectiveAssignedTo = parent?.assignedTo || null;
  }
  if (effectiveAssignedTo) {
    assertObjectId(effectiveAssignedTo, "Assignee");
    const assigneeExists = await User.exists({
      _id: effectiveAssignedTo,
      firmId,
      isActive: { $ne: false },
    });
    if (!assigneeExists)
      throw serviceError("Assignee not found in active firm", 404);
  }

  const sourceFingerprint = fingerprintForRun({
    clientId,
    gstin: normalizedGstin,
    period,
    booksBatchId,
    portalBatchId,
    gstr3bBatchId,
    gstr1BatchId,
    creditLedgerBatchId,
    matchingConfig,
    priorPeriodAdjustment: adjustment,
    assignedTo: effectiveAssignedTo,
    parentRunId,
  });
  const identity = { firmId, sourceFingerprint, revision };
  let run = null;
  let replayed = false;

  if (parent) {
    run = await ReconciliationRun.findOne({ firmId, parentRunId: parent._id });
    if (run) {
      if (run.sourceFingerprint !== sourceFingerprint) {
        throw serviceError(
          "Locked parent already has a different revision",
          409,
        );
      }
      replayed = true;
    } else {
      const latest = await ReconciliationRun.findOne({
        firmId,
        $or: [{ rootRunId }, { _id: rootRunId }],
      }).sort({ revision: -1, createdAt: -1 });
      if (!latest || String(latest._id) !== String(parent._id)) {
        throw serviceError(
          "Only the latest locked revision can be revised",
          409,
        );
      }
    }
  } else {
    run = await ReconciliationRun.findOne(identity);
    replayed = Boolean(run);
  }

  if (!run) {
    const runId = new mongoose.Types.ObjectId();
    const effectiveRootRunId = rootRunId || runId;
    try {
      run = await ReconciliationRun.create({
        _id: runId,
        ...identity,
        clientId,
        kind: "GST_ITC",
        gstin: normalizedGstin,
        period,
        sourceImports: {
          booksBatchId,
          portalBatchId,
          gstr3bBatchId: gstr3bBatchId || null,
          gstr1BatchId: gstr1BatchId || null,
          creditLedgerBatchId: creditLedgerBatchId || null,
        },
        rootRunId: effectiveRootRunId,
        parentRunId,
        status: "QUEUED",
        matchingConfig,
        priorPeriodAdjustment: adjustment,
        assignedTo: effectiveAssignedTo,
        createdBy: actorUserId,
      });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      run = parent
        ? await ReconciliationRun.findOne({ firmId, parentRunId: parent._id })
        : await ReconciliationRun.findOne(identity);
      if (!run) throw error;
      if (run.sourceFingerprint !== sourceFingerprint) {
        throw serviceError(
          "Concurrent revision used different immutable inputs",
          409,
        );
      }
      replayed = true;
    }
  }

  const job = await ensureRunJob(run, requestId);
  if (!replayed) {
    await safeRecordActivity({
      firmId,
      actorUserId,
      source: "USER",
      action: revisionOf
        ? "GST_RECONCILIATION_REVISION_CREATED"
        : "GST_RECONCILIATION_CREATED",
      entityType: "ReconciliationRun",
      entityId: run._id,
      requestId,
      afterSummary: {
        clientId,
        gstin: normalizedGstin,
        period,
        revision,
        sourceImports: run.sourceImports,
      },
    });
  }

  return {
    run: serializeRun(run),
    jobId: String(job?._id || run.jobId || "") || null,
    replayed,
  };
}

export async function processGstReconciliationJob(
  job,
  { assertLease = async () => {} } = {},
) {
  if (job.kind !== GST_RECONCILIATION_JOB_KIND) {
    throw new Error(`Unsupported GST job kind: ${job.kind}`);
  }
  await assertGstStorageIndexes({ reconciliation: true });
  const runId = job.payload?.runId;
  assertObjectId(runId, "Reconciliation run");
  const attempt = Math.max(1, Number(job.attemptCount || 1));
  await assertLease();

  let run = await ReconciliationRun.findOne({ _id: runId, firmId: job.firmId });
  if (!run) throw serviceError("Reconciliation run no longer exists", 404);
  if (["REVIEW", "LOCKED"].includes(run.status)) {
    return {
      outcome: "ALREADY_PROCESSED",
      runId: String(run._id),
      summary: run.summary,
    };
  }

  run = await ReconciliationRun.findOneAndUpdate(
    {
      _id: runId,
      firmId: job.firmId,
      $or: [
        { status: { $in: ["QUEUED", "FAILED"] } },
        {
          status: "PROCESSING",
          $or: [
            { processingJobId: null },
            { processingJobId: job._id, processingAttempt: { $lt: attempt } },
          ],
        },
      ],
    },
    {
      $set: {
        status: "PROCESSING",
        processingJobId: job._id,
        processingAttempt: attempt,
        lastError: "",
      },
    },
    { new: true },
  );
  if (!run)
    throw serviceError(
      "Reconciliation run is owned by another worker attempt",
      409,
    );

  const ownership = {
    _id: run._id,
    firmId: run.firmId,
    status: "PROCESSING",
    processingJobId: job._id,
    processingAttempt: attempt,
  };

  try {
    await assertLease();
    const [booksBatch, portalBatch] = await Promise.all([
      ImportBatch.findOne({
        _id: run.sourceImports.booksBatchId,
        firmId: run.firmId,
        status: "COMPLETED",
        kind: "GST_PURCHASE",
      }).lean(),
      ImportBatch.findOne({
        _id: run.sourceImports.portalBatchId,
        firmId: run.firmId,
        status: "COMPLETED",
        kind: "GSTR2B",
      }).lean(),
    ]);
    if (!booksBatch || !portalBatch) {
      throw serviceError(
        "Required completed source imports are unavailable",
        409,
      );
    }
    validateBatchContext(booksBatch, {
      firmId: run.firmId,
      clientId: run.clientId,
      gstin: run.gstin,
      period: run.period,
      kind: "GST_PURCHASE",
    });
    validateBatchContext(portalBatch, {
      firmId: run.firmId,
      clientId: run.clientId,
      gstin: run.gstin,
      period: run.period,
      kind: "GSTR2B",
    });

    const [booksRows, portalRows] = await Promise.all([
      ImportRow.find({
        firmId: run.firmId,
        batchId: booksBatch._id,
        importGeneration: booksBatch.activeImportGeneration,
      })
        .sort({ sourceRow: 1 })
        .lean(),
      ImportRow.find({
        firmId: run.firmId,
        batchId: portalBatch._id,
        importGeneration: portalBatch.activeImportGeneration,
      })
        .sort({ sourceRow: 1 })
        .lean(),
    ]);
    await assertLease();
    const generated = buildReconciliationItems({
      booksRows,
      portalRows,
      roundingToleranceMinor: run.matchingConfig.roundingToleranceMinor,
      dateToleranceDays: run.matchingConfig.dateToleranceDays,
    });
    if (
      generated.some(
        (item) => item.status === "AMBIGUOUS_MATCH" && item.autoAccepted,
      )
    ) {
      throw new Error(
        "Matcher safety invariant failed: ambiguous item auto-accepted",
      );
    }

    const operations = generated.map((item) => ({
      updateOne: {
        filter: {
          firmId: run.firmId,
          runId: run._id,
          generationAttempt: attempt,
          itemKey: item.itemKey,
        },
        update: {
          $set: {
            firmId: run.firmId,
            runId: run._id,
            clientId: run.clientId,
            generationAttempt: attempt,
            ...item,
            isActive: true,
            retiredPortalRowId: null,
            lastLifecycleOperationId: null,
            decisionVersion: 0,
            lastReviewOperationId: null,
            reviewMutationToken: null,
            reviewMutationFence: 0,
            reviewMutationExpiresAt: null,
            pendingTransition: {},
            candidateHistoryPortalRowIds:
              item.candidatePortalRowIds?.length > 0
                ? item.candidatePortalRowIds
                : item.candidateHistoryPortalRowIds || [],
          },
        },
        upsert: true,
      },
    }));
    if (operations.length) {
      await ReconciliationItem.bulkWrite(operations, { ordered: false });
    }
    await ReconciliationItem.deleteMany({
      firmId: run.firmId,
      runId: run._id,
      generationAttempt: attempt,
      itemKey: { $nin: generated.map((item) => item.itemKey) },
    });

    await assertLease();
    const summary = summarizeReconciliationItems(generated);
    run = await ReconciliationRun.findOneAndUpdate(
      ownership,
      {
        $set: {
          status: "REVIEW",
          activeGenerationAttempt: attempt,
          summary,
          summaryDirty: false,
          pendingReviewTransition: {},
          bulkReviewOperation: {},
          lastCompletedReviewOperationId: null,
          reviewMutationActive: false,
          reviewMutationToken: null,
          reviewMutationExpiresAt: null,
          lastError: "",
          processingJobId: null,
        },
      },
      { new: true, runValidators: true },
    );
    if (!run)
      throw new Error(
        "Worker attempt lost reconciliation ownership before completion",
      );

    await safeRecordActivity({
      firmId: run.firmId,
      actorUserId: null,
      source: "AUTOMATION",
      action: "GST_RECONCILIATION_COMPLETED",
      entityType: "ReconciliationRun",
      entityId: run._id,
      requestId: job.requestId,
      afterSummary: { revision: run.revision, summary },
      metadata: { jobId: String(job._id), attempt },
    });
    return { outcome: "RECONCILED", runId: String(run._id), summary };
  } catch (error) {
    await ReconciliationRun.updateOne(ownership, {
      $set: {
        status: "FAILED",
        processingJobId: null,
        // V13-P12-F2. This field is read back verbatim into the run view (see the serialiser
        // above, `lastError: run.lastError || ""`), so it is shown to the firm without ever
        // passing through publicErrorMessage. Only authored copy may be stored here.
        lastError: userFacingMessage(
          error,
          "Reconciliation could not be completed. Try again, or contact support if it continues.",
        ).slice(0, 600),
      },
    });
    throw error;
  }
}

export async function listReconciliationRuns({
  firmId,
  clientId = null,
  period = null,
  status = null,
  page = 1,
  limit = 25,
}) {
  const filter = { firmId, kind: "GST_ITC" };
  if (clientId) {
    assertObjectId(clientId, "Client");
    filter.clientId = clientId;
  }
  if (period) {
    if (!isValidPeriod(period)) throw serviceError("Period must use YYYY-MM");
    filter.period = period;
  }
  if (status) {
    const normalized = String(status).toUpperCase();
    if (
      !ReconciliationRun.schema.path("status").enumValues.includes(normalized)
    ) {
      throw serviceError("Unknown run status");
    }
    filter.status = normalized;
  }
  const safePage = boundedInteger(page, 1, 1, 100000, "Page");
  const safeLimit = boundedInteger(limit, 25, 1, 50, "Limit");
  const [runs, total] = await Promise.all([
    ReconciliationRun.find(filter)
      .sort({ updatedAt: -1, _id: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .lean(),
    ReconciliationRun.countDocuments(filter),
  ]);
  return {
    runs: runs.map(serializeRun),
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      pages: Math.ceil(total / safeLimit),
    },
  };
}

export async function getReconciliationRun({ firmId, runId }) {
  return serializeRun(await requireRun({ firmId, runId }), {
    includeRecoveryCommand: true,
  });
}

function escapedRegex(value) {
  return String(value || "")
    .slice(0, 80)
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function listReconciliationItems({
  firmId,
  runId,
  status = null,
  supplierGstin = null,
  search = null,
  page = 1,
  limit = 50,
}) {
  const run = await requireRun({ firmId, runId });
  const filter = { firmId, runId, ...activeItemScope(run) };
  if (status) {
    const normalized = String(status).toUpperCase();
    if (!RECONCILIATION_ITEM_STATUSES.includes(normalized)) {
      throw serviceError("Unknown item status");
    }
    filter.status = normalized;
  }
  if (supplierGstin) filter.supplierGstin = normalizeGstin(supplierGstin);
  if (search) {
    const pattern = escapedRegex(search);
    filter.$or = [
      { invoiceNumberOriginal: { $regex: pattern, $options: "i" } },
      { invoiceNumberNormalized: { $regex: pattern, $options: "i" } },
      { supplierGstin: { $regex: pattern, $options: "i" } },
    ];
  }
  const safePage = boundedInteger(page, 1, 1, 100000, "Page");
  const safeLimit = boundedInteger(limit, 50, 1, MAX_PAGE_SIZE, "Limit");
  const [items, total] = await Promise.all([
    ReconciliationItem.find(filter)
      .sort({
        status: 1,
        supplierGstin: 1,
        booksSourceRow: 1,
        portalSourceRow: 1,
        _id: 1,
      })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .lean(),
    ReconciliationItem.countDocuments(filter),
  ]);
  return {
    items: items.map(serializeItem),
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      pages: Math.ceil(total / safeLimit),
    },
  };
}

function cleanDispositionPayload(payload = {}) {
  const output = {
    reason: String(payload.reason || "")
      .trim()
      .slice(0, 500),
    note: String(payload.note || "")
      .trim()
      .slice(0, 1000),
    chaseState: String(payload.chaseState || "MARKED").toUpperCase(),
  };
  if (payload.ownerUserId) {
    assertObjectId(payload.ownerUserId, "Owner");
    output.ownerUserId = payload.ownerUserId;
  }
  if (payload.taskId) {
    assertObjectId(payload.taskId, "Task");
    output.taskId = payload.taskId;
  }
  if (payload.candidatePortalRowId) {
    assertObjectId(payload.candidatePortalRowId, "Candidate portal row");
    output.candidatePortalRowId = payload.candidatePortalRowId;
  }
  return output;
}

function reviewOperationId(material) {
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

function itemDispositionOperationId({
  runId,
  itemId,
  expectedVersion,
  action,
  payload,
}) {
  return reviewOperationId({
    type: "GST_ITEM_DISPOSITION",
    runId: String(runId),
    itemId: String(itemId),
    expectedVersion,
    action,
    payload,
  });
}

function bulkDispositionOperationId({
  runId,
  itemIds,
  action,
  payload,
  previewToken,
}) {
  return reviewOperationId({
    type: "GST_BULK_DISPOSITION",
    runId: String(runId),
    itemIds: [...itemIds].map(String).sort(),
    action,
    payload,
    previewToken: String(previewToken || "").toLowerCase(),
  });
}

function bulkDispositionSet({ item, action, payload, actorUserId, startedAt }) {
  assertObjectId(actorUserId, "Bulk review command actor");
  const commandTime = new Date(startedAt);
  if (Number.isNaN(commandTime.getTime())) {
    throw serviceError("Bulk review command time is invalid", 409);
  }
  const set = dispositionSet({
    item,
    action,
    payload,
    actorUserId,
    now: commandTime,
  });
  if (action === "SUPPLIER_FOLLOW_UP") {
    delete set.reviewedAt;
  }
  return set;
}

function dispositionSet({ item, action, payload, actorUserId, now }) {
  if (!DISPOSITION_ACTIONS.includes(action))
    throw serviceError("Unknown disposition action");
  const set = {
    "userDisposition.action": action,
    "userDisposition.reason": payload.reason,
    "userDisposition.note": payload.note,
    "userDisposition.updatedBy": actorUserId,
    "userDisposition.updatedAt": now,
  };
  if (payload.ownerUserId)
    set["userDisposition.ownerUserId"] = payload.ownerUserId;
  if (payload.taskId) set.taskId = payload.taskId;

  if (action === "UNMATCH") {
    set.status = "NEEDS_REVIEW";
    set.matchRule = "USER";
    set.autoAccepted = false;
    set.resolutionState = "OPEN";
    set.reviewedAt = null;
  } else if (action === "SUPPLIER_FOLLOW_UP") {
    if (!CHASE_STATES.has(payload.chaseState))
      throw serviceError("Unknown chase state");
    set["chase.required"] = true;
    set["chase.state"] = payload.chaseState;
    set["chase.lastActionAt"] = now;
    set.reviewedAt = item.reviewedAt || null;
  } else if (["BOOKS_CORRECTION", "PORTAL_CORRECTION"].includes(action)) {
    if (!payload.reason)
      throw serviceError("Reason is required for correction follow-up");
    set.status = "NEEDS_REVIEW";
    set.resolutionState = "OPEN";
    set.reviewedAt = null;
  } else if (action === "ACCEPT_EXCEPTION") {
    if (!payload.reason)
      throw serviceError("Reason is required for accepted exceptions");
    set.status = "USER_ACCEPTED_EXCEPTION";
    set.resolutionState = "RESOLVED";
    set.reviewedAt = now;
  } else if (action === "MARK_INELIGIBLE") {
    if (!payload.reason)
      throw serviceError("Reason is required for ineligible or blocked ITC");
    set.status = "INELIGIBLE_OR_BLOCKED";
    set.resolutionState = "RESOLVED";
    set.reviewedAt = now;
  } else if (action === "DEFER") {
    if (!payload.reason)
      throw serviceError("Reason is required to defer an item");
    set.status = "DEFERRED_TO_NEXT_PERIOD";
    set.resolutionState = "RESOLVED";
    set.reviewedAt = now;
  } else if (action === "ADD_NOTE") {
    if (!payload.note) throw serviceError("Note is required");
    set.reviewedAt = item.reviewedAt || null;
  } else if (action === "ASSIGN") {
    if (!payload.ownerUserId) throw serviceError("Owner is required");
    set.reviewedAt = item.reviewedAt || null;
  }
  return set;
}

async function validateDispositionReferences({ firmId, ownerUserId, taskId }) {
  const checks = [];
  if (ownerUserId) {
    // Firm authority comes from FirmMembership, not from User.firmId.
    //
    // This was User.exists({ _id, firmId, isActive }) alone, which was wrong in
    // both directions:
    //
    // 1. It accepted a REMOVED member. FirmMembership is the source of truth for
    //    who belongs to a firm; User.firmId only records which workspace a user is
    //    currently switched into. A User row still carrying firmId after their
    //    membership went to REMOVED was therefore accepted as the owner of a
    //    statutory input-tax-credit line. Only a client-side filter stood in the
    //    way, and client filtering is not authorization.
    // 2. It rejected a legitimate member. A user may hold ACTIVE memberships in
    //    several firms while User.firmId points at just one, so an active colleague
    //    who happened to be working in another workspace was refused. Since
    //    GET /api/firms/:firmId/members lists ACTIVE memberships, a client picker
    //    offers exactly those users and the assignment then failed with a 404.
    //
    // Requiring an ACTIVE membership fixes (1) and is strictly stronger than the
    // firmId condition it replaces, so dropping firmId from the User query fixes
    // (2) without widening authority: firm scoping is now enforced by the
    // membership, and isActive still excludes a deactivated account.
    //
    // The 404 wording is deliberately unchanged. It is accurate for both causes --
    // a removed member genuinely is not in the active firm -- and the desktop
    // surfaces this string verbatim to the reviewer as of ledger task T17a.
    checks.push(
      Promise.all([
        User.exists({ _id: ownerUserId, isActive: { $ne: false } }),
        FirmMembership.exists({
          userId: ownerUserId,
          firmId,
          status: "ACTIVE",
        }),
      ]).then(([user, activeMembership]) => {
        if (!user || !activeMembership) {
          throw serviceError("Owner not found in active firm", 404);
        }
      }),
    );
  }
  if (taskId) {
    checks.push(
      Task.exists({ _id: taskId, firmId }).then((found) => {
        if (!found) throw serviceError("Task not found in active firm", 404);
      }),
    );
  }
  await Promise.all(checks);
}

async function beginReviewMutation({ firmId, runId }) {
  assertObjectId(runId, "Reconciliation run");
  await assertGstStorageIndexes({ reconciliation: true });
  const token = randomUUID();
  const run = await ReconciliationRun.findOneAndUpdate(
    {
      _id: runId,
      firmId,
      status: "REVIEW",
      activeGenerationAttempt: { $gte: 1 },
      $expr: {
        $or: [
          { $ne: ["$reviewMutationActive", true] },
          {
            $lte: [
              { $ifNull: ["$reviewMutationExpiresAt", new Date(0)] },
              "$$NOW",
            ],
          },
        ],
      },
    },
    [
      {
        $set: {
          reviewMutationActive: true,
          reviewMutationToken: token,
          reviewMutationExpiresAt: {
            $add: ["$$NOW", REVIEW_MUTATION_LEASE_MS],
          },
          reviewMutationFence: {
            $add: [{ $ifNull: ["$reviewMutationFence", 0] }, 1],
          },
        },
      },
    ],
    { new: true },
  );
  if (run) {
    return {
      run,
      token,
      fence: Number(run.reviewMutationFence),
      expiresAt: new Date(run.reviewMutationExpiresAt),
    };
  }
  const current = await requireRun({ firmId, runId });
  if (current.status === "LOCKED" || current.status === "LOCKING") {
    throw serviceError("Locked run cannot be changed; create a revision", 423);
  }
  if (current.status !== "REVIEW") {
    throw serviceError("Run is not ready for review", 409);
  }
  requireActiveItemScope(current);
  throw serviceError(
    "Another review mutation is in progress; retry after reload",
    409,
  );
}

function mutationFence(run, fence = undefined) {
  const value = Number(fence ?? run.reviewMutationFence);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw serviceError("Review mutation fence is unavailable", 409);
  }
  return value;
}

async function renewReviewMutation({
  firmId,
  run,
  token,
  fence,
  itemIds = [],
}) {
  const expectedFence = mutationFence(run, fence);
  const renewed = await ReconciliationRun.findOneAndUpdate(
    {
      _id: run._id,
      firmId,
      status: "REVIEW",
      reviewMutationActive: true,
      reviewMutationToken: token,
      reviewMutationFence: expectedFence,
      $expr: { $gt: ["$reviewMutationExpiresAt", "$$NOW"] },
    },
    [
      {
        $set: {
          reviewMutationExpiresAt: {
            $add: ["$$NOW", REVIEW_MUTATION_LEASE_MS],
          },
        },
      },
    ],
    { new: true },
  );
  if (!renewed)
    throw serviceError(
      "Review mutation ownership expired; reload and retry",
      409,
    );

  const expiresAt = new Date(renewed.reviewMutationExpiresAt);
  const uniqueItemIds = [...new Set(itemIds.map(String))];
  if (uniqueItemIds.length) {
    const extended = await ReconciliationItem.updateMany(
      {
        _id: { $in: uniqueItemIds },
        firmId,
        runId: run._id,
        ...requireActiveItemScope(run),
        reviewMutationToken: token,
        reviewMutationFence: expectedFence,
        $expr: { $gt: ["$reviewMutationExpiresAt", "$$NOW"] },
      },
      { $set: { reviewMutationExpiresAt: expiresAt } },
    );
    if (Number(extended.matchedCount || 0) !== uniqueItemIds.length) {
      throw serviceError("Review item mutation ownership was lost", 409);
    }
  }
  return expiresAt;
}

async function claimReviewItems({
  firmId,
  run,
  token,
  fence,
  expiresAt,
  items,
}) {
  const expectedFence = mutationFence(run, fence);
  const claims = items.map((item) => ({
    _id: item._id,
    decisionVersion:
      Number(item.decisionVersion || 0) === 0
        ? { $in: [0, null] }
        : Number(item.decisionVersion),
  }));
  const result = await ReconciliationItem.updateMany(
    {
      firmId,
      runId: run._id,
      ...requireActiveItemScope(run),
      $and: [
        { $or: claims },
        {
          $or: [
            {
              $and: [
                { reviewMutationToken: token },
                { reviewMutationFence: expectedFence },
                { $expr: { $gt: ["$reviewMutationExpiresAt", "$$NOW"] } },
              ],
            },
            { reviewMutationToken: null },
            {
              $expr: {
                $lte: [
                  { $ifNull: ["$reviewMutationExpiresAt", new Date(0)] },
                  "$$NOW",
                ],
              },
            },
          ],
        },
      ],
      $expr: { $gt: [expiresAt, "$$NOW"] },
    },
    {
      $set: {
        reviewMutationToken: token,
        reviewMutationFence: expectedFence,
        reviewMutationExpiresAt: expiresAt,
      },
    },
  );
  if (Number(result.matchedCount || 0) !== claims.length) {
    await ReconciliationItem.updateMany(
      {
        firmId,
        runId: run._id,
        ...requireActiveItemScope(run),
        reviewMutationToken: token,
        reviewMutationFence: expectedFence,
      },
      { $set: { reviewMutationToken: null, reviewMutationExpiresAt: null } },
    ).catch(() => {});
    throw serviceError(
      "One or more review items changed or are busy; reload and retry",
      409,
    );
  }
}

async function releaseReviewItems({ firmId, run, token, fence, itemIds }) {
  const uniqueItemIds = [...new Set(itemIds.map(String))];
  if (!uniqueItemIds.length) return;
  await ReconciliationItem.updateMany(
    {
      _id: { $in: uniqueItemIds },
      firmId,
      runId: run._id,
      ...requireActiveItemScope(run),
      reviewMutationToken: token,
      reviewMutationFence: mutationFence(run, fence),
    },
    { $set: { reviewMutationToken: null, reviewMutationExpiresAt: null } },
  );
}

async function endReviewMutation({ firmId, runId, token, fence }) {
  const result = await ReconciliationRun.updateOne(
    {
      _id: runId,
      firmId,
      status: "REVIEW",
      reviewMutationToken: token,
      reviewMutationFence: Number(fence),
    },
    {
      $set: {
        reviewMutationActive: false,
        reviewMutationToken: null,
        reviewMutationExpiresAt: null,
      },
    },
  );
  if (result.matchedCount !== 1) {
    throw serviceError("Review mutation ownership was lost", 409);
  }
}

async function markSummaryDirty({
  firmId,
  run,
  token,
  fence,
  pendingReviewTransition,
  bulkReviewOperation,
}) {
  const set = { summaryDirty: true };
  if (pendingReviewTransition)
    set.pendingReviewTransition = pendingReviewTransition;
  if (bulkReviewOperation) set.bulkReviewOperation = bulkReviewOperation;
  const updated = await ReconciliationRun.findOneAndUpdate(
    {
      _id: run._id,
      firmId,
      status: "REVIEW",
      reviewMutationActive: true,
      reviewMutationToken: token,
      reviewMutationFence: mutationFence(run, fence),
      $expr: { $gt: ["$reviewMutationExpiresAt", "$$NOW"] },
    },
    { $set: set },
    { new: true, runValidators: true },
  );
  if (!updated)
    throw serviceError("Review mutation ownership expired before write", 409);
  return updated;
}

async function recomputeRunSummary({
  firmId,
  run,
  token,
  fence,
  clearDirty = false,
  transitionOperationId = null,
  bulkOperationId = null,
}) {
  const items = await ReconciliationItem.find({
    firmId,
    runId: run._id,
    ...requireActiveItemScope(run),
  }).lean();
  const summary = summarizeReconciliationItems(items);
  const expectedFence = mutationFence(run, fence);
  const filter = {
    _id: run._id,
    firmId,
    status: "REVIEW",
    reviewMutationActive: true,
    reviewMutationToken: token,
    reviewMutationFence: expectedFence,
    $expr: { $gt: ["$reviewMutationExpiresAt", "$$NOW"] },
  };
  const update = { $set: { summary } };

  if (clearDirty) {
    filter.summaryDirty = true;
    filter.reviewVersion = { $lt: Number.MAX_SAFE_INTEGER };
    update.$inc = { reviewVersion: 1 };
    const pendingItem = await ReconciliationItem.exists({
      firmId,
      runId: run._id,
      ...requireActiveItemScope(run),
      "pendingTransition.action": { $ne: null },
    });
    if (pendingItem) {
      throw serviceError(
        "A reconciliation transition is still incomplete",
        409,
      );
    }
    update.$set.summaryDirty = false;
    if (transitionOperationId) {
      filter["pendingReviewTransition.operationId"] = transitionOperationId;
      update.$unset = { pendingReviewTransition: "" };
      update.$set.lastCompletedReviewOperationId = transitionOperationId;
    } else if (bulkOperationId) {
      filter["bulkReviewOperation.operationId"] = bulkOperationId;
      filter["bulkReviewOperation.state"] = "PENDING";
      update.$set["bulkReviewOperation.state"] = "COMPLETED";
      update.$set["bulkReviewOperation.completedAt"] = new Date();
      update.$set.lastCompletedReviewOperationId = bulkOperationId;
    } else {
      filter["pendingReviewTransition.operationId"] = null;
      filter["bulkReviewOperation.state"] = { $ne: "PENDING" };
    }
  }

  const result = await ReconciliationRun.updateOne(filter, update, {
    runValidators: true,
  });
  if (result.matchedCount !== 1) {
    throw serviceError("Run changed while review summary was updating", 409);
  }
  return summary;
}

function portalOnlyItemForCandidate({
  run,
  portal,
  status,
  operationId = null,
  fence = 0,
}) {
  const portalAmounts = {
    taxableValueMinor: Number(portal.taxableValueMinor || 0),
    igstMinor: Number(portal.igstMinor || 0),
    cgstMinor: Number(portal.cgstMinor || 0),
    sgstMinor: Number(portal.sgstMinor || 0),
    cessMinor: Number(portal.cessMinor || 0),
    totalTaxMinor: Number(portal.totalTaxMinor || 0),
  };
  return {
    firmId: run.firmId,
    runId: run._id,
    clientId: run.clientId,
    generationAttempt: requireActiveItemScope(run).generationAttempt,
    itemKey: `P:${portal._id}`,
    isActive: true,
    retiredPortalRowId: null,
    lastLifecycleOperationId: operationId,
    booksRowId: null,
    portalRowId: portal._id,
    candidatePortalRowIds: [],
    candidateHistoryPortalRowIds: [],
    booksSourceRow: null,
    portalSourceRow: portal.sourceRow,
    supplierGstin: portal.supplierGstin || "",
    invoiceNumberOriginal: portal.invoiceNumberOriginal || "",
    invoiceNumberNormalized: portal.invoiceNumberNormalized || "",
    documentType: portal.documentType || "",
    documentDate: portal.documentDate || null,
    booksAmounts: {},
    portalAmounts,
    differences: amountDifferences({}, portal),
    dateDifferenceDays: null,
    status,
    originalStatus: status,
    matchRule: "NONE",
    autoAccepted: false,
    resolutionState: "OPEN",
    decisionVersion: 0,
    lastReviewOperationId: null,
    reviewMutationToken: null,
    reviewMutationFence: Number(fence),
    reviewMutationExpiresAt: null,
    pendingTransition: {},
    userDisposition: {},
    chase: { required: false, state: "NONE", lastActionAt: null },
    reviewedAt: null,
  };
}

function lifecycleOwnershipFilter({ fence, operationId }) {
  const expectedFence = Number(fence);
  return {
    $or: [
      { reviewMutationFence: { $lt: expectedFence } },
      {
        reviewMutationFence: expectedFence,
        lastLifecycleOperationId: operationId,
      },
    ],
  };
}

async function upsertPortalOnlyCandidates({
  firmId,
  run,
  candidates,
  status,
  operationId,
  fence,
}) {
  if (!candidates.length) return;
  const generationScope = requireGenerationItemScope(run);
  const expectedFence = mutationFence(run, fence);
  const operations = candidates.map((portal) => {
    const remainder = portalOnlyItemForCandidate({
      run,
      portal,
      status,
      operationId,
      fence: expectedFence,
    });
    return {
      updateOne: {
        filter: {
          firmId,
          runId: run._id,
          ...generationScope,
          itemKey: remainder.itemKey,
          ...lifecycleOwnershipFilter({ fence: expectedFence, operationId }),
        },
        update: { $set: remainder },
        upsert: true,
      },
    };
  });

  let result;
  try {
    result = await ReconciliationItem.bulkWrite(operations, { ordered: false });
  } catch (error) {
    if (error?.code === 11000) {
      throw serviceError(
        "Portal-only lifecycle ownership changed; retry the reserved transition",
        409,
      );
    }
    throw error;
  }
  const applied =
    Number(result.matchedCount || 0) + Number(result.upsertedCount || 0);
  if (applied !== candidates.length) {
    throw serviceError(
      "Portal-only lifecycle ownership changed; retry the reserved transition",
      409,
    );
  }
}

async function retirePortalOnlyItems({
  firmId,
  run,
  selector,
  operationId,
  fence,
}) {
  const expectedFence = mutationFence(run, fence);
  return ReconciliationItem.updateMany(
    {
      firmId,
      runId: run._id,
      ...requireGenerationItemScope(run),
      booksRowId: null,
      isActive: { $ne: false },
      ...selector,
      ...lifecycleOwnershipFilter({ fence: expectedFence, operationId }),
    },
    [
      {
        $set: {
          isActive: false,
          retiredPortalRowId: "$portalRowId",
          portalRowId: null,
          lastLifecycleOperationId: operationId,
          reviewMutationToken: null,
          reviewMutationFence: expectedFence,
          reviewMutationExpiresAt: null,
        },
      },
    ],
  );
}

export async function applyItemDisposition({
  firmId,
  runId,
  itemId,
  actorUserId,
  requestId = "",
  action,
  expectedDecisionVersion,
  payload = {},
}) {
  assertObjectId(actorUserId, "User");
  assertObjectId(itemId, "Reconciliation item");
  const expectedVersion = Number(expectedDecisionVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    throw serviceError("Expected decision version is required", 400);
  }

  const mutation = await beginReviewMutation({ firmId, runId });
  const run = mutation.run;
  const itemScope = requireActiveItemScope(run);
  const claimedItemIds = [];
  let changed = false;
  let operationError = null;
  try {
    let item = await ReconciliationItem.findOne({
      _id: itemId,
      runId,
      firmId,
      ...itemScope,
    });
    if (!item) throw serviceError("Reconciliation item not found", 404);

    const normalizedAction = String(action || "").toUpperCase();
    const cleaned = cleanDispositionPayload(payload);
    const operationId = itemDispositionOperationId({
      runId,
      itemId,
      expectedVersion,
      action: normalizedAction,
      payload: cleaned,
    });
    const transitionAction = ["ACCEPT_MATCH", "UNMATCH"].includes(
      normalizedAction,
    );
    const pendingAction = item.pendingTransition?.action || null;
    const pendingRun = run.pendingReviewTransition || {};
    const bulkPending = run.bulkReviewOperation?.state === "PENDING";
    if (bulkPending) {
      throw serviceError(
        "Complete the pending bulk review before changing an item",
        409,
      );
    }

    if (
      item.lastReviewOperationId === operationId &&
      Number(item.decisionVersion || 0) === expectedVersion + 1
    ) {
      const needsSummaryRepair = Boolean(
        run.summaryDirty || pendingRun.operationId,
      );
      const summary = needsSummaryRepair
        ? await recomputeRunSummary({
            firmId,
            run,
            token: mutation.token,
            fence: mutation.fence,
            clearDirty: true,
            transitionOperationId:
              pendingRun.operationId === operationId ? operationId : null,
          })
        : run.summary;
      changed = needsSummaryRepair;
      return {
        item: serializeItem(item),
        summary,
        operationId,
        replayed: true,
      };
    }
    if (Number(item.decisionVersion || 0) !== expectedVersion) {
      throw serviceError(
        "Reconciliation item changed; reload before applying a decision",
        409,
      );
    }

    const pendingItem = await ReconciliationItem.findOne({
      firmId,
      runId,
      ...itemScope,
      "pendingTransition.action": { $ne: null },
    })
      .select({
        _id: 1,
        pendingTransition: 1,
      })
      .lean();
    if (pendingItem) {
      const pending = pendingItem.pendingTransition || {};
      const sameCandidate =
        normalizedAction !== "ACCEPT_MATCH" ||
        String(pending.candidatePortalRowId || "") ===
          String(cleaned.candidatePortalRowId || "");
      if (
        String(pendingItem._id) !== String(item._id) ||
        !transitionAction ||
        pending.action !== normalizedAction ||
        !sameCandidate ||
        Number(pending.expectedDecisionVersion || 0) !== expectedVersion ||
        (pending.operationId && pending.operationId !== operationId)
      ) {
        throw serviceError(
          `Complete the pending ${pending.action || "item"} transition before another review`,
          409,
        );
      }
    }
    if (pendingRun.operationId) {
      const sameCandidate =
        normalizedAction !== "ACCEPT_MATCH" ||
        String(pendingRun.candidatePortalRowId || "") ===
          String(cleaned.candidatePortalRowId || "");
      if (
        pendingRun.operationId !== operationId ||
        String(pendingRun.itemId || "") !== String(item._id) ||
        pendingRun.action !== normalizedAction ||
        !sameCandidate ||
        Number(pendingRun.expectedDecisionVersion || 0) !== expectedVersion
      ) {
        throw serviceError(
          "Complete the reserved item transition before another review",
          409,
        );
      }
    }
    if (pendingAction) {
      const sameCandidate =
        normalizedAction !== "ACCEPT_MATCH" ||
        String(item.pendingTransition?.candidatePortalRowId || "") ===
          String(cleaned.candidatePortalRowId || "");
      if (
        !transitionAction ||
        pendingAction !== normalizedAction ||
        !sameCandidate ||
        Number(item.pendingTransition?.expectedDecisionVersion || 0) !==
          expectedVersion ||
        (item.pendingTransition?.operationId &&
          item.pendingTransition.operationId !== operationId)
      ) {
        throw serviceError(
          `Item has an incomplete ${pendingAction} transition; retry that action first`,
          409,
        );
      }
    }

    if (run.summaryDirty && !pendingRun.operationId && !pendingItem) {
      run.summary = await recomputeRunSummary({
        firmId,
        run,
        token: mutation.token,
        fence: mutation.fence,
        clearDirty: true,
      });
      run.summaryDirty = false;
      changed = true;
    }

    const replayingAdmittedTransition = pendingRun.operationId === operationId;
    if (!replayingAdmittedTransition) {
      await validateDispositionReferences({
        firmId,
        ownerUserId: cleaned.ownerUserId,
        taskId: cleaned.taskId,
      });
    }
    const commandActorUserId =
      pendingRun.operationId === operationId && pendingRun.actorUserId
        ? pendingRun.actorUserId
        : actorUserId;
    assertObjectId(commandActorUserId, "Review command actor");
    const now = new Date();
    const set = dispositionSet({
      item,
      action: normalizedAction,
      payload: cleaned,
      actorUserId: commandActorUserId,
      now,
    });
    let remainingCandidates = [];
    let conflictingPortalOnlyItem = null;
    let restoredCandidateIds = [];

    if (normalizedAction === "ACCEPT_MATCH") {
      if (!cleaned.candidatePortalRowId)
        throw serviceError("Candidate portal row is required");
      const candidateIds = [
        ...new Set((item.candidatePortalRowIds || []).map(String)),
      ];
      if (!candidateIds.includes(String(cleaned.candidatePortalRowId))) {
        throw serviceError(
          "Selected row is not a candidate for this item",
          409,
        );
      }
      const candidateRows = await ImportRow.find({
        _id: { $in: candidateIds },
        firmId,
        clientId: run.clientId,
        batchId: run.sourceImports.portalBatchId,
        kind: "GSTR2B",
      }).lean();
      if (candidateRows.length !== candidateIds.length) {
        throw serviceError(
          "One or more candidate portal rows are unavailable",
          409,
        );
      }
      const portal = candidateRows.find(
        (row) => String(row._id) === String(cleaned.candidatePortalRowId),
      );
      const existingPortalMatch = await ReconciliationItem.exists({
        firmId,
        runId,
        ...itemScope,
        portalRowId: portal._id,
        booksRowId: { $ne: null },
        _id: { $ne: item._id },
      });
      if (existingPortalMatch) {
        throw serviceError(
          "Candidate portal row is already accepted by another item",
          409,
        );
      }
      conflictingPortalOnlyItem = await ReconciliationItem.findOne({
        firmId,
        runId,
        ...itemScope,
        portalRowId: portal._id,
        booksRowId: null,
        _id: { $ne: item._id },
      })
        .select({ _id: 1, portalRowId: 1 })
        .lean();
      const books = {
        taxableValueMinor: item.booksAmounts.taxableValueMinor,
        igstMinor: item.booksAmounts.igstMinor,
        cgstMinor: item.booksAmounts.cgstMinor,
        sgstMinor: item.booksAmounts.sgstMinor,
        cessMinor: item.booksAmounts.cessMinor,
        totalTaxMinor: item.booksAmounts.totalTaxMinor,
        documentDate: item.documentDate,
      };
      const candidateHistory = [
        ...new Set([
          ...(item.candidateHistoryPortalRowIds || []).map(String),
          ...candidateIds,
        ]),
      ];
      set.portalRowId = portal._id;
      set.portalSourceRow = portal.sourceRow;
      set.portalAmounts = {
        taxableValueMinor: portal.taxableValueMinor,
        igstMinor: portal.igstMinor,
        cgstMinor: portal.cgstMinor,
        sgstMinor: portal.sgstMinor,
        cessMinor: portal.cessMinor,
        totalTaxMinor: portal.totalTaxMinor,
      };
      set.differences = amountDifferences(books, portal);
      set.dateDifferenceDays = dateDifferenceDays(
        item.documentDate,
        portal.documentDate,
      );
      set.candidatePortalRowIds = [];
      set.candidateHistoryPortalRowIds = candidateHistory;
      set.status = "MATCHED";
      set.matchRule = "USER";
      set.autoAccepted = false;
      set.resolutionState = "RESOLVED";
      set.reviewedAt = now;
      remainingCandidates = candidateRows.filter(
        (row) => String(row._id) !== String(portal._id),
      );
    } else if (normalizedAction === "UNMATCH") {
      if (!item.booksRowId) {
        throw serviceError(
          "A portal-only item cannot be unmatched; use a resolving disposition",
          409,
        );
      }
      restoredCandidateIds = [
        ...new Set([
          ...(item.candidateHistoryPortalRowIds || []).map(String),
          ...(item.candidatePortalRowIds || []).map(String),
          ...(item.portalRowId ? [String(item.portalRowId)] : []),
        ]),
      ];
      set.portalRowId = null;
      set.portalSourceRow = null;
      set.portalAmounts = {};
      set.differences = amountDifferences(item.booksAmounts || {}, {});
      set.dateDifferenceDays = null;
      set.candidatePortalRowIds = restoredCandidateIds;
      set.candidateHistoryPortalRowIds = restoredCandidateIds;
      if (restoredCandidateIds.length) {
        set.status = [
          "AMBIGUOUS_MATCH",
          "POSSIBLE_AMENDMENT",
          "DUPLICATE_IN_BOOKS",
        ].includes(item.originalStatus)
          ? item.originalStatus
          : "NEEDS_REVIEW";
        set.matchRule = "CANDIDATE";
      }
    }

    const expiresAt = await renewReviewMutation({
      firmId,
      run,
      token: mutation.token,
      fence: mutation.fence,
    });
    await claimReviewItems({
      firmId,
      run,
      token: mutation.token,
      fence: mutation.fence,
      expiresAt,
      items: [item],
    });
    claimedItemIds.push(String(item._id));

    const before = serializeItem(item);
    await recordActivity({
      firmId,
      actorUserId,
      source: "USER",
      action: "GST_ITEM_DISPOSITION_REQUESTED",
      entityType: "ReconciliationItem",
      entityId: item._id,
      requestId,
      beforeSummary: {
        status: before.status,
        resolutionState: before.resolutionState,
        decisionVersion: before.decisionVersion,
      },
      afterSummary: { action: normalizedAction, payload: cleaned },
      metadata: {
        runId: String(runId),
        resumedTransition: Boolean(pendingAction),
      },
    });

    const reservedTransition = transitionAction
      ? {
          operationId,
          itemId: item._id,
          action: normalizedAction,
          candidatePortalRowId:
            normalizedAction === "ACCEPT_MATCH"
              ? cleaned.candidatePortalRowId
              : null,
          expectedDecisionVersion: expectedVersion,
          payload: cleaned,
          actorUserId: commandActorUserId,
          requestId,
          startedAt: item.pendingTransition?.startedAt || now,
        }
      : null;
    await markSummaryDirty({
      firmId,
      run,
      token: mutation.token,
      fence: mutation.fence,
      pendingReviewTransition: reservedTransition || undefined,
    });
    changed = true;

    if (transitionAction && !pendingAction) {
      const intent = await ReconciliationItem.findOneAndUpdate(
        {
          _id: item._id,
          runId,
          firmId,
          ...itemScope,
          reviewMutationToken: mutation.token,
          reviewMutationFence: mutation.fence,
          decisionVersion:
            expectedVersion === 0 ? { $in: [0, null] } : expectedVersion,
          "pendingTransition.action": null,
          $expr: { $gt: ["$reviewMutationExpiresAt", "$$NOW"] },
        },
        {
          $set: {
            "pendingTransition.operationId": operationId,
            "pendingTransition.action": normalizedAction,
            "pendingTransition.candidatePortalRowId":
              normalizedAction === "ACCEPT_MATCH"
                ? cleaned.candidatePortalRowId
                : null,
            "pendingTransition.expectedDecisionVersion": expectedVersion,
            "pendingTransition.startedAt": now,
          },
        },
        { new: true, runValidators: true },
      );
      if (!intent)
        throw serviceError(
          "Item transition could not be reserved; reload and retry",
          409,
        );
      item = intent;
      changed = true;
    }

    if (normalizedAction === "ACCEPT_MATCH" && remainingCandidates.length) {
      await renewReviewMutation({
        firmId,
        run,
        token: mutation.token,
        fence: mutation.fence,
        itemIds: claimedItemIds,
      });
      const exactDuplicate = remainingCandidates.every(
        (row) =>
          row.supplierGstin === item.supplierGstin &&
          row.invoiceNumberNormalized === item.invoiceNumberNormalized &&
          row.documentType === item.documentType,
      );
      const remainderStatus = exactDuplicate
        ? "DUPLICATE_IN_2B"
        : "MISSING_IN_BOOKS";
      await upsertPortalOnlyCandidates({
        firmId,
        run,
        candidates: remainingCandidates,
        status: remainderStatus,
        operationId,
        fence: mutation.fence,
      });
      changed = true;
    }

    if (normalizedAction === "ACCEPT_MATCH" && conflictingPortalOnlyItem) {
      await renewReviewMutation({
        firmId,
        run,
        token: mutation.token,
        fence: mutation.fence,
        itemIds: claimedItemIds,
      });
      const retirement = await retirePortalOnlyItems({
        firmId,
        run,
        selector: {
          _id: conflictingPortalOnlyItem._id,
          portalRowId: conflictingPortalOnlyItem.portalRowId,
        },
        operationId,
        fence: mutation.fence,
      });
      if (Number(retirement.matchedCount || 0) > 0) changed = true;
    }

    if (normalizedAction === "UNMATCH" && restoredCandidateIds.length) {
      await renewReviewMutation({
        firmId,
        run,
        token: mutation.token,
        fence: mutation.fence,
        itemIds: claimedItemIds,
      });
      const retirement = await retirePortalOnlyItems({
        firmId,
        run,
        selector: {
          _id: { $ne: item._id },
          portalRowId: { $in: restoredCandidateIds },
        },
        operationId,
        fence: mutation.fence,
      });
      if (Number(retirement.matchedCount || 0) > 0) changed = true;
    }

    await renewReviewMutation({
      firmId,
      run,
      token: mutation.token,
      fence: mutation.fence,
      itemIds: claimedItemIds,
    });
    if (transitionAction) {
      set["pendingTransition.operationId"] = null;
      set["pendingTransition.action"] = null;
      set["pendingTransition.candidatePortalRowId"] = null;
      set["pendingTransition.expectedDecisionVersion"] = null;
      set["pendingTransition.startedAt"] = null;
    }
    set.lastReviewOperationId = operationId;

    let updated;
    try {
      updated = await ReconciliationItem.findOneAndUpdate(
        {
          _id: item._id,
          runId,
          firmId,
          ...itemScope,
          reviewMutationToken: mutation.token,
          reviewMutationFence: mutation.fence,
          decisionVersion:
            expectedVersion === 0 ? { $in: [0, null] } : expectedVersion,
          ...(transitionAction
            ? {
                "pendingTransition.action": normalizedAction,
                "pendingTransition.operationId": { $in: [operationId, null] },
              }
            : { "pendingTransition.action": null }),
          $expr: { $gt: ["$reviewMutationExpiresAt", "$$NOW"] },
        },
        { $set: set, $inc: { decisionVersion: 1 } },
        { new: true, runValidators: true },
      );
    } catch (error) {
      if (error?.code === 11000 && normalizedAction === "ACCEPT_MATCH") {
        throw serviceError(
          "Candidate portal row was accepted by another item; reload and review",
          409,
        );
      }
      throw error;
    }
    if (!updated) {
      throw serviceError(
        "Review ownership expired or item changed; reload before retrying",
        409,
      );
    }
    changed = true;

    await renewReviewMutation({
      firmId,
      run,
      token: mutation.token,
      fence: mutation.fence,
      itemIds: claimedItemIds,
    });
    const summary = await recomputeRunSummary({
      firmId,
      run,
      token: mutation.token,
      fence: mutation.fence,
      clearDirty: true,
      transitionOperationId: transitionAction ? operationId : null,
    });
    await safeRecordActivity({
      firmId,
      actorUserId,
      source: "USER",
      action: "GST_ITEM_DISPOSITION_UPDATED",
      entityType: "ReconciliationItem",
      entityId: item._id,
      requestId,
      beforeSummary: {
        status: before.status,
        disposition: before.userDisposition,
      },
      afterSummary: {
        status: updated.status,
        resolutionState: updated.resolutionState,
        disposition: updated.userDisposition,
      },
      metadata: { runId: String(runId), action: normalizedAction },
    });
    return { item: serializeItem(updated), summary, operationId };
  } catch (error) {
    operationError = error;
    if (changed) {
      await recomputeRunSummary({
        firmId,
        run,
        token: mutation.token,
        fence: mutation.fence,
      }).catch((summaryError) => {
        console.error(
          "[GST] Failed to repair run summary after item error:",
          summaryError.message,
        );
      });
    }
    throw error;
  } finally {
    await releaseReviewItems({
      firmId,
      run,
      token: mutation.token,
      fence: mutation.fence,
      itemIds: claimedItemIds,
    }).catch((releaseError) => {
      console.error(
        "[GST] Failed to release review item lease:",
        releaseError.message,
      );
    });
    try {
      await endReviewMutation({
        firmId,
        runId,
        token: mutation.token,
        fence: mutation.fence,
        changed,
      });
    } catch (endError) {
      if (!operationError) throw endError;
      console.error(
        "[GST] Failed to release item review mutation:",
        endError.message,
      );
    }
  }
}

function bulkMaterial({ run, items, action, payload }) {
  return JSON.stringify({
    runId: String(run._id),
    reviewVersion: Number(run.reviewVersion || 0),
    items: [...items]
      .map((item) => ({
        id: String(item._id),
        decisionVersion: Number(item.decisionVersion || 0),
        status: item.status,
        resolutionState: item.resolutionState || "OPEN",
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    action,
    payload,
  });
}

function bulkToken(material) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw serviceError("Bulk preview signing is unavailable", 503);
  return createHmac("sha256", secret).update(material).digest("hex");
}

function tokenMatches(expected, received) {
  if (!/^[a-f0-9]{64}$/i.test(String(received || ""))) return false;
  return timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(received, "hex"),
  );
}

export async function bulkDisposition({
  firmId,
  runId,
  actorUserId,
  requestId = "",
  mode,
  itemIds,
  action,
  payload = {},
  previewToken = "",
}) {
  assertObjectId(actorUserId, "User");
  const normalizedMode = String(mode || "preview").toLowerCase();
  if (!["preview", "commit"].includes(normalizedMode)) {
    throw serviceError("Mode must be preview or commit");
  }
  const normalizedAction = String(action || "").toUpperCase();
  if (!BULK_ACTIONS.has(normalizedAction)) {
    throw serviceError("Action is not supported for bulk review");
  }
  if (
    !Array.isArray(itemIds) ||
    itemIds.length < 1 ||
    itemIds.length > MAX_BULK_ITEMS
  ) {
    throw serviceError(`Select 1 to ${MAX_BULK_ITEMS} items`);
  }
  const uniqueIds = [...new Set(itemIds.map(String))];
  uniqueIds.forEach((id) => assertObjectId(id, "Reconciliation item"));
  const cleaned = cleanDispositionPayload(payload);

  if (normalizedMode === "preview") {
    await validateDispositionReferences({
      firmId,
      ownerUserId: cleaned.ownerUserId,
      taskId: cleaned.taskId,
    });
    const run = await requireRun({ firmId, runId });
    if (run.status === "LOCKED" || run.status === "LOCKING") {
      throw serviceError(
        "Locked run cannot be changed; create a revision",
        423,
      );
    }
    if (
      run.status !== "REVIEW" ||
      run.summaryDirty ||
      run.bulkReviewOperation?.state === "PENDING" ||
      run.pendingReviewTransition?.operationId
    ) {
      throw serviceError("Run is not available for bulk preview", 409);
    }
    const activeMutation = await ReconciliationRun.exists({
      _id: runId,
      firmId,
      status: "REVIEW",
      reviewMutationActive: true,
      $expr: { $gt: ["$reviewMutationExpiresAt", "$$NOW"] },
    });
    if (activeMutation) {
      throw serviceError("Run is not available for bulk preview", 409);
    }
    const pendingTransition = await ReconciliationItem.exists({
      firmId,
      runId,
      ...requireActiveItemScope(run),
      "pendingTransition.action": { $ne: null },
    });
    if (pendingTransition) {
      throw serviceError(
        "Complete pending item transitions before bulk review",
        409,
      );
    }
    const items = await ReconciliationItem.find({
      _id: { $in: uniqueIds },
      firmId,
      runId,
      ...requireActiveItemScope(run),
    });
    if (items.length !== uniqueIds.length) {
      throw serviceError("One or more selected items are unavailable", 409);
    }
    if (items.some((item) => item.pendingTransition?.action)) {
      throw serviceError(
        "Complete pending item transitions before bulk review",
        409,
      );
    }
    const now = new Date();
    items.forEach((item) => {
      dispositionSet({
        item,
        action: normalizedAction,
        payload: cleaned,
        actorUserId,
        now,
      });
    });
    const material = bulkMaterial({
      run,
      items,
      action: normalizedAction,
      payload: cleaned,
    });
    const affectedByStatus = items.reduce((counts, item) => {
      counts[item.status] = (counts[item.status] || 0) + 1;
      return counts;
    }, {});
    const previewAuthorization = bulkToken(material);
    return {
      mode: "preview",
      previewToken: previewAuthorization,
      operationId: bulkDispositionOperationId({
        runId,
        itemIds: uniqueIds,
        action: normalizedAction,
        payload: cleaned,
        previewToken: previewAuthorization,
      }),
      expiresOnChange: true,
      affectedCount: items.length,
      affectedByStatus,
      action: normalizedAction,
    };
  }

  const mutation = await beginReviewMutation({ firmId, runId });
  const run = mutation.run;
  const itemScope = requireActiveItemScope(run);
  const claimedItemIds = [];
  const requestedOperationId = bulkDispositionOperationId({
    runId,
    itemIds: uniqueIds,
    action: normalizedAction,
    payload: cleaned,
    previewToken,
  });
  let changed = false;
  let operationError = null;
  try {
    if (run.pendingReviewTransition?.operationId) {
      throw serviceError(
        "Complete the pending item transition before bulk review",
        409,
      );
    }
    const pendingItem = await ReconciliationItem.exists({
      firmId,
      runId,
      ...itemScope,
      "pendingTransition.action": { $ne: null },
    });
    if (pendingItem) {
      throw serviceError(
        "Complete pending item transitions before bulk review",
        409,
      );
    }

    const storedOperation = run.bulkReviewOperation || {};
    if (
      storedOperation.state === "COMPLETED" &&
      storedOperation.operationId === requestedOperationId
    ) {
      const summary = run.summaryDirty
        ? await recomputeRunSummary({
            firmId,
            run,
            token: mutation.token,
            fence: mutation.fence,
            clearDirty: true,
          })
        : run.summary;
      changed = Boolean(run.summaryDirty);
      return {
        mode: "commit",
        affectedCount: Number(
          storedOperation.affectedCount || uniqueIds.length,
        ),
        action: storedOperation.action || normalizedAction,
        summary,
        operationId: requestedOperationId,
        replayed: true,
      };
    }
    if (
      storedOperation.state === "PENDING" &&
      storedOperation.operationId !== requestedOperationId
    ) {
      throw serviceError(
        "A different bulk review is incomplete; retry its original commit",
        409,
      );
    }

    const resuming = storedOperation.state === "PENDING";
    const operationId = resuming
      ? storedOperation.operationId
      : requestedOperationId;
    const selectedIds = resuming
      ? (storedOperation.itemVersions || []).map((entry) =>
          String(entry.itemId),
        )
      : uniqueIds;
    const items = await ReconciliationItem.find({
      _id: { $in: selectedIds },
      firmId,
      runId,
      ...itemScope,
    });
    if (items.length !== selectedIds.length) {
      throw serviceError("One or more selected items are unavailable", 409);
    }
    if (items.some((item) => item.pendingTransition?.action)) {
      throw serviceError(
        "Complete pending item transitions before bulk review",
        409,
      );
    }

    let itemVersions;
    let affectedByStatus;
    let uniformSet;
    if (resuming) {
      itemVersions = (storedOperation.itemVersions || []).map((entry) => ({
        itemId: entry.itemId,
        decisionVersion: Number(entry.decisionVersion || 0),
      }));
      const versionsById = new Map(
        itemVersions.map((entry) => [
          String(entry.itemId),
          entry.decisionVersion,
        ]),
      );
      for (const item of items) {
        const baseVersion = versionsById.get(String(item._id));
        const completed = item.lastReviewOperationId === operationId;
        const expectedCurrent = baseVersion + (completed ? 1 : 0);
        if (Number(item.decisionVersion || 0) !== expectedCurrent) {
          throw serviceError(
            "Bulk review item changed outside its durable operation",
            409,
          );
        }
      }
      affectedByStatus = storedOperation.affectedByStatus || {};
      const storedAction = String(storedOperation.action || "").toUpperCase();
      if (storedAction !== normalizedAction) {
        throw serviceError(
          "Bulk review command action changed after admission",
          409,
        );
      }
      uniformSet = bulkDispositionSet({
        item: items[0],
        action: storedAction,
        payload: cleaned,
        actorUserId: storedOperation.actorUserId,
        startedAt: storedOperation.startedAt,
      });
      if (!run.summaryDirty) {
        await markSummaryDirty({
          firmId,
          run,
          token: mutation.token,
          fence: mutation.fence,
          bulkReviewOperation: storedOperation.toObject
            ? storedOperation.toObject()
            : storedOperation,
        });
        changed = true;
      }
    } else {
      const material = bulkMaterial({
        run,
        items,
        action: normalizedAction,
        payload: cleaned,
      });
      const expectedToken = bulkToken(material);
      if (!tokenMatches(expectedToken, previewToken)) {
        throw serviceError(
          "Bulk preview is stale or invalid; preview again",
          409,
        );
      }
      await validateDispositionReferences({
        firmId,
        ownerUserId: cleaned.ownerUserId,
        taskId: cleaned.taskId,
      });
      affectedByStatus = items.reduce((counts, item) => {
        counts[item.status] = (counts[item.status] || 0) + 1;
        return counts;
      }, {});
      const now = new Date();
      uniformSet = bulkDispositionSet({
        item: items[0],
        action: normalizedAction,
        payload: cleaned,
        actorUserId,
        startedAt: now,
      });
      itemVersions = items.map((item) => ({
        itemId: item._id,
        decisionVersion: Number(item.decisionVersion || 0),
      }));

      await recordActivity({
        firmId,
        actorUserId,
        source: "USER",
        action: "GST_ITEMS_BULK_DISPOSITION_REQUESTED",
        entityType: "ReconciliationRun",
        entityId: runId,
        requestId,
        beforeSummary: {
          affectedByStatus,
          reviewVersion: run.reviewVersion || 0,
        },
        afterSummary: {
          affectedCount: items.length,
          action: normalizedAction,
          payload: cleaned,
          operationId,
        },
      });

      await markSummaryDirty({
        firmId,
        run,
        token: mutation.token,
        fence: mutation.fence,
        bulkReviewOperation: {
          operationId,
          state: "PENDING",
          action: normalizedAction,
          previewToken: String(previewToken || "").toLowerCase(),
          payload: cleaned,
          actorUserId,
          itemVersions,
          affectedByStatus,
          affectedCount: items.length,
          requestId,
          startedAt: now,
          completedAt: null,
        },
      });
      changed = true;
    }

    const expiresAt = await renewReviewMutation({
      firmId,
      run,
      token: mutation.token,
      fence: mutation.fence,
    });
    await claimReviewItems({
      firmId,
      run,
      token: mutation.token,
      fence: mutation.fence,
      expiresAt,
      items,
    });
    claimedItemIds.push(...items.map((item) => String(item._id)));

    const remainingIds = items
      .filter((item) => item.lastReviewOperationId !== operationId)
      .map((item) => String(item._id));
    if (remainingIds.length) {
      changed = true;
      const result = await ReconciliationItem.updateMany(
        {
          _id: { $in: remainingIds },
          firmId,
          runId,
          ...itemScope,
          reviewMutationToken: mutation.token,
          reviewMutationFence: mutation.fence,
          lastReviewOperationId: { $ne: operationId },
          "pendingTransition.action": null,
          $expr: { $gt: ["$reviewMutationExpiresAt", "$$NOW"] },
        },
        {
          $set: {
            ...uniformSet,
            lastReviewOperationId: operationId,
          },
          $inc: { decisionVersion: 1 },
        },
      );
      if (Number(result.matchedCount || 0) !== remainingIds.length) {
        throw serviceError(
          "Bulk review remains incomplete; retry the same commit",
          409,
        );
      }
    }

    await renewReviewMutation({
      firmId,
      run,
      token: mutation.token,
      fence: mutation.fence,
      itemIds: claimedItemIds,
    });
    const completedItems = await ReconciliationItem.find({
      _id: { $in: selectedIds },
      firmId,
      runId,
      ...itemScope,
    })
      .select({ _id: 1, decisionVersion: 1, lastReviewOperationId: 1 })
      .lean();
    const baseVersions = new Map(
      itemVersions.map((entry) => [
        String(entry.itemId),
        Number(entry.decisionVersion || 0),
      ]),
    );
    const allCompleted =
      completedItems.length === selectedIds.length &&
      completedItems.every(
        (item) =>
          item.lastReviewOperationId === operationId &&
          Number(item.decisionVersion || 0) ===
            baseVersions.get(String(item._id)) + 1,
      );
    if (!allCompleted) {
      throw serviceError(
        "Bulk review remains incomplete; retry the same commit",
        409,
      );
    }

    const summary = await recomputeRunSummary({
      firmId,
      run,
      token: mutation.token,
      fence: mutation.fence,
      clearDirty: true,
      bulkOperationId: operationId,
    });
    await safeRecordActivity({
      firmId,
      actorUserId,
      source: "USER",
      action: "GST_ITEMS_BULK_DISPOSITION_UPDATED",
      entityType: "ReconciliationRun",
      entityId: runId,
      requestId,
      beforeSummary: { affectedByStatus },
      afterSummary: {
        affectedCount: selectedIds.length,
        action: normalizedAction,
        summary,
        operationId,
        resumed: resuming,
      },
    });
    return {
      mode: "commit",
      affectedCount: selectedIds.length,
      action: normalizedAction,
      summary,
      operationId,
      replayed: resuming,
    };
  } catch (error) {
    operationError = error;
    if (changed) {
      await recomputeRunSummary({
        firmId,
        run,
        token: mutation.token,
        fence: mutation.fence,
      }).catch((summaryError) => {
        console.error(
          "[GST] Failed to repair run summary after bulk error:",
          summaryError.message,
        );
      });
    }
    throw error;
  } finally {
    await releaseReviewItems({
      firmId,
      run,
      token: mutation.token,
      fence: mutation.fence,
      itemIds: claimedItemIds,
    }).catch((releaseError) => {
      console.error(
        "[GST] Failed to release bulk review item leases:",
        releaseError.message,
      );
    });
    try {
      await endReviewMutation({
        firmId,
        runId,
        token: mutation.token,
        fence: mutation.fence,
        changed,
      });
    } catch (endError) {
      if (!operationError) throw endError;
      console.error(
        "[GST] Failed to release bulk review mutation:",
        endError.message,
      );
    }
  }
}

export async function recoverReviewOperation({
  firmId,
  runId,
  actorUserId,
  requestId = "",
  operationId = null,
}) {
  assertObjectId(actorUserId, "User");
  const run = await requireRun({ firmId, runId });
  const pendingTransition = run.pendingReviewTransition || {};
  const pendingBulk = run.bulkReviewOperation || {};
  const rawPendingOperationId =
    pendingTransition.operationId ||
    (pendingBulk.state === "PENDING" ? pendingBulk.operationId : null);
  const pendingOperationId = rawPendingOperationId
    ? String(rawPendingOperationId).toLowerCase()
    : null;
  const requestedOperationId = operationId
    ? String(operationId).toLowerCase()
    : null;

  if (requestedOperationId && !/^[a-f0-9]{64}$/.test(requestedOperationId)) {
    throw serviceError("Recovery operation ID is invalid", 400);
  }
  if (pendingOperationId && !requestedOperationId) {
    throw serviceError(
      "Recovery operation ID is required for a pending review command",
      400,
    );
  }
  if (pendingOperationId && pendingOperationId !== requestedOperationId) {
    throw serviceError("A different review operation is pending", 409);
  }
  if (!pendingOperationId && requestedOperationId) {
    if (
      run.lastCompletedReviewOperationId === requestedOperationId &&
      !run.summaryDirty
    ) {
      return {
        run: serializeRun(run, { includeRecoveryCommand: true }),
        operationId: requestedOperationId,
        replayed: true,
      };
    }
    throw serviceError("Recovery operation is no longer pending", 409);
  }
  if (run.status !== "REVIEW") {
    throw serviceError(
      "Only a review run can recover review finalization",
      409,
    );
  }

  await safeRecordActivity({
    firmId,
    actorUserId,
    source: "USER",
    action: "GST_REVIEW_RECOVERY_REQUESTED",
    entityType: "ReconciliationRun",
    entityId: runId,
    requestId,
    afterSummary: {
      operationId: pendingOperationId || null,
      kind: pendingTransition.operationId
        ? "ITEM"
        : pendingBulk.state === "PENDING"
          ? "BULK"
          : "SUMMARY",
    },
  });

  let outcome;
  if (pendingTransition.operationId) {
    const commandPayload = plain(pendingTransition.payload) || {};
    outcome = await applyItemDisposition({
      firmId,
      runId,
      itemId: pendingTransition.itemId,
      actorUserId,
      requestId,
      action: pendingTransition.action,
      expectedDecisionVersion: pendingTransition.expectedDecisionVersion,
      payload: commandPayload,
    });
  } else if (pendingBulk.state === "PENDING") {
    const commandPayload = plain(pendingBulk.payload) || {};
    outcome = await bulkDisposition({
      firmId,
      runId,
      actorUserId,
      requestId,
      mode: "commit",
      itemIds: (pendingBulk.itemVersions || []).map((entry) => entry.itemId),
      action: pendingBulk.action,
      payload: commandPayload,
      previewToken: pendingBulk.previewToken,
    });
  } else if (run.summaryDirty) {
    const mutation = await beginReviewMutation({ firmId, runId });
    let recoveryError = null;
    try {
      const summary = await recomputeRunSummary({
        firmId,
        run: mutation.run,
        token: mutation.token,
        fence: mutation.fence,
        clearDirty: true,
      });
      outcome = { summary, operationId: null, repaired: true };
    } catch (error) {
      recoveryError = error;
      throw error;
    } finally {
      try {
        await endReviewMutation({
          firmId,
          runId,
          token: mutation.token,
          fence: mutation.fence,
        });
      } catch (endError) {
        if (!recoveryError) throw endError;
        console.error(
          "[GST] Failed to release review recovery mutation:",
          endError.message,
        );
      }
    }
  } else {
    return {
      run: serializeRun(run, { includeRecoveryCommand: true }),
      operationId: null,
      replayed: true,
    };
  }

  const recoveredRun = await requireRun({ firmId, runId });
  await safeRecordActivity({
    firmId,
    actorUserId,
    source: "USER",
    action: "GST_REVIEW_RECOVERY_COMPLETED",
    entityType: "ReconciliationRun",
    entityId: runId,
    requestId,
    afterSummary: {
      operationId: outcome?.operationId || pendingOperationId || null,
      reviewVersion: Number(recoveredRun.reviewVersion || 0),
    },
  });
  return {
    run: serializeRun(recoveredRun, { includeRecoveryCommand: true }),
    operationId: outcome?.operationId || pendingOperationId || null,
    replayed: Boolean(outcome?.replayed),
  };
}

export async function getGstr3bControl({ firmId, runId }) {
  const run = await requireRun({ firmId, runId });
  if (!["REVIEW", "LOCKED"].includes(run.status)) {
    throw serviceError(
      "Run must finish reconciliation before GSTR-3B control is available",
      409,
    );
  }
  const itemScope = requireActiveItemScope(run);
  if (
    run.summaryDirty ||
    run.pendingReviewTransition?.operationId ||
    run.bulkReviewOperation?.state === "PENDING"
  ) {
    throw serviceError(
      "Review finalization is incomplete; retry it before viewing control",
      409,
    );
  }
  if (run.status === "REVIEW") {
    const activeMutation = await ReconciliationRun.exists({
      _id: runId,
      firmId,
      status: "REVIEW",
      reviewMutationActive: true,
      $expr: { $gt: ["$reviewMutationExpiresAt", "$$NOW"] },
    });
    if (activeMutation) {
      throw serviceError("Review is changing; reload the GSTR-3B control", 409);
    }
  }
  const pendingTransition = await ReconciliationItem.exists({
    firmId,
    runId,
    ...itemScope,
    "pendingTransition.action": { $ne: null },
  });
  if (pendingTransition) {
    throw serviceError(
      "A reconciliation transition is incomplete; retry it before viewing control",
      409,
    );
  }

  let claimed = Object.fromEntries(TAX_HEAD_FIELDS.map((field) => [field, 0]));
  let claimedBasis = "NOT_IMPORTED";
  let gstr3bOutward = null;
  if (run.sourceImports.gstr3bBatchId) {
    const batch = await ImportBatch.findOne({
      _id: run.sourceImports.gstr3bBatchId,
      firmId,
      kind: "GSTR3B_SUMMARY",
      status: "COMPLETED",
    }).lean();
    validateBatchContext(batch, {
      firmId,
      clientId: run.clientId,
      gstin: run.gstin,
      period: run.period,
      kind: "GSTR3B_SUMMARY",
    });
    const rows = await ImportRow.find({
      firmId,
      clientId: run.clientId,
      batchId: batch._id,
      kind: "GSTR3B_SUMMARY",
      importGeneration: batch.activeImportGeneration,
    }).lean();
    try {
      const calculated = calculateGstr3bControlTotals(rows);
      if (calculated.claimed) {
        claimed = calculated.claimed;
        claimedBasis = calculated.claimedBasis;
      }
      // The SAME rows read for their other half. Table 3.1 is the outward supply the return
      // declares, and it is what GSTR-1 is compared against - so one GSTR-3B upload serves both
      // comparisons and costs one query, not two.
      gstr3bOutward = calculated.outward;
    } catch (error) {
      throw serviceError(
        `GSTR-3B control input is invalid: ${error.message}`,
        409,
      );
    }
  }

  // ---- GSTR-1 outward supply, for the turnover comparison ----
  let gstr1Outward = null;
  if (run.sourceImports.gstr1BatchId) {
    const batch = await ImportBatch.findOne({
      _id: run.sourceImports.gstr1BatchId,
      firmId,
      kind: "GSTR1_SUMMARY",
      status: "COMPLETED",
    }).lean();
    validateBatchContext(batch, {
      firmId,
      clientId: run.clientId,
      gstin: run.gstin,
      period: run.period,
      kind: "GSTR1_SUMMARY",
    });
    const rows = await ImportRow.find({
      firmId,
      clientId: run.clientId,
      batchId: batch._id,
      kind: "GSTR1_SUMMARY",
      importGeneration: batch.activeImportGeneration,
    }).lean();
    try {
      gstr1Outward = calculateGstr1Outward(rows);
    } catch (error) {
      throw serviceError(`GSTR-1 control input is invalid: ${error.message}`, 409);
    }
  }

  // ---- electronic credit ledger, for the ledger comparison ----
  let creditLedger = null;
  if (run.sourceImports.creditLedgerBatchId) {
    const batch = await ImportBatch.findOne({
      _id: run.sourceImports.creditLedgerBatchId,
      firmId,
      kind: "ECREDIT_LEDGER",
      status: "COMPLETED",
    }).lean();
    validateBatchContext(batch, {
      firmId,
      clientId: run.clientId,
      gstin: run.gstin,
      period: run.period,
      kind: "ECREDIT_LEDGER",
    });
    const rows = await ImportRow.find({
      firmId,
      clientId: run.clientId,
      batchId: batch._id,
      kind: "ECREDIT_LEDGER",
      importGeneration: batch.activeImportGeneration,
    }).lean();
    try {
      creditLedger = calculateCreditLedgerBalance(rows);
    } catch (error) {
      throw serviceError(`Credit ledger control input is invalid: ${error.message}`, 409);
    }
  }

  let stableRun = run;
  if (run.status === "REVIEW") {
    stableRun = await ReconciliationRun.findOne({
      _id: runId,
      firmId,
      status: "REVIEW",
      activeGenerationAttempt: itemScope.generationAttempt,
      reviewVersion: Number(run.reviewVersion || 0),
      reviewMutationFence: Number(run.reviewMutationFence || 0),
      summaryDirty: false,
      "pendingReviewTransition.operationId": null,
      "bulkReviewOperation.state": { $ne: "PENDING" },
      $expr: {
        $or: [
          { $ne: ["$reviewMutationActive", true] },
          {
            $lte: [
              { $ifNull: ["$reviewMutationExpiresAt", new Date(0)] },
              "$$NOW",
            ],
          },
        ],
      },
    }).lean();
    if (!stableRun) {
      throw serviceError(
        "Review changed while control was loading; reload",
        409,
      );
    }
  }

  const eligible = stableRun.summary?.eligible || {};
  const adjustment = stableRun.priorPeriodAdjustment || {};
  const adjustedEligible = {};
  const difference = {};
  for (const field of TAX_HEAD_FIELDS) {
    adjustedEligible[field] = addSafeIntegers([
      Number(eligible[field] || 0),
      Number(adjustment[field] || 0),
    ]);
    difference[field] = safeMinor(
      adjustedEligible[field] - Number(claimed[field] || 0),
      `Difference ${field}`,
    );
  }
  return {
    label: "CONTROL_ESTIMATE",
    basis:
      "Reviewed Purchase Register vs GSTR-2B invoice reconciliation; GSTR-3B is summary-level only.",
    claimedBasis,
    professionalConfirmed: Boolean(stableRun.reviewedAt),
    eligible,
    ineligible: stableRun.summary?.ineligible || {},
    deferred: stableRun.summary?.deferred || {},
    priorPeriodAdjustment: adjustment,
    adjustedEligible,
    claimedGstr3b: claimed,
    difference,
    hasImportedGstr3b: Boolean(stableRun.sourceImports.gstr3bBatchId),

    // ---- the two comparisons the ITC control never covered ----
    //
    // Both are stated the same way as the ITC one above: the two sides, their per-head
    // difference, and whether each source was actually imported. A section whose sources are
    // absent reports available:false rather than zeroes, so a screen can say "not imported" and
    // never present an un-run comparison as a clean one.
    turnover: buildTurnoverControl(gstr1Outward, gstr3bOutward),
    creditLedger: buildCreditLedgerControl(claimed, claimedBasis, creditLedger),
  };
}

/**
 * GSTR-1 declared outward supply against GSTR-3B Table 3.1, per tax head and on taxable value.
 *
 * The sign convention is stated rather than assumed: difference = GSTR-1 minus GSTR-3B. A
 * POSITIVE difference means more was declared in GSTR-1 than in GSTR-3B - supplies invoiced but
 * not carried into the summary return. A NEGATIVE difference means the summary return declared
 * more than the invoice-level return supports.
 */
function buildTurnoverControl(gstr1Outward, gstr3bOutward) {
  const available = Boolean(gstr1Outward && gstr3bOutward);
  const fields = ["taxableValueMinor", ...TAX_HEAD_FIELDS];
  const zero = Object.fromEntries(fields.map((field) => [field, 0]));

  const left = gstr1Outward || zero;
  const right = gstr3bOutward || zero;
  const difference = {};
  for (const field of fields) {
    difference[field] = safeMinor(
      Number(left[field] || 0) - Number(right[field] || 0),
      `Turnover difference ${field}`,
    );
  }

  return {
    available,
    basis: "GSTR-1 declared outward supply vs GSTR-3B Table 3.1, taxable and zero-rated only.",
    hasImportedGstr1: Boolean(gstr1Outward),
    hasImportedGstr3bOutward: Boolean(gstr3bOutward),
    gstr1: gstr1Outward,
    gstr3b: gstr3bOutward,
    difference: available ? difference : null,
    // Only meaningful when both sides exist; null keeps a screen from rendering "agreed" for a
    // comparison that never happened.
    agrees: available ? fields.every((field) => difference[field] === 0) : null,
  };
}

/**
 * ITC claimed in GSTR-3B against what the electronic credit ledger actually moved.
 *
 * difference = claimed minus ledger closing balance movement, per head. This is the third of the
 * three reconciliations a CA runs on a period, and the one that catches credit taken in the return
 * that the ledger never received.
 */
function buildCreditLedgerControl(claimed, claimedBasis, creditLedger) {
  const available = Boolean(creditLedger && claimedBasis !== "NOT_IMPORTED");
  const zero = Object.fromEntries(TAX_HEAD_FIELDS.map((field) => [field, 0]));
  const ledgerClosing = creditLedger?.closing || zero;

  const difference = {};
  for (const field of TAX_HEAD_FIELDS) {
    difference[field] = safeMinor(
      Number(claimed[field] || 0) - Number(ledgerClosing[field] || 0),
      `Credit ledger difference ${field}`,
    );
  }

  return {
    available,
    basis: "GSTR-3B ITC claimed vs the electronic credit ledger's closing balance.",
    hasImportedLedger: Boolean(creditLedger),
    ledgerBasis: creditLedger?.basis || "NOT_IMPORTED",
    // A file that states a closing balance AND the movements that should produce it, where the
    // two disagree, is reported rather than silently resolved in favour of either.
    ledgerStatedDiffersFromMovement: Boolean(creditLedger?.statedDiffers),
    claimedGstr3b: claimed,
    ledgerClosing: creditLedger ? ledgerClosing : null,
    difference: available ? difference : null,
    agrees: available ? TAX_HEAD_FIELDS.every((field) => difference[field] === 0) : null,
  };
}

export async function getSupplierChase({ firmId, runId }) {
  const run = await requireRun({ firmId, runId });
  const items = await ReconciliationItem.find({
    firmId,
    runId,
    ...requireActiveItemScope(run),
    "chase.required": true,
  })
    .sort({ supplierGstin: 1, booksSourceRow: 1 })
    .lean();
  const groups = new Map();
  for (const item of items) {
    const key = item.supplierGstin || "UNKNOWN";
    if (!groups.has(key)) {
      groups.set(key, {
        supplierGstin: key,
        period: run.period,
        itemIds: [],
        documentReferences: [],
        affectedTaxMinor: 0,
        states: {},
      });
    }
    const group = groups.get(key);
    group.itemIds.push(String(item._id));
    group.documentReferences.push(
      item.invoiceNumberOriginal ||
        item.invoiceNumberNormalized ||
        `row ${item.booksSourceRow}`,
    );
    group.affectedTaxMinor = addSafeIntegers([
      group.affectedTaxMinor,
      Number(item.booksAmounts?.totalTaxMinor || 0),
    ]);
    const state = item.chase?.state || "MARKED";
    group.states[state] = (group.states[state] || 0) + 1;
  }
  const suppliers = [...groups.values()].map((group) => ({
    ...group,
    deterministicMessage: `Please review ${group.documentReferences.length} document(s) for GSTIN ${group.supplierGstin} for period ${group.period}. Tax affected: INR ${formatMoneyMinor(group.affectedTaxMinor)}. Please share the correction or amendment status.`,
    deliveryEvidence: "ACTION_RECORDED_ONLY",
  }));
  return {
    suppliers,
    totalSuppliers: suppliers.length,
    totalItems: items.length,
  };
}

export async function lockReconciliationRun({
  firmId,
  runId,
  actorUserId,
  requestId = "",
}) {
  assertObjectId(actorUserId, "User");
  await assertGstStorageIndexes({ reconciliation: true });
  const current = await requireRun({ firmId, runId });
  if (current.status === "LOCKED") {
    return { run: serializeRun(current), replayed: true };
  }
  if (!["REVIEW", "LOCKING"].includes(current.status)) {
    throw serviceError("Run is not ready to lock", 409);
  }
  if (
    current.status === "REVIEW" &&
    current.summaryDirty &&
    !current.pendingReviewTransition?.operationId &&
    current.bulkReviewOperation?.state !== "PENDING"
  ) {
    const pendingItem = await ReconciliationItem.exists({
      firmId,
      runId,
      ...requireActiveItemScope(current),
      "pendingTransition.action": { $ne: null },
    });
    if (!pendingItem) {
      const recovery = await beginReviewMutation({ firmId, runId });
      let recoveryError = null;
      let recovered = false;
      try {
        await recomputeRunSummary({
          firmId,
          run: recovery.run,
          token: recovery.token,
          fence: recovery.fence,
          clearDirty: true,
        });
        recovered = true;
      } catch (error) {
        recoveryError = error;
        throw error;
      } finally {
        try {
          await endReviewMutation({
            firmId,
            runId,
            token: recovery.token,
            fence: recovery.fence,
            changed: recovered,
          });
        } catch (endError) {
          if (!recoveryError) throw endError;
          console.error(
            "[GST] Failed to release summary recovery mutation:",
            endError.message,
          );
        }
      }
      return lockReconciliationRun({ firmId, runId, actorUserId, requestId });
    }
  }
  if (
    current.summaryDirty ||
    current.pendingReviewTransition?.operationId ||
    current.bulkReviewOperation?.state === "PENDING"
  ) {
    throw serviceError(
      "Complete pending review finalization before locking reconciliation",
      409,
    );
  }
  const itemScope = requireActiveItemScope(current);
  const generationScope = requireGenerationItemScope(current);

  const lockToken = randomUUID();
  const locking = await ReconciliationRun.findOneAndUpdate(
    {
      _id: runId,
      firmId,
      activeGenerationAttempt: itemScope.generationAttempt,
      summaryDirty: false,
      "pendingReviewTransition.operationId": null,
      "bulkReviewOperation.state": { $ne: "PENDING" },
      $or: [
        {
          status: "REVIEW",
          $expr: {
            $or: [
              { $ne: ["$reviewMutationActive", true] },
              {
                $lte: [
                  { $ifNull: ["$reviewMutationExpiresAt", new Date(0)] },
                  "$$NOW",
                ],
              },
            ],
          },
        },
        {
          status: "LOCKING",
          $expr: {
            $lte: [{ $ifNull: ["$lockExpiresAt", new Date(0)] }, "$$NOW"],
          },
        },
      ],
    },
    [
      {
        $set: {
          status: "LOCKING",
          lockStartedAt: "$$NOW",
          lockToken,
          lockExpiresAt: { $add: ["$$NOW", RUN_LOCK_LEASE_MS] },
          reviewMutationActive: false,
          reviewMutationToken: null,
          reviewMutationExpiresAt: null,
          reviewMutationFence: {
            $add: [{ $ifNull: ["$reviewMutationFence", 0] }, 1],
          },
        },
      },
    ],
    { new: true },
  );
  if (!locking) {
    throw serviceError(
      "Run changed or another review/lock mutation is active; reload and retry",
      409,
    );
  }

  let locked = null;
  try {
    const invalidated = await ReconciliationItem.updateMany(
      {
        firmId,
        runId,
        ...generationScope,
      },
      {
        $set: {
          reviewMutationToken: null,
          reviewMutationExpiresAt: null,
          reviewMutationFence: Number(locking.reviewMutationFence),
        },
      },
    );
    if (Number(invalidated.matchedCount || 0) < 1) {
      const itemCount = await ReconciliationItem.countDocuments({
        firmId,
        runId,
        ...generationScope,
      });
      if (itemCount > 0) {
        throw serviceError("Review item fences could not be invalidated", 409);
      }
    }

    const pendingTransition = await ReconciliationItem.exists({
      firmId,
      runId,
      ...itemScope,
      "pendingTransition.action": { $ne: null },
    });
    if (pendingTransition) {
      throw serviceError(
        "Complete pending item transitions before locking reconciliation",
        409,
      );
    }

    const items = await ReconciliationItem.find({
      firmId,
      runId,
      ...itemScope,
    }).lean();
    const summary = summarizeReconciliationItems(items);
    if (summary.reviewCount > 0) {
      throw serviceError(
        "All exceptions require a resolving disposition before locking",
        409,
        {
          reviewCount: summary.reviewCount,
        },
      );
    }

    await recordActivity({
      firmId,
      actorUserId,
      source: "USER",
      action: "GST_RECONCILIATION_LOCK_REQUESTED",
      entityType: "ReconciliationRun",
      entityId: runId,
      requestId,
      beforeSummary: {
        status: current.status,
        reviewVersion: current.reviewVersion || 0,
      },
      afterSummary: { revision: locking.revision, summary },
    });

    locked = await ReconciliationRun.findOneAndUpdate(
      {
        _id: runId,
        firmId,
        status: "LOCKING",
        lockToken,
        reviewMutationFence: Number(locking.reviewMutationFence),
        summaryDirty: false,
        "pendingReviewTransition.operationId": null,
        "bulkReviewOperation.state": { $ne: "PENDING" },
        $expr: { $gt: ["$lockExpiresAt", "$$NOW"] },
      },
      {
        $set: {
          status: "LOCKED",
          summary,
          reviewer: actorUserId,
          lockedBy: actorUserId,
          reviewMutationActive: false,
          reviewMutationToken: null,
          reviewMutationExpiresAt: null,
          lockStartedAt: null,
          lockToken: null,
          lockExpiresAt: null,
        },
        $currentDate: {
          reviewedAt: true,
          lockedAt: true,
        },
      },
      { new: true, runValidators: true },
    );
    if (!locked)
      throw serviceError("Run changed before lock; reload and retry", 409);

    await safeRecordActivity({
      firmId,
      actorUserId,
      source: "USER",
      action: "GST_RECONCILIATION_LOCKED",
      entityType: "ReconciliationRun",
      entityId: runId,
      requestId,
      afterSummary: { revision: locked.revision, summary },
    });
    return { run: serializeRun(locked), replayed: false };
  } catch (error) {
    if (!locked) {
      await ReconciliationRun.updateOne(
        {
          _id: runId,
          firmId,
          status: "LOCKING",
          lockToken,
          reviewMutationFence: Number(locking.reviewMutationFence),
        },
        {
          $set: {
            status: "REVIEW",
            lockStartedAt: null,
            lockToken: null,
            lockExpiresAt: null,
          },
        },
      ).catch((resetError) => {
        console.error(
          "[GST] Failed to release reconciliation lock:",
          resetError.message,
        );
      });
    }
    throw error;
  }
}

function csvCell(value) {
  let text = String(value ?? "");
  if (/^[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export async function exportReconciliationRun({ firmId, runId }) {
  const run = await requireRun({ firmId, runId });
  if (run.status !== "LOCKED") {
    throw serviceError("Run must be locked before authoritative export", 409);
  }
  const items = await ReconciliationItem.find({
    firmId,
    runId,
    ...requireActiveItemScope(run),
  })
    .sort({ supplierGstin: 1, booksSourceRow: 1, portalSourceRow: 1 })
    .lean();
  const header = [
    "Item ID",
    "Status",
    "Supplier GSTIN",
    "Invoice Number",
    "Document Date",
    "Books Source Row",
    "2B Source Row",
    "Books Tax",
    "2B Tax",
    "Difference",
    "Disposition",
    "Reviewed",
  ];
  const lines = [header.map(csvCell).join(",")];
  for (const item of items) {
    lines.push(
      [
        item._id,
        item.status,
        item.supplierGstin,
        item.invoiceNumberOriginal,
        item.documentDate || "",
        item.booksSourceRow || "",
        item.portalSourceRow || "",
        formatMoneyMinor(Number(item.booksAmounts?.totalTaxMinor || 0)),
        formatMoneyMinor(Number(item.portalAmounts?.totalTaxMinor || 0)),
        formatMoneyMinor(Number(item.differences?.totalTaxMinor || 0)),
        item.userDisposition?.action || "",
        item.resolutionState === "RESOLVED" ||
        (!item.resolutionState &&
          item.status === "MATCHED" &&
          item.autoAccepted)
          ? "YES"
          : "NO",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  lines.push("");
  lines.push(["Displayed summary", "Count / INR"].map(csvCell).join(","));
  const summaryRows = [
    ["Total items", run.summary.totalItems],
    ["Matched", run.summary.matchedCount],
    ["Missing in 2B", run.summary.missingIn2bCount],
    ["Missing in books", run.summary.missingInBooksCount],
    ["Mismatches", run.summary.mismatchCount],
    ["Needs review", run.summary.reviewCount],
    [
      "Eligible ITC",
      formatMoneyMinor(Number(run.summary.eligible?.totalTaxMinor || 0)),
    ],
    [
      "Ineligible or blocked",
      formatMoneyMinor(Number(run.summary.ineligible?.totalTaxMinor || 0)),
    ],
    [
      "Deferred",
      formatMoneyMinor(Number(run.summary.deferred?.totalTaxMinor || 0)),
    ],
    [
      "Review value",
      formatMoneyMinor(Number(run.summary.reviewValueMinor || 0)),
    ],
  ];
  summaryRows.forEach((row) => lines.push(row.map(csvCell).join(",")));
  return {
    filename: `gst-reconciliation-${run.period}-r${run.revision}.csv`,
    content: `\uFEFF${lines.join("\r\n")}`,
    itemCount: items.length,
    summary: run.summary,
  };
}

export async function listReconciliationActivity({
  firmId,
  runId,
  limit = 100,
}) {
  await requireRun({ firmId, runId });
  const safeLimit = boundedInteger(limit, 100, 1, 200, "Limit");
  const events = await ActivityEvent.find({
    firmId,
    $or: [
      { entityType: "ReconciliationRun", entityId: String(runId) },
      { entityType: "ReconciliationItem", "metadata.runId": String(runId) },
    ],
  })
    .sort({ occurredAt: -1, _id: -1 })
    .limit(safeLimit)
    .lean();
  return events.map((event) => ({
    id: String(event._id),
    actorUserId: event.actorUserId ? String(event.actorUserId) : null,
    source: event.source,
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId,
    beforeSummary: event.beforeSummary,
    afterSummary: event.afterSummary,
    metadata: event.metadata,
    occurredAt: event.occurredAt,
  }));
}

export {
  BULK_ACTIONS,
  DEFAULT_DATE_TOLERANCE_DAYS,
  DEFAULT_ROUNDING_TOLERANCE_MINOR,
  GST_RECONCILIATION_JOB_KIND,
  MATCHING_CONFIG_VERSION,
  MAX_BULK_ITEMS,
  MAX_PAGE_SIZE,
  fingerprintForRun,
  serializeItem,
  serializeRun,
  serviceError,
};
