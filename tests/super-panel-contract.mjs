// tests/super-panel-contract.mjs
//
// Why this exists. The super admin panel gained a sidebar router and sortable tables,
// and both shipped to production with defects nothing in the suite could see.
//
// The sorting bug is the reason this file exists. Every date in the panel is rendered
// with toLocaleDateString()/toLocaleString(), which follows the VIEWER's locale - so an
// Indian admin sees "11/8/2026" meaning 11 August. The sort key handed that string to
// Date.parse, which always reads a bare numeric date as American m/d/y, so it sorted as
// 8 November. Worse, "20/9/2026" is not a valid m/d/y date at all, so it was rejected
// and fell through to STRING sorting - putting two different orderings in one column.
// A statutory due-date column that sorts wrongly is a missed deadline, so this is
// checked against both field orders, not just the one the machine running CI happens
// to use.
//
// The markup checks exist because the sections were tagged by a regex script, which
// left two wrapper divs unclosed and wrote a second class attribute on seven sections
// (browsers keep the first and silently drop the second).
//
// Pure logic only - no database, no network, no browser.
//
// Run: node tests/super-panel-contract.mjs

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(here, "..", "public", "admin", "super.js");
const PANEL_HTML = join(here, "..", "public", "admin", "super.html");
const PANEL_CSS = join(here, "..", "public", "admin", "admin.css");

const superJs = readFileSync(PANEL_JS, "utf8");
const superHtml = readFileSync(PANEL_HTML, "utf8");
const adminCss = readFileSync(PANEL_CSS, "utf8");

const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass, detail });

// --- Load the sort key under a controllable locale ----------------
//
// The functions are plain declarations in a browser script, so they are lifted out
// and evaluated with Date.prototype.toLocaleDateString stubbed. That is the whole
// point: the key DETECTS the field order from that API, so the test has to control it.

const START = "const SUPER_DATE_FIELD_ORDER";
const END = "\nfunction superCompare";
const startIndex = superJs.indexOf(START);
const endIndex = superJs.indexOf(END);
check(
  "super.js exposes a date-order-aware sort key",
  startIndex >= 0 && endIndex > startIndex,
  startIndex >= 0 ? "found" : "SUPER_DATE_FIELD_ORDER missing"
);

const sortBlock =
  startIndex >= 0 && endIndex > startIndex ? superJs.slice(startIndex, endIndex) : "";

function loadSortKey(renderDate) {
  const original = Date.prototype.toLocaleDateString;
  Date.prototype.toLocaleDateString = function stub() {
    return renderDate(this);
  };
  try {
    return new Function(
      sortBlock + "; return { superSortKey, superDateValue, SUPER_DATE_FIELD_ORDER };"
    )();
  } finally {
    Date.prototype.toLocaleDateString = original;
  }
}

// Mirrors super.js's own comparator.
function compare(a, b, direction) {
  if (a.empty && b.empty) return 0;
  if (a.empty) return 1;
  if (b.empty) return -1;
  const factor = direction === "desc" ? -1 : 1;
  if (a.n !== null && b.n !== null) return (a.n - b.n) * factor;
  return a.s.localeCompare(b.s) * factor;
}

const pad = (value) => String(value).padStart(2, "0");

const LOCALES = [
  {
    name: "day-first (en-IN, en-GB - every Indian user of this product)",
    render: (d) => d.getDate() + "/" + (d.getMonth() + 1) + "/" + d.getFullYear(),
    expectedOrder: ["d", "m", "y"],
  },
  {
    name: "month-first (en-US)",
    render: (d) => d.getMonth() + 1 + "/" + d.getDate() + "/" + d.getFullYear(),
    expectedOrder: ["m", "d", "y"],
  },
  {
    name: "day-first, zero-padded",
    render: (d) => pad(d.getDate()) + "/" + pad(d.getMonth() + 1) + "/" + d.getFullYear(),
    expectedOrder: ["d", "m", "y"],
  },
];

