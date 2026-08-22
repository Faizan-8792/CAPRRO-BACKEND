import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  parse,
  version as acornVersion,
} from "../node_modules/acorn/dist/acorn.mjs";

const EXPECTED_ACORN_VERSION = "8.18.0";
const EXPECTED_PACKAGE_LOCK_SHA256 =
  "d085edd7aa9d6080bc80cbb2453d92d9d781b8e1e2e1e72a699845675f5ee4dc";
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_STATIC_DECODE_BYTES = 1024 * 1024;
const UNKNOWN = Symbol("unknown static value");
const UNKNOWN_ENVIRONMENT_SECRET = "process.env[computed]";
const PLACEHOLDER = /^(?:REPLACE_ME|YOUR_[A-Z0-9_]*|CHANGEME)$/i;
const ENV_PLACEHOLDER = /^\$\{[A-Z][A-Z0-9_]*\}$/;
const SEMVER_SPEC = /^[~^]?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const CONCRETE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
const FORBIDDEN_LIFECYCLE_SCRIPTS = new Set([
  "preinstall",
  "install",
  "postinstall",
  "prepublish",
  "preprepare",
  "prepare",
  "postprepare",
  "prestart",
  "poststart",
]);
const UNSUPPORTED_INSTALL_MANIFEST_FIELDS = new Set([
  "bundleDependencies",
  "bundledDependencies",
  "config",
  "dependenciesMeta",
  "devEngines",
  "onlyBuiltDependencies",
  "os",
  "cpu",
  "libc",
  "overrides",
  "packageManager",
  "pnpm",
  "resolutions",
  "trustedDependencies",
  "workspaces",
]);
const ALLOWED_PACKAGE_MANIFEST_FIELDS = new Set([
  "name",
  "version",
  "description",
  "main",
  "type",
  "engines",
  "scripts",
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
]);
export const PROVIDER_SECRET_PATTERNS = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i],
  ["credentialed MongoDB URI", /mongodb(?:\+srv)?:\/\/[^/\s:]+:[^@\s]+@/i],
  ["Google OAuth client secret", /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/i],
  ["Resend API key", /\bre_[A-Za-z0-9_-]{20,}\b/i],
  ["provider API key", /\bsk-[A-Za-z0-9_-]{20,}\b/i],
  ["npm access token", /\bnpm_[A-Za-z0-9]{20,}\b/i],
  ["GitHub access token", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/i],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Stripe live key", /\b[rs]k_live_[A-Za-z0-9]{16,}\b/i],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/i],
];

function fail(message) {
  console.error(`REFUSED: ${message}`);
  process.exit(1);
}

async function readPayload() {
  const chunks = [];
  let size = 0;

  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) {
      fail("JavaScript secret-scan payload exceeds 32 MB");
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    fail("JavaScript secret-scan payload is not valid JSON");
  }
}

function isPlainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validatePayload(payload) {
  if (
    !isPlainRecord(payload) ||
    !["archive", "javascript-fixtures"].includes(payload.mode) ||
    !Array.isArray(payload.files) ||
    !Array.isArray(payload.secretNames)
  ) {
    fail("JavaScript secret-scan payload has an invalid shape");
  }

  const secretNames = new Set();
  for (const name of payload.secretNames) {
    if (typeof name !== "string" || !/^[A-Z][A-Z0-9_]+$/.test(name)) {
      fail("JavaScript secret-scan payload contains an invalid secret name");
    }
    secretNames.add(name);
  }
  if (secretNames.size === 0) {
    fail("JavaScript secret-scan payload contains no secret names");
  }

  const paths = new Set();
  for (const file of payload.files) {
    if (
      !isPlainRecord(file) ||
      typeof file.path !== "string" ||
      !/\.(?:cjs|js|mjs)$/i.test(file.path) ||
      typeof file.source !== "string" ||
      paths.has(file.path) ||
      // parseOptional downgrades a parse failure from a refusal to a skip, so it
      // has to be a real boolean. Accepting any truthy value would let a
      // malformed payload turn off the refusal with a non-empty string.
      (file.parseOptional !== undefined &&
        typeof file.parseOptional !== "boolean")
    ) {
      fail("JavaScript secret-scan payload contains an invalid file");
    }
    paths.add(file.path);
  }

  if (payload.mode === "archive") {
    if (
      !isPlainRecord(payload.manifests) ||
      typeof payload.manifests.packageJson !== "string" ||
      typeof payload.manifests.packageLock !== "string"
    ) {
      fail("archive scan requires package manifest sources");
    }
  } else if (payload.manifests !== undefined) {
    fail("fixture scans must not supply package manifests");
  }

  return secretNames;
}

function parseJsonManifest(source, path) {
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    fail(`${path} is not strict JSON: ${error.message}`);
  }
  if (!isPlainRecord(value)) fail(`${path} must contain a JSON object`);
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (isPlainRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalSha256(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function stringMap(value, path) {
  if (!isPlainRecord(value)) fail(`${path} must be an object`);
  const result = new Map();
  for (const [name, spec] of Object.entries(value)) {
    if (!name || typeof spec !== "string" || !spec) {
      fail(`${path} contains an invalid entry`);
    }
    result.set(name, spec);
  }
  return result;
}

function optionalStringMap(value, path) {
  return value === undefined ? new Map() : stringMap(value, path);
}

function validatePeerDependencyMetadata(value, peerDependencies, path) {
  if (value === undefined) return {};
  if (!isPlainRecord(value)) fail(`${path} must be an object`);
  for (const [name, metadata] of Object.entries(value)) {
    if (!peerDependencies.has(name)) {
      fail(`${path}.${name} does not identify a peer dependency`);
    }
    if (
      !isPlainRecord(metadata) ||
      Object.keys(metadata).some((key) => key !== "optional") ||
      metadata.optional !== true
    ) {
      fail(`${path}.${name} must contain only optional: true`);
    }
  }
  return value;
}

function assertDisjointDependencyGroups(groups) {
  const owners = new Map();
  for (const [groupName, dependencies] of groups) {
    for (const name of dependencies.keys()) {
      const existing = owners.get(name);
      if (existing) {
        fail(
          `package.json declares ${name} in both ${existing} and ${groupName}`,
        );
      }
      owners.set(name, groupName);
    }
  }
}

function assertSameStringMap(actual, expected, path) {
  if (actual.size !== expected.size) fail(`${path} differs from package.json`);
  for (const [name, spec] of expected) {
    if (actual.get(name) !== spec)
      fail(`${path}.${name} differs from package.json`);
  }
}

function parseVersion(value, path) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) fail(`${path} is not a stable canonical semantic version`);
  const parts = match.slice(1).map(Number);
  if (!parts.every(Number.isSafeInteger)) {
    fail(`${path} contains an unsafe semantic version component`);
  }
  return { major: parts[0], minor: parts[1], patch: parts[2] };
}

function parsePartialVersion(value, path) {
  const match =
    /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:\.(0|[1-9]\d*))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      value,
    );
  if (!match) fail(`${path} contains an unsupported semantic version`);
  const precision =
    match[3] === undefined ? (match[2] === undefined ? 1 : 2) : 3;
  if (match[4] !== undefined && precision !== 3) {
    fail(`${path} contains an unsupported semantic version`);
  }
  const parts = [match[1], match[2] ?? "0", match[3] ?? "0"].map(Number);
  if (!parts.every(Number.isSafeInteger)) {
    fail(`${path} contains an unsafe semantic version component`);
  }
  const prerelease = match[4]?.split(".") ?? null;
  if (
    prerelease?.some(
      (identifier) =>
        /^\d+$/.test(identifier) && !/^(?:0|[1-9]\d*)$/.test(identifier),
    )
  ) {
    fail(`${path} contains a non-canonical semantic prerelease`);
  }
  return {
    major: parts[0],
    minor: parts[1],
    patch: parts[2],
    precision,
    prerelease,
  };
}

function compareVersions(left, right) {
  for (const field of ["major", "minor", "patch"]) {
    if (left[field] !== right[field])
      return left[field] < right[field] ? -1 : 1;
  }
  const leftPrerelease = left.prerelease ?? null;
  const rightPrerelease = right.prerelease ?? null;
  if (leftPrerelease === null && rightPrerelease === null) return 0;
  if (leftPrerelease === null) return 1;
  if (rightPrerelease === null) return -1;
  const length = Math.max(leftPrerelease.length, rightPrerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = leftPrerelease[index];
    const rightIdentifier = rightPrerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      return Number(leftIdentifier) < Number(rightIdentifier) ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

function upperPrefixBound(base) {
  if (base.precision === 1) {
    return { major: base.major + 1, minor: 0, patch: 0 };
  }
  return { major: base.major, minor: base.minor + 1, patch: 0 };
}

function upperCaretBound(base) {
  if (base.precision === 1 || base.major > 0) {
    return { major: base.major + 1, minor: 0, patch: 0 };
  }
  if (base.precision === 2 || base.minor > 0) {
    return { major: 0, minor: base.minor + 1, patch: 0 };
  }
  return { major: 0, minor: 0, patch: base.patch + 1 };
}

function satisfiesComparator(version, operator, boundary) {
  const comparison = compareVersions(version, boundary);
  if (operator === ">=") return comparison >= 0;
  if (operator === ">") return comparison > 0;
  if (operator === "<=") return comparison <= 0;
  return comparison < 0;
}

function satisfiesRangeAlternative(version, range, path) {
  if (range === "*") return true;

  if (range.startsWith("^") || range.startsWith("~")) {
    const operator = range[0];
    const base = parsePartialVersion(range.slice(1), `${path} range`);
    if (compareVersions(version, base) < 0) return false;
    const upper =
      operator === "^" ? upperCaretBound(base) : upperPrefixBound(base);
    return compareVersions(version, upper) < 0;
  }

  const wildcard = /^(0|[1-9]\d*)\.(?:x|\*)$/.exec(range);
  if (wildcard) {
    const base = parsePartialVersion(wildcard[1], `${path} range`);
    return (
      compareVersions(version, base) >= 0 &&
      compareVersions(version, upperPrefixBound(base)) < 0
    );
  }

  if (/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,2}$/.test(range)) {
    const base = parsePartialVersion(range, `${path} range`);
    if (base.precision === 3) return compareVersions(version, base) === 0;
    return (
      compareVersions(version, base) >= 0 &&
      compareVersions(version, upperPrefixBound(base)) < 0
    );
  }

  const normalized = range.replace(/(>=|<=|>|<)\s+/g, "$1").trim();
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length > 0) {
    const comparisons = tokens.map((token) =>
      /^(>=|<=|>|<)((?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,2})$/.exec(token),
    );
    if (comparisons.every(Boolean)) {
      return comparisons.every((match) =>
        satisfiesComparator(
          version,
          match[1],
          parsePartialVersion(match[2], `${path} comparator`),
        ),
      );
    }
  }

  fail(`${path} contains an unsupported dependency range: ${range}`);
}

function versionSatisfiesRange(versionText, rangeText, path) {
  const version = parseVersion(versionText, `${path} lock entry`);
  const alternatives = rangeText.split("||").map((range) => range.trim());
  if (alternatives.length === 0 || alternatives.some((range) => !range)) {
    fail(`${path} contains an empty dependency range alternative`);
  }
  const matches = alternatives.map((range) =>
    satisfiesRangeAlternative(version, range, path),
  );
  return matches.some(Boolean);
}

function versionSatisfiesSpec(versionText, spec, path) {
  return versionSatisfiesRange(versionText, spec, path);
}

function packageNameFromLockPath(path) {
  const marker = path.lastIndexOf("node_modules/");
  if (marker < 0)
    fail(`package-lock.json contains an unsupported package path: ${path}`);
  const remainder = path.slice(marker + "node_modules/".length);
  const parts = remainder.split("/");
  if (parts[0]?.startsWith("@")) {
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      fail(
        `package-lock.json contains an invalid scoped package path: ${path}`,
      );
    }
    return `${parts[0]}/${parts[1]}`;
  }
  if (parts.length !== 1 || !parts[0]) {
    fail(`package-lock.json contains an invalid package path: ${path}`);
  }
  return parts[0];
}

function expectedRegistryTarballUrl(name, version) {
  const archiveName = name.slice(name.lastIndexOf("/") + 1);
  return `https://registry.npmjs.org/${name}/-/${archiveName}-${version}.tgz`;
}

function isValidSha512Integrity(value) {
  if (typeof value !== "string" || !INTEGRITY.test(value)) return false;
  const encoded = value.slice("sha512-".length);
  try {
    const digest = Buffer.from(encoded, "base64");
    return digest.length === 64 && digest.toString("base64") === encoded;
  } catch {
    return false;
  }
}

function resolveLockedDependencyPath(packages, packagePath, dependencyName) {
  let ancestor = packagePath;
  while (true) {
    const candidate = ancestor
      ? `${ancestor}/node_modules/${dependencyName}`
      : `node_modules/${dependencyName}`;
    if (isPlainRecord(packages[candidate])) return candidate;
    if (!ancestor) return null;
    const marker = ancestor.lastIndexOf("/node_modules/");
    ancestor = marker >= 0 ? ancestor.slice(0, marker) : "";
  }
}

function packageDependencyEdges(entry, packagePath) {
  const edges = [];
  for (const group of ["dependencies", "optionalDependencies"]) {
    if (entry[group] === undefined) continue;
    for (const [name, spec] of stringMap(
      entry[group],
      `package-lock.json ${packagePath} ${group}`,
    )) {
      edges.push({
        name,
        spec,
        kind: group,
        optional: group === "optionalDependencies",
      });
    }
  }

  const peerDependencies =
    entry.peerDependencies === undefined
      ? new Map()
      : stringMap(
          entry.peerDependencies,
          `package-lock.json ${packagePath} peerDependencies`,
        );
  if (
    entry.peerDependenciesMeta !== undefined &&
    !isPlainRecord(entry.peerDependenciesMeta)
  ) {
    fail(
      `package-lock.json ${packagePath} has invalid peer dependency metadata`,
    );
  }
  for (const [name, meta] of Object.entries(entry.peerDependenciesMeta ?? {})) {
    if (
      !isPlainRecord(meta) ||
      Object.keys(meta).some((key) => key !== "optional") ||
      (meta.optional !== undefined && typeof meta.optional !== "boolean")
    ) {
      fail(
        `package-lock.json ${packagePath} has invalid peer metadata for ${name}`,
      );
    }
    if (!peerDependencies.has(name) && meta.optional !== true) {
      fail(
        `package-lock.json ${packagePath} has non-optional peer metadata without a peer dependency: ${name}`,
      );
    }
  }
  for (const [name, spec] of peerDependencies) {
    edges.push({
      name,
      spec,
      kind: "peerDependencies",
      optional: entry.peerDependenciesMeta?.[name]?.optional === true,
    });
  }
  return edges;
}

function validatePackageClassification(entry, packagePath) {
  const classificationFlags = ["dev", "devOptional", "optional", "peer"];
  for (const flag of classificationFlags) {
    if (entry[flag] !== undefined && typeof entry[flag] !== "boolean") {
      fail(
        `package-lock.json ${packagePath} has a non-boolean ${flag} classification`,
      );
    }
  }

  const exclusiveFlags = ["dev", "devOptional", "optional"].filter(
    (flag) => entry[flag] === true,
  );
  if (exclusiveFlags.length > 1) {
    fail(
      `package-lock.json ${packagePath} has incompatible classifications: ${exclusiveFlags.join(", ")}`,
    );
  }
}

function validateLockDependencyGraph(
  packages,
  rootDependencies,
  graphName,
  optionalRootNames = new Set(),
) {
  const reachable = new Set();
  const queue = [];
  for (const [name, spec] of rootDependencies) {
    const path = `node_modules/${name}`;
    const entry = packages[path];
    if (!isPlainRecord(entry)) {
      if (optionalRootNames.has(name)) continue;
      fail(`package-lock.json is missing ${graphName} dependency: ${name}`);
    }
    if (!versionSatisfiesRange(entry.version, spec, path)) {
      fail(
        `package-lock.json ${graphName} dependency does not satisfy package.json: ${name}`,
      );
    }
    reachable.add(path);
    queue.push(path);
  }

  for (let index = 0; index < queue.length; index += 1) {
    const packagePath = queue[index];
    const entry = packages[packagePath];
    for (const edge of packageDependencyEdges(entry, packagePath)) {
      const resolvedPath = resolveLockedDependencyPath(
        packages,
        packagePath,
        edge.name,
      );
      if (!resolvedPath) {
        if (edge.kind === "peerDependencies" && edge.optional) continue;
        fail(
          `package-lock.json is missing ${edge.kind} dependency ${edge.name} required by ${packagePath}`,
        );
      }
      const resolvedEntry = packages[resolvedPath];
      if (
        !versionSatisfiesRange(
          resolvedEntry.version,
          edge.spec,
          `${packagePath} -> ${edge.name}`,
        )
      ) {
        fail(
          `package-lock.json ${edge.kind} dependency ${edge.name} does not satisfy ${packagePath}`,
        );
      }
      if (!reachable.has(resolvedPath)) {
        reachable.add(resolvedPath);
        queue.push(resolvedPath);
      }
    }
  }

  return reachable;
}

