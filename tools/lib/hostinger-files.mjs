// tools/lib/hostinger-files.mjs
//
// Shared core of the single-file Hostinger upload path, extracted from
// hostinger-upload-file.mjs (which becomes a thin CLI wrapper around this) so
// publish-desktop-release.mjs can reuse the exact same upload+verify logic for
// its own multiple files (the installer, its sha256 sidecar, and a freshly
// generated latest.json) rather than a second, possibly-diverging copy.
//
// Behavior is unchanged from the original script: resolve the account, get TUS
// upload credentials, PATCH the bytes in chunks, then independently re-download
// the public URL and compare bytes -- an upload is not "done" until what the
// public URL actually serves has been read back and hashed, not merely POSTed.

import { createHash } from "node:crypto";
import { openSync, readSync, closeSync, statSync, existsSync } from "node:fs";

const CHUNK = 10 * 1024 * 1024; // matches the reference client

export function sha256OfBytes(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

export function sha256OfFile(filePath) {
  const h = createHash("sha256");
  const fd = openSync(filePath, "r");
  const buf = Buffer.alloc(1024 * 1024);
  let bytes;
  while ((bytes = readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, bytes));
  closeSync(fd);
  return h.digest("hex");
}

// Reads either a local file path or an in-memory Buffer/string into one { size, sha256, read }
// descriptor, so uploadFileToHostinger doesn't need to know which kind of source it was given.
export function describeSource({ filePath, content }) {
  if (filePath) {
    if (!existsSync(filePath)) throw new Error(`local file not found: ${filePath}`);
    const size = statSync(filePath).size;
    return {
      size,
      sha256: sha256OfFile(filePath),
      readChunk: (offset, len) => {
        const fd = openSync(filePath, "r");
        try {
          const buf = Buffer.alloc(len);
          readSync(fd, buf, 0, len, offset);
          return buf;
        } finally {
          closeSync(fd);
        }
      },
    };
  }
  if (content !== undefined) {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
    return {
      size: buf.length,
      sha256: sha256OfBytes(buf),
      readChunk: (offset, len) => buf.subarray(offset, offset + len),
    };
  }
  throw new Error("describeSource: one of filePath or content is required");
}

// Uploads one file to a Hostinger shared-hosting site at an exact relative path, then
// independently re-downloads the public URL to confirm what is actually being served matches
// what was sent. Never calls the deploy/extract endpoint -- nothing outside the single target
// path is ever touched. Throws on any failure; the caller decides how to report it.
//
//   { domain, token, remotePath, filePath? , content?, log? } -> { size, sha256, verified: true }
export async function uploadFileToHostinger({
  domain,
  token,
  remotePath: remotePathRaw,
  filePath,
  content,
  base = process.env.HOSTINGER_API_BASE || "https://developers.hostinger.com",
  log = () => {},
  expectPe = /\.exe$/i.test(remotePathRaw || ""),
}) {
  if (!token) throw new Error("HOSTINGER_API_TOKEN is not set.");
  const remotePath = remotePathRaw.replace(/\\/g, "/").replace(/^\/+/, "");
  const source = describeSource({ filePath, content });
  const authed = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  log(`  file/content : ${filePath || "(in-memory)"}  size=${source.size}  sha256=${source.sha256}`);
  log(`  target       : ${domain} :: ${remotePath}`);

  const wsRes = await fetch(`${base}/api/hosting/v1/websites?domain=${encodeURIComponent(domain)}`, {
    headers: authed,
  });
  if (!wsRes.ok) throw new Error(`resolveUsername: HTTP ${wsRes.status}`);
  const wsBody = await wsRes.json();
  const site = (wsBody?.data || []).find((w) => w.domain === domain);
  if (!site?.username) throw new Error(`resolveUsername: no site matching ${domain}`);

  const credRes = await fetch(`${base}/api/hosting/v1/files/upload-urls`, {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ username: site.username, domain }),
  });
  if (!credRes.ok) {
    throw new Error(`uploadUrls: HTTP ${credRes.status} ${(await credRes.text()).slice(0, 300)}`);
  }
  const cred = await credRes.json();
  const uploadUrl = cred.url || cred?.data?.url;
  const authKey = cred.auth_key || cred?.data?.auth_key;
  const restKey = cred.rest_auth_key || cred?.data?.rest_auth_key;
  if (!uploadUrl || !authKey || !restKey) throw new Error("uploadUrls: incomplete credentials in response");

  const target = `${uploadUrl.replace(/\/$/, "")}/${remotePath}?override=true`;
  const createRes = await fetch(target, {
    method: "POST",
    headers: {
      "X-Auth": authKey,
      "X-Auth-Rest": restKey,
      "upload-length": String(source.size),
      "upload-offset": "0",
    },
    body: "",
  });
  if (createRes.status !== 201) {
    throw new Error(`tusCreate: expected 201, got ${createRes.status} ${(await createRes.text()).slice(0, 300)}`);
  }

  let offset = 0;
  while (offset < source.size) {
    const len = Math.min(CHUNK, source.size - offset);
    const buf = source.readChunk(offset, len);
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
      throw new Error(`tusPatch: offset ${offset}: HTTP ${patch.status} ${(await patch.text()).slice(0, 200)}`);
    }
    const next = Number(patch.headers.get("upload-offset"));
    offset = Number.isFinite(next) && next > offset ? next : offset + len;
    log(`  ${offset}/${source.size} bytes (${((offset / source.size) * 100).toFixed(1)}%)`);
  }

  const publicUrl = `https://${domain}/${remotePath}`;
  const head = await fetch(`${publicUrl}?cb=${Date.now()}`, { method: "HEAD", redirect: "follow" });
  if (!head.ok) throw new Error(`verify: the file is not being served (HTTP ${head.status})`);

  const got = await fetch(`${publicUrl}?cb=${Date.now()}`, { redirect: "follow" });
  const bytes = Buffer.from(await got.arrayBuffer());
  const remoteSha = sha256OfBytes(bytes);
  const isPe = bytes[0] === 0x4d && bytes[1] === 0x5a;
  const ok = bytes.length === source.size && remoteSha === source.sha256 && (!expectPe || isPe);

  log(`  downloaded   : ${bytes.length} bytes, sha256 ${remoteSha}`);
  log(`  size match   : ${bytes.length === source.size}, sha match: ${remoteSha === source.sha256}${expectPe ? `, MZ header: ${isPe}` : ""}`);

  if (!ok) {
    throw new Error(
      `MISMATCH after upload to ${remotePath}: size ${bytes.length}/${source.size}, sha ${remoteSha === source.sha256 ? "match" : "MISMATCH"}${expectPe ? `, MZ ${isPe}` : ""}`
    );
  }

  return { size: source.size, sha256: source.sha256, publicUrl, verified: true };
}
