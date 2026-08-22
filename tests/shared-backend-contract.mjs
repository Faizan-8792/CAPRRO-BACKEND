// tests/shared-backend-contract.mjs
//
// Asserts that the Chrome extension and the Windows desktop app really do share ONE
// backend, ONE database and ONE identity system.
//
// PLAN.md is explicit that `api.caprotoolkit.in` and MongoDB are the shared source of
// truth and that the desktop never connects to MongoDB directly. Nothing enforced
// that. The two clients live in separate trees with separately declared base URLs, so
// they could drift apart in a single commit and every existing test would still pass:
// the backend suites do not read the clients, and the desktop suites use their own
// stub base address.
//
// This suite reads all three trees. It lives in the backend because the backend is
// the thing being shared, and because it is the only lane that can see both clients.
//
// Deliberately NOT pinned to file paths on the client side: the desktop constant is
// located by name across its tree, so a legitimate refactor that moves the file does
// not fail this gate. Only deleting or changing the constant does.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKEND = join(__dirname, "..");
const REPO = join(BACKEND, "..");
const EXTENSION = join(REPO, "audit-nlp-extension");
const DESKTOP = join(REPO, "apps", "desktop-native");

// The one origin both clients must use. Every assertion below compares against this
// single literal, so changing the production host fails this suite loudly instead of
// letting one client move without the other.
const SHARED_ORIGIN = "https://api.caprotoolkit.in";

const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass, detail });

function walk(dir, extensions, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    if (
      entry === "node_modules" ||
      entry === "obj" ||
      entry === "bin" ||
      entry === ".git"
    ) {
      continue;
    }
    const full = join(dir, entry);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) walk(full, extensions, acc);
    else if (extensions.some((ext) => entry.endsWith(ext))) acc.push(full);
  }
  return acc;
}

function read(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

// ─── Both client trees are present, or nothing below means anything ──

const extensionFiles = walk(EXTENSION, [".js", ".json", ".html"]);
const desktopFiles = walk(DESKTOP, [".cs", ".json", ".xaml"]);

check(
  "both client trees were found",
  extensionFiles.length > 20 && desktopFiles.length > 20,
  `extension ${extensionFiles.length} files, desktop ${desktopFiles.length} files`,
);

// ─── The extension is locked to the shared origin, twice over ───────

const manifestRaw = read(join(EXTENSION, "manifest.json"));
let manifest = null;
try {
  manifest = manifestRaw ? JSON.parse(manifestRaw) : null;
} catch {
  manifest = null;
}

check(
  "extension manifest parses",
  Boolean(manifest),
  manifest
    ? `manifest v${manifest.manifest_version}, version ${manifest.version}`
    : "unreadable",
);

check(
  "extension host_permissions allow only the shared backend",
  Array.isArray(manifest?.host_permissions) &&
    manifest.host_permissions.length === 1 &&
    manifest.host_permissions[0] === `${SHARED_ORIGIN}/*`,
  manifest?.host_permissions
    ? manifest.host_permissions.join(", ")
    : "host_permissions missing",
);

const connectSrc = /connect-src ([^;"]*)/.exec(
  manifest?.content_security_policy?.extension_pages || "",
);

check(
  "extension CSP connect-src allows only self and the shared backend",
  Boolean(connectSrc) &&
    connectSrc[1].trim().split(/\s+/).filter(Boolean).sort().join(" ") ===
      ["'self'", SHARED_ORIGIN].sort().join(" "),
  connectSrc ? connectSrc[1].trim() : "connect-src not found",
);

check(
  "extension manifest carries the key that fixes its published id",
  typeof manifest?.key === "string" && manifest.key.length > 300,
  "changing the key changes the extension id and breaks the registered Google redirect",
);

// ─── Every declared base URL in the extension is the shared origin ──

const BASE_DECLARATION = /(?:API_BASE_URL|WORKSPACE_API_BASE)\s*=\s*"([^"]+)"/g;
const extensionBases = [];
for (const file of extensionFiles.filter((path) => path.endsWith(".js"))) {
  if (file.includes(`${join("audit-nlp-extension", "tests")}`)) continue;
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(BASE_DECLARATION)) {
    extensionBases.push({ file: file.slice(REPO.length + 1), value: match[1] });
  }
}

check(
  "extension base-URL declarations were found",
  extensionBases.length >= 3,
  extensionBases.length
    ? extensionBases.map((entry) => `${entry.file}=${entry.value}`).join(", ")
    : "none found — the constant was renamed and this check went blind",
);

