import {
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
  recordPanVerification,
  resolveTdsHealthCheck,
} from "../services/tds-health.service.js";

const CREATE_FIELDS = new Set([
  "clientId",
  "tan",
  "financialYear",
  "quarter",
  "statementType",
  "deductionsBatchId",
  "challansBatchId",
  "statementsBatchId",
  "creditBatchId",
  "revisionOf",
  "correctionReason",
  "assignedTo",
]);
const RESOLUTION_FIELDS = new Set([
  "action",
  "note",
  "expectedResolutionVersion",
]);
const PAN_VERIFICATION_FIELDS = new Set([
  "status",
  "sourceReference",
  "note",
  "expectedResolutionVersion",
]);
const PAN_VERIFICATION_COMPAT_FIELDS = new Set([
  "runId",
  "checkId",
  ...PAN_VERIFICATION_FIELDS,
]);
const ACTION_PLAN_FIELDS = new Set([
  "checkIds",
  "ownerUserId",
  "dueDateISO",
  "priority",
  "reviewerNote",
  "previewToken",
]);

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

function actionPlanInput(req) {
  return {
    firmId: req.user.firmId,
    runId: req.params.id,
    checkIds: req.body.checkIds,
    ownerUserId: req.body.ownerUserId,
    dueDateISO: req.body.dueDateISO,
    priority: req.body.priority,
    reviewerNote: req.body.reviewerNote,
  };
}

export async function createRun(req, res, next) {
  try {
    validateBody(req.body, CREATE_FIELDS);
    const result = await createTdsHealthRun({
      firmId: req.user.firmId,
      actorUserId: req.user.id,
      requestId: req.id || "",
      ...req.body,
    });
    return res.status(result.replayed ? 200 : 202).json({ ok: true, ...result, requestId: req.id || "" });
  } catch (error) {
    return next(error);
  }
}

