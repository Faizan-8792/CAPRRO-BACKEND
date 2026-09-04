// src/controllers/reminder.controller.js

import { randomUUID } from "node:crypto";
import Reminder from "../models/Reminder.js";
import User from "../models/User.js";
import AppConfig from "../models/AppConfig.js";
import { sendComplianceReminderEmail } from "../services/reminder.service.js";
import { safeRecordActivity } from "../services/activity.service.js";
import { parseStatutoryDayIso } from "../services/robust-normalize.service.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DELIVERY_LOCK_MS = 10 * 60 * 1000;
const FULL_DEFAULT_OFFSETS = Object.freeze([-7, -3, -1, 0]);
const LEGACY_DEFAULT_OFFSETS = Object.freeze([-1, 0]);
const RETRY_DELAYS_MS = Object.freeze([
  15 * 60 * 1000,
  60 * 60 * 1000,
  4 * 60 * 60 * 1000,
  12 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
]);

async function includeCaseReminders() {
  return AppConfig.isFeatureEnabled("noticeCases", { fresh: true });
}

function capturedNoticeCasesEnabled(req) {
  return req.featureFlagStates?.noticeCases?.enabled === true;
}

function scopeCaseReminders(filter, includeCaseRemindersInResponse) {
  if (!includeCaseRemindersInResponse) filter.source = { $ne: "CASE" };
  return filter;
}

const DELIVERY_UNCONFIRMED_STATUS = "DELIVERY_STATE_UNCONFIRMED";
const DELIVERY_ATTEMPT_KEY_PATTERN = /^v[1-9]\d*_(?:immediate|offset_(?:m[1-9]\d*|0|[1-9]\d*))$/;

function reminderVisibilityFilter(user) {
  const ownReminder = { userId: user.id };
  if (user.role === "FIRM_ADMIN" && user.firmId) {
    return { $or: [ownReminder, { firmId: user.firmId }] };
  }
  return ownReminder;
}

function deliveryAttemptView(attempt = {}) {
  return {
    kind: attempt.kind || null,
    offset: Number.isInteger(Number(attempt.offset)) ? Number(attempt.offset) : null,
    scheduleVersion: Math.max(1, Number(attempt.scheduleVersion) || 1),
    provider: attempt.provider || null,
    status: attempt.status || "UNKNOWN",
    attemptCount: Math.max(0, Number(attempt.attemptCount) || 0),
    lastAttemptAt: attempt.lastAttemptAt || null,
    nextAttemptAt: attempt.nextAttemptAt || null,
    sentAt: attempt.sentAt || null,
    lastError: attempt.lastError || "",
    providerCallStartedAt: attempt.providerCallStartedAt || null,
    providerMessageId: attempt.providerMessageId || null,
    resolution: attempt.resolution || null,
    resolvedAt: attempt.resolvedAt || null,
    resolvedBy: attempt.resolvedBy || null,
    resolutionNote: attempt.resolutionNote || "",
  };
}

// Exported so super.controller.js's fleet-wide delivery-monitoring stat (T1,
// .kiro/PLAN.md) reuses this exact definition of "delivery trouble" rather
// than a second, possibly-diverging one.
export function deliveryHealth(reminder, now = new Date()) {
  const staleBefore = new Date(now.getTime() - DELIVERY_LOCK_MS);
  const activeScheduleVersion = Math.max(
    1,
    Number(reminder?.scheduleVersion) || 1
  );
  const issues = getAttemptEntries(reminder).flatMap(([key, attempt = {}]) => {
    const lockedAt = attempt.lockedAt ? new Date(attempt.lockedAt) : null;
    const staleProcessing =
      attempt.status === "PROCESSING" &&
      lockedAt &&
      !Number.isNaN(lockedAt.getTime()) &&
      lockedAt <= staleBefore;
    const keyVersion = /^v([1-9]\d*)_/.exec(key);
    const attemptScheduleVersion = Math.max(
      1,
      Number(attempt.scheduleVersion) || Number(keyVersion?.[1]) || 1
    );
    const activeSchedule = attemptScheduleVersion === activeScheduleVersion;
    const providerOutcomeUnconfirmed =
      attempt.status === DELIVERY_UNCONFIRMED_STATUS ||
      (staleProcessing && attempt.providerCallStartedAt);
    const activeFailure = activeSchedule && attempt.status === "FAILED";
    const activeStaleClaim =
      activeSchedule && staleProcessing && !attempt.providerCallStartedAt;
    const supersededUnresolved =
      !activeSchedule &&
      (attempt.status === "FAILED" ||
        (staleProcessing && !attempt.providerCallStartedAt));
    if (
      !providerOutcomeUnconfirmed &&
      !activeFailure &&
      !activeStaleClaim &&
      !supersededUnresolved
    ) {
      return [];
    }
    return [{
      key,
      ...deliveryAttemptView(attempt),
      scheduleVersion: attemptScheduleVersion,
      status: providerOutcomeUnconfirmed
        ? DELIVERY_UNCONFIRMED_STATUS
        : supersededUnresolved
          ? "SUPERSEDED_ATTEMPT"
          : attempt.status,
      recovery: providerOutcomeUnconfirmed
        ? "VERIFY_PROVIDER_THEN_RESOLVE"
        : supersededUnresolved
          ? "NONE_SUPERSEDED_SCHEDULE"
          : activeFailure
            ? "AUTOMATIC_RETRY_SCHEDULED"
            : "SAFE_STALE_CLAIM_RECOVERY",
    }];
  });
  const status = issues.some((issue) => issue.status === DELIVERY_UNCONFIRMED_STATUS)
    ? DELIVERY_UNCONFIRMED_STATUS
    : issues.some((issue) => issue.status === "FAILED")
      ? "RETRY_SCHEDULED"
      : issues.some((issue) => issue.status === "PROCESSING")
        ? "STALE_CLAIM"
        : issues.some((issue) => issue.status === "SUPERSEDED_ATTEMPT")
          ? "HISTORICAL_ATTEMPTS_PRESENT"
          : "HEALTHY";
  return { status, issueCount: issues.length, issues };
}

