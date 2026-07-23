import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import mongoose from "mongoose";
import ActivityEvent from "../models/ActivityEvent.js";
import AppConfig from "../models/AppConfig.js";
import Client from "../models/Client.js";
import ImportBatch from "../models/ImportBatch.js";
import Task from "../models/Task.js";
import TdsHealthCheck, {
  TDS_CHECK_DIMENSIONS,
  TDS_CHECK_STATES,
  TDS_CHECK_STATUSES,
} from "../models/TdsHealthCheck.js";
import TdsHealthRun, { TDS_RUN_STATUSES } from "../models/TdsHealthRun.js";
import TdsHealthEvidenceLink from "../models/TdsHealthEvidenceLink.js";
import TdsImportRow, { TDS_IMPORT_KINDS } from "../models/TdsImportRow.js";
import User from "../models/User.js";
import { safeRecordActivity, sanitizeSummary } from "./activity.service.js";
import { enqueueJob } from "./automation-job.service.js";
import {
  HEALTH_RULE_VERSION,
  buildTdsHealthChecks,
} from "./tds-health-engine.service.js";
import {
  assertTdsHealthStorageReady,
  assertTdsReviewStorageReady,
} from "./tds-storage-readiness.service.js";
import { normalizeTdsContext } from "./tds-normalization.service.js";

const TDS_HEALTH_JOB_KIND = "TDS_HEALTH";
const MAX_PAGE_SIZE = 100;
const EVIDENCE_INSERT_CHUNK_SIZE = 1000;
const ACTION_PLAN_MAX_CHECKS = 100;
const ACTION_TOKEN_TTL_MS = 15 * 60 * 1000;
const PRIORITIES = Object.freeze(["LOW", "MEDIUM", "HIGH", "URGENT"]);
const RESOLUTION_ACTIONS = Object.freeze(["RESOLVE", "ACCEPT_REVIEW", "REOPEN"]);

function serviceError(message, statusCode = 400, details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (details) error.details = details;
  return error;
}

