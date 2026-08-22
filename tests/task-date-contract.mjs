// tests/task-date-contract.mjs
//
// Ledger task C13 (.kiro/finalreleasefix.md). createTask did
// `dueDateISO: new Date(dueDateISO).toISOString()` with no guard at all -- the exact
// silent day-first/month-first misread C10 exists to close everywhere else in this
// backend. reminder.controller.js's createReminder, right next to it in the same
// feature area, already fixed this with parseStatutoryDayIso(dueDateISO, "dueDateISO")
// (see robust-normalize.service.js); createTask was missed. This file pins that guard
// on both createTask and updateTask (same file, identical hazard on the same field),
// so a statutory task due date typed or posted as "03/05/2026" is refused rather than
// silently stored as 5 March read as 3 May, or vice versa.
//
// Ledger task C14 extends this same file (rather than creating a new one -- this
// backend has no pre-existing bulk-task contract test file, and C14's own text names
// this file as the natural place to extend). task-bulk.service.js's normalizePatch had
// the identical unguarded `new Date(rawPatch.dueDateISO)` on the bulk task-patch path
// (TaskBulkPage's preview/commit flow), found while doing C13. The section below pins
// previewTaskBulk's guard on that same field, matching the SAME per-item-invalid
// TaskBulkError shape this function already uses for an invalid status/assignedTo --
// confirmed by reading normalizePatch directly: a structurally invalid patch field
// (bad status enum, malformed assignedTo, and now malformed/ambiguous dueDateISO)
// throws TaskBulkError synchronously from normalizeItems, which previewTaskBulk never
// catches internally, so the WHOLE preview request rejects with 400 TASK_BULK_INVALID
// before any task is read -- there is no per-item FAILED entry for this class of error.
// (The per-item FAILED/"TASK_NOT_FOUND"/"ASSIGNEE_NOT_IN_FIRM" shape is a DIFFERENT,
// later stage reserved for runtime/DB-dependent checks after normalization already
// succeeded -- not the shape a malformed dueDateISO belongs to.)
//
// Documents the raw hazard first (matching the pattern already used in
// tests/import-date-order-contract.mjs and C10's own evidence log), then proves the
// route-level guard closes it:
//   new Date('05-03-2026').getUTCMonth() === 4        -- reads as May, not 5 March
//   new Date('03/05/2026').toISOString()  starts '2026-03-04' -- reads as 5 March, one
//                                                                 day early once shifted to UTC
//
// Monkey-patches Task.prototype.save and Task.findOne, matching the pattern already
// used for directly-imported Mongoose models in tests/task-version-guard-contract.mjs
// and tests/taxworker-duplicate-audit-contract.mjs. The C14 section below monkey-patches
// Task.find / User.find / TaskBulkOperation.create the same way, so previewTaskBulk's
// real exported code runs unmodified against an in-memory stand-in rather than a live
// Mongo (the live end-to-end preview->commit->stored-on-task proof runs separately
// against the real capro-mongo-dev container, recorded in this task's own evidence).
//
// Run: node tests/task-date-contract.mjs

import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV || "development";
process.env.JWT_SECRET = process.env.JWT_SECRET || "local-verification-only";
process.env.MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/capro-task-date-check";

const { default: Task } = await import("../src/models/Task.js");
const { default: User } = await import("../src/models/User.js");
const { default: TaskBulkOperation } = await import(
  "../src/models/TaskBulkOperation.js"
);
const { createTask, updateTask } = await import(
  "../src/controllers/task.controller.js"
);
const { previewTaskBulk, TaskBulkError } = await import(
  "../src/services/task-bulk.service.js"
);

