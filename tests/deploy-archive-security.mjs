import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const scannerPath = "tools/scan-deploy-secrets.mjs";
const secretNames = [
  "MONGODB_URI",
  "MONGO_URI",
  "JWT_SECRET",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_DESKTOP_CLIENT_SECRET",
  "RESEND_API_KEY",
  "DEEPSEEK_API_KEY",
];
let passed = 0;
let failed = 0;

function runScanner(payload, timeout = 5_000) {
  return spawnSync(process.execPath, [scannerPath], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
    input: JSON.stringify(payload),
    timeout,
  });
}

function record(name, condition, result) {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL  ${name}`);
  if (result?.error) console.error(result.error);
  if (result?.stderr) console.error(result.stderr.trim());
}

function scanJavaScript(name, source, shouldReject, expectedOutput) {
  const result = runScanner({
    mode: "javascript-fixtures",
    files: [{ path: `${name.replaceAll(" ", "-")}.js`, source }],
    secretNames,
  });
  const rejected = result.status !== 0 && !result.error;
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const outputMatches =
    expectedOutput === undefined || output.includes(expectedOutput);
  record(
    name,
    shouldReject
      ? rejected && outputMatches
      : result.status === 0 && outputMatches,
    result,
  );
}

const resendPrefix = "re_1234567890";
const resendSuffix = "abcdefghij";
const base64Secret = "c3VwZXJzZWNyZXQ=";
const hardcoded = "hardcoded-supersecret";
const cases = [
  [
    "destructuring default is refused",
    `const { JWT_SECRET = "${hardcoded}" } = process.env;`,
    true,
  ],
  [
    "one-hop alias fallback is refused",
    `const jwtSecret = process.env.JWT_SECRET; const signingKey = jwtSecret ?? "${hardcoded}";`,
    true,
  ],
  [
    "computed template key fallback is refused",
    `const token = process.env[\`JWT_SECRET\`] || "${hardcoded}";`,
    true,
  ],
  [
    "concatenated assignment is refused",
    'process.env.JWT_SECRET = "hard" + "coded";',
    true,
  ],
  ["short value is refused", 'const JWT_SECRET = "secret";', true],
  [
    "exact secret-name value is refused",
    'const JWT_SECRET = "JWT_SECRET";',
    true,
  ],
  [
    "propagated alias fallback is refused",
    `const first = process.env.JWT_SECRET; const second = first; const signingKey = second || "${hardcoded}";`,
    true,
  ],
  [
    "conditional fallback is refused",
    `const key = ready ? process.env.JWT_SECRET : "${hardcoded}";`,
    true,
  ],
  [
    "base64 Buffer decode is refused",
    `const JWT_SECRET = Buffer.from("${base64Secret}", "base64").toString("utf8");`,
    true,
  ],
  [
    "split provider token is refused",
    `const apiKey = "${resendPrefix}" + "${resendSuffix}";`,
    true,
  ],
  [
    "escaped provider token is refused",
    `const apiKey = "${resendPrefix}abcde\\u0066ghij";`,
    true,
  ],
  [
    "class secret field is refused",
    `class RuntimeConfig { JWT_SECRET = "${hardcoded}"; }`,
    true,
  ],
  [
    "indirect constant object assignment is refused",
    `const values = { jwt: "${hardcoded}" }; process.env.JWT_SECRET = values.jwt;`,
    true,
  ],
  [
    "conditional alias propagation is refused",
    `const candidate = enabled ? process.env.JWT_SECRET : undefined; const runtimeValue = candidate || "${hardcoded}";`,
    true,
  ],
  [
    "encoded environment key is refused",
    `process.env[decodeURIComponent("JWT%5FSECRET")] ||= "${hardcoded}";`,
    true,
  ],
  [
    "conflicting aliases terminate and refuse",
    `let key = process.env.JWT_SECRET; key = process.env.RESEND_API_KEY; key ||= "${hardcoded}";`,
    true,
  ],
  [
    "IIFE secret initializer is refused",
    `const JWT_SECRET = (() => "${hardcoded}")();`,
    true,
  ],
  [
    "string slice secret initializer is refused",
    `const JWT_SECRET = "${hardcoded}".slice(0);`,
    true,
  ],
  [
    "function-return alias fallback is refused",
    `const runtimeSecret = () => process.env.JWT_SECRET; const key = runtimeSecret() || "${hardcoded}";`,
    true,
  ],
  [
    "array destructuring secret is refused",
    `const [JWT_SECRET] = ["${hardcoded}"];`,
    true,
  ],
  [
    "sliced object secret property is refused",
    `const config = { JWT_SECRET: "${hardcoded}".slice(0) };`,
    true,
  ],
  [
    "nested conditional fallback is refused",
    `consume(enabled ? (ready ? process.env.JWT_SECRET : readVault()) : "${hardcoded}");`,
    true,
  ],
  [
    "transformed provider token is refused",
    `const apiKey = "${resendPrefix}".concat("${resendSuffix}".slice(0));`,
    true,
  ],
  [
    "IIFE environment fallback is refused",
    `(() => process.env.JWT_SECRET)() || "${hardcoded}";`,
    true,
  ],
  [
    "nested IIFE conditional fallback is refused",
    `consume(enabled ? (ready ? (() => process.env.JWT_SECRET)() : readVault()) : "${hardcoded}");`,
    true,
  ],
  [
    "object member secret propagation is refused",
    `const box = { value: process.env.JWT_SECRET }; const alias = box.value; const signingKey = alias || "${hardcoded}";`,
    true,
  ],
  [
    "mutable object member secret propagation is refused",
    `const box = {}; box.value = process.env.JWT_SECRET; const key = box.value || "${hardcoded}";`,
    true,
    "hardcoded JWT_SECRET fallback",
  ],
  [
    "nested mutable member secret propagation is refused",
    `const box = { inner: {} }; box.inner.value = process.env.JWT_SECRET; const key = box.inner.value || "${hardcoded}";`,
    true,
    "hardcoded JWT_SECRET fallback",
  ],
  [
    "mutable array member secret propagation is refused",
    `const values = []; values[0] = process.env.JWT_SECRET; const key = values[0] ?? "${hardcoded}";`,
    true,
    "hardcoded JWT_SECRET fallback",
  ],
  [
    "mutable member status value passes",
    `const box = {}; box.status = process.env.JWT_SECRET ? "configured" : "missing"; const label = box.status || "missing";`,
    false,
  ],
  [
    "computed environment replacement key is refused",
    `process.env["JWT-SECRET".replace("-", "_")] ||= "${hardcoded}";`,
    true,
  ],
  [
    "Reflect environment mutation is refused",
    `Reflect.set(process.env, "JWT_SECRET", "${hardcoded}");`,
    true,
  ],
  [
    "defineProperty environment mutation is refused",
    `Object.defineProperty(process.env, "JWT_SECRET", { value: "${hardcoded}" });`,
    true,
  ],
  [
    "dynamic IIFE secret read passes",
    "const JWT_SECRET = (() => process.env.JWT_SECRET)();",
    false,
  ],
  [
    "unverified vault read is refused",
    'const JWT_SECRET = await vault.read("JWT_SECRET");',
    true,
  ],
  [
    "locally implemented vault read is refused",
    `const vault = { read() { return "${hardcoded}"; } }; const JWT_SECRET = await vault.read("JWT_SECRET");`,
    true,
  ],
  [
    "unverified vault fallback is refused",
    `const vault = { read() { return "${hardcoded}"; } }; const key = process.env.JWT_SECRET || vault.read("JWT_SECRET");`,
    true,
  ],
  [
    "mutable computed environment fallback is refused",
    `let envName = "JWT_SECRET"; const key = process.env[envName] || "${hardcoded}";`,
    true,
  ],
  [
    "nested control-flow return fallback is refused",
    `function loadSecret() { if (enabled) return process.env.JWT_SECRET; return undefined; } const key = loadSecret() || "${hardcoded}";`,
    true,
  ],
  [
    "destructured function parameter fallback is refused",
    `function readSecret({ value: alias }) { return alias; } const key = readSecret({ value: process.env.JWT_SECRET }) || "${hardcoded}";`,
    true,
    "hardcoded JWT_SECRET fallback",
  ],
  [
    "destructured arrow parameter fallback is refused",
    `const readSecret = ({ nested: { value } }) => value; const key = readSecret({ nested: { value: process.env.JWT_SECRET } }) || "${hardcoded}";`,
    true,
    "hardcoded JWT_SECRET fallback",
  ],
  [
    "function parameter object alias fallback is refused",
    `function readSecret(config) { return config.value; } const key = readSecret({ value: process.env.JWT_SECRET }) || "${hardcoded}";`,
    true,
    "hardcoded JWT_SECRET fallback",
  ],
  [
    "arrow parameter member alias fallback is refused",
    `const readSecret = (config) => config.value; const source = {}; source.value = process.env.JWT_SECRET; const key = readSecret(source) || "${hardcoded}";`,
    true,
    "hardcoded JWT_SECRET fallback",
  ],
  [
    "class method secret return fallback is refused",
    `class RuntimeConfig { readSecret() { return process.env.JWT_SECRET; } } const key = new RuntimeConfig().readSecret() || "${hardcoded}";`,
    true,
    "hardcoded JWT_SECRET fallback",
  ],
  [
    "static class method secret return fallback is refused",
    `class RuntimeConfig { static readSecret() { return process.env.JWT_SECRET; } } const key = RuntimeConfig.readSecret() || "${hardcoded}";`,
    true,
    "hardcoded JWT_SECRET fallback",
  ],
  [
    "static class expression secret return fallback is refused",
    `const RuntimeConfig = class { static readSecret() { return process.env.JWT_SECRET; } }; const key = RuntimeConfig.readSecret() || "${hardcoded}";`,
    true,
    "hardcoded JWT_SECRET fallback",
  ],
  [
    "destructured process and environment aliases are refused",
    `const { process: runtimeProcess } = globalThis; const { env: environment } = runtimeProcess; let name = "JWT_SECRET"; const key = environment[name] || "${hardcoded}";`,
    true,
    "hardcoded process.env[computed] fallback",
  ],
  [
    "computed destructuring from environment alias is refused",
    `const environment = process.env; let name = "JWT_SECRET"; const { [name]: token } = environment; const key = token || "${hardcoded}";`,
    true,
    "hardcoded process.env[computed] fallback",
  ],
  [
    "globalThis computed environment fallback is refused",
    `let name = "JWT_SECRET"; const key = globalThis.process.env[name] || "${hardcoded}";`,
    true,
    "hardcoded process.env[computed] fallback",
  ],
  [
    "mutable provider identifier assembly is refused",
    `let apiKey = "${resendPrefix}"; apiKey += "${resendSuffix}";`,
    true,
    "hardcoded Resend API key static provider credential",
  ],
  [
    "mutable provider object assembly is refused",
    `const holder = {}; holder.key = "${resendPrefix}"; holder.key += "${resendSuffix}"; const apiKey = holder.key;`,
    true,
    "hardcoded Resend API key static provider credential",
  ],
  [
    "mutable provider array assembly is refused",
    `const parts = []; parts.push("${resendPrefix}"); parts.push("${resendSuffix}"); const apiKey = parts.join("");`,
    true,
    "hardcoded Resend API key static provider credential",
  ],
  [
    "pure dynamic mutable member storage passes",
    `const box = {}; box.value = process.env.JWT_SECRET;`,
    false,
  ],
  [
    "pure dynamic nested member storage passes",
    `const box = { inner: {} }; box.inner.value = process.env.JWT_SECRET;`,
    false,
  ],
  [
    "pure dynamic array storage passes",
    `const values = []; values[0] = process.env.JWT_SECRET;`,
    false,
  ],
  [
    "parameter-derived status value passes",
    `function secretStatus(config) { return config.value ? "configured" : "missing"; } const label = secretStatus({ value: process.env.JWT_SECRET }) || "missing";`,
    false,
  ],
  [
    "class dynamic secret read passes",
    `class RuntimeConfig { readSecret() { return process.env.JWT_SECRET; } } const key = new RuntimeConfig().readSecret();`,
    false,
  ],
  [
    "environment alias dynamic secret read passes",
    `const environment = globalThis.process.env; const key = environment.JWT_SECRET;`,
    false,
  ],
  [
    "incomplete mutable provider assembly passes",
    `let apiKey = "${resendPrefix}"; apiKey += "short";`,
    false,
  ],
  [
    "dynamic computed environment status check passes",
    `for (const envName of ["JWT_SECRET"]) { if (!process.env[envName]) throw new Error("missing"); }`,
    false,
  ],
  [
    "comparison passes",
    'if (process.env.JWT_SECRET === "expected") console.log("configured");',
    false,
  ],
  [
    "status conditional passes",
    'const status = process.env.JWT_SECRET ? "configured" : "missing";',
    false,
  ],
  [
    "negated status conditional passes",
    'const status = !process.env.JWT_SECRET ? "missing" : "configured";',
    false,
  ],
  [
    "semicolonless separate statements pass",
    `const key = process.env.JWT_SECRET\nconst label = "${hardcoded}"`,
    false,
  ],
  [
    "obvious provider placeholder passes",
    'const example = "sk-00000000000000000000";',
    false,
  ],
];
for (const [name, source, shouldReject, expectedOutput] of cases) {
  scanJavaScript(name, source, shouldReject, expectedOutput);
}

