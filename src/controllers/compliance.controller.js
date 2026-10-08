import mongoose from "mongoose";
import Client, {
  APPLICABILITY_STATUSES,
  ENTITY_TYPES,
} from "../models/Client.js";
import ComplianceRule, {
  DUE_DATE_POLICIES,
  RULE_FREQUENCIES,
  RULE_STATUSES,
} from "../models/ComplianceRule.js";
import ComplianceOverride, {
  OVERRIDE_ACTIONS,
} from "../models/ComplianceOverride.js";
import Firm from "../models/Firm.js";
import { safeRecordActivity } from "../services/activity.service.js";
import { resolveApplicableComplianceRule } from "../services/compliance-period.service.js";
import { parseStatutoryDayIso } from "../services/robust-normalize.service.js";

const PROFILE_FREQUENCIES = Object.freeze([
  "MONTHLY",
  "QUARTERLY",
  "ANNUAL",
  "EVENT_DRIVEN",
  "OTHER",
]);
const TASK_SERVICE_TYPES = Object.freeze([
  "GST",
  "TDS",
  "ITR",
  "ROC",
  "AUDIT",
  "OTHER",
]);
const RULE_CODE_PATTERN = /^[A-Z0-9_]+$/;
const MAX_PAGE_SIZE = 100;
const CLIENT_PROFILE_SELECT = [
  "name",
  "+entityType",
  "+tan",
  "+clientCode",
  "+tags",
  "+complianceProfile",
  "+profileReviewedAt",
  "+profileReviewedBy",
  "updatedAt",
].join(" ");

const PROFILE_WRITE_FIELDS = new Set([
  "entityType",
  "tan",
  "clientCode",
  "tags",
  "complianceProfile",
]);
const RULE_MUTABLE_FIELDS = new Set([
  "title",
  "frequency",
  "entityTypes",
  "dueDatePolicy",
  "generationPolicy",
  "defaultReminderOffsets",
  "effectiveFrom",
  "effectiveTo",
  "sourceReference",
]);
const RULE_CREATE_FIELDS = new Set([
  "firmId",
  "code",
  ...RULE_MUTABLE_FIELDS,
]);
const OVERRIDE_WRITE_FIELDS = new Set([
  "clientId",
  "ruleCode",
  "period",
  "action",
  "dueDate",
  "reason",
]);

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function assertObjectBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw httpError(400, "JSON object body is required");
  }
  return body;
}

function assertAllowedFields(body, allowedFields) {
  const unknownFields = Object.keys(body).filter(
    (field) => !allowedFields.has(field)
  );
  if (unknownFields.length) {
    throw httpError(400, `Unknown fields: ${unknownFields.join(", ")}`);
  }
}

function requireObjectId(value, fieldName) {
  if (!mongoose.Types.ObjectId.isValid(String(value || ""))) {
    throw httpError(400, `Invalid ${fieldName}`);
  }
  return value;
}

function normalizeRequiredText(value, fieldName, maxLength) {
  const normalized = String(value || "").trim();
  if (!normalized) throw httpError(400, `${fieldName} is required`);
  if (normalized.length > maxLength) {
    throw httpError(400, `${fieldName} exceeds ${maxLength} characters`);
  }
  return normalized;
}

function parseDate(value, fieldName, { nullable = false } = {}) {
  if (nullable && (value === null || value === "")) return null;
  // Strict on purpose -- new Date(string) silently mis-reads an ambiguous DD-MM/MM-DD
  // date, and this gates a reviewed compliance due-date override. See
  // parseStatutoryDayIso's remarks in robust-normalize.service.js.
  try {
    return parseStatutoryDayIso(value, fieldName);
  } catch (error) {
    throw httpError(error.statusCode || 400, error.message);
  }
}

function parseLimit(value) {
  const parsed = Number(value ?? 50);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw httpError(400, "limit must be a positive integer");
  }
  return Math.min(parsed, MAX_PAGE_SIZE);
}

function applyCursor(filter, cursor) {
  if (!cursor) return;
  requireObjectId(cursor, "cursor");
  filter._id = { $lt: cursor };
}

