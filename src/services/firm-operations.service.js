import mongoose from "mongoose";
import CaseDraft from "../models/CaseDraft.js";
import CaseMatter from "../models/CaseMatter.js";
import Client from "../models/Client.js";
import ReconciliationItem from "../models/ReconciliationItem.js";
import Task from "../models/Task.js";
import TdsHealthCheck from "../models/TdsHealthCheck.js";
import User from "../models/User.js";

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const MAX_FILING_COLUMNS = 100;
const OPEN_TASK_STATUSES = Object.freeze([
  "NOT_STARTED",
  "WAITING_DOCS",
  "IN_PROGRESS",
]);
const SOURCE_ORDER = Object.freeze({
  TASK: 1,
  CLIENT: 2,
  CASE: 3,
  CASE_DRAFT: 4,
  GST_RECONCILIATION: 5,
  TDS_HEALTH: 6,
});

class FirmOperationsQueryError extends Error {
  constructor(message, status = 400, code = "INVALID_QUERY") {
    super(message);
    this.name = "FirmOperationsQueryError";
    this.status = status;
    this.code = code;
  }
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parsePage(query = {}) {
  const page = Number(query.page ?? 1);
  const limit = Number(query.limit ?? DEFAULT_PAGE_SIZE);
  if (!Number.isInteger(page) || page < 1 || page > 100000) {
    throw new FirmOperationsQueryError(
      "page must be an integer between 1 and 100000"
    );
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new FirmOperationsQueryError(
      `limit must be an integer between 1 and ${MAX_PAGE_SIZE}`
    );
  }
  return { page, limit, skip: (page - 1) * limit };
}

function pageMetadata(page, limit, total) {
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
  return {
    page,
    limit,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrevious: page > 1 && totalPages > 0,
  };
}

function parseLimit(value) {
  const limit = Number(value ?? DEFAULT_PAGE_SIZE);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new FirmOperationsQueryError(
      `limit must be an integer between 1 and ${MAX_PAGE_SIZE}`
    );
  }
  return limit;
}

function decodeCursor(rawCursor, allowedTypes) {
  if (!rawCursor) return null;
  try {
    const value = JSON.parse(
      Buffer.from(String(rawCursor), "base64url").toString("utf8")
    );
    const at = new Date(value.t);
    if (
      Number.isNaN(at.getTime()) ||
      !/^[a-f\d]{24}$/i.test(String(value.id || "")) ||
      !allowedTypes.includes(value.type)
    ) {
      throw new Error("invalid cursor payload");
    }
    return {
      at,
      id: new mongoose.Types.ObjectId(value.id),
      idText: String(value.id),
      type: value.type,
    };
  } catch {
    throw new FirmOperationsQueryError("cursor is invalid");
  }
}

function encodeCursor(item) {
  return Buffer.from(
    JSON.stringify({
      t: new Date(item.updatedAt).toISOString(),
      id: String(item.id),
      type: item.type,
    })
  ).toString("base64url");
}

function withCursor(filter, cursor, sourceType) {
  if (!cursor) return filter;
  const clauses = [
    { updatedAt: { $lt: cursor.at } },
    { updatedAt: cursor.at, _id: { $lt: cursor.id } },
  ];
  if (SOURCE_ORDER[sourceType] > SOURCE_ORDER[cursor.type]) {
    clauses.push({ updatedAt: cursor.at, _id: cursor.id });
  }
  return { ...filter, $or: clauses };
}

function compareCursorItems(left, right) {
  const timeDifference =
    new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
  if (timeDifference) return timeDifference;
  const idDifference = String(right.id).localeCompare(String(left.id));
  if (idDifference) return idDifference;
  return SOURCE_ORDER[left.type] - SOURCE_ORDER[right.type];
}

function cursorPage(items, limit) {
  const ordered = items.sort(compareCursorItems);
  const pageItems = ordered.slice(0, limit);
  const hasMore = ordered.length > limit;
  return {
    items: pageItems.map(({ _cursorType, ...item }) => item),
    pagination: {
      limit,
      hasMore,
      nextCursor:
        hasMore && pageItems.length
          ? encodeCursor(pageItems[pageItems.length - 1])
          : null,
    },
  };
}

