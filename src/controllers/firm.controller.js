// src/controllers/firm.controller.js
import mongoose from "mongoose";
import Firm from "../models/Firm.js";
import User from "../models/User.js";
import FirmMembership from "../models/FirmMembership.js";
import WorkspaceOperation from "../models/WorkspaceOperation.js";
import {
  ensureFirmMembership,
  ensurePersonalFirm,
} from "../services/firm-provisioning.service.js";
import workspaceOperationService from "../services/workspace-operation.service.js";

const MEMBERSHIP_TRANSACTION_OPTIONS = {
  readConcern: { level: "snapshot" },
  writeConcern: { w: "majority" },
};

function membershipLifecycleError(
  statusCode,
  message,
  forwardToErrorMiddleware = false,
) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (forwardToErrorMiddleware) error.forwardToErrorMiddleware = true;
  return error;
}

async function withMembershipTransaction(action) {
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(
      () => action(session),
      MEMBERSHIP_TRANSACTION_OPTIONS,
    );
  } finally {
    await session.endSession();
  }
}

async function beginWorkspaceRequest(req, res, kind, payload) {
  try {
    const claim = await workspaceOperationService.claim({
      userId: req.user.id,
      operationId: req.body?.operationId,
      kind,
      payload,
    });

    if (!claim.tracked || claim.isNew) {
      return { handled: false, claim };
    }

    const receipt = claim.receipt;
    if (receipt.status === "PENDING") {
      res.status(202).json({ ok: true, operation: receipt });
    } else if (receipt.status === "SUCCEEDED") {
      res.json({ ok: true, operation: receipt });
    } else {
      res.status(receipt.error?.httpStatus || 409).json({
        ok: false,
        error: receipt.error?.message || "Workspace operation was rejected",
        operation: receipt,
      });
    }
    return { handled: true, claim: null };
  } catch (error) {
    if (!error?.statusCode) throw error;
    res.status(error.statusCode).json({
      ok: false,
      error: error.message,
      ...(error.code ? { code: error.code } : {}),
    });
    return { handled: true, claim: null };
  }
}

async function rejectWorkspaceRequest(res, claim, status, error) {
  const operation = claim?.tracked
    ? await workspaceOperationService.reject(claim, status, error)
    : null;
  return res.status(status).json({
    ok: false,
    error,
    ...(operation ? { operation } : {}),
  });
}

// Activation can fail with a domain status when account authority or firm
// membership changed mid-flight. A client waiting on the exact operation needs
// that as a terminal outcome rather than a 500.
async function activateWorkspace(req, res, claim, user, firm, membership) {
  try {
    const activated = await setActiveWorkspace(
      user,
      firm,
      membership,
      claim,
      req.user?.tokenVersion ?? null,
    );
    return { handled: false, activated };
  } catch (error) {
    if (!error?.statusCode) throw error;

    if (error.operation) {
      res.status(error.statusCode).json({
        ok: false,
        error: error.message,
        operation: error.operation,
      });
    } else {
      await rejectWorkspaceRequest(res, claim, error.statusCode, error.message);
    }
    return { handled: true, activated: null };
  }
}

function hasActiveOwnerAuthority(firm, membership, userId) {
  return (
    membership?.status === "ACTIVE" &&
    membership.role === "OWNER" &&
    Boolean(firm?.ownerUserId) &&
    String(firm.ownerUserId) === String(userId)
  );
}

function hasFirmAdminAuthority(firm, membership, userId) {
  return (
    hasActiveOwnerAuthority(firm, membership, userId) ||
    (membership?.status === "ACTIVE" && membership.role === "ADMIN")
  );
}

function effectiveMembershipRole(firm, membership, userId) {
  if (
    membership?.role === "OWNER" &&
    !hasActiveOwnerAuthority(firm, membership, userId)
  ) {
    return "MEMBER";
  }
  return membership?.role;
}

async function assertFirmAdmin(userId, firmId) {
  const firm = await Firm.findById(firmId);
  if (!firm) {
    const err = new Error("Firm not found");
    err.statusCode = 404;
    throw err;
  }

  const ownerMembership = await FirmMembership.findOne({
    userId,
    firmId: firm._id,
    status: "ACTIVE",
    role: "OWNER",
  })
    .select("_id")
    .lean();
  if (String(firm.ownerUserId) !== String(userId) || !ownerMembership) {
    const err = new Error("Not authorized for this firm");
    err.statusCode = 403;
    throw err;
  }

  return firm;
}

// Any ACTIVE member (owner, admin, or member) of the firm.
async function assertFirmMembership(userId, firmId) {
  const firm = await Firm.findById(firmId);
  if (!firm) {
    const err = new Error("Firm not found");
    err.statusCode = 404;
    throw err;
  }
  if (firm.kind === "PERSONAL" && String(firm.ownerUserId) !== String(userId)) {
    const err = new Error("You are not a member of this firm");
    err.statusCode = 403;
    throw err;
  }
  const membership = await FirmMembership.findOne({
    userId,
    firmId,
    status: "ACTIVE",
  });
  if (!membership) {
    const err = new Error("You are not a member of this firm");
    err.statusCode = 403;
    throw err;
  }
  return { firm, membership };
}

