import { createHash } from "node:crypto";
import mongoose from "mongoose";

import AppConfig, { DEFAULT_FEATURE_FLAGS } from "../models/AppConfig.js";
import AutomationJob from "../models/AutomationJob.js";
import Client from "../models/Client.js";
import ComplianceOverride from "../models/ComplianceOverride.js";
import ComplianceRule from "../models/ComplianceRule.js";
import Firm from "../models/Firm.js";
import Reminder from "../models/Reminder.js";
import Task from "../models/Task.js";
import TaxWorkSession, { TAX_TYPES } from "../models/TaxWorkSession.js";
import User from "../models/User.js";
import { getTemplateDocuments } from "../config/tax-templates.js";
import { safeRecordActivity } from "./activity.service.js";
import { enqueueJob, renewJobLease } from "./automation-job.service.js";
import { selectApplicableComplianceRule } from "./compliance-period.service.js";

export const COMPLIANCE_GENERATION_JOB_KIND =
  "COMPLIANCE_HORIZON_GENERATION";
export const COMPLIANCE_GENERATION_PREVIEW_VERSION = 1;

const MAX_GENERATION_ITEMS = 100;
const RULE_CODE_PATTERN = /^[A-Z0-9_]+$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const TASK_SERVICE_TYPES = new Set([
  "GST",
  "TDS",
  "ITR",
  "ROC",
  "AUDIT",
  "OTHER",
]);
const TITLE_TEMPLATE_FIELDS = new Set([
  "clientName",
  "code",
  "period",
  "ruleTitle",
  "dueDate",
]);
const TITLE_TEMPLATE_PATTERN = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

const GENERATION_INDEX_SPECS = Object.freeze([
  {
    Model: AutomationJob,
    key: [["firmId", 1], ["kind", 1], ["idempotencyKey", 1]],
    unique: true,
    partialFilterExpression: null,
  },
  {
    Model: ComplianceRule,
    key: [["firmId", 1], ["code", 1]],
    unique: true,
    partialFilterExpression: { status: "ACTIVE" },
  },
  {
    Model: ComplianceOverride,
    key: [["firmId", 1], ["clientId", 1], ["ruleCode", 1], ["period", 1]],
    unique: true,
    partialFilterExpression: null,
  },
  {
    Model: Task,
    key: [["firmId", 1], ["generationKey", 1]],
    unique: true,
    partialFilterExpression: { generationKey: { $type: "string" } },
  },
  {
    Model: TaxWorkSession,
    key: [["firmId", 1], ["generationKey", 1]],
    unique: true,
    partialFilterExpression: { generationKey: { $type: "string" } },
  },
  {
    Model: Reminder,
    key: [["firmId", 1], ["generationKey", 1]],
    unique: true,
    partialFilterExpression: { generationKey: { $type: "string" } },
  },
]);

function indexKeyMatches(index, expectedKey) {
  const actual = Object.entries(index.key || {});
  return (
    actual.length === expectedKey.length &&
    actual.every(
      ([field, direction], indexPosition) =>
        field === expectedKey[indexPosition][0] &&
        Number(direction) === expectedKey[indexPosition][1]
    )
  );
}

function indexSpecMatches(index, spec) {
  if (!indexKeyMatches(index, spec.key)) return false;
  if (spec.unique && index.unique !== true) return false;
  if (index.sparse === true) return false;

  const actualPartial = index.partialFilterExpression || null;
  return (
    hashGenerationValue(actualPartial) ===
    hashGenerationValue(spec.partialFilterExpression)
  );
}

export async function assertComplianceGenerationIndexes({ mode }) {
  const normalizedMode = String(mode || "").toUpperCase();
  const specs =
    normalizedMode === "LIVE"
      ? GENERATION_INDEX_SPECS
      : GENERATION_INDEX_SPECS.slice(0, 1);
  const missing = [];

  for (const spec of specs) {
    let indexes;
    try {
      indexes = await spec.Model.collection.indexes();
    } catch (error) {
      missing.push(spec.Model.modelName);
      continue;
    }
    if (!indexes.some((index) => indexSpecMatches(index, spec))) {
      missing.push(spec.Model.modelName);
    }
  }

  if (missing.length) {
    throw httpError(
      503,
      `Compliance generation indexes are not verified: ${missing.join(", ")}`,
      "GENERATION_INDEXES_UNAVAILABLE"
    );
  }
  return true;
}

function httpError(statusCode, message, code = "COMPLIANCE_GENERATION_ERROR") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function assertPlainObject(value, fieldName) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw httpError(400, `${fieldName} must be an object`, "INVALID_INPUT");
  }
  return value;
}

function assertAllowedFields(value, allowedFields, fieldName) {
  const unknownFields = Object.keys(value).filter(
    (field) => !allowedFields.has(field)
  );
  if (unknownFields.length) {
    throw httpError(
      400,
      `Unknown ${fieldName} fields: ${unknownFields.join(", ")}`,
      "INVALID_INPUT"
    );
  }
}

function objectIdString(value, fieldName) {
  const candidate = String(value || "").trim();
  if (!mongoose.Types.ObjectId.isValid(candidate)) {
    throw httpError(400, `Invalid ${fieldName}`, "INVALID_INPUT");
  }
  return String(new mongoose.Types.ObjectId(candidate));
}

function requiredText(value, fieldName, maxLength) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw httpError(400, `${fieldName} is required`, "INVALID_INPUT");
  }
  if (normalized.length > maxLength) {
    throw httpError(
      400,
      `${fieldName} exceeds ${maxLength} characters`,
      "INVALID_INPUT"
    );
  }
  return normalized;
}

