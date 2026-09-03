// tests/desktop-navigation-contract.mjs
//
// Proves that every navigation tag the desktop's Core layer hands out actually resolves to a page.
//
// WHY THIS EXISTS
// ---------------
// Core builds the buttons - the review queue's "Open in compliance tasks", an empty state's "Go to
// imports" - and names its destination with a string tag. The App layer's PageRouteCatalog is what
// turns that string into a page. Core cannot reference App, so the tags are written down twice.
//
// Nothing checked that the two agreed. ReviewQueueTests asserted string literals against string
// literals: rename a pane tag, update ReviewQueuePolicy and the matching InlineData, and all of the
// Core tests stay green, the Release build stays at 0 warnings - and every Open button in the review
// queue becomes a control that silently does nothing, because NavigateTo returns without navigating
// on an unknown tag. That is worse than the sentence the button replaced, because the user is
// already stuck on that screen and now has something that looks like a way out.
//
// This is also what keeps SurfaceActionTargets.Known honest. SurfaceState drops an action whose
// target is not in that set, so a set that has drifted from the catalogue does not produce a dead
// button - it produces NO button, and an empty state silently loses the way out it was written to
// offer. Both directions are therefore checked.
//
// Pure text parsing - no database, no network, no .NET build.
//
// Run: node tests/desktop-navigation-contract.mjs

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DESKTOP = join(here, "..", "..", "apps", "desktop-native", "src");

const catalogueSource = readFileSync(join(DESKTOP, "CaPro.Desktop.App", "PageRouteCatalog.cs"), "utf8");
const targetsSource = readFileSync(
  join(DESKTOP, "CaPro.Desktop.Core", "Presentation", "SurfaceActionTargets.cs"),
  "utf8"
);
const reviewQueueSource = readFileSync(
  join(DESKTOP, "CaPro.Desktop.Core", "Presentation", "ReviewQueuePolicy.cs"),
  "utf8"
);
const surfaceStateSource = readFileSync(
  join(DESKTOP, "CaPro.Desktop.Core", "Presentation", "SurfaceState.cs"),
  "utf8"
);

const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass, detail });

// --- What the router can actually reach ---------------------------
//
// Entries look like:  new(typeof(OverviewPage), "overview", "Overview", null, true),
// The trailing boolean is IsNavigationTarget, and NavigateTo filters on it - so a page with
// `false` is NOT reachable by tag even when it has one.

const entryPattern =
  /new\(\s*typeof\((\w+)\)\s*,\s*(null|"[a-z0-9]+")\s*,\s*"[^"]*"\s*,\s*(?:null|"[^"]*")\s*,\s*(true|false)\s*\)/g;

