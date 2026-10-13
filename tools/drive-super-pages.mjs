// tools/drive-super-pages.mjs
//
// Ledger task DS10: the super-admin panel loads each page's data when that page is opened, and its
// per-day charts carry axes, a legend for the client split, and the same figures in a table.
//
// WHY THIS EXISTS
// ---------------
// The panel fetched every page's data at startup - about ten requests against the API's limiter of
// 50 per 15 minutes, so a handful of reloads could lock the super admin out of their own panel -
// and its two charts were bare bars: no scale, no legend, a quiet day missing from the row rather
// than drawn as zero, the figures readable only by hovering.
//
// This drives the REAL panel in a REAL browser and checks, from the network log and the page:
//   1. startup asks for the signed-in user and the default page's data, nothing else;
//   2. every other page asks for its own data the first time it is opened, and only then;
//   3. both analytics charts have a scale, every UTC day of the window as a column, a table whose
//      figures equal the payload the page received (zero for a day with no row), and the client
//      split has a legend;
//   4. nothing in the page threw;
//   5. the Sign-in health page (PHASE 8) shows the auth-health payload it received: the cards, the
//      refusal reasons by app, the failures, the session lengths and the version split equal the
//      payload; the window buttons and the custom window ask for exactly that window; an invalid
//      window asks for nothing; a failed load says so (stub); no transport words reach the page.
//
// TWO BACKENDS
//   default   the real express app on a loopback port against a scratch database - the ledger
//             gate. The same guards as tools/drive-local-panel.mjs, each aborting before anything
//             is created: the API base is loopback; MONGODB_URI is loopback and names the scratch
//             database; the outbound provider keys are blanked in this process. The scratch
//             database is dropped at the end, including when a check fails.
//   --stub    no database: the panel's own files served as app.js serves them, and canned
//             payloads shaped like the controllers' answers. It proves the page's behaviour, not
//             the server's, and is what runs while the local Mongo is unavailable.
//
// USAGE
//   node tools/drive-super-pages.mjs              # real local backend + scratch database
//   node tools/drive-super-pages.mjs --stub       # no database
//   add --show to watch it
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withBrowser } from "./browser-drive.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, "..", "public");
const STUB = process.argv.includes("--stub");
const SHOW = process.argv.includes("--show");
const SCRATCH_MARKER = "capro-local-super-pages-drive";
const MONGO_URI = `mongodb://127.0.0.1:27117/${SCRATCH_MARKER}`;
const SUPER_EMAIL = "saifullahfaizan786@gmail.com";
const DAY_MS = 24 * 60 * 60 * 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// UTC day keys relative to today: day(0) is today, day(3) three days ago.
const todayUtc = (() => { const now = new Date(); return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()); })();
const day = (back) => new Date(todayUtc - back * DAY_MS).toISOString().slice(0, 10);

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

// ---------------- The backend ----------------

let base = "";
let token = "";
let cleanup = async () => {};
// What the stub's /api/app-config does (stub mode only).
const stubState = { appConfigDelayMs: 0, appConfigFails: false, authHealthFails: false };
// What the Controls cards should show once read: the stub's maintenance mode, or the seeded one.
const storedMaintenance = STUB ? true : false;