// Switches the user's active workspace and keeps role/accountType coherent with
// their authority in that firm. SUPER_ADMIN is never downgraded. The personal
// workspace pointer is preserved.
// A concurrent removal can land between the membership read and this commit.
// Every firm-scoped request re-checks ACTIVE membership, so that guard is the
// durable control; this only stops the user being parked on a firm they no
// longer belong to.
async function assertMembershipStillActive(userId, firmId) {
  const stillActive = await FirmMembership.exists({
    userId,
    firmId,
    status: "ACTIVE",
  });
  if (stillActive) return;

  const err = new Error(
    "Your membership in this workspace changed before the switch completed",
  );
  err.statusCode = 409;
  throw err;
}

// Restores the active pointer after a lost race: back to the workspace the user
// came from when that membership still holds, otherwise to their personal
// workspace. A removal must never leave the pointer on an unusable firm.
async function restoreActiveWorkspace(userId, preferredFirmId) {
  const user = await User.findById(userId);
  if (!user) return;

  const candidates = [preferredFirmId, user.personalFirmId].filter(Boolean);
  for (const candidateFirmId of candidates) {
    const [firm, membership] = await Promise.all([
      Firm.findOne({
        _id: candidateFirmId,
        isActive: true,
      }).select("_id kind ownerUserId"),
      FirmMembership.findOne({
        userId,
        firmId: candidateFirmId,
        status: "ACTIVE",
      }),
    ]);
    if (!firm || !membership) continue;
    if (
      firm.kind === "PERSONAL" &&
      !hasActiveOwnerAuthority(firm, membership, userId)
    ) {
      continue;
    }

    const elevated = hasFirmAdminAuthority(firm, membership, userId);
    user.firmId = candidateFirmId;
    if (user.role !== "SUPER_ADMIN") {
      user.role = elevated ? "FIRM_ADMIN" : "USER";
    }
    await user.save();
    return;
  }

  user.firmId = null;
  if (user.role !== "SUPER_ADMIN") user.role = "USER";
  await user.save();
}

// Switches the user's active workspace and keeps role/accountType coherent with
// their authority in that firm. SUPER_ADMIN is never downgraded. The personal
// workspace pointer is preserved. Account activation is never changed here:
// workspace selection is not an authority decision.
async function setActiveWorkspace(
  user,
  firm,
  membership,
  operationClaim = null,
  authorizedTokenVersion = null,
) {
  const elevated = hasFirmAdminAuthority(firm, membership, user._id);
  const role =
    user.role === "SUPER_ADMIN"
      ? "SUPER_ADMIN"
      : elevated
        ? "FIRM_ADMIN"
        : "USER";
  const userChanges = {
    accountType: "FIRM_USER",
    role,
  };
  const previousFirmId = user.firmId ? String(user.firmId) : null;

  let activated;
  if (operationClaim?.tracked) {
    activated = await workspaceOperationService.succeed(operationClaim, {
      userId: user._id,
      activeFirmId: firm._id,
      userChanges,
      // Prefer the version this request was authenticated with. Re-reading it
      // here would silently adopt a force-logout that landed in between.
      expectedTokenVersion: Number.isInteger(authorizedTokenVersion)
        ? authorizedTokenVersion
        : user.tokenVersion || 0,
    });
  } else {
    user.firmId = firm._id;
    Object.assign(user, userChanges);
    await user.save();
    activated = { user, receipt: null };
  }

  try {
    await assertMembershipStillActive(user._id, firm._id);
  } catch (error) {
    await restoreActiveWorkspace(user._id, previousFirmId);
    if (operationClaim?.tracked) {
      // The commit already recorded success, so the receipt must be withdrawn
      // rather than left pointing at a firm the user no longer belongs to. A
      // failed withdrawal must still surface the original domain status.
      try {
        error.operation = await workspaceOperationService.rollback(
          operationClaim,
          {
            userId: user._id,
            httpStatus: error.statusCode,
            message: error.message,
          },
        );
      } catch {
        error.operation = null;
      }
    }
    throw error;
  }

  return activated;
}

// Compact summary used by workspace listing/switching responses.
async function workspaceSummary(
  firm,
  membership,
  activeFirmId,
  session = null,
) {
  const countQuery = FirmMembership.countDocuments({
    firmId: firm._id,
    status: "ACTIVE",
  });
  if (session) countQuery.session(session);
  const memberCount = await countQuery;
  const membershipUserId = membership?.userId;
  const role = effectiveMembershipRole(firm, membership, membershipUserId);
  const elevated = hasFirmAdminAuthority(firm, membership, membershipUserId);
  return Object.freeze({
    id: firm._id,
    displayName: firm.displayName,
    handle: firm.handle,
    kind: firm.kind || "SHARED",
    isPersonal: !!membership.isPersonal,
    role,
    memberCount,
    joinCode:
      hasExplicitSharedKind(firm) && elevated ? firm.joinCode : undefined,
    sharingEnabled: firm.sharingEnabled !== false,
    memberAccess: firm.memberAccess === "READ_ONLY" ? "READ_ONLY" : "EDIT",
    isActive: String(firm._id) === String(activeFirmId),
  });
}

