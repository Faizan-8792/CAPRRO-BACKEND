// src/services/engagement-assurance.service.js
//
// W10 AP38 (2026-10-17). Attribution, independence and the 60-day assembly of an engagement's file.
//
//   independence   a team member confirms FOR THEMSELF, dated. Nobody confirms for anybody else, and the
//                  service checks nothing about independence - it records that a person said so, when.
//   report date    set by the engagement's assigned reviewer (the partner who signs), a UTC day.
//   assembly       the reviewer records that the file was assembled. The timer runs from the report date;
//                  its deadline is that UTC day + ASSEMBLY_DAYS, so it is a day count, never a clock time.
//   after assembly any change to the file is LOGGED with a reason, and the working-paper rows added after
//                  assembly are counted from their own creation times (measured, not asked for).
//   schedules      the preparer of each working paper and the reviewer of the engagement, shown together.
//   time           append-only; a mistaken entry is voided, never deleted.
//
// Nothing here concludes anything, and nothing is automatic: every write is a person's act.

import AuditWorkingPaper from "../models/AuditWorkingPaper.js";
import AuditWorkingPaperRow from "../models/AuditWorkingPaperRow.js";
import Engagement from "../models/Engagement.js";
import EngagementAssurance, { ASSURANCE_LIMITS, MODIFICATION_KINDS } from "../models/EngagementAssurance.js";
import User from "../models/User.js";
import { httpError, mutationKey as readMutationKey, objectId } from "./case-validation.service.js";
import { isoDayFromNumber, parseIsoDay, utcDayNumber } from "./deadline-catalogue.service.js";

/** The period the plan sets for assembling the final file after the report date. Counted in UTC days. */
export const ASSEMBLY_DAYS = 60;

/** What a team member's confirmation says. It records the person's own act; it does not check anything. */
export const INDEPENDENCE_STATEMENT = "Confirmed independence of the client for this engagement.";

const MAX_TIME_PER_DAY_MINUTES = 1440;
const RECENT_TIME_ENTRIES = 100;
const MIN_REASON = 3;

// ── Pure ────────────────────────────────────────────────────────────────────────────────────────

/** The state of the assembly timer. Days only: deadline = report day + ASSEMBLY_DAYS. */
export function assemblyStatus({ reportDate, assembledAt }, now = new Date()) {
  if (!reportDate) return { state: "NOT_SET", reportDate: null, deadline: null, daysLeft: null, assembledOn: null, lateByDays: null, assemblyDays: ASSEMBLY_DAYS };
  const parsed = parseIsoDay(reportDate);
  if (!parsed) return { state: "NOT_SET", reportDate: null, deadline: null, daysLeft: null, assembledOn: null, lateByDays: null, assemblyDays: ASSEMBLY_DAYS };
  const deadlineNumber = parsed.dayNumber + ASSEMBLY_DAYS;
  const deadline = isoDayFromNumber(deadlineNumber);
  if (assembledAt) {
    const on = utcDayNumber(new Date(assembledAt));
    const late = on - deadlineNumber;
    return { state: late > 0 ? "ASSEMBLED_LATE" : "ASSEMBLED", reportDate, deadline, daysLeft: null, assembledOn: isoDayFromNumber(on), lateByDays: late > 0 ? late : 0, assemblyDays: ASSEMBLY_DAYS };
  }
  const left = deadlineNumber - utcDayNumber(now);
  return { state: left < 0 ? "OVERDUE" : "OPEN", reportDate, deadline, daysLeft: left, assembledOn: null, lateByDays: left < 0 ? -left : 0, assemblyDays: ASSEMBLY_DAYS };
}

const teamUserIds = (engagement) => [...new Set([engagement.ownerUserId, engagement.reviewerUserId, ...(engagement.teamUserIds || [])].map(String))];

function assertTeamMember(engagement, userId) {
  if (!teamUserIds(engagement).includes(String(userId))) {
    throw httpError(403, "Only people on the engagement team can do this.", "ENGAGEMENT_TEAM_REQUIRED");
  }
}

