import {
  loadComplianceCalendar,
  loadHomeSummary,
  WorkspaceQueryError,
} from "../services/workspace-summary.service.js";

function requestUserId(req) {
  return req.user?.id || req.user?._id;
}

function capturedNoticeCasesEnabled(req) {
  return req.featureFlagStates?.noticeCases?.enabled === true;
}

function rejectWorkspaceQuery(error, req, res, next) {
  if (!(error instanceof WorkspaceQueryError)) return next(error);
  return res.status(error.status).json({
    ok: false,
    error: error.message,
    requestId: req.id || "",
  });
}

export async function getHomeSummary(req, res, next) {
  try {
    const summary = await loadHomeSummary({
      firmId: req.user.firmId,
      userId: requestUserId(req),
      role: req.user.role,
      noticeCasesEnabled: capturedNoticeCasesEnabled(req),
    });
    return res.json({ ok: true, summary });
  } catch (error) {
    return rejectWorkspaceQuery(error, req, res, next);
  }
}

export async function getComplianceCalendar(req, res, next) {
  try {
    const calendar = await loadComplianceCalendar({
      firmId: req.user.firmId,
      userId: requestUserId(req),
      role: req.user.role,
      query: req.query || {},
      noticeCasesEnabled: capturedNoticeCasesEnabled(req),
    });
    return res.json({ ok: true, calendar });
  } catch (error) {
    return rejectWorkspaceQuery(error, req, res, next);
  }
}