function reminderView(reminder) {
  const value = reminder?.toObject ? reminder.toObject() : { ...reminder };
  return {
    ...value,
    deliveryAttempts: Object.fromEntries(
      getAttemptEntries(reminder).map(([key, attempt]) => [key, deliveryAttemptView(attempt)])
    ),
    deliveryHealth: deliveryHealth(reminder),
  };
}

async function rejectCaseProjectionMutation(reminder, res) {
  if (reminder?.source !== "CASE") return false;
  const enabled = await includeCaseReminders();
  res.status(enabled ? 409 : 404).json({
    ok: false,
    error: enabled
      ? "Case-generated reminders are server-managed and cannot be changed through generic reminder routes"
      : "Reminder not found",
    ...(enabled ? { code: "CASE_PROJECTION_READ_ONLY" } : {}),
  });
  return true;
}

function utcDayStart(value) {
  const date = new Date(value);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function getRelativeOffset(dueDate, now) {
  const daysUntilDue = Math.round((utcDayStart(dueDate) - utcDayStart(now)) / DAY_MS);
  return -daysUntilDue;
}

function normalizeOffsets(offsets, fallback) {
  if (!Array.isArray(offsets)) return [...fallback];

  const normalized = [...new Set(offsets
    .map(Number)
    .filter((value) => Number.isInteger(value) && value >= -365 && value <= 365))]
    .sort((a, b) => a - b);

  return normalized.length ? normalized : [...fallback];
}

function attemptKey(kind, offset, scheduleVersion = 1) {
  const version = Math.max(1, Number(scheduleVersion) || 1);
  const suffix = kind === "IMMEDIATE"
    ? "immediate"
    : `offset_${offset < 0 ? `m${Math.abs(offset)}` : offset}`;
  return `v${version}_${suffix}`;
}

function legacyAttemptKey(kind, offset) {
  if (kind === "IMMEDIATE") return "immediate";
  return `offset_${offset < 0 ? `m${Math.abs(offset)}` : offset}`;
}

function getAttempt(reminder, key) {
  const attempts = reminder?.deliveryAttempts;
  if (!attempts) return null;
  if (attempts instanceof Map) return attempts.get(key) || null;
  return attempts[key] || null;
}

function getScheduleAttempt(reminder, kind, offset) {
  const version = Math.max(1, Number(reminder?.scheduleVersion) || 1);
  return (
    getAttempt(reminder, attemptKey(kind, offset, version)) ||
    (version === 1 ? getAttempt(reminder, legacyAttemptKey(kind, offset)) : null)
  );
}

// Exported for the same reason as deliveryHealth above.
export function getAttemptEntries(reminder) {
  const attempts = reminder?.deliveryAttempts;
  if (!attempts) return [];
  if (attempts instanceof Map) return [...attempts.entries()];
  return Object.entries(attempts);
}

function retryDelay(attemptCount) {
  const index = Math.min(
    Math.max(Number(attemptCount || 1) - 1, 0),
    RETRY_DELAYS_MS.length - 1
  );
  return RETRY_DELAYS_MS[index];
}

function safeDeliveryError(error) {
  const code = String(error?.code || error?.name || "DELIVERY_FAILED").slice(0, 80);
  const message = String(error?.message || "Email delivery failed")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 400);
  return `${code}: ${message}`;
}

function scheduleVersionFilter(scheduleVersion) {
  const version = Math.max(1, Number(scheduleVersion) || 1);
  return version === 1
    ? { $or: [{ scheduleVersion: 1 }, { scheduleVersion: { $exists: false } }] }
    : { scheduleVersion: version };
}

