import mongoose from "mongoose";
import Client from "../models/Client.js";
import Reminder from "../models/Reminder.js";
import Task from "../models/Task.js";
import TaxWorkSession from "../models/TaxWorkSession.js";
import User from "../models/User.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const OPEN_TASK_STATUSES = ["NOT_STARTED", "WAITING_DOCS", "IN_PROGRESS"];
const OPEN_SESSION_STATUSES = ["DRAFT", "IN_PROGRESS"];
const COMPLETE_TASK_STATUSES = ["FILED", "CLOSED"];
const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CANONICAL_UTC_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const AUTHORITY_RESOLUTION_LIMIT = 5000;

export const HOME_SECTION_LIMIT = 25;
export const HOME_SOURCE_FETCH_LIMIT = HOME_SECTION_LIMIT * 3 + 1;
export const CALENDAR_DEFAULT_LIMIT = 250;
export const CALENDAR_MAX_LIMIT = 500;
export const CALENDAR_MAX_RANGE_DAYS = 93;

export class WorkspaceQueryError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "WorkspaceQueryError";
    this.status = status;
  }
}

function objectId(value, label) {
  if (value instanceof mongoose.Types.ObjectId) return value;
  const normalized = String(value || "").trim();
  if (!OBJECT_ID_PATTERN.test(normalized)) {
    throw new WorkspaceQueryError(`${label} must be a valid ObjectId`);
  }
  return new mongoose.Types.ObjectId(normalized);
}

function optionalQueryObjectId(value, label) {
  if (value === undefined || value === null || value === "") return null;
  if (Array.isArray(value)) {
    throw new WorkspaceQueryError(`${label} must be a single ObjectId`);
  }
  return objectId(value, label);
}

function idString(value) {
  if (value === undefined || value === null) return null;
  const raw = typeof value === "object" && value._id ? value._id : value;
  return String(raw);
}

function sameId(left, right) {
  const leftId = idString(left);
  const rightId = idString(right);
  return Boolean(leftId && rightId && leftId === rightId);
}

function utcDayStart(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new WorkspaceQueryError("Invalid UTC clock value");
  }
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
}

function addUtcDays(value, days) {
  return new Date(value.getTime() + days * DAY_MS);
}

function formatUtcDay(value) {
  return value.toISOString().slice(0, 10);
}

