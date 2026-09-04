import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import mongoose from "mongoose";
import AppConfig from "../models/AppConfig.js";
import AutomationJob from "../models/AutomationJob.js";
import DigestDelivery, {
  DIGEST_RECOVERY_CURSOR_ID,
  DigestRecoveryCursor,
} from "../models/DigestDelivery.js";
import Firm from "../models/Firm.js";
import FirmMembership from "../models/FirmMembership.js";
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
// A send claim older than this is treated as dead and may be taken over. It is
// deliberately longer than the automation job lease of 10 minutes, so a worker
// that is merely slow does not lose its claim to a second worker.
const SEND_CLAIM_STALE_MS = 15 * 60 * 1000;
const DIGEST_JOB_RECOVERY_LEASE_MS = 2 * 60 * 1000;
const DIGEST_RECOVERY_CURSOR_LEASE_MS = 2 * 60 * 1000;
const DIGEST_AUTHORITY_DEFER_MS = 30 * 1000;

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

function canonicalObjectId(value) {
  if (typeof value === "string") {
    return /^[a-f\d]{24}$/i.test(value) ? value.toLowerCase() : null;
  }
  if (!(value instanceof mongoose.Types.ObjectId)) return null;
  const canonical = value.toHexString();
  return /^[a-f\d]{24}$/.test(canonical) ? canonical.toLowerCase() : null;
}

function validObjectId(value) {
  return canonicalObjectId(value) !== null;
}

function requireCanonicalObjectId(value, label = "ObjectId") {
  const canonical = canonicalObjectId(value);
  if (!canonical) throw new TypeError(`${label} must be a canonical ObjectId`);
  return canonical;
}

function exactObjectIdClauses(fieldPath, value) {
  const canonical = requireCanonicalObjectId(value, fieldPath);
  return [
    { $eq: [{ $type: `$${fieldPath}` }, "objectId"] },
    {
      $eq: [
        `$${fieldPath}`,
        { $literal: new mongoose.Types.ObjectId(canonical) },
      ],
    },
  ];
}

function exactCanonicalObjectIdStringClauses(fieldPath, value) {
  const canonical = requireCanonicalObjectId(value, fieldPath);
  return [
    { $eq: [{ $type: `$${fieldPath}` }, "string"] },
    literalSnapshotClause(fieldPath, canonical),
  ];
}

function literalSnapshotClause(fieldPath, value) {
  if (value === undefined) {
    return { $eq: [{ $type: `$${fieldPath}` }, "missing"] };
  }
  return { $eq: [`$${fieldPath}`, { $literal: value }] };
}

function expressionFilter(clauses) {
  return { $expr: { $and: clauses } };
}

// MongoDB refuses "$expr is not allowed in the query predicate for an upsert",
// so any filter reaching an upsert has to be built from ordinary operators. The
// $expr forms above are still used everywhere else, including on the read that
// precedes each upsert, because they are what make a comparison exact.
//
// $exists:false distinguishes an absent field from a stored null, exactly as the
// $type "missing" clause does.
//
// A defined value is compared with a bare value rather than {$eq: value}, and is
// asserted to be a scalar first. The reason $literal appears in the $expr clauses
// is to stop an object value being reinterpreted as query operators; asserting the
// value is a scalar rules that out at the source, and keeps the filter to
// operators MongoDB accepts in an upsert predicate.
function assertUpsertComparableValue(fieldPath, value) {
  if (value === null) return value;
  const type = typeof value;
  if (type === "string" || type === "number" || type === "boolean")
    return value;
  if (value instanceof Date) return value;
  if (value instanceof mongoose.Types.ObjectId) return value;
  throw new TypeError(
    `${fieldPath} must be a scalar to be compared in an upsert predicate`,
  );
}

function upsertEqualityFilter(entries) {
  return Object.fromEntries(
    Object.entries(entries).map(([fieldPath, value]) => [
      fieldPath,
      value === undefined
        ? { $exists: false }
        : assertUpsertComparableValue(fieldPath, value),
    ]),
  );
}

function upsertObjectIdEqualityFilter(entries) {
  return upsertEqualityFilter(
    Object.fromEntries(
      Object.entries(entries).map(([fieldPath, value]) => [
        fieldPath,
        new mongoose.Types.ObjectId(requireCanonicalObjectId(value, fieldPath)),
      ]),
    ),
  );
}

function strictObjectIdFilter(entries) {
  const canonicalEntries = Object.fromEntries(
    Object.entries(entries).map(([fieldPath, value]) => [
      fieldPath,
      new mongoose.Types.ObjectId(requireCanonicalObjectId(value, fieldPath)),
    ]),
  );
  return {
    $and: [
      canonicalEntries,
      expressionFilter(
        Object.entries(entries).flatMap(([fieldPath, value]) =>
          exactObjectIdClauses(fieldPath, value),
        ),
      ),
    ],
  };
}

function strictOptionalObjectIdSnapshotFilter(fieldPath, value) {
  if (value === null || value === undefined) {
    return snapshotFilter({ [fieldPath]: value });
  }
  return strictObjectIdFilter({ [fieldPath]: value });
}

function snapshotFilter(entries) {
  return expressionFilter(
    Object.entries(entries).map(([fieldPath, value]) =>
      literalSnapshotClause(fieldPath, value),
    ),
  );
}

function strictStringFilter(entries) {
  const clauses = Object.entries(entries).flatMap(([fieldPath, value]) => {
    if (typeof value !== "string") {
      throw new TypeError(`${fieldPath} must be a primitive string`);
    }
    return [
      { $eq: [{ $type: `$${fieldPath}` }, "string"] },
      literalSnapshotClause(fieldPath, value),
    ];
  });
  return { $and: [entries, expressionFilter(clauses)] };
}

function combineQueryFilters(...filters) {
  const present = filters.filter(Boolean);
  if (present.length === 0) return {};
  if (present.length === 1) return present[0];
  return { $and: present };
}

function nonnegativeSafeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function normalizeDigestEmail(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized.length > 254 || /[\s\u0000-\u001f\u007f]/u.test(normalized)) {
    return null;
  }

  const atIndex = normalized.indexOf("@");
  if (atIndex <= 0 || atIndex !== normalized.lastIndexOf("@")) return null;
  const localPart = normalized.slice(0, atIndex);
  const domain = normalized.slice(atIndex + 1);
  if (
    localPart.length > 64 ||
    localPart.startsWith(".") ||
    localPart.endsWith(".") ||
    localPart.includes("..") ||
    !/^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+$/u.test(localPart)
  ) {
    return null;
  }

  const domainLabels = domain.split(".");
  if (
    domain.length > 253 ||
    domainLabels.length < 2 ||
    domainLabels.some(
      (label) =>
        label.length < 1 ||
        label.length > 63 ||
        label.startsWith("-") ||
        label.endsWith("-") ||
        !/^[a-z0-9-]+$/u.test(label),
    )
  ) {
    return null;
  }
  return normalized;
}

const DAILY_FREQUENCIES = new Set(["DAILY", "EVERY_3_DAYS", "WEEKLY", "OFF"]);

function effectiveDailyFrequency(user) {
  const raw = user?.digestPreferences?.dailyFrequency;
  if (DAILY_FREQUENCIES.has(raw)) return raw;
  // Legacy accounts without the field: derive from the old on/off flag.
  return user?.digestPreferences?.dailyEnabled === false ? "OFF" : "DAILY";
}

function effectivePreferences(user) {
  const dailyFrequency = effectiveDailyFrequency(user);
  return {
    dailyFrequency,
    // dailyEnabled stays true unless the cadence is OFF, so existing consumers
    // (and the legacy on/off toggle) keep behaving sensibly.
    dailyEnabled: dailyFrequency !== "OFF",
    weeklyEnabled: user?.digestPreferences?.weeklyEnabled !== false,
    emailEnabled: user?.digestPreferences?.emailEnabled !== false,
  };
}

function hasWeeklyDigestAuthority({ membership, user }) {
  return (
    membership?.status === "ACTIVE" &&
    (["OWNER", "ADMIN"].includes(membership.role) ||
      user?.role === "SUPER_ADMIN")
  );
}

function digestRecipientPolicy({ firm, recipientUserId, membership }) {
  const hasActiveMembership = membership?.status === "ACTIVE";
  if (!firm) {
    return {
      allowed: false,
      reason: "ACTIVE_FIRM_REQUIRED",
    };
  }
  if (firm.kind !== "PERSONAL") {
    return {
      allowed: hasActiveMembership,
      reason: hasActiveMembership ? null : "ACTIVE_MEMBERSHIP_REQUIRED",
    };
  }
  if (!sameObjectId(recipientUserId, firm.ownerUserId)) {
    return {
      allowed: false,
      reason: "PERSONAL_OWNER_MISMATCH",
      outcome: "DIGEST_PERSONAL_RECIPIENT_NOT_OWNER",
      lastError: "Personal firm digest recipient is not the firm owner",
    };
  }
  if (!hasActiveMembership || membership.role !== "OWNER") {
    return {
      allowed: false,
      reason: "PERSONAL_OWNER_MEMBERSHIP_REQUIRED",
      outcome: "DIGEST_PERSONAL_OWNER_AUTHORITY_REVOKED",
      lastError: "Personal firm owner no longer has an active OWNER membership",
    };
  }
  return { allowed: true, reason: null };
}

