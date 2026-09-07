// src/controllers/firm-invite.controller.js
//
// Invites, member tiers, and the firm-level elevation queue.
//
// EVERY AUTHORITY DECISION IN THIS FILE COMES FROM resolveFirmAuthority. There is no `if
// (role === "OWNER")` here and there must not be one: the ladder is in
// services/firm-authority.service.js, pinned by tests/firm-role-tier-contract.mjs and scored by
// tools/mutations/firm-authority.mjs. A second copy of it here would be the fourth, and the whole
// point of that service was to stop there being three.
//
// THE SAFETY BOUNDARY, restated because it is the one thing in this feature that must not bend:
// nothing in this file writes User.role. A firm owner grants firm-LOCAL authority
// (FirmMembership.role) and nothing wider. Account-level FIRM_ADMIN stays a super-admin grant
// through the existing requestFirmAdmin path. Joining the two would let any firm owner mint
// authority reaching into other firms by inviting somebody as an admin --
// TASK-MANAGEMENT-DESIGN.md section 1.5 calls this the sharpest safety point in the design, and
// tests/firm-invite-contract.mjs asserts the absence by reading this source.

import mongoose from "mongoose";
import Firm from "../models/Firm.js";
import User from "../models/User.js";
import FirmInvite from "../models/FirmInvite.js";
import FirmMembership from "../models/FirmMembership.js";
import {
  INVITABLE_FIRM_ROLES,
  highestInvitableRole,
  isInvitableRole,
  resolveFirmAuthority,
  roleAtLeast,
} from "../services/firm-authority.service.js";
import {
  firmInviteStatus,
  serializeFirmInvite,
  validateInviteRequest,
} from "../services/firm-invite.service.js";

