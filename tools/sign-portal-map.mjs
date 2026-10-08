#!/usr/bin/env node
// Signs a GST downloader portal map OFFLINE, on the owner's machine (GD28; plan section 8.12).
//
// The private key never sits on Hostinger, and never inside either repository: this tool refuses
// to write or read one anywhere under the CA PRO checkout, so it cannot be committed or swept into
// a deploy archive. Only the public half travels - into GST_PORTAL_MAP_PUBLIC_KEY on the server,
// and into the extension, which verifies every version again before using it (GD29).
//
//   node tools/sign-portal-map.mjs keygen --out <folder outside the repository>
//       Creates <folder>/portal-map-signing-key.pem (never overwrites one) and prints the public
//       key to configure.
//
//   node tools/sign-portal-map.mjs sign --key <pem> --map <map.json> --out <request.json> [--notes "..."]
//       Writes the body for POST /api/super/gst-portal-map: { version, content, signature, notes }.
//       `content` is the map as compact JSON - the exact text that is signed and later verified.
//
//   node tools/sign-portal-map.mjs verify --public <base64> --request <request.json>
//       Checks a request the way the server will, before it is sent.

import crypto from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPortalMapSubmission, portalMapPublicKey } from "../src/services/portal-map.service.js";

const BACKEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The parent checkout holds this repository as a submodule; a key anywhere under it is refused.
const CHECKOUT_ROOT = resolve(BACKEND_ROOT, "..");
const KEY_FILE = "portal-map-signing-key.pem";

function fail(message) {
  console.error(`sign-portal-map: ${message}`);
  process.exit(1);
}

function argsOf(list) {
  const out = {};
  for (let index = 0; index < list.length; index += 1) {
    const name = list[index];
    if (!name.startsWith("--")) fail(`unexpected argument ${JSON.stringify(name)}`);
    const value = list[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`${name} needs a value`);
    out[name.slice(2)] = value;
    index += 1;
  }
  return out;
}

function insideCheckout(target) {
  const rel = relative(CHECKOUT_ROOT, resolve(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function refuseKeyInsideCheckout(target, what) {
  if (insideCheckout(target)) {
    fail(`${what} ${resolve(target)} is inside the CA PRO checkout. A signing key must live outside it, where nothing can commit or deploy it.`);
  }
}

// The public half as the 32 raw bytes in base64, from either half of the pair.
function publicKeyText(keyObject) {
  const publicKey = keyObject.type === "public" ? keyObject : crypto.createPublicKey(keyObject);
  const jwk = publicKey.export({ format: "jwk" });
  return Buffer.from(jwk.x, "base64url").toString("base64");
}

function keygen(options) {
  if (!options.out) fail("keygen needs --out <folder outside the repository>");
  refuseKeyInsideCheckout(options.out, "The folder");
  if (!existsSync(options.out)) fail(`${resolve(options.out)} does not exist`);
  const keyPath = join(options.out, KEY_FILE);
  if (existsSync(keyPath)) fail(`${keyPath} already exists; a signing key is never overwritten`);
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  writeFileSync(keyPath, privateKey.export({ format: "pem", type: "pkcs8" }), { flag: "wx", mode: 0o600 });
  console.log(`Private key written to ${keyPath} - keep it offline and backed up; it never goes to the server.`);
  console.log(`Public key (GST_PORTAL_MAP_PUBLIC_KEY on the server, and the extension's bundled key):`);
  console.log(publicKeyText(publicKey));
}

function sign(options) {
  for (const name of ["key", "map", "out"]) if (!options[name]) fail(`sign needs --${name}`);
  refuseKeyInsideCheckout(options.key, "The key");
  let map = null;
  try {
    map = JSON.parse(readFileSync(options.map, "utf8"));
  } catch (error) {
    fail(`the map is not readable JSON (${error.message})`);
  }
  if (!map || typeof map !== "object" || Array.isArray(map)) fail("the map must be a JSON object");
  const content = JSON.stringify(map);
  const privateKey = crypto.createPrivateKey(readFileSync(options.key, "utf8"));
  const request = {
    version: map.mapVersion,
    content,
    signature: crypto.sign(null, Buffer.from(content, "utf8"), privateKey).toString("base64"),
    notes: String(options.notes || ""),
  };
  // Checked exactly as the server will check it, so a request that would be refused is never
  // written. The latest published version is unknown here; the server applies it.
  const verdict = checkPortalMapSubmission(request, { publicKey: portalMapPublicKey(publicKeyText(privateKey)), latestVersion: 0 });
  if (!verdict.ok) fail(`the server would refuse this map: ${verdict.message}`);
  writeFileSync(options.out, `${JSON.stringify(request, null, 2)}\n`);
  console.log(`Signed map version ${request.version} (minimum extension ${verdict.record.minExtensionVersion}) written to ${options.out}.`);
}

function verify(options) {
  for (const name of ["public", "request"]) if (!options[name]) fail(`verify needs --${name}`);
  const publicKey = portalMapPublicKey(options.public);
  if (!publicKey) fail("--public is not a 32-byte Ed25519 public key in base64");
  const request = JSON.parse(readFileSync(options.request, "utf8"));
  const verdict = checkPortalMapSubmission(request, { publicKey, latestVersion: 0 });
  if (!verdict.ok) fail(`${verdict.code}: ${verdict.message}`);
  console.log(`OK: version ${verdict.record.version} verifies against this key.`);
}

const [command, ...rest] = process.argv.slice(2);
const options = argsOf(rest);
if (command === "keygen") keygen(options);
else if (command === "sign") sign(options);
else if (command === "verify") verify(options);
else fail("usage: keygen --out <folder> | sign --key <pem> --map <map.json> --out <request.json> [--notes text] | verify --public <base64> --request <request.json>");