function normalizeRuleCode(value) {
  const code = normalizeRequiredText(value, "code", 80).toUpperCase();
  if (!RULE_CODE_PATTERN.test(code)) {
    throw httpError(400, "code may contain only A-Z, 0-9, and underscore");
  }
  return code;
}

function normalizeOffsets(value, fieldName = "reminderOffsets") {
  if (!Array.isArray(value) || value.length > 50) {
    throw httpError(400, `${fieldName} must be an array of at most 50 values`);
  }
  const values = value.map((offset) => {
    if (!Number.isInteger(offset) || offset < -365 || offset > 365) {
      throw httpError(
        400,
        `${fieldName} values must be whole days between -365 and 365`
      );
    }
    return offset;
  });
  return [...new Set(values)].sort((left, right) => left - right);
}

function normalizeTags(value) {
  if (!Array.isArray(value) || value.length > 50) {
    throw httpError(400, "tags must be an array of at most 50 values");
  }
  return [
    ...new Set(
      value
        .map((tag) => String(tag || "").trim())
        .filter(Boolean)
        .map((tag) => tag.slice(0, 80))
    ),
  ];
}

function normalizeComplianceProfile(value, actorUserId) {
  if (!Array.isArray(value) || value.length > 100) {
    throw httpError(
      400,
      "complianceProfile must be an array of at most 100 entries"
    );
  }

  const seenCodes = new Set();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw httpError(400, `complianceProfile[${index}] must be an object`);
    }
    const allowedFields = new Set([
      "code",
      "applicability",
      "frequency",
      "reminderOffsets",
      "notes",
    ]);
    assertAllowedFields(entry, allowedFields);

    const code = normalizeRuleCode(entry.code);
    if (seenCodes.has(code)) {
      throw httpError(400, `Duplicate compliance profile code: ${code}`);
    }
    seenCodes.add(code);

    const applicability = String(
      entry.applicability || "NEEDS_REVIEW"
    ).toUpperCase();
    if (!APPLICABILITY_STATUSES.includes(applicability)) {
      throw httpError(400, `Invalid applicability for ${code}`);
    }

    const frequency = String(entry.frequency || "OTHER").toUpperCase();
    if (!PROFILE_FREQUENCIES.includes(frequency)) {
      throw httpError(400, `Invalid frequency for ${code}`);
    }

    const notes = String(entry.notes || "").trim();
    if (notes.length > 500) {
      throw httpError(400, `notes exceeds 500 characters for ${code}`);
    }

    return {
      code,
      applicability,
      frequency,
      reminderOffsets: normalizeOffsets(entry.reminderOffsets || []),
      notes,
      updatedAt: new Date(),
      updatedBy: actorUserId,
    };
  });
}

function normalizeDueDatePolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw httpError(400, "dueDatePolicy must be an object");
  }
  const allowedFields = new Set(["type", "day", "monthOffset", "offsetDays"]);
  assertAllowedFields(value, allowedFields);

  const type = String(value.type || "").toUpperCase();
  if (!DUE_DATE_POLICIES.includes(type)) {
    throw httpError(400, "Invalid dueDatePolicy.type");
  }

  const output = { type };
  for (const [field, min, max] of [
    ["day", 1, 31],
    ["monthOffset", 0, 24],
    ["offsetDays", -365, 730],
  ]) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) continue;
    if (!Number.isInteger(value[field]) || value[field] < min || value[field] > max) {
      throw httpError(400, `${field} must be a whole number from ${min} to ${max}`);
    }
    output[field] = value[field];
  }

  if (type === "DAY_OF_MONTH" && !Number.isInteger(output.day)) {
    throw httpError(400, "DAY_OF_MONTH requires day");
  }
  return output;
}

function normalizeGenerationPolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw httpError(400, "generationPolicy must be an object");
  }
  const allowedFields = new Set([
    "createTask",
    "createTaxWorkSession",
    "createReminder",
    "taskServiceType",
    "taxWorkType",
    "titleTemplate",
  ]);
  assertAllowedFields(value, allowedFields);

  const output = {};
  for (const field of [
    "createTask",
    "createTaxWorkSession",
    "createReminder",
  ]) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) continue;
    if (typeof value[field] !== "boolean") {
      throw httpError(400, `${field} must be boolean`);
    }
    output[field] = value[field];
  }

  if (Object.prototype.hasOwnProperty.call(value, "taskServiceType")) {
    const serviceType = String(value.taskServiceType || "").toUpperCase();
    if (!TASK_SERVICE_TYPES.includes(serviceType)) {
      throw httpError(400, "Invalid taskServiceType");
    }
    output.taskServiceType = serviceType;
  }
  if (Object.prototype.hasOwnProperty.call(value, "taxWorkType")) {
    output.taxWorkType = normalizeRequiredText(
      value.taxWorkType,
      "taxWorkType",
      80
    ).toUpperCase();
  }
  if (Object.prototype.hasOwnProperty.call(value, "titleTemplate")) {
    output.titleTemplate = normalizeRequiredText(
      value.titleTemplate,
      "titleTemplate",
      240
    );
  }
  return output;
}

function buildRulePayload(body) {
  const payload = {};

  if (Object.prototype.hasOwnProperty.call(body, "title")) {
    payload.title = normalizeRequiredText(body.title, "title", 200);
  }
  if (Object.prototype.hasOwnProperty.call(body, "frequency")) {
    const frequency = String(body.frequency || "").toUpperCase();
    if (!RULE_FREQUENCIES.includes(frequency)) {
      throw httpError(400, "Invalid frequency");
    }
    payload.frequency = frequency;
  }
  if (Object.prototype.hasOwnProperty.call(body, "entityTypes")) {
    if (!Array.isArray(body.entityTypes) || body.entityTypes.length > 30) {
      throw httpError(400, "entityTypes must be an array of at most 30 values");
    }
    const entityTypes = [
      ...new Set(
        body.entityTypes.map((entityType) =>
          String(entityType || "").toUpperCase()
        )
      ),
    ];
    const invalid = entityTypes.filter(
      (entityType) => !ENTITY_TYPES.includes(entityType)
    );
    if (invalid.length) {
      throw httpError(400, `Invalid entity types: ${invalid.join(", ")}`);
    }
    payload.entityTypes = entityTypes;
  }
  if (Object.prototype.hasOwnProperty.call(body, "dueDatePolicy")) {
    payload.dueDatePolicy = normalizeDueDatePolicy(body.dueDatePolicy);
  }
  if (Object.prototype.hasOwnProperty.call(body, "generationPolicy")) {
    payload.generationPolicy = normalizeGenerationPolicy(body.generationPolicy);
  }
  if (Object.prototype.hasOwnProperty.call(body, "defaultReminderOffsets")) {
    payload.defaultReminderOffsets = normalizeOffsets(
      body.defaultReminderOffsets,
      "defaultReminderOffsets"
    );
  }
  if (Object.prototype.hasOwnProperty.call(body, "effectiveFrom")) {
    payload.effectiveFrom = parseDate(body.effectiveFrom, "effectiveFrom");
  }
  if (Object.prototype.hasOwnProperty.call(body, "effectiveTo")) {
    payload.effectiveTo = parseDate(body.effectiveTo, "effectiveTo", {
      nullable: true,
    });
  }
  if (Object.prototype.hasOwnProperty.call(body, "sourceReference")) {
    const sourceReference = String(body.sourceReference || "").trim();
    if (sourceReference.length > 1000) {
      throw httpError(400, "sourceReference exceeds 1000 characters");
    }
    payload.sourceReference = sourceReference;
  }

  return payload;
}

function profileView(client) {
  return {
    clientId: client._id,
    name: client.name,
    entityType: client.entityType,
    tan: client.tan || "",
    clientCode: client.clientCode || "",
    tags: client.tags || [],
    complianceProfile: client.complianceProfile || [],
    profileReviewedAt: client.profileReviewedAt || null,
    profileReviewedBy: client.profileReviewedBy || null,
    updatedAt: client.updatedAt,
  };
}

