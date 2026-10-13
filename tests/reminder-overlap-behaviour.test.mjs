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
 * A module-level numeric constant, read from server.js itself.
 *
 * Hard-coding these here would let the test and the code disagree silently: the batch size could be
 * changed in server.js and every assertion below would still pass against the old number.
 */
function constantFromSource(name) {
  const match = new RegExp(`const ${name} = ([0-9_]+);`).exec(source);
  assert.ok(match, `${name} is gone from server.js`);
  return Number(match[1].replace(/_/g, ""));
}

const BATCH_SIZE = constantFromSource("REMINDER_SCAN_BATCH_SIZE");
const MAX_BATCHES = constantFromSource("REMINDER_SCAN_MAX_BATCHES");

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
  // passes and queries are counted separately. The pass now reads in keyset batches, so one pass
  // makes SEVERAL find() calls - conflating the two would make "a second pass ran" and "a second
  // batch was fetched" indistinguishable, and every overlap assertion below depends on telling
  // them apart. isFeatureEnabled is called exactly once per pass, which is what makes it the
  // honest place to count passes.
  const calls = { passes: 0, starts: 0, processed: [], errors: [], queries: [], limits: [] };

  const factory = new Function(
    "deps",
    `
    let shuttingDown = false;
    let reminderSchedulerPromise = null;
    // The real values, read out of server.js above. Supplying them rather than inlining numbers is
    // what keeps this harness honest when the batch size changes.
    const REMINDER_SCAN_BATCH_SIZE = ${BATCH_SIZE};
    const REMINDER_SCAN_MAX_BATCHES = ${MAX_BATCHES};
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
    AppConfig: {
      isFeatureEnabled: async () => {
        calls.passes += 1;
        return true;
      },
    },
    Reminder: {
      // The real call is Reminder.find(filter).sort({_id:1}).limit(n) and is awaited, so the stub
      // has to be chainable AND thenable. Returning a plain array here would make the batching
      // tests pass against a shape the code does not actually use.
      find(filter) {
        calls.starts += 1;
        calls.queries.push(filter);
        let limit = Infinity;

        const after = filter?._id?.$gt ?? null;
        const page = () => {
          const from = after === null ? 0 : reminders.findIndex((r) => r._id === after) + 1;
          return reminders.slice(from, from + limit);
        };

        const chain = {
          sort() {
            return chain;
          },
          limit(n) {
            limit = n;
            calls.limits.push(n);
            return chain;
          },
          then(resolve, reject) {
            const run = async () => {
              if (onFind) await onFind();
              return page();
            };
            return run().then(resolve, reject);
          },
        };
        return chain;
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

/**
 * A pass held open at its first reminder, and a promise that resolves once it is genuinely there.
 *
 * These tests used to advance the pass with a fixed number of `await Promise.resolve()` ticks. That
 * was luck dressed as a test: adding the batch query put one more await in front of the first
 * reminder, and the tick count silently stopped reaching it - the assertion then read "0 processed"
 * and looked like a real failure of the shutdown check. Signalling from inside onProcess is exact,
 * and stays exact however many awaits the pass grows.
 */
function passHeldAtFirstReminder(reminders) {
  const reached = deferred();
  const release = deferred();
  const scheduler = buildScheduler({
    reminders,
    onProcess: async () => {
      reached.resolve();
      await release.promise;
    },
  });
  return { scheduler, reached: reached.promise, release };
}

test("a second run arriving during the first is coalesced, not started", async () => {
  const { scheduler, reached, release } = passHeldAtFirstReminder([
    { id: "a", _id: "a" },
    { id: "b", _id: "b" },
  ]);

  const first = scheduler.run();
  await reached;

  const second = scheduler.run();
  assert.equal(second, first, "the second call started a new pass instead of returning the first");
  assert.equal(scheduler.calls.passes, 1, "a second pass ran");

  release.resolve();
  await first;

  assert.equal(scheduler.calls.passes, 1, "a second pass began after all");
  assert.deepEqual(scheduler.calls.processed, ["a", "b"], "the first pass did not finish its list");
});

test("a later run executes normally once the first has finished", async () => {
  // The guard must coalesce, not disable. A guard that never clears turns a 15-minute scheduler
  // into a run-once-per-boot scheduler, and nothing would report it.
  const scheduler = buildScheduler({ reminders: [{ id: "a", _id: "a" }] });

  await scheduler.run();
  assert.equal(scheduler.inFlight(), null, "the guard was not cleared after a clean pass");

  await scheduler.run();
  await scheduler.run();
  assert.equal(scheduler.calls.passes, 3, "later ticks were suppressed by a stuck guard");
  assert.deepEqual(scheduler.calls.processed, ["a", "a", "a"]);
});

test("the guard resets when a pass throws, and the next run proceeds", async () => {
  // A latch that survives an exception is worse than no latch: it fails silent and permanent.
  const scheduler = buildScheduler({
    reminders: [{ id: "boom", _id: "boom" }],
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
  assert.equal(scheduler.calls.passes, 2, "a throw disabled every future pass");
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
    reminders: [{ id: "a", _id: "a" }],
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
    reminders: [{ id: "a", _id: "a" }, { id: "bad", _id: "bad" }, { id: "c", _id: "c" }],
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
  const scheduler = buildScheduler({ reminders: [{ id: "a", _id: "a" }] });
  scheduler.setShuttingDown(true);

  const result = scheduler.run();
  assert.equal(result, null, "a pass was started during shutdown");
  assert.equal(scheduler.calls.passes, 0, "a pass began during shutdown");
});

test("a pass in flight stops early when a shutdown begins", async () => {
  // The forced-exit backstop is 10 seconds. A long list that ignores shutdown would be killed
  // mid-reminder rather than stopping between them.
  const { scheduler, reached, release } = passHeldAtFirstReminder([
    { id: "a", _id: "a" },
    { id: "b", _id: "b" },
    { id: "c", _id: "c" },
    { id: "d", _id: "d" },
  ]);

  const pass = scheduler.run();
  await reached;

  scheduler.setShuttingDown(true);
  release.resolve();
  await pass;

  assert.equal(
    scheduler.calls.processed.length,
    1,
    `the pass continued through ${scheduler.calls.processed.length} reminders after shutdown began`,
  );
});

// ── keyset batching ─────────────────────────────────────────────────────
// The pass used to read every active reminder in the product in one unbounded find(), hydrated as
// full documents and held for the whole pass. It grew with total usage rather than with any one
// firm, and it was the last unbounded read in this incident's path.
//
// The property that matters most is NOT that it is bounded. It is that it is bounded AND still
// reaches every reminder: a .limit() alone would bound it by silently not sending the rest.

const many = (n) =>
  Array.from({ length: n }, (_, i) => {
    const id = `r${String(i).padStart(5, "0")}`;
    return { id, _id: id };
  });

test("every reminder is processed even when it takes several batches", async () => {
  const total = BATCH_SIZE * 2 + 7;
  const scheduler = buildScheduler({ reminders: many(total) });

  await scheduler.run();

  assert.equal(
    scheduler.calls.processed.length,
    total,
    `${total - scheduler.calls.processed.length} reminders were never processed`,
  );
  // In order, and each exactly once - a keyset that repeated or skipped a page would show here.
  assert.deepEqual(
    scheduler.calls.processed,
    many(total).map((r) => r.id),
    "reminders were processed out of order, repeated, or skipped",
  );
});

test("no single query asks for more than one batch", async () => {
  // This is the bound. If any query goes back to being unbounded, the memory problem returns
  // whatever else the loop does.
  const scheduler = buildScheduler({ reminders: many(BATCH_SIZE * 2 + 7) });
  await scheduler.run();

  assert.ok(scheduler.calls.limits.length > 0, "no query carried a limit at all");
  for (const limit of scheduler.calls.limits) {
    assert.equal(limit, BATCH_SIZE, `a query asked for ${limit} rows instead of ${BATCH_SIZE}`);
  }
});

test("each batch after the first resumes from the last id, not from an offset", async () => {
  // Keyset, not skip/limit. An offset would re-read rows already passed and could drop a reminder
  // whenever the set shifts underneath it - exactly what a scheduler running against live data does.
  const scheduler = buildScheduler({ reminders: many(BATCH_SIZE * 2 + 7) });
  await scheduler.run();

  const [first, ...rest] = scheduler.calls.queries;
  assert.equal(first._id, undefined, "the first query already carried a resume point");
  assert.ok(rest.length >= 2, "the pass did not make the batches it should have");

  for (const query of rest) {
    assert.ok(query?._id?.$gt, "a later query did not resume from the previous batch's last id");
    assert.equal(query.isActive, true, "a later query lost the isActive filter");
  }

  // And the resume points advance strictly.
  const resumePoints = rest.map((q) => q._id.$gt);
  for (let i = 1; i < resumePoints.length; i += 1) {
    assert.ok(
      resumePoints[i] > resumePoints[i - 1],
      `resume point went backwards: ${resumePoints[i - 1]} -> ${resumePoints[i]}`,
    );
  }
});

test("a short batch ends the pass without one more empty query", async () => {
  // Cheap, but it is also the termination condition. If this stopped working the pass would make
  // one wasted round trip per tick forever.
  const scheduler = buildScheduler({ reminders: many(BATCH_SIZE - 1) });
  await scheduler.run();

  assert.equal(scheduler.calls.queries.length, 1, "a short first batch did not end the pass");
  assert.equal(scheduler.calls.processed.length, BATCH_SIZE - 1);
});

test("an exactly-full final batch is followed by one query that finds nothing", async () => {
  // The boundary case the short-batch check cannot cover: when the last batch is exactly full,
  // the pass cannot know it is the last without asking once more.
  const scheduler = buildScheduler({ reminders: many(BATCH_SIZE) });
  await scheduler.run();

  assert.equal(scheduler.calls.queries.length, 2, "the pass stopped without confirming it was done");
  assert.equal(scheduler.calls.processed.length, BATCH_SIZE, "the full batch was not fully processed");
});

test("stopping at the batch cap says so, instead of ending quietly", async () => {
  // A pass that stopped early and said nothing would look exactly like a pass that finished, and
  // the reminders it never reached would simply not go out.
  const scheduler = buildScheduler({ reminders: many(BATCH_SIZE * (MAX_BATCHES + 2)) });
  await scheduler.run();

  assert.ok(
    scheduler.calls.queries.length <= MAX_BATCHES + 1,
    `the cap did not hold: ${scheduler.calls.queries.length} queries`,
  );
  const announced = scheduler.calls.errors.find((line) => line.includes("stopped after"));
  assert.ok(announced, "the pass stopped at the cap without reporting it");
  assert.match(announced, /More remain/, "the notice does not say that reminders were left unsent");
  assert.match(announced, /\d+ reminders/, "the notice does not say how many were processed");
});
