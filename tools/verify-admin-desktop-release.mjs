// tools/verify-admin-desktop-release.mjs
//
// Drives the REAL super-admin panel in a REAL browser to settle the U5 gates that were recorded as
// owner-manual on the grounds that "no browser exists in the agent environment".
//
// WHY THIS EXISTS
// ---------------
// U5's remaining Verify bullets are about a rendered page: that the Desktop Release card appears
// below Welcome Announcement, that its readout matches the API, and -- the two that actually matter
// -- that DECLINING either confirmation issues **zero network requests**. "Zero requests" is not
// something source reading can establish; it needs a browser and a request log. So those bullets
// sat unattempted, not un-runnable: `tools/browser-drive.mjs` (a dependency-free CDP driver) was
// already committed for exactly this purpose and nothing had ever imported it.
//
// WHAT THIS DELIBERATELY DOES NOT DO
// ----------------------------------
// It never drives the notify to completion. `super.js` only POSTs
// `/app-config/desktop-release/notify` when the typed string matches the version EXACTLY, and that
// call alerts every desktop user -- an external communication, and irreversible. Both gates here are
// the REFUSAL paths, which is what the gate text asks for. There is no code path in this file that
// can send a notification.
//
// HOW THE HUMAN ANSWER IS SUPPLIED, stated plainly so nobody has to guess whether this is a real test
// -----------------------------------------------------------------------------------------------
// The panel asks the operator through `window.confirm` and `window.prompt`. This script replaces
// those two browser primitives with stubs returning the answer a tester would give, then lets the
// panel's own code run untouched. What is under test is the panel's branch logic and its decision to
// issue or not issue a request -- `if (!window.confirm(msg)) return;` and
// `if (typed !== version) { ...; return; }` -- both of which execute for real. The stub stands in for
// the human's keystroke, nothing else. It also records that each dialog was actually opened and with
// what message, so a panel that silently skipped its own confirmation would fail rather than pass.
//
// USAGE
//   CAPRO_ADMIN_TOKEN=<super-admin jwt> node tools/verify-admin-desktop-release.mjs
// The token is read from the environment or from CAPRO_SUPER_ADMIN_JWT in .env; it is never printed.
import { withBrowser } from "./browser-drive.mjs";
import { readFileSync, existsSync } from "node:fs";

const API_BASE = process.env.CAPRO_API_BASE || "https://api.caprotoolkit.in";
const PANEL_URL = `${API_BASE}/admin/super.html`;
const NOTIFY_PATH = "/app-config/desktop-release/notify";

function readToken() {
  if (process.env.CAPRO_ADMIN_TOKEN) return process.env.CAPRO_ADMIN_TOKEN.trim();
  const envPath = new URL("../.env", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = /^CAPRO_SUPER_ADMIN_JWT=(.*)$/.exec(line);
      if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    }
  }
  throw new Error("No admin token. Set CAPRO_ADMIN_TOKEN or CAPRO_SUPER_ADMIN_JWT in .env.");
}

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

const token = readToken();

// The live truth to compare the panel's readout against. Fetched independently of the browser so a
// panel reading its own cache would not agree with it by construction.
const liveConfig = await (await fetch(`${API_BASE}/api/app-config`)).json();
const liveRelease = liveConfig?.config?.desktopRelease || null;
console.log(`live desktopRelease.latestVersion: ${liveRelease?.latestVersion ?? "(none)"}`);
console.log("");

