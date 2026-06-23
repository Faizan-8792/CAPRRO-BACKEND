// src/controllers/taxworker.controller.js
import mongoose from "mongoose";
import Client from "../models/Client.js";
import TaxWorkSession, { TAX_TYPES, STATUSES } from "../models/TaxWorkSession.js";
import {
  TAX_TEMPLATES,
  listTaxTypes,
  getTemplateDocuments,
  suggestPeriodAndDueDate,
} from "../config/tax-templates.js";

function getScope(user) {
  // Returns the filter that scopes queries to the user's data.
  // - Firm-linked user: see firm-shared data
  // - Solo user: see only their own data (firmId is null + ownerUserId match)
  if (!user) {
    const err = new Error("Unauthorized");
    err.statusCode = 401;
    throw err;
  }
  if (user.firmId) return { firmId: user.firmId };
  return { firmId: null, ownerUserId: user.id };
}

function getOwnership(user) {
  // Returns the fields to set when creating new docs.
  return {
    firmId: user.firmId || null,
    ownerUserId: user.id,
  };
}

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(String(id || ""));
}

// ─── Templates ──────────────────────────────────────────────────────
export const getTemplates = async (req, res, next) => {
  try {
    getScope(req.user);
    const list = listTaxTypes().map((t) => ({
      ...t,
      documents: getTemplateDocuments(t.code),
      defaultDueDay: TAX_TEMPLATES[t.code]?.defaultDueDay || 0,
    }));
    return res.json({ ok: true, templates: list, statuses: STATUSES });
  } catch (err) {
    next(err);
  }
};

// ─── Clients ────────────────────────────────────────────────────────
export const listClients = async (req, res, next) => {
  try {
    const scope = getScope(req.user);
    const { search = "", limit = 200 } = req.query || {};

    const filter = { ...scope, isActive: true };
    if (search) {
      const safe = String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(safe, "i");
      filter.$or = [{ name: re }, { gstin: re }, { pan: re }];
    }

    const clients = await Client.find(filter)
      .sort({ name: 1 })
      .limit(Math.min(Number(limit) || 200, 500))
      .lean();

    return res.json({ ok: true, clients });
  } catch (err) {
    next(err);
  }
};

export const createClient = async (req, res, next) => {
  try {
    const own = getOwnership(req.user);
    const { name, gstin, pan, contactPerson, phone, email, notes } = req.body || {};

    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ ok: false, error: "name required" });
    }

    const client = new Client({
      ...own,
      name: name.trim(),
      gstin: gstin?.trim().toUpperCase() || undefined,
      pan: pan?.trim().toUpperCase() || undefined,
      contactPerson: contactPerson?.trim() || undefined,
      phone: phone?.trim() || undefined,
      email: email?.trim().toLowerCase() || undefined,
      notes: notes?.trim() || undefined,
      createdBy: req.user.id,
    });

    await client.save();
    return res.json({ ok: true, client });
  } catch (err) {
    next(err);
  }
};

export const updateClient = async (req, res, next) => {
  try {
    const scope = getScope(req.user);
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ ok: false, error: "Invalid client id" });
    }

    const client = await Client.findOne({ _id: id, ...scope });
    if (!client) return res.status(404).json({ ok: false, error: "Client not found" });

    const editable = ["name", "gstin", "pan", "contactPerson", "phone", "email", "notes"];
    for (const key of editable) {
      if (key in req.body) {
        let v = req.body[key];
        if (typeof v === "string") v = v.trim();
        if (key === "gstin" || key === "pan") v = (v || "").toUpperCase();
        if (key === "email") v = (v || "").toLowerCase();
        client[key] = v || undefined;
      }
    }

    await client.save();
    return res.json({ ok: true, client });
  } catch (err) {
    next(err);
  }
};

export const deleteClient = async (req, res, next) => {
  try {
    const scope = getScope(req.user);
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ ok: false, error: "Invalid client id" });
    }
    const client = await Client.findOne({ _id: id, ...scope });
    if (!client) return res.status(404).json({ ok: false, error: "Client not found" });
    client.isActive = false;
    await client.save();
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
};

