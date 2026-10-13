// tests/taxworker-duplicate-audit-contract.mjs
//
// Ledger task T102 (board item B10). GET /api/taxworker/clients silently deactivates
// case-insensitive name duplicates as a side effect of a read, with nothing beyond the
// response's removedDupes count to show it happened. A firm's audit trail for one of
// these clients would never mention it was archived by a sweep rather than a person.
//
// This adds an ActivityEvent (source AUTOMATION, action CLIENT_DUPLICATES_ARCHIVED)
// whenever listClients actually archives something, and skips it for solo users
// (scope.firmId is null) because recordActivity requires a tenant firmId for a
// non-SUPER_ADMIN event and a single owner's own data has no firm audit trail to
// appear on.
//
// Monkey-patches Client's static query methods and ActivityEvent.prototype.save,
// matching the pattern already used for directly-imported Mongoose models in
// tests/terms-acceptance-contract.mjs and tests/task-version-guard-contract.mjs.

import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV || "development";
process.env.JWT_SECRET = process.env.JWT_SECRET || "local-verification-only";
process.env.MONGODB_URI =
  process.env.MONGODB_URI ||
  "mongodb://127.0.0.1:27017/capro-taxworker-audit-check";

const { default: Client } = await import("../src/models/Client.js");
const { default: ActivityEvent } =
  await import("../src/models/ActivityEvent.js");
const { listClients } =
  await import("../src/controllers/taxworker.controller.js");

const originals = {
  find: Client.find,
  updateMany: Client.updateMany,
  save: ActivityEvent.prototype.save,
};

// firmId/actorUserId are ObjectId refs on ActivityEvent. A non-hex-24 string fails Mongoose's
// cast silently during $set (invalidated, not thrown, since validate() is never reached behind
// the save() stub below), which previously surfaced as a confusing "null !== 'firm-1'" failure
// rather than the real assertion. Real-shaped ids avoid that trap entirely.
const FIRM_1 = "670aaa11bb22cc33dd44ee01";
const FIRM_2 = "670aaa11bb22cc33dd44ee02";
const USER_9 = "670aaa11bb22cc33dd44ee19";
const SOLO_USER = "670aaa11bb22cc33dd44ee1f";

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

function fakeReq({ firmId, userId }) {
  return {
    user: firmId ? { id: userId, firmId } : { id: userId, firmId: null },
    query: {},
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

// A chainable stand-in for Client.find(filter).select(...).sort(...).limit(...).lean().
function chainableFind(rows) {
  const api = {
    select: () => api,
    sort: () => api,
    limit: () => api,
    lean: async () => rows,
  };
  return api;
}

function clientRow(id, name, overrides = {}) {
  return {
    _id: id,
    name,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function stubActivitySave(capture) {
  ActivityEvent.prototype.save = async function save() {
    capture.push({
      firmId: this.firmId,
      actorUserId: this.actorUserId,
      source: this.source,
      action: this.action,
      entityType: this.entityType,
      entityId: this.entityId,
      beforeSummary: this.beforeSummary,
      afterSummary: this.afterSummary,
      metadata: this.metadata,
    });
    return this;
  };
}

await test("no duplicates: nothing archived, no activity event recorded", async () => {
  const rows = [
    clientRow("c1", "Rao & Co"),
    clientRow("c2", "Sharma Associates"),
  ];
  Client.find = () => chainableFind(rows);
  let updateManyCalled = false;
  Client.updateMany = async () => {
    updateManyCalled = true;
    return { modifiedCount: 0 };
  };
  const activityCalls = [];
  stubActivitySave(activityCalls);

  const req = fakeReq({ firmId: FIRM_1, userId: USER_9 });
  const res = fakeRes();
  await listClients(req, res, (err) => {
    throw err;
  });

  assert.equal(res.body.removedDupes, 0);
  assert.equal(updateManyCalled, false);
  assert.equal(
    activityCalls.length,
    0,
    "no archive happened, so no activity event should be written",
  );
});

await test("a firm-scoped duplicate is archived and recorded on the audit trail", async () => {
  const rows = [
    clientRow("c1", "Rao & Co"),
    clientRow("c2", "rao & co"), // case-insensitive duplicate of c1
    clientRow("c3", "Sharma Associates"),
  ];
  Client.find = () => chainableFind(rows);
  let updateManyArgs = null;
  Client.updateMany = async (filter, update) => {
    updateManyArgs = { filter, update };
    return { modifiedCount: 1 };
  };
  const activityCalls = [];
  stubActivitySave(activityCalls);

  const req = fakeReq({ firmId: FIRM_1, userId: USER_9 });
  const res = fakeRes();
  await listClients(req, res, (err) => {
    throw err;
  });

  assert.equal(res.body.removedDupes, 1);
  assert.deepEqual(updateManyArgs.filter, { _id: { $in: ["c2"] } });
  assert.deepEqual(updateManyArgs.update, { $set: { isActive: false } });

  assert.equal(
    activityCalls.length,
    1,
    "exactly one activity event for the whole sweep, not one per duplicate",
  );
  const [event] = activityCalls;
  assert.equal(String(event.firmId), FIRM_1);
  assert.equal(String(event.actorUserId), USER_9);
  assert.equal(event.source, "AUTOMATION");
  assert.equal(event.action, "CLIENT_DUPLICATES_ARCHIVED");
  assert.equal(event.entityType, "Client");
  assert.equal(event.afterSummary.archivedCount, 1);
  assert.deepEqual(event.afterSummary.archivedClientIds, ["c2"]);
});

await test("multiple duplicates in one read produce one event naming all of them", async () => {
  const rows = [
    clientRow("c1", "Rao & Co"),
    clientRow("c2", "RAO & CO"),
    clientRow("c3", "Rao & co"),
  ];
  Client.find = () => chainableFind(rows);
  Client.updateMany = async () => ({ modifiedCount: 2 });
  const activityCalls = [];
  stubActivitySave(activityCalls);

  const req = fakeReq({ firmId: FIRM_2, userId: USER_9 });
  const res = fakeRes();
  await listClients(req, res, (err) => {
    throw err;
  });

  assert.equal(res.body.removedDupes, 2);
  assert.equal(activityCalls.length, 1);
  assert.deepEqual(activityCalls[0].afterSummary.archivedClientIds, [
    "c2",
    "c3",
  ]);
});

await test("a solo user (no firm) never triggers an activity write even when archiving", async () => {
  const rows = [clientRow("c1", "Rao & Co"), clientRow("c2", "rao & co")];
  Client.find = () => chainableFind(rows);
  let updateManyCalled = false;
  Client.updateMany = async () => {
    updateManyCalled = true;
    return { modifiedCount: 1 };
  };
  const activityCalls = [];
  stubActivitySave(activityCalls);

  const req = fakeReq({ firmId: null, userId: SOLO_USER });
  const res = fakeRes();
  await listClients(req, res, (err) => {
    throw err;
  });

  // The archive itself still happens (future lists still stay clean for a solo user);
  // only the firm-audit-trail write is skipped, because there is no firm to record it against.
  assert.equal(res.body.removedDupes, 1);
  assert.equal(updateManyCalled, true);
  assert.equal(
    activityCalls.length,
    0,
    "recordActivity requires a tenant firmId for a non-SUPER_ADMIN event; a solo user has none",
  );
});

Client.find = originals.find;
Client.updateMany = originals.updateMany;
ActivityEvent.prototype.save = originals.save;

console.log(
  `taxworker duplicate-archive audit contract: ${passed}/${passed + failed} passed`,
);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  FAIL ${failure}`);
  process.exit(1);
}
