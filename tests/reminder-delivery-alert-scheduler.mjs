// tests/reminder-delivery-alert-scheduler.mjs
//
// T3 (.kiro/PLAN.md): a best-effort email alert to the owner when the
// fleet-wide failed-delivery count crosses a small threshold. This suite
// proves checkReminderDeliveryHealthAndAlert (reminder-delivery-alert.service.js)
// without a live database connection or a live Resend call -- the Mongo layer
// (Reminder.find, AppConfig.findById/findByIdAndUpdate) and the email send are
// both stubbed, following the style of reminder-delivery-health-stat.mjs and
// reminder-message-validation.mjs.

const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass, detail });

const { checkReminderDeliveryHealthAndAlert, REMINDER_DELIVERY_ALERT_THRESHOLD } =
  await import("../src/services/reminder-delivery-alert.service.js");

// ─── fixtures ───

function unhealthyReminder(id) {
  return {
    _id: id,
    scheduleVersion: 1,
    deliveryAttempts: {
      v1_offset_m1: {
        status: "FAILED",
        scheduleVersion: 1,
        attemptCount: 2,
        lastError: "RESEND_ERROR: timeout",
      },
    },
  };
}

function healthyReminder(id) {
  return {
    _id: id,
    scheduleVersion: 1,
    deliveryAttempts: {
      v1_offset_m1: { status: "SENT", scheduleVersion: 1, sentAt: "2026-08-01T00:00:00.000Z" },
    },
  };
}

// stubReminderFind mirrors reminder-delivery-health-stat.mjs's chain shape
// (.select().limit().lean()) so it matches the real query in
// countUnhealthyReminders exactly.
function stubReminderFind(Reminder, returning) {
  Reminder.find = () => ({
    select: () => ({
      limit: () => ({
        lean: async () => returning,
      }),
    }),
  });
}

// A minimal AppConfig double that actually stores what it is given, so a
// write in one call is visible to the next call's read -- the same relationship
// the real singleton document has across scheduler ticks.
function makeAppConfigStub() {
  let singleton = null; // null until the first alert write, like a fresh deploy
  let invalidateCalls = 0;
  return {
    findById(id) {
      if (id !== "singleton") throw new Error(`unexpected findById(${id})`);
      return {
        select: () => ({
          lean: async () => (singleton ? { ...singleton } : null),
        }),
      };
    },
    findByIdAndUpdate(id, update) {
      if (id !== "singleton") throw new Error(`unexpected findByIdAndUpdate(${id})`);
      const current = singleton?.reminderDeliveryAlert || {};
      const next = { ...current };
      for (const [path, value] of Object.entries(update?.$set || {})) {
        const key = path.replace("reminderDeliveryAlert.", "");
        next[key] = value;
      }
      singleton = { ...singleton, reminderDeliveryAlert: next };
      return Promise.resolve({ ...singleton });
    },
    invalidateCache() {
      invalidateCalls += 1;
    },
    get invalidateCalls() {
      return invalidateCalls;
    },
    get lastAlertAt() {
      return singleton?.reminderDeliveryAlert?.lastAlertAt ?? null;
    },
  };
}

function makeEmailSpy(shouldFail = false) {
  const calls = [];
  const sendAlertEmail = async (args) => {
    calls.push(args);
    if (shouldFail) throw new Error("Resend is down");
    return { data: { id: "test-message-id" } };
  };
  return { sendAlertEmail, calls };
}

// ─── (a) crossing the threshold sends exactly one email ───

{
  const Reminder = {};
  stubReminderFind(
    Reminder,
    Array.from({ length: REMINDER_DELIVERY_ALERT_THRESHOLD }, (_, i) =>
      unhealthyReminder(`unhealthy-${i}`),
    ),
  );
  const AppConfig = makeAppConfigStub();
  const email = makeEmailSpy();
  const now = new Date("2026-09-01T00:00:00.000Z");

  const result = await checkReminderDeliveryHealthAndAlert({
    Reminder,
    AppConfig,
    sendAlertEmail: email.sendAlertEmail,
    toEmail: "owner@example.com",
    nowUtc: now,
  });

  check(
    "(a) issueCount at exactly the threshold triggers an alert",
    result.alerted === true && result.reason === "SENT",
    JSON.stringify(result),
  );
  check("(a) exactly one email was sent", email.calls.length === 1, String(email.calls.length));
  check(
    "(a) the email carries the real issueCount, not a placeholder",
    email.calls[0]?.issueCount === REMINDER_DELIVERY_ALERT_THRESHOLD,
    JSON.stringify(email.calls[0]),
  );
  check(
    "(a) AppConfig.lastAlertAt is persisted after a successful send",
    AppConfig.lastAlertAt?.getTime?.() === now.getTime(),
    String(AppConfig.lastAlertAt),
  );
  check("(a) the shared config cache is invalidated after the write", AppConfig.invalidateCalls === 1);

  // ─── (b) staying over threshold on the next tick within the rate-limit
  //         window does not send a second email ───

  const nowPlus1h = new Date(now.getTime() + 60 * 60 * 1000);
  const secondResult = await checkReminderDeliveryHealthAndAlert({
    Reminder,
    AppConfig,
    sendAlertEmail: email.sendAlertEmail,
    toEmail: "owner@example.com",
    nowUtc: nowPlus1h,
  });

  check(
    "(b) a tick one hour later, still over threshold, is rate-limited",
    secondResult.alerted === false && secondResult.reason === "RATE_LIMITED",
    JSON.stringify(secondResult),
  );
  check("(b) no second email was sent", email.calls.length === 1, String(email.calls.length));

  // ─── (c) after the rate-limit window passes and the count is still over
  //         threshold, it alerts again ───

  const nowPlus7h = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  const thirdResult = await checkReminderDeliveryHealthAndAlert({
    Reminder,
    AppConfig,
    sendAlertEmail: email.sendAlertEmail,
    toEmail: "owner@example.com",
    nowUtc: nowPlus7h,
  });

  check(
    "(c) a tick past the 6h re-alert window, still over threshold, alerts again",
    thirdResult.alerted === true && thirdResult.reason === "SENT",
    JSON.stringify(thirdResult),
  );
  check("(c) a second email was sent", email.calls.length === 2, String(email.calls.length));
  check(
    "(c) AppConfig.lastAlertAt advances to the second alert's timestamp",
    AppConfig.lastAlertAt?.getTime?.() === nowPlus7h.getTime(),
    String(AppConfig.lastAlertAt),
  );
}

