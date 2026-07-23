import {
  DigestError,
  getDigestPreferences,
  listDigestInbox,
  markDigestRead,
  previewDigest,
  updateDigestPreferences,
  updateFirmDigestSettings,
} from "../services/digest.service.js";

function actorId(req) {
  return req.user?.id || req.user?._id;
}

function enabled(req, flag) {
  return req.featureFlagStates?.[flag]?.enabled === true;
}

function handleDigestError(error, req, res, next) {
  if (!(error instanceof DigestError)) return next(error);
  return res.status(error.status).json({
    ok: false,
    error: error.message,
    code: error.code,
    requestId: req.id || "",
  });
}

export async function readDigestPreferences(req, res, next) {
  try {
    const settings = await getDigestPreferences({
      userId: actorId(req),
      firmId: req.user.firmId,
    });
    return res.json({ ok: true, settings });
  } catch (error) {
    return handleDigestError(error, req, res, next);
  }
}

export async function patchDigestPreferences(req, res, next) {
  try {
    const preferences = await updateDigestPreferences({
      userId: actorId(req),
      firmId: req.user.firmId,
      input: req.body,
      requestId: req.id || "",
    });
    return res.json({ ok: true, preferences });
  } catch (error) {
    return handleDigestError(error, req, res, next);
  }
}

export async function patchFirmDigestSettings(req, res, next) {
  try {
    const settings = await updateFirmDigestSettings({
      userId: actorId(req),
      firmId: req.user.firmId,
      input: req.body,
      requestId: req.id || "",
    });
    return res.json({ ok: true, settings });
  } catch (error) {
    return handleDigestError(error, req, res, next);
  }
}

export async function getDigestPreview(req, res, next) {
  try {
    const kind = String(req.query?.kind || "DAILY_PERSONAL").toUpperCase();
    const summary = await previewDigest({
      userId: actorId(req),
      firmId: req.user.firmId,
      role: req.user.role,
      kind,
      dailyEnabled: enabled(req, "dailyDigest"),
      weeklyEnabled: enabled(req, "weeklySummary"),
      noticeCasesEnabled: enabled(req, "noticeCases"),
    });
    return res.json({ ok: true, summary });
  } catch (error) {
    return handleDigestError(error, req, res, next);
  }
}

export async function getDigestInbox(req, res, next) {
  try {
    const inbox = await listDigestInbox({
      userId: actorId(req),
      firmId: req.user.firmId,
      query: req.query || {},
    });
    return res.json({ ok: true, inbox });
  } catch (error) {
    return handleDigestError(error, req, res, next);
  }
}

export async function readDigestInboxItem(req, res, next) {
  try {
    const digest = await markDigestRead({
      deliveryId: req.params.deliveryId,
      userId: actorId(req),
      firmId: req.user.firmId,
    });
    return res.json({ ok: true, digest });
  } catch (error) {
    return handleDigestError(error, req, res, next);
  }
}
