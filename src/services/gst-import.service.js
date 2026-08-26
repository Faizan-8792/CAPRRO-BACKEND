import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import mongoose from "mongoose";
import Client from "../models/Client.js";
import ImportBatch from "../models/ImportBatch.js";
import ImportRow, { GST_IMPORT_KINDS } from "../models/ImportRow.js";
import { parseMappedImport } from "./import-preview.service.js";
import { safeRecordActivity } from "./activity.service.js";
import { assertGstStorageIndexes } from "./gst-storage-readiness.service.js";
import {
  calculateGstr3bClaimed,
  isValidGstin,
  isValidPeriod,
  normalizeGstin,
} from "./gst-normalization.service.js";
import { userFacingMessage } from "../utils/user-facing-error.js";

// Bumped to v3 when dateOrder joined the fingerprint material (C3): a batch
// committed under v2 has no dateOrder recorded and will not replay against a
// re-submission of the same file, because its fingerprint no longer matches
// one computed with a dateOrder value. That is the honest consequence of
// closing the date-swap gap, not a bug -- see .kiro/finalreleasefix.md C3.
const GST_IMPORT_NORMALIZATION_VERSION = "gst-import-v3";
const GST_IMPORT_PROCESSING_LEASE_MS = 10 * 60 * 1000;

function serviceError(message, statusCode = 400, details = null, code = "") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code || details?.code || "";
  if (details) error.details = details;
  return error;
}

function assertObjectId(value, label) {
  if (!mongoose.isValidObjectId(value)) {
    throw serviceError(`${label} must be a valid ID`);
  }
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key])])
  );
}

function canonicalImportDelimiter(text, delimiter) {
  if (delimiter === "TAB" || delimiter === "\t") return "TAB";
  if (delimiter === "," || delimiter === ";") return delimiter;
  if (delimiter != null && delimiter !== "") return String(delimiter);
  const firstLine = String(text || "").split(/\r?\n/, 1)[0] || "";
  const selected = ["\t", ",", ";"].sort(
    (left, right) => firstLine.split(right).length - firstLine.split(left).length
  )[0];
  return selected === "\t" ? "TAB" : selected;
}

function buildImportFingerprint({
  sourceHash,
  kind,
  mapping,
  delimiter,
  clientId,
  gstin,
  period,
  dateOrder,
}) {
  const material = JSON.stringify(
    canonicalValue({
      normalizationVersion: GST_IMPORT_NORMALIZATION_VERSION,
      sourceHash,
      kind,
      mapping,
      delimiter,
      clientId: String(clientId),
      gstin,
      period,
      // Included so a file cannot be previewed under one date-order reading
      // and committed under another with the same token -- see C3 in
      // .kiro/finalreleasefix.md. "NOT_APPLICABLE" is a real, distinct value
      // (every date in the file states its own order), not an absence.
      dateOrder: dateOrder || "NOT_APPLICABLE",
    })
  );
  return createHash("sha256").update(material).digest("hex");
}

function previewTokenForFingerprint(importFingerprint) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw serviceError("GST import preview signing is unavailable", 503);
  return createHmac("sha256", secret)
    .update(`gst-import-preview:${importFingerprint}`)
    .digest("hex");
}

function previewTokenMatches(importFingerprint, received) {
  if (!/^[a-f0-9]{64}$/i.test(String(received || ""))) return false;
  const expected = previewTokenForFingerprint(importFingerprint);
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received, "hex"));
}

function recipientGstinMismatchRows(parsed, normalizedKind, normalizedGstin) {
  if (normalizedKind === "GSTR3B_SUMMARY") return [];
  return parsed.rows
    .filter((row) => isValidGstin(row.values.recipientGstin))
    .filter((row) => row.values.recipientGstin !== normalizedGstin)
    .map((row) => row.row);
}

