import { previewImport, suggestImportMapping } from "../services/import-preview.service.js";
import { convertGstr2bJson } from "../services/gstr2b-json.service.js";
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
  "dateOrder",
  "clientId",
  "gstin",
  "period",
  "tan",
  "financialYear",
  "quarter",
  "statementType",
]);
// A suggestion needs the file and nothing else: no mapping (that is what it produces), and no
// statutory context, because it neither previews figures nor authorizes a commit.
const SUGGEST_FIELDS = new Set(["kind", "text", "delimiter"]);
const COMMIT_FIELDS = new Set([
  "kind",
  "text",
  "mapping",
  "delimiter",
  "dateOrder",
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
  "dateOrder",
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

/**
 * Proposes a column mapping for a file, without importing anything.
 *
 * Deliberately issues NO commit token and touches no collection. It reads the header row and
 * answers "which column looks like which field", so a person confirms a proposal instead of
 * mapping ten columns by hand on every file. Everything it returns is overridable by the caller,
 * and the preview it feeds still re-validates the file from scratch.
 */
export async function suggestImportMappingForFile(req, res, next) {
  try {
    validateBody(req.body, SUGGEST_FIELDS);
    const suggestion = suggestImportMapping({
      kind: req.body.kind,
      text: req.body.text,
      delimiter: requestDelimiter(req.body.delimiter),
    });
    return res.json({ ok: true, suggestion });
  } catch (error) {
    return next(error);
  }
}

export async function previewMappedImport(req, res, next) {
  try {
    validateBody(req.body, PREVIEW_FIELDS);
    const preview = previewImport({
      kind: req.body.kind,
      text: req.body.text,
      mapping: req.body.mapping,
      delimiter: requestDelimiter(req.body.delimiter),
      dateOrder: req.body.dateOrder || null,
    });
    let authorization = {};
    // An AMBIGUOUS file with no resolved order must never carry a commit
    // authorization, whatever kind it is -- the person has not yet said which
    // reading of the dates the figures below actually mean.
    const dateOrderUnanswered = preview.dateOrder
      && preview.dateOrder.status === "AMBIGUOUS"
      && !preview.dateOrder.resolved;
    if (dateOrderUnanswered) {
      // authorization stays {}; no commitToken is issued.
    } else if (TDS_IMPORT_KINDS.includes(preview.kind)) {
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
        // This function does not re-parse the file, so it is given the
        // ALREADY-RESOLVED order from the previewImport() call above, not the
        // raw stated request value.
        dateOrder: preview.dateOrder.resolved || "NOT_APPLICABLE",
      });
    } else if (preview.kind !== "CLIENTS") {
      authorization = await createGstImportPreviewAuthorization({
        firmId: req.user.firmId,
        sourceHash: preview.sourceHash,
        kind: preview.kind,
        text: req.body.text,
        mapping: preview.mapping,
        delimiter: preview.delimiter,
        clientId: req.body.clientId,
        gstin: req.body.gstin,
        period: req.body.period,
        // This function re-parses the file itself, so it is given the raw
        // stated request value and derives its own authoritative resolution
        // from that fresh parse.
        dateOrder: req.body.dateOrder || null,
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
      dateOrder: req.body.dateOrder || null,
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
      dateOrder: req.body.dateOrder || null,
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


// Convert a GST portal GSTR-2B JSON export into preview-ready delimited text +
// column mapping. The client then feeds this into the normal /preview + /commit
// flow (kind GSTR2B) — no change to the proven ingestion path.
export const convertGstr2bImport = async (req, res, next) => {
  try {
    const input =
      req.body && typeof req.body.json === "object" ? req.body.json : req.body;
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw badRequest("A GSTR-2B JSON object is required");
    }
    const result = convertGstr2bJson(input);
    return res.json({
      ok: true,
      kind: "GSTR2B",
      text: result.csv,
      mapping: result.mapping,
      headers: result.headers,
      meta: result.meta,
      warnings: result.warnings,
    });
  } catch (err) {
    return next(err);
  }
};