function ruleSummary(rule) {
  return {
    id: rule._id,
    firmId: rule.firmId || null,
    code: rule.code,
    version: rule.version,
    title: rule.title,
    status: rule.status,
    frequency: rule.frequency,
    effectiveFrom: rule.effectiveFrom,
    effectiveTo: rule.effectiveTo || null,
    sourceReference: rule.sourceReference || "",
    reviewedBy: rule.reviewedBy || null,
    reviewedAt: rule.reviewedAt || null,
  };
}

function overrideSummary(override) {
  return {
    id: override._id,
    clientId: override.clientId,
    ruleId: override.ruleId,
    ruleVersion: override.ruleVersion,
    ruleCode: override.ruleCode,
    period: override.period,
    periodStart: override.periodStart,
    periodEnd: override.periodEnd,
    action: override.action,
    dueDate: override.dueDate || null,
    reason: override.reason,
    reviewedBy: override.reviewedBy,
    reviewedAt: override.reviewedAt,
  };
}

function forwardKnownError(error, next) {
  if (!error.statusCode && ["ValidationError", "CastError"].includes(error.name)) {
    error.statusCode = 400;
  }
  if (!error.statusCode && error.name === "VersionError") {
    error.statusCode = 409;
    error.message = "Record changed concurrently; reload and retry";
  }
  if (!error.statusCode && error.code === 11000) {
    error.statusCode = 409;
    error.message = "A record with this unique key already exists";
  }
  return next(error);
}

async function recordRuleActivity(req, action, beforeSummary, afterSummary, rule) {
  await safeRecordActivity({
    firmId: rule.firmId || null,
    actorUserId: req.user.id,
    source: "SUPER_ADMIN",
    action,
    entityType: "ComplianceRule",
    entityId: rule._id,
    beforeSummary,
    afterSummary,
    requestId: req.id,
  });
}

export async function getClientComplianceProfile(req, res, next) {
  try {
    requireObjectId(req.params.clientId, "client id");
    const client = await Client.findOne({
      _id: req.params.clientId,
      firmId: req.user.firmId,
      isActive: true,
    })
      .select(CLIENT_PROFILE_SELECT)
      .lean();
    if (!client) throw httpError(404, "Client not found");

    return res.json({
      ok: true,
      profile: profileView(client),
      requestId: req.id || "",
    });
  } catch (error) {
    return forwardKnownError(error, next);
  }
}

export async function updateClientComplianceProfile(req, res, next) {
  try {
    const body = assertObjectBody(req.body);
    assertAllowedFields(body, PROFILE_WRITE_FIELDS);
    if (!Object.keys(body).length) throw httpError(400, "No profile fields supplied");
    requireObjectId(req.params.clientId, "client id");

    const client = await Client.findOne({
      _id: req.params.clientId,
      firmId: req.user.firmId,
      isActive: true,
    }).select(CLIENT_PROFILE_SELECT);
    if (!client) throw httpError(404, "Client not found");

    const before = profileView(client.toObject());

    if (Object.prototype.hasOwnProperty.call(body, "entityType")) {
      const entityType = String(body.entityType || "").toUpperCase();
      if (!ENTITY_TYPES.includes(entityType)) {
        throw httpError(400, "Invalid entityType");
      }
      client.entityType = entityType;
    }
    for (const field of ["tan", "clientCode"]) {
      if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
      const value = String(body[field] || "").trim().toUpperCase();
      if (value.length > 80) {
        throw httpError(400, `${field} exceeds 80 characters`);
      }
      client[field] = value || undefined;
    }
    if (Object.prototype.hasOwnProperty.call(body, "tags")) {
      client.tags = normalizeTags(body.tags);
    }
    if (Object.prototype.hasOwnProperty.call(body, "complianceProfile")) {
      client.complianceProfile = normalizeComplianceProfile(
        body.complianceProfile,
        req.user.id
      );
    }

    client.profileReviewedAt = new Date();
    client.profileReviewedBy = req.user.id;
    await client.save();

    const after = profileView(client.toObject());
    await safeRecordActivity({
      firmId: req.user.firmId,
      actorUserId: req.user.id,
      source: "USER",
      action: "CLIENT_COMPLIANCE_PROFILE_UPDATED",
      entityType: "Client",
      entityId: client._id,
      beforeSummary: before,
      afterSummary: after,
      requestId: req.id,
    });

    return res.json({
      ok: true,
      profile: after,
      requestId: req.id || "",
    });
  } catch (error) {
    return forwardKnownError(error, next);
  }
}

