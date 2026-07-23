// src/services/firm-provisioning.service.js
//
// Auto-provisions a personal workspace (Firm) for a user so every account can
// use the product immediately, without being forced to create or join a firm.
// This is the "personal workspace" pattern: each user owns an active firm and
// is its admin, so firm-scoped features work out of the box. Users may still
// join a shared firm by code later — that is optional, never a gate.

import crypto from "crypto";
import Firm from "../models/Firm.js";

function slugifyBase(input) {
  const base = String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return base || "workspace";
}

/**
 * Ensures the given Mongoose user document owns an active firm.
 * - If the user already has an active firm, the user is returned unchanged
 *   (only re-activating the account if it was inactive).
 * - Otherwise a personal firm is created and the user is linked to it as an
 *   active admin (SUPER_ADMIN role is preserved).
 *
 * Idempotent and safe to call on every login and on /me. Handle/joinCode
 * collisions are retried.
 *
 * @param {import("mongoose").Document} user - a full (non-lean) User document
 * @returns {Promise<import("mongoose").Document>} the same user document
 */
export async function ensurePersonalFirm(user) {
  if (!user) return user;

  if (user.firmId) {
    const existing = await Firm.findOne({ _id: user.firmId, isActive: true })
      .select("_id")
      .lean();
    if (existing) {
      if (user.isActive === false) {
        user.isActive = true;
        await user.save();
      }
      return user;
    }
    // firmId points to a missing/inactive firm — provision a fresh personal one.
  }

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
      });
    } catch (error) {
      lastError = error;
      // Duplicate handle or joinCode — retry with fresh random values.
      if (error && error.code === 11000) continue;
      throw error;
    }
  }

  if (!firm) {
    throw lastError || new Error("Could not provision personal workspace");
  }

  user.firmId = firm._id;
  user.accountType = "FIRM_USER";
  if (user.role !== "SUPER_ADMIN") {
    user.role = "FIRM_ADMIN";
  }
  user.isActive = true;
  await user.save();

  return user;
}

export default ensurePersonalFirm;
