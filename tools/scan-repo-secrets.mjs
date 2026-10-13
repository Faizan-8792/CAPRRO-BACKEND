#!/usr/bin/env node
// tools/scan-repo-secrets.mjs
//
// O2: sweep the WHOLE repo (not just the deploy archive) for any secret-
// bearing artifact, using the SAME credential-pattern table
// tools/scan-deploy-secrets.mjs already carries -- imported, not copied, so
// there stays exactly one definition (see PROVIDER_SECRET_PATTERNS' export
// there for why: two independently-maintained copies is exactly the kind of
// drift that let capro-backend.zip carry two live keys unnoticed).
//
// Walks a root (argv[2], default: the repo root two levels above this file)
// skipping node_modules, .git, obj and bin at any depth. Every remaining
// regular file under MAX_FILE_BYTES is pattern-matched directly; every
// *.zip/*.7z/*.tar*/*.tgz archive has its entries enumerated and each
// text-ish entry under MAX_FILE_BYTES pattern-matched in memory.
//
// Output contract, load-bearing: a finding reports the file path, the
// archive-internal entry path (when applicable), the pattern LABEL that
// matched, and the matched substring's length plus its first 3 characters.
// The matched value itself is NEVER printed, logged, or written anywhere --
// a secret scanner that leaks the secret it found into its own report/log
// output has not fixed the leak, it has relocated it. Exit 1 if any match is
// found (after placeholder triage), exit 0 otherwise.
//
// Bytes are read as latin1 (never utf8) deliberately: latin1 maps every byte
// 0-255 to one code point with no replacement/loss, so an ASCII credential
// embedded in a file that is not valid UTF-8 (a different encoding, or
// genuinely binary data with an embedded ASCII secret) still round-trips
// exactly and still matches its pattern. Decoding as utf8 first would risk
// exactly the false-negative a secret scanner cannot afford.
//
// ONE deliberate, narrow exclusion: a file matching capro-backend/.gitignore's
// own `.env` / `.env.*` (but not `.env.example`) rule is not content-scanned.
// That file is the intended, git-ignored local secrets vault -- the one place
// a real credential is SUPPOSED to live outside version control, per this
// repo's existing .gitignore rule (not a new judgement call this file
// invents). Run once for real against the whole repo (this task's own
// mandatory gate), the only content-based hit before this exclusion existed
// was capro-backend/.env itself holding its own real, currently-in-use Resend
// key -- exactly the non-finding this exclusion exists to encode, not hide:
// the path is still walked, still named explicitly in the summary below, and
// still counted -- only its content is not pattern-matched. Any OTHER file
// anywhere in the tree is scanned normally, including one that happened to be
// named e.g. "notes.env.txt" (the pattern below matches only an exact
// ".env"/".env.<suffix>" basename, same as the gitignore rule it mirrors).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync, gunzipSync } from "node:zlib";
import { PROVIDER_SECRET_PATTERNS } from "./scan-deploy-secrets.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DEFAULT_ROOT = join(HERE, "..", "..");
const ROOT = process.argv[2] ? String(process.argv[2]) : DEFAULT_ROOT;

// 10 MiB: generous for any tracked source, doc, or config file in this repo
// (the largest legitimate tracked text assets are still well under this),
// while refusing to decompress/scan something sized to make the walk itself
// the attack surface. Oversized files/entries are still counted and named in
// the summary, never silently invisible.
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const SKIP_DIR_NAMES = new Set(["node_modules", ".git", "obj", "bin"]);
const ARCHIVE_EXTENSIONS = [".zip", ".7z", ".tar", ".tgz"]; // ".tar*" per the task's own Steps also covers .tar.gz/.tar.bz2 etc, matched separately below.

// Mirrors providerFindingForValue's own placeholder exclusion in
// scan-deploy-secrets.mjs (kept in step with $providerPlaceholderRegex in
// make-deploy-archive.ps1, per that file's own comment) -- not imported,
// because unlike PROVIDER_SECRET_PATTERNS this is a two-line, self-contained
// filter with no state, and importing a second binding for it would only add
// coupling without removing a real duplicated table. Documented here so it is
// visibly the same rule, not an independent judgement call.
const PLACEHOLDER_TEXT = /(?:REPLACE_ME|YOUR_|CHANGEME|EXAMPLE|PLACEHOLDER|<[A-Za-z0-9_. -]{1,40}>)/i;
const REPEATED_HEX_DIGIT = /^([0xXaA])\1{11,}$/;

