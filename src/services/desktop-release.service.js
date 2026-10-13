// Validates and normalizes desktop-release admin writes (see AppConfig.js's desktopRelease
// sub-document and appconfig.controller.js's updateDesktopRelease/notifyDesktopRelease). Pure
// functions only, so the controller stays a thin assertSuper + $set wrapper and every rule here
// is unit-testable without a database.
//
// VERSION_PATTERN and compareVersions exist because a naive string or semver-library compare is
// the wrong tool: this project pads to 4 numeric components and compares each one numerically, so
// "0.1.10" sorts after "0.1.9" (a plain string compare would put it before), and "0.1.1" equals
// "0.1.1.0" (so an operator does not have to remember how many components to type consistently).
//
// isAllowedDownloadUrl is an exact-hostname allow-list, not a substring or endsWith check, because
// "caprotoolkit.in.evil.com" ends with a string containing "caprotoolkit.in" but is not this site.

export const VERSION_PATTERN = /^\d{1,5}(\.\d{1,5}){0,3}$/;

export const ALLOWED_DOWNLOAD_HOSTS = Object.freeze(["caprotoolkit.in", "www.caprotoolkit.in"]);

export function parseVersion(text) {
  if (typeof text !== "string" || !VERSION_PATTERN.test(text)) return null;
  const parts = text.split(".").map((p) => Number.parseInt(p, 10));
  while (parts.length < 4) parts.push(0);
  return parts;
}

export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 4; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

export function isAllowedDownloadUrl(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  let url;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  const hostname = url.hostname.toLowerCase();
  if (hostname.endsWith(".")) return false;
  return ALLOWED_DOWNLOAD_HOSTS.includes(hostname);
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_SIZE_BYTES = 524288000;
const MAX_RELEASE_NOTES_LENGTH = 4000;

// body: the raw PATCH payload (only the keys the operator actually sent are present).
// current: the stored desktopRelease sub-document (for version-monotonicity and defaulting).
// Returns { ok:true, update } with a dotted-path object ready for $set, or
// { ok:false, status, error, code } naming the exact rule that failed.
export function validateDesktopReleasePatch(body, current) {
  if (!body || typeof body !== "object") {
    return { ok: false, status: 400, error: "Nothing to update" };
  }

  const update = {};
  const has = (key) => Object.prototype.hasOwnProperty.call(body, key);

  let latestVersion = current?.latestVersion;
  if (has("latestVersion")) {
    const v = body.latestVersion;
    if (typeof v !== "string" || !VERSION_PATTERN.test(v)) {
      return {
        ok: false,
        status: 400,
        error:
          "latestVersion must be plain dotted digits (e.g. 0.1.2), with no leading 'v' and no pre-release suffix.",
      };
    }
    latestVersion = v;
    update["desktopRelease.latestVersion"] = v;
  }

  if (has("minSupportedVersion")) {
    const v = body.minSupportedVersion;
    if (v !== "" && (typeof v !== "string" || !VERSION_PATTERN.test(v))) {
      return {
        ok: false,
        status: 400,
        error:
          "minSupportedVersion must be plain dotted digits (e.g. 0.1.0), or an empty string to block nothing.",
      };
    }
    if (v !== "" && latestVersion) {
      const cmp = compareVersions(v, latestVersion);
      if (cmp !== null && cmp > 0) {
        return {
          ok: false,
          status: 400,
          error: "The minimum supported version cannot be newer than the latest version",
        };
      }
    }
    update["desktopRelease.minSupportedVersion"] = v;
  }

  if (has("downloadUrl")) {
    const v = body.downloadUrl;
    if (!isAllowedDownloadUrl(v)) {
      return {
        ok: false,
        status: 400,
        error: `downloadUrl must be an https URL on one of: ${ALLOWED_DOWNLOAD_HOSTS.join(", ")}`,
      };
    }
    update["desktopRelease.downloadUrl"] = v;
  }

  if (has("releaseNotes")) {
    const raw = typeof body.releaseNotes === "string" ? body.releaseNotes : "";
    const trimmed = raw.trim();
    if (trimmed.length > MAX_RELEASE_NOTES_LENGTH) {
      return {
        ok: false,
        status: 400,
        error: `releaseNotes must be ${MAX_RELEASE_NOTES_LENGTH} characters or fewer; it was ${trimmed.length}. Shorten it and resubmit -- it is not truncated for you.`,
      };
    }
    update["desktopRelease.releaseNotes"] = trimmed;
  }

  if (has("sha256")) {
    const v = typeof body.sha256 === "string" ? body.sha256.toLowerCase() : "";
    if (!SHA256_PATTERN.test(v)) {
      return {
        ok: false,
        status: 400,
        error: "sha256 must be exactly 64 hexadecimal characters.",
      };
    }
    update["desktopRelease.sha256"] = v;
  }

  if (has("sizeBytes")) {
    const v = body.sizeBytes;
    if (!Number.isSafeInteger(v) || v < 1 || v > MAX_SIZE_BYTES) {
      return {
        ok: false,
        status: 400,
        error: `sizeBytes must be a whole number of bytes between 1 and ${MAX_SIZE_BYTES}.`,
      };
    }
    update["desktopRelease.sizeBytes"] = v;
  }

  if (has("mandatory")) {
    update["desktopRelease.mandatory"] = body.mandatory === true;
  }

  // Publishing a binary whose hash the page cannot state is worse than publishing none: both
  // must be sent alongside downloadUrl in THIS request, not merely already present on the stored
  // document from an earlier save.
  if (has("downloadUrl") && (!has("sha256") || !has("sizeBytes"))) {
    return {
      ok: false,
      status: 400,
      error: "sha256 and sizeBytes are required in the same request whenever downloadUrl is being set.",
    };
  }

  // Version monotonicity, checked last so field-level 400s take priority over the 409 below.
  if (has("latestVersion") && current?.latestVersion) {
    const cmp = compareVersions(latestVersion, current.latestVersion);
    if (cmp !== null) {
      const isSame = cmp === 0;
      const isOlder = cmp < 0;
      if (isOlder || (isSame && body.allowRepublish !== true)) {
        return {
          ok: false,
          status: 409,
          code: "VERSION_NOT_NEWER",
          error:
            "That version is older than the one already published. Set enabled to false to stop announcing instead of publishing a rollback.",
        };
      }
    }
  }

  if (Object.keys(update).length === 0) {
    return { ok: false, status: 400, error: "Nothing to update" };
  }

  return { ok: true, update };
}
