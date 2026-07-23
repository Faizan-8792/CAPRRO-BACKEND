import {
  FirmOperationsQueryError,
  loadFilingDashboard,
  loadReviewQueue,
  loadTeamWorkload,
  searchWorkspace,
} from "../services/firm-operations.service.js";

function featureEnabled(req, name) {
  return req.featureFlagStates?.[name]?.enabled === true;
}

function handleQueryError(error, req, res, next) {
  if (!(error instanceof FirmOperationsQueryError)) return next(error);
  return res.status(error.status).json({
    ok: false,
    error: error.message,
    code: error.code,
    requestId: req.id || "",
  });
}

export async function getFilingDashboard(req, res, next) {
  try {
    const dashboard = await loadFilingDashboard({
      firmId: req.user.firmId,
      query: req.query || {},
    });
    return res.json({ ok: true, dashboard });
  } catch (error) {
    return handleQueryError(error, req, res, next);
  }
}

export async function getTeamWorkload(req, res, next) {
  try {
    const workload = await loadTeamWorkload({
      firmId: req.user.firmId,
      query: req.query || {},
      noticeCasesEnabled: featureEnabled(req, "noticeCases"),
    });
    return res.json({ ok: true, workload });
  } catch (error) {
    return handleQueryError(error, req, res, next);
  }
}

export async function getWorkspaceSearch(req, res, next) {
  try {
    const results = await searchWorkspace({
      firmId: req.user.firmId,
      query: req.query || {},
      noticeCasesEnabled: featureEnabled(req, "noticeCases"),
    });
    return res.json({ ok: true, results });
  } catch (error) {
    return handleQueryError(error, req, res, next);
  }
}

export async function getReviewQueue(req, res, next) {
  try {
    const queue = await loadReviewQueue({
      firmId: req.user.firmId,
      query: req.query || {},
      noticeCasesEnabled: featureEnabled(req, "noticeCases"),
      gstEnabled: featureEnabled(req, "gstReconciliation"),
      tdsEnabled: featureEnabled(req, "tdsHealth"),
    });
    return res.json({ ok: true, queue });
  } catch (error) {
    return handleQueryError(error, req, res, next);
  }
}
