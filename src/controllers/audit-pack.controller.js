// src/controllers/audit-pack.controller.js
//
// W10 AP6 + AP8 + AP9 (2026-10-15): HTTP for audit packs. Bodies are checked against per-route
// field lists inside the service; ids, client and firm scoping are enforced there too, so this file
// only maps requests to calls and statuses.

import {
  createAuditPackRun,
  decideAuditPackRow,
  getAuditPackRun,
  listAuditPackRows,
  listAuditPackRuns,
  listAuditPackSources,
  listParties,
  setPartyStatus,
} from "../services/audit-pack.service.js";
import { exportAuditPackWorkbook } from "../services/audit-pack-export.service.js";
import { describeKinds } from "../services/audit-pack-kinds/index.js";

function context(req) {
  return { firmId: req.user.firmId, actorUserId: req.user.id, requestId: req.id || "" };
}

export async function createRun(req, res, next) {
  try {
    const result = await createAuditPackRun({
      ...context(req),
      input: req.body || {},
      rolloutVersion: req.featureFlagVersions?.auditPacks ?? 0,
    });
    return res.status(result.replayed ? 200 : 202).json({ ok: true, replayed: result.replayed, run: result.run });
  } catch (error) {
    return next(error);
  }
}

export async function listRuns(req, res, next) {
  try {
    return res.json({ ok: true, ...(await listAuditPackRuns({ firmId: req.user.firmId, query: req.query || {} })) });
  } catch (error) {
    return next(error);
  }
}

export async function showRun(req, res, next) {
  try {
    return res.json({ ok: true, run: await getAuditPackRun({ firmId: req.user.firmId, runId: req.params.id }) });
  } catch (error) {
    return next(error);
  }
}

export async function listRows(req, res, next) {
  try {
    return res.json({ ok: true, ...(await listAuditPackRows({ firmId: req.user.firmId, runId: req.params.id, query: req.query || {} })) });
  } catch (error) {
    return next(error);
  }
}

export async function decideRow(req, res, next) {
  try {
    const row = await decideAuditPackRow({
      ...context(req),
      runId: req.params.id,
      rowKey: req.params.rowKey,
      input: req.body || {},
    });
    return res.json({ ok: true, row });
  } catch (error) {
    return next(error);
  }
}

export function listKinds(req, res, next) {
  try {
    return res.json({ ok: true, kinds: describeKinds() });
  } catch (error) {
    return next(error);
  }
}

export async function listSources(req, res, next) {
  try {
    return res.json({ ok: true, ...(await listAuditPackSources({ firmId: req.user.firmId, query: req.query || {} })) });
  } catch (error) {
    return next(error);
  }
}

export async function listClientParties(req, res, next) {
  try {
    return res.json({ ok: true, ...(await listParties({ firmId: req.user.firmId, query: req.query || {} })) });
  } catch (error) {
    return next(error);
  }
}

export async function updateParty(req, res, next) {
  try {
    const party = await setPartyStatus({ ...context(req), partyId: req.params.partyId, input: req.body || {} });
    return res.json({ ok: true, party });
  } catch (error) {
    return next(error);
  }
}

export async function exportRun(req, res, next) {
  try {
    const { bytes, fileName, provisional } = await exportAuditPackWorkbook({ firmId: req.user.firmId, runId: req.params.id });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("X-Audit-Pack-Provisional", provisional ? "true" : "false");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(bytes);
  } catch (error) {
    return next(error);
  }
}
