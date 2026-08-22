// tests/desktop-release-contract.mjs
//
// Verifies the desktop-release announcement pipeline end to end at the contract level:
// the pure validation/version-compare functions in desktop-release.service.js behave
// correctly (BEHAVIOUR half, real imports + node:assert/strict, no MongoDB, no live
// server), and the controller/routes/models/admin-panel wiring that connects those
// functions to an actual super-admin-only save/notify flow has not drifted (WIRING
// half, readFileSync + regex against the real source, no server needed either).
//
// The point of the BEHAVIOUR half is compareVersions and isAllowedDownloadUrl in
// particular: a naive string compare would sort "0.1.10" before "0.1.9", and a naive
// substring/prefix host check would let "caprotoolkit.in.evil.com" or
// "evilcaprotoolkit.in" through. Both are guarded here with a negative control.
//
// The point of the WIRING half is that saving a draft must never itself notify anyone
// (no announcementId/announcedAt write in updateDesktopRelease), only notifyDesktopRelease
// may stamp those, and every one of the three super-only desktop-release routes is both
// authenticated and rate-limited while the two user-facing routes (public root GET,
// dismiss-desktop-update) are not over-restricted. A silent regression in any of these
// is exactly the "rollback announcement reaches every user" or "off-origin download URL
// reaches every user" failure mode this suite exists to catch before it ships.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

process.env.NODE_ENV = process.env.NODE_ENV || "development";
process.env.JWT_SECRET = process.env.JWT_SECRET || "local-verification-only";
process.env.MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/capro-retention-check";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKEND = join(__dirname, "..");

const {
  compareVersions,
  parseVersion,
  isAllowedDownloadUrl,
  validateDesktopReleasePatch,
} = await import("../src/services/desktop-release.service.js");

const model = readFileSync(join(BACKEND, "src", "models", "AppConfig.js"), "utf8");
const userModel = readFileSync(join(BACKEND, "src", "models", "User.js"), "utf8");
const ctrl = readFileSync(
  join(BACKEND, "src", "controllers", "appconfig.controller.js"),
  "utf8"
);
const routes = readFileSync(
  join(BACKEND, "src", "routes", "appconfig.routes.js"),
  "utf8"
);
const app = readFileSync(join(BACKEND, "src", "app.js"), "utf8");
const authCtrl = readFileSync(
  join(BACKEND, "src", "controllers", "auth.controller.js"),
  "utf8"
);
const superJs = readFileSync(join(BACKEND, "public", "admin", "super.js"), "utf8");
const superHtml = readFileSync(join(BACKEND, "public", "admin", "super.html"), "utf8");

// Slices the body of a top-level `export const NAME = ...` up to (but not including)
// the next top-level `export const`, so a check can assert on what one handler's own
// body does or does not contain without accidentally matching a neighbour.
function exportedFunctionBody(source, name) {
  const marker = `export const ${name} =`;
  const start = source.indexOf(marker);
  if (start === -1) return "";
  const rest = source.slice(start);
  const nextIdx = rest.indexOf("\nexport const ", marker.length);
  return nextIdx === -1 ? rest : rest.slice(0, nextIdx);
}

const checks = [];

// WIRING-style check: pass is a plain boolean already computed by the caller
// (regex against real source text), same shape as app-config-checklist.mjs.
function check(name, pass, detail = "") {
  checks.push({ name, pass, detail });
}

// BEHAVIOUR-style check: fn calls the real, imported functions and is expected to
// either return without throwing (pass) or throw (fail, with the assertion's own
// message recorded) -- same error-capturing shape as data-retention-contract.mjs's
// test()/testAsync(), pushed into the same checks[] array so one summary covers both.
function behaviour(name, fn) {
  try {
    fn();
    checks.push({ name, pass: true, detail: "" });
  } catch (error) {
    checks.push({ name, pass: false, detail: `threw: ${error.message}` });
  }
}

