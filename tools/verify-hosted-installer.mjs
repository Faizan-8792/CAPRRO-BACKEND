// Verifies the hosted installer end to end, from the public internet, against the values the
// release announcement actually carries. Run this immediately after uploading the installer.
//
//   node tools/verify-hosted-installer.mjs
//
// Exits 0 only if every check passes. Nothing here trusts a local copy: the file is downloaded
// over HTTPS and hashed as received, because the point is to prove what a customer would get.
import { createHash } from "node:crypto";

const EXPECTED_SHA256 = "9e2f4a8a9141a3f5b406b9d1f3b9c5846185302b92fc8efd4cb4dbf49f04855e";
const EXPECTED_SIZE = 65681189;
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
