// tools/desktop-route-parsers.mjs
//
// The one definition of "which routes does the desktop client call", shared by
// tools/capture-desktop-fixtures.mjs (which captures them) and
// tests/desktop-route-discovery-contract.mjs (which proves none is missed).
//
// WHY THIS IS A MODULE RATHER THAN A PAIR OF FUNCTIONS INSIDE THE TOOL
// -------------------------------------------------------------------
// The tool does live work at module scope -- it connects to Mongo and drops a database -- so nothing
// can import it to reuse its parsers. Two copies of a discovery regex is how a discovery gap gets
// fixed in one place and stays open in the other, and a discovery gap is the worst kind here: the
// tool's own comment says it "reports as completeness", because a route nobody looked for is
// indistinguishable from a route that is fully covered.
//
// THREE CONSTRUCTION FORMS, AND THE THIRD IS WHY THIS FILE EXISTS
// --------------------------------------------------------------
// CaProApiClient.cs builds a request path three ways:
//
//   1. A plain literal in the call:      Authorized(HttpMethod.Get, "api/cases", token)
//   2. An interpolated literal in the call:
//                                        Authorized(HttpMethod.Get, $"api/cases/{id}", token)
//   3. A literal built into a LOCAL first, then passed by name:
//                                        var path = string.Create(culture, $"api/tasks/my-open?...");
//                                        Authorized(HttpMethod.Get, path, token)
//
// Only 1 and 2 were discovered. Measured 2026-08-26: 97 of 107 distinct route literals, leaving
// TEN uncounted -- api/tasks/my-open, api/compliance/calendar,
// api/gst-reconciliation/runs/{runId}/activity, api/auth/google, and five api/imports/* routes,
// which are the GST and TDS import commit paths. `api/tasks/my-open` is the Overview page's own
// endpoint, and its absence from the fixture set is exactly why D13 -- Overview reading the work
// queue total from the wrong level of the response -- survived a drift gate designed to catch that
// class of defect.
//
// Form 3's HTTP verb is INFERRED, and labelled as such: the literal and the HttpMethod are in
// different statements, so the method is taken from the nearest following `HttpMethod.<Verb>` within
// a bounded window. That is good enough for counting and reporting, which is what these routes were
// missing, and it is marked `inferred` so nothing downstream mistakes it for a parsed fact.

/**
 * Collapses every interpolated hole to the identifier that names the value, so a route key is a
 * stable template rather than a snapshot of the C# inside it:
 *
 *   {Uri.EscapeDataString(runId)}          -> {runId}
 *   {Math.Clamp(limit, 1, 100)}            -> {limit}
 *   {string.Join('&', queryParts)}         -> {queryParts}
 *   {Uri.EscapeDataString(id.Trim())}      -> {id}      <- NOT {Trim}
 *
 * The last case is why method names are dropped first. Taking the last identifier outright made a
 * trailing no-argument call the key, so `{Uri.EscapeDataString(batchId.Trim())}` keyed as `{Trim}` -
 * unstable in exactly the way the clamp-bound example warns about, since deleting the `.Trim()`
 * would silently rename the route and orphan any fixture bound to it.
 */
export function normaliseRouteTemplate(route) {
  return String(route).replace(/\{([^}]*)\}/g, (whole, inner) => {
    const text = String(inner);
    // Drop `.Method(` names: they describe how the value was produced, not which value it is.
    const withoutMethodNames = text.replace(/\.\s*[A-Za-z_][A-Za-z0-9_]*\s*\(/g, "(");
    const identifiers = withoutMethodNames.match(/[A-Za-z_][A-Za-z0-9_]*/g);
    if (!identifiers || identifiers.length === 0) return whole;
    return `{${identifiers[identifiers.length - 1]}}`;
  });
}

const STATIC_PATTERN = /(?:Authorized|new HttpRequestMessage)\(\s*HttpMethod\.(\w+),\s*"([^"]+)"/g;
const INTERPOLATED_PATTERN = /(?:Authorized|new HttpRequestMessage)\(\s*HttpMethod\.(\w+),\s*\$"([^"]+)"/g;

// Any `api/...` literal, however it is built. The denominator every parser is measured against.
const ANY_API_LITERAL = /\$?"(api\/[^"]*)"/g;

// How far after an indirectly-built literal to look for its verb. Measured against all ten real
// cases: the largest gap is a conditional expression assigning one of two literals to a local
// before the call, well inside this.
const VERB_SEARCH_WINDOW = 800;

function collect(text, pattern) {
  const seen = new Map();
  for (const match of String(text).matchAll(pattern)) {
    const method = match[1].toUpperCase();
    const path = normaliseRouteTemplate(match[2]);
    seen.set(`${method} ${path}`, { method, path, methodSource: "parsed" });
  }
  return [...seen.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Form 1: a plain literal passed straight to the call. These are the routes a capture can drive
 * without creating an entity first, so they are the ones the fixture tool actually fetches.
 */
export function parseStaticRoutes(text) {
  return collect(text, STATIC_PATTERN);
}

/** Form 2: an interpolated literal passed straight to the call. Needs a real id to drive. */
export function parseInterpolatedRoutes(text) {
  return collect(text, INTERPOLATED_PATTERN);
}

/**
 * Form 3: a literal built into a local and passed by name. Discovered by elimination - every
 * `api/...` literal that neither precise parser matched - with the verb inferred from the nearest
 * following `HttpMethod.<Verb>`.
 */
export function parseIndirectRoutes(text) {
  const source = String(text);
  const parsed = new Set([
    ...parseStaticRoutes(source).map((route) => route.path),
    ...parseInterpolatedRoutes(source).map((route) => route.path),
  ]);

  const seen = new Map();
  for (const match of source.matchAll(ANY_API_LITERAL)) {
    const path = normaliseRouteTemplate(match[1]).replace(/\?.*$/, "");
    if (parsed.has(path) || parsed.has(normaliseRouteTemplate(match[1]))) continue;

    const window = source.slice(match.index, match.index + VERB_SEARCH_WINDOW);
    const verb = /HttpMethod\.(\w+)/.exec(window);
    const method = verb ? verb[1].toUpperCase() : "UNKNOWN";
    seen.set(`${method} ${path}`, { method, path, methodSource: "inferred" });
  }
  return [...seen.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Every distinct `api/...` route template in the file, whichever way it is constructed. This is the
 * denominator: if the three parsers above do not account for all of it, something is uncounted.
 */
export function parseAllRouteLiterals(text) {
  const seen = new Set();
  for (const match of String(text).matchAll(ANY_API_LITERAL)) {
    seen.add(normaliseRouteTemplate(match[1]).replace(/\?.*$/, ""));
  }
  return [...seen].sort();
}