function assertActiveLifecycleUser(
  user,
  notFoundMessage,
  forwardToErrorMiddleware = false,
) {
  if (!user) {
    throw membershipLifecycleError(
      404,
      notFoundMessage,
      forwardToErrorMiddleware,
    );
  }
  if (user.isActive === false) {
    throw membershipLifecycleError(
      403,
      "Account is inactive",
      forwardToErrorMiddleware,
    );
  }
}

async function applyMembershipRemovalToUser(user, removedFirmId, session) {
  let activeWorkspace = null;

  if (String(user.firmId || "") === String(removedFirmId)) {
    let personalFirm = null;
    let personalMembership = null;
    if (user.personalFirmId) {
      // The pointer is untrusted. Transactional fallback requires an active,
      // owned firm whose persisted kind is exactly PERSONAL. Missing-kind
      // legacy firms remain ambiguous and cannot restore access.
      personalFirm = await Firm.findOne({
        _id: user.personalFirmId,
        ownerUserId: user._id,
        isActive: true,
        kind: "PERSONAL",
      }).session(session);
      if (personalFirm) {
        personalMembership = await FirmMembership.findOne({
          userId: user._id,
          firmId: personalFirm._id,
          status: "ACTIVE",
        }).session(session);
      }
    }

    if (personalFirm && personalMembership) {
      let membershipChanged = false;
      if (personalMembership.role !== "OWNER") {
        personalMembership.role = "OWNER";
        membershipChanged = true;
      }
      if (!personalMembership.isPersonal) {
        personalMembership.isPersonal = true;
        membershipChanged = true;
      }
      if (membershipChanged) {
        await personalMembership.save({ session });
      }

      user.firmId = personalFirm._id;
      user.accountType = "FIRM_USER";
      if (user.role !== "SUPER_ADMIN") user.role = "FIRM_ADMIN";
      activeWorkspace = { firm: personalFirm, membership: personalMembership };
    } else {
      user.firmId = null;
      user.accountType = "INDIVIDUAL";
      if (user.role !== "SUPER_ADMIN") user.role = "USER";
    }
  }

  // Membership removal is an authority change even when another workspace was
  // active. Revoke every token issued before this transaction commits.
  user.tokenVersion = Number(user.tokenVersion || 0) + 1;
  await user.save({ session });
  return activeWorkspace;
}

async function leaveFirmInTransaction(userId, firmId) {
  return withMembershipTransaction(async (session) => {
    const membership = await FirmMembership.findOne({
      userId,
      firmId,
      status: "ACTIVE",
    }).session(session);
    if (!membership) {
      throw membershipLifecycleError(404, "You are not a member of this firm");
    }

    const user = await User.findById(userId).session(session);
    assertActiveLifecycleUser(user, "User not found");

    // Persisted kind, not the membership marker, decides whether a workspace
    // may be left. Personal workspaces are never leaveable.
    const firm = await Firm.findById(firmId).session(session);
    if (firm?.kind === "PERSONAL") {
      throw membershipLifecycleError(
        400,
        "Your personal workspace cannot be left",
      );
    }

    // Shared ownership must be transferred first even when no other ACTIVE
    // member remains and even when the owner's membership role drifted.
    const isSharedFirmOwner =
      firm?.kind === "SHARED" &&
      Boolean(firm.ownerUserId) &&
      String(firm.ownerUserId) === String(userId);
    if (isSharedFirmOwner) {
      throw membershipLifecycleError(
        409,
        "Transfer ownership before leaving this firm",
      );
    }

    membership.status = "REMOVED";
    await membership.save({ session });
    const activeWorkspace = await applyMembershipRemovalToUser(
      user,
      firmId,
      session,
    );
    const activeWorkspaceSummary = activeWorkspace
      ? await workspaceSummary(
          activeWorkspace.firm,
          activeWorkspace.membership,
          activeWorkspace.firm._id,
          session,
        )
      : null;
    return Object.freeze({ activeWorkspace: activeWorkspaceSummary });
  });
}

