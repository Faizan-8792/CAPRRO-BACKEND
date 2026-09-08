// tests/task-assignment-receipt-contract.mjs
//
// Part 3 of TASK-MANAGEMENT-PLAN.md: an administrator assigns work with remarks, the assignee
// acknowledges it, and the administrator can see that they did.
//
// THE RULE THIS FILE EXISTS FOR, and the one worth reading twice: the read receipt belongs to the
// ASSIGNMENT, not to the task. Both receipt fields are cleared when assignedTo changes, because a
// task handed to a second person has not been read by them -- an administrator looking at a tick
// left behind by the PREVIOUS assignee would conclude the new one has seen the work, which is the
// exact opposite of the truth and precisely the mistake a read receipt is for.
//
// The other half of that rule matters just as much and is easier to get wrong: the receipt must NOT
// be cleared when the SAME assignee is re-sent. A bulk edit, or any form that posts every field it
// knows about, re-sends assignedTo unchanged all the time; clearing on "the field was present"
// rather than on "the value actually changed" would silently discard acknowledgements that really
// happened, and it would do it on the most ordinary edit there is.
//
// Follows the harness already used by tests/task-version-guard-contract.mjs: the real exported
// controller functions run unmodified against monkey-patched Mongoose models, so what is proved here
// is the shipped code path and not a re-description of it.

import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV || "development";
process.env.JWT_SECRET = process.env.JWT_SECRET || "local-verification-only";
process.env.MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/capro-task-receipt-check";

const { default: Task } = await import("../src/models/Task.js");
const { default: User } = await import("../src/models/User.js");
const { updateTask, markTaskRead } = await import(
  "../src/controllers/task.controller.js"
);

