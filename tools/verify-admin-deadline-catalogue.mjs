// tools/verify-admin-deadline-catalogue.mjs
//
// W10 AP40. Drives the REAL super-admin panel in a REAL browser against a LOCAL backend and a scratch
// database, to see the deadline catalogue card do what a person would do with it: add a row, fill the
// statutory date and the extension apart, be asked why, decline (nothing sent), publish (one request),
// see it again after a reload with the days unchanged, be told what is wrong with a bad row, and be told
// when someone else published first.
//
// The same safety shape as tools/drive-local-panel.mjs, which it is modelled on: the API base and the
// database must be loopback, the database name must carry the scratch marker, the outbound provider keys
// are blanked in this process, and the scratch database is dropped at the end. There is no way to point
// this at api.caprotoolkit.in.
//
//   node tools/verify-admin-deadline-catalogue.mjs            headless
//   node tools/verify-admin-deadline-catalogue.mjs --show     watch it
import { withBrowser } from "./browser-drive.mjs";

const SCRATCH_MARKER = "capro-deadline-panel-drive";
const MONGO_URI = `mongodb://127.0.0.1:27117/${SCRATCH_MARKER}`;
const SUPER_EMAIL = "saifullahfaizan786@gmail.com";
const SHOW = process.argv.includes("--show");

process.env.NODE_ENV = "development";
process.env.JWT_SECRET = "deadline-panel-drive-only-not-a-real-secret";
process.env.MONGODB_URI = MONGO_URI;
for (const outbound of ["RESEND_API_KEY", "DEEPSEEK_API_KEY", "OCR_SPACE_API_KEY", "HOSTINGER_API_TOKEN"]) process.env[outbound] = "";

const host = /^mongodb:\/\/([^/:]+)/.exec(MONGO_URI)?.[1];
if (host !== "127.0.0.1" || !MONGO_URI.includes(SCRATCH_MARKER)) throw new Error("the database must be loopback and scratch-named - refusing to run");

const mongoose = (await import("mongoose")).default;
const jwt = (await import("jsonwebtoken")).default;
const { default: app } = await import("../src/app.js");
const { default: User } = await import("../src/models/User.js");
const { default: AppConfig } = await import("../src/models/AppConfig.js");