export async function listActiveComplianceRules(req, res, next) {
  try {
    const asOf = req.query.asOf
      ? parseDate(req.query.asOf, "asOf")
      : new Date();
    const conditions = [
      { $or: [{ effectiveTo: null }, { effectiveTo: { $gte: asOf } }] },
    ];

    if (req.query.entityType) {
      const entityType = String(req.query.entityType).toUpperCase();
      if (!ENTITY_TYPES.includes(entityType)) {
        throw httpError(400, "Invalid entityType");
      }
      conditions.push({
        $or: [{ entityTypes: { $size: 0 } }, { entityTypes: entityType }],
      });
    }

    const rules = await ComplianceRule.find({
      firmId: { $in: [null, req.user.firmId] },
      status: "ACTIVE",
      reviewedBy: { $ne: null },
      reviewedAt: { $ne: null },
      sourceReference: { $nin: [null, ""] },
      effectiveFrom: { $lte: asOf },
      $and: conditions,
    })
      .sort({ code: 1, version: -1 })
      .lean();

    const selectedByCode = new Map();
    for (const rule of rules) {
      const current = selectedByCode.get(rule.code);
      const ruleIsFirmSpecific = Boolean(rule.firmId);
      const currentIsFirmSpecific = Boolean(current?.firmId);
      if (
        !current ||
        (ruleIsFirmSpecific && !currentIsFirmSpecific) ||
        (ruleIsFirmSpecific === currentIsFirmSpecific &&
          rule.version > current.version)
      ) {
        selectedByCode.set(rule.code, rule);
      }
    }

    return res.json({
      ok: true,
      asOf: asOf.toISOString(),
      rules: [...selectedByCode.values()],
      requestId: req.id || "",
    });
  } catch (error) {
    return forwardKnownError(error, next);
  }
}

export async function listManagedComplianceRules(req, res, next) {
  try {
    const limit = parseLimit(req.query.limit);
    const filter = {};
    applyCursor(filter, req.query.cursor);

    if (req.query.status) {
      const status = String(req.query.status).toUpperCase();
      if (!RULE_STATUSES.includes(status)) throw httpError(400, "Invalid status");
      filter.status = status;
    }
    if (req.query.code) filter.code = normalizeRuleCode(req.query.code);
    if (req.query.firmId === "global") {
      filter.firmId = null;
    } else if (req.query.firmId) {
      filter.firmId = requireObjectId(req.query.firmId, "firmId");
    }

    const rules = await ComplianceRule.find(filter)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .lean();
    const hasMore = rules.length > limit;
    if (hasMore) rules.pop();

    return res.json({
      ok: true,
      rules,
      pagination: {
        limit,
        hasMore,
        nextCursor: hasMore ? String(rules.at(-1)._id) : null,
      },
      requestId: req.id || "",
    });
  } catch (error) {
    return forwardKnownError(error, next);
  }
}