function validateManifests(manifests) {
  const packageJson = parseJsonManifest(manifests.packageJson, "package.json");
  const packageLock = parseJsonManifest(
    manifests.packageLock,
    "package-lock.json",
  );

  if (
    packageJson.name !== "capro-backend" ||
    typeof packageJson.version !== "string" ||
    packageJson.main !== "src/server.js" ||
    packageJson.type !== "module" ||
    packageJson.scripts?.start !== "node src/server.js"
  ) {
    fail("package.json does not describe the expected backend entry point");
  }
  if (
    !isPlainRecord(packageJson.engines) ||
    packageJson.engines.node !== ">=20.0.0" ||
    Object.keys(packageJson.engines).some((name) => name !== "node")
  ) {
    fail("package.json must declare only the supported Node.js floor");
  }
  if (!isPlainRecord(packageJson.scripts)) {
    fail("package.json scripts must be an object");
  }
  for (const scriptName of Object.keys(packageJson.scripts)) {
    if (FORBIDDEN_LIFECYCLE_SCRIPTS.has(scriptName)) {
      fail(`package.json contains forbidden lifecycle script: ${scriptName}`);
    }
  }
  for (const field of UNSUPPORTED_INSTALL_MANIFEST_FIELDS) {
    if (Object.hasOwn(packageJson, field)) {
      fail(`package.json contains unsupported install field: ${field}`);
    }
  }
  for (const field of Object.keys(packageJson)) {
    if (!ALLOWED_PACKAGE_MANIFEST_FIELDS.has(field)) {
      fail(`package.json contains unsupported manifest field: ${field}`);
    }
  }

  const dependencies = stringMap(
    packageJson.dependencies,
    "package.json.dependencies",
  );
  const devDependencies = stringMap(
    packageJson.devDependencies,
    "package.json.devDependencies",
  );
  const optionalDependencies = optionalStringMap(
    packageJson.optionalDependencies,
    "package.json.optionalDependencies",
  );
  const peerDependencies = optionalStringMap(
    packageJson.peerDependencies,
    "package.json.peerDependencies",
  );
  const peerDependenciesMeta = validatePeerDependencyMetadata(
    packageJson.peerDependenciesMeta,
    peerDependencies,
    "package.json.peerDependenciesMeta",
  );
  const dependencyGroups = [
    ["dependencies", dependencies],
    ["devDependencies", devDependencies],
    ["optionalDependencies", optionalDependencies],
    ["peerDependencies", peerDependencies],
  ];
  assertDisjointDependencyGroups(dependencyGroups);
  if (devDependencies.get("acorn") !== EXPECTED_ACORN_VERSION) {
    fail(`package.json must pin Acorn ${EXPECTED_ACORN_VERSION}`);
  }
  for (const [, group] of dependencyGroups) {
    for (const [name, spec] of group) {
      if (!SEMVER_SPEC.test(spec)) {
        fail(`package.json contains a mutable dependency source: ${name}`);
      }
    }
  }

  if (
    packageLock.lockfileVersion !== 3 ||
    packageLock.requires !== true ||
    !isPlainRecord(packageLock.packages) ||
    !isPlainRecord(packageLock.packages[""])
  ) {
    fail("package-lock.json is not a complete lockfileVersion 3 manifest");
  }
  const lockRoot = packageLock.packages[""];
  if (
    lockRoot.name !== packageJson.name ||
    lockRoot.version !== packageJson.version ||
    lockRoot.engines?.node !== packageJson.engines.node
  ) {
    fail("package-lock.json root metadata differs from package.json");
  }
  assertSameStringMap(
    stringMap(lockRoot.dependencies, "package-lock.json root dependencies"),
    dependencies,
    "package-lock.json root dependencies",
  );
  assertSameStringMap(
    stringMap(
      lockRoot.devDependencies,
      "package-lock.json root devDependencies",
    ),
    devDependencies,
    "package-lock.json root devDependencies",
  );
  const lockOptionalDependencies = optionalStringMap(
    lockRoot.optionalDependencies,
    "package-lock.json root optionalDependencies",
  );
  assertSameStringMap(
    lockOptionalDependencies,
    optionalDependencies,
    "package-lock.json root optionalDependencies",
  );
  const lockPeerDependencies = optionalStringMap(
    lockRoot.peerDependencies,
    "package-lock.json root peerDependencies",
  );
  assertSameStringMap(
    lockPeerDependencies,
    peerDependencies,
    "package-lock.json root peerDependencies",
  );
  const lockPeerDependenciesMeta = validatePeerDependencyMetadata(
    lockRoot.peerDependenciesMeta,
    lockPeerDependencies,
    "package-lock.json root peerDependenciesMeta",
  );
  if (
    canonicalJson(lockPeerDependenciesMeta) !==
    canonicalJson(peerDependenciesMeta)
  ) {
    fail(
      "package-lock.json root peerDependenciesMeta differs from package.json",
    );
  }

  for (const [, group] of dependencyGroups) {
    for (const name of group.keys()) {
      const optionalPeer =
        peerDependencies.has(name) &&
        peerDependenciesMeta[name]?.optional === true;
      if (
        !optionalPeer &&
        !isPlainRecord(packageLock.packages[`node_modules/${name}`])
      ) {
        fail(`package-lock.json is missing direct dependency: ${name}`);
      }
    }
  }
  for (const [path, entry] of Object.entries(packageLock.packages)) {
    if (path === "") continue;
    if (!path.startsWith("node_modules/") || !isPlainRecord(entry)) {
      fail(`package-lock.json contains an unsupported package path: ${path}`);
    }
    if (
      entry.link === true ||
      entry.hasInstallScript === true ||
      typeof entry.version !== "string" ||
      !CONCRETE_VERSION.test(entry.version) ||
      typeof entry.resolved !== "string" ||
      !isValidSha512Integrity(entry.integrity)
    ) {
      fail(`package-lock.json contains an untrusted package entry: ${path}`);
    }
    validatePackageClassification(entry, path);
    const packageName = packageNameFromLockPath(path);
    if (
      entry.resolved !== expectedRegistryTarballUrl(packageName, entry.version)
    ) {
      fail(
        `package-lock.json package tarball does not match its path: ${path}`,
      );
    }
  }

  const runtimeDependencies = new Map([
    ...dependencies,
    ...optionalDependencies,
    ...peerDependencies,
  ]);
  const optionalRuntimeDependencies = new Set([
    ...optionalDependencies.keys(),
    ...Object.entries(peerDependenciesMeta)
      .filter(([, metadata]) => metadata.optional === true)
      .map(([name]) => name),
  ]);
  const runtimeReachable = validateLockDependencyGraph(
    packageLock.packages,
    runtimeDependencies,
    "runtime",
    optionalRuntimeDependencies,
  );
  const developmentReachable = validateLockDependencyGraph(
    packageLock.packages,
    devDependencies,
    "development",
  );
  for (const path of runtimeReachable) {
    const entry = packageLock.packages[path];
    if (entry.dev === true || entry.devOptional === true) {
      fail(
        `package-lock.json runtime-reachable package is classified as development-only: ${path}`,
      );
    }
  }
  for (const path of developmentReachable) {
    if (runtimeReachable.has(path)) continue;
    const entry = packageLock.packages[path];
    if (entry.dev !== true && entry.devOptional !== true) {
      fail(
        `package-lock.json development-only package lacks a development classification: ${path}`,
      );
    }
  }
  const reachable = new Set([...runtimeReachable, ...developmentReachable]);
  for (const path of Object.keys(packageLock.packages)) {
    if (path && !reachable.has(path)) {
      fail(`package-lock.json contains an unreachable package entry: ${path}`);
    }
  }

  for (const [, group] of dependencyGroups) {
    for (const [name, spec] of group) {
      const path = `node_modules/${name}`;
      const entry = packageLock.packages[path];
      if (!isPlainRecord(entry) && optionalRuntimeDependencies.has(name)) {
        continue;
      }
      if (!versionSatisfiesSpec(entry.version, spec, path)) {
        fail(
          `package-lock.json direct dependency does not satisfy package.json: ${name}`,
        );
      }
      const expectedResolved = expectedRegistryTarballUrl(name, entry.version);
      if (entry.resolved !== expectedResolved) {
        fail(
          `package-lock.json direct dependency has an unexpected tarball URL: ${name}`,
        );
      }
    }
  }

  const packageLockDigest = canonicalSha256(packageLock);
  if (packageLockDigest !== EXPECTED_PACKAGE_LOCK_SHA256) {
    fail(
      `package-lock.json canonical SHA-256 does not match the trusted lock (${packageLockDigest})`,
    );
  }
}

function childNodes(node) {
  const children = [];
  for (const [key, value] of Object.entries(node ?? {})) {
    if (key === "loc" || key === "start" || key === "end") continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item.type === "string") children.push(item);
      }
    } else if (value && typeof value.type === "string") {
      children.push(value);
    }
  }
  return children;
}

function allNodes(root) {
  const nodes = [];
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    nodes.push(node);
    stack.push(...childNodes(node));
  }
  return nodes;
}

function returnedExpressions(functionNode) {
  if (functionNode.body.type !== "BlockStatement") {
    return [functionNode.body];
  }

  const returned = [];
  const stack = [...functionNode.body.body];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node.type === "ReturnStatement") {
      if (node.argument) returned.push(node.argument);
      continue;
    }
    if (
      [
        "ArrowFunctionExpression",
        "FunctionExpression",
        "FunctionDeclaration",
        "ClassExpression",
        "ClassDeclaration",
      ].includes(node.type)
    ) {
      continue;
    }
    stack.push(...childNodes(node));
  }
  return returned;
}

function collectConstantBindings(nodes) {
  const candidates = new Map();
  const unusable = new Set();

  for (const node of nodes) {
    if (node.type === "VariableDeclaration" && node.kind === "const") {
      for (const declaration of node.declarations) {
        if (declaration.id.type !== "Identifier" || !declaration.init) continue;
        const name = declaration.id.name;
        if (candidates.has(name)) unusable.add(name);
        else candidates.set(name, declaration.init);
      }
    }
    if (
      node.type === "AssignmentExpression" &&
      node.left.type === "Identifier"
    ) {
      unusable.add(node.left.name);
    }
    if (
      node.type === "UpdateExpression" &&
      node.argument.type === "Identifier"
    ) {
      unusable.add(node.argument.name);
    }
  }
  for (const name of unusable) candidates.delete(name);
  return candidates;
}

function createStaticEvaluator(nodes) {
  const bindings = collectConstantBindings(nodes);
  const memo = new WeakMap();
  const resolving = new Set();

  function evaluate(node) {
    if (!node) return UNKNOWN;
    if (memo.has(node)) return memo.get(node);
    let result = UNKNOWN;

    if (node.type === "Literal") {
      if (
        typeof node.value === "string" ||
        typeof node.value === "number" ||
        typeof node.value === "bigint" ||
        typeof node.value === "boolean" ||
        node.value === null
      ) {
        result = node.value;
      }
    } else if (node.type === "Identifier") {
      if (
        bindings.has(node.name) &&
        !resolving.has(node.name) &&
        resolving.size < 128
      ) {
        resolving.add(node.name);
        result = evaluate(bindings.get(node.name));
        resolving.delete(node.name);
      }
    } else if (
      node.type === "ChainExpression" ||
      node.type === "AwaitExpression"
    ) {
      result = evaluate(node.expression ?? node.argument);
    } else if (node.type === "TemplateLiteral") {
      const parts = [];
      let complete = true;
      for (let index = 0; index < node.quasis.length; index += 1) {
        parts.push(
          node.quasis[index].value.cooked ?? node.quasis[index].value.raw,
        );
        if (index < node.expressions.length) {
          const expressionValue = evaluate(node.expressions[index]);
          if (expressionValue === UNKNOWN || Buffer.isBuffer(expressionValue)) {
            complete = false;
            break;
          }
          parts.push(String(expressionValue));
        }
      }
      if (complete) result = parts.join("");
    } else if (node.type === "BinaryExpression" && node.operator === "+") {
      const left = evaluate(node.left);
      const right = evaluate(node.right);
      if (
        left !== UNKNOWN &&
        right !== UNKNOWN &&
        !Buffer.isBuffer(left) &&
        !Buffer.isBuffer(right)
      ) {
        result = left + right;
      }
    } else if (node.type === "LogicalExpression") {
      const left = evaluate(node.left);
      if (left !== UNKNOWN) {
        if (node.operator === "??") result = left ?? evaluate(node.right);
        if (node.operator === "||") result = left || evaluate(node.right);
        if (node.operator === "&&") result = left && evaluate(node.right);
      }
    } else if (node.type === "ConditionalExpression") {
      const test = evaluate(node.test);
      if (test !== UNKNOWN) {
        result = evaluate(test ? node.consequent : node.alternate);
      } else {
        const consequent = evaluate(node.consequent);
        const alternate = evaluate(node.alternate);
        if (
          consequent !== UNKNOWN &&
          alternate !== UNKNOWN &&
          !Buffer.isBuffer(consequent) &&
          !Buffer.isBuffer(alternate) &&
          Object.is(consequent, alternate)
        ) {
          result = consequent;
        }
      }
    } else if (node.type === "SequenceExpression") {
      result = evaluate(node.expressions.at(-1));
    } else if (node.type === "UnaryExpression") {
      const argument = evaluate(node.argument);
      if (argument !== UNKNOWN && !Buffer.isBuffer(argument)) {
        if (node.operator === "!") result = !argument;
        if (node.operator === "+") result = +argument;
        if (node.operator === "-") result = -argument;
        if (node.operator === "~") result = ~argument;
      }
    } else if (node.type === "ArrayExpression") {
      const values = [];
      let complete = true;
      for (const element of node.elements) {
        const value = evaluate(element);
        if (value === UNKNOWN) {
          complete = false;
          break;
        }
        values.push(value);
      }
      if (complete) result = { kind: "array", values };
    } else if (node.type === "ObjectExpression") {
      const values = new Map();
      let complete = true;
      for (const property of node.properties) {
        if (property.type !== "Property" || property.kind !== "init") {
          complete = false;
          break;
        }
        const key = propertyName(property.key, property.computed, evaluate);
        const value = evaluate(property.value);
        if (key === null || value === UNKNOWN) {
          complete = false;
          break;
        }
        values.set(key, value);
      }
      if (complete) result = { kind: "object", values };
    } else if (node.type === "MemberExpression") {
      const object = evaluate(node.object);
      const key = propertyName(node.property, node.computed, evaluate);
      if (key !== null && object !== UNKNOWN) {
        if (object?.kind === "object" && object.values.has(key)) {
          result = object.values.get(key);
        } else if (object?.kind === "array" && /^\d+$/.test(key)) {
          result = object.values[Number(key)] ?? UNKNOWN;
        }
      }
    } else if (node.type === "CallExpression") {
      result = evaluateStaticCall(node, evaluate);
    } else if (node.type === "TaggedTemplateExpression") {
      result = evaluate(node.quasi);
    }

    memo.set(node, result);
    return result;
  }

  return evaluate;
}

function staticArrayValues(value) {
  return value !== UNKNOWN &&
    value !== null &&
    typeof value === "object" &&
    value.kind === "array" &&
    Array.isArray(value.values)
    ? value.values
    : null;
}

function codePointsToText(codes, method) {
  if (codes.length === 0 || codes.length > MAX_STATIC_DECODE_BYTES) {
    return UNKNOWN;
  }
  const limit = method === "fromCodePoint" ? 0x10ffff : 0xffff;
  const points = [];
  for (const code of codes) {
    if (
      typeof code !== "number" ||
      !Number.isInteger(code) ||
      code < 0 ||
      code > limit
    ) {
      return UNKNOWN;
    }
    points.push(code);
  }
  try {
    return method === "fromCodePoint"
      ? String.fromCodePoint(...points)
      : String.fromCharCode(...points);
  } catch {
    return UNKNOWN;
  }
}

function mapThroughStaticStringCall(body, parameterName, elements) {
  if (
    body?.type !== "CallExpression" ||
    body.arguments.length !== 1 ||
    body.arguments[0].type !== "Identifier" ||
    body.arguments[0].name !== parameterName ||
    elements.length > MAX_STATIC_DECODE_BYTES
  ) {
    return null;
  }
  let method = null;
  if (body.callee.type === "Identifier" && body.callee.name === "String") {
    method = "String";
  } else if (
    body.callee.type === "MemberExpression" &&
    !body.callee.computed &&
    body.callee.object.type === "Identifier" &&
    body.callee.object.name === "String" &&
    body.callee.property.type === "Identifier"
  ) {
    method = body.callee.property.name;
  }
  if (!["String", "fromCharCode", "fromCodePoint"].includes(method)) {
    return null;
  }

  const values = [];
  for (const element of elements) {
    if (method === "String") {
      if (typeof element !== "string" && typeof element !== "number") {
        return null;
      }
      values.push(String(element));
      continue;
    }
    const text = codePointsToText([element], method);
    if (text === UNKNOWN) return null;
    values.push(text);
  }
  return values;
}

