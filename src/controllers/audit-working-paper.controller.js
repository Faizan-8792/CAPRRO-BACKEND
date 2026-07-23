import {
  buildAuditWorkingPaperExport,
  createAuditWorkingPaper,
  createAuditWorkingPaperRow,
  dispositionAuditFindingProposal,
  generateAuditWorkingPaperAnalysis,
  getAuditWorkingPaperDetail,
  listAuditWorkingPapers,
  workingPaperPublicationFromRequest,
} from "../services/audit-working-paper.service.js";

function context(req) {
  return {
    firmId: req.user.firmId,
    actorUserId: req.user.id,
    requestId: req.id || "",
    publication: workingPaperPublicationFromRequest(req),
  };
}

export async function createWorkingPaper(req, res, next) {
  try {
    const paper = await createAuditWorkingPaper({
      ...context(req),
      input: req.body || {},
    });
    return res.status(201).json({ ok: true, paper });
  } catch (error) {
    return next(error);
  }
}

export async function listWorkingPapers(req, res, next) {
  try {
    const result = await listAuditWorkingPapers({
      firmId: req.user.firmId,
      query: req.query || {},
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return next(error);
  }
}

export async function showWorkingPaper(req, res, next) {
  try {
    const result = await getAuditWorkingPaperDetail({
      workingPaperId: req.params.id,
      firmId: req.user.firmId,
      query: req.query || {},
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return next(error);
  }
}

export async function addWorkingPaperRow(req, res, next) {
  try {
    const result = await createAuditWorkingPaperRow({
      ...context(req),
      workingPaperId: req.params.id,
      input: req.body || {},
    });
    return res.status(201).json({ ok: true, ...result });
  } catch (error) {
    return next(error);
  }
}

export async function generateWorkingPaperAnalysis(req, res, next) {
  try {
    const result = await generateAuditWorkingPaperAnalysis({
      ...context(req),
      workingPaperId: req.params.id,
      input: req.body || {},
    });
    const status = result.providerCallState === "PROCESSING_UNKNOWN" ? 202 : 201;
    return res.status(status).json({ ok: true, ...result });
  } catch (error) {
    return next(error);
  }
}

export async function dispositionWorkingPaperProposal(req, res, next) {
  try {
    const result = await dispositionAuditFindingProposal({
      ...context(req),
      workingPaperId: req.params.id,
      analysisId: req.params.analysisId,
      proposalId: req.params.proposalId,
      input: req.body || {},
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return next(error);
  }
}

export async function exportWorkingPaper(req, res, next) {
  try {
    const buffer = await buildAuditWorkingPaperExport({
      workingPaperId: req.params.id,
      firmId: req.user.firmId,
    });
    const safeId = String(req.params.id).replace(/[^a-zA-Z0-9_-]/g, "");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="audit-working-paper-${safeId}.json"`
    );
    return res.status(200).send(buffer);
  } catch (error) {
    return next(error);
  }
}