async function removeFirmMemberInTransaction(
  actorUserId,
  firmId,
  targetUserId,
) {
  return withMembershipTransaction(async (session) => {
    const firm = await Firm.findById(firmId).session(session);
    if (!firm) {
      throw membershipLifecycleError(404, "Firm not found", true);
    }

    const actor = await User.findById(actorUserId).session(session);
    assertActiveLifecycleUser(actor, "User not found", true);
    const actorMembership = await FirmMembership.findOne({
      userId: actorUserId,
      firmId: firm._id,
      status: "ACTIVE",
      role: "OWNER",
    }).session(session);
    // Controller-level owner authority never follows a global role or a stale
    // owner pointer: both firm identity and ACTIVE OWNER membership must agree.
    if (String(firm.ownerUserId) !== String(actorUserId) || !actorMembership) {
      throw membershipLifecycleError(403, "Not authorized for this firm", true);
    }

    if (String(targetUserId) === String(actorUserId)) {
      throw membershipLifecycleError(400, "Cannot delete yourself");
    }

    const membership = await FirmMembership.findOne({
      userId: targetUserId,
      firmId: firm._id,
      status: "ACTIVE",
    }).session(session);
    if (!membership) {
      throw membershipLifecycleError(404, "User not found in firm");
    }
    const isOwnedPersonalFirm =
      firm.kind === "PERSONAL" &&
      Boolean(firm.ownerUserId) &&
      String(firm.ownerUserId) === String(targetUserId);
    if (isOwnedPersonalFirm) {
      throw membershipLifecycleError(
        400,
        "Cannot remove an owner's personal workspace",
      );
    }

    const targetUser = await User.findById(targetUserId).session(session);
    if (!targetUser) {
      throw membershipLifecycleError(404, "User not found in firm");
    }
    if (targetUser.role === "SUPER_ADMIN") {
      throw membershipLifecycleError(400, "Cannot remove super admin account");
    }

    membership.status = "REMOVED";
    await membership.save({ session });
    await applyMembershipRemovalToUser(targetUser, firm._id, session);

    // Build the success payload from post-removal snapshot data before commit.
    // No fallible response read may escape this transaction.
    const memberships = await FirmMembership.find({
      firmId: firm._id,
      status: "ACTIVE",
    })
      .session(session)
      .lean();
    const memberIds = memberships.map((item) => item.userId);
    const memberUsers = await User.find({ _id: { $in: memberIds } })
      .select("email name role accountType createdAt isActive")
      .session(session)
      .lean();
    const roleByUser = new Map(
      memberships.map((item) => [String(item.userId), item.role]),
    );
    const users = Object.freeze(
      memberUsers.map((memberUser) =>
        Object.freeze({
          ...memberUser,
          membershipRole: roleByUser.get(String(memberUser._id)) || "MEMBER",
        }),
      ),
    );
    const firmProjection = Object.freeze({
      id: firm._id,
      displayName: firm.displayName,
      handle: firm.handle,
    });

    return Object.freeze({ firm: firmProjection, users });
  });
}

// POST /api/firms
export const createFirm = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { displayName, handle, description, practiceAreas } = req.body || {};
    const normalizedDisplayName =
      typeof displayName === "string" ? displayName.trim() : "";
    const normalizedHandle =
      typeof handle === "string" ? handle.trim().toLowerCase() : "";
    const normalizedPracticeAreas = Array.isArray(practiceAreas)
      ? practiceAreas.map((value) => String(value))
      : [];
    const request = await beginWorkspaceRequest(req, res, "CREATE", {
      displayName: normalizedDisplayName,
      handle: normalizedHandle,
      description: String(description || ""),
      practiceAreas: normalizedPracticeAreas,
    });
    if (request.handled) return;

    if (!normalizedDisplayName || !normalizedHandle) {
      return rejectWorkspaceRequest(
        res,
        request.claim,
        400,
        "displayName and handle are required",
      );
    }

    const existing = await Firm.findOne({ handle: normalizedHandle });
    if (existing) {
      return rejectWorkspaceRequest(
        res,
        request.claim,
        409,
        "Firm handle already taken",
      );
    }

    let joinCode;
    while (true) {
      joinCode = Firm.generateJoinCode();
      const clash = await Firm.findOne({ joinCode });
      if (!clash) break;
    }

    const firm = await Firm.create({
      displayName: normalizedDisplayName,
      handle: normalizedHandle,
      ownerUserId: userId,
      description: description || "",
      practiceAreas: normalizedPracticeAreas,
      joinCode,
      planType: "FREE",
      planExpiry: null,
      isActive: true,
      kind: "SHARED",
    });

    // The creator becomes the firm OWNER and the firm becomes their active
    // workspace. Their personal workspace is preserved and remains switchable.
    const owner = await User.findById(userId);
    if (!owner) {
      return rejectWorkspaceRequest(res, request.claim, 404, "User not found");
    }
    const membership = await ensureFirmMembership(userId, firm._id, {
      role: "OWNER",
      isPersonal: false,
    });
    const activation = await activateWorkspace(
      req,
      res,
      request.claim,
      owner,
      firm,
      membership,
    );
    if (activation.handled) return;
    const activated = activation.activated;

    return res.status(201).json({
      ok: true,
      firm,
      workspace: await workspaceSummary(
        firm,
        membership,
        activated.user.firmId,
      ),
      ...(activated.receipt ? { operation: activated.receipt } : {}),
    });
  } catch (err) {
    next(err);
  }
};

// A hydrated legacy firm can expose the schema default "SHARED" even though
// kind was never persisted. Join-code disclosure requires an explicit stored
// SHARED classification, not a hydration default.
function hasExplicitSharedKind(firm) {
  return (
    firm?.kind === "SHARED" &&
    !(typeof firm?.$isDefault === "function" && firm.$isDefault("kind"))
  );
}

function serializeFirmWithJoinCodeAccess(firm, canViewJoinCode) {
  const serializedFirm =
    typeof firm?.toJSON === "function"
      ? firm.toJSON()
      : typeof firm?.toObject === "function"
        ? firm.toObject()
        : firm;
  const responseFirm = { ...serializedFirm };
  if (!canViewJoinCode || !hasExplicitSharedKind(firm)) {
    delete responseFirm.joinCode;
  }
  return responseFirm;
}