export async function createComplianceRule(req, res, next) {
  try {
    const body = assertObjectBody(req.body);
    assertAllowedFields(body, RULE_CREATE_FIELDS);
    const code = normalizeRuleCode(body.code);

    let firmId = null;
    if (body.firmId !== undefined && body.firmId !== null && body.firmId !== "") {
      firmId = requireObjectId(body.firmId, "firmId");
      const firmExists = await Firm.exists({ _id: firmId, isActive: true });
      if (!firmExists) throw httpError(404, "Firm not found");
    }

    const latest = await ComplianceRule.findOne({ firmId, code })
      .sort({ version: -1 })
      .select("version")
      .lean();
    const rule = new ComplianceRule({
      ...buildRulePayload(body),
      firmId,
      code,
      version: (latest?.version || 0) + 1,
      status: "DRAFT",
      createdBy: req.user.id,
      updatedBy: req.user.id,
    });
    await rule.save();

    await recordRuleActivity(
      req,
      "COMPLIANCE_RULE_CREATED",
      null,
      ruleSummary(rule),
      rule
    );

    return res.status(201).json({
      ok: true,
      rule,
      requestId: req.id || "",
    });
  } catch (error) {
    return forwardKnownError(error, next);
  }
}

export async function updateComplianceRule(req, res, next) {
  try {
    requireObjectId(req.params.ruleId, "rule id");
    const body = assertObjectBody(req.body);
    assertAllowedFields(body, RULE_MUTABLE_FIELDS);
    if (!Object.keys(body).length) throw httpError(400, "No rule fields supplied");

    const rule = await ComplianceRule.findById(req.params.ruleId);
    if (!rule) throw httpError(404, "Compliance rule not found");
    if (rule.status !== "DRAFT") {
      throw httpError(409, "Only draft rules can be edited");
    }

    const before = ruleSummary(rule);
    Object.assign(rule, buildRulePayload(body));
    rule.updatedBy = req.user.id;
    await rule.save();

    await recordRuleActivity(
      req,
      "COMPLIANCE_RULE_UPDATED",
      before,
      ruleSummary(rule),
      rule
    );

    return res.json({ ok: true, rule, requestId: req.id || "" });
  } catch (error) {
    return forwardKnownError(error, next);
  }
}

export async function submitComplianceRuleForReview(req, res, next) {
  try {
    requireObjectId(req.params.ruleId, "rule id");
    const body = assertObjectBody(req.body || {});
    assertAllowedFields(body, new Set());

    const rule = await ComplianceRule.findById(req.params.ruleId);
    if (!rule) throw httpError(404, "Compliance rule not found");
    if (rule.status !== "DRAFT") {
      throw httpError(409, "Only draft rules can enter review");
    }
    if (!rule.sourceReference) {
      throw httpError(400, "Official sourceReference is required before review");
    }

    const before = ruleSummary(rule);
    rule.status = "IN_REVIEW";
    rule.reviewedBy = null;
    rule.reviewedAt = null;
    rule.updatedBy = req.user.id;
    await rule.save();

    await recordRuleActivity(
      req,
      "COMPLIANCE_RULE_SUBMITTED_FOR_REVIEW",
      before,
      ruleSummary(rule),
      rule
    );

    return res.json({ ok: true, rule, requestId: req.id || "" });
  } catch (error) {
    return forwardKnownError(error, next);
  }
}

export async function reviewComplianceRule(req, res, next) {
  try {
    requireObjectId(req.params.ruleId, "rule id");
    const body = assertObjectBody(req.body || {});
    assertAllowedFields(body, new Set(["sourceReference"]));

    const rule = await ComplianceRule.findById(req.params.ruleId);
    if (!rule) throw httpError(404, "Compliance rule not found");
    if (rule.status !== "IN_REVIEW") {
      throw httpError(409, "Rule must be in review before approval");
    }

    if (Object.prototype.hasOwnProperty.call(body, "sourceReference")) {
      const reference = normalizeRequiredText(
        body.sourceReference,
        "sourceReference",
        1000
      );
      rule.sourceReference = reference;
    }
    if (!rule.sourceReference) {
      throw httpError(400, "Official sourceReference is required for approval");
    }

    const before = ruleSummary(rule);
    rule.reviewedBy = req.user.id;
    rule.reviewedAt = new Date();
    rule.updatedBy = req.user.id;
    await rule.save();

    await recordRuleActivity(
      req,
      "COMPLIANCE_RULE_REVIEWED",
      before,
      ruleSummary(rule),
      rule
    );

    return res.json({ ok: true, rule, requestId: req.id || "" });
  } catch (error) {
    return forwardKnownError(error, next);
  }
}