async function claimDelivery(reminderId, spec, now) {
  const scheduleVersion = Math.max(1, Number(spec.scheduleVersion) || 1);
  const key = attemptKey(spec.kind, spec.offset, scheduleVersion);
  const path = `deliveryAttempts.${key}`;
  const claimToken = randomUUID();
  const staleBefore = new Date(now.getTime() - DELIVERY_LOCK_MS);

  const dedupFilter = spec.kind === "IMMEDIATE"
    ? { sentImmediate: { $ne: true } }
    : { firedOffsets: { $ne: spec.offset } };

  const reminder = await Reminder.findOneAndUpdate(
    {
      _id: reminderId,
      isActive: true,
      ...dedupFilter,
      $and: [
        scheduleVersionFilter(scheduleVersion),
        {
          $or: [
            { [`${path}.status`]: { $exists: false } },
            {
              [`${path}.status`]: "FAILED",
              [`${path}.nextAttemptAt`]: { $lte: now },
            },
            {
              [`${path}.status`]: "PROCESSING",
              [`${path}.lockedAt`]: { $lte: staleBefore },
              [`${path}.providerCallStartedAt`]: { $exists: false },
            },
          ],
        },
      ],
    },
    {
      $set: {
        [`${path}.kind`]: spec.kind,
        [`${path}.offset`]: spec.offset,
        [`${path}.scheduleVersion`]: scheduleVersion,
        [`${path}.provider`]: spec.provider,
        [`${path}.status`]: "PROCESSING",
        [`${path}.claimToken`]: claimToken,
        [`${path}.lockedAt`]: now,
        [`${path}.lastAttemptAt`]: now,
      },
      $inc: { [`${path}.attemptCount`]: 1 },
      $unset: {
        [`${path}.nextAttemptAt`]: "",
        [`${path}.lastError`]: "",
        [`${path}.providerCallStartedAt`]: "",
        [`${path}.providerAcceptedAt`]: "",
        [`${path}.providerMessageId`]: "",
        [`${path}.providerIdempotencyKey`]: "",
        [`${path}.resolution`]: "",
        [`${path}.resolvedAt`]: "",
        [`${path}.resolvedBy`]: "",
        [`${path}.resolutionNote`]: "",
      },
    },
    { new: true }
  );

  return reminder ? { reminder, key, path, claimToken } : null;
}

function providerDeliveryKey(reminderId, deliveryAttemptKey) {
  return `reminder-${String(reminderId)}-${deliveryAttemptKey}`.slice(0, 200);
}

async function markProviderCallStarted(claim, startedAt, providerKey) {
  return Reminder.findOneAndUpdate(
    {
      _id: claim.reminder._id,
      [`${claim.path}.status`]: "PROCESSING",
      [`${claim.path}.claimToken`]: claim.claimToken,
    },
    {
      $set: {
        [`${claim.path}.providerCallStartedAt`]: startedAt,
        [`${claim.path}.providerIdempotencyKey`]: providerKey,
      },
    },
    { new: true }
  );
}

async function sendDeliveryEmail(reminder, spec, providerKey) {
  const user = await User.findById(reminder.userId).lean();
  if (!user?.email) {
    throw new Error("Reminder owner has no deliverable email address");
  }

  // Both immediate and scheduled-offset reminders deliver through Resend (the
  // verified caprotoolkit.in domain). daysLeft is derived from the attempt's
  // offset: for IMMEDIATE we recompute it against "now"; for OFFSET the offset
  // itself is the schedule point (daysLeft = -offset).
  const offset =
    spec.kind === "IMMEDIATE"
      ? getRelativeOffset(new Date(reminder.dueDateISO), new Date())
      : spec.offset;

  return sendComplianceReminderEmail({
    toEmail: user.email,
    title: reminder.typeId,
    clientLabel: reminder.clientLabel,
    dueDateISO: reminder.dueDateISO,
    daysLeft: -offset,
    idempotencyKey: providerKey,
  });
}

async function completeDelivery(claim, spec, sentAt, providerResult = {}) {
  const successUpdate = {
    $set: {
      [`${claim.path}.status`]: "SUCCEEDED",
      [`${claim.path}.sentAt`]: sentAt,
      [`${claim.path}.providerAcceptedAt`]: sentAt,
      ...(providerResult.providerMessageId
        ? { [`${claim.path}.providerMessageId`]: providerResult.providerMessageId }
        : {}),
      sentAt,
    },
    $unset: {
      [`${claim.path}.claimToken`]: "",
      [`${claim.path}.lockedAt`]: "",
      [`${claim.path}.nextAttemptAt`]: "",
      [`${claim.path}.lastError`]: "",
    },
  };

  if (spec.kind === "IMMEDIATE") {
    successUpdate.$set.sentImmediate = true;
  }

  if (spec.kind === "OFFSET" || claim.reminder.offsets.includes(spec.offset)) {
    successUpdate.$addToSet = { firedOffsets: spec.offset };
  }

  return Reminder.findOneAndUpdate(
    {
      _id: claim.reminder._id,
      ...scheduleVersionFilter(spec.scheduleVersion),
      [`${claim.path}.status`]: "PROCESSING",
      [`${claim.path}.claimToken`]: claim.claimToken,
    },
    successUpdate,
    { new: true }
  );
}

async function completeDeliveredAttemptOnly(claim, sentAt, providerResult = {}) {
  return Reminder.findOneAndUpdate(
    {
      _id: claim.reminder._id,
      [`${claim.path}.status`]: "PROCESSING",
      [`${claim.path}.claimToken`]: claim.claimToken,
    },
    {
      $set: {
        [`${claim.path}.status`]: "SUCCEEDED",
        [`${claim.path}.sentAt`]: sentAt,
        [`${claim.path}.providerAcceptedAt`]: sentAt,
        ...(providerResult.providerMessageId
          ? { [`${claim.path}.providerMessageId`]: providerResult.providerMessageId }
          : {}),
      },
      $unset: {
        [`${claim.path}.claimToken`]: "",
        [`${claim.path}.lockedAt`]: "",
        [`${claim.path}.nextAttemptAt`]: "",
        [`${claim.path}.lastError`]: "",
      },
    },
    { new: true }
  );
}