export function normalizeGenerationRequest(input, { actorUserId } = {}) {
  const body = assertPlainObject(input, "request");
  assertAllowedFields(
    body,
    new Set(["clientId", "assignedTo", "items"]),
    "request"
  );

  const normalizedActorId = objectIdString(actorUserId, "actor user id");
  const clientId = objectIdString(body.clientId, "clientId");
  const assignedTo = body.assignedTo
    ? objectIdString(body.assignedTo, "assignedTo")
    : normalizedActorId;

  if (
    !Array.isArray(body.items) ||
    body.items.length < 1 ||
    body.items.length > MAX_GENERATION_ITEMS
  ) {
    throw httpError(
      400,
      `items must contain 1 to ${MAX_GENERATION_ITEMS} entries`,
      "INVALID_INPUT"
    );
  }

  const seen = new Set();
  const items = body.items.map((rawItem, index) => {
    const item = assertPlainObject(rawItem, `items[${index}]`);
    assertAllowedFields(
      item,
      new Set(["ruleCode", "period"]),
      `items[${index}]`
    );

    const ruleCode = requiredText(
      item.ruleCode,
      `items[${index}].ruleCode`,
      80
    ).toUpperCase();
    if (!RULE_CODE_PATTERN.test(ruleCode)) {
      throw httpError(
        400,
        `items[${index}].ruleCode may contain only A-Z, 0-9, and underscore`,
        "INVALID_INPUT"
      );
    }
    const period = requiredText(
      item.period,
      `items[${index}].period`,
      80
    ).toUpperCase();
    const key = `${ruleCode}\u0000${period}`;
    if (seen.has(key)) {
      throw httpError(
        400,
        `Duplicate generation item: ${ruleCode} ${period}`,
        "DUPLICATE_ITEM"
      );
    }
    seen.add(key);
    return { ruleCode, period };
  });

  items.sort(
    (left, right) =>
      left.ruleCode.localeCompare(right.ruleCode) ||
      left.period.localeCompare(right.period)
  );

  return {
    clientId,
    assignedTo,
    items,
  };
}

function stableValue(value) {
  if (value == null || ["string", "number", "boolean"].includes(typeof value)) {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value?.toHexString === "function") return value.toHexString();
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])])
    );
  }
  return String(value);
}

export function hashGenerationValue(value) {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

function utcDateOnly(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw httpError(400, "Invalid date in reviewed rule", "INVALID_RULE_POLICY");
  }
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
}

function addUtcDays(value, days) {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date;
}

export function calculateComplianceDueDate({
  periodWindow,
  dueDatePolicy,
  override = null,
}) {
  if (override?.action === "DATE_OVERRIDE") {
    if (!override.dueDate) {
      throw httpError(
        400,
        "DATE_OVERRIDE requires a reviewed due date",
        "INVALID_OVERRIDE"
      );
    }
    const overrideDate = new Date(override.dueDate);
    if (Number.isNaN(overrideDate.getTime())) {
      throw httpError(400, "Override due date is invalid", "INVALID_OVERRIDE");
    }
    return overrideDate;
  }

  const policy = dueDatePolicy || {};
  if (policy.type === "MANUAL") {
    throw httpError(
      409,
      "MANUAL due-date rules require a reviewed DATE_OVERRIDE",
      "MANUAL_DATE_REQUIRED"
    );
  }

  if (policy.type === "DAYS_AFTER_PERIOD_END") {
    return addUtcDays(utcDateOnly(periodWindow.end), policy.offsetDays || 0);
  }

  if (policy.type === "DAY_OF_MONTH") {
    if (!Number.isInteger(policy.day) || policy.day < 1 || policy.day > 31) {
      throw httpError(
        400,
        "DAY_OF_MONTH rule has an invalid day",
        "INVALID_RULE_POLICY"
      );
    }
    const periodEnd = utcDateOnly(periodWindow.end);
    const monthStart = new Date(
      Date.UTC(
        periodEnd.getUTCFullYear(),
        periodEnd.getUTCMonth() + Number(policy.monthOffset || 0),
        1
      )
    );
    const lastDay = new Date(
      Date.UTC(
        monthStart.getUTCFullYear(),
        monthStart.getUTCMonth() + 1,
        0
      )
    ).getUTCDate();
    const clampedDay = Math.min(policy.day, lastDay);
    const dueDate = new Date(
      Date.UTC(
        monthStart.getUTCFullYear(),
        monthStart.getUTCMonth(),
        clampedDay
      )
    );
    return addUtcDays(dueDate, policy.offsetDays || 0);
  }

  throw httpError(
    400,
    "Reviewed rule has an unsupported due-date policy",
    "INVALID_RULE_POLICY"
  );
}

export function renderComplianceTitle(template, values) {
  const normalizedTemplate = requiredText(
    template,
    "titleTemplate",
    240
  );
  const unknownPlaceholder = [
    ...normalizedTemplate.matchAll(TITLE_TEMPLATE_PATTERN),
  ].find((match) => !TITLE_TEMPLATE_FIELDS.has(match[1]));
  const unmatchedBraces = /[{}]/.test(
    normalizedTemplate.replace(TITLE_TEMPLATE_PATTERN, "")
  );
  if (unknownPlaceholder || unmatchedBraces) {
    throw httpError(
      400,
      "Title template contains an unsupported placeholder",
      "INVALID_RULE_POLICY"
    );
  }

  const rendered = normalizedTemplate.replace(
    TITLE_TEMPLATE_PATTERN,
    (_, field) => String(values[field] ?? "")
  );
  const normalized = rendered.replace(/\s+/g, " ").trim();
  if (!normalized) {
    throw httpError(
      400,
      "Title template produced an empty title",
      "INVALID_RULE_POLICY"
    );
  }
  return normalized.slice(0, 240);
}

