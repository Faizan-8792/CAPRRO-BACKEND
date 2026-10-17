// src/routes/audit-pack.routes.js
//
// W10 AP6 + AP8 + AP9 (2026-10-15). Mounted at /api/audit-packs. Every route needs a signed-in firm
// member with write access, counts as "audit_pack" usage, and answers 404 with featureFlag
// "auditPacks" while the pack is switched off. The export also needs a firm admin, like every other
// export of firm work product.
import { Router } from "express";
import {
  createRun,
  decideRow,
  exportRun,
  listClientParties,
  listKinds,
  listRows,
  listRuns,
  listSources,
  showRun,
  updateParty,
} from "../controllers/audit-pack.controller.js";
import { authRequiredWithoutUsageTracking } from "../middleware/auth.middleware.js";
import {
  requireFirmAdmin,
  requireFirmMember,
  requireFirmWriteAccess,
} from "../middleware/authorization.middleware.js";
import { requireFeatureFlag } from "../middleware/rollout.middleware.js";
import { trackWorkflow } from "../middleware/workflow-usage.middleware.js";

const router = Router();

router.use(
  authRequiredWithoutUsageTracking,
  requireFirmMember,
  requireFirmWriteAccess,
  trackWorkflow("audit_pack"),
  requireFeatureFlag("auditPacks"),
);

// Fixed paths before /:id so "sources" and "parties" are never read as a pack id.
router.get("/kinds", listKinds);
router.get("/sources", listSources);
router.get("/parties", listClientParties);
router.patch("/parties/:partyId", updateParty);
router.post("/", createRun);
router.get("/", listRuns);
router.get("/:id/rows", listRows);
router.post("/:id/rows/:rowKey/decision", decideRow);
router.get("/:id/export", requireFirmAdmin, exportRun);
router.get("/:id", showRun);

export default router;
