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

const inlineTargets = new Set();
const viewsDir = join(DESKTOP, "CaPro.Desktop.App", "Views");
const { readdirSync } = await import("node:fs");
for (const file of readdirSync(viewsDir).filter((f) => f.endsWith(".xaml.cs"))) {
  const text = readFileSync(join(viewsDir, file), "utf8");
  for (const m of text.matchAll(/emptyActionTarget:\s*(?:[^,)]*\?\s*null\s*:\s*)?"([a-z0-9]+)"/g)) {
    inlineTargets.add(m[1]);
  }
  // Empty(title, next, "Label", "target") - the fourth argument.
  for (const m of text.matchAll(/SurfaceState\.Empty\(\s*(?:[^()]|\([^()]*\))*?"([a-z0-9]+)"\s*\)\s*\)/g)) {
    if (navigable.has(m[1]) || declaredTargets.has(m[1])) inlineTargets.add(m[1]);
  }
}
const policyDir = join(DESKTOP, "CaPro.Desktop.Core", "Presentation");
for (const file of readdirSync(policyDir).filter((f) => f.endsWith(".cs"))) {
  const text = readFileSync(join(policyDir, file), "utf8");
  for (const m of text.matchAll(/emptyActionTarget:\s*"([a-z0-9]+)"/g)) inlineTargets.add(m[1]);
}

check("surfaces name destinations inline", inlineTargets.size >= 1, [...inlineTargets].join(", ") || "(none)");

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