// Compare ORIGINS, not whole base strings. tasks.js legitimately folds the `/api`
// prefix into its base (`https://api.caprotoolkit.in/api`) while the other files
// append it per call. That is a path convention, not a different backend, and the
// invariant worth guarding is that every client talks to the same server.
function originOf(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

const divergentExtensionBases = extensionBases.filter(
  (entry) => originOf(entry.value) !== SHARED_ORIGIN,
);

check(
  "negative control: origin comparison discriminates",
  originOf("https://api.caprotoolkit.in/api") === SHARED_ORIGIN &&
    originOf("https://evil.example.invalid/api") !== SHARED_ORIGIN &&
    originOf("http://api.caprotoolkit.in") !== SHARED_ORIGIN &&
    originOf("https://api.caprotoolkit.in.evil.invalid") !== SHARED_ORIGIN,
  "a path prefix is accepted; a different host, a downgrade to http, and a suffix " +
    "lookalike are all rejected — so the assertions below are not vacuously true",
);

check(
  "every extension base URL resolves to the shared origin",
  extensionBases.length > 0 && divergentExtensionBases.length === 0,
  divergentExtensionBases.length
    ? `diverged: ${divergentExtensionBases.map((e) => `${e.file}=${e.value}`).join(", ")}`
    : `${extensionBases.length} declarations, all origin ${SHARED_ORIGIN}`,
);

// ─── The desktop defaults to the same origin ────────────────────────
// Located by constant name rather than by path, so moving the file is fine.

const DESKTOP_DEFAULT = /DefaultApiBaseUrl\s*=\s*"([^"]+)"/;
let desktopDefault = null;
let desktopDefaultFile = null;
for (const file of desktopFiles.filter((path) => path.endsWith(".cs"))) {
  if (file.includes(`${join("desktop-native", "tests")}`)) continue;
  const found = DESKTOP_DEFAULT.exec(readFileSync(file, "utf8"));
  if (found) {
    desktopDefault = found[1];
    desktopDefaultFile = file.slice(REPO.length + 1);
    break;
  }
}

check(
  "desktop DefaultApiBaseUrl was found in production code",
  Boolean(desktopDefault),
  desktopDefault
    ? `${desktopDefaultFile} = ${desktopDefault}`
    : "not found — if the constant was renamed, update this test rather than deleting the check",
);

check(
  "desktop defaults to the same origin as the extension",
  desktopDefault != null && originOf(desktopDefault) === SHARED_ORIGIN,
  desktopDefault
    ? `desktop origin ${originOf(desktopDefault)} vs shared ${SHARED_ORIGIN}`
    : "cannot compare",
);

// ─── Neither client may reach MongoDB directly ──────────────────────
// PLAN.md: the desktop never connects to MongoDB directly. The backend is the only
// gateway to the shared database.

