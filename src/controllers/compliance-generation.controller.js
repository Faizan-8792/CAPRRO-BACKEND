import {
  createComplianceGenerationPreview,
  enqueueComplianceGeneration,
} from "../services/compliance-generation.service.js";

const PREVIEW_FIELDS = new Set(["clientId", "assignedTo", "items"]);
const CONFIRM_FIELDS = new Set([
  "clientId",
  "assignedTo",
  "items",
  "previewHash",
]);

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function assertBody(body, allowedFields) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw httpError(400, "JSON object body is required");
  }
  const unknownFields = Object.keys(body).filter(
    (field) => !allowedFields.has(field)
  );
  if (unknownFields.length) {
    throw httpError(400, `Unknown fields: ${unknownFields.join(", ")}`);
  }
  return body;
}

function generationInput(body) {
  return {
    clientId: body.clientId,
    ...(Object.prototype.hasOwnProperty.call(body, "assignedTo")
      ? { assignedTo: body.assignedTo }
      : {}),
    items: body.items,
  };
}

function forwardKnownError(error, next) {
  if (!error.statusCode && ["ValidationError", "CastError"].includes(error.name)) {
    error.statusCode = 400;
  }
  if (!error.statusCode && error.code === 11000) {
    error.statusCode = 409;
    error.message = "A generated record with this key already exists";
  }
  return next(error);
}

export async function previewComplianceGeneration(req, res, next) {
  try {
    const body = assertBody(req.body, PREVIEW_FIELDS);
    const preview = await createComplianceGenerationPreview({
      firmId: req.user.firmId,
      actorUserId: req.user.id,
      input: generationInput(body),
    });

    return res.json({
      ok: true,
      preview,
      requestId: req.id || "",
    });
  } catch (error) {
    return forwardKnownError(error, next);
  }
}

export async function confirmComplianceGeneration(req, res, next) {
  try {
    const body = assertBody(req.body, CONFIRM_FIELDS);
    const result = await enqueueComplianceGeneration({
      firmId: req.user.firmId,
      actorUserId: req.user.id,
      input: generationInput(body),
      previewHash: body.previewHash,
      requestId: req.id || "",
    });

    return res.status(202).json({
      ok: true,
      ...result,
      requestId: req.id || "",
    });
  } catch (error) {
    return forwardKnownError(error, next);
  }
}
