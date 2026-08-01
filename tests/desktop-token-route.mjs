// tests/desktop-token-route.mjs
// Verifies POST /api/auth/google/desktop-token is mounted and validates input
// before any call reaches Google. Uses placeholder env values only; no real
// credentials are read or written. Never calls the live Google token endpoint
// because every case here fails validation first.
process.env.NODE_ENV = process.env.NODE_ENV || "development";
process.env.JWT_SECRET = process.env.JWT_SECRET || "local-verification-only";
process.env.MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/capro-route-check";
process.env.GOOGLE_DESKTOP_CLIENT_SECRET =
  process.env.GOOGLE_DESKTOP_CLIENT_SECRET || "local-placeholder";

const { default: app } = await import("../src/app.js");

const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const route = "/api/auth/google/desktop-token";

const validCode = "a".repeat(24);
const validVerifier = "b".repeat(64);
const loopback = "http://127.0.0.1:52123/oauth2/callback/";

const cases = [
  {
    name: "empty body is rejected before contacting Google",
    body: {},
    expectStatus: 400,
    expectError: /authorization code is required/i,
  },
  {
    name: "short PKCE verifier is rejected",
    body: { code: validCode, codeVerifier: "tooshort", redirectUri: loopback },
    expectStatus: 400,
    expectError: /code verifier/i,
  },
  {
    name: "non-loopback redirect is rejected",
    body: {
      code: validCode,
      codeVerifier: validVerifier,
      redirectUri: "https://attacker.example.com/callback",
    },
    expectStatus: 400,
    expectError: /loopback/i,
  },
  {
    name: "https loopback redirect is rejected",
    body: {
      code: validCode,
      codeVerifier: validVerifier,
      redirectUri: "https://127.0.0.1:52123/oauth2/callback/",
    },
    expectStatus: 400,
    expectError: /loopback/i,
  },
];

const failures = [];

for (const testCase of cases) {
  const response = await fetch(base + route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(testCase.body),
  });
  const payload = await response.json().catch(() => ({}));

  const statusOk = response.status === testCase.expectStatus;
  const errorOk = testCase.expectError.test(String(payload?.error || ""));

  console.log(
    `${statusOk && errorOk ? "[PASS]" : "[FAIL]"} ${testCase.name} ` +
      `(status ${response.status}: ${payload?.error || ""})`
  );

  if (!statusOk || !errorOk) failures.push(testCase.name);
}

// The route must be reachable without a bearer token. If it were missing, the
// request would fall through to the /api router that requires authentication.
const unauthenticated = await fetch(base + route, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
});
const unauthenticatedBody = await unauthenticated.json().catch(() => ({}));
const isMounted = !/Authorization header/i.test(String(unauthenticatedBody?.error || ""));
console.log(
  `${isMounted ? "[PASS]" : "[FAIL]"} route is public and mounted under /api/auth`
);
if (!isMounted) failures.push("route is public and mounted under /api/auth");

await new Promise((resolve) => server.close(resolve));

console.log(
  `\nResult: ${cases.length + 1 - failures.length} passed, ${failures.length} failed`
);
process.exitCode = failures.length === 0 ? 0 : 1;
