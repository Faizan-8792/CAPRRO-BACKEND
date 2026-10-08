import AppConfig from "../models/AppConfig.js";
import {
  createAnalysis,
  createDraft,
  finalizeDraft,
  recordSubmission,
  reviewDraft,
  submitDraftForReview,
} from "../services/case-content.service.js";
import {
  addCaseTimelineEntry,
  addVerifiedReference,
  buildCaseExport,
  confirmCaseFields,
  createCaseMatter,
  getCaseDetail,
  listCaseMatters,
  listVerifiedReferences,
  runCaseExtraction,
  updateCaseMatter,
} from "../services/case-record.service.js";
import { extractTextWithOcrSpace } from "../services/ocr-space.service.js";
import { noticePublicationFromRequest } from "../services/notice-publication.service.js";

function context(req) {
  return {
    firmId: req.user.firmId,
    actorUserId: req.user.id,
    requestId: req.id || "",
    noticePublication: noticePublicationFromRequest(req),
  };
}

async function assertNoticeRequestCurrent(req) {
  return AppConfig.assertFeatureFlagVersion(
    "noticeCases",
    req.featureFlagVersions?.noticeCases,
    req.featureFlagPublicationFences?.noticeCases ?? null,
  );
}

export async function previewCaseOcr(req, res, next) {
  try {
    await assertNoticeRequestCurrent(req);
    const result = await extractTextWithOcrSpace({
      buffer: req.file?.buffer,
      mimeType: req.file?.mimetype,
      fileName: req.file?.originalname,
      consent: String(req.body?.consent || "").toLowerCase() === "true",
      userId: req.user.id,
    });
    return res.json({ ok: true, zeroWrite: true, result });
  } catch (error) {
    return next(error);
  }
}

export async function createCase(req, res, next) {
  try {
    const caseMatter = await createCaseMatter({
      ...context(req),
      input: req.body || {},
    });
    return res.status(201).json({ ok: true, case: caseMatter });
  } catch (error) {
    return next(error);
  }
}

export async function listCases(req, res, next) {
  try {
    const result = await listCaseMatters({
      firmId: req.user.firmId,
      query: req.query || {},
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return next(error);
  }
}

export async function showCase(req, res, next) {
  try {
    const detail = await getCaseDetail({
      caseId: req.params.id,
      firmId: req.user.firmId,
      query: req.query || {},
    });
    return res.json({ ok: true, ...detail });
  } catch (error) {
    return next(error);
  }
}

export async function proposeCaseFields(req, res, next) {
  try {
    await assertNoticeRequestCurrent(req);
    const caseMatter = await runCaseExtraction({
      ...context(req),
      caseId: req.params.id,
      input: req.body || {},
    });
    return res.json({ ok: true, case: caseMatter });
  } catch (error) {
    return next(error);
  }
}

export async function confirmFields(req, res, next) {
  try {
    const result = await confirmCaseFields({
      ...context(req),
      caseId: req.params.id,
      input: req.body || {},
    });
    const artifacts = result.deadlineArtifacts;
    return res.json({
      ok: true,
      case: result.caseMatter,
      deadlineArtifacts:
        artifacts && (artifacts.task || artifacts.reminder)
          ? {
              taskId: artifacts.task?._id || null,
              reminderId: artifacts.reminder?._id || null,
              active: artifacts.active,
              deactivated: artifacts.deactivated,
              scheduleChanged: artifacts.scheduleChanged,
            }
          : null,
    });
  } catch (error) {
    return next(error);
  }
}

export async function patchCase(req, res, next) {
  try {
    const caseMatter = await updateCaseMatter({
      ...context(req),
      caseId: req.params.id,
      input: req.body || {},
    });
    return res.json({ ok: true, case: caseMatter });
  } catch (error) {
    return next(error);
  }
}

export async function createTimelineEntry(req, res, next) {
  try {
    const event = await addCaseTimelineEntry({
      ...context(req),
      caseId: req.params.id,
      input: req.body || {},
    });
    return res.status(201).json({ ok: true, event });
  } catch (error) {
    return next(error);
  }
}

export async function verifyReference(req, res, next) {
  try {
    const reference = await addVerifiedReference({
      ...context(req),
      caseId: req.params.id,
      input: req.body || {},
    });
    return res.status(201).json({ ok: true, reference });
  } catch (error) {
    return next(error);
  }
}

export async function listReferences(req, res, next) {
  try {
    const references = await listVerifiedReferences({
      caseId: req.params.id,
      firmId: req.user.firmId,
    });
    return res.json({ ok: true, references });
  } catch (error) {
    return next(error);
  }
}

export async function generateAnalysis(req, res, next) {
  try {
    await assertNoticeRequestCurrent(req);
    const analysis = await createAnalysis({
      ...context(req),
      caseId: req.params.id,
      input: req.body || {},
    });
    return res.status(201).json({ ok: true, analysis });
  } catch (error) {
    return next(error);
  }
}

export async function createResponseDraft(req, res, next) {
  try {
    if (String(req.body?.origin || "USER").toUpperCase() === "AI_ASSISTED") {
      await assertNoticeRequestCurrent(req);
    }
    const draft = await createDraft({
      ...context(req),
      caseId: req.params.id,
      input: req.body || {},
    });
    return res.status(201).json({ ok: true, draft });
  } catch (error) {
    return next(error);
  }
}

export async function sendDraftForReview(req, res, next) {
  try {
    const draft = await submitDraftForReview({
      ...context(req),
      caseId: req.params.id,
      draftId: req.params.draftId,
      input: req.body || {},
    });
    return res.json({ ok: true, draft });
  } catch (error) {
    return next(error);
  }
}

export async function decideDraftReview(req, res, next) {
  try {
    const draft = await reviewDraft({
      caseId: req.params.id,
      draftId: req.params.draftId,
      firmId: req.user.firmId,
      user: req.user,
      input: req.body || {},
      requestId: req.id || "",
      noticePublication: noticePublicationFromRequest(req),
    });
    return res.json({ ok: true, draft });
  } catch (error) {
    return next(error);
  }
}

export async function finalizeResponseDraft(req, res, next) {
  try {
    const draft = await finalizeDraft({
      caseId: req.params.id,
      draftId: req.params.draftId,
      firmId: req.user.firmId,
      user: req.user,
      input: req.body || {},
      requestId: req.id || "",
      noticePublication: noticePublicationFromRequest(req),
    });
    return res.json({ ok: true, draft });
  } catch (error) {
    return next(error);
  }
}

export async function createSubmissionRecord(req, res, next) {
  try {
    const submission = await recordSubmission({
      ...context(req),
      caseId: req.params.id,
      input: req.body || {},
    });
    return res.status(201).json({
      ok: true,
      submission,
      automaticSubmissionPerformed: false,
    });
  } catch (error) {
    return next(error);
  }
}

export async function exportCase(req, res, next) {
  try {
    const buffer = await buildCaseExport({
      caseId: req.params.id,
      firmId: req.user.firmId,
    });
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="case-${String(req.params.id).replace(/[^a-zA-Z0-9_-]/g, "")}.json"`,
    );
    return res.status(200).send(buffer);
  } catch (error) {
    return next(error);
  }
}
