import { Router } from "express";
import {
  addWorkingPaperRow,
  createWorkingPaper,
  dispositionWorkingPaperProposal,
  exportWorkingPaper,
  generateWorkingPaperAnalysis,
  listWorkingPapers,
  showWorkingPaper,
} from "../controllers/audit-working-paper.controller.js";
import {
  createEngagementRecord,
  createFinding,
  exportEngagement,
  listEngagementRecords,
  listTemplates,
  patchEngagement,
  patchFinding,
  reviewEngagementRecord,
  showEngagement,
} from "../controllers/engagement.controller.js";
import { authRequired } from "../middleware/auth.middleware.js";
import {
  requireFirmMember,
  requireFirmWriteAccess,
} from "../middleware/authorization.middleware.js";
import { requireFeatureFlag } from "../middleware/rollout.middleware.js";
import { trackWorkflow } from "../middleware/workflow-usage.middleware.js";

const router = Router();
const requireAuditWorkingPapers = requireFeatureFlag("auditWorkingPapers");

// AP1 (2026-10-15): engagements and working papers were never counted. Each request is counted
// under exactly one name, chosen by its path, so the two surfaces can be read apart.
const countWorkingPaper = trackWorkflow("working_paper");
const countEngagement = trackWorkflow("engagement");
const isWorkingPaperPath = (path) =>
  path === "/working-papers" || path.startsWith("/working-papers/");

router.use(
  authRequired,
  requireFirmMember,
  requireFirmWriteAccess,
  requireFeatureFlag("assuranceEngagements"),
  (req, res, next) =>
    (isWorkingPaperPath(req.path) ? countWorkingPaper : countEngagement)(req, res, next)
);

router.post("/working-papers", requireAuditWorkingPapers, createWorkingPaper);
router.get("/working-papers", requireAuditWorkingPapers, listWorkingPapers);
router.get("/working-papers/:id/export", requireAuditWorkingPapers, exportWorkingPaper);
router.get("/working-papers/:id", requireAuditWorkingPapers, showWorkingPaper);
router.post("/working-papers/:id/rows", requireAuditWorkingPapers, addWorkingPaperRow);
router.post(
  "/working-papers/:id/analyses",
  requireAuditWorkingPapers,
  generateWorkingPaperAnalysis
);
router.post(
  "/working-papers/:id/analyses/:analysisId/proposals/:proposalId/disposition",
  requireAuditWorkingPapers,
  dispositionWorkingPaperProposal
);

router.post("/", createEngagementRecord);
router.get("/", listEngagementRecords);
router.get("/templates", listTemplates);
router.get("/:id/export", exportEngagement);
router.get("/:id", showEngagement);
router.patch("/:id", patchEngagement);
router.post("/:id/findings", createFinding);
router.patch("/:id/findings/:findingId", patchFinding);
router.post("/:id/review", reviewEngagementRecord);

export default router;
