// tests/digest-unsubscribe-link.mjs
//
// Root-cause coverage for the no-login, one-click digest-email unsubscribe
// flow: an HMAC-signed link in the email footer (and List-Unsubscribe /
// List-Unsubscribe-Post headers, RFC 8058) that opens a public confirmation
// page and, once confirmed, stops that email (or all digest email) without
// requiring the recipient to sign in.
//
// Three layers, matching how the feature is actually built:
//   1. Token issuance/verification (buildDigestUnsubscribeToken /
//      digestUnsubscribeTokenMatches) - pure HMAC logic, no DB.
//   2. previewDigestUnsubscribe / applyDigestUnsubscribe - service logic
//      with dependency-injected models, no real DB (same DI pattern the
//      rest of digest.service.js's own exported functions use).
//   3. The real Express app booted over HTTP (same pattern as
//      production-error-envelope.mjs), proving the two routes are actually
//      mounted, reachable with NO Authorization header, and NOT blocked by
//      the maintenance gate.
//
// Run: node tests/digest-unsubscribe-link.mjs

import assert from "node:assert/strict";
import mongoose from "mongoose";

mongoose.set("bufferTimeoutMS", 50);

process.env.JWT_SECRET = process.env.JWT_SECRET || "local-verification-only";
process.env.MONGODB_URI =
  process.env.MONGODB_URI ||
  "mongodb://127.0.0.1:27017/digest-unsubscribe-check";

const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass, detail });
async function checkAsync(name, fn) {
  try {
    await fn();
    checks.push({ name, pass: true });
  } catch (err) {
    checks.push({ name, pass: false, detail: err?.message || String(err) });
  }
}

const {
  DAILY_KIND,
  WEEKLY_KIND,
  applyDigestUnsubscribe,
  buildDigestUnsubscribeLinks,
  buildDigestUnsubscribeToken,
  digestUnsubscribeTokenMatches,
  previewDigestUnsubscribe,
} = await import("../src/services/digest.service.js");

const RECIPIENT_ID = "0123456789abcdef01234567";
const OTHER_RECIPIENT_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";

// ─── 1. Token issuance / verification ─────────────────────────────────────

check(
  "a freshly issued token matches for the exact recipient+kind it was issued for",
  digestUnsubscribeTokenMatches(
    RECIPIENT_ID,
    DAILY_KIND,
    buildDigestUnsubscribeToken(RECIPIENT_ID, DAILY_KIND),
  ),
);

check(
  "the same token does NOT match a different recipient",
  !digestUnsubscribeTokenMatches(
    OTHER_RECIPIENT_ID,
    DAILY_KIND,
    buildDigestUnsubscribeToken(RECIPIENT_ID, DAILY_KIND),
  ),
);

check(
  "the same token does NOT match a different digest kind",
  !digestUnsubscribeTokenMatches(
    RECIPIENT_ID,
    WEEKLY_KIND,
    buildDigestUnsubscribeToken(RECIPIENT_ID, DAILY_KIND),
  ),
);

check(
  "an expired token (expiresAt in the past) does not match",
  !digestUnsubscribeTokenMatches(
    RECIPIENT_ID,
    DAILY_KIND,
    buildDigestUnsubscribeToken(RECIPIENT_ID, DAILY_KIND, Date.now() - 1000),
  ),
);

check(
  "a token with the signature flipped by one hex character does not match",
  (() => {
    const token = buildDigestUnsubscribeToken(RECIPIENT_ID, DAILY_KIND);
    const [expiry, signature] = token.split(".");
    const flipped =
      signature.slice(0, -1) + (signature.at(-1) === "0" ? "1" : "0");
    return !digestUnsubscribeTokenMatches(
      RECIPIENT_ID,
      DAILY_KIND,
      `${expiry}.${flipped}`,
    );
  })(),
);

check(
  "garbage input never matches (malformed token, invalid ObjectId, invalid kind)",
  !digestUnsubscribeTokenMatches("not-an-object-id", DAILY_KIND, "junk") &&
    !digestUnsubscribeTokenMatches(RECIPIENT_ID, "NOT_A_KIND", "1.2") &&
    !digestUnsubscribeTokenMatches(RECIPIENT_ID, DAILY_KIND, ""),
);

