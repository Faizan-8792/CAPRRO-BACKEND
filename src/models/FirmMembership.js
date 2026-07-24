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
    // OWNER  — created the firm; full control, cannot be removed by others.
    // ADMIN  — elevated member (reserved for future delegation).
    // MEMBER — collaborates on shared firm data.
    role: {
      type: String,
      enum: ["OWNER", "ADMIN", "MEMBER"],
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