function assertReviewer(engagement, userId) {
  if (String(engagement.reviewerUserId) !== String(userId)) {
    throw httpError(403, "Only the engagement's assigned reviewer can do this.", "ENGAGEMENT_REVIEWER_REQUIRED");
  }
}

function boundedReason(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length < MIN_REASON) throw httpError(400, `${label} is required.`);
  return text.slice(0, 1000);
}

// ── Loading ─────────────────────────────────────────────────────────────────────────────────────

async function loadEngagement(engagementId, firmId) {
  const engagement = await Engagement.findOne({ _id: objectId(engagementId, "engagementId"), firmId })
    .select("clientId ownerUserId reviewerUserId teamUserIds status title period")
    .lean();
  if (!engagement) throw httpError(404, "Engagement not found", "ENGAGEMENT_NOT_FOUND");
  return engagement;
}

function assertWritable(engagement) {
  if (engagement.status === "ARCHIVED") {
    throw httpError(409, "Archived engagements are read-only", "ENGAGEMENT_COMPLETE_READ_ONLY");
  }
}

async function ensureRecord(engagement, firmId, engagementId) {
  try {
    await EngagementAssurance.updateOne(
      { firmId, engagementId: engagement._id },
      { $setOnInsert: { firmId, engagementId: engagement._id, clientId: engagement.clientId, revision: 1 } },
      { upsert: true },
    );
  } catch (error) {
    // Two first requests at once: the unique key lets one create the record and the other read it.
    if (error?.code !== 11000) throw error;
  }
  return EngagementAssurance.findOne({ firmId, engagementId: engagement._id }).lean();
}

const nameOf = (users, id) => {
  const u = users.get(String(id));
  return u ? { userId: String(id), name: u.name || u.email || "A team member" } : { userId: String(id), name: "A team member" };
};

/** The whole picture, read fresh. */
export async function describeAssurance({ engagement, firmId, now = new Date() }) {
  const record = (await EngagementAssurance.findOne({ firmId, engagementId: engagement._id }).lean()) || {
    independence: [], modifications: [], timeEntries: [], reportDate: null, assembledAt: null, revision: 0,
  };
  const papers = await AuditWorkingPaper.find({ firmId, engagementId: engagement._id }).select("title createdBy").limit(500).lean();
  const paperIds = papers.map((p) => p._id);
  const rowCounts = paperIds.length
    ? await AuditWorkingPaperRow.aggregate([{ $match: { firmId, workingPaperId: { $in: paperIds } } }, { $group: { _id: "$workingPaperId", rows: { $sum: 1 } } }])
    : [];
  const rowCountById = new Map(rowCounts.map((r) => [String(r._id), r.rows]));

  const ids = new Set(teamUserIds(engagement));
  for (const e of record.independence) ids.add(String(e.userId));
  for (const e of record.modifications) ids.add(String(e.byUserId));
  for (const e of record.timeEntries) ids.add(String(e.userId));
  for (const p of papers) ids.add(String(p.createdBy));
  if (record.reportDateSetByUserId) ids.add(String(record.reportDateSetByUserId));
  if (record.assembledByUserId) ids.add(String(record.assembledByUserId));
  const users = new Map((await User.find({ _id: { $in: [...ids] } }).select("name email").lean()).map((u) => [String(u._id), u]));

  const latestIndependence = new Map();
  for (const e of record.independence) {
    const key = String(e.userId);
    const held = latestIndependence.get(key);
    if (!held || new Date(e.confirmedAt) > new Date(held.confirmedAt)) latestIndependence.set(key, e);
  }
  // The engagement's team list also holds its owner and reviewer, so "member" is only for people who are
  // neither: a person is listed by what they are for this engagement, once each.
  const roleOf = (id) => {
    const roles = [
      ...(String(engagement.ownerUserId) === id ? ["OWNER"] : []),
      ...(String(engagement.reviewerUserId) === id ? ["REVIEWER"] : []),
    ];
    return roles.length ? roles : ["MEMBER"];
  };
  const team = teamUserIds(engagement).map((id) => {
    const held = latestIndependence.get(id);
    return {
      ...nameOf(users, id),
      roles: roleOf(id),
      independence: held ? { confirmedAt: held.confirmedAt, statement: held.statement, note: held.note || "" } : null,
    };
  });

  const status = assemblyStatus(record, now);
  const rowsAddedAfterAssembly = record.assembledAt && paperIds.length
    ? await AuditWorkingPaperRow.countDocuments({ firmId, workingPaperId: { $in: paperIds }, createdAt: { $gt: new Date(record.assembledAt) } })
    : record.assembledAt ? 0 : null;

  const live = record.timeEntries.filter((t) => !t.voidedAt);
  const byUser = new Map();
  for (const t of live) byUser.set(String(t.userId), (byUser.get(String(t.userId)) || 0) + t.minutes);

  return {
    engagementId: String(engagement._id),
    revision: record.revision,
    assemblyDays: ASSEMBLY_DAYS,
    statement: INDEPENDENCE_STATEMENT,
    team,
    independence: { confirmed: team.filter((m) => m.independence).length, pending: team.filter((m) => !m.independence).length },
    report: {
      ...status,
      setAt: record.reportDateSetAt || null,
      setBy: record.reportDateSetByUserId ? nameOf(users, record.reportDateSetByUserId) : null,
      assembledAt: record.assembledAt || null,
      assembledBy: record.assembledByUserId ? nameOf(users, record.assembledByUserId) : null,
    },
    modifications: record.modifications.map((m) => ({ id: String(m._id), at: m.at, by: nameOf(users, m.byUserId), kind: m.kind, reason: m.reason })).reverse(),
    rowsAddedAfterAssembly,
    schedules: papers.map((p) => ({
      workingPaperId: String(p._id),
      title: p.title,
      preparedBy: nameOf(users, p.createdBy),
      reviewer: nameOf(users, engagement.reviewerUserId),
      rows: rowCountById.get(String(p._id)) || 0,
    })),
    time: {
      totalMinutes: live.reduce((sum, t) => sum + t.minutes, 0),
      byUser: [...byUser.entries()].map(([id, minutes]) => ({ ...nameOf(users, id), minutes })).sort((a, b) => b.minutes - a.minutes),
      recent: record.timeEntries.slice(-RECENT_TIME_ENTRIES).reverse().map((t) => ({
        id: String(t._id), by: nameOf(users, t.userId), workDay: t.workDay, minutes: t.minutes, note: t.note || "", enteredAt: t.enteredAt, voided: Boolean(t.voidedAt),
      })),
    },
  };
}

