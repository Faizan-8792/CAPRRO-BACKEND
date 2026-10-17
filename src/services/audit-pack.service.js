// src/services/audit-pack.service.js
//
// W10 AP6 + AP8 (2026-10-15): audit pack runs - created from a client's completed imports,
// computed by the automation worker, reviewed and decided by people - and the party master the
// decisions keep.
//
// LIFECYCLE
//   create  -> QUEUED, with a source fingerprint over the exact batches and their generations; the
//              same batches give the same run back (idempotent), never a second copy
//   worker  -> PROCESSING: the engine's rows are written under a fresh generation attempt, the
//              written counts and evidence are verified, and only then is the run published to
//              REVIEW with that attempt as its active one. A reader only ever reads the active
//              attempt, so a half-written run is never visible.
//   people  -> decide rows (version-fenced), and set supplier statuses in the party master
//   read    -> the clause's figures are recomputed from rows and decisions every time
//
// THE CEILING. Nothing here files, uploads, locks or concludes. A run cannot be "completed" by the
// system; the figures say provisional until people have decided every row.

import { createHash, randomUUID } from "node:crypto";
import mongoose from "mongoose";
import AuditPackRun, { AUDIT_PACK_KINDS } from "../models/AuditPackRun.js";
import AuditPackRow from "../models/AuditPackRow.js";
import AuditPackEvidenceLink from "../models/AuditPackEvidenceLink.js";
import BooksImportRow from "../models/BooksImportRow.js";
import Client from "../models/Client.js";
import ImportBatch from "../models/ImportBatch.js";
import ImportRow from "../models/ImportRow.js";
import PartyMaster, { PARTY_GST_STATUSES } from "../models/PartyMaster.js";
import { enqueueJob } from "./automation-job.service.js";
import { safeRecordActivity } from "./activity.service.js";
import {
  CLAUSE44_RULE_VERSION,
  LEDGER_TREATMENTS,
  buildClause44Rows,
  effectiveRow,
  financialYearMonths,
  summarizeClause44,
} from "./audit-pack-engine/clause44.engine.js";
import { looksLikePredefinedGroup } from "./books-normalization.service.js";
import { allCreateFields, getPackKind } from "./audit-pack-kinds/index.js";

export const AUDIT_PACK_JOB_KIND = "AUDIT_PACK";

const MAX_SOURCE_BATCHES = 24;
const MAX_SOURCE_ROWS = 200_000;
const WRITE_CHUNK = 1_000;
const ROW_PAGE_MAX = 100;
const RUN_PAGE_MAX = 50;

