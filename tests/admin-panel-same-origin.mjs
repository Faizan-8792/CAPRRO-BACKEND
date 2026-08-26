// tests/admin-panel-same-origin.mjs
//
// Pins that every script this server SERVES talks to this server, not to a hardcoded
// api.caprotoolkit.in.
//
// WHY THIS EXISTS
// ---------------
// All six scripts under public/ declared an ABSOLUTE production API base:
//
//   public/admin/super.js       const API_BASE      = "https://api.caprotoolkit.in/api"
//   public/admin/admin.js       const API_BASE      = "https://api.caprotoolkit.in/api"
//   public/admin/login.js       const API_BASE      = "https://api.caprotoolkit.in/api"
//   public/admin/admin-tasks.js const TASK_API_BASE = "https://api.caprotoolkit.in/api"
//   public/admin/compliance-assistant/assistant.js
//                               const API_BASE      = "https://api.caprotoolkit.in/api"
//   public/unsubscribe.js       const API_BASE      = "https://api.caprotoolkit.in/api"
//
// app.js serves public/ and public/admin from the API host itself, so in production the absolute
// base and a relative "/api" hit exactly the same endpoints. Off that host they do not: ANY copy of
// these pages - a local server, a staging host, a mirror, a file:// copy - drove PRODUCTION. For
// super.html, which can overwrite production feature flags and notify every installed desktop app,
// an operator opening a local copy to try something would have mutated production with no hint that
// it was not local. It is also why the panel's browser gates could only ever be run against
// production, which is why several of them sat unrun.
//
// WHAT IS DELIBERATELY OUT OF SCOPE
// ---------------------------------
// The Chrome extension. It runs on a chrome-extension:// origin, so a relative path there resolves
// inside the extension package and reaches no server at all: its bases MUST be absolute. This suite
// asserts that too, in the opposite direction, so a later reader cannot "make it consistent" by
// applying this rule to the extension and breaking it. tests/shared-backend-contract.mjs owns the
// extension's own base-URL invariant.
//
// USAGE
//   node tests/admin-panel-same-origin.mjs
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND = join(HERE, "..");
const PUBLIC = join(BACKEND, "public");
const EXTENSION = join(BACKEND, "..", "audit-nlp-extension");
const SERVED_HOST = "api.caprotoolkit.in";

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

function jsFilesUnder(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "node_modules") continue;
        walk(full);
      } else if (entry.endsWith(".js") || entry.endsWith(".mjs")) {
        found.push(full);
      }
    }
  };
  walk(root);
  return found;
}

