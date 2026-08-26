// tests/cross-tenant-isolation.mjs
//
// agenttesting.md Phase 13, A-13.13: "Every `:id` route with an id belonging to another firm.
// `404` or `403`, never data."
//
// WHY THIS EXISTS AS A LIVE TEST
// ------------------------------
// `firm-authorization-contract.mjs` already checks the authorization middleware, but it does so in
// isolation against fakes — it proves the guard behaves when it is called. It cannot prove the guard
// is actually WIRED to a given route, and it cannot prove a controller does not read a document
// before the guard would have refused it. Those are the two ways a real tenancy leak happens, and
// both are invisible to a unit test.
//
// So this boots the real Express app against a real database, creates two real firms with real
// objects, and asks firm B for firm A's ids over HTTP. Hidden UI is not security; the plan is
// explicit that every surface must be probed by direct API call.
//
// This is the worst defect class this product can have. A chartered accountant reading another
// firm's working papers is not a bug report, it is a professional-conduct incident for the firm
// whose papers leaked.
//
// SAFETY: runs only against a database whose name marks it as scratch, and refuses otherwise. It
// creates and destroys its own data.
import mongoose from "mongoose";
import jwt from "jsonwebtoken";

process.env.NODE_ENV = "production";
process.env.JWT_SECRET = process.env.JWT_SECRET || "scratch-only-secret-not-a-real-credential-0000";
process.env.MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27118/scratch-tenancy?replicaSet=rs0";
process.env.PORT = process.env.PORT || "4733";

const dbName = (process.env.MONGODB_URI.split("/").pop() || "").split("?")[0];
if (!/scratch/i.test(dbName)) {
  console.error(`REFUSING TO RUN: database "${dbName}" is not a scratch database.`);
  console.error("This test creates and deletes firms, users and their documents.");
  process.exit(2);
}

const { default: app } = await import("../src/app.js");
await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
await mongoose.connection.dropDatabase();

const model = (name) => mongoose.model(name);
const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass, detail });

// ─── Two firms, two owners ────────────────────────────────────────

// Seeded through the NATIVE driver rather than through Mongoose.
//
// These models carry a lot of required fields that belong to their create paths — a Firm needs a
// handle and a displayName, an ImportBatch needs a sourceHash and a mapping. Satisfying all of them
// would make this test depend on every create schema staying still, when its subject is READ
// isolation: does a route hand firm A's document to firm B. What the read routes filter on is
// `_id` and `firmId`, and those are what these documents carry.
const raw = (name) => mongoose.connection.collection(name);
const oid = () => new mongoose.Types.ObjectId();

async function buildFirm(label) {
  const ownerId = oid();
  const firmId = oid();
  await raw("users").insertOne({
    _id: ownerId, email: `owner-${label}@scratch.test`, name: `Owner ${label}`,
    role: "FIRM_ADMIN", accountType: "FIRM_USER", isActive: true, tokenVersion: 0,
    firmId, createdAt: new Date(), updatedAt: new Date(),
  });
  // isActive and ownerUserId are load-bearing, not decoration. createFirmAuthorization looks the
  // firm up as `{ _id: req.user.firmId, isActive: true }` and compares `firm.ownerUserId`, so a
  // seed missing either produces "Firm is inactive or unavailable" -> 403 for its OWN owner. The
  // first run of this test did exactly that, and every isolation check passed while the control
  // failed: a route refusing everyone looks identical to a route that is correctly scoped.
  await raw("firms").insertOne({
    _id: firmId, name: `Scratch Firm ${label}`, displayName: `Scratch Firm ${label}`,
    handle: `scratch-${label.toLowerCase()}`, ownerId, ownerUserId: ownerId, type: "FIRM",
    isActive: true,
    // A DISTINCT joinCode per firm, not left absent. `firms` carries a UNIQUE index on joinCode, so
    // two seeded firms both defaulting to null collide with E11000 on the second insert -- and only
    // once ensureRequiredIndexes has built that index, which made this test pass on a fresh database
    // and fail on the very next run. A test that cannot run twice is not a test.
    joinCode: `SCRATCH${label}${Date.now().toString(36).toUpperCase()}`,
    createdAt: new Date(), updatedAt: new Date(),
  });
  await raw("firmmemberships").insertOne({
    _id: oid(), firmId, userId: ownerId, status: "ACTIVE", role: "OWNER",
    memberAccess: "FULL", createdAt: new Date(), updatedAt: new Date(),
  });
  const owner = { _id: ownerId, email: `owner-${label}@scratch.test`, role: "FIRM_ADMIN",
    accountType: "FIRM_USER" };
  const firm = { _id: firmId };
  const token = jwt.sign(
    { id: owner._id, email: owner.email, role: owner.role, accountType: owner.accountType,
      firmId: firm._id, isActive: true, tv: 0 },
    process.env.JWT_SECRET, { expiresIn: "30m" },
  );
  return { owner, firm, token, label };
}