export function buildGenerationKeys({
  firmId,
  clientId,
  ruleId,
  ruleVersion,
  period,
}) {
  const digest = hashGenerationValue({
    version: 1,
    firmId: String(firmId),
    clientId: String(clientId),
    ruleId: String(ruleId),
    ruleVersion: Number(ruleVersion),
    period: String(period),
  });
  return {
    task: `compliance:task:v1:${digest}`,
    taxWorkSession: `compliance:session:v1:${digest}`,
    reminder: `compliance:reminder:v1:${digest}`,
  };
}

function overrideKey(ruleCode, period) {
  return `${ruleCode}\u0000${period}`;
}

function ruleView(rule) {
  if (!rule) return null;
  return {
    id: String(rule._id),
    firmId: rule.firmId ? String(rule.firmId) : null,
    code: rule.code,
    version: rule.version,
    title: rule.title,
    status: rule.status,
    frequency: rule.frequency,
    entityTypes: rule.entityTypes || [],
    dueDatePolicy: rule.dueDatePolicy,
    generationPolicy: rule.generationPolicy,
    defaultReminderOffsets: rule.defaultReminderOffsets || [],
    sourceReference: rule.sourceReference,
    reviewedBy: String(rule.reviewedBy),
    reviewedAt: new Date(rule.reviewedAt).toISOString(),
    effectiveFrom: new Date(rule.effectiveFrom).toISOString(),
    effectiveTo: rule.effectiveTo
      ? new Date(rule.effectiveTo).toISOString()
      : null,
    updatedAt: rule.updatedAt ? new Date(rule.updatedAt).toISOString() : null,
  };
}

function overrideView(override) {
  if (!override) return null;
  return {
    id: String(override._id),
    ruleId: String(override.ruleId),
    ruleVersion: override.ruleVersion,
    action: override.action,
    dueDate: override.dueDate
      ? new Date(override.dueDate).toISOString()
      : null,
    reason: override.reason,
    reviewedBy: String(override.reviewedBy),
    reviewedAt: new Date(override.reviewedAt).toISOString(),
    updatedAt: override.updatedAt
      ? new Date(override.updatedAt).toISOString()
      : null,
  };
}

function profileSettingView(setting) {
  if (!setting) return null;
  return {
    code: setting.code,
    applicability: setting.applicability,
    frequency: setting.frequency,
    reminderOffsets: setting.reminderOffsets || [],
    updatedAt: setting.updatedAt
      ? new Date(setting.updatedAt).toISOString()
      : null,
    updatedBy: setting.updatedBy ? String(setting.updatedBy) : null,
  };
}

function normalizeOffsets(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter(Number.isInteger))].sort(
    (left, right) => left - right
  );
}

function blockedPlan(base, reasonCode, reason) {
  return {
    ...base,
    status: "BLOCKED",
    reasonCode,
    reason,
    dueDate: null,
    title: null,
    generationPolicy: null,
    artifacts: null,
  };
}

function skippedPlan(base, reasonCode, reason) {
  return {
    ...base,
    status: "SKIPPED",
    reasonCode,
    reason,
    dueDate: null,
    title: null,
    generationPolicy: null,
    artifacts: null,
  };
}

function readyPlan({
  base,
  client,
  assignedTo,
  actorUserId,
  resolution,
  override,
  profileSetting,
}) {
  const { rule, periodWindow } = resolution;
  const generationPolicy = {
    createTask: rule.generationPolicy?.createTask !== false,
    createTaxWorkSession:
      rule.generationPolicy?.createTaxWorkSession !== false,
    createReminder: rule.generationPolicy?.createReminder !== false,
    taskServiceType: String(
      rule.generationPolicy?.taskServiceType || "OTHER"
    ).toUpperCase(),
    taxWorkType: String(
      rule.generationPolicy?.taxWorkType || "OTHER"
    ).toUpperCase(),
    titleTemplate:
      rule.generationPolicy?.titleTemplate ||
      "{clientName} - {code} - {period}",
  };

  if (
    !generationPolicy.createTask &&
    !generationPolicy.createTaxWorkSession &&
    !generationPolicy.createReminder
  ) {
    return blockedPlan(
      base,
      "EMPTY_GENERATION_POLICY",
      "Reviewed rule does not create any artifact"
    );
  }
  if (!TASK_SERVICE_TYPES.has(generationPolicy.taskServiceType)) {
    return blockedPlan(
      base,
      "INVALID_TASK_SERVICE_TYPE",
      "Reviewed rule has an invalid task service type"
    );
  }
  if (!TAX_TYPES.includes(generationPolicy.taxWorkType)) {
    return blockedPlan(
      base,
      "INVALID_TAX_WORK_TYPE",
      "Reviewed rule has an invalid Tax Work template"
    );
  }

  let dueDate;
  let title;
  try {
    dueDate = calculateComplianceDueDate({
      periodWindow,
      dueDatePolicy: rule.dueDatePolicy,
      override,
    });
    title = renderComplianceTitle(generationPolicy.titleTemplate, {
      clientName: client.name,
      code: rule.code,
      period: periodWindow.period,
      ruleTitle: rule.title,
      dueDate: dueDate.toISOString().slice(0, 10),
    });
  } catch (error) {
    return blockedPlan(
      base,
      error.code || "INVALID_RULE_POLICY",
      error.message
    );
  }

  const keys = buildGenerationKeys({
    firmId: client.firmId,
    clientId: client._id,
    ruleId: rule._id,
    ruleVersion: rule.version,
    period: periodWindow.period,
  });
  const reminderOffsets = normalizeOffsets(
    profileSetting?.reminderOffsets?.length
      ? profileSetting.reminderOffsets
      : rule.defaultReminderOffsets
  );
  const documents = getTemplateDocuments(generationPolicy.taxWorkType);
  const dueDateISO = dueDate.toISOString();

  return {
    ...base,
    status: "READY",
    reasonCode: null,
    reason: null,
    dueDate: dueDateISO,
    title,
    generationPolicy,
    artifacts: {
      task: generationPolicy.createTask
        ? {
            generationKey: keys.task,
            values: {
              clientName: client.name,
              serviceType: generationPolicy.taskServiceType,
              title,
              dueDateISO,
              assignedTo,
              status: "NOT_STARTED",
            },
          }
        : null,
      taxWorkSession: generationPolicy.createTaxWorkSession
        ? {
            generationKey: keys.taxWorkSession,
            values: {
              ownerUserId: assignedTo,
              taxType: generationPolicy.taxWorkType,
              period: periodWindow.period,
              dueDate: dueDateISO,
              status: "DRAFT",
              assignedTo,
              documents,
            },
          }
        : null,
      reminder: generationPolicy.createReminder
        ? {
            generationKey: keys.reminder,
            values: {
              userId: assignedTo,
              typeId: rule.code,
              clientLabel: client.name,
              dueDateISO,
              offsets: reminderOffsets,
              isActive: true,
            },
          }
        : null,
    },
    createdBy: actorUserId,
  };
}