const packageJsonSource = readFileSync("package.json", "utf8");
const packageLockSource = readFileSync("package-lock.json", "utf8");

function mutateJson(source, mutate) {
  const value = JSON.parse(source);
  mutate(value);
  return JSON.stringify(value);
}

const unsupportedManifestFieldValues = {
  bundleDependencies: ["compression"],
  bundledDependencies: ["compression"],
  dependenciesMeta: { compression: { built: true } },
  devEngines: { runtime: { name: "node", onFail: "error" } },
  onlyBuiltDependencies: ["compression"],
  os: ["win32"],
  cpu: ["x64"],
  libc: ["glibc"],
  overrides: { compression: "9.0.0" },
  packageManager: "npm@11.0.0",
  pnpm: { onlyBuiltDependencies: ["compression"] },
  resolutions: { compression: "9.0.0" },
  trustedDependencies: ["compression"],
  workspaces: ["packages/*"],
};

const manifestCases = [
  ["current manifests pass", packageJsonSource, packageLockSource, false],
  [
    "overlapping optional root dependency is refused",
    mutateJson(packageJsonSource, (manifest) => {
      manifest.optionalDependencies = { compression: "^999.0.0" };
    }),
    packageLockSource,
    true,
    "both dependencies and optionalDependencies",
  ],
  [
    "unlocked optional root dependency is refused",
    mutateJson(packageJsonSource, (manifest) => {
      manifest.optionalDependencies = { "left-pad": "^1.3.0" };
    }),
    packageLockSource,
    true,
    "package-lock.json root optionalDependencies differs from package.json",
  ],
  [
    "unlocked peer root dependency is refused",
    mutateJson(packageJsonSource, (manifest) => {
      manifest.peerDependencies = { react: "^18.0.0" };
    }),
    packageLockSource,
    true,
    "package-lock.json root peerDependencies differs from package.json",
  ],
  [
    "orphan root peer metadata is refused",
    mutateJson(packageJsonSource, (manifest) => {
      manifest.peerDependencies = { react: "^18.0.0" };
      manifest.peerDependenciesMeta = { missing: { optional: true } };
    }),
    packageLockSource,
    true,
    "does not identify a peer dependency",
  ],
  ...Object.entries(unsupportedManifestFieldValues).map(([field, value]) => [
    `unsupported root ${field} is refused`,
    mutateJson(packageJsonSource, (manifest) => {
      manifest[field] = value;
    }),
    packageLockSource,
    true,
    `unsupported install field: ${field}`,
  ]),
  [
    "canonical lock whitespace and top-level key reordering pass",
    packageJsonSource,
    (() => {
      const manifest = JSON.parse(packageLockSource);
      return `${JSON.stringify(
        Object.fromEntries(Object.entries(manifest).reverse()),
        null,
        4,
      )}\n`;
    })(),
    false,
  ],
  [
    "valid-length transitive integrity substitution is refused",
    packageJsonSource,
    mutateJson(packageLockSource, (manifest) => {
      manifest.packages["node_modules/accepts"].integrity =
        manifest.packages["node_modules/acorn"].integrity;
    }),
    true,
    "canonical SHA-256 does not match the trusted lock",
  ],
  [
    "runtime package classified as development-only is refused",
    packageJsonSource,
    mutateJson(packageLockSource, (manifest) => {
      manifest.packages["node_modules/compression"].dev = true;
    }),
    true,
    "runtime-reachable package is classified as development-only",
  ],
  [
    "conflicting duplicate peer range is refused",
    packageJsonSource,
    mutateJson(packageLockSource, (manifest) => {
      manifest.packages["node_modules/accepts"].peerDependencies = {
        "mime-types": "^999.0.0",
      };
    }),
    true,
    "peerDependencies dependency mime-types does not satisfy",
  ],
  [
    "widened transitive dependency range is refused",
    packageJsonSource,
    mutateJson(packageLockSource, (manifest) => {
      manifest.packages["node_modules/accepts"].dependencies["mime-types"] =
        "*";
    }),
    true,
    "canonical SHA-256 does not match the trusted lock",
  ],
  [
    "invalid package JSON is refused",
    packageJsonSource.replace(/\n}\s*$/, ",\n}"),
    packageLockSource,
    true,
  ],
  [
    "package-lock mismatch is refused",
    packageJsonSource.replace(
      '"compression": "^1.8.1"',
      '"compression": "^1.8.2"',
    ),
    packageLockSource,
    true,
  ],
  [
    "mutable dependency source is refused",
    packageJsonSource.replace(
      '"compression": "^1.8.1"',
      '"compression": "github:user/repo#main"',
    ),
    packageLockSource,
    true,
  ],
  [
    "incompatible direct lock version is refused",
    mutateJson(packageJsonSource, (manifest) => {
      manifest.dependencies.compression = "^9.0.0";
    }),
    mutateJson(packageLockSource, (manifest) => {
      manifest.packages[""].dependencies.compression = "^9.0.0";
    }),
    true,
  ],
  [
    "direct dependency tarball substitution is refused",
    packageJsonSource,
    mutateJson(packageLockSource, (manifest) => {
      manifest.packages["node_modules/acorn"].resolved =
        "https://registry.npmjs.org/not-acorn/-/not-acorn-8.18.0.tgz";
    }),
    true,
  ],
  [
    "transitive package tarball substitution is refused",
    packageJsonSource,
    mutateJson(packageLockSource, (manifest) => {
      const acorn = manifest.packages["node_modules/acorn"];
      const accepts = manifest.packages["node_modules/accepts"];
      accepts.resolved = acorn.resolved;
      accepts.integrity = acorn.integrity;
    }),
    true,
  ],
  [
    "transitive dependency range mismatch is refused",
    packageJsonSource,
    mutateJson(packageLockSource, (manifest) => {
      const mimeTypes = manifest.packages["node_modules/mime-types"];
      mimeTypes.version = "3.0.0";
      mimeTypes.resolved =
        "https://registry.npmjs.org/mime-types/-/mime-types-3.0.0.tgz";
    }),
    true,
    "dependencies dependency mime-types does not satisfy",
  ],
  [
    "prerelease direct version is refused",
    packageJsonSource,
    mutateJson(packageLockSource, (manifest) => {
      const compression = manifest.packages["node_modules/compression"];
      compression.version = "1.9.0-beta.1";
      compression.resolved =
        "https://registry.npmjs.org/compression/-/compression-1.9.0-beta.1.tgz";
    }),
    true,
  ],
  [
    "leading-zero direct version is refused",
    packageJsonSource,
    mutateJson(packageLockSource, (manifest) => {
      const compression = manifest.packages["node_modules/compression"];
      compression.version = "01.8.1";
      compression.resolved =
        "https://registry.npmjs.org/compression/-/compression-01.8.1.tgz";
    }),
    true,
  ],
  [
    "unreachable lock entry is refused",
    packageJsonSource,
    mutateJson(packageLockSource, (manifest) => {
      const source = manifest.packages["node_modules/accepts"];
      manifest.packages["node_modules/unreachable-package"] = {
        ...source,
        resolved:
          "https://registry.npmjs.org/unreachable-package/-/unreachable-package-1.3.8.tgz",
      };
    }),
    true,
    "contains an unreachable package entry",
  ],
  [
    "short lock integrity is refused",
    packageJsonSource,
    mutateJson(packageLockSource, (manifest) => {
      manifest.packages["node_modules/acorn"].integrity = "sha512-AA==";
    }),
    true,
  ],
  [
    "missing transitive lock entry is refused",
    packageJsonSource,
    mutateJson(packageLockSource, (manifest) => {
      delete manifest.packages["node_modules/accepts"];
    }),
    true,
  ],
  [
    "prestart lifecycle script is refused",
    mutateJson(packageJsonSource, (manifest) => {
      manifest.scripts.prestart = "node setup.js";
    }),
    packageLockSource,
    true,
    "forbidden lifecycle script: prestart",
  ],
  [
    "poststart lifecycle script is refused",
    mutateJson(packageJsonSource, (manifest) => {
      manifest.scripts.poststart = "node cleanup.js";
    }),
    packageLockSource,
    true,
    "forbidden lifecycle script: poststart",
  ],
  [
    "install lifecycle script is refused",
    packageJsonSource.replace(
      '"start": "node src/server.js"',
      '"start": "node src/server.js", "postinstall": "node setup.js"',
    ),
    packageLockSource,
    true,
    "forbidden lifecycle script: postinstall",
  ],
];
for (const [
  name,
  packageJson,
  packageLock,
  shouldReject,
  expectedOutput,
] of manifestCases) {
  const result = runScanner({
    mode: "archive",
    files: [],
    secretNames,
    manifests: { packageJson, packageLock },
  });
  const rejected = result.status !== 0 && !result.error;
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const outputMatches =
    expectedOutput === undefined || output.includes(expectedOutput);
  record(
    name,
    shouldReject
      ? rejected && outputMatches
      : result.status === 0 && outputMatches,
    result,
  );
}