// ════════════════════════════════════════════════════════════════════
// BEHAVIOUR — compareVersions
// ════════════════════════════════════════════════════════════════════

behaviour(
  "compareVersions treats 0.1.10 as newer than 0.1.9 (guards against the classic lexicographic-string-compare bug)",
  () => assert.equal(compareVersions("0.1.10", "0.1.9"), 1)
);

behaviour(
  "compareVersions treats 0.1.1 and 0.1.1.0 as equal (trailing zero components pad out, they don't distinguish)",
  () => assert.equal(compareVersions("0.1.1", "0.1.1.0"), 0)
);

behaviour(
  "compareVersions treats 1.0 as newer than 0.9.9 (first component dominates, regardless of component count)",
  () => assert.equal(compareVersions("1.0", "0.9.9"), 1)
);

behaviour(
  "compareVersions treats 0.1.2 as equal to itself",
  () => assert.equal(compareVersions("0.1.2", "0.1.2"), 0)
);

// ════════════════════════════════════════════════════════════════════
// BEHAVIOUR — parseVersion rejects everything that is not plain dotted digits
// ════════════════════════════════════════════════════════════════════

const INVALID_VERSIONS = [
  ["v0.1.2", "a leading 'v' is not plain digits"],
  ["0.1.2-beta", "a pre-release suffix is not plain digits"],
  ["", "an empty string has no digits to parse"],
  [null, "null is not a string at all"],
  ["0.1.-1", "a negative component is not \\d"],
  ["1.2.3.4.5", "five components exceeds the 4-component cap"],
  ["999999", "six digits exceeds the 5-digit-per-component cap"],
];

for (const [input, why] of INVALID_VERSIONS) {
  behaviour(
    `parseVersion(${JSON.stringify(input)}) is null -- ${why}`,
    () => assert.equal(parseVersion(input), null)
  );
}

// ════════════════════════════════════════════════════════════════════
// BEHAVIOUR — isAllowedDownloadUrl: exact-hostname allow-list
// ════════════════════════════════════════════════════════════════════

behaviour(
  "isAllowedDownloadUrl accepts the bare caprotoolkit.in download host",
  () => assert.equal(isAllowedDownloadUrl("https://caprotoolkit.in/download/x.exe"), true)
);

behaviour(
  "isAllowedDownloadUrl accepts the www.caprotoolkit.in download host",
  () => assert.equal(isAllowedDownloadUrl("https://www.caprotoolkit.in/download/x.exe"), true)
);

const REJECTED_DOWNLOAD_URLS = [
  ["http://caprotoolkit.in/x.exe", "plain http is not allowed, only https"],
  [
    "https://caprotoolkit.in.evil.com/x.exe",
    "a suffix-matching lookalike host must not pass an exact allow-list",
  ],
  [
    "https://evilcaprotoolkit.in/x.exe",
    "a prefix-glued lookalike (no separating dot) must not pass either -- this is the shape an " +
      "endsWith()-style host check would wrongly admit even though the substring-suffix shape " +
      "above (caprotoolkit.in.evil.com) would not",
  ],
  ["https://evil.com/x.exe", "an unrelated host is not on the allow-list"],
  [
    "https://user:pw@caprotoolkit.in/x.exe",
    "embedded userinfo on an otherwise-valid host is still refused",
  ],
  ["file:///x.exe", "a non-https scheme is refused even with no host at all"],
  ["javascript:alert(1)", "a script scheme is refused, not merely a non-matching host"],
  ["caprotoolkit.in/x.exe", "a schemeless string is not a parseable URL"],
  ["", "an empty string is refused before any URL parsing is attempted"],
  [null, "null is refused before any URL parsing is attempted"],
];

for (const [input, why] of REJECTED_DOWNLOAD_URLS) {
  behaviour(
    `isAllowedDownloadUrl(${JSON.stringify(input)}) is false -- ${why}`,
    () => assert.equal(isAllowedDownloadUrl(input), false)
  );
}

