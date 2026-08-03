// src/services/firm-provisioning.service.js
//
// Workspace provisioning for collaborative firms.
//
// Every account owns a personal workspace (a Firm with kind=PERSONAL) so the
// product is usable immediately, without being forced to create or join a firm.
// On top of that, a user may create or join shared firms; each of those is a
// FirmMembership. `User.firmId` always points at the *active* workspace.
//
// This module is idempotent and safe to call on every login and on /me. It also
// backfills memberships for accounts that predate the collaborative model.

import crypto from "crypto";
import Firm from "../models/Firm.js";
import FirmMembership from "../models/FirmMembership.js";

function slugifyBase(input) {
  const base = String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return base || "workspace";
}

/**
 * Ensures a membership row exists for (firm, user). A retained REMOVED row is
 * reactivated only when the caller explicitly allows it. Generic sign-in and
 * legacy backfill must not restore access to a shared workspace the user left
 * or was removed from.
 */
export async function ensureFirmMembership(
  userId,
  firmId,
  {
    role = "MEMBER",
    isPersonal,
    reactivateRemoved = false,
    session = null,
  } = {},
) {
  const synchronizePersonalMarker = typeof isPersonal === "boolean";
  const personalMarker = synchronizePersonalMarker ? isPersonal : false;
  const membershipQuery = FirmMembership.findOne({ firmId, userId });
  if (session) membershipQuery.session(session);
  const existing = await membershipQuery;
  if (!existing) {
    const membership = {
      userId,
      firmId,
      role,
      status: "ACTIVE",
      isPersonal: personalMarker,
      joinedAt: new Date(),
    };
    if (session) {
      const [created] = await FirmMembership.create([membership], { session });
      return created;
    }
    return FirmMembership.create(membership);
  }

  // Only personal-workspace repair and validated join-by-code may cross this
  // boundary. Returning the retained row lets generic healing fall back safely.
  if (existing.status !== "ACTIVE" && !reactivateRemoved) return existing;

  let changed = false;
  if (existing.status !== "ACTIVE") {
    existing.status = "ACTIVE";
    if (existing.role !== role) existing.role = role;
    changed = true;
  } else if (role === "OWNER" && existing.role !== "OWNER") {
    existing.role = "OWNER";
    changed = true;
  }
  if (synchronizePersonalMarker && existing.isPersonal !== personalMarker) {
    existing.isPersonal = personalMarker;
    changed = true;
  }
  if (changed) {
    if (session) await existing.save({ session });
    else await existing.save();
  }
  return existing;
}

async function createPersonalFirm(user) {
  const displayName = user.name ? `${user.name}'s Workspace` : "My Workspace";
  const handleBase = slugifyBase(
    user.name || String(user.email || "").split("@")[0],
  );

  let firm = null;
  let lastError = null;
  for (let attempt = 0; attempt < 6 && !firm; attempt++) {
    const suffix = crypto.randomBytes(3).toString("hex"); // 6 hex chars
    const handle = `${handleBase}-${suffix}`.slice(0, 40);
    const joinCode = Firm.generateJoinCode();
    try {
      firm = await Firm.create({
        displayName,
        handle,
        ownerUserId: user._id,
        joinCode,
        planType: "FREE",
        isActive: true,
        kind: "PERSONAL",
      });
    } catch (error) {
      lastError = error;
      if (error && error.code === 11000) continue; // handle/joinCode clash - retry
      throw error;
    }
  }

  if (!firm) {
    throw lastError || new Error("Could not provision personal workspace");
  }
  return firm;
}

/**
 * Resolves (and if needed creates) the user's personal workspace.
 * Repair rule: only an active firm owned by the user with persisted kind exactly
 * PERSONAL may be reused. A missing kind is ambiguous legacy data and must not
 * be converted or have a retained membership reactivated by generic healing.
 */
async function resolvePersonalFirm(user) {
  // A pointer is only a repair hint. Ownership plus an explicit persisted kind
  // must establish personal-workspace identity before repair may reactivate a
  // retained membership.
  const candidateIds = [user.personalFirmId, user.firmId].filter(Boolean);
  for (const candidateId of candidateIds) {
    const candidate = await Firm.findOne({
      _id: candidateId,
      ownerUserId: user._id,
      isActive: true,
      kind: "PERSONAL",
    }).select("_id ownerUserId kind");
    if (candidate) return candidate;
  }

  return createPersonalFirm(user);
}

