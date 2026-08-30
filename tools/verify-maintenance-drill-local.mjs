// tools/verify-maintenance-drill-local.mjs
//
// O12's "Maintenance drill, performed and dated" Verify bullet asks for it against a real deployed
// backend. This does NOT do that -- it exercises the exact same mechanism (maintenanceGate,
// updateMaintenance, the real ALLOW_PREFIXES allowlist) against a local backend on a scratch
// database, following the same safety pattern as drive-local-panel.mjs. It answers "does the code
// do what the runbook will claim it does" without touching production, which no agent may put into
// maintenance mode unilaterally -- that takes the real service offline for real users.
//
// THIS IS NOT A SUBSTITUTE for the production drill. It is supplementary mechanism evidence, and is
// recorded as such.
//
// SAFETY, same three guards as drive-local-panel.mjs:
//   1. MONGODB_URI must be loopback and carry a scratch marker.
//   2. The outbound provider keys are blanked in this process.
//   3. The scratch database is dropped at the end, including on failure.
import { setTimeout as sleep } from "node:timers/promises";

const SCRATCH_MARKER = "capro-maintenance-drill-local";
const MONGO_URI = `mongodb://127.0.0.1:27117/${SCRATCH_MARKER}`;

process.env.NODE_ENV = "development";
process.env.JWT_SECRET = "local-maintenance-drill-only-not-a-real-secret";
process.env.MONGODB_URI = MONGO_URI;
for (const outbound of ["RESEND_API_KEY", "DEEPSEEK_API_KEY", "OCR_SPACE_API_KEY", "HOSTINGER_API_TOKEN"]) {
  process.env[outbound] = "";
}

function assertLoopback(label, value) {
  const host = /^mongodb:\/\/([^/:]+)/.exec(value)?.[1] ?? new URL(value).hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error(`${label} must be loopback, got ${host} - refusing to run`);
  }
}
assertLoopback("MONGODB_URI", MONGO_URI);
if (!MONGO_URI.includes(SCRATCH_MARKER)) {
  throw new Error("MONGODB_URI must name the scratch database - refusing to run");
}

const mongoose = (await import("mongoose")).default;
const jwt = (await import("jsonwebtoken")).default;
const { default: app } = await import("../src/app.js");
const { default: User } = await import("../src/models/User.js");
const { default: AppConfig } = await import("../src/models/AppConfig.js");

let pass = 0, fail = 0;
const failures = [];
function check(id, ok, detail) {
  if (ok) { pass += 1; console.log(`  PASS ${id}  ${detail}`); }
  else { fail += 1; failures.push(id); console.log(`  FAIL ${id}  ${detail}`); }
}

const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://localhost:${server.address().port}`;
assertLoopback("API base", base);
console.log("LOCAL maintenance-mode mechanism drill (NOT the production drill)");
console.log(`  api   ${base}`);
console.log(`  mongo ${MONGO_URI}`);
console.log("");

async function cleanup() {
  try {
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.dropDatabase();
      console.log(`  scratch database ${SCRATCH_MARKER} dropped`);
    }
  } catch (error) {
    console.log(`  WARNING could not drop the scratch database: ${error.message}`);
  }
  try { await mongoose.disconnect(); } catch { /* already closed */ }
  await new Promise((resolve) => server.close(resolve));
}