// ── Writes ──────────────────────────────────────────────────────────────────────────────────────

/** The loading and permission steps the memo service shares with this one. */
export const assuranceKit = Object.freeze({ loadEngagement, ensureRecord, assertTeamMember, assertReviewer, assertWritable });

export async function showAssurance({ engagementId, firmId }) {
  const engagement = await loadEngagement(engagementId, firmId);
  return describeAssurance({ engagement, firmId });
}

/** A team member confirms independence FOR THEMSELF. Dated now; a repeat is a new, later confirmation. */
export async function confirmIndependence({ engagementId, firmId, actorUserId, input = {} }) {
  const engagement = await loadEngagement(engagementId, firmId);
  assertWritable(engagement);
  assertTeamMember(engagement, actorUserId);
  const key = readMutationKey(input.mutationKey);
  if (input.confirmed !== true) throw httpError(400, "Confirm by sending confirmed: true; nothing is recorded otherwise.");
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 500) : "";
  await ensureRecord(engagement, firmId, engagementId);

  const last = ASSURANCE_LIMITS.independence - 1;
  const updated = await EngagementAssurance.findOneAndUpdate(
    { firmId, engagementId: engagement._id, "independence.mutationKey": { $ne: key }, [`independence.${last}`]: { $exists: false } },
    { $push: { independence: { userId: actorUserId, confirmedAt: new Date(), statement: INDEPENDENCE_STATEMENT, note, mutationKey: key } }, $inc: { revision: 1 } },
    { new: true },
  ).lean();
  if (!updated) {
    const held = await EngagementAssurance.findOne({ firmId, engagementId: engagement._id, "independence.mutationKey": key }).select("_id").lean();
    if (!held) throw httpError(409, "The list of independence confirmations is full.", "ASSURANCE_LIMIT");
  }
  return describeAssurance({ engagement, firmId });
}