async function persistSuccessfulDelivery(claim, spec, sentAt, providerResult = {}) {
  const completed = await completeDelivery(claim, spec, sentAt, providerResult);
  if (completed) return completed;
  return completeDeliveredAttemptOnly(claim, sentAt, providerResult);
}

async function failDelivery(claim, error, failedAt) {
  const attempt = getAttempt(claim.reminder, claim.key);
  const nextAttemptAt = new Date(
    failedAt.getTime() + retryDelay(attempt?.attemptCount)
  );

  return Reminder.findOneAndUpdate(
    {
      _id: claim.reminder._id,
      [`${claim.path}.status`]: "PROCESSING",
      [`${claim.path}.claimToken`]: claim.claimToken,
    },
    {
      $set: {
        [`${claim.path}.status`]: "FAILED",
        [`${claim.path}.lastError`]: safeDeliveryError(error),
        [`${claim.path}.nextAttemptAt`]: nextAttemptAt,
      },
      $unset: {
        [`${claim.path}.claimToken`]: "",
        [`${claim.path}.lockedAt`]: "",
      },
    },
    { new: true }
  );
}

async function markDeliveryUnconfirmed(
  claim,
  error,
  recordedAt,
  { providerAcceptedAt = null, providerMessageId = null } = {}
) {
  return Reminder.findOneAndUpdate(
    {
      _id: claim.reminder._id,
      [`${claim.path}.status`]: "PROCESSING",
      [`${claim.path}.claimToken`]: claim.claimToken,
    },
    {
      $set: {
        [`${claim.path}.status`]: DELIVERY_UNCONFIRMED_STATUS,
        [`${claim.path}.lastError`]: safeDeliveryError(error),
        [`${claim.path}.unconfirmedAt`]: recordedAt,
        ...(providerAcceptedAt
          ? { [`${claim.path}.providerAcceptedAt`]: providerAcceptedAt }
          : {}),
        ...(providerMessageId
          ? { [`${claim.path}.providerMessageId`]: providerMessageId }
          : {}),
      },
      $unset: {
        [`${claim.path}.claimToken`]: "",
        [`${claim.path}.lockedAt`]: "",
        [`${claim.path}.nextAttemptAt`]: "",
      },
    },
    { new: true }
  );
}

async function releaseDeliveryClaim(claim) {
  return Reminder.findOneAndUpdate(
    {
      _id: claim.reminder._id,
      [`${claim.path}.status`]: "PROCESSING",
      [`${claim.path}.claimToken`]: claim.claimToken,
    },
    { $unset: { [claim.path]: "" } },
    { new: true }
  );
}

async function deliverReminderAttempt(reminderId, spec, now = new Date()) {
  const claim = await claimDelivery(reminderId, spec, now);
  if (!claim) return { status: "SKIPPED" };

  const providerKey = providerDeliveryKey(claim.reminder._id, claim.key);
  let providerCallStarted = false;
  let providerAccepted = false;
  let providerResult = {};
  let sentAt = null;
  try {
    if (claim.reminder.source === "CASE") {
      await AppConfig.assertFeatureFlagVersion(
        "noticeCases",
        spec.noticeCasesVersion,
        spec.noticeCasesPublicationFence ?? null
      );
    }

    const marked = await markProviderCallStarted(claim, new Date(), providerKey);
    if (!marked) {
      const error = new Error("Provider-call start state could not be persisted");
      error.code = "DELIVERY_START_PERSISTENCE_LOST";
      throw error;
    }
    providerCallStarted = true;
    providerResult = (await sendDeliveryEmail(claim.reminder, spec, providerKey)) || {};
    providerAccepted = true;
    sentAt = new Date();

    let successReason = null;
    if (claim.reminder.source === "CASE") {
      try {
        await AppConfig.assertFeatureFlagVersion(
          "noticeCases",
          spec.noticeCasesVersion,
          spec.noticeCasesPublicationFence ?? null
        );
      } catch (error) {
        if (error?.code !== "FEATURE_ROLLOUT_CHANGED") throw error;
        successReason = "FEATURE_ROLLOUT_CHANGED_AFTER_DELIVERY";
      }
    }

    const completed = await persistSuccessfulDelivery(
      claim,
      spec,
      sentAt,
      providerResult
    );
    if (!completed) {
      const error = new Error(
        "Delivery succeeded but success state could not be persisted"
      );
      error.code = "DELIVERY_SUCCESS_PERSISTENCE_LOST";
      throw error;
    }

    if (successReason) {
      console.warn(
        `[REMINDER] Email sent for ${claim.reminder._id} (${claim.key}); ${successReason}`
      );
      return { status: "SUCCEEDED", reason: successReason };
    }

    console.log(
      `[REMINDER] Email sent for ${claim.reminder._id} (${claim.key})`
    );
    return { status: "SUCCEEDED" };
  } catch (error) {
    if (error?.code === "FEATURE_ROLLOUT_CHANGED" && !providerCallStarted) {
      await releaseDeliveryClaim(claim);
      return { status: "SKIPPED", reason: error.code };
    }

    if (providerAccepted) {
      try {
        const completed = await persistSuccessfulDelivery(
          claim,
          spec,
          sentAt || new Date(),
          providerResult
        );
        if (completed) {
          const reason =
            error?.code === "FEATURE_ROLLOUT_CHANGED"
              ? "FEATURE_ROLLOUT_CHANGED_AFTER_DELIVERY"
              : "POST_PROVIDER_STATE_RECOVERED";
          console.warn(
            `[REMINDER] Email sent for ${claim.reminder._id} (${claim.key}); ${reason}`
          );
          return { status: "SUCCEEDED", reason };
        }
      } catch (persistenceError) {
        console.error(
          `[REMINDER] Email succeeded but success persistence retry failed for ${claim.reminder._id} (${claim.key}):`,
          persistenceError
        );
      }

      await markDeliveryUnconfirmed(claim, error, new Date(), {
        providerAcceptedAt: sentAt || new Date(),
        providerMessageId: providerResult.providerMessageId || null,
      });
      console.error(
        `[REMINDER] Email succeeded but delivery state is unconfirmed for ${claim.reminder._id} (${claim.key}); automatic resend is blocked:`,
        error
      );
      return {
        status: DELIVERY_UNCONFIRMED_STATUS,
        reason: "PROVIDER_SUCCEEDED_STATE_UNCONFIRMED",
        error,
      };
    }

    if (providerCallStarted && spec.provider === "SMTP") {
      await markDeliveryUnconfirmed(claim, error, new Date());
      console.error(
        `[REMINDER] SMTP outcome is unconfirmed for ${claim.reminder._id} (${claim.key}); automatic resend is blocked:`,
        error
      );
      return {
        status: DELIVERY_UNCONFIRMED_STATUS,
        reason: "SMTP_OUTCOME_UNCONFIRMED",
        error,
      };
    }

    await failDelivery(claim, error, new Date());
    console.error(
      `[REMINDER] Delivery failed for ${claim.reminder._id} (${claim.key}):`,
      error
    );
    return { status: "FAILED", error };
  }
}