async function requireActiveDigestAccess(
  { userId, firmId },
  {
    Firm: FirmModel = Firm,
    FirmMembership: FirmMembershipModel = FirmMembership,
    User: UserModel = User,
  } = {},
) {
  const canonicalUserId = requireCanonicalObjectId(userId, "userId");
  const canonicalFirmId = requireCanonicalObjectId(firmId, "firmId");
  const [firm, membership, user] = await Promise.all([
    FirmModel.findOne(
      combineQueryFilters(strictObjectIdFilter({ _id: canonicalFirmId }), {
        isActive: true,
      }),
    )
      .select("kind ownerUserId timezone digestSettings")
      .lean(),
    FirmMembershipModel.findOne(
      combineQueryFilters(
        strictObjectIdFilter({
          firmId: canonicalFirmId,
          userId: canonicalUserId,
        }),
        { status: "ACTIVE" },
      ),
    )
      .select("role status")
      .lean(),
    UserModel.findOne(
      combineQueryFilters(strictObjectIdFilter({ _id: canonicalUserId }), {
        isActive: true,
      }),
    )
      .select("email role digestPreferences")
      .lean(),
  ]);
  const recipientPolicy = digestRecipientPolicy({
    firm,
    recipientUserId: canonicalUserId,
    membership,
  });
  if (!firm || !user || !recipientPolicy.allowed) {
    throw new DigestError(
      "Digest access is unavailable",
      403,
      "DIGEST_ACCESS_FORBIDDEN",
    );
  }

  return {
    firm,
    user,
    membership,
    weeklyAuthorized: hasWeeklyDigestAuthority({ membership, user }),
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
      .map((part) => [part.type, part.value]),
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
      .map((part) => [part.type, part.value]),
  );
  const representedUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
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

// Personal daily-digest cadence. The periodKey stays the local date, so the
// per-day dedup index is unchanged; here we only decide whether *today* is a
// sending day for this recipient's chosen cadence.
function dailyDigestDueForFrequency(dailyFrequency, parts) {
  if (dailyFrequency === "OFF") return false;
  if (dailyFrequency === "DAILY") return true;
  if (dailyFrequency === "WEEKLY") return parts.weekday === 1; // Monday
  if (dailyFrequency === "EVERY_3_DAYS") {
    const { utcMs } = parseDateKey(parts.dateKey);
    return Math.floor(utcMs / 86400000) % 3 === 0;
  }
  return true;
}

function pagination(query = {}) {
  const page = Number(query.page ?? 1);
  const limit = Number(query.limit ?? DEFAULT_LIMIT);
  if (!Number.isInteger(page) || page < 1 || page > 100000) {
    throw new DigestError("page must be an integer between 1 and 100000");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new DigestError(
      `limit must be an integer between 1 and ${MAX_LIMIT}`,
    );
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
  const identityFields = { firmId };
  if (kind === DAILY_KIND) identityFields.assignedTo = userId;
  return combineQueryFilters(strictObjectIdFilter(identityFields), {
    isActive: true,
    ...(noticeCasesEnabled ? {} : { source: { $ne: "CASE" } }),
  });
}

async function buildDigestSummary(
  {
    firmId,
    userId,
    kind,
    periodKey,
    timezone,
    noticeCasesEnabled,
    now = new Date(),
  },
  { Task: TaskModel = Task } = {},
) {
  if (!DIGEST_KINDS.has(kind)) throw new DigestError("Digest kind is invalid");
  const scope = taskScope({ firmId, userId, kind, noticeCasesEnabled });
  // Deadlines are UTC days. Firm-local dates still govern digest scheduling
  // and period identity, but must never shift a statutory due-day boundary.
  const utcTodayKey = now.toISOString().slice(0, 10);
  const todayISO = `${utcTodayKey}T00:00:00.000Z`;
  const dueSoonISO = `${addDateKeyDays(utcTodayKey, 8)}T00:00:00.000Z`;
  const periodStart =
    kind === WEEKLY_KIND ? zonedDateKeyStart(periodKey, timezone) : null;
  const [countsRows, completedThisWeek, topTasks] = await Promise.all([
    TaskModel.aggregate([
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
      ? TaskModel.countDocuments({
          ...scope,
          status: { $in: ["FILED", "CLOSED"] },
          completedAt: { $gte: periodStart, $lte: now },
        })
      : 0,
    TaskModel.find({ ...scope, status: { $in: OPEN_STATUSES } })
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
        label: "Filed/closed this week",
        value: counts.completedThisWeek || 0,
      },
    );
  }
  return lines;
}

// Decides whether a queued digest email must still be suppressed, using the
// recipient's preferences as they are RIGHT NOW. Returns null when the email
// should be sent, otherwise the reason it is being held back.
function digestEmailSuppressionReason(kind, recipient) {
  const preferences = effectivePreferences(recipient);
  const subscribedToKind =
    kind === DAILY_KIND ? preferences.dailyEnabled : preferences.weeklyEnabled;
  if (!subscribedToKind) return "UNSUBSCRIBED";
  if (!preferences.emailEnabled) return "EMAIL_DISABLED";
  return null;
}

function digestBusinessIdentity({ firmId, kind, periodKey, recipientUserId }) {
  const canonicalFirmId = requireCanonicalObjectId(firmId, "firmId");
  const canonicalRecipientUserId = requireCanonicalObjectId(
    recipientUserId,
    "recipientUserId",
  );
  return `digest:${canonicalFirmId}:${String(kind)}:${String(periodKey)}:${canonicalRecipientUserId}`;
}

// ─── Unsubscribe-by-link (one-click, no login required) ──────────────────
//
// RFC 8058 / CAN-SPAM: every marketing/automated email needs a way to stop
// receiving it that does not require the recipient to sign in first - an
// unsubscribed recipient with an expired session, a deactivated firm
// membership, or simply no wish to log in must still be able to stop the
// mail. The link travels inside the email itself, so it cannot rely on a
// session cookie or JWT; it carries its own signed credential instead,
// following the same HMAC-SHA256 "expiry.signature" pattern already used
// for the TDS preview/action tokens (tds-import.service.js's
// previewTokenForFingerprint, tds-health.service.js's actionToken) - same
// algorithm and wire format, but with a much longer TTL: those tokens back
// one interactive session and expire in 15 minutes, while this one has to
// keep working from inside a mailbox weeks or months after send.
const DIGEST_UNSUBSCRIBE_TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180 days
// Overridable only so a non-production environment can point the link at
// itself; every real deployment uses the one production API host, the same
// hardcoded convention already used for FROM_EMAIL and the CORS/CSP origin.
const DIGEST_UNSUBSCRIBE_BASE_URL =
  process.env.DIGEST_UNSUBSCRIBE_BASE_URL || "https://api.caprotoolkit.in";

function digestUnsubscribeSecret() {
  const secret =
    process.env.DIGEST_UNSUBSCRIBE_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    throw new DigestError(
      "Digest unsubscribe link signing is unavailable",
      503,
      "DIGEST_UNSUBSCRIBE_UNAVAILABLE",
    );
  }
  return secret;
}

function digestUnsubscribeTokenPayload(recipientUserId, kind, expiresAt) {
  return `${recipientUserId}.${kind}.${expiresAt}`;
}

// expiresAt is a parameter (not always "now + TTL") so a test can pin it and
// so digestUnsubscribeTokenMatches's own expected-signature recomputation
// derives from the exact same function.
function buildDigestUnsubscribeToken(
  recipientUserId,
  kind,
  expiresAt = Date.now() + DIGEST_UNSUBSCRIBE_TOKEN_TTL_MS,
) {
  const canonicalRecipientUserId = requireCanonicalObjectId(
    recipientUserId,
    "recipientUserId",
  );
  if (!DIGEST_KINDS.has(kind)) throw new DigestError("Digest kind is invalid");
  const signature = createHmac("sha256", digestUnsubscribeSecret())
    .update(
      digestUnsubscribeTokenPayload(canonicalRecipientUserId, kind, expiresAt),
    )
    .digest("hex");
  return `${expiresAt}.${signature}`;
}

// Constant-time comparison (timingSafeEqual), same as
// tds-health.service.js's actionTokenMatches - a byte-by-byte comparison of
// a security signature must not let an attacker learn how many leading
// bytes matched from response timing.
function digestUnsubscribeTokenMatches(recipientUserId, kind, token) {
  const canonicalRecipientUserId = canonicalObjectId(recipientUserId);
  if (!canonicalRecipientUserId || !DIGEST_KINDS.has(kind)) return false;
  const [expiresText, signature = ""] = String(token || "").split(".");
  const expiresAt = Number(expiresText);
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Date.now() ||
    !/^[a-f0-9]{64}$/i.test(signature)
  ) {
    return false;
  }
  const expected = createHmac("sha256", digestUnsubscribeSecret())
    .update(
      digestUnsubscribeTokenPayload(canonicalRecipientUserId, kind, expiresAt),
    )
    .digest();
  const actual = Buffer.from(signature, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Builds the two URLs a digest email needs, both carrying the same signed
// token but for two different readers:
//
//   pageUrl - the human-facing link placed in the email's visible footer.
//     Opens the static confirmation page (public/unsubscribe.html) so a
//     person sees what they are unsubscribing from and can choose "just
//     this email" or "all digest emails" before anything changes.
//   apiUrl  - the machine-facing target placed in the List-Unsubscribe /
//     List-Unsubscribe-Post headers (RFC 8058). A compliant mail client
//     (Gmail, Outlook, Apple Mail) POSTs to this URL directly, with a fixed
//     body of "List-Unsubscribe=One-Click" and nothing else, expecting the
//     unsubscribe to happen immediately with no page and no further
//     confirmation - pointing this at the static HTML page instead would
//     not work, since a POST to a static asset does nothing.
//
// u and k merely name WHICH recipient and WHICH digest kind the link is
// about and are not secret; t's signature is what actually prevents anyone
// from forging or altering a request, so u/k/t travelling together, plainly
// visible in the URL, is safe by design - exactly as an RFC 8058 link is
// expected to be self-contained with no session of its own.
function buildDigestUnsubscribeLinks({ recipientUserId, kind }) {
  const canonicalRecipientUserId = requireCanonicalObjectId(
    recipientUserId,
    "recipientUserId",
  );
  if (!DIGEST_KINDS.has(kind)) throw new DigestError("Digest kind is invalid");
  const token = buildDigestUnsubscribeToken(canonicalRecipientUserId, kind);
  const query = new URLSearchParams({
    u: canonicalRecipientUserId,
    k: kind,
    t: token,
  }).toString();
  return {
    pageUrl: `${DIGEST_UNSUBSCRIBE_BASE_URL}/unsubscribe.html?${query}`,
    apiUrl: `${DIGEST_UNSUBSCRIBE_BASE_URL}/api/digests/unsubscribe?${query}`,
  };
}

function digestKindLabel(kind) {
  return kind === DAILY_KIND
    ? "Daily personal work digest"
    : "Weekly firm operations summary";
}

// THIS_KIND stops only the specific digest the clicked link was about;
// ALL stops every digest email regardless of kind, by turning off email
// copies entirely (digestPreferences.emailEnabled) - the two options named
// on the confirmation page.
const DIGEST_UNSUBSCRIBE_SCOPES = Object.freeze(["THIS_KIND", "ALL"]);

function digestUnsubscribeTokenFailure() {
  return new DigestError(
    "This unsubscribe link is invalid or has expired",
    400,
    "DIGEST_UNSUBSCRIBE_TOKEN_INVALID",
  );
}

function digestUnsubscribeAccountFailure() {
  return new DigestError(
    "This account is unavailable",
    404,
    "DIGEST_UNSUBSCRIBE_ACCOUNT_NOT_FOUND",
  );
}

// Validates the link's token and returns just enough to render the
// confirmation page - never mutates anything. Must be safe to call
// repeatedly with no side effects (a mail client's link-preview/security
// scanner following the link automatically, a person reloading the page).
async function previewDigestUnsubscribe(
  { recipientUserId, kind, token },
  { User: UserModel = User } = {},
) {
  const canonicalRecipientUserId = canonicalObjectId(recipientUserId);
  if (
    !canonicalRecipientUserId ||
    !DIGEST_KINDS.has(kind) ||
    !digestUnsubscribeTokenMatches(canonicalRecipientUserId, kind, token)
  ) {
    throw digestUnsubscribeTokenFailure();
  }
  const user = await UserModel.findOne(
    combineQueryFilters(
      strictObjectIdFilter({ _id: canonicalRecipientUserId }),
      { isActive: true },
    ),
  )
    .select("email digestPreferences")
    .lean();
  if (!user) throw digestUnsubscribeAccountFailure();
  return {
    email: user.email,
    kind,
    kindLabel: digestKindLabel(kind),
    preferences: effectivePreferences(user),
  };
}

// Applies the unsubscribe choice made on the confirmation page - or, for a
// mail client that supports RFC 8058 one-click List-Unsubscribe-Post, a
// direct POST with no human ever seeing the page at all, so this must be
// safe to call the moment the token itself is verified, without any further
// confirmation step of its own.
//
// This deliberately does NOT go through updateDigestPreferences /
// requireActiveDigestAccess: those assume an authenticated session scoped to
// one active firm workspace, which a mailed link cannot assume - the
// recipient may have switched workspaces, left the firm, or simply not be
// signed in on this device at all. digestPreferences lives on the User
// document directly and is not firm-scoped, so none of that firm/membership
// context is actually needed to honour the request.
async function applyDigestUnsubscribe(
  { recipientUserId, kind, token, scope },
  {
    User: UserModel = User,
    safeRecordActivity: recordActivity = safeRecordActivity,
  } = {},
) {
  const canonicalRecipientUserId = canonicalObjectId(recipientUserId);
  if (
    !canonicalRecipientUserId ||
    !DIGEST_KINDS.has(kind) ||
    !digestUnsubscribeTokenMatches(canonicalRecipientUserId, kind, token)
  ) {
    throw digestUnsubscribeTokenFailure();
  }
  if (!DIGEST_UNSUBSCRIBE_SCOPES.includes(scope)) {
    throw new DigestError(
      "scope must be THIS_KIND or ALL",
      400,
      "DIGEST_UNSUBSCRIBE_SCOPE_INVALID",
    );
  }

  const before = await UserModel.findOne(
    combineQueryFilters(
      strictObjectIdFilter({ _id: canonicalRecipientUserId }),
      { isActive: true },
    ),
  )
    .select("firmId personalFirmId email digestPreferences")
    .lean();
  if (!before) throw digestUnsubscribeAccountFailure();

  const update =
    scope === "ALL"
      ? { "digestPreferences.emailEnabled": false }
      : kind === DAILY_KIND
        ? {
            "digestPreferences.dailyFrequency": "OFF",
            "digestPreferences.dailyEnabled": false,
          }
        : { "digestPreferences.weeklyEnabled": false };

  const user = await UserModel.findOneAndUpdate(
    combineQueryFilters(
      strictObjectIdFilter({ _id: canonicalRecipientUserId }),
      { isActive: true },
    ),
    { $set: update },
    { new: true, runValidators: true },
  )
    .select("digestPreferences")
    .lean();
  if (!user) throw digestUnsubscribeAccountFailure();

  // Best effort, same as every other activity record in this file: a
  // mailed-link action has no firm context of its own, so this uses
  // whichever workspace pointer the user happens to have (falling back to
  // null, which safeRecordActivity tolerates by logging and continuing
  // rather than failing the preference change that already succeeded).
  await recordActivity({
    firmId: before.firmId || before.personalFirmId || null,
    actorUserId: canonicalRecipientUserId,
    source: "USER",
    action: "DIGEST_UNSUBSCRIBED_VIA_EMAIL_LINK",
    entityType: "User",
    entityId: canonicalRecipientUserId,
    beforeSummary: effectivePreferences(before),
    afterSummary: effectivePreferences(user),
    metadata: { kind, scope },
  });

  return {
    scope,
    kind,
    kindLabel: digestKindLabel(kind),
    preferences: effectivePreferences(user),
  };
}

function digestSendingRecoveryReason(delivery, now = new Date()) {
  if (delivery?.email?.state !== "SENDING") return null;

  const claimToken = delivery.email?.claimToken;
  if (
    claimToken === null ||
    claimToken === undefined ||
    String(claimToken).trim() === ""
  ) {
    return "MISSING_CLAIM_TOKEN";
  }

  const claimedAt = delivery.email?.claimedAt;
  if (claimedAt === null || claimedAt === undefined) {
    return "MISSING_CLAIM_TIME";
  }

  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs)) {
    throw new TypeError("Digest recovery requires a valid current time");
  }
  const claimedAtMs = new Date(claimedAt).getTime();
  if (!Number.isFinite(claimedAtMs)) return "INVALID_CLAIM_TIME";
  return claimedAtMs < nowMs - SEND_CLAIM_STALE_MS ? "STALE_CLAIM" : null;
}

function updateProvesMatch(result) {
  return (
    typeof result?.matchedCount === "number" &&
    Number.isSafeInteger(result.matchedCount) &&
    result.matchedCount > 0
  );
}

async function claimDigestDelivery({
  deliveryId,
  firmId,
  automationJobId,
  now = new Date(),
  claimToken = randomUUID(),
  deliveryModel = DigestDelivery,
}) {
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs)) {
    throw new TypeError("Digest claim requires a valid current time");
  }
  const identityFilter = strictObjectIdFilter({
    _id: deliveryId,
    firmId,
    automationJobId,
  });
  const claimedAt = new Date(nowMs);
  const staleBefore = new Date(nowMs - SEND_CLAIM_STALE_MS);
  const delivery = await deliveryModel.findOneAndUpdate(
    combineQueryFilters(identityFilter, {
      $or: [
        { "email.state": "PENDING" },
        {
          "email.state": "SENDING",
          $or: [
            { "email.claimToken": null },
            { "email.claimToken": "" },
            { "email.claimToken": { $exists: false } },
            { "email.claimedAt": { $lt: staleBefore } },
            { "email.claimedAt": null },
            { "email.claimedAt": { $exists: false } },
            { "email.claimedAt": { $not: { $type: "date" } } },
          ],
        },
      ],
    }),
    {
      $set: {
        "email.state": "SENDING",
        "email.claimToken": claimToken,
        "email.claimedAt": claimedAt,
      },
    },
    { new: true, lean: true },
  );
  return delivery ? { delivery, claimToken } : null;
}

const ACTIVE_DIGEST_JOB_STATUSES = new Set([
  "PENDING",
  "PROCESSING",
  "RETRY_SCHEDULED",
]);
const REPAIRABLE_DIGEST_JOB_STATUSES = Object.freeze([
  "PENDING",
  "RETRY_SCHEDULED",
]);
const RECOVERABLE_SENDING_REPAIRABLE_DIGEST_JOB_STATUSES = Object.freeze([
  ...REPAIRABLE_DIGEST_JOB_STATUSES,
  "FAILED",
]);

function isActiveDigestJob(job) {
  return ACTIVE_DIGEST_JOB_STATUSES.has(job?.status);
}

function withDigestRecoverySession(query, session) {
  if (session && query && typeof query.session === "function") {
    return query.session(session);
  }
  return query;
}

async function findDigestJob(
  AutomationJobModel,
  filter,
  { session = null } = {},
) {
  let query = withDigestRecoverySession(
    AutomationJobModel.findOne(filter),
    session,
  );
  if (query && typeof query.lean === "function") query = query.lean();
  return query;
}

function sameObjectId(left, right) {
  const canonicalLeft = canonicalObjectId(left);
  const canonicalRight = canonicalObjectId(right);
  return (
    canonicalLeft !== null &&
    canonicalRight !== null &&
    canonicalLeft === canonicalRight
  );
}

function digestJobPayloadFilter(deliveryId) {
  return {
    $expr: {
      $or: [
        {
          $and: exactCanonicalObjectIdStringClauses(
            "payload.deliveryId",
            deliveryId,
          ),
        },
        {
          $and: exactObjectIdClauses("payload.deliveryId", deliveryId),
        },
      ],
    },
  };
}

async function findDigestDelivery(
  DigestDeliveryModel,
  filter,
  { session = null } = {},
) {
  let query = withDigestRecoverySession(
    DigestDeliveryModel.findOne(filter),
    session,
  );
  if (query && typeof query.lean === "function") query = query.lean();
  return query;
}

function jobRecoveryLeaseFilter(lease) {
  return snapshotFilter({
    "jobRecovery.token": lease.token,
    "jobRecovery.revision": lease.revision,
  });
}

function currentJobRecoveryLeaseFilter(lease, now) {
  return combineQueryFilters(jobRecoveryLeaseFilter(lease), {
    "jobRecovery.expiresAt": { $gt: now },
  });
}

function jobRecoveryLeaseExpiry(now) {
  return new Date(new Date(now).getTime() + DIGEST_JOB_RECOVERY_LEASE_MS);
}

function recoverableSendingStateFilter(now) {
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs)) {
    throw new TypeError("Digest recovery requires a valid current time");
  }
  const staleBefore = new Date(nowMs - SEND_CLAIM_STALE_MS);
  return {
    "email.state": "SENDING",
    $or: [
      { "email.claimToken": null },
      { "email.claimToken": "" },
      { "email.claimToken": { $exists: false } },
      { "email.claimedAt": { $lt: staleBefore } },
      { "email.claimedAt": null },
      { "email.claimedAt": { $exists: false } },
      { "email.claimedAt": { $not: { $type: "date" } } },
    ],
  };
}

function digestJobRecoveryPolicy(delivery, now) {
  if (delivery?.email?.state === "PENDING") {
    return { state: "PENDING", allowFailedRetry: false, reason: null };
  }
  const reason = digestSendingRecoveryReason(delivery, now);
  return reason
    ? { state: "RECOVERABLE_SENDING", allowFailedRetry: true, reason }
    : null;
}

function digestEmailSnapshotFilter(delivery) {
  return snapshotFilter({
    "email.state": delivery.email?.state,
    "email.claimToken": delivery.email?.claimToken,
    "email.claimedAt": delivery.email?.claimedAt,
  });
}

function digestRecoverySnapshotFilter(delivery, now) {
  const policy = digestJobRecoveryPolicy(delivery, now);
  if (!policy) return null;
  const emailSnapshot = digestEmailSnapshotFilter(delivery);
  if (policy.state === "PENDING") return emailSnapshot;
  return combineQueryFilters(recoverableSendingStateFilter(now), emailSnapshot);
}

function digestRecoveryEligibleStateFilter(now) {
  const recoverableSending = recoverableSendingStateFilter(now);
  return {
    $or: [{ "email.state": "PENDING" }, recoverableSending],
  };
}

function digestTerminalQuarantineFields(
  lastError,
  { clearRecovery = true } = {},
) {
  return {
    status: "FAILED",
    "email.state": "FAILED",
    "email.lastError": String(lastError).slice(0, 500),
    "email.claimToken": null,
    "email.claimedAt": null,
    "inApp.state": "HIDDEN",
    "inApp.availableAt": null,
    "inApp.readAt": null,
    ...(clearRecovery
      ? {
          "jobRecovery.token": null,
          "jobRecovery.expiresAt": null,
        }
      : {}),
  };
}

async function acquireDigestJobRecoveryLease({
  deliveryId,
  firmId,
  now,
  DigestDeliveryModel,
  token = randomUUID(),
}) {
  const identityFilter = strictObjectIdFilter({ _id: deliveryId, firmId });
  const current = await findDigestDelivery(
    DigestDeliveryModel,
    combineQueryFilters(identityFilter, digestRecoveryEligibleStateFilter(now)),
  );
  if (!current) return null;

  const rawRevision = current.jobRecovery?.revision;
  const revisionIsMissing = rawRevision === undefined;
  const revision = revisionIsMissing ? 0 : nonnegativeSafeInteger(rawRevision);
  if (revision === null || revision === Number.MAX_SAFE_INTEGER) {
    const quarantined = await DigestDeliveryModel.updateOne(
      combineQueryFilters(
        identityFilter,
        digestRecoveryEligibleStateFilter(now),
        digestEmailSnapshotFilter(current),
        snapshotFilter({ "jobRecovery.revision": rawRevision }),
      ),
      {
        $set: digestTerminalQuarantineFields(
          "Digest recovery revision is invalid",
        ),
      },
    );
    if (!updateProvesMatch(quarantined)) return null;
    return null;
  }

  const revisionFilter = revisionIsMissing
    ? { "jobRecovery.revision": { $exists: false } }
    : snapshotFilter({ "jobRecovery.revision": rawRevision });
  const nextRevision = revision + 1;
  const locked = await DigestDeliveryModel.findOneAndUpdate(
    combineQueryFilters(
      identityFilter,
      digestRecoveryEligibleStateFilter(now),
      digestEmailSnapshotFilter(current),
      revisionFilter,
      {
        $or: [
          { "jobRecovery.token": null },
          { "jobRecovery.token": "" },
          { "jobRecovery.token": { $exists: false } },
          { "jobRecovery.expiresAt": { $lte: now } },
          { "jobRecovery.expiresAt": null },
          { "jobRecovery.expiresAt": { $exists: false } },
          { "jobRecovery.expiresAt": { $not: { $type: "date" } } },
        ],
      },
    ),
    {
      $set: {
        "jobRecovery.token": token,
        "jobRecovery.expiresAt": jobRecoveryLeaseExpiry(now),
        "jobRecovery.revision": nextRevision,
      },
    },
    { new: true, lean: true },
  );
  if (!locked) return null;

  const lockedRevision = nonnegativeSafeInteger(locked.jobRecovery?.revision);
  if (lockedRevision !== nextRevision) {
    const quarantined = await DigestDeliveryModel.updateOne(
      combineQueryFilters(
        identityFilter,
        digestEmailSnapshotFilter(locked),
        snapshotFilter({
          "jobRecovery.token": token,
          "jobRecovery.revision": locked.jobRecovery?.revision,
        }),
      ),
      {
        $set: digestTerminalQuarantineFields(
          "Digest recovery revision is invalid",
        ),
      },
    );
    if (!updateProvesMatch(quarantined)) return null;
    return null;
  }
  return { delivery: locked, token, revision: nextRevision };
}

