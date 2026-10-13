// src/services/firm-invite.service.js
//
// Pure decisions about invites. No database, no express, no dates read from the clock unless one
// is handed in -- so every rule below is testable, and none of them can behave differently in a
// test than in production.
//
// The authority half lives in firm-authority.service.js. This file answers three questions:
// is this invite usable, what does redeeming it grant, and what may safely be shown about it.

import {
  PENDING_ELEVATION_ROLE,
  isInvitableRole,
  roleAtLeast,
} from "./firm-authority.service.js";

/** Derived, never stored. */
export const INVITE_STATUSES = ["REVOKED", "EXPIRED", "EXHAUSTED", "LIVE"];

/**
 * The status of an invite, derived from its own fields.
 *
 * PRECEDENCE IS FIXED AND TESTED: REVOKED, then EXPIRED, then EXHAUSTED, then LIVE. An invite can
 * be more than one of the first three at once, and the answer must not depend on field order or
 * on which check happened to run first. Revocation wins because it is the one a person did on
 * purpose and therefore the one they are looking for; expiry beats exhaustion because time passing
 * is not something anybody can undo by raising the cap.
 *
 * `now` is a parameter. A caller that reads the clock itself cannot be tested at a boundary.
 */
export function firmInviteStatus(invite, now = new Date()) {
  if (!invite) return "REVOKED";
  if (invite.revokedAt) return "REVOKED";

  // Strictly past. An invite expiring at exactly this instant is spent, not live: an admission
  // window whose closing edge is inclusive stays open for one more request, and "expires at 17:00"
  // must not mean "and also at 17:00".
  if (invite.expiresAt && new Date(invite.expiresAt).getTime() <= now.getTime()) {
    return "EXPIRED";
  }

  // A null cap is unlimited. Reading null as zero would exhaust every uncapped invite instantly,
  // which is the same class of mistake as reading a provisional total as 0.00.
  const cap = invite.maxUses;
  if (cap !== null && cap !== undefined && Number(invite.usedCount || 0) >= Number(cap)) {
    return "EXHAUSTED";
  }

  return "LIVE";
}

export function isInviteRedeemable(invite, now = new Date()) {
  return firmInviteStatus(invite, now) === "LIVE";
}

/**
 * What redeeming this invite grants, and whether a person has to approve it.
 *
 * The ONE rule that matters here: an ADMIN ceiling never activates on redemption. The person joins
 * at MEMBER and an owner decides afterwards. TASK-MANAGEMENT-DESIGN.md section 1.5 calls this the
 * sharpest safety point in the design, and it is: a self-service path into an admin tier in a
 * compliance product is exactly the mistake worth proving cannot happen.
 *
 * Note what this does NOT do. It never touches User.role. A firm owner grants firm-local authority
 * only; account-level FIRM_ADMIN stays a super-admin grant through the existing requestFirmAdmin
 * path. Wiring the two together would let a firm owner mint authority reaching beyond their firm.
 */
export function resolveInviteGrant(grantsRole) {
  if (!isInvitableRole(grantsRole)) {
    return null;
  }

  // Anything at or above ADMIN is gated. Written as a ladder comparison rather than
  // `=== "ADMIN"` so that a tier inserted above ADMIN later is gated by default instead of
  // silently self-service.
  if (roleAtLeast(grantsRole, "ADMIN")) {
    return {
      role: PENDING_ELEVATION_ROLE,
      requestedRole: grantsRole,
      approvalState: "PENDING",
    };
  }

  return {
    role: grantsRole,
    requestedRole: grantsRole,
    approvalState: "NOT_REQUIRED",
  };
}

/**
 * A base for shareable links, or null when none is configured.
 *
 * NULL IS THE HONEST ANSWER AND MUST STAY REACHABLE. There is no /join page on caprotoolkit.in and
 * the desktop registers no URI scheme, so a link built on a guess would be a dead link presented
 * as a way in. When this is unset the caller shows the code alone and says to enter it in CA PRO,
 * which is true. Set FIRM_INVITE_BASE_URL once a landing page exists.
 */