/** The assigned reviewer sets the report date (a UTC day). Not changeable once the file is assembled. */
export async function setReportDate({ engagementId, firmId, actorUserId, input = {} }) {
  const engagement = await loadEngagement(engagementId, firmId);
  assertWritable(engagement);
  assertReviewer(engagement, actorUserId);
  readMutationKey(input.mutationKey);
  const parsed = parseIsoDay(input.reportDate);
  if (!parsed || parsed.year < 2000 || parsed.year > 2100) throw httpError(400, "The report date must be a real day written YYYY-MM-DD.");
  await ensureRecord(engagement, firmId, engagementId);

  const updated = await EngagementAssurance.findOneAndUpdate(
    { firmId, engagementId: engagement._id, assembledAt: null },
    { $set: { reportDate: input.reportDate, reportDateSetByUserId: actorUserId, reportDateSetAt: new Date() }, $inc: { revision: 1 } },
    { new: true },
  ).lean();
  if (!updated) {
    throw httpError(409, "The file is already assembled, so its report date can no longer be changed. Log the change instead.", "ASSURANCE_ASSEMBLED");
  }
  return describeAssurance({ engagement, firmId });
}

/** The assigned reviewer records that the final file was assembled. Needs a report date. Recorded, never inferred. */
export async function assembleFile({ engagementId, firmId, actorUserId, input = {} }) {
  const engagement = await loadEngagement(engagementId, firmId);
  assertWritable(engagement);
  assertReviewer(engagement, actorUserId);
  const key = readMutationKey(input.mutationKey);
  const record = await ensureRecord(engagement, firmId, engagementId);
  if (record.assembledAt) {
    if (record.assembleMutationKey === key) return describeAssurance({ engagement, firmId });
    throw httpError(409, "The file was already recorded as assembled.", "ASSURANCE_ALREADY_ASSEMBLED");
  }
  if (!record.reportDate) throw httpError(409, "Set the report date first: the assembly period runs from it.", "ASSURANCE_REPORT_DATE_REQUIRED");

  const updated = await EngagementAssurance.findOneAndUpdate(
    { firmId, engagementId: engagement._id, assembledAt: null, reportDate: { $ne: null } },
    { $set: { assembledAt: new Date(), assembledByUserId: actorUserId, assembleMutationKey: key }, $inc: { revision: 1 } },
    { new: true },
  ).lean();
  if (!updated) throw httpError(409, "The file was recorded as assembled by someone else just now.", "ASSURANCE_ALREADY_ASSEMBLED");
  return describeAssurance({ engagement, firmId });
}

/** After assembly, a change to the file is logged with its reason. Before assembly there is nothing to log. */
export async function logModification({ engagementId, firmId, actorUserId, input = {} }) {
  const engagement = await loadEngagement(engagementId, firmId);
  assertWritable(engagement);
  assertTeamMember(engagement, actorUserId);
  const key = readMutationKey(input.mutationKey);
  const kind = typeof input.kind === "string" ? input.kind : "";
  if (!MODIFICATION_KINDS.includes(kind)) throw httpError(400, `The kind must be one of ${MODIFICATION_KINDS.join(", ")}.`);
  const reason = boundedReason(input.reason, "A reason");
  const record = await ensureRecord(engagement, firmId, engagementId);
  if (!record.assembledAt) throw httpError(409, "The file has not been recorded as assembled, so there is nothing to log yet.", "ASSURANCE_NOT_ASSEMBLED");

  const last = ASSURANCE_LIMITS.modifications - 1;
  const updated = await EngagementAssurance.findOneAndUpdate(
    { firmId, engagementId: engagement._id, assembledAt: { $ne: null }, "modifications.mutationKey": { $ne: key }, [`modifications.${last}`]: { $exists: false } },
    { $push: { modifications: { at: new Date(), byUserId: actorUserId, kind, reason, mutationKey: key } }, $inc: { revision: 1 } },
    { new: true },
  ).lean();
  if (!updated) {
    const held = await EngagementAssurance.findOne({ firmId, engagementId: engagement._id, "modifications.mutationKey": key }).select("_id").lean();
    if (!held) throw httpError(409, "The modification log is full.", "ASSURANCE_LIMIT");
  }
  return describeAssurance({ engagement, firmId });
}

