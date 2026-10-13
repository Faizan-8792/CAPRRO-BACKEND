// tools/drive-sign-in-health.mjs
//
// Draws the REAL super-admin panel in a REAL browser, against a LOCAL backend and a scratch
// database, and reads back what DS43 and DS44 put on it:
//   - DS44: the Sign-in health page's failures table - a Cause for every row, words rather than
//     raw reason keys, defects ("Needs a look") first, and the summary line under the heading;
//   - DS43: the bar saying which of the owner's own accounts the figures leave out, the switch that
//     brings them back, and that the bar is not shown on a page that is not a report.
//
// Same safety shape as drive-local-panel.mjs, asserted rather than intended: the API base and
// MONGODB_URI must be loopback, the database name must carry the scratch marker, the outbound
// provider keys are blanked in this process, and the scratch database is dropped at the end, also
// when a check fails. There is no flag that points this at api.caprotoolkit.in.
//
// USAGE
//   node tools/drive-sign-in-health.mjs                 # headless
//   node tools/drive-sign-in-health.mjs --show          # watch it
//   node tools/drive-sign-in-health.mjs --shot <dir>    # also save screenshots of the pages it read

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { withBrowser } from "./browser-drive.mjs";

const SCRATCH_MARKER = "capro-local-sign-in-health-drive";
const MONGO_URI = `mongodb://127.0.0.1:27117/${SCRATCH_MARKER}`;
const SUPER_EMAIL = "saifullahfaizan786@gmail.com";
const OWNER_TEST_EMAIL = "wb.robotics.qa@example.invalid";
const CLIENT_EMAIL = "ordinary.client@example.invalid";
const SHOW = process.argv.includes("--show");
const shotIndex = process.argv.indexOf("--shot");
const SHOT_DIR = shotIndex > 0 ? process.argv[shotIndex + 1] : "";

// Set BEFORE src/app.js is imported: dotenv does not override a value already present.
process.env.NODE_ENV = "development";
process.env.JWT_SECRET = "sign-in-health-drive-only-not-a-real-secret";
process.env.MONGODB_URI = MONGO_URI;
delete process.env.OWNER_ACCOUNT_PATTERNS;
for (const outbound of ["RESEND_API_KEY", "DEEPSEEK_API_KEY", "OCR_SPACE_API_KEY", "HOSTINGER_API_TOKEN", "CAPTCHA_API"]) {
  process.env[outbound] = "";
}

function assertLoopback(label, value) {
  const host = /^mongodb:\/\/([^/:]+)/.exec(value)?.[1] ?? new URL(value).hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error(`${label} must be loopback, got ${host} - refusing to run`);
  }
}
assertLoopback("MONGODB_URI", MONGO_URI);
if (!MONGO_URI.includes(SCRATCH_MARKER)) throw new Error("MONGODB_URI must name the scratch database - refusing to run");

const mongoose = (await import("mongoose")).default;
const jwt = (await import("jsonwebtoken")).default;
const { default: app } = await import("../src/app.js");
const { default: User } = await import("../src/models/User.js");
const { default: AuthHealthEvent } = await import("../src/models/AuthHealthEvent.js");

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
const base = `http://localhost:${server.address().port}`;
assertLoopback("API base", base);
const panelUrl = `${base}/admin/super.html`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

console.log("sign-in health and own-accounts drive");
console.log(`  api      ${base}`);
console.log(`  mongo    ${MONGO_URI}`);
console.log("");

async function cleanup() {
  try {
    if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
  } catch (error) {
    console.log(`  WARNING could not drop the scratch database: ${error.message}`);
  }
  try { await mongoose.disconnect(); } catch { /* already closed */ }
  await new Promise((resolve) => server.close(resolve));
}