try {
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  await mongoose.connection.dropDatabase();

  // assertSuper (appconfig.controller.js:12-18) hardcodes role AND this exact email - matching it
  // is required for the real super-admin route to accept the request, not optional test setup.
  const superUser = await User.create({
    email: "saifullahfaizan786@gmail.com",
    name: "Local Drill Super Admin",
    role: "SUPER_ADMIN",
    accountType: "INDIVIDUAL",
  });
  await AppConfig.create({ _id: "singleton" });

  const superToken = jwt.sign(
    { id: String(superUser._id), email: superUser.email, role: superUser.role,
      accountType: superUser.accountType, firmId: null, isActive: true, tv: 0 },
    process.env.JWT_SECRET,
    { expiresIn: "1h" },
  );
  const authed = (path, init = {}) =>
    fetch(`${base}${path}`, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${superToken}` } });

  // wait for background bootstrap() to finish, same as any real deploy's health check would -
  // probing /health immediately after listen() catches it mid-"initializing", which is a real,
  // documented, normal startup transient (see the health handler's own comment), not a defect.
  // NOT a wait-for-ready loop: app.js:143-144 says plainly "server.js owns background
  // initialization and marks readiness true only after indexes and schedulers are ready" - and
  // this harness, like drive-local-panel.mjs before it, imports app.js and calls app.listen(0)
  // directly, never running server.js's own bootstrap. So backgroundInitializationReady can never
  // become true here, by construction, regardless of how long this waits. Confirmed rather than
  // assumed: it stayed "initializing" through a full 60s wait during development of this script.
  // This means /health's own 200/503 status - which this harness cannot make happen - is OUT OF
  // SCOPE for this local drill; it is not a claim this script can honestly make either way.
  const probe = await fetch(`${base}/health`).then((r) => r.json()).catch(() => null);
  console.log(`  NOTE /health reads background="${probe?.background}" in this harness - by design`);
  console.log(`       (server.js's bootstrap never runs here; see comment above). This is a`);
  console.log(`       harness limitation, not evidence about the real deployed server's /health.`);

  // --- baseline: maintenance OFF ---
  const before = await fetch(`${base}/api/clients`);
  check("baseline-protected-route-not-503", before.status !== 503, `GET /api/clients -> ${before.status} before engaging maintenance`);

  // --- engage maintenance via the REAL super-admin route, not a direct model write ---
  const engage = await authed("/api/app-config/maintenance", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ maintenanceMode: true, maintenanceMessage: "Local drill - scheduled maintenance" }),
  });
  const engageBody = await engage.json().catch(() => ({}));
  check("engage-succeeds", engage.status === 200 && engageBody.maintenanceMode === true, `PATCH .../maintenance {true} -> ${engage.status}, maintenanceMode=${engageBody.maintenanceMode}`);

  // --- protected route now refused ---
  const during = await fetch(`${base}/api/clients`);
  const duringBody = await during.json().catch(() => ({}));
  check("protected-route-503-during-maintenance", during.status === 503, `GET /api/clients -> ${during.status}, body error=${duringBody.error}`);
  check("503-carries-configured-message", duringBody.message === "Local drill - scheduled maintenance", `message="${duringBody.message}"`);

  // --- /health specifically: prove maintenanceGate does not intercept it, separately from
  // whether /health's OWN unrelated background-readiness check reports itself healthy (which this
  // harness cannot produce - see the note above). The two are different claims; only the first is
  // this drill's business.
  const healthDuring = await fetch(`${base}/health`);
  const healthDuringBody = await healthDuring.json().catch(() => ({}));
  check(
    "health-not-intercepted-by-maintenance-gate",
    healthDuringBody.error !== "maintenance",
    `GET /health during maintenance -> ${healthDuring.status}, body.error=${healthDuringBody.error ?? "(none)"} - not the maintenance-block shape`,
  );

  // --- every remaining allowlisted prefix must still answer, none of them 503-for-maintenance ---
  const allowlistProbes = [
    ["GET", "/api/app-config"],
    ["POST", "/api/auth/send-otp"],       // auth/* - expect a real validation response, just not 503
    ["GET", "/api/super/dashboard-stats"], // super/* - authed
    ["GET", "/api/digests/unsubscribe?token=x"],
  ];
  for (const [method, path] of allowlistProbes) {
    const needsAuth = path.startsWith("/api/super");
    const response = await fetch(`${base}${path}`, {
      method,
      headers: needsAuth ? { Authorization: `Bearer ${superToken}` } : {},
      ...(method === "POST" ? { headers: { "Content-Type": "application/json", ...(needsAuth ? { Authorization: `Bearer ${superToken}` } : {}) }, body: "{}" } : {}),
    });
    check(`allowlist-stays-up ${method} ${path}`, response.status !== 503, `-> ${response.status} (not 503)`);
  }

  // --- lift maintenance ---
  const lift = await authed("/api/app-config/maintenance", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ maintenanceMode: false }),
  });
  const liftBody = await lift.json().catch(() => ({}));
  check("lift-succeeds", lift.status === 200 && liftBody.maintenanceMode === false, `PATCH .../maintenance {false} -> ${lift.status}, maintenanceMode=${liftBody.maintenanceMode}`);

  await sleep(200); // config cache is 30s in production but this suite writes the same document read next request
  const after = await fetch(`${base}/api/clients`);
  check("protected-route-restored-after-lift", after.status !== 503, `GET /api/clients -> ${after.status} after lifting maintenance`);

  // --- fail-open honesty check: a config read failure must not accidentally engage maintenance ---
  // (documented behaviour, not exercised destructively here - see O12 step 9's own note)

  console.log("");
  console.log(`passed: ${pass}  failed: ${fail}`);
  if (fail > 0) console.log(`failing: ${failures.join(", ")}`);
  console.log(fail === 0 ? "LOCAL MAINTENANCE MECHANISM DRILL OK (not a substitute for the production drill)" : "LOCAL MAINTENANCE MECHANISM DRILL FAILED");
  await cleanup();
  process.exit(fail === 0 ? 0 : 1);
} catch (error) {
  console.error("FATAL", error);
  await cleanup();
  process.exit(1);
}