// ════════════════════════════════════════════════════════════════════
// BEHAVIOUR — validateDesktopReleasePatch
// ════════════════════════════════════════════════════════════════════

behaviour(
  "validateDesktopReleasePatch rejects downloadUrl supplied without sha256 in the same request",
  () => {
    const result = validateDesktopReleasePatch(
      { downloadUrl: "https://caprotoolkit.in/download/x.exe" },
      {}
    );
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
  }
);

behaviour("validateDesktopReleasePatch rejects a 65-char sha256", () => {
  const result = validateDesktopReleasePatch({ sha256: "a".repeat(65) }, {});
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
});

behaviour("validateDesktopReleasePatch rejects a 63-char sha256", () => {
  const result = validateDesktopReleasePatch({ sha256: "a".repeat(63) }, {});
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
});

// NOTE: the service lower-cases sha256 BEFORE testing it against the hex pattern
// (`body.sha256.toLowerCase()` runs first, see desktop-release.service.js), so a
// well-formed 64-char uppercase hex string is normalized and ACCEPTED, not rejected.
// This deliberately documents the real behaviour rather than the length-only intuition
// ("reject anything uppercase") that a first read of the field might suggest.
behaviour(
  "validateDesktopReleasePatch NORMALIZES (does not reject) a well-formed uppercase sha256, because it lower-cases before matching the hex pattern",
  () => {
    const upper = "AB".repeat(32); // 64 chars, valid hex, all uppercase
    const result = validateDesktopReleasePatch({ sha256: upper }, {});
    assert.equal(result.ok, true);
    assert.equal(result.update["desktopRelease.sha256"], upper.toLowerCase());
  }
);

behaviour("validateDesktopReleasePatch rejects sizeBytes of 0", () => {
  const result = validateDesktopReleasePatch({ sizeBytes: 0 }, {});
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
});

behaviour("validateDesktopReleasePatch rejects sizeBytes of -1", () => {
  const result = validateDesktopReleasePatch({ sizeBytes: -1 }, {});
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
});

behaviour("validateDesktopReleasePatch rejects sizeBytes of 1e12 (over the 500MB cap)", () => {
  const result = validateDesktopReleasePatch({ sizeBytes: 1e12 }, {});
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
});

behaviour(
  "validateDesktopReleasePatch rejects sizeBytes sent as the string '95420416' -- it must be a number, not a numeric string",
  () => {
    const result = validateDesktopReleasePatch({ sizeBytes: "95420416" }, {});
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
  }
);

behaviour(
  "validateDesktopReleasePatch rejects releaseNotes of 4001 characters",
  () => {
    const result = validateDesktopReleasePatch({ releaseNotes: "x".repeat(4001) }, {});
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
  }
);

behaviour(
  "validateDesktopReleasePatch rejects a minSupportedVersion newer than latestVersion",
  () => {
    const result = validateDesktopReleasePatch(
      { latestVersion: "0.1.5", minSupportedVersion: "0.2.0" },
      {}
    );
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
  }
);

behaviour(
  "validateDesktopReleasePatch returns 409 VERSION_NOT_NEWER for a lower version than the one already published",
  () => {
    const result = validateDesktopReleasePatch(
      { latestVersion: "0.1.5" },
      { latestVersion: "0.1.6" }
    );
    assert.equal(result.ok, false);
    assert.equal(result.status, 409);
    assert.equal(result.code, "VERSION_NOT_NEWER");
  }
);

behaviour(
  "validateDesktopReleasePatch returns 409 VERSION_NOT_NEWER for an equal version without allowRepublish",
  () => {
    const result = validateDesktopReleasePatch(
      { latestVersion: "0.1.6" },
      { latestVersion: "0.1.6" }
    );
    assert.equal(result.ok, false);
    assert.equal(result.status, 409);
    assert.equal(result.code, "VERSION_NOT_NEWER");
  }
);

