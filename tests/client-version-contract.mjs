// tests/client-version-contract.mjs
//
// O11: enforce a minimum supported desktop-client version, additively and
// fail-open, at src/middleware/client-version.middleware.js. No live
// MongoDB and no live server -- same convention as
// tests/provider-quota-contract.mjs's Part D: call the REAL, unmodified
// exported middleware function directly with a minimal fake req/res/next, and
// stub only the one real Mongo call (AppConfig.getInstance) it depends on.
//
// A live HTTP-level pass of bullets (f) and the wire-level/live-observation
// bullets this task's own Verify text separately lists (curling a real
// running server, raising/lowering the floor from the real admin route, a
// real desktop build) is recorded outside this file, since those need a
// server this suite deliberately does not require in order to stay part of
// the mandatory no-database gate (run-gates.ps1).

const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass, detail });

const { default: AppConfig } = await import("../src/models/AppConfig.js");
const { clientVersionGate, evaluateClientVersion } = await import(
  "../src/middleware/client-version.middleware.js"
);

function stubAppConfig(minSupportedVersion) {
  AppConfig.getInstance = async () => ({
    desktopRelease: { minSupportedVersion },
  });
}

function fakeReqRes({ path, headerValue }) {
  const state = { status: null, body: null, nextCalledWith: "not-called" };
  const req = {
    path,
    id: "req-abc-123",
    get(name) {
      if (name === "X-CaPro-Client-Version") return headerValue;
      return undefined;
    },
  };
  const res = {
    status(code) {
      state.status = code;
      return res;
    },
    json(payload) {
      state.body = payload;
      return res;
    },
  };
  const next = (err) => {
    state.nextCalledWith = err === undefined ? "called" : err;
  };
  return { req, res, next, state };
}

async function run(path, headerValue, minSupportedVersion) {
  stubAppConfig(minSupportedVersion);
  const { req, res, next, state } = fakeReqRes({ path, headerValue });
  await clientVersionGate(req, res, next);
  return state;
}

// ─── Pure decision function, in isolation ──────────────────────────────
{
  check(
    "evaluateClientVersion: no header -> not blocked",
    evaluateClientVersion(undefined, "1.0.0").blocked === false,
  );
  check(
    "evaluateClientVersion: garbage header -> not blocked (never throws/400s)",
    evaluateClientVersion("not-a-version", "1.0.0").blocked === false,
  );
  check(
    "evaluateClientVersion: unset floor -> never blocked regardless of header",
    evaluateClientVersion("0.0.1", "").blocked === false,
  );
  check(
    "evaluateClientVersion: below floor -> blocked",
    evaluateClientVersion("0.0.9", "1.0.0").blocked === true,
  );
  check(
    "evaluateClientVersion: equal to floor -> not blocked (inclusive)",
    evaluateClientVersion("1.0.0", "1.0.0").blocked === false,
  );
  check(
    "evaluateClientVersion: above floor -> not blocked",
    evaluateClientVersion("2.0.0", "1.0.0").blocked === false,
  );
}

// ─── (a) NO version header -> proceeds, asserted on a PROTECTED route ──
{
  const state = await run("/api/audit/refine", undefined, "1.0.0");
  check(
    "(a) no header on a protected route proceeds even with a floor configured",
    state.nextCalledWith === "called" && state.status === null,
  );
}
{
  // Same case again with an absurdly high floor -- fail-open must hold no
  // matter how high the floor is, because every desktop in the field today
  // sends no header at all.
  const state = await run("/api/tasks", undefined, "99.0.0");
  check(
    "(a) no header still proceeds even with an extreme floor (99.0.0)",
    state.nextCalledWith === "called" && state.status === null,
  );
}