function evaluateStaticCall(node, evaluate) {
  if (
    ["ArrowFunctionExpression", "FunctionExpression"].includes(
      node.callee.type,
    ) &&
    node.arguments.length === 0
  ) {
    const body = node.callee.body;
    if (body.type !== "BlockStatement") return evaluate(body);
    const returns = body.body.filter(
      (statement) => statement.type === "ReturnStatement" && statement.argument,
    );
    if (returns.length === 1) return evaluate(returns[0].argument);
    return UNKNOWN;
  }

  if (node.callee.type === "Identifier") {
    const argument =
      node.arguments.length > 0 ? evaluate(node.arguments[0]) : UNKNOWN;
    if (node.callee.name === "String" && argument !== UNKNOWN) {
      return Buffer.isBuffer(argument)
        ? argument.toString("utf8")
        : String(argument);
    }
    if (
      ["decodeURI", "decodeURIComponent", "atob"].includes(node.callee.name) &&
      typeof argument === "string"
    ) {
      try {
        if (node.callee.name === "decodeURI") return decodeURI(argument);
        if (node.callee.name === "decodeURIComponent") {
          return decodeURIComponent(argument);
        }
        return Buffer.from(argument, "base64").toString("binary");
      } catch {
        return UNKNOWN;
      }
    }
  }

  if (node.callee.type !== "MemberExpression") return UNKNOWN;
  const method = propertyName(
    node.callee.property,
    node.callee.computed,
    evaluate,
  );
  if (!method) return UNKNOWN;

  if (
    ["fromCharCode", "fromCodePoint"].includes(method) &&
    node.callee.object.type === "Identifier" &&
    node.callee.object.name === "String"
  ) {
    const codes = [];
    for (const argument of node.arguments) {
      if (argument.type === "SpreadElement") {
        const spreadValues = staticArrayValues(evaluate(argument.argument));
        if (!spreadValues) return UNKNOWN;
        codes.push(...spreadValues);
        continue;
      }
      codes.push(evaluate(argument));
    }
    return codePointsToText(codes, method);
  }

  if (method === "map" && node.arguments.length === 1) {
    const elements = staticArrayValues(evaluate(node.callee.object));
    const callback = node.arguments[0];
    if (
      elements &&
      ["ArrowFunctionExpression", "FunctionExpression"].includes(
        callback?.type,
      ) &&
      callback.params.length === 1 &&
      callback.params[0].type === "Identifier"
    ) {
      const body =
        callback.body.type === "BlockStatement"
          ? (returnedExpressions(callback)[0] ?? null)
          : callback.body;
      const mapped = mapThroughStaticStringCall(
        body,
        callback.params[0].name,
        elements,
      );
      if (mapped) return { kind: "array", values: mapped };
    }
  }

  if (
    method === "from" &&
    node.callee.object.type === "Identifier" &&
    node.callee.object.name === "Buffer"
  ) {
    const value =
      node.arguments.length > 0 ? evaluate(node.arguments[0]) : UNKNOWN;
    const encoding =
      node.arguments.length > 1 ? evaluate(node.arguments[1]) : "utf8";
    const arrayValues = staticArrayValues(value);
    if (arrayValues) {
      if (arrayValues.length > MAX_STATIC_DECODE_BYTES) return UNKNOWN;
      const bytes = [];
      for (const entry of arrayValues) {
        if (
          typeof entry !== "number" ||
          !Number.isInteger(entry) ||
          entry < 0 ||
          entry > 255
        ) {
          return UNKNOWN;
        }
        bytes.push(entry);
      }
      return Buffer.from(bytes);
    }
    if (
      typeof value === "string" &&
      typeof encoding === "string" &&
      [
        "ascii",
        "base64",
        "base64url",
        "hex",
        "latin1",
        "utf8",
        "utf-8",
      ].includes(encoding.toLowerCase())
    ) {
      try {
        const decoded = Buffer.from(value, encoding);
        return decoded.length <= MAX_STATIC_DECODE_BYTES ? decoded : UNKNOWN;
      } catch {
        return UNKNOWN;
      }
    }
  }

  const object = evaluate(node.callee.object);
  if (method === "toString" && object !== UNKNOWN) {
    const encoding =
      node.arguments.length > 0 ? evaluate(node.arguments[0]) : "utf8";
    if (Buffer.isBuffer(object) && typeof encoding === "string") {
      try {
        return object.toString(encoding);
      } catch {
        return UNKNOWN;
      }
    }
    if (!Buffer.isBuffer(object) && node.arguments.length === 0) {
      return String(object);
    }
  }
  if (
    ["slice", "substring", "substr"].includes(method) &&
    typeof object === "string"
  ) {
    const values = node.arguments.map(evaluate);
    if (values.every((value) => typeof value === "number")) {
      return String.prototype[method].apply(object, values);
    }
  }
  if (
    ["replace", "replaceAll"].includes(method) &&
    typeof object === "string" &&
    node.arguments.length === 2
  ) {
    const values = node.arguments.map(evaluate);
    if (values.every((value) => typeof value === "string")) {
      return String.prototype[method].apply(object, values);
    }
  }
  if (
    ["trim", "trimStart", "trimEnd", "toLowerCase", "toUpperCase"].includes(
      method,
    ) &&
    typeof object === "string" &&
    node.arguments.length === 0
  ) {
    return String.prototype[method].call(object);
  }
  if (method === "concat" && typeof object === "string") {
    const values = node.arguments.map(evaluate);
    if (values.every((value) => typeof value === "string")) {
      return object.concat(...values);
    }
  }
  if (method === "join" && object?.kind === "array") {
    const separator =
      node.arguments.length > 0 ? evaluate(node.arguments[0]) : ",";
    if (
      typeof separator === "string" &&
      object.values.every((value) => !Buffer.isBuffer(value))
    ) {
      return object.values.join(separator);
    }
  }
  return UNKNOWN;
}

function propertyName(node, computed, evaluate) {
  if (!computed && node?.type === "Identifier") return node.name;
  const value = evaluate(node);
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : null;
}

function memberRootIdentifierName(node) {
  let current = node;
  while (current?.type === "ChainExpression") current = current.expression;
  while (current?.type === "MemberExpression") {
    current = current.object;
    while (current?.type === "ChainExpression") current = current.expression;
  }
  return current?.type === "Identifier" ? current.name : null;
}

const MEMBER_ALIAS_PREFIX = "\u0000member:";
const CALL_ALIAS_PREFIX = "\u0000call:";

function memberReferenceParts(node, evaluate) {
  const path = [];
  let current = node;
  while (current?.type === "ChainExpression") current = current.expression;
  while (current?.type === "MemberExpression") {
    const name = propertyName(current.property, current.computed, evaluate);
    if (name === null) return null;
    path.unshift(name);
    current = current.object;
    while (current?.type === "ChainExpression") current = current.expression;
  }
  if (current?.type !== "Identifier") return null;
  return { root: current.name, path };
}

function canonicalMemberParts(parts, aliases = null) {
  if (!parts) return null;
  let root = parts.root;
  let path = [...parts.path];
  const visited = new Set();
  while (aliases?.memberSources?.has(root) && !visited.has(root)) {
    visited.add(root);
    const source = aliases.memberSources.get(root);
    root = source.root;
    path = [...source.path, ...path];
  }
  return { root, path };
}

function classHasUnprovableInstanceWrite(
  classNode,
  secretNames,
  aliases,
  evaluate,
) {
  if (!classNode) return false;
  for (const candidate of allNodes(classNode)) {
    const target =
      candidate.type === "AssignmentExpression" &&
      candidate.operator === "=" &&
      candidate.left.type === "MemberExpression" &&
      candidate.left.object.type === "ThisExpression"
        ? candidate.right
        : candidate.type === "PropertyDefinition" && !candidate.static
          ? candidate.value
          : null;
    if (!target) continue;
    if (!isApprovedDynamicSecretValue(target, secretNames, aliases, evaluate)) {
      return true;
    }
  }
  return false;
}

// Recognises Object.entries(process.env), optionally followed by array
// transforms that preserve the entries' origin. This is matched positionally, in
// the value position that actually feeds the container.
//
// An earlier form asked only whether the initializer's subtree *mentioned*
// process.env anywhere. That is not provenance: `Object.create(base ?? process.env)`
// passed while `Object.create(base)` was refused, so six characters in a
// right-hand side that never evaluates disarmed the rule entirely.
const ENVIRONMENT_ENTRY_TRANSFORMS = new Set([
  "concat",
  "filter",
  "flat",
  "flatMap",
  "map",
  "reverse",
  "slice",
  "sort",
  "toReversed",
  "toSorted",
]);

function isEnvironmentEntriesExpression(node, evaluate, aliases) {
  if (!node) return false;
  if (node.type === "ChainExpression") {
    return isEnvironmentEntriesExpression(node.expression, evaluate, aliases);
  }
  if (node.type !== "CallExpression") return false;
  const callee = node.callee;
  if (callee.type !== "MemberExpression" || callee.computed) return false;
  const method = propertyName(callee.property, callee.computed, evaluate);
  if (
    callee.object.type === "Identifier" &&
    callee.object.name === "Object" &&
    method === "entries"
  ) {
    return isProcessEnvironmentObject(node.arguments[0], evaluate, aliases);
  }
  if (!ENVIRONMENT_ENTRY_TRANSFORMS.has(method)) return false;
  return isEnvironmentEntriesExpression(callee.object, evaluate, aliases);
}

function isEmptyObjectSource(node, evaluate) {
  if (!node) return true;
  if (node.type === "ObjectExpression") return node.properties.length === 0;
  return evaluate(node) === null;
}

function isOpaqueContainerInitializer(node, secretNames, aliases, evaluate) {
  if (!node) return false;
  if (node.type === "NewExpression") {
    if (node.callee.type !== "Identifier") return true;
    const classNode = aliases.classNodes?.get(node.callee.name);
    if (!classNode) return false;
    return classHasUnprovableInstanceWrite(
      classNode,
      secretNames,
      aliases,
      evaluate,
    );
  }
  if (node.type === "ObjectExpression") {
    const spreads = node.properties.filter(
      (property) => property.type === "SpreadElement",
    );
    if (spreads.length <= 1) return false;
    // Several spreads normally mean the result cannot be tracked member by
    // member. But when one of them spreads process.env directly, the container
    // is an environment copy, which is the shape { ...defaults, ...process.env }
    // and { ...{}, ...process.env } that legitimately reads a secret back out.
    return !spreads.some((spread) =>
      isProcessEnvironmentObject(spread.argument, evaluate, aliases),
    );
  }
  if (
    node.type !== "CallExpression" ||
    node.callee.type !== "MemberExpression" ||
    node.callee.computed ||
    node.callee.object.type !== "Identifier" ||
    node.callee.property.type !== "Identifier"
  ) {
    return false;
  }
  if (node.callee.object.name !== "Object") return false;
  // Object.create(null) and Object.create({}) produce an empty object with
  // nothing inherited, so every later write to it is one this scanner already
  // models. Only a create from some other prototype can carry state in from
  // somewhere unmodelled.
  if (node.callee.property.name === "create") {
    return !isEmptyObjectSource(node.arguments[0], evaluate);
  }
  if (node.callee.property.name !== "fromEntries") return false;
  // Object.fromEntries hides which members it produced, unless its argument is
  // demonstrably the environment's own entries, in which case the container is
  // an environment copy and reading a secret out of it is correct.
  return !isEnvironmentEntriesExpression(node.arguments[0], evaluate, aliases);
}

function containerRootKey(key) {
  const suffix = key.slice(MEMBER_ALIAS_PREFIX.length);
  const bracket = suffix.indexOf("[");
  const root = bracket < 0 ? suffix : suffix.slice(0, bracket);
  return memberAliasKey(root, []);
}

const OPAQUE_CONTAINER_MUTATORS = new Map([
  ["Reflect", new Set(["set", "defineProperty", "deleteProperty"])],
  ["Object", new Set(["defineProperties", "setPrototypeOf"])],
]);

function opaqueContainerMutationTarget(node, evaluate, aliases) {
  if (node?.type !== "CallExpression" || node.arguments.length === 0) {
    return null;
  }
  const resolved = resolveBuiltinCall(node, evaluate, aliases);
  if (!resolved) return null;
  const owner = resolved.owner;
  const method = resolved.method;
  const callArguments = resolved.args ?? node.arguments;
  if (callArguments.length === 0) return null;
  if (OPAQUE_CONTAINER_MUTATORS.get(owner)?.has(method)) {
    return callArguments[0];
  }
  if (owner === "Reflect" && method === "set") return callArguments[0];
  if (owner === "Object" && method === "assign") {
    const opaqueSource = callArguments
      .slice(1)
      .some((argument) => argument.type !== "ObjectExpression");
    return opaqueSource ? callArguments[0] : null;
  }
  return null;
}

function containerCopySource(node) {
  if (!node) return null;
  if (node.type === "ObjectExpression") {
    const spreads = node.properties.filter(
      (property) => property.type === "SpreadElement",
    );
    return spreads.length === 1 ? spreads[0].argument : null;
  }
  if (node.type !== "CallExpression") return null;
  if (
    node.callee.type === "Identifier" &&
    node.callee.name === "structuredClone" &&
    node.arguments.length === 1
  ) {
    return node.arguments[0];
  }
  if (node.callee.type !== "MemberExpression" || node.callee.computed) {
    return null;
  }
  if (
    node.callee.object.type !== "Identifier" ||
    node.callee.property.type !== "Identifier"
  ) {
    return null;
  }
  const owner = node.callee.object.name;
  const method = node.callee.property.name;
  if (owner === "Object" && method === "assign") {
    for (const argument of node.arguments) {
      const nested = containerCopySource(argument) ?? argument;
      if (["Identifier", "MemberExpression"].includes(nested?.type)) {
        return nested;
      }
    }
    return null;
  }
  if (owner === "JSON" && method === "parse" && node.arguments.length >= 1) {
    const inner = node.arguments[0];
    if (
      inner?.type === "CallExpression" &&
      inner.callee.type === "MemberExpression" &&
      !inner.callee.computed &&
      inner.callee.object.type === "Identifier" &&
      inner.callee.object.name === "JSON" &&
      inner.callee.property.type === "Identifier" &&
      inner.callee.property.name === "stringify" &&
      inner.arguments.length >= 1
    ) {
      return inner.arguments[0];
    }
  }
  return null;
}

function memberAliasKey(root, path) {
  return `${MEMBER_ALIAS_PREFIX}${root}${path
    .map((part) => `[${JSON.stringify(part)}]`)
    .join("")}`;
}

function memberReferenceKey(node, evaluate, aliases = null) {
  const parts = canonicalMemberParts(
    memberReferenceParts(node, evaluate),
    aliases,
  );
  return parts ? memberAliasKey(parts.root, parts.path) : null;
}

function callAliasKey(node) {
  return `${CALL_ALIAS_PREFIX}${node.start}:${node.end}`;
}

function directSecretReference(node, secretNames, aliases, evaluate) {
  if (!node) return null;
  if (node.type === "ChainExpression" || node.type === "AwaitExpression") {
    return directSecretReference(
      node.expression ?? node.argument,
      secretNames,
      aliases,
      evaluate,
    );
  }
  if (node.type === "Identifier") {
    if (secretNames.has(node.name)) return node.name;
    return aliases.get(node.name) ?? null;
  }
  if (node.type !== "MemberExpression") return null;

  const name = propertyName(node.property, node.computed, evaluate);
  if (name && secretNames.has(name)) return name;
  if (
    name === null &&
    node.computed &&
    isProcessEnvironmentProperty(node, evaluate, aliases)
  ) {
    return UNKNOWN_ENVIRONMENT_SECRET;
  }
  const memberKey = memberReferenceKey(node, evaluate, aliases);
  if (memberKey && aliases.memberAssignments?.has(memberKey)) {
    return aliases.memberSecretAt(memberKey, node.start);
  }
  if (memberKey && aliases.has(memberKey)) return aliases.get(memberKey);
  const rootName = memberRootIdentifierName(node);
  return rootName ? (aliases.get(rootName) ?? null) : null;
}

function expressionSecretReference(node, secretNames, aliases, evaluate) {
  const direct = directSecretReference(node, secretNames, aliases, evaluate);
  if (direct) return direct;
  if (!node) return null;
  if (node.type === "ChainExpression" || node.type === "AwaitExpression") {
    return expressionSecretReference(
      node.expression ?? node.argument,
      secretNames,
      aliases,
      evaluate,
    );
  }
  if (node.type === "CallExpression") {
    const callSecret = aliases.get(callAliasKey(node));
    if (callSecret) return callSecret;
    if (node.callee.type === "Identifier") {
      const functionSecret = aliases.get(node.callee.name);
      if (functionSecret) return functionSecret;
    }
  }
  if (
    node.type === "CallExpression" &&
    ["ArrowFunctionExpression", "FunctionExpression"].includes(node.callee.type)
  ) {
    for (const expression of returnedExpressions(node.callee)) {
      const name = expressionSecretReference(
        expression,
        secretNames,
        aliases,
        evaluate,
      );
      if (name) return name;
    }
    return null;
  }
  if (node.type === "ObjectExpression") {
    for (const property of node.properties) {
      if (property.type !== "Property") continue;
      const name = expressionSecretReference(
        property.value,
        secretNames,
        aliases,
        evaluate,
      );
      if (name) return name;
    }
    return null;
  }
  if (node.type === "ArrayExpression") {
    for (const element of node.elements) {
      const name = expressionSecretReference(
        element,
        secretNames,
        aliases,
        evaluate,
      );
      if (name) return name;
    }
    return null;
  }
  if (node.type === "LogicalExpression" || node.type === "BinaryExpression") {
    return (
      expressionSecretReference(node.left, secretNames, aliases, evaluate) ??
      expressionSecretReference(node.right, secretNames, aliases, evaluate)
    );
  }
  if (node.type === "ConditionalExpression") {
    return (
      expressionSecretReference(
        node.consequent,
        secretNames,
        aliases,
        evaluate,
      ) ??
      expressionSecretReference(node.alternate, secretNames, aliases, evaluate)
    );
  }
  if (node.type === "SequenceExpression") {
    return expressionSecretReference(
      node.expressions.at(-1),
      secretNames,
      aliases,
      evaluate,
    );
  }
  return null;
}

