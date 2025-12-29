import AccountingRecord from "../models/AccountingRecord.js";
import { cleanupExpiredAccountingRecords } from "../services/retention.service.js";

// -------- CREATE RECORD --------
export const createAccountingRecord = async (req, res) => {
  try {
    const user = req.user;
    const firmId = user.firmId;

    if (!firmId) {
      return res.status(400).json({ ok: false, error: "Firm not linked" });
    }

    const {
      clientName,
      periodKey,
      source,
      metrics,
      intelligence,
      retentionDays,
      meta = {},
    } = req.body || {};

    if (!clientName || !periodKey || !source || !intelligence || !retentionDays) {
      return res.status(400).json({ ok: false, error: "Missing required fields" });
    }

    const expiresAt =
      retentionDays === "FOREVER"
        ? new Date("2999-12-31")
        : new Date(Date.now() + Number(retentionDays) * 24 * 60 * 60 * 1000);

    const record = new AccountingRecord({
      firmId,
      createdBy: user.id,
      clientName,
      periodKey,
      source,
      totalEntries: metrics?.totalEntries || 0,
      totalDebit: metrics?.totalDebit || 0,
      totalCredit: metrics?.totalCredit || 0,
      roundFigureCount: metrics?.roundFigureCount || 0,
      lastEntryDate: metrics?.lastEntryDate || null,
      health: intelligence.health,
      readinessScore: intelligence.readinessScore,
      riskFlags: intelligence.riskFlags || [],
      summaryNotes: intelligence.summaryNotes || "",
      expiresAt,
      meta,
    });

    await record.save();

    res.json({ ok: true, record });
  } catch (err) {
    console.error("createAccountingRecord error:", err);
    res.status(500).json({ ok: false, error: "Failed to create record" });
  }
};

// -------- LIST RECORDS --------
export const listAccountingRecords = async (req, res) => {
  try {
    const user = req.user;
    const firmId = user.firmId;

    if (!firmId) {
      return res.status(400).json({ ok: false, error: "Firm not linked" });
    }

    // Cleanup expired first
    await cleanupExpiredAccountingRecords(firmId);

    const records = await AccountingRecord.find({ firmId })
      .sort({ createdAt: -1 })
      .lean();

    res.json({ ok: true, records });
  } catch (err) {
    console.error("listAccountingRecords error:", err);
    res.status(500).json({ ok: false, error: "Failed to load records" });
  }
};

// -------- GET SINGLE --------
export const getAccountingRecord = async (req, res) => {
  try {
    const { id } = req.params;
    const firmId = req.user.firmId;

    const record = await AccountingRecord.findOne({ _id: id, firmId }).lean();

    if (!record) {
      return res.status(404).json({ ok: false, error: "Record not found" });
    }

    res.json({ ok: true, record });
  } catch (err) {
    res.status(500).json({ ok: false, error: "Failed to load record" });
  }
};

// -------- DELETE (PERMANENT) --------
export const deleteAccountingRecord = async (req, res) => {
  try {
    const { id } = req.params;
    const firmId = req.user.firmId;

    await AccountingRecord.deleteOne({ _id: id, firmId });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: "Failed to delete record" });
  }
};
