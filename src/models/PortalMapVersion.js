import mongoose from "mongoose";

/**
 * One signed version of the GST downloader's portal map (GD28; GST-DOWNLOADER-PLAN section 8.12).
 *
 * The extension carries a bundled map - where GST Portal's pages are, how its controls are found,
 * which endpoints are read and the portal's own sentences, as plain data - and may use a newer
 * version from here. Only a version the owner signed OFFLINE, with tools/sign-portal-map.mjs, is
 * ever accepted: the private key never sits on this server. The server verifies the signature
 * before it stores a version, and the extension verifies it again with its own bundled public key
 * (GD29), so even a compromised server can serve nothing the owner did not sign.
 *
 * `content` is the exact signed text, kept as text: the bytes the extension verifies must be the
 * bytes the owner signed, and a parsed-and-re-serialised object could reorder keys and break every
 * signature. It is data, never code - PLAN.md forbids remote JavaScript.
 *
 * Versions only go up. A rollback is a new, higher version carrying the old content. Nothing here
 * belongs to a firm or describes a client: the publisher's id is the only reference to a person.
 */
export const PORTAL_MAP_LIMITS = Object.freeze({
  contentBytes: 65536,
  signatureChars: 88,
  notesChars: 500,
  versionTextChars: 32,
  highestVersion: 1000000,
});

const PortalMapVersionSchema = new mongoose.Schema(
  {
    version: { type: Number, required: true, min: 1, max: PORTAL_MAP_LIMITS.highestVersion, unique: true },
    content: { type: String, required: true },
    signature: { type: String, required: true, maxlength: PORTAL_MAP_LIMITS.signatureChars },
    minExtensionVersion: { type: String, required: true, maxlength: PORTAL_MAP_LIMITS.versionTextChars },
    notes: { type: String, default: "", maxlength: PORTAL_MAP_LIMITS.notesChars },
    publishedAt: { type: Date, required: true },
    publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { collection: "portalmapversions", versionKey: false },
);

export default mongoose.model("PortalMapVersion", PortalMapVersionSchema);