function collectSecretInputs(node, secretNames, evaluate, result) {
  if (!node) return;
  if (node.type === "ChainExpression" || node.type === "AwaitExpression") {
    collectSecretInputs(
      node.expression ?? node.argument,
      secretNames,
      evaluate,
      result,
    );
    return;
  }
  if (node.type === "Identifier") {
    if (secretNames.has(node.name)) result.direct.add(node.name);
    else result.dependencies.add(node.name);
    return;
  }
  if (node.type === "MemberExpression") {
    const name = propertyName(node.property, node.computed, evaluate);
    if (name && secretNames.has(name)) {
      result.direct.add(name);
    } else if (
      name === null &&
      node.computed &&
      isProcessEnvironmentProperty(node, evaluate, result.aliases)
    ) {
      result.direct.add(UNKNOWN_ENVIRONMENT_SECRET);
    } else {
      const memberKey = memberReferenceKey(node, evaluate, result.aliases);
      if (memberKey && result.aliases?.memberAssignments?.has(memberKey)) {
        const secret = result.aliases.memberSecretAt(memberKey, node.start);
        if (secret) result.direct.add(secret);
      } else if (memberKey) {
        result.dependencies.add(memberKey);
      } else {
        collectSecretInputs(node.object, secretNames, evaluate, result);
      }
    }
    return;
  }
  if (node.type === "ObjectExpression") {
    for (const property of node.properties) {
      if (property.type === "Property") {
        collectSecretInputs(property.value, secretNames, evaluate, result);
      }
    }
    return;
  }
  if (node.type === "ArrayExpression") {
    for (const element of node.elements) {
      collectSecretInputs(element, secretNames, evaluate, result);
    }
    return;
  }
  if (node.type === "LogicalExpression") {
    collectSecretInputs(node.left, secretNames, evaluate, result);
    collectSecretInputs(node.right, secretNames, evaluate, result);
    return;
  }
  if (node.type === "ConditionalExpression") {
    collectSecretInputs(node.consequent, secretNames, evaluate, result);
    collectSecretInputs(node.alternate, secretNames, evaluate, result);
    return;
  }
  if (node.type === "SequenceExpression") {
    collectSecretInputs(node.expressions.at(-1), secretNames, evaluate, result);
    return;
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    collectSecretInputs(node.left, secretNames, evaluate, result);
    collectSecretInputs(node.right, secretNames, evaluate, result);
    return;
  }
  if (
    [
      "ArrowFunctionExpression",
      "FunctionExpression",
      "FunctionDeclaration",
    ].includes(node.type)
  ) {
    for (const expression of returnedExpressions(node)) {
      collectSecretInputs(expression, secretNames, evaluate, result);
    }
    return;
  }
  if (
    node.type === "CallExpression" &&
    ["ArrowFunctionExpression", "FunctionExpression"].includes(node.callee.type)
  ) {
    collectSecretInputs(node.callee, secretNames, evaluate, result);
    return;
  }
  if (node.type === "CallExpression") {
    if (
      node.callee.type === "Identifier" &&
      node.callee.name === "String" &&
      node.arguments.length > 0
    ) {
      collectSecretInputs(node.arguments[0], secretNames, evaluate, result);
    } else {
      result.dependencies.add(callAliasKey(node));
      if (node.callee.type === "Identifier") {
        result.dependencies.add(node.callee.name);
      }
    }
    return;
  }
}