check(
  "buildDigestUnsubscribeLinks returns two DIFFERENT URLs: a page URL and an API URL",
  (() => {
    const { pageUrl, apiUrl } = buildDigestUnsubscribeLinks({
      recipientUserId: RECIPIENT_ID,
      kind: DAILY_KIND,
    });
    return (
      pageUrl !== apiUrl &&
      pageUrl.includes("/unsubscribe.html?") &&
      apiUrl.includes("/api/digests/unsubscribe?") &&
      pageUrl.includes(`u=${RECIPIENT_ID}`) &&
      apiUrl.includes(`u=${RECIPIENT_ID}`)
    );
  })(),
);

check(
  "both links carry the SAME token, so either one can complete the same request",
  (() => {
    const { pageUrl, apiUrl } = buildDigestUnsubscribeLinks({
      recipientUserId: RECIPIENT_ID,
      kind: DAILY_KIND,
    });
    const tokenOf = (url) => new URL(url).searchParams.get("t");
    return tokenOf(pageUrl) === tokenOf(apiUrl);
  })(),
);

// ─── 2. previewDigestUnsubscribe / applyDigestUnsubscribe (DI models) ────

function makeUserModel(user) {
  let stored = user ? { ...user } : null;
  return {
    findOne() {
      return {
        select() {
          return this;
        },
        lean: async () => (stored ? { ...stored } : null),
      };
    },
    findOneAndUpdate(_filter, update) {
      if (stored && update?.$set) {
        stored = { ...stored };
        for (const [path, value] of Object.entries(update.$set)) {
          const [group, field] = path.split(".");
          stored[group] = { ...(stored[group] || {}), [field]: value };
        }
      }
      return {
        select() {
          return this;
        },
        lean: async () => (stored ? { ...stored } : null),
      };
    },
  };
}

const ACTIVE_USER = {
  _id: RECIPIENT_ID,
  email: "recipient@example.com",
  firmId: "111111111111111111111111",
  personalFirmId: null,
  isActive: true,
  digestPreferences: {
    dailyFrequency: "DAILY",
    dailyEnabled: true,
    weeklyEnabled: true,
    emailEnabled: true,
  },
};

await checkAsync(
  "previewDigestUnsubscribe rejects an invalid/forged token before touching the User model",
  async () => {
    let modelTouched = false;
    const UserModel = {
      findOne() {
        modelTouched = true;
        throw new Error("must not be called for an invalid token");
      },
    };
    await assert.rejects(
      () =>
        previewDigestUnsubscribe(
          { recipientUserId: RECIPIENT_ID, kind: DAILY_KIND, token: "junk" },
          { User: UserModel },
        ),
      (error) => {
        assert.equal(error.status, 400);
        assert.equal(error.code, "DIGEST_UNSUBSCRIBE_TOKEN_INVALID");
        return true;
      },
    );
    assert.equal(modelTouched, false);
  },
);

await checkAsync(
  "previewDigestUnsubscribe returns the account email and kind label for a valid token",
  async () => {
    const token = buildDigestUnsubscribeToken(RECIPIENT_ID, WEEKLY_KIND);
    const preview = await previewDigestUnsubscribe(
      { recipientUserId: RECIPIENT_ID, kind: WEEKLY_KIND, token },
      { User: makeUserModel(ACTIVE_USER) },
    );
    assert.equal(preview.email, "recipient@example.com");
    assert.equal(preview.kind, WEEKLY_KIND);
    assert.equal(preview.kindLabel, "Weekly firm operations summary");
  },
);

