// The reminder overlap guard, RUN rather than read.
//
// tests/outage-hardening.test.mjs asserts the guard is present in the source. That is not the same
// as knowing it works: a guard can be present and still let two passes run, or present and latch
// permanently after a throw, and the source reads identically either way.
//
// server.js cannot be imported to test this - importing it calls app.listen() and connects to
// MongoDB, and the URI in this project's environment is PRODUCTION. A second process running a
// second reminder scheduler against live data would send duplicate reminder emails to real people.
//
// So this uses the pattern server.js already documents for completeDigestStartup: extract the
// function's source and evaluate it in isolation against stubs. The function body under test is
// byte-for-byte the deployed one; only its module-level bindings are supplied by this file.
//
//   node --test capro-backend/tests/reminder-overlap-behaviour.test.mjs

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "src/server.js"), "utf8").replace(/\r\n/g, "\n");

/** The real function's source text, from `function runReminderScheduler(` to its closing brace. */
function extractScheduler() {
  const start = source.indexOf("function runReminderScheduler(");
  assert.ok(start >= 0, "runReminderScheduler is gone or was renamed");
  const from = source.indexOf("{", start);
  let depth = 0;
  for (let i = from; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced function body");
}

const SCHEDULER_SOURCE = extractScheduler();

/**
 * Build a runnable copy of the real function over controllable stubs.
 *
 * `shuttingDown` and `reminderSchedulerPromise` are module-level `let`s in server.js, so they are
 * declared here in the same shape - a closure variable the function reads and writes - rather than
 * as an object property, which would not reproduce the assignment semantics being tested.
 */
function buildScheduler({
  reminders = [],
  onProcess = async () => {},
  onFind = null,
} = {}) {
  const calls = { starts: 0, processed: [], errors: [] };

  const factory = new Function(
    "deps",
    `
    let shuttingDown = false;
    let reminderSchedulerPromise = null;
    const { AppConfig, Reminder, processReminderForNow, console } = deps;
    ${SCHEDULER_SOURCE}
    return {
      run: runReminderScheduler,
      setShuttingDown: (v) => { shuttingDown = v; },
      inFlight: () => reminderSchedulerPromise,
    };
    `,
  );

  const harness = factory({
    AppConfig: { isFeatureEnabled: async () => true },
    Reminder: {
      find: async () => {
        calls.starts += 1;
        if (onFind) await onFind();
        return reminders;
      },
    },
    processReminderForNow: async (reminder) => {
      calls.processed.push(reminder.id);
      await onProcess(reminder);
    },
    // Swallow the function's own logging so a passing run is quiet, but keep the errors it reports.
    console: {
      log: () => {},
      error: (...args) => calls.errors.push(args.map(String).join(" ")),
    },
  });

  return { ...harness, calls };
}

/** A promise plus the handles to settle it from outside. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("a second run arriving during the first is coalesced, not started", async () => {
  const gate = deferred();
  const scheduler = buildScheduler({
    reminders: [{ id: "a" }, { id: "b" }],
    onProcess: () => gate.promise,
  });

  const first = scheduler.run();
  // Let the pass reach its first reminder and block there.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  const second = scheduler.run();
  assert.equal(second, first, "the second call started a new pass instead of returning the first");
  assert.equal(scheduler.calls.starts, 1, "the reminder list was queried twice - two passes ran");

  gate.resolve();
  await first;

  assert.equal(scheduler.calls.starts, 1, "a second pass began after all");
  assert.deepEqual(scheduler.calls.processed, ["a", "b"], "the first pass did not finish its list");
});

test("a later run executes normally once the first has finished", async () => {
  // The guard must coalesce, not disable. A guard that never clears turns a 15-minute scheduler
  // into a run-once-per-boot scheduler, and nothing would report it.
  const scheduler = buildScheduler({ reminders: [{ id: "a" }] });

  await scheduler.run();
  assert.equal(scheduler.inFlight(), null, "the guard was not cleared after a clean pass");

  await scheduler.run();
  await scheduler.run();
  assert.equal(scheduler.calls.starts, 3, "later ticks were suppressed by a stuck guard");
  assert.deepEqual(scheduler.calls.processed, ["a", "a", "a"]);
});

test("the guard resets when a pass throws, and the next run proceeds", async () => {
  // A latch that survives an exception is worse than no latch: it fails silent and permanent.
  const scheduler = buildScheduler({
    reminders: [{ id: "boom" }],
    onProcess: async () => {
      throw new Error("delivery exploded");
    },
  });

  await scheduler.run();
  assert.equal(scheduler.inFlight(), null, "the guard stayed set after a pass that threw");
  assert.ok(
    scheduler.calls.errors.some((line) => line.includes("delivery exploded")),
    "the failure was swallowed without being reported",
  );

  // And the next tick still runs.
  await scheduler.run();
  assert.equal(scheduler.calls.starts, 2, "a throw disabled every future pass");
});

test("a query that fails does not latch the guard, and the next pass runs", async () => {
  // This is now a REAL path, not a hypothetical one. Setting waitQueueTimeoutMS means a saturated
  // pool no longer queues forever - it REJECTS. So the very condition this whole change was made
  // for is one that now makes Reminder.find throw, and the scheduler meets it first.
  //
  // If that rejection escaped the pass, the guard would never clear and the reminder scheduler
  // would go silent for the life of the process: the quiet, permanent failure that is worse than
  // the loud one it replaced.
  let fail = true;
  const scheduler = buildScheduler({
    reminders: [{ id: "a" }],
    onFind: async () => {
      if (fail) throw new Error("connection pool timed out");
    },
  });

  await scheduler.run();
  assert.equal(scheduler.inFlight(), null, "a failed query left the guard set");
  assert.ok(
    scheduler.calls.errors.some((line) => line.includes("connection pool timed out")),
    "the query failure was swallowed without being reported",
  );

  fail = false;
  await scheduler.run();
  assert.deepEqual(
    scheduler.calls.processed,
    ["a"],
    "the scheduler never recovered after one failed query",
  );
});

test("a failure inside one reminder does not abandon the rest of the list", async () => {
  const scheduler = buildScheduler({
    reminders: [{ id: "a" }, { id: "bad" }, { id: "c" }],
    onProcess: async (reminder) => {
      if (reminder.id === "bad") throw new Error("one bad reminder");
    },
  });

  await scheduler.run();
  assert.deepEqual(
    scheduler.calls.processed,
    ["a", "bad", "c"],
    "one failing reminder stopped the pass; the reminders after it were never processed",
  );
});

test("no pass starts once a shutdown has begun", async () => {
  const scheduler = buildScheduler({ reminders: [{ id: "a" }] });
  scheduler.setShuttingDown(true);

  const result = scheduler.run();
  assert.equal(result, null, "a pass was started during shutdown");
  assert.equal(scheduler.calls.starts, 0, "the reminder list was queried during shutdown");
});

test("a pass in flight stops early when a shutdown begins", async () => {
  // The forced-exit backstop is 10 seconds. A long list that ignores shutdown would be killed
  // mid-reminder rather than stopping between them.
  const gate = deferred();
  let seen = 0;
  const scheduler = buildScheduler({
    reminders: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
    onProcess: async () => {
      seen += 1;
      if (seen === 1) await gate.promise;
    },
  });

  const pass = scheduler.run();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  scheduler.setShuttingDown(true);
  gate.resolve();
  await pass;

  assert.equal(
    scheduler.calls.processed.length,
    1,
    `the pass continued through ${scheduler.calls.processed.length} reminders after shutdown began`,
  );
});