// GET /api/firms/me
function serializeFirmForViewer(firm, membership, userId) {
  return serializeFirmWithJoinCodeAccess(
    firm,
    hasFirmAdminAuthority(firm, membership, userId),
  );
}

export const getMyFirm = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId);
    if (!user) {
      return res
        .status(404)
        .json({ ok: false, error: "User is not linked to any firm" });
    }

    // Sign-in healing may backfill a missing legacy row, but a retained REMOVED
    // shared membership forces the active pointer back to the personal workspace.
    await ensurePersonalFirm(user);
    if (!user.firmId) {
      return res
        .status(404)
        .json({ ok: false, error: "User is not linked to any firm" });
    }

    const firm = await Firm.findById(user.firmId);
    if (!firm) {
      return res.status(404).json({ ok: false, error: "Firm not found" });
    }

    const membership = await FirmMembership.findOne({
      userId,
      firmId: firm._id,
      status: "ACTIVE",
    });
    if (!membership) {
      return res
        .status(404)
        .json({ ok: false, error: "User is not linked to any firm" });
    }

    return res.json({
      ok: true,
      firm: serializeFirmForViewer(firm, membership, userId),
      workspace: await workspaceSummary(firm, membership, user.firmId),
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/firms/workspaces
// Lists every workspace the signed-in user can switch into (personal + shared),
// marking the active one. Powers the collaborative workspace switcher.
export const listWorkspaces = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId).select("firmId personalFirmId");
    if (!user) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }

    const memberships = await FirmMembership.find({
      userId,
      status: "ACTIVE",
    }).lean();

    const firmIds = memberships.map((m) => m.firmId);
    const firms = await Firm.find({
      _id: { $in: firmIds },
      isActive: true,
    }).lean();
    const firmById = new Map(firms.map((f) => [String(f._id), f]));

    const counts = await FirmMembership.aggregate([
      { $match: { firmId: { $in: firmIds }, status: "ACTIVE" } },
      { $group: { _id: "$firmId", count: { $sum: 1 } } },
    ]);
    const countById = new Map(counts.map((c) => [String(c._id), c.count]));

    const workspaces = memberships
      .map((m) => {
        const firm = firmById.get(String(m.firmId));
        if (!firm) return null;
        // Lean results preserve persisted kind. Historical memberships cannot
        // surface another user's explicitly PERSONAL workspace, while legacy
        // missing-kind memberships retain their existing compatibility.
        if (
          firm.kind === "PERSONAL" &&
          String(firm.ownerUserId) !== String(userId)
        ) {
          return null;
        }
        const role = effectiveMembershipRole(firm, m, userId);
        const elevated = hasFirmAdminAuthority(firm, m, userId);
        return {
          id: firm._id,
          displayName: firm.displayName,
          handle: firm.handle,
          kind: firm.kind || "SHARED",
          isPersonal: !!m.isPersonal,
          role,
          memberCount: countById.get(String(firm._id)) || 1,
          joinCode:
            hasExplicitSharedKind(firm) && elevated ? firm.joinCode : undefined,
          sharingEnabled: firm.sharingEnabled !== false,
          memberAccess:
            firm.memberAccess === "READ_ONLY" ? "READ_ONLY" : "EDIT",
          isActive: String(firm._id) === String(user.firmId),
        };
      })
      .filter(Boolean)
      // Personal workspace first, then shared firms by name.
      .sort((a, b) => {
        if (a.isPersonal !== b.isPersonal) return a.isPersonal ? -1 : 1;
        return String(a.displayName).localeCompare(String(b.displayName));
      });

    return res.json({
      ok: true,
      activeFirmId: user.firmId || null,
      personalFirmId: user.personalFirmId || null,
      workspaces,
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/firms/workspace-operations/:operationId
// Exact, user-scoped terminal status for a desktop workspace mutation. A 404
// intentionally does not reveal whether another account owns the identifier.
export const getWorkspaceOperationStatus = async (req, res, next) => {
  try {
    const operation = await workspaceOperationService.statusFor(
      req.user.id,
      req.params.operationId,
    );
    return res.json({ ok: true, operation });
  } catch (error) {
    if (error?.statusCode) {
      return res.status(error.statusCode).json({
        ok: false,
        error: error.message,
        ...(error.code ? { code: error.code } : {}),
      });
    }
    next(error);
  }
};

// POST /api/firms/switch  { firmId, operationId? }
// Switches the active workspace to another firm the user is an active member of.
export const switchWorkspace = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { firmId } = req.body || {};
    const normalizedFirmId = typeof firmId === "string" ? firmId.trim() : "";
    const request = await beginWorkspaceRequest(req, res, "SWITCH", {
      firmId: normalizedFirmId,
    });
    if (request.handled) return;

    if (!normalizedFirmId) {
      return rejectWorkspaceRequest(
        res,
        request.claim,
        400,
        "firmId is required",
      );
    }

    let firm;
    let membership;
    try {
      ({ firm, membership } = await assertFirmMembership(
        userId,
        normalizedFirmId,
      ));
    } catch (error) {
      if (error?.statusCode) {
        return rejectWorkspaceRequest(
          res,
          request.claim,
          error.statusCode,
          error.message,
        );
      }
      throw error;
    }
    if (!firm.isActive) {
      return rejectWorkspaceRequest(
        res,
        request.claim,
        409,
        "This workspace is not available",
      );
    }

    const user = await User.findById(userId);
    if (!user) {
      return rejectWorkspaceRequest(res, request.claim, 404, "User not found");
    }
    const activation = await activateWorkspace(
      req,
      res,
      request.claim,
      user,
      firm,
      membership,
    );
    if (activation.handled) return;
    const activated = activation.activated;

    return res.json({
      ok: true,
      workspace: await workspaceSummary(
        firm,
        membership,
        activated.user.firmId,
      ),
      user: {
        id: activated.user._id,
        email: activated.user.email,
        role: activated.user.role,
        accountType: activated.user.accountType,
        firmId: activated.user.firmId,
      },
      ...(activated.receipt ? { operation: activated.receipt } : {}),
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/firms/:firmId/members
// Any active member can see who they collaborate with in a firm.
export const listFirmMembers = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { firmId } = req.params;
    const { firm } = await assertFirmMembership(userId, firmId);

    const memberships = await FirmMembership.find({
      firmId: firm._id,
      status: "ACTIVE",
    })
      .sort({ isPersonal: -1, role: 1, joinedAt: 1 })
      .lean();

    const userIds = memberships.map((m) => m.userId);
    const users = await User.find({ _id: { $in: userIds } })
      .select("name email lastActiveAt")
      .lean();
    const userById = new Map(users.map((u) => [String(u._id), u]));

    const members = memberships.map((m) => {
      const u = userById.get(String(m.userId)) || {};
      return {
        userId: m.userId,
        name: u.name || null,
        email: u.email || null,
        role: m.role,
        joinedAt: m.joinedAt,
        lastActiveAt: u.lastActiveAt || null,
        isYou: String(m.userId) === String(userId),
      };
    });

    return res.json({
      ok: true,
      firm: {
        id: firm._id,
        displayName: firm.displayName,
        handle: firm.handle,
        kind: firm.kind || "SHARED",
      },
      members,
    });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ ok: false, error: err.message });
    }
    next(err);
  }
};