export async function activateComplianceRule(req, res, next) {
  let session = null;
  try {
    requireObjectId(req.params.ruleId, "rule id");
    const body = assertObjectBody(req.body || {});
    assertAllowedFields(body, new Set());

    session = await mongoose.startSession();
    let activatedRule = null;
    let retiredRules = [];
    await session.withTransaction(async () => {
      const rule = await ComplianceRule.findById(req.params.ruleId).session(session);
      if (!rule) throw httpError(404, "Compliance rule not found");
      if (rule.status !== "IN_REVIEW" || !rule.reviewedBy || !rule.reviewedAt) {
        throw httpError(409, "Rule requires completed human review before activation");
      }
      if (!rule.sourceReference) {
        throw httpError(400, "Official sourceReference is required for activation");
      }

      retiredRules = await ComplianceRule.find({
        _id: { $ne: rule._id },
        firmId: rule.firmId || null,
        code: rule.code,
        status: "ACTIVE",
      })
        .select("_id version")
        .session(session)
        .lean();

      if (retiredRules.length) {
        await ComplianceRule.updateMany(
          { _id: { $in: retiredRules.map((item) => item._id) } },
          {
            $set: {
              status: "RETIRED",
              updatedBy: req.user.id,
            },
          },
          { session }
        );
      }

      rule.status = "ACTIVE";
      rule.updatedBy = req.user.id;
      activatedRule = await rule.save({ session });
    });

    await recordRuleActivity(
      req,
      "COMPLIANCE_RULE_ACTIVATED",
      { status: "IN_REVIEW" },
      {
        ...ruleSummary(activatedRule),
        retiredVersions: retiredRules.map((rule) => rule.version),
      },
      activatedRule
    );

    return res.json({
      ok: true,
      rule: activatedRule,
      retiredRuleIds: retiredRules.map((rule) => rule._id),
      requestId: req.id || "",
    });
  } catch (error) {
    return forwardKnownError(error, next);
  } finally {
    if (session) await session.endSession();
  }
}

export async function retireComplianceRule(req, res, next) {
  try {
    requireObjectId(req.params.ruleId, "rule id");
    const body = assertObjectBody(req.body || {});
    assertAllowedFields(body, new Set());

    const rule = await ComplianceRule.findById(req.params.ruleId);
    if (!rule) throw httpError(404, "Compliance rule not found");
    if (rule.status === "RETIRED") {
      throw httpError(409, "Compliance rule is already retired");
    }

    const before = ruleSummary(rule);
    rule.status = "RETIRED";
    rule.updatedBy = req.user.id;
    await rule.save();

    await recordRuleActivity(
      req,
      "COMPLIANCE_RULE_RETIRED",
      before,
      ruleSummary(rule),
      rule
    );

    return res.json({ ok: true, rule, requestId: req.id || "" });
  } catch (error) {
    return forwardKnownError(error, next);
  }
}

export async function listComplianceOverrides(req, res, next) {
  try {
    const limit = parseLimit(req.query.limit);
    const filter = { firmId: req.user.firmId };
    applyCursor(filter, req.query.cursor);

    if (req.query.clientId) {
      filter.clientId = requireObjectId(req.query.clientId, "clientId");
    }
    if (req.query.ruleCode) {
      filter.ruleCode = normalizeRuleCode(req.query.ruleCode);
    }
    if (req.query.period) {
      filter.period = normalizeRequiredText(req.query.period, "period", 80);
    }

    const overrides = await ComplianceOverride.find(filter)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .populate("clientId", "name clientCode")
      .lean();
    const hasMore = overrides.length > limit;
    if (hasMore) overrides.pop();

    return res.json({
      ok: true,
      overrides,
      pagination: {
        limit,
        hasMore,
        nextCursor: hasMore ? String(overrides.at(-1)._id) : null,
      },
      requestId: req.id || "",
    });
  } catch (error) {
    return forwardKnownError(error, next);
  }
}

