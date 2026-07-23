import {
  commitTaskBulk,
  getTaskBulkOperation,
  previewTaskBulk,
  TaskBulkError,
} from "../services/task-bulk.service.js";

function actorId(req) {
  return req.user?.id || req.user?._id;
}

function handleBulkError(error, req, res, next) {
  if (!(error instanceof TaskBulkError)) return next(error);
  return res.status(error.status).json({
    ok: false,
    error: error.message,
    code: error.code,
    requestId: req.id || "",
    ...(error.details ? { details: error.details } : {}),
  });
}

export async function previewBulkTaskUpdate(req, res, next) {
  try {
    const preview = await previewTaskBulk({
      firmId: req.user.firmId,
      actorUserId: actorId(req),
      rawItems: req.body?.items,
      requestId: req.id || "",
    });
    if (!preview.committable) {
      return res.status(422).json({
        ok: false,
        error: "No task passed preview validation",
        code: "TASK_BULK_NOT_COMMITTABLE",
        contentHash: preview.contentHash,
        items: preview.items,
        requestId: req.id || "",
      });
    }
    return res.status(201).json({ ok: true, ...preview });
  } catch (error) {
    return handleBulkError(error, req, res, next);
  }
}

export async function commitBulkTaskUpdate(req, res, next) {
  try {
    const operation = await commitTaskBulk({
      operationId: req.params.operationId,
      firmId: req.user.firmId,
      actorUserId: actorId(req),
      previewToken: req.body?.previewToken,
      contentHash: req.body?.contentHash,
    });
    return res.json({ ok: true, operation });
  } catch (error) {
    return handleBulkError(error, req, res, next);
  }
}

export async function readBulkTaskOperation(req, res, next) {
  try {
    const operation = await getTaskBulkOperation({
      operationId: req.params.operationId,
      firmId: req.user.firmId,
      actorUserId: actorId(req),
    });
    return res.json({ ok: true, operation });
  } catch (error) {
    return handleBulkError(error, req, res, next);
  }
}
