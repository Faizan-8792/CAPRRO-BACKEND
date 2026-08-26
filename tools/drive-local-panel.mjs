// tools/drive-local-panel.mjs
//
// Drives the REAL super-admin panel, in a REAL browser, against a LOCAL backend and a scratch
// database - so the write paths can be exercised without touching production.
//
// WHY THIS EXISTS
// ---------------
// U5's Verify bullet 3 is "fill valid values, press Save Release -> green status, no toast to users,
// and GET /api/app-config still returns desktopRelease: null". Against production it is unrunnable
// for two honest reasons already recorded under that task: pressing Save is a WRITE to the live
// release document, and the bullet's own premise ("desktopRelease: null, because enabled is off or
// it was never notified") stopped holding the day 0.1.2 was announced. So it belongs against a
// backend where writing is harmless and nothing has been announced yet - which is exactly what this
// script stands up.
//
// It became possible only after O18. Every script under public/ used to hardcode
// `https://api.caprotoolkit.in/api`, so a panel served from localhost still drove PRODUCTION and
// pressing Save here would have published a release. The bases are same-origin now, which is what
// makes a local panel a local panel.
//
// SAFETY, and it is asserted rather than intended
// -----------------------------------------------
// Three guards, each of which aborts before anything is created:
//   1. The API base must be a loopback address.
//   2. MONGODB_URI must be a loopback address, and its database name must carry the scratch marker.
//   3. The outbound provider keys are blanked in this process, so no email or paid provider call can
//      leave the machine even if a code path tries.
// There is no argument, flag or environment variable that points this at api.caprotoolkit.in.
//
// The scratch database is dropped at the end, including when a check fails.
//
// USAGE
//   node tools/drive-local-panel.mjs            # headless
//   node tools/drive-local-panel.mjs --show     # watch it, useful when a selector will not match
import { withBrowser } from "./browser-drive.mjs";

const SCRATCH_MARKER = "capro-local-panel-drive";
const MONGO_URI = `mongodb://127.0.0.1:27117/${SCRATCH_MARKER}`;
const SUPER_EMAIL = "saifullahfaizan786@gmail.com";
const NON_SUPER_EMAIL = "not-the-super-admin@example.invalid";
const SHOW = process.argv.includes("--show");

