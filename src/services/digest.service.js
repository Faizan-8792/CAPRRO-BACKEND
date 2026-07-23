import mongoose from "mongoose";
import AppConfig from "../models/AppConfig.js";
import DigestDelivery from "../models/DigestDelivery.js";
import Firm from "../models/Firm.js";
import Task from "../models/Task.js";
import User from "../models/User.js";
import { safeRecordActivity } from "./activity.service.js";
import { enqueueJob } from "./automation-job.service.js";
import { sendDigestEmail } from "./email.service.js";

const DIGEST_JOB_KIND = "DIGEST_DELIVERY";
const DAILY_KIND = "DAILY_PERSONAL";
const WEEKLY_KIND = "WEEKLY_FIRM";
const DIGEST_KINDS = new Set([DAILY_KIND, WEEKLY_KIND]);
const OPEN_STATUSES = Object.freeze([
  "NOT_STARTED",
  "WAITING_DOCS",
  "IN_PROGRESS",
]);
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const FIRM_SCAN_BATCH = 200;

class DigestError extends Error {
  constructor(message, status = 400, code = "DIGEST_INVALID") {
    super(message);
    this.name = "DigestError";
    this.status = status;
    this.code = code;
  }
}

function safeError(error) {
  return String(error?.message || "Digest delivery failed")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 500);
}

function validObjectId(value) {
  return /^[a-f\d]{24}$/i.test(String(value || ""));
}

function effectivePreferences(user) {
  return {
    dailyEnabled: user?.digestPreferences?.dailyEnabled !== false,
    weeklyEnabled: user?.digestPreferences?.weeklyEnabled !== false,
    emailEnabled: user?.digestPreferences?.emailEnabled !== false,
  };
}

function validTimezone(value) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function zonedParts(now, timezone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  const weekday = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  }[parts.weekday];
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    weekday,
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

function parseDateKey(dateKey) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ""));
  if (!match) throw new DigestError("Digest period key is invalid");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utcMs = Date.UTC(year, month - 1, day);
  const date = new Date(utcMs);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new DigestError("Digest period key is invalid");
  }
  return { year, month, day, utcMs };
}

