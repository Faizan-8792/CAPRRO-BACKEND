// One definition of "the deploy archive is still exposed", shared by the deploy tool and the gate.
//
// WHY THIS EXISTS
// ---------------
// Hostinger builds this API from an archive uploaded into the domain's document root, and that root
// is served statically: for the moment the archive sits there, `https://api.caprotoolkit.in/
// capro-backend.zip` is an unauthenticated download of the whole backend source. That happened for
// real on 2026-09-08 and was cleaned up by hand afterwards. Hand cleanup is not a control - the next
// deploy re-creates the exposure - so the deploy itself now closes it and proves it closed.
//
// WHAT WAS RULED OUT FIRST, WITH EVIDENCE
// ---------------------------------------
// A genuine 404 would be better than covering the file. Two routes to it were probed against the
// live account and both are unavailable:
//
//   1. Deleting the file. The upload path is a TUS endpoint; TUS defines a termination extension.
//      DELETE on the resource, DELETE with `Tus-Resumable`, and DELETE with `?override=true` all
//      answer HTTP 404. The file service exposes no delete, and the Hostinger MCP surface has no
//      file manager either.
//   2. Keeping the archive outside the served root. An upload to `../private/capro-backend.zip`
//      succeeds (201 create, 204 patch) and is genuinely NOT public - but the build cannot read it:
//      `nodejs/builds/settings/from-archive?archive_path=../private/capro-backend.zip` answers 404.
//      The archive has to be in the served root for the build to see it.
//
// So the archive is necessarily public for the length of one build, and the guarantee that can
// actually be made is the one implemented here: it never REMAINS public, the deploy enforces that
// itself, and a deploy that cannot prove it fails.
//
// The file service also refuses to read a file back (GET and HEAD on the resource with the upload
// credentials both answer 404), so the only way to observe what is served is the public URL - which
// is exactly the thing being checked, so that limitation costs nothing here.

/** The bytes written over the archive once the build has read it. */
export const PLACEHOLDER_BODY =
  "This path is intentionally blank.\n" +
  "\n" +
  "A deployment archive is uploaded here only for the moment a build reads it, and is overwritten\n" +
  "with this file immediately afterwards. Nothing is served from this path.\n";

/**
 * Anything at this path larger than this is treated as exposure even if it is not recognisably a
 * zip. The placeholder is ~200 bytes and a real archive is hundreds of kilobytes, so the gap is
 * wide; the point is that "unrecognised but large" fails closed rather than passing.
 */
export const MAX_SAFE_BODY_BYTES = 4096;

const PK_MAGIC = [0x50, 0x4b];

function sha256Hex(bytes, createHash) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Decides whether what is being served at the archive path is safe.
 *
 * Pure: bytes in, verdict out. That is what makes it testable offline, which matters because the
 * live check can only run against production.
 *
 * @param {object} input
 * @param {Buffer|Uint8Array|null} input.bytes  what the path served, or null if it served nothing
 * @param {number|null} input.status            the HTTP status, or null when not fetched
 * @param {string|null} [input.archiveSha256]   sha256 of the archive that was deployed, when known
 * @param {Function} input.createHash           node:crypto createHash, injected so this stays pure
 * @returns {{safe: boolean, reason: string}}
 */
export function classifyServedArchive({ bytes, status, archiveSha256 = null, createHash }) {
  // The best possible outcome: the path is not served at all.
  if (status === 404 || status === 403) {
    return { safe: true, reason: `not served (HTTP ${status})` };
  }

  if (!bytes || bytes.length === 0) {
    return { safe: true, reason: "served no bytes" };
  }

  const view = Uint8Array.from(bytes);

  // Checked before size and before the hash: a zip is a zip whatever else is true of it, and this
  // is the signature the owner asked to be certain about.
  if (view.length >= 2 && view[0] === PK_MAGIC[0] && view[1] === PK_MAGIC[1]) {
    return { safe: false, reason: "body begins with the PK zip signature" };
  }

  if (archiveSha256) {
    const served = sha256Hex(view, createHash);
    if (served.toLowerCase() === String(archiveSha256).toLowerCase()) {
      return { safe: false, reason: "body is byte-identical to the deployment archive" };
    }
  }

  // Fails closed. Something large and unrecognised at this path is not something to wave through
  // merely because it did not start with PK.
  if (view.length > MAX_SAFE_BODY_BYTES) {
    return {
      safe: false,
      reason: `body is ${view.length} bytes, over the ${MAX_SAFE_BODY_BYTES}-byte ceiling for this path`,
    };
  }

  return { safe: true, reason: `served ${view.length} harmless bytes` };
}

/**
 * Fetches the public archive path and throws unless it is safe.
 *
 * @returns {Promise<{status: number|null, bytes: number, reason: string}>}
 */
export async function assertArchivePathNotExposed({
  domain,
  remotePath,
  archiveSha256 = null,
  createHash,
  fetchImpl = fetch,
  log = () => {},
}) {
  // Cache-busted deliberately. A 404 cached from before the archive was uploaded is exactly how
  // this exposure was missed the first time it happened: the bare URL answered 404 from cache while
  // the file was being served at origin.
  const url = `https://${domain}/${remotePath}?cb=${Date.now()}`;

  let status = null;
  let bytes = null;
  try {
    const res = await fetchImpl(url, { redirect: "follow" });
    status = res.status;
    if (res.ok) {
      bytes = Buffer.from(await res.arrayBuffer());
    }
  } catch (err) {
    // A network failure is not proof of safety. It is an unproven claim, and this function exists
    // to refuse those.
    throw new Error(`archive exposure check could not run: ${String(err)}`);
  }

  const verdict = classifyServedArchive({ bytes, status, archiveSha256, createHash });
  log(`  archive path : HTTP ${status} - ${verdict.reason}`);

  if (!verdict.safe) {
    throw new Error(
      `THE DEPLOY ARCHIVE IS STILL PUBLIC at https://${domain}/${remotePath} - ${verdict.reason}`,
    );
  }

  return { status, bytes: bytes ? bytes.length : 0, reason: verdict.reason };
}