// ─── (b) below floor -> 426 CLIENT_UPDATE_REQUIRED ─────────────────────
{
  const state = await run("/api/audit/refine", "0.0.9", "1.0.0");
  check(
    "(b) '0.0.9' vs floor '1.0.0' answers 426",
    state.status === 426,
  );
  check(
    "(b) 426 body carries code CLIENT_UPDATE_REQUIRED",
    state.body?.code === "CLIENT_UPDATE_REQUIRED",
  );
  check(
    "(b) 426 body carries the minSupportedVersion field",
    state.body?.minSupportedVersion === "1.0.0",
  );
  check(
    "(b) 426 body carries a non-empty requestId",
    typeof state.body?.requestId === "string" && state.body.requestId.length > 0,
  );
  check(
    "(b) next() was NOT called when blocked",
    state.nextCalledWith === "not-called",
  );
}

// ─── (c) equal to floor -> proceeds (inclusive) ────────────────────────
{
  const state = await run("/api/audit/refine", "1.0.0", "1.0.0");
  check(
    "(c) header equal to the floor proceeds (floor is inclusive)",
    state.nextCalledWith === "called" && state.status === null,
  );
}

// ─── (d) above floor -> proceeds ────────────────────────────────────────
{
  const state = await run("/api/audit/refine", "2.0.0", "1.0.0");
  check(
    "(d) header above the floor proceeds",
    state.nextCalledWith === "called" && state.status === null,
  );
}

// ─── (e) garbage header -> proceeds, NOT 400 ───────────────────────────
{
  const state = await run("/api/audit/refine", "not-a-version", "1.0.0");
  check(
    "(e) garbage header proceeds rather than answering 400",
    state.nextCalledWith === "called" && state.status === null,
  );
}
{
  // A 4-part .NET-style version (Assembly.GetExecutingAssembly().GetName()
  // .Version, e.g. "0.1.1.0") must parse -- this is the exact shape the
  // desktop actually sends per O11 step 2.
  const state = await run("/api/audit/refine", "0.1.1.0", "1.0.0.0");
  check(
    "4-part .NET-style version strings compare correctly (below a 4-part floor)",
    state.status === 426 && state.body?.minSupportedVersion === "1.0.0.0",
  );
}

// ─── (f) allowlist prevents the deadlock: app-config and health always 200,
// even with an extreme floor and a stale header ───────────────────────
{
  const state = await run("/api/app-config", "0.0.1", "99.0.0");
  check(
    "(f) /api/app-config bypasses the gate entirely (extreme floor, stale header)",
    state.nextCalledWith === "called" && state.status === null,
  );
}
{
  const state = await run("/health", "0.0.1", "99.0.0");
  check(
    "(f) /health bypasses the gate entirely (extreme floor, stale header)",
    state.nextCalledWith === "called" && state.status === null,
  );
}
{
  const state = await run("/api/auth/me", "0.0.1", "99.0.0");
  check(
    "(f) /api/auth/* bypasses the gate entirely, so a stranded user can still sign in",
    state.nextCalledWith === "called" && state.status === null,
  );
}

// ─── Fail-open on an AppConfig read error (DB blip), matching maintenanceGate's
// own rule: never block traffic on infrastructure trouble unrelated to the
// client's own version. ─────────────────────────────────────────────────
{
  AppConfig.getInstance = async () => {
    throw new Error("simulated DB blip");
  };
  const { req, res, next, state } = fakeReqRes({
    path: "/api/audit/refine",
    headerValue: "0.0.1",
  });
  await clientVersionGate(req, res, next);
  check(
    "AppConfig read failure fails OPEN rather than blocking or 500ing",
    state.nextCalledWith === "called" && state.status === null,
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Report
// ═══════════════════════════════════════════════════════════════════════

let passed = 0;
for (const entry of checks) {
  const mark = entry.pass ? "PASS" : "FAIL";
  if (entry.pass) passed += 1;
  console.log(`[${mark}] ${entry.name}${entry.detail ? ` — ${entry.detail}` : ""}`);
}

const total = checks.length;
console.log(`\nClient version contract: ${passed}/${total}`);

if (passed !== total) {
  console.error(`\n${total - passed} check(s) failed.`);
  process.exit(1);
}
