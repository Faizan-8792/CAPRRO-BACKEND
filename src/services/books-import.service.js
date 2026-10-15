// src/services/books-import.service.js
//
// W10 AP5 (2026-10-15): committing a previewed trial balance. The same lifecycle as the TDS import
// (tds-import.service.js), because it is the same problem: a preview is signed (an HMAC over the
// file, the mapping and the context, valid 15 minutes) so the commit can refuse anything that
// changed after the person saw it; the batch is unique per (firm, kind, fingerprint) so a repeated
// commit replays rather than duplicates; rows are written under a processing token and only become
// the batch's active generation when every one is written, so a reader never sees half a file.

import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import mongoose from "mongoose";
import BooksImportRow, { BOOKS_IMPORT_KINDS } from "../models/BooksImportRow.js";
import Client from "../models/Client.js";
import ImportBatch from "../models/ImportBatch.js";
import { safeRecordActivity } from "./activity.service.js";
import {
  BOOKS_NORMALIZATION_VERSION,
  BOOKS_SOURCE_LABELS,
  fingerprintBooksRow,
  normalizeBooksContext,
} from "./books-normalization.service.js";
import { parseMappedImport } from "./import-preview.service.js";
import { assertAuditPackStorageReady } from "./audit-pack-index-readiness.service.js";
import { userFacingMessage } from "../utils/user-facing-error.js";

const BOOKS_IMPORT_PROCESSING_LEASE_MS = 10 * 60 * 1000;
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
  const secret = process.env.BOOKS_IMPORT_PREVIEW_SECRET || process.env.JWT_SECRET;
  if (!secret) throw serviceError("Books import preview signing is unavailable", 503);
  return secret;
}

function buildBooksImportFingerprint({ sourceHash, kind, mapping, delimiter, clientId, financialYear }) {
  return createHash("sha256")
    .update(JSON.stringify(canonical({
      sourceHash: String(sourceHash || "").toLowerCase(),
      kind: String(kind || "").toUpperCase(),
      mapping,
      delimiter,
      clientId: String(clientId || ""),
      financialYear,
      normalizationVersion: BOOKS_NORMALIZATION_VERSION,
    })))
    .digest("hex");
}

function previewTokenForFingerprint(fingerprint, expiresAt = Date.now() + PREVIEW_TOKEN_TTL_MS) {
  const signature = createHmac("sha256", previewSecret()).update(`${fingerprint}.${expiresAt}`).digest("hex");
  return `${expiresAt}.${signature}`;
}