// ---- CREATE REMINDER ----

export async function createReminder(req, res) {
  try {
    const { typeId, clientLabel, dueDateISO, offsets, meta = {} } = req.body || {};
    const userId = req.user.id;

    if (!typeId || !dueDateISO) {
      return res.status(400).json({
        ok: false,
        error: "typeId and dueDateISO are required",
      });
    }

    // Strict on purpose -- new Date(string) silently mis-reads an ambiguous DD-MM/MM-DD
    // reminder date. See parseStatutoryDayIso's remarks in robust-normalize.service.js.
    let dueDate;
    try {
      dueDate = parseStatutoryDayIso(dueDateISO, "dueDateISO");
    } catch {
      return res.status(400).json({ ok: false, error: "Invalid dueDateISO" });
    }

    const [user, featureFlags] = await Promise.all([
      User.findById(userId).lean(),
      AppConfig.getFeatureFlags(),
    ]);
    if (!user) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }

    const fallbackOffsets = featureFlags.fullReminderOffsets
      ? FULL_DEFAULT_OFFSETS
      : LEGACY_DEFAULT_OFFSETS;
    const finalOffsets = normalizeOffsets(offsets, fallbackOffsets);
    const now = new Date();
    const relativeOffset = getRelativeOffset(dueDate, now);
    const daysLeft = -relativeOffset;

    const reminder = await Reminder.create({
      userId,
      firmId: user.firmId,
      typeId,
      clientLabel,
      dueDateISO: dueDate.toISOString(),
      offsets: finalOffsets,
      meta: { source: meta.source || "web", ...meta },
      isActive: true,
      sentImmediate: false,
    });

    if (daysLeft >= 0 && daysLeft <= 2) {
      await deliverReminderAttempt(
        reminder._id,
        {
          kind: "IMMEDIATE",
          offset: relativeOffset,
          provider: "RESEND",
          scheduleVersion: reminder.scheduleVersion,
        },
        now
      );
    }

    const freshReminder = await Reminder.findById(reminder._id);
    return res.json({ ok: true, reminder: reminderView(freshReminder) });
  } catch (err) {
    console.error("Create reminder error:", err);
    return res.status(500).json({ error: "Failed to create reminder" });
  }
}

// ---- LIST REMINDERS ----

export async function listReminders(req, res) {
  try {
    const filter = reminderVisibilityFilter(req.user);
    scopeCaseReminders(filter, capturedNoticeCasesEnabled(req));
    const reminders = await Reminder.find(filter)
      .sort({ dueDateISO: 1 })
      .limit(100);

    return res.json({ ok: true, reminders: reminders.map(reminderView) });
  } catch (err) {
    console.error("List reminders error:", err);
    return res.status(500).json({ error: "Failed to list reminders" });
  }
}

// ---- REMINDERS DUE TODAY ----

