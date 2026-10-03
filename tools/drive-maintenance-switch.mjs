// tools/drive-maintenance-switch.mjs
//
// Ledger task DS6: the super-admin panel's maintenance switch asks before it takes every user
// offline, and the panel no longer opens on the page that holds it.
//
// WHY THIS EXISTS
// ---------------
// The switch PATCHed /api/app-config/maintenance on the first click - no confirmation - and the
// panel's default page was Controls, where the switch lives. One stray click on the landing page
// put every user of the product behind the maintenance screen. Every other destructive action in
// the panel (delete a user, erase a firm, notify all users) already asked first.
//
// This drives the REAL panel in a REAL browser against a LOCAL backend and a scratch database, the
// same way tools/drive-local-panel.mjs does, and with the same three guards, each of which aborts
// before anything is created:
//   1. The API base must be a loopback address.
//   2. MONGODB_URI must be a loopback address, and its database name must carry the scratch marker.
//   3. The outbound provider keys are blanked in this process.
// The scratch database is dropped at the end, including when a check fails. Nothing here can reach
// api.caprotoolkit.in.
//
// window.confirm is replaced inside the page with a recorder that answers as told, so the drive
// sees exactly what the panel asks and what it sends after each answer.
//
// USAGE
//   node tools/drive-maintenance-switch.mjs            # headless
//   node tools/drive-maintenance-switch.mjs --show     # watch it
import { withBrowser } from "./browser-drive.mjs";

const SCRATCH_MARKER = "capro-local-maintenance-drive";
const MONGO_URI = `mongodb://127.0.0.1:27117/${SCRATCH_MARKER}`;
const SUPER_EMAIL = "saifullahfaizan786@gmail.com";
const SHOW = process.argv.includes("--show");

// Development mode for the same reason drive-local-panel.mjs gives: its runs were captured in it,
// and what the mode changes is error verbosity, not the route under test.
process.env.NODE_ENV = "development";
process.env.JWT_SECRET = "local-maintenance-drive-only-not-a-real-secret";
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
if (!MONGO_URI.includes(SCRATCH_MARKER)) throw new Error("MONGODB_URI must name the scratch database - refusing to run");

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
const base = `http://localhost:${server.address().port}`;
assertLoopback("API base", base);
const panelUrl = `${base}/admin/super.html`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

console.log("local maintenance-switch drive (DS6)");
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

const storedMode = async () => Boolean((await AppConfig.findById("singleton").lean())?.maintenanceMode);

try {
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  await mongoose.connection.dropDatabase();
  const superUser = await User.create({
    email: SUPER_EMAIL,
    name: "Local Drive Super Admin",
    role: "SUPER_ADMIN",
    accountType: "INDIVIDUAL",
  });
  await AppConfig.create({ _id: "singleton", maintenanceMode: false });
  const superToken = jwt.sign(
    { id: String(superUser._id), email: superUser.email, role: superUser.role, accountType: superUser.accountType, firmId: null, isActive: true, tv: 0 },
    process.env.JWT_SECRET,
    { expiresIn: "1h" },
  );

  await withBrowser(async (page) => {
    await page.goto(panelUrl, { waitMs: 1200 });
    await page.evaluate(`localStorage.setItem("caproadminjwt", ${JSON.stringify(superToken)}); true`);
    await page.goto(panelUrl, { waitMs: 3500 });

    const where = JSON.parse(await page.evaluate(`JSON.stringify({ origin: location.origin, hash: location.hash })`));
    check("panel-is-local", where.origin === base, `the page under test is ${where.origin} (expected ${base})`);

    // ─── The panel opens on Overview ─────────────────────────────────
    const landing = JSON.parse(await page.evaluate(`JSON.stringify({
      overview: !document.getElementById("page-overview")?.hidden,
      controls: !document.getElementById("page-controls")?.hidden,
      current: document.querySelector('.sidebar a[aria-current="page"]')?.getAttribute("href") || "",
    })`));
    check(
      "default-page-is-overview",
      landing.overview === true && landing.controls === false && landing.current === "#overview",
      `with no hash: overview shown ${landing.overview}, controls shown ${landing.controls}, current link ${JSON.stringify(landing.current)}`,
    );

    // To the switch, the way a person gets there. Its card opens once the server's settings have
    // been read (DS10: Controls loads when it is opened, and stays disabled until then).
    await page.evaluate(`location.hash = "controls"; true`);
    await sleep(800);
    for (let waited = 0; waited < 5000; waited += 200) {
      if (await page.evaluate(`!document.getElementById("maintenanceSet") || !document.getElementById("maintenanceSet").disabled`)) break;
      await sleep(200);
    }
    const onControls = await page.evaluate(`!document.getElementById("page-controls").hidden`);
    check("controls-reachable", onControls === true, `Controls shown after choosing it: ${onControls}`);

    // A recorder in place of confirm(), answering as the drive tells it.
    await page.evaluate(`(() => {
      window.__asked = [];
      window.__answer = false;
      window.confirm = (message) => { window.__asked.push(String(message)); return window.__answer === true; };
      return true;
    })()`);
    const maintenancePatches = () =>
      page.requests().filter((request) => request.method === "PATCH" && /\/app-config\/maintenance/.test(request.url));

    // ─── 1. Declining sends nothing ──────────────────────────────────
    page.clearRequests();
    await page.evaluate(`document.getElementById("maintenanceToggle").click(); true`);
    await sleep(1500);
    const declined = JSON.parse(await page.evaluate(`JSON.stringify({
      asked: window.__asked.slice(),
      checked: document.getElementById("maintenanceToggle").checked,
    })`));
    check("asks-before-turning-on", declined.asked.length === 1 && /Every user will see the maintenance screen/.test(declined.asked[0]), `asked ${declined.asked.length} time(s): ${JSON.stringify(declined.asked[0] || "")}`);
    check("declining-sends-no-patch", maintenancePatches().length === 0, `${maintenancePatches().length} PATCH to /app-config/maintenance after declining (expected 0)`);
    check("declining-leaves-switch-off", declined.checked === false, `switch checked after declining: ${declined.checked}`);
    check("declining-changes-nothing-stored", (await storedMode()) === false, `stored maintenanceMode after declining: ${await storedMode()}`);

    // ─── 2. Accepting turns it on, once ──────────────────────────────
    page.clearRequests();
    await page.evaluate(`window.__answer = true; window.__asked = []; document.getElementById("maintenanceToggle").click(); true`);
    await sleep(2000);
    const label = await page.evaluate(`document.getElementById("maintenanceLabel").textContent.trim()`);
    check("accepting-sends-one-patch", maintenancePatches().length === 1, `${maintenancePatches().length} PATCH after accepting (expected 1)`);
    check("accepted-on-is-stored", (await storedMode()) === true, `stored maintenanceMode: ${await storedMode()}, label ${JSON.stringify(label)}`);

    // ─── 3. Turning it off asks too, and names the effect ────────────
    page.clearRequests();
    await page.evaluate(`window.__asked = []; document.getElementById("maintenanceToggle").click(); true`);
    await sleep(2000);
    const offAsked = await page.evaluate(`window.__asked.slice()`);
    check("asks-before-turning-off", offAsked.length === 1 && /full access again/.test(offAsked[0]), `asked: ${JSON.stringify(offAsked[0] || "")}`);
    check("accepted-off-is-stored", maintenancePatches().length === 1 && (await storedMode()) === false, `${maintenancePatches().length} PATCH; stored maintenanceMode: ${await storedMode()}`);
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
console.log("MAINTENANCE SWITCH DRIVE OK");