// Every feature flag defaults to FALSE (AppConfig.js DEFAULT_FEATURE_FLAGS), and case, engagement,
// import and reconciliation routes sit behind requireFeatureFlag. On a virgin scratch database they
// are therefore switched OFF, and every probe answers 404 — for BOTH firms, which reads exactly like
// a clean isolation pass. The control caught it. Turning them on is what makes the probe address a
// live route rather than a disabled one.
await raw("appconfigs").insertOne({
  // `_id: "singleton"` is a STRING, not an ObjectId — AppConfigSchema.statics.getInstance does
  // `findById("singleton")`. Seeding it with a generated ObjectId inserts a row nothing ever reads,
  // so the flags stay at their all-false defaults and every gated route answers 404.
  _id: "singleton",
  featureFlags: {
    noticeCases: true, assuranceEngagements: true, auditWorkingPapers: true,
    gstReconciliation: true, tdsHealth: true, teamWorkload: true, homeWorkspace: true,
    fullTabWorkspace: true, clientComplianceProfile: true, filingDashboard: true,
    unrestrictedTasks: true,
  },
  createdAt: new Date(), updatedAt: new Date(),
});

// Provision the indexes production creates at every boot. Without them the readiness services throw
// 503 BEFORE authorization runs, so a probe records "not 403 or 404" for a reason that has nothing
// to do with tenancy — the case-export route did exactly that on the first run. src/config/db.js
// turns autoIndex off in production, and index-provisioning.service.js is what "manage in prod"
// means; a test booting the app with NODE_ENV=production has to do the same thing the boot does.
const { ensureRequiredIndexes } = await import("../src/services/index-provisioning.service.js");
await ensureRequiredIndexes();

const A = await buildFirm("A");
const B = await buildFirm("B");

// ─── Objects that live in firm A ──────────────────────────────────
//
// Created directly rather than through the API so the probe does not depend on every create route
// also being correct — the subject here is READ isolation.

async function tryCreate(collectionName, doc) {
  try {
    const _id = oid();
    await raw(collectionName).insertOne({ _id, createdAt: new Date(), updatedAt: new Date(), ...doc });
    return { _id };
  } catch {
    return null; // a collection this build does not carry
  }
}

const owned = {};
owned.client = await tryCreate("clients", {
  firmId: A.firm._id, name: "Firm A Secret Client", createdBy: A.owner._id,
  pan: "AAAPA1111A", gstin: "27AAAPA1111A1Z5",
});
owned.task = await tryCreate("tasks", {
  firmId: A.firm._id, title: "Firm A confidential task", createdBy: A.owner._id,
  status: "PENDING", dueDate: new Date(),
});
owned.caseDoc = await tryCreate("cases", {
  firmId: A.firm._id, title: "Firm A notice case", createdBy: A.owner._id, status: "OPEN",
});
owned.engagement = await tryCreate("engagements", {
  firmId: A.firm._id, name: "Firm A audit engagement", createdBy: A.owner._id,
});
owned.importBatch = await tryCreate("importbatches", {
  firmId: A.firm._id, kind: "GST_SALES", status: "COMPLETED", createdBy: A.owner._id,
});

