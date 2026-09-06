// The three unbounded waits behind a 504 that was not a crash.
//
// WHAT HAPPENED
// UptimeRobot reported api.caprotoolkit.in/health DOWN at 2026-09-06 13:04:53 UTC with
// HTTP 504 Gateway Timeout. When checked at 15:07 UTC the service answered normally and reported
// uptime 7081s, which puts the process start at ~13:09 - four minutes after the alert. So the
// process was replaced, not merely slow.
//
// 504 is the important detail. A crashed process refuses the connection and the proxy answers 502.
// 504 means the proxy connected, waited, and got nothing: the app was alive and listening while
// answering nothing.
//
// THREE UNBOUNDED WAITS, stacked
//   1. waitQueueTimeoutMS was unset, so the driver's default of 0 applied - an operation waits
//      FOREVER for a free pool connection. serverSelectionTimeoutMS and socketTimeoutMS do not
//      bound this; they bound choosing a server and running an operation, not queueing for a slot.
//   2. /health awaited a ping through that same pool with no timeout of its own, so the one
//      endpoint whose job is to answer became the one endpoint that could not.
//   3. runReminderScheduler had no overlap guard, alone among the five schedulers, so a pass slower
//      than its 15-minute interval was joined by the next one, and each pass holds pool connections.
//
// (3) is a plausible cause of the saturation and is not proven to be THIS outage's cause - that
// needs host logs. (1) and (2) are what turned any saturation, from any cause, into silence.
//
//   node --test capro-backend/tests/outage-hardening.test.mjs

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const db = read("src/config/db.js");
const app = read("src/app.js");
const server = read("src/server.js");

/** One balanced {...} block starting at the first occurrence of `opener`. */
function block(source, opener) {
  const start = source.indexOf(opener);
  assert.ok(start >= 0, `could not find ${opener}`);
  const from = source.indexOf("{", start);
  assert.ok(from >= 0, `no block after ${opener}`);
  let depth = 0;
  for (let i = from; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(from, i + 1);
    }
  }
  throw new Error(`unbalanced block after ${opener}`);
}

test("waiting for a pool connection is bounded", () => {
  const options = block(db, "mongoose.connect(uri,");

  assert.match(
    options,
    /waitQueueTimeoutMS:\s*[1-9]/,
    "waitQueueTimeoutMS is unset or zero - the driver then waits forever for a free connection, " +
      "and a saturated pool becomes silence instead of an error",
  );

  const ms = Number(/waitQueueTimeoutMS:\s*([0-9_]+)/.exec(options)?.[1].replace(/_/g, ""));
  assert.ok(
    ms > 0 && ms <= 30_000,
    `waitQueueTimeoutMS should be a real, short bound; found ${ms}`,
  );

  // The bounds that do NOT cover queueing must still be present, so a future reader does not
  // conclude one of them made this one redundant.
  for (const name of ["serverSelectionTimeoutMS", "connectTimeoutMS", "socketTimeoutMS"]) {
    assert.match(options, new RegExp(`${name}:\\s*[0-9]`), `${name} was removed`);
  }
});

test("/health always answers, even when the database will not", () => {
  const handler = block(app, 'app.get("/health"');

  assert.match(handler, /admin\(\)\.ping\(\)/, "the health check no longer pings the database");
  assert.match(
    handler,
    /Promise\.race\(/,
    "the ping is awaited directly again - `catch` catches a rejection, not a wait, so a saturated " +
      "pool makes /health hang and the monitor reads 504 instead of a degraded body",
  );
  assert.match(
    handler,
    /HEALTH_PING_TIMEOUT_MS/,
    "the race has no named bound",
  );

  const ms = Number(/HEALTH_PING_TIMEOUT_MS\s*=\s*([0-9_]+)/.exec(app)?.[1].replace(/_/g, ""));
  assert.ok(
    ms > 0 && ms <= 5_000,
    `the health ping bound should be short enough to answer inside a monitor's timeout; found ${ms}`,
  );

  // A timeout must be distinguishable from an unreachable database: they have different fixes, and
  // a saturated pool still reports readyState "connected".
  assert.match(
    handler,
    /payload\.db\.slow\s*=\s*true/,
    "a timed-out ping is not reported as such",
  );
  assert.match(handler, /timeout_ms/, "the bound that was exceeded is not reported");

  // And the endpoint must still be able to say it is unhealthy.
  assert.match(handler, /res\.status\(dbOk \? 200 : 503\)/, "the degraded status code changed");
});

test("every scheduler refuses to start a second pass over itself", () => {
  // The guard is what keeps a slow pass from being joined by the next one. Four schedulers had it
  // and the reminder scheduler did not; that asymmetry is the defect, so all five are asserted
  // together rather than the fixed one alone.
  for (const [fn, promise] of [
    ["runReminderScheduler", "reminderSchedulerPromise"],
    ["runDigestScheduler", "digestSchedulerPromise"],
    ["runAutomationWorker", "automationWorkerPromise"],
    ["runRetentionScheduler", "retentionSchedulerPromise"],
    ["runReminderDeliveryAlertScheduler", "reminderDeliveryAlertPromise"],
  ]) {
    const body = block(server, `function ${fn}(`);
    assert.match(
      body,
      // The five are written in three shapes - one line, wrapped, and braced - because Prettier
      // breaks them differently by length. The condition and the return are asserted exactly; only
      // the formatting between them is allowed to vary.
      new RegExp(`if \\(shuttingDown \\|\\| ${promise}\\)\\s*\\{?\\s*return ${promise};`),
      `${fn} can run twice at once - a pass slower than its interval is then joined by the next, ` +
        `and each pass holds pool connections`,
    );
    assert.match(
      body,
      new RegExp(`${promise} = null;`),
      `${fn} never clears ${promise}, so it would run exactly once and never again`,
    );
  }
});

test("a shutdown waits for the reminder pass it started", () => {
  const shutdown = block(server, "async function gracefulShutdown(");

  // Abandoning a pass mid-list can deliver a reminder and exit before recording it, which reads
  // afterwards as a reminder that never went out.
  assert.match(
    shutdown,
    /reminderSchedulerPromise/,
    "shutdown waits for the other four schedulers but not this one",
  );

  for (const promise of [
    "automationWorkerPromise",
    "digestSchedulerPromise",
    "retentionSchedulerPromise",
    "reminderDeliveryAlertPromise",
  ]) {
    assert.match(shutdown, new RegExp(promise), `shutdown no longer waits for ${promise}`);
  }

  // And it must still be unable to wait forever.
  assert.match(shutdown, /Forced shutdown after/, "the forced-exit backstop is gone");
});

test("the reminder pass stops when a shutdown begins", () => {
  const body = block(server, "function runReminderScheduler(");
  assert.match(
    body,
    /for \(const reminder of activeReminders\) \{\s*(?:\/\/[^\n]*\n\s*)*if \(shuttingDown\) break;/,
    "the loop does not check for shutdown, so a long list holds the process open past its deadline",
  );
});