if (STUB) {
  const express = (await import("express")).default;
  const stub = express();
  stub.use(express.static(PUBLIC_DIR, { index: false }));
  stub.use("/admin", express.static(join(PUBLIC_DIR, "admin"), { index: false }));
  const answer = (payload) => (req, res) => res.json(payload);
  // Shaped like the controllers' answers (super.controller.js getUsageStats and getDashboardStats,
  // appconfig.controller.js), including fields the panel does not read.
  stub.get("/api/auth/me", answer({ ok: true, user: { _id: "u-super", email: SUPER_EMAIL, name: "Stub Super Admin", role: "SUPER_ADMIN", accountType: "INDIVIDUAL", firmId: null, isActive: true } }));
  stub.get("/api/super/dashboard-stats", answer({ ok: true, stats: {
    users: { total: 7, active: 6, inactive: 1, pendingAdmins: 0, firmAdmins: 1, recentSignups: 2 },
    firms: { total: 2, active: 2 },
    tasks: { total: 10, active: 8, recentTasks: 3, statusBreakdown: [{ _id: "IN_PROGRESS", count: 5 }], serviceBreakdown: [{ _id: "GST", count: 6 }] },
    reminders: { total: 4 },
  } }));
  stub.get("/api/super/usage-stats", answer({ ok: true, usage: {
    basis: "mixed — legacy fields are lastActiveAt-approximate; clientSplit/dailyActivityByClient/workflowBreakdown/perUser are WorkflowUsage counters (server-verified)",
    dau: 1, wau: 4, mau: 6, qau: 6, totalEverActive: 6, totalUsers: 7, totalApiCalls: 1234, activationRate: 86, retentionRate: 67,
    // A partial first day (the server's window is 14 x 24 hours to now) and gaps inside the window.
    dailyActivity: [{ _id: day(14), count: 1 }, { _id: day(10), count: 2 }, { _id: day(4), count: 1 }, { _id: day(1), count: 3 }],
    topUsers: [{ email: "user1@example.test", name: "User One", role: "USER", totalApiCalls: 400, firmId: null }],
    clientSplit: { daily: { desktop: 1, extension: 2 }, weekly: { desktop: 3, extension: 2 }, monthly: { desktop: 4, extension: 3 } },
    dailyActivityByClient: [{ _id: day(13), desktop: 0, extension: 1 }, { _id: day(2), desktop: 3, extension: 0 }, { _id: day(0), desktop: 1, extension: 2 }],
    workflowBreakdown: [{ workflow: "gst_recon", weekActive: 3, totalCounts: 12, errorCounts: 1 }],
    perUser: [{ userId: "u1", email: "user1@example.test", name: "User One", desktopCount: 9, extensionCount: 3, totalCount: 12, workflows: 2, lastSeenAt: new Date(todayUtc).toISOString() }],
    perUserWindowDays: 30,
  } }));
  // getAppConfig's shape. The drive sets stubState to slow it down or make it fail, so the Controls
  // cards can be seen waiting for it and refusing to open without it.
  stub.get("/api/app-config", async (req, res) => {
    await sleep(stubState.appConfigDelayMs);
    if (stubState.appConfigFails) return res.status(500).json({ ok: false, error: "Server error" });
    return res.json({ ok: true, config: {
      maintenanceMode: true,
      maintenanceMessage: "Back at 6 pm",
      welcomeAnnouncement: { version: "v1", title: "Welcome", body: "Hello", enabled: true },
      desktopRelease: null,
      featureFlags: { gstReconciliation: true, tdsHealth: false, dailyDigest: false },
      dataRetention: { summary: "stub" },
    } });
  });
  stub.get("/api/app-config/desktop-release", answer({ ok: true, desktopRelease: {} }));
  stub.get("/api/app-config/control-changes", answer({ ok: true, changes: [], limit: 50 }));
  stub.get("/api/super/provider-usage", answer({ ok: true, usage: { today: {}, thisMonth: {}, topUsersToday: {} } }));
  stub.get("/api/super/reminder-delivery-health", answer({ ok: true, delivery: { issueCount: 0, sample: [], candidatesScanned: 0, candidatesScanTruncated: false } }));
  stub.get("/api/super/emails", answer({ ok: true, rows: [], summary: {}, pagination: { page: 1, pages: 1, total: 0 } }));
  stub.get("/api/super/emails/suppressions", answer({ ok: true, rows: [] }));
  stub.get("/api/super/users", answer({ ok: true, users: [], pagination: { page: 1, pages: 1, total: 0 } }));
  stub.get("/api/super/firms", answer({ ok: true, firms: [], totalFirms: 0, returnedFirms: 0, truncated: false, limit: 200 }));
  stub.get("/api/super/pending-admins", answer({ ok: true, users: [] }));
  stub.get("/api/super/terms-acceptances", answer({ ok: true, acceptances: [], pagination: { page: 1, totalPages: 1, total: 0 } }));
  stub.get("/api/super/self-test/latest", answer({ ok: true, run: null }));
  // authHealthSummary's shape (auth-health.service.js), including a kind and an app the panel
  // does not know, which must be shown verbatim rather than folded into a known one.
  stub.get("/api/super/auth-health", (req, res) => {
    if (stubState.authHealthFails) return res.status(500).json({ ok: false, error: "Server error" });
    const windowDays = Math.max(1, Math.min(365, Number(req.query.days) || 30));
    return res.json({
      ok: true,
      windowDays,
      since: new Date(Date.now() - windowDays * DAY_MS).toISOString(),
      byDay: [
        { day: day(2), kind: "login_success", count: 3 },
        { day: day(2), kind: "refresh_success", count: 5 },
        { day: day(1), kind: "auth_rejection", count: 24 },
        { day: day(0), kind: "signed_out", count: 2 },
        { day: day(0), kind: "session_restored", count: 6 },
      ],
      byKindReason: [
        { kind: "auth_rejection", reason: "no_credentials", platform: "unknown", count: 20 },
        { kind: "auth_rejection", reason: "expired", platform: "extension", count: 3 },
        { kind: "auth_rejection", reason: "revoked", platform: "desktop", count: 1 },
        { kind: "auth_rejection", reason: "expired", platform: "kiosk", count: 1 },
        { kind: "refresh_success", reason: "unknown", platform: "extension", count: 5 },
        { kind: "refresh_fail", reason: "max_age", platform: "desktop", count: 1 },
        { kind: "refresh_retry", reason: "network", platform: "extension", count: 2 },
        { kind: "login_success", reason: "unknown", platform: "desktop", count: 3 },
        { kind: "login_fail", reason: "invalid", platform: "website", count: 1 },
        { kind: "signed_out", reason: "signed_out", platform: "extension", count: 1 },
        { kind: "signed_out", reason: "unknown", platform: "extension", count: 1 },
        { kind: "session_restored", reason: "restart", platform: "extension", count: 6 },
      ],
      byVersion: [
        { platform: "extension", appVersion: "1.4.14", kind: "refresh_success", count: 5 },
        { platform: "extension", appVersion: "1.4.14", kind: "session_restored", count: 6 },
        { platform: "desktop", appVersion: "", kind: "login_success", count: 3 },
        { platform: "desktop", appVersion: "0.1.27", kind: "refresh_fail", count: 1 },
      ],
      totals: { auth_rejection: 25, refresh_success: 5, refresh_fail: 1, refresh_retry: 2, login_success: 3, login_fail: 1, signed_out: 2, session_restored: 6 },
      sessionDurationHours: [{ bucket: "1", count: 1 }, { bucket: "24", count: 2 }],
    });
  });
  stub.use("/api", (req, res) => res.status(404).json({ ok: false, error: "Not found" }));
  const server = stub.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  token = "stub-token-not-a-real-jwt";
  cleanup = async () => { await new Promise((resolve) => server.close(resolve)); };
} else {
  process.env.NODE_ENV = "development";
  process.env.JWT_SECRET = "local-super-pages-drive-only-not-a-real-secret";
  process.env.MONGODB_URI = MONGO_URI;
  for (const outbound of ["RESEND_API_KEY", "DEEPSEEK_API_KEY", "OCR_SPACE_API_KEY", "HOSTINGER_API_TOKEN"]) {
    process.env[outbound] = "";
  }
  const loopback = (label, value) => {
    const host = /^mongodb:\/\/([^/:]+)/.exec(value)?.[1] ?? new URL(value).hostname;
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
      throw new Error(`${label} must be loopback, got ${host} - refusing to run`);
    }
  };
  loopback("MONGODB_URI", MONGO_URI);
  if (!MONGO_URI.includes(SCRATCH_MARKER)) throw new Error("MONGODB_URI must name the scratch database - refusing to run");

  const mongoose = (await import("mongoose")).default;
  const jwt = (await import("jsonwebtoken")).default;
  const { default: app } = await import("../src/app.js");
  const { default: User } = await import("../src/models/User.js");
  const { default: AppConfig } = await import("../src/models/AppConfig.js");
  const { default: WorkflowUsage } = await import("../src/models/WorkflowUsage.js");
  const { default: AuthHealthEvent } = await import("../src/models/AuthHealthEvent.js");

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;
  loopback("API base", base);
  cleanup = async () => {
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
  };

  try {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
    await mongoose.connection.dropDatabase();
    const superUser = await User.create({ email: SUPER_EMAIL, name: "Local Drive Super Admin", role: "SUPER_ADMIN", accountType: "INDIVIDUAL" });
    await AppConfig.create({ _id: "singleton", maintenanceMode: false });
    // Users last active on a few days, with gaps between them.
    const noon = (back) => new Date(todayUtc - back * DAY_MS + 12 * 60 * 60 * 1000);
    const people = [];
    for (const [index, back] of [1, 1, 1, 4, 10, 10].entries()) {
      people.push(await User.create({ email: `drive-user-${index}@example.test`, name: `Drive User ${index}`, role: "USER", accountType: "INDIVIDUAL", lastActiveAt: noon(back), totalApiCalls: 10 * (index + 1) }));
    }
    // Workflow runs on both apps on some days.
    const runs = [[0, "desktop", 0], [1, "extension", 0], [2, "extension", 0], [0, "desktop", 2], [3, "desktop", 2], [4, "desktop", 2], [5, "extension", 13]];
    for (const [who, client, back] of runs) {
      await WorkflowUsage.create({ userId: people[who]._id, client, workflow: "gst_recon", periodDay: day(back), count: 2, lastSeenAt: noon(back), outcomeCounts: { ok: 2, error: 0 } });
    }
    // Authentication events (PHASE 8): a session that ended by an explicit sign-out two hours in,
    // one ended by a revocation, renewals, restart recoveries, refusals of every common reason.
    const hoursAfter = (back, hours) => new Date(noon(back).getTime() + hours * 60 * 60 * 1000);
    await AuthHealthEvent.insertMany([
      { kind: "login_success", platform: "extension", userId: people[0]._id, occurredAt: noon(5) },
      { kind: "signed_out", reason: "signed_out", platform: "extension", appVersion: "1.4.14", userId: people[0]._id, occurredAt: hoursAfter(5, 2) },
      { kind: "login_success", platform: "desktop", userId: people[1]._id, occurredAt: noon(4) },
      { kind: "refresh_success", platform: "desktop", appVersion: "0.1.27", userId: people[1]._id, occurredAt: noon(2), count: 2 },
      { kind: "auth_rejection", reason: "revoked", platform: "desktop", appVersion: "0.1.27", userId: people[1]._id, occurredAt: noon(1) },
      { kind: "refresh_success", platform: "extension", appVersion: "1.4.14", userId: people[2]._id, occurredAt: noon(1), count: 3 },
      { kind: "session_restored", reason: "restart", platform: "extension", appVersion: "1.4.14", userId: people[2]._id, occurredAt: noon(0), count: 4 },
      { kind: "refresh_retry", reason: "network", platform: "extension", appVersion: "1.4.14", userId: people[2]._id, occurredAt: noon(1), count: 2 },
      { kind: "refresh_fail", reason: "max_age", platform: "desktop", appVersion: "0.1.27", userId: people[3]._id, occurredAt: noon(1) },
      { kind: "auth_rejection", reason: "expired", platform: "extension", userId: people[3]._id, occurredAt: noon(3), count: 4 },
      { kind: "auth_rejection", reason: "no_credentials", platform: "unknown", occurredAt: noon(0), count: 20 },
      { kind: "auth_rejection", reason: "invalid", platform: "unknown", occurredAt: noon(0), count: 2 },
      { kind: "signed_out", reason: "unknown", platform: "extension", appVersion: "1.4.14", userId: people[4]._id, occurredAt: noon(1) },
      { kind: "login_fail", reason: "invalid", platform: "website", occurredAt: noon(0) },
      { kind: "login_success", platform: "website", userId: superUser._id, occurredAt: noon(0) },
    ]);
    token = jwt.sign(
      { id: String(superUser._id), email: superUser.email, role: superUser.role, accountType: superUser.accountType, firmId: null, isActive: true, tv: 0 },
      process.env.JWT_SECRET,
      { expiresIn: "1h" },
    );
  } catch (error) {
    await cleanup();
    throw error;
  }
}