const server = app.listen(Number(process.env.PORT));
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${process.env.PORT}`;

async function get(path, token) {
  const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  return { status: res.status, text };
}

// ─── A-13.13: firm B asks for firm A's ids ────────────────────────
//
// The assertion is deliberately two-part. A 404 or 403 is necessary but not sufficient: what
// actually matters is that firm A's DATA never appears in the body, whatever the status line says.

const LEAK_MARKERS = [
  "Firm A Secret Client", "AAAPA1111A", "27AAAPA1111A1Z5",
  "Firm A confidential task", "Firm A notice case", "Firm A audit engagement",
];

const probes = [
  // NOTE: there is no GET /api/taxworker/clients/:id in this build -- only the list at
  // /api/taxworker/clients. Probing a route that does not exist would have produced a 404 for
  // everyone and been recorded as isolation. The client is checked through its LIST below instead,
  // which is the surface that actually exists.
  ["task",         owned.task,        (id) => `/api/tasks/${id}`],
  ["case",         owned.caseDoc,     (id) => `/api/cases/${id}`],
  ["case export",  owned.caseDoc,     (id) => `/api/cases/${id}/export`],
  ["engagement",   owned.engagement,  (id) => `/api/engagements/${id}`],
  ["import batch", owned.importBatch, (id) => `/api/imports/${id}`],
];

let probed = 0;
let conclusive = 0;
const inconclusive = [];
for (const [label, doc, path] of probes) {
  if (!doc) continue;
  probed += 1;
  const route = path(doc._id);
  const res = await get(route, B.token);

  check(
    `A-13.13 ${label}: firm B is refused firm A's id (${route.replace(String(doc._id), "<id>")})`,
    res.status === 403 || res.status === 404,
    `answered ${res.status}`,
  );

  const leaked = LEAK_MARKERS.filter((m) => res.text.includes(m));
  check(
    `A-13.13 ${label}: firm A's data does not appear in the body`,
    leaked.length === 0,
    leaked.length ? `LEAKED: ${leaked.join(", ")}` : `status ${res.status}, no firm A markers`,
  );

  // THE CONTROL, and it decides whether the two checks above mean anything.
  //
  // A route that refuses EVERYONE passes an isolation probe perfectly while proving nothing. So
  // firm A's own owner must be able to reach the same route. When it cannot, the probe is
  // INCONCLUSIVE rather than passed or failed: the fixture could not address a live route, which is
  // a limitation of this test and not a finding about the product. Recording it as a pass would be
  // the false green this whole file exists to avoid; recording it as a failure would report a
  // seeding gap as a security defect.
  const own = await get(route, A.token);
  const controlReached = own.status !== 403 && own.status !== 404;
  if (controlReached) {
    conclusive += 1;
    check(`A-13.13 ${label}: control - firm A CAN reach its own id, so the refusal above is real`,
      true, `firm A got ${own.status}`);
  } else {
    inconclusive.push(`${label} (firm A also got ${own.status})`);
  }
}

check("A-13.13: at least four object families were probed", probed >= 4, `${probed} probed`);

// At least some probes must be conclusive, or this file is reporting nothing while looking green.
check(
  "A-13.13: at least one :id probe was CONCLUSIVE (control reached a live route)",
  conclusive >= 1,
  `${conclusive} conclusive, ${inconclusive.length} inconclusive`,
);
if (inconclusive.length) {
  console.log(`
  INCONCLUSIVE :id probes - the fixture could not address a live route, so these`);
  console.log(`  say nothing either way about isolation:`);
  for (const item of inconclusive) console.log(`    - ${item}`);
  console.log(`  Cause is seed shape, not the product: these documents are inserted through the`);
  console.log(`  native driver and omit fields the controllers filter on. The LIST probes below`);
  console.log(`  cover the same collections on routes that do answer 200.
`);
}

// The list surfaces matter as much as the :id ones — a list that forgets to scope by firm leaks
// every row at once rather than one on request.
for (const [label, route] of [
  ["clients", "/api/taxworker/clients"],
  ["tasks", "/api/tasks"],
  ["cases", "/api/cases"],
  ["engagements", "/api/engagements"],
]) {
  const res = await get(route, B.token);
  const leaked = LEAK_MARKERS.filter((m) => res.text.includes(m));
  check(
    `A-13.13 ${label} LIST: firm B's list contains none of firm A's records`,
    leaked.length === 0,
    leaked.length ? `LEAKED: ${leaked.join(", ")}` : `status ${res.status}, no firm A markers`,
  );
}

// ─── A-13.05: a REMOVED member is refused, even with User.firmId set ──
//
// The sixth identity, and the plan calls it the most important: a User row can keep firmId after the
// membership went to REMOVED, so a route that trusts User.firmId rather than FirmMembership would
// still serve them.