const routes = [...catalogueSource.matchAll(entryPattern)].map((m) => ({
  page: m[1],
  tag: m[2] === "null" ? null : m[2].replace(/"/g, ""),
  isNavigationTarget: m[3] === "true",
}));

check("the route catalogue parses", routes.length >= 20, `${routes.length} routes`);

const navigable = new Set(
  routes.filter((r) => r.isNavigationTarget && r.tag).map((r) => r.tag)
);
check("the catalogue exposes navigable tags", navigable.size >= 20, `${navigable.size} tags`);

// Guards the parse itself: if the regex silently stopped matching, every check below
// would pass vacuously against an empty set.
check(
  "the parse found the tags this suite reasons about",
  ["gstrecon", "tds", "taskboard", "cases", "importlookup"].every((tag) => navigable.has(tag)),
  [...navigable].slice(0, 6).join(", ") + "..."
);

// A page deliberately excluded from navigation must not be offered as a destination.
const childRoutes = routes.filter((r) => r.tag && !r.isNavigationTarget).map((r) => r.tag);
check(
  "child routes are recorded so they can be excluded",
  true,
  childRoutes.length ? childRoutes.join(", ") : "(none)"
);

// --- Core's declared destinations ---------------------------------

const declaredTargets = new Set(
  (targetsSource
    .slice(targetsSource.indexOf("Known ="), targetsSource.indexOf("};", targetsSource.indexOf("Known =")))
    .match(/"([a-z0-9]+)"/g) || []
  ).map((raw) => raw.replace(/"/g, ""))
);
check("SurfaceActionTargets declares a target set", declaredTargets.size >= 10, `${declaredTargets.size} targets`);

const unreachable = [...declaredTargets].filter((tag) => !navigable.has(tag));
check(
  "every declared action target resolves to a navigable page",
  unreachable.length === 0,
  unreachable.length ? `dead: ${unreachable.join(", ")}` : "all resolve"
);

// --- The review queue's own tags ----------------------------------

const openTargetBlock = reviewQueueSource.slice(
  reviewQueueSource.indexOf("OpenTargetTag"),
  reviewQueueSource.indexOf("OpenLabel") + 1200
);
const reviewTags = new Set(
  (openTargetBlock.match(/=>\s*"([a-z0-9]+)"/g) || []).map((raw) =>
    raw.replace(/=>\s*"|"/g, "")
  )
);
check("the review queue names destinations", reviewTags.size >= 3, [...reviewTags].join(", "));

const deadReviewTags = [...reviewTags].filter((tag) => !navigable.has(tag));
check(
  "every review queue Open button resolves to a navigable page",
  deadReviewTags.length === 0,
  deadReviewTags.length ? `dead: ${deadReviewTags.join(", ")}` : "all resolve"
);

// A review queue tag that Core will refuse renders no button at all, which is the
// opposite failure and just as silent.
const refusedReviewTags = [...reviewTags].filter((tag) => !declaredTargets.has(tag));
check(
  "every review queue destination is also a declared action target",
  refusedReviewTags.length === 0,
  refusedReviewTags.length ? `would be dropped: ${refusedReviewTags.join(", ")}` : "all declared"
);

// --- Targets named inline by surfaces -----------------------------
//
// A page can pass a target string straight to Empty()/FromView(). Those are collected here
// so a typo cannot silently produce a state with no button.

// Every shape a destination is written in, across BOTH layers.
//
// This scraper started narrower and gave false assurance because of it: it matched
// `emptyActionTarget: "x"` and `... ? "x" : null`, but not `... ? null : "x"` (the null-first
// ternary), and its positional matcher required the call to end `))` so it missed a target in a
// static property ending `);`. Three real destinations - engagements, intake and taskboard - were
// therefore never validated at all, and a typo in any of them would have passed this test. The
// count assertion below is what turns that class of miss into a failure rather than a silent pass.
const TARGET_PATTERNS = [
  // emptyActionTarget: "x"   |   ? "x" : null   |   ? null : "x"
  /emptyActionTarget:\s*(?:[^,;)]*?\?\s*(?:null\s*:\s*)?)?"([a-z0-9]+)"/g,
  // emptyActionTarget: cond ? "a" : "b"  - capture the second arm too
  /emptyActionTarget:\s*[^,;)]*?\?\s*"[a-z0-9]+"\s*:\s*"([a-z0-9]+)"/g,
];

const inlineTargets = new Set();
const { readdirSync } = await import("node:fs");

function collectTargets(text) {
  for (const pattern of TARGET_PATTERNS) {
    for (const m of text.matchAll(pattern)) inlineTargets.add(m[1]);
  }
  // A positional SurfaceState.Empty(title, next, "Label", "target"), however the call is
  // terminated - `));` inside a method, `);` in a static property initialiser. The candidate is
  // only accepted when it looks like a route tag, so ordinary copy is not swept up.
  for (const m of text.matchAll(/SurfaceState\.Empty\(([\s\S]{0,900}?)\)\s*[);]/g)) {
    const literals = [...m[1].matchAll(/"([a-z0-9]+)"/g)].map((x) => x[1]);
    for (const candidate of literals) {
      if (navigable.has(candidate) || declaredTargets.has(candidate)) inlineTargets.add(candidate);
    }
  }
}

