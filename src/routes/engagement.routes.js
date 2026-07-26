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

const router = Router();
const requireAuditWorkingPapers = requireFeatureFlag("auditWorkingPapers");

router.use(
  authRequired,
  requireFirmMember,
  requireFirmWriteAccess,
  requireFeatureFlag("assuranceEngagements")
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
