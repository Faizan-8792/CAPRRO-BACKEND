// agenttesting.md Phase 13 - authorization, tenancy and firm isolation.
//
// Builds the six identities the bar requires in a DISPOSABLE database and probes every route
// family by DIRECT API CALL, because section 15 is explicit that "client-side filtering is never
// accepted as evidence of a server rule". Nothing here goes near production: the database name is
// asserted to be a scratch one before a single document is written.
//
//   node tools/phase13-identity-matrix.mjs
//   MONGODB_URI="mongodb://127.0.0.1:27118/scratch-phase13?replicaSet=rs0" node tools/...
//
// The sixth identity, the REMOVED member, is the one the bar calls "the most important": a User row
// can keep firmId after its membership went to REMOVED (B7/T17b), so authority must come from
// FirmMembership.exists({userId, firmId, status:"ACTIVE"}) and never from User.firmId.

import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const toFileUrl = (...p) => pathToFileURL(join(repoRoot, ...p)).href;

mongoose.set("bufferTimeoutMS", 5_000);
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = process.env.JWT_SECRET || "local-verification-only";
process.env.MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27118/scratch-phase13?replicaSet=rs0";

// Refuse to run anywhere that is not obviously disposable. mongorestore-style guard, same spirit
// as restore-drill.ps1: a matrix that writes REMOVED memberships into a real firm is worse than
// no matrix at all.
const dbName = (process.env.MONGODB_URI.split("/").pop() || "").split("?")[0];
if (!dbName.startsWith("scratch-")) {
  console.error(
    `REFUSING: database "${dbName}" does not begin with "scratch-". This harness drops the ` +
      `database and writes REMOVED memberships; it must never point at real data.`,
  );
  process.exit(2);
}

const { connectDB } = await import(toFileUrl("src", "config", "db.js"));
const { default: app } = await import(toFileUrl("src", "app.js"));
const { default: User } = await import(toFileUrl("src", "models", "User.js"));
const { default: Firm } = await import(toFileUrl("src", "models", "Firm.js"));
const { default: FirmMembership } = await import(toFileUrl("src", "models", "FirmMembership.js"));
const { default: AppConfig, DEFAULT_FEATURE_FLAGS } = await import(
  toFileUrl("src", "models", "AppConfig.js")
);

await connectDB();
await mongoose.connection.dropDatabase();

// Every rollout flag on, so a 404 in the matrix means an authorization decision and not a
// disabled feature. Without this, rollout.middleware.js 404s and the matrix reads as "refused"
// for reasons that have nothing to do with identity.
await AppConfig.create({
  _id: "singleton",
  featureFlags: Object.fromEntries(Object.keys(DEFAULT_FEATURE_FLAGS).map((k) => [k, true])),
});

const server = app.listen(0);
await new Promise((res, rej) => {
  server.once("listening", res);
  server.once("error", rej);
});
const base = `http://127.0.0.1:${server.address().port}`;

// ───────────────────────────────────────────────────────── identities

const SUPER_EMAIL = "saifullahfaizan786@gmail.com";

async function makeUser(email, name, role = "USER") {
  return User.create({ email, name, role, accountType: "FIRM_USER", isActive: true });
}

let joinCodeSeed = 0;
async function makeFirm(displayName, handle, ownerUserId, memberAccess) {
  // joinCode is required and unique on Firm. Generated deterministically here rather than left to
  // the provisioning service, because this harness creates firms directly to control memberAccess.
  joinCodeSeed += 1;
  return Firm.create({
    displayName,
    handle,
    ownerUserId,
    kind: "SHARED",
    memberAccess,
    isActive: true,
    joinCode: `P13${String(joinCodeSeed).padStart(3, "0")}`,
  });
}

async function addMembership(userId, firmId, role, status) {
  return FirmMembership.create({ userId, firmId, role, status });
}

const ownerA = await makeUser("owner-a@example.invalid", "Owner A");
const firmA = await makeFirm("Phase13 Firm A", "phase13-firm-a", ownerA._id, "EDIT");
await addMembership(ownerA._id, firmA._id, "OWNER", "ACTIVE");
ownerA.firmId = firmA._id;
await ownerA.save();