export async function getTodayReminders(req, res) {
  try {
    const now = new Date();
    const start = new Date(utcDayStart(now));
    const end = new Date(start.getTime() + DAY_MS);

    const visibility =
      req.user.role === "FIRM_ADMIN" && req.user.firmId
        ? { $or: [{ userId: req.user.id }, { firmId: req.user.firmId }] }
        : { userId: req.user.id };
    const filter = {
      dueDateISO: {
        $gte: start.toISOString(),
        $lt: end.toISOString(),
      },
      isActive: true,
      ...visibility,
    };
    scopeCaseReminders(filter, capturedNoticeCasesEnabled(req));
    const reminders = await Reminder.find(filter)
      .sort({ dueDateISO: 1 })
      .limit(50);

    return res.json({
      ok: true,
      reminders: reminders.map((reminder) => {
        const offsetAttempt = getScheduleAttempt(reminder, "OFFSET", 0);
        const immediateAttempt = getScheduleAttempt(reminder, "IMMEDIATE", 0);
        const immediateSentToday =
          immediateAttempt?.status === "SUCCEEDED" && immediateAttempt?.offset === 0;
        const sent = reminder.firedOffsets?.includes(0) || immediateSentToday;
        const failed =
          offsetAttempt?.status === "FAILED" ||
          (immediateAttempt?.offset === 0 && immediateAttempt?.status === "FAILED");
        const unconfirmed =
          offsetAttempt?.status === DELIVERY_UNCONFIRMED_STATUS ||
          (immediateAttempt?.offset === 0 &&
            immediateAttempt?.status === DELIVERY_UNCONFIRMED_STATUS);

        return {
          id: reminder._id,
          typeId: reminder.typeId,
          clientLabel: reminder.clientLabel,
          dueDateISO: reminder.dueDateISO,
          status: sent
            ? "SENT"
            : unconfirmed
              ? DELIVERY_UNCONFIRMED_STATUS
              : failed
                ? "RETRY_SCHEDULED"
                : "PENDING",
        };
      }),
    });
  } catch (err) {
    console.error("Get today reminders error:", err);
    return res.status(500).json({ error: "Failed to fetch reminders" });
  }
}


// ---- DEACTIVATE EVERY MANUAL REMINDER ----

/**
 * Turns off every reminder the caller could have turned off one at a time.
 *
 * There is no DELETE route for reminders and this does not add one. "Delete" here means what it
 * has always meant in this controller - `isActive: false` - so a bulk action cannot destroy
 * anything a single action would only have hidden, and the delivery history on each row survives
 * for the audit trail.
 *
 * Three parts of the filter are load-bearing:
 *
 *   - `reminderVisibilityFilter` is reused verbatim, so "all" means exactly the set GET / already
 *     returns to this caller. A firm admin turns off the firm's; anyone else turns off their own.
 *     Building a different filter here is how a bulk action ends up reaching further than the
 *     per-row one it replaces.
 *   - `source: "MANUAL"` is the bulk equivalent of rejectCaseProjectionMutation. A reminder
 *     projected from a case, a compliance rule or an engagement is not the user's to switch off,
 *     and the single-row path already answers 409 for one. Excluding them here skips them quietly
 *     instead of failing the whole call over rows the person never meant to touch.
 *   - `isActive: true` keeps the count honest. Without it the reply would claim to have changed
 *     rows that were already off.
 *
 * scheduleVersion and firedOffsets are deliberately untouched. updateReminder bumps those only
 * when the SCHEDULE changes, and switching a reminder off is not a schedule change.
 */
export async function deactivateAllReminders(req, res) {
  try {
    const filter = {
      ...reminderVisibilityFilter(req.user),
      isActive: true,
      source: "MANUAL",
    };

    const result = await Reminder.updateMany(filter, { $set: { isActive: false } });

    // 200 with zero, never 404. "There was nothing to switch off" is a successful outcome for a
    // bulk action, unlike the single-row path where a missing id is a real error.
    return res.json({
      ok: true,
      deactivated: Number(result?.modifiedCount || 0),
    });
  } catch (err) {
    console.error("Deactivate all reminders error:", err);
    return res.status(500).json({ error: "Failed to turn off reminders" });
  }
}

// ---- UPDATE REMINDER ----

export async function updateReminder(req, res) {
  try {
    const { id } = req.params;
    const { typeId, clientLabel, dueDateISO, offsets, isActive, meta } = req.body || {};
    const visibility = reminderVisibilityFilter(req.user);
    const reminder = await Reminder.findOne({ _id: id, ...visibility });

    if (!reminder) {
      return res.status(404).json({ error: "Reminder not found" });
    }
    if (await rejectCaseProjectionMutation(reminder, res)) return;

    const scheduleChanged =
      typeId !== undefined ||
      clientLabel !== undefined ||
      dueDateISO !== undefined ||
      Array.isArray(offsets);
    const updates = {};

    if (typeId !== undefined) updates.typeId = typeId;
    if (clientLabel !== undefined) updates.clientLabel = clientLabel;
    if (dueDateISO !== undefined) {
      let dueDate;
      try {
        dueDate = parseStatutoryDayIso(dueDateISO, "dueDateISO");
      } catch {
        return res.status(400).json({ ok: false, error: "Invalid dueDateISO" });
      }
      updates.dueDateISO = dueDate.toISOString();
    }
    if (Array.isArray(offsets)) updates.offsets = normalizeOffsets(offsets, []);
    if (typeof isActive === "boolean") updates.isActive = isActive;
    if (meta && typeof meta === "object") updates.meta = meta;

    if (!Object.keys(updates).length) {
      return res.json({ ok: true, reminder: reminderView(reminder) });
    }

    const updateConditions = [{ _id: reminder._id }, visibility];
    if (scheduleChanged) {
      const observedScheduleVersion = Math.max(
        1,
        Number(reminder.scheduleVersion) || 1
      );
      updateConditions.push(scheduleVersionFilter(observedScheduleVersion));
      updates.scheduleVersion = observedScheduleVersion + 1;
      updates.firedOffsets = [];
      updates.sentImmediate = false;
      updates.sentAt = null;
    }

    const updated = await Reminder.findOneAndUpdate(
      { $and: updateConditions },
      { $set: updates },
      { new: true, runValidators: true }
    );
    if (!updated) {
      return res.status(scheduleChanged ? 409 : 404).json({
        ok: false,
        error: scheduleChanged
          ? "Reminder schedule changed; refresh before saving"
          : "Reminder not found",
      });
    }

    return res.json({ ok: true, reminder: reminderView(updated) });
  } catch (err) {
    console.error("Update reminder error:", err);
    return res.status(500).json({ error: "Failed to update reminder" });
  }
}