function isPlaceholderMatch(matchedText) {
  const credentialBody = matchedText.replace(/^[A-Za-z_-]+/, "");
  return (
    PLACEHOLDER_TEXT.test(matchedText) || REPEATED_HEX_DIGIT.test(credentialBody)
  );
}

function isArchivePath(path) {
  const lower = path.toLowerCase();
  return ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext)) || /\.tar\.[a-z0-9]+$/.test(lower);
}

const counts = {
  filesWalked: 0,
  filesScanned: 0,
  filesSkippedOversize: 0,
  filesSkippedGitignoredEnv: 0,
  archiveEntriesScanned: 0,
  archiveEntriesSkippedOversize: 0,
  archivesUnsupportedFormat: 0,
  archivesUnreadable: 0,
};
const findings = [];
const gitignoredEnvFilesSeen = [];

// Mirrors capro-backend/.gitignore lines 5-7 exactly: `.env`, `.env.*`, with
// `.env.example` explicitly un-ignored. A file elsewhere in the tree that
// merely contains ".env" somewhere in a longer name (e.g. "notes.env.txt")
// does not match this -- only an exact basename of ".env" or ".env.<rest>".
function isGitignoredEnvFile(basename) {
  if (basename === ".env.example") return false;
  return basename === ".env" || /^\.env\./.test(basename);
}

function recordFinding({ path, archiveEntryPath, label, matchedText }) {
  findings.push({
    path,
    archiveEntryPath: archiveEntryPath || null,
    label,
    matchedLength: matchedText.length,
    matchedFirst3: matchedText.slice(0, 3),
  });
}

// Reports at most the FIRST matching pattern for a given piece of content --
// mirrors providerFindingForValue's own "first match wins" behaviour in
// scan-deploy-secrets.mjs, so the two scanners agree on what "a finding" means
// for the same bytes.
function scanContent(text, path, archiveEntryPath) {
  for (const [label, pattern] of PROVIDER_SECRET_PATTERNS) {
    const match = text.match(pattern)?.[0];
    if (!match) continue;
    if (isPlaceholderMatch(match)) continue;
    recordFinding({ path, archiveEntryPath, label, matchedText: match });
    return true;
  }
  return false;
}

// ── Minimal, dependency-free ZIP reader (central-directory + local-header
// walk; STORED and DEFLATE methods only, which is everything `zip`/Explorer/
// PowerShell's Compress-Archive produce and everything this repo's own
// archives use). No ZIP64 support -- not needed for any archive actually
// tracked in this repo, and a >65,535-entry or >4 GiB archive is exactly the
// kind of thing this scanner should refuse to silently half-read, so it is
// reported as unreadable rather than guessed at. ──────────────────────────
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;

function findEndOfCentralDirectory(buffer) {
  const maxCommentLength = 65535;
  const searchStart = Math.max(0, buffer.length - 22 - maxCommentLength);
  for (let offset = buffer.length - 22; offset >= searchStart; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

function readZipEntries(buffer) {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset < 0) return null;
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (centralDirOffset === 0xffffffff || entryCount === 0xffff) return null; // ZIP64 -- not supported.

  const entries = [];
  let cursor = centralDirOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_DIR_SIGNATURE) {
      return null;
    }
    const compressionMethod = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    const name = buffer.toString("utf8", nameStart, nameStart + nameLength);
    entries.push({ name, compressionMethod, compressedSize, uncompressedSize, localHeaderOffset });
    cursor = nameStart + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readZipEntryContent(buffer, entry) {
  const header = entry.localHeaderOffset;
  if (header + 30 > buffer.length || buffer.readUInt32LE(header) !== LOCAL_HEADER_SIGNATURE) {
    return null;
  }
  const nameLength = buffer.readUInt16LE(header + 26);
  const extraLength = buffer.readUInt16LE(header + 28);
  const dataStart = header + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buffer.length) return null;
  const raw = buffer.subarray(dataStart, dataEnd);
  if (entry.compressionMethod === 0) return raw;
  if (entry.compressionMethod === 8) {
    try {
      return inflateRawSync(raw);
    } catch {
      return null;
    }
  }
  return null; // Any other method (e.g. legacy Shrink/Implode) -- unreadable, not silently skipped-as-clean.
}