const ownerB = await makeUser("owner-b@example.invalid", "Owner B");
const firmB = await makeFirm("Phase13 Firm B", "phase13-firm-b", ownerB._id, "EDIT");
await addMembership(ownerB._id, firmB._id, "OWNER", "ACTIVE");
ownerB.firmId = firmB._id;
await ownerB.save();

// A firm whose memberAccess is READ_ONLY. That flag lives on Firm, not on the membership -
// requireFirmWriteAccess reads firm.memberAccess and bypasses it for OWNER/ADMIN/SUPER_ADMIN.
const ownerRO = await makeUser("owner-ro@example.invalid", "Owner RO");
const firmRO = await makeFirm("Phase13 Firm RO", "phase13-firm-ro", ownerRO._id, "READ_ONLY");
await addMembership(ownerRO._id, firmRO._id, "OWNER", "ACTIVE");

async function identity(email, name, firm, role, status, { globalRole = "USER", keepFirmId = true } = {}) {
  const u = await makeUser(email, name, globalRole);
  if (firm) {
    await addMembership(u._id, firm._id, role, status);
    if (keepFirmId) {
      u.firmId = firm._id;
      await u.save();
    }
  }
  return u;
}

const identities = {
  // 1. Not a member: a real signed-in user with no membership in firm A at all.
  nonMember: await identity("nonmember@example.invalid", "Non Member", null, null, null),
  // 2. Read-only member: MEMBER of a firm whose memberAccess is READ_ONLY.
  readOnly: await identity("readonly@example.invalid", "Read Only", firmRO, "MEMBER", "ACTIVE"),
  // 3. Member with write access.
  member: await identity("member@example.invalid", "Member", firmA, "MEMBER", "ACTIVE"),
  // 4. Firm admin.
  firmAdmin: await identity("admin@example.invalid", "Firm Admin", firmA, "ADMIN", "ACTIVE"),
  // 5. Platform super admin. Gated on BOTH role and the pinned email, per assertSuper.
  superAdmin: await identity(SUPER_EMAIL, "Super Admin", firmA, "ADMIN", "ACTIVE", {
    globalRole: "SUPER_ADMIN",
  }),
  // 6. REMOVED member - membership REMOVED but User.firmId deliberately left pointing at firm A.
  removed: await identity("removed@example.invalid", "Removed Member", firmA, "MEMBER", "REMOVED"),
};

function mint(u) {
  return jwt.sign(
    {
      id: String(u._id),
      email: u.email,
      role: u.role,
      accountType: u.accountType,
      firmId: u.firmId,
      isActive: u.isActive,
      tv: u.tokenVersion || 0,
    },
    process.env.JWT_SECRET,
    { expiresIn: "1h" },
  );
}

const tokens = Object.fromEntries(Object.entries(identities).map(([k, u]) => [k, mint(u)]));

// Print what each identity actually resolves to. authRequired re-reads firmId from the DATABASE,
// not from the token, so this is the value every gate will actually see.
console.log("=== identities as the server will see them ===");
for (const [k, u] of Object.entries(identities)) {
  const fresh = await User.findById(u._id).select("firmId role").lean();
  const m = await FirmMembership.findOne({ userId: u._id, firmId: firmA._id }).select("role status").lean();
  console.log(
    `  ${k.padEnd(11)} role=${String(fresh.role).padEnd(11)} firmId=${String(fresh.firmId).padEnd(26)} firmA-membership=${m ? m.role + "/" + m.status : "none"}`,
  );
}
console.log(`  firmA=${firmA._id}  firmRO=${firmRO._id}  firmB=${firmB._id}
`);

async function call(token, method, path, body) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${base}/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body */
  }
  return { status: r.status, json };
}

// ───────────────────────────────────────────────────────── the matrix

const ROUTES = [
  ["GET", "api/auth/me", undefined, "identity read"],
  ["GET", "api/firms/me", undefined, "firm read"],
  ["GET", "api/home/summary", undefined, "firm read"],
  ["GET", "api/reminders", undefined, "firm read"],
  ["POST", "api/reminders", { typeId: "P13-GSTR3B", clientLabel: "C", dueDateISO: "2026-12-31" }, "firm WRITE"],
  ["POST", "api/tasks", { title: "P13", clientName: "C", dueDateISO: "2026-12-31" }, "firm WRITE"],
  ["POST", "api/audit/insights", { text: "probe" }, "audit (W03: authRequired only)"],
];