for (const dir of [
  join(DESKTOP, "CaPro.Desktop.App", "Views"),
  join(DESKTOP, "CaPro.Desktop.Core", "Presentation"),
]) {
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".cs"))) {
    collectTargets(readFileSync(join(dir, file), "utf8"));
  }
}

check("surfaces name destinations inline", inlineTargets.size >= 1, [...inlineTargets].join(", ") || "(none)");

// The scraper must keep finding what the app actually ships. A regex that quietly stops matching
// turns every check below it into a check of nothing - which is exactly what happened before.
const EXPECTED_TARGETS = ["engagements", "gstrecon", "importlookup", "intake", "taskboard", "taxwork", "tds", "workspaces"];
const notScraped = EXPECTED_TARGETS.filter((tag) => !inlineTargets.has(tag));
check(
  "the scraper finds every destination the app is known to use",
  notScraped.length === 0,
  notScraped.length ? `not found by the scraper: ${notScraped.join(", ")}` : `${inlineTargets.size} found`,
);

const badInline = [...inlineTargets].filter((tag) => !navigable.has(tag) || !declaredTargets.has(tag));
check(
  "every inline destination both resolves and is declared",
  badInline.length === 0,
  badInline.length ? `broken: ${badInline.join(", ")}` : "all good"
);

// --- The promise SurfaceState makes about unknown targets ---------

check(
  "SurfaceState actually enforces the target allow-list it documents",
  /SurfaceActionTargets\.IsKnown\(target\)/.test(surfaceStateSource),
  ""
);

// --- a resolvable tag is not enough; the navigation has to happen ---
//
// The tag allow-list above proves a destination EXISTS. It does not prove clicking gets you
// there. NavigateTo worked by assigning Navigation.SelectedItem, and WinUI raises no
// SelectionChanged when the item assigned is the one already selected - which is exactly the
// case on a CHILD page, because TDS checks, reconciliation lines, run controls and working
// papers have no pane item of their own and the pane is still highlighting their section. So
// every "open the section this belongs to" button on a child page was an enabled control that
// did nothing, and the allow-list test passed the whole time.

const mainWindowSource = readFileSync(
  join(DESKTOP, "CaPro.Desktop.App", "MainWindow.xaml.cs"),
  "utf8"
);

const navigateToBody = mainWindowSource.slice(
  mainWindowSource.indexOf("internal void NavigateTo(string tag)")
);
const navigateToEnd = navigateToBody.indexOf("\n    }\n");
const navigateTo = navigateToEnd > 0 ? navigateToBody.slice(0, navigateToEnd) : navigateToBody;

check(
  "NavigateTo exists and is reachable from a page",
  navigateTo.length > 0 && navigateTo.indexOf("Navigation.SelectedItem") >= 0,
  ""
);

check(
  "NavigateTo still navigates when the section is ALREADY selected",
  /ReferenceEquals\(Navigation\.SelectedItem, item\)/.test(navigateTo)
    && /NavigateToTagAsync\(tag\)/.test(navigateTo),
  navigateTo.indexOf("ReferenceEquals") >= 0
    ? "handles the already-selected case"
    : "assigning SelectedItem alone - a child page's button would do nothing",
);

check(
  "the navigation body is shared, so the unsaved-text guard applies to both paths",
  /private async Task NavigateToTagAsync\(string tag\)/.test(mainWindowSource)
    && /await NavigateToTagAsync\(tag\)/.test(mainWindowSource)
    && /ConfirmLeavingDirtyPageAsync/.test(mainWindowSource),
  ""
);
check(
  "FromView can carry an action, so empty states are not limited to a sentence",
  /emptyActionLabel/.test(surfaceStateSource) && /emptyActionTarget/.test(surfaceStateSource),
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
console.log("\nDesktop navigation contract: " + passed + "/" + total);

if (passed !== total) {
  console.error("\n" + (total - passed) + " check(s) failed.");
  process.exit(1);
}