await checkAsync(
  "previewDigestUnsubscribe 404s for an inactive/missing account, even with a valid token",
  async () => {
    const token = buildDigestUnsubscribeToken(RECIPIENT_ID, DAILY_KIND);
    await assert.rejects(
      () =>
        previewDigestUnsubscribe(
          { recipientUserId: RECIPIENT_ID, kind: DAILY_KIND, token },
          { User: makeUserModel(null) },
        ),
      (error) => {
        assert.equal(error.status, 404);
        assert.equal(error.code, "DIGEST_UNSUBSCRIBE_ACCOUNT_NOT_FOUND");
        return true;
      },
    );
  },
);

await checkAsync(
  "applyDigestUnsubscribe(THIS_KIND, DAILY) turns off only the daily cadence",
  async () => {
    const token = buildDigestUnsubscribeToken(RECIPIENT_ID, DAILY_KIND);
    const activityCalls = [];
    const result = await applyDigestUnsubscribe(
      {
        recipientUserId: RECIPIENT_ID,
        kind: DAILY_KIND,
        token,
        scope: "THIS_KIND",
      },
      {
        User: makeUserModel(ACTIVE_USER),
        safeRecordActivity: async (event) => {
          activityCalls.push(event);
        },
      },
    );
    assert.equal(result.scope, "THIS_KIND");
    assert.equal(result.preferences.dailyFrequency, "OFF");
    assert.equal(result.preferences.dailyEnabled, false);
    // Weekly and the email master switch are untouched by a THIS_KIND/DAILY
    // request - only the daily cadence itself changed.
    assert.equal(result.preferences.weeklyEnabled, true);
    assert.equal(result.preferences.emailEnabled, true);
    assert.equal(activityCalls.length, 1);
    assert.equal(activityCalls[0].action, "DIGEST_UNSUBSCRIBED_VIA_EMAIL_LINK");
    assert.equal(activityCalls[0].metadata.scope, "THIS_KIND");
  },
);

await checkAsync(
  "applyDigestUnsubscribe(THIS_KIND, WEEKLY_FIRM) turns off only the weekly summary",
  async () => {
    const token = buildDigestUnsubscribeToken(RECIPIENT_ID, WEEKLY_KIND);
    const result = await applyDigestUnsubscribe(
      {
        recipientUserId: RECIPIENT_ID,
        kind: WEEKLY_KIND,
        token,
        scope: "THIS_KIND",
      },
      { User: makeUserModel(ACTIVE_USER) },
    );
    assert.equal(result.preferences.weeklyEnabled, false);
    assert.equal(result.preferences.dailyFrequency, "DAILY");
    assert.equal(result.preferences.emailEnabled, true);
  },
);

await checkAsync(
  "applyDigestUnsubscribe(ALL) turns off the email master switch, leaving cadence untouched",
  async () => {
    const token = buildDigestUnsubscribeToken(RECIPIENT_ID, DAILY_KIND);
    const result = await applyDigestUnsubscribe(
      { recipientUserId: RECIPIENT_ID, kind: DAILY_KIND, token, scope: "ALL" },
      { User: makeUserModel(ACTIVE_USER) },
    );
    assert.equal(result.scope, "ALL");
    assert.equal(result.preferences.emailEnabled, false);
    // ALL stops delivery via the email switch, not by silently rewriting the
    // recipient's stated cadence preference - if they ever re-enable email,
    // their cadence choice should still read as it did before.
    assert.equal(result.preferences.dailyFrequency, "DAILY");
    assert.equal(result.preferences.weeklyEnabled, true);
  },
);

await checkAsync(
  "applyDigestUnsubscribe rejects an invalid scope",
  async () => {
    const token = buildDigestUnsubscribeToken(RECIPIENT_ID, DAILY_KIND);
    await assert.rejects(
      () =>
        applyDigestUnsubscribe(
          {
            recipientUserId: RECIPIENT_ID,
            kind: DAILY_KIND,
            token,
            scope: "EVERYTHING",
          },
          { User: makeUserModel(ACTIVE_USER) },
        ),
      (error) => {
        assert.equal(error.status, 400);
        assert.equal(error.code, "DIGEST_UNSUBSCRIBE_SCOPE_INVALID");
        return true;
      },
    );
  },
);

