// src/controllers/task.controller.js

import Task from "../models/Task.js";
import User from "../models/User.js";
import AppConfig from "../models/AppConfig.js";

const PRODUCT_ACCESS_MODEL = "FREE";
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
      meta = {},
    } = req.body || {};

    if (!clientName || !title || !dueDateISO) {
      return res.status(400).json({
        ok: false,
        error: "clientName, title and dueDateISO are required",
      });
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
      dueDateISO: new Date(dueDateISO).toISOString(),
      assignedTo: assignedToUserId,
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
        documentReadiness: task.documentReadiness || "UNKNOWN",
        reconciliationExceptionCount: Number(
          task.reconciliationExceptionCount || 0,
        ),
        reviewStatus: task.reviewStatus || "NOT_REQUIRED",
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
    const { status, assignedTo, title, dueDateISO, meta, expectedVersion } =
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
      task.dueDateISO = new Date(dueDateISO).toISOString();
    }

    if (assignedTo !== undefined) {
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
    }

    if (meta && typeof meta === "object") {
      task.meta = { ...(task.meta || {}), ...meta };
    }

    await task.save();
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
        "clientName serviceType title dueDateISO status assignedTo completedAt createdAt updatedAt",
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
        .select(
          "clientName serviceType title dueDateISO status documentReadiness reconciliationExceptionCount reviewStatus mutationVersion createdAt updatedAt",
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