const panelUrl = `${base}/admin/super.html`;
console.log(`super panel pages and charts drive (DS10) - ${STUB ? "stub API, no database" : "local backend, scratch database"}`);
console.log(`  panel    ${panelUrl}`);
console.log("");

// Recorded before any page script runs: thrown errors, and the JSON of the analytics payload as the
// page itself received it.
const RECORDER = `(() => {
  window.__thrown = [];
  window.__payloads = {};
  addEventListener("error", (event) => window.__thrown.push(String(event.message || event.error)));
  addEventListener("unhandledrejection", (event) => window.__thrown.push(String(event.reason && event.reason.message || event.reason)));
  const original = window.fetch;
  window.fetch = async (...args) => {
    const response = await original(...args);
    const url = String(args[0] && args[0].url || args[0]);
    if (/\\/api\\/super\\/usage-stats$/.test(url)) response.clone().json().then((body) => { window.__payloads.usage = body; }, () => {});
    if (/\\/api\\/super\\/auth-health\\?/.test(url)) response.clone().json().then((body) => { window.__payloads.authHealth = body; }, () => {});
    return response;
  };
})();`;

// What each page asks for the first time it is opened.
const PAGE_ENDPOINTS = {
  overview: ["/api/super/dashboard-stats"],
  // DS24 added the history of changes to the platform switches.
  controls: ["/api/app-config", "/api/app-config/control-changes", "/api/app-config/desktop-release", "/api/super/provider-usage", "/api/super/reminder-delivery-health"],
  analytics: ["/api/super/usage-stats"],
  sessions: ["/api/super/auth-health"],
  emails: ["/api/super/emails", "/api/super/emails/suppressions"],
  users: ["/api/super/users"],
  firms: ["/api/super/firms"],
  approvals: ["/api/super/pending-admins"],
  terms: ["/api/super/terms-acceptances"],
  review: ["/api/super/self-test/latest"],
};
const apiPaths = (requests) => requests
  .map((request) => new URL(request.url))
  .filter((url) => url.origin === base.replace("localhost", "localhost") && url.pathname.startsWith("/api/"))
  .map((url) => url.pathname)
  .sort();