function hashItemView(item) {
  const artifacts = item.artifacts
    ? Object.fromEntries(
        Object.entries(item.artifacts).map(([key, artifact]) => [
          key,
          artifact
            ? {
                generationKey: artifact.generationKey,
                values: artifact.values,
              }
            : null,
        ])
      )
    : null;
  return {
    requestedRuleCode: item.requestedRuleCode,
    requestedPeriod: item.requestedPeriod,
    clientUpdatedAt: item.clientUpdatedAt,
    status: item.status,
    reasonCode: item.reasonCode,
    rule: item.rule,
    period: item.period,
    periodStart: item.periodStart,
    periodEnd: item.periodEnd,
    profileSetting: item.profileSetting,
    override: item.override,
    dueDate: item.dueDate,
    title: item.title,
    generationPolicy: item.generationPolicy,
    artifacts,
  };
}

async function existingByGenerationKey(Model, firmId, keys) {
  if (!keys.length) return new Map();
  const records = await Model.find({
    firmId,
    generationKey: { $in: keys },
  })
    .select("_id generationKey")
    .lean();
  return new Map(
    records.map((record) => [record.generationKey, String(record._id)])
  );
}

function attachExistingArtifactState(artifact, existingMap) {
  if (!artifact) return null;
  const existingId = existingMap.get(artifact.generationKey) || null;
  return {
    ...artifact,
    exists: Boolean(existingId),
    existingId,
    action: existingId ? "REUSE" : "CREATE",
  };
}

