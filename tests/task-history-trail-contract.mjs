// tests/task-history-trail-contract.mjs
//
// Part 3.4 and 3.5 of TASK-MANAGEMENT-PLAN.md: every task mutation leaves a before/after trail, and
// one route reads it back.
//
// WHY THIS IS A QUERY AND NOT A FIELD. The owner asked to see "whom task was assigned before".
// ActivityEvent already exists, is already firm-scoped and is already this backend's audit surface,
// so the history is a query over it. A second private history array on Task would be a second thing
// to keep true, and the two would eventually disagree about the same reassignment.
//
// THE FACT THAT MADE THIS NECESSARY: before this change task.controller.js recorded NO activity at
// all. The trail existed and tasks did not use it, so "assigned to whom before" was not merely
// unshown - it was never written down, and no amount of reading the database afterwards could
// recover it.
//
// Two properties are pinned here that are easy to lose later:
//   1. A no-op edit records NOTHING. Forms that post every field they know about save constantly,
//      and a trail that logs each one becomes unreadable and hides the changes that mattered.
//   2. The trail can never fail the user's write. safeRecordActivity swallows its own errors, and
//      the test for it forces a failure and then asserts the task was still saved.

import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV || "development";
process.env.JWT_SECRET = process.env.JWT_SECRET || "local-verification-only";
process.env.MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/capro-task-trail-check";

const { default: Task } = await import("../src/models/Task.js");
const { default: User } = await import("../src/models/User.js");
const { default: ActivityEvent } = await import("../src/models/ActivityEvent.js");
const { updateTask, getTaskHistory } = await import(
  "../src/controllers/task.controller.js"
);

// Real ObjectId-shaped ids throughout, so ActivityEvent's own casting is exercised rather than
// sidestepped. Fake ids like "user-1" make the trail write fail for the wrong reason.
const FIRM = "6a65b73e8952e7e690a33589";
const ACTOR = "6a0d4094df5a97c1a82dfdee";
const OTHER_STAFF = "6a15a2fb852884d3f1480aeb";
const TASK = "6a65b73e8952e7e690a33590";

const originals = {
  taskFindOne: Task.findOne,
  userFindOne: User.findOne,
  activitySave: ActivityEvent.prototype.save,
  activityFind: ActivityEvent.find,
};

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  return fn()
    .then(() => {
      passed++;
    })
    .catch((error) => {
      failed++;
      failures.push(`${name}: ${error.message}`);
    });
}

function fakeReq({ body = {}, taskId = TASK } = {}) {
  return { user: { id: ACTOR, firmId: FIRM }, params: { id: taskId }, body };
}

function fakeRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

function fakeTaskDocument(overrides = {}) {
  let saveCount = 0;
  const doc = {
    _id: TASK,
    firmId: FIRM,
    isActive: true,
    status: "NOT_STARTED",
    title: "GSTR-3B Apr 2025",
    dueDateISO: "2025-05-20",
    remarks: "",
    assignedTo: null,
    assigneeReadAt: null,
    assigneeReadBy: null,
    reviewStatus: "NOT_REQUIRED",
    mutationVersion: 1,
    meta: {},
    async save() {
      saveCount += 1;
      return doc;
    },
    get saveCount() {
      return saveCount;
    },
    ...overrides,
  };
  return doc;
}

let recorded = [];

function stubTaskFindOne(document) {
  // The FILTER is captured, not just the result. A stub that returns null on request would let a
  // cross-firm test pass for the wrong reason - it would prove the stub was told to return nothing,
  // not that the query was scoped to the caller's firm. A mutation that dropped firmId from this
  // lookup survived until this captured the filter.
  stubTaskFindOne.lastFilter = null;
  Task.findOne = (filter) => {
    stubTaskFindOne.lastFilter = filter;
    return {
      then: (ok, no) => Promise.resolve(document).then(ok, no),
      lean: () => Promise.resolve(document),
    };
  };
}

