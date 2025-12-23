// src/controllers/task.controller.js

import Task from "../models/Task.js";
import Firm from "../models/Firm.js";
import User from "../models/User.js";

/**
 * Helper: firm ka current plan (FREE / PREMIUM) resolve karo
 */
async function getFirmPlan(firmId) {
  if (!firmId) return "FREE";
  const firm = await Firm.findById(firmId).lean();
  if (!firm) return "FREE";
  return firm.planType || "FREE";
}

/**
 * FREE plan ke liye max tasks per firm
 */
const FREE_TASK_LIMIT_PER_FIRM = 50;

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

    const plan = await getFirmPlan(firmId);

    if (plan === "FREE") {
      const count = await Task.countDocuments({ firmId, isActive: true });
      if (count >= FREE_TASK_LIMIT_PER_FIRM) {
        return res.status(403).json({
          ok: false,
          error:
            "Free plan task limit reached. Upgrade to PREMIUM for unlimited tasks.",
        });
      }
    }

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

    const task = new Task({
      firmId,
      createdBy: user.id,
      clientName,
      serviceType: serviceType || "OTHER",
      title,
      dueDateISO: new Date(dueDateISO).toISOString(),
      assignedTo: assignedToUserId,
      status: status || "NOT_STARTED",
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

    const plan = await getFirmPlan(firmId);

    const { serviceType, assignedTo, month, status } = req.query || {};

    const filter = {
      firmId,
      isActive: true,
    };

    // Premium filters only if plan = PREMIUM
    if (plan === "PREMIUM") {
      if (serviceType) filter.serviceType = serviceType;
      if (status) filter.status = status;
      if (assignedTo) filter.assignedTo = assignedTo;
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
    }

    const tasks = await Task.find(filter)
      .sort({ dueDateISO: 1 })
      .populate("assignedTo", "name email")
      .lean();

    const columns = {
      NOT_STARTED: [],
      WAITING_DOCS: [],
      IN_PROGRESS: [],
      FILED: [],
      CLOSED: [],
    };

    tasks.forEach((t) => {
      const key = t.status || "NOT_STARTED";
      if (!columns[key]) columns[key] = [];
      columns[key].push({
        id: t._id,
        clientName: t.clientName,
        serviceType: t.serviceType,
        title: t.title,
        dueDateISO: t.dueDateISO,
        assignedTo: t.assignedTo
          ? {
              id: t.assignedTo._id,
              name: t.assignedTo.name,
              email: t.assignedTo.email,
            }
          : null,
        status: t.status,
        meta: t.meta || {},
        createdAt: t.createdAt,
      });
    });

    res.json({
      ok: true,
      plan,
      columns,
    });
  } catch (err) {
    console.error("getTaskBoard error:", err);
    res.status(500).json({ ok: false, error: "Failed to load task board" });
  }
};

// -------- UPDATE STATUS / ASSIGNMENT --------

export const updateTask = async (req, res) => {
  try {
    const user = req.user;
    const firmId = user.firmId;
    const { id } = req.params;
    const { status, assignedTo, title, dueDateISO, meta } = req.body || {};

    if (!firmId) {
      return res
        .status(400)
        .json({ ok: false, error: "Firm not linked to this user" });
    }

    const task = await Task.findOne({ _id: id, firmId, isActive: true });
    if (!task) {
      return res.status(404).json({ ok: false, error: "Task not found" });
    }

    if (status) {
      task.status = status;
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

    task.isActive = false;
    await task.save();

    res.json({ ok: true });
  } catch (err) {
    console.error("archiveTask error:", err);
    res.status(500).json({ ok: false, error: "Failed to archive task" });
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

    const filter = {
      firmId,
      isActive: true,
      assignedTo: user.id,  // ✅ FIXED: user._id → user.id
      status: { $in: ["NOT_STARTED", "WAITING_DOCS", "IN_PROGRESS"] },
    };

    const tasks = await Task.find(filter)
      .sort({ dueDateISO: 1 })
      .select("clientName serviceType title dueDateISO status createdAt")
      .lean();

    res.json({ ok: true, tasks });
  } catch (err) {
    console.error("getMyOpenTasks error:", err);
    res.status(500).json({ ok: false, error: "Failed to load user tasks" });
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
      assignedTo: user.id,  // ✅ FIXED: user._id → user.id
    });

    if (!task) {
      return res.status(404).json({
        ok: false,
        error: "Task not found or not assigned to this user",
      });
    }

    task.status = "CLOSED";

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
