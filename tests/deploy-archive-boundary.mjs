import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repositoryRoot = process.cwd();
const builderPath = resolve("tools/make-deploy-archive.ps1");
const gatePath = resolve("tools/run-gates.ps1");

const TEMPORARY_PREFIX = "capro-deploy-boundary-";
const STALE_TEMPORARY_AGE_MS = 2 * 60 * 60 * 1000;

// This suite removes its own directory in a finally block, but this environment
// kills long-running child processes part-way, and a killed process never runs
// finally. Several hundred megabytes of git fixtures had accumulated in the temp
// directory as a result. Sweeping older leftovers on the way in keeps that
// bounded without depending on a clean exit.
//
// The age bound is what makes this safe to do while another run may be in
// progress: a live run's directory is minutes old, never hours.
function removeStaleTemporaryRoots() {
  const now = Date.now();
  let candidates;
  try {
    candidates = readdirSync(tmpdir());
  } catch {
    return;
  }
  for (const entry of candidates) {
    if (!entry.startsWith(TEMPORARY_PREFIX)) continue;
    const candidate = join(tmpdir(), entry);
    try {
      const stats = statSync(candidate);
      if (!stats.isDirectory()) continue;
      if (now - stats.mtimeMs < STALE_TEMPORARY_AGE_MS) continue;
      rmSync(candidate, { force: true, recursive: true });
    } catch {
      // A directory another process is still using, or already gone. Leave it.
    }
  }
}

removeStaleTemporaryRoots();
const temporaryRoot = mkdtempSync(join(tmpdir(), TEMPORARY_PREFIX));
let passed = 0;
let failed = 0;

function run(file, args, options = {}) {
  return spawnSync(file, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
    timeout: options.timeout ?? 120_000,
    windowsHide: true,
  });
}

// The tar compatibility probes below pass a BARE FILENAME and set the child's cwd to the fixture
// directory. They deliberately do not pass an absolute path, in either Windows or POSIX form.
//
// A Windows drive-letter path breaks GNU tar: it reads the colon as `host:path` remote-archive
// syntax and fails with "Cannot connect to C: resolve failed" before reading the file, and
// `--force-local` only trades that for MSYS mangling the backslashes. So an earlier version of this
// file converted to the POSIX form GNU tar wants (`/c/Users/...`) - and that broke the other way:
// `tar` on PATH is whichever binary the operator's shell resolves, and the two disagree.
// Measured 2026-08-26 on this machine: from Git Bash `tar` is Git for Windows' GNU tar 1.35, which
// reads `/c/Users/...`; from PowerShell - and therefore from tools/run-gates.ps1, and from CI -
// `tar` is C:\WINDOWS\system32\tar.exe, bsdtar 3.8.4, which cannot open that form at all. The suite
// passed in one shell and failed five checks in the other, which for a gate guarding polyglot
// refusal in the deploy archive is worse than either result alone.
//
// A bare filename with cwd set has no colon and no backslashes, so there is nothing for either
// binary to reinterpret. Verified against both: GNU tar 1.35 and bsdtar 3.8.4 each list the entry
// and exit 0. None of this touches the production tooling, which never shells out to tar
// (make-deploy-archive.ps1 parses tar headers itself via its own Get-TarHeader).

function resultDetail(result) {
  return [result.error?.stack, result.stdout, result.stderr]
    .filter(Boolean)
    .join("\n")
    .trim();
}

