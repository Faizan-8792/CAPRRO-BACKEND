// src/services/firm-authority.service.js
//
// THE ONE PLACE that decides what a person may do inside a firm.
//
// WHY THIS EXISTS
// ---------------
// The same six lines were written twice, verbatim, in authorization.middleware.js -- once in
// requireActiveFirm and once in requireFirmWriteAccess:
//
//     const hasActiveMembership = membership?.status === "ACTIVE";
//     const isOwner = String(firm.ownerUserId || "") === String(req.user.id) && ...
//     const isFirmAdmin = hasActiveMembership && membership.role === "ADMIN";
//     const isSuperAdmin = req.user.role === "SUPER_ADMIN";
//
// and a third, subtly different, time in firm.controller.js as hasActiveOwnerAuthority /
// hasFirmAdminAuthority / effectiveMembershipRole. Three copies of an authority ladder is three
// places a new tier can be forgotten, and the brief that introduced VIEWER asked for exactly one
// named accessor rather than scattered ifs. This is it.
//
// It decides. It does not respond: every user-facing string stays in the middleware and the
// controllers that own the wording, so centralising the decision could not silently reword a
// refusal.
//
// THE LADDER
// ----------
// VIEWER < MEMBER < ADMIN < OWNER, with SUPER_ADMIN outside it as the single global bypass.
//
// A RANK, NOT A BOOLEAN, deliberately. This project has already been burned by a boolean that
// could not distinguish "chosen false" from "never chosen"; a four-tier ladder squeezed into
// isAdmin would repeat that at a wider blast radius.
//
// WHAT MUST NOT DRIFT
// -------------------
// Adding VIEWER changed no existing verdict, and that is load-bearing rather than a nicety:
//
//   * Nothing in this repository has ever written role: "ADMIN" to a FirmMembership. The only
//     values written are "OWNER" (firm creation, provisioning, and an owner rejoining) and the
//     schema default "MEMBER". Verified by grep across src/ before this file was written. So the
//     Owner-versus-Admin distinction below cannot demote a live member: no live member holds ADMIN.
//   * Nothing has ever written "VIEWER" either -- it is new here -- so recognising it takes
//     nothing away from anybody.
//   * A firm-wide memberAccess: READ_ONLY still stops a plain member writing, by mapping them onto
//     the VIEWER rung rather than by a separate branch. Same verdict, one ladder.
//
// That last point is the migration in DESIGN section 2.2 expressed as code instead of as a data
// change. memberAccess is NOT deleted and NOT ignored: an older desktop build still sends and
// reads it, and WorkspaceMemberAccess.Unknown exists precisely because an older cache may omit it
// and must fail closed for writes. It stays authoritative for anybody whose membership does not
// name a per-member tier.

/** Membership tiers, lowest authority first. The index IS the rank. */
export const FIRM_ROLE_LADDER = ["VIEWER", "MEMBER", "ADMIN", "OWNER"];

/**
 * Roles an invite may grant.
 *
 * OWNER is absent on purpose and must stay absent: a firm has exactly one owner and ownership
 * moves by deliberate transfer, never by someone redeeming a code.
 */
export const INVITABLE_FIRM_ROLES = ["ADMIN", "MEMBER", "VIEWER"];

/**
 * What an invite grants when its creator names nothing.
 *
 * The brief is explicit that a ceiling must never default to the top tier, so this is MEMBER --
 * not ADMIN, and not the highest tier the creator happens to hold.
 */
export const DEFAULT_INVITE_ROLE = "MEMBER";

/** The tier an invite acceptance lands on while an ADMIN grant waits for approval. */
export const PENDING_ELEVATION_ROLE = "MEMBER";

function rank(role) {
  const index = FIRM_ROLE_LADDER.indexOf(String(role || ""));
  return index < 0 ? null : index;
}

/** True when `role` sits at or above `floor` on the ladder. An unknown role is never at or above. */
export function roleAtLeast(role, floor) {
  const held = rank(role);
  const needed = rank(floor);
  return held !== null && needed !== null && held >= needed;
}

/** True when `role` is a value an invite may grant. Rejects OWNER, unknown values and absent ones. */
export function isInvitableRole(role) {
  return INVITABLE_FIRM_ROLES.includes(String(role || ""));
}

/**
 * True when the membership row names this person the firm's owner AND the firm agrees.
 *
 * Both halves are required. A membership row saying OWNER on a firm whose ownerUserId names
 * somebody else is stale data, not authority -- authorization.middleware.js already said so
 * ("A stale OWNER row belonging to a non-owner follows ordinary member write policy instead")
 * and that behaviour is preserved exactly.
 */
export function isConfirmedOwner(firm, membership, userId) {
  return (
    membership?.status === "ACTIVE" &&
    membership.role === "OWNER" &&
    Boolean(firm?.ownerUserId) &&
    String(firm.ownerUserId) === String(userId)
  );
}