function collectAliases(nodes, secretNames, evaluate) {
  const aliases = new Map();
  aliases.environmentObjects = new Set();
  aliases.globalObjects = new Set();
  aliases.processObjects = new Set();
  aliases.functionDefinitions = new Map();
  aliases.classMethods = new Map();
  aliases.classNames = new Set();
  aliases.classNodes = new Map();
  aliases.builtinNamespaces = new Map();
  aliases.builtinMembers = new Map();
  aliases.objectMethods = new Map();
  aliases.instanceClasses = new Map();
  aliases.memberSources = new Map();
  aliases.memberAssignments = new Map();

  const dependents = new Map();
  const queue = [];
  const calls = [];
  const parents = new WeakMap();
  for (const node of nodes) {
    for (const child of childNodes(node)) {
      if (!parents.has(child)) parents.set(child, node);
    }
  }

  function staticTruthiness(node) {
    const value = evaluate(node);
    if (value === UNKNOWN || Buffer.isBuffer(value)) return null;
    if (
      value === null ||
      ["boolean", "number", "string", "bigint", "undefined"].includes(
        typeof value,
      )
    ) {
      return Boolean(value);
    }
    return null;
  }

  function memberEventExecution(node) {
    let current = node;
    while (current) {
      const parent = parents.get(current);
      if (!parent) break;
      if (parent.type === "IfStatement") {
        if (current === parent.consequent || current === parent.alternate) {
          const truthiness = staticTruthiness(parent.test);
          const selected = truthiness
            ? parent.consequent
            : truthiness === false
              ? parent.alternate
              : null;
          if (truthiness !== null) {
            if (current !== selected) return "never";
          } else {
            return "maybe";
          }
        }
      } else if (parent.type === "ConditionalExpression") {
        if (current === parent.consequent || current === parent.alternate) {
          const truthiness = staticTruthiness(parent.test);
          const selected = truthiness ? parent.consequent : parent.alternate;
          if (truthiness !== null) {
            if (current !== selected) return "never";
          } else {
            return "maybe";
          }
        }
      } else if (
        parent.type === "LogicalExpression" &&
        current === parent.right
      ) {
        const leftValue = evaluate(parent.left);
        if (leftValue === UNKNOWN || Buffer.isBuffer(leftValue)) return "maybe";
        if (parent.operator === "&&") {
          if (!leftValue) return "never";
        } else if (parent.operator === "||") {
          if (leftValue) return "never";
        } else if (parent.operator === "??") {
          if (leftValue !== null && leftValue !== undefined) return "never";
        } else {
          return "maybe";
        }
      } else if (
        [
          "CatchClause",
          "ForInStatement",
          "ForOfStatement",
          "ForStatement",
          "SwitchCase",
          "WhileStatement",
        ].includes(parent.type) ||
        (parent.type === "TryStatement" &&
          (current === parent.handler || current === parent.block))
      ) {
        return "maybe";
      }
      if (
        [
          "ArrowFunctionExpression",
          "FunctionDeclaration",
          "FunctionExpression",
        ].includes(parent.type)
      ) {
        return "maybe";
      }
      current = parent;
    }
    return "always";
  }

  function rememberAlias(target, source) {
    if (!target || !source || aliases.has(target)) return false;
    aliases.set(target, source);
    queue.push(target);
    return true;
  }

  function addDependency(target, dependency) {
    if (!target || !dependency) return;
    if (!dependents.has(dependency)) dependents.set(dependency, new Set());
    dependents.get(dependency).add(target);
  }

  function addExpression(target, expression) {
    if (!target || !expression) return;
    const inputs = {
      aliases,
      direct: new Set(),
      dependencies: new Set(),
    };
    collectSecretInputs(expression, secretNames, evaluate, inputs);
    const direct = inputs.direct.values().next().value;
    if (direct) rememberAlias(target, direct);
    for (const dependency of inputs.dependencies) {
      addDependency(target, dependency);
    }
  }

  function recordMemberExpression(root, path, expression, position) {
    const canonical = canonicalMemberParts({ root, path }, aliases);
    if (!canonical || !expression) return;
    const key = memberAliasKey(canonical.root, canonical.path);
    if (!aliases.memberAssignments.has(key)) {
      aliases.memberAssignments.set(key, []);
    }
    aliases.memberAssignments.get(key).push({
      execution: memberEventExecution(expression),
      expression,
      position,
    });
  }

  const hardcodedProvenanceCalls = new WeakSet();
  aliases.hardcodedProvenanceCalls = hardcodedProvenanceCalls;
  aliases.opaqueContainers = new Set();

  function markOpaqueContainer(expression) {
    const parts = canonicalMemberParts(
      memberReferenceParts(expression, evaluate),
      aliases,
    );
    if (!parts) return;
    aliases.opaqueContainers.add(memberAliasKey(parts.root, []));
  }

  const resolvingMemberEvents = new Set();
  aliases.memberSecretAt = (key, position = Number.POSITIVE_INFINITY) => {
    const events = aliases.memberAssignments.get(key) ?? [];
    let secret = aliases.get(key) ?? null;
    let allWritesApproved = true;
    for (const event of events) {
      if (event.execution === "never") continue;
      const eventKey = `${key}:${event.position}`;
      if (resolvingMemberEvents.has(eventKey)) continue;
      resolvingMemberEvents.add(eventKey);
      let eventSecret;
      let eventApproved;
      try {
        eventSecret = expressionSecretReference(
          event.expression,
          secretNames,
          aliases,
          evaluate,
        );
        eventApproved = isApprovedDynamicSecretValue(
          event.expression,
          secretNames,
          aliases,
          evaluate,
        );
      } finally {
        resolvingMemberEvents.delete(eventKey);
      }
      if (event.execution === "always") {
        secret = eventSecret;
        allWritesApproved = eventApproved;
      } else {
        if (!secret && eventSecret) secret = eventSecret;
        if (!eventApproved) allWritesApproved = false;
      }
    }
    if (!secret) return null;
    if (!allWritesApproved) return null;
    if (aliases.memberHardcodedAt(key, position)) return null;
    if (aliases.opaqueContainers.has(containerRootKey(key))) return null;
    return secret;
  };

  aliases.memberSecretBefore = (key, position) => {
    const events = aliases.memberAssignments.get(key) ?? [];
    let secret = aliases.get(key) ?? null;
    let allWritesApproved = true;
    for (const event of events) {
      if (event.position >= position) break;
      if (event.execution === "never") continue;
      const eventKey = `before:${key}:${event.position}`;
      if (resolvingMemberEvents.has(eventKey)) continue;
      resolvingMemberEvents.add(eventKey);
      let eventSecret;
      let eventApproved;
      try {
        eventSecret = expressionSecretReference(
          event.expression,
          secretNames,
          aliases,
          evaluate,
        );
        eventApproved = isApprovedDynamicSecretValue(
          event.expression,
          secretNames,
          aliases,
          evaluate,
        );
      } finally {
        resolvingMemberEvents.delete(eventKey);
      }
      if (event.execution === "always") {
        secret = eventSecret;
        allWritesApproved = eventApproved;
      } else {
        if (!secret && eventSecret) secret = eventSecret;
        if (!eventApproved) allWritesApproved = false;
      }
    }
    return secret && allWritesApproved ? secret : null;
  };

  aliases.memberHardcodedAt = (key) => {
    const events = aliases.memberAssignments.get(key) ?? [];
    let hardcoded = false;
    for (const event of events) {
      if (event.execution === "never") continue;
      const eventHardcoded = containsHardcodedValue(event.expression, evaluate);
      if (event.execution === "always") {
        hardcoded = eventHardcoded;
      } else if (eventHardcoded) {
        hardcoded = true;
      }
    }
    return hardcoded;
  };

  function addContainerExpressions(root, path, expression) {
    if (expression?.type === "ObjectExpression") {
      for (const property of expression.properties) {
        if (property.type !== "Property" || property.kind !== "init") continue;
        const key = propertyName(property.key, property.computed, evaluate);
        if (key === null) continue;
        const memberPath = [...path, key];
        recordMemberExpression(
          root,
          memberPath,
          property.value,
          property.value.end,
        );
        addContainerExpressions(root, memberPath, property.value);
      }
      return true;
    }
    const arrayInfo = staticArrayInfo(expression);
    if (arrayInfo) {
      arrayInfo.elements.forEach((element, index) => {
        if (!element) return;
        const memberPath = [...path, String(index)];
        recordMemberExpression(root, memberPath, element, element.end);
        addContainerExpressions(root, memberPath, element);
      });
      return true;
    }
    return false;
  }

  function targetIdentifier(node) {
    let current = node;
    if (current?.type === "AssignmentPattern") current = current.left;
    if (current?.type === "RestElement") current = current.argument;
    return current?.type === "Identifier" ? current.name : null;
  }

  function drainQueue() {
    for (let index = 0; index < queue.length; index += 1) {
      const sourceName = queue[index];
      const secretName = aliases.get(sourceName);
      for (const target of dependents.get(sourceName) ?? []) {
        rememberAlias(target, secretName);
      }
    }
    queue.length = 0;
  }

  const aliasAssignments = [];
  const destructuredObjectAliases = [];
  const containerKeys = new Set();

  function staticArrayInfo(expression) {
    if (expression?.type === "ArrayExpression") {
      return {
        elements: expression.elements,
        length: expression.elements.length,
      };
    }
    if (
      !["CallExpression", "NewExpression"].includes(expression?.type) ||
      expression.callee.type !== "Identifier" ||
      expression.callee.name !== "Array"
    ) {
      return null;
    }
    if (expression.arguments.length === 0) {
      return { elements: [], length: 0 };
    }
    if (expression.arguments.length === 1) {
      const length = evaluate(expression.arguments[0]);
      if (Number.isInteger(length) && length >= 0 && length <= 0xffff_ffff) {
        return { elements: [], length };
      }
    }
    if (
      expression.arguments.some((argument) => argument.type === "SpreadElement")
    ) {
      return null;
    }
    return {
      elements: expression.arguments,
      length: expression.arguments.length,
    };
  }

  function markContainerPaths(root, path, expression) {
    const arrayInfo = staticArrayInfo(expression);
    if (expression?.type !== "ObjectExpression" && !arrayInfo) {
      return;
    }
    containerKeys.add(memberAliasKey(root, path));
    if (expression.type === "ObjectExpression") {
      for (const property of expression.properties) {
        if (property.type !== "Property" || property.kind !== "init") continue;
        const key = propertyName(property.key, property.computed, evaluate);
        if (key !== null) {
          markContainerPaths(root, [...path, key], property.value);
        }
      }
      return;
    }
    arrayInfo.elements.forEach((element, index) => {
      if (element) markContainerPaths(root, [...path, String(index)], element);
    });
  }

  function registerClassMethods(className, classNode) {
    if (
      !className ||
      (classNode?.type !== "ClassExpression" &&
        classNode?.type !== "ClassDeclaration")
    ) {
      return;
    }
    aliases.classNames.add(className);
    aliases.classNodes.set(className, classNode);
    for (const element of classNode.body.body) {
      if (
        element.type !== "MethodDefinition" &&
        element.type !== "PropertyDefinition"
      ) {
        continue;
      }
      const member = propertyName(element.key, element.computed, evaluate);
      if (!member) continue;
      const callable = element.value;
      const isCallable =
        callable &&
        ["ArrowFunctionExpression", "FunctionExpression"].includes(
          callable.type,
        );
      if (
        element.type === "PropertyDefinition" &&
        element.static &&
        callable &&
        !isCallable
      ) {
        recordMemberExpression(className, [member], callable, element.end);
      }
      if (!isCallable) continue;
      const kind = element.static ? "static" : "instance";
      aliases.classMethods.set(`${className}:${kind}:${member}`, callable);
    }
  }

  function registerObjectMethods(ownerName, objectNode) {
    if (!ownerName || objectNode?.type !== "ObjectExpression") return;
    for (const property of objectNode.properties) {
      if (
        property.type !== "Property" ||
        !["FunctionExpression", "ArrowFunctionExpression"].includes(
          property.value?.type,
        )
      ) {
        continue;
      }
      const method = propertyName(property.key, property.computed, evaluate);
      if (method)
        aliases.objectMethods.set(`${ownerName}:${method}`, property.value);
    }
  }

  function registerAssignedMemberCallable(node) {
    if (
      node.type !== "AssignmentExpression" ||
      node.operator !== "=" ||
      node.left.type !== "MemberExpression" ||
      !["ArrowFunctionExpression", "FunctionExpression"].includes(
        node.right?.type,
      )
    ) {
      return;
    }
    const method = propertyName(
      node.left.property,
      node.left.computed,
      evaluate,
    );
    const owner = memberReferenceParts(node.left.object, evaluate);
    if (!method || !owner) return;
    if (owner.path.length === 0) {
      if (aliases.classNames.has(owner.root)) {
        aliases.classMethods.set(`${owner.root}:static:${method}`, node.right);
      } else {
        aliases.objectMethods.set(`${owner.root}:${method}`, node.right);
      }
      return;
    }
    if (
      owner.path.length === 1 &&
      owner.path[0] === "prototype" &&
      aliases.classNames.has(owner.root)
    ) {
      aliases.classMethods.set(`${owner.root}:instance:${method}`, node.right);
    }
  }

  for (const node of nodes) {
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "ObjectPattern" &&
      node.init
    ) {
      destructuredObjectAliases.push([node.id, node.init]);
    }
    if (
      node.type === "AssignmentExpression" &&
      node.operator === "=" &&
      node.left.type === "ObjectPattern"
    ) {
      destructuredObjectAliases.push([node.left, node.right]);
    }
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.init
    ) {
      aliasAssignments.push([node.id.name, node.init]);
      markContainerPaths(node.id.name, [], node.init);
      if (
        node.init.type === "ArrowFunctionExpression" ||
        node.init.type === "FunctionExpression"
      ) {
        aliases.functionDefinitions.set(node.id.name, node.init);
      }
      if (
        node.init.type === "NewExpression" &&
        node.init.callee.type === "Identifier"
      ) {
        aliases.instanceClasses.set(node.id.name, node.init.callee.name);
      }
      registerClassMethods(node.id.name, node.init);
      registerObjectMethods(node.id.name, node.init);
    }
    if (
      node.type === "AssignmentExpression" &&
      node.operator === "=" &&
      node.left.type === "Identifier"
    ) {
      aliasAssignments.push([node.left.name, node.right]);
      markContainerPaths(node.left.name, [], node.right);
      if (
        node.right.type === "ArrowFunctionExpression" ||
        node.right.type === "FunctionExpression"
      ) {
        aliases.functionDefinitions.set(node.left.name, node.right);
      }
      if (
        node.right.type === "NewExpression" &&
        node.right.callee.type === "Identifier"
      ) {
        aliases.instanceClasses.set(node.left.name, node.right.callee.name);
      }
      registerClassMethods(node.left.name, node.right);
      registerObjectMethods(node.left.name, node.right);
    }
    if (node.type === "FunctionDeclaration" && node.id?.type === "Identifier") {
      aliases.functionDefinitions.set(node.id.name, node);
    }
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.init?.type === "ClassExpression"
    ) {
      registerClassMethods(node.id.name, node.init);
    }
    if (node.type === "ClassDeclaration" && node.id?.type === "Identifier") {
      registerClassMethods(node.id.name, node);
    }
    if (
      node.type === "AssignmentExpression" &&
      node.left.type === "MemberExpression"
    ) {
      const assignedMember = memberReferenceParts(node.left, evaluate);
      if (assignedMember) {
        containerKeys.add(memberAliasKey(assignedMember.root, []));
      }
    }
    if (node.type === "CallExpression") calls.push(node);
  }
  for (const node of nodes) registerAssignedMemberCallable(node);

  for (
    let pass = 0;
    pass <= aliasAssignments.length + destructuredObjectAliases.length;
    pass += 1
  ) {
    let changed = false;
    for (const [target, source] of aliasAssignments) {
      const builtinNamespace = builtinNamespaceName(source, evaluate, aliases);
      if (
        builtinNamespace &&
        !aliases.builtinNamespaces.has(target) &&
        target !== builtinNamespace
      ) {
        aliases.builtinNamespaces.set(target, builtinNamespace);
        changed = true;
      }
      if (
        isOpaqueContainerInitializer(source, secretNames, aliases, evaluate)
      ) {
        aliases.opaqueContainers.add(memberAliasKey(target, []));
      }
      const sourceIsGlobal = isGlobalObjectExpression(
        source,
        evaluate,
        aliases,
      );
      if (sourceIsGlobal && !aliases.globalObjects.has(target)) {
        aliases.globalObjects.add(target);
        changed = true;
      }
      const sourceParts = canonicalMemberParts(
        memberReferenceParts(containerCopySource(source) ?? source, evaluate),
        aliases,
      );
      const sourceKey = sourceParts
        ? memberAliasKey(sourceParts.root, sourceParts.path)
        : null;
      if (
        sourceParts &&
        sourceParts.root !== target &&
        sourceKey &&
        containerKeys.has(sourceKey) &&
        !aliases.memberSources.has(target)
      ) {
        aliases.memberSources.set(target, sourceParts);
        containerKeys.add(memberAliasKey(target, []));
        changed = true;
      }
      if (
        !aliases.processObjects.has(target) &&
        isProcessObject(source, evaluate, aliases)
      ) {
        aliases.processObjects.add(target);
        changed = true;
      }
      if (
        !aliases.environmentObjects.has(target) &&
        isProcessEnvironmentObject(source, evaluate, aliases)
      ) {
        aliases.environmentObjects.add(target);
        changed = true;
      }
    }
    for (const [pattern, source] of destructuredObjectAliases) {
      const destructuredNamespace = builtinNamespaceName(
        source,
        evaluate,
        aliases,
      );
      if (destructuredNamespace) {
        for (const property of pattern.properties) {
          if (property.type !== "Property") continue;
          const method = propertyName(
            property.key,
            property.computed,
            evaluate,
          );
          const local = targetIdentifier(property.value);
          if (!method || !local || aliases.builtinMembers.has(local)) continue;
          aliases.builtinMembers.set(local, {
            owner: destructuredNamespace,
            method,
          });
          changed = true;
        }
      }
      const sourceIsProcess = isProcessObject(source, evaluate, aliases);
      const sourceIsGlobal =
        source.type === "Identifier" &&
        (["globalThis", "global"].includes(source.name) ||
          aliases.globalObjects.has(source.name));
      for (const property of pattern.properties) {
        if (property.type !== "Property") continue;
        const key = propertyName(property.key, property.computed, evaluate);
        const target = targetIdentifier(property.value);
        if (!target) continue;
        if (
          key === "env" &&
          sourceIsProcess &&
          !aliases.environmentObjects.has(target)
        ) {
          aliases.environmentObjects.add(target);
          changed = true;
        }
        if (
          key === "process" &&
          sourceIsGlobal &&
          !aliases.processObjects.has(target)
        ) {
          aliases.processObjects.add(target);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  const arrayLengths = new Map();
  const orderedNodes = [...nodes].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  for (const node of orderedNodes) {
    if (node.type === "FunctionDeclaration" && node.id?.type === "Identifier") {
      addExpression(node.id.name, node);
    }
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier") {
      const canonical = canonicalMemberParts(
        { root: node.id.name, path: [] },
        aliases,
      );
      const arrayInfo = staticArrayInfo(node.init);
      if (arrayInfo && canonical) {
        arrayLengths.set(
          memberAliasKey(canonical.root, canonical.path),
          arrayInfo.length,
        );
      }
      if (
        isOpaqueContainerInitializer(node.init, secretNames, aliases, evaluate)
      ) {
        aliases.opaqueContainers.add(memberAliasKey(node.id.name, []));
      }
      if (!addContainerExpressions(node.id.name, [], node.init)) {
        addExpression(node.id.name, node.init);
      }
    }
    if (
      node.type === "AssignmentExpression" &&
      node.left.type === "Identifier"
    ) {
      const canonical = canonicalMemberParts(
        { root: node.left.name, path: [] },
        aliases,
      );
      const arrayInfo = staticArrayInfo(node.right);
      if (arrayInfo && canonical) {
        arrayLengths.set(
          memberAliasKey(canonical.root, canonical.path),
          arrayInfo.length,
        );
      }
      if (
        isOpaqueContainerInitializer(node.right, secretNames, aliases, evaluate)
      ) {
        aliases.opaqueContainers.add(memberAliasKey(node.left.name, []));
      }
      if (!addContainerExpressions(node.left.name, [], node.right)) {
        addExpression(node.left.name, node.right);
      }
    }
    if (
      node.type === "AssignmentExpression" &&
      node.left.type === "MemberExpression"
    ) {
      const parts = canonicalMemberParts(
        memberReferenceParts(node.left, evaluate),
        aliases,
      );
      if (!parts) markOpaqueContainer(node.left.object);
      if (parts) {
        recordMemberExpression(parts.root, parts.path, node.right, node.end);
        const arrayInfo = staticArrayInfo(node.right);
        if (arrayInfo) {
          arrayLengths.set(
            memberAliasKey(parts.root, parts.path),
            arrayInfo.length,
          );
        }
        addContainerExpressions(parts.root, parts.path, node.right);
      }
    }
    const opaqueTarget = opaqueContainerMutationTarget(node, evaluate, aliases);
    if (opaqueTarget) markOpaqueContainer(opaqueTarget);

    if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      !node.callee.computed &&
      node.callee.object.type === "Identifier" &&
      node.callee.object.name === "Object" &&
      node.callee.property.type === "Identifier" &&
      ["assign", "defineProperty"].includes(node.callee.property.name) &&
      node.arguments.length >= 2
    ) {
      const targetParts = canonicalMemberParts(
        memberReferenceParts(node.arguments[0], evaluate),
        aliases,
      );
      if (targetParts) {
        if (node.callee.property.name === "assign") {
          for (const argument of node.arguments.slice(1)) {
            if (argument.type !== "ObjectExpression") continue;
            for (const property of argument.properties) {
              if (property.type !== "Property" || property.kind !== "init") {
                continue;
              }
              const key = propertyName(
                property.key,
                property.computed,
                evaluate,
              );
              if (key === null) continue;
              recordMemberExpression(
                targetParts.root,
                [...targetParts.path, key],
                property.value,
                node.end,
              );
            }
          }
        } else {
          const key = evaluate(node.arguments[1]);
          const descriptorValue =
            node.arguments[2]?.type === "ObjectExpression"
              ? node.arguments[2].properties.find(
                  (property) =>
                    property.type === "Property" &&
                    propertyName(property.key, property.computed, evaluate) ===
                      "value",
                )?.value
              : null;
          if (typeof key === "string" && descriptorValue) {
            recordMemberExpression(
              targetParts.root,
              [...targetParts.path, key],
              descriptorValue,
              node.end,
            );
          }
        }
      }
    }
    if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression"
    ) {
      const method = propertyName(
        node.callee.property,
        node.callee.computed,
        evaluate,
      );
      const parts = canonicalMemberParts(
        memberReferenceParts(node.callee.object, evaluate),
        aliases,
      );
      const arrayKey = parts ? memberAliasKey(parts.root, parts.path) : null;
      if (method === "push" && arrayKey && arrayLengths.has(arrayKey)) {
        let nextIndex = arrayLengths.get(arrayKey);
        for (const argument of node.arguments) {
          const values =
            argument.type === "SpreadElement" &&
            argument.argument.type === "ArrayExpression"
              ? argument.argument.elements.filter(Boolean)
              : [
                  argument.type === "SpreadElement"
                    ? argument.argument
                    : argument,
                ];
          for (const value of values) {
            recordMemberExpression(
              parts.root,
              [...parts.path, String(nextIndex)],
              value,
              node.end,
            );
            nextIndex += 1;
          }
        }
        arrayLengths.set(arrayKey, nextIndex);
      }
    }
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "ObjectPattern"
    ) {
      const sourceIsEnvironment = isProcessEnvironmentObject(
        node.init,
        evaluate,
        aliases,
      );
      const sourceParts = canonicalMemberParts(
        memberReferenceParts(node.init, evaluate),
        aliases,
      );
      for (const property of node.id.properties) {
        if (property.type !== "Property") continue;
        const target = targetIdentifier(property.value);
        if (!target) continue;
        const sourceName = propertyName(
          property.key,
          property.computed,
          evaluate,
        );
        if (sourceName && secretNames.has(sourceName)) {
          rememberAlias(target, sourceName);
          continue;
        }
        if (sourceIsEnvironment && property.computed && sourceName === null) {
          rememberAlias(target, UNKNOWN_ENVIRONMENT_SECRET);
          continue;
        }
        if (sourceParts && sourceName !== null) {
          const memberKey = memberAliasKey(sourceParts.root, [
            ...sourceParts.path,
            sourceName,
          ]);
          const secret = aliases.memberSecretAt(memberKey, node.start);
          if (secret) rememberAlias(target, secret);
          else addDependency(target, memberKey);
          continue;
        }
        if (node.init?.type === "ObjectExpression" && sourceName !== null) {
          const sourceProperty = node.init.properties.find(
            (candidate) =>
              candidate.type === "Property" &&
              propertyName(candidate.key, candidate.computed, evaluate) ===
                sourceName,
          );
          if (sourceProperty) addExpression(target, sourceProperty.value);
        }
      }
    }
  }

  for (const events of aliases.memberAssignments.values()) {
    events.sort((left, right) => left.position - right.position);
  }
  drainQueue();

  function callableForCall(call) {
    if (call.callee.type === "Identifier") {
      return aliases.functionDefinitions.get(call.callee.name) ?? null;
    }
    if (call.callee.type !== "MemberExpression") return null;
    const method = propertyName(
      call.callee.property,
      call.callee.computed,
      evaluate,
    );
    if (!method) return null;

    const ownerParts = canonicalMemberParts(
      memberReferenceParts(call.callee.object, evaluate),
      aliases,
    );
    if (ownerParts?.path.length === 0) {
      const objectMethod = aliases.objectMethods.get(
        `${ownerParts.root}:${method}`,
      );
      if (objectMethod) return objectMethod;
    }

    let className = null;
    let kind = "instance";
    const owner = call.callee.object;
    if (owner.type === "Identifier") {
      if (aliases.classMethods.has(`${owner.name}:static:${method}`)) {
        className = owner.name;
        kind = "static";
      } else {
        className = aliases.instanceClasses.get(owner.name) ?? null;
      }
    } else if (
      owner.type === "NewExpression" &&
      owner.callee.type === "Identifier"
    ) {
      className = owner.callee.name;
    }
    return className
      ? (aliases.classMethods.get(`${className}:${kind}:${method}`) ?? null)
      : null;
  }

  function scopedNodes(functionNode) {
    const result = [];
    const stack = [functionNode.body];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) continue;
      result.push(current);
      for (const child of childNodes(current)) {
        if (
          child !== functionNode.body &&
          [
            "ArrowFunctionExpression",
            "FunctionExpression",
            "FunctionDeclaration",
            "ClassExpression",
            "ClassDeclaration",
          ].includes(child.type)
        ) {
          continue;
        }
        stack.push(child);
      }
    }
    return result;
  }

  function parameterPathForExpression(expression, parameterPaths) {
    let current = expression;
    const suffix = [];
    while (current?.type === "ChainExpression") current = current.expression;
    while (current?.type === "MemberExpression") {
      const key = propertyName(current.property, current.computed, evaluate);
      suffix.unshift(key);
      current = current.object;
      while (current?.type === "ChainExpression") current = current.expression;
    }
    if (current?.type !== "Identifier") return null;
    const base = parameterPaths.get(current.name);
    return base
      ? { parameter: base.parameter, path: [...base.path, ...suffix] }
      : null;
  }

  function functionParameterPaths(functionNode) {
    const paths = new Map();
    const parameterBindings = new Map();
    const defaults = new Map();
    const defaultKey = (parameter, path) =>
      `${parameter}:${JSON.stringify(path)}`;

    function bindParameterPattern(
      pattern,
      parameter,
      index,
      path = [],
      rest = false,
    ) {
      if (!pattern) return;
      if (pattern.type === "AssignmentPattern") {
        defaults.set(defaultKey(parameter, path), pattern.right);
        bindParameterPattern(pattern.left, parameter, index, path, rest);
        return;
      }
      if (pattern.type === "RestElement") {
        parameterBindings.set(parameter, { index, rest: true });
        bindParameterPattern(pattern.argument, parameter, index, path, true);
        return;
      }
      if (pattern.type === "Identifier") {
        paths.set(pattern.name, { parameter, path });
        if (!parameterBindings.has(parameter)) {
          parameterBindings.set(parameter, { index, rest });
        }
        return;
      }
      if (pattern.type === "ObjectPattern") {
        for (const property of pattern.properties) {
          if (property.type !== "Property") continue;
          const key = propertyName(property.key, property.computed, evaluate);
          bindParameterPattern(
            property.value,
            parameter,
            index,
            [...path, key],
            rest,
          );
        }
        return;
      }
      if (pattern.type === "ArrayPattern") {
        pattern.elements.forEach((element, elementIndex) => {
          bindParameterPattern(
            element,
            parameter,
            index,
            [...path, String(elementIndex)],
            rest,
          );
        });
      }
    }

    functionNode.params.forEach((parameter, index) => {
      bindParameterPattern(parameter, `parameter:${index}`, index);
    });

    const localAssignments = [];
    for (const current of scopedNodes(functionNode)) {
      if (
        current.type === "VariableDeclarator" &&
        current.id.type === "Identifier" &&
        current.init
      ) {
        localAssignments.push([current.id.name, current.init]);
      }
      if (
        current.type === "AssignmentExpression" &&
        current.operator === "=" &&
        current.left.type === "Identifier"
      ) {
        localAssignments.push([current.left.name, current.right]);
      }
    }
    for (let pass = 0; pass <= localAssignments.length; pass += 1) {
      let changed = false;
      for (const [target, source] of localAssignments) {
        if (paths.has(target)) continue;
        const sourcePath = parameterPathForExpression(source, paths);
        if (sourcePath) {
          paths.set(target, sourcePath);
          changed = true;
        }
      }
      if (!changed) break;
    }

    const memberAssignments = new Map();
    for (const current of scopedNodes(functionNode)) {
      if (
        current.type !== "AssignmentExpression" ||
        current.operator !== "=" ||
        current.left.type !== "MemberExpression"
      ) {
        continue;
      }
      const target = parameterPathForExpression(current.left, paths);
      if (!target || target.path.some((part) => part === null)) continue;
      const key = defaultKey(target.parameter, target.path);
      if (!memberAssignments.has(key)) memberAssignments.set(key, []);
      memberAssignments.get(key).push({
        execution: memberEventExecution(current.right),
        expression: current.right,
        position: current.end,
      });
    }
    for (const events of memberAssignments.values()) {
      events.sort((left, right) => left.position - right.position);
    }
    paths.memberAssignments = memberAssignments;
    return { defaultKey, defaults, parameterBindings, paths };
  }

  function secretFromArgumentPath(argument, path) {
    if (!argument) return null;
    if (path.length === 0) {
      return expressionSecretReference(
        argument,
        secretNames,
        aliases,
        evaluate,
      );
    }

    const [head, ...tail] = path;
    if (isProcessEnvironmentObject(argument, evaluate, aliases)) {
      if (head === null) return UNKNOWN_ENVIRONMENT_SECRET;
      return secretNames.has(head) ? head : null;
    }
    if (argument.type === "ObjectExpression" && head !== null) {
      for (const property of argument.properties) {
        if (
          property.type === "Property" &&
          propertyName(property.key, property.computed, evaluate) === head
        ) {
          return tail.length === 0
            ? expressionSecretReference(
                property.value,
                secretNames,
                aliases,
                evaluate,
              )
            : secretFromArgumentPath(property.value, tail);
        }
      }
      return null;
    }
    if (argument.type === "ArrayExpression" && /^\d+$/.test(String(head))) {
      const element = argument.elements[Number(head)];
      return element ? secretFromArgumentPath(element, tail) : null;
    }

    const argumentParts = canonicalMemberParts(
      argument.type === "Identifier"
        ? { root: argument.name, path: [] }
        : memberReferenceParts(argument, evaluate),
      aliases,
    );
    if (argumentParts && path.every((part) => part !== null)) {
      const key = memberAliasKey(argumentParts.root, [
        ...argumentParts.path,
        ...path,
      ]);
      return aliases.memberAssignments.has(key)
        ? aliases.memberSecretAt(
            key,
            argument.start ?? Number.POSITIVE_INFINITY,
          )
        : (aliases.get(key) ?? null);
    }
    return null;
  }

  function argumentPathState(argument, path) {
    if (
      !argument ||
      (argument.type === "Identifier" && argument.name === "undefined") ||
      (argument.type === "UnaryExpression" && argument.operator === "void")
    ) {
      return "missing";
    }
    if (path.length === 0) return "present";
    const [head, ...tail] = path;
    if (argument.type === "ObjectExpression" && head !== null) {
      const property = argument.properties.find(
        (candidate) =>
          candidate.type === "Property" &&
          propertyName(candidate.key, candidate.computed, evaluate) === head,
      );
      return property ? argumentPathState(property.value, tail) : "missing";
    }
    if (argument.type === "ArrayExpression" && /^\d+$/.test(String(head))) {
      const element = argument.elements[Number(head)];
      return element ? argumentPathState(element, tail) : "missing";
    }
    return "unknown";
  }

  function defaultSecretForPath(parameter, path, defaults, defaultKey) {
    for (let length = path.length; length >= 0; length -= 1) {
      const prefix = path.slice(0, length);
      const expression = defaults.get(defaultKey(parameter, prefix));
      if (!expression) continue;
      const remaining = path.slice(length);
      const secret =
        remaining.length === 0
          ? expressionSecretReference(
              expression,
              secretNames,
              aliases,
              evaluate,
            )
          : secretFromArgumentPath(expression, remaining);
      if (secret) return secret;
    }
    return null;
  }

  function boundExpressionSecret(
    expression,
    parameterPaths,
    parameterBindings,
    defaults,
    defaultKey,
    call,
  ) {
    if (!expression) return null;
    const parameterPath = parameterPathForExpression(
      expression,
      parameterPaths,
    );
    if (parameterPath) {
      const binding = parameterBindings.get(parameterPath.parameter);
      if (!binding) return null;
      let argument;
      let effectivePath = parameterPath.path;
      if (binding.rest) {
        if (/^\d+$/.test(String(effectivePath[0]))) {
          argument = call.arguments[binding.index + Number(effectivePath[0])];
          effectivePath = effectivePath.slice(1);
        } else if (effectivePath.length === 0) {
          for (const restArgument of call.arguments.slice(binding.index)) {
            const secret = secretFromArgumentPath(restArgument, []);
            if (secret) return secret;
          }
          argument = null;
        }
      } else {
        argument = call.arguments[binding.index];
      }
      const argumentSecret = secretFromArgumentPath(argument, effectivePath);
      let secret = argumentSecret;
      if (!secret && argumentPathState(argument, effectivePath) !== "present") {
        secret = defaultSecretForPath(
          parameterPath.parameter,
          parameterPath.path,
          defaults,
          defaultKey,
        );
      }
      const memberKey = defaultKey(parameterPath.parameter, parameterPath.path);
      let hardcodedReaching = false;
      for (const event of parameterPaths.memberAssignments?.get(memberKey) ??
        []) {
        if (event.position >= (expression.start ?? Number.POSITIVE_INFINITY)) {
          break;
        }
        if (event.execution === "never") continue;
        const eventSecret = expressionSecretReference(
          event.expression,
          secretNames,
          aliases,
          evaluate,
        );
        const eventHardcoded = containsHardcodedValue(
          event.expression,
          evaluate,
        );
        const eventApproved = isApprovedDynamicSecretValue(
          event.expression,
          secretNames,
          aliases,
          evaluate,
        );
        if (event.execution === "always") {
          secret = eventSecret;
          hardcodedReaching = eventHardcoded || !eventApproved;
        } else {
          if (!secret && eventSecret) secret = eventSecret;
          if (eventHardcoded || !eventApproved) hardcodedReaching = true;
        }
      }
      if (hardcodedReaching && call) hardcodedProvenanceCalls.add(call);
      if (secret && hardcodedReaching) return null;
      return secret;
    }

    const direct = expressionSecretReference(
      expression,
      secretNames,
      aliases,
      evaluate,
    );
    if (direct) return direct;
    if (
      expression.type === "ChainExpression" ||
      expression.type === "AwaitExpression"
    ) {
      return boundExpressionSecret(
        expression.expression ?? expression.argument,
        parameterPaths,
        parameterBindings,
        defaults,
        defaultKey,
        call,
      );
    }
    if (
      expression.type === "LogicalExpression" ||
      expression.type === "BinaryExpression"
    ) {
      return (
        boundExpressionSecret(
          expression.left,
          parameterPaths,
          parameterBindings,
          defaults,
          defaultKey,
          call,
        ) ??
        boundExpressionSecret(
          expression.right,
          parameterPaths,
          parameterBindings,
          defaults,
          defaultKey,
          call,
        )
      );
    }
    if (expression.type === "ConditionalExpression") {
      return (
        boundExpressionSecret(
          expression.consequent,
          parameterPaths,
          parameterBindings,
          defaults,
          defaultKey,
          call,
        ) ??
        boundExpressionSecret(
          expression.alternate,
          parameterPaths,
          parameterBindings,
          defaults,
          defaultKey,
          call,
        )
      );
    }
    if (expression.type === "SequenceExpression") {
      return boundExpressionSecret(
        expression.expressions.at(-1),
        parameterPaths,
        parameterBindings,
        defaults,
        defaultKey,
        call,
      );
    }
    if (expression.type === "CallExpression") {
      if (
        expression.callee.type === "Identifier" &&
        expression.callee.name === "String" &&
        expression.arguments.length > 0
      ) {
        return boundExpressionSecret(
          expression.arguments[0],
          parameterPaths,
          parameterBindings,
          defaults,
          defaultKey,
          call,
        );
      }
      if (expression.callee.type === "MemberExpression") {
        const method = propertyName(
          expression.callee.property,
          expression.callee.computed,
          evaluate,
        );
        if (
          [
            "trim",
            "trimStart",
            "trimEnd",
            "slice",
            "substring",
            "substr",
            "toString",
          ].includes(method)
        ) {
          return boundExpressionSecret(
            expression.callee.object,
            parameterPaths,
            parameterBindings,
            defaults,
            defaultKey,
            call,
          );
        }
      }
    }
    return null;
  }

  function callSecret(call) {
    const callable = callableForCall(call);
    if (!callable) return null;
    const { defaultKey, defaults, parameterBindings, paths } =
      functionParameterPaths(callable);
    for (const expression of returnedExpressions(callable)) {
      const secret = boundExpressionSecret(
        expression,
        paths,
        parameterBindings,
        defaults,
        defaultKey,
        call,
      );
      if (secret) return secret;
    }
    return null;
  }

  for (let pass = 0; pass <= calls.length; pass += 1) {
    let changed = false;
    for (const call of calls) {
      if (aliases.has(callAliasKey(call))) continue;
      if (rememberAlias(callAliasKey(call), callSecret(call))) changed = true;
    }
    drainQueue();
    if (!changed) break;
  }

  return aliases;
}