behaviour(
  "validateDesktopReleasePatch returns ok for an equal version WITH allowRepublish:true",
  () => {
    const result = validateDesktopReleasePatch(
      { latestVersion: "0.1.6", allowRepublish: true },
      { latestVersion: "0.1.6" }
    );
    assert.equal(result.ok, true);
  }
);

behaviour(
  "validateDesktopReleasePatch returns ok for any strictly greater version",
  () => {
    const result = validateDesktopReleasePatch(
      { latestVersion: "0.1.7" },
      { latestVersion: "0.1.6" }
    );
    assert.equal(result.ok, true);
  }
);

// ════════════════════════════════════════════════════════════════════
// WIRING — AppConfig.js desktopRelease sub-document
// ════════════════════════════════════════════════════════════════════

const desktopBlockStart = model.indexOf("desktopRelease: {");
const desktopBlockEnd = model.indexOf("featureFlags: {", desktopBlockStart);
const desktopBlock =
  desktopBlockStart === -1 || desktopBlockEnd === -1
    ? ""
    : model.slice(desktopBlockStart, desktopBlockEnd);

const DESKTOP_RELEASE_FIELDS = [
  "latestVersion",
  "minSupportedVersion",
  "downloadUrl",
  "releaseNotes",
  "mandatory",
  "announcementId",
  "announcedAt",
  "sha256",
  "sizeBytes",
  "enabled",
  "updatedAt",
];

for (const field of DESKTOP_RELEASE_FIELDS) {
  check(
    `AppConfig.js desktopRelease sub-document declares field '${field}'`,
    new RegExp(`\\b${field}:\\s*\\{`).test(desktopBlock),
    "desktopRelease must carry exactly the fields the controller and UI read/write"
  );
}

check(
  "AppConfig.js desktopRelease.enabled defaults to false",
  /enabled:\s*\{\s*type:\s*Boolean,\s*default:\s*false\s*\}/.test(desktopBlock),
  "A cold/pre-existing singleton must read as 'nothing announced', never as 'update required'"
);

// ════════════════════════════════════════════════════════════════════
// WIRING — appconfig.controller.js exports and guards
// ════════════════════════════════════════════════════════════════════

for (const name of [
  "updateDesktopRelease",
  "notifyDesktopRelease",
  "getDesktopReleaseDraft",
  "dismissDesktopUpdate",
]) {
  check(
    `appconfig.controller.js exports ${name}`,
    new RegExp(`export const ${name}\\s*=`).test(ctrl),
    "The route file imports these four by name; a rename here breaks the import silently at runtime"
  );
}

const updateBody = exportedFunctionBody(ctrl, "updateDesktopRelease");
const notifyBody = exportedFunctionBody(ctrl, "notifyDesktopRelease");
const draftBody = exportedFunctionBody(ctrl, "getDesktopReleaseDraft");
const dismissBody = exportedFunctionBody(ctrl, "dismissDesktopUpdate");
const getAppConfigBody = exportedFunctionBody(ctrl, "getAppConfig");

for (const [name, body] of [
  ["updateDesktopRelease", updateBody],
  ["notifyDesktopRelease", notifyBody],
  ["getDesktopReleaseDraft", draftBody],
]) {
  check(
    `${name} calls assertSuper(req.user) before doing anything else super-only`,
    /assertSuper\(req\.user\)/.test(body),
    "Only the super admin may save a draft, notify, or read the draft"
  );
}

check(
  "dismissDesktopUpdate does NOT call assertSuper (it is an ordinary authenticated user action, not super-only)",
  !/assertSuper\(req\.user\)/.test(dismissBody),
  "Every signed-in user must be able to dismiss a non-mandatory update for themselves"
);