export async function createComplianceGenerationPreview({
  firmId,
  actorUserId,
  input,
}) {
  const normalizedFirmId = objectIdString(firmId, "firmId");
  const normalizedActorId = objectIdString(actorUserId, "actor user id");
  const request = normalizeGenerationRequest(input, {
    actorUserId: normalizedActorId,
  });
  const ruleCodes = [...new Set(request.items.map((item) => item.ruleCode))];

  const [client, actor, assignee, firm, candidates] = await Promise.all([
    Client.findOne({
      _id: request.clientId,
      firmId: normalizedFirmId,
      isActive: true,
    })
      .select(
        "name ownerUserId firmId updatedAt +entityType +complianceProfile +profileReviewedAt +profileReviewedBy"
      )
      .lean(),
    User.findOne({
      _id: normalizedActorId,
      firmId: normalizedFirmId,
      role: "FIRM_ADMIN",
      isActive: true,
    })
      .select("_id")
      .lean(),
    User.findOne({
      _id: request.assignedTo,
      firmId: normalizedFirmId,
      isActive: true,
    })
      .select("_id name email")
      .lean(),
    Firm.findOne({ _id: normalizedFirmId, isActive: true })
      .select("_id")
      .lean(),
    ComplianceRule.find({
      firmId: { $in: [null, normalizedFirmId] },
      code: { $in: ruleCodes },
      status: "ACTIVE",
      reviewedBy: { $ne: null },
      reviewedAt: { $ne: null },
      sourceReference: { $nin: [null, ""] },
    }).lean(),
  ]);

  if (!firm) {
    throw httpError(404, "Active firm not found", "FIRM_NOT_FOUND");
  }
  if (!actor) {
    throw httpError(
      403,
      "Current actor is no longer an active firm administrator",
      "ACTOR_NOT_AUTHORIZED"
    );
  }
  if (!client) {
    throw httpError(404, "Client not found", "CLIENT_NOT_FOUND");
  }
  if (!assignee) {
    throw httpError(
      400,
      "assignedTo must be an active user in the current firm",
      "INVALID_ASSIGNEE"
    );
  }

  const resolvedItems = request.items.map((item) => ({
    request: item,
    resolution: selectApplicableComplianceRule({
      firmId: normalizedFirmId,
      code: item.ruleCode,
      period: item.period,
      candidates,
    }),
  }));

  const canonicalKeys = new Set();
  for (const item of resolvedItems) {
    if (!item.resolution) continue;
    const key = overrideKey(
      item.request.ruleCode,
      item.resolution.periodWindow.period
    );
    if (canonicalKeys.has(key)) {
      throw httpError(
        400,
        `Periods resolve to a duplicate canonical item: ${item.request.ruleCode} ${item.resolution.periodWindow.period}`,
        "DUPLICATE_CANONICAL_ITEM"
      );
    }
    canonicalKeys.add(key);
  }

  const overrideClauses = resolvedItems
    .filter((item) => item.resolution)
    .map((item) => ({
      ruleCode: item.request.ruleCode,
      period: item.resolution.periodWindow.period,
    }));
  const overrides = overrideClauses.length
    ? await ComplianceOverride.find({
        firmId: normalizedFirmId,
        clientId: request.clientId,
        $or: overrideClauses,
      }).lean()
    : [];
  const overrideMap = new Map(
    overrides.map((override) => [
      overrideKey(override.ruleCode, override.period),
      override,
    ])
  );

  const profileReviewed = Boolean(
    client.profileReviewedAt && client.profileReviewedBy
  );
  const plans = resolvedItems.map(({ request: requestedItem, resolution }) => {
    const profileSetting = (client.complianceProfile || []).find(
      (setting) => setting.code === requestedItem.ruleCode
    );
    const rule = resolution?.rule || null;
    const periodWindow = resolution?.periodWindow || null;
    const override = periodWindow
      ? overrideMap.get(overrideKey(requestedItem.ruleCode, periodWindow.period)) ||
        null
      : null;
    const base = {
      requestedRuleCode: requestedItem.ruleCode,
      requestedPeriod: requestedItem.period,
      clientUpdatedAt: client.updatedAt
        ? new Date(client.updatedAt).toISOString()
        : null,
      rule: ruleView(rule),
      period: periodWindow?.period || null,
      periodStart: periodWindow?.start?.toISOString() || null,
      periodEnd: periodWindow?.end?.toISOString() || null,
      profileSetting: profileSettingView(profileSetting),
      override: overrideView(override),
    };

    if (!resolution) {
      return blockedPlan(
        base,
        "NO_ACTIVE_REVIEWED_RULE",
        "No active human-reviewed rule applies to this period"
      );
    }
    if (
      override &&
      (String(override.ruleId) !== String(rule._id) ||
        Number(override.ruleVersion) !== Number(rule.version))
    ) {
      return blockedPlan(
        base,
        "STALE_OVERRIDE",
        "Period override must be reviewed against the current active rule version"
      );
    }
    if (override?.action === "SKIP") {
      return skippedPlan(
        base,
        "REVIEWED_OVERRIDE_SKIP",
        "Reviewed period override suppresses generation"
      );
    }
    if (!profileReviewed) {
      return blockedPlan(
        base,
        "PROFILE_NOT_REVIEWED",
        "Client compliance profile requires human review"
      );
    }

    const overrideForcesApplication = ["APPLY", "DATE_OVERRIDE"].includes(
      override?.action
    );
    if (!overrideForcesApplication) {
      if (!profileSetting) {
        return blockedPlan(
          base,
          "PROFILE_SETTING_MISSING",
          "Compliance code is missing from the reviewed client profile"
        );
      }
      if (profileSetting.applicability !== "APPLICABLE") {
        return blockedPlan(
          base,
          `PROFILE_${profileSetting.applicability}`,
          "Client profile does not mark this compliance code applicable"
        );
      }
      if (profileSetting.frequency !== rule.frequency) {
        return blockedPlan(
          base,
          "PROFILE_FREQUENCY_MISMATCH",
          "Client profile frequency differs from the active rule"
        );
      }
      if (
        rule.entityTypes?.length &&
        !rule.entityTypes.includes(client.entityType)
      ) {
        return blockedPlan(
          base,
          "ENTITY_TYPE_NOT_APPLICABLE",
          "Active rule does not apply to the client's reviewed entity type"
        );
      }
    }

    return readyPlan({
      base,
      client,
      assignedTo: request.assignedTo,
      actorUserId: normalizedActorId,
      resolution,
      override,
      profileSetting,
    });
  });

  const previewHash = hashGenerationValue({
    previewVersion: COMPLIANCE_GENERATION_PREVIEW_VERSION,
    firmId: normalizedFirmId,
    actorUserId: normalizedActorId,
    client: {
      id: String(client._id),
      name: client.name,
      entityType: client.entityType,
      profileReviewedAt: client.profileReviewedAt
        ? new Date(client.profileReviewedAt).toISOString()
        : null,
      profileReviewedBy: client.profileReviewedBy
        ? String(client.profileReviewedBy)
        : null,
      updatedAt: client.updatedAt
        ? new Date(client.updatedAt).toISOString()
        : null,
    },
    assignedTo: request.assignedTo,
    items: plans.map(hashItemView),
  });

  const keys = {
    task: plans.flatMap((plan) =>
      plan.artifacts?.task ? [plan.artifacts.task.generationKey] : []
    ),
    taxWorkSession: plans.flatMap((plan) =>
      plan.artifacts?.taxWorkSession
        ? [plan.artifacts.taxWorkSession.generationKey]
        : []
    ),
    reminder: plans.flatMap((plan) =>
      plan.artifacts?.reminder ? [plan.artifacts.reminder.generationKey] : []
    ),
  };
  const [existingTasks, existingSessions, existingReminders] =
    await Promise.all([
      existingByGenerationKey(Task, normalizedFirmId, keys.task),
      existingByGenerationKey(
        TaxWorkSession,
        normalizedFirmId,
        keys.taxWorkSession
      ),
      existingByGenerationKey(Reminder, normalizedFirmId, keys.reminder),
    ]);

  for (const plan of plans) {
    if (!plan.artifacts) continue;
    plan.artifacts = {
      task: attachExistingArtifactState(plan.artifacts.task, existingTasks),
      taxWorkSession: attachExistingArtifactState(
        plan.artifacts.taxWorkSession,
        existingSessions
      ),
      reminder: attachExistingArtifactState(
        plan.artifacts.reminder,
        existingReminders
      ),
    };
  }

  const summary = {
    requested: plans.length,
    ready: plans.filter((plan) => plan.status === "READY").length,
    skipped: plans.filter((plan) => plan.status === "SKIPPED").length,
    blocked: plans.filter((plan) => plan.status === "BLOCKED").length,
    artifactsToCreate: plans.reduce(
      (count, plan) =>
        count +
        Object.values(plan.artifacts || {}).filter(
          (artifact) => artifact?.action === "CREATE"
        ).length,
      0
    ),
    artifactsToReuse: plans.reduce(
      (count, plan) =>
        count +
        Object.values(plan.artifacts || {}).filter(
          (artifact) => artifact?.action === "REUSE"
        ).length,
      0
    ),
  };

  return {
    previewVersion: COMPLIANCE_GENERATION_PREVIEW_VERSION,
    previewHash,
    canConfirm: summary.blocked === 0 && summary.ready > 0,
    request,
    client: {
      id: String(client._id),
      name: client.name,
      entityType: client.entityType,
      profileReviewedAt: client.profileReviewedAt || null,
      profileReviewedBy: client.profileReviewedBy || null,
    },
    assignee: {
      id: String(assignee._id),
      name: assignee.name || "",
      email: assignee.email,
    },
    items: plans,
    summary,
  };
}

