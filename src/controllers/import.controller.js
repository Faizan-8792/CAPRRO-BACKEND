import { previewImport } from "../services/import-preview.service.js";
import {
  commitGstImport,
  createGstImportPreviewAuthorization,
  getGstImportBatch,
  getGstImportErrors,
} from "../services/gst-import.service.js";
import {
  commitTdsImport,
  createTdsImportPreviewAuthorization,
  getTdsImportBatch,
  getTdsImportErrors,
} from "../services/tds-import.service.js";
import { TDS_IMPORT_KINDS } from "../services/tds-normalization.service.js";

const PREVIEW_FIELDS = new Set([
  "kind",
  "text",
  "mapping",
  "delimiter",
  "clientId",
  "gstin",
  "period",
  "tan",
  "financialYear",
  "quarter",
  "statementType",
]);
const COMMIT_FIELDS = new Set([
  "kind",
  "text",
  "mapping",
  "delimiter",
  "sourceName",
  "clientId",
  "gstin",
  "period",
  "previewToken",
]);
const TDS_COMMIT_FIELDS = new Set([
  "kind",
  "text",
  "mapping",
  "delimiter",
  "sourceName",
  "clientId",
  "tan",
  "financialYear",
  "quarter",
  "statementType",
  "previewToken",
]);

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function validateBody(body, allowedFields) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw badRequest("JSON object body is required");
  }
  const unknownFields = Object.keys(body).filter(
    (field) => !allowedFields.has(field)
  );
  if (unknownFields.length) {
    throw badRequest(`Unknown fields: ${unknownFields.join(", ")}`);
  }
}

function requestDelimiter(value) {
  return value === "TAB" ? "\t" : value || null;
}

export async function previewMappedImport(req, res, next) {
  try {
    validateBody(req.body, PREVIEW_FIELDS);
    const preview = previewImport({
      kind: req.body.kind,
      text: req.body.text,
      mapping: req.body.mapping,
      delimiter: requestDelimiter(req.body.delimiter),
    });
    let authorization = {};
    if (TDS_IMPORT_KINDS.includes(preview.kind)) {
      authorization = createTdsImportPreviewAuthorization({
        sourceHash: preview.sourceHash,
        kind: preview.kind,
        mapping: preview.mapping,
        delimiter: preview.delimiter,
        clientId: req.body.clientId,
        tan: req.body.tan,
        financialYear: req.body.financialYear,
        quarter: req.body.quarter,
        statementType: req.body.statementType,
      });
    } else if (preview.kind !== "CLIENTS") {
      authorization = createGstImportPreviewAuthorization({
        sourceHash: preview.sourceHash,
        kind: preview.kind,
        mapping: preview.mapping,
        delimiter: preview.delimiter,
        clientId: req.body.clientId,
        gstin: req.body.gstin,
        period: req.body.period,
      });
    }

    return res.json({
      ok: true,
      preview: { ...preview, ...authorization },
      requestId: req.id || "",
    });
  } catch (error) {
    if (!error.statusCode) error.statusCode = 400;
    return next(error);
  }
}

export async function commitMappedGstImport(req, res, next) {
  try {
    validateBody(req.body, COMMIT_FIELDS);
    const result = await commitGstImport({
      firmId: req.user.firmId,
      actorUserId: req.user.id,
      requestId: req.id || "",
      sourceHash: req.params.sourceHash,
      sourceName: req.body.sourceName,
      kind: req.body.kind,
      text: req.body.text,
      mapping: req.body.mapping,
      delimiter: requestDelimiter(req.body.delimiter),
      previewToken: req.body.previewToken,
      clientId: req.body.clientId,
      gstin: req.body.gstin,
      period: req.body.period,
    });
    return res.status(result.replayed ? 200 : 201).json({
      ok: true,
      replayed: result.replayed,
      batch: result.batch,
      requestId: req.id || "",
    });
  } catch (error) {
    return next(error);
  }
}

export async function commitMappedTdsImport(req, res, next) {
  try {
    validateBody(req.body, TDS_COMMIT_FIELDS);
    const result = await commitTdsImport({
      firmId: req.user.firmId,
      actorUserId: req.user.id,
      requestId: req.id || "",
      sourceHash: req.params.sourceHash,
      sourceName: req.body.sourceName,
      kind: req.body.kind,
      text: req.body.text,
      mapping: req.body.mapping,
      delimiter: requestDelimiter(req.body.delimiter),
      previewToken: req.body.previewToken,
      clientId: req.body.clientId,
      tan: req.body.tan,
      financialYear: req.body.financialYear,
      quarter: req.body.quarter,
      statementType: req.body.statementType,
    });
    return res.status(result.replayed ? 200 : 201).json({
      ok: true,
      replayed: result.replayed,
      batch: result.batch,
      requestId: req.id || "",
    });
  } catch (error) {
    return next(error);
  }
}

export async function showGstImportBatch(req, res, next) {
  try {
    const batch = await getGstImportBatch({
      firmId: req.user.firmId,
      batchId: req.params.id,
    });
    return res.json({ ok: true, batch, requestId: req.id || "" });
  } catch (error) {
    return next(error);
  }
}

export async function showGstImportErrors(req, res, next) {
  try {
    const report = await getGstImportErrors({
      firmId: req.user.firmId,
      batchId: req.params.id,
    });
    return res.json({ ok: true, report, requestId: req.id || "" });
  } catch (error) {
    return next(error);
  }
}

export async function showTdsImportBatch(req, res, next) {
  try {
    const batch = await getTdsImportBatch({
      firmId: req.user.firmId,
      batchId: req.params.id,
    });
    return res.json({ ok: true, batch, requestId: req.id || "" });
  } catch (error) {
    return next(error);
  }
}

export async function showTdsImportErrors(req, res, next) {
  try {
    const report = await getTdsImportErrors({
      firmId: req.user.firmId,
      batchId: req.params.id,
    });
    return res.json({ ok: true, report, requestId: req.id || "" });
  } catch (error) {
    return next(error);
  }
}
