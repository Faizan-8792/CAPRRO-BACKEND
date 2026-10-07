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
// DS24: the panel asks through the shared CA PRO dialog (ui/capro-ui.js), not window.confirm. The
// drive answers the REAL dialog the way a person does - reads it, types into its fields, presses
// its buttons - so what is under test is the panel and the dialog together: that it asks, that
// turning maintenance on needs a reason and the environment's name typed, that declining sends
// nothing, and that the reason reaches the server's record of the change.
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

console.log("local maintenance-switch drive (DS6, DS24)");
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
const storedChanges = async () => (await AppConfig.findById("singleton").lean())?.controlChanges || [];

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

    // The dialog as a person sees it: its title and body, its fields, its buttons.
    const dialog = async () => JSON.parse(await page.evaluate(`JSON.stringify((() => {
      const d = document.querySelector("dialog.cp-dialog");
      if (!d) return null;
      const buttons = [...d.querySelectorAll(".cp-dialog__footer button")];
      return {
        open: d.open,
        text: (d.querySelector(".cp-dialog__title")?.textContent || "") + " | " + (d.querySelector(".cp-dialog__body")?.textContent || "").replace(/\\s+/g, " ").trim(),
        fields: [...d.querySelectorAll("label.cp-label")].map((l) => l.textContent),
        buttons: buttons.map((b) => ({ label: b.textContent, disabled: b.disabled })),
      };
    })())`));
    // Types into the dialog's nth field the way a keyboard would (value, then an input event).
    const type = (index, text) => page.evaluate(`(() => {
      const box = document.querySelectorAll("dialog.cp-dialog input")[${index}];
      box.value = ${JSON.stringify("")} + ${JSON.stringify(text)};
      box.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    const press = (label) => page.evaluate(`(() => {
      const b = [...document.querySelectorAll("dialog.cp-dialog .cp-dialog__footer button")].find((x) => x.textContent === ${JSON.stringify(label)});
      if (!b) return false;
      b.click();
      return true;
    })()`);
    const maintenancePatches = () =>
      page.requests().filter((request) => request.method === "PATCH" && /\/app-config\/maintenance/.test(request.url));

    // ─── 1. Declining sends nothing ──────────────────────────────────
    page.clearRequests();
    await page.evaluate(`document.getElementById("maintenanceToggle").click(); true`);
    await sleep(600);
    const asked = await dialog();
    check("asks-before-turning-on", asked?.open === true && /Every user will see the maintenance screen/.test(asked.text), `dialog: ${JSON.stringify(asked?.text || null)}`);
    check("asks-for-a-reason-and-the-environment", asked?.fields.length === 2 && /Reason/.test(asked.fields[0]) && /Type local to confirm/.test(asked.fields[1]), `fields: ${JSON.stringify(asked?.fields || [])}`);
    const turnOn = asked?.buttons.find((b) => b.label === "Turn on maintenance");
    check("turn-on-is-off-until-both-are-filled", turnOn?.disabled === true, `Turn on maintenance disabled before typing: ${turnOn?.disabled}`);
    await press("Keep it off");
    await sleep(1200);
    const declined = JSON.parse(await page.evaluate(`JSON.stringify({ checked: document.getElementById("maintenanceToggle").checked, open: !!document.querySelector("dialog.cp-dialog") })`));
    check("declining-closes-the-dialog", declined.open === false, `dialog still open: ${declined.open}`);
    check("declining-sends-no-patch", maintenancePatches().length === 0, `${maintenancePatches().length} PATCH to /app-config/maintenance after declining (expected 0)`);
    check("declining-leaves-switch-off", declined.checked === false, `switch checked after declining: ${declined.checked}`);
    check("declining-changes-nothing-stored", (await storedMode()) === false && (await storedChanges()).length === 0, `stored maintenanceMode after declining: ${await storedMode()}, history ${(await storedChanges()).length}`);

    // ─── 2. The word alone is not enough; the reason and the word turn it on, once ─────
    page.clearRequests();
    await page.evaluate(`document.getElementById("maintenanceToggle").click(); true`);
    await sleep(600);
    await type(1, "local");
    const wordOnly = (await dialog())?.buttons.find((b) => b.label === "Turn on maintenance");
    check("the-word-alone-is-not-enough", wordOnly?.disabled === true, `Turn on maintenance disabled with no reason: ${wordOnly?.disabled}`);
    const REASON_ON = "Database upgrade, about 15 minutes (local drive)";
    await type(0, REASON_ON);
    const both = (await dialog())?.buttons.find((b) => b.label === "Turn on maintenance");
    check("the-reason-and-the-word-turn-it-on", both?.disabled === false, `Turn on maintenance disabled with both: ${both?.disabled}`);
    await press("Turn on maintenance");
    await sleep(2000);
    const label = await page.evaluate(`document.getElementById("maintenanceLabel").textContent.trim()`);
    const scopeChip = await page.evaluate(`!document.getElementById("superScopeMaintenance").hidden`);
    check("accepting-sends-one-patch", maintenancePatches().length === 1, `${maintenancePatches().length} PATCH after accepting (expected 1)`);
    check("accepted-on-is-stored", (await storedMode()) === true && label === "Maintenance mode: ON", `stored maintenanceMode: ${await storedMode()}, label ${JSON.stringify(label)}`);
    const afterOn = await storedChanges();
    check("the-reason-is-recorded-with-the-change", afterOn.length === 1 && afterOn[0].reason === REASON_ON && afterOn[0].summary === "Set maintenance mode on" && afterOn[0].byEmail === SUPER_EMAIL, `history: ${JSON.stringify(afterOn.map((c) => [c.summary, c.reason]))}`);
    check("the-scope-bar-says-maintenance-is-on", scopeChip === true, `scope bar maintenance chip shown: ${scopeChip}`);

    // ─── 3. Turning it off asks too, and names the effect ────────────
    page.clearRequests();
    await page.evaluate(`document.getElementById("maintenanceToggle").click(); true`);
    await sleep(600);
    const offAsked = await dialog();
    check("asks-before-turning-off", offAsked?.open === true && /full access again/.test(offAsked.text) && offAsked.fields.length === 1, `dialog: ${JSON.stringify(offAsked?.text || null)}, fields ${JSON.stringify(offAsked?.fields || [])}`);
    await type(0, "Upgrade finished (local drive)");
    await press("Turn off maintenance");
    await sleep(2000);
    check("accepted-off-is-stored", maintenancePatches().length === 1 && (await storedMode()) === false, `${maintenancePatches().length} PATCH; stored maintenanceMode: ${await storedMode()}`);
    const history = await page.evaluate(`[...document.querySelectorAll("#controlChangesList .control-change__why")].map((n) => n.textContent.trim())`);
    check("the-panel-lists-the-changes-with-their-reasons", Array.isArray(history) && history[0] === "Upgrade finished (local drive)" && history[1] === REASON_ON, `listed: ${JSON.stringify(history)}`);
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
  console.log("MAINTENANCE SWITCH DRIVE OK");
}
