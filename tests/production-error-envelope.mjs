// tests/production-error-envelope.mjs
//
// The first suite that boots the real Express app in **production mode** and calls it
// over HTTP. Everything else in tests/ either asserts source text or runs the app in
// development, where `publicErrorMessage` short-circuits and returns the raw error
// message. Production is the only mode where the public-code allow-list actually does
// anything, so it is the only mode where the error contract can be observed.
//
// Why this exists. Closing T31 and T37 left the same honest gap five times over: "no
// route was called against a running server". Most of it needs a database and an
// authenticated session, which is not available here. But a large part of the error
// contract fails **before any database access**, and that part can be executed rather
// than merely read:
//
//   - the Content-Type guard, which answers directly and NOT through the error handler
//   - body-parser failures, which do go through the error handler
//   - the authenticated /api/* catch-all
//   - CORS, security headers, and the multipart exemption
//
// No database is used. No credentials are read. Placeholder secrets only.

import mongoose from "mongoose";

// Fail Mongo-buffered queries fast instead of waiting out the 10s default. The
// maintenance gate queries AppConfig for any non-allowlisted /api/* path and then
// fails OPEN on error, so without this every probe below would take ten seconds.
mongoose.set("bufferTimeoutMS", 50);

process.env.NODE_ENV = "production";
process.env.JWT_SECRET = process.env.JWT_SECRET || "local-verification-only";
process.env.MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/capro-envelope-check";

const { default: app } = await import("../src/app.js");

const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass, detail });

async function call(path, options = {}) {
  const response = await fetch(base + path, options);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, json, text };
}

// ─── The app really is in production mode ───────────────────────────
// Proven by observable behaviour, not by trusting the env var: a malformed JSON body
// reaches the global error handler, and in production its message is replaced by the
// generic sentence while `stack` is withheld. In development the raw SyntaxError text
// would come through instead.

const malformed = await call("/api/app-config", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{ this is not json",
});

check(
  "malformed JSON is refused with a 400",
  malformed.status === 400,
  `status ${malformed.status}`,
);

check(
  "production genericises the parser error instead of leaking it",
  malformed.json?.error ===
    "Some submitted information could not be accepted. Review the form and try again.",
  `error: ${JSON.stringify(malformed.json?.error)}`,
);

check(
  "production withholds the stack",
  malformed.json != null && !("stack" in malformed.json),
  Object.keys(malformed.json || {}).join(", "),
);

check(
  "the parser error carries category INPUT_ERROR and a requestId",
  malformed.json?.category === "INPUT_ERROR" &&
    typeof malformed.json?.requestId === "string" &&
    malformed.json.requestId.length > 0,
  `category ${malformed.json?.category}, requestId ${malformed.json?.requestId ? "present" : "absent"}`,
);

check(
  "a non-public code emits no `code` field",
  malformed.json != null && !("code" in malformed.json),
  "only codes on PUBLIC_ERROR_CODES are placed on the wire",
);

// ─── The Content-Type guard answers directly, without the envelope ──
// Documented in docs/notices-cases-contract.md §3.1. This is the one error on the
// notices surface with no `category` and no `requestId`, because the guard responds
// itself rather than delegating to the error handler. A client error reader must
// tolerate their absence, so it is worth executing rather than assuming.

const wrongType = await call("/api/cases/ocr", {
  method: "POST",
  headers: { "Content-Type": "text/plain" },
  body: "consent=true",
});

check(
  "a non-JSON body on /api/cases/ocr is refused with 415",
  wrongType.status === 415,
  `status ${wrongType.status}`,
);

check(
  "that 415 names the required Content-Type",
  /Unsupported Media Type/.test(String(wrongType.json?.error || "")),
  JSON.stringify(wrongType.json?.error),
);

check(
  "that 415 carries NO category and NO requestId, unlike every other error",
  wrongType.json != null &&
    !("category" in wrongType.json) &&
    !("requestId" in wrongType.json),
  `fields: ${Object.keys(wrongType.json || {}).join(", ")}`,
);

// ─── The multipart exemption is an exact path match ─────────────────
// Documented open item: /api/cases/ocr/ with a trailing slash is refused by the guard
// even though the Express router would have matched it.

const exactMultipart = await call("/api/cases/ocr", {
  method: "POST",
  headers: { "Content-Type": "multipart/form-data; boundary=----xyz" },
  body: "------xyz--\r\n",
});

check(
  "multipart IS permitted on the exact path /api/cases/ocr",
  exactMultipart.status !== 415,
  `status ${exactMultipart.status} — passes the guard and is then stopped by authentication`,
);

const trailingSlash = await call("/api/cases/ocr/", {
  method: "POST",
  headers: { "Content-Type": "multipart/form-data; boundary=----xyz" },
  body: "------xyz--\r\n",
});

check(
  "multipart on /api/cases/ocr/ with a trailing slash is refused by the guard",
  trailingSlash.status === 415,
  `status ${trailingSlash.status} — the exemption compares req.path exactly`,
);

// ─── A zero-length body skips the guard ─────────────────────────────

