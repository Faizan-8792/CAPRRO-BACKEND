// tools/verify-admin-reminder-delivery-health.mjs
//
// T8 (.kiro/PLAN.md): "the admin panel actually renders" is exactly the kind of claim a source
// read cannot establish -- proving it needs a real browser reading the real DOM against the real
// deployed panel. Modelled directly on verify-admin-provider-usage.mjs's shape: fetch the API
// truth independently, drive the panel with the committed CDP driver, compare structurally.
//
// This is READ-ONLY. It loads a page and reads the DOM. There is no write path in this file.
//
// USAGE
//   CAPRO_ADMIN_TOKEN=<super-admin jwt> node tools/verify-admin-reminder-delivery-health.mjs
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

const apiRes = await fetch(`${API_BASE}/api/super/reminder-delivery-health`, {
  headers: { Authorization: `Bearer ${token}` },
});
const apiJson = await apiRes.json().catch(() => null);
console.log(`GET /api/super/reminder-delivery-health -> ${apiRes.status}`);
console.log("");

await withBrowser(async (page) => {
  await page.goto(PANEL_URL, { waitMs: 1500 });
  await page.evaluate(`localStorage.setItem("caproadminjwt", ${JSON.stringify(token)}); true`);
  await page.goto(PANEL_URL, { waitMs: 5000 });

  console.log("=== T2: the Reminder Delivery Health card loads and renders the real numbers ===");

  const card = await page.evaluate(`(() => {
    const status = document.getElementById("reminderDeliveryHealthStatus");
    const body = document.getElementById("reminderDeliveryHealthBody");
    const heads = Array.from(document.querySelectorAll("h6"));
    const heading = heads.find(h => /Reminder Delivery Health/i.test(h.textContent || ""));
    return {
      headingPresent: !!heading,
      statusText: status ? (status.textContent || "").trim() : null,
      bodyChildren: body ? body.children.length : -1,
      bodyText: body ? (body.textContent || "").replace(/\\s+/g, " ").trim() : null,
      bodyHtml: body ? body.innerHTML : null,
    };
  })()`);

  check("T2-card-present", card.headingPresent && card.bodyChildren >= 0,
    `heading ${card.headingPresent ? "present" : "MISSING"}, body container ${card.bodyChildren >= 0 ? "present" : "MISSING"}`);

  check("T2-card-finished-loading",
    card.statusText === "",
    `status line reads ${JSON.stringify(card.statusText)} -- the card clears it to empty string once loaded (super.js), so anything else (including the initial "Loading...") means the fetch never resolved`);

  check("T2-card-not-errored",
    !/fail|error|could not/i.test(card.statusText || ""),
    `status line carries no failure wording: ${JSON.stringify(card.statusText)}`);

  check("T2-body-rendered", card.bodyChildren > 0,
    `the body rendered ${card.bodyChildren} child element(s) -- an empty body is the silent-dashboard failure`);

  if (apiRes.ok && apiJson?.delivery) {
    const d = apiJson.delivery;
    const truncated = !!d.candidatesScanTruncated;
    const expectedCountText = truncated ? `${Number(d.issueCount) || 0}+` : String(Number(d.issueCount) || 0);

    // Read the rendered headline count STRUCTURALLY, matching super.js's own markup
    // (headline div > first child = count, second child = "N reminders with a delivery problem...").
    const headline = await page.evaluate(`(() => {
      const body = document.getElementById("reminderDeliveryHealthBody");
      const headlineDiv = body ? body.firstElementChild : null;
      if (!headlineDiv) return null;
      return {
        countText: (headlineDiv.children[0]?.textContent || "").trim(),
        captionText: (headlineDiv.children[1]?.textContent || "").trim(),
      };
    })()`);

    check("T2-headline-count-matches-api",
      headline?.countText === expectedCountText,
      `screen shows ${JSON.stringify(headline?.countText)}, API says ${JSON.stringify(expectedCountText)} (issueCount=${d.issueCount}, truncated=${truncated})`);

    // The live production fleet has a real, non-zero issueCount right now (a stale pre-Resend
    // Gmail SMTP failure), so this comparison is discriminating, not a 0-equals-0 coincidence.
    check("T2-comparison-had-a-nonzero-figure",
      Number(d.issueCount) > 0,
      Number(d.issueCount) > 0
        ? `live issueCount is ${d.issueCount} (non-zero), so the match above is discriminating`
        : `live issueCount is 0 -- this run cannot distinguish a working card from one rendering zeroes; re-run once a real delivery problem exists, or treat as a weaker pass`);

    // If the API returned a sample, the table must actually render a matching number of rows.
    const sample = Array.isArray(d.sample) ? d.sample : [];
    if (sample.length > 0) {
      const rowCount = await page.evaluate(`document.querySelectorAll("#reminderDeliveryHealthBody tbody tr").length`);
      check("T2-sample-row-count-matches-api",
        rowCount === sample.length,
        `screen renders ${rowCount} row(s), API sample has ${sample.length}`);

      // Cross-check one real field (the first row's status badge) against the API's first sample
      // row, so this is a genuine content check, not just a row-count coincidence.
      const firstRowStatus = await page.evaluate(`(() => {
        const cell = document.querySelector("#reminderDeliveryHealthBody tbody tr:first-child td:nth-child(5)");
        return cell ? (cell.textContent || "").trim() : null;
      })()`);
      check("T2-first-row-status-matches-api",
        firstRowStatus === sample[0].status,
        `screen shows status ${JSON.stringify(firstRowStatus)}, API's first sample row says ${JSON.stringify(sample[0].status)}`);
    } else {
      check("T2-sample-row-count-matches-api", true, "API sample is empty; nothing to render as rows -- vacuously satisfied");
    }
  } else {
    check("T2-headline-count-matches-api", false,
      `could not compare: the API returned ${apiRes.status} or an unexpected shape`);
  }

  console.log("");
  console.log("=== control: the DOM read is live ===");
  await page.evaluate(`document.getElementById("reminderDeliveryHealthStatus").textContent = "__control_sentinel__"; true`);
  const sentinel = await page.evaluate(`document.getElementById("reminderDeliveryHealthStatus").textContent`);
  check("T2-dom-read-is-live", sentinel === "__control_sentinel__",
    `wrote a sentinel into the status node and read it back as ${JSON.stringify(sentinel)} -- so the reads above reflect the real DOM`);
}, { headless: true });

console.log("");
console.log(`=== admin reminder-delivery-health card: ${pass} passed, ${fail} failed ===`);
if (failures.length) console.log(`  failed: ${failures.join(", ")}`);
process.exit(fail === 0 ? 0 : 1);