const order = ["nonMember", "readOnly", "member", "firmAdmin", "superAdmin", "removed"];
const results = {};

console.log("=== A-13.01 full matrix: six identities x route families, by direct API call ===\n");
const head = "ROUTE".padEnd(34) + order.map((k) => k.slice(0, 10).padStart(11)).join("");
console.log(head);
console.log("-".repeat(head.length));

for (const [method, path, body, family] of ROUTES) {
  const row = [];
  for (const who of order) {
    const { status } = await call(tokens[who], method, path, body);
    row.push(status);
    results[`${method} ${path}`] = results[`${method} ${path}`] || {};
    results[`${method} ${path}`][who] = status;
  }
  console.log(`${method} ${path}`.padEnd(34) + row.map((s) => String(s).padStart(11)).join(""));
}
console.log(`\n(${ROUTES.map((r) => r[3]).filter((v, i, a) => a.indexOf(v) === i).join("; ")})`);

// ───────────────────────────────────────────────────────── targeted assertions

let pass = 0;
let fail = 0;
const findings = [];
function check(id, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  PASS ${id}  ${detail}`);
  } else {
    fail++;
    findings.push(`${id}: ${detail}`);
    console.log(`  FAIL ${id}  ${detail}`);
  }
}

// Decisive: a 200 does not prove a write happened. Print what the server actually returned for
// the cells that look like firm-isolation failures, and count what really persisted into firm A.
console.log("");
console.log("=== what POST /api/tasks actually returned ===");
for (const who of ["nonMember", "removed", "member"]) {
  const r = await call(tokens[who], "POST", "api/tasks", {
    title: `probe-${who}`, clientName: "C", dueDateISO: "2026-12-31",
  });
  console.log(`  ${who.padEnd(11)} status=${r.status} ok=${r.json?.ok} body=${JSON.stringify(r.json || {}).slice(0,140)}`);
}
{
  const { default: Task } = await import(toFileUrl("src", "models", "Task.js"));
  console.log(`  tasks persisted into firm A: ${await Task.countDocuments({ firmId: firmA._id })}`);
}

console.log("\n=== targeted assertions ===");

// A-13.02: requireFirmWriteAccess no-ops on GET, so a read-only member CAN read.
const roRead = results["GET api/home/summary"].readOnly;
check("A-13.02", roRead === 200, `read-only member GET /api/home/summary -> ${roRead} (expect 200: write gate no-ops on GET)`);

const roWrite = results["POST api/reminders"].readOnly;
check("A-13.02b", roWrite === 403, `read-only member POST /api/reminders -> ${roWrite} (expect 403)`);

// A-13.03 / W03: audit routes carry only authRequired, so even a user with no firm reaches them.
const auditNonMember = results["POST api/audit/insights"].nonMember;
check(
  "A-13.03",
  auditNonMember !== 403,
  `user with no firm POST /api/audit/insights -> ${auditNonMember} (W03: no firm gate, so NOT 403)`,
);

// A-13.05 - the REMOVED member, which the bar calls the most important identity.
//
// The first draft of this harness asserted a 403 and reported three failures. That was WRONG, and
// the diagnostics above are what caught it: the server does not refuse a removed member, it MOVES
// them to their own personal workspace. Their writes still return 200 - but they land in a
// different firmId. Asserting the status code would have reported a false finding against a system
// that is actually isolating correctly, by a different mechanism than expected. So the assertion
// below tests the invariant that matters - can firm A's data be reached - not the status code.
{
  const seeded = await FirmMembership.findOne({
    userId: identities.removed._id, firmId: firmA._id,
  }).select("status").lean();
  check("A-13.05a", seeded?.status === "REMOVED", `membership in firm A is REMOVED (setup is the real B7 shape)`);

  const write = await call(tokens.removed, "POST", "api/tasks", {
    title: "removed-should-not-reach-firm-A", clientName: "C", dueDateISO: "2026-12-31",
  });
  const landedIn = write.json?.task?.firmId;
  check(
    "A-13.05w",
    String(landedIn) !== String(firmA._id),
    `REMOVED member's write landed in ${landedIn} which is NOT firm A (${firmA._id})`,
  );

  const { default: Task } = await import(toFileUrl("src", "models", "Task.js"));
  const leaked = await Task.countDocuments({
    firmId: firmA._id, title: "removed-should-not-reach-firm-A",
  });
  check("A-13.05p", leaked === 0, `nothing the REMOVED member wrote persisted into firm A (found ${leaked})`);

  // And they must not be able to READ firm A's rows either.
  const firmARows = await call(tokens.member, "GET", "api/reminders");
  const removedRows = await call(tokens.removed, "GET", "api/reminders");
  const aIds = new Set((firmARows.json?.reminders || []).map((r) => String(r._id)));
  const overlap = (removedRows.json?.reminders || []).filter((r) => aIds.has(String(r._id)));
  check("A-13.05r", overlap.length === 0, `REMOVED member's reminder list shares 0 rows with firm A's (shared: ${overlap.length})`);
}

