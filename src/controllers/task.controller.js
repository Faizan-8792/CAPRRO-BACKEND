// src/controllers/task.controller.js

import Task from "../models/Task.js";
import User from "../models/User.js";
import AppConfig from "../models/AppConfig.js";
import { parseStatutoryDayIso } from "../services/robust-normalize.service.js";
import { safeRecordActivity } from "../services/activity.service.js";
import ActivityEvent from "../models/ActivityEvent.js";

const PRODUCT_ACCESS_MODEL = "FREE";

/**
 * The fields a firm actually needs to see the history of, and nothing else.
 *
 * Deliberately NOT the whole document. An activity trail that stores every field on every edit
 * grows without bound, and the fields left out here are either derived (completedAt moves with
 * status) or noise (mutationVersion). What IS captured is what somebody asks the trail about:
 * who it was assigned to, where it was in the ladder, when it was due, and what they were told.
 *
 * assignedTo is stringified because it is an ObjectId on a loaded document and a string when it
 * arrives from JSON; a trail that recorded one as an object and the other as a string would show
 * a change on every edit that touched neither.
 */
function taskTrailSnapshot(task) {
  if (!task) return null;
  return {
    assignedTo: task.assignedTo ? String(task.assignedTo) : null,
    status: task.status ?? null,
    title: task.title ?? null,
    dueDateISO: task.dueDateISO ?? null,
    remarks: task.remarks ?? "",
    reviewStatus: task.reviewStatus ?? null,
    assigneeReadAt: task.assigneeReadAt ? new Date(task.assigneeReadAt).toISOString() : null,
  };
}

/**
 * Which of the tracked fields actually moved. Returns null when nothing did.
 *
 * The trail records an event only when something changed, so "who touched this" stays readable
 * instead of filling with no-op saves from forms that post every field they know about.
 */
function taskTrailChanges(before, after) {
  if (!before || !after) return null;
  const changed = {};
  for (const key of Object.keys(after)) {
    if (before[key] !== after[key]) {
      changed[key] = { from: before[key], to: after[key] };
    }
  }
  return Object.keys(changed).length > 0 ? changed : null;
}
const DEFAULT_TASK_PAGE_SIZE = 50;
const MAX_TASK_PAGE_SIZE = 100;

function taskPagination(query = {}) {
  const page = Number(query.page ?? 1);
  const limit = Number(query.limit ?? DEFAULT_TASK_PAGE_SIZE);
  if (!Number.isInteger(page) || page < 1 || page > 100000) {
    const error = new Error("page must be an integer between 1 and 100000");
    error.statusCode = 400;
    throw error;
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TASK_PAGE_SIZE) {
    const error = new Error(
      `limit must be an integer between 1 and ${MAX_TASK_PAGE_SIZE}`,
    );
    error.statusCode = 400;
    throw error;
  }
  return { page, limit, skip: (page - 1) * limit };
}

