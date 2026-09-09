// tests/task-version-guard-contract.mjs
//
// Ledger task T101 (board item B9, "the one that matters" per the coordination
// board). PATCH /api/tasks/:id had no version guard at all: the board response
// has always returned mutationVersion, but updateTask never read an incoming
// expected value, so two people editing one task at once produced a silent
// overwrite with no signal to either party.
//
// This adds an OPTIONAL expectedVersion field. Absent means proceed exactly as
// before, so no existing caller breaks. Present and stale means 409
// TASK_VERSION_CONFLICT before any field is touched, not a partial write.
//
// Monkey-patches Task's static methods, matching the pattern already used for a
// directly-imported Mongoose model in tests/terms-acceptance-contract.mjs, since
// task.controller.js imports Task directly rather than accepting it injected.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NODE_ENV = process.env.NODE_ENV || "development";
process.env.JWT_SECRET = process.env.JWT_SECRET || "local-verification-only";
process.env.MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/capro-task-version-check";

const { default: Task } = await import("../src/models/Task.js");
const { updateTask } = await import("../src/controllers/task.controller.js");

const originals = {
  findOne: Task.findOne,
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

function fakeReq({ body, taskId = "task-1" }) {
  return {
    user: { id: "user-1", firmId: "firm-1" },
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

// A minimal stand-in for the Mongoose document updateTask reads and saves.
// save() records that it was actually called, which is the property that
// matters: a refused write must never reach save().
function fakeTaskDocument({ mutationVersion = 3, status = "IN_PROGRESS" } = {}) {
  let saveCount = 0;
  const doc = {
    _id: "task-1",
    firmId: "firm-1",
    isActive: true,
    status,
    title: "GSTR-3B Apr 2025",
    dueDateISO: "2025-05-20",
    mutationVersion,
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

function stubFindOne(document) {
  Task.findOne = () => ({
    // updateTask calls Task.findOne(...) with no further chaining (no .lean()),
    // so the query result IS the document with its save() method.
    then: (onFulfilled, onRejected) =>
      Promise.resolve(document).then(onFulfilled, onRejected),
  });
}

await test("a request with no expectedVersion behaves exactly as before", async () => {
  const document = fakeTaskDocument({ mutationVersion: 5 });
  stubFindOne(document);
  const req = fakeReq({ body: { status: "CLOSED" } });
  const res = fakeRes();

  await updateTask(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(document.saveCount, 1, "the write must proceed when no version was sent");
});

await test("a matching expectedVersion is accepted and the write proceeds", async () => {
  const document = fakeTaskDocument({ mutationVersion: 5 });
  stubFindOne(document);
  const req = fakeReq({ body: { status: "CLOSED", expectedVersion: 5 } });
  const res = fakeRes();

  await updateTask(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(document.saveCount, 1);
});

await test("a stale expectedVersion is refused with 409 and the write never happens", async () => {
  const document = fakeTaskDocument({ mutationVersion: 5 });
  stubFindOne(document);
  const req = fakeReq({ body: { status: "CLOSED", expectedVersion: 4 } });
  const res = fakeRes();

  await updateTask(req, res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, "TASK_VERSION_CONFLICT");
  assert.equal(res.body.currentVersion, 5);
  assert.equal(
    document.saveCount,
    0,
    "a stale version must refuse before any field is touched, not as a partial write",
  );
});

await test("the conflict is reported before status is mutated on the in-memory document", async () => {
  const document = fakeTaskDocument({ mutationVersion: 5, status: "IN_PROGRESS" });
  stubFindOne(document);
  const req = fakeReq({ body: { status: "CLOSED", expectedVersion: 1 } });
  const res = fakeRes();

  await updateTask(req, res);

  assert.equal(res.statusCode, 409);
  assert.equal(
    document.status,
    "IN_PROGRESS",
    "a refused write must leave every field exactly as it was read",
  );
});

await test("a non-integer expectedVersion is a 400, not silently ignored or accepted", async () => {
  const document = fakeTaskDocument({ mutationVersion: 5 });
  stubFindOne(document);
  const req = fakeReq({ body: { status: "CLOSED", expectedVersion: "not-a-number" } });
  const res = fakeRes();

  await updateTask(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(document.saveCount, 0);
});

await test("a negative expectedVersion is a 400", async () => {
  const document = fakeTaskDocument({ mutationVersion: 5 });
  stubFindOne(document);
  const req = fakeReq({ body: { status: "CLOSED", expectedVersion: -1 } });
  const res = fakeRes();

  await updateTask(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(document.saveCount, 0);
});

await test("expectedVersion: 0 is honoured (never falls through as falsy/absent)", async () => {
  // A task never saved (mutationVersion starts at 0) must be checkable at 0.
  // A naive `if (expectedVersion)` guard would treat 0 as "not sent" and skip
  // the check entirely, which is exactly the class of bug this test exists for.
  const document = fakeTaskDocument({ mutationVersion: 0 });
  stubFindOne(document);
  const req = fakeReq({ body: { status: "CLOSED", expectedVersion: 0 } });
  const res = fakeRes();

  await updateTask(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(document.saveCount, 1);
});

await test("expectedVersion: 0 against a task already at version 2 is refused", async () => {
  const document = fakeTaskDocument({ mutationVersion: 2 });
  stubFindOne(document);
  const req = fakeReq({ body: { status: "CLOSED", expectedVersion: 0 } });
  const res = fakeRes();

  await updateTask(req, res);

  assert.equal(res.statusCode, 409);
  assert.equal(document.saveCount, 0);
});

// ---------------------------------------------------------------- the client half of the guard
//
// WHY A DESKTOP CHECK LIVES IN A BACKEND SUITE.
// Everything above proves the SERVER refuses a stale write. None of it proves any client ever
// sends expectedVersion - and a guard nobody triggers is not a guard. The gap was real: the task
// board's one-tap ladder button ("Start work" / "Mark done" / "Mark completed") sent no
// expectedVersion at all, while the status dialog and the undo button both did. So the fastest,
// most-tapped status control on the page was the only one that could silently overwrite a
// colleague's change, and every test in this file passed the whole time.
//
// Textual, because TaskBoardPage is internal to the desktop app project and there is no test
// project that can see it - the same reason desktop-navigation-contract.mjs parses desktop source
// from here.

const boardSource = readFileSync(
  new URL(
    "../../apps/desktop-native/src/CaPro.Desktop.App/Views/TaskBoardPage.xaml.cs",
    import.meta.url,
  ),
  "utf8",
);

await test("every status write from the task board carries expectedVersion", async () => {
  // Every TaskChange the page constructs, with its braces.
  const changes = [...boardSource.matchAll(/new TaskChange\s*\{([^}]*)\}/g)].map(
    (match) => match[1],
  );

  assert.ok(
    changes.length >= 3,
    `parsed only ${changes.length} TaskChange constructions - this parser needs updating, not ` +
      "relaxing, because passing on zero of them would prove nothing",
  );

  const unguarded = changes.filter(
    (body) => /\bStatus\s*=/.test(body) && !/\bExpectedVersion\s*=/.test(body),
  );

  assert.deepEqual(
    unguarded,
    [],
    "a status write from the task board sends no ExpectedVersion, so two people changing one " +
      "task at once produces a silent overwrite instead of the 409 this suite proves the server " +
      "is ready to give",
  );
});

Task.findOne = originals.findOne;

console.log(`task version guard contract: ${passed}/${passed + failed} passed`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  FAIL ${failure}`);
  process.exit(1);
}