function stubUserFindOne(user) {
  User.findOne = () => ({ lean: () => Promise.resolve(user) });
}

function captureActivity({ fail = false } = {}) {
  recorded = [];
  ActivityEvent.prototype.save = function save() {
    if (fail) {
      return Promise.reject(new Error("the trail is unavailable"));
    }
    recorded.push(this);
    return Promise.resolve(this);
  };
}

// ---------------------------------------------------------------- the trail on a reassignment

await test("a reassignment records who held it BEFORE", async () => {
  // The whole reason Part 3.4 exists. Without the before half, "assigned to whom previously" is
  // unanswerable no matter how the screen is built.
  const document = fakeTaskDocument({ assignedTo: ACTOR });
  stubTaskFindOne(document);
  stubUserFindOne({ _id: OTHER_STAFF });
  captureActivity();

  await updateTask(fakeReq({ body: { assignedTo: OTHER_STAFF } }), fakeRes());

  assert.equal(recorded.length, 1, "exactly one event for one edit");
  const event = recorded[0];
  assert.equal(event.action, "task.reassigned");
  assert.equal(event.entityType, "Task");
  assert.equal(String(event.entityId), TASK);
  assert.equal(event.beforeSummary.assignedTo, ACTOR, "the PREVIOUS holder must be recorded");
  assert.equal(event.afterSummary.assignedTo, OTHER_STAFF);
});

await test("an ordinary edit is recorded as an update, not a reassignment", async () => {
  const document = fakeTaskDocument({ assignedTo: ACTOR });
  stubTaskFindOne(document);
  captureActivity();

  await updateTask(fakeReq({ body: { status: "IN_PROGRESS" } }), fakeRes());

  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].action, "task.updated");
  assert.equal(recorded[0].beforeSummary.status, "NOT_STARTED");
  assert.equal(recorded[0].afterSummary.status, "IN_PROGRESS");
});

await test("the changed fields are named, so a reader need not diff two blobs", async () => {
  const document = fakeTaskDocument({ assignedTo: ACTOR });
  stubTaskFindOne(document);
  captureActivity();

  await updateTask(
    fakeReq({ body: { status: "IN_PROGRESS", remarks: "Chase the client" } }),
    fakeRes(),
  );

  const changed = recorded[0].metadata.changed;
  assert.ok(changed.includes("status"), "status must be listed");
  assert.ok(changed.includes("remarks"), "remarks must be listed");
  assert.ok(!changed.includes("title"), "an untouched field must not be listed");
});

await test("an edit that changes nothing records nothing", async () => {
  // A form that posts every field it knows about saves constantly. A trail that logged each one
  // would bury the changes that mattered under no-ops.
  const document = fakeTaskDocument({ assignedTo: ACTOR, status: "IN_PROGRESS" });
  stubTaskFindOne(document);
  stubUserFindOne({ _id: ACTOR });
  captureActivity();

  await updateTask(
    fakeReq({
      body: {
        assignedTo: ACTOR,
        status: "IN_PROGRESS",
        title: "GSTR-3B Apr 2025",
      },
    }),
    fakeRes(),
  );

  assert.equal(recorded.length, 0, "a no-op edit must leave no trail entry");
});

await test("the trail never fails the user's write", async () => {
  // Forced failure. safeRecordActivity swallows it; the task must still be saved and the caller must
  // still get a 200. A missing audit line is a gap - a refused edit is lost work.
  const document = fakeTaskDocument({ assignedTo: ACTOR });
  stubTaskFindOne(document);
  captureActivity({ fail: true });
  const res = fakeRes();

  await updateTask(fakeReq({ body: { status: "IN_PROGRESS" } }), res);

  assert.equal(res.statusCode, 200, "the edit must succeed even when the trail cannot be written");
  assert.equal(document.saveCount, 1);
  assert.equal(document.status, "IN_PROGRESS");
});

