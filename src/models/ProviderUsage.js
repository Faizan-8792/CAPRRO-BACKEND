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
      // Three granularities share this one field, distinguished by shape:
      //   daily   "2026-08-28"   monthly "2026-08"   weekly "2026-W35" (ISO 8601 week)
      // The weekly form was added 2026-08-28 for the owner's OCR policy (300 per user per
      // WEEK). It cannot collide with the other two: a literal "W" never appears in either.
      match: /^\d{4}-(\d{2}(-\d{2})?|W\d{2})$/,
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

// ISO 8601 week key, e.g. "2026-W35". Weeks start Monday and week 1 is the week
// containing the first Thursday, which is why this cannot be done with simple
// arithmetic on the day-of-year: the ISO week-numbering YEAR can differ from the
// calendar year at both ends. 2021-01-01 belongs to 2020-W53, and 2024-12-30 to
// 2025-W01 -- both are covered by the contract suite so a "simplification" that
// breaks them fails loudly rather than silently resetting somebody's cap early.
//
// UTC throughout, deliberately and for the same reason every other statutory date
// in this codebase is UTC: a per-week quota must not reset at a different instant
// for a user in a different timezone, and must not shift when a machine's local
// clock changes.
function weeklyPeriodKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNumber = d.getUTCDay() || 7; // Monday = 1 ... Sunday = 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNumber); // the Thursday that identifies this ISO week
  const isoYear = d.getUTCFullYear();
  const isoYearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((d - isoYearStart) / 86400000 + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
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
  weeklyCapPerUser,
  monthlyCapPerUser,
  globalDailyCap,
  now = new Date(),
}) {
  const dayKey = dailyPeriodKey(now);
  const weekKey = weeklyPeriodKey(now);
  const monthKey = monthlyPeriodKey(now);
  const label = PROVIDER_LABELS[provider] || provider;

  // Tiers are declared rather than hand-written, because the rollback is the part that gets
  // silently wrong: every tier already reserved has to be released when a LATER tier refuses,
  // and with four tiers the hand-written version needed a growing list of release calls copied
  // into each branch. Here the loop releases exactly what it reserved, so a fifth tier cannot
  // be added with a forgotten rollback.
  //
  // A tier whose cap is not a positive finite number is SKIPPED, not treated as zero. That is
  // what lets one provider be metered weekly and another daily/monthly without either inheriting
  // a cap that does not apply to it -- and it is the difference between "no weekly limit" and
  // "a weekly limit of nothing, refuse everything".
  const tiers = [
    { cap: dailyCapPerUser, periodKey: dayKey, userId, reason: `${label} daily quota exceeded for this account` },
    { cap: weeklyCapPerUser, periodKey: weekKey, userId, reason: `${label} weekly quota exceeded for this account` },
    { cap: monthlyCapPerUser, periodKey: monthKey, userId, reason: `${label} monthly quota exceeded for this account` },
    {
      cap: globalDailyCap,
      periodKey: dayKey,
      userId: GLOBAL_USAGE_USER_ID,
      reason: `${label} provider-wide daily volume limit reached; try again tomorrow`,
    },
  ].filter((tier) => Number.isFinite(tier.cap) && tier.cap > 0);

  const reserved = [];
  for (const tier of tiers) {
    const outcome = await this.tryIncrement({
      userId: tier.userId,
      provider,
      periodKey: tier.periodKey,
      cap: tier.cap,
    });
    if (!outcome.allowed) {
      for (const done of reserved) {
        await this.releaseReservation({ userId: done.userId, provider, periodKey: done.periodKey });
      }
      return { allowed: false, reason: tier.reason };
    }
    reserved.push(tier);
  }

  return { allowed: true };
};

const ProviderUsage = mongoose.model("ProviderUsage", ProviderUsageSchema);

export { PROVIDERS, GLOBAL_USAGE_USER_ID, dailyPeriodKey, weeklyPeriodKey, monthlyPeriodKey };
export default ProviderUsage;