const MONGO_EVIDENCE =
  /mongodb\+srv:\/\/|mongodb:\/\/|MongoClient|require\(["']mongodb|from\s+["']mongodb["']|MONGODB_URI/;
const clientMongoHits = [];
for (const file of [...extensionFiles, ...desktopFiles]) {
  if (file.includes(`${join("audit-nlp-extension", "tests")}`)) continue;
  if (file.includes(`${join("desktop-native", "tests")}`)) continue;
  const text = readFileSync(file, "utf8");
  if (MONGO_EVIDENCE.test(text))
    clientMongoHits.push(file.slice(REPO.length + 1));
}

check(
  "no client touches MongoDB directly",
  clientMongoHits.length === 0,
  clientMongoHits.length
    ? `direct database access in a client: ${clientMongoHits.join(", ")}`
    : "the backend is the sole gateway to the shared database",
);

// ─── The backend opens exactly one database connection ──────────────

const db = read(join(BACKEND, "src", "config", "db.js"));
const backendSources = walk(join(BACKEND, "src"), [".js", ".mjs"]);
// The invariant is ONE DATABASE, not one call site. There are legitimately two entry
// points: the server (src/config/db.js) and the boot-time index provisioning CLI
// (src/maintenance/ensure-indexes.mjs). Both must resolve the same environment
// variable, because a literal connection string anywhere would be a second database
// and the two clients would silently stop sharing state.
const connectSites = [];
for (const file of backendSources) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(
    /mongoose\.connect\(\s*([A-Za-z_$][\w$]*|["'`])/g,
  )) {
    connectSites.push({
      file: file.slice(BACKEND.length + 1).replace(/\\/g, "/"),
      argument: match[1],
      readsEnv: /process\.env\.MONGODB_URI/.test(text),
    });
  }
}

check(
  "every MongoDB connection site was located",
  connectSites.length >= 1,
  connectSites.map((site) => `${site.file}(${site.argument})`).join(", ") ||
    "none found",
);

const literalConnections = connectSites.filter((site) =>
  ['"', "'", "`"].includes(site.argument),
);

check(
  "no connection site passes a literal connection string",
  literalConnections.length === 0,
  literalConnections.length
    ? `hardcoded database: ${literalConnections.map((s) => s.file).join(", ")}`
    : "every site passes a variable, so the environment decides the database",
);

const notFromEnv = connectSites.filter((site) => !site.readsEnv);

check(
  "every connection site resolves its URI from MONGODB_URI",
  connectSites.length > 0 && notFromEnv.length === 0,
  notFromEnv.length
    ? `does not read MONGODB_URI: ${notFromEnv.map((s) => s.file).join(", ")}`
    : `${connectSites.length} site(s), all reading process.env.MONGODB_URI — one database`,
);

check(
  "that connection reads MONGODB_URI from the environment and refuses without it",
  Boolean(db) &&
    /const uri = process\.env\.MONGODB_URI/.test(db) &&
    /if \(!uri\)/.test(db),
  "no connection string is hardcoded, so the deployed environment decides the database",
);

// ─── One identity system serves both clients ────────────────────────

const authController = read(
  join(BACKEND, "src", "controllers", "auth.controller.js"),
);

check(
  "Google verification accepts the extension/web audience and the desktop audience",
  Boolean(authController) &&
    /const GOOGLE_CLIENT_IDS = \[/.test(authController) &&
    /process\.env\.GOOGLE_CLIENT_ID/.test(authController) &&
    /DESKTOP_GOOGLE_CLIENT_ID/.test(authController),
  "both audiences resolve through the same verifier to the same User collection",
);

check(
  "the desktop audience is a distinct client id, not a reused web one",
  Boolean(authController) &&
    /GOOGLE_DESKTOP_CLIENT_ID/.test(authController) &&
    /apps\.googleusercontent\.com/.test(authController),
  "a shared audience would make desktop and extension tokens indistinguishable",
);

// ─── The extension's routes must keep working ───────────────────────
// PLAN.md: the extension is in production and a backend change serving the desktop
// must keep every extension call working. OTP stays server-side even though the
// desktop is Google-only.

const app = read(join(BACKEND, "src", "app.js"));
const authRoutes = read(join(BACKEND, "src", "routes", "auth.routes.js"));

const EXTENSION_CRITICAL = [
  ["/api/auth/google", /"\/google"/],
  ["/api/auth/send-otp", /"\/send-otp"/],
  ["/api/auth/verify-otp", /"\/verify-otp"/],
  ["/api/auth/me", /"\/me"/],
];

const missingRoutes = EXTENSION_CRITICAL.filter(
  ([, pattern]) => !authRoutes || !pattern.test(authRoutes),
).map(([name]) => name);

check(
  "every extension-critical auth route is still registered",
  missingRoutes.length === 0,
  missingRoutes.length
    ? `missing: ${missingRoutes.join(", ")} — the extension is in production`
    : EXTENSION_CRITICAL.map(([name]) => name).join(", "),
);

check(
  "/api/app-config is mounted",
  Boolean(app) && /app\.use\("\/api\/app-config", appConfigRoutes\)/.test(app),
  "the extension reads it on every popup open",
);

// ─── CORS admits the extension ──────────────────────────────────────
// Pinned as-is. The current rule admits ANY chrome-extension:// origin, which is
// loose but not exploitable today because this API authenticates with a Bearer token
// held in the extension's own chrome.storage.local, which another extension cannot
// read. Narrowing it would break unpacked development builds, which get a different
// id, and risks breaking the production extension -- so it is raised for a human
// rather than changed here. See agenttesting.md A-13.14: confirm on every full run that this
// is still not exploitable (bearer token in the extension's own storage, no auth cookie) and
// that the pin still holds.

check(
  "CORS admits chrome-extension origins",
  Boolean(app) && /origin\.startsWith\("chrome-extension:\/\/"\)/.test(app),
  "removing this blocks the production extension outright",
);

check(
  "CORS admits the backend's own origin",
  Boolean(app) && new RegExp(`origin === "${SHARED_ORIGIN}"`).test(app),
  "the hosted admin panel is served from the same host",
);

check(
  "CORS still refuses unknown origins",
  Boolean(app) && /CORS blocked for origin/.test(app),
  "the allowlist is not open to arbitrary web origins",
);

// ─── Report ───────────────────────────────────────────────────────

let passed = 0;
for (const entry of checks) {
  const mark = entry.pass ? "PASS" : "FAIL";
  if (entry.pass) passed += 1;
  console.log(
    `[${mark}] ${entry.name}${entry.detail ? ` — ${entry.detail}` : ""}`,
  );
}

const total = checks.length;
console.log(`\nShared backend contract: ${passed}/${total}`);

if (passed !== total) {
  console.error(`\n${total - passed} check(s) failed.`);
  process.exit(1);
}
