// src/routes/firm.routes.js
import express from "express";
import { authRequired } from "../middleware/auth.middleware.js";
import {
  createFirmInvite,
  listFirmInvites,
  revokeFirmInvite,
  listPendingElevations,
  decideElevation,
  setFirmMemberRole,
  previewFirmInvite,
} from "../controllers/firm-invite.controller.js";
import {
  createFirm,
  getMyFirm,
  getFirmById,
  updateFirm,
  rotateJoinCode,
  joinFirmByCode,
  getWorkspaceOperationStatus,
  listFirmUsers,
  requestFirmAdmin,
  deleteFirmUser,
  listWorkspaces,
  switchWorkspace,
  listFirmMembers,
  leaveFirm,
} from "../controllers/firm.controller.js";

const router = express.Router();

// Apply auth middleware to all routes
router.use(authRequired);

// Firm creation and management
router.post("/", createFirm); // POST /api/firms
router.get("/me", getMyFirm); // GET /api/firms/me

// Collaborative workspaces (personal + shared). Specific paths must be declared
// before the parameterized ':firmId' routes so they are not captured by them.
router.get("/workspaces", listWorkspaces); // GET /api/firms/workspaces
router.get("/workspace-operations/:operationId", getWorkspaceOperationStatus);
router.post("/switch", switchWorkspace); // POST /api/firms/switch

// Join code management. POST /join accepts EITHER the firm's own joinCode or a FirmInvite code --
// firm-admission.service.js resolves both, so no client needed a change to redeem an invite.
router.post("/join", joinFirmByCode); // POST /api/firms/join

// Invitation preview: the firm's name and the designation on offer, before joining. Declared
// above the parameterized ':firmId' routes below, or "invites" would be captured as a firm id.
router.get("/invites/preview", previewFirmInvite); // GET /api/firms/invites/preview?code=

// NEW: user → FIRM_ADMIN (pending) of their linked firm
router.post("/request-admin", requestFirmAdmin);

router.get("/:firmId", getFirmById); // GET /api/firms/:firmId
router.patch("/:firmId", updateFirm); // PATCH /api/firms/:firmId

router.post("/:firmId/join-code/rotate", rotateJoinCode); // POST /api/firms/:firmId/join-code/rotate

// Firm members (any active member can view teammates)
router.get("/:firmId/members", listFirmMembers); // GET /api/firms/:firmId/members
router.post("/:firmId/leave", leaveFirm); // POST /api/firms/:firmId/leave

// Per-member designation. Owner or admin, with two owner-only edges: changing an existing
// administrator, and appointing a new one. Enforced in the controller from resolveFirmAuthority,
// never from a role string compared here.
router.patch("/:firmId/members/:userId/role", setFirmMemberRole);

// Invitations. Every one of these re-resolves authority from the firm in the path rather than
// trusting the caller's active workspace, because an owner may administer a firm they are not
// currently switched into. The fixed segments are declared before ':inviteId' so "pending" is
// never captured as an invite id.
router.get("/:firmId/invites", listFirmInvites);
router.post("/:firmId/invites", createFirmInvite);
router.get("/:firmId/invites/pending", listPendingElevations);
router.post("/:firmId/invites/:inviteId/revoke", revokeFirmInvite);
router.post("/:firmId/invites/:inviteId/decide", decideElevation);

// Firm users (owner management)
router.get("/:firmId/users", listFirmUsers); // GET /api/firms/:firmId/users
router.delete("/:firmId/users/:userId", deleteFirmUser); // DELETE user

export default router;