for (const locale of LOCALES) {
  const loaded = loadSortKey(locale.render);
  const superSortKey = loaded.superSortKey;
  const detected = loaded.SUPER_DATE_FIELD_ORDER;

  check(
    locale.name + ": the field order is detected, not assumed",
    JSON.stringify(detected) === JSON.stringify(locale.expectedOrder),
    "detected [" + detected.join(",") + "]"
  );

  // The exact shape of the shipped bug: a day past the 12th cannot be read as a
  // month, and a day below it transposes silently.
  const chronological = [
    [2026, 8, 11],
    [2026, 9, 3],
    [2026, 9, 20],
    [2026, 12, 1],
  ].map((parts) => locale.render(new Date(parts[0], parts[1] - 1, parts[2])));

  const sorted = chronological
    .slice()
    .reverse()
    .sort((left, right) => compare(superSortKey(left), superSortKey(right), "asc"));

  check(
    locale.name + ": statutory dates sort chronologically",
    JSON.stringify(sorted) === JSON.stringify(chronological),
    sorted.join("  ")
  );

  check(
    locale.name + ": a day past the 12th is still read as a date, not string-sorted",
    superSortKey(locale.render(new Date(2026, 8, 20))).n !== null,
    "20 September parses"
  );

  // Descending has to be the exact reverse, or the header's second click lies.
  const descending = chronological
    .slice()
    .sort((left, right) => compare(superSortKey(left), superSortKey(right), "desc"));
  check(
    locale.name + ": descending is the exact reverse",
    JSON.stringify(descending) === JSON.stringify(chronological.slice().reverse()),
    ""
  );

  // A text column must never be sorted as a date just because it contains a year.
  const textCells = ["FY 2025-26 annual return", "Acme Advisors LLP", "Reminder 2026 batch"];
  check(
    locale.name + ": text containing a four-digit year is NOT treated as a date",
    textCells.every((cell) => superSortKey(cell).n === null),
    textCells.map((c) => c + "=" + (superSortKey(c).n === null ? "text" : "DATE")).join(", ")
  );

  // Placeholders sort last in both directions rather than landing mid-column.
  check(
    locale.name + ": em-dash and blank placeholders are flagged empty",
    ["—", "-", "", "   "].every((cell) => superSortKey(cell).empty === true),
    ""
  );

  // toLocaleString() adds a time; the date part must still drive the order.
  const morning = locale.render(new Date(2026, 7, 11)) + ", 9:05:00 am";
  const evening = locale.render(new Date(2026, 8, 3)) + ", 3:20:00 pm";
  check(
    locale.name + ": date-with-time cells order by date then time",
    superSortKey(morning).n !== null &&
      superSortKey(evening).n !== null &&
      superSortKey(morning).n < superSortKey(evening).n,
    ""
  );

  // ISO is unambiguous and must keep working in every locale.
  check(
    locale.name + ": ISO dates parse and order",
    superSortKey("2026-08-11").n !== null &&
      superSortKey("2026-08-11").n < superSortKey("2026-09-03").n,
    ""
  );

  // A spelled-out month carries its own order.
  check(
    locale.name + ": a spelled-out month parses unambiguously",
    superSortKey("11 August 2026").n !== null &&
      superSortKey("11 August 2026").n < superSortKey("3 September 2026").n,
    ""
  );

  // Money and counts still sort numerically, not as text.
  check(
    locale.name + ": currency and thousands separators sort numerically",
    superSortKey("₹1,20,000").n === 120000 && superSortKey("9").n < superSortKey("100").n,
    ""
  );
}

// --- The truncated firm list has to say so ------------------------

check(
  "loadFirms keeps the truncation fields instead of returning a bare array",
  /truncated:\s*Boolean\(data\.truncated\)/.test(superJs) &&
    /totalFirms:\s*Number\(data\.totalFirms\)/.test(superJs),
  ""
);

check(
  "the panel tells the admin when the firm list is capped",
  /firmList\.truncated[\s\S]{0,240}?Showing the/.test(superJs),
  ""
);

// --- Markup the browser has to repair is markup nobody can reason about ---

const openDivs = (superHtml.match(/<div\b/g) || []).length;
const closeDivs = (superHtml.match(/<\/div>/g) || []).length;
check(
  "super.html closes every div it opens",
  openDivs === closeDivs,
  openDivs + " open / " + closeDivs + " close"
);