function addDateKeyDays(dateKey, days) {
  const { utcMs } = parseDateKey(dateKey);
  return new Date(utcMs + days * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

function zonedOffsetMilliseconds(instant, timezone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(instant)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  const representedUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return representedUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

function zonedDateKeyStart(dateKey, timezone) {
  const { utcMs } = parseDateKey(dateKey);
  let instantMs = utcMs;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const next = utcMs - zonedOffsetMilliseconds(new Date(instantMs), timezone);
    if (next === instantMs) break;
    instantMs = next;
  }
  return new Date(instantMs);
}

function weekStartKey(parts) {
  const localDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const daysFromMonday = (parts.weekday + 6) % 7;
  localDate.setUTCDate(localDate.getUTCDate() - daysFromMonday);
  return localDate.toISOString().slice(0, 10);
}

function weeklyDue(parts, settings) {
  const currentFromMonday = (parts.weekday + 6) % 7;
  const targetFromMonday = (Number(settings.weeklyDay ?? 1) + 6) % 7;
  if (currentFromMonday < targetFromMonday) return false;
  if (currentFromMonday > targetFromMonday) return true;
  return parts.hour >= Number(settings.weeklyHour ?? 8);
}

function pagination(query = {}) {
  const page = Number(query.page ?? 1);
  const limit = Number(query.limit ?? DEFAULT_LIMIT);
  if (!Number.isInteger(page) || page < 1 || page > 100000) {
    throw new DigestError("page must be an integer between 1 and 100000");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new DigestError(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return { page, limit, skip: (page - 1) * limit };
}

function pageMetadata(page, limit, total) {
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

function taskScope({ firmId, userId, kind, noticeCasesEnabled }) {
  return {
    firmId: new mongoose.Types.ObjectId(String(firmId)),
    isActive: true,
    ...(kind === DAILY_KIND
      ? { assignedTo: new mongoose.Types.ObjectId(String(userId)) }
      : {}),
    ...(noticeCasesEnabled ? {} : { source: { $ne: "CASE" } }),
  };
}

async function buildDigestSummary({
  firmId,
  userId,
  kind,
  periodKey,
  timezone,
  noticeCasesEnabled,
  now = new Date(),
}) {
  if (!DIGEST_KINDS.has(kind)) throw new DigestError("Digest kind is invalid");
  const scope = taskScope({ firmId, userId, kind, noticeCasesEnabled });
  const localTodayKey = zonedParts(now, timezone).dateKey;
  const todayISO = `${localTodayKey}T00:00:00.000Z`;
  const dueSoonISO = `${addDateKeyDays(localTodayKey, 8)}T00:00:00.000Z`;
  const periodStart =
    kind === WEEKLY_KIND ? zonedDateKeyStart(periodKey, timezone) : null;
  const [countsRows, completedThisWeek, topTasks] = await Promise.all([
    Task.aggregate([
      {
        $match: {
          ...scope,
          status: { $in: OPEN_STATUSES },
        },
      },
      {
        $group: {
          _id: null,
          open: { $sum: 1 },
          overdue: {
            $sum: {
              $cond: [{ $lt: ["$dueDateISO", todayISO] }, 1, 0],
            },
          },
          dueSoon: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $gte: ["$dueDateISO", todayISO] },
                    { $lt: ["$dueDateISO", dueSoonISO] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          waitingDocs: {
            $sum: { $cond: [{ $eq: ["$status", "WAITING_DOCS"] }, 1, 0] },
          },
          unassigned: {
            $sum: { $cond: [{ $eq: ["$assignedTo", null] }, 1, 0] },
          },
          case: {
            $sum: { $cond: [{ $eq: ["$source", "CASE"] }, 1, 0] },
          },
          reconciliationReview: {
            $sum: {
              $cond: [
                {
                  $or: [
                    { $eq: ["$source", "RECONCILIATION"] },
                    { $gt: ["$reconciliationExceptionCount", 0] },
                    { $eq: ["$reviewStatus", "PENDING"] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ]),
    kind === WEEKLY_KIND
      ? Task.countDocuments({
          ...scope,
          status: { $in: ["FILED", "CLOSED"] },
          completedAt: { $gte: periodStart, $lte: now },
        })
      : 0,
    Task.find({ ...scope, status: { $in: OPEN_STATUSES } })
      .select("title clientName dueDateISO status")
      .sort({ dueDateISO: 1, _id: 1 })
      .limit(10)
      .lean(),
  ]);
  const counts = countsRows[0] || {};
  return {
    kind,
    periodKey,
    timezone,
    generatedAt: now.toISOString(),
    definition: "Operational counts only; review source records before acting.",
    counts: {
      open: Number(counts.open || 0),
      overdue: Number(counts.overdue || 0),
      dueSoon: Number(counts.dueSoon || 0),
      waitingDocs: Number(counts.waitingDocs || 0),
      unassigned: kind === WEEKLY_KIND ? Number(counts.unassigned || 0) : 0,
      case: Number(counts.case || 0),
      reconciliationReview: Number(counts.reconciliationReview || 0),
      completedThisWeek: kind === WEEKLY_KIND ? completedThisWeek : 0,
    },
    topItems: topTasks.map((task) => ({
      taskId: String(task._id),
      title: String(task.title || "Task").slice(0, 240),
      clientName: String(task.clientName || "").slice(0, 160),
      dueDateISO: task.dueDateISO,
      status: task.status,
    })),
  };
}

function digestCopy(kind, periodKey) {
  return kind === DAILY_KIND
    ? {
        subject: `Daily work digest · ${periodKey}`,
        heading: "Daily personal work digest",
        periodLabel: `Local work date: ${periodKey}`,
      }
    : {
        subject: `Weekly firm summary · ${periodKey}`,
        heading: "Weekly firm operations summary",
        periodLabel: `Week starting: ${periodKey}`,
      };
}

function summaryLines(summary) {
  const counts = summary.counts || {};
  const lines = [
    { label: "Open", value: counts.open || 0 },
    { label: "Overdue", value: counts.overdue || 0 },
    { label: "Due in next 7 days", value: counts.dueSoon || 0 },
    { label: "Waiting for documents", value: counts.waitingDocs || 0 },
    { label: "Case work", value: counts.case || 0 },
    {
      label: "Reconciliation/review",
      value: counts.reconciliationReview || 0,
    },
  ];
  if (summary.kind === WEEKLY_KIND) {
    lines.push(
      { label: "Unassigned", value: counts.unassigned || 0 },
      {
        label: "Filed/closed in last 7 days",
        value: counts.completedThisWeek || 0,
      }
    );
  }
  return lines;
}

async function enqueueRecipientDigest({
  firm,
  recipient,
  kind,
  periodKey,
  noticeCasesEnabled,
  now,
}) {
  const existing = await DigestDelivery.findOne({
    firmId: firm._id,
    recipientUserId: recipient._id,
    kind,
    periodKey,
  });
  let delivery = existing;
  if (!delivery) {
    const summary = await buildDigestSummary({
      firmId: firm._id,
      userId: recipient._id,
      kind,
      periodKey,
      timezone: firm.timezone,
      noticeCasesEnabled,
      now,
    });
    const copy = digestCopy(kind, periodKey);
    const preferences = effectivePreferences(recipient);
    const emailEnabled = preferences.emailEnabled;
    delivery = await DigestDelivery.findOneAndUpdate(
      {
        firmId: firm._id,
        recipientUserId: recipient._id,
        kind,
        periodKey,
      },
      {
        $setOnInsert: {
          firmId: firm._id,
          recipientUserId: recipient._id,
          kind,
          periodKey,
          timezone: firm.timezone,
          subject: copy.subject,
          summary,
          status: emailEnabled ? "QUEUED" : "DELIVERED",
          email: { state: emailEnabled ? "PENDING" : "DISABLED" },
          inApp: emailEnabled
            ? { state: "HIDDEN" }
            : { state: "AVAILABLE", availableAt: now },
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }

  if (["PENDING", "FAILED"].includes(delivery.email?.state)) {
    const job = await enqueueJob({
      firmId: firm._id,
      kind: DIGEST_JOB_KIND,
      idempotencyKey: `digest:${delivery._id}`,
      payload: { deliveryId: String(delivery._id) },
      createdBy: recipient._id,
      requestId: `digest-scheduler:${periodKey}`,
      maxAttempts: 5,
    });
    if (String(delivery.automationJobId || "") !== String(job._id)) {
      await DigestDelivery.updateOne(
        { _id: delivery._id, automationJobId: null },
        { $set: { automationJobId: job._id } }
      );
    }
  }
  return delivery;
}

export async function enqueueDueDigests({ now = new Date() } = {}) {
  const [dailyEnabled, weeklyEnabled, noticeCasesEnabled] = await Promise.all([
    AppConfig.isFeatureEnabled("dailyDigest", { fresh: true }),
    AppConfig.isFeatureEnabled("weeklySummary", { fresh: true }),
    AppConfig.isFeatureEnabled("noticeCases", { fresh: true }),
  ]);
  if (!dailyEnabled && !weeklyEnabled) {
    return { firms: 0, daily: 0, weekly: 0, disabled: true };
  }

  const result = { firms: 0, daily: 0, weekly: 0, disabled: false };
  let afterId = null;
  while (true) {
    const firms = await Firm.find({
      isActive: true,
      ...(afterId ? { _id: { $gt: afterId } } : {}),
    })
      .select("timezone digestSettings")
      .sort({ _id: 1 })
      .limit(FIRM_SCAN_BATCH)
      .lean();
    if (!firms.length) break;

    for (const firm of firms) {
      const timezone = validTimezone(firm.timezone)
        ? firm.timezone
        : "Asia/Kolkata";
      firm.timezone = timezone;
      const parts = zonedParts(now, timezone);
      const settings = {
        dailyHour: Number(firm.digestSettings?.dailyHour ?? 8),
        weeklyDay: Number(firm.digestSettings?.weeklyDay ?? 1),
        weeklyHour: Number(firm.digestSettings?.weeklyHour ?? 8),
      };
      const dailyDue = dailyEnabled && parts.hour >= settings.dailyHour;
      const firmWeeklyDue = weeklyEnabled && weeklyDue(parts, settings);
      if (!dailyDue && !firmWeeklyDue) continue;

      const recipients = await User.find({ firmId: firm._id, isActive: true })
        .select("role digestPreferences")
        .lean();
      for (const recipient of recipients) {
        const preferences = effectivePreferences(recipient);
        if (dailyDue && preferences.dailyEnabled) {
          await enqueueRecipientDigest({
            firm,
            recipient,
            kind: DAILY_KIND,
            periodKey: parts.dateKey,
            noticeCasesEnabled,
            now,
          });
          result.daily += 1;
        }
        if (
          firmWeeklyDue &&
          recipient.role === "FIRM_ADMIN" &&
          preferences.weeklyEnabled
        ) {
          await enqueueRecipientDigest({
            firm,
            recipient,
            kind: WEEKLY_KIND,
            periodKey: weekStartKey(parts),
            noticeCasesEnabled,
            now,
          });
          result.weekly += 1;
        }
      }
      result.firms += 1;
    }
    afterId = firms[firms.length - 1]._id;
    if (firms.length < FIRM_SCAN_BATCH) break;
  }
  return result;
}

export async function processDigestDeliveryJob(job, { assertLease } = {}) {
  const deliveryId = String(job.payload?.deliveryId || "");
  if (!validObjectId(deliveryId)) {
    throw new Error("Digest job payload is missing a valid deliveryId");
  }
  const delivery = await DigestDelivery.findOne({
    _id: deliveryId,
    firmId: job.firmId,
  }).lean();
  if (!delivery) return { outcome: "DIGEST_DELIVERY_MISSING" };
  if (delivery.email?.state === "SENT") {
    return { outcome: "DIGEST_ALREADY_SENT", deliveryId };
  }

  const featureFlag =
    delivery.kind === DAILY_KIND ? "dailyDigest" : "weeklySummary";
  const enabled = await AppConfig.isFeatureEnabled(featureFlag, { fresh: true });
  if (!enabled) {
    await DigestDelivery.updateOne(
      { _id: delivery._id, "email.state": { $ne: "SENT" } },
      {
        $set: {
          status: "PARTIAL",
          "email.state": "ROLLOUT_BLOCKED",
          "email.lastError": "Feature rollout disabled before email delivery",
          "inApp.state": "AVAILABLE",
          "inApp.availableAt": new Date(),
        },
      }
    );
    return { outcome: "DIGEST_ROLLOUT_BLOCKED", deliveryId };
  }

  const recipient = await User.findOne({
    _id: delivery.recipientUserId,
    firmId: delivery.firmId,
    isActive: true,
  })
    .select("email digestPreferences")
    .lean();
  if (!recipient) {
    await DigestDelivery.updateOne(
      { _id: delivery._id, "email.state": { $ne: "SENT" } },
      {
        $set: {
          status: "FAILED",
          "email.state": "FAILED",
          "email.lastError": "Recipient is inactive or unavailable",
        },
      }
    );
    return { outcome: "DIGEST_RECIPIENT_UNAVAILABLE", deliveryId };
  }
  if (!effectivePreferences(recipient).emailEnabled) {
    await DigestDelivery.updateOne(
      { _id: delivery._id, "email.state": { $ne: "SENT" } },
      {
        $set: {
          status: "DELIVERED",
          "email.state": "DISABLED",
          "email.lastError": "",
          "inApp.state": "AVAILABLE",
          "inApp.availableAt": new Date(),
        },
      }
    );
    return { outcome: "DIGEST_EMAIL_DISABLED_IN_APP_AVAILABLE", deliveryId };
  }

  const copy = digestCopy(delivery.kind, delivery.periodKey);
  try {
    if (assertLease) await assertLease();
    const response = await sendDigestEmail({
      toEmail: recipient.email,
      subject: delivery.subject,
      heading: copy.heading,
      periodLabel: copy.periodLabel,
      lines: summaryLines(delivery.summary),
      idempotencyKey: `digest-delivery:${delivery._id}`,
    });
    if (assertLease) await assertLease();
    const updated = await DigestDelivery.findOneAndUpdate(
      { _id: delivery._id, "email.state": { $ne: "SENT" } },
      {
        $set: {
          status: "DELIVERED",
          "email.state": "SENT",
          "email.providerMessageId": String(
            response?.data?.id || response?.id || ""
          ).slice(0, 240),
          "email.lastError": "",
          "email.sentAt": new Date(),
        },
        $inc: { "email.attempts": 1 },
      },
      { new: true }
    );
    await safeRecordActivity({
      firmId: delivery.firmId,
      actorUserId: delivery.recipientUserId,
      source: "AUTOMATION",
      action: "DIGEST_EMAIL_SENT",
      entityType: "DigestDelivery",
      entityId: delivery._id,
      requestId: job.requestId,
      metadata: { kind: delivery.kind, periodKey: delivery.periodKey },
    });
    return {
      outcome: updated ? "DIGEST_EMAIL_SENT" : "DIGEST_ALREADY_SENT",
      deliveryId,
    };
  } catch (error) {
    await DigestDelivery.updateOne(
      { _id: delivery._id, "email.state": { $ne: "SENT" } },
      {
        $set: {
          status: "PARTIAL",
          "email.state": "FAILED",
          "email.lastError": safeError(error),
          "inApp.state": "AVAILABLE",
          "inApp.availableAt": new Date(),
        },
        $inc: { "email.attempts": 1 },
      }
    );
    await safeRecordActivity({
      firmId: delivery.firmId,
      actorUserId: delivery.recipientUserId,
      source: "AUTOMATION",
      action: "DIGEST_EMAIL_FAILED_IN_APP_AVAILABLE",
      entityType: "DigestDelivery",
      entityId: delivery._id,
      requestId: job.requestId,
      metadata: { kind: delivery.kind, periodKey: delivery.periodKey },
    });
    throw error;
  }
}

export async function getDigestPreferences({ userId, firmId }) {
  const [user, firm, flags] = await Promise.all([
    User.findOne({ _id: userId, firmId, isActive: true })
      .select("role digestPreferences")
      .lean(),
    Firm.findOne({ _id: firmId, isActive: true })
      .select("timezone digestSettings")
      .lean(),
    AppConfig.getFeatureFlags(),
  ]);
  if (!user || !firm) {
    throw new DigestError("User or firm is unavailable", 404, "DIGEST_SCOPE_NOT_FOUND");
  }
  return {
    preferences: effectivePreferences(user),
    timezone: firm.timezone || "Asia/Kolkata",
    schedule: {
      dailyHour: Number(firm.digestSettings?.dailyHour ?? 8),
      weeklyDay: Number(firm.digestSettings?.weeklyDay ?? 1),
      weeklyHour: Number(firm.digestSettings?.weeklyHour ?? 8),
    },
    availability: {
      daily: flags.dailyDigest === true,
      weekly: flags.weeklySummary === true,
    },
    weeklyRecipientPolicy: "ACTIVE_FIRM_ADMINS",
    role: user.role,
  };
}

export async function updateDigestPreferences({
  userId,
  firmId,
  input,
  requestId = "",
}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new DigestError("Digest preferences object is required");
  }
  const allowed = ["dailyEnabled", "weeklyEnabled", "emailEnabled"];
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new DigestError(`Unsupported digest preferences: ${unknown.join(", ")}`);
  }
  const update = {};
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    if (typeof input[key] !== "boolean") {
      throw new DigestError(`${key} must be boolean`);
    }
    update[`digestPreferences.${key}`] = input[key];
  }
  if (!Object.keys(update).length) {
    throw new DigestError("No digest preferences to update");
  }
  const before = await User.findOne({ _id: userId, firmId, isActive: true })
    .select("digestPreferences")
    .lean();
  if (!before) {
    throw new DigestError("User is unavailable", 404, "DIGEST_USER_NOT_FOUND");
  }
  const user = await User.findOneAndUpdate(
    { _id: userId, firmId, isActive: true },
    { $set: update },
    { new: true, runValidators: true }
  )
    .select("digestPreferences")
    .lean();
  await safeRecordActivity({
    firmId,
    actorUserId: userId,
    source: "USER",
    action: "DIGEST_PREFERENCES_UPDATED",
    entityType: "User",
    entityId: userId,
    beforeSummary: effectivePreferences(before),
    afterSummary: effectivePreferences(user),
    requestId,
  });
  return effectivePreferences(user);
}

export async function updateFirmDigestSettings({
  userId,
  firmId,
  input,
  requestId = "",
}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new DigestError("Firm digest settings object is required");
  }
  const allowed = ["timezone", "dailyHour", "weeklyDay", "weeklyHour"];
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new DigestError(`Unsupported firm digest settings: ${unknown.join(", ")}`);
  }
  const update = {};
  if (Object.prototype.hasOwnProperty.call(input, "timezone")) {
    const timezone = String(input.timezone || "").trim();
    if (!timezone || timezone.length > 80 || !validTimezone(timezone)) {
      throw new DigestError("timezone must be a valid IANA time zone");
    }
    update.timezone = timezone;
  }
  for (const [key, max] of [
    ["dailyHour", 23],
    ["weeklyDay", 6],
    ["weeklyHour", 23],
  ]) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    if (!Number.isInteger(input[key]) || input[key] < 0 || input[key] > max) {
      throw new DigestError(`${key} must be an integer between 0 and ${max}`);
    }
    update[`digestSettings.${key}`] = input[key];
  }
  if (!Object.keys(update).length) {
    throw new DigestError("No firm digest settings to update");
  }
  const before = await Firm.findOne({ _id: firmId, isActive: true })
    .select("timezone digestSettings")
    .lean();
  if (!before) {
    throw new DigestError("Firm is unavailable", 404, "DIGEST_FIRM_NOT_FOUND");
  }
  const firm = await Firm.findOneAndUpdate(
    { _id: firmId, isActive: true },
    { $set: update },
    { new: true, runValidators: true }
  )
    .select("timezone digestSettings")
    .lean();
  await safeRecordActivity({
    firmId,
    actorUserId: userId,
    source: "USER",
    action: "FIRM_DIGEST_SETTINGS_UPDATED",
    entityType: "Firm",
    entityId: firmId,
    beforeSummary: before,
    afterSummary: firm,
    requestId,
  });
  return firm;
}

export async function previewDigest({
  userId,
  firmId,
  role,
  kind,
  dailyEnabled,
  weeklyEnabled,
  noticeCasesEnabled,
  now = new Date(),
}) {
  if (!DIGEST_KINDS.has(kind)) throw new DigestError("Digest kind is invalid");
  if (kind === DAILY_KIND && !dailyEnabled) {
    throw new DigestError("Daily digest is unavailable", 404, "DAILY_DIGEST_DISABLED");
  }
  if (kind === WEEKLY_KIND && !weeklyEnabled) {
    throw new DigestError("Weekly summary is unavailable", 404, "WEEKLY_SUMMARY_DISABLED");
  }
  if (kind === WEEKLY_KIND && role !== "FIRM_ADMIN") {
    throw new DigestError("Weekly firm summary is firm-admin only", 403, "FIRM_ADMIN_ONLY");
  }
  const firm = await Firm.findOne({ _id: firmId, isActive: true })
    .select("timezone")
    .lean();
  if (!firm) throw new DigestError("Firm is unavailable", 404);
  const timezone = validTimezone(firm.timezone) ? firm.timezone : "Asia/Kolkata";
  const parts = zonedParts(now, timezone);
  const periodKey = kind === DAILY_KIND ? parts.dateKey : weekStartKey(parts);
  return buildDigestSummary({
    firmId,
    userId,
    kind,
    periodKey,
    timezone,
    noticeCasesEnabled,
    now,
  });
}

export async function listDigestInbox({ userId, firmId, query = {} }) {
  const { page, limit, skip } = pagination(query);
  const filter = {
    firmId,
    recipientUserId: userId,
    "inApp.state": { $in: ["AVAILABLE", "READ"] },
  };
  const [total, items] = await Promise.all([
    DigestDelivery.countDocuments(filter),
    DigestDelivery.find(filter)
      .select("kind periodKey timezone subject summary status email inApp createdAt")
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
  ]);
  return {
    items: items.map((item) => ({
      id: String(item._id),
      kind: item.kind,
      periodKey: item.periodKey,
      timezone: item.timezone,
      subject: item.subject,
      summary: item.summary,
      status: item.status,
      emailState: item.email?.state,
      inAppState: item.inApp?.state,
      availableAt: item.inApp?.availableAt || null,
      readAt: item.inApp?.readAt || null,
      createdAt: item.createdAt,
    })),
    pagination: pageMetadata(page, limit, total),
  };
}

export async function markDigestRead({ deliveryId, userId, firmId }) {
  if (!validObjectId(deliveryId)) throw new DigestError("Digest id is invalid");
  const delivery = await DigestDelivery.findOneAndUpdate(
    {
      _id: deliveryId,
      firmId,
      recipientUserId: userId,
      "inApp.state": { $in: ["AVAILABLE", "READ"] },
    },
    {
      $set: {
        "inApp.state": "READ",
        "inApp.readAt": new Date(),
      },
    },
    { new: true }
  ).lean();
  if (!delivery) {
    throw new DigestError("Digest not found", 404, "DIGEST_NOT_FOUND");
  }
  return { id: String(delivery._id), inAppState: delivery.inApp.state };
}

export {
  DAILY_KIND,
  DIGEST_JOB_KIND,
  DigestError,
  FIRM_SCAN_BATCH,
  WEEKLY_KIND,
  buildDigestSummary,
  effectivePreferences,
  summaryLines,
  validTimezone,
  zonedParts,
};