export function inviteShareBaseUrl(env = process.env) {
  const configured = String(env.FIRM_INVITE_BASE_URL || "").trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    // https only. An invite code in a URL is an admission credential.
    if (url.protocol !== "https:") return null;
    return configured.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function inviteShareUrl(code, env = process.env) {
  const base = inviteShareBaseUrl(env);
  if (!base || !code) return null;
  return `${base}/join?code=${encodeURIComponent(code)}`;
}

/**
 * Everything safe to show about one invite, including its live stats.
 *
 * Stats are counted from the acceptance records that produced them rather than kept as counters,
 * so the number of people shown and the number reported can never disagree.
 *
 * `usedCount` is the exception and is read from the stored field on purpose: it counts redemptions,
 * and a redemption whose acceptance record was later trimmed still consumed a use.
 */
export function serializeFirmInvite(invite, { now = new Date(), env = process.env } = {}) {
  const status = firmInviteStatus(invite, now);
  const used = Number(invite.usedCount || 0);
  const cap =
    invite.maxUses === null || invite.maxUses === undefined
      ? null
      : Number(invite.maxUses);
  const acceptances = Array.isArray(invite.acceptances) ? invite.acceptances : [];

  return {
    id: String(invite._id || invite.id || ""),
    code: invite.code,
    // Null, not a fabricated URL. The client renders the code alone when this is absent.
    shareUrl: inviteShareUrl(invite.code, env),
    label: invite.label || "",
    grantsRole: invite.grantsRole,
    status,
    // Derived from the same fields the status is, so a caller cannot show "LIVE" beside a
    // remaining count of zero.
    maxUses: cap,
    usedCount: used,
    remainingUses: cap === null ? null : Math.max(0, cap - used),
    expiresAt: invite.expiresAt ? new Date(invite.expiresAt).toISOString() : null,
    revokedAt: invite.revokedAt ? new Date(invite.revokedAt).toISOString() : null,
    createdAt: invite.createdAt ? new Date(invite.createdAt).toISOString() : null,
    pendingApprovals: acceptances.filter(
      (item) => item.approvalState === "PENDING",
    ).length,
    acceptances: acceptances.map((item) => ({
      userId: String(item.userId || ""),
      acceptedAt: item.acceptedAt ? new Date(item.acceptedAt).toISOString() : null,
      resultingRole: item.resultingRole,
      approvalState: item.approvalState,
      decidedAt: item.decidedAt ? new Date(item.decidedAt).toISOString() : null,
    })),
  };
}

/**
 * Validates a request to create an invite, against what the caller is actually allowed to offer.
 *
 * Returns `{ error }` for a refusal or `{ value }` for an accepted, normalised request. Every
 * refusal is a plain sentence: this is the only place these are written, so the routes cannot
 * disagree about them.
 *
 * `ceiling` is the highest tier the caller may grant -- from highestInvitableRole(), never from
 * the request body.
 */
export function validateInviteRequest(body = {}, { ceiling, now = new Date() } = {}) {
  if (!ceiling) {
    return { error: "You cannot create invites for this workspace" };
  }

  const requested =
    body.grantsRole === undefined || body.grantsRole === null || body.grantsRole === ""
      ? "MEMBER"
      : String(body.grantsRole);

  if (!isInvitableRole(requested)) {
    return { error: "Choose a designation of Admin, Member or Viewer" };
  }
  // The ceiling check. An Admin creating an ADMIN invite lands here, which is what stops an Admin
  // minting another Admin one step before the approval queue would have had to.
  if (!roleAtLeast(ceiling, requested)) {
    return {
      error: "You cannot create an invite for a designation above your own",
    };
  }

  let maxUses = null;
  if (body.maxUses !== undefined && body.maxUses !== null && body.maxUses !== "") {
    maxUses = Number(body.maxUses);
    if (!Number.isInteger(maxUses) || maxUses < 1) {
      return { error: "A usage limit must be a whole number of at least 1" };
    }
  }

  let expiresAt = null;
  if (body.expiresAt !== undefined && body.expiresAt !== null && body.expiresAt !== "") {
    const parsed = new Date(body.expiresAt);
    if (Number.isNaN(parsed.getTime())) {
      return { error: "That expiry date could not be read" };
    }
    // Refused rather than accepted-and-immediately-dead, so nobody hands out a code that was
    // never going to work and has no way to find out why.
    if (parsed.getTime() <= now.getTime()) {
      return { error: "An expiry date must be in the future" };
    }
    expiresAt = parsed;
  }

  const label = String(body.label || "").trim().slice(0, 80);

  return { value: { grantsRole: requested, maxUses, expiresAt, label } };
}
