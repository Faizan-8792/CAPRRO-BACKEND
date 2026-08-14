import {
  DigestError,
  applyDigestUnsubscribe,
  getDigestPreferences,
  listDigestInbox,
  markDigestRead,
  previewDigest,
  previewDigestUnsubscribe,
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

// ─── Public, no-login unsubscribe (RFC 8058 / CAN-SPAM) ───────────────────
// Deliberately does NOT use actorId(req)/req.user - there is no session on
// this path at all. req.user is simply absent here (this router mounts
// these two routes ABOVE its own router.use(authRequired, ...) line, see
// digest.routes.js), and the recipient identity + authority instead come
// entirely from the signed token in the request itself.

export async function getDigestUnsubscribePreview(req, res, next) {
  try {
    const preview = await previewDigestUnsubscribe({
      recipientUserId: req.query?.u,
      kind: req.query?.k,
      token: req.query?.t,
    });
    return res.json({ ok: true, ...preview });
  } catch (error) {
    return handleDigestError(error, req, res, next);
  }
}

// u/k/t travel in the QUERY STRING, not the body, on purpose: RFC 8058's
// automatic one-click handler POSTs to exactly the URL named in the
// List-Unsubscribe header with a fixed body of "List-Unsubscribe=One-Click"
// and nothing else - it cannot be told to add its own body fields. Reading
// the identity/token from req.query keeps the SAME url a mail client
// auto-POSTs to also work when the confirmation page submits an explicit
// scope choice as its own POST body, without requiring two different
// request shapes for the same route.
//
// A one-click request with no scope in the body defaults to THIS_KIND, the
// least surprising interpretation of a bare unsubscribe click with no
// choice offered - it stops the exact digest the header/link was attached
// to, not silently every digest email the recipient has.
export async function postDigestUnsubscribe(req, res, next) {
  try {
    const result = await applyDigestUnsubscribe({
      recipientUserId: req.query?.u,
      kind: req.query?.k,
      token: req.query?.t,
      scope: req.body?.scope || "THIS_KIND",
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return handleDigestError(error, req, res, next);
  }
}