let pass = 0;
let fail = 0;
const failures = [];
function check(id, ok, detail) {
  if (ok) { pass += 1; console.log(`  PASS ${id}  ${detail}`); } else { fail += 1; failures.push(id); console.log(`  FAIL ${id}  ${detail}`); }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://localhost:${server.address().port}`;
const panelUrl = `${base}/admin/super.html`;
console.log("deadline catalogue: the real panel against a local backend");
console.log(`  api   ${base}`);
console.log(`  mongo ${MONGO_URI}\n`);

try {
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  await mongoose.connection.dropDatabase();
  const superUser = await User.create({ email: SUPER_EMAIL, name: "Local Drive Super Admin", role: "SUPER_ADMIN", accountType: "INDIVIDUAL" });
  await AppConfig.create({ _id: "singleton" });
  const superToken = jwt.sign({ id: String(superUser._id), email: superUser.email, role: superUser.role, accountType: superUser.accountType, firmId: null, isActive: true, tv: 0 }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const publicCatalogue = async () => (await (await fetch(`${base}/api/app-config`)).json())?.config?.deadlineCatalogue ?? null;

  check("seed-nothing-published", (await publicCatalogue()) === null, "GET /api/app-config -> deadlineCatalogue is null before anything is published");

  await withBrowser(async (page) => {
    await page.goto(panelUrl, { waitMs: 1200 });
    await page.evaluate(`localStorage.setItem("caproadminjwt", ${JSON.stringify(superToken)}); true`);
    await page.goto(`${panelUrl}#controls`, { waitMs: 2500 });
    for (let waited = 0; waited < 6000; waited += 200) {
      if (await page.evaluate(`document.getElementById("deadlineSet") && !document.getElementById("deadlineSet").disabled`)) break;
      await sleep(200);
    }

    const opened = JSON.parse(await page.evaluate(`JSON.stringify({
      ready: !!document.getElementById("deadlineSet") && !document.getElementById("deadlineSet").disabled,
      rows: document.querySelectorAll("#deadlineRows .deadline-row").length,
      note: (document.getElementById("deadlineVersion")||{}).textContent || ""
    })`));
    check("card-opens-empty-and-says-so", opened.ready && opened.rows === 0 && /No calendar has been published/.test(opened.note), `ready ${opened.ready}, ${opened.rows} row(s), note ${JSON.stringify(opened.note.slice(0, 70))}`);

    const dialog = async () => JSON.parse(await page.evaluate(`JSON.stringify((() => {
      const d = document.querySelector("dialog.cp-dialog");
      if (!d) return null;
      const confirm = [...d.querySelectorAll(".cp-dialog__footer button")].find((b) => b.textContent === "Publish the calendar");
      return { title: d.querySelector(".cp-dialog__title")?.textContent || "", inputs: d.querySelectorAll("input.cp-input, textarea.cp-input").length, confirmDisabled: confirm ? confirm.disabled : null };
    })())`));
    const press = (label) => page.evaluate(`(() => { const b = [...document.querySelectorAll("dialog.cp-dialog .cp-dialog__footer button")].find((x) => x.textContent === ${JSON.stringify(label)}); if (b) b.click(); return !!b; })()`);
    const fill = (field, value) => page.evaluate(`(() => { const el = document.querySelector('#deadlineRows .deadline-row:last-child [data-field="${field}"]'); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return el.value; })()`);

    await page.evaluate(`document.getElementById("deadlineAddBtn").click(); true`);
    await sleep(200);
    await fill("formKey", "ITR");
    await fill("label", "Income tax return");
    await fill("financialYear", "2025-26");
    await fill("statutoryDate", "2026-07-31");
    await fill("extendedDate", "2026-09-15");
    await fill("extensionReference", "Circular 12/2026");
    const typedDate = await page.evaluate(`document.querySelector('#deadlineRows .deadline-row:last-child [data-field="statutoryDate"]').value`);
    check("a-date-is-kept-as-the-day-typed", typedDate === "2026-07-31", `the statutory date input holds ${JSON.stringify(typedDate)}`);

    page.clearRequests();
    await page.evaluate(`document.getElementById("deadlinePublishBtn").click(); true`);
    await sleep(800);
    const asked = await dialog();
    check("publish-asks-why-and-for-the-environment-word", asked !== null && /Publish 1 date\?/.test(asked.title) && asked.inputs === 2 && asked.confirmDisabled === true, `dialog ${JSON.stringify(asked)}`);
    await press("Keep the current calendar");
    await sleep(800);
    const declined = page.requests().filter((r) => r.method === "PATCH" && /deadline-catalogue/.test(r.url));
    check("declining-sends-nothing", declined.length === 0 && (await publicCatalogue()) === null, `${declined.length} PATCH request(s) after declining (want 0); catalogue still null`);

    page.clearRequests();
    await page.evaluate(`document.getElementById("deadlinePublishBtn").click(); true`);
    await sleep(800);
    await page.evaluate(`(() => {
      const [reason, typed] = document.querySelectorAll("dialog.cp-dialog .cp-input");
      reason.value = "Circular 12/2026 extends the ITR date"; reason.dispatchEvent(new Event("input", { bubbles: true }));
      typed.value = "local"; typed.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    await sleep(200);
    await press("Publish the calendar");
    await sleep(2500);
    const patches = page.requests().filter((r) => r.method === "PATCH" && /deadline-catalogue/.test(r.url));
    const status = (await page.evaluate(`(document.getElementById("deadlineStatus")||{}).textContent || ""`)).trim();
    check("publish-sends-one-request-and-says-so", patches.length === 1 && /Published version 1/.test(status), `${patches.length} PATCH; status ${JSON.stringify(status)}`);

    const stored = await publicCatalogue();
    const itr = stored?.entries?.[0];
    check("the-statutory-date-and-the-extension-are-stored-apart", itr?.statutoryDate === "2026-07-31" && itr?.extendedDate === "2026-09-15" && itr?.effectiveDate === "2026-09-15" && itr?.extensionReference === "Circular 12/2026", `stored ${JSON.stringify(itr)}`);

    await page.goto(`${panelUrl}#controls`, { waitMs: 2500 });
    for (let waited = 0; waited < 6000; waited += 200) {
      if (await page.evaluate(`document.getElementById("deadlineSet") && !document.getElementById("deadlineSet").disabled`)) break;
      await sleep(200);
    }
    const reloaded = JSON.parse(await page.evaluate(`JSON.stringify([...document.querySelectorAll("#deadlineRows .deadline-row")].map((row) => ({ statutory: row.querySelector('[data-field="statutoryDate"]').value, extended: row.querySelector('[data-field="extendedDate"]').value, form: row.querySelector('[data-field="formKey"]').value })))`));
    check("after-a-reload-the-days-are-the-same-days", reloaded.length === 1 && reloaded[0].statutory === "2026-07-31" && reloaded[0].extended === "2026-09-15" && reloaded[0].form === "ITR", `rows ${JSON.stringify(reloaded)}`);

    // A bad row: the browser's date input gives "" for a day that does not exist, so the server's own message is what the person reads.
    await fill("statutoryDate", "");
    await page.evaluate(`document.getElementById("deadlinePublishBtn").click(); true`);
    await sleep(800);
    await page.evaluate(`(() => {
      const [reason, typed] = document.querySelectorAll("dialog.cp-dialog .cp-input");
      reason.value = "Trying a bad row"; reason.dispatchEvent(new Event("input", { bubbles: true }));
      typed.value = "local"; typed.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    await sleep(200);
    await press("Publish the calendar");
    await sleep(2000);
    const badStatus = (await page.evaluate(`(document.getElementById("deadlineStatus")||{}).textContent || ""`)).trim();
    check("a-bad-row-is-named-and-nothing-is-stored", /Row 1: The statutory date is required/.test(badStatus) && (await publicCatalogue())?.version === 1, `status ${JSON.stringify(badStatus.slice(0, 160))}; stored version ${(await publicCatalogue())?.version}`);

    // Someone else publishes first: the panel's copy is now stale.
    const rival = await fetch(`${base}/api/app-config/deadline-catalogue`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${superToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ entries: [{ formKey: "AGM", label: "Annual general meeting", clientType: "ALL", financialYear: "2025-26", statutoryDate: "2026-09-30" }], reason: "A second publisher", expectedVersion: 1 }),
    });
    await fill("statutoryDate", "2026-07-31");
    await page.evaluate(`document.getElementById("deadlinePublishBtn").click(); true`);
    await sleep(800);
    await page.evaluate(`(() => {
      const [reason, typed] = document.querySelectorAll("dialog.cp-dialog .cp-input");
      reason.value = "From a stale copy"; reason.dispatchEvent(new Event("input", { bubbles: true }));
      typed.value = "local"; typed.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    await sleep(200);
    await press("Publish the calendar");
    await sleep(2000);
    const staleStatus = (await page.evaluate(`(document.getElementById("deadlineStatus")||{}).textContent || ""`)).trim();
    check("a-stale-copy-is-refused-and-the-newer-calendar-stays", rival.status === 200 && /published by someone else/.test(staleStatus) && (await publicCatalogue())?.entries?.[0]?.formKey === "AGM", `rival ${rival.status}; status ${JSON.stringify(staleStatus.slice(0, 110))}; stored first form ${(await publicCatalogue())?.entries?.[0]?.formKey}`);
  }, { headless: !SHOW });
} finally {
  try { if (mongoose.connection.readyState === 1) { await mongoose.connection.dropDatabase(); console.log(`  scratch database ${SCRATCH_MARKER} dropped`); } } catch (error) { console.log(`  WARNING could not drop the scratch database: ${error.message}`); }
  try { await mongoose.disconnect(); } catch { /* already closed */ }
  await new Promise((resolve) => server.close(resolve));
}

console.log(`\npassed: ${pass}  failed: ${fail}`);
if (fail > 0) {
  console.log(`failing checks: ${failures.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log("DEADLINE CATALOGUE PANEL DRIVE OK");
}
