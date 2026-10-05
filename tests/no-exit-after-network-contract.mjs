// tests/no-exit-after-network-contract.mjs
//
// Ledger task V32. A script that makes requests must not end with process.exit().
//
// WHY THIS EXISTS
// ---------------
// On Node 24 under Windows, process.exit() after a fetch() aborts the process with exit code
// 3221226505 (0xC0000409) and "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file
// src\win\async.c, line 76". fetch() makes V8 compile undici's WebAssembly HTTP parser in the
// background the first time a response is parsed, and exiting while that compile is still running
// trips libuv. Measured 2026-10-05, 12 runs each against a loopback stand-in for the endpoint:
// tools/verify-resend-webhook.mjs as committed (process.exit at the end, straight after the last
// response) ended in the crash code 12 of 12 with every check passed; ending with process.exitCode
// instead exited 0 12 of 12. node --liftoff-only, waiting 3 s before the exit, and http.get in place
// of fetch also exit cleanly; --no-wasm-tier-up does not help.
//
// So a gate suite that had PASSED could report a crash, and an operator tool could report a crash
// code for a clean run or hide a failure's real code (the deploy tool's 2 and 1) behind it. Thirty
// files and 72 call sites had the pattern, and every one was fixed by hand; this is what stops the
// next one. The way to end such a script is process.exitCode and a natural end, closing the servers
// and connections it opened - or, to stop a long flow early from inside a helper, an ExitRequest
// (tools/lib/exit-code.mjs).
//
// WHAT IS CHECKED
// ---------------
// Every .mjs/.js/.cjs under tools/, tests/ and scripts/ here, plus the sibling folders listed in
// ROOTS when they are present (the extension's scripts and tests, the repository's own tools). Each
// file is PARSED, not grepped, so a process.exit( inside a comment, a string or a template literal is
// not a finding, and a call spelled process["exit"](1) or imported as `exit` from node:process is.
//
//   makes requests   a call to fetch(), to .listen(), or a `new WebSocket(`; or an import, through
//                    a relative path inside the scanned folders, of a file that does (so a tool that
//                    only imports tools/lib/hostinger-files.mjs is covered). A test that STUBS
//                    globalThis.fetch makes none, and neither does one that reaches the network only
//                    through src/ (src/ is outside the scan).
//   exits early      any process.exit( or process.reallyExit( call, wherever in the file it is. A
//                    process.exit() before the first request is safe in itself, but a helper defined
//                    above the request and called after it is not distinguishable by position, so
//                    the rule is the whole file.
//
// KNOWN LIMITS: an uncaught exception also leaves through Node's exit path, so a script that crashes
// after a fetch can still end in the crash code - that is a failed run either way. src/ runs on
// Linux in production, where the abort does not occur, and is not scanned.
//
// Run: node tests/no-exit-after-network-contract.mjs

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { listSources, scan } from "./helpers/exit-after-network.mjs";

const BACKEND = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(BACKEND, "..");

// `required` roots must exist (a vanished tests/ folder must not read as a clean scan); the others
// belong to sibling folders of the repository, absent when the backend is checked out alone.
const ROOTS = [
  { dir: join(BACKEND, "tools"), required: true },
  { dir: join(BACKEND, "tests"), required: true },
  { dir: join(BACKEND, "scripts"), required: true },
  { dir: join(REPO, "audit-nlp-extension", "scripts"), required: false },
  { dir: join(REPO, "audit-nlp-extension", "tests"), required: false },
  { dir: join(REPO, "audit-nlp-extension", "test-classifier.mjs"), required: false },
  { dir: join(REPO, "tools"), required: false },
  { dir: join(REPO, "__ecosystem-test"), required: false },
  { dir: join(REPO, "design"), required: false },
  { dir: join(REPO, "ca-pro-website", "tools"), required: false },
  { dir: join(REPO, "apps", "desktop-native", "tools"), required: false },
];

// ─── the checks ───────────────────────────────────────────────────────────────────────────────

const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass, detail });
const display = (path) => relative(REPO, path).split(sep).join("/");

// The real tree.
const files = new Map();
const rootsScanned = [];
for (const root of ROOTS) {
  if (!existsSync(root.dir)) {
    if (root.required) check(`required root ${display(root.dir)} exists`, false, "missing - a scan of nothing would read as clean");
    continue;
  }
  const found = listSources(root.dir);
  rootsScanned.push(`${display(root.dir)} (${found.length})`);
  for (const path of found) files.set(path, readFileSync(path, "utf8"));
}
const real = scan(files);

