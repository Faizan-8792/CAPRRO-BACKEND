// src/controllers/task.controller.js

import Task from "../models/Task.js";
import Firm from "../models/Firm.js";
import User from "../models/User.js";

/* ---------------- HELPERS ---------------- */

async function getFirmPlan(firmId) {
  if (!firmId) return "FREE";
  const firm = await Firm.findById(firmId).lean();
  return firm?.planType || "FREE";
}

const FREE_TASK_LIMIT_PER_FIRM = 50;

/* ---------------- CREATE TASK ---------------- */

export const createTask = async (req, res) => {
  try {
    const user = req.user;
    const firmId = user.firmId;

    const {
      clientName,
      serviceType,
      title,
      dueDateISO,
      assignedTo,
      status,
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
          error: "Free plan task limit reached",
        });
      }
    }

    let assignedUserId = null;
    if (assignedTo) {
      const u = await User.findOne({ _id: assignedTo, firmId }).lean();
      if (u) assignedUserId = u._id;
    }

    const taskMeta = { ...meta };
    if (status === "WAITING_DOCS") {
      taskMeta.waitingSince = new Date().toISOString();
    }

    const task = new Task({
      firmId,
      createdBy: user.id,
      clientName,
      serviceType: serviceType || "OTHER",
      title,
      dueDateISO,
      assignedTo: assignedUserId,
      status: status || "NOT_STARTED",
      meta: taskMeta,
      isActive: true,
    });

    await task.save();
    res.json({ ok: true, task });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Failed to create task" });
  }
};

/* ---------------- BOARD ---------------- */

export const getTaskBoard = async (req, res) => {
  try {
    const firmId = req.user.firmId;
    const plan = await getFirmPlan(firmId);

    const filter = { firmId, isActive: true };

    if (plan === "PREMIUM") {
      const { serviceType, assignedTo, status } = req.query;
      if (serviceType) filter.serviceType = serviceType;
      if (assignedTo) filter.assignedTo = assignedTo;
      if (status) filter.status = status;
    }

    const tasks = await Task.find(filter)
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
      columns[t.status || "NOT_STARTED"].push({
        id: t._id,
        clientName: t.clientName,
        serviceType: t.serviceType,
        title: t.title,
        dueDateISO: t.dueDateISO,
        assignedTo: t.assignedTo,
        status: t.status,
        meta: t.meta || {},
      });
    });

    res.json({ ok: true, plan, columns });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Failed to load board" });
  }
};

/* ---------------- UPDATE TASK ---------------- */

export const updateTask = async (req, res) => {
  try {
    const firmId = req.user.firmId;
    const { id } = req.params;
    const { status, assignedTo, meta } = req.body;

    const task = await Task.findOne({ _id: id, firmId, isActive: true });
    if (!task) return res.status(404).json({ ok: false, error: "Task not found" });

    if (status) {
      task.status = status;

      // ✅ ALWAYS ensure meta exists
      task.meta = task.meta || {};

      if (status === "WAITING_DOCS" && !task.meta.waitingSince) {
        task.meta.waitingSince = new Date().toISOString();
      }

      if (status !== "WAITING_DOCS") {
        delete task.meta.waitingSince; // ✅ SAFE
      }
    }

    if (assignedTo !== undefined) {
      task.assignedTo = assignedTo || null;
    }

    if (meta) {
      task.meta = { ...(task.meta || {}), ...meta };
    }

    await task.save();
    res.json({ ok: true, task });
  } catch (err) {
    console.error("updateTask error FULL 👉", err);
    return res.status(500).json({
      ok: false,
      error: err.message,
      stack: err.stack
    });
  }
};

/* ---------------- DELETE TASK ---------------- */

export const deleteTask = async (req, res) => {
  try {
    const { id } = req.params;
    const firmId = req.user.firmId;

    const task = await Task.findOne({
      _id: id,
      firmId,
      isActive: true,
    });

    if (!task) {
      return res.status(404).json({
        ok: false,
        error: "Task not found",
      });
    }

    // ✅ Soft delete (recommended)
    task.isActive = false;
    await task.save();

    return res.json({
      ok: true,
      message: "Task deleted",
    });
  } catch (err) {
    console.error("deleteTask error:", err);
    return res.status(500).json({
      ok: false,
      error: "Delete failed",
    });
  }
};

/* ---------------- USER TASKS ---------------- */

export const getMyOpenTasks = async (req, res) => {
  try {
    const tasks = await Task.find({
      firmId: req.user.firmId,
      assignedTo: req.user.id,
      isActive: true,
      status: { $in: ["NOT_STARTED", "WAITING_DOCS", "IN_PROGRESS"] },
    }).lean();

    res.json({ ok: true, tasks });
  } catch (err) {
    res.status(500).json({ ok: false, error: "Failed to load tasks" });
  }
};

/* ---------------- FOLLOWUP ---------------- */

export const postTaskFollowup = async (req, res) => {
  try {
    const task = await Task.findOne({
      _id: req.params.id,
      firmId: req.user.firmId,
      isActive: true,
    });

    if (!task) return res.status(404).json({ ok: false });

    task.meta = task.meta || {};
    task.meta.lastFollowUpAt = new Date().toISOString();
    await task.save();

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false });
  }
};

/* ---------------- ESCALATE ---------------- */

export const postTaskEscalate = async (req, res) => {
  try {
    const task = await Task.findOne({
      _id: req.params.id,
      firmId: req.user.firmId,
      isActive: true,
    });

    if (!task) return res.status(404).json({ ok: false });

    task.meta = task.meta || {};
    task.meta.escalated = true;
    task.meta.escalatedAt = new Date().toISOString();
    await task.save();

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false });
  }
};