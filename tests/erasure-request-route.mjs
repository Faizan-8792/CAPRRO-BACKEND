// L12 step 6: the erasure REQUEST path, and the super-admin side that honours it.
//
//   node tests/erasure-request-route.mjs
//
// The cascade has its own contract and end-to-end suites. This one covers the part a user actually
// touches and the guard that stands between a request and an irreversible erasure:
//
//   * asking for erasure records a request and destroys nothing
//   * the ordinary profile update still behaves exactly as it did, so no client breaks
//   * a super administrator can see outstanding requests, and nobody else can
//   * the firm erasure refuses to run without an explicit confirmation, and refusing changes nothing
//
// Controllers are called directly with mock req/res against the scratch replica set. That is
// deliberate: it exercises the real controller, the real Mongoose models and the real guards,
// without standing up an HTTP listener the assertions would not benefit from.

import mongoose from "mongoose";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readdirSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const mod = (...p) => pathToFileURL(join(repoRoot, ...p)).href;

process.env.NODE_ENV = "production";
process.env.JWT_SECRET = process.env.JWT_SECRET || "scratch-erasure-secret";
process.env.MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27118/scratch-erasure-request?replicaSet=rs0";

const dbName = process.env.MONGODB_URI.split("/").pop().split("?")[0];
if (!/scratch/i.test(dbName)) {
  console.error(`REFUSING TO RUN: database "${dbName}" is not a scratch database.`);
  process.exit(2);
}

for (const f of readdirSync(join(repoRoot, "src", "models")).filter((x) => x.endsWith(".js"))) {
  await import(mod("src", "models", f));
}
const { updateMe } = await import(mod("src", "controllers", "auth.controller.js"));
const { deleteFirmForSuper, listErasureRequestsForSuper, getErasureReceiptForSuper } = await import(
  mod("src", "controllers", "super.controller.js")
);

const User = mongoose.model("User");
const Firm = mongoose.model("Firm");
const Task = mongoose.model("Task");
const Client = mongoose.model("Client");
const ActivityEvent = mongoose.model("ActivityEvent");

await mongoose.connect(process.env.MONGODB_URI);
await mongoose.connection.dropDatabase();

let pass = 0;
let fail = 0;
const failures = [];
function check(id, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  PASS ${id}  ${detail}`);
  } else {
    fail += 1;
    failures.push(id);
    console.log(`  FAIL ${id}  ${detail}`);
  }
}

// The super-admin guard checks role AND a specific address, so the test has to use the real one.
const SUPER_EMAIL = "saifullahfaizan786@gmail.com";

function mockRes() {
  const r = { statusCode: 200, body: null };
  r.status = (code) => {
    r.statusCode = code;
    return r;
  };
  r.json = (body) => {
    r.body = body;
    return r;
  };
  return r;
}

async function call(handler, { user, body = {}, params = {} } = {}) {
  const res = mockRes();
  let forwarded = null;
  await handler({ user, body, params }, res, (err) => {
    forwarded = err;
  });
  if (forwarded) return { status: forwarded.statusCode || 500, body: null, error: forwarded };
  return { status: res.statusCode, body: res.body, error: null };
}

const oid = () => new mongoose.Types.ObjectId();

// ------------------------------------------------------------------------------------------------
console.log("=== a user asks for erasure ===");
const firmId = oid();
const userId = oid();
await Firm.collection.insertOne({ _id: firmId, name: "Requesting Firm" });
await User.collection.insertOne({
  _id: userId, firmId, email: "requester@example.invalid", name: "Original Name",
  role: "FIRM_ADMIN", tokenVersion: 0, isActive: true,
});
await Task.collection.insertOne({ firmId, title: "Untouched by a request" });

{
  const r = await call(updateMe, { user: { id: String(userId) }, body: { requestErasure: true } });
  check("REQUEST-ok", r.status === 200 && r.body?.ok === true, `status ${r.status}`);
  check(
    "REQUEST-recorded",
    Boolean(r.body?.user?.erasureRequestedAt),
    `erasureRequestedAt returned to the caller (${r.body?.user?.erasureRequestedAt})`,
  );
  check(
    "REQUEST-grievance-address",
    r.body?.erasureGrievanceUrl === "caprotoolkit.in/privacy.html",
    `the grievance channel comes from the server, not hard-coded in the client (${r.body?.erasureGrievanceUrl})`,
  );

  // The whole point of separating request from erasure: nothing may be destroyed here.
  const tasks = await Task.collection.countDocuments({ firmId });
  const stillNamed = await User.collection.findOne({ _id: userId });
  check("REQUEST-destroys-nothing", tasks === 1, `the firm's task is still present (${tasks})`);
  check(
    "REQUEST-identity-intact",
    stillNamed.email === "requester@example.invalid" && stillNamed.name === "Original Name",
    "the requester's identity is untouched — asking is not erasing",
  );

  const ev = await ActivityEvent.collection.findOne({ action: "ERASURE_REQUESTED" });
  check("REQUEST-audited", Boolean(ev) && String(ev.actorUserId) === String(userId), "the request is recorded in the audit trail");
}

