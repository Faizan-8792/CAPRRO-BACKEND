// src/models/ProviderUsage.js
// Per-user, per-provider call counters for the two paid third-party providers
// (DeepSeek, OCR.space). Backs the O10 spend meter/cap enforced at each
// provider's single choke-point function (callDeepSeek, extractTextWithOcrSpace)
// -- see deepseek-provider.service.js and ocr-space.service.js.
//
// One document per (userId, provider, periodKey). periodKey is reused for BOTH
// granularities a caller checks: a daily stamp ("YYYY-MM-DD", UTC) and a monthly
// stamp ("YYYY-MM", UTC) are just different strings under the same unique index,
// so a single approved call increments two documents (its day's row and its
// month's row) rather than needing two different schemas.
//
// The provider-wide daily ceiling (required in addition to the per-user caps, so
// a per-user cap multiplied by an unexpected number of signups is still bounded)
// is stored the same way: as an ordinary row under a fixed, non-real sentinel
// userId (GLOBAL_USAGE_USER_ID) with periodKey = today's daily stamp. Nothing
// else about the schema needs to change for that -- it is just another
// (userId, provider, periodKey) counter.

import mongoose from "mongoose";

const PROVIDERS = Object.freeze(["DEEPSEEK", "OCR_SPACE"]);

// Not a real User document -- never populated, never shown as a "user" in the
// admin panel's top-users list (that query explicitly excludes it). Exists only
// so the provider-wide daily ceiling can reuse the exact same unique-indexed,
// atomically-incremented row shape as every real per-user counter instead of a
// second schema or a live aggregation on every paid call.
const GLOBAL_USAGE_USER_ID = new mongoose.Types.ObjectId(
  "000000000000000000000000",
);

// A refusal reason can reach a chartered accountant verbatim (OCR's choke
// point throws it as an httpError message; DeepSeek's classification regex
// matches on the word "quota" regardless of provider wording). A human label
// here, never the raw enum value, matches this codebase's existing policy of
// not putting a bare provider identifier in front of the end user.
const PROVIDER_LABELS = Object.freeze({
  DEEPSEEK: "DeepSeek",
  OCR_SPACE: "OCR.space",
});

const ProviderUsageSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
      index: true,
    },
    provider: {
      type: String,
      enum: PROVIDERS,
      required: true,
      immutable: true,
    },
    periodKey: {
      type: String,
      required: true,
      trim: true,
      match: /^\d{4}-\d{2}(-\d{2})?$/,
      immutable: true,
    },
    calls: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

ProviderUsageSchema.index(
  { userId: 1, provider: 1, periodKey: 1 },
  { unique: true, name: "unique_provider_usage_period" },
);

function dailyPeriodKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function monthlyPeriodKey(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

// Atomically increments one (userId, provider, periodKey) counter only if it is
// currently under `cap`, in a single findOneAndUpdate -- never a separate
// read-then-write, which would race under concurrent requests (exactly the
// retry-storm case this exists to survive). Either:
//   - an existing under-cap row matches the filter and is incremented, or
//   - no row currently qualifies (none exists yet, or the existing one is
//     already at/over cap) and Mongo attempts to insert a fresh one, which
//     either succeeds (brand-new counter, starts at 1) or collides with the
//     unique index on an already-at-cap row and throws E11000 -- read here as
//     "quota already exhausted" without that row's count ever being touched.
ProviderUsageSchema.statics.tryIncrement = async function tryIncrement({
  userId,
  provider,
  periodKey,
  cap,
}) {
  try {
    const doc = await this.findOneAndUpdate(
      { userId, provider, periodKey, calls: { $lt: cap } },
      { $inc: { calls: 1 } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    return { allowed: true, calls: doc.calls };
  } catch (error) {
    if (error?.code === 11000) return { allowed: false, calls: cap };
    throw error;
  }
};

// Best-effort compensating decrement for a tier that was reserved (tryIncrement
// returned allowed:true) before a LATER tier in the same reservation refused it.
// Guards calls > 0 so it can never drive a row negative, and is deliberately not
// itself treated as fatal if it can't find a row to decrement -- the goal is
// only to undo this caller's own increment, not to enforce an exact value.
ProviderUsageSchema.statics.releaseReservation = async function releaseReservation({
  userId,
  provider,
  periodKey,
}) {
  await this.updateOne(
    { userId, provider, periodKey, calls: { $gt: 0 } },
    { $inc: { calls: -1 } },
  );
};

// The one entry point the two choke-point functions call. Reserves capacity
// across three tiers -- per-user daily, per-user monthly, provider-wide daily --
// BEFORE the paid call is made. Charging (a kept increment) only happens once
// every tier has cleared; a tier refused after an earlier tier already
// incremented rolls that earlier increment back, so a refused call is never
// left counted against the account. Returns { allowed: true } or
// { allowed: false, reason }; never throws for an ordinary quota refusal.
ProviderUsageSchema.statics.reserveProviderCall = async function reserveProviderCall({
  userId,
  provider,
  dailyCapPerUser,
  monthlyCapPerUser,
  globalDailyCap,
  now = new Date(),
}) {
  const dayKey = dailyPeriodKey(now);
  const monthKey = monthlyPeriodKey(now);
  const label = PROVIDER_LABELS[provider] || provider;

  const perUserDay = await this.tryIncrement({
    userId,
    provider,
    periodKey: dayKey,
    cap: dailyCapPerUser,
  });
  if (!perUserDay.allowed) {
    return {
      allowed: false,
      reason: `${label} daily quota exceeded for this account`,
    };
  }

  const perUserMonth = await this.tryIncrement({
    userId,
    provider,
    periodKey: monthKey,
    cap: monthlyCapPerUser,
  });
  if (!perUserMonth.allowed) {
    await this.releaseReservation({ userId, provider, periodKey: dayKey });
    return {
      allowed: false,
      reason: `${label} monthly quota exceeded for this account`,
    };
  }

  const global = await this.tryIncrement({
    userId: GLOBAL_USAGE_USER_ID,
    provider,
    periodKey: dayKey,
    cap: globalDailyCap,
  });
  if (!global.allowed) {
    await this.releaseReservation({ userId, provider, periodKey: dayKey });
    await this.releaseReservation({ userId, provider, periodKey: monthKey });
    return {
      allowed: false,
      reason: `${label} provider-wide daily volume limit reached; try again tomorrow`,
    };
  }

  return { allowed: true };
};

const ProviderUsage = mongoose.model("ProviderUsage", ProviderUsageSchema);

export { PROVIDERS, GLOBAL_USAGE_USER_ID, dailyPeriodKey, monthlyPeriodKey };
export default ProviderUsage;