// ─── Sessions ───────────────────────────────────────────────────────
export const listSessions = async (req, res, next) => {
  try {
    const scope = getScope(req.user);
    const { clientId, taxType, status, assignedTo, mine } = req.query || {};

    const filter = { ...scope, status: { $ne: "ARCHIVED" } };
    if (clientId && isValidObjectId(clientId)) filter.clientId = clientId;
    if (taxType && TAX_TYPES.includes(taxType)) filter.taxType = taxType;
    if (status && STATUSES.includes(status)) filter.status = status;
    if (assignedTo && isValidObjectId(assignedTo)) filter.assignedTo = assignedTo;
    if (mine === "1" || mine === "true") filter.assignedTo = req.user.id;

    const sessions = await TaxWorkSession.find(filter)
      .sort({ updatedAt: -1 })
      .populate("clientId", "name gstin pan")
      .populate("assignedTo", "name email")
      .limit(500)
      .lean();

    const enriched = sessions.map((s) => {
      const total = (s.documents || []).length;
      const required = (s.documents || []).filter((d) => d.required).length;
      const received = (s.documents || []).filter((d) => d.received).length;
      const requiredReceived = (s.documents || []).filter(
        (d) => d.required && d.received
      ).length;
      const pct = total ? Math.round((received / total) * 100) : 0;
      return {
        ...s,
        progress: { total, required, received, requiredReceived, percent: pct },
      };
    });

    return res.json({ ok: true, sessions: enriched });
  } catch (err) {
    next(err);
  }
};

export const getSession = async (req, res, next) => {
  try {
    const scope = getScope(req.user);
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ ok: false, error: "Invalid session id" });
    }
    const session = await TaxWorkSession.findOne({ _id: id, ...scope })
      .populate("clientId", "name gstin pan email phone contactPerson")
      .populate("assignedTo", "name email")
      .populate("createdBy", "name email")
      .lean();
    if (!session) return res.status(404).json({ ok: false, error: "Session not found" });
    return res.json({ ok: true, session });
  } catch (err) {
    next(err);
  }
};

export const createSession = async (req, res, next) => {
  try {
    const scope = getScope(req.user);
    const own = getOwnership(req.user);
    const { clientId, taxType, period, dueDate, assignedTo, notes } = req.body || {};

    if (!isValidObjectId(clientId)) {
      return res.status(400).json({ ok: false, error: "Valid clientId required" });
    }
    if (!TAX_TYPES.includes(taxType)) {
      return res.status(400).json({ ok: false, error: "Invalid taxType" });
    }

    const client = await Client.findOne({ _id: clientId, ...scope, isActive: true });
    if (!client) {
      return res.status(404).json({ ok: false, error: "Client not found in your scope" });
    }

    const docs = getTemplateDocuments(taxType).map((d) => ({
      ...d,
      received: false,
      receivedAt: null,
      receivedByUserId: null,
      notes: "",
      isCustom: false,
    }));

    let finalPeriod = period;
    let finalDueDate = dueDate ? new Date(dueDate) : null;
    if (!finalPeriod || !finalDueDate) {
      const auto = suggestPeriodAndDueDate(taxType);
      if (!finalPeriod) finalPeriod = auto.period;
      if (!finalDueDate && auto.dueDate) finalDueDate = new Date(auto.dueDate);
    }

    let assignedToId = null;
    if (assignedTo && isValidObjectId(assignedTo)) assignedToId = assignedTo;

    const session = new TaxWorkSession({
      ...own,
      clientId,
      taxType,
      period: finalPeriod || "",
      dueDate: finalDueDate,
      status: "DRAFT",
      documents: docs,
      assignedTo: assignedToId,
      createdBy: req.user.id,
      notes: notes || "",
    });

    await session.save();
    return res.json({ ok: true, session });
  } catch (err) {
    next(err);
  }
};

export const updateSession = async (req, res, next) => {
  try {
    const scope = getScope(req.user);
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ ok: false, error: "Invalid session id" });
    }
    const session = await TaxWorkSession.findOne({ _id: id, ...scope });
    if (!session) return res.status(404).json({ ok: false, error: "Session not found" });

    const { period, dueDate, status, assignedTo, notes } = req.body || {};

    if (typeof period === "string") session.period = period.trim();
    if (dueDate === null) session.dueDate = null;
    else if (dueDate) session.dueDate = new Date(dueDate);
    if (status && STATUSES.includes(status)) {
      session.status = status;
      if (status === "COMPLETE" && !session.completedAt) {
        session.completedAt = new Date();
      }
      if (status !== "COMPLETE") session.completedAt = null;
    }
    if (assignedTo === null) session.assignedTo = null;
    else if (assignedTo && isValidObjectId(assignedTo)) session.assignedTo = assignedTo;
    if (typeof notes === "string") session.notes = notes;

    await session.save();
    return res.json({ ok: true, session });
  } catch (err) {
    next(err);
  }
};

