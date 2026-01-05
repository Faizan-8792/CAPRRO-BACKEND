import mongoose from "mongoose";
import TaskDelayLog from "../models/TaskDelayLog.js";

export const createDelayLog = async (req, res) => {
  try {
    const firmId = req.user.firmId;
    const { taskId, reason, note } = req.body || {};
    console.log("[DelayLog] Request received:", { taskId, reason, note, firmId });
    
    if (!taskId || !reason) return res.status(400).json({ ok: false, error: "taskId and reason required" });

    // Validate ObjectId early so we can return a clear 400 (Mongoose otherwise throws CastError)
    if (!mongoose.Types.ObjectId.isValid(taskId)) {
      return res.status(400).json({ ok: false, error: "Invalid taskId", details: { taskId: "Must be a valid ObjectId" } });
    }

    // Validate reason enum early so UI gets clear error
    const allowedReasons = ["CLIENT_DELAY", "DOCUMENTS_PENDING", "STAFF_WORKLOAD", "TECHNICAL"]; 
    if (!allowedReasons.includes(reason)) {
      return res.status(400).json({ ok: false, error: "Invalid reason", details: { reason: `Must be one of: ${allowedReasons.join(", ")}` } });
    }

    if (!firmId) {
      // More explicit error when user's firm context is missing
      return res.status(400).json({ ok: false, error: "Firm context missing for this user" });
    }

    const log = new TaskDelayLog({ firmId, taskId, reason, note, createdBy: req.user.id });
    try {
      await log.save();
    } catch (saveErr) {
      // If validation error, return 400 with details to help debugging
      if (saveErr && saveErr.name === 'ValidationError') {
        const details = Object.keys(saveErr.errors || {}).reduce((acc, k) => {
          acc[k] = saveErr.errors[k].message;
          return acc;
        }, {});
        console.error("[DelayLog] Validation error details:", details);
        return res.status(400).json({ ok: false, error: 'Validation failed', details });
      }

      // CastError (commonly thrown for invalid ObjectId)
      if (saveErr && saveErr.name === 'CastError') {
        return res.status(400).json({ ok: false, error: 'Validation failed', details: { [saveErr.path]: saveErr.message } });
      }
      throw saveErr;
    }

    console.log("[DelayLog] Successfully created:", log._id);
    return res.json({ ok: true, id: log._id });
  } catch (err) {
    console.error("createDelayLog error", err);
    return res.status(500).json({ ok: false, error: "Failed to create delay log" });
  }
};

export const aggregateDelayReasons = async (req, res) => {
  try {
    const firmId = req.user.firmId;
    const sinceDays = Number(req.query.sinceDays || 30);
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);

    const agg = await TaskDelayLog.aggregate([
      { $match: { firmId, createdAt: { $gte: since } } },
      { $group: { _id: "$reason", count: { $sum: 1 } } },
    ]);

    const recent = await TaskDelayLog.find({ firmId }).sort({ createdAt: -1 }).limit(20).lean();
    return res.json({ ok: true, aggregate: agg, recent });
  } catch (err) {
    console.error("aggregateDelayReasons error", err);
    return res.status(500).json({ ok: false, error: "Failed to aggregate" });
  }
};

export const getTaskDelayLogs = async (req, res) => {
  try {
    const firmId = req.user.firmId;
    const { taskId } = req.params;
    if (!taskId) return res.status(400).json({ ok: false, error: "taskId required" });
    const logs = await TaskDelayLog.find({ firmId, taskId }).sort({ createdAt: -1 }).lean();
    return res.json({ ok: true, logs });
  } catch (err) {
    console.error("getTaskDelayLogs error", err);
    return res.status(500).json({ ok: false, error: "Failed to load logs" });
  }
};