// POST /api/firms/:firmId/leave
// Leaves a shared firm. The personal workspace can never be left. If the user
// leaves their active firm, they fall back to their personal workspace.
export const leaveFirm = async (req, res, next) => {
  try {
    const { activeWorkspace } = await leaveFirmInTransaction(
      req.user.id,
      req.params.firmId,
    );
    return res.json({ ok: true, activeWorkspace });
  } catch (err) {
    if (err?.statusCode) {
      return res.status(err.statusCode).json({ ok: false, error: err.message });
    }
    next(err);
  }
};

// GET /api/firms/:firmId
export const getFirmById = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { firmId } = req.params;
    const firm = await assertFirmAdmin(userId, firmId);
    return res.json({
      ok: true,
      firm: serializeFirmWithJoinCodeAccess(firm, true),
    });
  } catch (err) {
    next(err);
  }
};

// PATCH /api/firms/:firmId
export const updateFirm = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { firmId } = req.params;
    const firm = await assertFirmAdmin(userId, firmId);

    const {
      displayName,
      description,
      practiceAreas,
      joinCode,
      sharingEnabled,
      memberAccess,
    } = req.body || {};

    // Update basic fields
    if (displayName !== undefined) firm.displayName = displayName.trim();
    if (description !== undefined) firm.description = description || "";
    if (Array.isArray(practiceAreas)) firm.practiceAreas = practiceAreas;
    // Owner-only privacy switch (assertFirmAdmin above already enforced ownership).
    if (typeof sharingEnabled === "boolean")
      firm.sharingEnabled = sharingEnabled;
    // Owner-only member write access: EDIT (collaborative) or READ_ONLY (view only).
    if (memberAccess !== undefined) {
      if (memberAccess !== "EDIT" && memberAccess !== "READ_ONLY") {
        return res.status(400).json({
          ok: false,
          error: "memberAccess must be either EDIT or READ_ONLY",
        });
      }
      firm.memberAccess = memberAccess;
    }

    // Handle custom join code update
    if (joinCode) {
      const normalizedCode = String(joinCode).trim().toUpperCase();

      // Validate length
      if (normalizedCode.length < 4 || normalizedCode.length > 10) {
        return res.status(400).json({
          ok: false,
          error: "Join code must be 4-10 characters",
        });
      }

      // Check for clashes with other firms
      const clash = await Firm.findOne({
        joinCode: normalizedCode,
        _id: { $ne: firmId },
      });

      if (clash) {
        return res.status(409).json({
          ok: false,
          error: "Join code already taken by another firm",
        });
      }

      firm.joinCode = normalizedCode;
    }

    await firm.save();
    return res.json({
      ok: true,
      firm: serializeFirmWithJoinCodeAccess(firm, true),
    });
  } catch (err) {
    next(err);
  }
};