console.log("");
console.log("=== the request date does not move when it is re-sent ===");
{
  const before = (await User.collection.findOne({ _id: userId })).erasureRequestedAt;
  const r = await call(updateMe, { user: { id: String(userId) }, body: { requestErasure: true } });
  const after = (await User.collection.findOne({ _id: userId })).erasureRequestedAt;
  check(
    "REREQUEST-stable",
    r.status === 200 && String(before) === String(after),
    "re-asking keeps the original date, which is when the duty to answer started running",
  );
}

console.log("");
console.log("=== a request can be withdrawn ===");
{
  const r = await call(updateMe, { user: { id: String(userId) }, body: { requestErasure: false } });
  const row = await User.collection.findOne({ _id: userId });
  check("WITHDRAW-ok", r.status === 200 && row.erasureRequestedAt === null, "the request is cleared");
  const ev = await ActivityEvent.collection.findOne({ action: "ERASURE_REQUEST_WITHDRAWN" });
  check("WITHDRAW-audited", Boolean(ev), "the withdrawal is recorded too");
  // Put it back for the super-admin section below.
  await call(updateMe, { user: { id: String(userId) }, body: { requestErasure: true } });
}

console.log("");
console.log("=== the ordinary profile update is unchanged ===");
{
  const renamed = await call(updateMe, { user: { id: String(userId) }, body: { name: "Renamed Person" } });
  check("PROFILE-rename", renamed.status === 200 && renamed.body?.user?.name === "Renamed Person", "a plain rename still works");
  check(
    "PROFILE-request-untouched",
    Boolean(renamed.body?.user?.erasureRequestedAt),
    "renaming does not disturb an outstanding erasure request",
  );

  const missing = await call(updateMe, { user: { id: String(userId) }, body: {} });
  check("PROFILE-name-required", missing.status === 400, `a body with neither field is still rejected (${missing.status})`);

  const bad = await call(updateMe, { user: { id: String(userId) }, body: { requestErasure: "yes" } });
  check("PROFILE-bad-flag", bad.status === 400, `a non-boolean requestErasure is rejected (${bad.status})`);

  const blank = await call(updateMe, { user: { id: String(userId) }, body: { name: "   " } });
  check("PROFILE-blank-name", blank.status === 400, `a blank name is still rejected (${blank.status})`);

  const both = await call(updateMe, {
    user: { id: String(userId) },
    body: { name: "Both At Once", requestErasure: true },
  });
  check(
    "PROFILE-both-fields",
    both.status === 200 && both.body?.user?.name === "Both At Once",
    "name and flag can be sent together",
  );
}

console.log("");
console.log("=== only a super administrator sees the queue ===");
{
  const asUser = await call(listErasureRequestsForSuper, {
    user: { id: String(userId), role: "FIRM_ADMIN", email: "requester@example.invalid" },
  });
  check("QUEUE-forbidden", asUser.status === 403, `an ordinary firm admin is refused (${asUser.status})`);

  const impostor = await call(listErasureRequestsForSuper, {
    user: { id: String(oid()), role: "SUPER_ADMIN", email: "not-the-super@example.invalid" },
  });
  check("QUEUE-role-alone-insufficient", impostor.status === 403, `the role alone is not enough (${impostor.status})`);

  const asSuper = await call(listErasureRequestsForSuper, {
    user: { id: String(oid()), role: "SUPER_ADMIN", email: SUPER_EMAIL },
  });
  check("QUEUE-visible", asSuper.status === 200 && asSuper.body?.count === 1, `the super admin sees ${asSuper.body?.count} request(s)`);
  check(
    "QUEUE-content",
    asSuper.body?.requests?.[0]?.email === "requester@example.invalid",
    "the queue names who asked and when",
  );
}

console.log("");
console.log("=== the erasure refuses to run without an explicit confirmation ===");
const superUser = { id: String(oid()), role: "SUPER_ADMIN", email: SUPER_EMAIL };
await Client.collection.insertOne({ firmId, name: "A Client", ownerUserId: userId });