await withBrowser(async (page) => {
  // localStorage is origin-scoped, so the origin has to be loaded before the token can be planted.
  await page.goto(PANEL_URL, { waitMs: 1500 });
  await page.evaluate(`localStorage.setItem("caproadminjwt", ${JSON.stringify(token)}); true`);
  await page.goto(PANEL_URL, { waitMs: 4000 });

  console.log("=== bullet 1: the card renders, below Welcome Announcement, matching the API ===");

  const layout = await page.evaluate(`(() => {
    const notify = document.getElementById("notifyDesktopReleaseBtn");
    const live = document.getElementById("desktopReleaseLive");
    const version = document.getElementById("desktopLatestVersion");
    const headings = Array.from(document.querySelectorAll("h6"));
    const welcome = headings.find(h => /Welcome Announcement/i.test(h.textContent || ""));
    const desktop = headings.find(h => /Desktop release/i.test(h.textContent || ""));
    const top = el => el ? el.getBoundingClientRect().top + window.scrollY : null;
    return {
      hasNotify: !!notify,
      notifyLabel: notify ? (notify.textContent || "").trim() : null,
      hasLiveReadout: !!live,
      liveText: live ? (live.textContent || "").trim() : null,
      versionValue: version ? version.value : null,
      welcomeTop: top(welcome),
      desktopTop: top(desktop),
      welcomeFound: !!welcome,
      desktopFound: !!desktop,
    };
  })()`);

  check("U5-card-present", layout.hasNotify && layout.hasLiveReadout,
    `Notify button ${layout.hasNotify ? "present" : "MISSING"} (label ${JSON.stringify(layout.notifyLabel)}), live readout ${layout.hasLiveReadout ? "present" : "MISSING"}`);
  check("U5-card-below-welcome",
    layout.welcomeFound && layout.desktopFound && layout.desktopTop > layout.welcomeTop,
    `Welcome Announcement at y=${layout.welcomeTop}, Desktop release at y=${layout.desktopTop} - the gate asks for the desktop card BELOW the welcome card`);
  check("U5-readout-matches-api",
    liveRelease?.latestVersion ? String(layout.liveText || "").includes(liveRelease.latestVersion) : true,
    liveRelease?.latestVersion
      ? `readout ${JSON.stringify(String(layout.liveText || "").slice(0, 120))} contains the live latestVersion ${liveRelease.latestVersion}`
      : "no release announced live, so there is no version for the readout to contradict");
  check("U5-form-version-matches-api",
    liveRelease?.latestVersion ? layout.versionValue === liveRelease.latestVersion : true,
    `form field ${JSON.stringify(layout.versionValue)} vs live ${JSON.stringify(liveRelease?.latestVersion ?? null)}`);

  console.log("");
  console.log("=== bullet 2, gate 1: DECLINING the first confirm issues zero requests ===");

  // Stub the dialogs and record that they were opened. A panel that never asked would leave
  // dialogs.confirm empty, and the assertion below would fail rather than silently pass.
  await page.evaluate(`(() => {
    window.__dialogs = { confirm: [], prompt: [] };
    window.confirm = (msg) => { window.__dialogs.confirm.push(String(msg)); return window.__confirmAnswer; };
    window.prompt = (msg) => { window.__dialogs.prompt.push(String(msg)); return window.__promptAnswer; };
    return true;
  })()`);

  await page.evaluate(`window.__confirmAnswer = false; window.__promptAnswer = null; true`);
  page.clearRequests();
  await page.evaluate(`document.getElementById("notifyDesktopReleaseBtn").click(); true`);
  await new Promise((r) => setTimeout(r, 1500));

  const afterDecline = page.requests();
  const declineDialogs = await page.evaluate(`JSON.stringify(window.__dialogs)`);
  const declineParsed = JSON.parse(declineDialogs);
  const declineNotify = afterDecline.filter((r) => r.url.includes(NOTIFY_PATH));
  const declinePosts = afterDecline.filter((r) => r.method === "POST");

  check("U5-decline-asked-first", declineParsed.confirm.length === 1,
    `the panel opened ${declineParsed.confirm.length} confirm dialog(s); message: ${JSON.stringify((declineParsed.confirm[0] || "").slice(0, 90))}`);
  check("U5-decline-zero-notify-requests", declineNotify.length === 0,
    `${declineNotify.length} request(s) to ${NOTIFY_PATH} after declining (want 0)`);
  check("U5-decline-zero-posts", declinePosts.length === 0,
    `${declinePosts.length} POST request(s) of any kind after declining (want 0); total requests observed: ${afterDecline.length}`);
  check("U5-decline-no-prompt", declineParsed.prompt.length === 0,
    `declining the first confirm must not reach the typed confirmation; prompts opened: ${declineParsed.prompt.length}`);

  console.log("");
  console.log("=== bullet 2, gate 2: accepting, then typing the WRONG version, issues zero requests ===");

  const realVersion = layout.versionValue || liveRelease?.latestVersion || "0.0.0";
  const wrongVersion = `${realVersion}-not-the-version`;

  await page.evaluate(`window.__dialogs = { confirm: [], prompt: [] }; window.__confirmAnswer = true; window.__promptAnswer = ${JSON.stringify(wrongVersion)}; true`);
  page.clearRequests();
  await page.evaluate(`document.getElementById("notifyDesktopReleaseBtn").click(); true`);
  await new Promise((r) => setTimeout(r, 1500));

  const afterWrong = page.requests();
  const wrongParsed = JSON.parse(await page.evaluate(`JSON.stringify(window.__dialogs)`));
  const wrongNotify = afterWrong.filter((r) => r.url.includes(NOTIFY_PATH));
  const wrongPosts = afterWrong.filter((r) => r.method === "POST");
  const statusText = await page.evaluate(`(document.getElementById("desktopReleaseStatus")||{}).textContent || ""`);

  check("U5-wrong-reached-typed-confirm", wrongParsed.prompt.length === 1,
    `accepting the first confirm reached the typed confirmation; prompts opened: ${wrongParsed.prompt.length}, message ${JSON.stringify((wrongParsed.prompt[0] || "").slice(0, 90))}`);
  check("U5-wrong-zero-notify-requests", wrongNotify.length === 0,
    `${wrongNotify.length} request(s) to ${NOTIFY_PATH} after a mistyped version (want 0)`);
  check("U5-wrong-zero-posts", wrongPosts.length === 0,
    `${wrongPosts.length} POST request(s) of any kind after a mistyped version (want 0); total requests observed: ${afterWrong.length}`);
  check("U5-wrong-says-cancelled", /cancel/i.test(statusText) && /match/i.test(statusText),
    `status line reads ${JSON.stringify(statusText.trim().slice(0, 120))}`);

  console.log("");
  console.log("=== bullet 5: invalid input surfaces the server's own message, and writes nothing ===");

  // Safe by construction, not by hope. `updateDesktopRelease` calls the pure
  // `validateDesktopReleasePatch` and does `if (!result.ok) return res.status(...)` BEFORE touching
  // the document, and the download-URL check is an exact-hostname allow-list. So this PATCH cannot
  // reach a write. That is asserted rather than trusted: the live release is read before and after
  // and compared field by field.
  const beforeSave = JSON.stringify(
    (await (await fetch(`${API_BASE}/api/app-config`)).json())?.config?.desktopRelease ?? null,
  );

  page.clearRequests();
  await page.evaluate(`(() => {
    document.getElementById("desktopDownloadUrl").value = "https://evil.com/x.exe";
    document.getElementById("saveDesktopReleaseBtn").click();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 2500));

  const invalidStatus = await page.evaluate(`(document.getElementById("desktopReleaseStatus")||{}).textContent || ""`);
  const afterSave = JSON.stringify(
    (await (await fetch(`${API_BASE}/api/app-config`)).json())?.config?.desktopRelease ?? null,
  );

  check("U5-invalid-names-allowed-host", /caprotoolkit\.in/i.test(invalidStatus),
    `status line reads ${JSON.stringify(invalidStatus.trim().slice(0, 150))} - it must name the allowed host, not show a stack`);
  check("U5-invalid-no-stack", !/\bat \w|Error:|undefined|\[object/i.test(invalidStatus),
    `status line carries no raw error shape: ${JSON.stringify(invalidStatus.trim().slice(0, 90))}`);
  check("U5-invalid-wrote-nothing", beforeSave === afterSave,
    `live desktopRelease is byte-identical before and after the refused save (${beforeSave.length} chars both) - the refusal happened before any write`);

  console.log("");
  console.log("=== R9 bullet 1: the 19 feature-flag checkboxes match the live API ===");

  const liveFlags = liveConfig?.config?.featureFlags || {};
  const flagState = await page.evaluate(`(() => {
    // super.js:119 -- featureFlagCheckbox(key) resolves the id \`flag-\${key}\`.
    const boxes = Array.from(document.querySelectorAll('input[type="checkbox"]'))
      .filter(b => b.id && b.id.startsWith("flag-"));
    const out = {};
    for (const b of boxes) out[b.id.slice("flag-".length)] = { checked: b.checked, disabled: b.disabled };
    return out;
  })()`);

  const flagKeys = Object.keys(flagState);
  const liveKeys = Object.keys(liveFlags);
  const mismatched = liveKeys.filter((k) => flagState[k] && flagState[k].checked !== liveFlags[k]);
  const missing = liveKeys.filter((k) => !(k in flagState));
  const disabled = flagKeys.filter((k) => flagState[k].disabled);

  check("R9-nineteen-checkboxes", flagKeys.length === liveKeys.length && liveKeys.length === 19,
    `panel rendered ${flagKeys.length} feature-flag checkboxes; live API serves ${liveKeys.length} keys`);
  check("R9-no-missing-keys", missing.length === 0,
    missing.length === 0 ? "every live key has a checkbox on screen" : `absent from the panel: ${missing.join(", ")}`);
  // Checked BEFORE trusting the checked states: super.js:146 disables every box when the load fails,
  // precisely because "every feature is off" and "nothing loaded" look identical in a grid of
  // unchecked boxes. If any box is disabled, the states below are not the real state.
  check("R9-card-actually-loaded", disabled.length === 0,
    disabled.length === 0
      ? "no checkbox is disabled, so the card loaded its state rather than failing silently"
      : `${disabled.length} checkbox(es) disabled - the card reports a FAILED load, so its checked states are not the real state: ${disabled.join(", ")}`);
  check("R9-checked-state-matches-api", mismatched.length === 0,
    mismatched.length === 0
      ? `all ${liveKeys.length} checked states equal the live values (${liveKeys.filter(k => liveFlags[k]).length} on, ${liveKeys.filter(k => !liveFlags[k]).length} off)`
      : `disagree with the API: ${mismatched.map(k => `${k} screen=${flagState[k].checked} api=${liveFlags[k]}`).join("; ")}`);

  // A control for the comparison above: if every flag happened to be false and the panel rendered
  // every box unchecked, the match would be trivially true and would prove nothing about wiring.
  check("R9-comparison-is-discriminating",
    liveKeys.some((k) => liveFlags[k]) && liveKeys.some((k) => !liveFlags[k]),
    `the live flag set is mixed (${liveKeys.filter(k => liveFlags[k]).length} on / ${liveKeys.filter(k => !liveFlags[k]).length} off), so an all-unchecked render could not have passed`);

  // A control, so "zero requests" cannot be a false negative from a dead button or a broken driver.
  // The click handler must be live and the request log must be capable of recording a request.
  console.log("");
  console.log("=== control: the request log and the button are both actually working ===");
  // Deliberately a POST, because every assertion above counts POSTs. A GET-only control would leave
  // "0 POST requests" resting on an untested code path in the driver. Aimed at a route that certainly
  // does not exist, so it is counted and refused rather than doing anything.
  page.clearRequests();
  await page.evaluate(`fetch("${API_BASE}/api/auth/definitely-not-a-real-route-xyz", { method: "POST" }).then(()=>{}).catch(()=>{}); true`);
  await new Promise((r) => setTimeout(r, 1500));
  const controlAll = page.requests();
  const controlPosts = controlAll.filter((r) => r.method === "POST");
  check("U5-control-log-records-posts", controlPosts.length >= 1,
    `${controlPosts.length} POST request(s) recorded for a deliberately-issued POST - proves the "0 POST" counts above are real observations from a working log, not a blind one`);
  check("U5-control-button-live", (wrongParsed.confirm.length + declineParsed.confirm.length) === 2,
    `the Notify button's handler fired on both clicks (${declineParsed.confirm.length + wrongParsed.confirm.length} confirms across 2 clicks) - proves "zero requests" came from the refusal branch, not from a dead button`);
}, { headless: true });

console.log("");
console.log(`=== admin desktop-release panel: ${pass} passed, ${fail} failed ===`);
if (failures.length) console.log(`  failed: ${failures.join(", ")}`);
process.exit(fail === 0 ? 0 : 1);