// 43 tools + 104 suites + 2 scripts when this was written; a scan that reads far fewer has lost a
// folder, and "no findings" over a lost folder is the failure this guards against.
const backendFiles = [...files.keys()].filter((path) => path.startsWith(BACKEND + sep)).length;
check(
  "the scan reads the backend's tools, tests and scripts",
  backendFiles >= 120,
  `${backendFiles} backend file(s); every root: ${rootsScanned.join(", ")}`,
);
check("every scanned file parses", real.parseErrors.length === 0, real.parseErrors.map((e) => `${display(e.path)}: ${e.message}`).join("; "));
check(
  "no file that makes requests calls process.exit()",
  real.violations.length === 0,
  real.violations
    .map((v) => `${display(v.path)} - ${v.reason}; exits at line ${v.exits.map((e) => e.line).join(", ")}`)
    .join("\n    "),
);

// The scan must be able to SEE the files it is about: a detector that stopped recognising requests
// would report a clean tree.
const tool = (name) => join(BACKEND, "tools", name);
const suite = (name) => join(BACKEND, "tests", name);
for (const [label, path] of [
  ["a tool that calls fetch() itself", tool("hostinger-deploy-backend.mjs")],
  ["a tool that only imports a helper which fetches", tool("hostinger-upload-file.mjs")],
  ["a tool that reaches Chrome through browser-drive.mjs", tool("verify-admin-mobile.mjs")],
  ["a gate suite that listens and fetches", suite("bulk-actions-e2e.mjs")],
  ["a backend script that fetches", join(BACKEND, "scripts", "launch-campaign.mjs")],
]) {
  check(`positive control: ${label} is seen as making requests`, real.requestMakers.has(path), display(path));
}
for (const [label, path] of [
  ["a suite that only stubs globalThis.fetch", suite("audit-insights-grounding.mjs")],
  ["a tool that reaches the network only through src/", tool("run-insights-fixture.mjs")],
]) {
  check(`negative control: ${label} is not seen as making requests`, existsSync(path) && !real.requestMakers.has(path), display(path));
}

// The detector, on small inputs of its own.
const virtual = (entries) => new Map(Object.entries(entries).map(([name, source]) => [resolve("/virtual", name), source]));
const verdict = (entries) => scan(virtual(entries));
const flagged = (entries) => verdict(entries).violations.length > 0;
const cases = [
  ["fetch() then process.exit()", { "a.mjs": "await fetch('http://x'); process.exit(1);" }, true],
  ["a call through globalThis.fetch", { "a.mjs": "await globalThis.fetch('http://x'); process.exit(0);" }, true],
  ["listen() then process.exit()", { "a.mjs": "const s = app.listen(0); s.close(); process.exit(0);" }, true],
  ["a WebSocket then process.exit()", { "a.mjs": "new WebSocket('ws://x'); process.exit(0);" }, true],
  ["process.exit() in a helper defined above the request", { "a.mjs": "function die() { process.exit(1); }\nawait fetch('http://x');\ndie();" }, true],
  ["a computed process['exit'](1)", { "a.mjs": "await fetch('http://x'); process['exit'](1);" }, true],
  ["process.reallyExit", { "a.mjs": "await fetch('http://x'); process.reallyExit(1);" }, true],
  ["globalThis.process.exit", { "a.mjs": "await fetch('http://x'); globalThis.process.exit(1);" }, true],
  ["exit imported from node:process", { "a.mjs": "import { exit } from 'node:process';\nawait fetch('http://x');\nexit(1);" }, true],
  ["process imported by name", { "a.mjs": "import proc from 'node:process';\nawait fetch('http://x');\nproc.exit(1);" }, true],
  ["exit destructured from process", { "a.mjs": "const { exit } = process;\nawait fetch('http://x');\nexit(1);" }, true],
  ["fetch handed on as a default parameter", { "a.mjs": "async function probe(fetchImpl = fetch) { return fetchImpl('http://x'); }\nawait probe();\nprocess.exit(1);" }, true],
  ["fetch handed on as a property value", { "a.mjs": "await run({ fetchImpl: fetch });\nprocess.exit(1);" }, true],
  ["a request made only by an imported helper", { "a.mjs": "import { go } from './lib/b.mjs';\nawait go();\nprocess.exit(0);", "lib/b.mjs": "export const go = () => fetch('http://x');" }, true],
  ["a request two imports away", { "a.mjs": "import './b.mjs';\nprocess.exit(0);", "b.mjs": "import './c.mjs';", "c.mjs": "await fetch('http://x');" }, true],
  ["a dynamic import of a helper that fetches", { "a.mjs": "await import('./b.mjs');\nprocess.exit(0);", "b.mjs": "await fetch('http://x');" }, true],
  ["a re-export of a helper that fetches", { "a.mjs": "export * from './b.mjs';\nprocess.exit(0);", "b.mjs": "await fetch('http://x');" }, true],
  ["an import cycle that makes requests", { "a.mjs": "import './b.mjs';\nprocess.exit(0);", "b.mjs": "import './a.mjs';\nawait fetch('http://x');" }, true],
  ["process.exitCode and a natural end", { "a.mjs": "await fetch('http://x'); process.exitCode = 1;" }, false],
  ["process.exit() with no request in the file", { "a.mjs": "process.exit(1);" }, false],
  ["process.exit mentioned in a line comment", { "a.mjs": "await fetch('http://x');\n// never process.exit(1) here\nprocess.exitCode = 0;" }, false],
  ["process.exit mentioned in a block comment", { "a.mjs": "await fetch('http://x');\n/* process.exit(1) */\nprocess.exitCode = 0;" }, false],
  ["process.exit inside a string and a template", { "a.mjs": "await fetch('http://x');\nconst a = 'process.exit(1)';\nconst b = `x ${a} process.exit(0)`;" }, false],
  ["a stubbed fetch is not a request", { "a.mjs": "globalThis.fetch = async () => new Response('{}');\nawait run();\nprocess.exit(1);" }, false],
  ["an import of something outside the scanned files", { "a.mjs": "import './elsewhere.mjs';\nprocess.exit(1);" }, false],
  ["a method named fetch on another object", { "a.mjs": "await cache.fetch('k');\nprocess.exit(1);" }, false],
  ["a property named fetch that is not the global", { "a.mjs": "const api = { fetch: 1 };\nconst f = cache.fetch;\nprocess.exit(1);" }, false],
  ["another object's exit()", { "a.mjs": "await fetch('http://x'); worker.exit(1); child.process.exit(0);" }, false],
];
for (const [name, entries, expected] of cases) {
  check(`detector: ${name} ${expected ? "is flagged" : "is not flagged"}`, flagged(entries) === expected);
}
check(
  "detector: a file it cannot parse is reported, not skipped",
  verdict({ "a.mjs": "const = ;" }).parseErrors.length === 1,
);

