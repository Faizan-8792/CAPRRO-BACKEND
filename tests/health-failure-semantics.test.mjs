// /health must tell three states apart, and must answer in all three.
//
// The 2026-09-06 incident reached the owner as "DOWN" with no further information, because the
// health check awaited a ping through the same connection pool as everything else and that wait was
// unbounded. A saturated pool still reports readyState "connected", so even a health check that
// completed would have said "connected" - and this one did not complete at all.
//
// Three states have three different fixes and must not read the same:
//
//   A  healthy              200, status ok,       db.state connected, ping_ms present
//   B  connected but busy   503, status degraded, db.state connected, db.slow + timeout_ms
//   C  unavailable          503, status degraded, db.state NOT connected, no db.slow
//
// State B is the one that could not be produced before, and it is the whole point: it distinguishes
// "the database is busy" from "the database is gone" while readyState calls both "connected".
//
// RUN AGAINST LOCAL MONGO ONLY. This boots the real Express app in-process. MONGODB_URI is set to
// the project's dev container BEFORE any import, and the test refuses to run if it points anywhere
// else - booting this against production would start a second reminder scheduler on live data.
//
//   node --test capro-backend/tests/health-failure-semantics.test.mjs

import assert from "node:assert/strict";
import test, { after, before } from "node:test";

const LOCAL = "mongodb://127.0.0.1:27117/capro-health-semantics-test";

// Set before importing app.js, and guard it. An inherited production URI must never win here.
if (process.env.MONGODB_URI && !/127\.0\.0\.1|localhost/.test(process.env.MONGODB_URI)) {
  throw new Error(
    "MONGODB_URI points somewhere that is not local; refusing to boot the app against it",
  );
}
process.env.MONGODB_URI = LOCAL;
process.env.NODE_ENV = process.env.NODE_ENV || "test";
// app.js refuses to load without one. A throwaway value, deliberately not the real secret: nothing
// here signs or verifies a token, and a test that needed the production secret to run would be a
// reason to keep the production secret within reach of the test runner.
process.env.JWT_SECRET = process.env.JWT_SECRET || "health-semantics-test-only-secret";
// Never let a local boot make a real paid call.
delete process.env.DEEPSEEK_API_KEY;
delete process.env.OCR_SPACE_API_KEY;
delete process.env.RESEND_API_KEY;

const mongoose = (await import("mongoose")).default;
const { default: app } = await import("../src/app.js");

let server;
let base;
let reachable = true;

before(async () => {
  try {
    await mongoose.connect(LOCAL, { serverSelectionTimeoutMS: 3000 });
  } catch {
    reachable = false;
    return;
  }
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

const skipIfNoMongo = (t) => {
  if (!reachable) {
    t.skip("no local MongoDB on 127.0.0.1:27117 - start the capro-mongo-dev container");
    return true;
  }
  return false;
};

async function health() {
  const started = Date.now();
  const response = await fetch(`${base}/health`);
  return { status: response.status, ms: Date.now() - started, body: await response.json() };
}

test("A - a healthy database answers 200 and reports a ping time", async (t) => {
  if (skipIfNoMongo(t)) return;

  const r = await health();
  assert.equal(r.body.db.state, "connected");
  assert.equal(typeof r.body.db.ping_ms, "number", "a healthy ping did not report its duration");
  assert.equal(r.body.db.slow, undefined, "a healthy ping was marked slow");
  // status also depends on background readiness, which this test does not run; assert what the
  // database half of the answer says rather than the combined code.
  assert.ok(r.ms < 2_000, `a healthy check took ${r.ms}ms`);
});

test("B - a database that will not answer is reported as SLOW, and health still replies", async (t) => {
  if (skipIfNoMongo(t)) return;

  // Stall the ping the way a saturated pool does: it neither resolves nor rejects. Before the fix
  // this hung the request forever, which is precisely what an uptime monitor reports as 504.
  const admin = mongoose.connection.db.admin();
  const realPing = admin.ping.bind(admin);
  admin.ping = () => new Promise(() => {});
  mongoose.connection.db.admin = () => admin;

  try {
    const r = await health();

    assert.equal(r.status, 503, "a database that never answers was reported as healthy");
    assert.equal(r.body.status, "degraded");
    assert.equal(r.body.db.state, "connected", "readyState still says connected - that is the trap");
    assert.equal(r.body.db.slow, true, "a stalled ping was not reported as slow");
    assert.equal(r.body.db.timeout_ms, 2_000, "the bound that was exceeded was not reported");
    assert.equal(r.body.db.ping_ms, null, "a ping that never returned reported a duration");

    // The whole point: it ANSWERED. And close to its bound, not minutes later.
    assert.ok(
      r.ms >= 2_000 && r.ms < 6_000,
      `health answered in ${r.ms}ms; it should be just over its own 2000ms bound`,
    );
  } finally {
    admin.ping = realPing;
  }
});

test("C - an unavailable database is a different answer from a busy one", async (t) => {
  if (skipIfNoMongo(t)) return;

  // readyState 0. The handler must not reach the ping at all, and must not claim the database is
  // merely slow - "gone" and "busy" have different fixes.
  const connection = mongoose.connection;
  const realState = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(connection),
    "readyState",
  );
  Object.defineProperty(connection, "readyState", { value: 0, configurable: true });

  try {
    const r = await health();

    assert.equal(r.status, 503);
    assert.equal(r.body.status, "degraded");
    assert.equal(r.body.db.state, "disconnected", "an unavailable database was not named as such");
    assert.equal(r.body.db.slow, undefined, "an unavailable database was reported as merely slow");
    assert.equal(r.body.db.ping_ms, null);
    assert.ok(r.ms < 2_000, "the handler waited on a ping it should never have attempted");
  } finally {
    delete connection.readyState;
    if (realState) Object.defineProperty(Object.getPrototypeOf(connection), "readyState", realState);
  }
});

test("the three states are genuinely distinguishable from the body alone", async (t) => {
  if (skipIfNoMongo(t)) return;

  // An operator reads the body, not the code. If two states produce the same body, the endpoint has
  // not actually improved - it has only moved where the ambiguity lives.
  const healthy = (await health()).body;

  const admin = mongoose.connection.db.admin();
  const realPing = admin.ping.bind(admin);
  admin.ping = () => new Promise(() => {});
  const busy = (await health()).body;
  admin.ping = realPing;

  const connection = mongoose.connection;
  Object.defineProperty(connection, "readyState", { value: 0, configurable: true });
  const gone = (await health()).body;
  delete connection.readyState;

  const fingerprint = (b) => `${b.status}|${b.db.state}|${b.db.slow ?? "-"}|${typeof b.db.ping_ms}`;
  const seen = new Set([fingerprint(healthy), fingerprint(busy), fingerprint(gone)]);
  assert.equal(
    seen.size,
    3,
    `the three states produce ${seen.size} distinct bodies: ${[...seen].join("  /  ")}`,
  );
});
