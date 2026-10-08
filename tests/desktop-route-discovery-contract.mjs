// tests/desktop-route-discovery-contract.mjs
//
// Proves that the fixture tooling DISCOVERS every route the desktop client calls, and reports which
// of them have no committed fixture.
//
// WHY THIS EXISTS
// ---------------
// tools/capture-desktop-fixtures.mjs parses CaProApiClient.cs for the routes it should capture, and
// tests/desktop-fixture-drift-contract.mjs then guards those fixtures against a controller renaming
// a field. Both are only as good as the parse. Measured 2026-08-26: the two parsers between them
// found 97 of the client's 107 distinct route templates, and the ten they missed were not "known
// gaps" -- they were invisible, because the tool counted the routes it discovered rather than the
// routes that exist. Its own header says why that is the bad kind of bug: "a discovery bug is worse
// than a coverage gap, because it reports as completeness."
//
// The ten were all built the same way: the path is assembled into a local first and passed to the
// call by name, so neither `HttpMethod.X, "literal"` nor `HttpMethod.X, $"literal"` matches:
//
//   var path = string.Create(CultureInfo.InvariantCulture, $"api/tasks/my-open?page={p}&limit={l}");
//   using var request = Authorized(HttpMethod.Get, path, accessToken);
//
// That list includes `api/tasks/my-open` -- the Overview page's own endpoint -- and the five
// `api/imports/*` routes that carry a GST or TDS import through preview and commit. `my-open` having
// no fixture is precisely why D13 survived: the mapper read the work-queue total from the wrong
// level of the response, the fixture that would have caught it was never captured, and the hand
// written test fixture had been invented rather than copied.
//
// WHAT THIS ASSERTS, AND WHAT IT DELIBERATELY DOES NOT
// ---------------------------------------------------
// It asserts the three parsers ACCOUNT FOR every `api/...` literal in the client. It does NOT demand
// a fixture for each: most parameterised routes need a real entity created first, and failing on
// that today would turn a green gate red for a gap that has always existed and that nothing here
// closes. Coverage is therefore REPORTED with a number that can only be argued down, while
// discovery is ENFORCED -- because an uncovered route is a known debt and an undiscovered one is a
// false clean bill of health.
//
// USAGE
//   node tests/desktop-route-discovery-contract.mjs
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  parseStaticRoutes,
  parseInterpolatedRoutes,
  parseIndirectRoutes,
  parseAllRouteLiterals,
  normaliseRouteTemplate,
} from "../tools/desktop-route-parsers.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const clientPath = resolve(
  repoRoot,
  "..",
  "apps",
  "desktop-native",
  "src",
  "CaPro.Desktop.Core",
  "Api",
  "CaProApiClient.cs",
);
const manifestPath = resolve(
  repoRoot,
  "..",
  "apps",
  "desktop-native",
  "tests",
  "CaPro.Desktop.Core.Tests",
  "Fixtures",
  "manifest.json",
);