{
  const r = await call(deleteFirmForSuper, { user: superUser, params: { firmId: String(firmId) }, body: {} });
  check("CONFIRM-required", r.status === 400, `refused without confirmation (${r.status})`);
  check(
    "CONFIRM-explains",
    /ERASE_FIRM_DATA/.test(r.body?.error || "") && r.body?.plan?.collections > 0,
    `the refusal says what to send and how much it covers (${r.body?.plan?.collections} collections)`,
  );

  // A refusal that half-ran would be far worse than one that did not run at all.
  const tasks = await Task.collection.countDocuments({ firmId });
  const clients = await Client.collection.countDocuments({ firmId });
  const firm = await Firm.collection.countDocuments({ _id: firmId });
  check(
    "CONFIRM-nothing-happened",
    tasks === 1 && clients === 1 && firm === 1,
    `task, client and firm all still present (${tasks}/${clients}/${firm})`,
  );

  const wrong = await call(deleteFirmForSuper, {
    user: superUser, params: { firmId: String(firmId) }, body: { confirmation: "yes" },
  });
  check("CONFIRM-exact", wrong.status === 400, `a near-miss confirmation is still refused (${wrong.status})`);
}

console.log("");
console.log("=== an unknown firm is a clean 404, not a cascade ===");
{
  const r = await call(deleteFirmForSuper, {
    user: superUser, params: { firmId: String(oid()) }, body: { confirmation: "ERASE_FIRM_DATA" },
  });
  check("MISSING-firm", r.status === 404, `unknown firm rejected (${r.status})`);
}

console.log("");
console.log("=== a confirmed erasure runs, and the firm row goes last ===");
let operationId = null;
{
  const r = await call(deleteFirmForSuper, {
    user: superUser,
    params: { firmId: String(firmId) },
    body: { confirmation: "ERASE_FIRM_DATA", requestReference: "GRIEVANCE-2026-0042" },
  });
  check("ERASE-ok", r.status === 200 && r.body?.ok === true, `status ${r.status}`);
  operationId = r.body?.receipt?.operationId;
  check("ERASE-receipt", Boolean(operationId), `a receipt is returned (${operationId})`);
  check(
    "ERASE-reference",
    r.body?.receipt?.requestReference === "GRIEVANCE-2026-0042",
    "the written request reference is recorded on the receipt",
  );
  check(
    "ERASE-authoriser",
    r.body?.receipt?.authorisedByUserId === superUser.id,
    "the authorising super administrator is recorded",
  );

  const tasks = await Task.collection.countDocuments({ firmId });
  const clients = await Client.collection.countDocuments({ firmId });
  const firm = await Firm.collection.countDocuments({ _id: firmId });
  check("ERASE-purged", tasks === 0 && clients === 0, `task and client rows deleted (${tasks}/${clients})`);
  check("ERASE-firm-row", firm === 0, "the firm row itself is removed once the cascade completed");

  const person = await User.collection.findOne({ _id: userId });
  check(
    "ERASE-identity",
    /^erased-[0-9a-f]{24}@erased\.invalid$/i.test(person.email) && person.name === "Erased account",
    `the requester's identity is gone (${person.email})`,
  );
  check("ERASE-signed-out", person.tokenVersion >= 1, `sessions invalidated (tokenVersion ${person.tokenVersion})`);
}

console.log("");
console.log("=== the receipt can be read back afterwards ===");
{
  const r = await call(getErasureReceiptForSuper, { user: superUser, params: { operationId } });
  check("RECEIPT-readable", r.status === 200 && r.body?.receipt?.status === "COMPLETED", `status ${r.status}`);
  check(
    "RECEIPT-detail",
    Array.isArray(r.body?.receipt?.steps) && r.body.receipt.steps.length > 0,
    `the receipt lists ${r.body?.receipt?.steps?.length} per-collection outcomes`,
  );

  const missing = await call(getErasureReceiptForSuper, { user: superUser, params: { operationId: "no-such-operation" } });
  check("RECEIPT-404", missing.status === 404, `an unknown receipt is a clean 404 (${missing.status})`);

  const asUser = await call(getErasureReceiptForSuper, {
    user: { id: String(userId), role: "FIRM_ADMIN", email: "x@example.invalid" }, params: { operationId },
  });
  check("RECEIPT-guarded", asUser.status === 403, `an ordinary user cannot read receipts (${asUser.status})`);
}

console.log("");
console.log(`=== erasure request route: ${pass} passed, ${fail} failed ===`);
if (failures.length) console.log(`  failed: ${failures.join(", ")}`);

await mongoose.connection.dropDatabase();
await mongoose.disconnect();
process.exit(fail === 0 ? 0 : 1);