const duplicateClassAttrs = (
  superHtml.match(/<[a-zA-Z][a-zA-Z0-9-]*\b[^>]*\sclass="[^"]*"[^>]*\sclass="/g) || []
).length;
check(
  "no element carries two class attributes (the second is silently dropped)",
  duplicateClassAttrs === 0,
  duplicateClassAttrs + " found"
);

const balancePairs = [
  ["section", /<section\b/g, /<\/section>/g],
  ["main", /<main\b/g, /<\/main>/g],
  ["table", /<table\b/g, /<\/table>/g],
  ["aside", /<aside\b/g, /<\/aside>/g],
];
for (const pair of balancePairs) {
  const opened = (superHtml.match(pair[1]) || []).length;
  const closed = (superHtml.match(pair[2]) || []).length;
  check("super.html balances <" + pair[0] + ">", opened === closed, opened + "/" + closed);
}

// Every routed section the sidebar links to has to exist, or a menu item is a dead end.
const routedIds = (superHtml.match(/id="page-[a-z-]+"/g) || []).map((raw) =>
  raw.slice(4, -1)
);
check("the panel is split into routed sections", routedIds.length >= 8, routedIds.length + " sections");

// The sidebar navigates by hash ("#firms"); the router turns that into an element id
// ("page-firms"). Those are two different vocabularies that have to stay in step, so
// check the whole chain: link -> SUPER_PAGES -> section id. A link that resolves to
// nothing is a menu item that silently does nothing when clicked.
const sidebarBlock = (superHtml.match(/<aside[^>]*class="[^"]*sidebar[\s\S]*?<\/aside>/) || [""])[0];
const sidebarTargets = (sidebarBlock.match(/href="#([a-z-]+)"/g) || []).map((raw) =>
  raw.replace(/href="#|"/g, "")
);
check(
  "the sidebar actually contains navigation links",
  sidebarTargets.length >= 8,
  sidebarTargets.length + " links: " + sidebarTargets.join(", ")
);