export async function resolveReminderDeliveryAttempt(req, res, next) {
  try {
    const { id, attemptKey: rawAttemptKey } = req.params;
    const attemptKeyValue = String(rawAttemptKey || "").trim();
    const { resolution, note } = req.body || {};
    const normalizedResolution = String(resolution || "").trim().toUpperCase();
    const normalizedNote = String(note || "").trim();

    if (!DELIVERY_ATTEMPT_KEY_PATTERN.test(attemptKeyValue)) {
      return res.status(400).json({ ok: false, error: "Invalid delivery attempt key" });
    }
    if (!["MARK_SUCCEEDED", "RETRY_CONFIRMED_NOT_SENT"].includes(normalizedResolution)) {
      return res.status(400).json({ ok: false, error: "Invalid delivery resolution" });
    }
    if (!normalizedNote || normalizedNote.length > 500) {
      return res.status(400).json({
        ok: false,
        error: "A resolution note of 1-500 characters is required",
      });
    }

    const visibility = reminderVisibilityFilter(req.user);
    const reminder = await Reminder.findOne({ _id: id, ...visibility });
    if (!reminder) {
      return res.status(404).json({ ok: false, error: "Reminder not found" });
    }
    const attempt = getAttempt(reminder, attemptKeyValue);
    if (!attempt) {
      return res.status(404).json({ ok: false, error: "Delivery attempt not found" });
    }

    const now = new Date();
    const staleBefore = new Date(now.getTime() - DELIVERY_LOCK_MS);
    const lockedAt = attempt.lockedAt ? new Date(attempt.lockedAt) : null;
    const staleProviderStarted =
      attempt.status === "PROCESSING" &&
      attempt.providerCallStartedAt &&
      lockedAt &&
      !Number.isNaN(lockedAt.getTime()) &&
      lockedAt <= staleBefore;
    if (attempt.status !== DELIVERY_UNCONFIRMED_STATUS && !staleProviderStarted) {
      return res.status(409).json({
        ok: false,
        error: "Only unconfirmed provider outcomes can be resolved manually",
      });
    }

    const path = `deliveryAttempts.${attemptKeyValue}`;
    const attemptScheduleVersion = Math.max(
      1,
      Number(attempt.scheduleVersion) || 1
    );
    const affectsActiveSchedule =
      attemptScheduleVersion ===
      Math.max(1, Number(reminder.scheduleVersion) || 1);
    if (
      normalizedResolution === "RETRY_CONFIRMED_NOT_SENT" &&
      !affectsActiveSchedule
    ) {
      return res.status(409).json({
        ok: false,
        error: "Only an active-schedule delivery attempt can be retried",
      });
    }

    const eligibleAttempt = {
      $or: [
        { [`${path}.status`]: DELIVERY_UNCONFIRMED_STATUS },
        {
          [`${path}.status`]: "PROCESSING",
          [`${path}.providerCallStartedAt`]: { $exists: true },
          [`${path}.lockedAt`]: { $lte: staleBefore },
        },
      ],
    };
    const activeSuccessFields = affectsActiveSchedule
      ? {
          sentAt: now,
          ...(attempt.kind === "IMMEDIATE" ? { sentImmediate: true } : {}),
        }
      : {};
    const attemptOffset = Number(attempt.offset);
    const updatesActiveOffset =
      affectsActiveSchedule &&
      attempt.kind === "OFFSET" &&
      Number.isInteger(attemptOffset);
    const update = normalizedResolution === "MARK_SUCCEEDED"
      ? {
          $set: {
            [`${path}.status`]: "SUCCEEDED",
            [`${path}.sentAt`]: now,
            [`${path}.providerAcceptedAt`]: attempt.providerAcceptedAt || now,
            [`${path}.resolution`]: normalizedResolution,
            [`${path}.resolvedAt`]: now,
            [`${path}.resolvedBy`]: req.user.id,
            [`${path}.resolutionNote`]: normalizedNote,
            ...activeSuccessFields,
          },
          ...(updatesActiveOffset
            ? { $addToSet: { firedOffsets: attemptOffset } }
            : {}),
          $unset: {
            [`${path}.claimToken`]: "",
            [`${path}.lockedAt`]: "",
            [`${path}.nextAttemptAt`]: "",
            [`${path}.lastError`]: "",
            [`${path}.unconfirmedAt`]: "",
          },
        }
      : {
          $set: {
            [`${path}.status`]: "FAILED",
            [`${path}.nextAttemptAt`]: now,
            [`${path}.lastError`]: `OPERATOR_CONFIRMED_NOT_SENT: ${normalizedNote}`,
            [`${path}.resolution`]: normalizedResolution,
            [`${path}.resolvedAt`]: now,
            [`${path}.resolvedBy`]: req.user.id,
            [`${path}.resolutionNote`]: normalizedNote,
          },
          $unset: {
            [`${path}.claimToken`]: "",
            [`${path}.lockedAt`]: "",
            [`${path}.providerCallStartedAt`]: "",
            [`${path}.providerAcceptedAt`]: "",
            [`${path}.providerMessageId`]: "",
            [`${path}.providerIdempotencyKey`]: "",
            [`${path}.unconfirmedAt`]: "",
          },
        };

    const updateConditions = [visibility, eligibleAttempt];
    if (affectsActiveSchedule) {
      updateConditions.push(scheduleVersionFilter(attemptScheduleVersion));
    }
    const updated = await Reminder.findOneAndUpdate(
      { _id: reminder._id, $and: updateConditions },
      update,
      { new: true }
    );
    if (!updated) {
      return res.status(409).json({
        ok: false,
        error: "Delivery attempt changed; refresh before resolving",
      });
    }

    await safeRecordActivity({
      firmId: updated.firmId,
      actorUserId: req.user.id,
      source: "USER",
      action: "REMINDER_DELIVERY_RESOLVED",
      entityType: "Reminder",
      entityId: updated._id,
      beforeSummary: {
        attemptKey: attemptKeyValue,
        status: attempt.status,
      },
      afterSummary: {
        attemptKey: attemptKeyValue,
        status: getAttempt(updated, attemptKeyValue)?.status,
        resolution: normalizedResolution,
      },
      requestId: req.id,
    });

    return res.json({
      ok: true,
      reminder: reminderView(updated),
      requestId: req.id || "",
    });
  } catch (error) {
    if (!error.statusCode && error.name === "CastError") error.statusCode = 400;
    return next(error);
  }
}

