import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import mongoose from "mongoose";
import Client from "../models/Client.js";
import ImportBatch from "../models/ImportBatch.js";
import TdsImportRow from "../models/TdsImportRow.js";
import { safeRecordActivity } from "./activity.service.js";
import { parseMappedImport } from "./import-preview.service.js";
import {
  SOURCE_LABELS,
  TDS_IMPORT_KINDS,
  TDS_NORMALIZATION_VERSION,
  fingerprintTdsRow,
  normalizeTdsContext,
} from "./tds-normalization.service.js";
import { assertTdsImportStorageReady } from "./tds-storage-readiness.service.js";

const TDS_IMPORT_PROCESSING_LEASE_MS = 10 * 60 * 1000;
const PREVIEW_TOKEN_TTL_MS = 15 * 60 * 1000;

function serviceError(message, statusCode = 400, details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (details) error.details = details;
  return error;
}

function assertObjectId(value, label) {
  if (!mongoose.isValidObjectId(value)) throw serviceError(`${label} ID is invalid`);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function previewSecret() {
  const secret = process.env.TDS_IMPORT_PREVIEW_SECRET || process.env.JWT_SECRET;
  if (!secret) throw serviceError("TDS import preview signing is unavailable", 503);
  return secret;
}

function buildTdsImportFingerprint({
  sourceHash,
  kind,
  mapping,
  delimiter,
  clientId,
  tan,
  financialYear,
  quarter,
  statementType,
  dateOrder,
}) {
  return createHash("sha256")
    .update(JSON.stringify(canonical({
      sourceHash: String(sourceHash || "").toLowerCase(),
      kind: String(kind || "").toUpperCase(),
      mapping,
      delimiter,
      clientId: String(clientId || ""),
      tan,
      financialYear,
      quarter,
      statementType,
      normalizationVersion: TDS_NORMALIZATION_VERSION,
      // See buildImportFingerprint in gst-import.service.js -- same anti-swap
      // reasoning, mirrored here for the Income-tax TDS import path.
      dateOrder: dateOrder || "NOT_APPLICABLE",
    })))
    .digest("hex");
}

function previewTokenForFingerprint(fingerprint, expiresAt = Date.now() + PREVIEW_TOKEN_TTL_MS) {
  const payload = `${fingerprint}.${expiresAt}`;
  const signature = createHmac("sha256", previewSecret()).update(payload).digest("hex");
  return `${expiresAt}.${signature}`;
}

function previewTokenMatches(fingerprint, token) {
  const [expiresText, signature = ""] = String(token || "").split(".");
  const expiresAt = Number(expiresText);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || !/^[a-f0-9]{64}$/i.test(signature)) {
    return false;
  }
  const expected = createHmac("sha256", previewSecret())
    .update(`${fingerprint}.${expiresAt}`)
    .digest();
  const actual = Buffer.from(signature, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function createTdsImportPreviewAuthorization({
  sourceHash,
  kind,
  mapping,
  delimiter,
  clientId,
  tan,
  financialYear,
  quarter,
  statementType,
  dateOrder = null,
}) {
  assertObjectId(clientId, "Client");
  const normalizedKind = String(kind || "").toUpperCase();
  if (!TDS_IMPORT_KINDS.includes(normalizedKind)) {
    throw serviceError("Only Income-tax TDS import kinds can receive this authorization");
  }
  const context = normalizeTdsContext({ tan, financialYear, quarter, statementType });
  const importFingerprint = buildTdsImportFingerprint({
    sourceHash,
    kind: normalizedKind,
    mapping,
    delimiter,
    clientId,
    ...context,
    dateOrder,
  });
  return {
    importFingerprint,
    commitToken: previewTokenForFingerprint(importFingerprint),
    context,
  };
}

function primaryTotalForKind(kind, totals = {}) {
  if (kind === "TDS_DEDUCTIONS") return totals.deductedMinor || 0;
  if (kind === "TDS_CHALLANS") return totals.depositedMinor || 0;
  if (kind === "TDS_STATEMENTS") return totals.reportedMinor || 0;
  return totals.creditedMinor || 0;
}

function batchMetadataMatches(batch, metadata) {
  return String(batch.clientId || "") === String(metadata.clientId) &&
    batch.tan === metadata.tan &&
    batch.financialYear === metadata.financialYear &&
    batch.quarter === metadata.quarter &&
    batch.statementType === metadata.statementType &&
    batch.importFingerprint === metadata.importFingerprint;
}

function serializeTdsImportBatch(batch) {
  return {
    id: String(batch._id),
    kind: batch.kind,
    clientId: String(batch.clientId),
    tan: batch.tan,
    financialYear: batch.financialYear,
    quarter: batch.quarter,
    statementType: batch.statementType,
    sourceName: batch.sourceName,
    sourceHash: batch.sourceHash,
    importFingerprint: batch.importFingerprint,
    normalizationVersion: batch.normalizationVersion,
    dateOrder: batch.dateOrder || "",
    sourceLabel: SOURCE_LABELS[batch.kind],
    status: batch.status,
    totalRows: batch.totalRows,
    validRows: batch.validRows,
    invalidRows: batch.invalidRows,
    totalTaxMinor: batch.totalTaxMinor,
    financialTotals: batch.errorSummary?.financialTotals || null,
    warningCount: batch.errorSummary?.warnings?.length || 0,
    activeImportGeneration: batch.activeImportGeneration,
    committedAt: batch.committedAt,
    completedAt: batch.completedAt,
  };
}

async function commitTdsImport({
  firmId,
  actorUserId,
  requestId = "",
  sourceHash,
  sourceName = "",
  kind,
  text,
  mapping,
  delimiter = null,
  dateOrder = null,
  previewToken,
  clientId,
  tan,
  financialYear,
  quarter,
  statementType,
}) {
  assertObjectId(firmId, "Firm");
  assertObjectId(actorUserId, "User");
  assertObjectId(clientId, "Client");
  const normalizedKind = String(kind || "").toUpperCase();
  if (!TDS_IMPORT_KINDS.includes(normalizedKind)) {
    if (["GSTR7", "GSTR-7"].includes(normalizedKind)) {
      throw serviceError("GSTR-7 is GST TDS and cannot be committed as Income-tax TDS evidence");
    }
    throw serviceError("Only Income-tax TDS import kinds can be committed here");
  }
  if (!/^[a-f0-9]{64}$/i.test(String(sourceHash || ""))) {
    throw serviceError("Source hash must be a SHA-256 hex value");
  }
  const context = normalizeTdsContext({ tan, financialYear, quarter, statementType });
  const parsed = parseMappedImport({ kind: normalizedKind, text, mapping, delimiter, dateOrder });

  // An unanswered ambiguous file must never reach storage -- see the matching
  // guard in commitGstImport (gst-import.service.js) for the full reasoning.
  if (parsed.dateOrder.status === "AMBIGUOUS" && !parsed.dateOrder.resolved) {
    throw serviceError(
      "This file has dates that could be read either day-first or month-first, and no answer was given for which. Read the file again and state the date order before committing it.",
      409
    );
  }

  const importFingerprint = buildTdsImportFingerprint({
    sourceHash: parsed.sourceHash,
    kind: normalizedKind,
    mapping: parsed.mapping,
    delimiter: parsed.delimiter,
    clientId,
    ...context,
    // The fresh re-parse's OWN resolution, not the raw request value -- same
    // anti-swap reasoning as commitGstImport's parsedFingerprint.
    dateOrder: parsed.dateOrder.resolved || "NOT_APPLICABLE",
  });
  if (
    parsed.sourceHash !== String(sourceHash).toLowerCase() ||
    !previewTokenMatches(importFingerprint, previewToken)
  ) {
    throw serviceError("Import inputs or TDS context changed after preview; preview again", 409);
  }
  if (parsed.summary.invalidRows > 0) {
    throw serviceError("Import contains invalid rows and was not committed", 422, {
      summary: parsed.summary,
      errors: parsed.errors,
    });
  }

  const client = await Client.findOne({ _id: clientId, firmId, isActive: true }).select("+tan").lean();
  if (!client) throw serviceError("Active client not found in active firm", 404);
  if (client.tan && client.tan !== context.tan) {
    throw serviceError("Selected TAN does not match the client's governed profile", 409);
  }

  await assertTdsImportStorageReady({ firmId });
  const metadata = { clientId, ...context, importFingerprint };
  const identity = { firmId, kind: normalizedKind, importFingerprint };
  let batch = await ImportBatch.findOne(identity);
  if (batch?.status === "COMPLETED") {
    if (!batchMetadataMatches(batch, metadata)) {
      throw serviceError("Import fingerprint is committed to different TDS context", 409);
    }
    return { batch: serializeTdsImportBatch(batch), replayed: true };
  }
  if (batch && !batchMetadataMatches(batch, metadata)) {
    throw serviceError("Import fingerprint is reserved by different TDS context", 409);
  }

  const processingToken = randomUUID();
  let ownsProcessing = false;
  const financialTotals = parsed.summary.financialTotals || {};
  const primaryTotal = primaryTotalForKind(normalizedKind, financialTotals);
  try {
    if (!batch) {
      try {
        const now = new Date();
        batch = await ImportBatch.create({
          ...identity,
          clientId,
          ...context,
          sourceName: String(sourceName || "").trim().slice(0, 240),
          sourceHash: parsed.sourceHash,
          normalizationVersion: TDS_NORMALIZATION_VERSION,
          delimiter: parsed.delimiter,
          dateOrder: parsed.dateOrder.resolved || "NOT_APPLICABLE",
          mapping: parsed.mapping,
          status: "PROCESSING",
          processingToken,
          processingExpiresAt: new Date(now.getTime() + TDS_IMPORT_PROCESSING_LEASE_MS),
          totalRows: parsed.summary.totalRows,
          validRows: parsed.summary.validRows,
          invalidRows: 0,
          totalTaxMinor: primaryTotal,
          requestId,
          createdBy: actorUserId,
          committedAt: now,
        });
        ownsProcessing = true;
      } catch (error) {
        if (error?.code !== 11000) throw error;
        batch = await ImportBatch.findOne(identity);
        if (!batch) throw error;
      }
    }

    if (!ownsProcessing) {
      if (batch.status === "COMPLETED") {
        if (!batchMetadataMatches(batch, metadata)) {
          throw serviceError("Import fingerprint is committed to different TDS context", 409);
        }
        return { batch: serializeTdsImportBatch(batch), replayed: true };
      }
      const now = new Date();
      batch = await ImportBatch.findOneAndUpdate(
        {
          _id: batch._id,
          firmId,
          $or: [
            { status: { $in: ["FAILED", "PARTIAL"] } },
            { status: "PROCESSING", $or: [{ processingExpiresAt: { $lte: now } }, { processingExpiresAt: null }] },
          ],
        },
        {
          $set: {
            status: "PROCESSING",
            processingToken,
            processingExpiresAt: new Date(now.getTime() + TDS_IMPORT_PROCESSING_LEASE_MS),
            completedAt: null,
            requestId,
            committedAt: now,
          },
        },
        { new: true }
      );
      if (!batch) throw serviceError("This TDS import is already being processed", 409);
      ownsProcessing = true;
    }

    if (!batchMetadataMatches(batch, metadata)) {
      throw serviceError("Import was concurrently reserved by different TDS context", 409);
    }
    const leaseNow = new Date();
    const renewed = await ImportBatch.updateOne(
      {
        _id: batch._id,
        firmId,
        status: "PROCESSING",
        processingToken,
        processingExpiresAt: { $gt: leaseNow },
      },
      { $set: { processingExpiresAt: new Date(leaseNow.getTime() + TDS_IMPORT_PROCESSING_LEASE_MS) } }
    );
    if (renewed.matchedCount !== 1) throw serviceError("TDS import processing ownership was lost", 409);

    const operations = parsed.rows.map((row) => ({
      updateOne: {
        filter: { firmId, batchId: batch._id, importGeneration: processingToken, sourceRow: row.row },
        update: {
          $setOnInsert: {
            firmId,
            clientId,
            batchId: batch._id,
            importGeneration: processingToken,
            kind: normalizedKind,
            sourceRow: row.row,
            sourceHash: parsed.sourceHash,
            rowFingerprint: fingerprintTdsRow(normalizedKind, row.values),
            normalizationVersion: TDS_NORMALIZATION_VERSION,
            dateOrder: parsed.dateOrder.resolved || "NOT_APPLICABLE",
            sourceLabel: SOURCE_LABELS[normalizedKind],
            ...context,
            ...row.values,
          },
        },
        upsert: true,
      },
    }));
    if (operations.length) await TdsImportRow.bulkWrite(operations, { ordered: false });

    const completionTime = new Date();
    batch = await ImportBatch.findOneAndUpdate(
      {
        _id: batch._id,
        firmId,
        status: "PROCESSING",
        processingToken,
        processingExpiresAt: { $gt: completionTime },
      },
      {
        $set: {
          status: "COMPLETED",
          activeImportGeneration: processingToken,
          processingToken: null,
          processingExpiresAt: null,
          totalRows: parsed.summary.totalRows,
          validRows: parsed.summary.validRows,
          invalidRows: 0,
          totalTaxMinor: primaryTotal,
          errorSummary: {
            warnings: parsed.warnings.slice(0, 100),
            financialTotals,
            sourceLabel: SOURCE_LABELS[normalizedKind],
          },
          completedAt: completionTime,
        },
      },
      { new: true, runValidators: true }
    );
    if (!batch) throw serviceError("TDS import processing ownership was lost", 409);

    TdsImportRow.deleteMany({
      firmId,
      batchId: batch._id,
      importGeneration: { $ne: processingToken },
    }).catch(() => {});

    await safeRecordActivity({
      firmId,
      actorUserId,
      source: "IMPORT",
      action: "TDS_IMPORT_COMMITTED",
      entityType: "ImportBatch",
      entityId: batch._id,
      requestId,
      batchId: batch._id,
      afterSummary: {
        kind: normalizedKind,
        clientId,
        ...context,
        totalRows: parsed.summary.totalRows,
        primaryTotalMinor: primaryTotal,
        importFingerprint,
        sourceLabel: SOURCE_LABELS[normalizedKind],
      },
    });
    return { batch: serializeTdsImportBatch(batch), replayed: false };
  } catch (error) {
    if (batch?._id && ownsProcessing) {
      await TdsImportRow.deleteMany({ firmId, batchId: batch._id, importGeneration: processingToken }).catch(() => {});
      await ImportBatch.updateOne(
        { _id: batch._id, firmId, status: { $ne: "COMPLETED" }, processingToken },
        {
          $set: {
            status: "FAILED",
            processingToken: null,
            processingExpiresAt: null,
            errorSummary: {
              code: String(error.code || error.name || "IMPORT_FAILED").slice(0, 80),
              message: String(error.message || "TDS import failed").slice(0, 500),
            },
            completedAt: new Date(),
          },
        }
      ).catch(() => {});
    }
    throw error;
  }
}

async function getTdsImportBatch({ firmId, batchId }) {
  assertObjectId(firmId, "Firm");
  assertObjectId(batchId, "Import batch");
  const batch = await ImportBatch.findOne({ _id: batchId, firmId, kind: { $in: TDS_IMPORT_KINDS } }).lean();
  if (!batch) throw serviceError("TDS import batch not found", 404);
  return serializeTdsImportBatch(batch);
}

async function getTdsImportErrors({ firmId, batchId }) {
  assertObjectId(firmId, "Firm");
  assertObjectId(batchId, "Import batch");
  const batch = await ImportBatch.findOne({ _id: batchId, firmId, kind: { $in: TDS_IMPORT_KINDS } })
    .select("kind status totalRows validRows invalidRows errorSummary")
    .lean();
  if (!batch) throw serviceError("TDS import batch not found", 404);
  return {
    batchId: String(batch._id),
    kind: batch.kind,
    status: batch.status,
    totalRows: batch.totalRows,
    validRows: batch.validRows,
    invalidRows: batch.invalidRows,
    warnings: batch.errorSummary?.warnings || [],
    failure: batch.status === "FAILED" ? batch.errorSummary : null,
  };
}

export {
  PREVIEW_TOKEN_TTL_MS,
  TDS_IMPORT_PROCESSING_LEASE_MS,
  buildTdsImportFingerprint,
  commitTdsImport,
  createTdsImportPreviewAuthorization,
  getTdsImportBatch,
  getTdsImportErrors,
  serializeTdsImportBatch,
};
