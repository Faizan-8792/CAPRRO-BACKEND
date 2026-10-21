// src/controllers/gst-intelligence.controller.js
//
// W11 IN8-IN12 (2026-10-21): HTTP for the reconciliation's likely causes and supplier chase pack. Mounted on the
// reconciliation router behind both its own flag (gstReconciliation) and `intelligence`.

import {
  draftChaseMessages,
  draftResidueCauses,
  getChasePack,
  getRunCauses,
} from "../services/gst-intelligence.service.js";

export async function showRunCauses(req, res, next) {
  try {
    return res.json({ ok: true, ...(await getRunCauses({ firmId: req.user.firmId, runId: req.params.id })) });
  } catch (error) {
    return next(error);
  }
}

export async function createResidueCauses(req, res, next) {
  try {
    const result = await draftResidueCauses({
      firmId: req.user.firmId,
      userId: req.user.id,
      runId: req.params.id,
      input: req.body || {},
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return next(error);
  }
}

export async function showChasePack(req, res, next) {
  try {
    return res.json({ ok: true, ...(await getChasePack({ firmId: req.user.firmId, runId: req.params.id })) });
  } catch (error) {
    return next(error);
  }
}

export async function createChaseDrafts(req, res, next) {
  try {
    const result = await draftChaseMessages({
      firmId: req.user.firmId,
      userId: req.user.id,
      runId: req.params.id,
      input: req.body || {},
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return next(error);
  }
}