function isSuspiciousString(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    !PLACEHOLDER.test(trimmed) &&
    !ENV_PLACEHOLDER.test(trimmed)
  );
}

// Collects the array literals that are consumed as key/value bindings, so the
// entry-pair rule can require a construct rather than judge a value's shape.
//
// A bare `const TABLE = [["JWT_SECRET", "..."]]` is a lookup table and binds
// nothing; the same literal handed to new Map, new Set or Object.fromEntries, or
// yielded or returned for one of them to consume, does bind. Restricting the
// rule to the latter is what removed four false refusals whose values were a
// legacy variable name, a source path, a docs URL and an error code.
const ENTRY_PAIR_CONSUMER_CONSTRUCTORS = new Set([
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
]);

// Names bound by a pattern, so a loop body can be checked for writing one of them.
function patternBoundNames(pattern) {
  const names = [];
  for (const node of allNodes(pattern ?? {})) {
    if (node.type === "Identifier") names.push(node.name);
  }
  return names;
}

function collectConsumedEntryArrays(nodes, evaluate) {
  const consumed = new WeakSet();
  const markPairElements = (argument) => {
    if (argument?.type !== "ArrayExpression") return;
    for (const element of argument.elements) {
      if (element?.type === "ArrayExpression") consumed.add(element);
    }
  };
  for (const node of nodes) {
    if (
      node.type === "NewExpression" &&
      node.callee.type === "Identifier" &&
      ENTRY_PAIR_CONSUMER_CONSTRUCTORS.has(node.callee.name)
    ) {
      markPairElements(node.arguments[0]);
      continue;
    }
    if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      !node.callee.computed &&
      node.callee.object.type === "Identifier" &&
      node.callee.object.name === "Object" &&
      propertyName(node.callee.property, false, evaluate) === "fromEntries"
    ) {
      markPairElements(node.arguments[0]);
      continue;
    }
    // A pair produced for a consumer to read, rather than held in a table.
    if (
      (node.type === "YieldExpression" || node.type === "ReturnStatement") &&
      node.argument?.type === "ArrayExpression"
    ) {
      consumed.add(node.argument);
      continue;
    }
    // for (const [k, v] of [["JWT_SECRET", "..."]]) { target[k] = v; }
    //
    // Destructuring a pair literal in a loop binds it, but only when the body
    // writes one of the bound names somewhere does the value actually travel. A
    // body that merely passes the pair to a validator or a formatter does not,
    // which is what separates this from the length, description and remediation
    // tables that are iterated for exactly that purpose.
    if (
      node.type === "ForOfStatement" &&
      node.right?.type === "ArrayExpression"
    ) {
      const pattern =
        node.left?.type === "VariableDeclaration"
          ? node.left.declarations[0]?.id
          : node.left;
      if (pattern?.type !== "ArrayPattern") continue;
      const bound = new Set(patternBoundNames(pattern));
      if (bound.size === 0) continue;
      const writesBoundName = allNodes(node.body ?? {}).some(
        (candidate) =>
          candidate.type === "AssignmentExpression" &&
          candidate.right?.type === "Identifier" &&
          bound.has(candidate.right.name),
      );
      if (writesBoundName) markPairElements(node.right);
    }
  }
  return consumed;
}

function containsHardcodedValue(node, evaluate) {
  if (!node) return false;
  const staticValue = evaluate(node);
  if (typeof staticValue === "string") return isSuspiciousString(staticValue);
  if (Buffer.isBuffer(staticValue)) {
    return isSuspiciousString(staticValue.toString("utf8"));
  }
  if (
    typeof staticValue === "number" ||
    typeof staticValue === "bigint" ||
    typeof staticValue === "boolean"
  ) {
    return true;
  }
  if (node.type === "TemplateLiteral") {
    const staticText = node.quasis
      .map((part) => part.value.cooked ?? part.value.raw)
      .join("");
    return isSuspiciousString(staticText);
  }
  if (node.type === "ChainExpression" || node.type === "AwaitExpression") {
    return containsHardcodedValue(node.expression ?? node.argument, evaluate);
  }
  if (node.type === "AssignmentPattern") {
    return containsHardcodedValue(node.right, evaluate);
  }
  if (node.type === "LogicalExpression" || node.type === "BinaryExpression") {
    return (
      containsHardcodedValue(node.left, evaluate) ||
      containsHardcodedValue(node.right, evaluate)
    );
  }
  if (node.type === "ConditionalExpression") {
    return (
      containsHardcodedValue(node.consequent, evaluate) ||
      containsHardcodedValue(node.alternate, evaluate)
    );
  }
  if (node.type === "SequenceExpression") {
    return containsHardcodedValue(node.expressions.at(-1), evaluate);
  }
  if (node.type === "TaggedTemplateExpression") {
    return containsHardcodedValue(node.quasi, evaluate);
  }
  if (node.type === "ObjectExpression") {
    return node.properties.some(
      (property) =>
        property.type === "Property" &&
        containsHardcodedValue(property.value, evaluate),
    );
  }
  if (node.type === "ArrayExpression") {
    return node.elements.some((element) =>
      containsHardcodedValue(element, evaluate),
    );
  }
  if (
    node.type === "CallExpression" &&
    ["ArrowFunctionExpression", "FunctionExpression"].includes(node.callee.type)
  ) {
    return returnedExpressions(node.callee).some((expression) =>
      containsHardcodedValue(expression, evaluate),
    );
  }
  if (
    node.type === "CallExpression" &&
    node.callee.type === "Identifier" &&
    node.callee.name === "String"
  ) {
    return node.arguments.some((argument) =>
      containsHardcodedValue(argument, evaluate),
    );
  }
  return false;
}

function isProcessObject(node, evaluate, aliases = null) {
  if (!node) return false;
  if (node.type === "ChainExpression" || node.type === "AwaitExpression") {
    return isProcessObject(node.expression ?? node.argument, evaluate, aliases);
  }
  if (node.type === "Identifier") {
    return node.name === "process" || aliases?.processObjects?.has(node.name);
  }
  return (
    node.type === "MemberExpression" &&
    propertyName(node.property, node.computed, evaluate) === "process" &&
    node.object.type === "Identifier" &&
    (["globalThis", "global"].includes(node.object.name) ||
      aliases?.globalObjects?.has(node.object.name))
  );
}

function isProcessEnvironmentObject(node, evaluate, aliases = null) {
  if (!node) return false;
  if (node.type === "ChainExpression" || node.type === "AwaitExpression") {
    return isProcessEnvironmentObject(
      node.expression ?? node.argument,
      evaluate,
      aliases,
    );
  }
  if (node.type === "Identifier") {
    return aliases?.environmentObjects?.has(node.name) ?? false;
  }
  return (
    node.type === "MemberExpression" &&
    isProcessObject(node.object, evaluate, aliases) &&
    propertyName(node.property, node.computed, evaluate) === "env"
  );
}

function isProcessEnvironmentProperty(node, evaluate, aliases = null) {
  if (!node) return false;
  if (node.type === "ChainExpression" || node.type === "AwaitExpression") {
    return isProcessEnvironmentProperty(
      node.expression ?? node.argument,
      evaluate,
      aliases,
    );
  }
  return (
    node.type === "MemberExpression" &&
    isProcessEnvironmentObject(node.object, evaluate, aliases)
  );
}

function packageManifestEnvironmentName(node, evaluate, aliases = null) {
  let name = null;
  if (isProcessEnvironmentProperty(node, evaluate, aliases)) {
    name = propertyName(node.property, node.computed, evaluate);
  } else if (
    node?.type === "CallExpression" &&
    node.callee.type === "MemberExpression" &&
    node.callee.object.type === "Identifier" &&
    node.callee.object.name === "Reflect" &&
    propertyName(node.callee.property, node.callee.computed, evaluate) ===
      "get" &&
    node.arguments.length >= 2 &&
    isProcessEnvironmentObject(node.arguments[0], evaluate, aliases)
  ) {
    const value = evaluate(node.arguments[1]);
    if (typeof value === "string" || typeof value === "number") {
      name = String(value);
    }
  }
  return typeof name === "string" &&
    name.toLowerCase().startsWith("npm_package_")
    ? name
    : null;
}

function isProcessEnvironmentReference(node, evaluate, aliases = null) {
  return (
    isProcessEnvironmentObject(node, evaluate, aliases) ||
    isProcessEnvironmentProperty(node, evaluate, aliases)
  );
}