const pagesDecl = superJs.match(/const SUPER_PAGES\s*=\s*\[([\s\S]*?)\]/);
const superPages = pagesDecl
  ? (pagesDecl[1].match(/"([a-z-]+)"/g) || []).map((raw) => raw.replace(/"/g, ""))
  : [];
check(
  "super.js declares the routed page vocabulary",
  superPages.length >= 8,
  superPages.length + " pages"
);

const unrouted = sidebarTargets.filter((target) => !superPages.includes(target));
check(
  "every sidebar link names a page the router knows",
  sidebarTargets.length > 0 && unrouted.length === 0,
  unrouted.length ? "unrouted: " + unrouted.join(", ") : "all " + sidebarTargets.length + " resolve"
);

const missingSections = superPages.filter((page) => !routedIds.includes("page-" + page));
check(
  "every routed page has a section in the markup",
  superPages.length > 0 && missingSections.length === 0,
  missingSections.length ? "missing: " + missingSections.join(", ") : "all " + superPages.length + " present"
);

const orphanSections = routedIds.filter((id) => !superPages.includes(id.replace(/^page-/, "")));
check(
  "no section is unreachable from the sidebar",
  orphanSections.length === 0,
  orphanSections.length ? "orphaned: " + orphanSections.join(", ") : ""
);

// The default has to be one of the pages, or the panel opens on nothing.
const defaultDecl = superJs.match(/const SUPER_DEFAULT_PAGE\s*=\s*"([a-z-]+)"/);
check(
  "the default page is one of the routed pages",
  Boolean(defaultDecl) && superPages.includes(defaultDecl[1]),
  defaultDecl ? defaultDecl[1] : "not declared"
);

// --- Cache busting ------------------------------------------------
//
// A stylesheet whose CONTENT changed but whose ?v= token did not is served from the
// browser cache, so a returning admin gets new markup against old CSS. That is exactly
// how the sortable-header styling failed to appear after it was deployed.

const cssRef = superHtml.match(/admin\.css\?v=(\d+)/);
const jsRef = superHtml.match(/super\.js\?v=(\d+)/);
check("super.html cache-busts admin.css", Boolean(cssRef), cssRef ? cssRef[0] : "missing");
check("super.html cache-busts super.js", Boolean(jsRef), jsRef ? jsRef[0] : "missing");

// The sortable rules live in admin.css. If they are present, the stylesheet has moved
// past the version the panel shipped with before sorting existed (v12).
const hasSortableRules = /\.super-sortable/.test(adminCss);
check("admin.css carries the sortable-header rules", hasSortableRules, "");
check(
  "admin.css's cache token was raised past the pre-sorting version",
  !hasSortableRules || (cssRef !== null && Number(cssRef[1]) > 12),
  cssRef ? "v=" + cssRef[1] : "missing"
);

// --- Each page loads its own data (DS10) --------------------------
//
// Startup used to fetch every page's data - about ten requests against a limiter of 50 per 15
// minutes. Now initSuperPage asks only for the page on screen, through superLoadPage, and every
// routed page has exactly one loader.

const loadersDecl = superJs.match(/const SUPER_PAGE_LOADERS\s*=\s*\{([\s\S]*?)\n\};/);
const loaderPages = loadersDecl ? [...loadersDecl[1].matchAll(/^\s+([a-z-]+):/gm)].map((m) => m[1]) : [];
check(
  "every routed page has a loader, and no loader names a page the router does not know",
  loaderPages.length > 0 &&
    superPages.every((page) => loaderPages.includes(page)) &&
    loaderPages.every((page) => superPages.includes(page)),
  "loaders: " + loaderPages.join(", ")
);

const initStart = superJs.indexOf("async function initSuperPage()");
const initBody = initStart >= 0 ? superJs.slice(initStart, superJs.indexOf("\n}\n", initStart)) : "";
const directLoads = [...initBody.matchAll(/\b(load[A-Z]\w*)\s*\(/g)].map((m) => m[1]);
check(
  "startup calls no page loader directly - only superLoadPage for the page on screen",
  initBody.length > 0 && directLoads.length === 0 && /superLoadPage\(superShowPage\(/.test(initBody),
  directLoads.length ? "direct: " + directLoads.join(", ") : "superLoadPage only"
);
const meCalls = superJs.split("\n").filter((line) => line.includes("/auth/me") && !line.trim().startsWith("//"));
check(
  "startup asks /auth/me once - the user from the auth check is reused",
  meCalls.length === 1,
  meCalls.length + " call site(s)"
);
check(
  "no DOMContentLoaded handler fetches on its own",
  !/addEventListener\("DOMContentLoaded",\s*initializeSelfTestPanel\)/.test(superJs) &&
    /addEventListener\("DOMContentLoaded",\s*bindSelfTestPanel\)/.test(superJs),
  "the deep review's latest run is read when its page opens"
);

// --- Day charts (DS10) --------------------------------------------
//
// The chart helpers are lifted out and evaluated, as the sort key is above.

const chartStart = superJs.indexOf("const DAY_CHART_MONTHS");
const chartEnd = superJs.indexOf("\n// ─── Emails page");
check("super.js carries the day-chart helpers", chartStart >= 0 && chartEnd > chartStart, "");
const chartApi = chartStart >= 0 && chartEnd > chartStart
  ? new Function(
      "escapeHtml",
      superJs.slice(chartStart, chartEnd) + "\nreturn { dayChartKeys, dayChartTicks, renderDayChart };"
    )((s) => String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"))
  : null;

if (chartApi) {
  const today = new Date("2026-10-04T15:00:00Z");
  const keys = chartApi.dayChartKeys([{ _id: "2026-10-02" }, { _id: "2026-09-25" }], 14, today);
  check(
    "a chart's window is every UTC day, a quiet day included",
    keys.length === 14 && keys[0] === "2026-09-21" && keys[13] === "2026-10-04" && keys.includes("2026-09-30"),
    keys[0] + " .. " + keys[keys.length - 1] + " (" + keys.length + ")"
  );
  const widened = chartApi.dayChartKeys([{ _id: "2026-09-20" }, { _id: "2026-10-05" }], 14, today);
  check(
    "a day returned outside the window widens it rather than being dropped",
    widened[0] === "2026-09-20" && widened[widened.length - 1] === "2026-10-05" && widened.length === 16,
    widened[0] + " .. " + widened[widened.length - 1] + " (" + widened.length + ")"
  );
  const tickCases = [[0, "0,1"], [1, "0,1"], [3, "0,1,2,3"], [4, "0,1,2,3,4"], [5, "0,2,4,6"], [12, "0,5,10,15"], [100, "0,50,100"], [1234, "0,500,1000,1500"]];
  const wrongTicks = tickCases.filter(([max, want]) => chartApi.dayChartTicks(max).join(",") !== want);
  check(
    "the scale is whole numbers from 0, at most four steps, topping the largest figure",
    wrongTicks.length === 0,
    wrongTicks.length ? wrongTicks.map(([max]) => max + " -> " + chartApi.dayChartTicks(max).join(",")).join("; ") : tickCases.length + " cases"
  );

  const box = { innerHTML: "" };
  chartApi.renderDayChart(box, {
    rows: [{ _id: "2026-10-01", desktop: 2, extension: 1 }],
    windowDays: 3,
    series: [{ key: "desktop", label: "Desktop" }, { key: "extension", label: "<b>Extension</b>" }],
    caption: "Distinct users per day by app (UTC)",
    empty: "none",
  });
  const html = box.innerHTML;
  const dayColumns = (html.match(/<th scope="col" data-day="/g) || []).length;
  check(
    "the figures sit in a table, one column per day, one row per series",
    /<table class="day-chart__table">/.test(html) && dayColumns >= 3 && (html.match(/<th scope="row">/g) || []).length === 2,
    dayColumns + " day columns"
  );
  check("two series get a legend", /<ul class="day-chart__legend">/.test(html), "");
  check("a series label is escaped", html.includes("&lt;b&gt;Extension&lt;/b&gt;") && !html.includes("<b>Extension"), "");
  const single = { innerHTML: "" };
  chartApi.renderDayChart(single, { rows: [{ _id: "2026-10-01", count: 1 }], windowDays: 3, series: [{ key: "count", label: "Users" }], caption: "c", empty: "none" });
  check("one series has no legend", !/day-chart__legend/.test(single.innerHTML), "");
  const empty = { innerHTML: "" };
  chartApi.renderDayChart(empty, { rows: [], windowDays: 14, series: [{ key: "count", label: "Users" }], caption: "c", empty: "No activity recorded yet" });
  check("no rows at all says so instead of drawing fourteen zeros", /No activity recorded yet/.test(empty.innerHTML) && !/<table/.test(empty.innerHTML), "");
}

// The Controls cards show the server's settings, so each starts disabled and busy, and their
// resting text claims no state: loading by page put the read at the moment the page opens.
const controlsCards = ["maintenanceSet", "welcomeSet", "featureFlagsSet", "desktopReleaseSet"];
const closedCards = controlsCards.filter((id) =>
  new RegExp(`<fieldset id="${id}" class="super-loading-set" disabled aria-busy="true">`).test(superHtml)
);
check(
  "every Controls card starts closed until its settings are read",
  closedCards.length === controlsCards.length && (superHtml.match(/<\/fieldset>/g) || []).length >= controlsCards.length,
  closedCards.length + "/" + controlsCards.length + " cards"
);
check(
  "the maintenance label and the release readout claim no state before reading",
  !/id="maintenanceLabel">Maintenance mode: (ON|OFF)/.test(superHtml) &&
    !/id="desktopReleaseLive"[^>]*>Nothing announced yet\./.test(superHtml),
  ""
);

// The chart's table runs sideways in day order; the panel's column sorting must leave it alone.
check(
  "the day-chart table is excluded from column sorting",
  /classList\.contains\("day-chart__table"\)\) return;/.test(superJs),
  ""
);

// --- Report -------------------------------------------------------

let passed = 0;
for (const entry of checks) {
  const mark = entry.pass ? "PASS" : "FAIL";
  if (entry.pass) passed += 1;
  console.log("[" + mark + "] " + entry.name + (entry.detail ? " - " + entry.detail : ""));
}

const total = checks.length;
console.log("\nSuper panel contract: " + passed + "/" + total);

if (passed !== total) {
  console.error("\n" + (total - passed) + " check(s) failed.");
  process.exit(1);
}
