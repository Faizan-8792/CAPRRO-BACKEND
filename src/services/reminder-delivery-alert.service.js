// src/services/reminder-delivery-alert.service.js
//
// T3 (.kiro/PLAN.md): a best-effort email alert to the owner when the
// fleet-wide failed-delivery count crosses a small threshold -- a secondary
// signal on top of T2's admin panel (GET /api/super/reminder-delivery-health),
// not a replacement for it. Reuses deliveryHealth from reminder.controller.js
// (T1) so "what counts as a delivery problem" has exactly one definition; this
// file adds only the fleet scan, the threshold, and the re-alert throttle.
//
// This runs on a server.js setInterval tick, not inside an HTTP request, so it
// calls deliveryHealth directly against a Reminder.find rather than going
// through getReminderDeliveryHealthStats (which is wired to req/res and a
// super-admin auth gate that has no meaning on a timer).

import { deliveryHealth } from "../controllers/reminder.controller.js";

export const REMINDER_DELIVERY_ALERT_THRESHOLD = 5;

// Re-alerting on every scheduler tick while the fleet stays unhealthy would
// turn one real incident into dozens of identical emails. Six hours keeps the
// owner informed on the same working day as a genuine incident, while giving
// the retry loop (RETRY_DELAYS_MS in reminder.controller.js tops out at 24h
// between attempts) real room to clear a transient problem on its own before
// a second email fires.
export const REMINDER_DELIVERY_ALERT_REALERT_MS = 6 * 60 * 60 * 1000;

// Mirrors DELIVERY_STAT_CANDIDATE_LIMIT in super.controller.js's T1 stat --
// same bound, so this scheduler's count and the admin panel's count agree.
export const REMINDER_DELIVERY_ALERT_CANDIDATE_LIMIT = 5000;

function resolveNow(nowUtc) {
  const now = nowUtc instanceof Date ? nowUtc : new Date(nowUtc ?? Date.now());
  if (!Number.isFinite(now.getTime())) {
    const error = new Error(
      "reminder delivery alert refused: nowUtc is not a valid date",
    );
    error.code = "REMINDER_DELIVERY_ALERT_INVALID_NOW";
    throw error;
  }
  return now;
}

// Counts unhealthy reminders the same way T1's getReminderDeliveryHealthStats
// does: same pre-filter, same candidate cap, same deliveryHealth call.
export async function countUnhealthyReminders({ Reminder, nowUtc, limit } = {}) {
  if (!Reminder) {
    const error = new Error(
      "reminder delivery alert refused: Reminder model was not supplied",
    );
    error.code = "REMINDER_DELIVERY_ALERT_MODEL_MISSING";
    throw error;
  }
  const now = resolveNow(nowUtc);
  const candidateLimit =
    Number.isInteger(limit) && limit > 0
      ? limit
      : REMINDER_DELIVERY_ALERT_CANDIDATE_LIMIT;

  const candidates = await Reminder.find({
    isActive: true,
    deliveryAttempts: { $ne: {} },
  })
    .select("deliveryAttempts scheduleVersion")
    .limit(candidateLimit)
    .lean();

  let issueCount = 0;
  for (const reminder of candidates) {
    if (deliveryHealth(reminder, now).status !== "HEALTHY") issueCount += 1;
  }

  return {
    issueCount,
    candidatesScanned: candidates.length,
    candidatesScanTruncated: candidates.length === candidateLimit,
  };
}

// One scheduler tick: count, decide, alert, persist. Never throws for a mail
// send failure -- server.js also wraps the caller in try/catch, but a
// provider outage is an expected, ordinary condition here, not an exceptional
// one, so it is handled locally and reported in the returned summary instead.
export async function checkReminderDeliveryHealthAndAlert({
  Reminder,
  AppConfig,
  sendAlertEmail,
  toEmail,
  nowUtc,
  threshold = REMINDER_DELIVERY_ALERT_THRESHOLD,
  realertMs = REMINDER_DELIVERY_ALERT_REALERT_MS,
} = {}) {
  if (!AppConfig) {
    const error = new Error(
      "reminder delivery alert refused: AppConfig model was not supplied",
    );
    error.code = "REMINDER_DELIVERY_ALERT_MODEL_MISSING";
    throw error;
  }
  const now = resolveNow(nowUtc);
  const { issueCount, candidatesScanned, candidatesScanTruncated } =
    await countUnhealthyReminders({ Reminder, nowUtc: now });

  if (issueCount < threshold) {
    return {
      alerted: false,
      reason: "BELOW_THRESHOLD",
      issueCount,
      candidatesScanned,
      candidatesScanTruncated,
    };
  }

  // Read the singleton directly rather than through AppConfig.getInstance().
  // getInstance() caches for 30s, which is fine for a feature flag read on
  // every request but wrong for a guard whose whole job is "did I already
  // alert recently" -- this scheduler only ticks every 15 minutes, so paying
  // for one extra direct read each time costs nothing next to that cadence,
  // and it means a stale cached value can never make this guard wrong.
  const config = await AppConfig.findById("singleton")
    .select("reminderDeliveryAlert")
    .lean();
  const lastAlertAt = config?.reminderDeliveryAlert?.lastAlertAt
    ? new Date(config.reminderDeliveryAlert.lastAlertAt)
    : null;
  const sinceLastAlertMs =
    lastAlertAt && !Number.isNaN(lastAlertAt.getTime())
      ? now.getTime() - lastAlertAt.getTime()
      : Infinity;

  if (sinceLastAlertMs < realertMs) {
    return {
      alerted: false,
      reason: "RATE_LIMITED",
      issueCount,
      candidatesScanned,
      candidatesScanTruncated,
      lastAlertAt,
    };
  }

  // lastAlertAt is written only after a successful send, deliberately not
  // before. If Resend itself is down, a full 6-hour Resend outage would also
  // be exactly the kind of incident this alert exists to surface -- writing
  // the throttle timestamp first would silence the owner for the whole
  // window without ever having reached them. Sending first means a failed
  // attempt is retried on the next 15-minute tick instead.
  try {
    await sendAlertEmail({
      toEmail,
      issueCount,
      candidatesScanned,
      candidatesScanTruncated,
      now,
    });
  } catch (error) {
    return {
      alerted: false,
      reason: "SEND_FAILED",
      issueCount,
      candidatesScanned,
      candidatesScanTruncated,
      error: String(error?.message || error),
    };
  }

  await AppConfig.findByIdAndUpdate(
    "singleton",
    {
      $set: {
        "reminderDeliveryAlert.lastAlertAt": now,
        "reminderDeliveryAlert.lastAlertIssueCount": issueCount,
      },
    },
    { upsert: true },
  );
  // Keeps AppConfig.getInstance()'s shared 30s cache honest for every other
  // reader of the singleton (feature flags, desktop release, etc.) without
  // ever invalidating it on a read path -- only this write touches the cache,
  // exactly like every other AppConfig mutation in appconfig.controller.js.
  AppConfig.invalidateCache?.();

  return {
    alerted: true,
    reason: "SENT",
    issueCount,
    candidatesScanned,
    candidatesScanTruncated,
  };
}