function assertObjectId(value, label) {
  if (!mongoose.isValidObjectId(value)) throw serviceError(`${label} ID is invalid`);
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < minimum) return fallback;
  return Math.min(parsed, maximum);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function hashCanonical(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function canonicalEvidenceRow(row) {
  return {
    rowId: String(row.rowId),
    batchId: String(row.batchId),
    kind: String(row.kind),
    sourceRow: Number(row.sourceRow),
    label: String(row.label),
  };
}

function sourceEvidenceHash(rows) {
  return hashCanonical(rows.map(canonicalEvidenceRow));
}

function deterministicActivityId({ firmId, action, batchId }) {
  return new mongoose.Types.ObjectId(
    hashCanonical({ firmId: String(firmId), action, batchId }).slice(0, 24)
  );
}

async function ensureTransactionalActivity({
  session,
  firmId,
  actorUserId = null,
  source,
  action,
  entityType,
  entityId,
  requestId = "",
  batchId,
  beforeSummary = null,
  afterSummary = null,
  metadata = {},
}) {
  const _id = deterministicActivityId({ firmId, action, batchId });
  const existing = await ActivityEvent.findById(_id).session(session).lean();
  if (existing) {
    if (
      String(existing.firmId) !== String(firmId) ||
      existing.action !== action ||
      existing.entityType !== entityType ||
      existing.entityId !== String(entityId) ||
      existing.batchId !== batchId
    ) {
      throw serviceError("TDS activity idempotency identity conflict", 409);
    }
    return existing;
  }
  const [created] = await ActivityEvent.create([{
    _id,
    firmId,
    actorUserId,
    source,
    action,
    entityType,
    entityId: String(entityId),
    requestId: String(requestId || "").slice(0, 160),
    batchId,
    beforeSummary: sanitizeSummary(beforeSummary),
    afterSummary: sanitizeSummary(afterSummary),
    metadata: sanitizeSummary(metadata),
  }], { session });
  return created;
}

function actionSecret() {
  const secret = process.env.TDS_ACTION_PLAN_SECRET || process.env.JWT_SECRET;
  if (!secret) throw serviceError("TDS action-plan signing is unavailable", 503);
  return secret;
}

function actionToken(fingerprint, expiresAt = Date.now() + ACTION_TOKEN_TTL_MS) {
  const signature = createHmac("sha256", actionSecret())
    .update(`${fingerprint}.${expiresAt}`)
    .digest("hex");
  return `${expiresAt}.${signature}`;
}

function actionTokenMatches(fingerprint, token) {
  const [expiresText, signature = ""] = String(token || "").split(".");
  const expiresAt = Number(expiresText);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || !/^[a-f0-9]{64}$/i.test(signature)) {
    return false;
  }
  const expected = createHmac("sha256", actionSecret())
    .update(`${fingerprint}.${expiresAt}`)
    .digest();
  const actual = Buffer.from(signature, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function realIsoDay(value) {
  const day = String(value || "").trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(day)) return false;
  const date = new Date(`${day}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === day;
}

function cleanText(value, maximum) {
  return String(value || "").trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, maximum);
}

async function freshTdsRolloutState(session = null) {
  let query = AppConfig.findById("singleton")
    .select("featureFlags.tdsHealth featureFlagVersions.tdsHealth")
    .lean();
  if (session) query = query.session(session);
  const config = await query;
  return {
    enabled: config?.featureFlags?.tdsHealth === true,
    version: Number.isInteger(config?.featureFlagVersions?.tdsHealth)
      ? config.featureFlagVersions.tdsHealth
      : 0,
  };
}

function publishedAttempt(run) {
  if (!["REVIEW", "LOCKED"].includes(run.status)) return null;
  return run.activeGenerationAttempt || null;
}

function requirePublishedAttempt(run) {
  const attempt = publishedAttempt(run);
  if (!attempt || run.checkVersion < 1) {
    throw serviceError("TDS health checks are not published for this run", 409);
  }
  return attempt;
}

async function assertRolloutFence({ rolloutVersion, publicationAttempt, session }) {
  const result = await AppConfig.collection.updateOne(
    {
      _id: "singleton",
      "featureFlags.tdsHealth": true,
      "featureFlagVersions.tdsHealth": rolloutVersion,
    },
    {
      $set: {
        "featureFlagPublicationFences.tdsHealth": publicationAttempt,
      },
    },
    { session }
  );
  if (result.matchedCount !== 1) {
    throw serviceError("TDS Health rollout changed before publication", 409);
  }
}

function sourceImportsPlain(sourceImports) {
  return {
    deductionsBatchId: String(sourceImports.deductionsBatchId),
    challansBatchId: String(sourceImports.challansBatchId),
    statementsBatchId: String(sourceImports.statementsBatchId),
    creditBatchId: sourceImports.creditBatchId ? String(sourceImports.creditBatchId) : null,
  };
}

function serializeRun(run, summaryOverride = null) {
  const sourceImports = sourceImportsPlain(run.sourceImports);
  return {
    id: String(run._id),
    clientId: String(run.clientId),
    tan: run.tan,
    financialYear: run.financialYear,
    quarter: run.quarter,
    statementType: run.statementType,
    status: run.status,
    revision: run.revision,
    rootRunId: run.rootRunId ? String(run.rootRunId) : String(run._id),
    parentRunId: run.parentRunId ? String(run.parentRunId) : null,
    correctionReason: run.correctionReason || "",
    sourceImports,
    hasImportedCredit: Boolean(sourceImports.creditBatchId),
    sourceFingerprint: run.sourceFingerprint,
    rolloutVersion: run.rolloutVersion,
    generationAttempt: run.activeGenerationAttempt || null,
    checksPublished: Boolean(publishedAttempt(run) && run.checkVersion > 0),
    checkVersion: run.checkVersion,
    summary: summaryOverride || run.summary,
    calculationPolicy: run.calculationPolicy,
    jobId: run.jobId ? String(run.jobId) : null,
    assignedTo: run.assignedTo ? String(run.assignedTo) : null,
    reviewedAt: run.reviewedAt,
    reviewedBy: run.reviewedBy ? String(run.reviewedBy) : null,
    lockedAt: run.lockedAt,
    lockedBy: run.lockedBy ? String(run.lockedBy) : null,
    lastError: run.lastError || "",
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function serializeCheck(check) {
  return {
    id: String(check._id),
    runId: String(check.runId),
    itemKey: check.itemKey,
    checkVersion: check.checkVersion,
    status: check.status,
    dimension: check.dimension,
    severity: check.severity,
    state: check.state,
    title: check.title,
    explanation: check.explanation,
    recommendedAction: check.recommendedAction,
    deducteePan: check.deducteePan || "",
    sectionCode: check.sectionCode || "",
    expectedMinor: check.expectedMinor,
    actualMinor: check.actualMinor,
    differenceMinor: check.differenceMinor,
    sourceRows: (check.sourceRows || []).map((row) => ({
      rowId: String(row.rowId),
      batchId: String(row.batchId),
      kind: row.kind,
      sourceRow: row.sourceRow,
      label: row.label,
    })),
    sourceEvidenceCount: check.sourceEvidenceCount,
    sourceEvidenceHash: check.sourceEvidenceHash,
    sourceEvidenceStorage: check.sourceEvidenceStorage,
    calculation: check.calculation,
    resolution: {
      version: check.resolution?.version || 0,
      action: check.resolution?.action || null,
      note: check.resolution?.note || "",
      resolvedAt: check.resolution?.resolvedAt || null,
      resolvedBy: check.resolution?.resolvedBy ? String(check.resolution.resolvedBy) : null,
    },
    panVerification: {
      method: check.panVerification?.method || null,
      status: check.panVerification?.status || null,
      sourceReference: check.panVerification?.sourceReference || "",
      verifiedAt: check.panVerification?.verifiedAt || null,
      verifiedBy: check.panVerification?.verifiedBy ? String(check.panVerification.verifiedBy) : null,
    },
    actionPlan: {
      taskId: check.actionPlan?.taskId ? String(check.actionPlan.taskId) : null,
      ownerUserId: check.actionPlan?.ownerUserId ? String(check.actionPlan.ownerUserId) : null,
      dueDateISO: check.actionPlan?.dueDateISO || "",
      priority: check.actionPlan?.priority || "",
      clientChaseMessage: check.actionPlan?.clientChaseMessage || "",
      deducteeFollowUp: check.actionPlan?.deducteeFollowUp || "",
      correctionChecklist: check.actionPlan?.correctionChecklist || [],
      reviewerNote: check.actionPlan?.reviewerNote || "",
      plannedAt: check.actionPlan?.plannedAt || null,
      plannedBy: check.actionPlan?.plannedBy ? String(check.actionPlan.plannedBy) : null,
    },
    createdAt: check.createdAt,
    updatedAt: check.updatedAt,
  };
}

function serializeRow(row) {
  return {
    id: String(row._id),
    batchId: String(row.batchId),
    kind: row.kind,
    sourceRow: row.sourceRow,
    sourceLabel: row.sourceLabel,
    deducteeName: row.deducteeName,
    deducteePan: row.deducteePan,
    sectionCode: row.sectionCode,
    transactionDate: row.transactionDate,
    amountPaidMinor: row.amountPaidMinor,
    deductedMinor: row.deductedMinor,
    surchargeMinor: row.surchargeMinor,
    cessMinor: row.cessMinor,
    bsrCode: row.bsrCode,
    challanSerial: row.challanSerial,
    challanDate: row.challanDate,
    depositedMinor: row.depositedMinor,
    filingStatus: row.filingStatus,
    statementReference: row.statementReference,
    filedDate: row.filedDate,
    reportedMinor: row.reportedMinor,
    correctionStatus: row.correctionStatus,
    correctionReference: row.correctionReference,
    certificateStatus: row.certificateStatus,
    certificateType: row.certificateType,
    creditDate: row.creditDate,
    creditedMinor: row.creditedMinor,
    sourceReference: row.sourceReference,
  };
}

async function requireActiveUser({ userId, firmId, label = "Owner", session = null }) {
  assertObjectId(userId, label);
  const user = await User.findOne({ _id: userId, firmId, isActive: true }).session(session).lean();
  if (!user) throw serviceError(`${label} is not an active member of this firm`, 422);
  return user;
}

async function requireClient({ clientId, firmId, tan, session = null }) {
  assertObjectId(clientId, "Client");
  const client = await Client.findOne({ _id: clientId, firmId, isActive: true })
    .select("name +tan")
    .session(session)
    .lean();
  if (!client) throw serviceError("Active client not found in active firm", 404);
  if (client.tan && client.tan !== tan) {
    throw serviceError("Selected TAN does not match the client's governed profile", 409);
  }
  return client;
}

async function loadBatch({ batchId, kind, firmId, clientId, context, session = null }) {
  assertObjectId(batchId, `${kind} batch`);
  const batch = await ImportBatch.findOne({
    _id: batchId,
    firmId,
    clientId,
    kind,
    status: "COMPLETED",
    tan: context.tan,
    financialYear: context.financialYear,
    quarter: context.quarter,
    statementType: context.statementType,
    activeImportGeneration: { $type: "string" },
  }).session(session).lean();
  if (!batch) throw serviceError(`${kind} batch is not a completed import for this TDS context`, 422);
  return batch;
}

async function loadRunBatches(run, session = null) {
  const context = {
    tan: run.tan,
    financialYear: run.financialYear,
    quarter: run.quarter,
    statementType: run.statementType,
  };
  const imports = sourceImportsPlain(run.sourceImports);
  const promises = [
    loadBatch({ batchId: imports.deductionsBatchId, kind: "TDS_DEDUCTIONS", firmId: run.firmId, clientId: run.clientId, context, session }),
    loadBatch({ batchId: imports.challansBatchId, kind: "TDS_CHALLANS", firmId: run.firmId, clientId: run.clientId, context, session }),
    loadBatch({ batchId: imports.statementsBatchId, kind: "TDS_STATEMENTS", firmId: run.firmId, clientId: run.clientId, context, session }),
  ];
  if (imports.creditBatchId) {
    promises.push(loadBatch({ batchId: imports.creditBatchId, kind: "TDS_26AS", firmId: run.firmId, clientId: run.clientId, context, session }));
  }
  return Promise.all(promises);
}

function sourceFingerprint(context, batches, rolloutVersion) {
  return hashCanonical({
    context,
    rolloutVersion,
    sources: batches.map((batch) => ({
      id: String(batch._id),
      kind: batch.kind,
      sourceHash: batch.sourceHash,
      importFingerprint: batch.importFingerprint,
      importGeneration: batch.activeImportGeneration,
    })),
    engineVersion: HEALTH_RULE_VERSION,
  });
}

async function createTdsHealthRun({
  firmId,
  actorUserId,
  requestId = "",
  clientId,
  tan,
  financialYear,
  quarter,
  statementType,
  deductionsBatchId,
  challansBatchId,
  statementsBatchId,
  creditBatchId = null,
  revisionOf = null,
  correctionReason = "",
  assignedTo = null,
}) {
  assertObjectId(firmId, "Firm");
  assertObjectId(actorUserId, "User");
  const context = normalizeTdsContext({ tan, financialYear, quarter, statementType });
  const rollout = await freshTdsRolloutState();
  if (!rollout.enabled) throw serviceError("TDS Health rollout is disabled", 404);
  await assertTdsHealthStorageReady({ firmId });
  await requireClient({ clientId, firmId, tan: context.tan });
  if (assignedTo) await requireActiveUser({ userId: assignedTo, firmId, label: "Assignee" });

  const ids = [deductionsBatchId, challansBatchId, statementsBatchId, creditBatchId]
    .filter(Boolean)
    .map(String);
  if (new Set(ids).size !== ids.length) {
    throw serviceError("Each TDS source must use a distinct import batch");
  }

  const sourceStub = {
    firmId,
    clientId,
    ...context,
    sourceImports: { deductionsBatchId, challansBatchId, statementsBatchId, creditBatchId },
  };
  const batches = await loadRunBatches(sourceStub);
  const fingerprint = sourceFingerprint(context, batches, rollout.version);

  let parent = null;
  let revision = 1;
  let rootRunId = null;
  const normalizedReason = cleanText(correctionReason, 500);
  if (revisionOf) {
    assertObjectId(revisionOf, "Parent run");
    parent = await TdsHealthRun.findOne({ _id: revisionOf, firmId }).lean();
    if (!parent) throw serviceError("Parent TDS health run not found", 404);
    if (parent.status !== "LOCKED") {
      throw serviceError("Only a locked run can create a correction revision", 409);
    }
    if (!normalizedReason) throw serviceError("Correction reason is required for a new revision");
    const sameContext = String(parent.clientId) === String(clientId) &&
      parent.tan === context.tan &&
      parent.financialYear === context.financialYear &&
      parent.quarter === context.quarter &&
      parent.statementType === context.statementType;
    if (!sameContext) {
      throw serviceError("Correction revision must keep the parent client and TDS context", 409);
    }
    revision = parent.revision + 1;
    rootRunId = parent.rootRunId || parent._id;
  } else if (normalizedReason) {
    throw serviceError("Correction reason is only valid with revisionOf");
  }

  const identity = parent
    ? { firmId, parentRunId: parent._id }
    : { firmId, sourceFingerprint: fingerprint, revision: 1 };
  let run = await TdsHealthRun.findOne(identity);
  let replayed = Boolean(run);
  if (!run) {
    try {
      run = await TdsHealthRun.create({
        firmId,
        clientId,
        ...context,
        sourceImports: { deductionsBatchId, challansBatchId, statementsBatchId, creditBatchId },
        sourceFingerprint: fingerprint,
        rootRunId,
        parentRunId: parent?._id || null,
        revision,
        correctionReason: normalizedReason,
        status: "QUEUED",
        rolloutVersion: rollout.version,
        generationAttempt: randomUUID(),
        calculationPolicy: {
          version: HEALTH_RULE_VERSION,
          sourceLabel: "Normalized user-imported TDS records",
          sourceReference: "Pending deterministic health generation; no statutory rate rules are applied.",
          estimate: true,
          professionalConfirmed: false,
          ratesApplied: false,
        },
        assignedTo: assignedTo || actorUserId,
        createdBy: actorUserId,
      });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      run = await TdsHealthRun.findOne(identity);
      if (!run) throw error;
      replayed = true;
    }
  }

  let recycledStaleRevision = false;
  if (
    run &&
    parent &&
    ["QUEUED", "FAILED"].includes(run.status) &&
    !run.activeGenerationAttempt &&
    run.checkVersion === 0 &&
    run.rolloutVersion !== rollout.version
  ) {
    const recycled = await TdsHealthRun.findOneAndUpdate(
      {
        _id: run._id,
        firmId,
        parentRunId: parent._id,
        status: { $in: ["QUEUED", "FAILED"] },
        activeGenerationAttempt: null,
        checkVersion: 0,
        rolloutVersion: run.rolloutVersion,
        generationAttempt: run.generationAttempt,
      },
      {
        $set: {
          sourceImports: {
            deductionsBatchId,
            challansBatchId,
            statementsBatchId,
            creditBatchId,
          },
          sourceFingerprint: fingerprint,
          rolloutVersion: rollout.version,
          generationAttempt: randomUUID(),
          correctionReason: normalizedReason,
          status: "QUEUED",
          jobId: null,
          assignedTo: assignedTo || actorUserId,
          lastError: "",
        },
      },
      { new: true, runValidators: true }
    );
    if (recycled) {
      run = recycled;
      replayed = false;
      recycledStaleRevision = true;
    } else {
      run = await TdsHealthRun.findOne(identity);
      if (!run) throw serviceError("Stale TDS revision changed concurrently", 409);
      replayed = true;
    }
  }

  if (
    run.sourceFingerprint !== fingerprint ||
    run.revision !== revision ||
    run.rolloutVersion !== rollout.version
  ) {
    throw serviceError("Existing revision is bound to different sources or rollout", 409);
  }

  let job;
  try {
    job = await enqueueJob({
      firmId,
      kind: TDS_HEALTH_JOB_KIND,
      idempotencyKey: `tds-health:${run._id}:revision:${run.revision}:rollout:${run.rolloutVersion}`,
      payload: {
        runId: String(run._id),
        rolloutVersion: run.rolloutVersion,
      },
      createdBy: actorUserId,
      requestId,
      maxAttempts: 8,
    });
    run = await TdsHealthRun.findOneAndUpdate(
      { _id: run._id, firmId, $or: [{ jobId: null }, { jobId: job._id }] },
      { $set: { jobId: job._id } },
      { new: true }
    );
    if (!run) throw serviceError("TDS run job binding changed concurrently", 409);
  } catch (error) {
    await TdsHealthRun.updateOne(
      { _id: run._id, firmId, status: "QUEUED", jobId: null },
      { $set: { status: "FAILED", lastError: cleanText(error.message, 600) } }
    ).catch(() => {});
    throw error;
  }

  if (!replayed) {
    await safeRecordActivity({
      firmId,
      actorUserId,
      source: "USER",
      action: recycledStaleRevision
        ? "TDS_HEALTH_STALE_REVISION_REQUEUED"
        : parent ? "TDS_HEALTH_REVISION_CREATED" : "TDS_HEALTH_RUN_CREATED",
      entityType: "TdsHealthRun",
      entityId: run._id,
      requestId,
      afterSummary: {
        clientId,
        ...context,
        revision,
        rolloutVersion: run.rolloutVersion,
        sourceFingerprint: fingerprint,
        sourceImports: sourceImportsPlain(run.sourceImports),
      },
    });
  }
  return { run: serializeRun(run), jobId: String(job._id), replayed };
}

async function rowsForBatch(batch) {
  return TdsImportRow.find({
    firmId: batch.firmId,
    clientId: batch.clientId,
    batchId: batch._id,
    kind: batch.kind,
    importGeneration: batch.activeImportGeneration,
  }).sort({ sourceRow: 1, _id: 1 }).lean();
}

async function persistGenerationAttempt({ run, generationAttempt, result }) {
  const checkVersion = Math.max(1, Number(run.checkVersion || 0) + 1);
  const manifests = result.checks.map((check) => {
    const evidence = check.sourceRows.map(canonicalEvidenceRow);
    return {
      check,
      evidence,
      sourceEvidenceHash: sourceEvidenceHash(evidence),
    };
  });
  const createdChecks = await TdsHealthCheck.insertMany(
    manifests.map(({ check, evidence, sourceEvidenceHash: evidenceHash }) => ({
      firmId: run.firmId,
      runId: run._id,
      clientId: run.clientId,
      generationAttempt,
      checkVersion,
      ...check,
      sourceRows: evidence.slice(0, 100),
      sourceEvidenceCount: evidence.length,
      sourceEvidenceHash: evidenceHash,
      sourceEvidenceStorage: "TdsHealthEvidenceLink",
    })),
    { ordered: true }
  );
  const checkIdsByItemKey = new Map(
    createdChecks.map((check) => [check.itemKey, check._id])
  );
  const evidenceDocuments = manifests.flatMap(({ check, evidence }) =>
    evidence.map((row, ordinal) => ({
      firmId: run.firmId,
      runId: run._id,
      checkId: checkIdsByItemKey.get(check.itemKey),
      clientId: run.clientId,
      generationAttempt,
      itemKey: check.itemKey,
      ordinal,
      ...row,
    }))
  );
  for (let offset = 0; offset < evidenceDocuments.length; offset += EVIDENCE_INSERT_CHUNK_SIZE) {
    await TdsHealthEvidenceLink.insertMany(
      evidenceDocuments.slice(offset, offset + EVIDENCE_INSERT_CHUNK_SIZE),
      { ordered: true }
    );
  }
  return {
    checkVersion,
    expectedCheckCount: createdChecks.length,
    expectedEvidenceCount: evidenceDocuments.length,
  };
}

async function verifyGenerationAttempt({
  run,
  generationAttempt,
  expectedCheckCount,
  expectedEvidenceCount,
  session = null,
}) {
  let checksQuery = TdsHealthCheck.find({
    firmId: run.firmId,
    runId: run._id,
    generationAttempt,
  }).sort({ itemKey: 1, _id: 1 });
  let evidenceQuery = TdsHealthEvidenceLink.find({
    firmId: run.firmId,
    runId: run._id,
    generationAttempt,
  }).sort({ checkId: 1, ordinal: 1, _id: 1 });
  if (session) {
    checksQuery = checksQuery.session(session);
    evidenceQuery = evidenceQuery.session(session);
  }
  const [checks, evidence] = await Promise.all([
    checksQuery.lean(),
    evidenceQuery.lean(),
  ]);
  if (checks.length !== expectedCheckCount || evidence.length !== expectedEvidenceCount) {
    throw serviceError("TDS generation evidence count verification failed", 409);
  }
  const evidenceByCheck = new Map();
  evidence.forEach((link) => {
    const key = String(link.checkId);
    if (!evidenceByCheck.has(key)) evidenceByCheck.set(key, []);
    evidenceByCheck.get(key).push(link);
  });
  for (const check of checks) {
    const links = evidenceByCheck.get(String(check._id)) || [];
    const ordinalsValid = links.every((link, index) => link.ordinal === index);
    const identitiesValid = links.every(
      (link) => link.itemKey === check.itemKey && String(link.clientId) === String(run.clientId)
    );
    if (
      links.length !== check.sourceEvidenceCount ||
      !ordinalsValid ||
      !identitiesValid ||
      sourceEvidenceHash(links) !== check.sourceEvidenceHash
    ) {
      throw serviceError(`TDS source evidence manifest failed for ${check.itemKey}`, 409);
    }
  }
  return checks;
}

async function processTdsHealthJob(job, { assertLease = async () => {} } = {}) {
  if (job.kind !== TDS_HEALTH_JOB_KIND) {
    throw new Error(`Unsupported TDS job kind: ${job.kind}`);
  }
  const runId = job.payload?.runId;
  assertObjectId(runId, "TDS run");
  let run = await TdsHealthRun.findOne({
    _id: runId,
    firmId: job.firmId,
    jobId: job._id,
  }).lean();
  if (!run) throw serviceError("TDS health run is missing or bound to another job", 404);
  if (["REVIEW", "LOCKED"].includes(run.status)) {
    requirePublishedAttempt(run);
    return { outcome: "ALREADY_GENERATED", runId: String(run._id), status: run.status };
  }
  if (run.statementType === "27EQ") {
    const reason = "27EQ/TCS generation is unavailable until collection, collectee, and Form 27D support is implemented";
    await TdsHealthRun.updateOne(
      {
        _id: run._id,
        firmId: job.firmId,
        jobId: job._id,
        status: { $in: ["QUEUED", "PROCESSING", "FAILED"] },
      },
      { $set: { status: "FAILED", lastError: reason } }
    );
    return {
      outcome: "TDS_27EQ_UNSUPPORTED",
      runId: String(run._id),
      status: "FAILED",
      reason,
    };
  }

  const rollout = await freshTdsRolloutState();
  if (!rollout.enabled) {
    return {
      defer: true,
      outcome: "TDS_HEALTH_ROLLOUT_DISABLED",
      reason: "TDS Health rollout is disabled",
    };
  }
  const payloadRolloutVersion = Number(job.payload?.rolloutVersion);
  if (
    !Number.isInteger(payloadRolloutVersion) ||
    payloadRolloutVersion !== run.rolloutVersion ||
    rollout.version !== run.rolloutVersion
  ) {
    await TdsHealthRun.updateOne(
      { _id: run._id, firmId: job.firmId, status: { $nin: ["REVIEW", "LOCKED"] } },
      { $set: { status: "FAILED", lastError: "TDS Health rollout version is stale" } }
    );
    return {
      outcome: "TDS_HEALTH_ROLLOUT_STALE",
      runId: String(run._id),
      rolloutVersion: run.rolloutVersion,
      currentRolloutVersion: rollout.version,
    };
  }

  await assertTdsReviewStorageReady({ firmId: job.firmId });
  await assertLease();
  const previousAttempt = run.generationAttempt;
  const generationAttempt = randomUUID();
  run = await TdsHealthRun.findOneAndUpdate(
    {
      _id: run._id,
      firmId: job.firmId,
      jobId: job._id,
      rolloutVersion: run.rolloutVersion,
      generationAttempt: previousAttempt,
      status: { $in: ["QUEUED", "PROCESSING", "FAILED"] },
    },
    {
      $set: {
        status: "PROCESSING",
        generationAttempt,
        lastError: "",
      },
    },
    { new: true, runValidators: true }
  ).lean();
  if (!run) throw serviceError("TDS run state changed before generation", 409);

  try {
    const batches = await loadRunBatches(run);
    await assertLease();
    const rowGroups = await Promise.all(batches.map(rowsForBatch));
    const rowsByKind = new Map(
      batches.map((batch, index) => [batch.kind, rowGroups[index]])
    );
    const result = buildTdsHealthChecks({
      deductions: rowsByKind.get("TDS_DEDUCTIONS") || [],
      challans: rowsByKind.get("TDS_CHALLANS") || [],
      statements: rowsByKind.get("TDS_STATEMENTS") || [],
      credits: rowsByKind.get("TDS_26AS") || [],
    });

    await assertLease();
    const persisted = await persistGenerationAttempt({
      run,
      generationAttempt,
      result,
    });
    await verifyGenerationAttempt({
      run,
      generationAttempt,
      expectedCheckCount: persisted.expectedCheckCount,
      expectedEvidenceCount: persisted.expectedEvidenceCount,
    });
    await assertLease();

    const session = await mongoose.startSession();
    let published;
    try {
      await session.withTransaction(async () => {
        await assertRolloutFence({
          rolloutVersion: run.rolloutVersion,
          publicationAttempt: generationAttempt,
          session,
        });
        const current = await TdsHealthRun.findOne({
          _id: run._id,
          firmId: run.firmId,
          jobId: job._id,
          rolloutVersion: run.rolloutVersion,
          generationAttempt,
          status: "PROCESSING",
        }).session(session).lean();
        if (!current) throw serviceError("TDS run publication fence was lost", 409);
        await verifyGenerationAttempt({
          run: current,
          generationAttempt,
          expectedCheckCount: persisted.expectedCheckCount,
          expectedEvidenceCount: persisted.expectedEvidenceCount,
          session,
        });
        published = await TdsHealthRun.findOneAndUpdate(
          {
            _id: current._id,
            firmId: current.firmId,
            jobId: job._id,
            rolloutVersion: current.rolloutVersion,
            generationAttempt,
            status: "PROCESSING",
          },
          {
            $set: {
              status: "REVIEW",
              activeGenerationAttempt: generationAttempt,
              checkVersion: persisted.checkVersion,
              summary: result.summary,
              calculationPolicy: result.calculationPolicy,
              lastError: "",
            },
          },
          { new: true, runValidators: true, session }
        ).lean();
        if (!published) throw serviceError("TDS run publication fence was lost", 409);
      });
    } finally {
      await session.endSession();
    }

    await Promise.all([
      TdsHealthCheck.deleteMany({
        firmId: run.firmId,
        runId: run._id,
        generationAttempt: { $ne: generationAttempt },
      }),
      TdsHealthEvidenceLink.deleteMany({
        firmId: run.firmId,
        runId: run._id,
        generationAttempt: { $ne: generationAttempt },
      }),
    ]).catch((error) => {
      console.error("[TDS] Failed to clean unpublished generation attempts:", error.message);
    });

    await safeRecordActivity({
      firmId: run.firmId,
      actorUserId: null,
      source: "AUTOMATION",
      action: "TDS_HEALTH_GENERATED",
      entityType: "TdsHealthRun",
      entityId: run._id,
      requestId: job.requestId,
      afterSummary: result.summary,
      metadata: {
        engineVersion: HEALTH_RULE_VERSION,
        generationAttempt,
        rolloutVersion: run.rolloutVersion,
        evidenceCount: persisted.expectedEvidenceCount,
      },
    });
    return {
      outcome: "TDS_HEALTH_GENERATED",
      runId: String(run._id),
      checkCount: result.checks.length,
      evidenceCount: persisted.expectedEvidenceCount,
      generationAttempt: published.activeGenerationAttempt,
      summary: result.summary,
    };
  } catch (error) {
    await TdsHealthRun.updateOne(
      {
        _id: run._id,
        firmId: run.firmId,
        jobId: job._id,
        generationAttempt,
        status: "PROCESSING",
      },
      { $set: { status: "FAILED", lastError: cleanText(error.message, 600) } }
    ).catch(() => {});
    throw error;
  }
}

async function stateCounts({ run, session = null }) {
  const generationAttempt = requirePublishedAttempt(run);
  let aggregation = TdsHealthCheck.aggregate([
    {
      $match: {
        firmId: run.firmId,
        runId: run._id,
        generationAttempt,
      },
    },
    { $group: { _id: "$state", count: { $sum: 1 } } },
  ]);
  if (session) aggregation = aggregation.session(session);
  const groups = await aggregation;
  const counts = Object.fromEntries(groups.map((group) => [group._id, group.count]));
  return {
    totalChecks: Object.values(counts).reduce((total, count) => total + count, 0),
    openChecks: counts.OPEN || 0,
    actionPlannedChecks: counts.ACTION_PLANNED || 0,
    resolvedChecks: (counts.RESOLVED || 0) + (counts.ACCEPTED || 0),
  };
}

async function refreshStoredStateCounts(run, session = null) {
  const generationAttempt = requirePublishedAttempt(run);
  const counts = await stateCounts({ run, session });
  const result = await TdsHealthRun.updateOne(
    {
      _id: run._id,
      firmId: run.firmId,
      status: "REVIEW",
      activeGenerationAttempt: generationAttempt,
    },
    {
      $set: {
        "summary.totalChecks": counts.totalChecks,
        "summary.openChecks": counts.openChecks,
        "summary.actionPlannedChecks": counts.actionPlannedChecks,
        "summary.resolvedChecks": counts.resolvedChecks,
      },
    },
    { session }
  );
  if (result.matchedCount !== 1) {
    throw serviceError("TDS run changed while refreshing review totals", 409);
  }
  return counts;
}

async function listTdsHealthRuns({ firmId, clientId, status, financialYear, quarter, statementType, page = 1, limit = 50 }) {
  assertObjectId(firmId, "Firm");
  const query = { firmId };
  if (clientId) {
    assertObjectId(clientId, "Client");
    query.clientId = clientId;
  }
  if (status) {
    const normalized = String(status).toUpperCase();
    if (!TDS_RUN_STATUSES.includes(normalized)) throw serviceError("Invalid TDS run status");
    query.status = normalized;
  }
  if (financialYear) query.financialYear = String(financialYear);
  if (quarter) query.quarter = String(quarter).toUpperCase();
  if (statementType) query.statementType = String(statementType).toUpperCase();
  const requestedPage = boundedInteger(page, 1, 1, 100000);
  const requestedLimit = boundedInteger(limit, 50, 1, MAX_PAGE_SIZE);
  const [runs, total] = await Promise.all([
    TdsHealthRun.find(query).sort({ createdAt: -1, _id: -1 }).skip((requestedPage - 1) * requestedLimit).limit(requestedLimit).lean(),
    TdsHealthRun.countDocuments(query),
  ]);
  return {
    runs: runs.map((run) => serializeRun(run)),
    pagination: { page: requestedPage, limit: requestedLimit, total, pages: Math.ceil(total / requestedLimit) },
  };
}

async function getTdsHealthRun({ firmId, runId }) {
  assertObjectId(firmId, "Firm");
  assertObjectId(runId, "TDS run");
  const run = await TdsHealthRun.findOne({ _id: runId, firmId }).lean();
  if (!run) throw serviceError("TDS health run not found", 404);
  let summary = run.summary;
  if (["REVIEW", "LOCKED"].includes(run.status)) {
    requirePublishedAttempt(run);
    const counts = await stateCounts({ run });
    summary = { ...run.summary, ...counts };
  }
  return serializeRun(run, summary);
}

async function listTdsHealthChecks({ firmId, runId, status, dimension, state, page = 1, limit = 100 }) {
  assertObjectId(runId, "TDS run");
  const run = await TdsHealthRun.findOne({ _id: runId, firmId }).lean();
  if (!run) throw serviceError("TDS health run not found", 404);
  const generationAttempt = requirePublishedAttempt(run);
  const query = { firmId, runId: run._id, generationAttempt };
  if (status) {
    const normalized = String(status).toUpperCase();
    if (!TDS_CHECK_STATUSES.includes(normalized)) throw serviceError("Invalid TDS check status");
    query.status = normalized;
  }
  if (dimension) {
    const normalized = String(dimension).toUpperCase();
    if (!TDS_CHECK_DIMENSIONS.includes(normalized)) throw serviceError("Invalid TDS check dimension");
    query.dimension = normalized;
  }
  if (state) {
    const normalized = String(state).toUpperCase();
    if (!TDS_CHECK_STATES.includes(normalized)) throw serviceError("Invalid TDS check state");
    query.state = normalized;
  }
  const requestedPage = boundedInteger(page, 1, 1, 100000);
  const requestedLimit = boundedInteger(limit, 100, 1, MAX_PAGE_SIZE);
  const [checks, total] = await Promise.all([
    TdsHealthCheck.find(query).sort({ severity: 1, dimension: 1, status: 1, _id: 1 }).skip((requestedPage - 1) * requestedLimit).limit(requestedLimit).lean(),
    TdsHealthCheck.countDocuments(query),
  ]);
  return {
    checks: checks.map(serializeCheck),
    pagination: { page: requestedPage, limit: requestedLimit, total, pages: Math.ceil(total / requestedLimit) },
  };
}

async function listTdsHealthEvidence({
  firmId,
  runId,
  checkId,
  page = 1,
  limit = 100,
}) {
  assertObjectId(firmId, "Firm");
  assertObjectId(runId, "TDS run");
  assertObjectId(checkId, "TDS check");
  const run = await TdsHealthRun.findOne({ _id: runId, firmId }).lean();
  if (!run) throw serviceError("TDS health run not found", 404);
  const generationAttempt = requirePublishedAttempt(run);
  const check = await TdsHealthCheck.findOne({
    _id: checkId,
    firmId,
    runId: run._id,
    generationAttempt,
  }).lean();
  if (!check) throw serviceError("TDS health check not found", 404);
  const requestedPage = boundedInteger(page, 1, 1, 100000);
  const requestedLimit = boundedInteger(limit, 100, 1, MAX_PAGE_SIZE);
  const query = {
    firmId,
    runId: run._id,
    checkId: check._id,
    generationAttempt,
  };
  const [links, total] = await Promise.all([
    TdsHealthEvidenceLink.find(query)
      .sort({ ordinal: 1, _id: 1 })
      .skip((requestedPage - 1) * requestedLimit)
      .limit(requestedLimit)
      .lean(),
    TdsHealthEvidenceLink.countDocuments(query),
  ]);
  if (total !== check.sourceEvidenceCount) {
    throw serviceError("TDS source evidence manifest count no longer matches", 409);
  }
  return {
    checkId: String(check._id),
    sourceEvidenceCount: check.sourceEvidenceCount,
    sourceEvidenceHash: check.sourceEvidenceHash,
    evidence: links.map((link) => ({
      ordinal: link.ordinal,
      ...canonicalEvidenceRow(link),
    })),
    pagination: {
      page: requestedPage,
      limit: requestedLimit,
      total,
      pages: Math.ceil(total / requestedLimit),
    },
  };
}

async function listTdsImportRows({ firmId, runId, kind, pan = "", page = 1, limit = 100 }) {
  assertObjectId(runId, "TDS run");
  const run = await TdsHealthRun.findOne({ _id: runId, firmId }).lean();
  if (!run) throw serviceError("TDS health run not found", 404);
  const normalizedKind = String(kind || "").toUpperCase();
  if (!TDS_IMPORT_KINDS.includes(normalizedKind)) throw serviceError("A valid TDS source kind is required");
  const batchField = {
    TDS_DEDUCTIONS: "deductionsBatchId",
    TDS_CHALLANS: "challansBatchId",
    TDS_STATEMENTS: "statementsBatchId",
    TDS_26AS: "creditBatchId",
  }[normalizedKind];
  const batchId = run.sourceImports?.[batchField];
  if (!batchId) return { rows: [], pagination: { page: 1, limit: boundedInteger(limit, 100, 1, MAX_PAGE_SIZE), total: 0, pages: 0 }, sourceAvailable: false };
  const batch = await ImportBatch.findOne({ _id: batchId, firmId, status: "COMPLETED" }).lean();
  if (!batch) throw serviceError("Source import is unavailable", 409);
  const query = { firmId, batchId, importGeneration: batch.activeImportGeneration, kind: normalizedKind };
  const normalizedPan = cleanText(pan, 20).toUpperCase();
  if (normalizedPan) query.deducteePan = normalizedPan;
  const requestedPage = boundedInteger(page, 1, 1, 100000);
  const requestedLimit = boundedInteger(limit, 100, 1, MAX_PAGE_SIZE);
  const [rows, total] = await Promise.all([
    TdsImportRow.find(query).sort({ sourceRow: 1, _id: 1 }).skip((requestedPage - 1) * requestedLimit).limit(requestedLimit).lean(),
    TdsImportRow.countDocuments(query),
  ]);
  return {
    rows: rows.map(serializeRow),
    pagination: { page: requestedPage, limit: requestedLimit, total, pages: Math.ceil(total / requestedLimit) },
    sourceAvailable: true,
    sourceLabel: batch.errorSummary?.sourceLabel || "User-imported TDS source",
  };
}

async function resolveTdsHealthCheck({
  firmId,
  runId,
  checkId,
  actorUserId,
  requestId = "",
  action,
  note,
  expectedResolutionVersion,
}) {
  assertObjectId(runId, "TDS run");
  assertObjectId(checkId, "TDS check");
  assertObjectId(actorUserId, "User");
  const normalizedAction = String(action || "").toUpperCase();
  if (!RESOLUTION_ACTIONS.includes(normalizedAction)) {
    throw serviceError("Invalid TDS check resolution action");
  }
  const normalizedNote = cleanText(note, 1000);
  if (!normalizedNote) throw serviceError("Resolution note is required");
  if (!Number.isInteger(expectedResolutionVersion) || expectedResolutionVersion < 0) {
    throw serviceError("Expected resolution version is required");
  }
  await assertTdsReviewStorageReady({ firmId });
  const session = await mongoose.startSession();
  let savedCheck;
  try {
    await session.withTransaction(async () => {
      const run = await TdsHealthRun.findOne({
        _id: runId,
        firmId,
        status: "REVIEW",
      }).session(session).lean();
      if (!run) throw serviceError("Review-state TDS run not found", 404);
      const generationAttempt = requirePublishedAttempt(run);
      const current = await TdsHealthCheck.findOne({
        _id: checkId,
        firmId,
        runId: run._id,
        generationAttempt,
      }).session(session).lean();
      if (!current) throw serviceError("TDS health check not found", 404);
      if (
        current.status === "PAN_PORTAL_VERIFICATION_PENDING" &&
        current.panVerification?.status !== "VERIFIED" &&
        normalizedAction !== "REOPEN"
      ) {
        throw serviceError(
          "Pending or failed official PAN verification cannot be resolved by generic disposition",
          409
        );
      }
      if (normalizedAction === "REOPEN" && current.actionPlan?.taskId) {
        throw serviceError("A check with a linked action task cannot be reopened here", 409);
      }
      const allowedStates = normalizedAction === "REOPEN"
        ? ["RESOLVED", "ACCEPTED"]
        : ["OPEN", "RESOLVED", "ACCEPTED"];
      if (!allowedStates.includes(current.state)) {
        throw serviceError("Check state does not allow this transition", 409);
      }
      const nextState = normalizedAction === "REOPEN"
        ? "OPEN"
        : normalizedAction === "ACCEPT_REVIEW" ? "ACCEPTED" : "RESOLVED";
      const now = new Date();
      savedCheck = await TdsHealthCheck.findOneAndUpdate(
        {
          _id: current._id,
          firmId,
          runId: run._id,
          generationAttempt,
          state: current.state,
          "resolution.version": expectedResolutionVersion,
        },
        {
          $set: {
            state: nextState,
            "resolution.action": normalizedAction,
            "resolution.note": normalizedNote,
            "resolution.resolvedAt": normalizedAction === "REOPEN" ? null : now,
            "resolution.resolvedBy": normalizedAction === "REOPEN" ? null : actorUserId,
          },
          $inc: { "resolution.version": 1 },
        },
        { new: true, runValidators: true, session }
      ).lean();
      if (!savedCheck) throw serviceError("TDS check changed; reload before saving", 409);
      await refreshStoredStateCounts(run, session);
      await ensureTransactionalActivity({
        session,
        firmId,
        actorUserId,
        source: "USER",
        action: `TDS_CHECK_${normalizedAction}`,
        entityType: "TdsHealthRun",
        entityId: run._id,
        requestId,
        batchId: `tds-check:${savedCheck._id}:resolution:${savedCheck.resolution.version}`,
        beforeSummary: {
          checkId,
          state: current.state,
          resolutionVersion: expectedResolutionVersion,
        },
        afterSummary: {
          checkId,
          state: nextState,
          resolutionVersion: savedCheck.resolution.version,
        },
      });
    });
  } finally {
    await session.endSession();
  }
  return { check: serializeCheck(savedCheck) };
}

async function recordPanVerification({
  firmId,
  runId,
  checkId,
  actorUserId,
  requestId = "",
  status,
  sourceReference,
  note = "",
  expectedResolutionVersion,
}) {
  assertObjectId(runId, "TDS run");
  assertObjectId(checkId, "TDS check");
  assertObjectId(actorUserId, "User");
  const normalizedStatus = String(status || "").toUpperCase();
  if (!["VERIFIED", "FAILED"].includes(normalizedStatus)) {
    throw serviceError("PAN verification status must be VERIFIED or FAILED");
  }
  const normalizedReference = cleanText(sourceReference, 1000);
  if (!normalizedReference) {
    throw serviceError("Official verification source reference is required");
  }
  const normalizedNote = cleanText(note, 1000) ||
    `Manual official portal result recorded: ${normalizedStatus}`;
  if (!Number.isInteger(expectedResolutionVersion) || expectedResolutionVersion < 0) {
    throw serviceError("Expected resolution version is required");
  }
  await assertTdsReviewStorageReady({ firmId });
  const session = await mongoose.startSession();
  let savedCheck;
  try {
    await session.withTransaction(async () => {
      const run = await TdsHealthRun.findOne({
        _id: runId,
        firmId,
        status: "REVIEW",
      }).session(session).lean();
      if (!run) throw serviceError("Review-state TDS run not found", 404);
      const generationAttempt = requirePublishedAttempt(run);
      const now = new Date();
      const verified = normalizedStatus === "VERIFIED";
      savedCheck = await TdsHealthCheck.findOneAndUpdate(
        {
          _id: checkId,
          firmId,
          runId: run._id,
          generationAttempt,
          status: "PAN_PORTAL_VERIFICATION_PENDING",
          state: "OPEN",
          "resolution.version": expectedResolutionVersion,
        },
        {
          $set: {
            state: verified ? "RESOLVED" : "OPEN",
            "panVerification.method": "MANUAL_OFFICIAL_PORTAL_RECORD",
            "panVerification.status": normalizedStatus,
            "panVerification.sourceReference": normalizedReference,
            "panVerification.verifiedAt": now,
            "panVerification.verifiedBy": actorUserId,
            "resolution.action": verified ? "RESOLVE" : null,
            "resolution.note": normalizedNote,
            "resolution.resolvedAt": verified ? now : null,
            "resolution.resolvedBy": verified ? actorUserId : null,
          },
          $inc: { "resolution.version": 1 },
        },
        { new: true, runValidators: true, session }
      ).lean();
      if (!savedCheck) {
        throw serviceError("PAN check changed or is not pending; reload before saving", 409);
      }
      await refreshStoredStateCounts(run, session);
      await ensureTransactionalActivity({
        session,
        firmId,
        actorUserId,
        source: "USER",
        action: "TDS_PAN_OFFICIAL_RESULT_RECORDED",
        entityType: "TdsHealthRun",
        entityId: run._id,
        requestId,
        batchId: `tds-pan:${savedCheck._id}:resolution:${savedCheck.resolution.version}`,
        afterSummary: {
          checkId: String(savedCheck._id),
          pan: savedCheck.deducteePan,
          status: normalizedStatus,
          method: "MANUAL_OFFICIAL_PORTAL_RECORD",
          verifiedAt: now,
          reviewBlocking: !verified,
        },
      });
    });
  } finally {
    await session.endSession();
  }
  return { check: serializeCheck(savedCheck) };
}

function checklistForStatus(status) {
  if (["CORRECTION_REQUIRED", "DEDUCTION_NOT_REPORTED", "REPORTED_NOT_IN_REGISTER"].includes(status)) {
    return ["Confirm source-linked difference", "Prepare correction working", "Reviewer approves correction", "Record acknowledgment"];
  }
  if (["DEPOSIT_MISSING", "SHORT_DEPOSIT_ESTIMATE", "EXCESS_DEPOSIT_REVIEW", "CHALLAN_UNMAPPED"].includes(status)) {
    return ["Review ITNS 281 source row", "Confirm section and quarter mapping", "Professional confirms treatment", "Record follow-up evidence"];
  }
  if (["PAN_MISSING", "PAN_FORMAT_INVALID", "PAN_PORTAL_VERIFICATION_PENDING"].includes(status)) {
    return ["Obtain PAN evidence", "Run authorized official check manually", "Record source, actor, and time", "Review filing impact"];
  }
  if (status === "CERTIFICATE_PENDING") {
    return ["Confirm statement status", "Generate applicable Form 16/16A", "Issue certificate", "Record issue evidence"];
  }
  return ["Review linked source rows", "Confirm professional treatment", "Complete follow-up", "Record reviewer note"];
}

function planForCheck({ run, check, ownerUserId, dueDateISO, priority, reviewerNote }) {
  const period = `${run.financialYear} ${run.quarter} ${run.statementType}`;
  return {
    checkId: String(check._id),
    itemKey: check.itemKey,
    status: check.status,
    dimension: check.dimension,
    checkVersion: check.checkVersion,
    resolutionVersion: check.resolution?.version || 0,
    taskTitle: `TDS ${check.title} - ${period}`.slice(0, 240),
    ownerUserId: String(ownerUserId),
    dueDateISO,
    priority,
    clientChaseMessage: `Please provide or confirm records for TDS ${period}: ${check.title}. This message records a follow-up request, not delivery or professional confirmation.`.slice(0, 1000),
    deducteeFollowUp: check.deducteePan
      ? `Follow up for deductee PAN ${check.deducteePan} using linked source rows; do not describe local format checking as official verification.`
      : "Review whether deductee-specific follow-up is required from linked source rows.",
    correctionChecklist: checklistForStatus(check.status),
    reviewerNote,
    generationKey: `tds-action:${run._id}:${check.itemKey}:v${check.checkVersion}`.slice(0, 200),
  };
}

async function buildActionPlan({
  firmId,
  runId,
  checkIds,
  ownerUserId,
  dueDateISO,
  priority,
  reviewerNote = "",
  session = null,
}) {
  assertObjectId(runId, "TDS run");
  if (!Array.isArray(checkIds) || checkIds.length < 1 || checkIds.length > ACTION_PLAN_MAX_CHECKS) {
    throw serviceError(`Action plan requires 1 to ${ACTION_PLAN_MAX_CHECKS} check IDs`);
  }
  const uniqueIds = [...new Set(checkIds.map(String))];
  if (uniqueIds.length !== checkIds.length || uniqueIds.some((id) => !mongoose.isValidObjectId(id))) {
    throw serviceError("Action-plan check IDs must be unique valid IDs");
  }
  if (!realIsoDay(dueDateISO)) throw serviceError("Action-plan due date must be a real ISO date");
  const normalizedPriority = String(priority || "").toUpperCase();
  if (!PRIORITIES.includes(normalizedPriority)) throw serviceError("Action-plan priority is invalid");
  const normalizedNote = cleanText(reviewerNote, 1000);
  await requireActiveUser({ userId: ownerUserId, firmId, label: "Action owner", session });
  const run = await TdsHealthRun.findOne({ _id: runId, firmId }).session(session).lean();
  if (!run) throw serviceError("TDS health run not found", 404);
  if (run.status !== "REVIEW") {
    throw serviceError("Action plans can only be created during review", 409);
  }
  const generationAttempt = requirePublishedAttempt(run);
  const checks = await TdsHealthCheck.find({
    _id: { $in: uniqueIds },
    firmId,
    runId: run._id,
    generationAttempt,
    state: { $in: ["OPEN", "ACTION_PLANNED"] },
  }).session(session).lean();
  if (checks.length !== uniqueIds.length) {
    throw serviceError("One or more checks changed or cannot receive an action plan", 409);
  }
  if (checks.some(
    (check) => check.status === "PAN_PORTAL_VERIFICATION_PENDING" &&
      check.panVerification?.status === "FAILED"
  )) {
    throw serviceError(
      "A failed official PAN verification remains review-blocking and cannot be action-planned",
      409
    );
  }
  const checkById = new Map(checks.map((check) => [String(check._id), check]));
  const orderedChecks = uniqueIds.map((id) => checkById.get(id));
  const plan = orderedChecks.map((check) => planForCheck({
    run,
    check,
    ownerUserId,
    dueDateISO,
    priority: normalizedPriority,
    reviewerNote: normalizedNote,
  }));
  for (let index = 0; index < orderedChecks.length; index += 1) {
    const check = orderedChecks[index];
    if (check.state !== "ACTION_PLANNED") continue;
    const planned = check.actionPlan || {};
    const expected = plan[index];
    if (
      String(planned.ownerUserId || "") !== expected.ownerUserId ||
      planned.dueDateISO !== expected.dueDateISO ||
      planned.priority !== expected.priority ||
      (planned.reviewerNote || "") !== expected.reviewerNote
    ) {
      throw serviceError("An existing action plan uses different owner, date, priority, or reviewer note", 409);
    }
  }
  const fingerprint = hashCanonical({
    runId: String(run._id),
    generationAttempt,
    checkVersion: run.checkVersion,
    plan: plan.map(({ checkId, itemKey, checkVersion, resolutionVersion, ownerUserId: owner, dueDateISO: due, priority: level, reviewerNote: note }) => ({
      checkId, itemKey, checkVersion, resolutionVersion, ownerUserId: owner, dueDateISO: due, priority: level, reviewerNote: note,
    })),
  });
  return { run, checks: orderedChecks, plan, fingerprint };
}

async function previewTdsActionPlan(input) {
  const built = await buildActionPlan(input);
  return {
    plan: built.plan,
    planFingerprint: built.fingerprint,
    commitToken: actionToken(built.fingerprint),
    expiresInSeconds: ACTION_TOKEN_TTL_MS / 1000,
  };
}

async function getTdsActionPlan({ firmId, runId, page = 1, limit = 100 }) {
  assertObjectId(runId, "TDS run");
  const run = await TdsHealthRun.findOne({ _id: runId, firmId }).lean();
  if (!run) throw serviceError("TDS health run not found", 404);
  const generationAttempt = requirePublishedAttempt(run);
  const requestedPage = boundedInteger(page, 1, 1, 100000);
  const requestedLimit = boundedInteger(limit, 100, 1, MAX_PAGE_SIZE);
  const query = {
    firmId,
    runId: run._id,
    generationAttempt,
    state: { $in: ["OPEN", "ACTION_PLANNED"] },
  };
  const [checks, total] = await Promise.all([
    TdsHealthCheck.find(query)
      .sort({ severity: 1, dimension: 1, status: 1, _id: 1 })
      .skip((requestedPage - 1) * requestedLimit)
      .limit(requestedLimit)
      .lean(),
    TdsHealthCheck.countDocuments(query),
  ]);
  return {
    run: serializeRun(run),
    items: checks.map((check) => ({
      check: serializeCheck(check),
      suggestedChecklist: checklistForStatus(check.status),
      taskCreated: Boolean(check.actionPlan?.taskId),
    })),
    pagination: {
      page: requestedPage,
      limit: requestedLimit,
      total,
      pages: Math.ceil(total / requestedLimit),
    },
  };
}

async function commitTdsActionPlan({
  firmId,
  runId,
  checkIds,
  ownerUserId,
  dueDateISO,
  priority,
  reviewerNote = "",
  previewToken,
  actorUserId,
  requestId = "",
}) {
  assertObjectId(actorUserId, "User");
  await assertTdsReviewStorageReady({ firmId });
  const initial = await buildActionPlan({
    firmId,
    runId,
    checkIds,
    ownerUserId,
    dueDateISO,
    priority,
    reviewerNote,
  });
  if (!actionTokenMatches(initial.fingerprint, previewToken)) {
    throw serviceError("Action-plan inputs or checks changed after preview; preview again", 409);
  }
  let replayed = false;
  const session = await mongoose.startSession();
  let taskIds = [];
  try {
    await session.withTransaction(async () => {
      const built = await buildActionPlan({
        firmId,
        runId,
        checkIds,
        ownerUserId,
        dueDateISO,
        priority,
        reviewerNote,
        session,
      });
      if (built.fingerprint !== initial.fingerprint) {
        throw serviceError("Action-plan checks changed during commit", 409);
      }
      replayed = built.checks.every(
        (check) => check.state === "ACTION_PLANNED" && check.actionPlan?.taskId
      );
      const client = await requireClient({
        clientId: built.run.clientId,
        firmId,
        tan: built.run.tan,
        session,
      });
      const generationAttempt = requirePublishedAttempt(built.run);
      const attemptTaskIds = [];
      for (let index = 0; index < built.checks.length; index += 1) {
        const check = built.checks[index];
        const plan = built.plan[index];
        let task;
        if (check.state === "ACTION_PLANNED" && check.actionPlan?.taskId) {
          task = await Task.findOne({
            _id: check.actionPlan.taskId,
            firmId,
            generationKey: plan.generationKey,
          }).session(session).lean();
          if (!task) throw serviceError("Linked TDS action task is missing", 409);
        } else {
          task = await Task.findOneAndUpdate(
            { firmId, generationKey: plan.generationKey },
            {
              $setOnInsert: {
                firmId,
                createdBy: actorUserId,
                clientName: client.name,
                serviceType: "TDS",
                title: plan.taskTitle,
                dueDateISO: plan.dueDateISO,
                assignedTo: ownerUserId,
                status: "NOT_STARTED",
                isActive: true,
                source: "RECONCILIATION",
                clientId: built.run.clientId,
                period: `${built.run.financialYear}-${built.run.quarter}`,
                generationKey: plan.generationKey,
                automationJobId: built.run.jobId,
                meta: {
                  priority: plan.priority,
                  tdsHealthRunId: String(built.run._id),
                  tdsHealthCheckId: plan.checkId,
                  exceptionStatus: plan.status,
                  dimension: plan.dimension,
                  clientChaseMessage: plan.clientChaseMessage,
                  deducteeFollowUp: plan.deducteeFollowUp,
                  correctionChecklist: plan.correctionChecklist,
                  reviewerNote: plan.reviewerNote,
                  sourceEvidenceCount: check.sourceEvidenceCount,
                  sourceEvidenceHash: check.sourceEvidenceHash,
                  sourceRows: check.sourceRows.map((row) => ({
                    rowId: String(row.rowId),
                    batchId: String(row.batchId),
                    kind: row.kind,
                    sourceRow: row.sourceRow,
                  })),
                },
              },
            },
            { upsert: true, new: true, setDefaultsOnInsert: true, session }
          ).lean();
          const updated = await TdsHealthCheck.updateOne(
            {
              _id: check._id,
              firmId,
              runId: built.run._id,
              generationAttempt,
              state: "OPEN",
              "resolution.version": plan.resolutionVersion,
            },
            {
              $set: {
                state: "ACTION_PLANNED",
                "actionPlan.taskId": task._id,
                "actionPlan.ownerUserId": ownerUserId,
                "actionPlan.dueDateISO": plan.dueDateISO,
                "actionPlan.priority": plan.priority,
                "actionPlan.clientChaseMessage": plan.clientChaseMessage,
                "actionPlan.deducteeFollowUp": plan.deducteeFollowUp,
                "actionPlan.correctionChecklist": plan.correctionChecklist,
                "actionPlan.reviewerNote": plan.reviewerNote,
                "actionPlan.plannedAt": new Date(),
                "actionPlan.plannedBy": actorUserId,
              },
            },
            { session, runValidators: true }
          );
          if (updated.matchedCount !== 1) {
            throw serviceError("TDS check changed during action-plan commit", 409);
          }
        }
        attemptTaskIds.push(String(task._id));
      }
      await refreshStoredStateCounts(built.run, session);
      await ensureTransactionalActivity({
        session,
        firmId,
        actorUserId,
        source: "USER",
        action: "TDS_ACTION_PLAN_COMMITTED",
        entityType: "TdsHealthRun",
        entityId: built.run._id,
        requestId,
        batchId: `tds-action-plan:${built.fingerprint}`,
        afterSummary: {
          checkIds: built.plan.map((entry) => entry.checkId),
          taskIds: attemptTaskIds,
          ownerUserId,
          dueDateISO,
          priority: built.plan[0]?.priority || "",
        },
      });
      taskIds = attemptTaskIds;
    });
  } finally {
    await session.endSession();
  }
  return { taskIds, plannedCount: taskIds.length, replayed };
}

async function lockTdsHealthRun({ firmId, runId, actorUserId, requestId = "" }) {
  assertObjectId(runId, "TDS run");
  assertObjectId(actorUserId, "User");
  await assertTdsReviewStorageReady({ firmId });
  const session = await mongoose.startSession();
  let lockedRun;
  let replayed = false;
  try {
    await session.withTransaction(async () => {
      const run = await TdsHealthRun.findOne({ _id: runId, firmId })
        .session(session)
        .lean();
      if (!run) throw serviceError("TDS health run not found", 404);
      if (run.status === "LOCKED") {
        requirePublishedAttempt(run);
        lockedRun = run;
        replayed = true;
        return;
      }
      if (run.status !== "REVIEW") {
        throw serviceError("Only a review-state run can be locked", 409);
      }
      const generationAttempt = requirePublishedAttempt(run);
      const counts = await stateCounts({ run, session });
      const failedPanChecks = await TdsHealthCheck.countDocuments({
        firmId,
        runId: run._id,
        generationAttempt,
        status: "PAN_PORTAL_VERIFICATION_PENDING",
        "panVerification.status": "FAILED",
      }).session(session);
      if (failedPanChecks > 0) {
        throw serviceError(
          `${failedPanChecks} failed official PAN verification(s) still block lock`,
          409
        );
      }
      if (counts.openChecks > 0) {
        throw serviceError(
          `${counts.openChecks} health check(s) still require resolution or an action plan`,
          409
        );
      }
      const now = new Date();
      lockedRun = await TdsHealthRun.findOneAndUpdate(
        {
          _id: run._id,
          firmId,
          status: "REVIEW",
          activeGenerationAttempt: generationAttempt,
        },
        {
          $set: {
            status: "LOCKED",
            "summary.totalChecks": counts.totalChecks,
            "summary.openChecks": counts.openChecks,
            "summary.actionPlannedChecks": counts.actionPlannedChecks,
            "summary.resolvedChecks": counts.resolvedChecks,
            reviewedAt: now,
            reviewedBy: actorUserId,
            lockedAt: now,
            lockedBy: actorUserId,
          },
        },
        { new: true, runValidators: true, session }
      ).lean();
      if (!lockedRun) throw serviceError("TDS run changed before lock", 409);
      await ensureTransactionalActivity({
        session,
        firmId,
        actorUserId,
        source: "USER",
        action: "TDS_HEALTH_RUN_LOCKED",
        entityType: "TdsHealthRun",
        entityId: run._id,
        requestId,
        batchId: `tds-lock:${run._id}:revision:${run.revision}`,
        afterSummary: {
          revision: run.revision,
          summary: lockedRun.summary,
          professionalConfirmed: false,
        },
      });
    });
  } finally {
    await session.endSession();
  }
  return { run: serializeRun(lockedRun), replayed };
}

function csvCell(value) {
  const isText = typeof value === "string";
  let text = value == null ? "" : String(value);
  if (isText && /^[\s]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

async function exportTdsHealthRun({ firmId, runId }) {
  assertObjectId(runId, "TDS run");
  const run = await TdsHealthRun.findOne({ _id: runId, firmId }).lean();
  if (!run) throw serviceError("TDS health run not found", 404);
  if (run.status !== "LOCKED") {
    throw serviceError("Authoritative export requires a locked reviewed revision", 409);
  }
  const generationAttempt = requirePublishedAttempt(run);
  const checks = await TdsHealthCheck.find({
    firmId,
    runId: run._id,
    generationAttempt,
  }).sort({ dimension: 1, status: 1, _id: 1 }).lean();
  const evidence = await TdsHealthEvidenceLink.find({
    firmId,
    runId: run._id,
    generationAttempt,
  }).sort({ checkId: 1, ordinal: 1, _id: 1 }).lean();
  const evidenceByCheck = new Map();
  evidence.forEach((link) => {
    const key = String(link.checkId);
    if (!evidenceByCheck.has(key)) evidenceByCheck.set(key, []);
    evidenceByCheck.get(key).push(link);
  });
  checks.forEach((check) => {
    const links = evidenceByCheck.get(String(check._id)) || [];
    const validOrdinals = links.every((link, index) => link.ordinal === index);
    if (
      links.length !== check.sourceEvidenceCount ||
      !validOrdinals ||
      sourceEvidenceHash(links) !== check.sourceEvidenceHash
    ) {
      throw serviceError(`TDS export evidence manifest failed for ${check.itemKey}`, 409);
    }
  });

  const header = [
    "row_type", "run_id", "revision", "client_id", "tan", "financial_year", "quarter", "statement_type",
    "status", "dimension", "state", "deductee_pan", "section", "expected_minor", "actual_minor", "difference_minor",
    "estimate", "professional_confirmed", "rule_version", "source_label", "credit_import_state",
    "source_evidence_count", "source_evidence_hash", "source_rows", "pan_verification_method",
    "pan_verification_status", "pan_source_reference", "pan_verified_by", "pan_verified_at", "task_id", "resolution_note",
  ];
  const rows = [header];
  const summary = run.summary || {};
  const creditImportState = run.sourceImports?.creditBatchId ? "PROVIDED" : "NOT_PROVIDED";
  const summaryRows = [
    ["DEDUCTED", summary.deductedMinor || 0],
    ["DEPOSITED", summary.depositedMinor || 0],
    ["REPORTED", summary.reportedMinor || 0],
    ...(creditImportState === "PROVIDED"
      ? [["IMPORTED_CREDIT", summary.importedCreditMinor || 0]]
      : [["IMPORTED_CREDIT_NOT_PROVIDED", null]]),
    ["ESTIMATED_GAP", summary.estimatedGapMinor || 0],
  ];
  summaryRows.forEach(([label, amount]) => {
    const amountAvailable = amount != null;
    rows.push([
      "SUMMARY", String(run._id), run.revision, String(run.clientId), run.tan, run.financialYear, run.quarter, run.statementType,
      label, "SUMMARY", "LOCKED", "", "",
      amountAvailable ? amount : "", amountAvailable ? 0 : "", amountAvailable ? amount : "",
      true, false, run.calculationPolicy.version, run.calculationPolicy.sourceLabel, creditImportState,
      "", "", "", "", "", "", "", "", "",
      label === "IMPORTED_CREDIT_NOT_PROVIDED"
        ? "Optional 26AS/TRACES source was not provided; no imported-credit amount is asserted"
        : "Estimate; professional confirmation not recorded",
    ]);
  });
  checks.forEach((check) => {
    const links = evidenceByCheck.get(String(check._id)) || [];
    rows.push([
      "CHECK", String(run._id), run.revision, String(run.clientId), run.tan, run.financialYear, run.quarter, run.statementType,
      check.status, check.dimension, check.state, check.deducteePan, check.sectionCode,
      check.expectedMinor, check.actualMinor, check.differenceMinor,
      check.calculation.estimate, check.calculation.professionalConfirmed, check.calculation.ruleVersion, check.calculation.sourceLabel,
      creditImportState, check.sourceEvidenceCount, check.sourceEvidenceHash,
      links.map((row) => `${row.kind}:${row.sourceRow}:${row.rowId}`).join("|"),
      check.panVerification?.method || "", check.panVerification?.status || "",
      check.panVerification?.sourceReference || "",
      check.panVerification?.verifiedBy ? String(check.panVerification.verifiedBy) : "",
      check.panVerification?.verifiedAt ? new Date(check.panVerification.verifiedAt).toISOString() : "",
      check.actionPlan?.taskId ? String(check.actionPlan.taskId) : "",
      check.resolution?.note || "",
    ]);
  });
  return {
    filename: `tds-health-${run.financialYear}-${run.quarter}-${run.statementType}-r${run.revision}.csv`,
    content: `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`,
    checkCount: checks.length,
    evidenceCount: evidence.length,
  };
}

async function listTdsHealthHistory({ firmId, runId, limit = 100 }) {
  assertObjectId(runId, "TDS run");
  const run = await TdsHealthRun.findOne({ _id: runId, firmId }).lean();
  if (!run) throw serviceError("TDS health run not found", 404);
  const rootId = run.rootRunId || run._id;
  const revisions = await TdsHealthRun.find({
    firmId,
    $or: [{ _id: rootId }, { rootRunId: rootId }],
  }).sort({ revision: 1 }).lean();
  const runIds = revisions.map((entry) => String(entry._id));
  const events = await ActivityEvent.find({
    firmId,
    entityType: "TdsHealthRun",
    entityId: { $in: runIds },
  }).sort({ occurredAt: -1, _id: -1 }).limit(boundedInteger(limit, 100, 1, MAX_PAGE_SIZE)).lean();
  return {
    revisions: revisions.map((entry) => serializeRun(entry)),
    activity: events.map((event) => ({
      id: String(event._id),
      action: event.action,
      source: event.source,
      entityId: event.entityId,
      actorUserId: event.actorUserId ? String(event.actorUserId) : null,
      occurredAt: event.occurredAt,
      metadata: event.metadata,
      afterSummary: event.afterSummary,
    })),
  };
}

export {
  ACTION_PLAN_MAX_CHECKS,
  ACTION_TOKEN_TTL_MS,
  MAX_PAGE_SIZE,
  TDS_HEALTH_JOB_KIND,
  commitTdsActionPlan,
  createTdsHealthRun,
  exportTdsHealthRun,
  getTdsActionPlan,
  getTdsHealthRun,
  listTdsHealthChecks,
  listTdsHealthEvidence,
  listTdsHealthHistory,
  listTdsHealthRuns,
  listTdsImportRows,
  lockTdsHealthRun,
  previewTdsActionPlan,
  processTdsHealthJob,
  recordPanVerification,
  resolveTdsHealthCheck,
  serializeCheck,
  serializeRun,
};
