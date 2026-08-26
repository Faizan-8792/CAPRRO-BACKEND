// tools/verify-admin-provider-usage.mjs
//
// Settles O10's last open half: "the admin panel's Provider usage card LOADS".
//
// WHY THIS EXISTS
// ---------------
// O10 (meter and cap paid provider spend) was left `Blocked on: OWNER` for one reason, quoted from
// its own block: the sixth bullet's remaining half needs "a signed-in super-admin browser session".
// Its own note is precise about what was and was not proved -- "The data behind that card is already
// proved ... What is unproven is the rendering, not the numbers." Rendering is exactly what a browser
// establishes, and there is a browser on this machine plus a committed CDP driver
// (`tools/browser-drive.mjs`) that nothing had ever imported.
//
// This is READ-ONLY. It loads a page and reads the DOM. There is no write path in this file.
//
// The card is worth proving rather than assuming, because a spend cap whose dashboard silently shows
// nothing is how an owner discovers a runaway bill from the invoice instead of from the panel.
//
// USAGE
//   CAPRO_ADMIN_TOKEN=<super-admin jwt> node tools/verify-admin-provider-usage.mjs
// The token is read from the environment or from CAPRO_SUPER_ADMIN_JWT in .env; it is never printed.
import { withBrowser } from "./browser-drive.mjs";
import { readFileSync, existsSync } from "node:fs";

const API_BASE = process.env.CAPRO_API_BASE || "https://api.caprotoolkit.in";
const PANEL_URL = `${API_BASE}/admin/super.html`;

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
  if (ok) { pass += 1; console.log(`  PASS ${id}  ${detail}`); }
  else { fail += 1; failures.push(id); console.log(`  FAIL ${id}  ${detail}`); }
}

const token = readToken();

// The API truth, fetched independently of the browser, so a card rendering its own placeholder
// cannot agree with it by construction.
const apiRes = await fetch(`${API_BASE}/api/super/provider-usage`, {
  headers: { Authorization: `Bearer ${token}` },
});
const apiJson = await apiRes.json().catch(() => null);
console.log(`GET /api/super/provider-usage -> ${apiRes.status}`);
console.log("");

