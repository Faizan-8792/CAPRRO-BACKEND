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
  getMemos,
  patchMemo,
  postMemo,
  postSignMemo,
  getAssurance,
  postAssemble,
  postIndependence,
  postModification,
  postReportDate,
  postTimeEntry,
  postVoidTimeEntry,
  addPackRequests,
  chaseDraft,
  showPackRequestProposals,
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
// W10 AP37/AP38/AP41: the engagement file (request list, assurance, memos) is the owner's one switch for the W10
// surfaces, the same flag as the packs: the wording on it carries professional meaning and goes live when the owner
// has read it. Off: 404 naming the flag, as every audit-pack route answers.
const requireAuditPacks = requireFeatureFlag("auditPacks");

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
// W10 AP41: the measured request list - proposals from a pack's gaps, adding the chosen ones with the
// request time recorded, and the chase draft built only from requests that carry that time.
router.get("/:id/requests/proposals", requireAuditPacks, showPackRequestProposals);
router.post("/:id/requests/from-pack", requireAuditPacks, addPackRequests);
router.post("/:id/requests/chase-draft", requireAuditPacks, chaseDraft);
// W10 AP38: attribution, independence and the 60-day assembly of the file.
router.get("/:id/assurance", requireAuditPacks, getAssurance);
router.post("/:id/assurance/independence", requireAuditPacks, postIndependence);
router.post("/:id/assurance/report-date", requireAuditPacks, postReportDate);
router.post("/:id/assurance/assemble", requireAuditPacks, postAssemble);
router.post("/:id/assurance/modifications", requireAuditPacks, postModification);
router.post("/:id/assurance/time", requireAuditPacks, postTimeEntry);
router.post("/:id/assurance/time/:entryId/void", requireAuditPacks, postVoidTimeEntry);
// W10 AP37: drafted memos - assembled from the team's inputs, edited by the team, signed by the reviewer.
router.get("/:id/memos", requireAuditPacks, getMemos);
router.post("/:id/memos", requireAuditPacks, postMemo);
router.patch("/:id/memos/:memoId", requireAuditPacks, patchMemo);
router.post("/:id/memos/:memoId/sign", requireAuditPacks, postSignMemo);
router.get("/:id/export", exportEngagement);
router.get("/:id", showEngagement);
router.patch("/:id", patchEngagement);
router.post("/:id/findings", createFinding);
router.patch("/:id/findings/:findingId", patchFinding);
router.post("/:id/review", reviewEngagementRecord);

export default router;