// Matches any `const <NAME>_BASE... = "<value>"` style declaration, however the name is spelled, so
// renaming the constant cannot make this check go blind.
const BASE_DECLARATION = /(?:const|let|var)\s+([A-Za-z_$][\w$]*(?:API|BASE|URL)[\w$]*)\s*=\s*["'`]([^"'`]*)["'`]/g;

console.log("admin panel / served scripts: same-origin API base");
console.log("");

const servedFiles = jsFilesUnder(PUBLIC);
check(
  "served scripts were found under public/",
  servedFiles.length >= 6,
  `${servedFiles.length} file(s)`
);

// ─── 1. No served script declares an absolute base ──────────────────

const absoluteDeclarations = [];
const relativeDeclarations = [];
for (const file of servedFiles) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(BASE_DECLARATION)) {
    const [, name, value] = match;
    const record = { file: relative(BACKEND, file).split(sep).join("/"), name, value };
    if (/^https?:\/\//i.test(value)) absoluteDeclarations.push(record);
    else if (value.startsWith("/")) relativeDeclarations.push(record);
  }
}

check(
  "no served script declares an absolute http(s) API base",
  absoluteDeclarations.length === 0,
  absoluteDeclarations.length
    ? absoluteDeclarations.map((d) => `${d.file}:${d.name}=${d.value}`).join(", ")
    : "0 absolute declarations"
);

check(
  "the served scripts do declare relative bases, so the matcher is not simply finding nothing",
  relativeDeclarations.length >= 6,
  relativeDeclarations.map((d) => `${d.file}:${d.name}=${d.value}`).join(", ")
);

// Negative control on the matcher itself. Without this, a regex that silently stopped matching
// would report a clean pass over a file full of absolute bases.
const syntheticAbsolute = 'const API_BASE = "https://api.caprotoolkit.in/api";';
const syntheticMatches = [...syntheticAbsolute.matchAll(BASE_DECLARATION)];
check(
  "NEGATIVE CONTROL the matcher still recognises an absolute base",
  syntheticMatches.length === 1 && /^https:\/\//.test(syntheticMatches[0][2]),
  syntheticMatches.length ? `matched ${syntheticMatches[0][2]}` : "matched nothing"
);

const syntheticRelative = 'const API_BASE = "/api";';
check(
  "NEGATIVE CONTROL the matcher recognises a relative base as relative",
  [...syntheticRelative.matchAll(BASE_DECLARATION)].some(
    (match) => !/^https?:\/\//i.test(match[2])
  ),
  "relative form is classified as relative"
);

// ─── 2. No served script fetches the production host directly ───────

const directHostUses = [];
for (const file of servedFiles) {
  const text = readFileSync(file, "utf8");
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.includes(SERVED_HOST)) return;
    // A comment naming the host is documentation, not a request.
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
    directHostUses.push(`${relative(BACKEND, file).split(sep).join("/")}:${index + 1}`);
  });
}

check(
  `no served script names ${SERVED_HOST} outside a comment`,
  directHostUses.length === 0,
  directHostUses.length ? directHostUses.join(", ") : "0 occurrences"
);

// ─── 3. The unsubscribe page and its API keep one base ──────────────
// The digest email links a static page and an API endpoint. If those two were ever built from
// different bases, the page would load from one origin and post to another, and the relative base
// in unsubscribe.js would then be wrong. This pins that they come from the same constant.

const digestService = readFileSync(join(BACKEND, "src", "services", "digest.service.js"), "utf8");
const pageLine = /pageUrl:\s*`\$\{(\w+)\}\/unsubscribe\.html/.exec(digestService);
const apiLine = /apiUrl:\s*`\$\{(\w+)\}\/api\/digests\/unsubscribe/.exec(digestService);
check(
  "the unsubscribe page and its API are built from the same base constant",
  Boolean(pageLine) && Boolean(apiLine) && pageLine[1] === apiLine[1],
  pageLine && apiLine ? `${pageLine[1]} / ${apiLine[1]}` : "one of the two lines was not found"
);

// ─── 4. The extension must stay ABSOLUTE, for the opposite reason ───

if (!existsSync(EXTENSION)) {
  check(
    "extension checkout present for the opposite-direction assertion",
    false,
    "audit-nlp-extension is not checked out; run git submodule update --init"
  );
} else {
  const extensionFiles = jsFilesUnder(EXTENSION).filter(
    (file) => !file.includes(`${sep}tests${sep}`) && !file.includes(`${sep}node_modules${sep}`)
  );
  const extensionBases = [];
  for (const file of extensionFiles) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/(?:API_BASE_URL|WORKSPACE_API_BASE|TASK_API_BASE)\s*=\s*"([^"]+)"/g)) {
      extensionBases.push({ file: relative(EXTENSION, file).split(sep).join("/"), value: match[1] });
    }
  }
  check(
    "extension base declarations were found",
    extensionBases.length >= 3,
    `${extensionBases.length} declaration(s)`
  );
  const relativeInExtension = extensionBases.filter((entry) => !/^https?:\/\//i.test(entry.value));
  check(
    "every extension base stays ABSOLUTE, because a relative path on chrome-extension:// reaches no server",
    relativeInExtension.length === 0,
    relativeInExtension.length
      ? relativeInExtension.map((entry) => `${entry.file}=${entry.value}`).join(", ")
      : `${extensionBases.length} absolute, 0 relative`
  );
}

console.log("");
console.log(`passed: ${passed}  failed: ${failed}`);
if (failed > 0) {
  console.log(`failing checks: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("ADMIN PANEL SAME-ORIGIN OK");
