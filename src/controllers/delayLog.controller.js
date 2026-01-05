import TaskDelayLog from "../models/TaskDelayLog.js";

export const createDelayLog = async (req, res) => {
  try {
    const firmId = req.user.firmId;
    const { taskId, reason, note } = req.body || {};
    if (!taskId || !reason) return res.status(400).json({ ok: false, error: "taskId and reason required" });

    const log = new TaskDelayLog({ firmId, taskId, reason, note, createdBy: req.user.id });
    await log.save();
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
