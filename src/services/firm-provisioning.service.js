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
 * Upserts an ACTIVE membership row for (firm, user). Existing rows are
 * reactivated and, when a stronger role/isPersonal flag is supplied, upgraded —
 * membership authority is never silently downgraded here.
 */
export async function ensureFirmMembership(
  userId,
  firmId,
  { role = "MEMBER", isPersonal = false } = {}
) {
  const existing = await FirmMembership.findOne({ firmId, userId });
  if (!existing) {
    return FirmMembership.create({
      userId,
      firmId,
      role,
      status: "ACTIVE",
      isPersonal,
      joinedAt: new Date(),
    });
  }

  let changed = false;
  if (existing.status !== "ACTIVE") {
    existing.status = "ACTIVE";
    changed = true;
  }
  if (role === "OWNER" && existing.role !== "OWNER") {
    existing.role = "OWNER";
    changed = true;
  }
  if (isPersonal && !existing.isPersonal) {
    existing.isPersonal = true;
    changed = true;
  }
  if (changed) await existing.save();
  return existing;
}

async function createPersonalFirm(user) {
  const displayName = user.name ? `${user.name}'s Workspace` : "My Workspace";
  const handleBase = slugifyBase(
    user.name || String(user.email || "").split("@")[0]
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
      if (error && error.code === 11000) continue; // handle/joinCode clash — retry
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
 * Adoption rule: if the user already owns their active firm and it is not an
 * explicitly SHARED firm, that firm becomes their personal workspace. This heals
 * pre-existing accounts (and the auto-provisioned super-admin firm) without
 * creating duplicate empty workspaces.
 */
async function resolvePersonalFirm(user) {
  if (user.personalFirmId) {
    const existing = await Firm.findOne({
      _id: user.personalFirmId,
      isActive: true,
    }).select("_id kind");
    if (existing) return existing;
    // Pointer is stale — fall through and re-provision.
  }

  if (user.firmId) {
    const active = await Firm.findOne({ _id: user.firmId, isActive: true }).select(
      "_id ownerUserId kind"
    );
    if (
      active &&
      String(active.ownerUserId) === String(user._id) &&
      active.kind !== "SHARED"
    ) {
      if (active.kind !== "PERSONAL") {
        active.kind = "PERSONAL";
        await active.save();
      }
      return active;
    }
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

  // 1) Personal workspace + membership.
  const personalFirm = await resolvePersonalFirm(user);
  let userChanged = false;
  if (String(user.personalFirmId || "") !== String(personalFirm._id)) {
    user.personalFirmId = personalFirm._id;
    userChanged = true;
  }
  await ensureFirmMembership(user._id, personalFirm._id, {
    role: "OWNER",
    isPersonal: true,
  });

  // 2) Active workspace: keep the current one if it is still valid, otherwise
  //    fall back to the personal workspace. Never leave the user without one.
  let activeFirm = null;
  if (user.firmId) {
    activeFirm = await Firm.findOne({ _id: user.firmId, isActive: true }).select(
      "_id ownerUserId kind"
    );
  }
  if (!activeFirm) {
    if (String(user.firmId || "") !== String(personalFirm._id)) {
      user.firmId = personalFirm._id;
      userChanged = true;
    }
    activeFirm = personalFirm;
  }

  // 3) Membership for the active workspace (backfills pre-collaboration users).
  const isOwner = String(activeFirm.ownerUserId || user._id) === String(user._id);
  const isPersonalActive =
    String(activeFirm._id) === String(personalFirm._id);
  await ensureFirmMembership(user._id, activeFirm._id, {
    role: isOwner ? "OWNER" : "MEMBER",
    isPersonal: isPersonalActive,
  });

  // 4) Coherent role/accountType for the active workspace (SUPER_ADMIN pinned).
  if (user.accountType !== "FIRM_USER") {
    user.accountType = "FIRM_USER";
    userChanged = true;
  }
  if (user.role !== "SUPER_ADMIN") {
    const desiredRole = isOwner ? "FIRM_ADMIN" : "USER";
    if (user.role !== desiredRole) {
      user.role = desiredRole;
      userChanged = true;
    }
  }
  if (user.isActive === false) {
    user.isActive = true;
    userChanged = true;
  }

  if (userChanged) await user.save();
  return user;
}

export default ensurePersonalFirm;