export async function listRuns(req, res, next) {
  try {
    const result = await listTdsHealthRuns({
      firmId: req.user.firmId,
      clientId: req.query.clientId,
      status: req.query.status,
      financialYear: req.query.financialYear,
      quarter: req.query.quarter,
      statementType: req.query.statementType,
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
    const run = await getTdsHealthRun({ firmId: req.user.firmId, runId: req.params.id });
    return res.json({ ok: true, run, requestId: req.id || "" });
  } catch (error) {
    return next(error);
  }
}

export async function listChecks(req, res, next) {
  try {
    const result = await listTdsHealthChecks({
      firmId: req.user.firmId,
      runId: req.params.id,
      status: req.query.status,
      dimension: req.query.dimension,
      state: req.query.state,
      page: req.query.page,
      limit: req.query.limit,
    });
    return res.json({ ok: true, ...result, requestId: req.id || "" });
  } catch (error) {
    return next(error);
  }
}

export async function listEvidence(req, res, next) {
  try {
    const result = await listTdsHealthEvidence({
      firmId: req.user.firmId,
      runId: req.params.id,
      checkId: req.params.checkId,
      page: req.query.page,
      limit: req.query.limit,
    });
    return res.json({ ok: true, ...result, requestId: req.id || "" });
  } catch (error) {
    return next(error);
  }
}

export async function listRows(req, res, next) {
  try {
    const result = await listTdsImportRows({
      firmId: req.user.firmId,
      runId: req.params.id,
      kind: req.query.kind,
      pan: req.query.pan,
      page: req.query.page,
      limit: req.query.limit,
    });
    return res.json({ ok: true, ...result, requestId: req.id || "" });
  } catch (error) {
    return next(error);
  }
}

export async function resolveCheck(req, res, next) {
  try {
    validateBody(req.body, RESOLUTION_FIELDS);
    const result = await resolveTdsHealthCheck({
      firmId: req.user.firmId,
      runId: req.params.id,
      checkId: req.params.checkId,
      actorUserId: req.user.id,
      requestId: req.id || "",
      ...req.body,
    });
    return res.json({ ok: true, ...result, requestId: req.id || "" });
  } catch (error) {
    return next(error);
  }
}

export async function verifyPan(req, res, next) {
  try {
    validateBody(req.body, PAN_VERIFICATION_FIELDS);
    const result = await recordPanVerification({
      firmId: req.user.firmId,
      runId: req.params.id,
      checkId: req.params.checkId,
      actorUserId: req.user.id,
      requestId: req.id || "",
      ...req.body,
    });
    return res.json({ ok: true, ...result, requestId: req.id || "" });
  } catch (error) {
    return next(error);
  }
}

export async function verifyPanCompatibility(req, res, next) {
  try {
    validateBody(req.body, PAN_VERIFICATION_COMPAT_FIELDS);
    const { runId, checkId, ...verification } = req.body;
    const result = await recordPanVerification({
      firmId: req.user.firmId,
      runId,
      checkId,
      actorUserId: req.user.id,
      requestId: req.id || "",
      ...verification,
    });
    return res.json({ ok: true, ...result, requestId: req.id || "" });
  } catch (error) {
    return next(error);
  }
}

export async function previewActionPlan(req, res, next) {
  try {
    validateBody(req.body, ACTION_PLAN_FIELDS);
    if (req.body.previewToken != null) throw badRequest("previewToken is only accepted by action-plan commit");
    const result = await previewTdsActionPlan(actionPlanInput(req));
    return res.json({ ok: true, result, requestId: req.id || "" });
  } catch (error) {
    return next(error);
  }
}

export async function showActionPlan(req, res, next) {
  try {
    const result = await getTdsActionPlan({
      firmId: req.user.firmId,
      runId: req.params.id,
      page: req.query.page,
      limit: req.query.limit,
    });
    return res.json({ ok: true, ...result, requestId: req.id || "" });
  } catch (error) {
    return next(error);
  }
}

export async function commitActionPlan(req, res, next) {
  try {
    validateBody(req.body, ACTION_PLAN_FIELDS);
    const result = await commitTdsActionPlan({
      ...actionPlanInput(req),
      previewToken: req.body.previewToken,
      actorUserId: req.user.id,
      requestId: req.id || "",
    });
    return res.status(result.replayed ? 200 : 201).json({ ok: true, result, requestId: req.id || "" });
  } catch (error) {
    return next(error);
  }
}

export async function createTasksCompatibility(req, res, next) {
  try {
    validateBody(req.body, ACTION_PLAN_FIELDS);
    if (req.body.previewToken == null) {
      const result = await previewTdsActionPlan(actionPlanInput(req));
      return res.json({ ok: true, mode: "PREVIEW", result, requestId: req.id || "" });
    }
    const result = await commitTdsActionPlan({
      ...actionPlanInput(req),
      previewToken: req.body.previewToken,
      actorUserId: req.user.id,
      requestId: req.id || "",
    });
    return res.status(result.replayed ? 200 : 201).json({
      ok: true,
      mode: "COMMIT",
      result,
      requestId: req.id || "",
    });
  } catch (error) {
    return next(error);
  }
}

export async function lockRun(req, res, next) {
  try {
    validateBody(req.body || {}, new Set(), { allowEmpty: true });
    const result = await lockTdsHealthRun({
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
    const result = await exportTdsHealthRun({ firmId: req.user.firmId, runId: req.params.id });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
    res.setHeader("X-TDS-Health-Check-Count", String(result.checkCount));
    res.setHeader("X-TDS-Health-Evidence-Count", String(result.evidenceCount));
    return res.send(result.content);
  } catch (error) {
    return next(error);
  }
}

export async function listHistory(req, res, next) {
  try {
    const history = await listTdsHealthHistory({
      firmId: req.user.firmId,
      runId: req.params.id,
      limit: req.query.limit,
    });
    return res.json({ ok: true, history, requestId: req.id || "" });
  } catch (error) {
    return next(error);
  }
}