async function createGstImportPreviewAuthorization({
  firmId,
  sourceHash,
  kind,
  text,
  mapping,
  delimiter,
  clientId,
  gstin,
  period,
  dateOrder = null,
}) {
  assertObjectId(firmId, "Firm");
  assertObjectId(clientId, "Client");
  const normalizedKind = String(kind || "").toUpperCase();
  if (!GST_IMPORT_KINDS.includes(normalizedKind)) {
    throw serviceError("Only GST import kinds can receive a commit authorization");
  }
  const normalizedGstin = normalizeGstin(gstin);
  if (!isValidGstin(normalizedGstin)) throw serviceError("A valid GSTIN is required");
  if (!isValidPeriod(period)) throw serviceError("Period must use YYYY-MM");

  const clientExists = await Client.exists({ _id: clientId, firmId });
  if (!clientExists) {
    throw serviceError(
      "Client not found in active firm",
      404,
      { code: "GST_IMPORT_CLIENT_NOT_FOUND" }
    );
  }

  const parsed = parseMappedImport({
    kind: normalizedKind,
    text,
    mapping,
    delimiter: delimiter === "TAB" ? "\t" : delimiter,
    dateOrder,
  });
  if (parsed.sourceHash !== sourceHash) {
    throw serviceError(
      "Import inputs changed while previewing; preview the current source and mapping again",
      409,
      { code: "GST_IMPORT_PREVIEW_STALE" }
    );
  }
  const mismatchedRows = recipientGstinMismatchRows(parsed, normalizedKind, normalizedGstin);
  if (mismatchedRows.length) {
    throw serviceError(
      "Recipient GSTIN does not match selected registration",
      422,
      {
        code: "RECIPIENT_GSTIN_MISMATCH",
        rows: mismatchedRows.slice(0, 100),
      }
    );
  }

  // Authoritative: the SERVER'S OWN resolution from this parse, never the raw
  // request value, so the token is keyed to what the file itself proved (or to
  // what the person explicitly answered), not to whatever a caller claims.
  const resolvedDateOrder = parsed.dateOrder.resolved || "NOT_APPLICABLE";
  const importFingerprint = buildImportFingerprint({
    sourceHash,
    kind: normalizedKind,
    mapping,
    delimiter,
    clientId,
    gstin: normalizedGstin,
    period,
    dateOrder: resolvedDateOrder,
  });
  return {
    importFingerprint,
    commitToken: previewTokenForFingerprint(importFingerprint),
  };
}

function batchMetadataMatches(batch, { clientId, gstin, period, importFingerprint }) {
  return (
    String(batch.clientId || "") === String(clientId) &&
    String(batch.gstin || "") === gstin &&
    String(batch.period || "") === period &&
    String(batch.importFingerprint || "") === importFingerprint
  );
}

function serializeImportBatch(batch) {
  const source = typeof batch?.toObject === "function" ? batch.toObject() : batch;
  if (!source) return null;
  return {
    id: String(source._id),
    kind: source.kind,
    clientId: source.clientId ? String(source.clientId) : null,
    gstin: source.gstin || "",
    period: source.period || "",
    sourceName: source.sourceName || "",
    sourceHash: source.sourceHash,
    importFingerprint: source.importFingerprint,
    normalizationVersion: source.normalizationVersion,
    delimiter: source.delimiter,
    dateOrder: source.dateOrder || "",
    status: source.status,
    totalRows: source.totalRows || 0,
    validRows: source.validRows || 0,
    invalidRows: source.invalidRows || 0,
    totalTaxMinor: source.totalTaxMinor || 0,
    currencyScale: source.currencyScale ?? 2,
    errorSummary: source.errorSummary || {},
    committedAt: source.committedAt || null,
    completedAt: source.completedAt || null,
    createdAt: source.createdAt || null,
  };
}

