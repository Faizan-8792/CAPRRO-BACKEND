// tests/reminder-delivery-health-stat.mjs
//
// T1 (.kiro/PLAN.md): fleet-wide reminder delivery-failure visibility.
// reliableReminderDelivery's retry loop already records a per-attempt status on
// every Reminder document; nothing anywhere previously aggregated that into
// something an operator could see without opening MongoDB by hand. This suite
// proves two things without a live database connection:
//
//   1. deliveryHealth/getAttemptEntries (reminder.controller.js, now exported)
//      classify a representative set of attempt shapes correctly -- the same
//      function the fleet-wide stat and the single-reminder view both use, so
//      there is exactly one definition of "delivery trouble", not two.
//   2. getReminderDeliveryHealthStats (super.controller.js) enforces the
//      super-admin gate, aggregates a stubbed candidate set correctly (count,
//      sample, truncation, sort order), and never lets a caller who is not the
//      super admin see anything.

const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass, detail });

const { deliveryHealth, getAttemptEntries } = await import(
  "../src/controllers/reminder.controller.js"
);

// ─── deliveryHealth: classification of representative attempt shapes ───

{
  const healthy = {
    scheduleVersion: 1,
    deliveryAttempts: {
      v1_offset_m1: { status: "SENT", scheduleVersion: 1, sentAt: "2026-08-01T00:00:00.000Z" },
    },
  };
  const health = deliveryHealth(healthy, new Date("2026-08-02T00:00:00.000Z"));
  check(
    "a reminder with only a SENT attempt is HEALTHY",
    health.status === "HEALTHY" && health.issueCount === 0,
    JSON.stringify(health)
  );
}

{
  const failed = {
    scheduleVersion: 1,
    deliveryAttempts: {
      v1_offset_m1: {
        status: "FAILED",
        scheduleVersion: 1,
        attemptCount: 2,
        lastError: "RESEND_ERROR: timeout",
        nextAttemptAt: "2026-08-02T01:00:00.000Z",
      },
    },
  };
  const health = deliveryHealth(failed, new Date("2026-08-02T00:00:00.000Z"));
  check(
    "an active FAILED attempt reports RETRY_SCHEDULED with one issue",
    health.status === "RETRY_SCHEDULED" && health.issueCount === 1,
    JSON.stringify(health)
  );
  check(
    "the reported issue carries the real lastError, not a placeholder",
    health.issues[0]?.lastError === "RESEND_ERROR: timeout",
    JSON.stringify(health.issues)
  );
}

{
  // A FAILED attempt from a superseded schedule version (the reminder's due date
  // moved, bumping scheduleVersion) must still surface -- it is unresolved history,
  // not noise, per deliveryHealth's supersededUnresolved branch.
  const superseded = {
    scheduleVersion: 2,
    deliveryAttempts: {
      v1_offset_m1: { status: "FAILED", scheduleVersion: 1, attemptCount: 5 },
    },
  };
  const health = deliveryHealth(superseded, new Date("2026-08-02T00:00:00.000Z"));
  check(
    "a FAILED attempt on a superseded schedule version still surfaces",
    health.status === "HISTORICAL_ATTEMPTS_PRESENT" && health.issueCount === 1,
    JSON.stringify(health)
  );
}

{
  const empty = { scheduleVersion: 1, deliveryAttempts: {} };
  check(
    "getAttemptEntries on an empty deliveryAttempts map returns []",
    Array.isArray(getAttemptEntries(empty)) && getAttemptEntries(empty).length === 0
  );
}

// ─── getReminderDeliveryHealthStats: gate + aggregation, DB stubbed ───

const { default: Reminder } = await import("../src/models/Reminder.js");
const { getReminderDeliveryHealthStats } = await import(
  "../src/controllers/super.controller.js"
);

function fixtureReminder(id, { dueDateISO, status, scheduleVersion = 1 }) {
  return {
    _id: id,
    userId: "6512ab00ab00ab00ab00ab01",
    firmId: "6512ab00ab00ab00ab00ab02",
    typeId: "GSTR-3B",
    clientLabel: `Client ${id}`,
    dueDateISO,
    scheduleVersion,
    deliveryAttempts: {
      [`v${scheduleVersion}_offset_m1`]: {
        status,
        scheduleVersion,
        attemptCount: 1,
        lastError: status === "FAILED" ? "RESEND_ERROR: bounced" : "",
        nextAttemptAt: status === "FAILED" ? "2026-08-05T00:00:00.000Z" : null,
      },
    },
  };
}

// 2 healthy + 25 unhealthy (out of order on purpose, to prove the sort), so the
// 20-item sample cap and the true 25 count can both be checked distinctly.
const fixtureCandidates = [
  fixtureReminder("healthy-1", { dueDateISO: "2026-08-10T00:00:00.000Z", status: "SENT" }),
  ...Array.from({ length: 25 }, (_, i) =>
    fixtureReminder(`unhealthy-${i}`, {
      dueDateISO: `2026-08-${String(25 - i).padStart(2, "0")}T00:00:00.000Z`, // descending, so sort must fix it
      status: "FAILED",
    })
  ),
  fixtureReminder("healthy-2", { dueDateISO: "2026-08-11T00:00:00.000Z", status: "SENT" }),
];

