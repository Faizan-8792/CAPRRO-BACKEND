// Signed, versioned portal maps for the GST downloader (GD28; GST-DOWNLOADER-PLAN section 8.12).
//
// The owner signs a map OFFLINE with tools/sign-portal-map.mjs; this server only ever holds the
// PUBLIC key, in GST_PORTAL_MAP_PUBLIC_KEY, as the 32 raw Ed25519 bytes in base64. A version is
// accepted only when its signature verifies against that key, its body has exactly the expected
// shape, and its number is higher than every version already published. With no key configured,
// nothing is accepted at all: a server that cannot verify must not pretend to.
//
// What the map itself may contain is the extension's contract (validateMapData in
// gst-downloader/portal-map.js), checked by the extension, which alone knows which keys it reads.
// This side checks the envelope: the content is a JSON object whose mapVersion is the version
// being published and whose minExtensionVersion is a version number.

import crypto from "node:crypto";
import PortalMapVersion, { PORTAL_MAP_LIMITS } from "../models/PortalMapVersion.js";

// The same shape the extension's validator accepts for minExtensionVersion.
const VERSION_TEXT = /^\d{1,4}(\.\d{1,5}){0,3}$/;
const SUBMISSION_FIELDS = Object.freeze(["version", "content", "signature", "notes"]);

// Base64 that decodes to exactly `length` bytes and says nothing else: Buffer.from() silently
// skips characters that are not base64, so the decoded bytes are re-encoded and compared.
function exactBase64(text, length) {
  if (typeof text !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null;
  const bytes = Buffer.from(text, "base64");
  if (bytes.length !== length) return null;
  return bytes.toString("base64").replace(/=+$/, "") === text.replace(/=+$/, "") ? bytes : null;
}

// The owner's public key, or null when none is configured or the configured value is not one.
export function portalMapPublicKey(raw = process.env.GST_PORTAL_MAP_PUBLIC_KEY) {
  const bytes = exactBase64(String(raw || "").trim(), 32);
  if (!bytes) return null;
  try {
    return crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: bytes.toString("base64url") }, format: "jwk" });
  } catch (_) {
    return null;
  }
}

export function verifyPortalMapSignature(content, signature, publicKey) {
  if (!publicKey || typeof content !== "string") return false;
  const signatureBytes = exactBase64(signature, 64);
  if (!signatureBytes) return false;
  try {
    return crypto.verify(null, Buffer.from(content, "utf8"), publicKey, signatureBytes);
  } catch (_) {
    return false;
  }
}

function refusal(status, code, message) {
  return { ok: false, status, code, message };
}

