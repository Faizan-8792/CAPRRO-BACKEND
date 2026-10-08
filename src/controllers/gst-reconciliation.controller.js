import {
  applyItemDisposition,
  bulkDisposition,
  createReconciliationRun,
  exportReconciliationRun,
  getGstr3bControl,
  getReconciliationRun,
  getSupplierChase,
  listReconciliationActivity,
  listReconciliationItems,
  listReconciliationRuns,
  lockReconciliationRun,
  recoverReviewOperation,
} from "../services/gst-reconciliation.service.js";

const CREATE_FIELDS = new Set([
  "clientId",
  "gstin",
  "period",
  "booksBatchId",
  "portalBatchId",
  "gstr3bBatchId",
  "gstr1BatchId",
  "creditLedgerBatchId",
  "revisionOf",
  "roundingToleranceMinor",
  "dateToleranceDays",
  "priorPeriodAdjustment",
  "assignedTo",
]);
const DISPOSITION_FIELDS = new Set([
  "action",
  "candidatePortalRowId",
  "reason",
  "note",
  "ownerUserId",
  "chaseState",
  "taskId",
  "expectedDecisionVersion",
]);
const BULK_FIELDS = new Set([
  "mode",
  "itemIds",
  "action",
  "payload",
  "previewToken",
]);
const RECOVERY_FIELDS = new Set(["operationId"]);

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function validateBody(body, allowedFields, { allowEmpty = false } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw badRequest("JSON object body is required");
  }
  if (!allowEmpty && Object.keys(body).length === 0) {
    throw badRequest("Request body cannot be empty");
  }
  const unknownFields = Object.keys(body).filter((field) => !allowedFields.has(field));
  if (unknownFields.length) throw badRequest(`Unknown fields: ${unknownFields.join(", ")}`);
}

function dispositionPayload(body) {
  return {
    candidatePortalRowId: body.candidatePortalRowId,
    reason: body.reason,
    note: body.note,
    ownerUserId: body.ownerUserId,
    chaseState: body.chaseState,
    taskId: body.taskId,
  };
}

export async function createRun(req, res, next) {
  try {
    validateBody(req.body, CREATE_FIELDS);
    const result = await createReconciliationRun({
      firmId: req.user.firmId,
      actorUserId: req.user.id,
      requestId: req.id || "",
      ...req.body,
    });
    return res.status(result.replayed ? 200 : 202).json({
      ok: true,
      ...result,
      requestId: req.id || "",
    });
  } catch (error) {
    return next(error);
  }
}

export async function listRuns(req, res, next) {
  try {
    const result = await listReconciliationRuns({
      firmId: req.user.firmId,
      clientId: req.query.clientId,
      period: req.query.period,
      status: req.query.status,
      page: req.query.page,
      limit: req.query.limit,
    });
    return res.json({ ok: true, ...result, requestId: req.id || "" });
  } catch (error) {
    return next(error);
  }
}

export async function showRun(req, res, next) {
  try {
    const run = await getReconciliationRun({
      firmId: req.user.firmId,
      runId: req.params.id,
    });
    return res.json({ ok: true, run, requestId: req.id || "" });
  } catch (error) {
    return next(error);
  }
}

export async function listItems(req, res, next) {
  try {
    const result = await listReconciliationItems({
      firmId: req.user.firmId,
      runId: req.params.id,
      status: req.query.status,
      supplierGstin: req.query.supplierGstin,
      search: req.query.search,
      page: req.query.page,
      limit: req.query.limit,
    });
    return res.json({ ok: true, ...result, requestId: req.id || "" });
  } catch (error) {
    return next(error);
  }
}

export async function updateItemDisposition(req, res, next) {
  try {
    validateBody(req.body, DISPOSITION_FIELDS);
    const result = await applyItemDisposition({
      firmId: req.user.firmId,
      runId: req.params.id,
      itemId: req.params.itemId,
      actorUserId: req.user.id,
      requestId: req.id || "",
      action: req.body.action,
      expectedDecisionVersion: req.body.expectedDecisionVersion,
      payload: dispositionPayload(req.body),
    });
    return res.json({ ok: true, ...result, requestId: req.id || "" });
  } catch (error) {
    return next(error);
  }
}

export async function updateItemsBulk(req, res, next) {
  try {
    validateBody(req.body, BULK_FIELDS);
    if (req.body.payload != null) {
      validateBody(req.body.payload, new Set([...DISPOSITION_FIELDS].filter((field) => field !== "action")), { allowEmpty: true });
    }
    const result = await bulkDisposition({
      firmId: req.user.firmId,
      runId: req.params.id,
      actorUserId: req.user.id,
      requestId: req.id || "",
      mode: req.body.mode,
      itemIds: req.body.itemIds,
      action: req.body.action,
      payload: req.body.payload || {},
      previewToken: req.body.previewToken,
    });
    return res.json({ ok: true, result, requestId: req.id || "" });
  } catch (error) {
    return next(error);
  }
}

export async function showGstr3bControl(req, res, next) {
  try {
    const control = await getGstr3bControl({
      firmId: req.user.firmId,
      runId: req.params.id,
    });
    return res.json({ ok: true, control, requestId: req.id || "" });
  } catch (error) {
    return next(error);
  }
}

export async function showSupplierChase(req, res, next) {
  try {
    const chase = await getSupplierChase({
      firmId: req.user.firmId,
      runId: req.params.id,
    });
    return res.json({ ok: true, chase, requestId: req.id || "" });
  } catch (error) {
    return next(error);
  }
}

export async function recoverRunReview(req, res, next) {
  try {
    validateBody(req.body || {}, RECOVERY_FIELDS, { allowEmpty: true });
    const result = await recoverReviewOperation({
      firmId: req.user.firmId,
      runId: req.params.id,
      actorUserId: req.user.id,
      requestId: req.id || "",
      operationId: req.body?.operationId || null,
    });
    return res.json({ ok: true, ...result, requestId: req.id || "" });
  } catch (error) {
    return next(error);
  }
}

export async function lockRun(req, res, next) {
  try {
    validateBody(req.body || {}, new Set(), { allowEmpty: true });
    const result = await lockReconciliationRun({
      firmId: req.user.firmId,
      runId: req.params.id,
      actorUserId: req.user.id,
      requestId: req.id || "",
    });
    return res.json({ ok: true, ...result, requestId: req.id || "" });
  } catch (error) {
    return next(error);
  }
}

export async function exportRun(req, res, next) {
  try {
    const result = await exportReconciliationRun({
      firmId: req.user.firmId,
      runId: req.params.id,
    });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
    res.setHeader("X-Reconciliation-Item-Count", String(result.itemCount));
    return res.send(result.content);
  } catch (error) {
    return next(error);
  }
}

export async function listActivity(req, res, next) {
  try {
    const activity = await listReconciliationActivity({
      firmId: req.user.firmId,
      runId: req.params.id,
      limit: req.query.limit,
    });
    return res.json({ ok: true, activity, requestId: req.id || "" });
  } catch (error) {
    return next(error);
  }
}
