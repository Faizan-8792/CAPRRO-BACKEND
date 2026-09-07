// src/models/FirmMembership.js
//
// Collaborative firm memberships.
//
// A user can belong to more than one firm at the same time: their auto-provisioned
// personal workspace (isPersonal=true) plus any shared firms they create or join.
// `User.firmId` continues to point at the *active* workspace for backward
// compatibility; this collection is the source of truth for *which* firms a user
// may switch into and what authority they hold in each one.
//
// Firm-scoped records (tasks, clients, GST, TDS, cases, engagements, digests) are
// already scoped by the active `firmId`, so members sharing an active firm
// naturally collaborate on the same data without any per-record change.

import mongoose from "mongoose";

const FirmMembershipSchema = new mongoose.Schema(
  {
    firmId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Firm",
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    // The firm-local authority ladder. VIEWER < MEMBER < ADMIN < OWNER, decided in exactly one
    // place: services/firm-authority.service.js. Do not re-derive it from this list.
    //
    // OWNER  — created the firm; full control, cannot be removed by others. Five powers are
    //          owner-only and an ADMIN must never inherit them: transferring ownership, removing
    //          or demoting another ADMIN, approving an elevation to ADMIN, creating an
    //          ADMIN-ceiling invite, and changing firm policy (memberAccess, sharingEnabled, join
    //          code). Each would otherwise let an Admin take the firm or open the gate that
    //          limits Admins.
    // ADMIN  — elevated member: administers firm data, manages members and invites.
    // MEMBER — collaborates on shared firm data.
    // VIEWER — reads firm data and writes none. Added 2026-09-07 as the per-member replacement
    //          for the firm-wide `Firm.memberAccess` switch, which could only make a firm
    //          read-only for ALL ordinary members at once.
    //
    // `memberAccess` is NOT retired by this and must not be deleted for at least one release: a
    // desktop build that predates VIEWER still sends and reads it. Anyone on the MEMBER rung in a
    // READ_ONLY firm is resolved onto VIEWER at read time, so the old switch keeps working
    // unchanged and no data had to move. tests/firm-role-tier-contract.mjs pins that migration,
    // and measured it: 208 of 216 authority combinations were byte-identical before and after,
    // and the 8 that moved are all "a VIEWER may not write".
    role: {
      type: String,
      enum: ["OWNER", "ADMIN", "MEMBER", "VIEWER"],
      default: "MEMBER",
    },
    // ACTIVE — participates in the firm.
    // REMOVED — left or was removed; retained so history/reactivation is possible.
    status: {
      type: String,
      enum: ["ACTIVE", "REMOVED"],
      default: "ACTIVE",
      index: true,
    },
    // Marks the user's own personal workspace membership. A personal membership
    // is never removed and never left, so every user always has a home workspace.
    isPersonal: {
      type: Boolean,
      default: false,
    },
    joinedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

// One membership document per (firm, user) pair.
FirmMembershipSchema.index({ firmId: 1, userId: 1 }, { unique: true });
// Fast "list my workspaces" lookups.
FirmMembershipSchema.index({ userId: 1, status: 1 });

const FirmMembership = mongoose.model("FirmMembership", FirmMembershipSchema);

export default FirmMembership;