// POST /api/firms/:firmId/join-code/rotate
export const rotateJoinCode = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { firmId } = req.params;
    const firm = await assertFirmAdmin(userId, firmId);

    // Generate unique join code
    let joinCode;
    while (true) {
      joinCode = Firm.generateJoinCode();
      const clash = await Firm.findOne({
        joinCode,
        _id: { $ne: firmId },
      });
      if (!clash) break;
    }

    firm.joinCode = joinCode;
    await firm.save();

    return res.json({
      ok: true,
      ...(hasExplicitSharedKind(firm) ? { joinCode: firm.joinCode } : {}),
    });
  } catch (err) {
    next(err);
  }
};

const WORKSPACE_SUCCESS_RECEIPT_LIMIT = 20;

function tokenVersionFilter(tokenVersion) {
  return tokenVersion === 0 ? { $in: [0, null] } : tokenVersion;
}

function joinAuthorityChangedError(currentUser) {
  if (!currentUser) {
    return membershipLifecycleError(404, "User not found");
  }
  return membershipLifecycleError(
    409,
    currentUser.isActive === false
      ? "This account is no longer active, so the workspace change was not applied. Contact your firm administrator."
      : "This session was signed out on the server, so the workspace change was not applied. Sign in again, then retry.",
  );
}

function trackedJoinReceipt(operationClaim, activeFirmId, completedAt) {
  if (!operationClaim?.tracked) return null;
  const operation = operationClaim.operation;
  const startedAt = operation.startedAt || operation.createdAt || completedAt;
  return {
    stored: {
      operationId: operation.operationId,
      kind: operation.kind,
      requestHash: operation.requestHash,
      activeFirmId,
      startedAt,
      completedAt,
    },
    response: {
      operationId: String(operation.operationId),
      kind: String(operation.kind),
      status: "SUCCEEDED",
      activeFirmId: String(activeFirmId),
      startedAt,
      completedAt,
    },
  };
}

async function joinFirmInTransaction({
  userId,
  joinCode,
  operationClaim,
  authorizedTokenVersion,
}) {
  return withMembershipTransaction(async (session) => {
    // Persisted kind is part of join authority. Hydration defaults must not turn
    // an ambiguous legacy row into a joinable shared workspace.
    const firm = await Firm.findOne({
      joinCode,
      kind: "SHARED",
    }).session(session);
    if (!firm || !firm.isActive) {
      throw membershipLifecycleError(404, "Invalid or inactive join code");
    }

    const user = await User.findById(userId).session(session);
    if (!user) throw membershipLifecycleError(404, "User not found");
    if (user.isActive === false) throw joinAuthorityChangedError(user);

    const existing = await FirmMembership.findOne({
      userId,
      firmId: firm._id,
    }).session(session);
    const alreadyMember = existing?.status === "ACTIVE";
    const isOwner = String(firm.ownerUserId) === String(userId);

    // A retained removal is not active access. Private workspaces require the
    // owner to enable sharing before this explicit reactivation path may run.
    if (firm.sharingEnabled === false && !isOwner && !alreadyMember) {
      throw membershipLifecycleError(
        403,
        "This workspace is private. Ask the owner to turn on sharing before you can join.",
      );
    }

    const membership = await ensureFirmMembership(userId, firm._id, {
      role: isOwner ? "OWNER" : "MEMBER",
      isPersonal: false,
      reactivateRemoved: true,
      session,
    });
    const elevated = hasFirmAdminAuthority(firm, membership, userId);
    const userChanges = {
      firmId: firm._id,
      accountType: "FIRM_USER",
      role:
        user.role === "SUPER_ADMIN"
          ? "SUPER_ADMIN"
          : elevated
            ? "FIRM_ADMIN"
            : "USER",
    };

    const completedAt = new Date();
    const operationReceipt = trackedJoinReceipt(
      operationClaim,
      firm._id,
      completedAt,
    );
    const update = { $set: userChanges };
    if (operationReceipt) {
      update.$push = {
        workspaceOperationReceipts: {
          $each: [operationReceipt.stored],
          $slice: -WORKSPACE_SUCCESS_RECEIPT_LIMIT,
        },
      };
    }

    // This compare-and-set binds the mutation to the exact tokenVersion that
    // authenticated the request. Membership reactivation rolls back if a
    // suspension or force-logout wins before commit.
    const activatedUser = await User.findOneAndUpdate(
      {
        _id: userId,
        isActive: { $ne: false },
        tokenVersion: tokenVersionFilter(authorizedTokenVersion),
      },
      update,
      { new: true, runValidators: true, session },
    );
    if (!activatedUser) {
      const currentUser = await User.findById(userId)
        .select("isActive tokenVersion")
        .session(session)
        .lean();
      throw joinAuthorityChangedError(currentUser);
    }

    if (operationReceipt) {
      // The status row participates in the same authority transaction. A write
      // error must abort membership reactivation, the user pointer, and receipt.
      await WorkspaceOperation.updateOne(
        { _id: operationClaim.operation._id, status: "PENDING" },
        {
          $set: {
            status: "SUCCEEDED",
            activeFirmId: firm._id,
            completedAt,
            failure: null,
          },
        },
        { session },
      );
    }

    return {
      alreadyMember,
      firm: {
        id: firm._id,
        displayName: firm.displayName,
        handle: firm.handle,
      },
      workspace: await workspaceSummary(
        firm,
        membership,
        activatedUser.firmId,
        session,
      ),
      user: {
        id: activatedUser._id,
        email: activatedUser.email,
        name: activatedUser.name,
        role: activatedUser.role,
        accountType: activatedUser.accountType,
        firmId: activatedUser.firmId,
      },
      operation: operationReceipt?.response || null,
    };
  });
}