function fail(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function respond(res, statusCode, error, requestId) {
  return res
    .status(statusCode)
    .json({ ok: false, error, requestId: requestId || "" });
}

/** Wraps a handler so a thrown `statusCode` error becomes that response. */
function handle(action) {
  return async (req, res, next) => {
    try {
      return await action(req, res);
    } catch (error) {
      if (error?.statusCode) {
        return respond(res, error.statusCode, error.message, req.id);
      }
      return next(error);
    }
  };
}

/**
 * Loads the firm and the caller's membership for a :firmId route, and resolves their authority.
 *
 * These routes take a firm id in the path rather than using req.user.firmId, so the middleware
 * chain's firmAuthority (which is scoped to the ACTIVE workspace) is not the right answer here --
 * an owner may legitimately administer a firm they are not currently switched into.
 */
async function loadAuthority(req) {
  const { firmId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(String(firmId || ""))) {
    throw fail(404, "Workspace not found");
  }

  const [firm, membership] = await Promise.all([
    Firm.findById(firmId).lean(),
    FirmMembership.findOne({ firmId, userId: req.user.id })
      .select("role status")
      .lean(),
  ]);
  if (!firm || firm.isActive === false) {
    throw fail(404, "Workspace not found");
  }

  const authority = resolveFirmAuthority({ user: req.user, firm, membership });
  if (!authority.canRead) {
    // A retained removal row and never having been a member read differently, and the person
    // who was removed is owed the sentence that says so.
    throw fail(
      403,
      authority.wasRemoved
        ? "You are no longer a member of this workspace"
        : "You are not a member of this workspace",
    );
  }
  return { firm, membership, authority };
}

const MANAGE_REFUSAL =
  "Only a firm owner or administrator can manage invitations for this workspace";
const OWNER_REFUSAL = "Only the firm owner can do this";

// ---------------------------------------------------------------------------
// POST /api/firms/:firmId/invites
// ---------------------------------------------------------------------------

export const createFirmInvite = handle(async (req, res) => {
  const { firm, authority } = await loadAuthority(req);
  if (!authority.canManageInvites) {
    throw fail(403, MANAGE_REFUSAL);
  }
  // A personal workspace has no colleagues to invite, and admitting one would turn it into a
  // shared firm through a side door.
  if (firm.kind === "PERSONAL") {
    throw fail(400, "A personal workspace cannot have invitations");
  }

  // The ceiling comes from the caller's own authority, NEVER from the request body. This is the
  // line that stops an Admin minting another Admin, one step before the approval queue would
  // have had to catch it.
  const ceiling = highestInvitableRole(authority);
  const { error, value } = validateInviteRequest(req.body || {}, { ceiling });
  if (error) throw fail(400, error);

  // Retry on the unique index rather than checking first: a read-then-insert has a race, and a
  // duplicate admission code is not a collision to resolve later.
  let created = null;
  for (let attempt = 0; attempt < 5 && !created; attempt += 1) {
    try {
      created = await FirmInvite.create({
        firmId: firm._id,
        code: FirmInvite.generateCode(),
        createdBy: req.user.id,
        grantsRole: value.grantsRole,
        maxUses: value.maxUses,
        expiresAt: value.expiresAt,
        label: value.label,
      });
    } catch (creationError) {
      if (creationError?.code !== 11000) throw creationError;
    }
  }
  if (!created) {
    throw fail(503, "An invitation code could not be generated. Try again.");
  }

  return res.status(201).json({
    ok: true,
    invite: serializeFirmInvite(created.toObject()),
  });
});

// ---------------------------------------------------------------------------
// GET /api/firms/:firmId/invites
// ---------------------------------------------------------------------------

const INVITE_LIST_LIMIT = 100;

export const listFirmInvites = handle(async (req, res) => {
  const { firm, authority } = await loadAuthority(req);
  if (!authority.canManageInvites) {
    throw fail(403, MANAGE_REFUSAL);
  }

  // Bounded, and the bound is reported. A firm that has issued more than this sees a truthful
  // "there are more" rather than a list that quietly stops.
  const invites = await FirmInvite.find({ firmId: firm._id })
    .sort({ createdAt: -1 })
    .limit(INVITE_LIST_LIMIT + 1)
    .lean();

  const truncated = invites.length > INVITE_LIST_LIMIT;
  const page = truncated ? invites.slice(0, INVITE_LIST_LIMIT) : invites;
  const serialized = page.map((invite) => serializeFirmInvite(invite));

  // Names for the people in the acceptance lists, resolved in ONE query rather than per row.
  const userIds = [
    ...new Set(
      serialized.flatMap((invite) =>
        invite.acceptances.map((item) => item.userId).filter(Boolean),
      ),
    ),
  ];
  const people = userIds.length
    ? await User.find({ _id: { $in: userIds } })
        .select("name email")
        .lean()
    : [];
  const byId = new Map(people.map((person) => [String(person._id), person]));

  return res.json({
    ok: true,
    // The tiers this caller may offer, so the client does not have to derive the ceiling itself
    // and cannot disagree with the server about it.
    invitableRoles: INVITABLE_FIRM_ROLES.filter((role) =>
      roleAtLeast(highestInvitableRole(authority), role),
    ),
    truncated,
    invites: serialized.map((invite) => ({
      ...invite,
      acceptances: invite.acceptances.map((item) => {
        const person = byId.get(item.userId);
        return {
          ...item,
          // Never invented. A joined user document may be missing entirely, and the client
          // renders the absence rather than a placeholder person.
          name: person?.name || null,
          email: person?.email || null,
        };
      }),
    })),
  });
});

// ---------------------------------------------------------------------------
// POST /api/firms/:firmId/invites/:inviteId/revoke
// ---------------------------------------------------------------------------

export const revokeFirmInvite = handle(async (req, res) => {
  const { firm, authority } = await loadAuthority(req);
  if (!authority.canManageInvites) {
    throw fail(403, MANAGE_REFUSAL);
  }

  const { inviteId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(String(inviteId || ""))) {
    throw fail(404, "That invitation was not found");
  }

  const invite = await FirmInvite.findOne({ _id: inviteId, firmId: firm._id });
  if (!invite) throw fail(404, "That invitation was not found");

  // An ADMIN-ceiling invite was only creatable by the owner, so only the owner may revoke it --
  // otherwise an Admin could destroy an admission decision they were never allowed to make.
  if (roleAtLeast(invite.grantsRole, "ADMIN") && !authority.canInviteAdmins) {
    throw fail(403, OWNER_REFUSAL);
  }

  // Idempotent, and it says which it was. Revoking twice is not an error, but reporting the
  // second one as a fresh revocation would put a wrong time in the audit trail.
  const alreadyRevoked = Boolean(invite.revokedAt);
  if (!alreadyRevoked) {
    invite.revokedAt = new Date();
    invite.revokedBy = req.user.id;
    await invite.save();
  }

  return res.json({
    ok: true,
    alreadyRevoked,
    invite: serializeFirmInvite(invite.toObject()),
  });
});

// ---------------------------------------------------------------------------
// GET /api/firms/:firmId/invites/pending  -- the owner's elevation queue
// ---------------------------------------------------------------------------

export const listPendingElevations = handle(async (req, res) => {
  const { firm, authority } = await loadAuthority(req);
  // Only the owner sees the queue, because only the owner can act on it. Showing an Admin a list
  // of decisions they cannot take is the "control that looks live and does nothing" this project
  // already has a policy against.
  if (!authority.canApproveElevation) {
    throw fail(403, OWNER_REFUSAL);
  }

  const invites = await FirmInvite.find({
    firmId: firm._id,
    "acceptances.approvalState": "PENDING",
  })
    .sort({ createdAt: -1 })
    .limit(INVITE_LIST_LIMIT)
    .lean();

  const rows = [];
  for (const invite of invites) {
    for (const acceptance of invite.acceptances || []) {
      if (acceptance.approvalState !== "PENDING") continue;
      rows.push({
        inviteId: String(invite._id),
        code: invite.code,
        label: invite.label || "",
        userId: String(acceptance.userId || ""),
        // The tier being ASKED FOR, and the tier they hold now, both named. A queue that showed
        // only one of the two would not say what approving it actually changes.
        requestedRole: invite.grantsRole,
        currentRole: acceptance.resultingRole,
        acceptedAt: acceptance.acceptedAt
          ? new Date(acceptance.acceptedAt).toISOString()
          : null,
      });
    }
  }

  const people = rows.length
    ? await User.find({ _id: { $in: [...new Set(rows.map((row) => row.userId))] } })
        .select("name email")
        .lean()
    : [];
  const byId = new Map(people.map((person) => [String(person._id), person]));

  return res.json({
    ok: true,
    pending: rows.map((row) => ({
      ...row,
      name: byId.get(row.userId)?.name || null,
      email: byId.get(row.userId)?.email || null,
    })),
  });
});

// ---------------------------------------------------------------------------
// POST /api/firms/:firmId/invites/:inviteId/decide
// ---------------------------------------------------------------------------

export const decideElevation = handle(async (req, res) => {
  const { firm, authority } = await loadAuthority(req);
  if (!authority.canApproveElevation) {
    throw fail(403, OWNER_REFUSAL);
  }

  const { inviteId } = req.params;
  const { userId, decision } = req.body || {};
  if (!mongoose.Types.ObjectId.isValid(String(inviteId || ""))) {
    throw fail(404, "That invitation was not found");
  }
  if (!mongoose.Types.ObjectId.isValid(String(userId || ""))) {
    throw fail(400, "Name the person whose designation you are deciding");
  }
  if (decision !== "APPROVE" && decision !== "DECLINE") {
    throw fail(400, "A decision must be either APPROVE or DECLINE");
  }

  const invite = await FirmInvite.findOne({ _id: inviteId, firmId: firm._id });
  if (!invite) throw fail(404, "That invitation was not found");

  const acceptance = (invite.acceptances || []).find(
    (item) => String(item.userId) === String(userId),
  );
  if (!acceptance) {
    throw fail(404, "That person has not used this invitation");
  }
  if (acceptance.approvalState !== "PENDING") {
    // Not silently re-decided. A second decision on a settled record would overwrite who decided
    // it and when, which is the audit trail this queue exists to produce.
    throw fail(
      409,
      `That designation was already ${acceptance.approvalState === "APPROVED" ? "approved" : "declined"}`,
    );
  }

  // The invite must still be usable. Approving an elevation from a revoked or expired invite
  // would let a withdrawn admission decision be completed after the fact.
  const status = firmInviteStatus(invite);
  if (status === "REVOKED") {
    throw fail(409, "That invitation was revoked, so this cannot be approved");
  }

  const granted = roleAtLeast(invite.grantsRole, "ADMIN")
    ? invite.grantsRole
    : null;
  if (decision === "APPROVE" && !granted) {
    throw fail(409, "That invitation does not grant an elevated designation");
  }

  if (decision === "APPROVE") {
    // The membership must still be ACTIVE. Elevating somebody who has since left would leave a
    // dormant ADMIN row to be reactivated later by a plain rejoin.
    const membership = await FirmMembership.findOne({
      firmId: firm._id,
      userId,
      status: "ACTIVE",
    });
    if (!membership) {
      throw fail(409, "That person is no longer an active member of this workspace");
    }
    // FirmMembership.role only. User.role is not touched here or anywhere in this file.
    membership.role = granted;
    await membership.save();
  }

  acceptance.approvalState = decision === "APPROVE" ? "APPROVED" : "DECLINED";
  acceptance.resultingRole =
    decision === "APPROVE" ? granted : acceptance.resultingRole;
  acceptance.decidedBy = req.user.id;
  acceptance.decidedAt = new Date();
  await invite.save();

  return res.json({
    ok: true,
    decision: acceptance.approvalState,
    resultingRole: acceptance.resultingRole,
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/firms/:firmId/members/:userId/role
// ---------------------------------------------------------------------------

export const setFirmMemberRole = handle(async (req, res) => {
  const { firm, authority } = await loadAuthority(req);
  if (!authority.canManageMembers) {
    throw fail(403, "Only a firm owner or administrator can change designations");
  }

  const { userId } = req.params;
  const { role } = req.body || {};
  if (!mongoose.Types.ObjectId.isValid(String(userId || ""))) {
    throw fail(404, "That member was not found");
  }
  if (!isInvitableRole(role)) {
    throw fail(400, "Choose a designation of Admin, Member or Viewer");
  }

  // Ownership moves by transfer, never by a role edit. isInvitableRole already excludes OWNER;
  // this says why out loud at the place somebody would try it.
  if (String(userId) === String(firm.ownerUserId)) {
    throw fail(
      409,
      "The workspace owner's designation cannot be changed here. Transfer ownership instead.",
    );
  }
  // Nobody edits their own tier. An Admin who could would simply promote themselves.
  if (String(userId) === String(req.user.id)) {
    throw fail(409, "You cannot change your own designation");
  }

  // `targetMembership`, not `membership`. Everywhere else in this file `membership` means the
  // CALLER's row, and this is the row of the person being edited. Two different subjects under
  // one name in one file is how a check ends up reading the wrong person's tier -- and the tier
  // of the person being edited is data, whereas the caller's tier is authority and comes only
  // from `authority` below.
  const targetMembership = await FirmMembership.findOne({
    firmId: firm._id,
    userId,
    status: "ACTIVE",
  });
  if (!targetMembership) throw fail(404, "That member was not found");

  // Two owner-only edges, both from DESIGN section 5A Q2: touching an existing ADMIN, and
  // creating a new one. Without the first, two Admins can demote each other and the last one
  // standing wins.
  if (targetMembership.role === "ADMIN" && !authority.canManageAdmins) {
    throw fail(403, "Only the firm owner can change an administrator's designation");
  }
  if (roleAtLeast(role, "ADMIN") && !authority.canInviteAdmins) {
    throw fail(403, "Only the firm owner can appoint an administrator");
  }

  const previousRole = targetMembership.role;
  targetMembership.role = role;
  await targetMembership.save();

  return res.json({ ok: true, previousRole, role: targetMembership.role });
});

// ---------------------------------------------------------------------------
// GET /api/firms/invites/preview?code=...
// ---------------------------------------------------------------------------

/**
 * What a person sees before deciding to join: the firm's name, and the designation on offer.
 *
 * The brief's join flow is "enter the code -> see the firm name -> pick a designation from what
 * the ceiling allows", and this is the middle step.
 *
 * WHAT IT DISCLOSES, and why that is safe. Only the firm's display name, its handle, and the
 * ceiling. No member list, no counts, no ids. Anybody holding a valid code was given it
 * deliberately, and a 10-character code over the global 200-per-15-minutes limiter is roughly
 * 10^11 years of guessing, so this is not a usable enumeration oracle.
 */
export const previewFirmInvite = handle(async (req, res) => {
  const raw = req.query?.code ?? req.body?.code;
  const code = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  if (!code) throw fail(400, "Enter an invitation code");

  const invite = await FirmInvite.findOne({ code }).lean();
  const firmByJoinCode = invite
    ? null
    : await Firm.findOne({ joinCode: code, kind: "SHARED" })
        .select("displayName handle isActive")
        .lean();

  if (invite) {
    const firm = await Firm.findOne({ _id: invite.firmId, kind: "SHARED" })
      .select("displayName handle isActive sharingEnabled")
      .lean();
    if (!firm || firm.isActive === false) {
      throw fail(404, "Invalid or inactive join code");
    }
    const status = firmInviteStatus(invite);
    return res.json({
      ok: true,
      firm: { displayName: firm.displayName, handle: firm.handle },
      grantsRole: invite.grantsRole,
      status,
      // Said plainly so the client does not have to infer it from the tier, and so an
      // ADMIN-ceiling invite cannot be presented as though it activates on joining.
      requiresApproval: roleAtLeast(invite.grantsRole, "ADMIN"),
      canJoin: status === "LIVE" && firm.sharingEnabled !== false,
    });
  }

  if (firmByJoinCode && firmByJoinCode.isActive !== false) {
    return res.json({
      ok: true,
      firm: {
        displayName: firmByJoinCode.displayName,
        handle: firmByJoinCode.handle,
      },
      grantsRole: "MEMBER",
      status: "LIVE",
      requiresApproval: false,
      canJoin: true,
    });
  }

  throw fail(404, "Invalid or inactive join code");
});