function scanZipArchive(path, buffer) {
  const entries = readZipEntries(buffer);
  if (entries === null) {
    counts.archivesUnreadable += 1;
    recordFinding({
      path,
      archiveEntryPath: null,
      label: "unreadable ZIP archive (ZIP64 or corrupt central directory) -- not scanned",
      matchedText: "n/a",
    });
    return;
  }
  for (const entry of entries) {
    if (entry.name.endsWith("/")) continue; // directory entry
    if (entry.uncompressedSize > MAX_FILE_BYTES) {
      counts.archiveEntriesSkippedOversize += 1;
      continue;
    }
    const content = readZipEntryContent(buffer, entry);
    if (content === null) {
      counts.archivesUnreadable += 1;
      recordFinding({
        path,
        archiveEntryPath: entry.name,
        label: "unreadable ZIP entry (unsupported compression or truncated) -- not scanned",
        matchedText: "n/a",
      });
      continue;
    }
    counts.archiveEntriesScanned += 1;
    if (isArchivePath(entry.name)) {
      scanNestedArchiveBuffer(path, entry.name, content);
    } else {
      scanContent(content.toString("latin1"), path, entry.name);
    }
  }
}

// ── Minimal, dependency-free TAR reader (POSIX ustar / GNU tar, 512-byte
// header blocks). .tgz / .tar.gz are gunzipped first via node:zlib, which is
// a real decompressor, not a shell-out -- sidesteps the exact Windows
// tar-binary path-quoting hazard this session already found and documented
// live for deploy-archive-boundary.mjs (a Windows-side colon-after-drive-
// letter path is misread by GNU tar's remote "host:path" syntax). No archive
// in this repo is actually .tar/.tgz today (only the two named .zip files
// are), so this is exercised by construction in this file's own logic, not
// by a real fixture -- reported honestly in the O2 evidence, not hidden. ──
function readTarEntries(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const block = buffer.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) break; // end-of-archive marker
    const name = block.toString("utf8", 0, 100).replace(/\0.*$/s, "");
    const sizeOctal = block.toString("utf8", 124, 136).replace(/\0.*$/s, "").trim();
    const typeFlag = String.fromCharCode(block[156] || 0);
    const size = sizeOctal ? Number.parseInt(sizeOctal, 8) : 0;
    if (!Number.isFinite(size) || size < 0) break;
    const dataStart = offset + 512;
    if (dataStart + size > buffer.length) break;
    if (name) {
      entries.push({
        name,
        typeFlag,
        content: buffer.subarray(dataStart, dataStart + size),
      });
    }
    const paddedSize = Math.ceil(size / 512) * 512;
    offset = dataStart + paddedSize;
  }
  return entries;
}

function scanTarArchive(path, buffer, alreadyGunzipped) {
  let tarBuffer = buffer;
  if (!alreadyGunzipped && path.toLowerCase().endsWith(".tgz")) {
    try {
      tarBuffer = gunzipSync(buffer);
    } catch {
      counts.archivesUnreadable += 1;
      recordFinding({ path, archiveEntryPath: null, label: "unreadable .tgz (gzip decompression failed)", matchedText: "n/a" });
      return;
    }
  } else if (/\.tar\.gz$/i.test(path)) {
    try {
      tarBuffer = gunzipSync(buffer);
    } catch {
      counts.archivesUnreadable += 1;
      recordFinding({ path, archiveEntryPath: null, label: "unreadable .tar.gz (gzip decompression failed)", matchedText: "n/a" });
      return;
    }
  } else if (/\.tar\.(bz2|xz|lzma|zst)$/i.test(path)) {
    // No pure-JS decompressor available for these without adding a
    // dependency -- reported as an unscanned archive rather than silently
    // treated as clean.
    counts.archivesUnsupportedFormat += 1;
    recordFinding({ path, archiveEntryPath: null, label: `unsupported compressed-tar format (${path.split(".").pop()}) -- not scanned`, matchedText: "n/a" });
    return;
  }

  const entries = readTarEntries(tarBuffer);
  for (const entry of entries) {
    if (entry.typeFlag !== "0" && entry.typeFlag !== " ") continue; // regular files only
    if (entry.content.length > MAX_FILE_BYTES) {
      counts.archiveEntriesSkippedOversize += 1;
      continue;
    }
    counts.archiveEntriesScanned += 1;
    if (isArchivePath(entry.name)) {
      scanNestedArchiveBuffer(path, entry.name, entry.content);
    } else {
      scanContent(entry.content.toString("latin1"), path, entry.name);
    }
  }
}

function scanNestedArchiveBuffer(outerPath, entryName, content) {
  // An archive-inside-an-archive: recurse using the SAME readers, labelling
  // the outer path as `path` and the inner name as the archive-internal entry
  // path, so a finding still names exactly where it came from.
  const combinedPath = `${outerPath} :: ${entryName}`;
  scanArchiveBuffer(combinedPath, content);
}