function effectiveTaskCode(task) {
  return task.complianceCode || task.serviceType || "OTHER";
}

function documentReadiness(task) {
  if (task.documentReadiness && task.documentReadiness !== "UNKNOWN") {
    return task.documentReadiness;
  }
  const legacy = String(task.meta?.docsStatus || "").trim().toUpperCase();
  if (["RECEIVED", "READY", "COMPLETE"].includes(legacy)) return "READY";
  if (["PARTIAL", "PARTLY_RECEIVED"].includes(legacy)) return "PARTIAL";
  if (["PENDING", "MISSING"].includes(legacy)) return "PENDING";
  return "UNKNOWN";
}

function dueState(task, now) {
  if (["FILED", "CLOSED"].includes(task.status)) return "COMPLETE";
  const due = new Date(task.dueDateISO);
  if (Number.isNaN(due.getTime())) return "UNKNOWN";
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  const dueSoon = new Date(today.getTime() + 8 * 24 * 60 * 60 * 1000);
  if (due < today) return "OVERDUE";
  if (due < tomorrow) return "DUE_TODAY";
  if (due < dueSoon) return "DUE_SOON";
  return "UPCOMING";
}

async function selectedTasksForClients({ firmId, clients, codes }) {
  if (!clients.length || !codes.length) return new Map();
  const clientIds = clients.map((client) => client._id);
  const clientNames = clients.map((client) => client.name.toLowerCase());
  const grouped = async ({ complete, legacy }) => {
    const status = complete
      ? { $in: ["FILED", "CLOSED"] }
      : { $in: OPEN_TASK_STATUSES };
    const match = {
      firmId: new mongoose.Types.ObjectId(String(firmId)),
      isActive: true,
      status,
      source: { $ne: "CASE" },
      ...(legacy
        ? { clientId: null }
        : { clientId: { $in: clientIds } }),
    };
    return Task.aggregate([
      { $match: match },
      {
        $addFields: {
          effectiveCode: { $ifNull: ["$complianceCode", "$serviceType"] },
          normalizedClientName: { $toLower: "$clientName" },
        },
      },
      {
        $match: {
          effectiveCode: { $in: codes },
          ...(legacy
            ? { normalizedClientName: { $in: clientNames } }
            : {}),
        },
      },
      { $sort: { dueDateISO: complete ? -1 : 1, _id: complete ? -1 : 1 } },
      {
        $group: {
          _id: {
            clientKey: legacy ? "$normalizedClientName" : "$clientId",
            code: "$effectiveCode",
          },
          task: { $first: "$$ROOT" },
        },
      },
    ]);
  };

  const [openLinked, completeLinked, openLegacy, completeLegacy] =
    await Promise.all([
      grouped({ complete: false, legacy: false }),
      grouped({ complete: true, legacy: false }),
      grouped({ complete: false, legacy: true }),
      grouped({ complete: true, legacy: true }),
    ]);
  const selected = new Map();
  for (const result of [
    ...openLinked,
    ...openLegacy,
    ...completeLinked,
    ...completeLegacy,
  ]) {
    const key = `${String(result._id.clientKey)}:${result._id.code}`;
    if (!selected.has(key)) selected.set(key, result.task);
  }
  return selected;
}