function stubReminderFind(returning) {
  Reminder.find = () => ({
    select: () => ({
      limit: () => ({
        lean: async () => returning,
      }),
    }),
  });
}

function fakeReqRes(user) {
  const state = { status: 200, body: null };
  const req = { user };
  const res = {
    status(code) {
      state.status = code;
      return res;
    },
    json(payload) {
      state.body = payload;
      return res;
    },
  };
  return { req, res, state };
}

{
  stubReminderFind(fixtureCandidates);
  const { req, res, state } = fakeReqRes({
    role: "SUPER_ADMIN",
    email: "saifullahfaizan786@gmail.com",
  });
  let nextErr = null;
  await getReminderDeliveryHealthStats(req, res, (err) => {
    nextErr = err;
  });
  check("super admin call does not error", nextErr === null, String(nextErr));
  check(
    "issueCount reflects all 25 unhealthy reminders, not just the sample",
    state.body?.delivery?.issueCount === 25,
    JSON.stringify(state.body?.delivery?.issueCount)
  );
  check(
    "sample is capped at 20 even though 25 are unhealthy",
    state.body?.delivery?.sample?.length === 20,
    JSON.stringify(state.body?.delivery?.sample?.length)
  );
  check("sampleTruncated is true when issueCount exceeds the sample", state.body?.delivery?.sampleTruncated === true);
  check(
    "healthy reminders never appear in the sample",
    !state.body?.delivery?.sample?.some((row) => row.reminderId.startsWith("healthy")),
    JSON.stringify(state.body?.delivery?.sample?.map((r) => r.reminderId))
  );
  const dues = state.body?.delivery?.sample?.map((row) => row.dueDateISO) || [];
  const sorted = [...dues].sort();
  check(
    "sample is sorted by dueDateISO ascending, not fixture insertion order",
    JSON.stringify(dues) === JSON.stringify(sorted),
    JSON.stringify(dues)
  );
  check(
    "candidatesScanned matches the stubbed candidate count",
    state.body?.delivery?.candidatesScanned === fixtureCandidates.length
  );
  check(
    "a sampled row exposes the real failure reason, not a placeholder",
    state.body?.delivery?.sample?.[0]?.issues?.[0]?.lastError === "RESEND_ERROR: bounced",
    JSON.stringify(state.body?.delivery?.sample?.[0])
  );
}

{
  // Zero unhealthy reminders must report a real 0, never a provisional/undefined
  // value -- this project's own honest-copy rule (CLAUDE.md) treats a silently
  // wrong provisional zero as a release veto elsewhere; this pins the same
  // discipline here.
  stubReminderFind([fixtureReminder("only-healthy", { dueDateISO: "2026-08-10T00:00:00.000Z", status: "SENT" })]);
  const { req, res, state } = fakeReqRes({
    role: "SUPER_ADMIN",
    email: "saifullahfaizan786@gmail.com",
  });
  await getReminderDeliveryHealthStats(req, res, () => {});
  check(
    "an all-healthy candidate set reports issueCount 0 and an empty sample",
    state.body?.delivery?.issueCount === 0 && state.body?.delivery?.sample?.length === 0,
    JSON.stringify(state.body?.delivery)
  );
}

{
  // Non-super-admin callers must never see this -- reminder delivery status
  // reveals which firms/clients exist and are having trouble, firm-scoped data
  // that has no business reaching an ordinary member.
  stubReminderFind(fixtureCandidates);
  const { req, res } = fakeReqRes({ role: "FIRM_ADMIN", email: "someone@example.com" });
  let nextErr = null;
  await getReminderDeliveryHealthStats(req, res, (err) => {
    nextErr = err;
  });
  check(
    "a non-super-admin caller is refused with 403, not shown data",
    nextErr?.statusCode === 403,
    String(nextErr)
  );
}

{
  stubReminderFind(fixtureCandidates);
  const { req, res } = fakeReqRes(null);
  let nextErr = null;
  await getReminderDeliveryHealthStats(req, res, (err) => {
    nextErr = err;
  });
  check("an unauthenticated caller is refused with 403", nextErr?.statusCode === 403, String(nextErr));
}

// ─── report ───

const passed = checks.filter((c) => c.pass).length;
const failed = checks.length - passed;
for (const c of checks) {
  console.log(`${c.pass ? "PASS" : "FAIL"} ${c.name}${c.pass ? "" : ` -- ${c.detail}`}`);
}
console.log(`\n${passed} passed, ${failed} failed, ${checks.length} total`);
if (failed > 0) process.exit(1);
