// src/controllers/ai-draft.controller.js
//
// W11 IN5 (2026-10-21): HTTP for the shared intelligence layer - the firm's opt-in, reading one draft, and
// recording what a person did with a draft or with a rule's suggestion. Each feature's own drafting routes
// (reconciliation causes, chase packs, import mappings, TDS action drafts) live with that feature.

import {
  getAiDraft,
  getAiSettings,
  markAiDraftOutcome,
  recordRuleOutcome,
  setAiDrafting,
} from "../services/ai/ai-task.service.js";
import { safeRecordActivity } from "../services/activity.service.js";

export async function showSettings(req, res, next) {
  try {
    const settings = await getAiSettings({
      firmId: req.user.firmId,
      canAdminister: Boolean(req.firmAuthority?.canAdminister),
    });
    return res.json({ ok: true, settings });
  } catch (error) {
    return next(error);
  }
}

export async function updateSettings(req, res, next) {
  try {
    const firmOptIn = await setAiDrafting({ firmId: req.user.firmId, userId: req.user.id, input: req.body || {} });
    await safeRecordActivity({
      firmId: req.user.firmId,
      actorUserId: req.user.id,
      source: "USER",
      action: firmOptIn.enabled ? "FIRM_AI_DRAFTING_ON" : "FIRM_AI_DRAFTING_OFF",
      entityType: "Firm",
      entityId: req.user.firmId,
      requestId: req.id || "",
      afterSummary: { enabled: firmOptIn.enabled },
    });
    return res.json({ ok: true, firmOptIn });
  } catch (error) {
    return next(error);
  }
}

export async function showDraft(req, res, next) {
  try {
    return res.json({ ok: true, draft: await getAiDraft({ firmId: req.user.firmId, draftId: req.params.id }) });
  } catch (error) {
    return next(error);
  }
}

export async function updateDraftOutcome(req, res, next) {
  try {
    const draft = await markAiDraftOutcome({
      firmId: req.user.firmId,
      userId: req.user.id,
      draftId: req.params.id,
      input: req.body || {},
    });
    return res.json({ ok: true, draft });
  } catch (error) {
    return next(error);
  }
}

export async function createRuleOutcome(req, res, next) {
  try {
    return res.status(201).json({ ok: true, ...(await recordRuleOutcome({ firmId: req.user.firmId, input: req.body || {} })) });
  } catch (error) {
    return next(error);
  }
}
