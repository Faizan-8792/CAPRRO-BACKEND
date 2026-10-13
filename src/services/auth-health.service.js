// src/services/auth-health.service.js
//
// Fire-and-forget recording of privacy-safe authentication reliability
// events (PHASE 8 section D). The contract with every caller: this NEVER
// throws, NEVER blocks, and NEVER receives a token, cookie, password, or any
// other secret - only coarse categories. A telemetry failure must never
// break sign-in or a request, so every write is detached and its error is
// swallowed into a single coarse console warning (no identifiers attached).
//
// Write amplification guard: the authentication middleware records a
// rejection for every refused request, and most refused requests are
// anonymous (no token, a forged token) - a bot probing /api/* would
// otherwise cost one database write per request. Events are therefore
// buffered in memory and identical ones (same kind, reason, platform,
// version, user) are coalesced into a single row carrying a `count`, flushed
// every FLUSH_INTERVAL_MS. The write rate is bounded by the number of
// distinct keys, not by the request rate.

import AuthHealthEvent, {
  AUTH_HEALTH_KINDS,
  AUTH_HEALTH_REASONS,
  AUTH_HEALTH_PLATFORMS,
} from "../models/AuthHealthEvent.js";

const FLUSH_INTERVAL_MS = 30 * 1000;
// Beyond this many distinct keys in one window, new events drop their user
// and version and fold into a per-kind/reason/platform row, so memory stays
// bounded while the totals stay exact.
const MAX_PENDING_KEYS = 2000;
// Session-duration math pairs per-user events; more users than this in one
// window are not examined (the totals above it remain exact).
const DURATION_USER_CAP = 5000;

const pending = new Map();
let flushTimer = null;
let flushing = null;

const warnBudget = { count: 0, resetAt: 0 };

function throttledWarn(message) {
  const now = Date.now();
  if (now > warnBudget.resetAt) {
    warnBudget.count = 0;
    warnBudget.resetAt = now + 10 * 60 * 1000;
  }
  warnBudget.count += 1;
  if (warnBudget.count <= 3) {
    console.warn(`[auth-health] ${message}`);
  }
}

function platformOf(value) {
  const text = String(value || "").toLowerCase();
  return AUTH_HEALTH_PLATFORMS.includes(text) ? text : "unknown";
}

function reasonOf(value) {
  const text = String(value || "").toLowerCase();
  return AUTH_HEALTH_REASONS.includes(text) ? text : "unknown";
}

function userIdOf(value) {
  const text = value ? String(value) : "";
  return /^[a-f0-9]{24}$/i.test(text) ? text : null;
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushAuthHealth();
  }, FLUSH_INTERVAL_MS);
  // Telemetry must never keep a process (or a test) alive.
  if (typeof flushTimer.unref === "function") flushTimer.unref();
}

/**
 * Records one event. Safe to call from anywhere on the request path.
 *
 * @param {object} event
 * @param {"login_success"|"login_fail"|"refresh_success"|"refresh_fail"|"auth_rejection"|"signed_out"|"session_restored"|"refresh_retry"} event.kind
 * @param {string} [event.reason] coarse category, never free text from a client
 * @param {string} [event.platform] extension | desktop | website | unknown
 * @param {string} [event.appVersion] client-reported build, length-capped
 * @param {import("mongoose").Types.ObjectId|string} [event.userId]
 */
export function recordAuthHealth({ kind, reason = "unknown", platform = "unknown", appVersion = "", userId = null } = {}) {
  // Validate rather than trust: a malformed field falls back to a safe
  // value, and an unknown kind drops the whole event.
  try {
    const kindText = String(kind || "");
    if (!AUTH_HEALTH_KINDS.includes(kindText)) return;
    const doc = {
      kind: kindText,
      reason: reasonOf(reason),
      platform: platformOf(platform),
      appVersion: String(appVersion || "").replace(/[^0-9A-Za-z.+-]/g, "").slice(0, 40),
      userId: userIdOf(userId),
    };
    let key = [doc.kind, doc.reason, doc.platform, doc.appVersion, doc.userId || ""].join("|");
    if (!pending.has(key) && pending.size >= MAX_PENDING_KEYS) {
      doc.userId = null;
      doc.appVersion = "";
      key = [doc.kind, doc.reason, doc.platform, "", ""].join("|");
    }
    const existing = pending.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      pending.set(key, { ...doc, count: 1, occurredAt: new Date() });
    }
    scheduleFlush();
  } catch {
    throttledWarn("event construction failed");
  }
}

/**
 * Writes every buffered event. Never throws. Awaitable, so shutdown and the
 * admin summary can make the store current first; tests call it directly.
 */
export async function flushAuthHealth() {
  if (flushing) await flushing.catch(() => {});
  if (pending.size === 0) return;
  const docs = [...pending.values()];
  pending.clear();
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushing = AuthHealthEvent.insertMany(docs, { ordered: false })
    .then(() => undefined)
    .catch(() => throttledWarn("event write failed (database unavailable?)"));
  try {
    await flushing;
  } finally {
    flushing = null;
  }
}

function clampDays(days) {
  return Math.max(1, Math.min(Math.floor(Number(days)) || 30, 365));
}

const COUNT = { $sum: { $ifNull: ["$count", 1] } };

// A session ends when the user signs out, or when the server refuses the
// session for a reason that needs a fresh sign-in.
const TERMINAL_REASONS = ["expired", "revoked", "inactive", "missing_user"];