// A-13.13: a cross-tenant object id must never return another firm's data.
const bReminder = await call(tokens.member, "POST", "api/reminders", {
  typeId: "P13-GSTR3B", clientLabel: "firm A private", dueDateISO: "2026-12-31",
});
const foreignId = bReminder.json?.reminder?._id;
if (foreignId) {
  const cross = await call(tokens.nonMember, "GET", `api/reminders/${foreignId}`);
  const body = JSON.stringify(cross.json || {});
  check(
    "A-13.13",
    (cross.status === 403 || cross.status === 404) && !body.includes("firm A private"),
    `outsider GET /api/reminders/<firm A id> -> ${cross.status}, leaked title: ${body.includes("firm A private")}`,
  );
} else {
  check("A-13.13", false, "could not create a firm-A reminder to borrow an id from");
}

// A-13.06: a member of two firms must still be served for the firm they are scoped to.
await addMembership(identities.member._id, firmB._id, "MEMBER", "ACTIVE");
const multi = await call(tokens.member, "GET", "api/home/summary");
check("A-13.06", multi.status === 200, `multi-firm member still served for their active firm -> ${multi.status}`);

// A-13.07: the firm cache must be keyed by firm, not global. Two members of DIFFERENT firms hit
// the same endpoint back to back; if any response cache were global, the second read would be
// served the first firm's rows.
{
  const memberB = await identity("cache-b@example.invalid", "Cache B", firmB, "MEMBER", "ACTIVE");
  const tokenB = mint(memberB);
  await call(tokens.member, "POST", "api/reminders", {
    typeId: "P13-CACHE-A", clientLabel: "firm A only", dueDateISO: "2026-12-31",
  });
  await call(tokenB, "POST", "api/reminders", {
    typeId: "P13-CACHE-B", clientLabel: "firm B only", dueDateISO: "2026-12-31",
  });
  const aRows = JSON.stringify((await call(tokens.member, "GET", "api/reminders")).json || {});
  const bRows = JSON.stringify((await call(tokenB, "GET", "api/reminders")).json || {});
  check(
    "A-13.07",
    aRows.includes("firm A only") && !aRows.includes("firm B only") &&
    bRows.includes("firm B only") && !bRows.includes("firm A only"),
    "back-to-back reads by two firms each returned only their own rows (no global response cache)",
  );
}

// A-13.09: teardown - a token the server will not accept must fail EVERY route family, not just
// whichever one gets checked first. A gate that only guards the login surface is not a gate.
{
  const bad = tokens.member.slice(0, -6) + "AAAAAA"; // signature no longer verifies
  const statuses = [];
  for (const [method, path, body] of ROUTES) {
    statuses.push(method + " " + path + "=" + (await call(bad, method, path, body)).status);
  }
  const allRefused = statuses.every((x) => x.endsWith("=401"));
  check(
    "A-13.09",
    allRefused,
    "tampered token refused 401 on all " + ROUTES.length + " route families" +
      (allRefused ? "" : " -- " + statuses.join(" ")),
  );

  const none = [];
  for (const [method, path, body] of ROUTES) {
    none.push((await call(undefined, method, path, body)).status);
  }
  check(
    "A-13.09b",
    none.every((x) => x === 401),
    "no token at all refused 401 on every route family (got " + none.join(",") + ")",
  );
}