function isApprovedDynamicSecretValue(node, secretNames, aliases, evaluate) {
  if (!node) return true;
  if (node.type === "ChainExpression" || node.type === "AwaitExpression") {
    return isApprovedDynamicSecretValue(
      node.expression ?? node.argument,
      secretNames,
      aliases,
      evaluate,
    );
  }
  if (node.type === "Identifier" && node.name === "undefined") return true;
  if (node.type === "Literal" && node.value === null) return true;
  if (node.type === "AssignmentPattern") {
    return isApprovedDynamicSecretValue(
      node.right,
      secretNames,
      aliases,
      evaluate,
    );
  }
  if (["ArrowFunctionExpression", "FunctionExpression"].includes(node.type)) {
    const returned = returnedExpressions(node);
    return (
      returned.length > 0 &&
      returned.every((expression) =>
        isApprovedDynamicSecretValue(
          expression,
          secretNames,
          aliases,
          evaluate,
        ),
      )
    );
  }
  const staticValue = evaluate(node);
  if (
    (typeof staticValue === "string" && !isSuspiciousString(staticValue)) ||
    (Buffer.isBuffer(staticValue) &&
      !isSuspiciousString(staticValue.toString("utf8")))
  ) {
    return true;
  }
  if (packageManifestEnvironmentName(node, evaluate, aliases)) return false;
  if (
    expressionSecretReference(node, secretNames, aliases, evaluate) ||
    isProcessEnvironmentReference(node, evaluate, aliases)
  ) {
    return !hasHardcodedProvenance(node, aliases, evaluate);
  }
  if (node.type === "TemplateLiteral") {
    const staticText = node.quasis
      .map((part) => part.value.cooked ?? part.value.raw)
      .join("");
    return (
      !isSuspiciousString(staticText) &&
      node.expressions.length > 0 &&
      node.expressions.every((expression) =>
        isApprovedDynamicSecretValue(
          expression,
          secretNames,
          aliases,
          evaluate,
        ),
      )
    );
  }
  if (node.type === "SequenceExpression") {
    return isApprovedDynamicSecretValue(
      node.expressions.at(-1),
      secretNames,
      aliases,
      evaluate,
    );
  }
  if (node.type === "LogicalExpression") {
    return [node.left, node.right].every((branch) =>
      isApprovedDynamicSecretValue(branch, secretNames, aliases, evaluate),
    );
  }
  if (node.type === "ConditionalExpression") {
    return [node.consequent, node.alternate].every((branch) =>
      isApprovedDynamicSecretValue(branch, secretNames, aliases, evaluate),
    );
  }
  if (
    node.type === "CallExpression" &&
    ["ArrowFunctionExpression", "FunctionExpression"].includes(node.callee.type)
  ) {
    const returned = returnedExpressions(node.callee);
    return (
      returned.length > 0 &&
      returned.every((expression) =>
        isApprovedDynamicSecretValue(
          expression,
          secretNames,
          aliases,
          evaluate,
        ),
      )
    );
  }
  if (node.type !== "CallExpression") return false;

  if (
    node.callee.type === "Identifier" &&
    node.callee.name === "String" &&
    node.arguments.length === 1
  ) {
    return isApprovedDynamicSecretValue(
      node.arguments[0],
      secretNames,
      aliases,
      evaluate,
    );
  }
  if (node.callee.type !== "MemberExpression") return false;

  const method = propertyName(
    node.callee.property,
    node.callee.computed,
    evaluate,
  );
  if (
    [
      "trim",
      "trimStart",
      "trimEnd",
      "slice",
      "substring",
      "substr",
      "toString",
    ].includes(method) &&
    isApprovedDynamicSecretValue(
      node.callee.object,
      secretNames,
      aliases,
      evaluate,
    )
  ) {
    return node.arguments.every((argument) => {
      const value = evaluate(argument);
      return typeof value === "number" || value === UNKNOWN;
    });
  }

  return false;
}

function derivedMemberSecretBeforeWrite(node, aliases, evaluate) {
  if (
    node.type !== "AssignmentExpression" ||
    node.left.type !== "MemberExpression" ||
    typeof aliases.memberSecretBefore !== "function"
  ) {
    return null;
  }
  const memberKey = memberReferenceKey(node.left, evaluate, aliases);
  return memberKey ? aliases.memberSecretBefore(memberKey, node.start) : null;
}

function descriptorValueFromArgument(argument, evaluate) {
  if (argument?.type !== "ObjectExpression") return null;
  for (const property of argument.properties) {
    if (property.type !== "Property") continue;
    if (propertyName(property.key, property.computed, evaluate) === "value") {
      return property.value;
    }
  }
  return null;
}

const BUILTIN_NAMESPACES = new Set(["Reflect", "Object"]);

function isGlobalObjectExpression(node, evaluate, aliases, depth = 0) {
  if (!node || depth > 8) return false;
  if (node.type === "Identifier") {
    return (
      ["globalThis", "global"].includes(node.name) ||
      Boolean(aliases?.globalObjects?.has(node.name))
    );
  }
  if (node.type !== "MemberExpression") return false;
  const property = propertyName(node.property, node.computed, evaluate);
  if (!["globalThis", "global"].includes(property)) return false;
  return isGlobalObjectExpression(node.object, evaluate, aliases, depth + 1);
}

function builtinNamespaceName(node, evaluate, aliases, depth = 0) {
  if (!node || depth > 8) return null;
  if (node.type === "Identifier") {
    if (BUILTIN_NAMESPACES.has(node.name)) return node.name;
    return aliases?.builtinNamespaces?.get(node.name) ?? null;
  }
  if (node.type !== "MemberExpression") return null;
  const property = propertyName(node.property, node.computed, evaluate);
  if (!property) return null;
  if (BUILTIN_NAMESPACES.has(property)) {
    if (isGlobalObjectExpression(node.object, evaluate, aliases)) {
      return property;
    }
  }
  const memberKey = memberReferenceKey(node, evaluate, aliases);
  const events = memberKey
    ? (aliases?.memberAssignments?.get(memberKey) ?? [])
    : [];
  for (const event of events) {
    const resolved = builtinNamespaceName(
      event.expression,
      evaluate,
      aliases,
      depth + 1,
    );
    if (resolved) return resolved;
  }
  return null;
}

function builtinMemberReference(node, evaluate, aliases) {
  if (!node) return null;
  if (node.type === "Identifier") {
    const bound = aliases?.builtinMembers?.get(node.name);
    return bound ? { owner: bound.owner, method: bound.method } : null;
  }
  if (node.type !== "MemberExpression") return null;
  const owner = builtinNamespaceName(node.object, evaluate, aliases);
  if (!owner) return null;
  const method = propertyName(node.property, node.computed, evaluate);
  return method ? { owner, method } : null;
}

function resolveBuiltinCall(node, evaluate, aliases, depth = 0) {
  if (node?.type !== "CallExpression" || depth > 4) return null;

  const direct = builtinMemberReference(node.callee, evaluate, aliases);
  if (direct && !["call", "apply"].includes(direct.method)) {
    return { owner: direct.owner, method: direct.method, args: node.arguments };
  }

  if (node.callee.type === "MemberExpression") {
    const invoker = propertyName(
      node.callee.property,
      node.callee.computed,
      evaluate,
    );
    if (["call", "apply"].includes(invoker)) {
      const target = builtinMemberReference(
        node.callee.object,
        evaluate,
        aliases,
      );
      if (target) {
        const forwarded = node.arguments.slice(1);
        const args =
          invoker === "apply" && forwarded[0]?.type === "ArrayExpression"
            ? forwarded[0].elements
            : forwarded;
        return { owner: target.owner, method: target.method, args };
      }
    }
  }

  if (direct && direct.owner === "Reflect" && direct.method === "apply") {
    const target = builtinMemberReference(node.arguments[0], evaluate, aliases);
    if (target) {
      const list = node.arguments[2];
      const args =
        list?.type === "ArrayExpression"
          ? list.elements
          : node.arguments.slice(2);
      return { owner: target.owner, method: target.method, args };
    }
  }

  return direct
    ? { owner: direct.owner, method: direct.method, args: node.arguments }
    : null;
}

function staticSecretEntryFromValue(value, secretNames) {
  const entries =
    value !== UNKNOWN &&
    value !== null &&
    typeof value === "object" &&
    value.kind === "array"
      ? value.values
      : null;
  if (!entries) return null;
  for (const entry of entries) {
    const pair =
      entry !== null && typeof entry === "object" && entry.kind === "array"
        ? entry.values
        : null;
    if (!pair || pair.length < 2) continue;
    const [key, entryValue] = pair;
    if (typeof key !== "string" || !secretNames.has(key)) continue;
    const text = Buffer.isBuffer(entryValue)
      ? entryValue.toString("utf8")
      : entryValue;
    if (typeof text === "string" && isSuspiciousString(text)) {
      return { name: key };
    }
  }
  return null;
}

function reflectiveSecretWrite(node, secretNames, evaluate, aliases) {
  const resolved = resolveBuiltinCall(node, evaluate, aliases);
  if (!resolved) return null;
  const owner = resolved.owner;
  const method = resolved.method;
  const callArguments = resolved.args ?? node.arguments;

  if (
    (owner === "Reflect" && method === "set") ||
    (["Reflect", "Object"].includes(owner) && method === "defineProperty")
  ) {
    const key = evaluate(callArguments[1]);
    if (typeof key !== "string" || !secretNames.has(key)) return null;
    const value =
      method === "set"
        ? callArguments[2]
        : descriptorValueFromArgument(callArguments[2], evaluate);
    return value ? { name: key, value } : null;
  }

  if (owner === "Object" && method === "fromEntries") {
    if (callArguments[0]?.type === "ArrayExpression") {
      for (const entry of callArguments[0].elements) {
        if (entry?.type !== "ArrayExpression" || entry.elements.length < 2) {
          continue;
        }
        const key = evaluate(entry.elements[0]);
        if (typeof key === "string" && secretNames.has(key)) {
          return { name: key, value: entry.elements[1] };
        }
      }
      return null;
    }
    const staticEntry = staticSecretEntryFromValue(
      evaluate(callArguments[0]),
      secretNames,
    );
    if (staticEntry) return { name: staticEntry.name, value: null };
  }
  return null;
}

function hasHardcodedProvenance(node, aliases, evaluate) {
  if (!node || typeof aliases?.memberHardcodedAt !== "function") return false;
  for (const candidate of allNodes(node)) {
    if (candidate.type === "CallExpression") {
      if (aliases.hardcodedProvenanceCalls?.has(candidate)) return true;
      continue;
    }
    if (candidate.type === "MemberExpression") {
      const memberKey = memberReferenceKey(candidate, evaluate, aliases);
      if (memberKey && aliases.memberHardcodedAt(memberKey, candidate.start)) {
        return true;
      }
      if (
        memberKey &&
        aliases.opaqueContainers?.has(containerRootKey(memberKey))
      ) {
        return true;
      }
      continue;
    }
    if (candidate.type !== "Identifier") continue;
    const source = aliases.memberSources?.get(candidate.name);
    if (!source) continue;
    const canonical = canonicalMemberParts(source, aliases);
    if (!canonical) continue;
    const sourceKey = memberAliasKey(canonical.root, canonical.path);
    if (aliases.memberHardcodedAt(sourceKey, candidate.start)) return true;
  }
  return false;
}

function isRejectedSecretValue(node, secretNames, aliases, evaluate) {
  return (
    containsHardcodedValue(node, evaluate) ||
    !isApprovedDynamicSecretValue(node, secretNames, aliases, evaluate)
  );
}

function providerFindingForValue(value) {
  const text = Buffer.isBuffer(value)
    ? value.toString("utf8")
    : typeof value === "string"
      ? value
      : null;
  if (text === null) return null;
  for (const [name, pattern] of PROVIDER_SECRET_PATTERNS) {
    const match = text.match(pattern)?.[0];
    if (!match) continue;
    const credentialBody = match.replace(/^[A-Za-z_-]+/, "");
    if (
      // Kept in step with $providerPlaceholderRegex in make-deploy-archive.ps1.
      // The two layers scan the same bytes, so disagreeing on what counts as a
      // placeholder means one refuses what the other accepts.
      /(?:REPLACE_ME|YOUR_|CHANGEME|EXAMPLE|PLACEHOLDER|<[A-Za-z0-9_. -]{1,40}>)/i.test(
        match,
      ) ||
      /^([0xXaA])\1{11,}$/.test(credentialBody)
    ) {
      continue;
    }
    return { name, kind: "static provider credential" };
  }
  return null;
}

function providerFinding(node, evaluate) {
  return providerFindingForValue(evaluate(node));
}

function constructedProviderFinding(root, evaluate) {
  const functionTypes = new Set([
    "ArrowFunctionExpression",
    "FunctionExpression",
    "FunctionDeclaration",
  ]);
  const all = allNodes(root);
  const scopes = [
    root,
    ...all.filter(
      (node) => functionTypes.has(node.type) || node.type === "StaticBlock",
    ),
  ];

  function operationsForScope(scope) {
    const scopeRoot = functionTypes.has(scope.type) ? scope.body : scope;
    const operations = [];
    const stack = [scopeRoot];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) continue;
      if (
        node !== scopeRoot &&
        (functionTypes.has(node.type) ||
          node.type === "ClassDeclaration" ||
          node.type === "ClassExpression" ||
          node.type === "StaticBlock")
      ) {
        continue;
      }
      if (
        node.type === "VariableDeclarator" ||
        node.type === "AssignmentExpression" ||
        node.type === "CallExpression"
      ) {
        operations.push(node);
      }
      stack.push(...childNodes(node));
    }
    return operations.sort((left, right) => left.start - right.start);
  }

  for (const scope of scopes) {
    const state = new Map();

    function valueOf(node) {
      if (!node) return UNKNOWN;
      if (node.type === "ChainExpression" || node.type === "AwaitExpression") {
        return valueOf(node.expression ?? node.argument);
      }
      if (node.type === "Identifier") {
        return state.has(node.name) ? state.get(node.name) : evaluate(node);
      }
      if (node.type === "Literal") return evaluate(node);
      if (node.type === "TemplateLiteral") {
        const values = [];
        for (let index = 0; index < node.quasis.length; index += 1) {
          values.push(
            node.quasis[index].value.cooked ?? node.quasis[index].value.raw,
          );
          if (index < node.expressions.length) {
            const expression = valueOf(node.expressions[index]);
            if (expression === UNKNOWN || Buffer.isBuffer(expression)) {
              return UNKNOWN;
            }
            values.push(String(expression));
          }
        }
        return values.join("");
      }
      if (node.type === "BinaryExpression" && node.operator === "+") {
        const left = valueOf(node.left);
        const right = valueOf(node.right);
        return left !== UNKNOWN && right !== UNKNOWN ? left + right : UNKNOWN;
      }
      if (node.type === "ArrayExpression") {
        const values = [];
        for (const element of node.elements) {
          if (!element) {
            values.push(undefined);
            continue;
          }
          if (element.type === "SpreadElement") {
            const spread = valueOf(element.argument);
            if (spread?.kind !== "array") return UNKNOWN;
            values.push(...spread.values);
            continue;
          }
          const value = valueOf(element);
          if (value === UNKNOWN) return UNKNOWN;
          values.push(value);
        }
        return { kind: "array", values };
      }
      if (node.type === "ObjectExpression") {
        const values = new Map();
        for (const property of node.properties) {
          if (property.type !== "Property" || property.kind !== "init") {
            return UNKNOWN;
          }
          const key = propertyName(property.key, property.computed, valueOf);
          const value = valueOf(property.value);
          if (key === null || value === UNKNOWN) return UNKNOWN;
          values.set(key, value);
        }
        return { kind: "object", values };
      }
      if (node.type === "MemberExpression") {
        const object = valueOf(node.object);
        const key = propertyName(node.property, node.computed, valueOf);
        if (key === null) return UNKNOWN;
        if (object?.kind === "object") {
          return object.values.get(key) ?? UNKNOWN;
        }
        if (object?.kind === "array" && /^\d+$/.test(key)) {
          return object.values[Number(key)] ?? UNKNOWN;
        }
        return UNKNOWN;
      }
      if (node.type === "CallExpression") {
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "String" &&
          node.arguments.length > 0
        ) {
          const value = valueOf(node.arguments[0]);
          return value === UNKNOWN || Buffer.isBuffer(value)
            ? UNKNOWN
            : String(value);
        }
        if (node.callee.type === "MemberExpression") {
          const object = valueOf(node.callee.object);
          const method = propertyName(
            node.callee.property,
            node.callee.computed,
            valueOf,
          );
          if (method === "join" && object?.kind === "array") {
            const separator =
              node.arguments.length > 0 ? valueOf(node.arguments[0]) : ",";
            if (
              typeof separator === "string" &&
              object.values.every(
                (value) => value !== UNKNOWN && !Buffer.isBuffer(value),
              )
            ) {
              return object.values.join(separator);
            }
          }
          if (method === "concat" && typeof object === "string") {
            const values = node.arguments.map(valueOf);
            if (values.every((value) => typeof value === "string")) {
              return object.concat(...values);
            }
          }
        }
      }
      return evaluate(node);
    }

    function mutableTarget(node) {
      if (node?.type !== "MemberExpression") return null;
      const object = valueOf(node.object);
      const key = propertyName(node.property, node.computed, valueOf);
      if (key === null) return null;
      if (object?.kind === "object") return { object, key };
      if (object?.kind === "array" && /^\d+$/.test(key)) {
        return { object, key: Number(key) };
      }
      return null;
    }

    function assignedValue(node, operator, right) {
      const incoming = valueOf(right);
      if (operator === "=") return incoming;
      if (operator !== "+=" || incoming === UNKNOWN) return UNKNOWN;
      const current = valueOf(node);
      return current === UNKNOWN || Buffer.isBuffer(current)
        ? UNKNOWN
        : current + incoming;
    }

    for (const operation of operationsForScope(scope)) {
      let candidate = UNKNOWN;
      if (
        operation.type === "VariableDeclarator" &&
        operation.id.type === "Identifier"
      ) {
        candidate = valueOf(operation.init);
        if (candidate === UNKNOWN) state.delete(operation.id.name);
        else state.set(operation.id.name, candidate);
      } else if (
        operation.type === "AssignmentExpression" &&
        operation.left.type === "Identifier"
      ) {
        candidate = assignedValue(
          operation.left,
          operation.operator,
          operation.right,
        );
        if (candidate === UNKNOWN) state.delete(operation.left.name);
        else state.set(operation.left.name, candidate);
      } else if (
        operation.type === "AssignmentExpression" &&
        operation.left.type === "MemberExpression"
      ) {
        const target = mutableTarget(operation.left);
        if (target) {
          candidate = assignedValue(
            operation.left,
            operation.operator,
            operation.right,
          );
          if (candidate !== UNKNOWN) {
            if (target.object.kind === "object") {
              target.object.values.set(target.key, candidate);
            } else {
              target.object.values[target.key] = candidate;
            }
          }
        }
      } else if (
        operation.type === "CallExpression" &&
        operation.callee.type === "MemberExpression"
      ) {
        const object = valueOf(operation.callee.object);
        const method = propertyName(
          operation.callee.property,
          operation.callee.computed,
          valueOf,
        );
        const values = [];
        for (const argument of operation.arguments) {
          if (argument.type !== "SpreadElement") {
            values.push(valueOf(argument));
            continue;
          }
          const spreadValue = valueOf(argument.argument);
          if (spreadValue?.kind === "array") {
            values.push(...spreadValue.values);
          } else {
            values.push(UNKNOWN);
          }
        }
        if (
          object?.kind === "array" &&
          ["push", "unshift"].includes(method) &&
          values.every((value) => value !== UNKNOWN)
        ) {
          object.values[method](...values);
        }
        candidate = valueOf(operation);
      }

      const finding = providerFindingForValue(candidate);
      if (finding) return { ...finding, node: operation };
    }
  }
  return null;
}