function record(name, condition, result) {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL  ${name}`);
  const detail = resultDetail(result ?? {});
  if (detail) console.error(detail);
}

function requireSuccess(result, operation) {
  if (result.error || result.status !== 0) {
    throw new Error(`${operation} failed\n${resultDetail(result)}`);
  }
}

function copy(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

function git(fixtureRoot, args) {
  return run("git", args, { cwd: fixtureRoot, timeout: 120_000 });
}

function commitFixture(fixtureRoot, message, paths) {
  requireSuccess(
    git(fixtureRoot, ["-c", "core.autocrlf=false", "add", "--", ...paths]),
    `git add (${message})`,
  );
  requireSuccess(
    git(fixtureRoot, [
      "-c",
      "user.name=CA PRO Security Test",
      "-c",
      "user.email=security-test@example.invalid",
      "commit",
      "-q",
      "-m",
      message,
    ]),
    `git commit (${message})`,
  );
}

function addZipDigitalSignature(zipBytes) {
  const endSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const endOffset = zipBytes.lastIndexOf(endSignature);
  if (endOffset < 0 || endOffset + 22 > zipBytes.length) {
    throw new Error("ZIP fixture has no complete end record");
  }
  const commentLength = zipBytes.readUInt16LE(endOffset + 20);
  const centralSize = zipBytes.readUInt32LE(endOffset + 12);
  const centralOffset = zipBytes.readUInt32LE(endOffset + 16);
  if (
    endOffset + 22 + commentLength !== zipBytes.length ||
    centralOffset + centralSize !== endOffset
  ) {
    throw new Error("ZIP fixture central directory is not contiguous");
  }

  const signatureData = Buffer.from("capro-central-signature", "utf8");
  const signatureRecord = Buffer.alloc(6 + signatureData.length);
  signatureRecord.writeUInt32LE(0x05054b50, 0);
  signatureRecord.writeUInt16LE(signatureData.length, 4);
  signatureData.copy(signatureRecord, 6);
  const updatedEnd = Buffer.from(zipBytes.subarray(endOffset));
  updatedEnd.writeUInt32LE(centralSize + signatureRecord.length, 12);
  return Buffer.concat([
    zipBytes.subarray(0, endOffset),
    signatureRecord,
    updatedEnd,
  ]);
}

function addZipArchiveExtraData(zipBytes) {
  const endSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const endOffset = zipBytes.lastIndexOf(endSignature);
  if (endOffset < 0 || endOffset + 22 > zipBytes.length) {
    throw new Error("ZIP fixture has no complete end record");
  }
  const centralSize = zipBytes.readUInt32LE(endOffset + 12);
  const centralOffset = zipBytes.readUInt32LE(endOffset + 16);
  if (centralOffset + centralSize !== endOffset) {
    throw new Error("ZIP fixture central directory is not contiguous");
  }

  const extraData = Buffer.from("capro-archive-extra", "utf8");
  const extraRecord = Buffer.alloc(8 + extraData.length);
  extraRecord.writeUInt32LE(0x08064b50, 0);
  extraRecord.writeUInt32LE(extraData.length, 4);
  extraData.copy(extraRecord, 8);
  const updatedEnd = Buffer.from(zipBytes.subarray(endOffset));
  updatedEnd.writeUInt32LE(centralSize + extraRecord.length, 12);
  return Buffer.concat([
    zipBytes.subarray(0, centralOffset),
    extraRecord,
    zipBytes.subarray(centralOffset, endOffset),
    updatedEnd,
  ]);
}

function useZip64CentralSentinels(zipBytes) {
  const endSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const endOffset = zipBytes.lastIndexOf(endSignature);
  const centralOffset =
    endOffset >= 0 ? zipBytes.readUInt32LE(endOffset + 16) : -1;
  if (
    endOffset < 0 ||
    zipBytes.readUInt16LE(endOffset + 10) < 1 ||
    centralOffset < 0 ||
    zipBytes.readUInt32LE(centralOffset) !== 0x02014b50
  ) {
    throw new Error("ZIP64 sentinel fixture requires central entries");
  }
  const centralSize = zipBytes.readUInt32LE(endOffset + 12);
  const compressedSize = zipBytes.readUInt32LE(centralOffset + 20);
  const uncompressedSize = zipBytes.readUInt32LE(centralOffset + 24);
  const nameLength = zipBytes.readUInt16LE(centralOffset + 28);
  const extraLength = zipBytes.readUInt16LE(centralOffset + 30);
  const diskStart = zipBytes.readUInt16LE(centralOffset + 34);
  const localOffset = zipBytes.readUInt32LE(centralOffset + 42);
  const extraEnd = centralOffset + 46 + nameLength + extraLength;
  if (
    extraEnd > endOffset ||
    [compressedSize, uncompressedSize, localOffset].includes(0xffffffff) ||
    diskStart === 0xffff
  ) {
    throw new Error("ZIP fixture central entry is malformed");
  }

  const zip64Extra = Buffer.alloc(32);
  zip64Extra.writeUInt16LE(0x0001, 0);
  zip64Extra.writeUInt16LE(28, 2);
  zip64Extra.writeBigUInt64LE(BigInt(uncompressedSize), 4);
  zip64Extra.writeBigUInt64LE(BigInt(compressedSize), 12);
  zip64Extra.writeBigUInt64LE(BigInt(localOffset), 20);
  zip64Extra.writeUInt32LE(diskStart, 28);
  const prefix = Buffer.from(zipBytes.subarray(0, extraEnd));
  prefix.writeUInt16LE(extraLength + zip64Extra.length, centralOffset + 30);
  prefix.writeUInt32LE(0xffffffff, centralOffset + 20);
  prefix.writeUInt32LE(0xffffffff, centralOffset + 24);
  prefix.writeUInt16LE(0xffff, centralOffset + 34);
  prefix.writeUInt32LE(0xffffffff, centralOffset + 42);
  prefix.writeUInt16LE(
    Math.max(45, prefix.readUInt16LE(centralOffset + 6)),
    centralOffset + 6,
  );
  const updatedEnd = Buffer.from(zipBytes.subarray(endOffset));
  updatedEnd.writeUInt32LE(centralSize + zip64Extra.length, 12);
  return Buffer.concat([
    prefix,
    zip64Extra,
    zipBytes.subarray(extraEnd, endOffset),
    updatedEnd,
  ]);
}

function promoteZipToZip64(zipBytes) {
  const endSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const endOffset = zipBytes.lastIndexOf(endSignature);
  if (endOffset < 0 || endOffset + 22 > zipBytes.length) {
    throw new Error("ZIP fixture has no classic end record");
  }
  const entries = zipBytes.readUInt16LE(endOffset + 10);
  const centralSize = zipBytes.readUInt32LE(endOffset + 12);
  const centralOffset = zipBytes.readUInt32LE(endOffset + 16);
  if (centralOffset + centralSize !== endOffset) {
    throw new Error("ZIP fixture central directory is not contiguous");
  }

  const zip64End = Buffer.alloc(56);
  zip64End.writeUInt32LE(0x06064b50, 0);
  zip64End.writeBigUInt64LE(44n, 4);
  zip64End.writeUInt16LE(45, 12);
  zip64End.writeUInt16LE(45, 14);
  zip64End.writeUInt32LE(0, 16);
  zip64End.writeUInt32LE(0, 20);
  zip64End.writeBigUInt64LE(BigInt(entries), 24);
  zip64End.writeBigUInt64LE(BigInt(entries), 32);
  zip64End.writeBigUInt64LE(BigInt(centralSize), 40);
  zip64End.writeBigUInt64LE(BigInt(centralOffset), 48);

  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeUInt32LE(0, 4);
  locator.writeBigUInt64LE(BigInt(endOffset), 8);
  locator.writeUInt32LE(1, 16);

  const classicEnd = Buffer.from(zipBytes.subarray(endOffset));
  classicEnd.writeUInt16LE(0xffff, 8);
  classicEnd.writeUInt16LE(0xffff, 10);
  classicEnd.writeUInt32LE(0xffffffff, 12);
  classicEnd.writeUInt32LE(0xffffffff, 16);
  return Buffer.concat([
    zipBytes.subarray(0, endOffset),
    zip64End,
    locator,
    classicEnd,
  ]);
}

function crc32(bytes) {
  const table = new Uint32Array(256);
  for (let tableIndex = 0; tableIndex < table.length; tableIndex += 1) {
    let value = tableIndex;
    for (let bitIndex = 0; bitIndex < 8; bitIndex += 1) {
      value =
        (value & 1) !== 0 ? (0xedb88320 ^ (value >>> 1)) >>> 0 : value >>> 1;
    }
    table[tableIndex] = value >>> 0;
  }

  let value = 0xffffffff;
  for (const byte of bytes) {
    value = (table[(value ^ byte) & 0xff] ^ (value >>> 8)) >>> 0;
  }
  return (value ^ 0xffffffff) >>> 0;
}

function writeTarOctal(buffer, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, "0");
  if (encoded.length > length - 1) {
    throw new Error("TAR fixture numeric field overflowed");
  }
  buffer.write(encoded, offset, length - 1, "ascii");
  buffer[offset + length - 1] = 0;
}

// Writes an octal field with no left padding, so the digits are followed by NUL
// fill for the rest of the field. This is the form a reader accepts but a
// detector anchored on "digits then a single terminator" does not match, which
// is how a NUL-padded V7 tar reached publication while the left-zero-padded
// archive above was refused.
function writeNulPaddedTarOctal(buffer, offset, length, value) {
  const encoded = value.toString(8);
  if (encoded.length >= length) {
    throw new Error("TAR fixture numeric field overflowed");
  }
  buffer.fill(0, offset, offset + length);
  buffer.write(encoded, offset, encoded.length, "ascii");
}

// Fills the whole field with octal digits and no terminator byte at all. A
// reader that trims NUL and space and then checks the remainder is octal accepts
// this; a detector that requires a terminator in each field cannot match it.
function writeUnterminatedTarOctal(buffer, offset, length, value) {
  const encoded = value.toString(8).padStart(length, "0");
  if (encoded.length > length) {
    throw new Error("TAR fixture numeric field overflowed");
  }
  buffer.write(encoded, offset, length, "ascii");
}

// Leaves the mode field entirely NUL. The reader trims it to an empty string and
// treats that as zero, so the header is still valid.
function writeEmptyTarOctal(buffer, offset, length) {
  buffer.fill(0, offset, offset + length);
}

// Writes a leading NUL before the digits. GNU tar's own from_header tolerates
// this deliberately -- `where += !*where`, commented "Accommodate buggy tar of
// unknown vintage, which outputs leading NUL if the previous field overflows".
function writeLeadingNulTarOctal(buffer, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 2, "0");
  buffer.fill(0, offset, offset + length);
  buffer.write(encoded, offset + 1, encoded.length, "ascii");
}

function buildV7TarArchive(writeOctal) {
  const header = Buffer.alloc(512);
  header.write("empty.txt", 0, "ascii");
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, 0);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return Buffer.concat([header, Buffer.alloc(1024)]);
}

function createV7TarArchive() {
  return buildV7TarArchive(writeTarOctal);
}

function createNulPaddedV7TarArchive() {
  return buildV7TarArchive(writeNulPaddedTarOctal);
}

function createUnterminatedV7TarArchive() {
  return buildV7TarArchive(writeUnterminatedTarOctal);
}

// Only the mode field varies here, so the remaining fields keep the ordinary
// left-zero form and the header stays one a reader accepts.
function createModeVariantV7TarArchive(writeMode) {
  return buildV7TarArchive((buffer, offset, length, value) =>
    offset === 100
      ? writeMode(buffer, offset, length, value)
      : writeTarOctal(buffer, offset, length, value),
  );
}

function createRar4Block(type, flags, fixedFields = Buffer.alloc(0)) {
  const headerSize = 7 + fixedFields.length;
  const protectedHeader = Buffer.alloc(5 + fixedFields.length);
  protectedHeader[0] = type;
  protectedHeader.writeUInt16LE(flags, 1);
  protectedHeader.writeUInt16LE(headerSize, 3);
  fixedFields.copy(protectedHeader, 5);
  const block = Buffer.alloc(2 + protectedHeader.length);
  block.writeUInt16LE(crc32(protectedHeader) & 0xffff, 0);
  protectedHeader.copy(block, 2);
  return block;
}

function createRar4Archive() {
  return Buffer.concat([
    Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]),
    createRar4Block(0x73, 0, Buffer.alloc(6)),
    createRar4Block(0x7b, 0),
  ]);
}

function createRar5Block(type, specificFields = [0]) {
  const headerData = Buffer.from([type, 0, ...specificFields]);
  if (headerData.length >= 0x80) {
    throw new Error("RAR5 fixture header unexpectedly needs a multi-byte vint");
  }
  const protectedHeader = Buffer.concat([
    Buffer.from([headerData.length]),
    headerData,
  ]);
  const block = Buffer.alloc(4 + protectedHeader.length);
  block.writeUInt32LE(crc32(protectedHeader), 0);
  protectedHeader.copy(block, 4);
  return block;
}

function createRar5Archive() {
  return Buffer.concat([
    Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]),
    createRar5Block(1),
    createRar5Block(5),
  ]);
}

function createSevenZipArchive() {
  const nextHeader = Buffer.from([0x01, 0x00]);
  const signatureHeader = Buffer.alloc(32);
  Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]).copy(signatureHeader);
  signatureHeader[6] = 0;
  signatureHeader[7] = 4;
  signatureHeader.writeBigUInt64LE(0n, 12);
  signatureHeader.writeBigUInt64LE(BigInt(nextHeader.length), 20);
  signatureHeader.writeUInt32LE(crc32(nextHeader), 28);
  signatureHeader.writeUInt32LE(crc32(signatureHeader.subarray(12, 32)), 8);
  return Buffer.concat([signatureHeader, nextHeader]);
}

function createXzArchive() {
  return Buffer.from(
    "/Td6WFoAAATm1rRGAgAhARYAAAB0L+WjAQAWQ0EgUFJPIGFyY2hpdmUgYm91bmRhcnkAABK4IwcjNVpsAAEvF4EISbEftvN9AQAAAAAEWVo=",
    "base64",
  );
}

function withPngPrefix(archiveBytes) {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from("CA-PRO-BOUNDARY"),
    archiveBytes,
  ]);
}

function repeatBytes(bytes, count) {
  const repeated = Buffer.alloc(bytes.length * count);
  for (let index = 0; index < count; index += 1) {
    bytes.copy(repeated, index * bytes.length);
  }
  return repeated;
}

function readClassicZipUnixModes(zipBytes) {
  const endSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const endOffset = zipBytes.lastIndexOf(endSignature);
  if (endOffset < 0 || endOffset + 22 > zipBytes.length) {
    throw new Error("published ZIP has no classic end record");
  }
  const entryCount = zipBytes.readUInt16LE(endOffset + 10);
  const centralOffset = zipBytes.readUInt32LE(endOffset + 16);
  const modes = new Map();
  let cursor = centralOffset;
  for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
    if (
      cursor + 46 > endOffset ||
      zipBytes.readUInt32LE(cursor) !== 0x02014b50
    ) {
      throw new Error("published ZIP central directory is malformed");
    }
    const nameLength = zipBytes.readUInt16LE(cursor + 28);
    const extraLength = zipBytes.readUInt16LE(cursor + 30);
    const commentLength = zipBytes.readUInt16LE(cursor + 32);
    const name = zipBytes
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString("utf8");
    modes.set(name, zipBytes.readUInt32LE(cursor + 38) >>> 16);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return modes;
}

function parseArtifactRecord(result) {
  const prefix = "CAPRO_DEPLOY_ARTIFACT=";
  const line = result.stdout
    .split(/\r?\n/u)
    .find((candidate) => candidate.startsWith(prefix));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(prefix.length));
  } catch {
    return null;
  }
}

function runBuilder(fixtureRoot, outputRoot, { validateOnly = true } = {}) {
  const args = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    builderPath,
    "-RepoRoot",
    fixtureRoot,
    "-OutputDirectory",
    outputRoot,
  ];
  if (validateOnly) args.push("-ValidateOnly");
  return run("powershell.exe", args, {
    cwd: fixtureRoot,
    timeout: 300_000,
  });
}

try {
  const probeRoot = join(temporaryRoot, "process-probe");
  mkdirSync(probeRoot, { recursive: true });
  const exitedChildPidPath = join(probeRoot, "exited-parent-child.pid");
  const gateExitedChildPidPath = join(
    probeRoot,
    "gate-exited-parent-child.pid",
  );
  const timedChildPidPath = join(probeRoot, "timed-parent-child.pid");
  const builderAssignmentPidPath = join(
    probeRoot,
    "builder-assignment-failure-child.pid",
  );
  const gateAssignmentPidPath = join(
    probeRoot,
    "gate-assignment-failure-child.pid",
  );
  const parentScriptPath = join(probeRoot, "parent.ps1");
  const ioProbePath = join(probeRoot, "io-probe.ps1");
  const helperProbePath = join(probeRoot, "helper-probe.ps1");
  writeFileSync(
    parentScriptPath,
    [
      "param([Parameter(Mandatory = $true)][string]$PidFile, [switch]$ExitImmediately)",
      "$child = Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 30; Write-Output descendant-complete') -NoNewWindow -PassThru",
      "[System.IO.File]::WriteAllText($PidFile, [string]$child.Id)",
      "if ($ExitImmediately) { exit 0 }",
      "Start-Sleep -Seconds 30",
    ].join("\r\n"),
  );
  writeFileSync(
    ioProbePath,
    [
      "param([Parameter(Mandatory = $true)][ValidateSet('Binary', 'BinaryError', 'Text')][string]$Mode)",
      "$inputMemory = [System.IO.MemoryStream]::new()",
      "try { [Console]::OpenStandardInput().CopyTo($inputMemory); [byte[]]$inputBytes = $inputMemory.ToArray() } finally { $inputMemory.Dispose() }",
      "if ($Mode -eq 'Binary') {",
      "  [byte[]]$expectedInput = @(0, 1, 128, 255)",
      "  if ($inputBytes.Length -ne $expectedInput.Length) { throw 'binary stdin length mismatch' }",
      "  for ($index = 0; $index -lt $expectedInput.Length; $index++) { if ($inputBytes[$index] -ne $expectedInput[$index]) { throw 'binary stdin content mismatch' } }",
      "  [byte[]]$outputBytes = @(0, 1, 127, 128, 255)",
      "  [byte[]]$errorBytes = @(0, 128, 255)",
      "  [Console]::OpenStandardOutput().Write($outputBytes, 0, $outputBytes.Length)",
      "  [Console]::OpenStandardError().Write($errorBytes, 0, $errorBytes.Length)",
      "  exit 0",
      "}",
      "if ($Mode -eq 'BinaryError') {",
      "  if ($inputBytes.Length -ne 0) { throw 'binary error probe expected stdin EOF' }",
      "  [byte[]]$errorBytes = @(0, 128, 255)",
      "  [Console]::OpenStandardError().Write($errorBytes, 0, $errorBytes.Length)",
      "  exit 0",
      "}",
      "if ($inputBytes.Length -ne 0) { throw 'text probe expected stdin EOF' }",
      "[Console]::Out.Write(('O' * 1048576))",
      "[Console]::Error.Write(('E' * 1048576))",
    ].join("\r\n"),
  );

  const powerShellLiteral = (value) => `'${value.replaceAll("'", "''")}'`;
  const archiveNoiseBudgetMs = 10_000;
  const emptyBufferDigest =
    "E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855";
  const byteArrayRejectionCases = [
    {
      expression: "Get-Crc32 -Bytes @(1, 2, 3) -Offset 0 -Count 3",
      reason: "CRC32 requires a byte array",
    },
    {
      expression: "Test-NestedArchiveMagic -Bytes 'not-bytes'",
      reason: "nested archive detection requires a byte array",
    },
    {
      expression: "Get-SecretScanTextViews -Bytes 7",
      reason: "secret scan text views require a byte array",
    },
    {
      expression: "Get-Sha256Hex -Bytes @(1, 2, 3)",
      reason: "SHA-256 hashing requires a byte array",
    },
  ];
  const archiveNoiseCases = [
    {
      description: "TAR checksum-like noise",
      functionName: "Test-CoherentTarArchive",
      path: join(probeRoot, "tar-checksum-noise.bin"),
      bytes: repeatBytes(Buffer.from("000000\0 ", "latin1"), 4_097),
    },
    {
      description: "RAR4 signature noise",
      functionName: "Test-CoherentRar4Archive",
      path: join(probeRoot, "rar4-signature-noise.bin"),
      bytes: repeatBytes(
        Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]),
        4_097,
      ),
    },
    {
      description: "RAR5 signature noise",
      functionName: "Test-CoherentRar5Archive",
      path: join(probeRoot, "rar5-signature-noise.bin"),
      bytes: repeatBytes(
        Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]),
        4_097,
      ),
    },
    {
      description: "7z signature noise",
      functionName: "Test-CoherentSevenZipArchive",
      path: join(probeRoot, "seven-zip-signature-noise.bin"),
      bytes: repeatBytes(
        Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]),
        4_097,
      ),
    },
    {
      description: "XZ signature and footer noise",
      functionName: "Test-CoherentXzArchive",
      path: join(probeRoot, "xz-signature-noise.bin"),
      bytes: repeatBytes(
        Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 0x59, 0x5a]),
        4_097,
      ),
    },
    {
      description: "ZIP end-signature noise",
      functionName: "Test-CoherentZipArchive",
      path: join(probeRoot, "zip-end-signature-noise.bin"),
      bytes: repeatBytes(Buffer.from([0x50, 0x4b, 0x05, 0x06]), 4_097),
    },
  ];
  for (const archiveNoiseCase of archiveNoiseCases) {
    writeFileSync(archiveNoiseCase.path, archiveNoiseCase.bytes);
  }
  const tarBudgetNoisePath = join(probeRoot, "tar-budget-noise.bin");
  writeFileSync(
    tarBudgetNoisePath,
    repeatBytes(Buffer.from("000000\0 ", "latin1"), 400_000),
  );
  writeFileSync(
    helperProbePath,
    [
      "$ErrorActionPreference = 'Stop'",
      `$builderPath = ${powerShellLiteral(builderPath)}`,
      `$gatePath = ${powerShellLiteral(gatePath)}`,
      `$parentScriptPath = ${powerShellLiteral(parentScriptPath)}`,
      `$ioProbePath = ${powerShellLiteral(ioProbePath)}`,
      `$exitedChildPidPath = ${powerShellLiteral(exitedChildPidPath)}`,
      `$gateExitedChildPidPath = ${powerShellLiteral(gateExitedChildPidPath)}`,
      `$timedChildPidPath = ${powerShellLiteral(timedChildPidPath)}`,
      `$builderAssignmentPidPath = ${powerShellLiteral(builderAssignmentPidPath)}`,
      `$gateAssignmentPidPath = ${powerShellLiteral(gateAssignmentPidPath)}`,
      "function Assert-RecordedChildStopped {",
      "  param([Parameter(Mandatory = $true)][string]$PidPath, [Parameter(Mandatory = $true)][string]$Description)",
      "  $recordDeadline = [DateTime]::UtcNow.AddSeconds(30)",
      "  while (-not (Test-Path -LiteralPath $PidPath) -and [DateTime]::UtcNow -lt $recordDeadline) { Start-Sleep -Milliseconds 100 }",
      '  if (-not (Test-Path -LiteralPath $PidPath)) { throw "$Description child PID was not recorded" }',
      "  $childPid = [int]([System.IO.File]::ReadAllText($PidPath))",
      "  $exitDeadline = [DateTime]::UtcNow.AddSeconds(30)",
      "  $remaining = Get-Process -Id $childPid -ErrorAction SilentlyContinue",
      "  while ($null -ne $remaining -and [DateTime]::UtcNow -lt $exitDeadline) {",
      "    Start-Sleep -Milliseconds 100",
      "    $remaining = Get-Process -Id $childPid -ErrorAction SilentlyContinue",
      "  }",
      "  if ($null -ne $remaining) {",
      "    Stop-Process -Id $childPid -Force -ErrorAction SilentlyContinue",
      '    throw "$Description descendant remained alive"',
      "  }",
      "}",
      "function Assert-TargetNeverStarted {",
      "  param([Parameter(Mandatory = $true)][string]$PidPath, [Parameter(Mandatory = $true)][string]$Description)",
      "  Start-Sleep -Milliseconds 500",
      "  if (-not (Test-Path -LiteralPath $PidPath)) { return }",
      "  $childPid = [int]([System.IO.File]::ReadAllText($PidPath))",
      "  Stop-Process -Id $childPid -Force -ErrorAction SilentlyContinue",
      '  throw "$Description target started before Job assignment succeeded"',
      "}",
      "function Install-FailingJobFactory {",
      "  function global:New-KillOnCloseProcessJob {",
      "    $job = [pscustomobject]@{}",
      "    $job | Add-Member -MemberType ScriptMethod -Name Assign -Value { param([IntPtr]$processHandle) throw 'forced job assignment failure' }",
      "    $job | Add-Member -MemberType ScriptMethod -Name Dispose -Value { }",
      "    return $job",
      "  }",
      "}",
      "$tokens = $null; $errors = $null",
      "$builderAst = [System.Management.Automation.Language.Parser]::ParseFile($builderPath, [ref]$tokens, [ref]$errors)",
      "if ($errors.Count -gt 0) { throw 'builder parse failed' }",
      "$magicDefinitions = foreach ($name in @('Get-Crc32', 'Get-Sha256Hex', 'Read-Rar5VariableUInt', 'Read-XzVariableUInt', 'Test-ZeroByteRange', 'Get-TarHeader', 'Test-CoherentTarArchive', 'Test-CoherentRar4Archive', 'Test-CoherentRar5Archive', 'Test-CoherentSevenZipArchive', 'Test-CoherentXzArchive', 'Test-CoherentZstdArchive', 'Get-Zip64CentralValues', 'Test-ZipCentralDirectoryRecords', 'Test-CoherentZipArchive', 'Test-NestedArchiveMagic', 'Get-SecretScanTextViews')) {",
      "  $definition = $builderAst.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)",
      '  if ($null -eq $definition) { throw "missing archive detector function: $name" }',
      "  $definition.Extent.Text",
      "}",
      "$bytePreservingDecoder = [System.Text.Encoding]::GetEncoding(28591)",
      "$utf8Decoder = [System.Text.UTF8Encoding]::new($false, $true)",
      'Invoke-Expression ($magicDefinitions -join "`r`n`r`n")',
      "$archiveNoiseStopwatch = [System.Diagnostics.Stopwatch]::StartNew()",
      ...archiveNoiseCases.map(
        ({ description, functionName, path }) =>
          `if (${functionName} -Bytes ([System.IO.File]::ReadAllBytes(${powerShellLiteral(path)}))) { throw '${description} was misclassified as a coherent archive' }`,
      ),
      "$archiveNoiseStopwatch.Stop()",
      `if ($archiveNoiseStopwatch.ElapsedMilliseconds -gt ${archiveNoiseBudgetMs}) { throw "archive complexity noise probes took $($archiveNoiseStopwatch.ElapsedMilliseconds) ms against a ${archiveNoiseBudgetMs} ms budget; a whole-buffer helper argument is being copied on every call" }`,
      "Write-Output 'archive complexity noise probes passed'",
      "[byte[]]$png = @(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4)",
      "[byte[]]$fakeZipSignature = $png + [byte[]]@(0x50, 0x4B, 0x03, 0x04, 0, 0, 0, 0)",
      "if (Test-NestedArchiveMagic -Bytes $png) { throw 'benign PNG header was rejected' }",
      "if (Test-NestedArchiveMagic -Bytes $fakeZipSignature) { throw 'isolated ZIP signature was rejected' }",
      "Write-Output 'archive detector helper probes passed'",
      "[byte[]]$emptyBuffer = New-Object 'byte[]' 0",
      "if (Test-NestedArchiveMagic -Bytes $emptyBuffer) { throw 'empty buffer was reported as a nested archive' }",
      "[byte[]]$zstdFrame = @(0x28, 0xB5, 0x2F, 0xFD, 0x24, 0x10, 0x00, 0x00, 0x00, 0x11, 0x22, 0x33)",
      "if (-not (Test-CoherentZstdArchive -Bytes $zstdFrame)) { throw 'coherent zstd frame was not detected' }",
      "if (-not (Test-NestedArchiveMagic -Bytes $zstdFrame)) { throw 'coherent zstd frame was not reported as a nested archive' }",
      "[byte[]]$zstdReserved = @(0x28, 0xB5, 0x2F, 0xFD, 0x08, 0x10, 0x00, 0x00, 0x00, 0x11, 0x22, 0x33)",
      "if (Test-CoherentZstdArchive -Bytes $zstdReserved) { throw 'zstd frame with a set reserved bit was accepted' }",
      "$tarBudgetStopwatch = [System.Diagnostics.Stopwatch]::StartNew()",
      "$tarBudgetBounded = $false",
      `try { [void](Test-CoherentTarArchive -Bytes ([System.IO.File]::ReadAllBytes(${powerShellLiteral(tarBudgetNoisePath)}))) ; $tarBudgetBounded = $true } catch { if ($_.Exception.Message -notmatch 'TAR archive candidate scan (exceeded its work budget|timed out)') { throw } ; $tarBudgetBounded = $true }`,
      "$tarBudgetStopwatch.Stop()",
      "if (-not $tarBudgetBounded) { throw 'TAR candidate scan did not complete' }",
      'if ($tarBudgetStopwatch.ElapsedMilliseconds -gt 60000) { throw "TAR candidate scan on 3.2 MB of header-shaped noise took $($tarBudgetStopwatch.ElapsedMilliseconds) ms; the work bound is not holding" }',
      "if ((Get-Crc32 -Bytes $emptyBuffer -Offset 0 -Count 0) -ne 0) { throw 'empty-buffer CRC32 is not zero' }",
      `if ((Get-Sha256Hex -Bytes $emptyBuffer) -ne '${emptyBufferDigest}') { throw 'empty-buffer SHA-256 is not the canonical empty digest' }`,
      "if (@(Get-SecretScanTextViews -Bytes $emptyBuffer).Count -lt 1) { throw 'empty buffer produced no scan view' }",
      ...byteArrayRejectionCases.flatMap(({ expression, reason }) => [
        "$rejected = $false",
        `try { [void](${expression}) } catch { if ($_.Exception.Message -ne ${powerShellLiteral(reason)}) { throw } ; $rejected = $true }`,
        `if (-not $rejected) { throw 'non-byte-array input was silently coerced instead of refused: ${reason}' }`,
      ]),
      "Write-Output 'byte array contract probes passed'",
      "$builderDefinitions = foreach ($name in @('ConvertTo-NativeArgument', 'Get-RemainingTimeout', 'Wait-TaskWithinTimeout', 'New-KillOnCloseProcessJob', 'Get-ContainedProcessLauncherCommand', 'Invoke-BoundedProcess')) {",
      "  $definition = $builderAst.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)",
      '  if ($null -eq $definition) { throw "missing builder function: $name" }',
      "  $definition.Extent.Text",
      "}",
      'Invoke-Expression ($builderDefinitions -join "`r`n`r`n")',
      "$utf8Encoder = [System.Text.UTF8Encoding]::new($false)",
      "[byte[]]$binaryInput = @(0, 1, 128, 255)",
      "$binaryResult = Invoke-BoundedProcess -FilePath powershell.exe -Arguments @('-NoProfile', '-NonInteractive', '-File', $ioProbePath, '-Mode', 'Binary') -WorkingDirectory (Split-Path -Parent $ioProbePath) -TimeoutMs 20000 -StandardInput $binaryInput -CaptureBinaryOutput",
      "if ($binaryResult.ExitCode -ne 0) { throw 'builder binary probe returned nonzero' }",
      "[byte[]]$expectedBinaryOutput = @(0, 1, 127, 128, 255)",
      "if (-not ($binaryResult.StandardOutput -is [byte[]]) -or $binaryResult.StandardOutput.Length -ne $expectedBinaryOutput.Length) { $resultTypes = @($binaryResult | ForEach-Object { $_.GetType().FullName }) -join ','; $outputType = if ($null -eq $binaryResult.StandardOutput) { '<null>' } else { $binaryResult.StandardOutput.GetType().FullName }; throw \"builder binary stdout shape mismatch resultTypes=$resultTypes outputType=$outputType outputLength=$($binaryResult.StandardOutput.Length)\" }",
      "for ($index = 0; $index -lt $expectedBinaryOutput.Length; $index++) { if ($binaryResult.StandardOutput[$index] -ne $expectedBinaryOutput[$index]) { throw 'builder binary stdout content mismatch' } }",
      "[byte[]]$expectedBinaryError = @(0, 128, 255)",
      "if (-not ($binaryResult.StandardErrorBytes -is [byte[]]) -or $binaryResult.StandardErrorBytes.Length -ne $expectedBinaryError.Length) { throw 'builder binary stderr shape mismatch' }",
      "for ($index = 0; $index -lt $expectedBinaryError.Length; $index++) { if ($binaryResult.StandardErrorBytes[$index] -ne $expectedBinaryError[$index]) { throw 'builder binary stderr content mismatch' } }",
      "Write-Output 'builder binary and stdin EOF probes passed'",
      "$builderExitedResult = Invoke-BoundedProcess -FilePath powershell.exe -Arguments @('-NoProfile', '-NonInteractive', '-File', $parentScriptPath, '-PidFile', $exitedChildPidPath, '-ExitImmediately') -WorkingDirectory (Split-Path -Parent $parentScriptPath) -TimeoutMs 20000",
      "if ($builderExitedResult.ExitCode -ne 0) { throw 'exited-parent builder probe returned nonzero' }",
      "Assert-RecordedChildStopped -PidPath $exitedChildPidPath -Description 'normal-return exited-parent builder probe'",
      "Install-FailingJobFactory",
      "$builderAssignmentFailed = $false",
      "try {",
      "  [void](Invoke-BoundedProcess -FilePath powershell.exe -Arguments @('-NoProfile', '-NonInteractive', '-File', $parentScriptPath, '-PidFile', $builderAssignmentPidPath) -WorkingDirectory (Split-Path -Parent $parentScriptPath) -TimeoutMs 20000)",
      "}",
      "catch {",
      "  if ($_.Exception.Message -notmatch 'forced job assignment failure') { throw }",
      "  $builderAssignmentFailed = $true",
      "}",
      "if (-not $builderAssignmentFailed) { throw 'builder assignment-failure probe did not fail' }",
      "Assert-TargetNeverStarted -PidPath $builderAssignmentPidPath -Description 'builder assignment-failure probe'",
      "$tokens = $null; $errors = $null",
      "$gateAst = [System.Management.Automation.Language.Parser]::ParseFile($gatePath, [ref]$tokens, [ref]$errors)",
      "if ($errors.Count -gt 0) { throw 'gate parse failed' }",
      "$gateDefinitions = foreach ($name in @('ConvertTo-NativeArgument', 'New-KillOnCloseProcessJob', 'Get-ContainedProcessLauncherCommand', 'Invoke-CapturedProcess', 'Get-GateSummary')) {",
      "  $definition = $gateAst.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)",
      '  if ($null -eq $definition) { throw "missing gate function: $name" }',
      "  $definition.Extent.Text",
      "}",
      'Invoke-Expression ($gateDefinitions -join "`r`n`r`n")',
      "$gateIoResult = Invoke-CapturedProcess -FilePath powershell.exe -Arguments @('-NoProfile', '-NonInteractive', '-File', $ioProbePath, '-Mode', 'Text') -WorkingDirectory (Split-Path -Parent $ioProbePath) -TimeoutMs 30000",
      "if ($gateIoResult.ExitCode -ne 0) { throw 'gate IO probe returned nonzero' }",
      "if ($gateIoResult.StandardOutput.Length -ne 1048576 -or $gateIoResult.StandardOutput -notmatch '^O+$') { throw 'gate stdout drainage mismatch' }",
      "if ($gateIoResult.StandardError.Length -ne 1048576 -or $gateIoResult.StandardError -notmatch '^E+$') { throw 'gate stderr drainage mismatch' }",
      "$gateBinaryResult = Invoke-CapturedProcess -FilePath powershell.exe -Arguments @('-NoProfile', '-NonInteractive', '-File', $ioProbePath, '-Mode', 'BinaryError') -WorkingDirectory (Split-Path -Parent $ioProbePath) -TimeoutMs 20000",
      "[byte[]]$expectedBinaryError = @(0, 128, 255)",
      "if (-not ($gateBinaryResult.StandardErrorBytes -is [byte[]]) -or $gateBinaryResult.StandardErrorBytes.Length -ne $expectedBinaryError.Length) { throw 'gate binary stderr shape mismatch' }",
      "for ($index = 0; $index -lt $expectedBinaryError.Length; $index++) { if ($gateBinaryResult.StandardErrorBytes[$index] -ne $expectedBinaryError[$index]) { throw 'gate binary stderr content mismatch' } }",
      "Write-Output 'gate concurrent output, binary stderr, and stdin EOF probes passed'",
      "$gateExitedResult = Invoke-CapturedProcess -FilePath powershell.exe -Arguments @('-NoProfile', '-NonInteractive', '-File', $parentScriptPath, '-PidFile', $gateExitedChildPidPath, '-ExitImmediately') -WorkingDirectory (Split-Path -Parent $parentScriptPath) -TimeoutMs 20000",
      "if ($gateExitedResult.ExitCode -ne 0) { throw 'exited-parent gate probe returned nonzero' }",
      "Assert-RecordedChildStopped -PidPath $gateExitedChildPidPath -Description 'normal-return exited-parent gate probe'",
      "$preCommitSummary = @(Get-GateSummary -FailureCount 0 -ArchiveValidationSkipped $true)",
      'if (($preCommitSummary -join "`n") -ne "===== SUMMARY =====`nfailing gates: 0`ndeployment ready: false`nPRE-COMMIT GATES GREEN - DEPLOY ARCHIVE NOT VALIDATED") { throw \'pre-commit summary semantics regressed\' }',
      "$releaseSummary = @(Get-GateSummary -FailureCount 0 -ArchiveValidationSkipped $false)",
      'if (($releaseSummary -join "`n") -ne "===== SUMMARY =====`nfailing gates: 0`ndeployment ready: true`nALL RELEASE GATES GREEN") { throw \'release summary semantics regressed\' }',
      "$failedSummary = @(Get-GateSummary -FailureCount 2 -ArchiveValidationSkipped $false)",
      'if (($failedSummary -join "`n") -ne "===== SUMMARY =====`nfailing gates: 2`ndeployment ready: false`nGATES FAILED - DO NOT DEPLOY") { throw \'failed summary semantics regressed\' }',
      "Write-Output 'gate summary probes passed'",
      "$timedOut = $false",
      "try {",
      "  [void](Invoke-CapturedProcess -FilePath powershell.exe -Arguments @('-NoProfile', '-NonInteractive', '-File', $parentScriptPath, '-PidFile', $timedChildPidPath) -WorkingDirectory (Split-Path -Parent $parentScriptPath) -TimeoutMs 15000)",
      "}",
      "catch {",
      "  if ($_.Exception.Message -notmatch 'timed out') { throw }",
      "  $timedOut = $true",
      "}",
      "if (-not $timedOut) { throw 'process probe did not time out' }",
      "Assert-RecordedChildStopped -PidPath $timedChildPidPath -Description 'timed gate probe'",
      "Install-FailingJobFactory",
      "$gateAssignmentFailed = $false",
      "try {",
      "  [void](Invoke-CapturedProcess -FilePath powershell.exe -Arguments @('-NoProfile', '-NonInteractive', '-File', $parentScriptPath, '-PidFile', $gateAssignmentPidPath) -WorkingDirectory (Split-Path -Parent $parentScriptPath) -TimeoutMs 20000)",
      "}",
      "catch {",
      "  if ($_.Exception.Message -notmatch 'forced job assignment failure') { throw }",
      "  $gateAssignmentFailed = $true",
      "}",
      "if (-not $gateAssignmentFailed) { throw 'gate assignment-failure probe did not fail' }",
      "Assert-TargetNeverStarted -PidPath $gateAssignmentPidPath -Description 'gate assignment-failure probe'",
      "Write-Output 'job-object lifecycle probes passed'",
      "Write-Output 'PowerShell helper probes passed'",
    ].join("\r\n"),
  );

  const helperProbe = run(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      helperProbePath,
    ],
    { cwd: probeRoot, timeout: 300_000 },
  );
  for (const [name, marker] of [
    [
      "archive complexity noise probes pass",
      "archive complexity noise probes passed",
    ],
    [
      "embedded archive helper probes pass",
      "archive detector helper probes passed",
    ],
    [
      "whole-buffer helpers accept empty buffers and refuse non-byte-array input",
      "byte array contract probes passed",
    ],
    [
      "builder binary output and stdin EOF probes pass",
      "builder binary and stdin EOF probes passed",
    ],
    [
      "gate concurrent output, binary stderr, and stdin EOF probes pass",
      "gate concurrent output, binary stderr, and stdin EOF probes passed",
    ],
    ["gate summary semantics probes pass", "gate summary probes passed"],
    [
      "guarded job-object lifecycle helpers pass",
      "job-object lifecycle probes passed",
    ],
  ]) {
    record(
      name,
      helperProbe.status === 0 &&
        !helperProbe.error &&
        helperProbe.stdout.includes(marker),
      helperProbe,
    );
  }

  const fixtureRoot = join(temporaryRoot, "fixture");
  const outputRoot = join(temporaryRoot, "output");
  mkdirSync(outputRoot, { recursive: true });
  copy(join(repositoryRoot, "package.json"), join(fixtureRoot, "package.json"));
  copy(
    join(repositoryRoot, "package-lock.json"),
    join(fixtureRoot, "package-lock.json"),
  );
  copy(
    join(repositoryRoot, "tools", "scan-deploy-secrets.mjs"),
    join(fixtureRoot, "tools", "scan-deploy-secrets.mjs"),
  );
  copy(
    join(repositoryRoot, "node_modules", "acorn", "dist", "acorn.mjs"),
    join(fixtureRoot, "node_modules", "acorn", "dist", "acorn.mjs"),
  );
  mkdirSync(join(fixtureRoot, "src"), { recursive: true });
  mkdirSync(join(fixtureRoot, "public"), { recursive: true });
  writeFileSync(
    join(fixtureRoot, "src", "server.js"),
    'console.log("deployment boundary fixture");\n',
    { flag: "wx" },
  );
  writeFileSync(
    join(fixtureRoot, "public", "index.html"),
    "<!doctype html>\n",
    {
      flag: "wx",
    },
  );

  requireSuccess(git(fixtureRoot, ["init", "-q"]), "git init");
  commitFixture(fixtureRoot, "baseline", [
    "package.json",
    "package-lock.json",
    "src/server.js",
    "public/index.html",
    "tools/scan-deploy-secrets.mjs",
  ]);

  const staleBuildPath = join(outputRoot, `.capro-build-${"a".repeat(32)}`);
  const stalePartialPath = join(
    outputRoot,
    `.capro-backend_20000101_000000.zip.partial-${"b".repeat(32)}`,
  );
  const freshBuildPath = join(outputRoot, `.capro-build-${"c".repeat(32)}`);
  const freshPartialPath = join(
    outputRoot,
    `.capro-backend_20990101_000000.zip.partial-${"d".repeat(32)}`,
  );
  const unrelatedOldPath = join(outputRoot, ".capro-build-not-owned");
  mkdirSync(staleBuildPath);
  writeFileSync(join(staleBuildPath, "candidate.zip"), "stale");
  writeFileSync(stalePartialPath, "stale");
  mkdirSync(freshBuildPath);
  writeFileSync(freshPartialPath, "fresh");
  writeFileSync(unrelatedOldPath, "unrelated");
  const staleTimestamp = new Date(Date.now() - 48 * 60 * 60 * 1000);
  utimesSync(staleBuildPath, staleTimestamp, staleTimestamp);
  utimesSync(stalePartialPath, staleTimestamp, staleTimestamp);
  utimesSync(unrelatedOldPath, staleTimestamp, staleTimestamp);

  const baseline = runBuilder(fixtureRoot, outputRoot);
  record(
    "clean commit-pinned archive validates end to end",
    baseline.status === 0 &&
      /validation only \(not published\)/i.test(baseline.stdout),
    baseline,
  );
  record(
    "only stale builder-owned artifacts are scavenged",
    baseline.status === 0 &&
      !existsSync(staleBuildPath) &&
      !existsSync(stalePartialPath) &&
      existsSync(freshBuildPath) &&
      existsSync(freshPartialPath) &&
      existsSync(unrelatedOldPath),
    baseline,
  );

  const inlineSecretPath = join(fixtureRoot, "public", "inline-secret.html");
  for (const secretCase of [
    {
      name: "direct non-JavaScript text hardcoded secret assignment is refused",
      message: "direct inline HTML secret",
      source: '<script>JWT_SECRET = "hardcoded-supersecret";</script>\n',
    },
    {
      name: "dotted-member non-JavaScript secret assignment is refused",
      message: "dotted inline HTML secret",
      source:
        '<script>window.JWT_SECRET = "dotted-hardcoded-supersecret";</script>\n',
    },
    {
      name: "bracket-member non-JavaScript secret assignment is refused",
      message: "bracket inline HTML secret",
      source:
        '<script>window["JWT_SECRET"] = "bracket-hardcoded-supersecret";</script>\n',
    },
    {
      name: "CSS custom-property hardcoded secret assignment is refused",
      message: "CSS custom property secret",
      source: ":root { --JWT_SECRET: css-hardcoded-supersecret; }\n",
    },
    {
      name: "template-literal inline JavaScript secret assignment is refused",
      message: "template literal inline HTML secret",
      source:
        "<script>window.JWT_SECRET = `template-hardcoded-supersecret`;</script>\n",
    },
    {
      name: "encoded-key inline JavaScript secret assignment is refused",
      message: "encoded key inline HTML secret",
      source:
        '<script>window["JWT\\u005fSECRET"] = "encoded-hardcoded-supersecret";</script>\n',
    },
    {
      name: "wrapped inline JavaScript secret assignment is refused",
      message: "wrapped inline HTML secret",
      source:
        '<script>window.JWT_SECRET = String("wrapped-hardcoded-supersecret");</script>\n',
    },
    {
      name: "unquoted non-JavaScript secret assignment is refused",
      message: "unquoted inline HTML secret",
      source: "<p>JWT_SECRET=3f9c1e77a4b8d2065e1f4a7c9b3d5e80</p>\n",
    },
    {
      name: "unquoted colon-delimited secret assignment is refused",
      message: "unquoted colon inline HTML secret",
      source: "<p>JWT_SECRET: 3f9c1e77a4b8d2065e1f4a7c9b3d5e80</p>\n",
    },
    {
      name: "backtick-delimited non-JavaScript secret assignment is refused",
      message: "backtick inline HTML secret",
      source: "<p>JWT_SECRET = `3f9c1e77a4b8d2065e1f4a7c9b3d5e80`</p>\n",
    },
  ]) {
    writeFileSync(inlineSecretPath, secretCase.source);
    commitFixture(fixtureRoot, secretCase.message, [
      "public/inline-secret.html",
    ]);
    const secretResult = runBuilder(fixtureRoot, outputRoot);
    record(
      secretCase.name,
      secretResult.status !== 0 &&
        (/REFUSED: archive text contains a hardcoded secret assignment: public\/inline-secret\.html/i.test(
          secretResult.stdout,
        ) ||
          /JavaScript secret scan failed: REFUSED: public\/inline-secret\.html#inline-script-\d+\.js:\d+:\d+ contains a hardcoded JWT_SECRET assignment/i.test(
            secretResult.stdout,
          )),
      secretResult,
    );
  }

  writeFileSync(
    inlineSecretPath,
    [
      "<script>",
      "window.JWT_SECRET = process.env.JWT_SECRET;",
      'window["JWT_SECRET"] = "${JWT_SECRET}";',
      "window.JWT_SECRET = `${process.env.JWT_SECRET}`;",
      'window["JWT\\u005fSECRET"] = process.env.JWT_SECRET;',
      "window.JWT_SECRET = String(process.env.JWT_SECRET);",
      "</script>",
      "<style>:root { --JWT_SECRET: var(--runtime-jwt-secret); }</style>",
      "",
    ].join("\n"),
  );
  commitFixture(fixtureRoot, "dynamic non-JavaScript secret controls", [
    "public/inline-secret.html",
  ]);
  const dynamicSecretControls = runBuilder(fixtureRoot, outputRoot);
  record(
    "dynamic and placeholder non-JavaScript secret controls remain accepted",
    dynamicSecretControls.status === 0 &&
      /validation only \(not published\)/i.test(dynamicSecretControls.stdout),
    dynamicSecretControls,
  );

  for (const inlineCase of [
    {
      name: "CDATA-wrapped inline script with a hardcoded secret is refused",
      message: "CDATA inline HTML secret",
      source:
        '<script type="text/javascript"><![CDATA[\nwindow.JWT_SECRET = "cdata-hardcoded-supersecret";\n]]></script>\n',
      refuse: true,
    },
    {
      name: "inline script attribute containing a quoted angle bracket is still scanned",
      message: "quoted angle bracket attribute inline HTML secret",
      source:
        '<script data-selector="a>b" type="text/javascript">window.JWT_SECRET = "attribute-hardcoded-supersecret";</script>\n',
      refuse: true,
    },
    {
      name: "CDATA-wrapped inline script reading the environment remains accepted",
      message: "CDATA inline HTML control",
      source:
        '<script type="text/javascript"><![CDATA[\nwindow.JWT_SECRET = process.env.JWT_SECRET;\n]]></script>\n',
      refuse: false,
    },
    {
      name: "empty-type inline script assembling a provider credential is refused",
      message: "empty type inline HTML secret",
      source:
        '<script type="">const k = "re_" + "AbCdEfGhIjKlMnOpQrStUvWxYz123456"; send(k);</script>\n',
      refuse: true,
    },
    {
      name: "empty-type inline script reading the environment remains accepted",
      message: "empty type inline HTML control",
      source:
        '<script type="">window.token = process.env.JWT_SECRET;</script>\n',
      refuse: false,
    },
    {
      name: "non-executable inline script type remains skipped",
      message: "non-executable inline HTML control",
      source:
        '<script type="application/json">{"note":"not javascript"}</script>\n',
      refuse: false,
    },
    {
      name: "unterminated inline script assembling a provider credential is refused",
      message: "unterminated inline HTML secret",
      source:
        '<html><body>\n<script>\nconst seg = ["re_", "AbCdEfGhIjKlMnOpQrStUvWxYz123456"];\nwindow.mailer = seg.join("");\n',
      refuse: true,
    },
    {
      name: "unterminated inline script reading the environment remains accepted",
      message: "unterminated inline HTML control",
      source: "<html><body>\n<script>\nwindow.t = process.env.JWT_SECRET;\n",
      refuse: false,
    },
    {
      name: "external src script body is not parsed as inline JavaScript",
      message: "external src inline HTML control",
      source: '<script src="/app.js">this is not javascript {{</script>\n',
      refuse: false,
    },
    {
      name: "mustache template type remains skipped",
      message: "mustache template inline HTML control",
      source:
        '<script type="text/x-mustache"><div>{{#each items}}<b>{{name}}</b>{{/each}}</div></script>\n',
      refuse: false,
    },
  ]) {
    writeFileSync(inlineSecretPath, inlineCase.source);
    commitFixture(fixtureRoot, inlineCase.message, [
      "public/inline-secret.html",
    ]);
    const inlineResult = runBuilder(fixtureRoot, outputRoot);
    record(
      inlineCase.name,
      inlineCase.refuse
        ? inlineResult.status !== 0 &&
            /REFUSED: (?:archive text contains a hardcoded secret assignment|JavaScript secret scan failed)/i.test(
              inlineResult.stdout,
            )
        : inlineResult.status === 0 &&
            /validation only \(not published\)/i.test(inlineResult.stdout),
      inlineResult,
    );
  }

  const utf16SecretPath = join(fixtureRoot, "public", "utf16-secret.txt");
  writeFileSync(
    utf16SecretPath,
    Buffer.from("JWT_SECRET=3f9c1e77a4b8d2065e1f4a7c9b3d5e80\r\n", "utf16le"),
  );
  commitFixture(fixtureRoot, "UTF-16 served secret", [
    "public/utf16-secret.txt",
  ]);
  const utf16Secret = runBuilder(fixtureRoot, outputRoot);
  record(
    "UTF-16 encoded secret assignment in a served text file is refused",
    utf16Secret.status !== 0 &&
      /REFUSED: archive text contains a hardcoded secret assignment: public\/utf16-secret\.txt/i.test(
        utf16Secret.stdout,
      ),
    utf16Secret,
  );

  writeFileSync(
    utf16SecretPath,
    "JWT_SECRET is documented in the hosting panel.\n",
  );
  commitFixture(fixtureRoot, "neutralise UTF-16 served secret", [
    "public/utf16-secret.txt",
  ]);

  const utf32SecretPath = join(fixtureRoot, "public", "utf32-secret.txt");
  const utf32Bytes = Buffer.alloc(
    "JWT_SECRET=3f9c1e77a4b8d2065e1f4a7c9b3d5e80".length * 4,
  );
  for (
    let index = 0;
    index < "JWT_SECRET=3f9c1e77a4b8d2065e1f4a7c9b3d5e80".length;
    index += 1
  ) {
    utf32Bytes.writeUInt32LE(
      "JWT_SECRET=3f9c1e77a4b8d2065e1f4a7c9b3d5e80".codePointAt(index),
      index * 4,
    );
  }
  writeFileSync(utf32SecretPath, utf32Bytes);
  commitFixture(fixtureRoot, "UTF-32 served secret", [
    "public/utf32-secret.txt",
  ]);
  const utf32Secret = runBuilder(fixtureRoot, outputRoot);
  record(
    "UTF-32 encoded secret assignment in a served text file is refused",
    utf32Secret.status !== 0 &&
      /REFUSED: archive text contains a hardcoded secret assignment: public\/utf32-secret\.txt/i.test(
        utf32Secret.stdout,
      ),
    utf32Secret,
  );
  rmSync(utf32SecretPath, { force: true });
  commitFixture(fixtureRoot, "remove UTF-32 served secret", [
    "public/utf32-secret.txt",
  ]);

  writeFileSync(
    utf16SecretPath,
    "Set JWT_SECRET: your signing key here\nJWT_SECRET is required, no default.\n",
  );
  commitFixture(fixtureRoot, "documentation prose control", [
    "public/utf16-secret.txt",
  ]);
  const proseControl = runBuilder(fixtureRoot, outputRoot);
  record(
    "documentation prose naming a secret remains accepted",
    proseControl.status === 0 &&
      /validation only \(not published\)/i.test(proseControl.stdout),
    proseControl,
  );

  const truncatedTarPath = join(fixtureRoot, "public", "icon-carrier.png");
  const tarHeader = Buffer.alloc(512);
  tarHeader.write("secrets.env", 0, "ascii");
  writeTarOctal(tarHeader, 100, 8, 0o644);
  writeTarOctal(tarHeader, 108, 8, 0);
  writeTarOctal(tarHeader, 116, 8, 0);
  writeTarOctal(tarHeader, 124, 12, 44);
  writeTarOctal(tarHeader, 136, 12, 0);
  tarHeader.fill(0x20, 148, 156);
  const tarChecksum = tarHeader.reduce((sum, byte) => sum + byte, 0);
  tarHeader.write(tarChecksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  tarHeader[154] = 0;
  tarHeader[155] = 0x20;
  const tarData = Buffer.alloc(512);
  tarData.write("JWT_SECRET=3f9c1e77a4b8d2065e1f4a7c9b3d5e80\n", 0, "ascii");
  writeFileSync(truncatedTarPath, Buffer.concat([tarHeader, tarData]));
  commitFixture(fixtureRoot, "truncated tar carrier", [
    "public/icon-carrier.png",
  ]);
  const truncatedTar = runBuilder(fixtureRoot, outputRoot);
  record(
    "truncated but extractable TAR inside an image extension is refused",
    truncatedTar.status !== 0 &&
      /REFUSED: (?:archive contains nested archive bytes|archive text contains a hardcoded secret assignment): public\/icon-carrier\.png/i.test(
        truncatedTar.stdout,
      ),
    truncatedTar,
  );
  rmSync(truncatedTarPath, { force: true });
  commitFixture(fixtureRoot, "remove truncated tar carrier", [
    "public/icon-carrier.png",
  ]);

  const fakeSignaturePath = join(
    fixtureRoot,
    "public",
    "fake-zip-signature.png",
  );
  writeFileSync(
    fakeSignaturePath,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("benign-prefix"),
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]),
    ]),
  );
  commitFixture(fixtureRoot, "isolated ZIP signature", [
    "public/fake-zip-signature.png",
  ]);
  const fakeSignature = runBuilder(fixtureRoot, outputRoot);
  record(
    "isolated ZIP signature does not create a false positive",
    fakeSignature.status === 0 &&
      /validation only \(not published\)/i.test(fakeSignature.stdout),
    fakeSignature,
  );

  const nestedZipPath = join(temporaryRoot, "nested.zip");
  requireSuccess(
    git(fixtureRoot, [
      "archive",
      "--format=zip",
      `--output=${nestedZipPath}`,
      "HEAD",
      "--",
      "public/index.html",
    ]),
    "create nested ZIP fixture",
  );
  requireSuccess(
    git(fixtureRoot, ["rm", "-q", "--", "public/fake-zip-signature.png"]),
    "git rm fake ZIP signature",
  );
  const polyglotPath = join(fixtureRoot, "public", "polyglot.png");
  writeFileSync(
    polyglotPath,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("benign-prefix"),
      readFileSync(nestedZipPath),
    ]),
  );
  commitFixture(fixtureRoot, "real ZIP polyglot", ["public/polyglot.png"]);
  const polyglot = runBuilder(fixtureRoot, outputRoot);
  record(
    "PNG with an appended coherent ZIP is refused",
    polyglot.status !== 0 &&
      /nested archive bytes: public\/polyglot\.png/i.test(polyglot.stdout),
    polyglot,
  );

  requireSuccess(
    git(fixtureRoot, ["rm", "-q", "--", "public/polyglot.png"]),
    "git rm polyglot",
  );

  const signedZipPath = join(temporaryRoot, "central-signature.zip");
  writeFileSync(
    signedZipPath,
    addZipDigitalSignature(readFileSync(nestedZipPath)),
  );
  const signedZipCompatibility = run(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Add-Type -AssemblyName System.IO.Compression; $stream = [IO.File]::OpenRead($args[0]); try { $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Read, $false); try { if ($archive.Entries.Count -lt 1) { exit 2 } } finally { $archive.Dispose() } } finally { $stream.Dispose() }",
      signedZipPath,
    ],
    { cwd: temporaryRoot, timeout: 30_000 },
  );
  const signedPolyglotPath = join(fixtureRoot, "public", "signed-polyglot.png");
  writeFileSync(
    signedPolyglotPath,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("signed-prefix"),
      readFileSync(signedZipPath),
    ]),
  );
  commitFixture(fixtureRoot, "signed ZIP polyglot", [
    "public/signed-polyglot.png",
  ]);
  const signedPolyglot = runBuilder(fixtureRoot, outputRoot);
  record(
    "standards-valid ZIP digital-signature polyglot is refused",
    signedZipCompatibility.status === 0 &&
      !signedZipCompatibility.error &&
      signedPolyglot.status !== 0 &&
      /nested archive bytes: public\/signed-polyglot\.png/i.test(
        signedPolyglot.stdout,
      ),
    signedPolyglot.status === 0 ? signedPolyglot : signedZipCompatibility,
  );

  requireSuccess(
    git(fixtureRoot, ["rm", "-q", "--", "public/signed-polyglot.png"]),
    "git rm signed polyglot",
  );

  const archiveExtraZipPath = join(temporaryRoot, "archive-extra.zip");
  writeFileSync(
    archiveExtraZipPath,
    addZipArchiveExtraData(readFileSync(nestedZipPath)),
  );
  const archiveExtraPolyglotPath = join(
    fixtureRoot,
    "public",
    "archive-extra-polyglot.png",
  );
  writeFileSync(
    archiveExtraPolyglotPath,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("archive-extra-prefix"),
      readFileSync(archiveExtraZipPath),
    ]),
  );
  commitFixture(fixtureRoot, "archive-extra ZIP polyglot", [
    "public/archive-extra-polyglot.png",
  ]);
  const archiveExtraPolyglot = runBuilder(fixtureRoot, outputRoot);
  record(
    "ZIP archive-extra record polyglot is refused",
    archiveExtraPolyglot.status !== 0 &&
      /nested archive bytes: public\/archive-extra-polyglot\.png/i.test(
        archiveExtraPolyglot.stdout,
      ),
    archiveExtraPolyglot,
  );

  requireSuccess(
    git(fixtureRoot, ["rm", "-q", "--", "public/archive-extra-polyglot.png"]),
    "git rm archive-extra polyglot",
  );

  const signedZip64Path = join(temporaryRoot, "central-signature-zip64.zip");
  writeFileSync(
    signedZip64Path,
    promoteZipToZip64(
      useZip64CentralSentinels(
        addZipDigitalSignature(readFileSync(nestedZipPath)),
      ),
    ),
  );
  const signedZip64Compatibility = run(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Add-Type -AssemblyName System.IO.Compression; $stream = [IO.File]::OpenRead($args[0]); try { $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Read, $false); try { if ($archive.Entries.Count -lt 1) { exit 2 } } finally { $archive.Dispose() } } finally { $stream.Dispose() }",
      signedZip64Path,
    ],
    { cwd: temporaryRoot, timeout: 30_000 },
  );
  const signedZip64PolyglotPath = join(
    fixtureRoot,
    "public",
    "signed-zip64-polyglot.png",
  );
  writeFileSync(
    signedZip64PolyglotPath,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("signed-zip64-prefix"),
      readFileSync(signedZip64Path),
    ]),
  );
  commitFixture(fixtureRoot, "signed ZIP64 polyglot", [
    "public/signed-zip64-polyglot.png",
  ]);
  const signedZip64Polyglot = runBuilder(fixtureRoot, outputRoot);
  record(
    "standards-valid ZIP64 full-sentinel polyglot is refused",
    signedZip64Compatibility.status === 0 &&
      !signedZip64Compatibility.error &&
      signedZip64Polyglot.status !== 0 &&
      /nested archive bytes: public\/signed-zip64-polyglot\.png/i.test(
        signedZip64Polyglot.stdout,
      ),
    signedZip64Polyglot.status === 0
      ? signedZip64Polyglot
      : signedZip64Compatibility,
  );

  requireSuccess(
    git(fixtureRoot, ["rm", "-q", "--", "public/signed-zip64-polyglot.png"]),
    "git rm signed ZIP64 polyglot",
  );

  const archiveProbePath = join(
    fixtureRoot,
    "public",
    "archive-signature-probe.png",
  );
  writeFileSync(
    archiveProbePath,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]),
      Buffer.from("RAR-SEPARATOR"),
      Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]),
      Buffer.from("SEVEN-ZIP-SEPARATOR"),
      Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]),
      Buffer.from("XZ-SEPARATOR"),
      Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]),
    ]),
  );
  commitFixture(fixtureRoot, "isolated non-ZIP archive signatures", [
    "public/archive-signature-probe.png",
  ]);
  const isolatedArchiveSignatures = runBuilder(fixtureRoot, outputRoot);
  record(
    "isolated RAR4, RAR5, 7z, and XZ signatures remain accepted",
    isolatedArchiveSignatures.status === 0 &&
      /validation only \(not published\)/i.test(
        isolatedArchiveSignatures.stdout,
      ),
    isolatedArchiveSignatures,
  );

  const v7TarBytes = createV7TarArchive();
  const v7TarName = "valid-v7.tar";
  const v7TarPath = join(temporaryRoot, v7TarName);
  writeFileSync(v7TarPath, v7TarBytes);
  const v7TarCompatibility = run("tar", ["-tf", v7TarName], {
    cwd: temporaryRoot,
    timeout: 30_000,
  });
  // Each of these numeric-field forms is one Get-TarHeader accepts, so each must
  // be detected. They exist because three successive anchors were derived from
  // beliefs about how tar writers pad rather than from what the reader accepts,
  // and each belief turned out to be false for one of these shapes.
  const readerAcceptedTarVariants = [
    ["NUL-padded", createNulPaddedV7TarArchive()],
    ["unterminated-digit", createUnterminatedV7TarArchive()],
    ["empty-mode", createModeVariantV7TarArchive(writeEmptyTarOctal)],
    [
      "leading-NUL-mode",
      createModeVariantV7TarArchive(writeLeadingNulTarOctal),
    ],
  ].map(([label, bytes], index) => {
    const variantName = `valid-v7-variant-${index}.tar`;
    writeFileSync(join(temporaryRoot, variantName), bytes);
    return {
      bytes,
      compatibility: run("tar", ["-tf", variantName], {
        cwd: temporaryRoot,
        timeout: 30_000,
      }),
      label,
    };
  });
  for (const archiveCase of [
    {
      name: "structurally valid V7 TAR polyglot is refused",
      message: "V7 TAR polyglot",
      bytes: v7TarBytes,
      compatibility: v7TarCompatibility,
    },
    ...readerAcceptedTarVariants.map((variant) => ({
      name: `${variant.label} V7 TAR polyglot is refused`,
      message: `${variant.label} V7 TAR polyglot`,
      bytes: variant.bytes,
      compatibility: variant.compatibility,
    })),
    {
      name: "structurally coherent RAR4 polyglot is refused",
      message: "RAR4 polyglot",
      bytes: createRar4Archive(),
    },
    {
      name: "structurally coherent RAR5 polyglot is refused",
      message: "RAR5 polyglot",
      bytes: createRar5Archive(),
    },
    {
      name: "structurally coherent 7z polyglot is refused",
      message: "7z polyglot",
      bytes: createSevenZipArchive(),
    },
    {
      name: "structurally valid XZ polyglot is refused",
      message: "XZ polyglot",
      bytes: createXzArchive(),
    },
  ]) {
    writeFileSync(archiveProbePath, withPngPrefix(archiveCase.bytes));
    commitFixture(fixtureRoot, archiveCase.message, [
      "public/archive-signature-probe.png",
    ]);
    const archiveResult = runBuilder(fixtureRoot, outputRoot);
    record(
      archiveCase.name,
      (!archiveCase.compatibility ||
        (archiveCase.compatibility.status === 0 &&
          !archiveCase.compatibility.error)) &&
        archiveResult.status !== 0 &&
        /REFUSED: archive contains nested archive bytes: public\/archive-signature-probe\.png/i.test(
          archiveResult.stdout,
        ),
      archiveResult.status === 0 ? archiveResult : archiveCase.compatibility,
    );
  }

  requireSuccess(
    git(fixtureRoot, ["rm", "-q", "--", "public/archive-signature-probe.png"]),
    "git rm archive signature probe",
  );
  requireSuccess(
    git(fixtureRoot, [
      "-c",
      "user.name=CA PRO Security Test",
      "-c",
      "user.email=security-test@example.invalid",
      "commit",
      "-q",
      "-m",
      "remove archive signature probe",
    ]),
    "commit archive signature probe removal",
  );

  const executablePath = join(fixtureRoot, "src", "executable.js");
  writeFileSync(executablePath, 'console.log("executable mode fixture");\n');
  commitFixture(fixtureRoot, "add executable mode fixture", [
    "src/executable.js",
  ]);
  requireSuccess(
    git(fixtureRoot, ["update-index", "--chmod=+x", "--", "src/executable.js"]),
    "mark mode fixture executable",
  );
  requireSuccess(
    git(fixtureRoot, [
      "-c",
      "user.name=CA PRO Security Test",
      "-c",
      "user.email=security-test@example.invalid",
      "commit",
      "-q",
      "-m",
      "preserve executable mode",
    ]),
    "commit executable mode",
  );
  const fixtureCommitResult = git(fixtureRoot, ["rev-parse", "HEAD"]);
  requireSuccess(fixtureCommitResult, "resolve fixture commit");
  const fixtureCommit = fixtureCommitResult.stdout.trim();
  const published = runBuilder(fixtureRoot, outputRoot, {
    validateOnly: false,
  });
  const artifactRecord = parseArtifactRecord(published);
  const artifactExists =
    artifactRecord &&
    typeof artifactRecord.path === "string" &&
    existsSync(artifactRecord.path);
  const artifactBytes = artifactExists
    ? readFileSync(artifactRecord.path)
    : Buffer.alloc(0);
  const artifactModes = artifactExists
    ? readClassicZipUnixModes(artifactBytes)
    : new Map();
  record(
    "published ZIP modes exactly preserve committed regular-file modes",
    published.status === 0 &&
      artifactModes.get("src/executable.js") === 0o100755 &&
      artifactModes.get("src/server.js") === 0o100644 &&
      artifactModes.get("public/index.html") === 0o100644,
    published,
  );
  record(
    "published artifact handoff binds exact path, commit, hash, and byte length",
    published.status === 0 &&
      artifactExists &&
      artifactRecord.format === "ca-pro-deploy-artifact/v1" &&
      artifactRecord.commit === fixtureCommit &&
      basename(artifactRecord.path).includes(fixtureCommit) &&
      artifactRecord.byteLength === statSync(artifactRecord.path).size &&
      artifactRecord.sha256.toLowerCase() ===
        createHash("sha256").update(artifactBytes).digest("hex"),
    published,
  );

  const oversizedPath = join(fixtureRoot, "public", "oversized.png");
  writeFileSync(oversizedPath, Buffer.alloc(32 * 1024 * 1024 + 1));
  commitFixture(fixtureRoot, "oversized blob", ["public/oversized.png"]);
  const oversized = runBuilder(fixtureRoot, outputRoot);
  record(
    "oversized committed blob is refused before archive creation",
    oversized.status !== 0 &&
      /before archive creation: public\/oversized\.png/i.test(oversized.stdout),
    oversized,
  );
} catch (error) {
  record("boundary test setup completes", false, { error });
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log(`Result: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