export async function upsertComplianceOverride(req, res, next) {
  try {
    const body = assertObjectBody(req.body);
    assertAllowedFields(body, OVERRIDE_WRITE_FIELDS);
    const clientId = requireObjectId(body.clientId, "clientId");
    const ruleCode = normalizeRuleCode(body.ruleCode);
    const suppliedPeriod = normalizeRequiredText(body.period, "period", 80);
    const action = String(body.action || "").toUpperCase();
    const reason = normalizeRequiredText(body.reason, "reason", 1000);

    if (!OVERRIDE_ACTIONS.includes(action)) {
      throw httpError(400, "Invalid override action");
    }
    const dueDate =
      action === "DATE_OVERRIDE"
        ? parseDate(body.dueDate, "dueDate")
        : null;

    const [client, resolution] = await Promise.all([
      Client.exists({
        _id: clientId,
        firmId: req.user.firmId,
        isActive: true,
      }),
      resolveApplicableComplianceRule({
        firmId: req.user.firmId,
        code: ruleCode,
        period: suppliedPeriod,
      }),
    ]);
    if (!client) throw httpError(404, "Client not found");
    if (!resolution) {
      throw httpError(
        400,
        "No active reviewed rule applies to the requested period"
      );
    }

    const { rule, periodWindow } = resolution;
    const key = {
      firmId: req.user.firmId,
      clientId,
      ruleCode,
      period: periodWindow.period,
    };
    const before = await ComplianceOverride.findOne(key).lean();
    const isNew = !before;
    const reviewedAt = new Date();
    const mutableFields = {
      ruleId: rule._id,
      ruleVersion: rule.version,
      periodStart: periodWindow.start,
      periodEnd: periodWindow.end,
      action,
      dueDate,
      reason,
      reviewedBy: req.user.id,
      reviewedAt,
      updatedBy: req.user.id,
    };

    let override;
    try {
      override = await ComplianceOverride.findOneAndUpdate(
        key,
        {
          $set: mutableFields,
          $setOnInsert: {
            ...key,
            createdBy: req.user.id,
          },
        },
        {
          new: true,
          upsert: true,
          runValidators: true,
          setDefaultsOnInsert: true,
        }
      );
    } catch (error) {
      if (error.code !== 11000) throw error;
      override = await ComplianceOverride.findOneAndUpdate(
        key,
        { $set: mutableFields },
        { new: true, runValidators: true }
      );
    }
    if (!override) {
      throw httpError(409, "Override changed concurrently; reload and retry");
    }

    await safeRecordActivity({
      firmId: req.user.firmId,
      actorUserId: req.user.id,
      source: "USER",
      action: isNew
        ? "COMPLIANCE_OVERRIDE_CREATED"
        : "COMPLIANCE_OVERRIDE_UPDATED",
      entityType: "ComplianceOverride",
      entityId: override._id,
      beforeSummary: before ? overrideSummary(before) : null,
      afterSummary: overrideSummary(override),
      requestId: req.id,
      metadata: {
        applicableRuleId: rule._id,
        applicableRuleVersion: rule.version,
      },
    });

    return res.status(isNew ? 201 : 200).json({
      ok: true,
      override,
      requestId: req.id || "",
    });
  } catch (error) {
    return forwardKnownError(error, next);
  }
}

export async function deleteComplianceOverride(req, res, next) {
  try {
    requireObjectId(req.params.overrideId, "override id");
    const override = await ComplianceOverride.findOne({
      _id: req.params.overrideId,
      firmId: req.user.firmId,
    });
    if (!override) throw httpError(404, "Compliance override not found");

    const before = overrideSummary(override);
    await override.deleteOne();
    await safeRecordActivity({
      firmId: req.user.firmId,
      actorUserId: req.user.id,
      source: "USER",
      action: "COMPLIANCE_OVERRIDE_DELETED",
      entityType: "ComplianceOverride",
      entityId: override._id,
      beforeSummary: before,
      afterSummary: null,
      requestId: req.id,
    });

    return res.json({ ok: true, requestId: req.id || "" });
  } catch (error) {
    return forwardKnownError(error, next);
  }
}