check(
  "getAppConfig's returned config object contains a desktopRelease key",
  /desktopRelease:\s*publishableDesktopRelease\(cfg\.desktopRelease\)/.test(getAppConfigBody),
  "Desktop and extension clients read this key on the public route to detect an update"
);

check(
  "updateDesktopRelease's own body never writes desktopRelease.announcementId (saving a draft must never announce it)",
  !updateBody.includes("desktopRelease.announcementId"),
  "Saving is not announcing -- a draft can be revised any number of times before notify"
);

check(
  "updateDesktopRelease's own body never writes desktopRelease.announcedAt",
  !updateBody.includes("desktopRelease.announcedAt"),
  "Same guarantee as announcementId: no timestamp is stamped by a mere save"
);

check(
  "notifyDesktopRelease's own body DOES write desktopRelease.announcementId",
  notifyBody.includes("desktopRelease.announcementId"),
  "This is the one route allowed to make a draft visible to every client"
);

check(
  "notifyDesktopRelease stamps announcementId with a UUID generator, not an operator-supplied value",
  notifyBody.includes("randomUUID()"),
  "An operator-typed id could re-notify everyone (id reused) or silently notify nobody (id malformed)"
);

check(
  "dismissDesktopUpdate refuses to dismiss when the release is mandatory (MANDATORY_UPDATE)",
  dismissBody.includes("MANDATORY_UPDATE"),
  "A required update cannot be server-side dismissed"
);

// ════════════════════════════════════════════════════════════════════
// WIRING — appconfig.routes.js: auth + rate-limit placement
// ════════════════════════════════════════════════════════════════════