let passed = 0;
let failed = 0;
const failures = [];
function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS ${name}${detail ? "  -- " + detail : ""}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? "  -- " + detail : ""}`);
  }
}

console.log("desktop route discovery");
console.log("");

check("CaProApiClient.cs is where this expects it", existsSync(clientPath), clientPath);
if (!existsSync(clientPath)) {
  console.log("");
  console.log(`passed: ${passed}  failed: ${failed}`);
  process.exit(1);
}

const clientText = readFileSync(clientPath, "utf8");
const staticRoutes = parseStaticRoutes(clientText);
const interpolatedRoutes = parseInterpolatedRoutes(clientText);
const indirectRoutes = parseIndirectRoutes(clientText);
const allLiterals = parseAllRouteLiterals(clientText);

const discovered = new Set(
  [...staticRoutes, ...interpolatedRoutes, ...indirectRoutes].map((route) =>
    route.path.replace(/\?.*$/, ""),
  ),
);

console.log(
  `  static ${staticRoutes.length}, interpolated ${interpolatedRoutes.length}, ` +
    `indirect ${indirectRoutes.length}, distinct literals ${allLiterals.length}`,
);
console.log("");

// ─── 1. THE INVARIANT: nothing is uncounted ─────────────────────────

const unaccounted = allLiterals.filter((route) => !discovered.has(route));
check(
  "every api/... literal in the client is accounted for by one of the three parsers",
  unaccounted.length === 0,
  unaccounted.length === 0
    ? `${allLiterals.length} literals, 0 unaccounted`
    : `${unaccounted.length} UNACCOUNTED: ${unaccounted.join(", ")} -- a new construction form was added and the parsers did not follow it`,
);

check(
  "the client really does declare a substantial route surface, so the check is not passing on an empty parse",
  allLiterals.length >= 100,
  `${allLiterals.length} distinct route templates`,
);

// ─── 2. Negative controls on the parsers themselves ─────────────────
// Without these, a regex that silently stopped matching would report a clean pass over a file full
// of routes: zero discovered and zero literals both satisfy the invariant above.

const staticSample = 'Authorized(\n    HttpMethod.Get,\n    "api/negative-control",\n    token)';
check(
  "NEGATIVE CONTROL the static parser still matches a call split across lines",
  parseStaticRoutes(staticSample).some((route) => route.path === "api/negative-control"),
  "the newline after the opening paren is the exact formatting that once hid ten list GETs",
);

const interpolatedSample =
  'Authorized(\n    HttpMethod.Post,\n    $"api/negative/{Uri.EscapeDataString(id)}/control",\n    token)';
check(
  "NEGATIVE CONTROL the interpolated parser still matches, and collapses the hole to its value",
  parseInterpolatedRoutes(interpolatedSample).some(
    (route) => route.path === "api/negative/{id}/control",
  ),
  "hole collapsed to {id}, not to {EscapeDataString}",
);

const indirectSample =
  'var path = string.Create(CultureInfo.InvariantCulture, $"api/negative/indirect?x={y}");\n' +
  "using var request = Authorized(HttpMethod.Delete, path, accessToken);";
const indirectFound = parseIndirectRoutes(indirectSample);
check(
  "NEGATIVE CONTROL the indirect parser finds a literal built into a local, and infers its verb",
  indirectFound.some(
    (route) => route.path === "api/negative/indirect" && route.method === "DELETE",
  ),
  indirectFound.map((route) => `${route.method} ${route.path}`).join(", ") || "found nothing",
);

check(
  "NEGATIVE CONTROL a trailing method call does not become the route key",
  normaliseRouteTemplate("api/imports/tds/{Uri.EscapeDataString(batchId.Trim())}") ===
    "api/imports/tds/{batchId}",
  `got ${normaliseRouteTemplate("api/imports/tds/{Uri.EscapeDataString(batchId.Trim())}")}`,
);

check(
  "NEGATIVE CONTROL an indirect route is not double-counted as a static or interpolated one",
  parseStaticRoutes(indirectSample).length === 0 &&
    parseInterpolatedRoutes(indirectSample).length === 0,
  "the two precise parsers correctly see nothing in the indirect form",
);

// ─── 3. Coverage, reported rather than enforced ─────────────────────

if (!existsSync(manifestPath)) {
  check("the committed fixture manifest is present", false, manifestPath);
} else {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const capturedRoutes = new Set(
    (manifest.captured || []).map((entry) =>
      String(entry.route).replace(/^\w+\s+/, "").replace(/\?.*$/, ""),
    ),
  );

  const uncovered = allLiterals.filter((route) => !capturedRoutes.has(route));
  console.log("");
  console.log(
    `  fixtures cover ${allLiterals.length - uncovered.length} of ${allLiterals.length} route templates; ` +
      `${uncovered.length} outstanding`,
  );

  check(
    "the manifest records a capture, so coverage is measured against something real",
    (manifest.captured || []).length > 0,
    `${(manifest.captured || []).length} captured, backend commit ${String(manifest.backendCommitSha || "").slice(0, 8)}`,
  );

  // The routes worth naming: a GET with no path parameter can be captured with no entity setup at
  // all, so an uncovered one is not "hard", it is simply not done. Reported, not failed.
  const cheaplyCapturable = uncovered.filter(
    (route) => !route.includes("{") && !route.startsWith("api/auth/"),
  );
  if (cheaplyCapturable.length > 0) {
    console.log(
      `  of those, ${cheaplyCapturable.length} take no path parameter and so need no entity setup:`,
    );
    for (const route of cheaplyCapturable) console.log(`    - ${route}`);
  }

  // api/tasks/my-open is called out by name because its absence is what let D13 through, and a
  // regression here would be the same defect returning by the same route.
  check(
    "api/tasks/my-open is at least DISCOVERED, whatever its fixture status",
    discovered.has("api/tasks/my-open"),
    capturedRoutes.has("api/tasks/my-open")
      ? "discovered and captured"
      : "discovered; still no fixture -- the Overview page's endpoint, and the reason D13 survived the drift gate",
  );
}

console.log("");
console.log(`passed: ${passed}  failed: ${failed}`);
if (failed > 0) {
  console.log(`failing checks: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("DESKTOP ROUTE DISCOVERY OK");