// A-13.10: an unknown route must 404 rather than fall through to a handler or blow up as a 500.
{
  const bogus = await call(tokens.member, "GET", "api/definitely-not-a-route");
  check("A-13.10", bogus.status === 404, "unknown route -> " + bogus.status + " (expect 404)");

  // A well-formed object id that belongs to nobody must 404/403, never 500 - a 500 would confirm
  // the id parsed and reached a query, which is itself a probe signal.
  const orphan = await call(tokens.member, "GET", "api/reminders/000000000000000000000000");
  check(
    "A-13.10b",
    orphan.status === 404 || orphan.status === 403,
    "unowned but well-formed id -> " + orphan.status + " (expect 404/403, never 500)",
  );
}

// A-13.12 live half: clientType is untrusted request metadata, so forging it must change nothing.
{
  const forged = await fetch(base + "/api/auth/me", {
    method: "GET",
    headers: {
      authorization: "Bearer " + tokens.member,
      "content-type": "application/json",
      "x-client-type": "desktop",
    },
  });
  const forgedBody = await forged.json().catch(() => ({}));
  const plain = await call(tokens.member, "GET", "api/auth/me");
  check(
    "A-13.12",
    forged.status === plain.status &&
      JSON.stringify(forgedBody?.user?.role) === JSON.stringify(plain.json?.user?.role),
    "forged x-client-type: desktop changed neither status (" + forged.status + " vs " +
      plain.status + ") nor the role the server reports back",
  );
}

// A-13.14: CORS, five origins probed against the real app instance. Judged on what the server
// ECHOES in access-control-allow-origin, because a missing echo is what actually stops a browser.
{
  // This harness sets NODE_ENV=production (line 25), so the expectations below are the PRODUCTION
  // policy. http://localhost:5173 is expected to be REFUSED here: app.js allows localhost only
  // under `!isProd`. The first draft of this probe expected localhost to be allowed and reported a
  // failure; the server was right and the expectation was wrong.
  //
  // The two lookalikes are the point of the test. app.js's own comment says the allowlist is an
  // exact-string match specifically because "a .startsWith() check would also let
  // https://caprotoolkit.in.evil.com through". These probes are that claim, executed.
  const origins = [
    ["https://caprotoolkit.in", true],
    ["https://www.caprotoolkit.in", true],
    ["chrome-extension://abcdefghijklmnopabcdefghijklmnop", true],
    ["http://localhost:5173", false],
    ["https://evil.example.com", false],
    ["http://caprotoolkit.in.evil.com", false],
    ["https://caprotoolkit.in.attacker.io", false],
    ["https://caprotoolkit.in.evil.com", false],
  ];
  const verdicts = [];
  let corsOk = true;
  for (const [origin, shouldAllow] of origins) {
    const r = await fetch(base + "/api/auth/me", {
      method: "OPTIONS",
      headers: {
        origin,
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    });
    const echoed = r.headers.get("access-control-allow-origin");
    const allowed = echoed === origin || echoed === "*";
    verdicts.push(origin + "->" + (echoed === null ? "none" : echoed));
    if (allowed !== shouldAllow) corsOk = false;
  }
  check("A-13.14", corsOk, "eight origin probes (production policy), allow-origin echoed: " + verdicts.join("  "));
}

// A-13.04 live half - the OCR gate, which W06 says a READ-ONLY member can reach and spend paid
// quota through. Read first, then probed: in case.routes.js the /ocr route is declared ABOVE the
// `router.use(authRequired, requireFirmMember, requireFirmWriteAccess, ...)` block and carries only
// authRequiredWithoutUsageTracking + requireFirmMember + requireFeatureFlag + a rate limiter. No
// write gate. This probe is that reading, executed against the running app.
{
  // A real 1x1 PNG, so multer's mimetype filter admits it and the request reaches the handler
  // rather than dying in the upload filter - otherwise a refusal would prove nothing about auth.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  async function ocrAs(token) {
    const form = new FormData();
    form.append("file", new Blob([png], { type: "image/png" }), "probe.png");
    const r = await fetch(base + "/api/cases/ocr", {
      method: "POST",
      headers: token ? { authorization: "Bearer " + token } : {},
      body: form,
    });
    return { status: r.status, body: (await r.text()).slice(0, 200) };
  }

  const ro = await ocrAs(tokens.readOnly);
  const nonMem = await ocrAs(tokens.nonMember);
  const anon = await ocrAs(undefined);

  // W06's first claim: no write gate on this route, so READ_ONLY is not turned away for lacking
  // write access. 403 here would REFUTE W06.
  check(
    "A-13.04",
    ro.status !== 403,
    "W06 CONFIRMED live: read-only member POST /api/cases/ocr -> " + ro.status +
      " (not 403, so the write gate genuinely does not cover this paid route)",
  );

  // The gates the route DOES carry must still hold, or the finding would be a different one.
  check("A-13.04b", anon.status === 401, "unauthenticated OCR -> " + anon.status + " (expect 401)");
  // This started as "expect 403" and failed. The server was right again. requireFirmMember cannot
  // 403 an authenticated user, because a user without a firm gets a PERSONAL firm provisioned
  // during the request - which is the same mechanism that sends the REMOVED member's writes
  // somewhere other than firm A (A-13.05w). Verified rather than assumed, below.
  //
  // That makes W06 WORSE than its own wording, and this is the honest statement of it: the paid
  // OCR route is reachable by ANY authenticated account, not merely by a read-only member of a
  // real firm. The only thing standing between a signed-up stranger and OCR.space spend is the
  // consent flag and the 20-per-5-minutes limiter.
  const nonMemAfter = await User.findById(identities.nonMember._id).select("firmId").lean();
  check(
    "A-13.04c",
    nonMem.status !== 403 && nonMemAfter.firmId != null,
    "any authenticated account reaches the paid OCR route -> " + nonMem.status +
      " (not 403), because a personal firm was provisioned mid-request (firmId was null at seed, is " +
      nonMemAfter.firmId + " now) so requireFirmMember is satisfied",
  );

  console.log("  A-13.04 bodies: readOnly=" + ro.status + " " + ro.body.replace(/\s+/g, " ").slice(0, 90));
}