/**
 * Ensures the given user document has:
 *  - a personal workspace (personalFirmId) with an OWNER personal membership,
 *  - a valid active workspace (firmId) with a membership row,
 *  - a coherent role/accountType for the active workspace.
 *
 * The export name is kept as `ensurePersonalFirm` for backward compatibility
 * with existing auth flows.
 *
 * @param {import("mongoose").Document} user - a full (non-lean) User document
 * @returns {Promise<import("mongoose").Document>} the same user document
 */
export async function ensurePersonalFirm(user) {
  if (!user) return user;

  // Personal membership is the only membership generic healing may reactivate.
  const personalFirm = await resolvePersonalFirm(user);
  let userChanged = false;
  if (String(user.personalFirmId || "") !== String(personalFirm._id)) {
    user.personalFirmId = personalFirm._id;
    userChanged = true;
  }
  const personalMembership = await ensureFirmMembership(
    user._id,
    personalFirm._id,
    {
      role: "OWNER",
      isPersonal: true,
      reactivateRemoved: true,
    },
  );

  // Keep the current pointer when it is the resolved personal workspace, an
  // active persisted SHARED workspace, or a persisted missing-kind workspace
  // that already has an ACTIVE membership. Query missing kind before hydration:
  // the model default would otherwise make ambiguous legacy data look SHARED.
  let activeFirm = null;
  let activeMembership = null;
  if (String(user.firmId || "") === String(personalFirm._id)) {
    activeFirm = personalFirm;
    activeMembership = personalMembership;
  } else if (user.firmId) {
    activeFirm = await Firm.findOne({
      _id: user.firmId,
      isActive: true,
      kind: "SHARED",
    }).select("_id ownerUserId kind");

    if (activeFirm) {
      // Generic sign-in healing may preserve only authority already recorded
      // for a shared workspace. Membership creation/reactivation belongs to
      // validated join flow (or explicit firm-owner creation).
      activeMembership = await FirmMembership.findOne({
        userId: user._id,
        firmId: activeFirm._id,
        status: "ACTIVE",
      });
      if (!activeMembership) activeFirm = null;
    } else {
      // Missing-kind records are ambiguous legacy data. Preserve an existing
      // active relationship, but never manufacture or restore one here.
      const legacyFirm = await Firm.findOne({
        _id: user.firmId,
        isActive: true,
        kind: { $exists: false },
      }).select("_id ownerUserId kind");
      if (legacyFirm) {
        const legacyMembership = await FirmMembership.findOne({
          userId: user._id,
          firmId: legacyFirm._id,
          status: "ACTIVE",
        });
        if (legacyMembership) {
          activeFirm = legacyFirm;
          activeMembership = legacyMembership;
        }
      }
    }
  }

  if (!activeFirm) {
    if (String(user.firmId || "") !== String(personalFirm._id)) {
      user.firmId = personalFirm._id;
      userChanged = true;
    }
    activeFirm = personalFirm;
    activeMembership = personalMembership;
  }

  const hasActiveOwnerMembership =
    activeMembership?.status === "ACTIVE" &&
    activeMembership.role === "OWNER" &&
    Boolean(activeFirm.ownerUserId) &&
    String(activeFirm.ownerUserId) === String(user._id);
  const hasActiveAdministrativeMembership =
    activeMembership?.status === "ACTIVE" && activeMembership.role === "ADMIN";

  // Coherent role/accountType for the active workspace (SUPER_ADMIN pinned).
  if (user.accountType !== "FIRM_USER") {
    user.accountType = "FIRM_USER";
    userChanged = true;
  }
  if (user.role !== "SUPER_ADMIN") {
    const desiredRole =
      hasActiveOwnerMembership || hasActiveAdministrativeMembership
        ? "FIRM_ADMIN"
        : "USER";
    if (user.role !== desiredRole) {
      user.role = desiredRole;
      userChanged = true;
    }
  }
  // Activation is deliberately untouched. Workspace provisioning runs on every
  // sign-in, so reactivating here let a suspended or not-yet-approved account
  // clear its own isActive flag simply by signing in again.

  if (userChanged) await user.save();
  return user;
}

export default ensurePersonalFirm;