await withBrowser(async (page) => {
  await page.goto(PANEL_URL, { waitMs: 1500 });
  await page.evaluate(`localStorage.setItem("caproadminjwt", ${JSON.stringify(token)}); true`);
  await page.goto(PANEL_URL, { waitMs: 5000 });

  console.log("=== O10 bullet 6: the Provider usage card loads and renders the real numbers ===");

  const card = await page.evaluate(`(() => {
    const status = document.getElementById("providerUsageStatus");
    const grid = document.getElementById("providerUsageGrid");
    const heads = Array.from(document.querySelectorAll("h6"));
    const heading = heads.find(h => /Provider Usage/i.test(h.textContent || ""));
    return {
      headingPresent: !!heading,
      statusText: status ? (status.textContent || "").trim() : null,
      gridChildren: grid ? grid.children.length : -1,
      gridText: grid ? (grid.textContent || "").replace(/\\s+/g, " ").trim() : null,
    };
  })()`);

  check("O10-card-present", card.headingPresent && card.gridChildren >= 0,
    `heading ${card.headingPresent ? "present" : "MISSING"}, grid container ${card.gridChildren >= 0 ? "present" : "MISSING"}`);

  // "Loading..." is the card's initial literal (super.html:302). Still showing it means the fetch
  // never resolved, which is the failure this bullet exists to catch - and it is exactly what a
  // source-reading pass cannot distinguish from success.
  check("O10-card-finished-loading",
    card.statusText !== null && !/^Loading\.\.\.$/.test(card.statusText),
    `status line reads ${JSON.stringify(card.statusText)} - still showing the initial "Loading..." literal would mean the card never resolved`);

  check("O10-card-not-errored",
    !/fail|error|could not/i.test(card.statusText || ""),
    `status line carries no failure wording: ${JSON.stringify(card.statusText)}`);

  check("O10-grid-rendered", card.gridChildren > 0,
    `the usage grid rendered ${card.gridChildren} child element(s) - an empty grid is the silent-dashboard failure`);

  // Both providers the service meters must appear by label, not just one.
  const hasDeepseek = /DeepSeek/i.test(card.gridText || "");
  const hasOcr = /OCR\.space/i.test(card.gridText || "");
  check("O10-both-providers-shown", hasDeepseek && hasOcr,
    `DeepSeek ${hasDeepseek ? "shown" : "MISSING"}, OCR.space ${hasOcr ? "shown" : "MISSING"}`);

  // The rendered numbers must be the API's numbers, read STRUCTURALLY rather than by searching the
  // card's text for a digit. Both of today's counts are legitimately 0 right now, and "0" appears all
  // over a page; a substring search would pass on a card that rendered nothing meaningful. So each
  // provider column is walked and its two labelled figures extracted, then compared to the exact
  // API values. Shape (super.js:660-682): #providerUsageGrid > .col-md-6, an h6 label, then a
  // .d-flex holding two divs, each a value followed by its caption.
  const cells = await page.evaluate(`(() => {
    return Array.from(document.querySelectorAll("#providerUsageGrid > div")).map(col => {
      const label = (col.querySelector("h6")?.textContent || "").trim();
      const figures = Array.from(col.querySelectorAll(".d-flex > div")).map(d => ({
        value: (d.children[0]?.textContent || "").trim(),
        caption: (d.children[1]?.textContent || "").trim(),
      }));
      return { label, figures };
    });
  })()`);

  const LABEL_TO_KEY = { "DeepSeek": "DEEPSEEK", "OCR.space": "OCR_SPACE" };
  if (apiRes.ok && apiJson?.usage) {
    const results = [];
    let allMatch = cells.length === 2;
    for (const cell of cells) {
      const key = LABEL_TO_KEY[cell.label];
      if (!key) { allMatch = false; results.push(`unrecognised card label ${JSON.stringify(cell.label)}`); continue; }
      const apiToday = Number(apiJson.usage.today?.[key] ?? 0);
      const apiMonth = Number(apiJson.usage.thisMonth?.[key] ?? 0);
      const shownToday = cell.figures.find(f => /today/i.test(f.caption))?.value;
      const shownMonth = cell.figures.find(f => /month/i.test(f.caption))?.value;
      const ok = String(apiToday) === shownToday && String(apiMonth) === shownMonth;
      if (!ok) allMatch = false;
      results.push(`${cell.label}: today screen=${shownToday} api=${apiToday}, month screen=${shownMonth} api=${apiMonth}${ok ? "" : "  <-- MISMATCH"}`);
    }
    check("O10-numbers-match-api", allMatch, results.join(" | "));

    // A card that renders every figure as 0 would match an all-zero API by accident. Say whether the
    // comparison had anything non-zero to bite on, so the pass above can be weighed honestly.
    const nonZero = Object.values(apiJson.usage.thisMonth || {}).some(v => Number(v) > 0);
    check("O10-comparison-had-a-nonzero-figure", nonZero,
      nonZero
        ? `this month's live counts are non-zero (${JSON.stringify(apiJson.usage.thisMonth)}), so the match above is discriminating rather than 0-equals-0`
        : `every live count is zero (${JSON.stringify(apiJson.usage)}), so the match above cannot distinguish a working card from one rendering zeroes - re-run after real provider traffic`);
  } else {
    check("O10-numbers-match-api", false,
      `could not compare: the API returned ${apiRes.status} or an unexpected shape`);
  }

  // Control: prove the DOM read is capable of seeing a change, so the passes above are observations
  // rather than a reader that always returns the same thing.
  console.log("");
  console.log("=== control: the DOM read is live ===");
  await page.evaluate(`document.getElementById("providerUsageStatus").textContent = "__control_sentinel__"; true`);
  const sentinel = await page.evaluate(`document.getElementById("providerUsageStatus").textContent`);
  check("O10-dom-read-is-live", sentinel === "__control_sentinel__",
    `wrote a sentinel into the status node and read it back as ${JSON.stringify(sentinel)} - so the reads above reflect the real DOM`);
}, { headless: true });

console.log("");
console.log(`=== admin provider-usage card: ${pass} passed, ${fail} failed ===`);
if (failures.length) console.log(`  failed: ${failures.join(", ")}`);
process.exit(fail === 0 ? 0 : 1);