function resolveEnvironmentSecretTarget(node, secretNames, evaluate) {
  const value = evaluate(node);
  if (typeof value === "string" || typeof value === "number") {
    const name = String(value);
    return { name: secretNames.has(name) ? name : null, unknown: false };
  }
  return { name: null, unknown: true };
}

function descriptorValueExpression(node, evaluate) {
  if (node?.type !== "ObjectExpression") return node;
  for (const property of node.properties) {
    if (
      property.type === "Property" &&
      propertyName(property.key, property.computed, evaluate) === "value"
    ) {
      return property.value;
    }
  }
  return node;
}

function environmentMutationFinding(node, secretNames, aliases, evaluate) {
  if (
    node.type !== "CallExpression" ||
    node.callee.type !== "MemberExpression"
  ) {
    return null;
  }
  const method = propertyName(
    node.callee.property,
    node.callee.computed,
    evaluate,
  );
  const owner =
    node.callee.object.type === "Identifier" ? node.callee.object.name : null;

  let keyNode;
  let valueNode;
  if (
    owner === "Reflect" &&
    method === "set" &&
    node.arguments.length >= 3 &&
    isProcessEnvironmentObject(node.arguments[0], evaluate, aliases)
  ) {
    keyNode = node.arguments[1];
    valueNode = node.arguments[2];
  } else if (
    owner === "Object" &&
    method === "defineProperty" &&
    node.arguments.length >= 3 &&
    isProcessEnvironmentObject(node.arguments[0], evaluate, aliases)
  ) {
    keyNode = node.arguments[1];
    valueNode = descriptorValueExpression(node.arguments[2], evaluate);
  } else {
    return null;
  }

  const target = resolveEnvironmentSecretTarget(keyNode, secretNames, evaluate);
  if (
    (target.name || target.unknown) &&
    isRejectedSecretValue(valueNode, secretNames, aliases, evaluate)
  ) {
    return {
      name: target.name ?? "process.env[computed]",
      kind: `${owner}.${method} environment mutation`,
    };
  }
  return null;
}

function arrayPatternFinding(pattern, value, secretNames, aliases, evaluate) {
  if (pattern.type !== "ArrayPattern") return null;
  for (let index = 0; index < pattern.elements.length; index += 1) {
    const target = pattern.elements[index];
    if (!target) continue;
    const unwrappedTarget =
      target.type === "AssignmentPattern" ? target.left : target;
    const name = directSecretReference(
      unwrappedTarget,
      secretNames,
      aliases,
      evaluate,
    );
    if (!name) continue;
    const source =
      value?.type === "ArrayExpression" ? value.elements[index] : null;
    if (
      !source ||
      isRejectedSecretValue(source, secretNames, aliases, evaluate)
    ) {
      return { name, kind: "array destructuring initializer" };
    }
  }
  return null;
}

function packageManifestEnvironmentPatternName(
  pattern,
  source,
  evaluate,
  aliases,
) {
  if (
    pattern?.type !== "ObjectPattern" ||
    !isProcessEnvironmentObject(source, evaluate, aliases)
  ) {
    return null;
  }
  for (const property of pattern.properties) {
    if (property.type !== "Property") continue;
    const name = propertyName(property.key, property.computed, evaluate);
    if (
      typeof name === "string" &&
      name.toLowerCase().startsWith("npm_package_")
    ) {
      return name;
    }
  }
  return null;
}

function findingForNode(node, secretNames, aliases, evaluate) {
  const packageEnvironmentPatternName =
    node.type === "VariableDeclarator"
      ? packageManifestEnvironmentPatternName(
          node.id,
          node.init,
          evaluate,
          aliases,
        )
      : node.type === "AssignmentExpression"
        ? packageManifestEnvironmentPatternName(
            node.left,
            node.right,
            evaluate,
            aliases,
          )
        : null;
  if (packageEnvironmentPatternName) {
    return {
      name: packageEnvironmentPatternName,
      kind: "manifest-controlled environment reference",
    };
  }

  const packageEnvironmentName = packageManifestEnvironmentName(
    node,
    evaluate,
    aliases,
  );
  if (packageEnvironmentName) {
    return {
      name: packageEnvironmentName,
      kind: "manifest-controlled environment reference",
    };
  }

  const mutationFinding = environmentMutationFinding(
    node,
    secretNames,
    aliases,
    evaluate,
  );
  if (mutationFinding) return mutationFinding;

  if (node.type === "VariableDeclarator") {
    const patternFinding = arrayPatternFinding(
      node.id,
      node.init,
      secretNames,
      aliases,
      evaluate,
    );
    if (patternFinding) return patternFinding;

    const name = directSecretReference(node.id, secretNames, aliases, evaluate);
    const explicitTarget =
      node.id.type === "Identifier" && secretNames.has(node.id.name);
    const initializerSecret = expressionSecretReference(
      node.init,
      secretNames,
      aliases,
      evaluate,
    );
    if (
      name &&
      (explicitTarget || !initializerSecret) &&
      isRejectedSecretValue(node.init, secretNames, aliases, evaluate)
    ) {
      return { name, kind: "variable initializer" };
    }
  }

  if (
    node.type === "AssignmentExpression" ||
    node.type === "AssignmentPattern"
  ) {
    const name =
      directSecretReference(node.left, secretNames, aliases, evaluate) ??
      derivedMemberSecretBeforeWrite(node, aliases, evaluate);
    if (
      !name &&
      isProcessEnvironmentProperty(node.left, evaluate, aliases) &&
      node.left.computed
    ) {
      const target = resolveEnvironmentSecretTarget(
        node.left.property,
        secretNames,
        evaluate,
      );
      if (
        (target.name || target.unknown) &&
        isRejectedSecretValue(node.right, secretNames, aliases, evaluate)
      ) {
        return {
          name: target.name ?? "process.env[computed]",
          kind: "computed environment assignment",
        };
      }
    }
    const explicitTarget =
      (node.left.type === "Identifier" && secretNames.has(node.left.name)) ||
      (node.left.type === "MemberExpression" &&
        ((propertyName(node.left.property, node.left.computed, evaluate) !==
          null &&
          secretNames.has(
            propertyName(node.left.property, node.left.computed, evaluate),
          )) ||
          isProcessEnvironmentProperty(node.left, evaluate, aliases)));
    const sourceSecret = expressionSecretReference(
      node.right,
      secretNames,
      aliases,
      evaluate,
    );
    const assignmentCarriesHardcodedValue = explicitTarget
      ? isRejectedSecretValue(node.right, secretNames, aliases, evaluate)
      : containsHardcodedValue(node.right, evaluate);
    if (
      name &&
      (explicitTarget || !sourceSecret) &&
      assignmentCarriesHardcodedValue
    ) {
      return { name, kind: "assignment" };
    }
  }

  if (node.type === "CallExpression") {
    const reflectiveWrite = reflectiveSecretWrite(
      node,
      secretNames,
      evaluate,
      aliases,
    );
    if (
      reflectiveWrite &&
      (reflectiveWrite.value === null ||
        isRejectedSecretValue(
          reflectiveWrite.value,
          secretNames,
          aliases,
          evaluate,
        ))
    ) {
      return { name: reflectiveWrite.name, kind: "reflective assignment" };
    }
  }

  // An entry pair is [key, value, ...]; writers that carry a third element still
  // bind the first two, so require at least two rather than exactly two.
  //
  // The pair must be *consumed* as a key/value binding, and the value is judged
  // by the same isRejectedSecretValue gate every sibling rule uses. An earlier
  // form fired on any two-element array and judged the value by its character
  // profile -- string, >= 12 characters, no whitespace. That was both looser and
  // stricter than the rest of the file: it accepted a short value, a passphrase
  // containing a space and a Buffer, so Object.fromEntries and new Map disagreed
  // about the identical credential, while refusing four benign tables whose
  // values were a legacy variable name, a source path, a docs URL and an error
  // code.
  if (
    node.type === "ArrayExpression" &&
    node.elements.length >= 2 &&
    aliases.consumedEntryArrays?.has(node)
  ) {
    const entryKey = evaluate(node.elements[0]);
    if (
      typeof entryKey === "string" &&
      secretNames.has(entryKey) &&
      // A secret's name is not its value, so a rename table pairing one declared
      // secret name with another is not a credential. This is an identity check
      // against the declared names, not a guess at which value shapes are safe.
      !secretNames.has(evaluate(node.elements[1])) &&
      isRejectedSecretValue(node.elements[1], secretNames, aliases, evaluate)
    ) {
      return { name: entryKey, kind: "secret entry pair" };
    }
  }

  // The same binding written through a setter rather than a literal pair.
  if (
    node.type === "CallExpression" &&
    node.callee.type === "MemberExpression" &&
    !node.callee.computed &&
    propertyName(node.callee.property, false, evaluate) === "set" &&
    node.arguments.length >= 2
  ) {
    const setterKey = evaluate(node.arguments[0]);
    if (
      typeof setterKey === "string" &&
      secretNames.has(setterKey) &&
      !secretNames.has(evaluate(node.arguments[1])) &&
      isRejectedSecretValue(node.arguments[1], secretNames, aliases, evaluate)
    ) {
      return { name: setterKey, kind: "secret entry pair" };
    }
  }

  if (node.type === "ExportSpecifier") {
    const exportedName =
      node.exported.type === "Identifier"
        ? node.exported.name
        : node.exported.type === "Literal"
          ? node.exported.value
          : null;
    if (
      typeof exportedName === "string" &&
      secretNames.has(exportedName) &&
      node.local.type === "Identifier" &&
      isRejectedSecretValue(node.local, secretNames, aliases, evaluate)
    ) {
      return { name: exportedName, kind: "renamed export" };
    }
  }

  // MethodDefinition belongs here alongside Property. An object literal getter and
  // an arrow thunk named for a secret were already caught by this rule, because
  // isRejectedSecretValue looks through a function to what it produces. But a class
  // body yields MethodDefinition rather than Property, so
  // `class C { get JWT_SECRET() { return "<literal>"; } }` and its static form were
  // examined by no rule at all and published.
  if (
    node.type === "Property" ||
    node.type === "PropertyDefinition" ||
    node.type === "MethodDefinition"
  ) {
    const name = propertyName(node.key, node.computed, evaluate);
    if (
      name &&
      secretNames.has(name) &&
      isRejectedSecretValue(node.value, secretNames, aliases, evaluate)
    ) {
      return { name, kind: "object or class property" };
    }
    if (
      name?.toLowerCase() === "client_secret" &&
      containsHardcodedValue(node.value, evaluate)
    ) {
      return { name: "client_secret", kind: "provider property" };
    }
  }

  if (
    node.type === "LogicalExpression" &&
    ["||", "??"].includes(node.operator)
  ) {
    const leftName = expressionSecretReference(
      node.left,
      secretNames,
      aliases,
      evaluate,
    );
    if (
      leftName &&
      isRejectedSecretValue(node.right, secretNames, aliases, evaluate)
    ) {
      return { name: leftName, kind: "fallback" };
    }
    const rightName = expressionSecretReference(
      node.right,
      secretNames,
      aliases,
      evaluate,
    );
    if (
      rightName &&
      isRejectedSecretValue(node.left, secretNames, aliases, evaluate)
    ) {
      return { name: rightName, kind: "fallback" };
    }
  }

  if (node.type === "ConditionalExpression") {
    const consequentName = expressionSecretReference(
      node.consequent,
      secretNames,
      aliases,
      evaluate,
    );
    if (
      consequentName &&
      isRejectedSecretValue(node.alternate, secretNames, aliases, evaluate)
    ) {
      return { name: consequentName, kind: "conditional fallback" };
    }
    const alternateName = expressionSecretReference(
      node.alternate,
      secretNames,
      aliases,
      evaluate,
    );
    if (
      alternateName &&
      isRejectedSecretValue(node.consequent, secretNames, aliases, evaluate)
    ) {
      return { name: alternateName, kind: "conditional fallback" };
    }
  }

  return null;
}

function scanTree(root, secretNames) {
  const nodes = allNodes(root);
  const evaluate = createStaticEvaluator(nodes);
  const aliases = collectAliases(nodes, secretNames, evaluate);
  aliases.consumedEntryArrays = collectConsumedEntryArrays(nodes, evaluate);
  const constructedProvider = constructedProviderFinding(root, evaluate);
  if (constructedProvider) return constructedProvider;
  for (const node of nodes) {
    const provider = providerFinding(node, evaluate);
    if (provider) return { ...provider, node };
    const finding = findingForNode(node, secretNames, aliases, evaluate);
    if (finding) return { ...finding, node };
  }
  return null;
}

function parseJavaScript(file, comments = []) {
  const options = {
    allowAwaitOutsideFunction: true,
    allowHashBang: true,
    ecmaVersion: "latest",
    locations: true,
    onComment: comments,
  };
  const lowerPath = file.path.toLowerCase();
  const sourceTypes = lowerPath.endsWith(".cjs")
    ? ["script"]
    : lowerPath.endsWith(".mjs")
      ? ["module"]
      : ["module", "script"];
  let finalError;

  for (const sourceType of sourceTypes) {
    // A failed attempt still reports the comments it consumed before throwing,
    // so the collector is reset per attempt to keep the surviving parse's
    // comment list from carrying duplicates out of an abandoned one.
    comments.length = 0;
    try {
      return parse(file.source, {
        ...options,
        allowReturnOutsideFunction: sourceType === "script",
        sourceType,
      });
    } catch (error) {
      finalError = error;
    }
  }

  // A block marked parseOptional is one the browser will not execute -- a
  // template, or some other non-JavaScript payload carried in a script tag. Its
  // body is offered to the scanner because it still ships in the file, but it is
  // not required to be JavaScript, so failing to parse it means there is nothing
  // to scan rather than that the archive must be refused.
  if (file.parseOptional === true) return null;

  const location = finalError?.loc
    ? `:${finalError.loc.line}:${finalError.loc.column + 1}`
    : "";
  fail(`${file.path}${location} is not valid JavaScript`);
}

// Guarded so this file can also be `import`ed for its exported bindings
// (PROVIDER_SECRET_PATTERNS -- see O2/scan-repo-secrets.mjs, which reuses the
// same table rather than keeping a second, driftable copy) without triggering
// this CLI's own side effects: reading and blocking on stdin, and exiting the
// whole process on a version/payload problem. Every existing caller
// (deploy-archive-security.mjs, deploy-archive-boundary.mjs,
// make-deploy-archive.ps1, run-gates.ps1) invokes this file as `node
// tools/scan-deploy-secrets.mjs` in a child process, where process.argv[1] is
// this file's own path -- so the guard changes nothing for any of them.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (acornVersion !== EXPECTED_ACORN_VERSION) {
    fail(
      `expected Acorn ${EXPECTED_ACORN_VERSION}, but resolved ${acornVersion ?? "unknown"}`,
    );
  }

  const payload = await readPayload();
  const secretNames = validatePayload(payload);
  if (payload.mode === "archive") validateManifests(payload.manifests);
  const findings = [];

  for (const file of payload.files) {
    const ast = parseJavaScript(file);
    if (ast === null) continue;
    const finding = scanTree(ast, secretNames);
    if (finding) {
      findings.push({
        column: finding.node.loc.start.column + 1,
        kind: finding.kind,
        line: finding.node.loc.start.line,
        name: finding.name,
        path: file.path,
      });
    }
  }

  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(
        `REFUSED: ${finding.path}:${finding.line}:${finding.column} contains a hardcoded ${finding.name} ${finding.kind}`,
      );
    }
    process.exit(2);
  }

  console.log(`JavaScript secret AST scan: PASS (${payload.files.length} files)`);
}
