// src/services/ai/deepseek-models.js
//
// W11 IN1 (2026-10-21): which DeepSeek model names are current, and what a retired name now means.
//
// DeepSeek renames models and retires the old names on its own schedule (api-docs.deepseek.com/updates):
//   2026-07-24  deepseek-chat and deepseek-reasoner discontinued
//   2026-09-10  deepseek-v4-flash retired, "temporarily routed" to V4.1 Flash with no end date given
//   2026-10-17  deepseek-flash names the latest Flash; deepseek-v4-pro stays served
//
// The model names are read from the environment (DEEPSEEK_MODEL and friends) so a rename needs no deploy,
// but that only helps if someone edits the environment when DeepSeek renames. On 2026-10-21 the local .env
// still named a retired model for two of the four settings, and the code defaults named one too. So a
// retired name is translated here, at the one place every caller's model passes through, to the name that
// replaced it: an environment that was right last month keeps working this month, with nothing to edit.
//
// Thinking mode is irrelevant to the mapping: callDeepSeek always sends thinking disabled, so the old
// "reasoner" name maps to the same Flash model as "chat".

export const CURRENT_DEEPSEEK_MODELS = Object.freeze(["deepseek-flash", "deepseek-v4-pro"]);

export const RETIRED_DEEPSEEK_MODELS = Object.freeze({
  "deepseek-chat": "deepseek-flash",
  "deepseek-reasoner": "deepseek-flash",
  "deepseek-coder": "deepseek-flash",
  "deepseek-v4-flash": "deepseek-flash",
  "deepseek-v4-flash-vision-exp": "deepseek-flash",
});

export const DEFAULT_DEEPSEEK_MODEL = "deepseek-flash";
export const DEFAULT_DEEPSEEK_FALLBACK_MODEL = "deepseek-v4-pro";

// W11 IN2: deepseek-flash's PEAK price per million tokens in US dollars, read from
// api-docs.deepseek.com/quick_start/pricing on 2026-10-21. Peak is 01:00-04:00 and 06:00-10:00 UTC on
// weekdays (06:30-09:30 and 11:30-15:30 IST), which covers Indian office hours, so the admin panel's
// figure is an upper-bound ESTIMATE for Flash; a call answered by the fallback model costs more and is not
// separated. Change this table when DeepSeek changes its prices; nothing reads it for billing.
export const DEEPSEEK_PRICE_TABLE = Object.freeze({
  model: "deepseek-flash",
  window: "peak",
  readOn: "2026-10-21",
  usdPerMillion: Object.freeze({ cacheHit: 0.006, cacheMiss: 0.3, completion: 1.2 }),
});

// Estimated US dollars for a token block shaped like ProviderUsage's TOKEN_COUNTERS. A prompt with no
// cache split (an answer that did not report one) is priced entirely as cache misses: the upper bound.
export function estimateDeepSeekCostUsd(tokens) {
  const read = (value) => (Number.isFinite(value) && value > 0 ? value : 0);
  const prompt = read(tokens?.promptTokens);
  const hit = read(tokens?.cacheHitTokens);
  let miss = read(tokens?.cacheMissTokens);
  if (hit + miss === 0) miss = prompt;
  const price = DEEPSEEK_PRICE_TABLE.usdPerMillion;
  const usd = (hit * price.cacheHit + miss * price.cacheMiss + read(tokens?.completionTokens) * price.completion) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}

const warned = new Set();

// A blank or missing name gives `fallback`; a retired name gives its replacement (logged once per name,
// never the key); any other name is passed through untouched, so a model DeepSeek adds after this file
// was written can still be configured without a code change.
export function resolveDeepSeekModel(name, fallback = DEFAULT_DEEPSEEK_MODEL) {
  const value = typeof name === "string" ? name.trim() : "";
  if (!value) return fallback;
  const replacement = RETIRED_DEEPSEEK_MODELS[value];
  if (replacement) {
    if (!warned.has(value)) {
      warned.add(value);
      console.warn(`DeepSeek model "${value}" is retired; using "${replacement}" instead.`);
    }
    return replacement;
  }
  return value;
}
