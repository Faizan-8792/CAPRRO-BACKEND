// tools/publish-desktop-release.mjs
//
// Collapses the four independent "levers" that together make a new desktop build actually
// reach users into one command. Before this tool existed, shipping a new installer meant:
//   lever 1: upload the .exe (hostinger-upload-file.mjs)
//   lever 2: hand-edit and upload ca-pro-website/download/latest.json (the public download
//            page's fallback, and what a human reads)
//   lever 3: PATCH + POST /api/app-config/desktop-release via the admin panel (the ONLY thing
//            the running desktop app itself ever reads, at startup and when Security opens)
//   lever 4: minSupportedVersion, folded into lever 3's PATCH
// These are genuinely independent in the backend (see docs/operations-runbook.md's "four
// levers" section) and nothing syncs them automatically. Doing 1-2 without 3 is exactly the
// mistake this tool exists to make impossible: the website looks current, but every already-
// installed app never learns a new build exists, because it only ever reads lever 3.
//
// This tool still requires a human (or an agent acting on the owner's explicit instruction) to
// run it -- it does not fire on a filesystem watcher or a raw file upload. That is deliberate:
// "notify" is the step that announces to every running app, and staying a conscious, one-command
// action (rather than zero actions) is the fix for the gap, not turning it into something with no
// human in the loop at all.
//
//   HOSTINGER_API_TOKEN=<token> CAPRO_SUPER_ADMIN_JWT=<token> node tools/publish-desktop-release.mjs \
//     --exe "D:/path/CA-PRO-Setup-0.1.2.0-x64.exe" \
//     --version 0.1.2 \
//     --notes "Fixes Windows notifications not registering on a clean install." \
//     [--mandatory] [--min-supported-version 0.1.2] [--skip-notify] [--dry-run]
//
// --version is the AppConfig/latest.json style version (e.g. "0.1.2"), independent of whatever
//   4-part version is baked into the .exe's own filename -- the remote filename is always just
//   the local file's own basename, never reconstructed from --version, so there is no risk of
//   uploading an artifact under a name that doesn't match its actual content.
// --skip-notify saves the release as a draft (lever 3's PATCH only) without announcing it to
//   running apps yet -- use this to stage a release for review before publishing it.
// A same-version republish (shipping a bugfix rebuild without bumping the version number, like
//   this project's own 2026-08-31 notification fix) is allowed automatically -- allowRepublish is
//   always sent, since it only changes behavior in exactly that case and is a no-op for a genuine
//   version bump.

import { statSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { uploadFileToHostinger, sha256OfFile } from "./lib/hostinger-files.mjs";

const HOSTINGER_TOKEN = process.env.HOSTINGER_API_TOKEN;
const API_BASE = process.env.CAPRO_API_BASE || "https://api.caprotoolkit.in";
const DOMAIN = process.env.CAPRO_WEBSITE_DOMAIN || "caprotoolkit.in";
const REPO_ROOT = new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const LOCAL_LATEST_JSON = join(REPO_ROOT, "ca-pro-website", "download", "latest.json");

function arg(name, { required = false, flag = false } = {}) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) {
    if (required) {
      console.error(`missing --${name}`);
      process.exit(2);
    }
    return flag ? false : undefined;
  }
  if (flag) return true;
  const v = process.argv[i + 1];
  if (required && !v) {
    console.error(`missing value for --${name}`);
    process.exit(2);
  }
  return v;
}

function readAdminToken() {
  if (process.env.CAPRO_SUPER_ADMIN_JWT) return process.env.CAPRO_SUPER_ADMIN_JWT.trim();
  const envPath = join(REPO_ROOT, "capro-backend", ".env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = /^CAPRO_SUPER_ADMIN_JWT=(.*)$/.exec(line);
      if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    }
  }
  console.error("No admin token. Set CAPRO_SUPER_ADMIN_JWT in the environment or capro-backend/.env.");
  process.exit(2);
}

const exePath = arg("exe", { required: true });
const version = arg("version", { required: true });
const notes = arg("notes", { required: true });
const mandatory = arg("mandatory", { flag: true });
const minSupportedVersion = arg("min-supported-version") || version;
const skipNotify = arg("skip-notify", { flag: true });
const dryRun = arg("dry-run", { flag: true });

const VERSION_PATTERN = /^\d{1,5}(\.\d{1,5}){0,3}$/;
if (!VERSION_PATTERN.test(version)) {
  console.error(`--version must be plain dotted digits (e.g. 0.1.2), got: ${version}`);
  process.exit(2);
}
if (!existsSync(exePath)) {
  console.error(`local installer not found: ${exePath}`);
  process.exit(2);
}
const shaPath = `${exePath}.sha256.txt`;
if (!existsSync(shaPath)) {
  console.error(`sidecar hash file not found (expected next to the installer): ${shaPath}`);
  process.exit(2);
}
if (!HOSTINGER_TOKEN) {
  console.error("HOSTINGER_API_TOKEN is not set.");
  process.exit(2);
}

const exeSize = statSync(exePath).size;
const exeSha256 = sha256OfFile(exePath);
const exeName = basename(exePath);
const adminToken = dryRun ? null : readAdminToken();
const downloadUrl = `https://${DOMAIN}/download/${exeName}`;

console.log("=== plan ===");
console.log(`  installer     : ${exePath}`);
console.log(`  size          : ${exeSize} bytes`);
console.log(`  sha256        : ${exeSha256}`);
console.log(`  version       : ${version}  (minSupportedVersion: ${minSupportedVersion})`);
console.log(`  mandatory     : ${mandatory}`);
console.log(`  downloadUrl   : ${downloadUrl}`);
console.log(`  notes         : ${notes}`);
console.log(`  publish (notify) : ${skipNotify ? "NO - saved as draft only" : "yes"}`);