// ─── (d) dropping back under threshold never sends while healthy ───

{
  const Reminder = {};
  // One below the threshold, plus some healthy ones mixed in -- never crosses.
  stubReminderFind(Reminder, [
    ...Array.from({ length: REMINDER_DELIVERY_ALERT_THRESHOLD - 1 }, (_, i) =>
      unhealthyReminder(`unhealthy-${i}`),
    ),
    healthyReminder("healthy-1"),
    healthyReminder("healthy-2"),
  ]);
  const AppConfig = makeAppConfigStub();
  const email = makeEmailSpy();

  const result = await checkReminderDeliveryHealthAndAlert({
    Reminder,
    AppConfig,
    sendAlertEmail: email.sendAlertEmail,
    toEmail: "owner@example.com",
    nowUtc: new Date("2026-09-01T00:00:00.000Z"),
  });

  check(
    "(d) one below threshold never alerts",
    result.alerted === false && result.reason === "BELOW_THRESHOLD",
    JSON.stringify(result),
  );
  check("(d) no email was sent while healthy", email.calls.length === 0, String(email.calls.length));
  check(
    "(d) AppConfig is never written to when the fleet stays healthy",
    AppConfig.lastAlertAt === null,
  );

  // An all-healthy fleet, and a fleet with zero candidates at all, must also
  // never alert -- issueCount 0 is unambiguously below any positive threshold.
  stubReminderFind(Reminder, [healthyReminder("healthy-1")]);
  const allHealthy = await checkReminderDeliveryHealthAndAlert({
    Reminder,
    AppConfig,
    sendAlertEmail: email.sendAlertEmail,
    toEmail: "owner@example.com",
    nowUtc: new Date("2026-09-01T00:00:00.000Z"),
  });
  check(
    "(d) an all-healthy fleet never alerts",
    allHealthy.alerted === false && allHealthy.issueCount === 0,
    JSON.stringify(allHealthy),
  );

  stubReminderFind(Reminder, []);
  const noCandidates = await checkReminderDeliveryHealthAndAlert({
    Reminder,
    AppConfig,
    sendAlertEmail: email.sendAlertEmail,
    toEmail: "owner@example.com",
    nowUtc: new Date("2026-09-01T00:00:00.000Z"),
  });
  check(
    "(d) zero candidate reminders never alerts",
    noCandidates.alerted === false && noCandidates.issueCount === 0,
    JSON.stringify(noCandidates),
  );
  check("(d) email was never sent across all three healthy checks", email.calls.length === 0);
}

// ─── a failed send never crashes and is retried, not throttled ───

{
  const Reminder = {};
  stubReminderFind(
    Reminder,
    Array.from({ length: REMINDER_DELIVERY_ALERT_THRESHOLD }, (_, i) =>
      unhealthyReminder(`unhealthy-${i}`),
    ),
  );
  const AppConfig = makeAppConfigStub();
  const failingEmail = makeEmailSpy(true);
  const now = new Date("2026-09-01T00:00:00.000Z");

  let threw = null;
  let result = null;
  try {
    result = await checkReminderDeliveryHealthAndAlert({
      Reminder,
      AppConfig,
      sendAlertEmail: failingEmail.sendAlertEmail,
      toEmail: "owner@example.com",
      nowUtc: now,
    });
  } catch (error) {
    threw = error;
  }

  check("a Resend failure never throws out of the scheduler tick", threw === null, String(threw));
  check(
    "a failed send is reported, not silently swallowed",
    result?.alerted === false && result?.reason === "SEND_FAILED",
    JSON.stringify(result),
  );
  check(
    "a failed send does not set the throttle timestamp, so the very next tick retries",
    AppConfig.lastAlertAt === null,
  );

  // Confirms the "retried, not throttled" half: a tick moments later, still
  // over threshold, tries to send again rather than waiting out realertMs.
  const retryResult = await checkReminderDeliveryHealthAndAlert({
    Reminder,
    AppConfig,
    sendAlertEmail: failingEmail.sendAlertEmail,
    toEmail: "owner@example.com",
    nowUtc: new Date(now.getTime() + 60 * 1000),
  });
  check(
    "the next tick after a send failure attempts to send again immediately",
    failingEmail.calls.length === 2,
    String(failingEmail.calls.length),
  );
  check("that retry is also reported as SEND_FAILED, not rate-limited", retryResult.reason === "SEND_FAILED");
}

// ─── report ───

const passed = checks.filter((c) => c.pass).length;
const failed = checks.length - passed;
for (const c of checks) {
  console.log(`${c.pass ? "PASS" : "FAIL"} ${c.name}${c.pass ? "" : ` -- ${c.detail}`}`);
}
console.log(`\n${passed} passed, ${failed} failed, ${checks.length} total`);
if (failed > 0) process.exit(1);