// The gate fails on a deliberately added process.exit() after a request - on REAL files, so it is the
// repository's own code that is shown to trip it, and on the real helper path.
const mutate = (path, addition) => {
  const copy = new Map(files);
  copy.set(path, `${files.get(path)}\n${addition}\n`);
  return scan(copy);
};
for (const [label, path, addition] of [
  ["a tool that fetches", tool("verify-live-posture.mjs"), "process.exit(0);"],
  ["a gate suite that listens and fetches", suite("bulk-actions-e2e.mjs"), "process.exit(1);"],
  ["a tool whose requests come from a helper", tool("hostinger-upload-file.mjs"), "process.exit(0);"],
  ["a backend script", join(BACKEND, "scripts", "backfill-email-deliveries.mjs"), "process.exit(1);"],
]) {
  const base = files.has(path);
  const result = base ? mutate(path, addition) : { violations: [] };
  const hit = result.violations.some((v) => v.path === path);
  check(`deliberately adding ${addition} to ${label} fails the gate`, base && real.violations.every((v) => v.path !== path) && hit, display(path));
}

// tools/lib/exit-code.mjs, the way a script ends a long flow early without process.exit().
const exitCodeModule = pathToFileURL(join(BACKEND, "tools", "lib", "exit-code.mjs")).href;
const runInChild = (body) =>
  spawnSync(process.execPath, ["--input-type=module", "-e", `import { ExitRequest, runToExitCode } from ${JSON.stringify(exitCodeModule)};\n${body}`], {
    encoding: "utf8",
    timeout: 30_000,
  });
for (const [name, body, code, stderrPart] of [
  ["a main() that returns 0 ends with 0", "await runToExitCode(async () => 0);", 0, ""],
  ["a main() that returns 3 ends with 3", "await runToExitCode(async () => 3);", 3, ""],
  ["a main() that returns nothing leaves the code it set", "await runToExitCode(async () => { process.exitCode = 5; });", 5, ""],
  ["an ExitRequest thrown from a nested helper ends with its code and prints its message", "const stop = () => { throw new ExitRequest(2, 'stopped here'); };\nawait runToExitCode(async () => { stop(); return 0; });", 2, "stopped here"],
  ["an ExitRequest with no message prints nothing", "await runToExitCode(async () => { throw new ExitRequest(4); });", 4, ""],
  ["an unexpected error ends with 1 and is printed, not rethrown", "await runToExitCode(async () => { throw new Error('boom'); });", 1, "boom"],
]) {
  const result = runInChild(body);
  const ok = result.status === code && (stderrPart === "" ? result.stderr.trim() === "" : result.stderr.includes(stderrPart));
  check(`exit-code helper: ${name}`, ok, ok ? "" : `exit ${result.status}, stderr ${JSON.stringify(result.stderr.slice(0, 200))}`);
}

let passed = 0;
for (const entry of checks) {
  if (entry.pass) passed += 1;
  console.log(`[${entry.pass ? "PASS" : "FAIL"}] ${entry.name}${entry.detail ? ` - ${entry.detail}` : ""}`);
}
console.log(`no-exit-after-network-contract: ${passed}/${checks.length} checks passed`);
if (passed !== checks.length) process.exitCode = 1;
