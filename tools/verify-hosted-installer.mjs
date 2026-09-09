// Verifies the hosted installer end to end, from the public internet, against the values the
// release announcement actually carries. Run this immediately after uploading the installer.
//
//   node tools/verify-hosted-installer.mjs
//
// Exits 0 only if every check passes. Nothing here trusts a local copy: the file is downloaded
// over HTTPS and hashed as received, because the point is to prove what a customer would get.
import { createHash } from "node:crypto";

// The artefact this run is checking the hosted copy against.
//
// WHY THESE WENT STALE, and why they are now overridable.
// These were hardcoded to one historical build, so every release after it failed REL-sha, REL-size,
// HEAD-size, DL-size and DL-sha - five of ten checks - while the hosted file was in fact correct.
// The one check that mattered (DL-matches-announcement: the bytes a customer receives hash to what
// the release announcement promises, so the client's integrity check passes) went on passing, which
// is how the staleness stayed invisible: the tool looked broken-but-noisy rather than wrong.
//
// The constants stay, because the design is deliberate - the header's own words: "Nothing here
// trusts a local copy". A known-good reference held independently of both the website and the API
// is the whole point; if it were read from the announcement, the tool could only ever agree with
// whatever was published, including a bad publish.
//
// What changed is that a release no longer has to EDIT this file to keep the reference honest:
//   node tools/verify-hosted-installer.mjs --sha <sha256> --size <bytes>
// Passing them is the same act as updating them, minus the chance of forgetting. The defaults below
// are the current release (0.1.16), so an un-argued run still checks something real.
function argValue(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

const EXPECTED_SHA256 = (
  argValue("sha")
  ?? process.env.CAPRO_EXPECTED_INSTALLER_SHA256
  ?? "21a941b9e527c1ce757fdc5b7cd601c2c8b99668321234fd3c82e1c4e1e4903a"
).toLowerCase();
const EXPECTED_SIZE = Number(
  argValue("size") ?? process.env.CAPRO_EXPECTED_INSTALLER_SIZE ?? 65793405,
);

if (!/^[0-9a-f]{64}$/.test(EXPECTED_SHA256) || !Number.isSafeInteger(EXPECTED_SIZE) || EXPECTED_SIZE <= 0) {
  console.error("--sha must be 64 hex characters and --size a positive integer.");
  process.exit(2);
}
const API = "https://api.caprotoolkit.in";

let pass = 0;
let fail = 0;
function check(id, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  PASS ${id}  ${detail}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${id}  ${detail}`);
  }
}

const cb = () => `cb=${Date.now()}-${Math.floor(process.hrtime()[1] / 1000)}`;

console.log("=== 1. what the announced release says the installer is ===");
const cfg = await (
  await fetch(`${API}/api/app-config?${cb()}`, { headers: { "cache-control": "no-cache" } })
).json();
const rel = cfg?.config?.desktopRelease;
if (!rel) {
  console.log("  FAIL  desktopRelease is null - no release is announced, nothing to verify against");
  process.exit(1);
}
console.log(`  latestVersion : ${rel.latestVersion}`);
console.log(`  downloadUrl   : ${rel.downloadUrl}`);
console.log(`  sha256        : ${rel.sha256}`);
console.log(`  sizeBytes     : ${rel.sizeBytes}`);
check("REL-sha", rel.sha256 === EXPECTED_SHA256, "announced sha256 matches the built artefact");
check("REL-size", rel.sizeBytes === EXPECTED_SIZE, "announced sizeBytes matches the built artefact");

console.log("");
console.log("=== 2. HEAD the published URL ===");
const head = await fetch(rel.downloadUrl, { method: "HEAD", redirect: "follow" });
console.log(`  HTTP ${head.status} ${head.statusText}`);
console.log(`  content-type  : ${head.headers.get("content-type")}`);
console.log(`  content-length: ${head.headers.get("content-length")}`);
check("HTTP-ok", head.ok, `the published URL responds ${head.status} (must be 2xx, not 404)`);
if (!head.ok) {
  console.log("");
  console.log("  The installer is not hosted yet. Upload it to:");
  console.log(`    public_html/download/${rel.downloadUrl.split("/").pop()}`);
  console.log(`=== hosted installer: ${pass} passed, ${fail} failed ===`);
  process.exit(1);
}
const clen = Number(head.headers.get("content-length"));
check("HEAD-size", clen === EXPECTED_SIZE, `content-length ${clen} equals ${EXPECTED_SIZE}`);

console.log("");
console.log("=== 3. download the whole file and hash what actually arrives ===");
const started = Date.now();
const res = await fetch(rel.downloadUrl, { redirect: "follow" });
check("GET-ok", res.ok, `GET ${res.status}`);
const buf = Buffer.from(await res.arrayBuffer());
const secs = ((Date.now() - started) / 1000).toFixed(1);
const sha = createHash("sha256").update(buf).digest("hex");
console.log(`  downloaded ${buf.length} bytes in ${secs}s`);
console.log(`  sha256 as received: ${sha}`);
check("DL-size", buf.length === EXPECTED_SIZE, `downloaded size is exactly ${EXPECTED_SIZE}`);
check("DL-sha", sha === EXPECTED_SHA256, "sha256 of the downloaded bytes matches the built artefact");
check(
  "DL-matches-announcement",
  sha === rel.sha256 && buf.length === rel.sizeBytes,
  "the hosted bytes match what the release announcement promises, so the client's integrity check will pass",
);

// A Windows installer starts with the MZ DOS header. If a 404 page or an HTML error were served
// with a 200, this is what would catch it.
const isPe = buf[0] === 0x4d && buf[1] === 0x5a;
check("DL-is-exe", isPe, `first two bytes are ${isPe ? "MZ - a real PE executable" : "NOT MZ - this is not an .exe"}`);

console.log("");
console.log("=== 4. the URL must not have been served from a lookalike host ===");
console.log(`  final URL after redirects: ${res.url}`);
const host = new URL(res.url).hostname.toLowerCase();
check(
  "HOST",
  host === "caprotoolkit.in" || host === "www.caprotoolkit.in",
  `served from ${host}, which is on the allow-list`,
);

console.log("");
console.log(`=== hosted installer: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
