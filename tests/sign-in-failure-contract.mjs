// tests/sign-in-failure-contract.mjs
//
// DS44 (2026-10-14): failed sign-ins, each recorded with its own cause, and the two causes that
// were never the person's fault no longer failing. Driven against the real app on scratch Mongo,
// with Google scripted - nothing in this suite reaches Google or any other outside host.
//
// Before DS44 every failed Google sign-in was recorded as "invalid" from an "unknown" app, an
// OTP slip as "invalid" ("Token not recognised" on the panel), and the desktop's code exchange and
// every rate-limit refusal were not recorded at all. Each check below fails on that code:
//   - a moment when Google could not be reached refused a genuine sign-in (401); now retried once,
//     and if Google stays away the answer is 502 "Google could not be reached";
//   - Google rotating its keys ("No pem found") refused a genuine sign-in; now fresh keys, once more;
//   - expired, early, foreign-audience and forged tokens, unverified emails, the desktop audience,
//     missing or outdated terms, each OTP slip, the desktop's code exchange and every limiter
//     refusal each record a reason of their own, for the app the request came from.

const uri = (() => {
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === "--mongo-uri") return process.argv[i + 1];
  }
  return process.env.MONGODB_URI || "";
})();

function isLoopbackScratch(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
    return loopback && parsed.pathname.toLowerCase().includes("scratch");
  } catch {
    return false;
  }
}

let passed = 0;
let failed = 0;
function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

const EXTENSION_CLIENT = "contract-extension.apps.googleusercontent.com";
const DESKTOP_CLIENT = "contract-desktop.apps.googleusercontent.com";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

function idTokenFor(claims) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: "https://accounts.google.com", iat: now, exp: now + 3600, email_verified: true, ...claims };
  return `${b64url({ alg: "RS256", kid: "contract", typ: "JWT" })}.${b64url(payload)}.Y29udHJhY3Q`;
}

function payloadOf(token) {
  return JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8"));
}

// The shape google-auth-library 10 (gaxios 7) throws when a request to Google fails on the way:
// GaxiosError("fetch failed") <- TypeError("fetch failed") <- the socket error carrying the code.
function networkError(code) {
  const socket = Object.assign(new Error(`connect ${code}`), { code });
  const fetchFailed = new TypeError("fetch failed", { cause: socket });
  const gaxios = new Error("fetch failed", { cause: fetchFailed });
  gaxios.name = "GaxiosError";
  gaxios.error = fetchFailed;
  return gaxios;
}

// google-auth-library's own refusals carry the decoded payload in the message.
function libraryError(opening, payload = {}) {
  return new Error(`${opening}: ${JSON.stringify(payload)}`);
}