function previewTokenMatches(fingerprint, token) {
  const [expiresText, signature = ""] = String(token || "").split(".");
  const expiresAt = Number(expiresText);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || !/^[a-f0-9]{64}$/i.test(signature)) {
    return false;
  }
  const expected = createHmac("sha256", previewSecret()).update(`${fingerprint}.${expiresAt}`).digest();
  const actual = Buffer.from(signature, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function createBooksImportPreviewAuthorization({ sourceHash, kind, mapping, delimiter, clientId, financialYear }) {
  assertObjectId(clientId, "Client");
  const normalizedKind = String(kind || "").toUpperCase();
  if (!BOOKS_IMPORT_KINDS.includes(normalizedKind)) {
    throw serviceError("Only books import kinds can receive this authorization");
  }
  const context = normalizeBooksContext({ financialYear });
  const importFingerprint = buildBooksImportFingerprint({
    sourceHash, kind: normalizedKind, mapping, delimiter, clientId, ...context,
  });
  return { importFingerprint, commitToken: previewTokenForFingerprint(importFingerprint), context };
}

function serializeBooksImportBatch(batch) {
  return {
    id: String(batch._id),
    kind: batch.kind,
    clientId: String(batch.clientId),
    financialYear: batch.financialYear,
    sourceName: batch.sourceName,
    sourceHash: batch.sourceHash,
    importFingerprint: batch.importFingerprint,
    normalizationVersion: batch.normalizationVersion,
    sourceLabel: BOOKS_SOURCE_LABELS[batch.kind],
    status: batch.status,
    totalRows: batch.totalRows,
    validRows: batch.validRows,
    invalidRows: batch.invalidRows,
    financialTotals: batch.errorSummary?.financialTotals || null,
    warningCount: batch.errorSummary?.warnings?.length || 0,
    activeImportGeneration: batch.activeImportGeneration,
    committedAt: batch.committedAt,
    completedAt: batch.completedAt,
  };
}

function batchMetadataMatches(batch, metadata) {
  return String(batch.clientId || "") === String(metadata.clientId) &&
    batch.financialYear === metadata.financialYear &&
    batch.importFingerprint === metadata.importFingerprint;
}

async function commitBooksImport({
  firmId,
  actorUserId,
  requestId = "",
  sourceHash,
  sourceName = "",
  kind,
  text,
  mapping,
  delimiter = null,
  previewToken,
  clientId,
  financialYear,
}) {
  assertObjectId(firmId, "Firm");
  assertObjectId(actorUserId, "User");
  assertObjectId(clientId, "Client");
  const normalizedKind = String(kind || "").toUpperCase();
  if (!BOOKS_IMPORT_KINDS.includes(normalizedKind)) {
    throw serviceError("Only books import kinds can be committed here");
  }
  if (!/^[a-f0-9]{64}$/i.test(String(sourceHash || ""))) {
    throw serviceError("Source hash must be a SHA-256 hex value");
  }
  const context = normalizeBooksContext({ financialYear });
  const parsed = parseMappedImport({ kind: normalizedKind, text, mapping, delimiter });
  const importFingerprint = buildBooksImportFingerprint({
    sourceHash: parsed.sourceHash,
    kind: normalizedKind,
    mapping: parsed.mapping,
    delimiter: parsed.delimiter,
    clientId,
    ...context,
  });
  if (parsed.sourceHash !== String(sourceHash).toLowerCase() || !previewTokenMatches(importFingerprint, previewToken)) {
    throw serviceError("The file or its year changed after preview; read it again", 409);
  }
  if (parsed.summary.invalidRows > 0) {
    throw serviceError("The trial balance has rows that could not be read and was not saved", 422, {
      summary: parsed.summary,
      errors: parsed.errors,
    });
  }

  const client = await Client.findOne({ _id: clientId, firmId, isActive: true }).select("_id").lean();
  if (!client) throw serviceError("Active client not found in active firm", 404);

  await assertAuditPackStorageReady();
  const metadata = { clientId, ...context, importFingerprint };
  const identity = { firmId, kind: normalizedKind, importFingerprint };
  let batch = await ImportBatch.findOne(identity);
  if (batch?.status === "COMPLETED") {
    if (!batchMetadataMatches(batch, metadata)) throw serviceError("This file is already saved for a different year", 409);
    return { batch: serializeBooksImportBatch(batch), replayed: true };
  }
  if (batch && !batchMetadataMatches(batch, metadata)) {
    throw serviceError("This file is already being saved for a different year", 409);
  }

  const processingToken = randomUUID();
  let ownsProcessing = false;
  const financialTotals = parsed.summary.financialTotals || {};
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
          normalizationVersion: BOOKS_NORMALIZATION_VERSION,
          delimiter: parsed.delimiter,
          dateOrder: "NOT_APPLICABLE",
          mapping: parsed.mapping,
          status: "PROCESSING",
          processingToken,
          processingExpiresAt: new Date(now.getTime() + BOOKS_IMPORT_PROCESSING_LEASE_MS),
          totalRows: parsed.summary.totalRows,
          validRows: parsed.summary.validRows,
          invalidRows: 0,
          totalTaxMinor: 0,
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
        if (!batchMetadataMatches(batch, metadata)) throw serviceError("This file is already saved for a different year", 409);
        return { batch: serializeBooksImportBatch(batch), replayed: true };
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
            processingExpiresAt: new Date(now.getTime() + BOOKS_IMPORT_PROCESSING_LEASE_MS),
            completedAt: null,
            requestId,
            committedAt: now,
          },
        },
        { new: true },
      );
      if (!batch) throw serviceError("This trial balance is already being saved", 409);
      ownsProcessing = true;
    }

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
            rowFingerprint: fingerprintBooksRow(normalizedKind, row.values),
            normalizationVersion: BOOKS_NORMALIZATION_VERSION,
            sourceLabel: BOOKS_SOURCE_LABELS[normalizedKind],
            financialYear: context.financialYear,
            ledgerName: row.values.ledgerName,
            groupName: row.values.groupName,
            openingMinor: row.values.openingMinor,
            hasOpening: row.values.hasOpening,
            debitTotalMinor: row.values.debitTotalMinor,
            creditTotalMinor: row.values.creditTotalMinor,
            hasTransactionTotals: row.values.hasTransactionTotals,
            closingMinor: row.values.closingMinor,
          },
        },
        upsert: true,
      },
    }));
    if (operations.length) await BooksImportRow.bulkWrite(operations, { ordered: false });

    const completionTime = new Date();
    batch = await ImportBatch.findOneAndUpdate(
      { _id: batch._id, firmId, status: "PROCESSING", processingToken, processingExpiresAt: { $gt: completionTime } },
      {
        $set: {
          status: "COMPLETED",
          activeImportGeneration: processingToken,
          processingToken: null,
          processingExpiresAt: null,
          totalRows: parsed.summary.totalRows,
          validRows: parsed.summary.validRows,
          invalidRows: 0,
          errorSummary: {
            warnings: parsed.warnings.slice(0, 100),
            financialTotals,
            sourceLabel: BOOKS_SOURCE_LABELS[normalizedKind],
          },
          completedAt: completionTime,
        },
      },
      { new: true, runValidators: true },
    );
    if (!batch) throw serviceError("Saving this trial balance was taken over by another request", 409);

    BooksImportRow.deleteMany({ firmId, batchId: batch._id, importGeneration: { $ne: processingToken } }).catch(() => {});

    await safeRecordActivity({
      firmId,
      actorUserId,
      source: "IMPORT",
      action: "BOOKS_IMPORT_COMMITTED",
      entityType: "ImportBatch",
      entityId: batch._id,
      requestId,
      batchId: batch._id,
      afterSummary: {
        kind: normalizedKind,
        clientId,
        financialYear: context.financialYear,
        totalRows: parsed.summary.totalRows,
        importFingerprint,
      },
    });
    return { batch: serializeBooksImportBatch(batch), replayed: false };
  } catch (error) {
    if (batch?._id && ownsProcessing) {
      await BooksImportRow.deleteMany({ firmId, batchId: batch._id, importGeneration: processingToken }).catch(() => {});
      await ImportBatch.updateOne(
        { _id: batch._id, firmId, status: { $ne: "COMPLETED" }, processingToken },
        {
          $set: {
            status: "FAILED",
            processingToken: null,
            processingExpiresAt: null,
            errorSummary: {
              code: String(error.code || error.name || "IMPORT_FAILED").slice(0, 80),
              message: userFacingMessage(error, "The trial balance could not be saved. Check the file and try again.").slice(0, 500),
            },
            completedAt: new Date(),
          },
        },
      ).catch(() => {});
    }
    throw error;
  }
}

async function getBooksImportBatch({ firmId, batchId }) {
  assertObjectId(firmId, "Firm");
  assertObjectId(batchId, "Import batch");
  const batch = await ImportBatch.findOne({ _id: batchId, firmId, kind: { $in: BOOKS_IMPORT_KINDS } }).lean();
  if (!batch) throw serviceError("Trial balance import not found", 404);
  return serializeBooksImportBatch(batch);
}

export {
  BOOKS_IMPORT_PROCESSING_LEASE_MS,
  PREVIEW_TOKEN_TTL_MS,
  buildBooksImportFingerprint,
  commitBooksImport,
  createBooksImportPreviewAuthorization,
  getBooksImportBatch,
  serializeBooksImportBatch,
};
