// tests/digest-frequency-checklist.mjs
//
// Automated checks for the per-user "daily work digest" cadence introduced with
// the Settings view (Daily / Every 3 days / Weekly / Off).
//
// Pure logic only - no database or network. It verifies:
//   1. effectivePreferences() mapping for many user shapes (legacy + new).
//   2. dailyDigestDueForFrequency() across a range of dates.
//   3. The multi-user scheduling decision on a single shared day.
//   4. updateDigestPreferences() input validation (rejects before any DB call).
//
// Run:  node tests/digest-frequency-checklist.mjs   (from capro-backend/)

import assert from "node:assert/strict";
import {
  effectivePreferences,
  dailyDigestDueForFrequency,
  digestEmailSuppressionReason,
  updateDigestPreferences,
  zonedParts,
  DigestError,
} from "../src/services/digest.service.js";

const results = [];
let passed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    results.push(`PASS  ${name}`);
  } catch (err) {
    results.push(`FAIL  ${name}\n        ${err?.message || err}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    results.push(`PASS  ${name}`);
  } catch (err) {
    results.push(`FAIL  ${name}\n        ${err?.message || err}`);
  }
}

// ---------------------------------------------------------------------------
// 1. effectivePreferences: different users store preferences differently.
// ---------------------------------------------------------------------------
check("legacy user dailyEnabled=true -> DAILY", () => {
  const p = effectivePreferences({ digestPreferences: { dailyEnabled: true } });
  assert.equal(p.dailyFrequency, "DAILY");
  assert.equal(p.dailyEnabled, true);
});
check("legacy user dailyEnabled=false -> OFF", () => {
  const p = effectivePreferences({ digestPreferences: { dailyEnabled: false } });
  assert.equal(p.dailyFrequency, "OFF");
  assert.equal(p.dailyEnabled, false);
});
check("brand-new user (no prefs) -> sensible defaults", () => {
  const p = effectivePreferences({});
  assert.deepEqual(p, {
    dailyFrequency: "DAILY",
    dailyEnabled: true,
    weeklyEnabled: true,
    emailEnabled: true,
  });
});
for (const freq of ["DAILY", "EVERY_3_DAYS", "WEEKLY", "OFF"]) {
  check(`explicit dailyFrequency=${freq} is preserved`, () => {
    const p = effectivePreferences({ digestPreferences: { dailyFrequency: freq } });
    assert.equal(p.dailyFrequency, freq);
    assert.equal(p.dailyEnabled, freq !== "OFF");
  });
}
check("corrupt stored frequency falls back via legacy flag", () => {
  const p = effectivePreferences({
    digestPreferences: { dailyFrequency: "NONSENSE", dailyEnabled: false },
  });
  assert.equal(p.dailyFrequency, "OFF");
});
check("weekly + email opt-outs are independent per user", () => {
  const p = effectivePreferences({
    digestPreferences: { dailyFrequency: "WEEKLY", weeklyEnabled: false, emailEnabled: false },
  });
  assert.equal(p.dailyFrequency, "WEEKLY");
  assert.equal(p.weeklyEnabled, false);
  assert.equal(p.emailEnabled, false);
});

// ---------------------------------------------------------------------------
// 2. dailyDigestDueForFrequency across 14 consecutive days.
// ---------------------------------------------------------------------------
function partsForUtcDate(y, m, d) {
  return zonedParts(new Date(Date.UTC(y, m - 1, d, 12, 0, 0)), "UTC");
}
for (let d = 1; d <= 14; d += 1) {
  const parts = partsForUtcDate(2026, 3, d);
  const jsDay = new Date(Date.UTC(2026, 2, d)).getUTCDay(); // 0=Sun..1=Mon
  const epochDay = Math.floor(Date.UTC(2026, 2, d) / 86400000);
  check(`cadence for 2026-03-${String(d).padStart(2, "0")}`, () => {
    assert.equal(dailyDigestDueForFrequency("OFF", parts), false);
    assert.equal(dailyDigestDueForFrequency("DAILY", parts), true);
    assert.equal(dailyDigestDueForFrequency("WEEKLY", parts), jsDay === 1);
    assert.equal(dailyDigestDueForFrequency("EVERY_3_DAYS", parts), epochDay % 3 === 0);
  });
}

// ---------------------------------------------------------------------------
// 3. Multiple users, SAME day, mixed cadences (mirrors the scheduler loop:
//    one firm "parts" value, each recipient's own frequency).
// ---------------------------------------------------------------------------
check("multiple users on the same Monday get the right decisions", () => {
  const parts = partsForUtcDate(2026, 3, 2); // Monday
  assert.equal(new Date(Date.UTC(2026, 2, 2)).getUTCDay(), 1, "expected 2026-03-02 to be Monday");
  const epochDay = Math.floor(Date.UTC(2026, 2, 2) / 86400000);

  const users = [
    { name: "Asha", freq: "DAILY" },
    { name: "Ravi", freq: "OFF" },
    { name: "Meera", freq: "WEEKLY" },
    { name: "Sanjay", freq: "EVERY_3_DAYS" },
    { name: "Neha", freq: "DAILY" },
  ];
  const due = users
    .filter((u) => dailyDigestDueForFrequency(u.freq, parts))
    .map((u) => u.name)
    .sort();

  const expected = ["Asha", "Neha", "Meera"]; // DAILY x2 + WEEKLY(Monday)
  if (epochDay % 3 === 0) expected.push("Sanjay");
  assert.deepEqual(due, expected.sort());
});

check("OFF user never receives on any day of a week", () => {
  for (let d = 1; d <= 7; d += 1) {
    assert.equal(dailyDigestDueForFrequency("OFF", partsForUtcDate(2026, 6, d)), false);
  }
});

check("EVERY_3_DAYS fires exactly on a 3-day rhythm", () => {
  let hits = 0;
  for (let d = 1; d <= 30; d += 1) {
    if (dailyDigestDueForFrequency("EVERY_3_DAYS", partsForUtcDate(2026, 4, d))) hits += 1;
  }
  assert.equal(hits, 10, "30 days / 3 = 10 sending days");
});

// ---------------------------------------------------------------------------
// 3b. Send-time suppression: a queued email must respect the recipient's
//     CURRENT preferences (the reported "I turned it off but still got mail").
// ---------------------------------------------------------------------------
const DAILY = "DAILY_PERSONAL";
const WEEKLY = "WEEKLY_FIRM";

check("email copies off -> daily email suppressed", () => {
  const user = { digestPreferences: { dailyFrequency: "DAILY", emailEnabled: false } };
  assert.equal(digestEmailSuppressionReason(DAILY, user), "EMAIL_DISABLED");
});
check("email copies off -> weekly email suppressed", () => {
  const user = { digestPreferences: { weeklyEnabled: true, emailEnabled: false } };
  assert.equal(digestEmailSuppressionReason(WEEKLY, user), "EMAIL_DISABLED");
});
check("daily cadence OFF suppresses an already-queued daily email", () => {
  const user = { digestPreferences: { dailyFrequency: "OFF", emailEnabled: true } };
  assert.equal(digestEmailSuppressionReason(DAILY, user), "UNSUBSCRIBED");
});
check("weekly unsubscribed suppresses an already-queued weekly email", () => {
  const user = { digestPreferences: { weeklyEnabled: false, emailEnabled: true } };
  assert.equal(digestEmailSuppressionReason(WEEKLY, user), "UNSUBSCRIBED");
});
check("daily OFF does not block the weekly summary", () => {
  const user = {
    digestPreferences: { dailyFrequency: "OFF", weeklyEnabled: true, emailEnabled: true },
  };
  assert.equal(digestEmailSuppressionReason(WEEKLY, user), null);
});
check("weekly off does not block the daily digest", () => {
  const user = {
    digestPreferences: { dailyFrequency: "DAILY", weeklyEnabled: false, emailEnabled: true },
  };
  assert.equal(digestEmailSuppressionReason(DAILY, user), null);
});
check("fully opted-in recipient is not suppressed", () => {
  const user = {
    digestPreferences: { dailyFrequency: "EVERY_3_DAYS", weeklyEnabled: true, emailEnabled: true },
  };
  assert.equal(digestEmailSuppressionReason(DAILY, user), null);
  assert.equal(digestEmailSuppressionReason(WEEKLY, user), null);
});
check("legacy dailyEnabled=false suppresses the daily email", () => {
  const user = { digestPreferences: { dailyEnabled: false, emailEnabled: true } };
  assert.equal(digestEmailSuppressionReason(DAILY, user), "UNSUBSCRIBED");
});
check("EVERY_3_DAYS recipient with email off is still suppressed", () => {
  const user = { digestPreferences: { dailyFrequency: "EVERY_3_DAYS", emailEnabled: false } };
  assert.equal(digestEmailSuppressionReason(DAILY, user), "EMAIL_DISABLED");
});

// ---------------------------------------------------------------------------
// 4. updateDigestPreferences validation rejects bad input BEFORE any DB work.
// ---------------------------------------------------------------------------
await checkAsync("reject invalid dailyFrequency", async () => {
  await assert.rejects(
    () => updateDigestPreferences({ userId: "u", firmId: "f", input: { dailyFrequency: "SOMETIMES" } }),
    (e) => e instanceof DigestError && /dailyFrequency must be/.test(e.message)
  );
});
await checkAsync("reject unknown preference key", async () => {
  await assert.rejects(
    () => updateDigestPreferences({ userId: "u", firmId: "f", input: { bogus: true } }),
    (e) => e instanceof DigestError && /Unsupported digest preferences/.test(e.message)
  );
});
await checkAsync("reject empty preferences object", async () => {
  await assert.rejects(
    () => updateDigestPreferences({ userId: "u", firmId: "f", input: {} }),
    (e) => e instanceof DigestError && /No digest preferences/.test(e.message)
  );
});
await checkAsync("reject non-boolean weeklyEnabled", async () => {
  await assert.rejects(
    () => updateDigestPreferences({ userId: "u", firmId: "f", input: { weeklyEnabled: "yes" } }),
    (e) => e instanceof DigestError && /weeklyEnabled must be boolean/.test(e.message)
  );
});

// ---------------------------------------------------------------------------
console.log(results.join("\n"));
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
