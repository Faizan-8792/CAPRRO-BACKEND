import { createHash } from "node:crypto";
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
const PROVIDER_SECRET_PATTERNS = [
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
      paths.has(file.path)
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
  const match = /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:\.(0|[1-9]\d*))?$/.exec(
    value,
  );
  if (!match) fail(`${path} contains an unsupported semantic version`);
  const precision =
    match[3] === undefined ? (match[2] === undefined ? 1 : 2) : 3;
  const parts = [match[1], match[2] ?? "0", match[3] ?? "0"].map(Number);
  if (!parts.every(Number.isSafeInteger)) {
    fail(`${path} contains an unsafe semantic version component`);
  }
  return { major: parts[0], minor: parts[1], patch: parts[2], precision };
}

function compareVersions(left, right) {
  for (const field of ["major", "minor", "patch"]) {
    if (left[field] !== right[field])
      return left[field] < right[field] ? -1 : 1;
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
  const alternatives = rangeText.split(/\s*\|\|\s*/).filter(Boolean);
  if (alternatives.length === 0) {
    fail(`${path} contains an empty dependency range`);
  }
  return alternatives.some((range) =>
    satisfiesRangeAlternative(version, range.trim(), path),
  );
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
        if (edge.optional) continue;
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
    method === "from" &&
    node.callee.object.type === "Identifier" &&
    node.callee.object.name === "Buffer"
  ) {
    const value =
      node.arguments.length > 0 ? evaluate(node.arguments[0]) : UNKNOWN;
    const encoding =
      node.arguments.length > 1 ? evaluate(node.arguments[1]) : "utf8";
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

function memberAliasKey(root, path) {
  return `${MEMBER_ALIAS_PREFIX}${root}${path
    .map((part) => `[${JSON.stringify(part)}]`)
    .join("")}`;
}

function memberReferenceKey(node, evaluate) {
  const parts = memberReferenceParts(node, evaluate);
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
  const memberKey = memberReferenceKey(node, evaluate);
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
      isProcessEnvironmentProperty(node, evaluate)
    ) {
      result.direct.add(UNKNOWN_ENVIRONMENT_SECRET);
    } else {
      const memberKey = memberReferenceKey(node, evaluate);
      if (memberKey) result.dependencies.add(memberKey);
      else collectSecretInputs(node.object, secretNames, evaluate, result);
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
  aliases.processObjects = new Set();
  aliases.functionDefinitions = new Map();
  aliases.classMethods = new Map();
  aliases.instanceClasses = new Map();

  const dependents = new Map();
  const queue = [];
  const calls = [];

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
    const inputs = { direct: new Set(), dependencies: new Set() };
    collectSecretInputs(expression, secretNames, evaluate, inputs);
    const direct = inputs.direct.values().next().value;
    if (direct) rememberAlias(target, direct);
    for (const dependency of inputs.dependencies) {
      addDependency(target, dependency);
    }
  }

  function addContainerExpressions(root, path, expression) {
    if (expression?.type === "ObjectExpression") {
      for (const property of expression.properties) {
        if (property.type !== "Property" || property.kind !== "init") continue;
        const key = propertyName(property.key, property.computed, evaluate);
        if (key === null) continue;
        const memberPath = [...path, key];
        addExpression(memberAliasKey(root, memberPath), property.value);
        addContainerExpressions(root, memberPath, property.value);
      }
      return true;
    }
    if (expression?.type === "ArrayExpression") {
      expression.elements.forEach((element, index) => {
        if (!element) return;
        const memberPath = [...path, String(index)];
        addExpression(memberAliasKey(root, memberPath), element);
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
    }
    if (
      node.type === "AssignmentExpression" &&
      node.operator === "=" &&
      node.left.type === "Identifier"
    ) {
      aliasAssignments.push([node.left.name, node.right]);
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
    }
    if (node.type === "FunctionDeclaration" && node.id?.type === "Identifier") {
      aliases.functionDefinitions.set(node.id.name, node);
    }
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.init?.type === "ClassExpression"
    ) {
      for (const element of node.init.body.body) {
        if (element.type !== "MethodDefinition" || !element.value) continue;
        const method = propertyName(element.key, element.computed, evaluate);
        if (!method) continue;
        const kind = element.static ? "static" : "instance";
        aliases.classMethods.set(
          `${node.id.name}:${kind}:${method}`,
          element.value,
        );
      }
    }
    if (node.type === "ClassDeclaration" && node.id?.type === "Identifier") {
      for (const element of node.body.body) {
        if (element.type !== "MethodDefinition" || !element.value) continue;
        const method = propertyName(element.key, element.computed, evaluate);
        if (!method) continue;
        const kind = element.static ? "static" : "instance";
        aliases.classMethods.set(
          `${node.id.name}:${kind}:${method}`,
          element.value,
        );
      }
    }
    if (node.type === "CallExpression") calls.push(node);
  }

  for (
    let pass = 0;
    pass <= aliasAssignments.length + destructuredObjectAliases.length;
    pass += 1
  ) {
    let changed = false;
    for (const [target, source] of aliasAssignments) {
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
      const sourceIsProcess = isProcessObject(source, evaluate, aliases);
      const sourceIsGlobal =
        source.type === "Identifier" &&
        ["globalThis", "global"].includes(source.name);
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

  for (const node of nodes) {
    if (node.type === "FunctionDeclaration" && node.id?.type === "Identifier") {
      addExpression(node.id.name, node);
    }
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier") {
      if (!addContainerExpressions(node.id.name, [], node.init)) {
        addExpression(node.id.name, node.init);
      }
    }
    if (
      node.type === "AssignmentExpression" &&
      node.left.type === "Identifier"
    ) {
      if (!addContainerExpressions(node.left.name, [], node.right)) {
        addExpression(node.left.name, node.right);
      }
    }
    if (
      node.type === "AssignmentExpression" &&
      node.left.type === "MemberExpression"
    ) {
      const memberKey = memberReferenceKey(node.left, evaluate);
      if (memberKey) addExpression(memberKey, node.right);
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
      const sourceParts = memberReferenceParts(node.init, evaluate);
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
          addDependency(
            target,
            memberAliasKey(sourceParts.root, [...sourceParts.path, sourceName]),
          );
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
    const parameterIndexes = new Map();

    function bindParameterPattern(pattern, parameter, index, path = []) {
      if (!pattern) return;
      if (pattern.type === "AssignmentPattern") {
        bindParameterPattern(pattern.left, parameter, index, path);
        return;
      }
      if (pattern.type === "RestElement") {
        bindParameterPattern(pattern.argument, parameter, index, path);
        return;
      }
      if (pattern.type === "Identifier") {
        paths.set(pattern.name, { parameter, path });
        parameterIndexes.set(parameter, index);
        return;
      }
      if (pattern.type === "ObjectPattern") {
        for (const property of pattern.properties) {
          if (property.type !== "Property") continue;
          const key = propertyName(property.key, property.computed, evaluate);
          bindParameterPattern(property.value, parameter, index, [
            ...path,
            key,
          ]);
        }
        return;
      }
      if (pattern.type === "ArrayPattern") {
        pattern.elements.forEach((element, elementIndex) => {
          bindParameterPattern(element, parameter, index, [
            ...path,
            String(elementIndex),
          ]);
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
    return { parameterIndexes, paths };
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

    const argumentParts =
      argument.type === "Identifier"
        ? { root: argument.name, path: [] }
        : memberReferenceParts(argument, evaluate);
    if (argumentParts && path.every((part) => part !== null)) {
      return (
        aliases.get(
          memberAliasKey(argumentParts.root, [...argumentParts.path, ...path]),
        ) ?? null
      );
    }
    return null;
  }

  function boundExpressionSecret(
    expression,
    parameterPaths,
    parameterIndexes,
    call,
  ) {
    if (!expression) return null;
    const parameterPath = parameterPathForExpression(
      expression,
      parameterPaths,
    );
    if (parameterPath) {
      const index = parameterIndexes.get(parameterPath.parameter);
      return secretFromArgumentPath(call.arguments[index], parameterPath.path);
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
        parameterIndexes,
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
          parameterIndexes,
          call,
        ) ??
        boundExpressionSecret(
          expression.right,
          parameterPaths,
          parameterIndexes,
          call,
        )
      );
    }
    if (expression.type === "ConditionalExpression") {
      return (
        boundExpressionSecret(
          expression.consequent,
          parameterPaths,
          parameterIndexes,
          call,
        ) ??
        boundExpressionSecret(
          expression.alternate,
          parameterPaths,
          parameterIndexes,
          call,
        )
      );
    }
    if (expression.type === "SequenceExpression") {
      return boundExpressionSecret(
        expression.expressions.at(-1),
        parameterPaths,
        parameterIndexes,
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
          parameterIndexes,
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
            parameterIndexes,
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
    const { parameterIndexes, paths } = functionParameterPaths(callable);
    for (const expression of returnedExpressions(callable)) {
      const secret = boundExpressionSecret(
        expression,
        paths,
        parameterIndexes,
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
    ["globalThis", "global"].includes(node.object.name)
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
  const staticValue = evaluate(node);
  if (
    (typeof staticValue === "string" && !isSuspiciousString(staticValue)) ||
    (Buffer.isBuffer(staticValue) &&
      !isSuspiciousString(staticValue.toString("utf8")))
  ) {
    return true;
  }
  if (
    expressionSecretReference(node, secretNames, aliases, evaluate) ||
    isProcessEnvironmentReference(node, evaluate, aliases)
  ) {
    return true;
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
      /(?:REPLACE_ME|YOUR_|CHANGEME|EXAMPLE|PLACEHOLDER)/i.test(match) ||
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
        const values = operation.arguments.map(valueOf);
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

function findingForNode(node, secretNames, aliases, evaluate) {
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
    const name = directSecretReference(
      node.left,
      secretNames,
      aliases,
      evaluate,
    );
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
    if (
      name &&
      (explicitTarget || !sourceSecret) &&
      isRejectedSecretValue(node.right, secretNames, aliases, evaluate)
    ) {
      return { name, kind: "assignment" };
    }
  }

  if (node.type === "Property" || node.type === "PropertyDefinition") {
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

function parseJavaScript(file) {
  const options = {
    allowAwaitOutsideFunction: true,
    allowHashBang: true,
    ecmaVersion: "latest",
    locations: true,
  };
  const lowerPath = file.path.toLowerCase();
  const sourceTypes = lowerPath.endsWith(".cjs")
    ? ["script"]
    : lowerPath.endsWith(".mjs")
      ? ["module"]
      : ["module", "script"];
  let finalError;

  for (const sourceType of sourceTypes) {
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

  const location = finalError?.loc
    ? `:${finalError.loc.line}:${finalError.loc.column + 1}`
    : "";
  fail(`${file.path}${location} is not valid JavaScript`);
}

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