// POST /api/firms/join
export const joinFirmByCode = async (req, res, next) => {
  try {
    const userId = req.user.id;
    // Capture once. Transactional code must never adopt a newer version read
    // after this request passed authentication.
    const authorizedTokenVersion = Number.isInteger(req.user?.tokenVersion)
      ? req.user.tokenVersion
      : 0;
    const { joinCode } = req.body || {};
    const normalizedJoinCode =
      typeof joinCode === "string" ? joinCode.trim().toUpperCase() : "";
    const request = await beginWorkspaceRequest(req, res, "JOIN", {
      joinCode: normalizedJoinCode,
    });
    if (request.handled) return;

    if (!normalizedJoinCode) {
      return rejectWorkspaceRequest(
        res,
        request.claim,
        400,
        "joinCode is required",
      );
    }

    let result;
    try {
      result = await joinFirmInTransaction({
        userId,
        joinCode: normalizedJoinCode,
        operationClaim: request.claim,
        authorizedTokenVersion,
      });
    } catch (error) {
      if (error?.statusCode) {
        return rejectWorkspaceRequest(
          res,
          request.claim,
          error.statusCode,
          error.message,
        );
      }
      if (request.claim?.tracked) {
        try {
          return await rejectWorkspaceRequest(
            res,
            request.claim,
            500,
            "Workspace join could not be completed",
          );
        } catch {
          // Preserve the original failure for global handling when the
          // operation receipt cannot itself be made terminal.
        }
      }
      throw error;
    }

    return res.json({
      ok: true,
      alreadyMember: result.alreadyMember,
      firm: result.firm,
      workspace: result.workspace,
      user: result.user,
      ...(result.operation ? { operation: result.operation } : {}),
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/firms/:firmId/users
export const listFirmUsers = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { firmId } = req.params;
    const firm = await assertFirmAdmin(userId, firmId);

    const memberships = await FirmMembership.find({
      firmId: firm._id,
      status: "ACTIVE",
    })
      .select("userId")
      .lean();
    const memberUserIds = memberships.map((membership) => membership.userId);
    const users = await User.find({ _id: { $in: memberUserIds } }).select(
      "email name role accountType createdAt isActive",
    );

    return res.json({
      ok: true,
      firm: {
        id: firm._id,
        displayName: firm.displayName,
        handle: firm.handle,
      },
      users,
    });
  } catch (err) {
    next(err);
  }
};

// POST /api/firms/request-admin
// Current user wants to become FIRM_ADMIN of their linked firm
export const requestFirmAdmin = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }

    if (!user.firmId) {
      return res
        .status(400)
        .json({ ok: false, error: "User is not linked to any firm" });
    }

    if (user.role === "FIRM_ADMIN" && user.isActive !== false) {
      return res.json({
        ok: true,
        alreadyAdmin: true,
        message: "Already an approved Firm Admin",
      });
    }

    // Legacy pending accounts were marked by clearing isActive. Report them as
    // pending without creating a second request.
    if (user.firmAdminRequestedAt || user.isActive === false) {
      return res.json({
        ok: true,
        alreadyPending: true,
        message: "Firm Admin approval is already pending",
      });
    }

    // Record the request only. Role and activation stay untouched until a super
    // admin approves, so the account keeps working and stays visible in the
    // approval queue.
    user.firmAdminRequestedAt = new Date();
    user.accountType = "FIRM_USER";
    await user.save();

    return res.json({
      ok: true,
      pending: true,
      message: "Firm Admin request created. Wait for Super Admin approval.",
    });
  } catch (err) {
    next(err);
  }
};

// DELETE /api/firms/:firmId/users/:userId
// Firm owner can delete firm members (not self)
export const deleteFirmUser = async (req, res, next) => {
  try {
    const { firm, users } = await removeFirmMemberInTransaction(
      req.user.id,
      req.params.firmId,
      req.params.userId,
    );

    return res.json({ ok: true, firm, users });
  } catch (err) {
    if (err?.statusCode && !err.forwardToErrorMiddleware) {
      return res.status(err.statusCode).json({ ok: false, error: err.message });
    }
    next(err);
  }
};

export default {
  createFirm,
  getMyFirm,
  getFirmById,
  updateFirm,
  rotateJoinCode,
  joinFirmByCode,
  listFirmUsers,
  requestFirmAdmin,
  deleteFirmUser,
  listWorkspaces,
  switchWorkspace,
  listFirmMembers,
  leaveFirm,
};