/** The firm-wide read-only switch, expressed as a rung rather than as a separate branch. */
function demoteByFirmPolicy(firm, role) {
  return role === "MEMBER" && firm?.memberAccess === "READ_ONLY"
    ? "VIEWER"
    : role;
}

/**
 * The rung this person actually stands on, after two corrections.
 *
 * 1. A stale OWNER row (see isConfirmedOwner) drops to the ordinary-member path.
 * 2. Anyone on the MEMBER rung in a firm whose memberAccess is READ_ONLY stands on VIEWER
 *    instead. This is DESIGN section 2.2's migration applied at read time, so no data has to move
 *    and an older client that only knows memberAccess still gets the verdict it always got.
 *
 * Returns null when there is no ACTIVE membership at all -- the absence of a rung, which is not
 * the same as standing on the lowest one. Callers must not conflate the two.
 *
 * An unrecognised role string is treated as MEMBER, which is what the code this replaced did. It
 * is deliberately not tightened here: the schema enum makes the value unreachable, and quietly
 * changing an authorization verdict for a case no test can reach is how a rule stops being true
 * without anything failing.
 */
export function effectiveFirmRole(firm, membership, userId) {
  if (membership?.status !== "ACTIVE") return null;

  const declared = String(membership.role || "");
  if (declared === "OWNER") {
    return isConfirmedOwner(firm, membership, userId)
      ? "OWNER"
      : demoteByFirmPolicy(firm, "MEMBER");
  }
  if (declared === "ADMIN") return "ADMIN";
  if (declared === "VIEWER") return "VIEWER";
  return demoteByFirmPolicy(firm, "MEMBER");
}

/**
 * Everything the shell and the routes need to know about one person in one firm.
 *
 * `user` is the authenticated principal (id plus account-level role), `firm` the firm document,
 * and `membership` that person's FirmMembership row or null. Any of the three may be missing; the
 * result then denies everything, because an absent grant is not a grant.
 */
export function resolveFirmAuthority({ user, firm, membership } = {}) {
  const userId = user?.id ?? user?._id ?? null;
  const isSuperAdmin = user?.role === "SUPER_ADMIN";
  const hasActiveMembership = membership?.status === "ACTIVE";
  const isOwner = isConfirmedOwner(firm, membership, userId);
  const role = effectiveFirmRole(firm, membership, userId);

  // A personal workspace belongs to one person. Nobody else reaches it, whatever their membership
  // row says -- preserved from authorization.middleware.js, where it sits ahead of the membership
  // check for the same reason.
  const isForeignPersonalWorkspace =
    !isOwner && !isSuperAdmin && firm?.kind === "PERSONAL";

  // SUPER_ADMIN is the one global bypass and is deliberately NOT a rung: it must not be reachable
  // by promotion inside a firm, only by the platform grant that already exists.
  const bypass = isSuperAdmin && !isForeignPersonalWorkspace;
  const at = (floor) =>
    bypass || (!isForeignPersonalWorkspace && roleAtLeast(role, floor));
  const ownerOnly = bypass || (!isForeignPersonalWorkspace && isOwner);

  return {
    /** The rung, or null for no active membership. Never infer a default from null. */
    role,
    isSuperAdmin,
    isOwner,
    isAdmin: role === "ADMIN",
    hasActiveMembership,
    /** True when a removal row exists, which reads differently from never having been a member. */
    wasRemoved: Boolean(membership) && !hasActiveMembership,
    isForeignPersonalWorkspace,

    /** Any rung reads. Read-only members and legacy snapshots read; the server owns membership. */
    canRead:
      bypass || (!isForeignPersonalWorkspace && hasActiveMembership),
    canWrite: at("MEMBER"),
    canAdminister: at("ADMIN"),
    canManageMembers: at("ADMIN"),
    canManageInvites: at("ADMIN"),

    // The five owner-only powers (DESIGN section 5A, Q2). Each is owner-only because an Admin who
    // held it could either take the firm outright or open the very gate that limits Admins.
    canTransferOwnership: ownerOnly,
    /** Remove or demote someone who is themselves an ADMIN. */
    canManageAdmins: ownerOnly,
    /** Approve an acceptance that would elevate somebody to ADMIN. */
    canApproveElevation: ownerOnly,
    /** Create an invite whose ceiling is ADMIN. */
    canInviteAdmins: ownerOnly,
    /** memberAccess, sharingEnabled, and rotating the firm's join code. */
    canChangeFirmPolicy: ownerOnly,
  };
}

/**
 * The highest tier this person may set an invite's ceiling to, or null when they may create none.
 *
 * An Admin may staff the firm but may not mint another Admin; only the Owner may. So the ceiling
 * an Admin can offer stops one rung below their own -- which is the property that makes the
 * approval queue meaningful rather than decorative.
 */
export function highestInvitableRole(authority) {
  if (!authority?.canManageInvites) return null;
  return authority.canInviteAdmins ? "ADMIN" : "MEMBER";
}
