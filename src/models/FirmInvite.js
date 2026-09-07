// src/models/FirmInvite.js
//
// One invitation into one firm.
//
// WHAT THIS REPLACES, AND WHY IT IS NOT A RENAME
// ----------------------------------------------
// Admission to a firm was, until this collection existed, a single field: Firm.joinCode. One code
// per firm, disclosed only to elevated members, with exactly one control -- rotate it, which cuts
// off every person who has not yet joined. There was no per-invite record, no role ceiling, no
// usage cap, no expiry, no stats and no per-invite revocation.
//
// Firm.joinCode is NOT removed and keeps working. This sits alongside it, so an owner who is used
// to handing out one code loses nothing.
//
// THE FOUR DECISIONS INSIDE THIS SHAPE
// ------------------------------------
// 1. `grantsRole` IS A CEILING AND NEVER DEFAULTS TO THE TOP. The default is MEMBER. OWNER is not
//    an accepted value at all: a firm has one owner, and ownership moves by deliberate transfer,
//    never by somebody redeeming a code. services/firm-authority.service.js owns that list.
//
// 2. `usedCount` IS NEVER DECREMENTED. If a member is later removed, the invite has still been
//    used -- the event happened. Decrementing would let a capped invite be recycled without limit,
//    which is the cap silently not existing.
//
// 3. STATUS IS DERIVED, NEVER STORED. A stored status needs a scheduled job to expire it, and a
//    missed run leaves an expired invite live -- an admission control that fails open on an
//    infrastructure hiccup. Derived from revokedAt, expiresAt and usedCount/maxUses, it cannot
//    drift, because there is nothing to drift from. See firmInviteStatus().
//
// 4. `acceptances` RECORDS THE ROLE ACTUALLY GRANTED, not the ceiling. An ADMIN-ceiling invite
//    accepted by somebody whose approval is still pending granted MEMBER, and the record has to
//    say MEMBER, or the audit trail claims an elevation that never happened.

import mongoose from "mongoose";
import crypto from "crypto";
import {
  DEFAULT_INVITE_ROLE,
  INVITABLE_FIRM_ROLES,
} from "../services/firm-authority.service.js";

/**
 * One person's redemption of one invite.
 *
 * `resultingRole` is what they actually got. `approvalState` is why:
 *   NOT_REQUIRED — the ceiling was at or below MEMBER, so the tier was granted outright.
 *   PENDING      — an ADMIN ceiling. They are working at MEMBER while the owner decides.
 *   APPROVED     — the owner granted the elevation. resultingRole was updated to match.
 *   DECLINED     — the owner refused it. They stay a MEMBER, and stay in the firm.
 */
const FirmInviteAcceptanceSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    acceptedAt: { type: Date, default: Date.now },
    /** The tier this person actually holds because of this acceptance. */
    resultingRole: {
      type: String,
      enum: INVITABLE_FIRM_ROLES,
      required: true,
    },
    approvalState: {
      type: String,
      enum: ["NOT_REQUIRED", "PENDING", "APPROVED", "DECLINED"],
      default: "NOT_REQUIRED",
    },
    /** Who decided the elevation. Null while PENDING, and null forever when NOT_REQUIRED. */
    decidedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    decidedAt: { type: Date, default: null },
  },
  { _id: false },
);

const FirmInviteSchema = new mongoose.Schema(
  {
    firmId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Firm",
      required: true,
      index: true,
    },
    // `unique: true` already builds the index, so no `index: true` beside it -- mongoose warns
    // "Duplicate schema index" and builds two identical indexes on the same field.
    code: {
      type: String,
      required: true,
      unique: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    /**
     * A human label so a firm with several live invites can tell them apart.
     *
     * Not in the original design shape, added because "live stats: how many joined via this code,
     * and who" is unusable when three codes are distinguishable only by a random string. Optional,
     * and never shown in place of the code.
     */
    label: {
      type: String,
      trim: true,
      maxlength: 80,
      default: "",
    },
    /** The CEILING. Never OWNER, and the default is deliberately not the top tier. */
    grantsRole: {
      type: String,
      enum: INVITABLE_FIRM_ROLES,
      default: DEFAULT_INVITE_ROLE,
    },
    /** null means unlimited, matching what one firm-wide joinCode always did. */
    maxUses: {
      type: Number,
      default: null,
      min: 1,
    },
    /** Monotonic. See decision 2 above: never decremented, for any reason. */
    usedCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    /** null means it never expires, matching today's joinCode behaviour. */
    expiresAt: {
      type: Date,
      default: null,
    },
    /** Set once, by a person, and never cleared. Revocation is not reversible. */
    revokedAt: {
      type: Date,
      default: null,
    },
    revokedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    acceptances: {
      type: [FirmInviteAcceptanceSchema],
      default: [],
    },
  },
  { timestamps: true },
);

// "The live invites for this firm, newest first" is the only list view there is.
FirmInviteSchema.index({ firmId: 1, createdAt: -1 });
// The owner's approval queue reads this.
FirmInviteSchema.index({ firmId: 1, "acceptances.approvalState": 1 });

/**
 * The alphabet, borrowed deliberately from Firm.generateJoinCode.
 *
 * No I, O, 0 or 1: a code gets read aloud and typed from a screenshot, and those four are the
 * pairs people transcribe wrongly.
 *
 * ITS LENGTH IS LOAD-BEARING. 32 divides 256, so `randomBytes[i] % 32` is uniform. Add or remove
 * one character and the modulo becomes biased toward the start of the alphabet, which narrows the
 * real keyspace of an admission credential. tests/firm-invite-contract.mjs asserts the length for
 * exactly that reason.
 */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * TEN characters. Not six, and -- this is the part that matters -- not twelve.
 *
 * Why longer than the firm's six: a firm join code is disclosed only to elevated members of one
 * firm and rotated when it leaks. An invite code is pasted into chat messages and lives until it
 * expires, so it is guessed at leisure. 32^6 is about 10^9, which is bulk-guessable online.
 *
 * WHY NOT LONGER. Ten is a hard ceiling imposed by clients already in production, and this was
 * written as 12 first and caught by tests/firm-join-sync-checklist.mjs item 16:
 *
 *   audit-nlp-extension/tax-worker.js:1563   /^[A-Z0-9]{4,10}$/.test(code)
 *   audit-nlp-extension/popup.js:2264        code.length < 4
 *   CaPro.Desktop.Core/Models/FirmSettings.cs:68,71   MinJoinCodeLength 4, MaxJoinCodeLength 10
 *
 * The extension is IN PRODUCTION and validates before it submits, so a 12-character code was
 * refused in the tax-worker surface without a request ever reaching the server -- an invite that
 * simply does not work, for reasons invisible from the backend. Widening the extension instead
 * would mean a Chrome Web Store release to make a backend feature usable.
 *
 * 32^10 is about 1.1 x 10^15, which is not guessable, so nothing is lost by respecting the
 * contract. tests/firm-invite-contract.mjs reads that regex and that C# constant from their own
 * files and asserts a generated code satisfies both, so this cannot drift back.
 */
const CODE_LENGTH = 10;

FirmInviteSchema.statics.generateCode = function generateCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let code = "";
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    code += CODE_ALPHABET[bytes[index] % CODE_ALPHABET.length];
  }
  return code;
};

const FirmInvite = mongoose.model("FirmInvite", FirmInviteSchema);

export default FirmInvite;
export { CODE_ALPHABET, CODE_LENGTH };