async function readGenerationFlags(session = null) {
  let query = AppConfig.findById("singleton").select("featureFlags");
  if (session) query = query.session(session);
  const config = await query.lean();
  return {
    ...DEFAULT_FEATURE_FLAGS,
    ...(config?.featureFlags || {}),
  };
}

function selectGenerationMode(flags) {
  const shadow = flags.complianceGenerationShadow === true;
  const live = flags.complianceGenerationLive === true;
  if (shadow && live) {
    throw httpError(
      503,
      "Compliance generation rollout flags are misconfigured",
      "ROLLOUT_MISCONFIGURED"
    );
  }
  if (live) return "LIVE";
  if (shadow) return "SHADOW";
  throw httpError(
    404,
    "Compliance generation is unavailable",
    "ROLLOUT_DISABLED"
  );
}

function modeStillEnabled(mode, flags) {
  const shadow = flags.complianceGenerationShadow === true;
  const live = flags.complianceGenerationLive === true;
  if (shadow && live) return false;
  return mode === "LIVE" ? live && !shadow : shadow && !live;
}

export async function enqueueComplianceGeneration({
  firmId,
  actorUserId,
  input,
  previewHash,
  requestId = "",
}) {
  const suppliedHash = String(previewHash || "").trim().toLowerCase();
  if (!HASH_PATTERN.test(suppliedHash)) {
    throw httpError(400, "A valid previewHash is required", "INVALID_INPUT");
  }

  const preview = await createComplianceGenerationPreview({
    firmId,
    actorUserId,
    input,
  });
  if (preview.previewHash !== suppliedHash) {
    throw httpError(
      409,
      "Preview changed; review the latest generation preview before confirming",
      "STALE_PREVIEW"
    );
  }
  if (!preview.canConfirm) {
    throw httpError(
      409,
      "Generation preview contains blocked items or no work to generate",
      "PREVIEW_NOT_CONFIRMABLE"
    );
  }

  const flags = await readGenerationFlags();
  const mode = selectGenerationMode(flags);
  await assertComplianceGenerationIndexes({ mode });
  const job = await enqueueJob({
    firmId,
    kind: COMPLIANCE_GENERATION_JOB_KIND,
    idempotencyKey: `compliance-generation:${mode.toLowerCase()}:${suppliedHash}`,
    payload: {
      previewVersion: COMPLIANCE_GENERATION_PREVIEW_VERSION,
      previewHash: suppliedHash,
      mode,
      request: preview.request,
      actorUserId: String(actorUserId),
    },
    createdBy: actorUserId,
    requestId,
    maxAttempts: 5,
  });

  return {
    mode,
    previewHash: suppliedHash,
    job: {
      id: String(job._id),
      kind: job.kind,
      status: job.status,
      attemptCount: job.attemptCount,
      createdAt: job.createdAt,
    },
  };
}

async function ensureGeneratedArtifact({
  Model,
  firmId,
  generationKey,
  payload,
  session,
}) {
  const document = await Model.findOneAndUpdate(
    { firmId, generationKey },
    { $setOnInsert: payload },
    {
      upsert: true,
      new: true,
      runValidators: true,
      setDefaultsOnInsert: true,
      session,
    }
  );
  if (!document) {
    throw new Error(`Failed to ensure generated ${Model.modelName}`);
  }
  return document;
}

function deferredExecutionError(code, message, retryAfterMs = 5 * 60 * 1000) {
  const error = new Error(message);
  error.code = code;
  error.defer = true;
  error.retryAfterMs = retryAfterMs;
  return error;
}

function commitGuardError(message) {
  const error = new Error(message);
  error.code = "COMPLIANCE_GENERATION_COMMIT_GUARD_CHANGED";
  return error;
}

function assignedUserIdForItem(item) {
  return (
    item.artifacts.task?.values.assignedTo ||
    item.artifacts.taxWorkSession?.values.assignedTo ||
    item.artifacts.reminder?.values.userId ||
    null
  );
}