async function releaseDigestJobRecoveryLease({ lease, DigestDeliveryModel }) {
  const result = await DigestDeliveryModel.updateOne(
    combineQueryFilters(
      strictObjectIdFilter({
        _id: lease.delivery._id,
        firmId: lease.delivery.firmId,
      }),
      jobRecoveryLeaseFilter(lease),
    ),
    {
      $set: {
        "jobRecovery.token": null,
        "jobRecovery.expiresAt": null,
      },
    },
  );
  return updateProvesMatch(result);
}

async function readDigestAuthority({
  deliveryId,
  firmId,
  AutomationJobModel,
  DigestDeliveryModel,
}) {
  const currentDelivery = await findDigestDelivery(
    DigestDeliveryModel,
    strictObjectIdFilter({ _id: deliveryId, firmId }),
  );
  if (!canonicalObjectId(currentDelivery?.automationJobId)) {
    return { delivery: currentDelivery, job: null };
  }
  const job = await findDigestJob(
    AutomationJobModel,
    combineQueryFilters(
      strictObjectIdFilter({
        _id: currentDelivery.automationJobId,
        firmId,
      }),
      strictStringFilter({ kind: DIGEST_JOB_KIND }),
      digestJobPayloadFilter(currentDelivery._id),
    ),
  );
  return { delivery: currentDelivery, job };
}

async function loadDigestJobCandidates({
  delivery,
  firmId,
  businessIdentity,
  AutomationJobModel,
}) {
  const payloadFilter = digestJobPayloadFilter(delivery._id);
  const canonicalLinkedJobId = canonicalObjectId(delivery.automationJobId);
  if (canonicalLinkedJobId) {
    const linkedJob = await findDigestJob(
      AutomationJobModel,
      combineQueryFilters(
        strictObjectIdFilter({
          _id: canonicalLinkedJobId,
          firmId,
        }),
        strictStringFilter({ kind: DIGEST_JOB_KIND }),
        payloadFilter,
      ),
    );
    if (linkedJob) return linkedJob;
  }

  const legacyIdentity = `digest-delivery:${requireCanonicalObjectId(
    delivery._id,
    "deliveryId",
  )}`;
  const [legacyJob, businessJob] = await Promise.all([
    findDigestJob(
      AutomationJobModel,
      combineQueryFilters(
        strictObjectIdFilter({ firmId }),
        strictStringFilter({
          kind: DIGEST_JOB_KIND,
          idempotencyKey: legacyIdentity,
        }),
        payloadFilter,
      ),
    ),
    findDigestJob(
      AutomationJobModel,
      combineQueryFilters(
        strictObjectIdFilter({ firmId }),
        strictStringFilter({
          kind: DIGEST_JOB_KIND,
          idempotencyKey: businessIdentity,
        }),
        payloadFilter,
      ),
    ),
  ]);
  return (
    [legacyJob, businessJob].find(isActiveDigestJob) ||
    legacyJob ||
    businessJob ||
    null
  );
}

function sameBusinessDigestJobFilter(firmId, businessIdentity) {
  return combineQueryFilters(
    strictObjectIdFilter({ firmId }),
    strictStringFilter({
      kind: DIGEST_JOB_KIND,
      idempotencyKey: businessIdentity,
    }),
  );
}

function canonicalDigestPayloadDeliveryId(value) {
  const canonical = canonicalObjectId(value);
  if (canonical === null) return null;
  if (value instanceof mongoose.Types.ObjectId) return canonical;
  return typeof value === "string" && value === canonical ? canonical : null;
}

function digestJobPayloadMatches(job, deliveryId) {
  const canonicalDeliveryId = canonicalObjectId(deliveryId);
  const canonicalPayloadDeliveryId = canonicalDigestPayloadDeliveryId(
    job?.payload?.deliveryId,
  );
  return (
    canonicalDeliveryId !== null &&
    canonicalPayloadDeliveryId !== null &&
    canonicalPayloadDeliveryId === canonicalDeliveryId
  );
}

async function repairDigestJobPayloadUnderLease({
  lease,
  firmId,
  businessIdentity,
  observedJob,
  recoveryClock,
  AutomationJobModel,
  DigestDeliveryModel,
  runRecoveryTransactionProvider,
}) {
  const result = await runRecoveryTransactionProvider(async (session) => {
    if (!session) {
      throw new TypeError("Digest recovery transaction requires a session");
    }
    const transactionNow = digestRecoveryClockNow(recoveryClock);
    const deliveryFence = combineQueryFilters(
      strictObjectIdFilter({ _id: lease.delivery._id, firmId }),
      currentJobRecoveryLeaseFilter(lease, transactionNow),
      digestRecoveryEligibleStateFilter(transactionNow),
      digestEmailSnapshotFilter(lease.delivery),
      strictOptionalObjectIdSnapshotFilter(
        "automationJobId",
        lease.delivery.automationJobId,
      ),
    );
    const currentDelivery = await findDigestDelivery(
      DigestDeliveryModel,
      deliveryFence,
      { session },
    );
    if (!currentDelivery) throw digestRecoveryFenceLostError();
    const currentPolicy = digestJobRecoveryPolicy(
      currentDelivery,
      transactionNow,
    );
    if (!currentPolicy) throw digestRecoveryFenceLostError();
    const repairableStatuses = currentPolicy.allowFailedRetry
      ? RECOVERABLE_SENDING_REPAIRABLE_DIGEST_JOB_STATUSES
      : REPAIRABLE_DIGEST_JOB_STATUSES;

    const observedJobId = canonicalObjectId(observedJob?._id);
    let currentJob = null;
    if (observedJobId) {
      currentJob = await findDigestJob(
        AutomationJobModel,
        combineQueryFilters(
          strictObjectIdFilter({ _id: observedJobId, firmId }),
          strictStringFilter({
            kind: DIGEST_JOB_KIND,
            idempotencyKey: businessIdentity,
          }),
          snapshotFilter({
            status: observedJob.status,
            "payload.deliveryId": observedJob.payload?.deliveryId,
          }),
        ),
        { session },
      );
    }

    if (!currentJob) {
      const reread = await findDigestJob(
        AutomationJobModel,
        sameBusinessDigestJobFilter(firmId, businessIdentity),
        { session },
      );
      if (
        canonicalObjectId(reread?._id) &&
        digestJobPayloadMatches(reread, currentDelivery._id)
      ) {
        return { observedSameKey: true, job: reread };
      }
      if (reread) {
        const terminalized = await DigestDeliveryModel.updateOne(
          deliveryFence,
          {
            $set: digestTerminalQuarantineFields(
              "Digest automation job payload could not be safely repaired",
              { clearRecovery: false },
            ),
          },
          { session },
        );
        if (!updateProvesMatch(terminalized)) {
          throw digestRecoveryFenceLostError();
        }
        return { observedSameKey: true, job: null, terminalized: true };
      }
      return { observedSameKey: true, job: null };
    }

    const currentDeliveryId = requireCanonicalObjectId(
      currentDelivery._id,
      "deliveryId",
    );
    const currentDeliveryObjectId = new mongoose.Types.ObjectId(
      currentDeliveryId,
    );
    const otherJobOwner = await findDigestDelivery(
      DigestDeliveryModel,
      expressionFilter([
        ...exactObjectIdClauses("automationJobId", currentJob._id),
        { $eq: [{ $type: "$_id" }, "objectId"] },
        { $ne: ["$_id", { $literal: currentDeliveryObjectId }] },
      ]),
      { session },
    );
    const rawPayloadDeliveryId = currentJob.payload?.deliveryId;
    const payloadTargetId =
      canonicalDigestPayloadDeliveryId(rawPayloadDeliveryId);
    const payloadIsCanonicalScalar = payloadTargetId !== null;
    const otherPayloadTarget =
      payloadIsCanonicalScalar && payloadTargetId !== currentDeliveryId
        ? await findDigestDelivery(
            DigestDeliveryModel,
            strictObjectIdFilter({ _id: payloadTargetId }),
            { session },
          )
        : null;
    const immutableOrOwned =
      !repairableStatuses.includes(currentJob.status) ||
      !payloadIsCanonicalScalar ||
      Boolean(otherJobOwner) ||
      Boolean(otherPayloadTarget);

    if (immutableOrOwned) {
      const terminalized = await DigestDeliveryModel.updateOne(
        deliveryFence,
        {
          $set: digestTerminalQuarantineFields(
            "Digest automation job payload conflicts with another delivery",
            { clearRecovery: false },
          ),
        },
        { session },
      );
      if (!updateProvesMatch(terminalized)) {
        throw digestRecoveryFenceLostError();
      }
      return { observedSameKey: true, job: null, terminalized: true };
    }

    const repaired = await AutomationJobModel.updateOne(
      combineQueryFilters(
        strictObjectIdFilter({ _id: currentJob._id, firmId }),
        strictStringFilter({
          kind: DIGEST_JOB_KIND,
          idempotencyKey: businessIdentity,
          status: currentJob.status,
        }),
        snapshotFilter({
          "payload.deliveryId": currentJob.payload?.deliveryId,
        }),
        { status: { $in: repairableStatuses } },
      ),
      { $set: { "payload.deliveryId": currentDeliveryId } },
      { session },
    );
    const reread = await findDigestJob(
      AutomationJobModel,
      sameBusinessDigestJobFilter(firmId, businessIdentity),
      { session },
    );
    const rereadIsUsable =
      canonicalObjectId(reread?._id) &&
      digestJobPayloadMatches(reread, currentDelivery._id);
    if (rereadIsUsable) {
      return { observedSameKey: true, job: reread };
    }
    if (reread) {
      const terminalized = await DigestDeliveryModel.updateOne(
        deliveryFence,
        {
          $set: digestTerminalQuarantineFields(
            updateProvesMatch(repaired)
              ? "Digest automation job payload repair was not durable"
              : "Digest automation job payload repair lost its fence",
            { clearRecovery: false },
          ),
        },
        { session },
      );
      if (!updateProvesMatch(terminalized)) {
        throw digestRecoveryFenceLostError();
      }
      return { observedSameKey: true, job: null, terminalized: true };
    }
    return { observedSameKey: true, job: null };
  });
  if (result?.terminalized) {
    lease.delivery.status = "FAILED";
    lease.delivery.email = {
      ...lease.delivery.email,
      state: "FAILED",
      claimToken: null,
      claimedAt: null,
    };
  }
  return result;
}