// The window the page should draw: windowDays days to today, widened to any day returned.
function expectedKeys(rows, windowDays) {
  const returned = rows.map((row) => row._id).sort();
  let start = todayUtc - (windowDays - 1) * DAY_MS;
  let end = todayUtc;
  if (returned.length) {
    start = Math.min(start, Date.parse(`${returned[0]}T00:00:00Z`));
    end = Math.max(end, Date.parse(`${returned[returned.length - 1]}T00:00:00Z`));
  }
  const keys = [];
  for (let at = start; at <= end; at += DAY_MS) keys.push(new Date(at).toISOString().slice(0, 10));
  return keys;
}

try {
  await withBrowser(async (page) => {
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: RECORDER });
    await page.goto(panelUrl, { waitMs: 1200 });
    await page.evaluate(`localStorage.setItem("caproadminjwt", ${JSON.stringify(token)}); localStorage.removeItem("caproDeepSystemTestRunId"); true`);
    page.clearRequests();
    await page.goto(panelUrl, { waitMs: 3500 });

    const where = await page.evaluate(`location.origin`);
    check("panel-is-local", where === base, `the page under test is ${where}`);

    // 1. Startup: the user, then the default page's data - nothing else.
    const startup = apiPaths(page.requests());
    const expectedStartup = ["/api/auth/me", ...PAGE_ENDPOINTS.overview].sort();
    check("startup-asks-only-for-the-default-page", JSON.stringify(startup) === JSON.stringify(expectedStartup), `${startup.length} API request(s) at startup: ${startup.join(", ")} (expected ${expectedStartup.join(", ")})`);
    const shown = await page.evaluate(`!document.getElementById("page-overview").hidden`);
    check("opens-on-overview", shown === true, `Overview shown at startup: ${shown}`);

    // 2. Each page asks for its own data on first opening, and only then.
    for (const name of ["controls", "analytics", "sessions", "emails", "users", "firms", "approvals", "terms", "review"]) {
      page.clearRequests();
      await page.evaluate(`location.hash = ${JSON.stringify(name)}; true`);
      await sleep(1500);
      const first = [...new Set(apiPaths(page.requests()))];
      const wanted = PAGE_ENDPOINTS[name];
      check(`${name}-loads-on-first-open`, JSON.stringify(first.sort()) === JSON.stringify([...wanted].sort()), `${name}: ${first.join(", ") || "nothing"}`);
      page.clearRequests();
      await page.evaluate(`location.hash = "overview"; true`);
      await sleep(400);
      await page.evaluate(`location.hash = ${JSON.stringify(name)}; true`);
      await sleep(700);
      const again = apiPaths(page.requests());
      check(`${name}-not-fetched-again`, again.length === 0, `${again.length} request(s) on the second visit`);
    }

    // 3. The analytics charts.
    await page.evaluate(`location.hash = "analytics"; true`);
    await sleep(500);
    const usage = await page.evaluate(`window.__payloads.usage && window.__payloads.usage.usage`);
    check("analytics-payload-seen", Boolean(usage), usage ? "the page received usage-stats" : "no usage-stats payload recorded");
    const read = (id) => page.evaluate(`(() => {
      const chart = document.getElementById(${JSON.stringify(id)});
      const table = chart.querySelector("table.day-chart__table");
      return {
        table: Boolean(table),
        caption: table ? table.caption.textContent.trim() : "",
        days: table ? [...table.tHead.rows[0].querySelectorAll("th[data-day]")].map((th) => th.dataset.day) : [],
        rows: table ? [...table.tBodies[0].rows].map((row) => ({ label: row.cells[0].textContent.trim(), values: [...row.cells].slice(1).map((cell) => Number(cell.textContent)) })) : [],
        ticks: [...chart.querySelectorAll(".day-chart__tick")].map((tick) => Number(tick.textContent)),
        bars: chart.querySelectorAll(".day-chart__day").length,
        legend: [...chart.querySelectorAll(".day-chart__legend li")].map((li) => li.textContent.trim()),
        heading: chart.closest(".card").querySelector("h2, h3, h6").textContent.trim(),
        note: chart.closest(".card").querySelector("p").textContent.trim(),
        sortable: chart.querySelectorAll(".super-sortable").length,
      };
    })()`);
    const charts = [
      { id: "dailyActivityChart", rows: usage?.dailyActivity || [], series: [["count", "Users"]], legend: [] },
      { id: "clientSplitChart", rows: usage?.dailyActivityByClient || [], series: [["desktop", "Desktop"], ["extension", "Extension"]], legend: ["Desktop", "Extension"] },
    ];
    for (const chart of charts) {
      const seen = await read(chart.id);
      const keys = expectedKeys(chart.rows, 14);
      const byDay = new Map(chart.rows.map((row) => [row._id, row]));
      check(`${chart.id}-has-a-table`, seen.table, `table beside the chart: ${seen.table}; caption ${JSON.stringify(seen.caption)}`);
      check(`${chart.id}-every-day-is-a-column`, JSON.stringify(seen.days) === JSON.stringify(keys) && seen.bars === keys.length, `${seen.days.length} day columns and ${seen.bars} bar groups for ${keys.length} days (${keys[0]} to ${keys[keys.length - 1]})`);
      const expectedRows = chart.series.map(([key, label]) => ({ label, values: keys.map((k) => Number(byDay.get(k)?.[key]) || 0) }));
      check(`${chart.id}-table-equals-payload`, JSON.stringify(seen.rows) === JSON.stringify(expectedRows), `rows ${JSON.stringify(seen.rows.map((row) => `${row.label}: ${row.values.join(" ")}`))}`);
      const max = Math.max(0, ...expectedRows.flatMap((row) => row.values));
      check(`${chart.id}-has-a-scale`, seen.ticks.length >= 2 && seen.ticks[0] === 0 && seen.ticks[seen.ticks.length - 1] >= max, `y-axis ticks ${seen.ticks.join(", ")} for a largest figure of ${max}`);
      check(`${chart.id}-legend`, JSON.stringify(seen.legend) === JSON.stringify(chart.legend), `legend ${JSON.stringify(seen.legend)}`);
      check(`${chart.id}-states-window-and-denominator`, /14/.test(seen.heading) && /UTC/.test(seen.heading) && /counted|Counted/.test(seen.note), `${seen.heading} / ${seen.note.slice(0, 90)}...`);
      check(`${chart.id}-columns-stay-in-day-order`, seen.sortable === 0, `${seen.sortable} sortable header(s) on the chart's table`);
    }

    // 3b. Sign-in health (PHASE 8): what the page shows equals the payload it received.
    await page.evaluate(`location.hash = "sessions"; true`);
    await sleep(600);
    const health = await page.evaluate(`window.__payloads.authHealth || null`);
    check("sessions-payload-seen", Boolean(health && health.ok), health ? `window ${health.windowDays} days, ${(health.byKindReason || []).length} kind/reason rows` : "no auth-health payload recorded");
    if (health) {
      const shown = await page.evaluate(`(() => {
        const text = (el) => (el ? el.textContent.replace(/\\s+/g, " ").trim() : "");
        const rows = (id) => [...document.getElementById(id).rows].map((row) => [...row.cells].map((cell) => text(cell)));
        return {
          cards: [...document.querySelectorAll("#sessionsGrid .stat-card")].map((card) => ({ label: text(card.querySelector(".stat-label")), value: text(card.querySelector(".stat-value")) })),
          rejections: rows("sessionsRejectionsBody"),
          failures: rows("sessionsFailuresBody"),
          durations: rows("sessionsDurationsBody"),
          versions: rows("sessionsVersionsBody"),
          charts: ["sessionsStartChart", "sessionsEndChart"].map((id) => Boolean(document.querySelector("#" + id + " table.day-chart__table")) || Boolean(document.querySelector("#" + id + " .day-chart__empty"))),
          pressed: [...document.querySelectorAll("#sessionsWindowButtons [aria-pressed='true']")].map((b) => b.dataset.days),
          // innerText, not textContent: adjacent table cells 4, 0, 1 must not read as "401".
          pageText: document.getElementById("page-sessions").innerText,
        };
      })()`);
      const n = (value) => Number(String(value).replace(/[^0-9-]/g, "")) || 0;
      const sum = (pred) => (health.byKindReason || []).filter(pred).reduce((t, r) => t + (Number(r.count) || 0), 0);
      const card = (label) => shown.cards.find((c) => c.label === label);
      const totals = health.totals || {};
      check("sessions-cards", shown.cards.length === 7
        && n(card("Sign-ins")?.value) === (totals.login_success || 0)
        && n(card("Renewed")?.value) === (totals.refresh_success || 0)
        && n(card("Refused requests")?.value) === (totals.auth_rejection || 0)
        && n(card("Restored after restart")?.value) === (totals.session_restored || 0)
        && n(card("Signed out by the user")?.value) === sum((r) => r.kind === "signed_out" && r.reason === "signed_out")
        && n(card("Other sign-outs")?.value) === (totals.signed_out || 0) - sum((r) => r.kind === "signed_out" && r.reason === "signed_out"),
        shown.cards.map((c) => `${c.label}=${c.value}`).join("; "));
      const reasons = [...new Set((health.byKindReason || []).filter((r) => r.kind === "auth_rejection").map((r) => r.reason))];
      const rejectionTotals = shown.rejections.map((cells) => n(cells[cells.length - 1])).sort((a, b) => b - a);
      const expectedTotals = reasons.map((reason) => sum((r) => r.kind === "auth_rejection" && r.reason === reason)).sort((a, b) => b - a);
      check("sessions-refusal-reasons", reasons.length === 0
        ? shown.rejections.length === 1
        : JSON.stringify(rejectionTotals) === JSON.stringify(expectedTotals),
        `${shown.rejections.length} reason row(s): ${shown.rejections.map((c) => c[0] + " " + c[c.length - 1]).join("; ")}`);
      const unknownApps = [...new Set((health.byKindReason || []).map((r) => r.platform))].filter((p) => !["extension", "desktop", "website", "unknown"].includes(p));
      check("sessions-unknown-app-shown-verbatim", unknownApps.every((p) => shown.pageText.includes(p)), unknownApps.length ? `unknown app(s) ${unknownApps.join(", ")} shown` : "no unknown app in this payload");
      const failureRows = (health.byKindReason || []).filter((r) => ["login_fail", "refresh_fail", "refresh_retry", "signed_out"].includes(r.kind));
      check("sessions-failures", failureRows.length === 0 ? shown.failures.length === 1 : shown.failures.length === failureRows.length
        // DS44: Cause, What happened, Reason, App, Count.
        && shown.failures.every((cells, i) => cells.length === 5), `${shown.failures.length} row(s) for ${failureRows.length} payload row(s)`);
      const buckets = health.sessionDurationHours || [];
      check("sessions-durations", buckets.length === 0 ? shown.durations.length === 1 : JSON.stringify(shown.durations.map((c) => n(c[1]))) === JSON.stringify(buckets.map((b) => b.count)),
        shown.durations.map((c) => c.join(" ")).join("; "));
      const groups = new Set((health.byVersion || []).map((r) => r.platform + "|" + (r.appVersion || "")));
      check("sessions-versions", groups.size === 0 ? shown.versions.length === 1 : shown.versions.length === groups.size,
        shown.versions.map((c) => c.slice(0, 2).join(" ")).join("; "));
      check("sessions-charts-have-tables", shown.charts.every(Boolean), JSON.stringify(shown.charts));
      check("sessions-default-window", JSON.stringify(shown.pressed) === JSON.stringify(["30"]), `pressed ${shown.pressed.join(",")}`);
      const banned = ["logout", "401", "403", "429", "HTTP", "null", "undefined", "NaN", "exception"].filter((word) => new RegExp(`\\b${word}\\b`, "i").test(shown.pageText));
      check("sessions-no-transport-words", banned.length === 0, banned.length ? `found ${banned.join(", ")}` : "clean");

      const healthRequests = () => page.requests().map((r) => r.url).filter((url) => url.includes("/api/super/auth-health"));
      page.clearRequests();
      await page.evaluate(`document.querySelector('#sessionsWindowButtons [data-days="7"]').click(); true`);
      await sleep(800);
      const seven = healthRequests();
      const pressedSeven = await page.evaluate(`[...document.querySelectorAll("#sessionsWindowButtons [aria-pressed='true']")].map((b) => b.dataset.days).join(",")`);
      check("sessions-window-7", seven.length === 1 && /[?&]days=7$/.test(seven[0]) && pressedSeven === "7", `${seven.join(", ") || "no request"}; pressed ${pressedSeven}`);
      page.clearRequests();
      await page.evaluate(`document.getElementById("sessionsCustomDays").value = "0"; document.getElementById("sessionsApplyBtn").click(); true`);
      await sleep(500);
      const invalid = healthRequests();
      const invalidStatus = await page.evaluate(`document.getElementById("sessionsStatus").textContent`);
      check("sessions-invalid-window-asks-nothing", invalid.length === 0 && /whole number of days/.test(invalidStatus), `${invalid.length} request(s); status ${JSON.stringify(invalidStatus)}`);
      page.clearRequests();
      await page.evaluate(`document.getElementById("sessionsCustomDays").value = "45"; document.getElementById("sessionsApplyBtn").click(); true`);
      await sleep(800);
      const custom = healthRequests();
      check("sessions-custom-window", custom.length === 1 && /[?&]days=45$/.test(custom[0]), custom.join(", ") || "no request");
      if (STUB) {
        stubState.authHealthFails = true;
        await page.evaluate(`document.getElementById("sessionsCustomDays").value = ""; document.getElementById("sessionsApplyBtn").click(); true`);
        await sleep(800);
        const failedState = await page.evaluate(`({ tone: document.getElementById("sessionsStatus").dataset.tone || "", text: document.getElementById("sessionsStatus").textContent })`);
        check("sessions-failed-load-says-so", failedState.tone === "critical" && /could not be loaded/.test(failedState.text) && !/500|HTTP/.test(failedState.text), JSON.stringify(failedState));
        stubState.authHealthFails = false;
      }
      if (process.env.SESSIONS_SHOT) {
        await page.evaluate(`document.querySelector('#sessionsWindowButtons [data-days="30"]').click(); true`);
        await page.send("Emulation.setDeviceMetricsOverride", { width: 1366, height: 1700, deviceScaleFactor: 1, mobile: false });
        await sleep(900);
        await page.evaluate(`window.scrollTo(0, 0); true`);
        const sessionsShot = await page.send("Page.captureScreenshot", { format: "png" });
        const { writeFileSync } = await import("node:fs");
        writeFileSync(process.env.SESSIONS_SHOT, Buffer.from(sessionsShot.data, "base64"));
        console.log(`  screenshot ${process.env.SESSIONS_SHOT}`);
        await page.send("Emulation.clearDeviceMetricsOverride", {});
      }
    }

    // 4. Nothing threw.
    const thrown = await page.evaluate(`window.__thrown.slice()`);
    const failedLoads = page.consoleLines().filter((line) => /Loading the .* page failed|TypeError|ReferenceError/.test(line));
    check("nothing-threw", thrown.length === 0 && failedLoads.length === 0, `${thrown.length} uncaught, ${failedLoads.length} failed page load(s)${thrown.length ? `: ${thrown[0]}` : ""}`);

    // 5. The Controls cards stay closed until the server's settings have been read. Loading by
    // page put the read at the moment the page opens, so a switch at rest and empty fields must
    // not be clickable, or savable, as if they were the platform's state.
    const CARDS = ["maintenanceSet", "welcomeSet", "featureFlagsSet", "desktopReleaseSet"];
    const cardState = () => page.evaluate(`(() => ({
      disabled: ${JSON.stringify(CARDS)}.map((id) => document.getElementById(id) ? document.getElementById(id).disabled : null),
      busy: ${JSON.stringify(CARDS)}.map((id) => document.getElementById(id) ? document.getElementById(id).getAttribute("aria-busy") : null),
      label: document.getElementById("maintenanceLabel").textContent.trim(),
      checked: document.getElementById("maintenanceToggle").checked,
    }))()`);
    const reloadAt = async (hash, waitMs) => {
      await page.send("Page.navigate", { url: "about:blank" });
      await sleep(300);
      await page.goto(`${panelUrl}#${hash}`, { waitMs });
    };
    if (STUB) {
      stubState.appConfigDelayMs = 2500;
      await reloadAt("controls", 1200);
      const waiting = await cardState();
      check(
        "controls-cards-closed-while-reading",
        waiting.disabled.slice(0, 3).every((d) => d === true) && waiting.busy.slice(0, 3).every((b) => b === "true") && /loading/i.test(waiting.label),
        `while /app-config is outstanding: disabled ${waiting.disabled.join(",")}, label ${JSON.stringify(waiting.label)}`,
      );
      await sleep(2500);
      stubState.appConfigDelayMs = 0;
    } else {
      await reloadAt("controls", 3000);
    }
    const opened = await cardState();
    check(
      "controls-cards-open-once-read",
      opened.disabled.every((d) => d === false) && opened.busy.every((b) => b === "false") && opened.checked === storedMaintenance && opened.label === `Maintenance mode: ${storedMaintenance ? "ON" : "OFF"}`,
      `after reading: disabled ${opened.disabled.join(",")}, switch ${opened.checked}, label ${JSON.stringify(opened.label)}`,
    );
    if (STUB) {
      stubState.appConfigFails = true;
      await reloadAt("controls", 2500);
      const unread = await cardState();
      check(
        "controls-cards-stay-closed-when-unread",
        unread.disabled.slice(0, 3).every((d) => d === true) && /could not be read/.test(unread.label),
        `with /app-config failing: disabled ${unread.disabled.join(",")}, label ${JSON.stringify(unread.label)}`,
      );
      stubState.appConfigFails = false;
    }

    if (process.env.DS10_SHOT) {
      await page.evaluate(`location.hash = "analytics"; document.querySelector(".content") && (document.querySelector(".content").scrollTop = 0); true`);
      await page.send("Emulation.setDeviceMetricsOverride", { width: 1366, height: 1500, deviceScaleFactor: 1, mobile: false });
      await sleep(600);
      const shot = await page.send("Page.captureScreenshot", { format: "png" });
      const { writeFileSync } = await import("node:fs");
      writeFileSync(process.env.DS10_SHOT, Buffer.from(shot.data, "base64"));
      console.log(`  screenshot ${process.env.DS10_SHOT}`);
    }
  }, { headless: !SHOW });
} finally {
  await cleanup();
}

console.log("");
console.log(`passed: ${pass}  failed: ${fail}`);
if (fail > 0) {
  console.log(`failing checks: ${failures.join(", ")}`);
  // process.exitCode, not process.exit(): exiting after a fetch aborts Node 24 on Windows (V32).
  process.exitCode = 1;
} else {
  console.log("SUPER PAGES DRIVE OK");
}