export async function assertComplianceGenerationCommitGuards({
  firmId,
  actorUserId,
  jobId,
  leaseToken,
  item,
  session,
}) {
  const lease = await renewJobLease({
    jobId,
    token: leaseToken,
    session,
  });
  if (!lease) {
    const error = new Error("Automation job lease was lost before artifact commit");
    error.code = "JOB_LEASE_LOST";
    throw error;
  }

  const flags = await readGenerationFlags(session);
  if (!modeStillEnabled("LIVE", flags)) {
    throw deferredExecutionError(
      "ROLLOUT_DISABLED",
      "Live compliance generation was disabled before artifact commit"
    );
  }

  const clientFilter = {
    _id: item.clientId,
    firmId,
    isActive: true,
  };
  if (item.clientUpdatedAt) {
    clientFilter.updatedAt = new Date(item.clientUpdatedAt);
  }
  const assignedTo = assignedUserIdForItem(item);

  const [actor, assignee, firm, client, candidates, currentOverride] =
    await Promise.all([
      User.findOne({
        _id: actorUserId,
        firmId,
        role: "FIRM_ADMIN",
        isActive: true,
      })
        .select("_id")
        .session(session)
        .lean(),
      User.findOne({ _id: assignedTo, firmId, isActive: true })
        .select("_id")
        .session(session)
        .lean(),
      Firm.findOne({ _id: firmId, isActive: true })
        .select("_id")
        .session(session)
        .lean(),
      Client.findOne(clientFilter)
        .select("_id updatedAt")
        .session(session)
        .lean(),
      ComplianceRule.find({
        firmId: { $in: [null, firmId] },
        code: item.rule.code,
        status: "ACTIVE",
        reviewedBy: { $ne: null },
        reviewedAt: { $ne: null },
        sourceReference: { $nin: [null, ""] },
      })
        .session(session)
        .lean(),
      ComplianceOverride.findOne({
        firmId,
        clientId: item.clientId,
        ruleCode: item.rule.code,
        period: item.period,
      })
        .session(session)
        .lean(),
    ]);

  if (!actor || !assignee || !firm || !client) {
    throw commitGuardError(
      "Actor, assignee, firm, or client authorization changed after preview"
    );
  }

  const currentResolution = selectApplicableComplianceRule({
    firmId,
    code: item.rule.code,
    period: item.requestedPeriod,
    candidates,
  });
  if (
    !currentResolution ||
    hashGenerationValue(ruleView(currentResolution.rule)) !==
      hashGenerationValue(item.rule)
  ) {
    throw commitGuardError("Active reviewed rule changed after preview");
  }

  if (
    hashGenerationValue(overrideView(currentOverride)) !==
    hashGenerationValue(item.override)
  ) {
    throw commitGuardError("Reviewed compliance override changed after preview");
  }

  return true;
}

async function materializeItemInTransaction({
  firmId,
  actorUserId,
  jobId,
  leaseToken,
  item,
  session,
}) {
  await assertComplianceGenerationCommitGuards({
    firmId,
    actorUserId,
    jobId,
    leaseToken,
    item,
    session,
  });

  const provenance = {
    source: "COMPLIANCE_RULE",
    clientId: item.clientId,
    complianceRuleId: item.rule.id,
    complianceRuleVersion: item.rule.version,
    complianceCode: item.rule.code,
    period: item.period,
    ruleSourceReference: item.rule.sourceReference,
    automationJobId: jobId,
  };

  let task = null;
  let taxWorkSession = null;
  let reminder = null;

  if (item.artifacts.task) {
    task = await ensureGeneratedArtifact({
      Model: Task,
      firmId,
      generationKey: item.artifacts.task.generationKey,
      session,
      payload: {
        firmId,
        createdBy: actorUserId,
        ...item.artifacts.task.values,
        ...provenance,
        generationKey: item.artifacts.task.generationKey,
        meta: {
          docsStatus: "PENDING",
          periodKey: `${item.period}_${item.rule.code}_${item.clientId}`,
        },
      },
    });
  }

  if (item.artifacts.taxWorkSession) {
    taxWorkSession = await ensureGeneratedArtifact({
      Model: TaxWorkSession,
      firmId,
      generationKey: item.artifacts.taxWorkSession.generationKey,
      session,
      payload: {
        firmId,
        clientId: item.clientId,
        createdBy: actorUserId,
        ...item.artifacts.taxWorkSession.values,
        ...provenance,
        taskId: task?._id || null,
        generationKey: item.artifacts.taxWorkSession.generationKey,
      },
    });
  }

  if (item.artifacts.reminder) {
    reminder = await ensureGeneratedArtifact({
      Model: Reminder,
      firmId,
      generationKey: item.artifacts.reminder.generationKey,
      session,
      payload: {
        firmId,
        ...item.artifacts.reminder.values,
        ...provenance,
        taskId: task?._id || null,
        taxWorkSessionId: taxWorkSession?._id || null,
        generationKey: item.artifacts.reminder.generationKey,
      },
    });
  }

  if (task) {
    const links = {};
    if (taxWorkSession) links.taxWorkSessionId = taxWorkSession._id;
    if (reminder) links.reminderId = reminder._id;
    if (Object.keys(links).length) {
      await Task.updateOne(
        { _id: task._id, firmId, generationKey: item.artifacts.task.generationKey },
        { $set: links },
        { session }
      );
    }
  }
  if (taxWorkSession && reminder) {
    await TaxWorkSession.updateOne(
      {
        _id: taxWorkSession._id,
        firmId,
        generationKey: item.artifacts.taxWorkSession.generationKey,
      },
      { $set: { reminderId: reminder._id } },
      { session }
    );
  }

  return {
    ruleCode: item.rule.code,
    ruleVersion: item.rule.version,
    period: item.period,
    taskId: task ? String(task._id) : null,
    taxWorkSessionId: taxWorkSession ? String(taxWorkSession._id) : null,
    reminderId: reminder ? String(reminder._id) : null,
  };
}