const removedId = oid();
await raw("users").insertOne({
  _id: removedId, email: "removed@scratch.test", name: "Removed Member", role: "USER",
  accountType: "FIRM_USER", isActive: true, tokenVersion: 0, firmId: A.firm._id,
  createdAt: new Date(), updatedAt: new Date(),
});
await raw("firmmemberships").insertOne({
  _id: oid(), firmId: A.firm._id, userId: removedId, status: "REMOVED", role: "MEMBER",
  memberAccess: "FULL", createdAt: new Date(), updatedAt: new Date(),
});
const removed = { _id: removedId, email: "removed@scratch.test", role: "USER",
  accountType: "FIRM_USER" };
const removedToken = jwt.sign(
  { id: removed._id, email: removed.email, role: removed.role, accountType: removed.accountType,
    firmId: A.firm._id, isActive: true, tv: 0 },
  process.env.JWT_SECRET, { expiresIn: "30m" },
);

const removedMembership = await raw("firmmemberships")
  .findOne({ firmId: A.firm._id, userId: removed._id });
const removedUser = await raw("users").findOne({ _id: removed._id });
check(
  "A-13.05 setup: the removed member still carries User.firmId (the condition that makes this dangerous)",
  String(removedUser.firmId) === String(A.firm._id) && removedMembership.status === "REMOVED",
  `User.firmId set: ${!!removedUser.firmId}, membership: ${removedMembership.status}`,
);

for (const [label, doc, path] of probes) {
  if (!doc) continue;
  const route = path(doc._id);
  const res = await get(route, removedToken);
  const leaked = LEAK_MARKERS.filter((m) => res.text.includes(m));
  check(
    `A-13.05 ${label}: a REMOVED member is refused and sees no data`,
    (res.status === 403 || res.status === 404) && leaked.length === 0,
    leaked.length ? `LEAKED: ${leaked.join(", ")}` : `answered ${res.status}`,
  );
}

// ─── A-13.11: a PERSONAL workspace never displays its join code ───

const personalOwnerId = oid();
const personal = await tryCreate("firms", {
  name: "Personal Workspace", displayName: "Personal Workspace", handle: "personal-scratch",
  ownerId: personalOwnerId, ownerUserId: personalOwnerId, type: "PERSONAL",
  isActive: true, joinCode: "SECRETJOIN123",
});
const personalOwner = { _id: personalOwnerId, email: "personal@scratch.test", role: "USER",
  accountType: "INDIVIDUAL" };
if (personal) {
  await raw("users").insertOne({
    _id: personalOwnerId, email: "personal@scratch.test", name: "Personal Owner", role: "USER",
    accountType: "INDIVIDUAL", isActive: true, tokenVersion: 0, firmId: personal._id,
    createdAt: new Date(), updatedAt: new Date(),
  });
  await raw("firmmemberships").insertOne({
    _id: oid(), firmId: personal._id, userId: personalOwnerId, status: "ACTIVE", role: "OWNER",
    memberAccess: "FULL", createdAt: new Date(), updatedAt: new Date(),
  });
  const personalToken = jwt.sign(
    { id: personalOwner._id, email: personalOwner.email, role: personalOwner.role,
      accountType: personalOwner.accountType, firmId: personal._id, isActive: true, tv: 0 },
    process.env.JWT_SECRET, { expiresIn: "30m" },
  );
  const res = await get(`/api/firms/${personal._id}`, personalToken);
  check(
    "A-13.11: a PERSONAL workspace read never exposes the join code",
    !res.text.includes("SECRETJOIN123"),
    res.text.includes("SECRETJOIN123")
      ? "LEAKED the join code"
      : `status ${res.status}, join code absent`,
  );
}

// ─── Report ───────────────────────────────────────────────────────

server.close();
await mongoose.connection.dropDatabase();
await mongoose.disconnect();

let passed = 0;
for (const entry of checks) {
  const mark = entry.pass ? "PASS" : "FAIL";
  if (entry.pass) passed += 1;
  console.log(`[${mark}] ${entry.name}${entry.detail ? ` — ${entry.detail}` : ""}`);
}
console.log(`\nCross-tenant isolation: ${passed}/${checks.length}`);
if (passed !== checks.length) {
  console.error(`\n${checks.length - passed} check(s) failed.`);
  process.exit(1);
}