// ---- SCHEDULER PROCESSING ----

export async function processReminderForNow(reminderDoc, nowUtc) {
  let noticeCasesVersion = null;
  let noticeCasesPublicationFence = null;
  if (reminderDoc?.source === "CASE") {
    const rollout = await AppConfig.getFeatureFlagState("noticeCases", {
      fresh: true,
    });
    if (!rollout.enabled) return;
    noticeCasesVersion = rollout.version;
    noticeCasesPublicationFence = rollout.publicationFence;
  }
  const now = new Date(nowUtc);
  const dueDate = new Date(reminderDoc.dueDateISO);
  if (Number.isNaN(dueDate.getTime())) return;

  const featureFlags = await AppConfig.getFeatureFlags();
  const activeScheduleVersion = Math.max(
    1,
    Number(reminderDoc.scheduleVersion) || 1
  );

  if (featureFlags.reliableReminderDelivery) {
    for (const [key, attempt] of getAttemptEntries(reminderDoc)) {
      const keyVersionMatch = /^v(\d+)_/.exec(key);
      const attemptScheduleVersion = Math.max(
        1,
        Number(attempt?.scheduleVersion) || Number(keyVersionMatch?.[1]) || 1
      );
      if (
        attemptScheduleVersion !== activeScheduleVersion ||
        attempt?.status !== "FAILED" ||
        !attempt?.nextAttemptAt ||
        new Date(attempt.nextAttemptAt) > now
      ) {
        continue;
      }

      const kind = attempt.kind === "IMMEDIATE" ? "IMMEDIATE" : "OFFSET";
      const offset = Number(attempt.offset);
      if (!Number.isInteger(offset)) continue;

      await deliverReminderAttempt(
        reminderDoc._id,
        {
          kind,
          offset,
          provider: "RESEND",
          scheduleVersion: activeScheduleVersion,
          noticeCasesVersion,
          noticeCasesPublicationFence,
        },
        now
      );

      // Retry and current-offset delivery are coalesced to one message per tick.
      return;
    }
  }

  const relativeOffset = getRelativeOffset(dueDate, now);
  if (
    !reminderDoc.offsets.includes(relativeOffset) ||
    reminderDoc.firedOffsets?.includes(relativeOffset)
  ) {
    return;
  }

  const immediateAttempt = getScheduleAttempt(
    reminderDoc,
    "IMMEDIATE",
    relativeOffset
  );
  if (
    immediateAttempt?.offset === relativeOffset &&
    ["PROCESSING", "FAILED", "SUCCEEDED"].includes(immediateAttempt?.status)
  ) {
    return;
  }

  await deliverReminderAttempt(
    reminderDoc._id,
    {
      kind: "OFFSET",
      offset: relativeOffset,
      provider: "RESEND",
      scheduleVersion: activeScheduleVersion,
      noticeCasesVersion,
      noticeCasesPublicationFence,
    },
    now
  );
}