function paginationResult(page, limit, total) {
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

async function includeCaseArtifacts() {
  return AppConfig.isFeatureEnabled("noticeCases", { fresh: true });
}

function capturedNoticeCasesEnabled(req) {
  return req.featureFlagStates?.noticeCases?.enabled === true;
}

function scopeCaseArtifacts(filter, includeCaseArtifactsInResponse) {
  if (!includeCaseArtifactsInResponse) filter.source = { $ne: "CASE" };
  return filter;
}

async function rejectCaseProjectionMutation(task, res) {
  if (task?.source !== "CASE") return false;
  const enabled = await includeCaseArtifacts();
  res.status(enabled ? 409 : 404).json({
    ok: false,
    error: enabled
      ? "Case-generated tasks are server-managed and cannot be changed through generic task routes"
      : "Task not found",
    ...(enabled ? { code: "CASE_PROJECTION_READ_ONLY" } : {}),
  });
  return true;
}

// -------- CREATE TASK --------

export const createTask = async (req, res) => {
  try {
    const user = req.user;
    const firmId = user.firmId;

    if (!firmId) {
      return res
        .status(400)
        .json({ ok: false, error: "Firm not linked to this user" });
    }

    const {
      clientName,
      serviceType,
      title,
      dueDateISO,
      assignedTo,
      status,
      reminderId,
      remarks,
      meta = {},
    } = req.body || {};

    if (!clientName || !title || !dueDateISO) {
      return res.status(400).json({
        ok: false,
        error: "clientName, title and dueDateISO are required",
      });
    }

    // Strict on purpose -- new Date(string) silently mis-reads an ambiguous DD-MM/MM-DD
    // task due date. See parseStatutoryDayIso's remarks in robust-normalize.service.js.
    let dueDate;
    try {
      dueDate = parseStatutoryDayIso(dueDateISO, "dueDateISO");
    } catch {
      return res.status(400).json({ ok: false, error: "Invalid dueDateISO" });
    }

    // Product access is free for every authenticated firm. Operational limits
    // such as request-size caps and rate limiting remain enforced elsewhere.

    // Validate assignedTo user inside same firm
    let assignedToUserId = null;
    if (assignedTo) {
      const assignedUser = await User.findOne({
        _id: assignedTo,
        firmId,
      }).lean();
      if (assignedUser) {
        assignedToUserId = assignedUser._id;
      }
    }

    const initialStatus = status || "NOT_STARTED";
    const initiallyComplete = ["FILED", "CLOSED"].includes(initialStatus);
    const task = new Task({
      firmId,
      createdBy: user.id,
      clientName,
      serviceType: serviceType || "OTHER",
      title,
      dueDateISO: dueDate.toISOString(),
      assignedTo: assignedToUserId,

      // Trimmed and coerced here rather than trusted: the schema caps the length, but a null or
      // a number arriving from a client would otherwise be stored as-is and then rendered.
      remarks: typeof remarks === "string" ? remarks.trim() : "",

      // A brand-new assignment has not been read by anybody, INCLUDING when the administrator
      // assigns it to themselves. Stated explicitly rather than left to the schema default, so
      // the create path says out loud what the read receipt starts as.
      assigneeReadAt: null,
      assigneeReadBy: null,
      status: initialStatus,
      completedAt: initiallyComplete ? new Date() : null,
      completedBy: initiallyComplete ? user.id : null,
      filedAt: initialStatus === "FILED" ? new Date() : null,
      filedBy: initialStatus === "FILED" ? user.id : null,
      reminderId: reminderId || null,
      meta,
      isActive: true,
    });

    await task.save();

    // safeRecordActivity, not recordActivity: the trail must never be the reason a task fails to
    // be created. A missing audit line is a gap; a refused assignment is lost work.
    await safeRecordActivity({
      firmId,
      actorUserId: user.id,
      action: "task.created",
      entityType: "Task",
      entityId: task._id,
      beforeSummary: null,
      afterSummary: taskTrailSnapshot(task),
    });

    res.json({ ok: true, task });
  } catch (err) {
    console.error("createTask error:", err);
    res.status(500).json({ ok: false, error: "Failed to create task" });
  }
};

// -------- LIST / BOARD VIEW --------

export const getTaskBoard = async (req, res) => {
  try {
    const user = req.user;
    const firmId = user.firmId;

    if (!firmId) {
      return res
        .status(400)
        .json({ ok: false, error: "Firm not linked to this user" });
    }

    const { page, limit, skip } = taskPagination(req.query || {});
    const { serviceType, assignedTo, month, status } = req.query || {};

    const filter = {
      firmId,
      isActive: true,
    };
    scopeCaseArtifacts(filter, capturedNoticeCasesEnabled(req));

    if (serviceType) filter.serviceType = serviceType;
    if (status) filter.status = status;
    if (assignedTo) {
      if (!/^[a-f\d]{24}$/i.test(String(assignedTo))) {
        return res.status(400).json({
          ok: false,
          error: "assignedTo must be a valid ObjectId",
        });
      }
      filter.assignedTo = assignedTo;
    }
    if (month) {
      const [yearStr, monthStr] = month.split("-");
      const year = Number(yearStr);
      const m = Number(monthStr);
      if (!Number.isNaN(year) && !Number.isNaN(m) && m >= 1 && m <= 12) {
        const start = new Date(Date.UTC(year, m - 1, 1, 0, 0, 0, 0));
        const end = new Date(Date.UTC(year, m, 1, 0, 0, 0, 0));
        filter.dueDateISO = {
          $gte: start.toISOString(),
          $lt: end.toISOString(),
        };
      }
    }

    const [total, tasks] = await Promise.all([
      Task.countDocuments(filter),
      Task.find(filter)
        .sort({ dueDateISO: 1, _id: 1 })
        .skip(skip)
        .limit(limit)
        .populate("assignedTo", "name email")
        // createdBy has always been STORED (createTask sets it) and was never serialised, so a
        // "who raised this" column had no data to read. Populated with the same two fields as
        // assignedTo and nothing more: a name and an email are what a person needs to be
        // identified by a colleague, and widening the projection would ship account fields to a
        // list view that has no use for them.
        .populate("createdBy", "name email")
        .lean(),
    ]);

    const columns = {
      NOT_STARTED: [],
      WAITING_DOCS: [],
      IN_PROGRESS: [],
      FILED: [],
      CLOSED: [],
    };

    tasks.forEach((task) => {
      const key = task.status || "NOT_STARTED";
      if (!columns[key]) columns[key] = [];
      columns[key].push({
        id: task._id,
        clientName: task.clientName,
        clientId: task.clientId || null,
        serviceType: task.serviceType,
        complianceCode: task.complianceCode || null,
        period: task.period || null,
        source: task.source || "MANUAL",
        title: task.title,
        dueDateISO: task.dueDateISO,
        assignedTo: task.assignedTo
          ? {
              id: task.assignedTo._id,
              name: task.assignedTo.name,
              email: task.assignedTo.email,
            }
          : null,
        status: task.status,
        // Who raised the task. Null rather than omitted when the populate found no user, so a
        // client can tell "the server does not report this" from "nobody is recorded" -- the
        // desktop renders those two differently, and it must not fall back to the assignee, who is
        // usually a different person.
        createdBy: task.createdBy
          ? {
              id: task.createdBy._id || task.createdBy,
              name: task.createdBy.name || null,
              email: task.createdBy.email || null,
            }
          : null,
        documentReadiness: task.documentReadiness || "UNKNOWN",
        reconciliationExceptionCount: Number(
          task.reconciliationExceptionCount || 0,
        ),
        reviewStatus: task.reviewStatus || "NOT_REQUIRED",

        // Named explicitly, like every other field on this hand-built row. An administrator
        // reading the board is asking "have they seen it", and a null here is the honest
        // answer "not yet" rather than a missing key the client has to guess about.
        remarks: task.remarks || "",
        assigneeReadAt: task.assigneeReadAt || null,

        filedAt: task.filedAt || null,
        filedBy: task.filedBy || null,
        mutationVersion: Number(task.mutationVersion || 0),
        meta: task.meta || {},
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      });
    });

    return res.json({
      ok: true,
      plan: PRODUCT_ACCESS_MODEL,
      accessModel: PRODUCT_ACCESS_MODEL,
      columns,
      pagination: paginationResult(page, limit, total),
    });
  } catch (err) {
    console.error("getTaskBoard error:", err);
    return res.status(err.statusCode || 500).json({
      ok: false,
      error: err.statusCode ? err.message : "Failed to load task board",
    });
  }
};

// -------- UPDATE STATUS / ASSIGNMENT --------

export const updateTask = async (req, res) => {
  try {
    const user = req.user;
    const firmId = user.firmId;
    const { id } = req.params;
    const {
      status,
      assignedTo,
      title,
      dueDateISO,
      meta,
      remarks,
      expectedVersion,
    } =
      req.body || {};

    if (!firmId) {
      return res
        .status(400)
        .json({ ok: false, error: "Firm not linked to this user" });
    }

    const task = await Task.findOne({ _id: id, firmId, isActive: true });
    if (!task) {
      return res.status(404).json({ ok: false, error: "Task not found" });
    }
    if (await rejectCaseProjectionMutation(task, res)) return;

    // Captured BEFORE anything below can move a field. Taken after the refusals above rather than
    // before them, so a request that is about to be rejected never produces a trail entry for a
    // change that did not happen.
    const beforeTrail = taskTrailSnapshot(task);

    // Optional so an existing caller that never read mutationVersion keeps
    // working unchanged; a caller that did read it (the board response has
    // always returned it) can now use it to catch the case two people edit the
    // same task at once, where the second save previously overwrote the first
    // with no signal to either party. Checked before any field is touched so a
    // stale write changes nothing, not even a partial field.
    if (expectedVersion !== undefined) {
      const expected = Number(expectedVersion);
      if (!Number.isSafeInteger(expected) || expected < 0) {
        return res.status(400).json({
          ok: false,
          error: "expectedVersion must be a nonnegative integer",
        });
      }
      if (expected !== Number(task.mutationVersion || 0)) {
        return res.status(409).json({
          ok: false,
          error: "This task changed since it was read. Reload and try again.",
          code: "TASK_VERSION_CONFLICT",
          currentVersion: Number(task.mutationVersion || 0),
        });
      }
    }

    if (status) {
      const wasComplete = ["FILED", "CLOSED"].includes(task.status);
      const becomesComplete = ["FILED", "CLOSED"].includes(status);
      task.status = status;
      if (becomesComplete && (!wasComplete || !task.completedAt)) {
        task.completedAt = new Date();
        task.completedBy = user.id;
      } else if (!becomesComplete && wasComplete) {
        task.completedAt = null;
        task.completedBy = null;
      }
      if (status === "FILED" && !task.filedAt) {
        task.filedAt = new Date();
        task.filedBy = user.id;
      } else if (!["FILED", "CLOSED"].includes(status) && task.filedAt) {
        task.filedAt = null;
        task.filedBy = null;
      }
    }

    if (title) {
      task.title = title;
    }

    if (dueDateISO) {
      let updatedDueDate;
      try {
        updatedDueDate = parseStatutoryDayIso(dueDateISO, "dueDateISO");
      } catch {
        return res.status(400).json({ ok: false, error: "Invalid dueDateISO" });
      }
      task.dueDateISO = updatedDueDate.toISOString();
    }

    if (assignedTo !== undefined) {
      // Read BEFORE the field moves, so "did the assignee actually change" is a comparison and
      // not a guess. Compared as strings because one side is an ObjectId and the other arrives
      // from JSON; == would be true for the same id and === never would.
      const previousAssignee = task.assignedTo ? String(task.assignedTo) : null;

      if (!assignedTo) {
        task.assignedTo = null;
      } else {
        const assignedUser = await User.findOne({
          _id: assignedTo,
          firmId,
        }).lean();
        if (!assignedUser) {
          return res
            .status(400)
            .json({ ok: false, error: "Assigned user not in firm" });
        }
        task.assignedTo = assignedUser._id;
      }

      const nextAssignee = task.assignedTo ? String(task.assignedTo) : null;

      // THE RULE THIS FEATURE TURNS ON. A task handed to somebody else has not been read by
      // them, so the receipt is cleared. An administrator looking at a tick left behind by the
      // PREVIOUS assignee would conclude the new one has seen the work, which is the opposite of
      // the truth and exactly the mistake a read receipt exists to prevent.
      //
      // Guarded on a real change, not on the field being present in the request: re-sending the
      // same assignee (which a bulk edit or a form that posts every field does routinely) must
      // NOT throw away an acknowledgement that genuinely happened.
      if (previousAssignee !== nextAssignee) {
        task.assigneeReadAt = null;
        task.assigneeReadBy = null;
      }
    }

    // Present-and-a-string, so an explicit empty string CLEARS the remarks while an absent field
    // leaves them alone. `if (remarks)` would have made clearing them impossible.
    if (typeof remarks === "string") {
      task.remarks = remarks.trim();
    }

    if (meta && typeof meta === "object") {
      task.meta = { ...(task.meta || {}), ...meta };
    }

    await task.save();

    // The point of the whole trail: an assignment change records who held it BEFORE, which is
    // what answers "whom was this assigned to previously". Nothing is recorded when nothing
    // moved, so the history stays worth reading.
    const trailChanges = taskTrailChanges(beforeTrail, taskTrailSnapshot(task));
    if (trailChanges) {
      await safeRecordActivity({
        firmId,
        actorUserId: user.id,
        action: trailChanges.assignedTo ? "task.reassigned" : "task.updated",
        entityType: "Task",
        entityId: task._id,
        beforeSummary: beforeTrail,
        afterSummary: taskTrailSnapshot(task),
        metadata: { changed: Object.keys(trailChanges) },
      });
    }

    res.json({ ok: true, task });
  } catch (err) {
    console.error("updateTask error:", err);
    res.status(500).json({ ok: false, error: "Failed to update task" });
  }
};

// -------- SOFT DELETE / CLOSE --------

export const archiveTask = async (req, res) => {
  try {
    const user = req.user;
    const firmId = user.firmId;
    const { id } = req.params;

    if (!firmId) {
      return res
        .status(400)
        .json({ ok: false, error: "Firm not linked to this user" });
    }

    const task = await Task.findOne({ _id: id, firmId, isActive: true });
    if (!task) {
      return res.status(404).json({ ok: false, error: "Task not found" });
    }
    if (await rejectCaseProjectionMutation(task, res)) return;

    task.isActive = false;
    await task.save();

    res.json({ ok: true });
  } catch (err) {
    console.error("archiveTask error:", err);
    res.status(500).json({ ok: false, error: "Failed to archive task" });
  }
};

// -------- Exact task source lookup for workspace links --------

export const getTaskSource = async (req, res) => {
  try {
    const user = req.user;
    const firmId = user.firmId;
    const userId = user.id || user._id;
    const taskId = String(req.params.id || "").trim();

    if (!firmId) {
      return res
        .status(400)
        .json({ ok: false, error: "Firm not linked to this user" });
    }
    if (!/^[a-f\d]{24}$/i.test(taskId)) {
      return res.status(400).json({
        ok: false,
        error: "Task id must be a valid ObjectId",
      });
    }

    const filter = {
      _id: taskId,
      firmId,
      isActive: true,
    };
    scopeCaseArtifacts(filter, capturedNoticeCasesEnabled(req));
    if (user.role !== "FIRM_ADMIN") {
      filter.$or = [{ assignedTo: userId }, { createdBy: userId }];
    }

    const task = await Task.findOne(filter)
      .select(
        "clientName serviceType title dueDateISO status assignedTo remarks assigneeReadAt assigneeReadBy completedAt createdAt updatedAt",
      )
      .lean();
    if (!task) {
      return res.status(404).json({
        ok: false,
        error: "Task not found in your current firm scope",
      });
    }

    const openStatuses = new Set([
      "NOT_STARTED",
      "WAITING_DOCS",
      "IN_PROGRESS",
    ]);
    const canComplete =
      String(task.assignedTo || "") === String(userId) &&
      openStatuses.has(task.status);

    return res.json({ ok: true, task, canComplete });
  } catch (err) {
    console.error("getTaskSource error:", err);
    return res.status(500).json({
      ok: false,
      error: "Failed to load task source",
    });
  }
};

// -------- NEW: My open tasks for assigned user --------

export const getMyOpenTasks = async (req, res) => {
  try {
    const user = req.user;
    const firmId = user.firmId;

    if (!firmId) {
      return res
        .status(400)
        .json({ ok: false, error: "Firm not linked to this user" });
    }

    const { page, limit, skip } = taskPagination(req.query || {});
    const filter = {
      firmId,
      isActive: true,
      assignedTo: user.id,
      status: { $in: ["NOT_STARTED", "WAITING_DOCS", "IN_PROGRESS"] },
    };
    scopeCaseArtifacts(filter, capturedNoticeCasesEnabled(req));

    const [total, tasks] = await Promise.all([
      Task.countDocuments(filter),
      Task.find(filter)
        .sort({ dueDateISO: 1, _id: 1 })
        .skip(skip)
        .limit(limit)
        // remarks, assignedTo and the read receipt are listed because this is the screen the
        // ASSIGNEE reads. Without remarks they cannot see what they were told; without the
        // receipt the app cannot tell whether to offer "mark as read"; and without assignedTo
        // it cannot tell that the work is theirs at all.
        .select(
          "clientName serviceType title dueDateISO status assignedTo remarks assigneeReadAt assigneeReadBy documentReadiness reconciliationExceptionCount reviewStatus mutationVersion createdAt updatedAt",
        )
        .lean(),
    ]);

    return res.json({
      ok: true,
      tasks,
      pagination: paginationResult(page, limit, total),
    });
  } catch (err) {
    console.error("getMyOpenTasks error:", err);
    return res.status(err.statusCode || 500).json({
      ok: false,
      error: err.statusCode ? err.message : "Failed to load user tasks",
    });
  }
};

// -------- NEW: Mark done from extension (user) --------

/**
 * The assignee acknowledges work that was given to them.
 *
 * Assignee-only, by the same means completeTaskFromUser uses: assignedTo is part of the QUERY,
 * so a task belonging to somebody else is simply not found. That keeps "not yours" and "does not
 * exist" indistinguishable from outside, which is what stops this route from confirming the
 * existence of another person's work.
 *
 * IDEMPOTENT on purpose. Opening the same task twice, or two devices doing it at once, must not
 * move the recorded time - the administrator is reading "when did they first see this", and a
 * timestamp that creeps forward on every glance answers a different question.
 */
/**
 * One task's history: who changed what, and when.
 *
 * This is what answers the owner's "whom was this task assigned to before". It is a QUERY over
 * ActivityEvent rather than a field on the task, because the trail already exists, is already
 * firm-scoped and is already the audit surface - a second private history on Task would be a
 * second thing to keep true, and the two would eventually disagree.
 *
 * Firm-scoped twice over, deliberately. The task is looked up inside the caller's firm first, so
 * a task belonging to another firm is simply not found; then the events are queried by that same
 * firmId, so even an entityId guessed from another tenant returns nothing. Any member of the firm
 * may read it, which matches the task board they can already see - this exposes no task that was
 * hidden from them.
 */
export const getTaskHistory = async (req, res) => {
  try {
    const user = req.user;
    const firmId = user.firmId;
    const { id } = req.params;

    if (!firmId) {
      return res
        .status(400)
        .json({ ok: false, error: "Firm not linked to this user" });
    }

    const task = await Task.findOne({ _id: id, firmId }).lean();
    if (!task) {
      return res.status(404).json({ ok: false, error: "Task not found" });
    }

    // Newest first: "what happened to this most recently" is the question somebody opening a
    // history actually has. Capped so one heavily-edited task cannot return an unbounded page.
    const events = await ActivityEvent.find({
      firmId,
      entityType: "Task",
      entityId: String(id),
    })
      .sort({ occurredAt: -1 })
      .limit(200)
      .populate("actorUserId", "name email")
      .lean();

    res.json({
      ok: true,
      taskId: String(id),
      events: (events || []).map((event) => ({
        id: String(event._id),
        action: event.action,
        occurredAt: event.occurredAt,
        actor: event.actorUserId
          ? {
              id: String(event.actorUserId._id ?? event.actorUserId),
              name: event.actorUserId.name ?? null,
              email: event.actorUserId.email ?? null,
            }
          : null,
        before: event.beforeSummary ?? null,
        after: event.afterSummary ?? null,
        changed: event.metadata?.changed ?? null,
      })),
    });
  } catch (err) {
    console.error("getTaskHistory error:", err);
    res.status(500).json({ ok: false, error: "Failed to load the task history" });
  }
};

export const markTaskRead = async (req, res) => {
  try {
    const user = req.user;
    const firmId = user.firmId;
    const { id } = req.params;

    if (!firmId) {
      return res
        .status(400)
        .json({ ok: false, error: "Firm not linked to this user" });
    }

    const task = await Task.findOne({
      _id: id,
      firmId,
      isActive: true,
      assignedTo: user.id,
    });

    if (!task) {
      return res.status(404).json({
        ok: false,
        error: "Task not found or not assigned to this user",
      });
    }

    // Already acknowledged: report the state, change nothing, and say it was already read so a
    // caller can tell "you have just marked this" from "this was marked days ago".
    if (task.assigneeReadAt) {
      return res.json({
        ok: true,
        alreadyRead: true,
        assigneeReadAt: task.assigneeReadAt,
        assigneeReadBy: task.assigneeReadBy,
        task,
      });
    }

    task.assigneeReadAt = new Date();
    task.assigneeReadBy = user.id;
    await task.save();

    res.json({
      ok: true,
      alreadyRead: false,
      assigneeReadAt: task.assigneeReadAt,
      assigneeReadBy: task.assigneeReadBy,
      task,
    });
  } catch (err) {
    console.error("markTaskRead error:", err);
    res.status(500).json({ ok: false, error: "Failed to mark the task as read" });
  }
};

export const completeTaskFromUser = async (req, res) => {
  try {
    const user = req.user;
    const firmId = user.firmId;
    const { id } = req.params;

    if (!firmId) {
      return res
        .status(400)
        .json({ ok: false, error: "Firm not linked to this user" });
    }

    const task = await Task.findOne({
      _id: id,
      firmId,
      isActive: true,
      assignedTo: user.id, // ✅ FIXED: user._id → user.id
    });

    if (!task) {
      return res.status(404).json({
        ok: false,
        error: "Task not found or not assigned to this user",
      });
    }
    if (await rejectCaseProjectionMutation(task, res)) return;

    task.status = "CLOSED";
    if (!task.completedAt) {
      task.completedAt = new Date();
      task.completedBy = user.id;
    }

    const comment =
      "Marked done by user from Chrome extension (My Tasks panel).";

    task.meta = {
      ...(task.meta || {}),
      completedComment: comment,
      completedByUserId: user.id,
      completedAt: new Date().toISOString(),
    };

    await task.save();

    res.json({ ok: true, task });
  } catch (err) {
    console.error("completeTaskFromUser error:", err);
    res.status(500).json({ ok: false, error: "Failed to complete task" });
  }
};