check(
  "GET /desktop-release is authRequired + superLimiter (super-only draft read)",
  /router\.get\(\s*["']\/desktop-release["']\s*,\s*authRequired\s*,\s*superLimiter\s*,\s*getDesktopReleaseDraft\s*\)/.test(
    routes
  )
);

check(
  "PATCH /desktop-release is authRequired + superLimiter (super-only draft save)",
  /router\.patch\(\s*["']\/desktop-release["']\s*,\s*authRequired\s*,\s*superLimiter\s*,\s*updateDesktopRelease\s*\)/.test(
    routes
  )
);

check(
  "POST /desktop-release/notify is authRequired + superLimiter (super-only announce)",
  /router\.post\(\s*["']\/desktop-release\/notify["']\s*,\s*authRequired\s*,\s*superLimiter\s*,\s*notifyDesktopRelease\s*\)/.test(
    routes
  )
);

check(
  "POST /dismiss-desktop-update is authRequired but carries NO superLimiter (ordinary user action)",
  /router\.post\(\s*["']\/dismiss-desktop-update["']\s*,\s*authRequired\s*,\s*dismissDesktopUpdate\s*\)/.test(
    routes
  ),
  "A rate-limiter meant for the super admin's few requests would be wrong here -- every user hits this"
);

check(
  "the public root GET / carries neither authRequired nor superLimiter",
  /router\.get\(\s*["']\/["']\s*,\s*getAppConfig\s*\)/.test(routes),
  "A logged-out client must be able to detect maintenance and a pending desktop update"
);

// ════════════════════════════════════════════════════════════════════
// WIRING — User.js + auth.controller.js
// ════════════════════════════════════════════════════════════════════

check(
  "User.js declares desktopUpdateSeenAnnouncementId defaulting to null",
  /desktopUpdateSeenAnnouncementId:\s*\{\s*type:\s*String,\s*default:\s*null,?\s*\}/.test(
    userModel
  ),
  "Persists which announcement a user has dismissed across logout/reinstall"
);

// Counted per LINE, not per raw substring match: the response-echo lines spell the
// identifier twice on one line (`desktopUpdateSeenAnnouncementId: user.desktopUpdateSeenAnnouncementId
// || null,`), which a global-regex occurrence count would double-count to 6. Four
// SOURCE LINES is the real, stable shape: one .select() string and one echo line per
// handler, times the two handlers (getMe and updateMe) that expose it.
const authCtrlMentionLines = authCtrl
  .split("\n")
  .filter((line) => line.includes("desktopUpdateSeenAnnouncementId")).length;
check(
  `auth.controller.js mentions desktopUpdateSeenAnnouncementId on exactly 4 source lines (got ${authCtrlMentionLines})`,
  authCtrlMentionLines === 4,
  "Two response shapes (getMe and updateMe), each selecting the field and echoing it back"
);

// ════════════════════════════════════════════════════════════════════
// WIRING — app.js CORS (depends on U11 having landed; report honestly if not)
// ════════════════════════════════════════════════════════════════════

check(
  "app.js allows the https://caprotoolkit.in origin via an exact-string allow-list (MARKETING_SITE_ORIGINS.includes), not a prefix/substring match",
  /MARKETING_SITE_ORIGINS\s*=\s*Object\.freeze\(\[\s*["']https:\/\/caprotoolkit\.in["']/.test(app) &&
    /MARKETING_SITE_ORIGINS\.includes\(origin\)/.test(app),
  "This is the download page's read access to GET /api/app-config; it depends on the U11 CORS change"
);

check(
  "app.js contains no .startsWith(\"https://caprotoolkit) match for that origin",
  !/startsWith\(\s*["']https:\/\/caprotoolkit/.test(app),
  "A prefix match would also admit the lookalike \"https://caprotoolkit.in.evil.com\""
);

// ════════════════════════════════════════════════════════════════════
// WIRING — admin panel: super.html ids + super.js notify gating (depends on U5)
// ════════════════════════════════════════════════════════════════════

const DESKTOP_RELEASE_PANEL_IDS = [
  "desktopLatestVersion",
  "desktopMinSupportedVersion",
  "desktopDownloadUrl",
  "desktopSha256",
  "desktopSizeBytes",
  "desktopReleaseNotes",
  "desktopMandatory",
  "desktopEnabled",
  "saveDesktopReleaseBtn",
  "notifyDesktopReleaseBtn",
  "desktopReleaseStatus",
  "desktopReleaseLive",
];

for (const id of DESKTOP_RELEASE_PANEL_IDS) {
  check(
    `super.html carries id="${id}"`,
    new RegExp(`id=["']${id}["']`).test(superHtml),
    "The admin panel's desktop-release card depends on this exact id"
  );
}

check(
  "super.js posts to /app-config/desktop-release/notify",
  /\/app-config\/desktop-release\/notify/.test(superJs)
);

check(
  "super.js gates that notify POST behind a window.confirm or window.prompt call earlier in the same handler",
  (() => {
    const idx = superJs.indexOf("/app-config/desktop-release/notify");
    if (idx === -1) return false;
    // Look back a generous window for the handler's own start, not the whole file,
    // so this cannot pass merely because SOME confirm/prompt exists anywhere above.
    const before = superJs.slice(Math.max(0, idx - 1500), idx);
    return /window\.confirm\(/.test(before) || /window\.prompt\(/.test(before);
  })(),
  "A rollback/re-announce click must require typed operator confirmation before the network call fires"
);

// ─── Print ─────────────────────────────────────────────────────────
console.log("\n=== DESKTOP RELEASE CONTRACT VERIFICATION ===\n");
const passed = checks.filter((c) => c.pass).length;
const failed = checks.filter((c) => !c.pass).length;

checks.forEach((c, i) => {
  const icon = c.pass ? "[PASS]" : "[FAIL]";
  console.log(`${i + 1}. ${icon} ${c.name}`);
  if (c.detail) console.log(`        ${c.detail}`);
});

console.log(`\nResult: ${passed} passed, ${failed} failed (out of ${checks.length})\n`);

if (failed === 0) {
  console.log("ALL CHECKS PASSED. Desktop-release save/notify/dismiss contract is sound.\n");
} else {
  process.exit(1);
}
