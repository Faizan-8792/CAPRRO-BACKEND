// src/controllers/firm.controller.js
import Firm from "../models/Firm.js";
import User from "../models/User.js";
import FirmMembership from "../models/FirmMembership.js";
import { ensureFirmMembership } from "../services/firm-provisioning.service.js";
import workspaceOperationService from "../services/workspace-operation.service.js";

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

async function assertFirmAdmin(userId, firmId) {
  const firm = await Firm.findById(firmId);
  if (!firm) {
    const err = new Error("Firm not found");
    err.statusCode = 404;
    throw err;
  }

  if (String(firm.ownerUserId) !== String(userId)) {
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
    const membership = await FirmMembership.findOne({
      userId,
      firmId: candidateFirmId,
      status: "ACTIVE",
    });
    if (!membership) continue;

    const elevated = membership.role === "OWNER" || membership.role === "ADMIN";
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
  const elevated = membership.role === "OWNER" || membership.role === "ADMIN";
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
async function workspaceSummary(firm, membership, activeFirmId) {
  const memberCount = await FirmMembership.countDocuments({
    firmId: firm._id,
    status: "ACTIVE",
  });
  return {
    id: firm._id,
    displayName: firm.displayName,
    handle: firm.handle,
    kind: firm.kind || "SHARED",
    isPersonal: !!membership.isPersonal,
    role: membership.role,
    memberCount,
    joinCode:
      membership.role === "OWNER" || membership.role === "ADMIN"
        ? firm.joinCode
        : undefined,
    sharingEnabled: firm.sharingEnabled !== false,
    memberAccess: firm.memberAccess === "READ_ONLY" ? "READ_ONLY" : "EDIT",
    isActive: String(firm._id) === String(activeFirmId),
  };
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

// GET /api/firms/me
export const getMyFirm = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId);
    if (!user || !user.firmId) {
      return res
        .status(404)
        .json({ ok: false, error: "User is not linked to any firm" });
    }

    const firm = await Firm.findById(user.firmId);
    if (!firm) {
      return res.status(404).json({ ok: false, error: "Firm not found" });
    }

    let membership = await FirmMembership.findOne({
      userId,
      firmId: firm._id,
      status: "ACTIVE",
    });
    // Backfill for accounts that predate the collaborative model.
    if (!membership) {
      membership = await ensureFirmMembership(userId, firm._id, {
        role: String(firm.ownerUserId) === String(userId) ? "OWNER" : "MEMBER",
        isPersonal: String(user.personalFirmId || "") === String(firm._id),
      });
    }

    return res.json({
      ok: true,
      firm,
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
        const elevated = m.role === "OWNER" || m.role === "ADMIN";
        return {
          id: firm._id,
          displayName: firm.displayName,
          handle: firm.handle,
          kind: firm.kind || "SHARED",
          isPersonal: !!m.isPersonal,
          role: m.role,
          memberCount: countById.get(String(firm._id)) || 1,
          joinCode: elevated ? firm.joinCode : undefined,
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
    const userId = req.user.id;
    const { firmId } = req.params;

    const membership = await FirmMembership.findOne({
      userId,
      firmId,
      status: "ACTIVE",
    });
    if (!membership) {
      return res
        .status(404)
        .json({ ok: false, error: "You are not a member of this firm" });
    }
    if (membership.isPersonal) {
      return res.status(400).json({
        ok: false,
        error: "Your personal workspace cannot be left",
      });
    }

    const user = await User.findById(userId);
    if (membership.role === "OWNER") {
      const otherMembers = await FirmMembership.countDocuments({
        firmId,
        status: "ACTIVE",
        userId: { $ne: userId },
      });
      if (otherMembers > 0) {
        return res.status(409).json({
          ok: false,
          error:
            "Transfer ownership or remove members before leaving this firm",
        });
      }
    }

    membership.status = "REMOVED";
    await membership.save();

    // If they left their active workspace, return to the personal workspace.
    let switched = null;
    if (String(user.firmId) === String(firmId)) {
      const personalFirmId = user.personalFirmId;
      const personalFirm = personalFirmId
        ? await Firm.findById(personalFirmId)
        : null;
      const personalMembership = personalFirm
        ? await FirmMembership.findOne({
            userId,
            firmId: personalFirm._id,
            status: "ACTIVE",
          })
        : null;
      if (personalFirm && personalMembership) {
        await setActiveWorkspace(user, personalFirm, personalMembership);
        switched = await workspaceSummary(
          personalFirm,
          personalMembership,
          user.firmId,
        );
      }
    }

    return res.json({ ok: true, activeWorkspace: switched });
  } catch (err) {
    next(err);
  }
};

// GET /api/firms/:firmId
export const getFirmById = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { firmId } = req.params;
    const firm = await assertFirmAdmin(userId, firmId);
    return res.json({ ok: true, firm });
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
    return res.json({ ok: true, firm });
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

    return res.json({ ok: true, joinCode: firm.joinCode });
  } catch (err) {
    next(err);
  }
};

// POST /api/firms/join
export const joinFirmByCode = async (req, res, next) => {
  try {
    const userId = req.user.id;
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

    const firm = await Firm.findOne({ joinCode: normalizedJoinCode });

    if (!firm || !firm.isActive) {
      return rejectWorkspaceRequest(
        res,
        request.claim,
        404,
        "Invalid or inactive join code",
      );
    }

    const user = await User.findById(userId);
    if (!user) {
      return rejectWorkspaceRequest(res, request.claim, 404, "User not found");
    }

    // Joining is additive: a shared-firm membership is created (or reactivated)
    // and the firm becomes the active workspace. The user keeps their personal
    // workspace and any other firms. Joining does not grant firm-admin authority.
    const existing = await FirmMembership.findOne({ userId, firmId: firm._id });
    const alreadyMember = !!existing && existing.status === "ACTIVE";
    const isOwner = String(firm.ownerUserId) === String(userId);

    // Private workspace: refuse new joins. Existing members and the owner are
    // unaffected (they use switch, not join). Legacy firms without the flag are
    // treated as sharing-enabled.
    if (firm.sharingEnabled === false && !isOwner && !alreadyMember) {
      return rejectWorkspaceRequest(
        res,
        request.claim,
        403,
        "This workspace is private. Ask the owner to turn on sharing before you can join.",
      );
    }

    const membership = await ensureFirmMembership(userId, firm._id, {
      role: isOwner ? "OWNER" : "MEMBER",
      isPersonal: String(user.personalFirmId || "") === String(firm._id),
    });

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
      alreadyMember,
      firm: {
        id: firm._id,
        displayName: firm.displayName,
        handle: firm.handle,
      },
      workspace: await workspaceSummary(
        firm,
        membership,
        activated.user.firmId,
      ),
      user: {
        id: activated.user._id,
        email: activated.user.email,
        name: activated.user.name,
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

// GET /api/firms/:firmId/users
export const listFirmUsers = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { firmId } = req.params;
    const firm = await assertFirmAdmin(userId, firmId);

    const users = await User.find({ firmId: firm._id }).select(
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
    const userId = req.user.id;
    const { firmId, userId: targetUserId } = req.params;

    const firm = await assertFirmAdmin(userId, firmId);
    if (!firm)
      return res.status(404).json({ ok: false, error: "Firm not found" });

    // Cannot delete self
    if (String(targetUserId) === String(userId)) {
      return res
        .status(400)
        .json({ ok: false, error: "Cannot delete yourself" });
    }

    const membership = await FirmMembership.findOne({
      userId: targetUserId,
      firmId: firm._id,
      status: "ACTIVE",
    });
    if (!membership) {
      return res
        .status(404)
        .json({ ok: false, error: "User not found in firm" });
    }
    if (membership.isPersonal) {
      return res.status(400).json({
        ok: false,
        error: "Cannot remove an owner's personal workspace",
      });
    }

    const targetUser = await User.findById(targetUserId);
    if (targetUser && targetUser.role === "SUPER_ADMIN") {
      return res
        .status(400)
        .json({ ok: false, error: "Cannot remove super admin account" });
    }

    // Remove the membership. If the removed user was actively in this firm,
    // move them back to their own personal workspace instead of stranding them.
    membership.status = "REMOVED";
    await membership.save();

    if (targetUser && String(targetUser.firmId) === String(firm._id)) {
      const personalFirm = targetUser.personalFirmId
        ? await Firm.findById(targetUser.personalFirmId)
        : null;
      const personalMembership = personalFirm
        ? await FirmMembership.findOne({
            userId: targetUserId,
            firmId: personalFirm._id,
            status: "ACTIVE",
          })
        : null;
      if (personalFirm && personalMembership) {
        await setActiveWorkspace(targetUser, personalFirm, personalMembership);
      } else {
        targetUser.firmId = null;
        if (targetUser.role !== "SUPER_ADMIN") targetUser.role = "USER";
        await targetUser.save();
      }
    }

    // Return the updated active member list for this firm.
    const memberships = await FirmMembership.find({
      firmId: firm._id,
      status: "ACTIVE",
    }).lean();
    const memberIds = memberships.map((m) => m.userId);
    const memberUsers = await User.find({ _id: { $in: memberIds } })
      .select("email name role accountType createdAt isActive")
      .lean();
    const roleByUser = new Map(
      memberships.map((m) => [String(m.userId), m.role]),
    );
    const users = memberUsers.map((u) => ({
      ...u,
      membershipRole: roleByUser.get(String(u._id)) || "MEMBER",
    }));

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
