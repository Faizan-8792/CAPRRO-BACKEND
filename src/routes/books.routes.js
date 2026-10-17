// src/routes/books.routes.js
//
// W10 AP18-AP21 (2026-10-17). Mounted at /api/books. The same gate as the audit packs they feed: a signed-in
// firm member with write access, counted as "audit_pack" usage, behind the auditPacks flag (404 naming it
// while off). Chunks are large, so /api/books/snapshots has its own body limit in app.js.
import { Router } from "express";
import {
  chunk,
  create,
  diff,
  groups,
  list,
  mapGroup,
  parties,
  patchParty,
  seal,
  seedPartyMaster,
  show,
  suggest,
} from "../controllers/books.controller.js";
import { authRequiredWithoutUsageTracking } from "../middleware/auth.middleware.js";
import { requireFirmMember, requireFirmWriteAccess } from "../middleware/authorization.middleware.js";
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

router.post("/snapshots", create);
router.get("/snapshots", list);
router.get("/snapshots/:id", show);
router.post("/snapshots/:id/chunks", chunk);
router.post("/snapshots/:id/seal", seal);
router.get("/snapshots/:id/groups", groups);
router.post("/snapshots/:id/groups/suggest", suggest);
router.post("/snapshots/:id/parties/seed", seedPartyMaster);
router.get("/snapshots/:id/diff", diff);
router.put("/group-mappings", mapGroup);
router.get("/parties", parties);
router.patch("/parties/:partyId", patchParty);

export default router;