await checkAsync(
  "applyDigestUnsubscribe rejects a tampered token before any User write",
  async () => {
    let writeAttempted = false;
    const UserModel = {
      findOne() {
        throw new Error("must not be called for an invalid token");
      },
      findOneAndUpdate() {
        writeAttempted = true;
        throw new Error("must not write for an invalid token");
      },
    };
    await assert.rejects(() =>
      applyDigestUnsubscribe(
        {
          recipientUserId: RECIPIENT_ID,
          kind: DAILY_KIND,
          token: "0.deadbeef",
          scope: "ALL",
        },
        { User: UserModel },
      ),
    );
    assert.equal(writeAttempted, false);
  },
);

// ─── 2b. buildDigestEmailContent - the actual RFC 8058 headers and the
//     footer link/text that reach a real inbox ────────────────────────────

const { buildDigestEmailContent } =
  await import("../src/services/email.service.js");

const SAMPLE_LINKS = {
  pageUrl:
    "https://api.caprotoolkit.in/unsubscribe.html?u=abc&k=DAILY_PERSONAL&t=1.2",
  apiUrl:
    "https://api.caprotoolkit.in/api/digests/unsubscribe?u=abc&k=DAILY_PERSONAL&t=1.2",
};

check(
  "buildDigestEmailContent sets List-Unsubscribe to the API url, not the page url",
  buildDigestEmailContent({
    subject: "s",
    heading: "h",
    lines: [],
    ...SAMPLE_LINKS,
  }).headers["List-Unsubscribe"] === `<${SAMPLE_LINKS.apiUrl}>`,
);

check(
  "buildDigestEmailContent always sets List-Unsubscribe-Post=One-Click (required alongside List-Unsubscribe for RFC 8058)",
  buildDigestEmailContent({
    subject: "s",
    heading: "h",
    lines: [],
    ...SAMPLE_LINKS,
  }).headers["List-Unsubscribe-Post"] === "List-Unsubscribe=One-Click",
);

check(
  "the HTML footer links to the PAGE url (human-facing), not the API url",
  (() => {
    const { html } = buildDigestEmailContent({
      subject: "s",
      heading: "h",
      lines: [],
      ...SAMPLE_LINKS,
    });
    // The href is HTML-escaped (correctly - the URL's own "&" query
    // separators must become "&amp;" inside an attribute value), so compare
    // against the same escaping rather than the raw URL.
    const escapedHref = SAMPLE_LINKS.pageUrl.replaceAll("&", "&amp;");
    return (
      html.includes(`href="${escapedHref}"`) &&
      !html.includes(SAMPLE_LINKS.apiUrl)
    );
  })(),
);

check(
  "the text part also carries the page url, so a text-only client still offers a way to unsubscribe",
  buildDigestEmailContent({
    subject: "s",
    heading: "h",
    lines: [],
    ...SAMPLE_LINKS,
  }).text.includes(SAMPLE_LINKS.pageUrl),
);

check(
  "the HTML body escapes a hostile heading/line value rather than injecting raw markup",
  (() => {
    const { html } = buildDigestEmailContent({
      subject: "s",
      heading: "<img src=x onerror=alert(1)>",
      lines: [{ label: "L", value: '"><script>1</script>' }],
      ...SAMPLE_LINKS,
    });
    return (
      !html.includes("<img src=x onerror=alert(1)>") &&
      !html.includes("<script>1</script>") &&
      html.includes("&lt;img")
    );
  })(),
);

check(
  "rejects a pageUrl that is not a bare https:// URL (e.g. javascript:)",
  (() => {
    try {
      buildDigestEmailContent({
        subject: "s",
        heading: "h",
        lines: [],
        pageUrl: "javascript:alert(1)",
        apiUrl: SAMPLE_LINKS.apiUrl,
      });
      return false;
    } catch (error) {
      return /pageUrl must be a bare https/.test(error.message);
    }
  })(),
);

check(
  "rejects an apiUrl that is not a bare https:// URL (e.g. a relative path)",
  (() => {
    try {
      buildDigestEmailContent({
        subject: "s",
        heading: "h",
        lines: [],
        pageUrl: SAMPLE_LINKS.pageUrl,
        apiUrl: "/api/digests/unsubscribe",
      });
      return false;
    } catch (error) {
      return /apiUrl must be a bare https/.test(error.message);
    }
  })(),
);

