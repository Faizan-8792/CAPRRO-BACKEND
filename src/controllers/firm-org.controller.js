// src/controllers/firm-org.controller.js
//
// Who reports to whom inside a firm, and what the firm's records say each person has done.
//
// Both are administrator-only, decided through resolveFirmAuthority like everything else in this
// feature. There is no ladder logic here and there must not be: services/firm-authority.service.js
// is the one place that answers those questions.
//
// WHY THE ADOPTION READ IS GATED AT ALL, since it exposes no statutory data: it is a list of named
// people with a "last active" beside each one. That is the most misreadable figure in the product,
// and the firm's administrators are the people with the context to read it. TeamWorkload is gated
// the same way for the same reason.

import mongoose from "mongoose";
import Firm from "../models/Firm.js";
import User from "../models/User.js";
import Task from "../models/Task.js";
import FirmMembership from "../models/FirmMembership.js";
import { resolveFirmAuthority } from "../services/firm-authority.service.js";
import {
  buildAdoption,
  buildOrgTree,
  describeReportingRefusal,
} from "../services/firm-org.service.js";

function fail(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function handle(action) {
  return async (req, res, next) => {
    try {
      return await action(req, res);
    } catch (error) {
      if (error?.statusCode) {
        return res.status(error.statusCode).json({
          ok: false,
          error: error.message,
          requestId: req.id || "",
        });
      }
      return next(error);
    }
  };
}

/**
 * Loads the firm and the caller's authority over it.
 *
 * Duplicated in shape from firm-invite.controller.js rather than shared, deliberately: sharing it
 * would mean one of the two controllers importing the other, and the thing worth keeping identical
 * between them -- the authority decision -- already is, because both call resolveFirmAuthority.
 */
async function requireFirmAdministration(req) {
  const { firmId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(String(firmId || ""))) {
    throw fail(404, "Workspace not found");
  }

  const [firm, membership] = await Promise.all([
    Firm.findById(firmId).lean(),
    FirmMembership.findOne({ firmId, userId: req.user.id })
      .select("role status")
      .lean(),
  ]);
  if (!firm || firm.isActive === false) {
    throw fail(404, "Workspace not found");
  }

  const authority = resolveFirmAuthority({ user: req.user, firm, membership });
  if (!authority.canRead) {
    throw fail(
      403,
      authority.wasRemoved
        ? "You are no longer a member of this workspace"
        : "You are not a member of this workspace",
    );
  }
  if (!authority.canManageMembers) {
    throw fail(
      403,
      "Only a firm owner or administrator can see the team and adoption view",
    );
  }

  return { firm, authority };
}

/** The ACTIVE memberships of one firm, with the person attached. One query, not one per member. */
async function loadActiveMembers(firmId) {
  const memberships = await FirmMembership.find({ firmId, status: "ACTIVE" })
    .select("userId role reportsToUserId joinedAt")
    .lean();

  const people = memberships.length
    ? await User.find({ _id: { $in: memberships.map((row) => row.userId) } })
        .select("name email lastActiveAt")
        .lean()
    : [];
  const byId = new Map(people.map((person) => [String(person._id), person]));

  return memberships.map((row) => {
    const person = byId.get(String(row.userId));
    return {
      userId: String(row.userId),
      role: row.role || "MEMBER",
      reportsToUserId: row.reportsToUserId ? String(row.reportsToUserId) : null,
      joinedAt: row.joinedAt || null,
      // Never invented. A joined user document may be missing entirely, and the client renders the
      // absence rather than a placeholder person.
      name: person?.name || null,
      email: person?.email || null,
      lastActiveAt: person?.lastActiveAt || null,
    };
  });
}

// ---------------------------------------------------------------------------
// GET /api/firms/:firmId/org
// ---------------------------------------------------------------------------

export const getFirmOrg = handle(async (req, res) => {
  const { firm } = await requireFirmAdministration(req);
  const members = await loadActiveMembers(firm._id);

  const tree = buildOrgTree(members);
  const directory = Object.fromEntries(
    members.map((row) => [
      row.userId,
      { name: row.name, email: row.email, role: row.role },
    ]),
  );

  return res.json({
    ok: true,
    // Said out loud so the client does not have to infer it from an all-roots tree: a firm that has
    // recorded nothing looks structurally identical to a flat firm where everybody reports to the
    // owner, and those are very different claims.
    hasAnyLine: tree.hasAnyLine,
    memberCount: tree.memberCount,
    roots: tree.roots,
    // People caught in a cycle, held aside rather than nested or dropped. Should always be empty --
    // the write path refuses to create one - and is reported so a row written by anything else
    // surfaces instead of hiding.
    orphaned: tree.orphaned,
    directory,
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/firms/:firmId/members/:userId/reports-to
// ---------------------------------------------------------------------------

export const setReportsTo = handle(async (req, res) => {
  const { firm, authority } = await requireFirmAdministration(req);
  const { userId } = req.params;
  const body = req.body || {};

  if (!mongoose.Types.ObjectId.isValid(String(userId || ""))) {
    throw fail(404, "That member was not found");
  }

  // null and absent both mean "clear it". An empty string is accepted as the same, because that is
  // what a cleared picker sends.
  const raw = body.reportsToUserId;
  const manager =
    raw === null || raw === undefined || raw === "" ? null : String(raw);
  if (manager !== null && !mongoose.Types.ObjectId.isValid(manager)) {
    throw fail(400, "That manager reference could not be read");
  }

  const members = await loadActiveMembers(firm._id);

  // Every rule, including the cycle check, lives in firm-org.service.js and is answered before
  // anything is written.
  const refusal = describeReportingRefusal(members, userId, manager);
  if (refusal) {
    // 409 rather than 400 for the cycle: the request is well formed and the refusal is about the
    // state of the firm, which is what a conflict means.
    throw fail(refusal.includes("report to each other") ? 409 : 400, refusal);
  }

  // Changing the line of somebody who is an ADMIN is owner-only, matching how their designation is
  // owner-only: a reporting tree an administrator could rewrite around themselves is not a control.
  const target = members.find((row) => row.userId === String(userId));
  if (target?.role === "ADMIN" && !authority.canManageAdmins) {
    throw fail(
      403,
      "Only the firm owner can change an administrator's reporting line",
    );
  }

  const updated = await FirmMembership.findOneAndUpdate(
    { firmId: firm._id, userId, status: "ACTIVE" },
    { $set: { reportsToUserId: manager } },
    { new: true },
  );
  if (!updated) {
    throw fail(404, "That member was not found");
  }

  return res.json({
    ok: true,
    userId: String(userId),
    reportsToUserId: manager,
  });
});

// ---------------------------------------------------------------------------
// GET /api/firms/:firmId/adoption
// ---------------------------------------------------------------------------

export const getFirmAdoption = handle(async (req, res) => {
  const { firm } = await requireFirmAdministration(req);
  const members = await loadActiveMembers(firm._id);

  // Two aggregations, both scoped to this firm. `createdBy` and `assignedTo` are the only two
  // person fields Task carries, and completion is attributed to the ASSIGNEE because that is who
  // the task says did it -- there is no separate completedBy.
  const [created, completed] = await Promise.all([
    Task.aggregate([
      { $match: { firmId: firm._id, isActive: true } },
      { $group: { _id: "$createdBy", count: { $sum: 1 } } },
    ]),
    Task.aggregate([
      {
        $match: {
          firmId: firm._id,
          isActive: true,
          // FILED means a person filed it elsewhere and told CA PRO; CLOSED means done. Both are
          // finished work. Nothing here may present either as something the product did.
          status: { $in: ["FILED", "CLOSED"] },
          assignedTo: { $ne: null },
        },
      },
      { $group: { _id: "$assignedTo", count: { $sum: 1 } } },
    ]),
  ]);

  const adoption = buildAdoption(members, { created, completed });
  const directory = Object.fromEntries(
    members.map((row) => [row.userId, { name: row.name, email: row.email }]),
  );

  return res.json({
    ok: true,
    // Shipped WITH the rows, so a client cannot render the numbers without the sentence that says
    // what they are not.
    disclaimer: adoption.disclaimer,
    neverActive: adoption.neverActive,
    rows: adoption.rows,
    directory,
  });
});
