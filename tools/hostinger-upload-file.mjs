// Upload ONE file to a Hostinger shared-hosting site, at an exact relative path, without
// touching anything else. This is deliberately NOT a website deploy.
//
//   HOSTINGER_API_TOKEN=<token> node tools/hostinger-upload-file.mjs \
//     --domain caprotoolkit.in \
//     --file "D:/path/CA-PRO-Setup-0.1.2.0-x64.exe" \
//     --remote "download/CA-PRO-Setup-0.1.2.0-x64.exe"
//
// WHY THIS EXISTS
// ---------------
// The Hostinger MCP server exposes exactly one write tool, hosting_deployStaticWebsite, and it is
// the wrong instrument for putting a single file on a live site: it uploads an archive and then
// POSTs .../websites/{domain}/deploy, which extracts into the site root. Using it to add one
// installer risks the marketing site, and it cannot see this machine's filesystem anyway - the MCP
// gateway runs its servers in containers with no host mounts.
//
// Reading that server's own source (mcp/api-mcp-server, /app/server.ts) shows the upload and the
// deploy are two independent steps, and that the upload step accepts an ARBITRARY relative path.
// So the surgical operation we actually want is available at the API level even though no MCP tool
// exposes it. That is what this script does: steps 1 and 2, and deliberately not step 3.
//
//   1. GET  /api/hosting/v1/websites?domain=...        -> resolve the account username
//   2. POST /api/hosting/v1/files/upload-urls          -> { url, auth_key, rest_auth_key }
//   3. TUS  POST then PATCH to {url}/{remote}?override=true
//
// The deploy/extract call is never made, so nothing outside the single target path is altered.
//
// SECRET HANDLING: the token is read from the environment and never logged, never written to disk,
// and never included in an error message. Run it with the variable set for one command only.

import { createHash } from "node:crypto";
import { openSync, readSync, closeSync, statSync, existsSync } from "node:fs";

const BASE = process.env.HOSTINGER_API_BASE || "https://developers.hostinger.com";
const TOKEN = process.env.HOSTINGER_API_TOKEN;
const CHUNK = 10 * 1024 * 1024; // matches the reference client

function arg(name, required = true) {
  const i = process.argv.indexOf(`--${name}`);
  const v = i === -1 ? undefined : process.argv[i + 1];
  if (required && !v) {
    console.error(`missing --${name}`);
    process.exit(2);
  }
  return v;
}

const domain = arg("domain");
const filePath = arg("file");
const remotePath = arg("remote").replace(/\\/g, "/").replace(/^\/+/, "");
const dryRun = process.argv.includes("--dry-run");

if (!TOKEN) {
  console.error("HOSTINGER_API_TOKEN is not set. Set it for this one command; it is never stored.");
  process.exit(2);
}
if (!existsSync(filePath)) {
  console.error(`local file not found: ${filePath}`);
  process.exit(2);
}

const size = statSync(filePath).size;

// Hash the exact bytes we are about to send, so the post-upload check compares like with like.
function sha256OfFile(p) {
  const h = createHash("sha256");
  const fd = openSync(p, "r");
  const buf = Buffer.alloc(1024 * 1024);
  let bytes;
  while ((bytes = readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, bytes));
  closeSync(fd);
  return h.digest("hex");
}

const localSha = sha256OfFile(filePath);
console.log("=== local artefact ===");
console.log(`  file   : ${filePath}`);
console.log(`  size   : ${size} bytes`);
console.log(`  sha256 : ${localSha}`);
console.log(`  target : ${domain} :: ${remotePath}`);
if (dryRun) {
  console.log("\n  --dry-run: stopping before any network call.");
  process.exit(0);
}

const authed = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

function fail(step, detail) {
  // Never echo headers - they carry the bearer token.
  console.error(`\nFAILED at ${step}: ${detail}`);
  process.exit(1);
}

console.log("\n=== 1. resolve the hosting account for the domain ===");
const wsRes = await fetch(`${BASE}/api/hosting/v1/websites?domain=${encodeURIComponent(domain)}`, {
  headers: authed,
});
if (!wsRes.ok) fail("resolveUsername", `HTTP ${wsRes.status}`);
const wsBody = await wsRes.json();
const site = (wsBody?.data || []).find((w) => w.domain === domain);
if (!site?.username) fail("resolveUsername", `no site matching ${domain}`);
console.log(`  username      : ${site.username}`);
console.log(`  root_directory: ${site.root_directory}`);