console.log(`\n=== Phase 13 matrix: ${pass} passed, ${fail} failed ===`);
if (findings.length) {
  console.log("FINDINGS:");
  for (const f of findings) console.log("  -", f);
}

// Teardown, proved rather than assumed - V13's verify bullet requires a prefix query returning
// zero remaining records, and that the append-only collections are untouched because nothing was
// written to production. This harness is stronger than a prefix delete: every identity, firm,
// membership and row it creates lives in a scratch database that is dropped whole. Both halves are
// asserted below rather than stated.
{
  const dbNameUsed = mongoose.connection.name;
  const before = await mongoose.connection.db.listCollections().toArray();
  const beforeCounts = {};
  for (const c of before) {
    beforeCounts[c.name] = await mongoose.connection.db.collection(c.name).countDocuments();
  }
  const wroteSomething = Object.values(beforeCounts).some((n) => n > 0);

  await mongoose.connection.dropDatabase();

  const after = await mongoose.connection.db.listCollections().toArray();
  let remaining = 0;
  for (const c of after) {
    remaining += await mongoose.connection.db.collection(c.name).countDocuments();
  }

  console.log("");
  console.log("=== teardown ===");
  console.log("  scratch database      : " + dbNameUsed);
  console.log("  collections written   : " + before.length + " (" + Object.values(beforeCounts).reduce((a, b) => a + b, 0) + " documents)");
  console.log("  collections remaining : " + after.length + " (" + remaining + " documents)");
  check("A-13.T1", wroteSomething, "the run really did write data, so a zero afterwards means teardown and not a no-op");
  check("A-13.T2", remaining === 0 && after.length === 0, "every record created by this run is gone: " + remaining + " documents in " + after.length + " collections remain");
  check(
    "A-13.T3",
    /scratch|phase13|test/i.test(dbNameUsed),
    "the database dropped was the scratch one (" + dbNameUsed + "), never production - the guard at the top of this file refuses any other name",
  );
}

console.log("");
console.log(`=== Phase 13 matrix (incl. teardown): ${pass} passed, ${fail} failed ===`);

await mongoose.disconnect();
server.close();
process.exit(fail === 0 ? 0 : 1);
