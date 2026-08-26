// tests/extension-route-parity.mjs
//
// Every route the PRODUCTION Chrome extension calls must be a route this backend still declares.
//
// WHY THIS EXISTS
// ---------------
// "Never break the extension" is the oldest standing rule in this project - it is in production, it
// shares this backend, and a backend change that serves the desktop while dropping a route the
// extension calls breaks paying users with no warning. Until now that rule had **no automated
// check**. The one existing suite that looks at the extension (`shared-backend-contract.mjs`) checks
// its base URLs, its CSP and its manifest key; nothing compared the routes it calls against the
// routes this server offers.
//
// It could not be done live, and that is worth writing down so nobody tries the obvious thing.
// Measured 2026-08-27 against production: an unauthenticated `GET /api/auth/me` and an
// unauthenticated `GET /api/auth/definitely-not-a-real-route-xyz` both answer **401 with a
// byte-identical body** (113 bytes, same keys), and `OPTIONS` on both answers a bare 204 with no
// `Allow` header. `app.use("/api", firmOperationsRoutes)` plus `router.use(authRequired)` sends every
// unmatched `/api/*` request into an authenticated catch-all, so absence is indistinguishable from
// presence without a token. With a token they separate cleanly - real routes 200, missing routes 404
// - and `tools/verify-extension-routes.mjs` does exactly that when someone has one. This suite is the
// half that needs no credential and can therefore run on every gate.
//
// WHAT IT COMPARES
// ----------------
// Both sides are parsed from source, never from a hand-kept list - the lesson of V17 (ten suites the
// gate never invoked) and V23 (ten routes the fixture tool never discovered): a list you maintain by
// hand reports as completeness.
//
//   extension  every `/api/...` literal in audit-nlp-extension/*.js
//   backend    every `router.<verb>("<path>")` in src/routes/*.js, prefixed by its mount in app.js
//
// Path parameters are normalised on both sides - the extension writes `${caseId}`, the router writes
// `:id` - so the comparison is of route SHAPES, which is what a rename or a removal changes.
//
// USAGE
//   node tests/extension-route-parity.mjs
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const BACKEND = resolve(here, "..");
const EXTENSION = resolve(BACKEND, "..", "audit-nlp-extension");

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

// A route shape: lower-cased, one leading slash, every parameter collapsed to ':p', no trailing
// slash, no query string. `${Uri...}`, `${caseId}`, `:id` and `:sourceHash` all become ':p'.
export function routeShape(path) {
  let p = String(path).trim();
  p = p.replace(/[?#].*$/, "");
  p = p.replace(/\$\{[^}]*\}/g, ":p");
  p = p.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ":p");
  p = p.replace(/\/+/g, "/");
  if (!p.startsWith("/")) p = "/" + p;
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p.toLowerCase();
}

function jsFilesUnder(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js") || entry.name.endsWith(".mjs")) found.push(full);
    }
  };
  walk(root);
  return found;
}

console.log("extension route parity");
console.log("");

// ─── The backend's declared surface ─────────────────────────────────

const app = readFileSync(join(BACKEND, "src", "app.js"), "utf8");
const mounts = new Map(); // route-file identifier -> mount prefix
for (const m of app.matchAll(/app\.use\(\s*"(\/api[^"]*)"\s*,\s*(?:[A-Za-z0-9_]+\s*,\s*)*([A-Za-z0-9_]+)\s*\)/g)) {
  mounts.set(m[2], m[1]);
}
check(
  "app.js mounts were parsed",
  mounts.size >= 15,
  `${mounts.size} /api mount(s): ${[...mounts.values()].slice(0, 4).join(", ")}...`
);

// Which import name each route file is bound to, so a mount can be traced to its file.
const importedAs = new Map(); // file base name -> identifier
for (const m of app.matchAll(/import\s+([A-Za-z0-9_]+)\s+from\s+"\.\/routes\/([A-Za-z0-9_.-]+)\.js"/g)) {
  importedAs.set(m[2], m[1]);
}

const declared = new Set();
const routesDir = join(BACKEND, "src", "routes");
let declaredFiles = 0;
for (const file of readdirSync(routesDir).filter((f) => f.endsWith(".routes.js"))) {
  const identifier = importedAs.get(file.replace(/\.js$/, ""));
  const prefix = identifier ? mounts.get(identifier) : undefined;
  if (!prefix) continue;
  declaredFiles += 1;
  const text = readFileSync(join(routesDir, file), "utf8");
  for (const m of text.matchAll(/router\s*\.\s*(get|post|patch|put|delete)\s*\(\s*"([^"]*)"/g)) {
    declared.add(routeShape(prefix + (m[2] === "/" ? "" : m[2])));
  }
}

