import mongoose from "mongoose";

// Privacy rules for this collection, deliberately stricter than the rest of
// the product: authentication events carry NO tokens, NO emails, NO IPs in
// their payloads. The user reference exists because admin analytics is
// already authorized to see account identifiers, and session-duration math
// needs to correlate a sign-in with its ending; everything else is coarse
// category + platform + version so the dashboard can answer "why do sessions
// die" without ever holding a credential.
const AUTH_HEALTH_KINDS = Object.freeze([
  "login_success",
  "login_fail",
  "refresh_success",
  "refresh_fail",
  // A request was refused authentication. `reason` names the middleware's
  // own branch: expired | revoked | invalid | inactive | missing_user |
  // no_credentials. This is a rejection, NOT a logout - the client may
  // recover (refresh) or the user may still be shown as signed in offline.
  "auth_rejection",
  // Client-reported: the user pressed sign out. The only "logout" kind that
  // is definitely user-initiated.
  "signed_out",
  // Client-reported: the session survived a restart (recovered from the
  // persisted copy). The positive signal that the persistence fix works.
  "session_restored",
  // Client-reported: a refresh attempt had to retry (race or network).
  "refresh_retry",
]);

const AUTH_HEALTH_REASONS = Object.freeze([
  "expired",
  "revoked",
  "invalid",
  "inactive",
  "missing_user",
  "no_credentials",
  "network",
  "server_error",
  "rate_limited",
  "conflict",
  // A renewal refused because the sign-in reached SESSION_MAX_AGE_DAYS. The
  // token itself stays valid until its own expiry.
  "max_age",
  "signed_out",
  // Client vocabulary (auth-session-events.controller.js): a session
  // recovered after a browser or app restart, and a refresh that lost a race.
  "restart",
  "race",
  "unknown",
]);

// The client platform an event concerns. `unknown` when the server cannot
// tell - an anonymous or unverifiable request names no client it can trust.
const AUTH_HEALTH_PLATFORMS = Object.freeze([
  "extension",
  "desktop",
  "website",
  "unknown",
]);

// Raw events are analytics, not an audit trail of record: kept long enough
// for the panel's widest window (365 days) plus a margin, then expired by
// MongoDB itself so the collection cannot grow without bound.
const AUTH_HEALTH_RETENTION_SECONDS = 400 * 24 * 60 * 60;

const AuthHealthEventSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    kind: { type: String, enum: AUTH_HEALTH_KINDS, required: true },
    reason: { type: String, enum: AUTH_HEALTH_REASONS, default: "unknown" },
    platform: { type: String, enum: AUTH_HEALTH_PLATFORMS, default: "unknown" },
    appVersion: { type: String, trim: true, maxlength: 40, default: "" },
    // Identical events within one flush window are coalesced into one row
    // (auth-health.service.js), so every aggregate sums this, never counts
    // rows. Bounds the write rate an anonymous caller can cause.
    count: { type: Number, min: 1, default: 1 },
    occurredAt: { type: Date, default: Date.now, immutable: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

AuthHealthEventSchema.index(
  { occurredAt: 1 },
  { expireAfterSeconds: AUTH_HEALTH_RETENTION_SECONDS }
);
AuthHealthEventSchema.index({ kind: 1, occurredAt: -1 });

// Append-only, like ActivityEvent: an authentication record must never be
// rewritten after the fact. Only the TTL index above removes rows.
const rejectMutation = function rejectMutation(next) {
  next(new Error("Auth health events are append-only"));
};
for (const hook of [
  "updateOne",
  "updateMany",
  "findOneAndUpdate",
  "replaceOne",
  "deleteOne",
  "deleteMany",
  "findOneAndDelete",
]) {
  AuthHealthEventSchema.pre(hook, rejectMutation);
}

const AuthHealthEvent = mongoose.model(
  "AuthHealthEvent",
  AuthHealthEventSchema
);

export default AuthHealthEvent;
export {
  AUTH_HEALTH_KINDS,
  AUTH_HEALTH_REASONS,
  AUTH_HEALTH_PLATFORMS,
  AUTH_HEALTH_RETENTION_SECONDS,
};
