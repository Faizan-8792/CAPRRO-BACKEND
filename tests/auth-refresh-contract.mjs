// tests/auth-refresh-contract.mjs
//
// PHASE 8: the sliding-session renewal route, the client session-event route
// and the auth-health analytics, driven against the real app on scratch
// Mongo. Pins the security model while proving the usability fix:
//   - a live token refreshes into a fresh token with the same identity;
//   - an EXPIRED token is refused (no replay grace), and the refusal is
//     recorded as a failed renewal attributed to the verified subject;
//   - a tokenVersion bump (force-logout) refuses refresh even while the old
//     token still verifies cryptographically;
//   - an inactive account is refused;
//   - the client session-event route accepts only its fixed vocabulary and
//     requires authentication, and every reason it accepts is storable;
//   - anonymous rejections are coalesced, so a flood of refused requests
//     costs a bounded number of writes while the counts stay exact;
//   - the admin summary is super-admin only and carries no secrets.

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

async function runSuite() {
  process.env.NODE_ENV = "production";
  process.env.JWT_SECRET = "auth-refresh-contract-only-not-a-real-secret";
  for (const outbound of ["RESEND_API_KEY", "DEEPSEEK_API_KEY", "OCR_SPACE_API_KEY", "HOSTINGER_API_TOKEN", "CAPTCHA_API"]) {
    process.env[outbound] = "";
  }

  const mongoose = (await import("mongoose")).default;
  const jwt = (await import("jsonwebtoken")).default;
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  await mongoose.connection.dropDatabase();
  const { default: User } = await import("../src/models/User.js");
  const { default: AuthHealthEvent } = await import("../src/models/AuthHealthEvent.js");
  const { flushAuthHealth } = await import("../src/services/auth-health.service.js");
  const { default: app } = await import("../src/app.js");
  const { SUPER_ADMIN_EMAIL } = await import("../src/middleware/authorization.middleware.js");
  await AuthHealthEvent.init();

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(path, { token, method = "POST", body, headers: extra = {} } = {}) {
    const headers = { "Content-Type": "application/json", ...extra };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(base + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: response.status, json, text };
  }

  function signFor(user, { expiresIn = "2d", tv, client = "extension", at, iat } = {}) {
    return jwt.sign(
      {
        ...(at === undefined ? {} : { at }),
        ...(iat === undefined ? {} : { iat }),
        id: String(user._id),
        email: user.email,
        role: user.role,
        accountType: user.accountType,
        firmId: user.firmId || null,
        isActive: user.isActive,
        client,
        ...(tv === undefined ? {} : { tv }),
      },
      process.env.JWT_SECRET,
      { expiresIn },
    );
  }

  async function sumOf(filter) {
    await flushAuthHealth();
    const rows = await AuthHealthEvent.find(filter).lean();
    return rows.reduce((total, row) => total + (row.count || 1), 0);
  }

  try {
    const user = await User.create({
      email: "refresh-contract@example.com",
      name: "Refresh Contract",
      role: "USER",
      accountType: "INDIVIDUAL",
      tokenVersion: 0,
    });

    // 1. A live token refreshes.
    const live = signFor(user);
    const refreshed = await call("/api/auth/refresh", { token: live, headers: { "X-CaPro-Client-Version": "1.4.14" } });
    check("a live token refreshes with ok:true", refreshed.status === 200 && refreshed.json?.ok === true, JSON.stringify(refreshed.json).slice(0, 120));
    check("the fresh token carries the same identity", String(refreshed.json?.user?.id) === String(user._id) && refreshed.json?.user?.email === user.email);
    const freshDecoded = jwt.decode(refreshed.json?.token || "");
    check(
      "the fresh token is a full-lived successor with the current version",
      freshDecoded?.tv === 0 && typeof freshDecoded?.exp === "number" && freshDecoded.exp > Math.floor(Date.now() / 1000) + 6 * 24 * 60 * 60,
    );
    check("the fresh token keeps the client claim", freshDecoded?.client === "extension");
    const desktopFresh = await call("/api/auth/refresh", { token: signFor(user, { client: "desktop" }) });
    check("a desktop token refreshes as a desktop token", jwt.decode(desktopFresh.json?.token || "")?.client === "desktop");

    // 1b. Sessions are not indefinite: the sign-in time travels through every
    //     renewal and caps it.
    const nowSeconds = Math.floor(Date.now() / 1000);
    const DAY = 24 * 60 * 60;
    const { sessionMaxAgeSeconds } = await import("../src/controllers/auth-refresh.controller.js");
    check("the session cap defaults to 30 days", sessionMaxAgeSeconds(undefined) === 30 * DAY);
    check("a malformed cap falls back to 30 days, never unlimited",
      [ "abc", "0", "-5", "1000", "Infinity", "" ].every((value) => sessionMaxAgeSeconds(value) === 30 * DAY));
    check("a configured cap is honoured", sessionMaxAgeSeconds("90") === 90 * DAY);
    const signedInAt = nowSeconds - 3 * DAY;
    const carried = await call("/api/auth/refresh", { token: signFor(user, { at: signedInAt }) });
    check("the successor carries the original sign-in time", jwt.decode(carried.json?.token || "")?.at === signedInAt);
    const nearCap = nowSeconds - (30 * DAY - 2 * 60 * 60);
    const capped = await call("/api/auth/refresh", { token: signFor(user, { at: nearCap }) });
    const cappedExp = jwt.decode(capped.json?.token || "")?.exp || 0;
    check("a renewal near the cap ends exactly at the cap", capped.status === 200 && cappedExp === nearCap + 30 * DAY, `exp ${cappedExp} vs ${nearCap + 30 * DAY}`);
    const pastCap = await call("/api/auth/refresh", { token: signFor(user, { at: nowSeconds - 31 * DAY }) });
    check("a sign-in past the cap cannot renew", pastCap.status === 401 && pastCap.json?.code === "SESSION_MAX_AGE", `status ${pastCap.status}`);
    check("the cap refusal is recorded as max_age", (await sumOf({ kind: "refresh_fail", reason: "max_age" })) === 1);
    const legacyIat = nowSeconds - 2 * DAY;
    const legacy = await call("/api/auth/refresh", { token: signFor(user, { iat: legacyIat, expiresIn: "5d" }) });
    check("a token minted before the at claim measures its cap from its issue time", jwt.decode(legacy.json?.token || "")?.at === legacyIat);
    const legacyOld = await call("/api/auth/refresh", { token: signFor(user, { iat: nowSeconds - 31 * DAY, expiresIn: "40d" }) });
    check("an old pre-claim token past the cap cannot renew", legacyOld.status === 401 && legacyOld.json?.code === "SESSION_MAX_AGE");

    // The successor works as a session token.
    const me = await call("/api/auth/me", { token: refreshed.json?.token, method: "GET" });
    check("the refreshed token authenticates /auth/me", me.status === 200 && me.json?.ok === true);

    // 2. An expired token is refused outright, and recorded as a failed
    //    renewal attributed to the verified subject.
    const expired = signFor(user, { expiresIn: "-1h" });
    const expiredResult = await call("/api/auth/refresh", { token: expired });
    check("an expired token cannot refresh (no replay grace)", expiredResult.status === 401);
    check(
      "the expired refusal is a refresh_fail/expired for that user",
      (await sumOf({ kind: "refresh_fail", reason: "expired", userId: user._id })) === 1,
    );
    // The same expired token on an ordinary route is a rejection, not a failed renewal.
    await call("/api/auth/me", { token: expired, method: "GET" });
    check(
      "an expired token elsewhere is an auth_rejection/expired with its platform",
      (await sumOf({ kind: "auth_rejection", reason: "expired", userId: user._id, platform: "extension" })) === 1,
    );

    // A forged token stays anonymous - the server cannot trust its subject.
    const forged = jwt.sign({ id: String(user._id), client: "desktop" }, "not-our-secret", { expiresIn: "1h" });
    const forgedResult = await call("/api/auth/refresh", { token: forged });
    check("a forged token cannot refresh", forgedResult.status === 401);
    check(
      "a forged token is recorded as invalid, anonymous, platform unknown",
      (await sumOf({ kind: "refresh_fail", reason: "invalid", userId: null, platform: "unknown" })) === 1,
    );

    // 3. A revocation bump refuses refresh even for a cryptographically valid token.
    const staleLive = signFor(user, { tv: 0 });
    await User.updateOne({ _id: user._id }, { $set: { tokenVersion: 1 } });
    const revoked = await call("/api/auth/refresh", { token: staleLive });
    check("a tokenVersion bump refuses refresh (revocation kills renewal)", revoked.status === 401);
    check("the revocation is recorded in auth-health analytics", (await sumOf({ kind: "refresh_fail", reason: "revoked" })) === 1);

    // 4. An inactive account is refused.
    await User.updateOne({ _id: user._id }, { $set: { tokenVersion: 2, isActive: false } });
    const inactiveToken = signFor(user, { tv: 2 });
    const inactive = await call("/api/auth/refresh", { token: inactiveToken });
    check("an inactive account cannot refresh", inactive.status === 403, `status ${inactive.status}`);
    check("the inactive refusal is recorded", (await sumOf({ kind: "refresh_fail", reason: "inactive" })) === 1);

    // 5. No token: rejected by the middleware.
    const anonymous = await call("/api/auth/refresh", {});
    check("refresh requires authentication", anonymous.status === 401);

    // 6. Session events: fixed vocabulary, authenticated only, every accepted
    //    reason storable (a reason the model's enum refuses is a silently
    //    lost event - the bug this pins).
    await User.updateOne({ _id: user._id }, { $set: { isActive: true } });
    const goodToken = signFor(user, { tv: 2 });
    const event = await call("/api/auth/session-event", { token: goodToken, body: { kind: "signed_out", reason: "signed_out" } });
    check("a client session-event is accepted", event.status === 200 && event.json?.ok === true);
    await call("/api/auth/session-event", { token: goodToken, body: { kind: "session_restored", reason: "restart" } });
    await call("/api/auth/session-event", { token: goodToken, body: { kind: "refresh_retry", reason: "race" } });
    await call("/api/auth/session-event", { token: goodToken, body: { kind: "refresh_retry", reason: "server_error" } });
    await call("/api/auth/session-event", { token: goodToken, body: { kind: "refresh_retry", reason: "rate_limited" } });
    await call("/api/auth/session-event", { token: goodToken, body: { kind: "refresh_retry", reason: "<script>" } });
    check("session_restored/restart is stored", (await sumOf({ kind: "session_restored", reason: "restart" })) === 1);
    check("refresh_retry/race is stored", (await sumOf({ kind: "refresh_retry", reason: "race" })) === 1);
    check("refresh_retry/server_error and rate_limited are stored",
      (await sumOf({ kind: "refresh_retry", reason: "server_error" })) === 1 && (await sumOf({ kind: "refresh_retry", reason: "rate_limited" })) === 1);
    check("free-text reasons collapse to unknown", (await sumOf({ kind: "refresh_retry", reason: "unknown" })) === 1);
    const badEvent = await call("/api/auth/session-event", { token: goodToken, body: { kind: "admin_action", reason: "because" } });
    check("an unknown event kind is refused", badEvent.status === 400);
    const anonEvent = await call("/api/auth/session-event", { body: { kind: "signed_out" } });
    check("session events require authentication", anonEvent.status === 401);
    const stored = await AuthHealthEvent.findOne({ kind: "signed_out" }).lean();
    const storedKeys = Object.keys(stored || {}).sort().join(",");
    check(
      "a stored event holds only coarse fields",
      storedKeys === "__v,_id,appVersion,count,createdAt,kind,occurredAt,platform,reason,userId",
      storedKeys,
    );

    // 7. Refresh success is recorded with the reported version.
    check("refresh success is recorded with its client version", (await sumOf({ kind: "refresh_success", appVersion: "1.4.14" })) === 1);

    // 8. Coalescing: twenty anonymous refusals cost one row and count twenty.
    await flushAuthHealth();
    const rowsBefore = await AuthHealthEvent.countDocuments({ kind: "auth_rejection", reason: "no_credentials" });
    for (let i = 0; i < 20; i += 1) {
      await call("/api/auth/me", { method: "GET" });
    }
    await flushAuthHealth();
    const rowsAfter = await AuthHealthEvent.countDocuments({ kind: "auth_rejection", reason: "no_credentials" });
    check("twenty anonymous refusals are written as one row", rowsAfter - rowsBefore === 1, `${rowsAfter - rowsBefore} rows`);
    check("the coalesced row counts all twenty", (await sumOf({ kind: "auth_rejection", reason: "no_credentials" })) >= 20);

    // 9. Login failures are recorded (OTP path, unknown account).
    const otpFail = await call("/api/auth/verify-otp", { body: { email: "nobody-here@example.com", otp: "000000" } });
    check("a failed OTP sign-in is refused", otpFail.status === 404);
    check("the failed sign-in is a login_fail for the website", (await sumOf({ kind: "login_fail", reason: "invalid", platform: "website" })) === 1);

    // 10. The admin summary: super-admin only, aggregate only.
    const notAdmin = await call("/api/super/auth-health?days=7", { token: goodToken, method: "GET" });
    check("a non-super-admin cannot read auth health", notAdmin.status === 403, `status ${notAdmin.status}`);
    const admin = await User.create({
      email: SUPER_ADMIN_EMAIL,
      name: "Super",
      role: "SUPER_ADMIN",
      accountType: "INDIVIDUAL",
      tokenVersion: 0,
    });
    const summary = await call("/api/super/auth-health?days=7", { token: signFor(admin), method: "GET" });
    check("the super admin reads the summary", summary.status === 200 && summary.json?.ok === true, `status ${summary.status}`);
    check("the summary window is the one asked for", summary.json?.windowDays === 7);
    check("the summary totals sum coalesced counts", (summary.json?.totals?.auth_rejection || 0) >= 21);
    check(
      "the summary splits refresh failures by reason",
      ["expired", "revoked", "inactive", "invalid"].every((reason) =>
        (summary.json?.byKindReason || []).some((row) => row.kind === "refresh_fail" && row.reason === reason)),
    );
    check("the summary carries a version split", (summary.json?.byVersion || []).some((row) => row.appVersion === "1.4.14"));
    check(
      "the summary carries no identifiers or secrets",
      !/refresh-contract@example\.com|eyJ|userId|"_id"/.test(summary.text),
    );
    // The signed_out after the expired refusal pairs into one finished session?
    // No sign-in was recorded in this run, so the distribution must be empty -
    // non-login events must never be bucketed as sessions.
    check(
      "no sign-in recorded means no session durations",
      Array.isArray(summary.json?.sessionDurationHours) && summary.json.sessionDurationHours.length === 0,
      JSON.stringify(summary.json?.sessionDurationHours),
    );
    const unbounded = await call("/api/super/auth-health?days=99999", { token: signFor(admin), method: "GET" });
    check("the window is capped at 365 days", unbounded.json?.windowDays === 365);

    // 11. Rate limit: bounded per account.
    await User.updateOne({ _id: user._id }, { $set: { tokenVersion: 3 } });
    const rateToken = signFor(user, { tv: 3 });
    let limited = false;
    for (let i = 0; i < 40 && !limited; i += 1) {
      const result = await call("/api/auth/refresh", { token: rateToken });
      if (result.status === 429) limited = true;
    }
    check("refresh is rate-limited per account", limited);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await flushAuthHealth();
    await mongoose.connection.dropDatabase().catch(() => {});
    await mongoose.disconnect();
  }

  console.log(`\nAuth refresh contract: ${passed} passed, ${failed} failed`);
  return failed === 0 ? 0 : 1;
}

if (!isLoopbackScratch(uri)) {
  console.error("Refusing to run: MONGODB_URI must be a loopback scratch database.");
  process.exitCode = 1;
} else {
  process.exitCode = await runSuite();
}