export async function commitGstImport({
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
  gstin,
  period,
}) {
  assertObjectId(firmId, "Firm");
  assertObjectId(actorUserId, "User");
  assertObjectId(clientId, "Client");
  const normalizedKind = String(kind || "").toUpperCase();
  if (!GST_IMPORT_KINDS.includes(normalizedKind)) {
    throw serviceError("Only GST import kinds can be committed here");
  }
  if (!/^[a-f0-9]{64}$/i.test(String(sourceHash || ""))) {
    throw serviceError("Source hash must be a SHA-256 hex value");
  }
  const normalizedGstin = normalizeGstin(gstin);
  if (!isValidGstin(normalizedGstin)) throw serviceError("A valid GSTIN is required");
  if (!isValidPeriod(period)) throw serviceError("Period must use YYYY-MM");

  // Computed from the CALLER-supplied dateOrder, which a well-behaved desktop
  // took verbatim from preview.dateOrder.resolved (never from its own UI
  // control -- see C5). This is what makes previewing a file under one order
  // and committing it under another fail the token check below: the token was
  // minted over the order preview actually resolved to, so a different value
  // here simply does not reproduce it.
  const importFingerprint = buildImportFingerprint({
    sourceHash: String(sourceHash).toLowerCase(),
    kind: normalizedKind,
    mapping,
    delimiter: canonicalImportDelimiter(text, delimiter),
    clientId,
    gstin: normalizedGstin,
    period,
    dateOrder,
  });
  if (!previewTokenMatches(importFingerprint, previewToken)) {
    throw serviceError(
      "Import inputs changed after preview; preview the current source and mapping again",
      409,
      { code: "GST_IMPORT_PREVIEW_STALE" }
    );
  }

  const parsed = parseMappedImport({
    kind: normalizedKind,
    text,
    mapping,
    delimiter,
    dateOrder,
  });

  // An unanswered ambiguous file must never reach storage, whatever the token
  // situation is -- this is the hard backstop, independent of the controller
  // convenience check and independent of a client that manufactured a token
  // some other way.
  if (parsed.dateOrder.status === "AMBIGUOUS" && !parsed.dateOrder.resolved) {
    throw serviceError(
      "This file has dates that could be read either day-first or month-first, and no answer was given for which. Read the file again and state the date order before committing it.",
      409,
      { code: "GST_IMPORT_PREVIEW_STALE" }
    );
  }

  // Authoritative: the fresh re-parse's OWN resolution, not the value the
  // caller sent, so a file that changed between preview and commit (or whose
  // stated order no longer resolves the same way) fails this check rather
  // than silently committing under a different reading than what was reviewed.
  const parsedFingerprint = buildImportFingerprint({
    sourceHash: parsed.sourceHash,
    kind: normalizedKind,
    mapping: parsed.mapping,
    delimiter: parsed.delimiter,
    clientId,
    gstin: normalizedGstin,
    period,
    dateOrder: parsed.dateOrder.resolved || "NOT_APPLICABLE",
  });
  if (
    parsed.sourceHash !== String(sourceHash).toLowerCase() ||
    parsedFingerprint !== importFingerprint
  ) {
    throw serviceError(
      "Import inputs changed after preview; preview the current source and mapping again",
      409,
      { code: "GST_IMPORT_PREVIEW_STALE" }
    );
  }

  const clientExists = await Client.exists({ _id: clientId, firmId });
  if (!clientExists) {
    throw serviceError(
      "Client not found in active firm",
      404,
      { code: "GST_IMPORT_CLIENT_NOT_FOUND" }
    );
  }

  if (parsed.summary.invalidRows > 0) {
    throw serviceError("Import contains invalid rows and was not committed", 422, {
      summary: parsed.summary,
      errors: parsed.errors,
    });
  }

  const mismatchedRows = recipientGstinMismatchRows(parsed, normalizedKind, normalizedGstin);
  if (mismatchedRows.length) {
    throw serviceError("Recipient GSTIN does not match selected registration", 422, {
      code: "RECIPIENT_GSTIN_MISMATCH",
      rows: mismatchedRows.slice(0, 100),
    });
  }

  let gstr3bControl = null;
  if (normalizedKind === "GSTR3B_SUMMARY") {
    try {
      gstr3bControl = calculateGstr3bClaimed(parsed.rows.map((row) => row.values));
    } catch (error) {
      throw serviceError(
      // V13-P12-F2. INVALID_GSTR3B_SUMMARY is not on PUBLIC_ERROR_CODES, so production
      // already replaces this with generic 4xx copy - but development returns it verbatim,
      // and the code could be made public later without anyone revisiting this line.
      userFacingMessage(error, "This GSTR-3B summary could not be reconciled."),
      422,
      { code: "INVALID_GSTR3B_SUMMARY" },
    );
    }
  }
  const committedTaxMinor = gstr3bControl
    ? gstr3bControl.claimed.totalTaxMinor
    : parsed.summary.financialTotals?.totalTaxMinor || 0;
  await assertGstStorageIndexes();
  const metadata = {
    clientId,
    gstin: normalizedGstin,
    period,
    importFingerprint,
  };
  const identity = { firmId, kind: normalizedKind, importFingerprint };
  let batch = await ImportBatch.findOne(identity);
  if (batch?.status === "COMPLETED") {
    if (!batchMetadataMatches(batch, metadata)) {
      throw serviceError("This import fingerprint is already committed to different GST context", 409);
    }
    return { batch: serializeImportBatch(batch), replayed: true };
  }
  if (batch && !batchMetadataMatches(batch, metadata)) {
    throw serviceError("This import fingerprint is reserved by different GST context", 409);
  }

  let ownsProcessing = false;
  const processingToken = randomUUID();
  const processingExpiresAt = new Date(Date.now() + GST_IMPORT_PROCESSING_LEASE_MS);
  try {
    if (!batch) {
      try {
        batch = await ImportBatch.create({
          ...identity,
          clientId,
          gstin: normalizedGstin,
          period,
          sourceName: String(sourceName || "").trim().slice(0, 240),
          sourceHash: parsed.sourceHash,
          normalizationVersion: GST_IMPORT_NORMALIZATION_VERSION,
          delimiter: parsed.delimiter,
          dateOrder: parsed.dateOrder.resolved || "NOT_APPLICABLE",
          mapping: parsed.mapping,
          status: "PROCESSING",
          processingToken,
          processingExpiresAt,
          totalRows: parsed.summary.totalRows,
          validRows: parsed.summary.validRows,
          invalidRows: 0,
          totalTaxMinor: committedTaxMinor,
          requestId,
          createdBy: actorUserId,
          committedAt: new Date(),
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
          throw serviceError("This import fingerprint is already committed to different GST context", 409);
        }
        return { batch: serializeImportBatch(batch), replayed: true };
      }
      const claimTime = new Date();
      const claimed = await ImportBatch.findOneAndUpdate(
        {
          _id: batch._id,
          firmId,
          $or: [
            { status: { $in: ["FAILED", "PARTIAL"] } },
            {
              status: "PROCESSING",
              $or: [
                { processingExpiresAt: { $lte: claimTime } },
                { processingExpiresAt: null },
              ],
            },
          ],
        },
        {
          $set: {
            status: "PROCESSING",
            processingToken,
            processingExpiresAt: new Date(claimTime.getTime() + GST_IMPORT_PROCESSING_LEASE_MS),
            completedAt: null,
            requestId,
            committedAt: claimTime,
          },
        },
        { new: true }
      );
      if (!claimed) {
        throw serviceError("This import is already being processed", 409);
      }
      batch = claimed;
      ownsProcessing = true;
    }

    if (!batchMetadataMatches(batch, metadata)) {
      throw serviceError("This import was concurrently reserved by different GST context", 409);
    }

    const leaseNow = new Date();
    const leaseRenewal = await ImportBatch.updateOne(
      {
        _id: batch._id,
        firmId,
        status: "PROCESSING",
        processingToken,
        processingExpiresAt: { $gt: leaseNow },
      },
      {
        $set: {
          processingExpiresAt: new Date(leaseNow.getTime() + GST_IMPORT_PROCESSING_LEASE_MS),
        },
      }
    );
    if (leaseRenewal.matchedCount !== 1) {
      throw serviceError("Import processing ownership was lost", 409);
    }

    const operations = parsed.rows.map((row) => ({
      updateOne: {
        filter: {
          firmId,
          batchId: batch._id,
          importGeneration: processingToken,
          sourceRow: row.row,
        },
        update: {
          $setOnInsert: {
            firmId,
            batchId: batch._id,
            clientId,
            kind: normalizedKind,
            sourceHash: parsed.sourceHash,
            importGeneration: processingToken,
            sourceRow: row.row,
            dateOrder: parsed.dateOrder.resolved || "NOT_APPLICABLE",
            ...row.values,
            warnings: parsed.warnings
              .filter((warning) => warning.row === row.row)
              .map(({ field, code }) => ({ field, code })),
            createdBy: actorUserId,
          },
        },
        upsert: true,
      },
    }));
    if (operations.length) await ImportRow.bulkWrite(operations, { ordered: false });

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
          totalTaxMinor: committedTaxMinor,
          errorSummary: {
            warnings: parsed.warnings.slice(0, 100),
            ...(gstr3bControl ? { gstr3bBasis: gstr3bControl.basis } : {}),
          },
          completedAt: completionTime,
        },
      },
      { new: true, runValidators: true }
    );
    if (!batch) throw serviceError("Import processing ownership was lost", 409);

    await safeRecordActivity({
      firmId,
      actorUserId,
      source: "IMPORT",
      action: "GST_IMPORT_COMMITTED",
      entityType: "ImportBatch",
      entityId: batch._id,
      requestId,
      batchId: batch._id,
      afterSummary: {
        kind: normalizedKind,
        clientId,
        gstin: normalizedGstin,
        period,
        totalRows: parsed.summary.totalRows,
        totalTaxMinor: committedTaxMinor,
        importFingerprint,
        dateOrder: parsed.dateOrder.resolved || "NOT_APPLICABLE",
        gstr3bBasis: gstr3bControl?.basis || null,
      },
    });

    return { batch: serializeImportBatch(batch), replayed: false };
  } catch (error) {
    if (batch?._id && ownsProcessing) {
      await ImportBatch.updateOne(
        {
          _id: batch._id,
          firmId,
          status: { $ne: "COMPLETED" },
          processingToken,
        },
        {
          $set: {
            status: "FAILED",
            processingToken: null,
            processingExpiresAt: null,
            errorSummary: {
              code: String(error.code || error.name || "IMPORT_FAILED").slice(0, 80),
              // V13-P12-F2. This record is read back to the client verbatim (see toBatchView
              // and the FAILED branch of the status route), so it never passes through
              // publicErrorMessage. Only authored copy may be stored here.
              message: userFacingMessage(error, "Import failed. Check the file and try again.").slice(0, 500),
            },
            completedAt: new Date(),
          },
        }
      ).catch(() => {});
    }
    throw error;
  }
}

export async function getGstImportBatch({ firmId, batchId }) {
  assertObjectId(batchId, "Import batch");
  const batch = await ImportBatch.findOne({ _id: batchId, firmId }).lean();
  if (!batch || !GST_IMPORT_KINDS.includes(batch.kind)) {
    throw serviceError("GST import batch not found", 404);
  }
  return serializeImportBatch(batch);
}

export async function getGstImportErrors({ firmId, batchId }) {
  const batch = await getGstImportBatch({ firmId, batchId });
  return {
    id: batch.id,
    status: batch.status,
    invalidRows: batch.invalidRows,
    errorSummary: batch.errorSummary,
  };
}

export {
  GST_IMPORT_NORMALIZATION_VERSION,
  GST_IMPORT_PROCESSING_LEASE_MS,
  buildImportFingerprint,
  createGstImportPreviewAuthorization,
  serializeImportBatch,
  serviceError,
};