async function ensureDigestJobExists({
  lease,
  firmId,
  recipientUserId,
  periodKey,
  businessIdentity,
  recoveryClock,
  AutomationJobModel,
  DigestDeliveryModel,
  enqueueJobProvider,
  runRecoveryTransactionProvider,
}) {
  const existingJob = await loadDigestJobCandidates({
    delivery: lease.delivery,
    firmId,
    businessIdentity,
    AutomationJobModel,
  });
  if (existingJob) return existingJob;

  const sameBusinessJob = await findDigestJob(
    AutomationJobModel,
    sameBusinessDigestJobFilter(firmId, businessIdentity),
  );
  if (sameBusinessJob) {
    if (
      canonicalObjectId(sameBusinessJob._id) &&
      digestJobPayloadMatches(sameBusinessJob, lease.delivery._id)
    ) {
      return sameBusinessJob;
    }
    const repairResult = await repairDigestJobPayloadUnderLease({
      lease,
      firmId,
      businessIdentity,
      observedJob: sameBusinessJob,
      recoveryClock,
      AutomationJobModel,
      DigestDeliveryModel,
      runRecoveryTransactionProvider,
    });
    return repairResult?.job || null;
  }

  let enqueuedJob = null;
  try {
    enqueuedJob = await enqueueJobProvider({
      firmId,
      kind: DIGEST_JOB_KIND,
      idempotencyKey: businessIdentity,
      payload: {
        deliveryId: requireCanonicalObjectId(lease.delivery._id, "deliveryId"),
      },
      createdBy: requireCanonicalObjectId(recipientUserId, "recipientUserId"),
      requestId: `digest-scheduler:${periodKey}`,
      maxAttempts: 5,
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }

  const hintedJob =
    canonicalObjectId(enqueuedJob?._id) !== null
      ? await findDigestJob(
          AutomationJobModel,
          combineQueryFilters(
            strictObjectIdFilter({ _id: enqueuedJob._id, firmId }),
            strictStringFilter({
              kind: DIGEST_JOB_KIND,
              idempotencyKey: businessIdentity,
            }),
            digestJobPayloadFilter(lease.delivery._id),
          ),
        )
      : null;
  if (hintedJob) return hintedJob;

  const postEnqueueSameBusinessJob = await findDigestJob(
    AutomationJobModel,
    sameBusinessDigestJobFilter(firmId, businessIdentity),
  );
  if (
    canonicalObjectId(postEnqueueSameBusinessJob?._id) &&
    digestJobPayloadMatches(postEnqueueSameBusinessJob, lease.delivery._id)
  ) {
    return postEnqueueSameBusinessJob;
  }
  const repairResult = await repairDigestJobPayloadUnderLease({
    lease,
    firmId,
    businessIdentity,
    observedJob: postEnqueueSameBusinessJob,
    recoveryClock,
    AutomationJobModel,
    DigestDeliveryModel,
    runRecoveryTransactionProvider,
  });
  return repairResult?.job || null;
}

async function setDigestJobAuthorityUnderLease({
  lease,
  firmId,
  job,
  recoveryClock,
  DigestDeliveryModel,
}) {
  if (!job?._id) return null;
  const authorityNow = digestRecoveryClockNow(recoveryClock);
  const policy = digestJobRecoveryPolicy(lease.delivery, authorityNow);
  const eligibilityFilter = digestRecoverySnapshotFilter(
    lease.delivery,
    authorityNow,
  );
  if (!policy || !eligibilityFilter) return null;

  const nextExpiry = jobRecoveryLeaseExpiry(authorityNow);
  const result = await DigestDeliveryModel.updateOne(
    combineQueryFilters(
      strictObjectIdFilter({ _id: lease.delivery._id, firmId }),
      strictOptionalObjectIdSnapshotFilter(
        "automationJobId",
        lease.delivery.automationJobId,
      ),
      currentJobRecoveryLeaseFilter(lease, authorityNow),
      eligibilityFilter,
    ),
    {
      $set: {
        automationJobId: job._id,
        "jobRecovery.expiresAt": nextExpiry,
      },
    },
  );
  if (!updateProvesMatch(result)) return null;

  lease.delivery.automationJobId = job._id;
  lease.delivery.jobRecovery.expiresAt = nextExpiry;
  return policy;
}

function defaultRunRecoveryTransaction(work) {
  return mongoose.connection.transaction(async (session) => work(session));
}

function defaultRunSettingsTransaction(work) {
  return mongoose.connection.transaction(async (session) => work(session));
}

function digestRecoveryFenceLostError() {
  const error = new Error("Digest recovery transaction lost its target fence");
  error.code = "DIGEST_RECOVERY_JOB_FENCE_LOST";
  return error;
}

const DIGEST_JOB_ATTEMPT_HARD_CAP = 100000;

function normalizeDigestRetryCounter(value) {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
    ? value
    : null;
}

function digestJobReactivationPlan(job, policy) {
  if (
    job?.status !== "FAILED" ||
    typeof job.idempotencyKey !== "string" ||
    policy?.state !== "RECOVERABLE_SENDING"
  ) {
    return null;
  }

  const attemptCount = normalizeDigestRetryCounter(job.attemptCount);
  const normalizedMaxAttempts = normalizeDigestRetryCounter(job.maxAttempts);
  if (
    attemptCount === null ||
    normalizedMaxAttempts === null ||
    attemptCount >= DIGEST_JOB_ATTEMPT_HARD_CAP
  ) {
    return null;
  }

  const cappedMaxAttempts = Math.min(
    normalizedMaxAttempts,
    DIGEST_JOB_ATTEMPT_HARD_CAP,
  );
  if (cappedMaxAttempts <= attemptCount) return null;

  return {
    maxAttempts: Math.min(
      DIGEST_JOB_ATTEMPT_HARD_CAP,
      Math.max(cappedMaxAttempts, attemptCount + 5),
    ),
  };
}

async function reactivateTerminalDigestJobUnderFence(
  job,
  {
    lease,
    firmId,
    now,
    recoveryClock,
    AutomationJobModel,
    DigestDeliveryModel,
    runRecoveryTransactionProvider,
  },
) {
  const terminalStatus = job?.status;
  if (!["FAILED", "SUCCEEDED", "CANCELLED"].includes(terminalStatus)) {
    return job;
  }

  const transactionResult = await runRecoveryTransactionProvider(
    async (session) => {
      if (!session) {
        throw new TypeError("Digest recovery transaction requires a session");
      }
      const transactionNow = digestRecoveryClockNow(recoveryClock);
      const deliveryFilter = combineQueryFilters(
        strictObjectIdFilter({
          _id: lease.delivery._id,
          firmId,
          automationJobId: job._id,
        }),
        currentJobRecoveryLeaseFilter(lease, transactionNow),
        digestRecoveryEligibleStateFilter(transactionNow),
      );
      const currentDelivery = await findDigestDelivery(
        DigestDeliveryModel,
        deliveryFilter,
        { session },
      );
      if (!currentDelivery) return null;

      const currentPolicy = digestJobRecoveryPolicy(
        currentDelivery,
        transactionNow,
      );
      if (!currentPolicy) return null;

      const currentJob = await findDigestJob(
        AutomationJobModel,
        combineQueryFilters(
          strictObjectIdFilter({ _id: job._id, firmId }),
          strictStringFilter({
            kind: DIGEST_JOB_KIND,
            status: terminalStatus,
          }),
          digestJobPayloadFilter(currentDelivery._id),
        ),
        { session },
      );
      if (!currentJob) return null;

      const deliverySnapshotFilter = digestRecoverySnapshotFilter(
        currentDelivery,
        transactionNow,
      );
      if (!deliverySnapshotFilter) return null;
      const nextExpiry = jobRecoveryLeaseExpiry(transactionNow);
      const reactivationPlan = digestJobReactivationPlan(
        currentJob,
        currentPolicy,
      );
      const terminalizeDelivery = reactivationPlan === null;
      const deliverySet = terminalizeDelivery
        ? {
            status: "FAILED",
            "email.state": "FAILED",
            "email.claimToken": null,
            "email.claimedAt": null,
            "inApp.state": "HIDDEN",
            "inApp.availableAt": null,
            "inApp.readAt": null,
            "jobRecovery.expiresAt": nextExpiry,
          }
        : {
            "jobRecovery.expiresAt": nextExpiry,
            "email.state": "PENDING",
            "email.claimToken": null,
            "email.claimedAt": null,
          };
      const fencedDeliveryWrite = await DigestDeliveryModel.updateOne(
        combineQueryFilters(
          strictObjectIdFilter({
            _id: currentDelivery._id,
            firmId,
            automationJobId: currentJob._id,
          }),
          currentJobRecoveryLeaseFilter(lease, transactionNow),
          deliverySnapshotFilter,
        ),
        { $set: deliverySet },
        { session },
      );
      if (!updateProvesMatch(fencedDeliveryWrite)) {
        throw digestRecoveryFenceLostError();
      }

      if (terminalizeDelivery) {
        return {
          delivery: {
            ...currentDelivery,
            status: "FAILED",
            email: {
              ...currentDelivery.email,
              state: "FAILED",
              claimToken: null,
              claimedAt: null,
            },
            inApp: {
              ...currentDelivery.inApp,
              state: "HIDDEN",
              availableAt: null,
              readAt: null,
            },
            jobRecovery: {
              ...currentDelivery.jobRecovery,
              expiresAt: nextExpiry,
            },
          },
          job: currentJob,
        };
      }

      const reactivated = await AutomationJobModel.findOneAndUpdate(
        combineQueryFilters(
          strictObjectIdFilter({ _id: currentJob._id, firmId }),
          strictStringFilter({
            kind: DIGEST_JOB_KIND,
            idempotencyKey: currentJob.idempotencyKey,
            status: "FAILED",
          }),
          snapshotFilter({
            attemptCount: currentJob.attemptCount,
            maxAttempts: currentJob.maxAttempts,
          }),
          digestJobPayloadFilter(currentDelivery._id),
        ),
        {
          $set: {
            status: "PENDING",
            maxAttempts: reactivationPlan.maxAttempts,
            nextAttemptAt: now,
            lastError: "",
            completedAt: null,
            resultSummary: null,
          },
          $unset: { lease: "" },
        },
        { new: true, runValidators: true, session },
      );
      if (!reactivated) throw digestRecoveryFenceLostError();

      const recoveredDelivery = {
        ...currentDelivery,
        email: {
          ...currentDelivery.email,
          state: "PENDING",
          claimToken: null,
          claimedAt: null,
        },
        jobRecovery: {
          ...currentDelivery.jobRecovery,
          expiresAt: nextExpiry,
        },
      };
      return { delivery: recoveredDelivery, job: reactivated };
    },
  );

  if (!transactionResult?.job) return null;
  lease.delivery = transactionResult.delivery;
  return transactionResult.job;
}

async function releaseRecoverableSendingClaim({
  lease,
  authoritativeJob,
  recoveryClock,
  DigestDeliveryModel,
}) {
  if (!["PENDING", "RETRY_SCHEDULED"].includes(authoritativeJob?.status)) {
    return false;
  }
  const releaseNow = digestRecoveryClockNow(recoveryClock);
  const policy = digestJobRecoveryPolicy(lease.delivery, releaseNow);
  const eligibilityFilter = digestRecoverySnapshotFilter(
    lease.delivery,
    releaseNow,
  );
  if (!policy?.allowFailedRetry || !eligibilityFilter) return false;

  const result = await DigestDeliveryModel.updateOne(
    combineQueryFilters(
      strictObjectIdFilter({
        _id: lease.delivery._id,
        firmId: lease.delivery.firmId,
        automationJobId: authoritativeJob._id,
      }),
      currentJobRecoveryLeaseFilter(lease, releaseNow),
      eligibilityFilter,
    ),
    {
      $set: {
        "email.state": "PENDING",
        "email.claimToken": null,
        "email.claimedAt": null,
      },
    },
  );
  if (!updateProvesMatch(result)) return false;

  lease.delivery.email.state = "PENDING";
  lease.delivery.email.claimToken = null;
  lease.delivery.email.claimedAt = null;
  return true;
}

async function activateDigestJobUnderLease({
  lease,
  firmId,
  recipientUserId,
  periodKey,
  businessIdentity,
  now,
  recoveryClock,
  AutomationJobModel,
  DigestDeliveryModel,
  enqueueJobProvider,
  runRecoveryTransactionProvider,
}) {
  const eligibilityNow = digestRecoveryClockNow(recoveryClock);
  if (!digestJobRecoveryPolicy(lease.delivery, eligibilityNow)) return null;

  const candidateJob = await ensureDigestJobExists({
    lease,
    firmId,
    recipientUserId,
    periodKey,
    businessIdentity,
    recoveryClock,
    AutomationJobModel,
    DigestDeliveryModel,
    enqueueJobProvider,
    runRecoveryTransactionProvider,
  });
  if (!candidateJob?._id) return null;

  const authorityPolicy = await setDigestJobAuthorityUnderLease({
    lease,
    firmId,
    job: candidateJob,
    recoveryClock,
    DigestDeliveryModel,
  });
  if (!authorityPolicy) return null;

  let authoritativeJob = await findDigestJob(
    AutomationJobModel,
    combineQueryFilters(
      strictObjectIdFilter({ _id: candidateJob._id, firmId }),
      strictStringFilter({ kind: DIGEST_JOB_KIND }),
      digestJobPayloadFilter(lease.delivery._id),
    ),
  );
  if (!authoritativeJob) return null;

  if (["FAILED", "SUCCEEDED", "CANCELLED"].includes(authoritativeJob.status)) {
    authoritativeJob = await reactivateTerminalDigestJobUnderFence(
      authoritativeJob,
      {
        lease,
        firmId,
        now,
        recoveryClock,
        AutomationJobModel,
        DigestDeliveryModel,
        runRecoveryTransactionProvider,
      },
    );
    if (!authoritativeJob) return null;
    return authoritativeJob;
  }

  await releaseRecoverableSendingClaim({
    lease,
    authoritativeJob,
    recoveryClock,
    DigestDeliveryModel,
  });
  return authoritativeJob;
}

async function activateAuthoritativeDigestJob({
  delivery,
  firmId,
  recipientUserId,
  periodKey,
  businessIdentity,
  now,
  recoveryClock,
  AutomationJobModel,
  DigestDeliveryModel,
  enqueueJobProvider,
  runRecoveryTransactionProvider,
}) {
  const lease = await acquireDigestJobRecoveryLease({
    deliveryId: delivery._id,
    firmId,
    now: digestRecoveryClockNow(recoveryClock),
    DigestDeliveryModel,
  });
  if (!lease) {
    const winner = await readDigestAuthority({
      deliveryId: delivery._id,
      firmId,
      AutomationJobModel,
      DigestDeliveryModel,
    });
    delivery.automationJobId = winner.delivery?.automationJobId ?? null;
    return winner.job;
  }

  let authoritativeJob = null;
  let activationError = null;
  try {
    authoritativeJob = await activateDigestJobUnderLease({
      lease,
      firmId,
      recipientUserId,
      periodKey,
      businessIdentity,
      now,
      recoveryClock,
      AutomationJobModel,
      DigestDeliveryModel,
      enqueueJobProvider,
      runRecoveryTransactionProvider,
    });
  } catch (error) {
    activationError = error;
  }

  let released = false;
  try {
    released = await releaseDigestJobRecoveryLease({
      lease,
      DigestDeliveryModel,
    });
  } catch (error) {
    if (!activationError) activationError = error;
  }
  if (activationError) throw activationError;
  if (!authoritativeJob || !released) {
    const winner = await readDigestAuthority({
      deliveryId: delivery._id,
      firmId,
      AutomationJobModel,
      DigestDeliveryModel,
    });
    delivery.automationJobId = winner.delivery?.automationJobId ?? null;
    return winner.job;
  }

  delivery.automationJobId = authoritativeJob._id;
  return authoritativeJob;
}

async function enqueueRecipientDigest(
  { firm, recipient, kind, periodKey, noticeCasesEnabled, now },
  {
    AutomationJob: AutomationJobModel = AutomationJob,
    DigestDelivery: DigestDeliveryModel = DigestDelivery,
    buildDigestSummary: buildDigestSummaryProvider = buildDigestSummary,
    enqueueJob: enqueueJobProvider = enqueueJob,
    runRecoveryTransaction:
      runRecoveryTransactionProvider = defaultRunRecoveryTransaction,
    recoveryClock: recoveryClockProvider = () => new Date(),
  } = {},
) {
  const businessIdentity = digestBusinessIdentity({
    firmId: firm._id,
    kind,
    periodKey,
    recipientUserId: recipient._id,
  });
  const deliveryIdentityFilter = combineQueryFilters(
    strictObjectIdFilter({
      firmId: firm._id,
      recipientUserId: recipient._id,
    }),
    strictStringFilter({ kind, periodKey }),
  );
  const existing = await findDigestDelivery(
    DigestDeliveryModel,
    deliveryIdentityFilter,
  );
  let delivery = existing;
  if (!delivery) {
    const summary = await buildDigestSummaryProvider({
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
    delivery = await DigestDeliveryModel.findOneAndUpdate(
      // deliveryIdentityFilter carries $expr type assertions and cannot be used
      // here. The strict read above already ran with it; this filter matches the
      // same identity, and the unique index on
      // {firmId, kind, periodKey, recipientUserId} is what guarantees it.
      combineQueryFilters(
        upsertObjectIdEqualityFilter({
          firmId: firm._id,
          recipientUserId: recipient._id,
        }),
        upsertEqualityFilter({ kind, periodKey }),
      ),
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
          email: {
            state: emailEnabled ? "PENDING" : "DISABLED",
            attempts: 0,
            idempotencyKey: businessIdentity,
          },
          inApp: emailEnabled
            ? { state: "HIDDEN" }
            : { state: "AVAILABLE", availableAt: now },
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  }

  const shouldEnsureWork =
    delivery?.email?.state === "PENDING" ||
    digestSendingRecoveryReason(delivery, now) !== null;
  if (!shouldEnsureWork) return delivery;

  await activateAuthoritativeDigestJob({
    delivery,
    firmId: firm._id,
    recipientUserId: recipient._id,
    periodKey,
    businessIdentity,
    now,
    recoveryClock: recoveryClockProvider,
    AutomationJobModel,
    DigestDeliveryModel,
    enqueueJobProvider,
    runRecoveryTransactionProvider,
  });
  return delivery;
}

const DIGEST_RECOVERY_BATCH_SIZE = 100;
const DIGEST_RECOVERY_MAX_BATCHES = 5;

function digestRecoveryClockNow(clock) {
  const value = typeof clock === "function" ? clock() : clock?.now?.();
  const instant = new Date(value instanceof Date ? value.getTime() : value);
  if (!Number.isFinite(instant.getTime())) {
    throw new TypeError("Digest recovery clock returned an invalid time");
  }
  return instant;
}

const DIGEST_RECOVERY_MARKER_VERSION = "drc1";
const DIGEST_RECOVERY_LEASE_TOKEN_MAX_LENGTH = 64;
const DIGEST_RECOVERY_OWNER_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_RECOVERY_COMPACT_OWNER_PATTERN = /^[0-9a-f]{32}$/i;
const DIGEST_RECOVERY_LEGACY_FENCE_MS = 8_640_000_000_000_000;
const DIGEST_RECOVERY_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

function digestRecoveryCursorLeaseExpiry(now) {
  return new Date(new Date(now).getTime() + DIGEST_RECOVERY_CURSOR_LEASE_MS);
}

function digestRecoveryLegacyFenceExpiry() {
  return new Date(DIGEST_RECOVERY_LEGACY_FENCE_MS);
}

function digestRecoveryHasLegacyFence(value) {
  return (
    value instanceof Date && value.getTime() === DIGEST_RECOVERY_LEGACY_FENCE_MS
  );
}

function digestRecoveryStoredLeaseExpiry({
  failureCount,
  legacyFenceRequired,
  leaseExpiry,
}) {
  return legacyFenceRequired || failureCount > 0
    ? digestRecoveryLegacyFenceExpiry()
    : leaseExpiry;
}

function digestRecoveryCursorInvalidError() {
  const error = new Error("Digest recovery cursor marker is invalid");
  error.code = "DIGEST_RECOVERY_CURSOR_INVALID";
  return error;
}

function parseDigestRecoveryFailureCount(value) {
  if (!/^(0|[1-9]\d*)$/.test(value)) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function parseDigestRecoveryLeaseExpiry(value) {
  if (!/^(0|[1-9a-z][0-9a-z]*)$/.test(value)) return null;
  const expiryMs = Number.parseInt(value, 36);
  return Number.isSafeInteger(expiryMs) &&
    expiryMs >= 0 &&
    expiryMs.toString(36) === value
    ? expiryMs
    : null;
}

function decodeDigestRecoveryLeaseToken(value) {
  if (value !== null && value !== undefined && typeof value !== "string") {
    throw digestRecoveryCursorInvalidError();
  }
  const token = typeof value === "string" ? value.trim() : "";
  if (token.length > DIGEST_RECOVERY_LEASE_TOKEN_MAX_LENGTH) {
    throw digestRecoveryCursorInvalidError();
  }
  if (!token) {
    // Legacy null and empty tokens were always immediately claimable,
    // regardless of a stale expiresAt value.
    return { failureCount: 0, active: false, legacy: true };
  }
  if (!token.startsWith(`${DIGEST_RECOVERY_MARKER_VERSION}:`)) {
    // Deployed legacy owners were UUIDs. Reject other short strings instead of
    // allowing corrupted or case-shifted markers to wedge recovery forever.
    if (!DIGEST_RECOVERY_OWNER_PATTERN.test(token)) {
      throw digestRecoveryCursorInvalidError();
    }
    return { failureCount: 0, active: true, legacy: true };
  }

  const idleMatch = token.match(/^drc1:(0|[1-9]\d*)$/);
  if (idleMatch) {
    const failureCount = parseDigestRecoveryFailureCount(idleMatch[1]);
    if (failureCount !== null) {
      return { failureCount, active: false, legacy: false };
    }
  }

  const activeMatch = token.match(
    /^drc1:(0|[1-9]\d*):([0-9a-f]{32}):(0|[1-9a-z][0-9a-z]*)$/i,
  );
  if (
    activeMatch &&
    DIGEST_RECOVERY_COMPACT_OWNER_PATTERN.test(activeMatch[2])
  ) {
    const failureCount = parseDigestRecoveryFailureCount(activeMatch[1]);
    const expiresAtMs = parseDigestRecoveryLeaseExpiry(
      activeMatch[3].toLowerCase(),
    );
    if (failureCount !== null && expiresAtMs !== null) {
      return {
        failureCount,
        active: true,
        legacy: false,
        expiresAtMs,
      };
    }
  }

  throw digestRecoveryCursorInvalidError();
}

function encodeDigestRecoveryLeaseToken(
  failureCount,
  ownerToken = null,
  expiresAt = null,
) {
  if (
    !Number.isSafeInteger(failureCount) ||
    failureCount < 0 ||
    failureCount > Number.MAX_SAFE_INTEGER
  ) {
    throw new TypeError("Digest recovery failure count is invalid");
  }
  if (ownerToken === null) {
    if (expiresAt !== null) {
      throw new TypeError("Digest recovery idle marker cannot have an expiry");
    }
    return `${DIGEST_RECOVERY_MARKER_VERSION}:${failureCount}`;
  }
  if (
    typeof ownerToken !== "string" ||
    !DIGEST_RECOVERY_OWNER_PATTERN.test(ownerToken)
  ) {
    throw new TypeError("Digest recovery lease owner token is invalid");
  }
  const expiresAtMs =
    expiresAt instanceof Date ? expiresAt.getTime() : Number(expiresAt);
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs < 0) {
    throw new TypeError("Digest recovery lease expiry is invalid");
  }
  const compactOwner = ownerToken.replaceAll("-", "").toLowerCase();
  const token = `${DIGEST_RECOVERY_MARKER_VERSION}:${failureCount}:${compactOwner}:${expiresAtMs.toString(36)}`;
  if (token.length > DIGEST_RECOVERY_LEASE_TOKEN_MAX_LENGTH) {
    throw new TypeError("Digest recovery lease token is too long");
  }
  return token;
}

function digestRecoveryLeaseIsAvailable(decodedToken, expiresAt, now) {
  if (!decodedToken.active) return true;
  const latestPlausibleExpiry =
    now.getTime() +
    DIGEST_RECOVERY_CURSOR_LEASE_MS +
    DIGEST_RECOVERY_MAX_CLOCK_SKEW_MS;
  if (!decodedToken.legacy) {
    return (
      decodedToken.expiresAtMs <= now.getTime() ||
      decodedToken.expiresAtMs > latestPlausibleExpiry
    );
  }
  const expiresAtMs =
    expiresAt instanceof Date && Number.isFinite(expiresAt.getTime())
      ? expiresAt.getTime()
      : null;
  return (
    expiresAtMs === null ||
    expiresAtMs <= now.getTime() ||
    expiresAtMs > latestPlausibleExpiry
  );
}

async function acquireDigestRecoveryCursorLease({
  DigestRecoveryCursorModel,
  clock,
  ownerToken = randomUUID(),
}) {
  const now = digestRecoveryClockNow(clock);
  const snapshot = await DigestRecoveryCursorModel.findOne({
    _id: DIGEST_RECOVERY_CURSOR_ID,
  }).lean();
  const decodedToken = decodeDigestRecoveryLeaseToken(snapshot?.lease?.token);
  const legacyFenceRequired =
    !decodedToken.legacy &&
    (!decodedToken.active ||
      decodedToken.failureCount > 0 ||
      digestRecoveryHasLegacyFence(snapshot?.lease?.expiresAt));
  if (
    snapshot &&
    !digestRecoveryLeaseIsAvailable(
      decodedToken,
      snapshot?.lease?.expiresAt,
      now,
    )
  ) {
    return null;
  }

  const leaseExpiry = digestRecoveryCursorLeaseExpiry(now);
  const activeToken = encodeDigestRecoveryLeaseToken(
    decodedToken.failureCount,
    ownerToken,
    leaseExpiry,
  );
  // This fence guards an upsert, so it cannot use the $expr form. On first use
  // both values are undefined and the fence becomes "these fields are absent",
  // which is what allows the insert; afterwards it pins the exact lease that was
  // read, and a loser of that race is handled by the duplicate-key branch below.
  const snapshotFence = upsertEqualityFilter({
    "lease.token": snapshot?.lease?.token,
    "lease.expiresAt": snapshot?.lease?.expiresAt,
  });
  try {
    const cursor = await DigestRecoveryCursorModel.findOneAndUpdate(
      combineQueryFilters({ _id: DIGEST_RECOVERY_CURSOR_ID }, snapshotFence),
      {
        $set: {
          "lease.token": activeToken,
          "lease.expiresAt": digestRecoveryStoredLeaseExpiry({
            failureCount: decodedToken.failureCount,
            legacyFenceRequired,
            leaseExpiry,
          }),
        },
        $setOnInsert: { afterId: null, cycleEndId: null },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    return cursor
      ? {
          cursor,
          token: activeToken,
          ownerToken,
          failureCount: decodedToken.failureCount,
          legacyFenceRequired,
        }
      : null;
  } catch (error) {
    // Concurrent first-use upserts race on the singleton _id. The winner owns
    // the lease; the duplicate-key loser behaves exactly like live contention.
    if (error?.code === 11000 || error?.codeName === "DuplicateKey")
      return null;
    throw error;
  }
}

function safeDigestRecoveryErrorCode(error) {
  const candidate = String(error?.code || error?.name || "").toUpperCase();
  return /^[A-Z][A-Z0-9_]{0,79}$/.test(candidate)
    ? candidate
    : "DIGEST_RECOVERY_ROW_FAILED";
}

function defaultDigestRecoveryErrorReporter({ code }) {
  console.error("[DIGEST] Recovery row failed:", code);
}

async function reportDigestRecoveryError(reporter, error) {
  const code = safeDigestRecoveryErrorCode(error);
  try {
    await reporter({ code });
  } catch {
    console.error("[DIGEST] Recovery error reporter failed");
  }
  return code;
}

function nextDigestRecoveryFailureCount(failureCount, increment) {
  if (!increment) return failureCount;
  return failureCount >= Number.MAX_SAFE_INTEGER
    ? Number.MAX_SAFE_INTEGER
    : failureCount + 1;
}

async function updateDigestRecoveryCursor({
  DigestRecoveryCursorModel,
  token,
  ownerToken,
  failureCount,
  legacyFenceRequired,
  incrementFailure = false,
  afterId,
  cycleEndId,
  clock,
}) {
  const now = digestRecoveryClockNow(clock);
  const nextFailureCount = nextDigestRecoveryFailureCount(
    failureCount,
    incrementFailure,
  );
  const nextLegacyFenceRequired = legacyFenceRequired || nextFailureCount > 0;
  const leaseExpiry = digestRecoveryCursorLeaseExpiry(now);
  const nextToken = encodeDigestRecoveryLeaseToken(
    nextFailureCount,
    ownerToken,
    leaseExpiry,
  );
  const result = await DigestRecoveryCursorModel.updateOne(
    {
      _id: DIGEST_RECOVERY_CURSOR_ID,
      "lease.token": token,
    },
    {
      $set: {
        afterId,
        cycleEndId,
        "lease.token": nextToken,
        "lease.expiresAt": digestRecoveryStoredLeaseExpiry({
          failureCount: nextFailureCount,
          legacyFenceRequired: nextLegacyFenceRequired,
          leaseExpiry,
        }),
      },
    },
  );
  return {
    matched: updateProvesMatch(result),
    token: nextToken,
    failureCount: nextFailureCount,
    legacyFenceRequired: nextLegacyFenceRequired,
  };
}

async function releaseDigestRecoveryCursorLease({
  DigestRecoveryCursorModel,
  token,
  failureCount,
  legacyFenceRequired,
}) {
  const preserveMarker = legacyFenceRequired || failureCount > 0;
  const result = await DigestRecoveryCursorModel.updateOne(
    {
      _id: DIGEST_RECOVERY_CURSOR_ID,
      "lease.token": token,
    },
    {
      $set: {
        "lease.token": preserveMarker
          ? encodeDigestRecoveryLeaseToken(failureCount)
          : null,
        "lease.expiresAt": preserveMarker
          ? digestRecoveryLegacyFenceExpiry()
          : null,
      },
    },
  );
  return updateProvesMatch(result);
}

async function completeDigestRecoveryCycle({
  DigestRecoveryCursorModel,
  token,
  cycleEndId,
  retryRequired,
}) {
  const result = await DigestRecoveryCursorModel.updateOne(
    {
      _id: DIGEST_RECOVERY_CURSOR_ID,
      "lease.token": token,
    },
    {
      $set: {
        afterId: null,
        cycleEndId: retryRequired ? cycleEndId : null,
        "lease.token": retryRequired ? encodeDigestRecoveryLeaseToken(0) : null,
        "lease.expiresAt": retryRequired
          ? digestRecoveryLegacyFenceExpiry()
          : null,
      },
    },
  );
  return updateProvesMatch(result);
}

function digestRecoveryIdRangeFilter({ afterId = null, cycleEndId }) {
  const canonicalCycleEndId = requireCanonicalObjectId(
    cycleEndId,
    "cycleEndId",
  );
  return {
    _id: {
      ...(afterId
        ? {
            $gt: requireCanonicalObjectId(afterId, "afterId"),
          }
        : {}),
      $lte: canonicalCycleEndId,
    },
  };
}

async function findDigestRecoveryCycleEndId({ DigestDeliveryModel }) {
  const rows = await DigestDeliveryModel.find({})
    .select("_id")
    .sort({ _id: -1 })
    .limit(1)
    .lean();
  return rows[0]?._id ?? null;
}

function expandDigestRecoveryCycleEndId(
  currentCycleEndId,
  candidateCycleEndId,
) {
  if (!candidateCycleEndId) return currentCycleEndId;
  if (!currentCycleEndId) return candidateCycleEndId;
  const current = requireCanonicalObjectId(currentCycleEndId, "cycleEndId");
  const candidate = requireCanonicalObjectId(
    candidateCycleEndId,
    "candidateCycleEndId",
  );
  return candidate > current ? candidateCycleEndId : currentCycleEndId;
}

function digestRecoveryPassResult(
  state,
  { rowsProcessed = 0, rowFailures = [], cycleFailureCount = 0 } = {},
) {
  return {
    state,
    completed: state === "completed",
    incomplete: state === "incomplete",
    busy: state === "busy",
    leaseLost: state === "leaseLost",
    rowsProcessed,
    rowFailures,
    cycleFailureCount,
  };
}

async function reconcileRecoverableDigestDeliveries({
  now,
  noticeCasesEnabled,
  DigestDeliveryModel,
  DigestRecoveryCursorModel,
  enqueueRecipientDigestProvider,
  recoveryClock,
  recoveryErrorReporter,
}) {
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs)) {
    throw new TypeError("Digest reconciliation requires a valid current time");
  }
  const rowFailures = [];
  let rowsProcessed = 0;
  const cursorLease = await acquireDigestRecoveryCursorLease({
    DigestRecoveryCursorModel,
    clock: recoveryClock,
  });
  if (!cursorLease) {
    return digestRecoveryPassResult("busy");
  }

  let afterId = cursorLease.cursor.afterId ?? null;
  let cycleEndId = cursorLease.cursor.cycleEndId ?? null;
  let leaseToken = cursorLease.token;
  let failureCount = cursorLease.failureCount;
  let legacyFenceRequired = cursorLease.legacyFenceRequired;
  let cycleFailureCount = 0;
  let leaseOwned = true;
  let state = "incomplete";
  const markLeaseLost = async () => {
    if (state === "leaseLost") return;
    state = "leaseLost";
    leaseOwned = false;
    await reportDigestRecoveryError(recoveryErrorReporter, {
      code: "DIGEST_RECOVERY_CURSOR_LEASE_LOST",
    });
  };
  const persistCursor = async ({
    nextAfterId = afterId,
    nextCycleEndId = cycleEndId,
    incrementFailure = false,
  } = {}) => {
    const updated = await updateDigestRecoveryCursor({
      DigestRecoveryCursorModel,
      token: leaseToken,
      ownerToken: cursorLease.ownerToken,
      failureCount,
      legacyFenceRequired,
      incrementFailure,
      afterId: nextAfterId,
      cycleEndId: nextCycleEndId,
      clock: recoveryClock,
    });
    if (!updated.matched) {
      await markLeaseLost();
      return false;
    }
    leaseToken = updated.token;
    failureCount = updated.failureCount;
    legacyFenceRequired = updated.legacyFenceRequired;
    afterId = nextAfterId;
    cycleEndId = nextCycleEndId;
    return true;
  };
  const finishCycle = async () => {
    const retryRequired = failureCount > 0;
    let retryCycleEndId = cycleEndId;
    if (retryRequired) {
      const latestCycleEndId = await findDigestRecoveryCycleEndId({
        DigestDeliveryModel,
      });
      retryCycleEndId = expandDigestRecoveryCycleEndId(
        cycleEndId,
        latestCycleEndId,
      );
    }
    const completed = await completeDigestRecoveryCycle({
      DigestRecoveryCursorModel,
      token: leaseToken,
      cycleEndId: retryCycleEndId,
      retryRequired,
    });
    if (!completed) {
      await markLeaseLost();
      return false;
    }
    cycleFailureCount = retryRequired ? failureCount : 0;
    afterId = null;
    cycleEndId = retryRequired ? retryCycleEndId : null;
    leaseOwned = false;
    state = "completed";
    return true;
  };

  try {
    if (!cycleEndId) {
      const discoveredCycleEndId = await findDigestRecoveryCycleEndId({
        DigestDeliveryModel,
      });
      if (discoveredCycleEndId) {
        await persistCursor({ nextCycleEndId: discoveredCycleEndId });
      } else {
        await finishCycle();
      }
    }

    if (leaseOwned && cycleEndId) {
      for (
        let batchNumber = 0;
        batchNumber < DIGEST_RECOVERY_MAX_BATCHES;
        batchNumber += 1
      ) {
        const deliveries = await DigestDeliveryModel.find(
          digestRecoveryIdRangeFilter({ afterId, cycleEndId }),
        )
          .select(
            "firmId recipientUserId kind periodKey timezone email.state email.claimToken email.claimedAt",
          )
          .sort({ _id: 1 })
          .limit(DIGEST_RECOVERY_BATCH_SIZE)
          .lean();
        if (!deliveries.length) {
          await finishCycle();
          break;
        }

        for (const delivery of deliveries) {
          let rowFailed = false;
          const shouldReconcile =
            delivery.email?.state === "PENDING" ||
            digestSendingRecoveryReason(delivery, now) !== null;
          if (shouldReconcile) {
            try {
              await enqueueRecipientDigestProvider({
                firm: {
                  _id: delivery.firmId,
                  timezone: delivery.timezone || "Asia/Kolkata",
                },
                recipient: { _id: delivery.recipientUserId },
                kind: delivery.kind,
                periodKey: delivery.periodKey,
                noticeCasesEnabled,
                now,
              });
            } catch (error) {
              const code = await reportDigestRecoveryError(
                recoveryErrorReporter,
                error,
              );
              rowFailures.push({
                deliveryId: String(delivery._id),
                code,
              });
              rowFailed = true;
            }
          }

          // Failure count and keyset advance share one ownership-fenced write,
          // so poison rows cannot starve later rows or disappear after restart.
          const advanced = await persistCursor({
            nextAfterId: delivery._id,
            incrementFailure: rowFailed,
          });
          if (!advanced) break;
          rowsProcessed += 1;
        }

        if (!leaseOwned) break;
        const reachedCycleEnd =
          deliveries.length < DIGEST_RECOVERY_BATCH_SIZE ||
          sameObjectId(deliveries.at(-1)?._id, cycleEndId);
        if (reachedCycleEnd) {
          await finishCycle();
          break;
        }
      }
    }
  } finally {
    if (leaseOwned) {
      const released = await releaseDigestRecoveryCursorLease({
        DigestRecoveryCursorModel,
        token: leaseToken,
        failureCount,
        legacyFenceRequired,
      });
      if (!released) await markLeaseLost();
    }
  }

  return digestRecoveryPassResult(state, {
    rowsProcessed,
    rowFailures,
    cycleFailureCount,
  });
}

function defaultDigestRecoveryYield() {
  return new Promise((resolve) => setImmediate(resolve));
}

function digestRecoveryDrainError(
  code,
  message,
  {
    passes,
    rowsProcessed,
    rowFailures,
    rowFailureCount = rowFailures.length,
    rowFailuresComplete = rowFailures.length === rowFailureCount,
  },
) {
  const error = new Error(message);
  error.code = code;
  error.passes = passes;
  error.rowsProcessed = rowsProcessed;
  error.rowFailures = rowFailures;
  if (code === "DIGEST_RECOVERY_ROWS_FAILED") {
    error.rowFailureCount = rowFailureCount;
    error.rowFailuresComplete = rowFailuresComplete;
  }
  return error;
}

export async function drainDigestRecovery(
  { now = new Date() } = {},
  {
    AppConfig: AppConfigModel = AppConfig,
    DigestDelivery: DigestDeliveryModel = DigestDelivery,
    DigestRecoveryCursor: DigestRecoveryCursorModel = DigestRecoveryCursor,
    enqueueRecipientDigest:
      enqueueRecipientDigestProvider = enqueueRecipientDigest,
    reconcileRecoveryPass:
      reconcileRecoveryPassProvider = reconcileRecoverableDigestDeliveries,
    recoveryClock = () => new Date(),
    reportRecoveryError:
      recoveryErrorReporter = defaultDigestRecoveryErrorReporter,
    yieldControl = defaultDigestRecoveryYield,
  } = {},
) {
  if (typeof reconcileRecoveryPassProvider !== "function") {
    throw new TypeError("Digest recovery pass provider must be a function");
  }
  if (typeof yieldControl !== "function") {
    throw new TypeError("Digest recovery yield provider must be a function");
  }

  const noticeCasesEnabled =
    (await AppConfigModel.isFeatureEnabled("noticeCases", {
      fresh: true,
    })) === true;
  const aggregate = {
    completed: false,
    passes: 0,
    rowsProcessed: 0,
    rowFailures: [],
  };

  while (true) {
    const pass = await reconcileRecoveryPassProvider({
      now,
      noticeCasesEnabled,
      DigestDeliveryModel,
      DigestRecoveryCursorModel,
      enqueueRecipientDigestProvider,
      recoveryClock,
      recoveryErrorReporter,
    });
    aggregate.passes += 1;
    if (Number.isSafeInteger(pass?.rowsProcessed) && pass.rowsProcessed >= 0) {
      aggregate.rowsProcessed += pass.rowsProcessed;
    }
    if (Array.isArray(pass?.rowFailures)) {
      aggregate.rowFailures.push(...pass.rowFailures);
    }

    if (pass?.state === "busy" || pass?.busy === true) {
      throw digestRecoveryDrainError(
        "DIGEST_RECOVERY_BUSY",
        "Digest recovery is already running",
        aggregate,
      );
    }
    if (pass?.state === "leaseLost" || pass?.leaseLost === true) {
      throw digestRecoveryDrainError(
        "DIGEST_RECOVERY_CURSOR_LEASE_LOST",
        "Digest recovery cursor lease was lost",
        aggregate,
      );
    }
    if (pass?.state === "completed" && pass?.completed === true) {
      aggregate.completed = true;
      const durableFailureCount =
        nonnegativeSafeInteger(pass?.cycleFailureCount) ?? 0;
      const rowFailureCount = Math.max(
        durableFailureCount,
        aggregate.rowFailures.length,
      );
      if (rowFailureCount > 0) {
        throw digestRecoveryDrainError(
          "DIGEST_RECOVERY_ROWS_FAILED",
          `Digest recovery completed with ${rowFailureCount} row failure(s)`,
          { ...aggregate, rowFailureCount },
        );
      }
      return aggregate;
    }
    if (pass?.state !== "incomplete" || pass?.incomplete !== true) {
      throw digestRecoveryDrainError(
        "DIGEST_RECOVERY_INVALID_PASS_STATE",
        "Digest recovery pass returned no durable completion state",
        aggregate,
      );
    }

    await yieldControl();
  }
}

export async function enqueueDueDigests(
  { now = new Date() } = {},
  {
    AppConfig: AppConfigModel = AppConfig,
    DigestDelivery: DigestDeliveryModel = DigestDelivery,
    DigestRecoveryCursor: DigestRecoveryCursorModel = DigestRecoveryCursor,
    Firm: FirmModel = Firm,
    FirmMembership: FirmMembershipModel = FirmMembership,
    User: UserModel = User,
    enqueueRecipientDigest:
      enqueueRecipientDigestProvider = enqueueRecipientDigest,
    recoveryClock = () => new Date(),
    reportRecoveryError:
      recoveryErrorReporter = defaultDigestRecoveryErrorReporter,
  } = {},
) {
  const [dailyEnabled, weeklyEnabled, noticeCasesEnabled] = await Promise.all([
    AppConfigModel.isFeatureEnabled("dailyDigest", { fresh: true }),
    AppConfigModel.isFeatureEnabled("weeklySummary", { fresh: true }),
    AppConfigModel.isFeatureEnabled("noticeCases", { fresh: true }),
  ]);
  await reconcileRecoverableDigestDeliveries({
    now,
    noticeCasesEnabled,
    DigestDeliveryModel,
    DigestRecoveryCursorModel,
    enqueueRecipientDigestProvider,
    recoveryClock,
    recoveryErrorReporter,
  });
  if (!dailyEnabled && !weeklyEnabled) {
    return { firms: 0, daily: 0, weekly: 0, disabled: true };
  }

  const result = { firms: 0, daily: 0, weekly: 0, disabled: false };
  let afterId = null;
  while (true) {
    const firms = await FirmModel.find({
      isActive: true,
      ...(afterId
        ? { _id: { $gt: requireCanonicalObjectId(afterId, "afterId") } }
        : {}),
    })
      .select("timezone digestSettings kind ownerUserId")
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

      const memberships = await FirmMembershipModel.find(
        combineQueryFilters(strictObjectIdFilter({ firmId: firm._id }), {
          status: "ACTIVE",
        }),
      )
        .select("userId role status")
        .lean();
      const activeMemberships = memberships.filter(
        (membership) =>
          membership?.status === "ACTIVE" &&
          canonicalObjectId(membership.userId) !== null,
      );
      const membershipsByUserId = new Map(
        activeMemberships.map((membership) => [
          canonicalObjectId(membership.userId),
          membership,
        ]),
      );
      const recipientIds = activeMemberships.map(
        (membership) =>
          new mongoose.Types.ObjectId(canonicalObjectId(membership.userId)),
      );
      const recipients = recipientIds.length
        ? await UserModel.find(
            combineQueryFilters(
              expressionFilter([
                { $eq: [{ $type: "$_id" }, "objectId"] },
                { $in: ["$_id", { $literal: recipientIds }] },
              ]),
              { isActive: true },
            ),
          )
            .select("role digestPreferences")
            .lean()
        : [];
      for (const recipient of recipients) {
        const membership = membershipsByUserId.get(
          canonicalObjectId(recipient._id),
        );
        const recipientPolicy = digestRecipientPolicy({
          firm,
          recipientUserId: recipient._id,
          membership,
        });
        if (!recipientPolicy.allowed) continue;
        const preferences = effectivePreferences(recipient);
        if (
          dailyDue &&
          preferences.dailyEnabled &&
          dailyDigestDueForFrequency(preferences.dailyFrequency, parts)
        ) {
          await enqueueRecipientDigestProvider({
            firm,
            recipient,
            kind: DAILY_KIND,
            periodKey: parts.dateKey,
            noticeCasesEnabled,
            now,
          });
          result.daily += 1;
        }
        const weeklyAuthority = hasWeeklyDigestAuthority({
          membership,
          user: recipient,
        });
        if (firmWeeklyDue && weeklyAuthority && preferences.weeklyEnabled) {
          await enqueueRecipientDigestProvider({
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

function inAppAvailabilityFields(delivery, availableAt) {
  if (delivery?.inApp?.state !== "HIDDEN") return {};
  return {
    "inApp.state": "AVAILABLE",
    "inApp.availableAt": availableAt,
  };
}

function digestClaimLostResult(deliveryId) {
  return {
    outcome: "DIGEST_CLAIM_LOST",
    deliveryId,
    defer: true,
    reason: "Digest send claim changed before completion",
    retryAfterMs: 30 * 1000,
  };
}

function digestAuthorityFailure({
  delivery,
  firm,
  recipient,
  membership,
  resolved = {},
}) {
  const firmResolved = resolved.firm !== false;
  const recipientResolved = resolved.recipient !== false;
  const membershipResolved = resolved.membership !== false;

  if (firmResolved && !firm) {
    return {
      outcome: "DIGEST_FIRM_UNAVAILABLE",
      fields: {
        status: "FAILED",
        "email.state": "FAILED",
        "email.lastError": "Firm is inactive or unavailable",
        "email.claimToken": null,
        "email.claimedAt": null,
        "inApp.state": "HIDDEN",
        "inApp.availableAt": null,
        "inApp.readAt": null,
      },
    };
  }
  if (!firmResolved) {
    if (recipientResolved && !recipient) {
      return {
        outcome: "DIGEST_RECIPIENT_UNAVAILABLE",
        fields: {
          status: "FAILED",
          "email.state": "FAILED",
          "email.lastError": "Recipient is inactive or unavailable",
          "email.claimToken": null,
          "email.claimedAt": null,
          "inApp.state": "HIDDEN",
          "inApp.availableAt": null,
          "inApp.readAt": null,
        },
      };
    }
    if (membershipResolved && membership?.status !== "ACTIVE") {
      return {
        outcome: "DIGEST_MEMBERSHIP_UNAVAILABLE",
        fields: {
          status: "FAILED",
          "email.state": delivery.kind === WEEKLY_KIND ? "DISABLED" : "FAILED",
          "email.lastError":
            "Recipient no longer has an active firm membership",
          "email.claimToken": null,
          "email.claimedAt": null,
          "inApp.state": "HIDDEN",
          "inApp.availableAt": null,
          "inApp.readAt": null,
        },
      };
    }
    return null;
  }

  const recipientPolicy = digestRecipientPolicy({
    firm,
    recipientUserId: delivery.recipientUserId,
    membership,
  });
  const personalRecipientMismatch =
    firm.kind === "PERSONAL" &&
    !sameObjectId(firm.ownerUserId, delivery.recipientUserId);
  if (
    firm.kind === "PERSONAL" &&
    (personalRecipientMismatch ||
      (membershipResolved && !recipientPolicy.allowed))
  ) {
    return {
      outcome: recipientPolicy.outcome,
      fields: {
        status: "FAILED",
        "email.state": "DISABLED",
        "email.lastError": recipientPolicy.lastError,
        "email.claimToken": null,
        "email.claimedAt": null,
        "inApp.state": "HIDDEN",
        "inApp.availableAt": null,
        "inApp.readAt": null,
      },
    };
  }

  const hasActiveMembership = membershipResolved && recipientPolicy.allowed;
  if (recipientResolved && !recipient) {
    const fields = {
      status: "FAILED",
      "email.state": "FAILED",
      "email.lastError": "Recipient is inactive or unavailable",
      "email.claimToken": null,
      "email.claimedAt": null,
    };
    if (
      !hasActiveMembership ||
      delivery.kind === WEEKLY_KIND ||
      firm.kind === "PERSONAL"
    ) {
      Object.assign(fields, {
        "inApp.state": "HIDDEN",
        "inApp.availableAt": null,
        "inApp.readAt": null,
      });
    }
    return { outcome: "DIGEST_RECIPIENT_UNAVAILABLE", fields };
  }

  const weeklyAuthorityResolved = recipientResolved && membershipResolved;
  const weeklyAuthority =
    delivery.kind !== WEEKLY_KIND ||
    !weeklyAuthorityResolved ||
    hasWeeklyDigestAuthority({ membership, user: recipient });
  if (
    (membershipResolved && !hasActiveMembership) ||
    (weeklyAuthorityResolved && !weeklyAuthority)
  ) {
    const missingMembership = membershipResolved && !hasActiveMembership;
    const fields = {
      status: "FAILED",
      "email.state": delivery.kind === WEEKLY_KIND ? "DISABLED" : "FAILED",
      "email.lastError": missingMembership
        ? "Recipient no longer has an active firm membership"
        : "Recipient no longer has weekly digest authority",
      "email.claimToken": null,
      "email.claimedAt": null,
    };
    if (missingMembership || delivery.kind === WEEKLY_KIND) {
      Object.assign(fields, {
        "inApp.state": "HIDDEN",
        "inApp.availableAt": null,
        "inApp.readAt": null,
      });
    }
    return {
      outcome: missingMembership
        ? "DIGEST_MEMBERSHIP_UNAVAILABLE"
        : "DIGEST_WEEKLY_AUTHORITY_REVOKED",
      fields,
    };
  }
  return null;
}

export async function processDigestDeliveryJob(
  job,
  {
    assertLease,
    DigestDelivery: DigestDeliveryModel = DigestDelivery,
    Firm: FirmModel = Firm,
    User: UserModel = User,
    FirmMembership: FirmMembershipModel = FirmMembership,
    AppConfig: AppConfigModel = AppConfig,
    sendDigestEmail: sendDigestEmailProvider = sendDigestEmail,
    safeRecordActivity: recordActivity = safeRecordActivity,
    beforeProviderAuthorityReload = null,
    clock = () => new Date(),
  } = {},
) {
  const currentTime = () => {
    const value = typeof clock === "function" ? clock() : clock?.now?.();
    const instant = new Date(value instanceof Date ? value.getTime() : value);
    if (Number.isNaN(instant.getTime())) {
      throw new Error("Digest clock returned an invalid time");
    }
    return instant;
  };
  const deliveryId = canonicalObjectId(job?.payload?.deliveryId);
  if (!deliveryId) {
    throw new Error("Digest job payload is missing a valid deliveryId");
  }
  const jobId = canonicalObjectId(job?._id);
  if (!jobId) {
    throw new Error("Digest job is missing a valid authoritative job id");
  }
  const firmId = canonicalObjectId(job?.firmId);
  if (!firmId) {
    throw new Error("Digest job is missing a valid firm id");
  }

  const claimAttemptedAt = currentTime();
  const claim = await claimDigestDelivery({
    deliveryId,
    firmId,
    automationJobId: jobId,
    now: claimAttemptedAt,
    deliveryModel: DigestDeliveryModel,
  });
  if (!claim) {
    const existing = await DigestDeliveryModel.findOne(
      strictObjectIdFilter({ _id: deliveryId, firmId }),
    )
      .select("automationJobId email.state email.claimedAt")
      .lean();
    if (!existing) return { outcome: "DIGEST_DELIVERY_MISSING" };
    if (!existing.automationJobId) {
      return {
        outcome: "DIGEST_JOB_AUTHORITY_PENDING",
        deliveryId,
        defer: true,
        reason: "Digest job authority is still being linked",
        retryAfterMs: DIGEST_AUTHORITY_DEFER_MS,
      };
    }
    if (!sameObjectId(existing.automationJobId, job._id)) {
      return { outcome: "DIGEST_JOB_SUPERSEDED", deliveryId };
    }
    if (existing.email?.state === "SENT") {
      return { outcome: "DIGEST_ALREADY_SENT", deliveryId };
    }
    if (existing.email?.state === "SENDING") {
      const claimedAtMs = existing.email?.claimedAt
        ? new Date(existing.email.claimedAt).getTime()
        : Number.NaN;
      const remainingMs = Number.isFinite(claimedAtMs)
        ? claimedAtMs + SEND_CLAIM_STALE_MS - claimAttemptedAt.getTime()
        : SEND_CLAIM_STALE_MS;
      return {
        outcome: "DIGEST_SEND_IN_PROGRESS",
        deliveryId,
        defer: true,
        reason: "Another worker owns the digest send claim",
        retryAfterMs: Math.min(
          SEND_CLAIM_STALE_MS,
          Math.max(30 * 1000, remainingMs + 1),
        ),
      };
    }
    if (existing.email?.state === "PENDING") {
      return {
        outcome: "DIGEST_SEND_RETRYABLE_RACE",
        deliveryId,
        defer: true,
        reason: "Digest send state changed while another worker held the claim",
        retryAfterMs: 30 * 1000,
      };
    }
    return { outcome: "DIGEST_EMAIL_NOT_PENDING", deliveryId };
  }

  const { delivery, claimToken } = claim;
  const rawAttempts = delivery.email?.attempts;
  const baseClaimFilter = combineQueryFilters(
    strictObjectIdFilter({
      _id: delivery._id,
      firmId: delivery.firmId,
      automationJobId: jobId,
    }),
    snapshotFilter({
      "email.claimToken": claimToken,
      "email.state": "SENDING",
    }),
  );
  let attempts = nonnegativeSafeInteger(rawAttempts);
  if (rawAttempts === undefined) {
    const normalized = await DigestDeliveryModel.updateOne(
      combineQueryFilters(baseClaimFilter, {
        "email.attempts": { $exists: false },
      }),
      { $set: { "email.attempts": 0 } },
    );
    if (!updateProvesMatch(normalized)) {
      return digestClaimLostResult(deliveryId);
    }
    attempts = 0;
  }
  if (attempts === null || attempts === Number.MAX_SAFE_INTEGER) {
    const quarantined = await DigestDeliveryModel.updateOne(
      combineQueryFilters(
        baseClaimFilter,
        snapshotFilter({ "email.attempts": rawAttempts }),
      ),
      {
        $set: digestTerminalQuarantineFields(
          "Digest email attempts is invalid",
        ),
      },
    );
    if (!updateProvesMatch(quarantined)) {
      return digestClaimLostResult(deliveryId);
    }
    return { outcome: "DIGEST_DELIVERY_QUARANTINED", deliveryId };
  }
  const claimFilter = combineQueryFilters(
    baseClaimFilter,
    snapshotFilter({ "email.attempts": attempts }),
  );
  let authorityConfirmed = false;
  let sendAttemptStarted = false;
  let providerAccepted = false;

  try {
    const featureFlag =
      delivery.kind === DAILY_KIND ? "dailyDigest" : "weeklySummary";
    const [enabledResult, activeFirmResult, recipientResult, membershipResult] =
      await Promise.allSettled([
        AppConfigModel.isFeatureEnabled(featureFlag, { fresh: true }),
        FirmModel.findOne(
          combineQueryFilters(strictObjectIdFilter({ _id: delivery.firmId }), {
            isActive: true,
          }),
        )
          .select("_id kind ownerUserId")
          .lean(),
        UserModel.findOne(
          combineQueryFilters(
            strictObjectIdFilter({ _id: delivery.recipientUserId }),
            { isActive: true },
          ),
        )
          .select("email role digestPreferences")
          .lean(),
        FirmMembershipModel.findOne(
          combineQueryFilters(
            strictObjectIdFilter({
              firmId: delivery.firmId,
              userId: delivery.recipientUserId,
            }),
            { status: "ACTIVE" },
          ),
        )
          .select("role status")
          .lean(),
      ]);

    if (activeFirmResult.status === "fulfilled" && !activeFirmResult.value) {
      const firmWrite = await DigestDeliveryModel.updateOne(claimFilter, {
        $set: {
          status: "FAILED",
          "email.state": "FAILED",
          "email.lastError": "Firm is inactive or unavailable",
          "email.claimToken": null,
          "email.claimedAt": null,
          "inApp.state": "HIDDEN",
          "inApp.availableAt": null,
          "inApp.readAt": null,
        },
      });
      if (!updateProvesMatch(firmWrite)) {
        return digestClaimLostResult(deliveryId);
      }
      return { outcome: "DIGEST_FIRM_UNAVAILABLE", deliveryId };
    }
    if (activeFirmResult.status === "rejected") {
      throw activeFirmResult.reason;
    }
    const companionFailure = [
      enabledResult,
      recipientResult,
      membershipResult,
    ].find((result) => result.status === "rejected");
    if (companionFailure) throw companionFailure.reason;

    const enabled = enabledResult.value;
    const activeFirm = activeFirmResult.value;
    const recipient = recipientResult.value;
    const membership = membershipResult.value;
    const recipientPolicy = digestRecipientPolicy({
      firm: activeFirm,
      recipientUserId: delivery.recipientUserId,
      membership,
    });
    if (activeFirm.kind === "PERSONAL" && !recipientPolicy.allowed) {
      const policyWrite = await DigestDeliveryModel.updateOne(claimFilter, {
        $set: {
          status: "FAILED",
          "email.state": "DISABLED",
          "email.lastError": recipientPolicy.lastError,
          "email.claimToken": null,
          "email.claimedAt": null,
          "inApp.state": "HIDDEN",
          "inApp.availableAt": null,
          "inApp.readAt": null,
        },
      });
      if (!updateProvesMatch(policyWrite)) {
        return digestClaimLostResult(deliveryId);
      }
      return { outcome: recipientPolicy.outcome, deliveryId };
    }

    const hasActiveMembership = recipientPolicy.allowed;

    if (!recipient) {
      const recipientUnavailable = {
        status: "FAILED",
        "email.state": "FAILED",
        "email.lastError": "Recipient is inactive or unavailable",
        "email.claimToken": null,
        "email.claimedAt": null,
      };
      if (
        !hasActiveMembership ||
        delivery.kind === WEEKLY_KIND ||
        activeFirm.kind === "PERSONAL"
      ) {
        Object.assign(recipientUnavailable, {
          "inApp.state": "HIDDEN",
          "inApp.availableAt": null,
          "inApp.readAt": null,
        });
      }
      const recipientWrite = await DigestDeliveryModel.updateOne(claimFilter, {
        $set: recipientUnavailable,
      });
      if (!updateProvesMatch(recipientWrite)) {
        return digestClaimLostResult(deliveryId);
      }
      return { outcome: "DIGEST_RECIPIENT_UNAVAILABLE", deliveryId };
    }

    const weeklyAuthority =
      delivery.kind !== WEEKLY_KIND ||
      hasWeeklyDigestAuthority({ membership, user: recipient });
    if (!hasActiveMembership || !weeklyAuthority) {
      const missingMembership = !hasActiveMembership;
      const authorityUnavailable = {
        status: "FAILED",
        "email.state": delivery.kind === WEEKLY_KIND ? "DISABLED" : "FAILED",
        "email.lastError": missingMembership
          ? "Recipient no longer has an active firm membership"
          : "Recipient no longer has weekly digest authority",
        "email.claimToken": null,
        "email.claimedAt": null,
      };
      if (missingMembership || delivery.kind === WEEKLY_KIND) {
        Object.assign(authorityUnavailable, {
          "inApp.state": "HIDDEN",
          "inApp.availableAt": null,
          "inApp.readAt": null,
        });
      }
      const authorityWrite = await DigestDeliveryModel.updateOne(claimFilter, {
        $set: authorityUnavailable,
      });
      if (!updateProvesMatch(authorityWrite)) {
        return digestClaimLostResult(deliveryId);
      }
      return {
        outcome: missingMembership
          ? "DIGEST_MEMBERSHIP_UNAVAILABLE"
          : "DIGEST_WEEKLY_AUTHORITY_REVOKED",
        deliveryId,
      };
    }
    authorityConfirmed = true;

    if (!enabled) {
      const rolloutWrite = await DigestDeliveryModel.updateOne(claimFilter, {
        $set: {
          status: "PARTIAL",
          "email.state": "ROLLOUT_BLOCKED",
          "email.lastError": "Feature rollout disabled before email delivery",
          "email.claimToken": null,
          "email.claimedAt": null,
          ...inAppAvailabilityFields(delivery, currentTime()),
        },
      });
      if (!updateProvesMatch(rolloutWrite)) {
        return digestClaimLostResult(deliveryId);
      }
      return { outcome: "DIGEST_ROLLOUT_BLOCKED", deliveryId };
    }

    // Re-check the recipient's CURRENT preferences at send time, not just the
    // ones captured when the delivery was queued. A recipient who switches the
    // daily cadence to OFF, unsubscribes from the weekly summary, or turns off
    // email copies must not receive an email from a job queued earlier.
    const suppression = digestEmailSuppressionReason(delivery.kind, recipient);
    if (suppression) {
      const subscribedToKind = suppression === "EMAIL_DISABLED";
      const suppressionWrite = await DigestDeliveryModel.updateOne(
        claimFilter,
        {
          $set: {
            status: "DELIVERED",
            "email.state": "DISABLED",
            "email.lastError": "",
            "email.claimToken": null,
            "email.claimedAt": null,
            ...inAppAvailabilityFields(delivery, currentTime()),
          },
        },
      );
      if (!updateProvesMatch(suppressionWrite)) {
        return digestClaimLostResult(deliveryId);
      }
      return {
        outcome: subscribedToKind
          ? "DIGEST_EMAIL_DISABLED_IN_APP_AVAILABLE"
          : "DIGEST_UNSUBSCRIBED_IN_APP_AVAILABLE",
        deliveryId,
      };
    }

    const copy = digestCopy(delivery.kind, delivery.periodKey);
    const finalRolloutEnabled = await AppConfigModel.isFeatureEnabled(
      featureFlag,
      { fresh: true },
    );
    if (!finalRolloutEnabled) {
      const rolloutWrite = await DigestDeliveryModel.updateOne(claimFilter, {
        $set: {
          status: "PARTIAL",
          "email.state": "ROLLOUT_BLOCKED",
          "email.lastError": "Feature rollout disabled before email delivery",
          "email.claimToken": null,
          "email.claimedAt": null,
          ...inAppAvailabilityFields(delivery, currentTime()),
        },
      });
      if (!updateProvesMatch(rolloutWrite)) {
        return digestClaimLostResult(deliveryId);
      }
      return { outcome: "DIGEST_ROLLOUT_BLOCKED", deliveryId };
    }

    if (assertLease) await assertLease();
    if (typeof beforeProviderAuthorityReload === "function") {
      await beforeProviderAuthorityReload({ delivery, job });
    }
    const [finalFirmResult, finalRecipientResult, finalMembershipResult] =
      await Promise.allSettled([
        FirmModel.findOne(
          combineQueryFilters(strictObjectIdFilter({ _id: delivery.firmId }), {
            isActive: true,
          }),
        )
          .select("_id kind ownerUserId")
          .lean(),
        UserModel.findOne(
          combineQueryFilters(
            strictObjectIdFilter({ _id: delivery.recipientUserId }),
            { isActive: true },
          ),
        )
          .select("email role digestPreferences")
          .lean(),
        FirmMembershipModel.findOne(
          combineQueryFilters(
            strictObjectIdFilter({
              firmId: delivery.firmId,
              userId: delivery.recipientUserId,
            }),
            { status: "ACTIVE" },
          ),
        )
          .select("role status")
          .lean(),
      ]);
    const finalFirm =
      finalFirmResult.status === "fulfilled"
        ? finalFirmResult.value
        : undefined;
    const finalRecipient =
      finalRecipientResult.status === "fulfilled"
        ? finalRecipientResult.value
        : undefined;
    const finalMembership =
      finalMembershipResult.status === "fulfilled"
        ? finalMembershipResult.value
        : undefined;
    const finalAuthorityFailure = digestAuthorityFailure({
      delivery,
      firm: finalFirm,
      recipient: finalRecipient,
      membership: finalMembership,
      resolved: {
        firm: finalFirmResult.status === "fulfilled",
        recipient: finalRecipientResult.status === "fulfilled",
        membership: finalMembershipResult.status === "fulfilled",
      },
    });
    if (finalAuthorityFailure) {
      const finalAuthorityWrite = await DigestDeliveryModel.updateOne(
        claimFilter,
        { $set: finalAuthorityFailure.fields },
      );
      if (!updateProvesMatch(finalAuthorityWrite)) {
        return digestClaimLostResult(deliveryId);
      }
      return { outcome: finalAuthorityFailure.outcome, deliveryId };
    }
    const finalLookupFailure = [
      finalFirmResult,
      finalRecipientResult,
      finalMembershipResult,
    ].find((result) => result.status === "rejected");
    if (finalLookupFailure) throw finalLookupFailure.reason;

    const finalSuppression = digestEmailSuppressionReason(
      delivery.kind,
      finalRecipient,
    );
    if (finalSuppression) {
      const subscribedToKind = finalSuppression === "EMAIL_DISABLED";
      const finalSuppressionWrite = await DigestDeliveryModel.updateOne(
        claimFilter,
        {
          $set: {
            status: "DELIVERED",
            "email.state": "DISABLED",
            "email.lastError": "",
            "email.claimToken": null,
            "email.claimedAt": null,
            ...inAppAvailabilityFields(delivery, currentTime()),
          },
        },
      );
      if (!updateProvesMatch(finalSuppressionWrite)) {
        return digestClaimLostResult(deliveryId);
      }
      return {
        outcome: subscribedToKind
          ? "DIGEST_EMAIL_DISABLED_IN_APP_AVAILABLE"
          : "DIGEST_UNSUBSCRIBED_IN_APP_AVAILABLE",
        deliveryId,
      };
    }

    sendAttemptStarted = true;
    const response = await sendDigestEmailProvider({
      toEmail: finalRecipient.email,
      subject: delivery.subject,
      heading: copy.heading,
      periodLabel: copy.periodLabel,
      lines: summaryLines(delivery.summary),
      idempotencyKey:
        delivery.email?.idempotencyKey || `digest-delivery:${delivery._id}`,
      ...buildDigestUnsubscribeLinks({
        recipientUserId: delivery.recipientUserId,
        kind: delivery.kind,
      }),
    });
    providerAccepted = true;
    const updated = await DigestDeliveryModel.updateOne(claimFilter, {
      $set: {
        status: "DELIVERED",
        "email.state": "SENT",
        "email.providerMessageId": String(
          response?.data?.id || response?.id || "",
        ).slice(0, 240),
        "email.lastError": "",
        "email.sentAt": currentTime(),
        "email.claimToken": null,
        "email.claimedAt": null,
        "email.attempts": attempts + 1,
      },
    });
    if (!updateProvesMatch(updated)) {
      const persisted = await DigestDeliveryModel.findOne(
        strictObjectIdFilter({ _id: deliveryId, firmId }),
      )
        .select("email.state")
        .lean();
      if (persisted?.email?.state === "SENT") {
        return { outcome: "DIGEST_ALREADY_SENT", deliveryId };
      }
      return digestClaimLostResult(deliveryId);
    }

    await recordActivity({
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
      outcome: "DIGEST_EMAIL_SENT",
      deliveryId,
    };
  } catch (error) {
    if (providerAccepted) {
      // Provider acceptance is irreversible. Reclassifying a later persistence
      // error as an ordinary send failure could trigger a duplicate email.
      throw error;
    }
    const failureFields = {
      status: "PARTIAL",
      "email.state": "FAILED",
      "email.lastError": safeError(error),
      "email.claimToken": null,
      "email.claimedAt": null,
    };
    if (authorityConfirmed) {
      Object.assign(
        failureFields,
        inAppAvailabilityFields(delivery, currentTime()),
      );
    }
    if (sendAttemptStarted) {
      failureFields["email.attempts"] = attempts + 1;
    }
    const failureUpdate = { $set: failureFields };
    const failed = await DigestDeliveryModel.updateOne(
      claimFilter,
      failureUpdate,
    );
    if (!updateProvesMatch(failed)) {
      return digestClaimLostResult(deliveryId);
    }
    if (authorityConfirmed) {
      await recordActivity({
        firmId: delivery.firmId,
        actorUserId: delivery.recipientUserId,
        source: "AUTOMATION",
        action: "DIGEST_EMAIL_FAILED_IN_APP_AVAILABLE",
        entityType: "DigestDelivery",
        entityId: delivery._id,
        requestId: job.requestId,
        metadata: { kind: delivery.kind, periodKey: delivery.periodKey },
      });
    }
    throw error;
  }
}

export async function getDigestPreferences(
  { userId, firmId },
  {
    AppConfig: AppConfigModel = AppConfig,
    Firm: FirmModel = Firm,
    FirmMembership: FirmMembershipModel = FirmMembership,
    User: UserModel = User,
    requireActiveDigestAccess:
      requireActiveDigestAccessProvider = requireActiveDigestAccess,
  } = {},
) {
  const { firm, user } = await requireActiveDigestAccessProvider(
    { userId, firmId },
    {
      Firm: FirmModel,
      FirmMembership: FirmMembershipModel,
      User: UserModel,
    },
  );
  const flags = await AppConfigModel.getFeatureFlags();
  if (!firm) {
    throw new DigestError(
      "User or firm is unavailable",
      404,
      "DIGEST_SCOPE_NOT_FOUND",
    );
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

export async function updateDigestPreferences(
  { userId, firmId, input, requestId = "" },
  {
    Firm: FirmModel = Firm,
    FirmMembership: FirmMembershipModel = FirmMembership,
    User: UserModel = User,
    requireActiveDigestAccess:
      requireActiveDigestAccessProvider = requireActiveDigestAccess,
    safeRecordActivity: recordActivity = safeRecordActivity,
  } = {},
) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new DigestError("Digest preferences object is required");
  }
  const allowed = [
    "dailyFrequency",
    "dailyEnabled",
    "weeklyEnabled",
    "emailEnabled",
  ];
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new DigestError(
      `Unsupported digest preferences: ${unknown.join(", ")}`,
    );
  }
  const update = {};
  // Daily cadence: dailyFrequency is authoritative. Keep the legacy
  // dailyEnabled flag in sync so older clients keep working.
  if (Object.prototype.hasOwnProperty.call(input, "dailyFrequency")) {
    const freq = String(input.dailyFrequency || "");
    if (!DAILY_FREQUENCIES.has(freq)) {
      throw new DigestError(
        "dailyFrequency must be one of DAILY, EVERY_3_DAYS, WEEKLY, OFF",
      );
    }
    update["digestPreferences.dailyFrequency"] = freq;
    update["digestPreferences.dailyEnabled"] = freq !== "OFF";
  } else if (Object.prototype.hasOwnProperty.call(input, "dailyEnabled")) {
    if (typeof input.dailyEnabled !== "boolean") {
      throw new DigestError("dailyEnabled must be boolean");
    }
    update["digestPreferences.dailyEnabled"] = input.dailyEnabled;
    update["digestPreferences.dailyFrequency"] = input.dailyEnabled
      ? "DAILY"
      : "OFF";
  }
  for (const key of ["weeklyEnabled", "emailEnabled"]) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    if (typeof input[key] !== "boolean") {
      throw new DigestError(`${key} must be boolean`);
    }
    update[`digestPreferences.${key}`] = input[key];
  }
  if (!Object.keys(update).length) {
    throw new DigestError("No digest preferences to update");
  }
  const { user: before } = await requireActiveDigestAccessProvider(
    { userId, firmId },
    {
      Firm: FirmModel,
      FirmMembership: FirmMembershipModel,
      User: UserModel,
    },
  );
  const user = await UserModel.findOneAndUpdate(
    combineQueryFilters(strictObjectIdFilter({ _id: userId }), {
      isActive: true,
    }),
    { $set: update },
    { new: true, runValidators: true },
  )
    .select("digestPreferences")
    .lean();
  if (!user) {
    throw new DigestError("User is unavailable", 404, "DIGEST_USER_NOT_FOUND");
  }
  await recordActivity({
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

export async function updateFirmDigestSettings(
  { userId, firmId, input, requestId = "" },
  {
    Firm: FirmModel = Firm,
    FirmMembership: FirmMembershipModel = FirmMembership,
    User: UserModel = User,
    safeRecordActivity: recordActivity = safeRecordActivity,
    runSettingsTransaction:
      runSettingsTransactionProvider = defaultRunSettingsTransaction,
    beforeSettingsWrite = null,
  } = {},
) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new DigestError("Firm digest settings object is required");
  }
  const allowed = ["timezone", "dailyHour", "weeklyDay", "weeklyHour"];
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new DigestError(
      `Unsupported firm digest settings: ${unknown.join(", ")}`,
    );
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

  const canonicalUserId = requireCanonicalObjectId(userId, "userId");
  const canonicalFirmId = requireCanonicalObjectId(firmId, "firmId");
  const transactionResult = await runSettingsTransactionProvider(
    async (session) => {
      if (!session) {
        throw new TypeError("Digest settings transaction requires a session");
      }
      const currentUser = await withDigestRecoverySession(
        UserModel.findOne(
          combineQueryFilters(strictObjectIdFilter({ _id: canonicalUserId }), {
            isActive: true,
          }),
        ),
        session,
      )
        .select("_id isActive __v")
        .lean();
      const membership = await withDigestRecoverySession(
        FirmMembershipModel.findOne(
          combineQueryFilters(
            strictObjectIdFilter({
              firmId: canonicalFirmId,
              userId: canonicalUserId,
            }),
            { status: "ACTIVE" },
          ),
        ),
        session,
      )
        .select("role status __v")
        .lean();
      const before = await withDigestRecoverySession(
        FirmModel.findOne(
          combineQueryFilters(strictObjectIdFilter({ _id: canonicalFirmId }), {
            isActive: true,
          }),
        ),
        session,
      )
        .select("timezone digestSettings kind ownerUserId __v")
        .lean();

      const activeAdminMembership =
        membership?.status === "ACTIVE" &&
        ["OWNER", "ADMIN"].includes(membership.role);
      if (!currentUser || !activeAdminMembership) {
        throw new DigestError(
          "Firm digest settings are firm-admin only",
          403,
          "FIRM_ADMIN_ONLY",
        );
      }
      if (!before) {
        throw new DigestError(
          "Firm is unavailable",
          404,
          "DIGEST_FIRM_NOT_FOUND",
        );
      }
      const businessAuthority = before.kind !== "PERSONAL";
      const personalAuthority =
        before.kind === "PERSONAL" &&
        sameObjectId(before.ownerUserId, canonicalUserId) &&
        membership.role === "OWNER";
      if (!businessAuthority && !personalAuthority) {
        throw new DigestError(
          "Firm digest settings are firm-admin only",
          403,
          "FIRM_ADMIN_ONLY",
        );
      }

      const userVersion = nonnegativeSafeInteger(currentUser.__v);
      const membershipVersion = nonnegativeSafeInteger(membership.__v);
      const firmVersion = nonnegativeSafeInteger(before.__v);
      if (
        [userVersion, membershipVersion, firmVersion].some(
          (version) => version === null || version === Number.MAX_SAFE_INTEGER,
        )
      ) {
        throw new DigestError(
          "Digest settings changed before the update could be applied",
          409,
          "DIGEST_SETTINGS_CONFLICT",
        );
      }

      if (typeof beforeSettingsWrite === "function") {
        await beforeSettingsWrite({
          session,
          user: currentUser,
          membership,
          firm: before,
          update,
        });
      }

      const userFence = await UserModel.updateOne(
        combineQueryFilters(
          strictObjectIdFilter({ _id: canonicalUserId }),
          { isActive: true },
          snapshotFilter({ __v: userVersion }),
        ),
        { $inc: { __v: 1 } },
        { session, timestamps: false },
      );
      if (!updateProvesMatch(userFence)) {
        throw new DigestError(
          "Digest settings changed before the update could be applied",
          409,
          "DIGEST_SETTINGS_CONFLICT",
        );
      }

      const membershipFence = await FirmMembershipModel.updateOne(
        combineQueryFilters(
          strictObjectIdFilter({
            firmId: canonicalFirmId,
            userId: canonicalUserId,
          }),
          snapshotFilter({
            status: "ACTIVE",
            role: membership.role,
            __v: membershipVersion,
          }),
          personalAuthority
            ? { role: "OWNER" }
            : { role: { $in: ["OWNER", "ADMIN"] } },
        ),
        { $inc: { __v: 1 } },
        { session, timestamps: false },
      );
      if (!updateProvesMatch(membershipFence)) {
        throw new DigestError(
          "Digest settings changed before the update could be applied",
          409,
          "DIGEST_SETTINGS_CONFLICT",
        );
      }

      const firmFence = [
        strictObjectIdFilter({ _id: canonicalFirmId }),
        { isActive: true },
        snapshotFilter({ kind: before.kind, __v: firmVersion }),
      ];
      if (personalAuthority) {
        firmFence.push(strictObjectIdFilter({ ownerUserId: canonicalUserId }));
      }
      const firm = await FirmModel.findOneAndUpdate(
        combineQueryFilters(...firmFence),
        { $set: update, $inc: { __v: 1 } },
        { new: true, runValidators: true, session },
      )
        .select("timezone digestSettings")
        .lean();
      if (!firm) {
        throw new DigestError(
          "Digest settings changed before the update could be applied",
          409,
          "DIGEST_SETTINGS_CONFLICT",
        );
      }
      const beforeSummary = {
        _id: before._id,
        timezone: before.timezone,
        digestSettings: before.digestSettings,
      };
      return { before: beforeSummary, firm };
    },
  );

  await recordActivity({
    firmId,
    actorUserId: userId,
    source: "USER",
    action: "FIRM_DIGEST_SETTINGS_UPDATED",
    entityType: "Firm",
    entityId: firmId,
    beforeSummary: transactionResult.before,
    afterSummary: transactionResult.firm,
    requestId,
  });
  return transactionResult.firm;
}

export async function previewDigest(
  {
    userId,
    firmId,
    role,
    kind,
    dailyEnabled,
    weeklyEnabled,
    noticeCasesEnabled,
    now = new Date(),
  },
  {
    Firm: FirmModel = Firm,
    FirmMembership: FirmMembershipModel = FirmMembership,
    User: UserModel = User,
    requireActiveDigestAccess:
      requireActiveDigestAccessProvider = requireActiveDigestAccess,
    buildDigestSummary: buildDigestSummaryProvider = buildDigestSummary,
  } = {},
) {
  if (!DIGEST_KINDS.has(kind)) throw new DigestError("Digest kind is invalid");
  const { firm, weeklyAuthorized } = await requireActiveDigestAccessProvider(
    { userId, firmId },
    {
      Firm: FirmModel,
      FirmMembership: FirmMembershipModel,
      User: UserModel,
    },
  );
  if (kind === DAILY_KIND && !dailyEnabled) {
    throw new DigestError(
      "Daily digest is unavailable",
      404,
      "DAILY_DIGEST_DISABLED",
    );
  }
  if (kind === WEEKLY_KIND && !weeklyEnabled) {
    throw new DigestError(
      "Weekly summary is unavailable",
      404,
      "WEEKLY_SUMMARY_DISABLED",
    );
  }
  if (kind === WEEKLY_KIND && !weeklyAuthorized) {
    throw new DigestError(
      "Weekly firm summary is firm-admin only",
      403,
      "FIRM_ADMIN_ONLY",
    );
  }
  if (!firm) throw new DigestError("Firm is unavailable", 404);
  const timezone = validTimezone(firm.timezone)
    ? firm.timezone
    : "Asia/Kolkata";
  const parts = zonedParts(now, timezone);
  const periodKey = kind === DAILY_KIND ? parts.dateKey : weekStartKey(parts);
  return buildDigestSummaryProvider({
    firmId,
    userId,
    kind,
    periodKey,
    timezone,
    noticeCasesEnabled,
    now,
  });
}

async function freshDigestFeatureState(AppConfigModel, flagName) {
  if (typeof AppConfigModel.getFeatureFlagState === "function") {
    const state = await AppConfigModel.getFeatureFlagState(flagName, {
      fresh: true,
    });
    return {
      enabled: state?.enabled === true,
      version: Number.isSafeInteger(state?.version) ? state.version : 0,
      publicationFence:
        typeof state?.publicationFence === "string"
          ? state.publicationFence
          : "",
    };
  }
  return {
    enabled:
      (await AppConfigModel.isFeatureEnabled(flagName, { fresh: true })) ===
      true,
    version: null,
    publicationFence: null,
  };
}

function sameDigestFeatureState(left, right) {
  return (
    left.enabled === right.enabled &&
    left.version === right.version &&
    left.publicationFence === right.publicationFence
  );
}

// Super-admin diagnostic: compute the current digest live and email it once to
// the requester, WITHOUT creating/altering any DigestDelivery (so it never
// interferes with the real per-week dedup). Used to verify digest email
// delivery on demand. Feature flags are read fresh here.
export async function sendTestDigestNow(
  { userId, firmId, role, toEmail, kind = WEEKLY_KIND, now = new Date() },
  {
    AppConfig: AppConfigModel = AppConfig,
    Firm: FirmModel = Firm,
    FirmMembership: FirmMembershipModel = FirmMembership,
    User: UserModel = User,
    previewDigest: previewDigestProvider = previewDigest,
    requireActiveDigestAccess:
      requireActiveDigestAccessProvider = requireActiveDigestAccess,
    sendDigestEmail: sendDigestEmailProvider = sendDigestEmail,
    beforeProviderAuthorityReload = null,
  } = {},
) {
  if (role !== "SUPER_ADMIN") {
    throw new DigestError("Super admin only", 403, "SUPER_ADMIN_ONLY");
  }
  if (!toEmail) throw new DigestError("A recipient email is required", 400);
  const [dailyState, weeklyState, noticeCasesState] = await Promise.all([
    freshDigestFeatureState(AppConfigModel, "dailyDigest"),
    freshDigestFeatureState(AppConfigModel, "weeklySummary"),
    freshDigestFeatureState(AppConfigModel, "noticeCases"),
  ]);
  const summary = await previewDigestProvider(
    {
      userId,
      firmId,
      role,
      kind,
      dailyEnabled: dailyState.enabled,
      weeklyEnabled: weeklyState.enabled,
      noticeCasesEnabled: noticeCasesState.enabled,
      now,
    },
    {
      Firm: FirmModel,
      FirmMembership: FirmMembershipModel,
      User: UserModel,
      requireActiveDigestAccess: requireActiveDigestAccessProvider,
    },
  );
  const copy = digestCopy(summary.kind, summary.periodKey);
  if (typeof beforeProviderAuthorityReload === "function") {
    await beforeProviderAuthorityReload({ summary, userId, firmId });
  }
  const featureFlag =
    summary.kind === DAILY_KIND ? "dailyDigest" : "weeklySummary";
  const featureState = await freshDigestFeatureState(
    AppConfigModel,
    featureFlag,
  );
  const finalNoticeCasesState = await freshDigestFeatureState(
    AppConfigModel,
    "noticeCases",
  );
  if (!sameDigestFeatureState(finalNoticeCasesState, noticeCasesState)) {
    throw new DigestError(
      "Digest inputs changed after preview; preview the current digest again",
      409,
      "DIGEST_PREVIEW_STALE",
    );
  }
  // These rollout gates are boolean-only in AppConfig. The final enabled value
  // is authoritative; same-enabled republishes intentionally remain sendable.
  if (!featureState.enabled) {
    if (summary.kind === DAILY_KIND) {
      throw new DigestError(
        "Daily digest is unavailable",
        404,
        "DAILY_DIGEST_DISABLED",
      );
    }
    throw new DigestError(
      "Weekly summary is unavailable",
      404,
      "WEEKLY_SUMMARY_DISABLED",
    );
  }

  // Keep authority, preferences, and destination as the final awaited boundary
  // so a revocation during either feature read cannot reach the provider.
  const { user, weeklyAuthorized } = await requireActiveDigestAccessProvider(
    { userId, firmId },
    {
      Firm: FirmModel,
      FirmMembership: FirmMembershipModel,
      User: UserModel,
    },
  );
  if (user.role !== "SUPER_ADMIN") {
    throw new DigestError("Super admin only", 403, "SUPER_ADMIN_ONLY");
  }
  if (summary.kind === WEEKLY_KIND && !weeklyAuthorized) {
    throw new DigestError(
      "Weekly firm summary is firm-admin only",
      403,
      "FIRM_ADMIN_ONLY",
    );
  }
  const suppression = digestEmailSuppressionReason(summary.kind, user);
  if (suppression) {
    throw new DigestError(
      suppression === "EMAIL_DISABLED"
        ? "Digest email is disabled in current preferences"
        : "Digest is disabled in current preferences",
      409,
      suppression === "EMAIL_DISABLED"
        ? "DIGEST_EMAIL_DISABLED"
        : "DIGEST_UNSUBSCRIBED",
    );
  }

  const normalizedEmail = normalizeDigestEmail(user.email);
  if (!normalizedEmail) {
    throw new DigestError(
      "Current user email is invalid",
      400,
      "DIGEST_EMAIL_INVALID",
    );
  }
  const canonicalFirmId = requireCanonicalObjectId(firmId, "firmId");
  const response = await sendDigestEmailProvider({
    toEmail: normalizedEmail,
    subject: `[Test] ${copy.subject}`,
    heading: copy.heading,
    periodLabel: copy.periodLabel,
    lines: summaryLines(summary),
    idempotencyKey: `test-digest:${canonicalFirmId}:${summary.kind}:${summary.periodKey}:${now.getTime()}`,
    ...buildDigestUnsubscribeLinks({
      recipientUserId: user._id,
      kind: summary.kind,
    }),
  });
  return {
    summary,
    providerMessageId: String(response?.data?.id || response?.id || "").slice(
      0,
      240,
    ),
  };
}

export async function listDigestInbox({ userId, firmId, query = {} }) {
  const { page, limit, skip } = pagination(query);
  const { weeklyAuthorized } = await requireActiveDigestAccess({
    userId,
    firmId,
  });
  const filter = combineQueryFilters(
    strictObjectIdFilter({
      firmId,
      recipientUserId: userId,
    }),
    {
      "inApp.state": { $in: ["AVAILABLE", "READ"] },
      ...(weeklyAuthorized ? {} : { kind: DAILY_KIND }),
    },
  );
  const [total, items] = await Promise.all([
    DigestDelivery.countDocuments(filter),
    DigestDelivery.find(filter)
      .select(
        "kind periodKey timezone subject summary status email inApp createdAt",
      )
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
  const { weeklyAuthorized } = await requireActiveDigestAccess({
    userId,
    firmId,
  });
  const delivery = await DigestDelivery.findOneAndUpdate(
    combineQueryFilters(
      strictObjectIdFilter({
        _id: deliveryId,
        firmId,
        recipientUserId: userId,
      }),
      {
        "inApp.state": { $in: ["AVAILABLE", "READ"] },
        ...(weeklyAuthorized ? {} : { kind: DAILY_KIND }),
      },
    ),
    {
      $set: {
        "inApp.state": "READ",
        "inApp.readAt": new Date(),
      },
    },
    { new: true },
  ).lean();
  if (!delivery) {
    throw new DigestError("Digest not found", 404, "DIGEST_NOT_FOUND");
  }
  return { id: String(delivery._id), inAppState: delivery.inApp.state };
}


/**
 * Marks every digest this caller can see, and has not already read, as read.
 *
 * Two clauses carry the authorization and neither may be simplified away:
 *
 *   - `recipientUserId: userId`. A digest delivery belongs to one recipient. Marking read is
 *     personal, never firm-wide, and dropping this would let one member clear a colleague's inbox.
 *   - the `weeklyAuthorized ? {} : { kind: DAILY_KIND }` narrowing, exactly as markDigestRead
 *     applies it. Without it a member who is not allowed to see the weekly firm digest would
 *     silently mark rows read that they were never shown.
 *
 * Filtered on AVAILABLE only, unlike the single-row path which accepts AVAILABLE or READ. Sweeping
 * rows that are already read would overwrite each one's original readAt with today's date, quietly
 * rewriting when the person actually read it.
 */
export async function markAllDigestsRead({ userId, firmId }) {
  const { weeklyAuthorized } = await requireActiveDigestAccess({
    userId,
    firmId,
  });

  const result = await DigestDelivery.updateMany(
    combineQueryFilters(
      strictObjectIdFilter({ firmId, recipientUserId: userId }),
      {
        "inApp.state": "AVAILABLE",
        ...(weeklyAuthorized ? {} : { kind: DAILY_KIND }),
      },
    ),
    {
      $set: {
        "inApp.state": "READ",
        "inApp.readAt": new Date(),
      },
    },
  );

  // Zero is a success here. An inbox with nothing unread is the state the caller asked for, not a
  // missing record, so this does not throw the 404 the single-row path throws.
  return { updated: Number(result?.modifiedCount || 0) };
}

export {
  DAILY_KIND,
  DIGEST_AUTHORITY_DEFER_MS,
  DIGEST_JOB_KIND,
  DIGEST_JOB_RECOVERY_LEASE_MS,
  DIGEST_RECOVERY_BATCH_SIZE,
  DIGEST_RECOVERY_CURSOR_LEASE_MS,
  DIGEST_RECOVERY_MAX_BATCHES,
  DigestError,
  FIRM_SCAN_BATCH,
  SEND_CLAIM_STALE_MS,
  WEEKLY_KIND,
  applyDigestUnsubscribe,
  buildDigestSummary,
  buildDigestUnsubscribeLinks,
  buildDigestUnsubscribeToken,
  claimDigestDelivery,
  dailyDigestDueForFrequency,
  digestBusinessIdentity,
  digestEmailSuppressionReason,
  digestSendingRecoveryReason,
  digestUnsubscribeTokenMatches,
  effectiveDailyFrequency,
  effectivePreferences,
  enqueueRecipientDigest,
  hasWeeklyDigestAuthority,
  previewDigestUnsubscribe,
  requireActiveDigestAccess,
  summaryLines,
  validTimezone,
  zonedParts,
};