async function materializeItem(context) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const session = await mongoose.startSession();
    try {
      let result = null;
      await session.withTransaction(async () => {
        result = await materializeItemInTransaction({
          ...context,
          session,
        });
      });
      return result;
    } catch (error) {
      if (error.code !== 11000 || attempt === 1) throw error;
    } finally {
      await session.endSession();
    }
  }
  throw new Error("Unable to materialize compliance generation item");
}

function workerItem(item, clientId) {
  return {
    ...item,
    clientId,
  };
}

export async function processComplianceGenerationJob(
  job,
  { leaseToken } = {}
) {
  if (!job || job.kind !== COMPLIANCE_GENERATION_JOB_KIND) {
    throw new Error("Unsupported compliance generation job");
  }
  if (!leaseToken) {
    const error = new Error("Compliance generation requires an active job lease");
    error.code = "JOB_LEASE_REQUIRED";
    throw error;
  }

  const payload = assertPlainObject(job.payload, "job payload");
  const mode = String(payload.mode || "").toUpperCase();
  if (!["SHADOW", "LIVE"].includes(mode)) {
    throw httpError(400, "Invalid compliance generation job mode", "INVALID_JOB_MODE");
  }

  const initialLease = await renewJobLease({
    jobId: job._id,
    token: leaseToken,
  });
  if (!initialLease) {
    const error = new Error("Automation job lease was lost before processing");
    error.code = "JOB_LEASE_LOST";
    throw error;
  }

  const flags = await readGenerationFlags();
  if (!modeStillEnabled(mode, flags)) {
    return {
      outcome: "ROLLOUT_DISABLED",
      mode,
      generatedItems: 0,
      defer: true,
      retryAfterMs: 5 * 60 * 1000,
      reason: "Compliance generation rollout mode is currently disabled",
    };
  }

  try {
    await assertComplianceGenerationIndexes({ mode });
  } catch (error) {
    if (error.code !== "GENERATION_INDEXES_UNAVAILABLE") throw error;
    return {
      outcome: "GENERATION_INDEXES_UNAVAILABLE",
      mode,
      generatedItems: 0,
      defer: true,
      retryAfterMs: 15 * 60 * 1000,
      reason: error.message,
    };
  }

  const preview = await createComplianceGenerationPreview({
    firmId: job.firmId,
    actorUserId: payload.actorUserId,
    input: payload.request,
  });

  if (preview.previewHash !== payload.previewHash || !preview.canConfirm) {
    return {
      outcome: "STALE_PREVIEW",
      previewHash: preview.previewHash,
      generatedItems: 0,
      blockedItems: preview.summary.blocked,
    };
  }

  if (mode === "SHADOW") {
    const latestFlags = await readGenerationFlags();
    if (!modeStillEnabled(mode, latestFlags)) {
      return {
        outcome: "ROLLOUT_DISABLED",
        mode,
        generatedItems: 0,
        defer: true,
        retryAfterMs: 5 * 60 * 1000,
        reason: "Compliance generation rollout mode changed during preview",
      };
    }
    const renewed = await renewJobLease({
      jobId: job._id,
      token: leaseToken,
    });
    if (!renewed) {
      const error = new Error("Automation job lease was lost before shadow completion");
      error.code = "JOB_LEASE_LOST";
      throw error;
    }
    await safeRecordActivity({
      firmId: job.firmId,
      actorUserId: payload.actorUserId,
      source: "AUTOMATION",
      action: "COMPLIANCE_GENERATION_SHADOW_COMPLETED",
      entityType: "AutomationJob",
      entityId: job._id,
      afterSummary: preview.summary,
      requestId: job.requestId,
      metadata: { previewHash: preview.previewHash },
    });
    return {
      outcome: "SHADOW_COMPLETED",
      mode,
      generatedItems: 0,
      previewSummary: preview.summary,
    };
  }

  const results = [];
  for (const item of preview.items) {
    if (item.status !== "READY") continue;
    results.push(
      await materializeItem({
        firmId: String(job.firmId),
        actorUserId: payload.actorUserId,
        jobId: job._id,
        leaseToken,
        item: workerItem(item, preview.client.id),
      })
    );
  }

  const finalLease = await renewJobLease({
    jobId: job._id,
    token: leaseToken,
  });
  if (!finalLease) {
    const error = new Error("Automation job lease was lost before activity recording");
    error.code = "JOB_LEASE_LOST";
    throw error;
  }
  const latestFlags = await readGenerationFlags();
  if (!modeStillEnabled(mode, latestFlags)) {
    return {
      outcome: "ROLLOUT_DISABLED",
      mode,
      generatedItems: results.length,
      defer: true,
      retryAfterMs: 5 * 60 * 1000,
      reason: "Compliance generation rollout mode changed during processing",
    };
  }

  await safeRecordActivity({
    firmId: job.firmId,
    actorUserId: payload.actorUserId,
    source: "AUTOMATION",
    action: "COMPLIANCE_GENERATION_LIVE_COMPLETED",
    entityType: "AutomationJob",
    entityId: job._id,
    afterSummary: {
      generatedItems: results.length,
      skippedItems: preview.summary.skipped,
      results,
    },
    requestId: job.requestId,
    metadata: { previewHash: preview.previewHash },
  });

  return {
    outcome: "LIVE_COMPLETED",
    mode,
    generatedItems: results.length,
    skippedItems: preview.summary.skipped,
    results,
  };
}
