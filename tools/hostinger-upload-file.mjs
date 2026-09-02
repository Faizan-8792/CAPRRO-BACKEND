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
// The actual upload+verify logic lives in tools/lib/hostinger-files.mjs, shared with
// publish-desktop-release.mjs, so there is one implementation of "upload one file and prove the
// public URL now serves exactly those bytes", not two that could drift apart.
//
// SECRET HANDLING: the token is read from the environment and never logged, never written to disk,
// and never included in an error message. Run it with the variable set for one command only.

import { uploadFileToHostinger, sha256OfFile } from "./lib/hostinger-files.mjs";
import { statSync, existsSync } from "node:fs";

const TOKEN = process.env.HOSTINGER_API_TOKEN;

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

try {
  console.log("\n=== uploading and verifying ===");
  const result = await uploadFileToHostinger({
    domain,
    token: TOKEN,
    remotePath,
    filePath,
    log: (line) => console.log(line),
  });
  console.log(`\n  HEAD ${result.publicUrl} -> served, content-length ${result.size}`);
  console.log("\n=== UPLOAD VERIFIED ===");
  process.exit(0);
} catch (err) {
  console.error(`\nFAILED: ${err.message}`);
  console.log("\n=== MISMATCH - investigate before announcing ===");
  process.exit(1);
}