console.log("\n=== 2. request upload credentials ===");
const credRes = await fetch(`${BASE}/api/hosting/v1/files/upload-urls`, {
  method: "POST",
  headers: authed,
  body: JSON.stringify({ username: site.username, domain }),
});
if (!credRes.ok) fail("uploadUrls", `HTTP ${credRes.status} ${(await credRes.text()).slice(0, 300)}`);
const cred = await credRes.json();
const uploadUrl = cred.url || cred?.data?.url;
const authKey = cred.auth_key || cred?.data?.auth_key;
const restKey = cred.rest_auth_key || cred?.data?.rest_auth_key;
if (!uploadUrl || !authKey || !restKey) fail("uploadUrls", "incomplete credentials in response");
console.log(`  upload endpoint acquired (host: ${new URL(uploadUrl).host})`);

const target = `${uploadUrl.replace(/\/$/, "")}/${remotePath}?override=true`;
const tusHeaders = {
  "X-Auth": authKey,
  "X-Auth-Rest": restKey,
  "upload-length": String(size),
  "upload-offset": "0",
};

console.log("\n=== 3. create the upload (TUS) ===");
const createRes = await fetch(target, { method: "POST", headers: tusHeaders, body: "" });
if (createRes.status !== 201) {
  fail("tusCreate", `expected 201, got ${createRes.status} ${(await createRes.text()).slice(0, 300)}`);
}
console.log("  created (201)");

console.log("\n=== 4. send the bytes ===");
const fd = openSync(filePath, "r");
let offset = 0;
try {
  while (offset < size) {
    const len = Math.min(CHUNK, size - offset);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, offset);
    const patch = await fetch(target, {
      method: "PATCH",
      headers: {
        "X-Auth": authKey,
        "X-Auth-Rest": restKey,
        "Content-Type": "application/offset+octet-stream",
        "Upload-Offset": String(offset),
      },
      body: buf,
    });
    if (patch.status !== 204 && patch.status !== 200) {
      fail("tusPatch", `offset ${offset}: HTTP ${patch.status} ${(await patch.text()).slice(0, 200)}`);
    }
    const next = Number(patch.headers.get("upload-offset"));
    offset = Number.isFinite(next) && next > offset ? next : offset + len;
    process.stdout.write(`\r  ${offset}/${size} bytes (${((offset / size) * 100).toFixed(1)}%)`);
  }
} finally {
  closeSync(fd);
}
console.log("\n  upload complete");

console.log("\n=== 5. verify what the public URL now serves ===");
const publicUrl = `https://${domain}/${remotePath}`;
const head = await fetch(`${publicUrl}?cb=${Date.now()}`, { method: "HEAD", redirect: "follow" });
console.log(`  HEAD ${publicUrl} -> ${head.status}, content-length ${head.headers.get("content-length")}`);
if (!head.ok) fail("verify", `the file is not being served (HTTP ${head.status})`);

const got = await fetch(`${publicUrl}?cb=${Date.now()}`, { redirect: "follow" });
const bytes = Buffer.from(await got.arrayBuffer());
const remoteSha = createHash("sha256").update(bytes).digest("hex");

// The MZ check is meaningful for a Windows executable and meaningless for anything else. The first
// version of this script applied it unconditionally, which reported a perfectly good HTML upload as
// a MISMATCH purely because an .html file does not start with "MZ". Scope it to the case it was
// written for: an .exe served as a 200 that is really an HTML error page.
const expectsPe = /\.exe$/i.test(remotePath);
const isPe = bytes[0] === 0x4d && bytes[1] === 0x5a;

console.log(`  downloaded  : ${bytes.length} bytes`);
console.log(`  sha256      : ${remoteSha}`);
console.log(`  size match  : ${bytes.length === size}`);
console.log(`  sha match   : ${remoteSha === localSha}`);
if (expectsPe) {
  console.log(`  MZ header   : ${isPe}`);
} else {
  console.log(`  MZ header   : n/a (not an .exe)`);
}

const ok = bytes.length === size && remoteSha === localSha && (!expectsPe || isPe);
console.log(`\n=== ${ok ? "UPLOAD VERIFIED" : "MISMATCH - investigate before announcing"} ===`);
process.exit(ok ? 0 : 1);
