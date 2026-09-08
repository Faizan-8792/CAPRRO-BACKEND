// Checks that the deploy archive path is NOT serving the backend source, against the live site.
//
//   node tools/verify-archive-not-exposed.mjs
//   node tools/verify-archive-not-exposed.mjs --domain api.caprotoolkit.in --remote capro-backend.zip
//   node tools/verify-archive-not-exposed.mjs --archive-file D:/path/capro-backend_<sha>.zip
//
// hostinger-deploy-backend.mjs already runs this check as its own final step and fails the deploy
// if it does not hold, so this exists for the times that is not enough: confirming the state of
// production without deploying, and after a manual or interrupted deploy.
//
// It needs no credential - it asks the internet the same question an attacker would.
//
// Exit codes: 0 safe, 1 exposed or unverifiable.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { assertArchivePathNotExposed } from "./lib/deploy-archive-exposure.mjs";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const domain = arg("domain", "api.caprotoolkit.in");
const remote = arg("remote", "capro-backend.zip");
const archiveFile = arg("archive-file");

let archiveSha256 = null;
if (archiveFile) {
  try {
    archiveSha256 = createHash("sha256").update(readFileSync(archiveFile)).digest("hex");
  } catch (err) {
    console.error(`could not read ${archiveFile}: ${String(err)}`);
    process.exit(1);
  }
}

console.log(`checking https://${domain}/${remote}`);
if (archiveSha256) {
  console.log(`comparing against ${archiveFile}`);
  console.log(`  sha256 ${archiveSha256}`);
}

try {
  const result = await assertArchivePathNotExposed({
    domain,
    remotePath: remote,
    archiveSha256,
    createHash,
    log: (message) => console.log(message),
  });
  console.log("");
  console.log(`SAFE: ${result.reason}`);
  // process.exitCode, not process.exit(). Calling process.exit() here killed the process while
  // undici was still closing the connection this check had just used, and Node aborted with
  // "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" and exit code -1073740791 - so a
  // check that had already printed SAFE looked to its caller like a crash. Setting the code and
  // letting Node finish is the whole fix.
  process.exitCode = 0;
} catch (err) {
  console.error("");
  console.error(String(err).replace(/^Error:\s*/, ""));
  process.exitCode = 1;
}