const originals = {
  save: Task.prototype.save,
  findOne: Task.findOne,
  taskFind: Task.find,
  userFind: User.find,
  bulkOperationCreate: TaskBulkOperation.create,
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

// ─── Negative control: the raw hazard this guard exists to close ────────

{
  const misreadAsMay = new Date("05-03-2026").getUTCMonth() === 4;
  assert.equal(
    misreadAsMay,
    true,
    "negative control failed: this Node runtime no longer mis-reads '05-03-2026' as " +
      "May, so the guard below would not be proving anything",
  );

  const shiftedDayEarly =
    new Date("03/05/2026").toISOString().slice(0, 10) === "2026-03-04";
  assert.equal(
    shiftedDayEarly,
    true,
    "negative control failed: this machine's UTC offset no longer shifts " +
      "'03/05/2026' a day early, so the guard below would not be proving anything",
  );
}
passed++; // negative control counts as one passing check, matching C10's convention

function fakeCreateReq(body) {
  return {
    user: { id: "670aaa11bb22cc33dd44ee01", firmId: "670aaa11bb22cc33dd44ee02" },
    body,
  };
}

function fakeUpdateReq(body, taskId = "task-1") {
  return {
    user: { id: "670aaa11bb22cc33dd44ee01", firmId: "670aaa11bb22cc33dd44ee02" },
    params: { id: taskId },
    body,
  };
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

function stubCreateSave(capture) {
  Task.prototype.save = async function save() {
    capture.push(this);
    return this;
  };
}

function fakeTaskDocument({ dueDateISO = "2026-01-01T00:00:00.000Z" } = {}) {
  let saveCount = 0;
  const doc = {
    _id: "task-1",
    firmId: "670aaa11bb22cc33dd44ee02",
    isActive: true,
    status: "IN_PROGRESS",
    title: "GSTR-3B Apr 2025",
    dueDateISO,
    mutationVersion: 1,
    meta: {},
    async save() {
      saveCount += 1;
      return doc;
    },
    get saveCount() {
      return saveCount;
    },
  };
  return doc;
}

function stubUpdateFindOne(document) {
  Task.findOne = () => ({
    then: (onFulfilled, onRejected) =>
      Promise.resolve(document).then(onFulfilled, onRejected),
  });
}

// ─── createTask ───────────────────────────────────────────────────────

await test("createTask refuses ambiguous dueDateISO '05-03-2026' with 400, never saves", async () => {
  const saved = [];
  stubCreateSave(saved);
  const req = fakeCreateReq({
    clientName: "Acme & Co",
    title: "GSTR-3B Apr 2025",
    dueDateISO: "05-03-2026",
  });
  const res = fakeRes();

  await createTask(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { ok: false, error: "Invalid dueDateISO" });
  assert.equal(saved.length, 0, "an ambiguous date must never reach save()");
});

await test("createTask refuses ambiguous dueDateISO '03/05/2026' with 400, never saves", async () => {
  const saved = [];
  stubCreateSave(saved);
  const req = fakeCreateReq({
    clientName: "Acme & Co",
    title: "GSTR-3B Apr 2025",
    dueDateISO: "03/05/2026",
  });
  const res = fakeRes();

  await createTask(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { ok: false, error: "Invalid dueDateISO" });
  assert.equal(saved.length, 0, "an ambiguous date must never reach save()");
});

await test("createTask accepts unambiguous dueDateISO '2026-03-05' and stores exactly that day", async () => {
  const saved = [];
  stubCreateSave(saved);
  const req = fakeCreateReq({
    clientName: "Acme & Co",
    title: "GSTR-3B Apr 2025",
    dueDateISO: "2026-03-05",
  });
  const res = fakeRes();

  await createTask(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(saved.length, 1, "an unambiguous date must reach save() exactly once");
  assert.equal(
    res.body.task.dueDateISO,
    "2026-03-05T00:00:00.000Z",
    "must be stored as exactly 5 March, never shifted to 4 March or misread as May",
  );
});

// ─── updateTask (same file, same hazard, fixed in the same pass) ───────

await test("updateTask refuses ambiguous dueDateISO '05-03-2026' with 400, never saves", async () => {
  const document = fakeTaskDocument();
  stubUpdateFindOne(document);
  const req = fakeUpdateReq({ dueDateISO: "05-03-2026" });
  const res = fakeRes();

  await updateTask(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { ok: false, error: "Invalid dueDateISO" });
  assert.equal(document.saveCount, 0, "an ambiguous date must never reach save()");
});

await test("updateTask refuses ambiguous dueDateISO '03/05/2026' with 400, never saves", async () => {
  const document = fakeTaskDocument();
  stubUpdateFindOne(document);
  const req = fakeUpdateReq({ dueDateISO: "03/05/2026" });
  const res = fakeRes();

  await updateTask(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { ok: false, error: "Invalid dueDateISO" });
  assert.equal(document.saveCount, 0, "an ambiguous date must never reach save()");
});

await test("updateTask accepts unambiguous dueDateISO '2026-03-05' and stores exactly that day", async () => {
  const document = fakeTaskDocument();
  stubUpdateFindOne(document);
  const req = fakeUpdateReq({ dueDateISO: "2026-03-05" });
  const res = fakeRes();

  await updateTask(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(document.saveCount, 1);
  assert.equal(
    document.dueDateISO,
    "2026-03-05T00:00:00.000Z",
    "must be stored as exactly 5 March, never shifted to 4 March or misread as May",
  );
});

Task.prototype.save = originals.save;
Task.findOne = originals.findOne;

// ─── task-bulk.service.js normalizePatch (C14) ─────────────────────────

const FIRM_ID = "670aaa11bb22cc33dd44ee02";
const ACTOR_ID = "670aaa11bb22cc33dd44ee01";
const TASK_ID = "670aaa11bb22cc33dd44ee03";

function chain(result) {
  return {
    select() {
      return this;
    },
    lean() {
      return Promise.resolve(result);
    },
  };
}

function stubBulkFinds({ tasks = [], users = [] } = {}) {
  Task.find = () => chain(tasks);
  User.find = () => chain(users);
}

function stubBulkOperationCreate(capture) {
  TaskBulkOperation.create = async (payload) => {
    const doc = { _id: "680aaa11bb22cc33dd44ee09", ...payload };
    capture.push(doc);
    return { ...doc, toObject: () => doc };
  };
}

function activeTask(overrides = {}) {
  return {
    _id: TASK_ID,
    status: "IN_PROGRESS",
    assignedTo: null,
    dueDateISO: "2026-01-01T00:00:00.000Z",
    documentReadiness: "UNKNOWN",
    reviewStatus: "NOT_REQUIRED",
    filedAt: null,
    filedBy: null,
    completedAt: null,
    completedBy: null,
    mutationVersion: 0,
    source: "MANUAL",
    isActive: true,
    ...overrides,
  };
}

await test(
  "previewTaskBulk refuses ambiguous dueDateISO '03/05/2026' the same way it refuses an invalid status -- TaskBulkError, whole request rejected, never reaches a task read",
  async () => {
    stubBulkFinds();
    const created = [];
    stubBulkOperationCreate(created);

    let ambiguousError;
    try {
      await previewTaskBulk({
        firmId: FIRM_ID,
        actorUserId: ACTOR_ID,
        rawItems: [{ taskId: TASK_ID, patch: { dueDateISO: "03/05/2026" } }],
      });
    } catch (error) {
      ambiguousError = error;
    }
    assert.ok(ambiguousError instanceof TaskBulkError, "must reject with TaskBulkError");
    assert.equal(ambiguousError.status, 400);
    assert.equal(ambiguousError.code, "TASK_BULK_INVALID");
    assert.equal(ambiguousError.message, "items[0].patch.dueDateISO is invalid");

    // Same shape as an existing invalid field in the same function (status), proving
    // this is the pre-existing convention, not a new error surface invented for dates.
    let statusError;
    try {
      await previewTaskBulk({
        firmId: FIRM_ID,
        actorUserId: ACTOR_ID,
        rawItems: [{ taskId: TASK_ID, patch: { status: "NOT_A_REAL_STATUS" } }],
      });
    } catch (error) {
      statusError = error;
    }
    assert.ok(statusError instanceof TaskBulkError);
    assert.equal(statusError.status, ambiguousError.status);
    assert.equal(statusError.code, ambiguousError.code);
    assert.equal(statusError.message, "items[0].patch.status is invalid");

    assert.equal(
      created.length,
      0,
      "an ambiguous or otherwise invalid patch field must never reach TaskBulkOperation.create"
    );
  }
);

await test(
  "previewTaskBulk refuses ambiguous dueDateISO '05-03-2026' the same way",
  async () => {
    stubBulkFinds();
    const created = [];
    stubBulkOperationCreate(created);

    let error;
    try {
      await previewTaskBulk({
        firmId: FIRM_ID,
        actorUserId: ACTOR_ID,
        rawItems: [{ taskId: TASK_ID, patch: { dueDateISO: "05-03-2026" } }],
      });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof TaskBulkError);
    assert.equal(error.status, 400);
    assert.equal(error.message, "items[0].patch.dueDateISO is invalid");
    assert.equal(created.length, 0);
  }
);

await test(
  "previewTaskBulk accepts unambiguous dueDateISO '2026-03-05' and carries exactly that day into the previewed operation",
  async () => {
    stubBulkFinds({ tasks: [activeTask()] });
    const created = [];
    stubBulkOperationCreate(created);

    const result = await previewTaskBulk({
      firmId: FIRM_ID,
      actorUserId: ACTOR_ID,
      rawItems: [{ taskId: TASK_ID, patch: { dueDateISO: "2026-03-05" } }],
    });

    assert.equal(result.committable, true);
    assert.equal(created.length, 1, "a valid patch must reach TaskBulkOperation.create");
    assert.equal(
      created[0].items[0].patch.dueDateISO,
      "2026-03-05T00:00:00.000Z",
      "must be stored as exactly 5 March, never shifted to 4 March or misread as May"
    );
    assert.equal(
      result.operation.items[0].patch.dueDateISO,
      "2026-03-05T00:00:00.000Z"
    );
  }
);

Task.find = originals.taskFind;
User.find = originals.userFind;
TaskBulkOperation.create = originals.bulkOperationCreate;

console.log(`task date contract: ${passed}/${passed + failed} passed`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  FAIL ${failure}`);
  process.exit(1);
}
