// The GST downloader's run records, per firm (GD30; owner decision OD4). The firm is always the
// signed-in user's own, from the verified session - never a firm id the client names.

import { gstDownloadsService } from "../services/gst-downloads.service.js";

function answer(res, result, okBody) {
  if (!result.ok) {
    return res.status(result.status || 400).json({ ok: false, error: result.error, code: result.code });
  }
  return res.json(okBody(result));
}

// After a run: its records, frequency readings and filing statuses, written only when the firm
// records runs.
export const recordGstDownloads = async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const result = await gstDownloadsService.recordRun({
      firmId: req.user.firmId,
      records: body.records,
      frequency: body.frequency,
      filingStatus: body.filingStatus,
    });
    return answer(res, result, (done) => ({
      ok: true,
      recording: done.recording,
      recorded: done.recorded,
      frequencyRecorded: done.frequencyRecorded,
      filingRecorded: done.filingRecorded,
      stale: done.stale,
      refused: done.refused,
    }));
  } catch (error) {
    return next(error);
  }
};

export const listGstDownloads = async (req, res, next) => {
  try {
    const result = await gstDownloadsService.listRecords({
      firmId: req.user.firmId,
      gstin: req.query?.gstin,
      fy: req.query?.fy,
      limit: req.query?.limit,
    });
    return answer(res, result, (done) => ({ ok: true, records: done.records, truncated: done.truncated }));
  } catch (error) {
    return next(error);
  }
};

export const listGstFrequency = async (req, res, next) => {
  try {
    const result = await gstDownloadsService.listFrequency({ firmId: req.user.firmId, gstin: req.query?.gstin });
    return answer(res, result, (done) => ({ ok: true, frequency: done.frequency, truncated: done.truncated }));
  } catch (error) {
    return next(error);
  }
};

// The firm's filing board (decision D4, GD33).
export const listGstFilingStatus = async (req, res, next) => {
  try {
    const result = await gstDownloadsService.listFilingStatus({ firmId: req.user.firmId, gstin: req.query?.gstin, fy: req.query?.fy });
    return answer(res, result, (done) => ({ ok: true, filingStatus: done.filingStatus, truncated: done.truncated }));
  } catch (error) {
    return next(error);
  }
};

export const getGstDownloadSettings = async (req, res, next) => {
  try {
    const result = await gstDownloadsService.readSettings({ firmId: req.user.firmId });
    return answer(res, result, (done) => ({ ok: true, settings: done.settings }));
  } catch (error) {
    return next(error);
  }
};

export const patchGstDownloadSettings = async (req, res, next) => {
  try {
    const result = await gstDownloadsService.writeSettings({ firmId: req.user.firmId, input: req.body });
    return answer(res, result, (done) => ({ ok: true, settings: done.settings }));
  } catch (error) {
    return next(error);
  }
};