function httpError(statusCode, message, code = "") {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

function objectId(value, label) {
  if (!mongoose.isValidObjectId(value)) throw httpError(400, `${label} is not a valid id`);
  return new mongoose.Types.ObjectId(String(value));
}

function assertAllowed(input, allowed, label) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw httpError(400, `${label} must be an object`);
  const extra = Object.keys(input).filter((key) => !allowed.has(key));
  if (extra.length) throw httpError(400, `${label} does not accept: ${extra.join(", ")}`);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function financialYearOf(value) {
  const text = String(value || "").trim();
  try {
    financialYearMonths(text);
  } catch {
    throw httpError(400, "Choose a financial year like 2025-26.", "AUDIT_PACK_SOURCE_REFUSED");
  }
  return text;
}

// ─── serialization ──────────────────────────────────────────────────────

function serializeRun(run, summary = null) {
  const generic = getPackKind(run.kind);
  return {
    sections: generic ? generic.sections : undefined,
    params: generic ? run.params || {} : undefined,
    id: String(run._id),
    clientId: String(run.clientId),
    kind: run.kind,
    financialYear: run.financialYear,
    status: run.status,
    revision: run.revision,
    ruleVersion: run.ruleVersion,
    rowCount: run.rowCount,
    monthsLoaded: run.monthsLoaded || [],
    monthsMissing: run.monthsMissing || [],
    sourceBatches: (run.sourceBatches || []).map((batch) => ({
      batchId: String(batch.batchId),
      kind: batch.kind,
      period: batch.period || "",
    })),
    lastError: run.lastError || "",
    createdAt: run.createdAt,
    publishedAt: run.publishedAt,
    summary,
  };
}

function serializeRow(raw, kind = "CLAUSE44") {
  const generic = getPackKind(kind);
  const overlay = generic ? generic.effectiveRow : effectiveRow;
  const row = overlay({
    section: raw.section,
    values: raw.values || {},
    state: raw.state,
    decidable: raw.decidable,
    decision: raw.decision?.state
      ? { state: raw.decision.state, treatment: raw.decision.treatment || "", status: raw.decision.status || "", choice: raw.decision.choice || "" }
      : null,
  });
  return {
    ...(generic ? { lines: generic.displayLines(row), choices: generic.choicesFor(row) } : {}),
    rowKey: raw.rowKey,
    section: raw.section,
    label: raw.label,
    party: { gstin: raw.party?.gstin || "" },
    values: row.values,
    computedValues: raw.values || {},
    ruleHits: (raw.ruleHits || []).map((h) => ({ rule: h.rule, threshold: h.threshold ?? null, detail: h.detail || "" })),
    state: row.state,
    computedState: raw.state,
    decidable: Boolean(raw.decidable),
    sourceRows: (raw.sourceRows || []).map((s) => ({ kind: s.kind, batchId: s.batchId, rowId: s.rowId, sourceRow: s.sourceRow })),
    sourceEvidenceCount: raw.sourceEvidenceCount || 0,
    decision: {
      version: raw.decision?.version || 0,
      state: raw.decision?.state || null,
      treatment: raw.decision?.treatment || "",
      status: raw.decision?.status || "",
      choice: raw.decision?.choice || "",
      reason: raw.decision?.reason || "",
      note: raw.decision?.note || "",
      decidedBy: raw.decision?.decidedBy ? String(raw.decision.decidedBy) : null,
      decidedAt: raw.decision?.decidedAt || null,
    },
  };
}

function engineRowFromStored(raw) {
  return {
    section: raw.section,
    rowKey: raw.rowKey,
    label: raw.label,
    party: raw.party,
    values: raw.values || {},
    state: raw.state,
    decidable: raw.decidable,
    decision: raw.decision?.state
      ? { state: raw.decision.state, treatment: raw.decision.treatment || undefined, status: raw.decision.status || undefined, choice: raw.decision.choice || undefined }
      : null,
  };
}

// ─── sources ────────────────────────────────────────────────────────────

async function requireClient(firmId, clientId) {
  const client = await Client.findOne({ _id: objectId(clientId, "Client"), firmId, isActive: true })
    .select("_id name gstin")
    .lean();
  if (!client) throw httpError(404, "That client is not in this firm.");
  return client;
}

function batchPeriodMonths(batch, frequency) {
  const period = String(batch.period || "");
  if (!/^\d{4}-\d{2}$/.test(period)) return [];
  if (frequency !== "QUARTERLY") return [period];
  // A quarterly filer's GSTR-2B (2BQ) covers the quarter ending in this month.
  const [year, month] = period.split("-").map(Number);
  if (![3, 6, 9, 12].includes(month)) return [period];
  return [month - 2, month - 1, month].map((m) => `${year}-${String(m).padStart(2, "0")}`);
}

async function loadSourceBatches({ firmId, clientId, ids, kind, label }) {
  const unique = [...new Set(ids.map(String))];
  if (unique.length !== ids.length) throw httpError(400, `The same ${label} batch was chosen twice.`);
  const batches = await ImportBatch.find({
    _id: { $in: unique.map((id) => objectId(id, `${label} batch`)) },
    firmId,
  }).lean();
  if (batches.length !== unique.length) throw httpError(404, `A chosen ${label} import is not in this firm.`);
  for (const batch of batches) {
    if (batch.kind !== kind) throw httpError(400, `A chosen ${label} import is a ${batch.kind} import.`);
    if (batch.status !== "COMPLETED" || !batch.activeImportGeneration) {
      throw httpError(409, `A chosen ${label} import has not finished importing.`, "AUDIT_PACK_SOURCE_NOT_READY");
    }
    if (String(batch.clientId || "") !== String(clientId)) {
      throw httpError(400, `A chosen ${label} import belongs to another client.`);
    }
  }
  return batches;
}

const CREATE_FIELDS = new Set([
  "kind", "clientId", "financialYear", "trialBalanceBatchId", "purchaseBatchIds", "gstr2bBatchIds", "gstr2bFrequency",
]);
const BASE_CREATE_FIELDS = new Set(["kind", "clientId", "financialYear"]);

export async function createAuditPackRun({ firmId, actorUserId, requestId = "", input, rolloutVersion = 0 }) {
  assertAllowed(input, new Set([...CREATE_FIELDS, ...allCreateFields()]), "An audit pack");
  const kind = String(input.kind || "CLAUSE44").toUpperCase();
  if (!AUDIT_PACK_KINDS.includes(kind)) throw httpError(400, "That pack does not exist.");
  const generic = getPackKind(kind);
  if (!generic && kind !== "CLAUSE44") throw httpError(400, "That pack is not available yet.");
  assertAllowed(input, generic ? new Set([...BASE_CREATE_FIELDS, ...generic.createFields]) : CREATE_FIELDS, generic ? generic.label : "An audit pack");
  const client = await requireClient(firmId, input.clientId);
  const financialYear = financialYearOf(input.financialYear);
  if (generic) {
    const prepared = await generic.prepare({
      firmId,
      client,
      financialYear,
      input,
      helpers: { loadSourceBatches, httpError, objectId },
    });
    const sourceBatches = prepared.batches
      .map((batch) => ({ batchId: batch._id, kind: batch.kind, importGeneration: batch.activeImportGeneration, sourceHash: batch.sourceHash, period: batch.period || "" }))
      .sort((a, b) => `${a.kind}:${a.batchId}`.localeCompare(`${b.kind}:${b.batchId}`));
    return persistRun({
      firmId, actorUserId, requestId, rolloutVersion, client, kind, financialYear,
      ruleVersion: generic.ruleVersion,
      sourceBatches,
      fingerprintParts: { kind, financialYear, ruleVersion: generic.ruleVersion, params: prepared.params, batches: sourceBatches.map((b) => ({ ...b, batchId: String(b.batchId) })) },
      params: prepared.params,
      jobPayload: {},
    });
  }
  const frequency = String(input.gstr2bFrequency || "MONTHLY").toUpperCase();
  if (!["MONTHLY", "QUARTERLY"].includes(frequency)) throw httpError(400, "GSTR-2B frequency is MONTHLY or QUARTERLY.");
  const purchaseIds = Array.isArray(input.purchaseBatchIds) ? input.purchaseBatchIds : [];
  const gstr2bIds = Array.isArray(input.gstr2bBatchIds) ? input.gstr2bBatchIds : [];
  if (purchaseIds.length > MAX_SOURCE_BATCHES || gstr2bIds.length > MAX_SOURCE_BATCHES) {
    throw httpError(400, `Choose at most ${MAX_SOURCE_BATCHES} imports of each kind.`);
  }
  if (!input.trialBalanceBatchId) throw httpError(400, "Choose the client's trial balance for the year.", "AUDIT_PACK_SOURCE_REFUSED");

  const [trialBalance] = await loadSourceBatches({ firmId, clientId: client._id, ids: [input.trialBalanceBatchId], kind: "TRIAL_BALANCE", label: "trial balance" });
  if (trialBalance.financialYear !== financialYear) {
    throw httpError(400, `The chosen trial balance is for ${trialBalance.financialYear}, not ${financialYear}.`, "AUDIT_PACK_SOURCE_REFUSED");
  }
  const purchases = await loadSourceBatches({ firmId, clientId: client._id, ids: purchaseIds, kind: "GST_PURCHASE", label: "purchase register" });
  const gstr2b = await loadSourceBatches({ firmId, clientId: client._id, ids: gstr2bIds, kind: "GSTR2B", label: "GSTR-2B" });

  const sourceBatches = [trialBalance, ...purchases, ...gstr2b]
    .map((batch) => ({
      batchId: batch._id,
      kind: batch.kind,
      importGeneration: batch.activeImportGeneration,
      sourceHash: batch.sourceHash,
      period: batch.period || "",
    }))
    .sort((a, b) => `${a.kind}:${a.batchId}`.localeCompare(`${b.kind}:${b.batchId}`));
  return persistRun({
    firmId, actorUserId, requestId, rolloutVersion, client, kind, financialYear,
    ruleVersion: CLAUSE44_RULE_VERSION,
    sourceBatches,
    fingerprintParts: {
      kind,
      financialYear,
      frequency,
      ruleVersion: CLAUSE44_RULE_VERSION,
      batches: sourceBatches.map((b) => ({ ...b, batchId: String(b.batchId) })),
    },
    params: {},
    jobPayload: { frequency },
  });
}

// One run per (firm, kind, source fingerprint): the same inputs return the run that already exists.
async function persistRun({ firmId, actorUserId, requestId, rolloutVersion, client, kind, financialYear, ruleVersion, sourceBatches, fingerprintParts, params, jobPayload }) {
  const sourceFingerprint = createHash("sha256").update(JSON.stringify(canonical(fingerprintParts))).digest("hex");
  const identity = { firmId, kind, sourceFingerprint, revision: 1 };
  let run = await AuditPackRun.findOne(identity);
  if (run) return { run: serializeRun(run), replayed: true };
  try {
    run = await AuditPackRun.create({
      ...identity,
      clientId: client._id,
      financialYear,
      sourceBatches,
      ruleVersion,
      params,
      status: "QUEUED",
      rolloutVersion,
      createdBy: actorUserId,
      monthsLoaded: [],
      monthsMissing: [],
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    run = await AuditPackRun.findOne(identity);
    if (!run) throw error;
    return { run: serializeRun(run), replayed: true };
  }
  const job = await enqueueJob({
    firmId,
    kind: AUDIT_PACK_JOB_KIND,
    idempotencyKey: `audit-pack:${run._id}:revision:1`,
    payload: { runId: String(run._id), ...jobPayload },
    createdBy: actorUserId,
    requestId,
  });
  run = await AuditPackRun.findOneAndUpdate({ _id: run._id, firmId }, { $set: { jobId: job._id } }, { new: true });
  await safeRecordActivity({
    firmId,
    actorUserId,
    source: "USER",
    action: "AUDIT_PACK_RUN_CREATED",
    entityType: "AuditPackRun",
    entityId: run._id,
    requestId,
    afterSummary: { kind, clientId: client._id, financialYear, sourceBatchCount: sourceBatches.length },
  });
  return { run: serializeRun(run), replayed: false };
}

// ─── the worker ───────────────────────────────────────────────────────────

async function readRows(Model, filter, projection) {
  return Model.find(filter).select(projection).lean();
}

async function computeClause44(run, job, assertLease) {
  const frequency = String(job?.payload?.frequency || "MONTHLY").toUpperCase();
  const byKind = (kind) => run.sourceBatches.filter((b) => b.kind === kind);
  const tbBatch = byKind("TRIAL_BALANCE")[0];
  const generationFilter = (batch) => ({ firmId: run.firmId, batchId: batch.batchId, importGeneration: batch.importGeneration });

  const trialBalanceRows = tbBatch
    ? await readRows(BooksImportRow, generationFilter(tbBatch), "_id batchId sourceRow ledgerName groupName openingMinor hasOpening debitTotalMinor creditTotalMinor hasTransactionTotals closingMinor")
    : [];
  await assertLease();
  const purchaseRows = [];
  for (const batch of byKind("GST_PURCHASE")) {
    purchaseRows.push(...await readRows(ImportRow, generationFilter(batch), "_id batchId sourceRow supplierGstin documentDate documentType taxableValueMinor igstMinor cgstMinor sgstMinor cessMinor reverseCharge"));
  }
  await assertLease();
  const gstr2bRows = [];
  const gstr2bMonths = [];
  for (const batch of byKind("GSTR2B")) {
    const months = batchPeriodMonths(batch, frequency);
    gstr2bMonths.push(...months);
    const rows = await readRows(ImportRow, generationFilter(batch), "_id batchId sourceRow supplierGstin documentDate documentType taxableValueMinor igstMinor cgstMinor sgstMinor cessMinor");
    // A quarterly statement lists each document once, under its quarter's last month.
    gstr2bRows.push(...rows.map((row) => ({ ...row, period: batch.period })));
  }
  const sourceRowCount = trialBalanceRows.length + purchaseRows.length + gstr2bRows.length;
  if (sourceRowCount > MAX_SOURCE_ROWS) {
    throw httpError(413, `These imports hold ${sourceRowCount} rows; an audit pack reads at most ${MAX_SOURCE_ROWS}.`, "AUDIT_PACK_TOO_LARGE");
  }

  // AP6: every supplier this run sees has a party-master row; a person's answer is never touched.
  const gstins = [...new Set(purchaseRows.map((r) => String(r.supplierGstin || "").toUpperCase()).filter(Boolean))];
  if (gstins.length) {
    await PartyMaster.bulkWrite(gstins.map((gstin) => ({
      updateOne: {
        filter: { firmId: run.firmId, clientId: run.clientId, gstin },
        update: { $setOnInsert: { firmId: run.firmId, clientId: run.clientId, gstin, gstStatus: "UNKNOWN" } },
        upsert: true,
      },
    })), { ordered: false });
  }
  const parties = await PartyMaster.find({
    firmId: run.firmId,
    clientId: run.clientId,
    confirmedBy: { $ne: null },
    gstStatus: { $in: ["REGISTERED", "COMPOSITION", "EXEMPT_SUPPLIER"] },
  }).select("gstin gstStatus").lean();

  const idOf = (row) => ({ ...row, rowId: String(row._id), batchId: String(row.batchId) });
  return buildClause44Rows({
    financialYear: run.financialYear,
    trialBalance: trialBalanceRows.map((row) => idOf({ ...row, looksLikeGroupTotal: !row.groupName && looksLikePredefinedGroup(row.ledgerName) })),
    purchases: purchaseRows.map(idOf),
    gstr2b: gstr2bRows.map(idOf),
    gstr2bMonths,
    parties: parties.map((p) => ({ gstin: p.gstin, gstStatus: p.gstStatus })),
  });
}

// A generic pack reads through this: the same 200,000-row ceiling the Clause 44 worker holds itself to.
function countingReader() {
  let total = 0;
  return async (Model, filter, projection) => {
    const rows = await readRows(Model, filter, projection);
    total += rows.length;
    if (total > MAX_SOURCE_ROWS) {
      throw httpError(413, `These imports hold more than ${MAX_SOURCE_ROWS} rows; an audit pack reads at most ${MAX_SOURCE_ROWS}.`, "AUDIT_PACK_TOO_LARGE");
    }
    return rows;
  };
}

export async function processAuditPackJob(job, { assertLease = async () => {} } = {}) {
  const runId = job?.payload?.runId;
  if (!mongoose.isValidObjectId(runId)) return { outcome: "INVALID_PAYLOAD" };
  const run = await AuditPackRun.findOne({ _id: runId, firmId: job.firmId }).lean();
  if (!run) return { outcome: "RUN_NOT_FOUND" };
  if (run.status === "REVIEW") return { outcome: "ALREADY_PUBLISHED", runId: String(run._id) };

  const attempt = randomUUID();
  const claimed = await AuditPackRun.findOneAndUpdate(
    { _id: run._id, firmId: run.firmId, status: { $in: ["QUEUED", "PROCESSING", "FAILED"] } },
    { $set: { status: "PROCESSING", generationAttempt: attempt, lastError: "" } },
    { new: true },
  );
  if (!claimed) return { outcome: "NOT_CLAIMABLE" };

  try {
    const generic = getPackKind(run.kind);
    const built = generic
      ? await generic.compute({ run, readRows: countingReader(), assertLease, batchPeriodMonths })
      : await computeClause44(run, job, assertLease);
    await assertLease();

    const documents = built.rows.map((row, ordinal) => ({
      firmId: run.firmId,
      runId: run._id,
      generationAttempt: attempt,
      ordinal,
      section: row.section,
      rowKey: row.rowKey,
      label: String(row.label).slice(0, 300),
      party: { gstin: row.party?.gstin || "" },
      values: row.values,
      ruleHits: row.ruleHits,
      state: row.state,
      decidable: row.decidable,
      sourceRows: row.sourceRows,
      sourceEvidenceCount: row.sourceEvidenceCount,
      sourceEvidenceHash: row.sourceEvidenceHash,
      decision: { version: 0 },
    }));
    for (let i = 0; i < documents.length; i += WRITE_CHUNK) {
      await AuditPackRow.insertMany(documents.slice(i, i + WRITE_CHUNK), { ordered: true });
      await assertLease();
    }
    const links = built.rows.flatMap((row) => row.allSources.map((source, ordinal) => ({
      firmId: run.firmId,
      runId: run._id,
      generationAttempt: attempt,
      rowKey: row.rowKey,
      ordinal,
      kind: source.kind,
      batchId: source.batchId,
      rowId: source.rowId,
      sourceRow: source.sourceRow || 0,
    })));
    for (let i = 0; i < links.length; i += WRITE_CHUNK) {
      await AuditPackEvidenceLink.insertMany(links.slice(i, i + WRITE_CHUNK), { ordered: true });
      await assertLease();
    }

    // Verify before publishing: exactly what the engine produced, nothing more, nothing less.
    const [writtenRows, writtenLinks] = await Promise.all([
      AuditPackRow.countDocuments({ firmId: run.firmId, runId: run._id, generationAttempt: attempt }),
      AuditPackEvidenceLink.countDocuments({ firmId: run.firmId, runId: run._id, generationAttempt: attempt }),
    ]);
    if (writtenRows !== documents.length || writtenLinks !== links.length) {
      throw httpError(500, `The pack wrote ${writtenRows} of ${documents.length} rows and ${writtenLinks} of ${links.length} evidence links.`);
    }

    const published = await AuditPackRun.findOneAndUpdate(
      { _id: run._id, firmId: run.firmId, status: "PROCESSING", generationAttempt: attempt },
      {
        $set: {
          status: "REVIEW",
          activeGenerationAttempt: attempt,
          rowCount: documents.length,
          monthsLoaded: built.monthsLoaded,
          monthsMissing: built.monthsMissing,
          publishedAt: new Date(),
          lastError: "",
        },
      },
      { new: true },
    );
    if (!published) throw httpError(409, "Another worker took this pack over before it was published.");

    // Earlier attempts of this run are never read again.
    await Promise.all([
      AuditPackRow.deleteMany({ firmId: run.firmId, runId: run._id, generationAttempt: { $ne: attempt } }),
      AuditPackEvidenceLink.deleteMany({ firmId: run.firmId, runId: run._id, generationAttempt: { $ne: attempt } }),
    ]).catch(() => {});
    return { outcome: "PUBLISHED", runId: String(run._id), rowCount: documents.length };
  } catch (error) {
    await Promise.all([
      AuditPackRow.deleteMany({ firmId: run.firmId, runId: run._id, generationAttempt: attempt }),
      AuditPackEvidenceLink.deleteMany({ firmId: run.firmId, runId: run._id, generationAttempt: attempt }),
    ]).catch(() => {});
    await AuditPackRun.updateOne(
      { _id: run._id, firmId: run.firmId, generationAttempt: attempt },
      {
        $set: {
          status: "FAILED",
          lastError: error?.statusCode && error.statusCode < 500
            ? String(error.message).slice(0, 600)
            : "The pack could not be computed. Try creating it again; if it fails again, the imports may need to be read again.",
        },
      },
    ).catch(() => {});
    throw error;
  }
}

// ─── reads ──────────────────────────────────────────────────────────────

async function requireRun(firmId, runId) {
  const run = await AuditPackRun.findOne({ _id: objectId(runId, "Pack"), firmId }).lean();
  if (!run) throw httpError(404, "That audit pack is not in this firm.");
  return run;
}

async function activeRows(run, extraFilter = {}) {
  if (!run.activeGenerationAttempt) return [];
  return AuditPackRow.find({ firmId: run.firmId, runId: run._id, generationAttempt: run.activeGenerationAttempt, ...extraFilter })
    .sort({ ordinal: 1 })
    .lean();
}

export async function computeAuditPackSummary(run) {
  if (run.status !== "REVIEW") return null;
  const rows = await activeRows(run);
  const generic = getPackKind(run.kind);
  return (generic ? generic.summarize : summarizeClause44)(rows.map(engineRowFromStored));
}

export async function listAuditPackRuns({ firmId, query = {} }) {
  const filter = { firmId };
  if (query.clientId) filter.clientId = objectId(query.clientId, "Client");
  if (query.financialYear) filter.financialYear = financialYearOf(query.financialYear);
  const limit = Math.min(RUN_PAGE_MAX, Math.max(1, Number.parseInt(query.limit, 10) || 20));
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const [runs, total] = await Promise.all([
    AuditPackRun.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    AuditPackRun.countDocuments(filter),
  ]);
  return { runs: runs.map((run) => serializeRun(run)), pagination: { page, limit, total } };
}

export async function getAuditPackRun({ firmId, runId }) {
  const run = await requireRun(firmId, runId);
  return serializeRun(run, await computeAuditPackSummary(run));
}

export async function listAuditPackRows({ firmId, runId, query = {} }) {
  const run = await requireRun(firmId, runId);
  if (run.status !== "REVIEW") {
    return { rows: [], pagination: { page: 1, limit: 0, total: 0 }, status: run.status };
  }
  const filter = {};
  if (query.section) {
    const section = String(query.section).toUpperCase();
    const allowed = getPackKind(run.kind)?.sections.map((s) => s.code) || ["LEDGER", "SUPPLIER", "TIEOUT"];
    if (!allowed.includes(section)) throw httpError(400, `Section is ${allowed.join(", ")}.`);
    filter.section = section;
  }
  const limit = Math.min(ROW_PAGE_MAX, Math.max(1, Number.parseInt(query.limit, 10) || 50));
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const base = { firmId, runId: run._id, generationAttempt: run.activeGenerationAttempt, ...filter };
  const [rows, total] = await Promise.all([
    AuditPackRow.find(base).sort({ ordinal: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    AuditPackRow.countDocuments(base),
  ]);
  return { rows: rows.map((row) => serializeRow(row, run.kind)), pagination: { page, limit, total }, status: run.status };
}

export async function listAuditPackSources({ firmId, query = {} }) {
  const client = await requireClient(firmId, query.clientId);
  const financialYear = financialYearOf(query.financialYear);
  const months = financialYearMonths(financialYear);
  const batches = await ImportBatch.find({
    firmId,
    clientId: client._id,
    status: "COMPLETED",
    $or: [
      { kind: "TRIAL_BALANCE", financialYear },
      { kind: { $in: ["GST_PURCHASE", "GSTR2B", "GSTR1_SUMMARY", "GSTR3B_SUMMARY"] }, period: { $in: months } },
    ],
  })
    .select("_id kind period financialYear sourceName totalRows validRows completedAt gstin")
    .sort({ kind: 1, period: 1, completedAt: -1 })
    .limit(200)
    .lean();
  return {
    clientId: String(client._id),
    financialYear,
    batches: batches.map((b) => ({
      id: String(b._id),
      kind: b.kind,
      period: b.period || "",
      financialYear: b.financialYear || "",
      gstin: b.gstin || "",
      sourceName: b.sourceName || "",
      rows: b.validRows ?? b.totalRows ?? 0,
      completedAt: b.completedAt,
    })),
    truncated: batches.length === 200,
  };
}

// ─── decisions ──────────────────────────────────────────────────────────

const DECISION_FIELDS = new Set(["expectedVersion", "state", "treatment", "status", "choice", "reason", "note"]);
const PERSON_LEDGER_TREATMENTS = new Set(LEDGER_TREATMENTS.filter((t) => t !== "UNCLASSIFIED"));
const PERSON_SUPPLIER_STATUSES = new Set(["REGISTERED", "COMPOSITION", "EXEMPT_SUPPLIER"]);

function text(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

export async function decideAuditPackRow({ firmId, actorUserId, requestId = "", runId, rowKey, input }) {
  assertAllowed(input, DECISION_FIELDS, "A decision");
  if (!/^[a-f0-9]{64}$/.test(String(rowKey || ""))) throw httpError(400, "Row key is not valid.");
  const expectedVersion = Number(input.expectedVersion);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw httpError(400, "expectedVersion is required.");
  const state = String(input.state || "").toUpperCase();
  if (!["CONFIRMED", "EXCLUDED"].includes(state)) throw httpError(400, "A decision confirms or excludes a row.");
  const treatment = input.treatment ? String(input.treatment).toUpperCase() : "";
  const status = input.status ? String(input.status).toUpperCase() : "";
  const choice = input.choice ? String(input.choice).toUpperCase().slice(0, 60) : "";
  const reason = text(input.reason, 500);
  const note = text(input.note, 2000);

  const run = await requireRun(firmId, runId);
  if (run.status !== "REVIEW") throw httpError(409, "This pack is still being computed.", "AUDIT_PACK_NOT_READY");
  const row = await AuditPackRow.findOne({ firmId, runId: run._id, generationAttempt: run.activeGenerationAttempt, rowKey }).lean();
  if (!row) throw httpError(404, "That row is not in this pack.");
  if (!row.decidable) throw httpError(400, "This row is worked out from the others; decide those instead.", "AUDIT_PACK_DECISION_REFUSED");

  const genericKind = getPackKind(run.kind);
  if (genericKind) {
    if (treatment || status) throw httpError(400, "This pack takes a reason, not a treatment or a status.");
    try {
      genericKind.validateDecision(row, { state, choice, reason, note });
    } catch (error) {
      if (error instanceof RangeError) throw httpError(400, error.message, "AUDIT_PACK_DECISION_REFUSED");
      throw error;
    }
  } else if (row.section === "LEDGER") {
    if (choice) throw httpError(400, "A ledger takes a treatment.");
    if (status) throw httpError(400, "A ledger takes a treatment, not a supplier status.");
    if (treatment && !PERSON_LEDGER_TREATMENTS.has(treatment)) throw httpError(400, "That treatment is not one a ledger can take.");
    if (row.state === "PENDING_INPUT" && state === "CONFIRMED" && !treatment) {
      throw httpError(400, "This ledger needs a treatment before it can be confirmed.", "AUDIT_PACK_DECISION_REFUSED");
    }
    // A fixed asset counts the year's additions, and only the books can give them.
    if (state === "CONFIRMED" && (treatment || row.values?.treatment) === "CAPITAL_ADDITIONS"
      && !Number.isSafeInteger(row.values?.additionsMinor)) {
      throw httpError(400, "This asset's additions for the year are not in the trial balance. Import it with its Debit transactions column, or exclude this ledger with a reason.", "AUDIT_PACK_DECISION_REFUSED");
    }
  } else if (row.section === "SUPPLIER") {
    if (choice) throw httpError(400, "A supplier takes a status.");
    if (treatment) throw httpError(400, "A supplier takes a status, not a treatment.");
    if (state === "EXCLUDED") throw httpError(400, "A supplier cannot be excluded; set its status instead.", "AUDIT_PACK_DECISION_REFUSED");
    if (status && !PERSON_SUPPLIER_STATUSES.has(status)) throw httpError(400, "That status is not one a person can set.");
    if (row.state === "PENDING_INPUT" && !status && row.values?.status === "NOT_IN_2B") {
      throw httpError(400, "Check this supplier on the GST portal and set its status before confirming.", "AUDIT_PACK_DECISION_REFUSED");
    }
  }
  if (state === "EXCLUDED" && !reason) throw httpError(400, "Say why this row is excluded.", "AUDIT_PACK_DECISION_REFUSED");

  const decidedAt = new Date();
  const updated = await AuditPackRow.findOneAndUpdate(
    { _id: row._id, firmId, "decision.version": expectedVersion },
    {
      $set: {
        decision: {
          version: expectedVersion + 1,
          state,
          treatment,
          status,
          choice,
          reason,
          note,
          decidedBy: actorUserId,
          decidedAt,
        },
      },
    },
    { new: true },
  ).lean();
  if (!updated) throw httpError(409, "Someone else decided this row since you opened it. Reload it and decide again.", "AUDIT_PACK_ROW_CHANGED");

  if (row.section === "SUPPLIER" && status && row.party?.gstin) {
    await PartyMaster.findOneAndUpdate(
      { firmId, clientId: run.clientId, gstin: row.party.gstin },
      {
        $set: { gstStatus: status, gstStatusNote: note || reason, confirmedBy: actorUserId, confirmedAt: decidedAt },
        $inc: { version: 1 },
        $setOnInsert: { firmId, clientId: run.clientId, gstin: row.party.gstin },
      },
      { upsert: true, new: true },
    );
  }

  await safeRecordActivity({
    firmId,
    actorUserId,
    source: "USER",
    action: "AUDIT_PACK_ROW_DECIDED",
    entityType: "AuditPackRun",
    entityId: run._id,
    requestId,
    afterSummary: { section: row.section, state, treatment, status, choice, version: expectedVersion + 1 },
  });
  return serializeRow(updated, run.kind);
}

// ─── party master (AP6) ─────────────────────────────────────────────────────

function serializeParty(party) {
  return {
    id: String(party._id),
    clientId: String(party.clientId),
    gstin: party.gstin,
    name: party.name || "",
    gstStatus: party.gstStatus,
    gstStatusNote: party.gstStatusNote || "",
    udyamCategory: party.udyamCategory,
    relatedPerson: party.relatedPerson,
    lenderOrDepositor: party.lenderOrDepositor,
    version: party.version || 0,
    confirmedBy: party.confirmedBy ? String(party.confirmedBy) : null,
    confirmedAt: party.confirmedAt || null,
  };
}

export async function listParties({ firmId, query = {} }) {
  const client = await requireClient(firmId, query.clientId);
  const limit = Math.min(ROW_PAGE_MAX, Math.max(1, Number.parseInt(query.limit, 10) || 50));
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const filter = { firmId, clientId: client._id };
  const [parties, total] = await Promise.all([
    PartyMaster.find(filter).sort({ gstin: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    PartyMaster.countDocuments(filter),
  ]);
  return { parties: parties.map(serializeParty), pagination: { page, limit, total } };
}

const PARTY_FIELDS = new Set(["expectedVersion", "gstStatus", "note"]);

export async function setPartyStatus({ firmId, actorUserId, requestId = "", partyId, input }) {
  assertAllowed(input, PARTY_FIELDS, "A supplier status");
  const expectedVersion = Number(input.expectedVersion);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw httpError(400, "expectedVersion is required.");
  const gstStatus = String(input.gstStatus || "").toUpperCase();
  if (!PARTY_GST_STATUSES.includes(gstStatus)) throw httpError(400, "That is not a GST status.");
  const id = objectId(partyId, "Supplier");
  const existing = await PartyMaster.findOne({ _id: id, firmId }).lean();
  if (!existing) throw httpError(404, "That supplier is not in this firm.");
  const now = new Date();
  const updated = await PartyMaster.findOneAndUpdate(
    { _id: id, firmId, version: expectedVersion },
    {
      $set: {
        gstStatus,
        gstStatusNote: text(input.note, 500),
        confirmedBy: gstStatus === "UNKNOWN" ? null : actorUserId,
        confirmedAt: gstStatus === "UNKNOWN" ? null : now,
      },
      $inc: { version: 1 },
    },
    { new: true },
  ).lean();
  if (!updated) throw httpError(409, "Someone else changed this supplier since you opened it. Reload it and set the status again.", "PARTY_CHANGED");
  await safeRecordActivity({
    firmId,
    actorUserId,
    source: "USER",
    action: "PARTY_STATUS_SET",
    entityType: "PartyMaster",
    entityId: updated._id,
    requestId,
    afterSummary: { gstStatus, version: updated.version },
  });
  return serializeParty(updated);
}

export { serializeRow, serializeRun };