// ---------------------------------------------------------------- reading it back

function stubActivityFind(events) {
  let capturedFilter = null;
  ActivityEvent.find = (filter) => {
    capturedFilter = filter;
    const chain = {
      sort: () => chain,
      limit: () => chain,
      populate: () => chain,
      lean: () => Promise.resolve(events),
      get filter() {
        return capturedFilter;
      },
    };
    stubActivityFind.lastFilter = filter;
    return chain;
  };
}

await test("the history reads back the trail for one task", async () => {
  stubTaskFindOne(fakeTaskDocument());
  stubActivityFind([
    {
      _id: "e2",
      action: "task.reassigned",
      occurredAt: new Date("2026-09-02T09:00:00.000Z"),
      actorUserId: { _id: ACTOR, name: "A Partner", email: "partner@example.com" },
      beforeSummary: { assignedTo: ACTOR },
      afterSummary: { assignedTo: OTHER_STAFF },
      metadata: { changed: ["assignedTo"] },
    },
  ]);
  const res = fakeRes();

  await getTaskHistory(fakeReq(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.events.length, 1);
  const event = res.body.events[0];
  assert.equal(event.action, "task.reassigned");
  assert.equal(event.actor.name, "A Partner");
  assert.equal(event.before.assignedTo, ACTOR, "the reader can see who held it before");
  assert.equal(event.after.assignedTo, OTHER_STAFF);
  assert.deepEqual(event.changed, ["assignedTo"]);
});

await test("the history is scoped to the caller's firm and to that task", async () => {
  stubTaskFindOne(fakeTaskDocument());
  stubActivityFind([]);

  await getTaskHistory(fakeReq(), fakeRes());

  const filter = stubActivityFind.lastFilter;
  assert.equal(filter.firmId, FIRM, "another tenant's events must be unreachable");
  assert.equal(filter.entityType, "Task");
  assert.equal(filter.entityId, TASK);

  // And the TASK lookup itself is firm-scoped, which is the first of the two gates. Asserted on the
  // captured filter rather than inferred from a null result: dropping firmId here would let a
  // caller confirm that a task exists inside a firm they are not a member of, and a mutation that
  // did exactly that survived until this assertion existed.
  assert.equal(
    stubTaskFindOne.lastFilter.firmId,
    FIRM,
    "the task lookup must be scoped to the caller's firm",
  );
});

await test("another firm's task has no history, and says not found", async () => {
  // The task lookup is firm-scoped, so this is a 404 before any event is read - the route cannot be
  // used to discover that a task exists in a firm the caller is not in.
  stubTaskFindOne(null);
  const res = fakeRes();

  await getTaskHistory(fakeReq({ taskId: "6a65b73e8952e7e690a3359f" }), res);

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.ok, false);
});

await test("an event with no actor still renders", async () => {
  // Automation and imports write activity with no actorUserId. A history that threw on those would
  // fail exactly when somebody is investigating an automated change.
  stubTaskFindOne(fakeTaskDocument());
  stubActivityFind([
    {
      _id: "e1",
      action: "task.created",
      occurredAt: new Date("2026-09-01T09:00:00.000Z"),
      actorUserId: null,
      beforeSummary: null,
      afterSummary: { status: "NOT_STARTED" },
      metadata: {},
    },
  ]);
  const res = fakeRes();

  await getTaskHistory(fakeReq(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.events[0].actor, null);
  assert.equal(res.body.events[0].changed, null);
});

Task.findOne = originals.taskFindOne;
User.findOne = originals.userFindOne;
ActivityEvent.prototype.save = originals.activitySave;
ActivityEvent.find = originals.activityFind;

console.log(`task history trail contract: ${passed}/${passed + failed}`);
for (const failure of failures) {
  console.log(`  FAIL ${failure}`);
}
process.exitCode = failed > 0 ? 1 : 0;