function parseUtcDay(value, label) {
  if (Array.isArray(value) || typeof value !== "string") {
    throw new WorkspaceQueryError(`${label} must use YYYY-MM-DD`);
  }
  const normalized = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
  if (!match) {
    throw new WorkspaceQueryError(`${label} must use YYYY-MM-DD`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new WorkspaceQueryError(`${label} must be a valid UTC date`);
  }
  return parsed;
}

function parseCalendarLimit(value) {
  if (value === undefined || value === null || value === "") {
    return CALENDAR_DEFAULT_LIMIT;
  }
  if (Array.isArray(value) || !/^\d+$/.test(String(value))) {
    throw new WorkspaceQueryError("limit must be a whole number");
  }
  const limit = Number(value);
  if (limit < 1 || limit > CALENDAR_MAX_LIMIT) {
    throw new WorkspaceQueryError(
      `limit must be between 1 and ${CALENDAR_MAX_LIMIT}`
    );
  }
  return limit;
}

export function parseCalendarQuery(query = {}) {
  if (!query.from || !query.to) {
    throw new WorkspaceQueryError(
      "from and to are required and must use YYYY-MM-DD"
    );
  }

  const start = parseUtcDay(query.from, "from");
  const inclusiveEnd = parseUtcDay(query.to, "to");
  if (inclusiveEnd < start) {
    throw new WorkspaceQueryError("to must be on or after from");
  }

  const rangeDays = Math.round((inclusiveEnd - start) / DAY_MS) + 1;
  if (rangeDays > CALENDAR_MAX_RANGE_DAYS) {
    throw new WorkspaceQueryError(
      `Calendar range cannot exceed ${CALENDAR_MAX_RANGE_DAYS} UTC days`
    );
  }

  let recordType = null;
  if (
    query.recordType !== undefined &&
    query.recordType !== null &&
    query.recordType !== ""
  ) {
    if (Array.isArray(query.recordType) || typeof query.recordType !== "string") {
      throw new WorkspaceQueryError("recordType must be a single value");
    }
    const normalizedRecordType = query.recordType.trim().toUpperCase();
    const allowedRecordTypes = [
      "ALL",
      "TASK",
      "TAX_WORK_SESSION",
      "REMINDER",
    ];
    if (!allowedRecordTypes.includes(normalizedRecordType)) {
      throw new WorkspaceQueryError(
        `recordType must be one of ${allowedRecordTypes.join(", ")}`
      );
    }
    recordType = normalizedRecordType === "ALL" ? null : normalizedRecordType;
  }

  return {
    from: formatUtcDay(start),
    to: formatUtcDay(inclusiveEnd),
    start,
    endExclusive: addUtcDays(inclusiveEnd, 1),
    rangeDays,
    limit: parseCalendarLimit(query.limit),
    recordType,
    clientId: optionalQueryObjectId(query.clientId, "clientId"),
    assigneeId: optionalQueryObjectId(query.assigneeId, "assigneeId"),
  };
}

export function buildWorkspaceScopes({
  firmId,
  userId,
  role,
  assigneeId = null,
}) {
  const firmObjectId = objectId(firmId, "firmId");
  const userObjectId = objectId(userId, "userId");
  const assigneeObjectId = assigneeId
    ? objectId(assigneeId, "assigneeId")
    : null;
  const firmWide = role === "FIRM_ADMIN";

  if (
    !firmWide &&
    assigneeObjectId &&
    !sameId(assigneeObjectId, userObjectId)
  ) {
    throw new WorkspaceQueryError(
      "Firm members cannot view another assignee's workspace",
      403
    );
  }

  const task = { firmId: firmObjectId, isActive: true };
  const session = { firmId: firmObjectId };
  const reminder = { firmId: firmObjectId, isActive: true };

  if (assigneeObjectId) {
    task.assignedTo = assigneeObjectId;
    session.assignedTo = assigneeObjectId;
    reminder.userId = assigneeObjectId;
  } else if (!firmWide) {
    task.$or = [
      { assignedTo: userObjectId },
      { createdBy: userObjectId },
    ];
    session.$or = [
      { assignedTo: userObjectId },
      { ownerUserId: userObjectId },
    ];
    reminder.userId = userObjectId;
  }

  return {
    firmId: firmObjectId,
    userId: userObjectId,
    scope: firmWide ? "FIRM" : "PERSONAL",
    task,
    session,
    reminder,
  };
}

function combineFilters(...filters) {
  const active = filters.filter(
    (filter) => filter && Object.keys(filter).length > 0
  );
  if (active.length === 0) return {};
  if (active.length === 1) return active[0];
  return { $and: active };
}

function applyFeatureArtifactScopes(scopes, noticeCasesEnabled) {
  if (noticeCasesEnabled === true) return scopes;
  const excludeCaseArtifacts = { source: { $ne: "CASE" } };
  return {
    ...scopes,
    task: combineFilters(scopes.task, excludeCaseArtifacts),
    reminder: combineFilters(scopes.reminder, excludeCaseArtifacts),
  };
}

function stringDateRange(field, start, endExclusive) {
  return {
    $or: [
      {
        [field]: {
          $gte: start.toISOString(),
          $lt: endExclusive.toISOString(),
          $regex: CANONICAL_UTC_PATTERN,
        },
      },
      {
        [field]: {
          $gte: formatUtcDay(start),
          $lt: formatUtcDay(endExclusive),
          $regex: DATE_ONLY_PATTERN,
        },
      },
    ],
  };
}

function stringDateBefore(field, endExclusive) {
  return {
    $or: [
      {
        [field]: {
          $lt: endExclusive.toISOString(),
          $regex: CANONICAL_UTC_PATTERN,
        },
      },
      {
        [field]: {
          $lt: formatUtcDay(endExclusive),
          $regex: DATE_ONLY_PATTERN,
        },
      },
    ],
  };
}

function isoOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string") {
    const normalized = value.trim();
    if (DATE_ONLY_PATTERN.test(normalized)) {
      try {
        return parseUtcDay(normalized, "stored date").toISOString();
      } catch {
        return null;
      }
    }
    if (!CANONICAL_UTC_PATTERN.test(normalized)) return null;
  }
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function humanizeCode(value) {
  return String(value || "")
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function lookupRecord(map, value) {
  const id = idString(value);
  return id ? map.get(id) || null : null;
}

function clientView(doc, lookups, fallbackName = null) {
  const id = idString(doc.clientId);
  const client = lookupRecord(lookups.clients, doc.clientId);
  const name = client?.name || fallbackName || null;
  return id || name ? { id, name } : null;
}

function userView(value, lookups) {
  const id = idString(value);
  if (!id) return null;
  const user = lookupRecord(lookups.users, value);
  return { id, name: user?.name || null };
}

function provenanceView(doc) {
  return {
    source: doc.source || "MANUAL",
    complianceRuleId: idString(doc.complianceRuleId),
    complianceRuleVersion: doc.complianceRuleVersion || null,
    complianceCode: doc.complianceCode || null,
    period: doc.period || null,
    ruleSourceReference: doc.ruleSourceReference || null,
    automationJobId: idString(doc.automationJobId),
  };
}

function requiredDocumentReadiness(doc) {
  const requiredDocuments = Array.isArray(doc?.documents)
    ? doc.documents.filter((document) => document?.required)
    : [];
  const receivedDocuments = requiredDocuments.filter(
    (document) => document.received
  );
  return {
    required: requiredDocuments.length,
    received: receivedDocuments.length,
    missing: requiredDocuments.length - receivedDocuments.length,
  };
}

function baseWorkspaceItem(recordType, doc, lookups) {
  const recordId = idString(doc._id);
  const moduleByType = {
    TASK: "TASKS",
    TAX_WORK_SESSION: "TAX_WORK",
    REMINDER: "REMINDERS",
  };

  return {
    id: `${recordType}:${recordId}`,
    recordType,
    recordId,
    primarySource: { recordType, recordId },
    sourceRecords: {
      taskId: recordType === "TASK" ? recordId : idString(doc.taskId),
      taxWorkSessionId:
        recordType === "TAX_WORK_SESSION"
          ? recordId
          : idString(doc.taxWorkSessionId),
      reminderId:
        recordType === "REMINDER" ? recordId : idString(doc.reminderId),
      clientId: idString(doc.clientId),
    },
    openTarget: { module: moduleByType[recordType], recordId },
    dueDateISO: null,
    completedAtISO: null,
    updatedAtISO: isoOrNull(doc.updatedAt),
    title: "",
    status: null,
    client: null,
    assignee: null,
    provenance: provenanceView(doc),
    documentReadiness: null,
    integrity: { status: "NOT_LINKED", unresolvedLinks: [] },
  };
}

function normalizeTask(doc, lookups) {
  const item = baseWorkspaceItem("TASK", doc, lookups);
  item.dueDateISO = isoOrNull(doc.dueDateISO);
  item.completedAtISO = isoOrNull(doc.completedAt);
  item.title = doc.title || "Untitled task";
  item.status = doc.status || "NOT_STARTED";
  item.client = clientView(doc, lookups, doc.clientName || null);
  item.assignee = userView(doc.assignedTo, lookups);
  item.serviceType = doc.serviceType || "OTHER";
  return item;
}

function normalizeSession(doc, lookups) {
  const item = baseWorkspaceItem("TAX_WORK_SESSION", doc, lookups);
  item.dueDateISO = isoOrNull(doc.dueDate);
  item.completedAtISO = isoOrNull(doc.completedAt);
  item.title = [humanizeCode(doc.taxType) || "Tax work", doc.period]
    .filter(Boolean)
    .join(" — ");
  item.status = doc.status || "DRAFT";
  item.client = clientView(doc, lookups);
  item.assignee = userView(doc.assignedTo, lookups);
  item.serviceType = doc.taxType || "OTHER";
  item.documentReadiness = requiredDocumentReadiness(doc);
  return item;
}

function normalizeReminder(doc, lookups) {
  const item = baseWorkspaceItem("REMINDER", doc, lookups);
  item.dueDateISO = isoOrNull(doc.dueDateISO);
  item.title = humanizeCode(doc.typeId) || "Reminder";
  item.status = doc.isActive === false ? "INACTIVE" : "ACTIVE";
  item.client = clientView(doc, lookups, doc.clientLabel || null);
  item.assignee = userView(doc.userId, lookups);
  item.serviceType = doc.typeId || "GENERIC";
  return item;
}

function mapDocuments(documents) {
  return new Map(
    documents
      .filter((document) => idString(document?._id))
      .map((document) => [idString(document._id), document])
  );
}

function setFirst(map, key, value) {
  if (key && !map.has(key)) map.set(key, value);
}

function buildAuthorityIndex(context) {
  const tasks = context?.tasks || [];
  const sessions = context?.sessions || [];
  const reminders = context?.reminders || [];
  const index = {
    tasks: mapDocuments(tasks),
    sessions: mapDocuments(sessions),
    reminders: mapDocuments(reminders),
    taskBySession: new Map(),
    taskByReminder: new Map(),
    sessionByTask: new Map(),
    sessionByReminder: new Map(),
    reminderByTask: new Map(),
    reminderBySession: new Map(),
  };

  for (const task of tasks) {
    setFirst(index.taskBySession, idString(task.taxWorkSessionId), task);
    setFirst(index.taskByReminder, idString(task.reminderId), task);
  }
  for (const session of sessions) {
    setFirst(index.sessionByTask, idString(session.taskId), session);
    setFirst(index.sessionByReminder, idString(session.reminderId), session);
  }
  for (const reminder of reminders) {
    setFirst(index.reminderByTask, idString(reminder.taskId), reminder);
    setFirst(
      index.reminderBySession,
      idString(reminder.taxWorkSessionId),
      reminder
    );
  }
  return index;
}

function taskForSession(session, index) {
  return (
    index.tasks.get(idString(session.taskId)) ||
    index.taskBySession.get(idString(session._id)) ||
    null
  );
}

function taskForReminder(reminder, index) {
  return (
    index.tasks.get(idString(reminder.taskId)) ||
    index.taskByReminder.get(idString(reminder._id)) ||
    null
  );
}

function sessionForReminder(reminder, index) {
  return (
    index.sessions.get(idString(reminder.taxWorkSessionId)) ||
    index.sessionByReminder.get(idString(reminder._id)) ||
    null
  );
}

function sessionForTask(task, index) {
  return (
    index.sessions.get(idString(task.taxWorkSessionId)) ||
    index.sessionByTask.get(idString(task._id)) ||
    null
  );
}

function reminderForSession(session, index) {
  return (
    index.reminders.get(idString(session.reminderId)) ||
    index.reminderBySession.get(idString(session._id)) ||
    null
  );
}

function reminderForTask(task, index, session = null) {
  return (
    index.reminders.get(idString(task.reminderId)) ||
    index.reminderByTask.get(idString(task._id)) ||
    (session ? reminderForSession(session, index) : null)
  );
}

function linkedIntegrity(directLinks, resolvedLinks) {
  const unresolvedLinks = [];
  for (const [kind, value] of Object.entries(directLinks)) {
    const id = idString(value);
    if (id && !resolvedLinks[kind]) unresolvedLinks.push(`${kind}:${id}`);
  }
  const resolvedCount = Object.values(resolvedLinks).filter(Boolean).length;
  return {
    status: unresolvedLinks.length
      ? "UNRESOLVED_LINKS"
      : resolvedCount
        ? "LINKS_RESOLVED"
        : "NOT_LINKED",
    unresolvedLinks,
  };
}

function enrichTaskItem(item, task, index) {
  const session = sessionForTask(task, index);
  const reminder = reminderForTask(task, index, session);
  if (session) {
    item.sourceRecords.taxWorkSessionId = idString(session._id);
    item.documentReadiness = requiredDocumentReadiness(session);
  }
  if (reminder) item.sourceRecords.reminderId = idString(reminder._id);
  item.integrity = linkedIntegrity(
    {
      taxWorkSessionId: task.taxWorkSessionId,
      reminderId: task.reminderId,
    },
    { taxWorkSessionId: session, reminderId: reminder }
  );
  return item;
}

function enrichSessionItem(item, session, index) {
  const task = taskForSession(session, index);
  const reminder = reminderForSession(session, index);
  if (task) item.sourceRecords.taskId = idString(task._id);
  if (reminder) item.sourceRecords.reminderId = idString(reminder._id);
  item.integrity = linkedIntegrity(
    { taskId: session.taskId, reminderId: session.reminderId },
    { taskId: task, reminderId: reminder }
  );
  return item;
}

function enrichReminderItem(item, reminder, index) {
  const task = taskForReminder(reminder, index);
  const session = sessionForReminder(reminder, index);
  if (task) item.sourceRecords.taskId = idString(task._id);
  if (session) item.sourceRecords.taxWorkSessionId = idString(session._id);
  item.integrity = linkedIntegrity(
    {
      taskId: reminder.taskId,
      taxWorkSessionId: reminder.taxWorkSessionId,
    },
    { taskId: task, taxWorkSessionId: session }
  );
  return item;
}

function compareDueItems(left, right) {
  const leftDue = left.dueDateISO || "9999-12-31T23:59:59.999Z";
  const rightDue = right.dueDateISO || "9999-12-31T23:59:59.999Z";
  const dueComparison = leftDue.localeCompare(rightDue);
  if (dueComparison !== 0) return dueComparison;

  const typeRank = { TASK: 0, TAX_WORK_SESSION: 1, REMINDER: 2 };
  const rankComparison =
    (typeRank[left.recordType] ?? 9) - (typeRank[right.recordType] ?? 9);
  return rankComparison || left.id.localeCompare(right.id);
}

function compareRecentCompletions(left, right) {
  const leftCompleted = left.completedAtISO || "";
  const rightCompleted = right.completedAtISO || "";
  return (
    rightCompleted.localeCompare(leftCompleted) || left.id.localeCompare(right.id)
  );
}

function uniqueDocuments(documents) {
  return [...mapDocuments(documents).values()];
}

function uniqueItems(items) {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

export function mergeWorkspaceSourceRecords({
  tasks = [],
  sessions = [],
  reminders = [],
  authorityContext = null,
  lookups = { clients: new Map(), users: new Map() },
  limit = CALENDAR_DEFAULT_LIMIT,
  comparator = compareDueItems,
  requireDueDate = true,
  recordType = null,
}) {
  const context = authorityContext || { tasks, sessions, reminders };
  const index = buildAuthorityIndex(context);
  const taskDocuments = uniqueDocuments(tasks);
  const fallbackSessions = uniqueDocuments(sessions).filter(
    (session) => !taskForSession(session, index)
  );
  const fallbackReminders = uniqueDocuments(reminders).filter(
    (reminder) =>
      !taskForReminder(reminder, index) &&
      !sessionForReminder(reminder, index)
  );

  const normalized = uniqueItems([
    ...taskDocuments.map((task) =>
      enrichTaskItem(normalizeTask(task, lookups), task, index)
    ),
    ...fallbackSessions.map((session) =>
      enrichSessionItem(normalizeSession(session, lookups), session, index)
    ),
    ...fallbackReminders.map((reminder) =>
      enrichReminderItem(normalizeReminder(reminder, lookups), reminder, index)
    ),
  ]);
  const typeFiltered = recordType
    ? normalized.filter((item) => item.recordType === recordType)
    : normalized;
  const merged = (requireDueDate
    ? typeFiltered.filter((item) => item.dueDateISO)
    : typeFiltered
  ).sort(comparator);

  return {
    items: merged.slice(0, limit),
    totalBeforeLimit: merged.length,
  };
}

function buildMergedSection(
  sources,
  authorityContext,
  lookups,
  comparator = compareDueItems,
  requireDueDate = true
) {
  const merged = mergeWorkspaceSourceRecords({
    ...sources,
    authorityContext,
    lookups,
    limit: HOME_SECTION_LIMIT,
    comparator,
    requireDueDate,
  });
  const sourceMayHaveMore = [
    sources.tasks || [],
    sources.sessions || [],
    sources.reminders || [],
  ].some((records) => records.length >= HOME_SOURCE_FETCH_LIMIT);

  return {
    items: merged.items,
    returned: merged.items.length,
    isTruncated:
      sourceMayHaveMore || merged.totalBeforeLimit > HOME_SECTION_LIMIT,
  };
}

function buildSessionSection(sessions, authorityContext, lookups) {
  const index = buildAuthorityIndex(authorityContext);
  const normalized = uniqueItems(
    sessions.map((session) =>
      enrichSessionItem(normalizeSession(session, lookups), session, index)
    )
  ).sort(compareDueItems);
  const items = normalized.slice(0, HOME_SECTION_LIMIT);
  return {
    items,
    returned: items.length,
    isTruncated:
      sessions.length >= HOME_SOURCE_FETCH_LIMIT ||
      normalized.length > HOME_SECTION_LIMIT,
  };
}

function emptyHomeSources() {
  return {
    overdue: [],
    dueToday: [],
    dueNext7Days: [],
    next30Days: [],
    missingDocuments: [],
    unassigned: [],
    recentCompletions: [],
  };
}

function allHomeDocuments(...sources) {
  return sources.flatMap((source) => Object.values(source || {}).flat());
}

function collectLookupIds(documents) {
  const clientIds = new Set();
  const userIds = new Set();
  for (const doc of documents) {
    const clientId = idString(doc.clientId);
    if (clientId) clientIds.add(clientId);
    for (const value of [doc.assignedTo, doc.ownerUserId, doc.userId]) {
      const userId = idString(value);
      if (userId) userIds.add(userId);
    }
  }
  return { clientIds, userIds };
}

async function loadReferenceMaps(firmId, documents) {
  const { clientIds, userIds } = collectLookupIds(documents);
  const [clients, users] = await Promise.all([
    clientIds.size
      ? Client.find({ _id: { $in: [...clientIds] }, firmId })
          .select("_id name")
          .lean()
      : Promise.resolve([]),
    userIds.size
      ? User.find({ _id: { $in: [...userIds] }, firmId })
          .select("_id name")
          .lean()
      : Promise.resolve([]),
  ]);

  return {
    clients: new Map(clients.map((client) => [idString(client._id), client])),
    users: new Map(users.map((user) => [idString(user._id), user])),
  };
}

function nonEmptyIdClause(field, values) {
  const ids = [...new Set(values.map(idString).filter(Boolean))];
  return ids.length ? { [field]: { $in: ids } } : null;
}

async function boundedLinkedFind(Model, scope, clauses, extraFilter = {}) {
  const activeClauses = clauses.filter(Boolean);
  if (!activeClauses.length) return { records: [], mayHaveMore: false };
  const records = await Model.find(
    combineFilters(scope, extraFilter, { $or: activeClauses })
  )
    .limit(AUTHORITY_RESOLUTION_LIMIT)
    .lean();
  return {
    records,
    mayHaveMore: records.length >= AUTHORITY_RESOLUTION_LIMIT,
  };
}

async function resolveAuthorityContext(scopes, seedDocuments) {
  const seedTasks = uniqueDocuments(seedDocuments.tasks || []);
  const seedSessions = uniqueDocuments(seedDocuments.sessions || []);
  const seedReminders = uniqueDocuments(seedDocuments.reminders || []);

  const taskResolution = await boundedLinkedFind(Task, scopes.task, [
    nonEmptyIdClause(
      "_id",
      [...seedSessions, ...seedReminders].map((record) => record.taskId)
    ),
    nonEmptyIdClause(
      "taxWorkSessionId",
      seedSessions.map((record) => record._id)
    ),
    nonEmptyIdClause(
      "reminderId",
      seedReminders.map((record) => record._id)
    ),
  ]);
  const tasks = uniqueDocuments([...seedTasks, ...taskResolution.records]);

  const sessionResolution = await boundedLinkedFind(
    TaxWorkSession,
    scopes.session,
    [
      nonEmptyIdClause(
        "_id",
        [
          ...tasks.map((record) => record.taxWorkSessionId),
          ...seedReminders.map((record) => record.taxWorkSessionId),
        ]
      ),
      nonEmptyIdClause(
        "taskId",
        tasks.map((record) => record._id)
      ),
      nonEmptyIdClause(
        "reminderId",
        seedReminders.map((record) => record._id)
      ),
    ],
    { status: { $ne: "ARCHIVED" } }
  );
  const sessions = uniqueDocuments([
    ...seedSessions,
    ...sessionResolution.records,
  ]);

  const reminderResolution = await boundedLinkedFind(
    Reminder,
    scopes.reminder,
    [
      nonEmptyIdClause(
        "_id",
        [
          ...tasks.map((record) => record.reminderId),
          ...sessions.map((record) => record.reminderId),
        ]
      ),
      nonEmptyIdClause(
        "taskId",
        tasks.map((record) => record._id)
      ),
      nonEmptyIdClause(
        "taxWorkSessionId",
        sessions.map((record) => record._id)
      ),
    ]
  );
  const reminders = uniqueDocuments([
    ...seedReminders,
    ...reminderResolution.records,
  ]);

  return {
    tasks,
    sessions,
    reminders,
    resolutionTruncated:
      taskResolution.mayHaveMore ||
      sessionResolution.mayHaveMore ||
      reminderResolution.mayHaveMore,
  };
}

async function boundedFind(Model, filter, sort, limit = HOME_SOURCE_FETCH_LIMIT) {
  return Model.find(filter).sort(sort).limit(limit).lean();
}

function homeBoundaries(now) {
  const today = utcDayStart(now);
  return {
    today,
    tomorrow: addUtcDays(today, 1),
    next7End: addUtcDays(today, 8),
    next30End: addUtcDays(today, 30),
    recentCutoff: addUtcDays(today, -30),
  };
}

async function loadTaskHomeSources(scope, boundaries) {
  const open = { status: { $in: OPEN_TASK_STATUSES } };
  return Object.fromEntries(
    await Promise.all([
      [
        "overdue",
        boundedFind(
          Task,
          combineFilters(scope, open, stringDateBefore("dueDateISO", boundaries.today)),
          { dueDateISO: 1, _id: 1 }
        ),
      ],
      [
        "dueToday",
        boundedFind(
          Task,
          combineFilters(
            scope,
            open,
            stringDateRange("dueDateISO", boundaries.today, boundaries.tomorrow)
          ),
          { dueDateISO: 1, _id: 1 }
        ),
      ],
      [
        "dueNext7Days",
        boundedFind(
          Task,
          combineFilters(
            scope,
            open,
            stringDateRange(
              "dueDateISO",
              boundaries.tomorrow,
              boundaries.next7End
            )
          ),
          { dueDateISO: 1, _id: 1 }
        ),
      ],
      [
        "next30Days",
        boundedFind(
          Task,
          combineFilters(
            scope,
            open,
            stringDateRange(
              "dueDateISO",
              boundaries.today,
              boundaries.next30End
            )
          ),
          { dueDateISO: 1, _id: 1 }
        ),
      ],
      [
        "unassigned",
        boundedFind(
          Task,
          combineFilters(scope, open, { assignedTo: null }),
          { dueDateISO: 1, _id: 1 }
        ),
      ],
      [
        "recentCompletions",
        boundedFind(
          Task,
          combineFilters(scope, {
            status: { $in: COMPLETE_TASK_STATUSES },
            completedAt: { $gte: boundaries.recentCutoff },
          }),
          { completedAt: -1, _id: 1 }
        ),
      ],
    ].map(async ([name, promise]) => [name, await promise])
  ));
}

async function loadSessionHomeSources(scope, boundaries) {
  const open = { status: { $in: OPEN_SESSION_STATUSES } };
  return Object.fromEntries(
    await Promise.all([
      [
        "overdue",
        boundedFind(
          TaxWorkSession,
          combineFilters(scope, open, { dueDate: { $lt: boundaries.today } }),
          { dueDate: 1, _id: 1 }
        ),
      ],
      [
        "dueToday",
        boundedFind(
          TaxWorkSession,
          combineFilters(scope, open, {
            dueDate: { $gte: boundaries.today, $lt: boundaries.tomorrow },
          }),
          { dueDate: 1, _id: 1 }
        ),
      ],
      [
        "dueNext7Days",
        boundedFind(
          TaxWorkSession,
          combineFilters(scope, open, {
            dueDate: {
              $gte: boundaries.tomorrow,
              $lt: boundaries.next7End,
            },
          }),
          { dueDate: 1, _id: 1 }
        ),
      ],
      [
        "next30Days",
        boundedFind(
          TaxWorkSession,
          combineFilters(scope, open, {
            dueDate: {
              $gte: boundaries.today,
              $lt: boundaries.next30End,
            },
          }),
          { dueDate: 1, _id: 1 }
        ),
      ],
      [
        "missingDocuments",
        boundedFind(
          TaxWorkSession,
          combineFilters(scope, open, {
            documents: { $elemMatch: { required: true, received: false } },
          }),
          { dueDate: 1, _id: 1 }
        ),
      ],
      [
        "unassigned",
        boundedFind(
          TaxWorkSession,
          combineFilters(scope, open, { assignedTo: null }),
          { dueDate: 1, _id: 1 }
        ),
      ],
      [
        "recentCompletions",
        boundedFind(
          TaxWorkSession,
          combineFilters(scope, {
            status: "COMPLETE",
            completedAt: { $gte: boundaries.recentCutoff },
          }),
          { completedAt: -1, _id: 1 }
        ),
      ],
    ].map(async ([name, promise]) => [name, await promise])
  ));
}

async function loadReminderHomeSources(scope, boundaries) {
  return Object.fromEntries(
    await Promise.all([
      [
        "overdue",
        boundedFind(
          Reminder,
          combineFilters(scope, stringDateBefore("dueDateISO", boundaries.today)),
          { dueDateISO: 1, _id: 1 }
        ),
      ],
      [
        "dueToday",
        boundedFind(
          Reminder,
          combineFilters(
            scope,
            stringDateRange("dueDateISO", boundaries.today, boundaries.tomorrow)
          ),
          { dueDateISO: 1, _id: 1 }
        ),
      ],
      [
        "dueNext7Days",
        boundedFind(
          Reminder,
          combineFilters(
            scope,
            stringDateRange(
              "dueDateISO",
              boundaries.tomorrow,
              boundaries.next7End
            )
          ),
          { dueDateISO: 1, _id: 1 }
        ),
      ],
      [
        "next30Days",
        boundedFind(
          Reminder,
          combineFilters(
            scope,
            stringDateRange(
              "dueDateISO",
              boundaries.today,
              boundaries.next30End
            )
          ),
          { dueDateISO: 1, _id: 1 }
        ),
      ],
    ].map(async ([name, promise]) => [name, await promise])
  ));
}

export function composeHomeSummary({
  taskSources = emptyHomeSources(),
  sessionSources = emptyHomeSources(),
  reminderSources = emptyHomeSources(),
  authorityContext = null,
  lookups = { clients: new Map(), users: new Map() },
  now = new Date(),
  scope = "PERSONAL",
}) {
  const boundaries = homeBoundaries(now);
  const context = authorityContext || {
    tasks: allHomeDocuments(taskSources),
    sessions: allHomeDocuments(sessionSources),
    reminders: allHomeDocuments(reminderSources),
    resolutionTruncated: false,
  };
  const dueSources = (name) => ({
    tasks: taskSources[name] || [],
    sessions: sessionSources[name] || [],
    reminders: reminderSources[name] || [],
  });

  return {
    generatedAt: new Date(now).toISOString(),
    timezone: "UTC",
    scope,
    datePolicy: "STRICT_CANONICAL_ISO_OR_DATE_ONLY_AS_UTC_MIDNIGHT",
    completionTimestampPolicy: "EXPLICIT_TRANSITION_TIMESTAMP_ONLY",
    limits: { sectionItems: HOME_SECTION_LIMIT },
    integrity: {
      authorityResolutionTruncated: Boolean(context.resolutionTruncated),
    },
    ranges: {
      today: formatUtcDay(boundaries.today),
      dueNext7Days: {
        from: formatUtcDay(boundaries.tomorrow),
        to: formatUtcDay(addUtcDays(boundaries.next7End, -1)),
      },
      next30Days: {
        from: formatUtcDay(boundaries.today),
        to: formatUtcDay(addUtcDays(boundaries.next30End, -1)),
      },
      recentCompletionsSince: formatUtcDay(boundaries.recentCutoff),
    },
    sections: {
      overdue: buildMergedSection(
        dueSources("overdue"),
        context,
        lookups
      ),
      dueToday: buildMergedSection(
        dueSources("dueToday"),
        context,
        lookups
      ),
      missingDocuments: buildSessionSection(
        sessionSources.missingDocuments || [],
        context,
        lookups
      ),
      dueNext7Days: buildMergedSection(
        dueSources("dueNext7Days"),
        context,
        lookups
      ),
      unassigned: buildMergedSection(
        {
          tasks: taskSources.unassigned || [],
          sessions: sessionSources.unassigned || [],
          reminders: [],
        },
        context,
        lookups,
        compareDueItems,
        false
      ),
      recentCompletions: buildMergedSection(
        {
          tasks: taskSources.recentCompletions || [],
          sessions: sessionSources.recentCompletions || [],
          reminders: [],
        },
        context,
        lookups,
        compareRecentCompletions,
        false
      ),
      next30Days: buildMergedSection(
        dueSources("next30Days"),
        context,
        lookups
      ),
    },
  };
}

export async function loadHomeSummary({
  firmId,
  userId,
  role,
  now = new Date(),
  noticeCasesEnabled = false,
}) {
  const scopes = applyFeatureArtifactScopes(
    buildWorkspaceScopes({ firmId, userId, role }),
    noticeCasesEnabled
  );
  const boundaries = homeBoundaries(now);
  const [taskSources, sessionSources, reminderSources] = await Promise.all([
    loadTaskHomeSources(scopes.task, boundaries),
    loadSessionHomeSources(scopes.session, boundaries),
    loadReminderHomeSources(scopes.reminder, boundaries),
  ]);
  const authorityContext = await resolveAuthorityContext(scopes, {
    tasks: allHomeDocuments(taskSources),
    sessions: allHomeDocuments(sessionSources),
    reminders: allHomeDocuments(reminderSources),
  });
  const lookups = await loadReferenceMaps(scopes.firmId, [
    ...authorityContext.tasks,
    ...authorityContext.sessions,
    ...authorityContext.reminders,
  ]);

  return composeHomeSummary({
    taskSources,
    sessionSources,
    reminderSources,
    authorityContext,
    lookups,
    now,
    scope: scopes.scope,
  });
}

export async function loadComplianceCalendar({
  firmId,
  userId,
  role,
  query = {},
  noticeCasesEnabled = false,
}) {
  const parsed = parseCalendarQuery(query);
  const scopes = applyFeatureArtifactScopes(
    buildWorkspaceScopes({
      firmId,
      userId,
      role,
      assigneeId: parsed.assigneeId,
    }),
    noticeCasesEnabled
  );
  const sourceFetchLimit = Math.min(parsed.limit * 3 + 1, 1501);
  const taskFilter = combineFilters(
    scopes.task,
    stringDateRange("dueDateISO", parsed.start, parsed.endExclusive),
    parsed.clientId ? { clientId: parsed.clientId } : null
  );
  const sessionFilter = combineFilters(
    scopes.session,
    { status: { $ne: "ARCHIVED" } },
    { dueDate: { $gte: parsed.start, $lt: parsed.endExclusive } },
    parsed.clientId ? { clientId: parsed.clientId } : null
  );
  const reminderFilter = combineFilters(
    scopes.reminder,
    stringDateRange("dueDateISO", parsed.start, parsed.endExclusive),
    parsed.clientId ? { clientId: parsed.clientId } : null
  );

  const [tasks, sessions, reminders] = await Promise.all([
    boundedFind(
      Task,
      taskFilter,
      { dueDateISO: 1, _id: 1 },
      sourceFetchLimit
    ),
    boundedFind(
      TaxWorkSession,
      sessionFilter,
      { dueDate: 1, _id: 1 },
      sourceFetchLimit
    ),
    boundedFind(
      Reminder,
      reminderFilter,
      { dueDateISO: 1, _id: 1 },
      sourceFetchLimit
    ),
  ]);
  const authorityContext = await resolveAuthorityContext(scopes, {
    tasks,
    sessions,
    reminders,
  });
  const lookups = await loadReferenceMaps(scopes.firmId, [
    ...authorityContext.tasks,
    ...authorityContext.sessions,
    ...authorityContext.reminders,
  ]);
  const merged = mergeWorkspaceSourceRecords({
    tasks,
    sessions,
    reminders,
    authorityContext,
    lookups,
    limit: parsed.limit,
    recordType: parsed.recordType,
  });
  const sourceMayHaveMore = [tasks, sessions, reminders].some(
    (records) => records.length >= sourceFetchLimit
  );
  const isTruncated =
    sourceMayHaveMore ||
    authorityContext.resolutionTruncated ||
    merged.totalBeforeLimit > parsed.limit;

  return {
    generatedAt: new Date().toISOString(),
    timezone: "UTC",
    scope: scopes.scope,
    datePolicy: "STRICT_CANONICAL_ISO_OR_DATE_ONLY_AS_UTC_MIDNIGHT",
    range: {
      from: parsed.from,
      to: parsed.to,
      days: parsed.rangeDays,
      inclusive: true,
    },
    filters: {
      recordType: parsed.recordType,
      clientId: idString(parsed.clientId),
      assigneeId: idString(parsed.assigneeId),
    },
    limits: {
      requested: parsed.limit,
      maximum: CALENDAR_MAX_LIMIT,
      maximumRangeDays: CALENDAR_MAX_RANGE_DAYS,
      sourceFetch: sourceFetchLimit,
    },
    deduplication:
      "VERIFIED_TASK_AUTHORITY_THEN_SESSION_THEN_REMINDER_FALLBACK",
    integrity: {
      authorityResolutionTruncated: authorityContext.resolutionTruncated,
    },
    items: merged.items,
    returned: merged.items.length,
    isTruncated,
    truncationGuidance: isTruncated
      ? "Narrow the UTC date range to view more records"
      : null,
  };
}