if (dryRun) {
  console.log("\n--dry-run: stopping before any network call.");
  process.exit(0);
}

function fail(step, detail) {
  console.error(`\nFAILED at ${step}: ${detail}`);
  process.exit(1);
}

// ── lever 1: the installer itself ──────────────────────────────────────────
console.log("\n=== 1. upload the installer ===");
try {
  await uploadFileToHostinger({
    domain: DOMAIN,
    token: HOSTINGER_TOKEN,
    remotePath: `download/${exeName}`,
    filePath: exePath,
    log: (l) => console.log(`  ${l}`),
  });
} catch (err) {
  fail("uploadExe", err.message);
}
console.log("  installer verified live.");

console.log("\n=== 2. upload the sha256 sidecar ===");
try {
  await uploadFileToHostinger({
    domain: DOMAIN,
    token: HOSTINGER_TOKEN,
    remotePath: `download/${basename(shaPath)}`,
    filePath: shaPath,
    log: (l) => console.log(`  ${l}`),
  });
} catch (err) {
  fail("uploadSha", err.message);
}
console.log("  sidecar verified live.");

// ── lever 2: the website's static fallback JSON ────────────────────────────
console.log("\n=== 3. update and upload download/latest.json ===");
const today = new Date().toISOString().slice(0, 10);
const latestJson = {
  asOf: today,
  latestVersion: version,
  minSupportedVersion,
  downloadUrl,
  sha256: exeSha256,
  sizeBytes: exeSize,
  mandatory,
  announcedAt: today,
  releaseNotes: notes,
};
const latestJsonText = `${JSON.stringify(latestJson, null, 2)}\n`;
writeFileSync(LOCAL_LATEST_JSON, latestJsonText, "utf8");
console.log(`  wrote local file: ${LOCAL_LATEST_JSON}`);
try {
  await uploadFileToHostinger({
    domain: DOMAIN,
    token: HOSTINGER_TOKEN,
    remotePath: "download/latest.json",
    content: latestJsonText,
    log: (l) => console.log(`  ${l}`),
  });
} catch (err) {
  fail("uploadLatestJson", err.message);
}
console.log("  latest.json verified live.");

// ── lever 3+4: the AppConfig singleton every running app actually reads ────
console.log("\n=== 4. save the release (PATCH /api/app-config/desktop-release) ===");
const patchRes = await fetch(`${API_BASE}/api/app-config/desktop-release`, {
  method: "PATCH",
  headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    latestVersion: version,
    minSupportedVersion,
    downloadUrl,
    sha256: exeSha256,
    sizeBytes: exeSize,
    releaseNotes: notes,
    mandatory,
    allowRepublish: true,
  }),
});
const patchBody = await patchRes.json().catch(() => null);
if (!patchRes.ok || !patchBody?.ok) {
  fail("patchDesktopRelease", `HTTP ${patchRes.status} ${JSON.stringify(patchBody).slice(0, 400)}`);
}
console.log("  saved:", JSON.stringify(patchBody.desktopRelease, null, 2));

if (skipNotify) {
  console.log("\n=== DONE (saved as draft, not announced) ===");
  console.log("  Run again without --skip-notify (or call notifyDesktopRelease directly) to publish.");
  process.exit(0);
}

console.log("\n=== 5. publish (POST /api/app-config/desktop-release/notify) ===");
const notifyRes = await fetch(`${API_BASE}/api/app-config/desktop-release/notify`, {
  method: "POST",
  headers: { Authorization: `Bearer ${adminToken}` },
});
const notifyBody = await notifyRes.json().catch(() => null);
if (!notifyRes.ok || !notifyBody?.ok) {
  fail("notifyDesktopRelease", `HTTP ${notifyRes.status} ${JSON.stringify(notifyBody).slice(0, 400)}`);
}
console.log("  published:", JSON.stringify(notifyBody.desktopRelease, null, 2));

// ── final read-back, from the same public route every desktop app calls ────
console.log("\n=== 6. confirm what every running app will now see ===");
const publicRes = await fetch(`${API_BASE}/api/app-config`);
const publicBody = await publicRes.json().catch(() => null);
const publicRelease = publicBody?.config?.desktopRelease;
const matches =
  publicRelease?.latestVersion === version &&
  publicRelease?.sha256 === exeSha256 &&
  publicRelease?.announcementId === notifyBody.desktopRelease.announcementId;

console.log(`  GET /api/app-config -> ${publicRes.status}`);
console.log(`  desktopRelease.latestVersion  : ${publicRelease?.latestVersion} (expected ${version})`);
console.log(`  desktopRelease.sha256         : ${publicRelease?.sha256 === exeSha256 ? "matches" : "MISMATCH"}`);
console.log(`  desktopRelease.announcementId : ${publicRelease?.announcementId} (fresh)`);

console.log(`\n=== ${matches ? "PUBLISHED AND CONFIRMED LIVE" : "PUBLISHED BUT READ-BACK DID NOT MATCH - INVESTIGATE"} ===`);
if (matches) {
  console.log(
    "\nEvery already-installed app will show the update banner/toast the next time it starts,\n" +
      "or the next time a user opens Settings > Security -- there is no periodic re-check while\n" +
      "the app stays open (a known, separate gap; see .kiro/finalreleasefix.md U9/PLAN.md section 12.3)."
  );
}
process.exit(matches ? 0 : 1);