function scanArchiveBuffer(path, buffer) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".zip")) {
    scanZipArchive(path, buffer);
  } else if (lower.endsWith(".tar")) {
    scanTarArchive(path, buffer, true);
  } else if (lower.endsWith(".tgz") || /\.tar\.[a-z0-9]+$/.test(lower)) {
    scanTarArchive(path, buffer, false);
  } else if (lower.endsWith(".7z")) {
    // 7z is LZMA-based and proprietary-container; no pure-JS reader exists in
    // this project's dependency tree and none was added for this task.
    // Reported as an unscanned archive -- an unreadable format is a finding
    // worth a human's attention, not a silent pass.
    counts.archivesUnsupportedFormat += 1;
    recordFinding({ path, archiveEntryPath: null, label: "unsupported archive format (.7z) -- not scanned, needs manual review", matchedText: "n/a" });
  }
}

function scanArchiveFile(path) {
  let buffer;
  try {
    buffer = readFileSync(path);
  } catch (error) {
    counts.archivesUnreadable += 1;
    recordFinding({ path, archiveEntryPath: null, label: `archive could not be read (${error.code || error.message})`, matchedText: "n/a" });
    return;
  }
  scanArchiveBuffer(path, buffer);
}

function scanRegularFile(path, size) {
  if (size > MAX_FILE_BYTES) {
    counts.filesSkippedOversize += 1;
    return;
  }
  let buffer;
  try {
    buffer = readFileSync(path);
  } catch {
    return; // unreadable (permissions, race with a concurrent delete) -- not this scanner's job to report filesystem errors as findings.
  }
  counts.filesScanned += 1;
  scanContent(buffer.toString("latin1"), path, null);
}

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      walk(join(dir, entry.name));
      continue;
    }
    if (!entry.isFile()) continue; // skip symlinks/sockets/etc -- never dereferenced.
    const fullPath = join(dir, entry.name);
    counts.filesWalked += 1;
    if (isGitignoredEnvFile(entry.name)) {
      counts.filesSkippedGitignoredEnv += 1;
      gitignoredEnvFilesSeen.push(fullPath);
      continue;
    }
    if (isArchivePath(fullPath)) {
      scanArchiveFile(fullPath);
      continue;
    }
    let size;
    try {
      size = statSync(fullPath).size;
    } catch {
      continue;
    }
    scanRegularFile(fullPath, size);
  }
}

function displayPath(path) {
  const rel = relative(ROOT, path);
  return rel.startsWith("..") ? path : rel.split(sep).join("/");
}

walk(ROOT);

const totalScanned = counts.filesScanned + counts.archiveEntriesScanned;
console.log(`Repo secret scan root: ${displayPath(ROOT) || "."}`);
console.log(`Files walked: ${counts.filesWalked}`);
console.log(`Files scanned (content matched): ${counts.filesScanned}`);
console.log(`Files skipped (oversize > ${MAX_FILE_BYTES} bytes): ${counts.filesSkippedOversize}`);
console.log(
  `Files skipped (gitignored .env / .env.* local secrets store, per capro-backend/.gitignore): ${counts.filesSkippedGitignoredEnv}`,
);
for (const path of gitignoredEnvFilesSeen) {
  console.log(`  -- not content-scanned (intended local secrets vault, git-ignored): ${displayPath(path)}`);
}
console.log(`Archive entries scanned (content matched): ${counts.archiveEntriesScanned}`);
console.log(`Archive entries skipped (oversize): ${counts.archiveEntriesSkippedOversize}`);
console.log(`Archives/entries unreadable (unsupported/corrupt): ${counts.archivesUnreadable}`);
console.log(`Archives unsupported format (.7z / exotic tar compression): ${counts.archivesUnsupportedFormat}`);
console.log(`Total files + archive entries scanned: ${totalScanned}`);

if (findings.length > 0) {
  console.log("");
  console.log(`Findings (${findings.length}):`);
  for (const finding of findings) {
    const location = finding.archiveEntryPath
      ? `${displayPath(finding.path)} :: ${finding.archiveEntryPath}`
      : displayPath(finding.path);
    console.log(
      `  REFUSED: ${location} -- ${finding.label} (matched length=${finding.matchedLength}, first3=${JSON.stringify(finding.matchedFirst3)})`,
    );
  }
  process.exit(1);
}

console.log("");
console.log("No secret-shaped matches found.");