try {
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  await mongoose.connection.dropDatabase();

  const now = new Date();
  const superUser = await User.create({ email: SUPER_EMAIL, name: "Owner", role: "SUPER_ADMIN", accountType: "INDIVIDUAL", isActive: true, lastActiveAt: now });
  const ownerTest = await User.create({ email: OWNER_TEST_EMAIL, name: "Owner test", role: "USER", accountType: "INDIVIDUAL", isActive: true, lastActiveAt: now });
  const client = await User.create({ email: CLIENT_EMAIL, name: "Client", role: "USER", accountType: "INDIVIDUAL", isActive: true, lastActiveAt: now });
  const event = (kind, reason, platform, userId, count) => ({ kind, reason, platform, userId, count, occurredAt: now });
  await AuthHealthEvent.insertMany([
    event("login_success", "unknown", "extension", client._id, 3),
    event("login_success", "unknown", "desktop", ownerTest._id, 5),
    event("login_fail", "wrong_otp", "website", client._id, 2),
    event("login_fail", "wrong_otp", "website", superUser._id, 4),
    event("login_fail", "google_unreachable", "extension", null, 1),
    event("login_fail", "invalid", "extension", null, 1),
    event("login_fail", "rate_limited", "website", null, 1),
    event("login_fail", "clock", "desktop", null, 1),
    event("refresh_fail", "expired", "extension", client._id, 2),
    event("signed_out", "signed_out", "extension", client._id, 1),
  ]);
  const superToken = jwt.sign(
    { id: String(superUser._id), email: SUPER_EMAIL, role: "SUPER_ADMIN", accountType: "INDIVIDUAL", firmId: null, isActive: true, tv: 0 },
    process.env.JWT_SECRET,
    { expiresIn: "1h" },
  );

  await withBrowser(async (page) => {
    const waitFor = async (expression, ms = 8000) => {
      for (let waited = 0; waited < ms; waited += 200) {
        if (await page.evaluate(expression)) return true;
        await sleep(200);
      }
      return false;
    };
    const shot = async (name) => {
      if (!SHOT_DIR) return;
      const { data } = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
      writeFileSync(join(SHOT_DIR, name), Buffer.from(data, "base64"));
    };
    await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1600, deviceScaleFactor: 1, mobile: false });

    // localStorage is origin-scoped, so the origin is loaded before the token is planted.
    await page.goto(panelUrl, { waitMs: 1200 });
    await page.evaluate(`localStorage.setItem("caproadminjwt", ${JSON.stringify(superToken)}); localStorage.removeItem("caproSuperIncludeOwnAccounts"); true`);
    // The first load had no token and the panel said so on the console; only what follows counts.
    const consoleFrom = page.consoleLines().length;
    await page.goto(`${panelUrl}#sessions`, { waitMs: 1500 });
    const drawn = await waitFor(`document.querySelectorAll("#sessionsFailuresBody tr td").length > 4`);
    check("sessions-drawn", drawn, drawn ? "the failures table has rows" : "the failures table never filled");

    const readSessions = () => page.evaluate(`(() => {
      const rows = [...document.querySelectorAll("#sessionsFailuresBody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent.trim()));
      const card = [...document.querySelectorAll("#sessionsGrid .stat-card")].find((c) => c.querySelector(".stat-label")?.textContent.trim() === "Sign-ins");
      const bar = document.getElementById("ownAccountsBar");
      return {
        rows,
        heads: [...document.querySelectorAll("#sessionsFailuresBody")].map((b) => b.closest("table").querySelectorAll("thead th").length)[0],
        summary: document.getElementById("sessionsFailuresSummary")?.textContent.trim() || "",
        signIns: card?.querySelector(".stat-value")?.textContent.trim() || "",
        signInsSub: card?.querySelector(".stat-sub")?.textContent.trim() || "",
        bar: bar && !bar.hidden ? document.getElementById("ownAccountsNote").textContent.trim() : null,
        switchOn: document.getElementById("includeOwnAccounts")?.checked === true,
        bodyText: document.getElementById("page-sessions")?.innerText || "",
      };
    })()`);

    const first = await readSessions();
    await shot("sign-in-health.png");
    check("five-columns", first.heads === 5 && first.rows.every((cells) => cells.length === 5), `${first.heads} heads; cells per row ${[...new Set(first.rows.map((c) => c.length))]}`);
    check("defects-first", first.rows[0]?.[0] === "Needs a look", `first row: ${JSON.stringify(first.rows[0])}`);
    const wrong = first.rows.find((cells) => cells[2] === "Wrong code typed");
    check("person-cause", wrong?.[0] === "The person's own" && wrong?.[4] === "2", `wrong code row: ${JSON.stringify(wrong)}`);
    const unreachable = first.rows.find((cells) => cells[2] === "Google could not be reached");
    check("passing-cause", unreachable?.[0] === "Network or Google, passed", `unreachable row: ${JSON.stringify(unreachable)}`);
    const rawKeys = ["wrong_otp", "google_unreachable", "rate_limited", "otp_locked", "email_unverified"].filter((key) => first.bodyText.includes(key));
    check("words-not-keys", rawKeys.length === 0, rawKeys.length ? `raw keys on screen: ${rawKeys}` : "no raw reason key on the page");
    check("summary-line", first.summary === "Failed sign-ins: 6. Needs a look: 2. Too many tries: 1. Network or Google, passed: 1. The person's own: 2.", JSON.stringify(first.summary));
    check("sign-ins-card", first.signIns === "3" && first.signInsSub === "6 failed, 2 need a look", `${first.signIns} / ${first.signInsSub}`);
    check("own-accounts-bar", typeof first.bar === "string" && first.bar.includes("leave out your own accounts (2)") && first.bar.includes(SUPER_EMAIL) && first.bar.includes(OWNER_TEST_EMAIL) && !first.bar.includes(CLIENT_EMAIL) && !first.switchOn, JSON.stringify(first.bar));

    // The switch brings the owner's accounts back, on this page and the next.
    await page.evaluate(`document.getElementById("includeOwnAccounts").click(); true`);
    const reloaded = await waitFor(`(document.getElementById("ownAccountsNote")?.textContent || "").includes("include your own accounts")`);
    const second = await readSessions();
    const wrongAll = second.rows.find((cells) => cells[2] === "Wrong code typed");
    check("switch-on", reloaded && second.switchOn && second.signIns === "8" && wrongAll?.[4] === "6", `${second.signIns} sign-ins; wrong code ${wrongAll?.[4]}; bar ${JSON.stringify(second.bar)}`);

    await page.evaluate(`location.hash = "#users"; true`);
    await waitFor(`document.querySelectorAll("#userDirectoryBody tr td").length > 2`);
    await sleep(400);
    const usersAll = await page.evaluate(`document.getElementById("userDirectoryBody").innerText`);
    check("switch-carries", usersAll.includes(OWNER_TEST_EMAIL) && usersAll.includes(CLIENT_EMAIL), "the user directory lists the owner's accounts while the switch is on");

    await page.evaluate(`document.getElementById("includeOwnAccounts").click(); true`);
    await waitFor(`!document.getElementById("userDirectoryBody").innerText.includes(${JSON.stringify(OWNER_TEST_EMAIL)})`);
    await sleep(400);
    const usersOwn = await page.evaluate(`({ text: document.getElementById("userDirectoryBody").innerText, bar: document.getElementById("ownAccountsBar").hidden ? null : document.getElementById("ownAccountsNote").textContent })`);
    await shot("user-directory.png");
    check("users-left-out", !usersOwn.text.includes(OWNER_TEST_EMAIL) && !usersOwn.text.includes(SUPER_EMAIL) && usersOwn.text.includes(CLIENT_EMAIL) && (usersOwn.bar || "").includes("leave out"), `bar ${JSON.stringify(usersOwn.bar)}`);

    await page.evaluate(`location.hash = "#review"; true`);
    await sleep(600);
    const onReview = await page.evaluate(`document.getElementById("ownAccountsBar").hidden`);
    check("not-on-other-pages", onReview === true, "the bar is hidden on the Deep system review page");

    const errors = page.consoleLines().slice(consoleFrom).filter((line) => /error|uncaught|failed/i.test(line));
    check("no-console-errors", errors.length === 0, errors.length ? errors.join(" | ") : "none");
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
  console.log("SIGN-IN HEALTH DRIVE OK");
}