const originals = {
  taskFindOne: Task.findOne,
  userFindOne: User.findOne,
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

function fakeReq({ body = {}, taskId = "task-1", userId = "user-1" } = {}) {
  return {
    user: { id: userId, firmId: "firm-1" },
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

function fakeTaskDocument(overrides = {}) {
  let saveCount = 0;
  const doc = {
    _id: "task-1",
    firmId: "firm-1",
    isActive: true,
    status: "NOT_STARTED",
    title: "GSTR-3B Apr 2025",
    dueDateISO: "2025-05-20",
    remarks: "",
    assignedTo: null,
    assigneeReadAt: null,
    assigneeReadBy: null,
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

let lastTaskFilter = null;

function stubTaskFindOne(document) {
  Task.findOne = (filter) => {
    lastTaskFilter = filter;
    return {
      then: (onFulfilled, onRejected) =>
        Promise.resolve(document).then(onFulfilled, onRejected),
    };
  };
}

function stubUserFindOne(user) {
  User.findOne = () => ({
    lean: () => Promise.resolve(user),
  });
}

// ---------------------------------------------------------------- marking work as read

await test("marking read records when, and by whom", async () => {
  const document = fakeTaskDocument({ assignedTo: "user-1" });
  stubTaskFindOne(document);
  const res = fakeRes();

  await markTaskRead(fakeReq(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.alreadyRead, false);
  assert.ok(document.assigneeReadAt instanceof Date, "a real timestamp must be stored");
  assert.equal(document.assigneeReadBy, "user-1");
  assert.equal(document.saveCount, 1);
});

await test("the route asks only for work assigned to the caller", async () => {
  // The security property, and it is structural rather than a branch: assignedTo is part of the
  // QUERY, so another person's task is simply not found. That keeps "not yours" and "does not
  // exist" indistinguishable from outside, so this route cannot be used to confirm that somebody
  // else's task exists.
  const document = fakeTaskDocument({ assignedTo: "user-1" });
  stubTaskFindOne(document);

  await markTaskRead(fakeReq(), fakeRes());

  assert.equal(lastTaskFilter.assignedTo, "user-1");
  assert.equal(lastTaskFilter.firmId, "firm-1");
  assert.equal(lastTaskFilter.isActive, true);
});

await test("somebody else's task is a 404, not a 403", async () => {
  stubTaskFindOne(null);
  const res = fakeRes();

  await markTaskRead(fakeReq({ userId: "user-2" }), res);

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.ok, false);
  assert.match(res.body.error, /not assigned to this user/);
});

await test("marking read twice does not move the timestamp", async () => {
  // Idempotent on purpose. The administrator is reading "when did they first see this"; a timestamp
  // that crept forward every time the task was opened would answer a different question, and two
  // devices doing it at once would race.
  const firstSeen = new Date("2026-09-01T10:00:00.000Z");
  const document = fakeTaskDocument({
    assignedTo: "user-1",
    assigneeReadAt: firstSeen,
    assigneeReadBy: "user-1",
  });
  stubTaskFindOne(document);
  const res = fakeRes();

  await markTaskRead(fakeReq(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.alreadyRead, true, "the caller must be able to tell it was already read");
  assert.equal(document.assigneeReadAt.toISOString(), firstSeen.toISOString());
  assert.equal(document.saveCount, 0, "an already-read task must not be written again");
});

// ---------------------------------------------------------------- reassignment clears it

await test("handing the task to somebody else clears the receipt", async () => {
  // THE RULE. Without this, the administrator sees a tick that the new assignee never earned.
  const document = fakeTaskDocument({
    assignedTo: "user-1",
    assigneeReadAt: new Date("2026-09-01T10:00:00.000Z"),
    assigneeReadBy: "user-1",
  });
  stubTaskFindOne(document);
  stubUserFindOne({ _id: "user-2" });
  const res = fakeRes();

  await updateTask(fakeReq({ body: { assignedTo: "user-2" } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(document.assignedTo, "user-2");
  assert.equal(document.assigneeReadAt, null, "the new assignee has not read it");
  assert.equal(document.assigneeReadBy, null);
});

await test("re-sending the SAME assignee keeps the receipt", async () => {
  // The half that is easy to get wrong. A bulk edit, or any form that posts every field, re-sends
  // assignedTo unchanged constantly. Clearing on "the field was present" rather than on "the value
  // changed" would throw away real acknowledgements on the most ordinary edit there is.
  const firstSeen = new Date("2026-09-01T10:00:00.000Z");
  const document = fakeTaskDocument({
    assignedTo: "user-1",
    assigneeReadAt: firstSeen,
    assigneeReadBy: "user-1",
  });
  stubTaskFindOne(document);
  stubUserFindOne({ _id: "user-1" });
  const res = fakeRes();

  await updateTask(fakeReq({ body: { assignedTo: "user-1", title: "Renamed" } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(
    document.assigneeReadAt?.toISOString(),
    firstSeen.toISOString(),
    "an unchanged assignee must keep their acknowledgement",
  );
  assert.equal(document.assigneeReadBy, "user-1");
});

await test("unassigning the task clears the receipt too", async () => {
  const document = fakeTaskDocument({
    assignedTo: "user-1",
    assigneeReadAt: new Date("2026-09-01T10:00:00.000Z"),
    assigneeReadBy: "user-1",
  });
  stubTaskFindOne(document);
  const res = fakeRes();

  await updateTask(fakeReq({ body: { assignedTo: null } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(document.assignedTo, null);
  assert.equal(document.assigneeReadAt, null);
});

await test("an edit that never mentions the assignee leaves the receipt alone", async () => {
  const firstSeen = new Date("2026-09-01T10:00:00.000Z");
  const document = fakeTaskDocument({
    assignedTo: "user-1",
    assigneeReadAt: firstSeen,
    assigneeReadBy: "user-1",
  });
  stubTaskFindOne(document);
  const res = fakeRes();

  await updateTask(fakeReq({ body: { status: "IN_PROGRESS" } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(document.assigneeReadAt?.toISOString(), firstSeen.toISOString());
});

// ---------------------------------------------------------------- remarks

await test("remarks are stored, trimmed", async () => {
  const document = fakeTaskDocument();
  stubTaskFindOne(document);
  const res = fakeRes();

  await updateTask(
    fakeReq({ body: { remarks: "  Collect the signed 26AS before filing.  " } }),
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.equal(document.remarks, "Collect the signed 26AS before filing.");
});

await test("an empty string CLEARS the remarks", async () => {
  // `if (remarks)` would have made clearing them impossible, which is a real thing an administrator
  // needs to be able to do after remarks stop applying.
  const document = fakeTaskDocument({ remarks: "Old instruction" });
  stubTaskFindOne(document);
  const res = fakeRes();

  await updateTask(fakeReq({ body: { remarks: "" } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(document.remarks, "");
});

await test("an absent remarks field leaves existing remarks alone", async () => {
  const document = fakeTaskDocument({ remarks: "Keep me" });
  stubTaskFindOne(document);
  const res = fakeRes();

  await updateTask(fakeReq({ body: { status: "IN_PROGRESS" } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(document.remarks, "Keep me");
});

await test("a non-string remarks value is ignored rather than stored", async () => {
  const document = fakeTaskDocument({ remarks: "Keep me" });
  stubTaskFindOne(document);
  const res = fakeRes();

  await updateTask(fakeReq({ body: { remarks: { evil: true } } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(document.remarks, "Keep me", "an object must never reach the field");
});

// ---------------------------------------------------------------- the fields actually reach a screen
//
// THE CLASS OF BUG THIS PINS, and it is the quietest one in this backend: every task read projects
// by hand. getTaskBoard composes its rows field by field, and getMyOpenTasks and getTaskSource use
// written-out select lists. A new column on the model therefore reaches NOBODY until it is named in
// each one - the model has the field, the API drops it, the screen shows nothing, and not one thing
// fails anywhere. Both new fields were invisible to all three reads when they were first added.

await test("the assignee's own queue asks for remarks, the receipt and the assignee", async () => {
  const { getMyOpenTasks } = await import("../src/controllers/task.controller.js");

  let selected = null;
  const originalFind = Task.find;
  const originalCount = Task.countDocuments;
  Task.countDocuments = () => Promise.resolve(0);
  Task.find = () => {
    const chain = {
      sort: () => chain,
      skip: () => chain,
      limit: () => chain,
      select: (fields) => {
        selected = fields;
        return chain;
      },
      lean: () => Promise.resolve([]),
    };
    return chain;
  };

  try {
    await getMyOpenTasks(fakeReq(), fakeRes());
  } finally {
    Task.find = originalFind;
    Task.countDocuments = originalCount;
  }

  assert.ok(selected, "the query must project explicitly");
  for (const field of ["remarks", "assigneeReadAt", "assignedTo"]) {
    assert.ok(
      selected.includes(field),
      `${field} must be projected, or the assignee's own screen cannot show it`,
    );
  }
});

await test("the board's hand-built row names both new fields", async () => {
  // Asserted against the source, deliberately. getTaskBoard composes its response object key by
  // key, so the only way a field can be missing is by not being written there - and that is exactly
  // what happened. A behavioural test would need half the board's dependencies stubbed to prove a
  // property that is visible in one line.
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(
    new URL("../src/controllers/task.controller.js", import.meta.url),
    "utf8",
  );

  const start = source.indexOf("columns[key].push({");
  assert.ok(start > 0, "the board's row builder moved; this test needs updating");

  // Bounded on the object literal's actual CLOSING, not on a character count. The first version
  // sliced a fixed 2000 characters and started failing the moment the row grew past it - it
  // reported "the board row must carry remarks" about a row that carried remarks at offset 1976.
  // A fixed window measures the comments as much as the code.
  const end = source.indexOf("      });", start);
  assert.ok(end > start, "the board's row builder no longer closes where expected");
  const row = source.slice(start, end);

  assert.ok(row.includes("remarks:"), "the board row must carry remarks");
  assert.ok(
    row.includes("assigneeReadAt:"),
    "the board row must carry the read receipt, or an administrator cannot see it",
  );
  assert.ok(
    row.includes("clientOwner:"),
    "the board row must say which employee holds the client",
  );
});

// ---------------------------------------------------------------- the model declares them

await test("the schema carries the three new fields, with safe defaults", async () => {
  const paths = Task.schema.paths;
  assert.ok(paths.remarks, "Task.remarks must exist");
  assert.ok(paths.assigneeReadAt, "Task.assigneeReadAt must exist");
  assert.ok(paths.assigneeReadBy, "Task.assigneeReadBy must exist");
  assert.equal(paths.remarks.options.default, "");
  assert.equal(paths.assigneeReadAt.options.default, null);
  assert.equal(paths.assigneeReadBy.options.ref, "User");
  assert.equal(
    paths.remarks.options.maxlength,
    2000,
    "remarks must stay capped so it cannot become an unbounded blob",
  );
});

Task.findOne = originals.taskFindOne;
User.findOne = originals.userFindOne;

console.log(`task assignment receipt contract: ${passed}/${passed + failed}`);
for (const failure of failures) {
  console.log(`  FAIL ${failure}`);
}
process.exitCode = failed > 0 ? 1 : 0;