// The whole acceptance decision, without the database: what is refused, with which status, and why.
// `latestVersion` is the highest version already published (0 when there is none).
export function checkPortalMapSubmission(body, { publicKey, latestVersion = 0 } = {}) {
  if (!publicKey) {
    return refusal(503, "PORTAL_MAP_SIGNING_NOT_CONFIGURED", "This server has no portal-map signing key configured, so it accepts no version.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return refusal(400, "PORTAL_MAP_MALFORMED", "The request must be an object with version, content and signature.");
  }
  const unexpected = Object.keys(body).filter((key) => !SUBMISSION_FIELDS.includes(key));
  if (unexpected.length) {
    return refusal(400, "PORTAL_MAP_MALFORMED", `The request carries a field a portal map does not have (${unexpected.length}).`);
  }
  const { version, content, signature } = body;
  const notes = body.notes === undefined ? "" : body.notes;
  if (!Number.isInteger(version) || version < 1 || version > PORTAL_MAP_LIMITS.highestVersion) {
    return refusal(400, "PORTAL_MAP_MALFORMED", "version must be a whole number from 1.");
  }
  if (typeof content !== "string" || content === "" || Buffer.byteLength(content, "utf8") > PORTAL_MAP_LIMITS.contentBytes) {
    return refusal(400, "PORTAL_MAP_MALFORMED", `content must be the signed map text, at most ${PORTAL_MAP_LIMITS.contentBytes} bytes.`);
  }
  if (!exactBase64(signature, 64)) {
    return refusal(400, "PORTAL_MAP_MALFORMED", "signature must be the 64-byte signature in base64.");
  }
  if (typeof notes !== "string" || notes.length > PORTAL_MAP_LIMITS.notesChars) {
    return refusal(400, "PORTAL_MAP_MALFORMED", `notes must be text of at most ${PORTAL_MAP_LIMITS.notesChars} characters.`);
  }
  let parsed = null;
  try {
    parsed = JSON.parse(content);
  } catch (_) {
    return refusal(400, "PORTAL_MAP_MALFORMED", "content is not JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return refusal(400, "PORTAL_MAP_MALFORMED", "content must be a JSON object.");
  }
  if (parsed.mapVersion !== version) {
    return refusal(400, "PORTAL_MAP_MALFORMED", "The content's mapVersion is not the version being published.");
  }
  if (typeof parsed.minExtensionVersion !== "string" || !VERSION_TEXT.test(parsed.minExtensionVersion)) {
    return refusal(400, "PORTAL_MAP_MALFORMED", "The content's minExtensionVersion must be a version such as 1.4.6.");
  }
  // The signature before the stored state: an unsigned request learns nothing from this route.
  if (!verifyPortalMapSignature(content, signature, publicKey)) {
    return refusal(422, "PORTAL_MAP_BAD_SIGNATURE", "The signature does not match this content and this server's key.");
  }
  if (version <= latestVersion) {
    return refusal(
      409,
      "PORTAL_MAP_VERSION_NOT_HIGHER",
      `Version ${version} is not higher than the published version ${latestVersion}. A rollback is a new, higher version carrying the old content.`,
    );
  }
  return {
    ok: true,
    record: { version, content, signature, minExtensionVersion: parsed.minExtensionVersion, notes },
  };
}

// Production connects with autoIndex off, so the unique index on `version` is created here, once,
// before the first publish - and a publish is refused while it cannot be, because without it two
// requests could store the same version.
let indexesReady = null;
function ensurePortalMapIndexes() {
  if (!indexesReady) {
    indexesReady = PortalMapVersion.createIndexes().catch((error) => {
      indexesReady = null;
      throw error;
    });
  }
  return indexesReady;
}

export async function latestPortalMapVersion() {
  const latest = await PortalMapVersion.findOne({}, { version: 1 }).sort({ version: -1 }).lean();
  return latest ? Number(latest.version) : 0;
}

// Exactly what the extension needs to verify a version, and nothing else.
export async function findPortalMapVersion(version) {
  const found = await PortalMapVersion.findOne({ version }, { version: 1, content: 1, signature: 1 }).lean();
  return found ? { version: Number(found.version), content: found.content, signature: found.signature } : null;
}

export async function publishPortalMap(body, user, { publicKey = portalMapPublicKey(), now = new Date() } = {}) {
  try {
    await ensurePortalMapIndexes();
  } catch (_) {
    return refusal(503, "PORTAL_MAP_STORE_NOT_READY", "The portal-map store is not ready, so no version was accepted. Try again shortly.");
  }
  const verdict = checkPortalMapSubmission(body, { publicKey, latestVersion: await latestPortalMapVersion() });
  if (!verdict.ok) return verdict;
  try {
    const created = await PortalMapVersion.create({ ...verdict.record, publishedAt: now, publishedBy: user?._id || user?.id });
    return {
      ok: true,
      status: 201,
      published: { version: created.version, minExtensionVersion: created.minExtensionVersion, publishedAt: created.publishedAt },
    };
  } catch (error) {
    // Another request stored this version between the check and the write.
    if (error?.code === 11000) {
      return refusal(409, "PORTAL_MAP_VERSION_NOT_HIGHER", `Version ${verdict.record.version} has just been published by another request.`);
    }
    throw error;
  }
}