export const updateDocument = async (req, res, next) => {
  try {
    const scope = getScope(req.user);
    const { id, docKey } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ ok: false, error: "Invalid session id" });
    }

    const session = await TaxWorkSession.findOne({ _id: id, ...scope });
    if (!session) return res.status(404).json({ ok: false, error: "Session not found" });

    const doc = session.documents.find((d) => d.docKey === docKey);
    if (!doc) return res.status(404).json({ ok: false, error: "Document not found" });

    const { received, notes, required, name } = req.body || {};

    if (typeof received === "boolean") {
      doc.received = received;
      doc.receivedAt = received ? new Date() : null;
      doc.receivedByUserId = received ? req.user.id : null;
    }
    if (typeof notes === "string") doc.notes = notes;
    if (typeof required === "boolean") doc.required = required;
    if (typeof name === "string" && name.trim()) doc.name = name.trim();

    const allRequiredReceived =
      session.documents.length > 0 &&
      session.documents.filter((d) => d.required).every((d) => d.received);
    if (session.status === "DRAFT" && session.documents.some((d) => d.received)) {
      session.status = "IN_PROGRESS";
    }

    await session.save();
    return res.json({
      ok: true,
      session,
      hint: allRequiredReceived ? "ready_to_complete" : "in_progress",
    });
  } catch (err) {
    next(err);
  }
};

export const addCustomDocument = async (req, res, next) => {
  try {
    const scope = getScope(req.user);
    const { id } = req.params;
    const { name, required } = req.body || {};
    if (!isValidObjectId(id)) {
      return res.status(400).json({ ok: false, error: "Invalid session id" });
    }
    if (!name || !String(name).trim()) {
      return res.status(400).json({ ok: false, error: "name required" });
    }

    const session = await TaxWorkSession.findOne({ _id: id, ...scope });
    if (!session) return res.status(404).json({ ok: false, error: "Session not found" });

    const slug = String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60);

    let docKey = `custom_${slug}`;
    let suffix = 1;
    while (session.documents.find((d) => d.docKey === docKey)) {
      docKey = `custom_${slug}_${suffix++}`;
    }

    session.documents.push({
      docKey,
      name: String(name).trim(),
      required: required === true,
      received: false,
      receivedAt: null,
      receivedByUserId: null,
      notes: "",
      isCustom: true,
    });

    await session.save();
    return res.json({ ok: true, session });
  } catch (err) {
    next(err);
  }
};

export const removeCustomDocument = async (req, res, next) => {
  try {
    const scope = getScope(req.user);
    const { id, docKey } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ ok: false, error: "Invalid session id" });
    }

    const session = await TaxWorkSession.findOne({ _id: id, ...scope });
    if (!session) return res.status(404).json({ ok: false, error: "Session not found" });

    const before = session.documents.length;
    session.documents = session.documents.filter(
      (d) => !(d.docKey === docKey && d.isCustom)
    );
    if (session.documents.length === before) {
      return res
        .status(404)
        .json({ ok: false, error: "Custom document not found (built-ins cannot be removed)" });
    }

    await session.save();
    return res.json({ ok: true, session });
  } catch (err) {
    next(err);
  }
};

export const deleteSession = async (req, res, next) => {
  try {
    const scope = getScope(req.user);
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ ok: false, error: "Invalid session id" });
    }
    const session = await TaxWorkSession.findOne({ _id: id, ...scope });
    if (!session) return res.status(404).json({ ok: false, error: "Session not found" });
    session.status = "ARCHIVED";
    await session.save();
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
};

// ─── Stats ──────────────────────────────────────────────────────────
export const getStats = async (req, res, next) => {
  try {
    const scope = getScope(req.user);

    const [totalSessions, draftSessions, inProgressSessions, completeSessions] =
      await Promise.all([
        TaxWorkSession.countDocuments({ ...scope, status: { $ne: "ARCHIVED" } }),
        TaxWorkSession.countDocuments({ ...scope, status: "DRAFT" }),
        TaxWorkSession.countDocuments({ ...scope, status: "IN_PROGRESS" }),
        TaxWorkSession.countDocuments({ ...scope, status: "COMPLETE" }),
      ]);

    const totalClients = await Client.countDocuments({ ...scope, isActive: true });

    // Build aggregation match - convert ObjectIds where present
    const aggMatch = { status: { $in: ["DRAFT", "IN_PROGRESS"] } };
    if (scope.firmId) {
      aggMatch.firmId = new mongoose.Types.ObjectId(scope.firmId);
    } else {
      aggMatch.firmId = null;
      aggMatch.ownerUserId = new mongoose.Types.ObjectId(scope.ownerUserId);
    }

    const pendingAgg = await TaxWorkSession.aggregate([
      { $match: aggMatch },
      { $unwind: "$documents" },
      { $match: { "documents.required": true, "documents.received": false } },
      { $count: "pending" },
    ]);
    const pendingRequired = pendingAgg[0]?.pending || 0;

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const overdueSessions = await TaxWorkSession.countDocuments({
      ...scope,
      status: { $in: ["DRAFT", "IN_PROGRESS"] },
      dueDate: { $lt: today },
    });

    return res.json({
      ok: true,
      mode: scope.firmId ? "firm" : "solo",
      stats: {
        totalSessions,
        draftSessions,
        inProgressSessions,
        completeSessions,
        totalClients,
        pendingRequired,
        overdueSessions,
      },
    });
  } catch (err) {
    next(err);
  }
};