async function runSuite() {
  process.env.NODE_ENV = "production";
  process.env.JWT_SECRET = "sign-in-failure-contract-only-not-a-real-secret";
  process.env.GOOGLE_CLIENT_ID = EXTENSION_CLIENT;
  process.env.GOOGLE_CLIENT_IDS = "";
  process.env.GOOGLE_DESKTOP_CLIENT_ID = DESKTOP_CLIENT;
  process.env.GOOGLE_DESKTOP_CLIENT_SECRET = "contract-only-not-a-real-secret";
  for (const outbound of ["RESEND_API_KEY", "DEEPSEEK_API_KEY", "OCR_SPACE_API_KEY", "HOSTINGER_API_TOKEN", "CAPTCHA_API"]) {
    process.env[outbound] = "";
  }

  // ---- Google, scripted. A queued Error is thrown; a queued object is the answer. ----
  const { OAuth2Client } = await import("google-auth-library");
  const idSteps = [];
  const infoSteps = [];
  let idCalls = 0;
  OAuth2Client.prototype.verifyIdToken = async function verifyIdToken({ idToken }) {
    idCalls += 1;
    const step = idSteps.shift();
    if (step instanceof Error) throw step;
    const payload = step || payloadOf(idToken);
    return { getPayload: () => payload };
  };
  OAuth2Client.prototype.getTokenInfo = async function getTokenInfo() {
    const step = infoSteps.shift();
    if (step instanceof Error) throw step;
    return step;
  };
  const realFetch = globalThis.fetch;
  const tokenSteps = [];
  let tokenCalls = 0;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target === GOOGLE_TOKEN_ENDPOINT) {
      tokenCalls += 1;
      const step = tokenSteps.shift();
      if (step instanceof Error) throw step;
      return new Response(JSON.stringify(step.body), { status: step.status, headers: { "Content-Type": "application/json" } });
    }
    if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(target)) {
      throw new Error("the contract refuses every request that leaves this machine");
    }
    return realFetch(url, init);
  };

  const mongoose = (await import("mongoose")).default;
  const jwt = (await import("jsonwebtoken")).default;
  const crypto = await import("node:crypto");
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  await mongoose.connection.dropDatabase();
  const { default: User } = await import("../src/models/User.js");
  const { default: AuthHealthEvent, AUTH_HEALTH_REASONS } = await import("../src/models/AuthHealthEvent.js");
  const { flushAuthHealth } = await import("../src/services/auth-health.service.js");
  const { CURRENT_TERMS } = await import("../src/config/current-terms.js");
  const { default: app } = await import("../src/app.js");
  const { SUPER_ADMIN_EMAIL } = await import("../src/middleware/authorization.middleware.js");
  await AuthHealthEvent.init();

  let identity = null;
  try {
    identity = await import("../src/services/google-identity.service.js");
  } catch {
    identity = null;
  }

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(path, { token, method = "POST", body } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: response.status, json };
  }

  async function count(filter) {
    await flushAuthHealth();
    const rows = await AuthHealthEvent.find(filter).lean();
    return rows.reduce((total, row) => total + (row.count || 1), 0);
  }

  const signIn = (body) => call("/api/auth/google", { body });
  const extensionToken = (email, extra = {}) => idTokenFor({ aud: EXTENSION_CLIENT, email, name: "Contract User", ...extra });
  const desktopToken = (email, extra = {}) => idTokenFor({ aud: DESKTOP_CLIENT, email, name: "Contract User", ...extra });
  const currentTerms = { version: CURRENT_TERMS.version, documentHash: CURRENT_TERMS.documentHash, accepted: true };

  try {
    // ---- 1. The classification itself (pure). ----
    check("google-identity.service.js exists", Boolean(identity));
    if (identity) {
      const { classifyGoogleError, platformFromGoogleToken, isConnectError } = identity;
      const lost = classifyGoogleError(networkError("ECONNRESET"));
      check("a request to Google lost on the way is 'google_unreachable', 502, worth a retry",
        lost.reason === "google_unreachable" && lost.status === 502 && lost.retry === true, JSON.stringify(lost));
      check("Google answering 503 is 'google_unreachable'",
        classifyGoogleError(Object.assign(new Error("Service Unavailable"), { status: 503 })).reason === "google_unreachable");
      const late = classifyGoogleError(libraryError("Token used too late, 1 > 0", { name: "Network fetch failed timed out", aud: "x" }));
      check("a name inside the payload cannot turn an expired token into a network failure",
        late.reason === "google_expired" && late.retry === false, JSON.stringify(late));
      check("'No pem found' asks for fresh keys",
        classifyGoogleError(libraryError("No pem found for envelope", { kid: "new" })).freshKeys === true);
      check("an unparseable token is 'invalid' and not retried",
        classifyGoogleError(new Error("Wrong number of segments in token: abc")).reason === "invalid");
      check("the desktop app's audience reads as desktop",
        platformFromGoogleToken(desktopToken("a@example.com"), { desktopClientId: DESKTOP_CLIENT, clientIds: [EXTENSION_CLIENT, DESKTOP_CLIENT] }) === "desktop");
      check("the extension's audience reads as extension",
        platformFromGoogleToken(extensionToken("a@example.com"), { desktopClientId: DESKTOP_CLIENT, clientIds: [EXTENSION_CLIENT, DESKTOP_CLIENT] }) === "extension");
      check("a foreign audience or garbage reads as unknown",
        platformFromGoogleToken(idTokenFor({ aud: "someone-else" }), { desktopClientId: DESKTOP_CLIENT, clientIds: [EXTENSION_CLIENT] }) === "unknown" &&
        platformFromGoogleToken("not a token", { desktopClientId: DESKTOP_CLIENT, clientIds: [EXTENSION_CLIENT] }) === "unknown");
      check("only a failure before connecting is safe to send again",
        isConnectError(networkError("ECONNREFUSED")) === true && isConnectError(networkError("ECONNRESET")) === false);
    }
    check("every new reason is storable",
      ["no_account", "no_otp", "otp_expired", "wrong_otp", "otp_locked", "google_unreachable", "google_expired", "google_rejected",
        "audience", "desktop_audience", "email_unverified", "clock", "terms_required", "terms_outdated", "bad_request", "not_configured"]
        .every((reason) => AUTH_HEALTH_REASONS.includes(reason)));

    // ---- 2. Google sign-in: the two failures that were never the person's. ----
    idSteps.push(networkError("ECONNRESET"));
    let before = idCalls;
    const retried = await signIn({ idToken: extensionToken("retry-user@example.com") });
    check("a sign-in during a moment Google could not be reached succeeds on the retry",
      retried.status === 200 && typeof retried.json?.token === "string", `status ${retried.status}`);
    check("the retry asked Google exactly twice", idCalls - before === 2, `${idCalls - before} calls`);

    idSteps.push(networkError("ETIMEDOUT"), networkError("ETIMEDOUT"));
    const away = await signIn({ idToken: extensionToken("away-user@example.com") });
    check("Google still unreachable on the retry answers 502 GOOGLE_UNREACHABLE, not 'Invalid Google token'",
      away.status === 502 && away.json?.code === "GOOGLE_UNREACHABLE" && /could not be reached/.test(away.json?.error || ""),
      `status ${away.status} ${JSON.stringify(away.json)}`);
    check("... recorded as google_unreachable from the extension",
      (await count({ kind: "login_fail", reason: "google_unreachable", platform: "extension" })) === 1);

    idSteps.push(libraryError("No pem found for envelope", { kid: "rotated" }));
    const rotated = await signIn({ idToken: extensionToken("rotated-user@example.com") });
    check("a sign-in just after Google rotated its keys succeeds with fresh keys",
      rotated.status === 200 && typeof rotated.json?.token === "string", `status ${rotated.status}`);

    // ---- 3. Google sign-in: each refusal names its own cause and app. ----
    idSteps.push(libraryError("Token used too late, 1760000000 > 1759990000", { aud: EXTENSION_CLIENT }));
    const late = await signIn({ idToken: extensionToken("late@example.com") });
    check("an expired Google token is refused", late.status === 401);
    check("... recorded as google_expired from the extension", (await count({ kind: "login_fail", reason: "google_expired", platform: "extension" })) === 1);

    idSteps.push(libraryError("Token used too early, 1760000000 < 1760000900", { aud: DESKTOP_CLIENT }));
    await signIn({ idToken: desktopToken("early@example.com"), clientType: "DESKTOP", termsAcceptance: currentTerms });
    check("a token dated after the server's clock is recorded as clock, from the desktop",
      (await count({ kind: "login_fail", reason: "clock", platform: "desktop" })) === 1);

    idSteps.push(libraryError("Wrong recipient, payload audience != requiredAudience", { aud: "someone-else" }));
    await signIn({ idToken: idTokenFor({ aud: "someone-else", email: "foreign@example.com" }) });
    check("a token issued to another app is recorded as audience, from an unknown app",
      (await count({ kind: "login_fail", reason: "audience", platform: "unknown" })) === 1);

    idSteps.push(new Error("Invalid token signature: eyJhbGciOi.forged.sig"));
    const forged = await signIn({ idToken: extensionToken("forged@example.com") });
    check("a forged token is still 'Invalid Google token', 401", forged.status === 401 && forged.json?.error === "Invalid Google token");
    check("... recorded as invalid from the extension", (await count({ kind: "login_fail", reason: "invalid", platform: "extension" })) === 1);

    await signIn({ idToken: extensionToken("unverified@example.com", { email_verified: false }) });
    check("an unverified Google email is recorded as email_unverified, from the extension",
      (await count({ kind: "login_fail", reason: "email_unverified", platform: "extension" })) === 1);

    await signIn({ idToken: extensionToken("pretender@example.com"), clientType: "DESKTOP", termsAcceptance: currentTerms });
    check("a desktop request with another app's token is recorded as desktop_audience",
      (await count({ kind: "login_fail", reason: "desktop_audience", platform: "desktop" })) === 1);

    await User.create({ email: "desk-user@example.com", role: "USER", accountType: "INDIVIDUAL", isActive: true });
    const noTerms = await signIn({ idToken: desktopToken("desk-user@example.com"), clientType: "DESKTOP" });
    check("a desktop sign-in without accepting the terms is refused as before", noTerms.json?.code === "TERMS_ACCEPTANCE_REQUIRED");
    // Without the account: a refused desktop sign-in never looks the user up (terms-acceptance-contract).
    check("... and now recorded as terms_required, without looking the account up",
      (await count({ kind: "login_fail", reason: "terms_required", platform: "desktop", userId: null })) === 1);

    const oldTerms = await signIn({
      idToken: desktopToken("desk-user@example.com"),
      clientType: "DESKTOP",
      termsAcceptance: { version: "2020-01-01", documentHash: "a".repeat(64), accepted: true },
    });
    check("an acceptance of earlier terms is refused as before", oldTerms.json?.code === "TERMS_VERSION_MISMATCH");
    check("... and now recorded as terms_outdated", (await count({ kind: "login_fail", reason: "terms_outdated", platform: "desktop" })) === 1);

    await signIn({});
    check("a request with no token is recorded as bad_request", (await count({ kind: "login_fail", reason: "bad_request" })) === 1);

    infoSteps.push(Object.assign(new Error("invalid_token"), { status: 400 }));
    await signIn({ accessToken: "ya29.contract-not-a-real-token" });
    check("a revoked access token is recorded as google_expired from the extension",
      (await count({ kind: "login_fail", reason: "google_expired", platform: "extension" })) === 2);

    // ---- 4. The desktop's code exchange: recorded at all, and retried only when safe. ----
    const verifier = "v".repeat(64);
    const exchange = (extra = {}) => call("/api/auth/google/desktop-token", {
      body: { code: "4/contract-code", codeVerifier: verifier, redirectUri: "http://127.0.0.1:51789/", ...extra },
    });

    tokenSteps.push({ status: 400, body: { error: "invalid_grant", error_description: "Bad Request" } });
    const refused = await exchange();
    check("Google refusing the desktop's code still answers 401 with Google's words", refused.status === 401 && refused.json?.error === "Bad Request");
    check("... and is now recorded as google_rejected from the desktop",
      (await count({ kind: "login_fail", reason: "google_rejected", platform: "desktop" })) === 1);

    tokenSteps.push(networkError("ECONNREFUSED"), { status: 200, body: { id_token: desktopToken("desk-user@example.com") } });
    before = tokenCalls;
    const reconnected = await exchange();
    check("a code exchange that never connected is sent again and succeeds",
      reconnected.status === 200 && typeof reconnected.json?.idToken === "string", `status ${reconnected.status}`);
    check("... with exactly one more request to Google", tokenCalls - before === 2, `${tokenCalls - before} calls`);

    tokenSteps.push(networkError("ECONNRESET"));
    before = tokenCalls;
    const reset = await exchange();
    check("a code exchange cut off after connecting is not sent again (the code may be used up)",
      reset.status === 502 && tokenCalls - before === 1, `status ${reset.status}, ${tokenCalls - before} calls`);

    tokenSteps.push({ status: 503, body: { error: "backend_error" } });
    const down = await exchange();
    check("Google's own outage answers 502 'could not be reached', not a refusal of the person",
      down.status === 502 && /could not be reached/.test(down.json?.error || ""), `status ${down.status}`);
    check("... both recorded as google_unreachable from the desktop",
      (await count({ kind: "login_fail", reason: "google_unreachable", platform: "desktop" })) === 2);

    await exchange({ codeVerifier: "short" });
    check("an incomplete exchange request is recorded as bad_request from the desktop",
      (await count({ kind: "login_fail", reason: "bad_request", platform: "desktop" })) === 1);

    // ---- 5. The Google limiter's refusal is recorded (it shares 20 a window with the exchange). ----
    let limitedGoogle = null;
    for (let i = 0; i < 25 && !limitedGoogle; i += 1) {
      const result = await signIn({ idToken: extensionToken("busy@example.com") });
      if (result.status === 429) limitedGoogle = result;
    }
    check("the Google sign-in limit still refuses with its own words",
      limitedGoogle?.json?.error === "Too many sign-in attempts. Try again in 15 minutes.");
    check("... and the refusal is recorded as rate_limited from the extension",
      (await count({ kind: "login_fail", reason: "rate_limited", platform: "extension" })) >= 1);

    // ---- 6. The OTP sign-in: each slip by name. ----
    const otp = (email, code) => call("/api/auth/verify-otp", { body: { email, otp: code } });
    const hash = (code) => crypto.createHash("sha256").update(String(code)).digest("hex");

    check("an unknown address is refused as before", (await otp("nobody-here@example.com", "123456")).status === 404);
    check("... recorded as no_account", (await count({ kind: "login_fail", reason: "no_account", platform: "website" })) === 1);

    const otpUser = await User.create({ email: "otp-user@example.com", role: "USER", accountType: "INDIVIDUAL", isActive: true });
    await otp("otp-user@example.com", "123456");
    check("no code asked for is recorded as no_otp", (await count({ kind: "login_fail", reason: "no_otp", userId: otpUser._id })) === 1);

    await User.updateOne({ _id: otpUser._id }, { $set: { otpCodeHash: hash("123456"), otpExpiresAt: new Date(Date.now() - 60_000) } });
    await otp("otp-user@example.com", "123456");
    check("an old code is recorded as otp_expired", (await count({ kind: "login_fail", reason: "otp_expired", userId: otpUser._id })) === 1);

    await User.updateOne({ _id: otpUser._id }, { $set: { otpCodeHash: hash("123456"), otpExpiresAt: new Date(Date.now() + 600_000), otpAttempts: 0 } });
    for (let i = 0; i < 4; i += 1) await otp("otp-user@example.com", "000000");
    check("four mistyped codes are recorded as wrong_otp", (await count({ kind: "login_fail", reason: "wrong_otp", userId: otpUser._id })) === 4);
    const fifth = await otp("otp-user@example.com", "000000");
    check("the fifth locks the account for a while, as before", fifth.status === 429);
    await otp("otp-user@example.com", "123456");
    check("the lock and a try during it are recorded as otp_locked",
      (await count({ kind: "login_fail", reason: "otp_locked", userId: otpUser._id })) === 2);

    await call("/api/auth/verify-otp", { body: { email: "otp-user@example.com" } });
    check("a request without a code is recorded as bad_request from the website",
      (await count({ kind: "login_fail", reason: "bad_request", platform: "website" })) === 1);

    const limitedOtp = await otp("otp-user@example.com", "123456");
    check("the eleventh code check in the window is refused by the limiter with its own words",
      limitedOtp.status === 429 && limitedOtp.json?.error === "Too many verification attempts. Try again in 15 minutes.",
      `status ${limitedOtp.status}`);
    check("... and recorded as rate_limited from the website",
      (await count({ kind: "login_fail", reason: "rate_limited", platform: "website" })) === 1);

    // ---- 7. The summary passes the new reasons through. ----
    const admin = await User.create({ email: SUPER_ADMIN_EMAIL, name: "Super", role: "SUPER_ADMIN", accountType: "INDIVIDUAL", tokenVersion: 0 });
    const adminToken = jwt.sign(
      { id: String(admin._id), email: admin.email, role: admin.role, accountType: admin.accountType, firmId: null, isActive: true, client: "extension", tv: 0 },
      process.env.JWT_SECRET,
      { expiresIn: "1h" },
    );
    const summary = await call("/api/super/auth-health?days=1", { token: adminToken, method: "GET" });
    const rows = summary.json?.byKindReason || [];
    check("the Sign-in health summary carries the new reasons",
      ["wrong_otp", "google_unreachable", "terms_required", "google_rejected"].every((reason) =>
        rows.some((row) => row.kind === "login_fail" && row.reason === reason)),
      `status ${summary.status}`);

    // ---- 8. The renewal limiter, then the API-wide limiter, both recorded. ----
    const renewer = await User.create({ email: "renewer@example.com", role: "USER", accountType: "INDIVIDUAL", isActive: true, tokenVersion: 0 });
    const renewToken = jwt.sign(
      { id: String(renewer._id), email: renewer.email, role: "USER", accountType: "INDIVIDUAL", firmId: null, isActive: true, client: "desktop", tv: 0, at: Math.floor(Date.now() / 1000) },
      process.env.JWT_SECRET,
      { expiresIn: "2d" },
    );
    let limitedRenewal = false;
    for (let i = 0; i < 40 && !limitedRenewal; i += 1) {
      if ((await call("/api/auth/refresh", { token: renewToken })).status === 429) limitedRenewal = true;
    }
    check("renewals past the per-account limit are refused, as before", limitedRenewal);
    check("... and recorded as a refused renewal, rate_limited, from the desktop",
      (await count({ kind: "refresh_fail", reason: "rate_limited", platform: "desktop", userId: renewer._id })) >= 1);

    let limitedAll = null;
    for (let i = 0; i < 260 && !limitedAll; i += 1) {
      const result = await call("/api/auth/terms/current", { method: "GET" });
      if (result.status === 429) limitedAll = result;
    }
    check("the API-wide limit still refuses with its own words",
      limitedAll?.json?.error === "Too many requests, please try again later.");
    const beforeAll = await count({ kind: "login_fail", reason: "rate_limited", platform: "website" });
    const blockedSignIn = await otp("otp-user@example.com", "123456");
    check("a sign-in refused by the API-wide limit is recorded as rate_limited",
      blockedSignIn.status === 429 && (await count({ kind: "login_fail", reason: "rate_limited", platform: "website" })) === beforeAll + 1);
    const otherRoutes = await count({ kind: { $nin: ["login_fail", "refresh_fail"] }, reason: "rate_limited" });
    check("refusals on other routes record nothing", otherRoutes === 0, `${otherRoutes} recorded`);
  } finally {
    globalThis.fetch = realFetch;
    await new Promise((resolve) => server.close(resolve));
    await flushAuthHealth();
    await mongoose.connection.dropDatabase().catch(() => {});
    await mongoose.disconnect();
  }

  console.log(`\nSign-in failure contract: ${passed} passed, ${failed} failed`);
  return failed === 0 ? 0 : 1;
}

if (!isLoopbackScratch(uri)) {
  console.error("Refusing to run: MONGODB_URI must be a loopback scratch database.");
  process.exitCode = 1;
} else {
  process.exitCode = await runSuite();
}