/** A team member records time worked on a UTC day, for themself. Append-only. */
export async function addTimeEntry({ engagementId, firmId, actorUserId, input = {} }) {
  const engagement = await loadEngagement(engagementId, firmId);
  assertWritable(engagement);
  assertTeamMember(engagement, actorUserId);
  const key = readMutationKey(input.mutationKey);
  const day = parseIsoDay(input.workDay);
  if (!day) throw httpError(400, "The work day must be a real day written YYYY-MM-DD.");
  if (day.dayNumber > utcDayNumber(new Date())) throw httpError(400, "Time cannot be recorded for a day that has not happened yet.");
  const minutes = input.minutes;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_TIME_PER_DAY_MINUTES) {
    throw httpError(400, `Minutes must be a whole number from 1 to ${MAX_TIME_PER_DAY_MINUTES}.`);
  }
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 300) : "";
  const record = await ensureRecord(engagement, firmId, engagementId);
  if (record.timeEntries.some((t) => t.mutationKey === key)) return describeAssurance({ engagement, firmId });
  if (record.timeEntries.length >= ASSURANCE_LIMITS.timeEntries) throw httpError(409, "The time record is full.", "ASSURANCE_LIMIT");

  const sameDay = record.timeEntries
    .filter((t) => String(t.userId) === String(actorUserId) && t.workDay === input.workDay && !t.voidedAt)
    .reduce((sum, t) => sum + t.minutes, 0);
  if (sameDay + minutes > MAX_TIME_PER_DAY_MINUTES) {
    throw httpError(409, "That would be more than 24 hours recorded for one person on one day.", "ASSURANCE_DAY_OVERFLOW");
  }

  const updated = await EngagementAssurance.findOneAndUpdate(
    { firmId, engagementId: engagement._id, revision: record.revision },
    { $push: { timeEntries: { userId: actorUserId, workDay: input.workDay, minutes, note, enteredAt: new Date(), mutationKey: key } }, $inc: { revision: 1 } },
    { new: true },
  ).lean();
  if (!updated) {
    const winner = await EngagementAssurance.findOne({ firmId, engagementId: engagement._id, "timeEntries.mutationKey": key }).select("_id").lean();
    if (!winner) throw httpError(409, "The record changed while you were saving; open it again and retry.", "ENGAGEMENT_REVISION_CONFLICT");
  }
  return describeAssurance({ engagement, firmId });
}

/** Void a time entry (own entry, or any by the reviewer). It stays in the record, marked. */
export async function voidTimeEntry({ engagementId, firmId, actorUserId, entryId, input = {} }) {
  const engagement = await loadEngagement(engagementId, firmId);
  assertWritable(engagement);
  assertTeamMember(engagement, actorUserId);
  readMutationKey(input.mutationKey);
  const id = objectId(entryId, "entryId");
  const record = await ensureRecord(engagement, firmId, engagementId);
  const entry = record.timeEntries.find((t) => String(t._id) === String(id));
  if (!entry) throw httpError(404, "That time entry is not on this engagement.");
  if (entry.voidedAt) return describeAssurance({ engagement, firmId });
  if (String(entry.userId) !== String(actorUserId) && String(engagement.reviewerUserId) !== String(actorUserId)) {
    throw httpError(403, "Only the person who recorded the time, or the assigned reviewer, can void it.", "ENGAGEMENT_REVIEWER_REQUIRED");
  }
  await EngagementAssurance.updateOne(
    { firmId, engagementId: engagement._id, "timeEntries._id": id, "timeEntries.voidedAt": null },
    { $set: { "timeEntries.$[e].voidedAt": new Date(), "timeEntries.$[e].voidedByUserId": actorUserId }, $inc: { revision: 1 } },
    { arrayFilters: [{ "e._id": id, "e.voidedAt": null }] },
  );
  return describeAssurance({ engagement, firmId });
}
