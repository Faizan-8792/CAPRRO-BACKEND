import DocumentRequest from "../models/DocumentRequest.js";

export const createDocumentRequest = async (req, res) => {
  try {
    const firmId = req.user.firmId;
    const { clientId, clientName, items = [], dueDateISO, meta } = req.body || {};
    if (!clientId && !clientName) {
      return res.status(400).json({ ok: false, error: "clientId or clientName required" });
    }

    const dr = new DocumentRequest({
      firmId,
      clientId,
      clientName,
      items,
      dueDateISO,
      meta,
      createdBy: req.user.id,
    });

    await dr.save();
    return res.status(201).json({ ok: true, request: dr });
  } catch (err) {
    console.error("createDocumentRequest error", err);
    return res.status(500).json({ ok: false, error: "Failed to create document request" });
  }
};

export const listDocumentRequests = async (req, res) => {
  try {
    const firmId = req.user.firmId;
    const { status, clientId } = req.query;
    const q = { firmId };
    if (status) q.status = status;
    if (clientId) q.clientId = clientId;

    const docs = await DocumentRequest.find(q).sort({ createdAt: -1 }).limit(500).lean();
    return res.json({ ok: true, data: docs });
  } catch (err) {
    console.error("listDocumentRequests error", err);
    return res.status(500).json({ ok: false, error: "Failed to list document requests" });
  }
};

export const updateDocumentRequest = async (req, res) => {
  try {
    const firmId = req.user.firmId;
    const { id } = req.params;
    const payload = req.body || {};

    const doc = await DocumentRequest.findOne({ _id: id, firmId });
    if (!doc) return res.status(404).json({ ok: false, error: "Not found" });

    // Allow updating status or item statuses
    if (payload.status) doc.status = payload.status;
    if (Array.isArray(payload.items)) {
      // merge items by key
      for (const it of payload.items) {
        const idx = doc.items.findIndex((x) => x.key === it.key);
        if (idx >= 0) {
          doc.items[idx] = { ...doc.items[idx].toObject(), ...it, updatedAt: new Date() };
        } else {
          doc.items.push({ ...it, updatedAt: new Date() });
        }
      }
    }

    doc.updatedAt = new Date();
    await doc.save();
    return res.json({ ok: true, request: doc });
  } catch (err) {
    console.error("updateDocumentRequest error", err);
    return res.status(500).json({ ok: false, error: "Failed to update" });
  }
};

export const pendingSummary = async (req, res) => {
  try {
    const firmId = req.user.firmId;
    const pipeline = [
      { $match: { firmId: req.user.firmId } },
      { $unwind: { path: "$items", preserveNullAndEmptyArrays: true } },
      { $group: { _id: "$items.status", count: { $sum: 1 } } },
    ];
    const agg = await DocumentRequest.aggregate(pipeline);
    const counts = {};
    agg.forEach((r) => (counts[r._id || "UNKNOWN"] = r.count));

    const recent = await DocumentRequest.find({ firmId, status: "REQUESTED" })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    return res.json({ ok: true, counts, recent });
  } catch (err) {
    console.error("pendingSummary error", err);
    return res.status(500).json({ ok: false, error: "Failed to compute summary" });
  }
};
