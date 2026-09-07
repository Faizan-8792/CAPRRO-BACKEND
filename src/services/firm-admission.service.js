// src/services/firm-admission.service.js
//
// Resolves ONE typed code to "which firm, and what does it grant".
//
// WHY THIS IS NOT A SECOND JOIN ROUTE
// -----------------------------------
// Redeeming an invite is the same act as joining by code, plus a role decision. joinFirmInTransaction
// already carries the hard parts of that act and they are already tested: the workspace-operation
// lease, the tokenVersion compare-and-set that makes a concurrent suspension roll the join back, the
// receipt trimming, the personal-workspace pointer, and the sharingEnabled check.
//
// A separate POST /invites/accept would have had to reimplement every one of those, and would have
// been the second-hardest piece of code in this repository written twice. So instead the code
// RESOLVER became pluggable and the transaction stayed exactly where it was. Two consequences worth
// knowing:
//
//   * An invite code works anywhere a join code works -- desktop and extension both -- with no
//     client change at all. POST /api/firms/join takes either.
//   * sharingEnabled: false blocks an invite code too, because that check lives downstream of this
//     resolver and was not touched. That is deliberate and matches what Firm.js already says:
//     "the invite/join code will not admit new members". A private firm is private.

import Firm from "../models/Firm.js";
import FirmInvite from "../models/FirmInvite.js";
import { firmInviteStatus, resolveInviteGrant } from "./firm-invite.service.js";

/** Mirrors membershipLifecycleError in firm.controller.js: a status the route can answer with. */
function admissionError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

/**
 * Why a code was refused, in a sentence the person holding it can act on.
 *
 * These are deliberately distinct. An unknown code and an expired one have completely different
 * remedies -- check what you typed, versus ask for a new one -- and collapsing them into one
 * message sends half the people who hit it to the wrong place. It leaks nothing: a 12-character
 * code is 32^12, so anybody who has one to be told about already has it.
 */
const INVITE_REFUSALS = {
  REVOKED: "This invitation has been revoked. Ask for a new one.",
  EXPIRED: "This invitation has expired. Ask for a new one.",
  EXHAUSTED:
    "This invitation has already been used the maximum number of times. Ask for a new one.",
};

/**
 * Resolves a code to `{ firm, invite, grant }`.
 *
 * `grant` is always present and always names the role to create the membership at:
 *   - a firm join code grants MEMBER, exactly as it always has;
 *   - an invite grants its ceiling, EXCEPT that an ADMIN ceiling grants MEMBER with the elevation
 *     left PENDING. resolveInviteGrant owns that rule, not this file.
 *
 * Models are injected so the resolution order and every refusal can be tested without a database.
 */
export async function resolveAdmissionCode(
  code,
  {
    session = null,
    FirmModel = Firm,
    InviteModel = FirmInvite,
    now = new Date(),
  } = {},
) {
  const normalized = typeof code === "string" ? code.trim().toUpperCase() : "";
  if (!normalized) {
    throw admissionError(400, "joinCode is required");
  }

  // THE FIRM'S OWN CODE IS TRIED FIRST, and that order is not arbitrary: it is what makes this
  // change additive. Every code that worked before this file existed still resolves by the same
  // query, to the same firm, with the same MEMBER grant, before any invite is considered.
  //
  // Persisted kind is part of join authority. Hydration defaults must not turn an ambiguous legacy
  // row into a joinable shared workspace -- preserved verbatim from joinFirmInTransaction.
  const firmQuery = FirmModel.findOne({ joinCode: normalized, kind: "SHARED" });
  if (session) firmQuery.session(session);
  const firmByJoinCode = await firmQuery;
  if (firmByJoinCode) {
    if (!firmByJoinCode.isActive) {
      throw admissionError(404, "Invalid or inactive join code");
    }
    return {
      firm: firmByJoinCode,
      invite: null,
      grant: {
        role: "MEMBER",
        requestedRole: "MEMBER",
        approvalState: "NOT_REQUIRED",
      },
    };
  }

  const inviteQuery = InviteModel.findOne({ code: normalized });
  if (session) inviteQuery.session(session);
  const invite = await inviteQuery;
  if (!invite) {
    // Same wording as before for an unknown code, so a wrong guess is answered identically
    // whether or not invites exist.
    throw admissionError(404, "Invalid or inactive join code");
  }

  const status = firmInviteStatus(invite, now);
  if (status !== "LIVE") {
    throw admissionError(403, INVITE_REFUSALS[status] || INVITE_REFUSALS.REVOKED);
  }

  const inviteFirmQuery = FirmModel.findOne({
    _id: invite.firmId,
    kind: "SHARED",
  });
  if (session) inviteFirmQuery.session(session);
  const firm = await inviteFirmQuery;
  if (!firm || !firm.isActive) {
    throw admissionError(404, "Invalid or inactive join code");
  }

  const grant = resolveInviteGrant(invite.grantsRole);
  if (!grant) {
    // An unreadable ceiling fails CLOSED. Defaulting to MEMBER here would turn a corrupted or
    // future role value into a silent grant of firm write access.
    throw admissionError(
      403,
      "This invitation could not be read. Ask for a new one.",
    );
  }

  return { firm, invite, grant };
}

export { INVITE_REFUSALS };