const listed = spawnSync("git", ["ls-files", "-z", "--", "src", "public"], {
  cwd: process.cwd(),
  encoding: "buffer",
  timeout: 30_000,
});
if (listed.status !== 0 || listed.error) {
  record("tracked runtime JavaScript scan", false, listed);
} else {
  const paths = listed.stdout
    .toString("utf8")
    .split("\0")
    .filter((path) => /\.(?:cjs|js|mjs)$/i.test(path));
  const files = paths.map((path) => ({
    path: path.replaceAll("\\", "/"),
    source: readFileSync(path, "utf8"),
  }));
  const result = runScanner(
    { mode: "javascript-fixtures", files, secretNames },
    60_000,
  );
  record(
    `all ${files.length} tracked runtime JavaScript files pass`,
    files.length === 148 && result.status === 0,
    result,
  );
}

const aliases = ["const alias0 = process.env.JWT_SECRET;"];
for (let index = 1; index <= 8_000; index += 1) {
  aliases.push(`const alias${index} = alias${index - 1};`);
}
const scaleStarted = Date.now();
const scaleResult = runScanner(
  {
    mode: "javascript-fixtures",
    files: [{ path: "alias-scale.js", source: aliases.join("\n") }],
    secretNames: ["JWT_SECRET"],
  },
  10_000,
);
const scaleElapsed = Date.now() - scaleStarted;
record(
  `8,000-alias scan stays bounded (${scaleElapsed} ms)`,
  scaleResult.status === 0 && scaleElapsed < 5_000,
  scaleResult,
);

console.log(`Result: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