/**
 * Aggregates for the admin panel: counts by day, kind, reason, platform and
 * version over the requested window. Pure aggregation - no user rows leave
 * this function, so the dashboard sees totals only.
 */
export async function authHealthSummary({ days = 30, excludeUserIds = [] } = {}) {
  await flushAuthHealth();
  const windowDays = clampDays(days);
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  // DS43: the owner's own accounts' events are left out (an event with no account stays in, since
  // nothing ties it to anyone). $nin also keeps every row whose userId is null.
  const notExcluded = excludeUserIds.length ? { userId: { $nin: excludeUserIds } } : {};
  const inWindow = { $match: { occurredAt: { $gte: since }, ...notExcluded } };

  const [byDay, byKindReason, byVersion, totals, sessionDurations] = await Promise.all([
    AuthHealthEvent.aggregate([
      inWindow,
      {
        $group: {
          _id: {
            day: { $dateToString: { format: "%Y-%m-%d", date: "$occurredAt" } },
            kind: "$kind",
          },
          count: COUNT,
        },
      },
      { $sort: { "_id.day": 1 } },
    ]),
    AuthHealthEvent.aggregate([
      inWindow,
      {
        $group: {
          _id: { kind: "$kind", reason: "$reason", platform: "$platform" },
          count: COUNT,
        },
      },
      { $sort: { count: -1 } },
    ]),
    AuthHealthEvent.aggregate([
      inWindow,
      {
        $group: {
          _id: { platform: "$platform", appVersion: "$appVersion", kind: "$kind" },
          count: COUNT,
        },
      },
      { $sort: { count: -1 } },
      { $limit: 200 },
    ]),
    AuthHealthEvent.aggregate([
      inWindow,
      { $group: { _id: "$kind", count: COUNT } },
    ]),
    // Session duration distribution: for each user, each login_success paired
    // with the NEXT terminal event for that same user (signed_out, or a
    // rejection or refresh failure whose reason needs a fresh sign-in).
    // Bounded to the window; a sign-in with no ending in-window is still a
    // live session and is not counted.
    AuthHealthEvent.aggregate([
      { $match: { occurredAt: { $gte: since }, userId: { $ne: null, ...(excludeUserIds.length ? { $nin: excludeUserIds } : {}) } } },
      { $sort: { userId: 1, occurredAt: 1 } },
      {
        $group: {
          _id: "$userId",
          events: {
            $push: { kind: "$kind", reason: "$reason", at: "$occurredAt" },
          },
        },
      },
      { $limit: DURATION_USER_CAP },
      {
        $project: {
          pairs: {
            $map: {
              input: { $range: [0, { $size: "$events" }] },
              as: "i",
              in: {
                $let: {
                  vars: {
                    ev: { $arrayElemAt: ["$events", "$$i"] },
                    rest: { $slice: ["$events", { $add: ["$$i", 1] }, { $max: [1, { $size: "$events" }] }] },
                  },
                  in: {
                    $cond: [
                      { $eq: ["$$ev.kind", "login_success"] },
                      {
                        start: "$$ev.at",
                        end: {
                          $arrayElemAt: [
                            {
                              $map: {
                                input: {
                                  $filter: {
                                    input: "$$rest",
                                    as: "r",
                                    cond: {
                                      $or: [
                                        { $eq: ["$$r.kind", "signed_out"] },
                                        {
                                          $and: [
                                            { $in: ["$$r.kind", ["auth_rejection", "refresh_fail"]] },
                                            { $in: ["$$r.reason", TERMINAL_REASONS] },
                                          ],
                                        },
                                      ],
                                    },
                                  },
                                },
                                as: "t",
                                in: "$$t.at",
                              },
                            },
                            0,
                          ],
                        },
                      },
                      null,
                    ],
                  },
                },
              },
            },
          },
        },
      },
      {
        $project: {
          durations: {
            $map: {
              input: {
                $filter: {
                  input: "$pairs",
                  as: "p",
                  cond: { $and: [{ $ne: ["$$p", null] }, { $ne: [{ $ifNull: ["$$p.end", null] }, null] }] },
                },
              },
              as: "d",
              in: { $divide: [{ $subtract: ["$$d.end", "$$d.start"] }, 3600000] },
            },
          },
        },
      },
      { $unwind: "$durations" },
      {
        $bucket: {
          groupBy: "$durations",
          boundaries: [0, 1, 6, 24, 72, 168, 720],
          default: "720+",
          output: { count: { $sum: 1 } },
        },
      },
    ]),
  ]);

  return {
    windowDays,
    since: since.toISOString(),
    byDay: byDay.map((row) => ({ day: row._id.day, kind: row._id.kind, count: row.count })),
    byKindReason: byKindReason.map((row) => ({
      kind: row._id.kind,
      reason: row._id.reason,
      platform: row._id.platform,
      count: row.count,
    })),
    byVersion: byVersion.map((row) => ({
      platform: row._id.platform,
      appVersion: row._id.appVersion || "",
      kind: row._id.kind,
      count: row.count,
    })),
    totals: Object.fromEntries(totals.map((row) => [row._id, row.count])),
    // Bucket lower bounds in hours: 0, 1, 6, 24, 72, 168 (7 days), and
    // "720+" for 30 days or more.
    sessionDurationHours: sessionDurations.map((row) => ({
      bucket: String(row._id),
      count: row.count,
    })),
  };
}