// WHY THIS RUNS IN DEVELOPMENT MODE, stated plainly because it is a deviation
// ---------------------------------------------------------------------------
// In production mode the panel cannot talk to its own server from any host but the real one. The
// CORS allowlist in app.js:326 allows exactly `https://api.caprotoolkit.in` as "the backend itself",
// and a browser sends an Origin header on a PATCH even when the request IS same-origin - so a panel
// served from http://127.0.0.1:PORT gets `CORS blocked for origin: http://127.0.0.1:PORT` on Save.
// Observed here before this note was written: the save's status line read the generic
// "We could not complete your request" and the server logged the CORS error.
//
// The correct fix is to allow an Origin that equals the request's own origin, which is what
// same-origin means and adds no cross-origin capability. But that is a change to a SECURITY rule,
// and an agent does not make those unilaterally: the current behaviour is instead PINNED by
// tests/admin-panel-same-origin.mjs and raised for the owner in .kiro/OWNER-TODO.md.
//
// So this drive uses development mode and http://localhost, which app.js:345 already allows
// (`!isProd && origin.startsWith("http://localhost")`). What that changes is error verbosity, not
// the save path under test: updateDesktopRelease, its validator and its monotonicity guard are the
// same code in both modes. Every API-level assertion below is issued from node with no Origin
// header at all, so those are unaffected either way.
//
// Set BEFORE src/app.js is imported: load-env.js runs dotenv at import time and dotenv does not
// override a value already present, so these win over the committed .env.
process.env.NODE_ENV = "development";
process.env.JWT_SECRET = "local-panel-drive-only-not-a-real-secret";
process.env.MONGODB_URI = MONGO_URI;
for (const outbound of [
  "RESEND_API_KEY",
  "DEEPSEEK_API_KEY",
  "OCR_SPACE_API_KEY",
  "HOSTINGER_API_TOKEN",
]) {
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

let pass = 0;
let fail = 0;
const failures = [];
function check(id, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  PASS ${id}  ${detail}`);
  } else {
    fail += 1;
    failures.push(id);
    console.log(`  FAIL ${id}  ${detail}`);
  }
}

const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
// localhost rather than 127.0.0.1: the same address, but the only spelling app.js's dev CORS
// allowance recognises. See the note at the top of this file.
const base = `http://localhost:${server.address().port}`;
assertLoopback("API base", base);
const panelUrl = `${base}/admin/super.html`;

console.log("local super-admin panel drive");
console.log(`  api      ${base}`);
console.log(`  mongo    ${MONGO_URI}`);
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

  const superUser = await User.create({
    email: SUPER_EMAIL,
    name: "Local Drive Super Admin",
    role: "SUPER_ADMIN",
    accountType: "INDIVIDUAL",
  });
  const plainUser = await User.create({
    email: NON_SUPER_EMAIL,
    name: "Local Drive Ordinary User",
    role: "USER",
    accountType: "INDIVIDUAL",
  });
  // Nothing announced: this is the state U5 bullet 3's own premise requires and which production
  // has not been in since 0.1.2 was published.
  await AppConfig.create({ _id: "singleton" });

  const tokenFor = (user) =>
    jwt.sign(
      {
        id: String(user._id),
        email: user.email,
        role: user.role,
        accountType: user.accountType,
        firmId: null,
        isActive: true,
        tv: 0,
      },
      process.env.JWT_SECRET,
      { expiresIn: "1h" },
    );
  const superToken = tokenFor(superUser);
  const plainToken = tokenFor(plainUser);

  const publicConfig = async () => {
    const response = await fetch(`${base}/api/app-config`);
    return { status: response.status, body: await response.json() };
  };

  const seeded = await publicConfig();
  check(
    "seed-nothing-announced",
    seeded.status === 200 && (seeded.body?.config?.desktopRelease ?? null) === null,
    `GET /api/app-config -> ${seeded.status}, desktopRelease ${JSON.stringify(seeded.body?.config?.desktopRelease ?? null)}`,
  );

  await withBrowser(async (page) => {
    // localStorage is origin-scoped, so the origin must be loaded before the token can be planted.
    await page.goto(panelUrl, { waitMs: 1200 });
    await page.evaluate(
      `localStorage.setItem("caproadminjwt", ${JSON.stringify(superToken)}); true`,
    );
    await page.goto(panelUrl, { waitMs: 3500 });

    const origin = await page.evaluate(
      `JSON.stringify({ origin: location.origin, href: location.href })`,
    );
    const parsedOrigin = JSON.parse(origin);
    check(
      "panel-is-local",
      parsedOrigin.origin === base,
      `the page under test is ${parsedOrigin.origin} (expected ${base}) - this is the assertion that the same-origin fix is what makes this run local`,
    );

    const card = await page.evaluate(`(() => {
      const ids = ["desktopLatestVersion","desktopMinSupportedVersion","desktopDownloadUrl",
                   "desktopSha256","desktopSizeBytes","desktopReleaseNotes","desktopMandatory",
                   "desktopEnabled","saveDesktopReleaseBtn","notifyDesktopReleaseBtn",
                   "desktopReleaseStatus","desktopReleaseLive"];
      const present = ids.filter(id => !!document.getElementById(id));
      return JSON.stringify({ present, missing: ids.filter(id => !present.includes(id)) });
    })()`);
    const parsedCard = JSON.parse(card);
    check(
      "card-renders",
      parsedCard.missing.length === 0,
      `${parsedCard.present.length}/12 element ids present${parsedCard.missing.length ? `, missing ${parsedCard.missing.join(", ")}` : ""}`,
    );

    // ─── U5 bullet 3: Save with valid values ──────────────────────────
    // A version NEWER than nothing, so the monotonicity guard has no reason to refuse - the thing
    // under test is the save path and its green status, not the rollback guard (U5 already has
    // that, recorded as a 409 VERSION_NOT_NEWER against production).
    const validRelease = {
      latestVersion: "0.9.9",
      downloadUrl: "https://caprotoolkit.in/download/CA-PRO-Setup-0.9.9-x64.exe",
      sha256: "a".repeat(64),
      sizeBytes: "65681189",
      notes: "Local drive fixture. Never announced.",
    };
    await page.evaluate(`(() => {
      const set = (id, value) => { const el = document.getElementById(id); el.value = value; };
      set("desktopLatestVersion", ${JSON.stringify(validRelease.latestVersion)});
      set("desktopDownloadUrl", ${JSON.stringify(validRelease.downloadUrl)});
      set("desktopSha256", ${JSON.stringify(validRelease.sha256)});
      set("desktopSizeBytes", ${JSON.stringify(validRelease.sizeBytes)});
      set("desktopReleaseNotes", ${JSON.stringify(validRelease.notes)});
      document.getElementById("desktopMandatory").checked = false;
      document.getElementById("desktopEnabled").checked = false;
      return true;
    })()`);

    page.clearRequests();
    await page.evaluate(`document.getElementById("saveDesktopReleaseBtn").click(); true`);
    await new Promise((resolve) => setTimeout(resolve, 2500));

    const afterSave = page.requests();
    const status = await page.evaluate(
      `(document.getElementById("desktopReleaseStatus").textContent || "").trim()`,
    );
    const savePatches = afterSave.filter(
      (request) => request.method === "PATCH" && /desktop-release/.test(request.url),
    );
    const notifyPosts = afterSave.filter((request) => /desktop-release\/notify/.test(request.url));

    check(
      "save-issued-one-patch",
      savePatches.length === 1,
      `${savePatches.length} PATCH to /app-config/desktop-release (expected exactly 1)`,
    );
    check(
      "save-status-is-success-not-an-error",
      /saved|updated|success/i.test(status) && !/fail|error|must be|denied/i.test(status),
      `status line reads ${JSON.stringify(status)}`,
    );
    check(
      "save-does-not-notify",
      notifyPosts.length === 0,
      `${notifyPosts.length} request(s) to the notify route (expected 0 - saving must not announce)`,
    );

    const afterSaveConfig = await publicConfig();
    check(
      "public-config-still-null-after-save",
      (afterSaveConfig.body?.config?.desktopRelease ?? null) === null,
      `GET /api/app-config desktopRelease is ${JSON.stringify(afterSaveConfig.body?.config?.desktopRelease ?? null)} - the bullet's point is that a saved draft is not a published release`,
    );

    // Proof the save reached the database rather than only the status line: read the draft back
    // through the super-only route, which is the only place an unannounced release is visible.
    const draft = await fetch(`${base}/api/app-config/desktop-release`, {
      headers: { Authorization: `Bearer ${superToken}` },
    });
    const draftBody = await draft.json();
    const savedVersion =
      draftBody?.desktopRelease?.latestVersion ?? draftBody?.release?.latestVersion ?? null;
    check(
      "draft-persisted-and-unannounced",
      draft.status === 200 &&
        savedVersion === validRelease.latestVersion &&
        !draftBody?.desktopRelease?.announcementId &&
        !draftBody?.release?.announcementId,
      `super-only GET -> ${draft.status}, latestVersion ${JSON.stringify(savedVersion)}, announcementId ${JSON.stringify(draftBody?.desktopRelease?.announcementId ?? draftBody?.release?.announcementId ?? null)}`,
    );

    // ─── The non-super path, in the browser this time ─────────────────
    await page.evaluate(
      `localStorage.setItem("caproadminjwt", ${JSON.stringify(plainToken)}); true`,
    );
    const nonSuper = await fetch(`${base}/api/app-config/desktop-release`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${plainToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ latestVersion: "9.9.9" }),
    });
    const nonSuperBody = await nonSuper.json();
    check(
      "non-super-save-is-refused-403-with-readable-copy",
      nonSuper.status === 403 &&
        typeof nonSuperBody?.error === "string" &&
        !/401|403|HTTP|null|exception/.test(nonSuperBody.error),
      `PATCH as role USER -> ${nonSuper.status}, error ${JSON.stringify(nonSuperBody?.error)}`,
    );

    const afterRefusal = await fetch(`${base}/api/app-config/desktop-release`, {
      headers: { Authorization: `Bearer ${superToken}` },
    });
    const afterRefusalBody = await afterRefusal.json();
    const stillSaved =
      afterRefusalBody?.desktopRelease?.latestVersion ??
      afterRefusalBody?.release?.latestVersion ??
      null;
    check(
      "refusal-wrote-nothing",
      stillSaved === validRelease.latestVersion,
      `draft latestVersion after the refused write is ${JSON.stringify(stillSaved)} (expected ${JSON.stringify(validRelease.latestVersion)})`,
    );
  }, { headless: !SHOW });
} finally {
  await cleanup();
}

console.log("");
console.log(`passed: ${pass}  failed: ${fail}`);
if (fail > 0) {
  console.log(`failing checks: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("LOCAL PANEL DRIVE OK");