check(
  "rejects more than 30 lines",
  (() => {
    try {
      buildDigestEmailContent({
        subject: "s",
        heading: "h",
        lines: Array.from({ length: 31 }, (_, i) => ({
          label: `L${i}`,
          value: "v",
        })),
        ...SAMPLE_LINKS,
      });
      return false;
    } catch (error) {
      return /at most 30 entries/.test(error.message);
    }
  })(),
);

// ─── 3. Real Express app over HTTP: routes are mounted, public, and not
//     blocked by maintenance mode ────────────────────────────────────────

const { default: app } = await import("../src/app.js");
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function call(path, options = {}) {
  const response = await fetch(base + path, options);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

await checkAsync(
  "GET /api/digests/unsubscribe with no Authorization header is reachable (not 401)",
  async () => {
    const res = await call(
      "/api/digests/unsubscribe?u=0123456789abcdef01234567&k=DAILY_PERSONAL&t=0.bad",
    );
    // Reachable and evaluated by the unsubscribe handler itself (which
    // rejects the bad token with 400) rather than by the authRequired
    // middleware (which would answer 401) or the maintenance gate blocking
    // it outright.
    assert.equal(res.status, 400);
    assert.equal(res.json?.code, "DIGEST_UNSUBSCRIBE_TOKEN_INVALID");
  },
);

await checkAsync(
  "POST /api/digests/unsubscribe with no Authorization header is reachable (not 401)",
  async () => {
    const res = await call(
      "/api/digests/unsubscribe?u=0123456789abcdef01234567&k=DAILY_PERSONAL&t=0.bad",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "THIS_KIND" }),
      },
    );
    assert.equal(res.status, 400);
    assert.equal(res.json?.code, "DIGEST_UNSUBSCRIBE_TOKEN_INVALID");
  },
);

await checkAsync(
  "POST /api/digests/unsubscribe accepts a RFC 8058 one-click form-urlencoded body with no scope field",
  async () => {
    // This is exactly what a compliant mail client's automatic one-click
    // handler sends: no Authorization header, no JSON body, no scope field -
    // just the fixed form body against the URL named in List-Unsubscribe.
    const res = await call(
      "/api/digests/unsubscribe?u=0123456789abcdef01234567&k=DAILY_PERSONAL&t=0.bad",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      },
    );
    // Still reaches the handler (proves express.urlencoded() parsed the
    // body without erroring) and fails on the invalid token, not on a
    // missing/malformed body.
    assert.equal(res.status, 400);
    assert.equal(res.json?.code, "DIGEST_UNSUBSCRIBE_TOKEN_INVALID");
  },
);

await checkAsync(
  "the unsubscribe route is NOT swallowed by the authenticated /api/* catch-all",
  async () => {
    // The catch-all (firmOperationsRoutes, mounted last) answers every
    // unmatched /api/* with 401 via its own router.use(authRequired). A
    // 400 with the unsubscribe-specific error code (asserted above) already
    // proves this, but a control probe against a route that certainly does
    // NOT exist confirms what "absorbed by the catch-all" actually looks
    // like, so the two are distinguishable rather than coincidentally equal.
    const control = await call("/api/definitely-not-a-real-route-xyz");
    assert.equal(control.status, 401);
  },
);

server.close();

// ─── Report ───────────────────────────────────────────────────────

let passed = 0;
for (const entry of checks) {
  const mark = entry.pass ? "PASS" : "FAIL";
  if (entry.pass) passed += 1;
  console.log(
    `[${mark}] ${entry.name}${entry.detail ? ` — ${entry.detail}` : ""}`,
  );
}
const total = checks.length;
console.log(`\nDigest unsubscribe link: ${passed}/${total}`);
if (passed !== total) {
  console.error(`\n${total - passed} check(s) failed.`);
  process.exitCode = 1;
}
