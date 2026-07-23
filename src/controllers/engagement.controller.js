import {
  buildEngagementExport,
  createEngagement,
  createEngagementFinding,
  engagementPublicationFromRequest,
  getEngagementDetail,
  listEngagements,
  listEngagementTemplates,
  reviewEngagement,
  updateEngagement,
  updateEngagementFinding,
} from "../services/engagement.service.js";

function context(req) {
  return {
    firmId: req.user.firmId,
    actorUserId: req.user.id,
    requestId: req.id || "",
    publication: engagementPublicationFromRequest(req),
  };
}

export async function listTemplates(_req, res, next) {
  try {
    return res.json({
      ok: true,
      templates: listEngagementTemplates(),
      professionalConclusionGenerated: false,
      automaticPortalSubmissionPerformed: false,
      templateQualificationVerifiedByPlatform: false,
    });
  } catch (error) {
    return next(error);
  }
}

export async function createEngagementRecord(req, res, next) {
  try {
    const engagement = await createEngagement({
      ...context(req),
      input: req.body || {},
    });
    return res.status(201).json({ ok: true, engagement });
  } catch (error) {
    return next(error);
  }
}

export async function listEngagementRecords(req, res, next) {
  try {
    const result = await listEngagements({
      firmId: req.user.firmId,
      query: req.query || {},
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return next(error);
  }
}

export async function showEngagement(req, res, next) {
  try {
    const detail = await getEngagementDetail({
      engagementId: req.params.id,
      firmId: req.user.firmId,
      query: req.query || {},
    });
    return res.json({ ok: true, ...detail });
  } catch (error) {
    return next(error);
  }
}

export async function patchEngagement(req, res, next) {
  try {
    const engagement = await updateEngagement({
      ...context(req),
      engagementId: req.params.id,
      user: req.user,
      input: req.body || {},
    });
    return res.json({ ok: true, engagement });
  } catch (error) {
    return next(error);
  }
}

export async function createFinding(req, res, next) {
  try {
    const finding = await createEngagementFinding({
      ...context(req),
      engagementId: req.params.id,
      input: req.body || {},
    });
    return res.status(201).json({ ok: true, finding });
  } catch (error) {
    return next(error);
  }
}

export async function patchFinding(req, res, next) {
  try {
    const finding = await updateEngagementFinding({
      ...context(req),
      engagementId: req.params.id,
      findingId: req.params.findingId,
      user: req.user,
      input: req.body || {},
    });
    return res.json({ ok: true, finding });
  } catch (error) {
    return next(error);
  }
}

export async function reviewEngagementRecord(req, res, next) {
  try {
    const engagement = await reviewEngagement({
      ...context(req),
      engagementId: req.params.id,
      user: req.user,
      input: req.body || {},
    });
    return res.json({ ok: true, engagement });
  } catch (error) {
    return next(error);
  }
}

export async function exportEngagement(req, res, next) {
  try {
    const buffer = await buildEngagementExport({
      engagementId: req.params.id,
      firmId: req.user.firmId,
    });
    const safeId = String(req.params.id).replace(/[^a-zA-Z0-9_-]/g, "");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="engagement-${safeId}.json"`
    );
    return res.status(200).send(buffer);
  } catch (error) {
    return next(error);
  }
}
