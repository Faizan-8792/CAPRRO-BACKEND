// Checks the DEPLOYED backend's runtime posture — the things no offline suite can see.
//
//   CAPRO_TOKEN=<super-admin jwt> node tools/verify-live-posture.mjs
//   node tools/verify-live-posture.mjs          # runs the checks that need no auth
//
// WHY THIS EXISTS
// ---------------
// O17. `production-error-envelope`, `error-contract-invariants` and Phase 13's A-13.14 CORS probe
// all pass, and all three run against a locally started app with NODE_ENV=production set by the
// harness. They are correct tests of the code. They cannot see the deployed environment, and on
// 2026-08-24 the deployed environment did not have NODE_ENV=production, which put five isProd-gated
// behaviours into their development form — including returning stack traces to clients and granting
// CORS to any http://localhost origin.
//
// A-13.14 asserted that http://localhost:5173 is refused. That is true locally and was false in
// production. This file is the check that would have caught it.
//
// Exit 0 only if every executed check passes.

const BASE = process.env.CAPRO_API_BASE || "https://api.caprotoolkit.in";
const TOKEN = process.env.CAPRO_TOKEN;

let pass = 0;
let fail = 0;
let skipped = 0;

function check(id, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  PASS ${id}  ${detail}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${id}  ${detail}`);
  }
}
function skip(id, why) {
  skipped += 1;
  console.log(`  SKIP ${id}  ${why}`);
}

const cb = () => `cb=${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

console.log("=== 1. CORS: the localhost branch must be unreachable in production ===");
// app.js:346 allows any http://localhost origin only when !isProd. If one is echoed back, the
// deployed NODE_ENV is not "production".
for (const origin of ["http://localhost:5173", "http://localhost:3000"]) {
  const r = await fetch(`${BASE}/api/auth/me?${cb()}`, {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": "GET",
      "access-control-request-headers": "authorization",
    },
  });
  const echoed = r.headers.get("access-control-allow-origin");
  check(
    "CORS-localhost",
    echoed === null,
    `${origin} -> allow-origin: ${echoed ?? "none (correct)"}`,
  );
}

console.log("");
console.log("=== 2. CORS: the real allow-list must still work, and lookalikes must still fail ===");
for (const [origin, shouldAllow] of [
  ["https://caprotoolkit.in", true],
  ["https://www.caprotoolkit.in", true],
  ["https://evil.example.com", false],
  ["http://caprotoolkit.in.evil.com", false],
]) {
  const r = await fetch(`${BASE}/api/auth/me?${cb()}`, {
    method: "OPTIONS",
    headers: { origin, "access-control-request-method": "GET" },
  });
  const echoed = r.headers.get("access-control-allow-origin");
  const allowed = echoed === origin || echoed === "*";
  check(
    "CORS-allowlist",
    allowed === shouldAllow,
    `${origin} -> ${echoed ?? "none"} (expected ${shouldAllow ? "allowed" : "refused"})`,
  );
}

console.log("");
console.log("=== 3. error bodies must not carry a stack trace ===");
// Unauthenticated 401s are cheap and always available.
{
  const r = await fetch(`${BASE}/api/auth/me?${cb()}`, {
    headers: { authorization: "Bearer not.a.real.token" },
  });
  const body = await r.json().catch(() => ({}));
  check(
    "NO-STACK-401",
    !("stack" in body),
    `401 body keys: [${Object.keys(body).join(", ")}]`,
  );
}

// A server-side failure is the case that actually leaked. Needs auth, so it is optional.
if (TOKEN) {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const form = new FormData();
  form.append("file", new Blob([png], { type: "image/png" }), "probe.png");
  form.append("consent", "true");
  const r = await fetch(`${BASE}/api/cases/ocr?${cb()}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
    body: form,
  });
  const body = await r.json().catch(() => ({}));
  const hasStack = "stack" in body;
  check(
    "NO-STACK-5xx",
    !hasStack,
    `HTTP ${r.status}, keys: [${Object.keys(body).join(", ")}]` +
      (hasStack ? " — a stack trace is being returned to clients" : ""),
  );
  if (hasStack) {
    const leaksPath = /file:\/\/\/|\/home\/|[A-Za-z]:\\\\/.test(String(body.stack));
    check("NO-SERVER-PATHS", !leaksPath, `the stack ${leaksPath ? "contains" : "does not contain"} absolute server paths`);
  }
} else {
  skip("NO-STACK-5xx", "set CAPRO_TOKEN to a super-admin JWT to exercise the server-error path");
  skip("NO-SERVER-PATHS", "same");
}

console.log("");
console.log("=== 4. the service is actually up ===");
{
  const r = await fetch(`${BASE}/health?${cb()}`);
  const body = await r.json().catch(() => ({}));
  check("HEALTH", body.status === "ok", `status=${body.status} background=${body.background}`);
}

console.log("");
console.log(`=== live posture: ${pass} passed, ${fail} failed, ${skipped} skipped ===`);
if (fail > 0) {
  console.log("");
  console.log("If CORS-localhost and NO-STACK failed together, the cause is almost certainly one");
  console.log("thing: NODE_ENV is not \"production\" on the deployed host (app.js:219). See O17.");
}
process.exit(fail === 0 ? 0 : 1);