export async function loadFilingDashboard({ firmId, query = {}, now = new Date() }) {
  const { page, limit, skip } = parsePage(query);
  const search = String(query.q || "").trim();
  if (search.length > 80) {
    throw new FirmOperationsQueryError("q must be at most 80 characters");
  }
  const clientFilter = { firmId, isActive: true };
  if (search) {
    const pattern = new RegExp(escapeRegex(search), "i");
    clientFilter.$or = [
      { name: pattern },
      { gstin: pattern },
      { pan: pattern },
      { clientCode: pattern },
    ];
  }

  const [columnRows, total, clients] = await Promise.all([
    Client.aggregate([
      {
        $match: {
          firmId: new mongoose.Types.ObjectId(String(firmId)),
          isActive: true,
        },
      },
      { $unwind: "$complianceProfile" },
      { $match: { "complianceProfile.applicability": "APPLICABLE" } },
      { $group: { _id: "$complianceProfile.code" } },
      { $sort: { _id: 1 } },
      { $limit: MAX_FILING_COLUMNS + 1 },
    ]),
    Client.countDocuments(clientFilter),
    Client.find(clientFilter)
      .select("name gstin pan clientCode")
      .sort({ name: 1, _id: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),
  ]);
  if (columnRows.length > MAX_FILING_COLUMNS) {
    throw new FirmOperationsQueryError(
      `Filing Dashboard supports at most ${MAX_FILING_COLUMNS} enabled compliance codes`,
      422,
      "FILING_COLUMNS_LIMIT"
    );
  }
  const columns = columnRows.map((row) => row._id).filter(Boolean);
  const selected = await selectedTasksForClients({ firmId, clients, codes: columns });

  const rows = clients.map((client) => {
    const linkedKey = String(client._id);
    const legacyKey = client.name.toLowerCase();
    return {
      client: {
        id: linkedKey,
        name: client.name,
        clientCode: client.clientCode || "",
        gstin: client.gstin || "",
        pan: client.pan || "",
      },
      cells: columns.map((code) => {
        const task =
          selected.get(`${linkedKey}:${code}`) ||
          selected.get(`${legacyKey}:${code}`) ||
          null;
        if (!task) return { code, task: null };
        return {
          code,
          task: {
            id: String(task._id),
            title: task.title || `${code} filing`,
            period: task.period || "",
            status: task.status,
            dueDateISO: task.dueDateISO,
            dueState: dueState(task, now),
            documentReadiness: documentReadiness(task),
            reconciliationWarning:
              Number(task.reconciliationExceptionCount || 0) > 0 ||
              task.source === "RECONCILIATION",
            reconciliationExceptionCount: Number(
              task.reconciliationExceptionCount || 0
            ),
            reviewStatus: task.reviewStatus || "NOT_REQUIRED",
            filedAt: task.filedAt || null,
          },
        };
      }),
    };
  });

  return {
    generatedAt: now.toISOString(),
    columns,
    rows,
    pagination: pageMetadata(page, limit, total),
  };
}

export async function loadTeamWorkload({
  firmId,
  query = {},
  noticeCasesEnabled = false,
  now = new Date(),
}) {
  const { page, limit, skip } = parsePage(query);
  const memberFilter = { firmId, isActive: true };
  const [total, members] = await Promise.all([
    User.countDocuments(memberFilter),
    User.find(memberFilter)
      .select("name email role")
      .sort({ name: 1, email: 1, _id: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),
  ]);
  const memberIds = members.map((member) => member._id);
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const dueSoonEnd = new Date(today.getTime() + 8 * 24 * 60 * 60 * 1000);
  const todayISO = today.toISOString();
  const dueSoonISO = dueSoonEnd.toISOString();
  const sourceFilter = noticeCasesEnabled ? {} : { source: { $ne: "CASE" } };

  const [counts, unassigned] = await Promise.all([
    memberIds.length
      ? Task.aggregate([
          {
            $match: {
              firmId: new mongoose.Types.ObjectId(String(firmId)),
              isActive: true,
              assignedTo: { $in: memberIds },
              status: { $in: OPEN_TASK_STATUSES },
              ...sourceFilter,
            },
          },
          {
            $group: {
              _id: "$assignedTo",
              open: { $sum: 1 },
              overdue: {
                $sum: { $cond: [{ $lt: ["$dueDateISO", todayISO] }, 1, 0] },
              },
              dueSoon: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $gte: ["$dueDateISO", todayISO] },
                        { $lt: ["$dueDateISO", dueSoonISO] },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
              waitingDocs: {
                $sum: { $cond: [{ $eq: ["$status", "WAITING_DOCS"] }, 1, 0] },
              },
              case: {
                $sum: { $cond: [{ $eq: ["$source", "CASE"] }, 1, 0] },
              },
              reconciliationReview: {
                $sum: {
                  $cond: [
                    {
                      $or: [
                        { $eq: ["$source", "RECONCILIATION"] },
                        { $gt: ["$reconciliationExceptionCount", 0] },
                        { $eq: ["$reviewStatus", "PENDING"] },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
            },
          },
        ])
      : [],
    Task.countDocuments({
      firmId,
      isActive: true,
      assignedTo: null,
      status: { $in: OPEN_TASK_STATUSES },
      ...sourceFilter,
    }),
  ]);
  const byMember = new Map(counts.map((entry) => [String(entry._id), entry]));
  return {
    generatedAt: now.toISOString(),
    definition:
      "Operational workload counts only; values are not employee performance scores.",
    unassigned,
    members: members.map((member) => {
      const values = byMember.get(String(member._id)) || {};
      return {
        id: String(member._id),
        name: member.name || member.email,
        email: member.email,
        role: member.role,
        counts: {
          open: Number(values.open || 0),
          overdue: Number(values.overdue || 0),
          dueSoon: Number(values.dueSoon || 0),
          waitingDocs: Number(values.waitingDocs || 0),
          case: Number(values.case || 0),
          reconciliationReview: Number(values.reconciliationReview || 0),
          unassigned: 0,
        },
      };
    }),
    pagination: pageMetadata(page, limit, total),
  };
}

export async function searchWorkspace({
  firmId,
  query = {},
  noticeCasesEnabled = false,
}) {
  const q = String(query.q || "").trim();
  if (q.length < 2 || q.length > 80) {
    throw new FirmOperationsQueryError("q must contain 2 to 80 characters");
  }
  const limit = parseLimit(query.limit);
  const types = noticeCasesEnabled ? ["TASK", "CLIENT", "CASE"] : ["TASK", "CLIENT"];
  const cursor = decodeCursor(query.cursor, types);
  const pattern = new RegExp(escapeRegex(q), "i");
  const taskFilter = withCursor(
    {
      firmId,
      isActive: true,
      ...(noticeCasesEnabled ? {} : { source: { $ne: "CASE" } }),
      $and: [
        {
          $or: [
            { title: pattern },
            { clientName: pattern },
            { complianceCode: pattern },
            { period: pattern },
          ],
        },
      ],
    },
    cursor,
    "TASK"
  );
  const clientFilter = withCursor(
    {
      firmId,
      isActive: true,
      $and: [
        {
          $or: [
            { name: pattern },
            { gstin: pattern },
            { pan: pattern },
            { clientCode: pattern },
            { tags: pattern },
          ],
        },
      ],
    },
    cursor,
    "CLIENT"
  );
  const caseFilter = withCursor(
    {
      firmId,
      archivedAt: null,
      $and: [
        {
          $or: [
            { title: pattern },
            { internalReference: pattern },
            { "confirmedFacts.din": pattern },
            { "confirmedFacts.sectionReference": pattern },
          ],
        },
      ],
    },
    cursor,
    "CASE"
  );

  const [tasks, clients, cases] = await Promise.all([
    Task.find(taskFilter)
      .select("title clientName status dueDateISO serviceType complianceCode updatedAt")
      .sort({ updatedAt: -1, _id: -1 })
      .limit(limit + 1)
      .lean(),
    Client.find(clientFilter)
      .select("name gstin pan +clientCode updatedAt")
      .sort({ updatedAt: -1, _id: -1 })
      .limit(limit + 1)
      .lean(),
    noticeCasesEnabled
      ? CaseMatter.find(caseFilter)
          .select("title status priority internalReference confirmedFacts updatedAt")
          .sort({ updatedAt: -1, _id: -1 })
          .limit(limit + 1)
          .lean()
      : [],
  ]);

  const items = [
    ...tasks.map((task) => ({
      type: "TASK",
      id: String(task._id),
      title: task.title,
      subtitle: `${task.clientName} · ${effectiveTaskCode(task)}`,
      status: task.status,
      dueDateISO: task.dueDateISO,
      updatedAt: task.updatedAt,
    })),
    ...clients.map((client) => ({
      type: "CLIENT",
      id: String(client._id),
      title: client.name,
      subtitle: client.clientCode || client.gstin || client.pan || "Client",
      status: "ACTIVE",
      updatedAt: client.updatedAt,
    })),
    ...cases.map((matter) => ({
      type: "CASE",
      id: String(matter._id),
      title: matter.title,
      subtitle:
        matter.internalReference ||
        matter.confirmedFacts?.sectionReference ||
        "Case matter",
      status: matter.status,
      priority: matter.priority,
      updatedAt: matter.updatedAt,
    })),
  ];
  return { query: q, ...cursorPage(items, limit) };
}

export async function loadReviewQueue({
  firmId,
  query = {},
  noticeCasesEnabled = false,
  gstEnabled = false,
  tdsEnabled = false,
}) {
  const activeTypes = ["TASK"];
  if (noticeCasesEnabled) activeTypes.push("CASE_DRAFT");
  if (gstEnabled) activeTypes.push("GST_RECONCILIATION");
  if (tdsEnabled) activeTypes.push("TDS_HEALTH");
  const limit = parseLimit(query.limit);
  const cursor = decodeCursor(query.cursor, activeTypes);

  const [tasks, drafts, gstItems, tdsChecks] = await Promise.all([
    Task.find(
      withCursor(
        {
          firmId,
          isActive: true,
          reviewStatus: "PENDING",
          ...(noticeCasesEnabled ? {} : { source: { $ne: "CASE" } }),
        },
        cursor,
        "TASK"
      )
    )
      .select("title clientName status dueDateISO assignedTo updatedAt")
      .sort({ updatedAt: -1, _id: -1 })
      .limit(limit + 1)
      .lean(),
    noticeCasesEnabled
      ? CaseDraft.find(
          withCursor({ firmId, status: "IN_REVIEW" }, cursor, "CASE_DRAFT")
        )
          .select("caseId version title status origin createdBy updatedAt")
          .populate("caseId", "title status clientId")
          .sort({ updatedAt: -1, _id: -1 })
          .limit(limit + 1)
          .lean()
      : [],
    gstEnabled
      ? ReconciliationItem.find(
          withCursor(
            {
              firmId,
              isActive: true,
              resolutionState: "OPEN",
              status: { $ne: "MATCHED" },
            },
            cursor,
            "GST_RECONCILIATION"
          )
        )
          .select(
            "runId clientId status supplierGstin invoiceNumberOriginal userDisposition updatedAt"
          )
          .populate("clientId", "name")
          .sort({ updatedAt: -1, _id: -1 })
          .limit(limit + 1)
          .lean()
      : [],
    tdsEnabled
      ? TdsHealthCheck.find(
          withCursor(
            { firmId, state: { $in: ["OPEN", "ACTION_PLANNED"] } },
            cursor,
            "TDS_HEALTH"
          )
        )
          .select("runId clientId title status severity state actionPlan updatedAt")
          .populate("clientId", "name")
          .sort({ updatedAt: -1, _id: -1 })
          .limit(limit + 1)
          .lean()
      : [],
  ]);

  const items = [
    ...tasks.map((task) => ({
      type: "TASK",
      id: String(task._id),
      title: task.title,
      subtitle: task.clientName,
      status: task.reviewStatus || "PENDING",
      dueDateISO: task.dueDateISO,
      updatedAt: task.updatedAt,
    })),
    ...drafts.map((draft) => ({
      type: "CASE_DRAFT",
      id: String(draft._id),
      parentId: String(draft.caseId?._id || draft.caseId || ""),
      title: draft.title || `Case draft v${draft.version}`,
      subtitle: draft.caseId?.title || `Version ${draft.version}`,
      status: draft.status,
      origin: draft.origin,
      updatedAt: draft.updatedAt,
    })),
    ...gstItems.map((item) => ({
      type: "GST_RECONCILIATION",
      id: String(item._id),
      parentId: String(item.runId),
      title: item.invoiceNumberOriginal || item.supplierGstin || "GST exception",
      subtitle: item.clientId?.name || item.supplierGstin || "GST reconciliation",
      status: item.status,
      updatedAt: item.updatedAt,
    })),
    ...tdsChecks.map((check) => ({
      type: "TDS_HEALTH",
      id: String(check._id),
      parentId: String(check.runId),
      title: check.title,
      subtitle: check.clientId?.name || "TDS health",
      status: check.state,
      severity: check.severity,
      updatedAt: check.updatedAt,
    })),
  ];
  return { ...cursorPage(items, limit), sources: activeTypes };
}

export {
  DEFAULT_PAGE_SIZE,
  FirmOperationsQueryError,
  MAX_FILING_COLUMNS,
  MAX_PAGE_SIZE,
};