check(
  "every mounted route file was read",
  declaredFiles >= 15,
  `${declaredFiles} route file(s) traced from an app.js mount to their declarations`
);
check(
  "the backend declares a substantial route surface",
  declared.size >= 100,
  `${declared.size} distinct route shapes`
);

// ─── The extension's called surface ─────────────────────────────────

if (!existsSync(EXTENSION)) {
  check(
    "the extension checkout is present",
    false,
    "audit-nlp-extension is not checked out; run git submodule update --init"
  );
} else {
  const called = new Map(); // shape -> { file, literal, text }
  const perTree = { src: new Set(), dist: new Set() };
  for (const file of jsFilesUnder(EXTENSION)) {
    if (/[\\/]tests[\\/]/.test(file)) continue;
    const relative = file.slice(EXTENSION.length + 1);
    const tree = /^dist[\\/]/.test(relative) ? "dist" : "src";
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/["'`](\/api\/[^"'`\s]*)["'`]/g)) {
      const literal = m[1];
      const shape = routeShape(literal);
      // Not an API route: the extension references a bundled page under a path that starts /api.
      if (/\.(html?|js|css|png|svg|json)$/.test(shape)) continue;
      perTree[tree].add(shape);
      if (!called.has(shape)) called.set(shape, { file: relative, literal, text });
    }
  }

  check(
    "the extension's API calls were found",
    called.size >= 30,
    `${called.size} distinct route shapes called`
  );

  // A template whose LAST segment is a bare interpolation may hide more than one path segment: the
  // variable can itself carry slashes. notice-workspace.js does exactly that -
  // `/api/cases/${caseId}/${path}` where `path` is `drafts/{id}/review`, `.../finalize` or
  // `.../submit-review` - so the literal collapses to `/api/cases/:p/:p` while the real routes are
  // five segments long, and reporting it as missing is a FALSE failure. A suite that cries wolf gets
  // discounted, and a discounted suite protects nothing.
  //
  // The first version of this file classified every trailing interpolation as unresolvable and
  // excluded 13 of 74 routes from the check. That was too broad: nearly all of those 13 are a plain
  // single-segment id and match a declared route perfectly well. So the shape is checked FIRST, and
  // only a shape that does NOT match is re-examined by resolving the tail variable from its literal
  // assignments in the same file. That enforces all 74 instead of 61, and it narrows the exclusion to
  // the case that actually needs it.
  function resolveTail(entry) {
    const tail = /\$\{\s*([A-Za-z_$][\w$]*)\s*\}\/?$/.exec(entry.literal.replace(/[?#].*$/, ""));
    if (!tail) return null;
    const variable = tail[1];
    const prefix = entry.literal.replace(/[?#].*$/, "").replace(/\$\{\s*[A-Za-z_$][\w$]*\s*\}\/?$/, "");
    const assignment = new RegExp(
      `\\b${variable}\\s*=\\s*(?:\`([^\`]*)\`|"([^"]*)"|'([^']*)')`,
      "g",
    );
    const values = [];
    for (const a of entry.text.matchAll(assignment)) {
      const value = a[1] ?? a[2] ?? a[3];
      if (value !== undefined && value.length > 0) values.push(value);
    }
    if (values.length === 0) return null;
    return { variable, expansions: [...new Set(values.map((v) => routeShape(prefix + v)))] };
  }

  const missing = [];
  const resolvedTails = [];
  const unresolvable = [];
  for (const [shape, entry] of called) {
    if (declared.has(shape)) continue;
    const resolved = resolveTail(entry);
    if (!resolved) { unresolvable.push([shape, entry]); continue; }
    const undeclared = resolved.expansions.filter((e) => !declared.has(e));
    if (undeclared.length > 0) {
      missing.push([shape, entry, `expands to ${undeclared.join(", ")} which this backend does not declare`]);
    } else {
      resolvedTails.push([shape, entry, resolved]);
    }
  }

  check(
    "every route the extension calls is still declared by this backend",
    missing.length === 0 && unresolvable.length === 0,
    missing.length === 0 && unresolvable.length === 0
      ? `${called.size} called, ${called.size} accounted for (${resolvedTails.length} via a resolved tail variable)`
      : [
          ...missing.map(([shape, v, why]) => `MISSING ${shape} (${v.file}): ${why}`),
          ...unresolvable.map(([shape, v]) => `UNRESOLVABLE ${shape} (${v.file}): its tail variable has no literal assignment in that file`),
        ].join("; ")
  );

  if (resolvedTails.length > 0) {
    console.log(`  ${resolvedTails.length} route(s) needed their tail variable resolved to match a declared route:`);
    for (const [shape, v, r] of resolvedTails) {
      console.log(`    - ${shape}  (${v.file}, \${${r.variable}}) -> ${r.expansions.join(" | ")}`);
    }
  }

  // The resolver is the one part of this suite that could mask a real miss: if it invented an
  // expansion that happened to be declared, an undeclared route would pass. So its output is PINNED,
  // not trusted. `/api/cases/:p/:p` must resolve to exactly the three draft actions and nothing else.
  const caseDraftTail = resolvedTails.find(([shape]) => shape === "/api/cases/:p/:p");
  if (caseDraftTail) {
    const expected = [
      "/api/cases/:p/drafts/:p/submit-review",
      "/api/cases/:p/drafts/:p/finalize",
      "/api/cases/:p/drafts/:p/review",
    ].sort();
    const actual = [...caseDraftTail[2].expansions].sort();
    check(
      "the tail resolver's output is pinned, so it cannot mask a miss by inventing an expansion",
      actual.length === expected.length && actual.every((v, i) => v === expected[i]),
      `resolved to ${actual.join(" | ")}`
    );
  }

  // A stale build is its own failure mode: `dist/` is what actually ships, so a route present in the
  // source and absent from the bundle - or the reverse - means the shipped extension is not the
  // extension in the repository.
  const onlyInSrc = [...perTree.src].filter((s) => !perTree.dist.has(s));
  const onlyInDist = [...perTree.dist].filter((s) => !perTree.src.has(s));
  check(
    "the shipped bundle under dist/ calls the same routes as the source",
    onlyInSrc.length === 0 && onlyInDist.length === 0,
    onlyInSrc.length === 0 && onlyInDist.length === 0
      ? `${perTree.src.size} in source, ${perTree.dist.size} in dist, identical sets`
      : `source-only: ${onlyInSrc.join(", ") || "none"}; dist-only: ${onlyInDist.join(", ") || "none"} - dist/ is what ships, so a difference means the shipped extension is not this one`
  );

  // The six paths the product rules name by hand. Asserted individually because these are the ones
  // whose removal would lock every extension user out, and a set comparison that silently changed
  // shape could still pass while one of them vanished.
  for (const critical of [
    "/api/auth/google",
    "/api/auth/send-otp",
    "/api/auth/verify-otp",
    "/api/auth/me",
    "/api/app-config",
  ]) {
    check(
      `sign-in path ${critical} is declared`,
      declared.has(critical),
      declared.has(critical) ? "present" : "MISSING - this locks out every extension user"
    );
  }

  // OTP stays server-side even though the desktop is Google-only. The rule is explicit about it, and
  // the desktop having no call site is exactly why nothing else would notice its removal.
  check(
    "the OTP routes are still declared even though the desktop never calls them",
    declared.has("/api/auth/send-otp") && declared.has("/api/auth/verify-otp"),
    "kept for the hosted admin login; PLAN.md section 2 forbids removing them server-side"
  );
}

// ─── Negative controls on the parsers ───────────────────────────────

check(
  "NEGATIVE CONTROL a route the backend does not declare is detected as missing",
  !declared.has("/api/this/route/certainly/does/not/exist"),
  "a matcher that reported everything as declared would pass the parity check vacuously"
);
// Built by concatenation, not written as a template literal: the interpolation form this is testing
// is exactly what a template literal in this file would try to evaluate.
const interpolatedForm = "/api/cases/" + "${caseId}" + "/timeline";
check(
  "NEGATIVE CONTROL parameter forms normalise to the same shape",
  routeShape(interpolatedForm) === routeShape("/api/cases/:id/timeline") &&
    routeShape("/api/cases/:id/timeline") === "/api/cases/:p/timeline",
  routeShape(interpolatedForm) + " == " + routeShape("/api/cases/:id/timeline")
);
check(
  "NEGATIVE CONTROL a query string and a trailing slash do not change a shape",
  routeShape("/api/tasks/my-open?page=1&limit=25") === "/api/tasks/my-open" &&
    routeShape("/api/tasks/board/") === "/api/tasks/board",
  "so a caller adding a query parameter is not reported as a new route"
);

console.log("");
console.log(`passed: ${passed}  failed: ${failed}`);
if (failed > 0) {
  console.log(`failing checks: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("EXTENSION ROUTE PARITY OK");