const emptyBody = await call("/api/cases/ocr", {
  method: "POST",
  headers: { "Content-Type": "text/plain" },
});

check(
  "a zero-length body skips the Content-Type guard",
  emptyBody.status !== 415,
  `status ${emptyBody.status} — the guard returns early when content-length is 0`,
);

// ─── The authenticated catch-all ────────────────────────────────────
// app.use("/api", firmOperationsRoutes) plus router.use(authRequired) means an
// unmatched /api/* path answers 401 exactly like a present-but-protected one. This is
// why every deploy probe needs a control path.

const controlPath = await call("/api/auth/definitely-not-a-real-route-xyz", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
});

const realProtected = await call("/api/cases");

check(
  "an unmatched /api/* path answers 401, not 404",
  controlPath.status === 401,
  `status ${controlPath.status}`,
);

check(
  "a real protected route also answers 401 when unauthenticated",
  realProtected.status === 401,
  `status ${realProtected.status}`,
);

check(
  "the two are indistinguishable by body, which is why a control path is required",
  controlPath.json?.error === realProtected.json?.error &&
    typeof realProtected.json?.error === "string",
  `both: ${JSON.stringify(realProtected.json?.error)}`,
);

check(
  "the 401 carries a requestId, so the guard's 415 really is the exception",
  typeof realProtected.json?.requestId === "string" &&
    realProtected.json.requestId.length > 0,
  "confirms the missing requestId above is specific to the Content-Type guard",
);

// ─── Neither 401 leaks a status number or internals into the copy ───

const FORBIDDEN_COPY =
  /\bHTTP\b|\bnull\b|\bexception\b|\b(?:401|403|429|500)\b/i;

check(
  "no probed error message contains HTTP, null, exception or a bare status number",
  [malformed, wrongType, realProtected, controlPath].every(
    (result) => !FORBIDDEN_COPY.test(String(result.json?.error || "")),
  ),
  "user-facing copy rule holds on every envelope observed here",
);

// ─── CORS ───────────────────────────────────────────────────────────

const extensionPreflight = await call("/api/app-config", {
  method: "OPTIONS",
  headers: {
    Origin: "chrome-extension://emimafaefblkocfndndcgghbliodhnkp",
    "Access-Control-Request-Method": "GET",
  },
});

check(
  "the production extension origin is admitted by CORS",
  extensionPreflight.status === 204 &&
    extensionPreflight.headers.get("access-control-allow-origin") ===
      "chrome-extension://emimafaefblkocfndndcgghbliodhnkp",
  `status ${extensionPreflight.status}, allow-origin ${extensionPreflight.headers.get("access-control-allow-origin")}`,
);

const strangerOrigin = await call("/api/app-config", {
  method: "OPTIONS",
  headers: {
    Origin: "https://evil.example.invalid",
    "Access-Control-Request-Method": "GET",
  },
});

check(
  "an unknown web origin is not given an allow-origin header",
  strangerOrigin.headers.get("access-control-allow-origin") == null,
  `allow-origin ${strangerOrigin.headers.get("access-control-allow-origin")}`,
);

// ─── Security headers ───────────────────────────────────────────────

const health = await call("/health");

check(
  "/health is reachable without authentication",
  health.status === 200 || health.status === 503,
  `status ${health.status} — 503 is a legitimate not-ready answer with no database here`,
);

check(
  "clickjacking and sniffing protections are set",
  health.headers.get("x-frame-options") === "DENY" &&
    health.headers.get("x-content-type-options") === "nosniff",
  `x-frame-options ${health.headers.get("x-frame-options")}, x-content-type-options ${health.headers.get("x-content-type-options")}`,
);

check(
  "cross-domain policy and permissions policy are locked down",
  health.headers.get("x-permitted-cross-domain-policies") === "none" &&
    /camera=\(\)/.test(String(health.headers.get("permissions-policy") || "")),
  `${health.headers.get("x-permitted-cross-domain-policies")} / ${health.headers.get("permissions-policy")}`,
);

// ─── The JSON body cap ──────────────────────────────────────────────

const oversized = await call("/api/app-config", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ padding: "x".repeat(1_200_000) }),
});

check(
  "a body over the 1 MB cap is refused with 413",
  oversized.status === 413,
  `status ${oversized.status}`,
);

check(
  "the 413 is worded as a size limit and carries FILE_TOO_LARGE",
  oversized.json?.category === "FILE_TOO_LARGE" &&
    /exceeds the permitted size/.test(String(oversized.json?.error || "")),
  `category ${oversized.json?.category}, error ${JSON.stringify(oversized.json?.error)}`,
);

// ─── Report ───────────────────────────────────────────────────────

server.close();

let passed = 0;
for (const entry of checks) {
  const mark = entry.pass ? "PASS" : "FAIL";
  if (entry.pass) passed += 1;
  console.log(
    `[${mark}] ${entry.name}${entry.detail ? ` — ${entry.detail}` : ""}`,
  );
}

const total = checks.length;
console.log(`\nProduction error envelope: ${passed}/${total}`);

if (passed !== total) {
  console.error(`\n${total - passed} check(s) failed.`);
  process.exit(1);
}
