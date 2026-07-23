import ActivityEvent from "../models/ActivityEvent.js";

const SENSITIVE_KEY = /password|token|secret|authorization|cookie|otp/i;

function sanitizeSummary(value, depth = 0) {
  if (value == null) return value;
  if (depth > 4) return "[truncated]";
  if (typeof value === "string") return value.slice(0, 500);
  if (["number", "boolean"].includes(typeof value)) return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeSummary(item, depth + 1));
  }
  if (typeof value === "object") {
    const output = {};
    for (const [key, item] of Object.entries(value).slice(0, 50)) {
      output[key] = SENSITIVE_KEY.test(key)
        ? "[redacted]"
        : sanitizeSummary(item, depth + 1);
    }
    return output;
  }
  return String(value).slice(0, 500);
}

export async function recordActivity({
  eventId = null,
  firmId,
  actorUserId = null,
  source = "USER",
  action,
  entityType,
  entityId,
  beforeSummary = null,
  afterSummary = null,
  requestId = "",
  batchId = "",
  metadata = {},
  session = null,
}) {
  if ((!firmId && source !== "SUPER_ADMIN") || !action || !entityType || !entityId) {
    throw new Error(
      "Activity event requires tenant firmId (except SUPER_ADMIN), action, entityType, and entityId"
    );
  }

  const event = new ActivityEvent({
    ...(eventId ? { _id: eventId } : {}),
    firmId,
    actorUserId,
    source,
    action,
    entityType,
    entityId: String(entityId),
    beforeSummary: sanitizeSummary(beforeSummary),
    afterSummary: sanitizeSummary(afterSummary),
    requestId: String(requestId || "").slice(0, 160),
    batchId: String(batchId || "").slice(0, 160),
    metadata: sanitizeSummary(metadata),
  });
  return event.save(session ? { session } : undefined);
}

export async function safeRecordActivity(event) {
  try {
    return await recordActivity(event);
  } catch (error) {
    console.error("[ACTIVITY] Failed to persist event:", error.message);
    return null;
  }
}

export { sanitizeSummary };
