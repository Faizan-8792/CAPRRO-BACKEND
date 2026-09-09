import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  MAX_SAFE_BODY_BYTES,
  PLACEHOLDER_BODY,
  assertArchivePathNotExposed,
  classifyServedArchive,
} from "../tools/lib/deploy-archive-exposure.mjs";
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

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
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
  const fixturePath = `${name.replaceAll(" ", "-")}.js`;
  const result = runScanner({
    mode: "javascript-fixtures",
    files: [{ path: fixturePath, source }],
    secretNames,
  });
  const rejected = result.status !== 0 && !result.error;
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const refusalLines = output
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("REFUSED: "));
  const expectedReason = expectedOutput ?? expectedReasonByName.get(name);
  const hasExpectedReason =
    typeof expectedReason === "string" && expectedReason.trim().length > 0;
  const expectedPrefix = `REFUSED: ${fixturePath}:`;
  const expectedSuffix = ` contains a ${expectedReason}`;
  const exactRefusalLines = hasExpectedReason
    ? refusalLines.filter((line) => {
        if (
          !line.startsWith(expectedPrefix) ||
          !line.endsWith(expectedSuffix)
        ) {
          return false;
        }
        const location = line.slice(
          expectedPrefix.length,
          -expectedSuffix.length,
        );
        return /^\d+:\d+$/u.test(location);
      })
    : [];
  const safeOutputMatches =
    expectedOutput === undefined || output.includes(expectedOutput);
  record(
    name,
    shouldReject
      ? rejected &&
          hasExpectedReason &&
          refusalLines.length === 1 &&
          exactRefusalLines.length === 1
      : result.status === 0 && refusalLines.length === 0 && safeOutputMatches,
    result,
  );
}

const resendPrefix = "re_1234567890";
const resendSuffix = "abcdefghij";
const base64Secret = "c3VwZXJzZWNyZXQ=";
const hardcoded = "hardcoded-supersecret";
const expectedReasonByName = new Map([
  [
    "destructuring default is refused",
    "hardcoded JWT_SECRET object or class property",
  ],
  ["one-hop alias fallback is refused", "hardcoded JWT_SECRET fallback"],
  [
    "computed template key fallback is refused",
    "hardcoded JWT_SECRET fallback",
  ],
  ["concatenated assignment is refused", "hardcoded JWT_SECRET assignment"],
  ["short value is refused", "hardcoded JWT_SECRET variable initializer"],
  [
    "exact secret-name value is refused",
    "hardcoded JWT_SECRET variable initializer",
  ],
  ["propagated alias fallback is refused", "hardcoded JWT_SECRET fallback"],
  [
    "conditional fallback is refused",
    "hardcoded JWT_SECRET conditional fallback",
  ],
  [
    "base64 Buffer decode is refused",
    "hardcoded JWT_SECRET variable initializer",
  ],
  [
    "split provider token is refused",
    "hardcoded Resend API key static provider credential",
  ],
  [
    "escaped provider token is refused",
    "hardcoded Resend API key static provider credential",
  ],
  [
    "class secret field is refused",
    "hardcoded JWT_SECRET object or class property",
  ],
  [
    "indirect constant object assignment is refused",
    "hardcoded JWT_SECRET assignment",
  ],
  ["conditional alias propagation is refused", "hardcoded JWT_SECRET fallback"],
  ["encoded environment key is refused", "hardcoded JWT_SECRET assignment"],
  [
    "conflicting aliases terminate and refuse",
    "hardcoded JWT_SECRET assignment",
  ],
  [
    "IIFE secret initializer is refused",
    "hardcoded JWT_SECRET variable initializer",
  ],
  [
    "string slice secret initializer is refused",
    "hardcoded JWT_SECRET variable initializer",
  ],
  [
    "function-return alias fallback is refused",
    "hardcoded JWT_SECRET fallback",
  ],
  [
    "array destructuring secret is refused",
    "hardcoded JWT_SECRET array destructuring initializer",
  ],
  [
    "sliced object secret property is refused",
    "hardcoded JWT_SECRET object or class property",
  ],
  [
    "nested conditional fallback is refused",
    "hardcoded JWT_SECRET conditional fallback",
  ],
  [
    "transformed provider token is refused",
    "hardcoded Resend API key static provider credential",
  ],
  ["IIFE environment fallback is refused", "hardcoded JWT_SECRET fallback"],
  [
    "nested IIFE conditional fallback is refused",
    "hardcoded JWT_SECRET conditional fallback",
  ],
  [
    "object member secret propagation is refused",
    "hardcoded JWT_SECRET fallback",
  ],
  [
    "computed environment replacement key is refused",
    "hardcoded JWT_SECRET assignment",
  ],
  [
    "Reflect environment mutation is refused",
    "hardcoded JWT_SECRET Reflect.set environment mutation",
  ],
  [
    "defineProperty environment mutation is refused",
    "hardcoded JWT_SECRET Object.defineProperty environment mutation",
  ],
  [
    "unverified vault read is refused",
    "hardcoded JWT_SECRET variable initializer",
  ],
  [
    "locally implemented vault read is refused",
    "hardcoded JWT_SECRET variable initializer",
  ],
  ["unverified vault fallback is refused", "hardcoded JWT_SECRET fallback"],
  [
    "mutable computed environment fallback is refused",
    "hardcoded process.env[computed] fallback",
  ],
  [
    "nested control-flow return fallback is refused",
    "hardcoded JWT_SECRET fallback",
  ],
]);
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
    "object identity alias preserves member provenance",
    `const config = {}; config.value = process.env.JWT_SECRET; const alias = config; const key = alias.value || "${hardcoded}";`,
    true,
    "hardcoded JWT_SECRET fallback",
  ],
  [
    "parameter container alias preserves member provenance",
    `function runtime(box) { box.value = process.env.JWT_SECRET; const alias = box; return alias.value; } const key = runtime({}) || "${hardcoded}";`,
    true,
    "hardcoded JWT_SECRET fallback",
  ],
  [
    "parameter container alias does not taint a safe sibling",
    `function runtime(box) { box.value = process.env.JWT_SECRET; const alias = box; return alias.status; } const label = runtime({}) || "missing";`,
    false,
  ],
  [
    "array push preserves indexed member provenance",
    `const values = []; values.push(process.env.JWT_SECRET); const key = values[0] || "${hardcoded}";`,
    true,
    "hardcoded JWT_SECRET fallback",
  ],
  [
    "new Array push preserves indexed member provenance",
    `const values = new Array(); values.push(process.env.JWT_SECRET); const key = values[0] || "${hardcoded}";`,
    true,
    "hardcoded JWT_SECRET fallback",
  ],
  [
    "omitted default parameter preserves secret provenance",
    `function runtime(value = process.env.JWT_SECRET) { return value; } const key = runtime() || "${hardcoded}";`,
    true,
    "hardcoded JWT_SECRET fallback",
  ],
  [
    "explicit undefined activates default parameter provenance",
    `function runtime(value = process.env.JWT_SECRET) { return value; } const key = runtime(undefined) || "${hardcoded}";`,
    true,
    "hardcoded JWT_SECRET fallback",
  ],
  [
    "void expression activates default parameter provenance",
    `function runtime(value = process.env.JWT_SECRET) { return value; } const key = runtime(void 0) || "${hardcoded}";`,
    true,
    "hardcoded JWT_SECRET fallback",
  ],
  [
    "omitted nested destructuring default preserves secret provenance",
    `function runtime({ nested: { value = process.env.JWT_SECRET } = {} } = {}) { return value; } const key = runtime() || "${hardcoded}";`,
    true,
    "hardcoded JWT_SECRET fallback",
  ],
  [
    "rest parameter preserves secret provenance",
    `function runtime(...values) { return values[0]; } const key = runtime(process.env.JWT_SECRET) || "${hardcoded}";`,
    true,
    "hardcoded JWT_SECRET fallback",
  ],
  [
    "class expression assigned after declaration preserves secret return",
    `let RuntimeConfig; RuntimeConfig = class { static readSecret() { return process.env.JWT_SECRET; } }; const key = RuntimeConfig.readSecret() || "${hardcoded}";`,
    true,
    "hardcoded JWT_SECRET fallback",
  ],
  [
    "class field arrow method preserves secret return",
    `class RuntimeConfig { readSecret = () => process.env.JWT_SECRET; } const key = new RuntimeConfig().readSecret() || "${hardcoded}";`,
    true,
    "hardcoded JWT_SECRET fallback",
  ],
  [
    "static class field arrow method preserves secret return",
    `class RuntimeConfig { static readSecret = () => process.env.JWT_SECRET; } const key = RuntimeConfig.readSecret() || "${hardcoded}";`,
    true,
    "hardcoded JWT_SECRET fallback",
  ],
  [
    "post-declaration object method preserves secret return",
    `const runtime = {}; runtime.readSecret = () => process.env.JWT_SECRET; const key = runtime.readSecret() || "${hardcoded}";`,
    true,
    "hardcoded JWT_SECRET fallback",
  ],
  [
    "post-declaration prototype method preserves secret return",
    `class RuntimeConfig {} RuntimeConfig.prototype.readSecret = () => process.env.JWT_SECRET; const key = new RuntimeConfig().readSecret() || "${hardcoded}";`,
    true,
    "hardcoded JWT_SECRET fallback",
  ],
  [
    "object method preserves secret return",
    `const runtime = { readSecret() { return process.env.JWT_SECRET; } }; const key = runtime.readSecret() || "${hardcoded}";`,
    true,
    "hardcoded JWT_SECRET fallback",
  ],
  [
    "aliased globalThis preserves computed environment provenance",
    `const root = globalThis; let keyName = "JWT_SECRET"; const key = root.process.env[keyName] || "${hardcoded}";`,
    true,
    "hardcoded process.env[computed] fallback",
  ],
  [
    "explicit default parameter override passes",
    `function runtime(value = process.env.JWT_SECRET) { return value; } const key = runtime("safe-runtime-value") || "fallback";`,
    false,
  ],
  [
    "explicit nested default override passes",
    `function runtime({ nested: { value = process.env.JWT_SECRET } = {} } = {}) { return value; } const key = runtime({ nested: { value: "safe-runtime-value" } }) || "fallback";`,
    false,
  ],
  [
    "array push does not taint an untouched index",
    `const values = []; values.push(process.env.JWT_SECRET); const label = values[1] || "missing";`,
    false,
  ],
  [
    "new Array push does not taint an untouched index",
    `const values = new Array(); values.push(process.env.JWT_SECRET); const label = values[1] || "missing";`,
    false,
  ],
  [
    "assigned class expression dynamic read passes",
    `let RuntimeConfig; RuntimeConfig = class { static readSecret() { return process.env.JWT_SECRET; } }; const key = RuntimeConfig.readSecret();`,
    false,
  ],
  [
    "class field dynamic read passes",
    `class RuntimeConfig { readSecret = () => process.env.JWT_SECRET; } const key = new RuntimeConfig().readSecret();`,
    false,
  ],
  [
    "post-declaration object method dynamic read passes",
    `const runtime = {}; runtime.readSecret = () => process.env.JWT_SECRET; const key = runtime.readSecret();`,
    false,
  ],
  [
    "object method dynamic read passes",
    `const runtime = { readSecret() { return process.env.JWT_SECRET; } }; const key = runtime.readSecret();`,
    false,
  ],
  [
    "aliased globalThis dynamic read passes",
    `const root = globalThis; const key = root.process.env.JWT_SECRET;`,
    false,
  ],
  [
    "secret-bearing member does not taint safe sibling",
    `const runtime = {}; runtime.secret = process.env.JWT_SECRET; const port = runtime.port || "8080";`,
    false,
  ],
  [
    "overwritten member invalidates stale secret provenance",
    `const runtime = {}; runtime.secret = process.env.JWT_SECRET; runtime.secret = readVault(); const key = runtime.secret || "${hardcoded}";`,
    false,
  ],
  [
    "conditional overwrite cannot erase prior secret provenance",
    `const runtime = {}; runtime.secret = process.env.JWT_SECRET; if (false) runtime.secret = readVault(); const key = runtime.secret || "${hardcoded}";`,
    true,
    "hardcoded JWT_SECRET fallback",
  ],
  [
    "unconditional overwrite after conditional secret write passes",
    `const runtime = {}; if (enabled) runtime.secret = process.env.JWT_SECRET; runtime.secret = readVault(); const key = runtime.secret || "fallback";`,
    false,
  ],
  [
    "object member laundering cannot certify a hardcoded secret as environment-derived",
    `const config = {}; config.jwtSecret = "${hardcoded}"; if (process.env.JWT_SECRET) { config.jwtSecret = process.env.JWT_SECRET; } const JWT_SECRET = config.jwtSecret;`,
    true,
    "hardcoded JWT_SECRET variable initializer",
  ],
  [
    "member write inside a never-called function cannot launder a hardcoded secret",
    `const box = {}; box.value = "${hardcoded}"; function reload() { box.value = process.env.JWT_SECRET; } const JWT_SECRET = box.value;`,
    true,
    "hardcoded JWT_SECRET variable initializer",
  ],
  [
    "member write inside a try block cannot launder a hardcoded secret",
    `const box = {}; box.value = "${hardcoded}"; try { box.value = process.env.JWT_SECRET; } catch (error) { } const JWT_SECRET = box.value;`,
    true,
    "hardcoded JWT_SECRET variable initializer",
  ],
  [
    "parameter container laundering cannot certify a hardcoded secret",
    `function build(target) { target.secret = "${hardcoded}"; if (process.env.JWT_SECRET) { target.secret = process.env.JWT_SECRET; } return target.secret; } const JWT_SECRET = build({});`,
    true,
    "hardcoded JWT_SECRET variable initializer",
  ],
  [
    "class static laundering cannot certify a hardcoded secret",
    `class Config { static value = "${hardcoded}"; } if (process.env.JWT_SECRET) { Config.value = process.env.JWT_SECRET; } const JWT_SECRET = Config.value;`,
    true,
    "hardcoded JWT_SECRET variable initializer",
  ],
  [
    "pushed array slot laundering cannot certify a hardcoded secret",
    `const slots = []; slots.push("${hardcoded}"); if (process.env.JWT_SECRET) { slots[0] = process.env.JWT_SECRET; } const JWT_SECRET = slots[0];`,
    true,
    "hardcoded JWT_SECRET variable initializer",
  ],
  [
    "unconditional environment member write passes",
    `const config = {}; config.jwtSecret = process.env.JWT_SECRET; const JWT_SECRET = config.jwtSecret;`,
    false,
  ],
  [
    "hardcoded member later replaced by an environment write is still refused",
    `const config = {}; config.jwtSecret = "${hardcoded}"; config.jwtSecret = process.env.JWT_SECRET; const JWT_SECRET = config.jwtSecret;`,
    true,
    "hardcoded JWT_SECRET assignment",
  ],
  [
    "placeholder member default before a conditional environment write passes",
    `const config = {}; config.jwtSecret = "REPLACE_ME"; if (process.env.JWT_SECRET) { config.jwtSecret = process.env.JWT_SECRET; } const JWT_SECRET = config.jwtSecret;`,
    false,
  ],
  [
    "mutable provider spread assembly is refused",
    `const parts = []; parts.push(...["${resendPrefix}", "${resendSuffix}"]); const apiKey = parts.join("");`,
    true,
    "hardcoded Resend API key static provider credential",
  ],
  [
    "lazy getter returning an environment secret passes",
    `const config = { get JWT_SECRET() { return process.env.JWT_SECRET; } };`,
    false,
  ],
  [
    "arrow thunk property returning an environment secret passes",
    `const config = { JWT_SECRET: () => process.env.JWT_SECRET };`,
    false,
  ],
  [
    "shorthand method returning an environment secret passes",
    `const config = { JWT_SECRET() { return process.env.JWT_SECRET; } };`,
    false,
  ],
  [
    "unresolvable fallback helper remains refused",
    `const JWT_SECRET = process.env.JWT_SECRET ?? required("JWT_SECRET");`,
    true,
    "hardcoded JWT_SECRET fallback",
  ],
  [
    "locally defined readFileSync decoy is refused",
    `function readFileSync() { return "${hardcoded}"; } const JWT_SECRET = readFileSync();`,
    true,
    "hardcoded JWT_SECRET variable initializer",
  ],
  [
    "renamed vault method decoy is refused",
    `const vault = { readFileSync() { return "${hardcoded}"; } }; const JWT_SECRET = process.env.JWT_SECRET ?? vault.readFileSync();`,
    true,
    "hardcoded JWT_SECRET fallback",
  ],
  [
    "aliased container member laundering is refused",
    `const config = {}; config.jwtSecret = "${hardcoded}"; if (process.env.JWT_SECRET) { config.jwtSecret = process.env.JWT_SECRET; } const jwtSecret = config.jwtSecret; const JWT_SECRET = jwtSecret;`,
    true,
    "hardcoded JWT_SECRET variable initializer",
  ],
  [
    "function returning a laundered container member is refused",
    `const box = {}; box.value = "${hardcoded}"; if (process.env.JWT_SECRET) { box.value = process.env.JWT_SECRET; } function read() { return box.value; } const JWT_SECRET = read();`,
    true,
    "hardcoded JWT_SECRET variable initializer",
  ],
  [
    "Object.assign laundering is refused",
    `const box = { value: process.env.JWT_SECRET }; Object.assign(box, { value: "${hardcoded}" }); const JWT_SECRET = box.value;`,
    true,
    "hardcoded JWT_SECRET variable initializer",
  ],
  [
    "spread container copy laundering is refused",
    `const base = { value: "${hardcoded}" }; const box = { ...base }; if (process.env.JWT_SECRET) { box.value = process.env.JWT_SECRET; } const JWT_SECRET = box.value;`,
    true,
    "hardcoded JWT_SECRET variable initializer",
  ],
  [
    "structuredClone container copy laundering is refused",
    `const base = { value: "${hardcoded}" }; const box = structuredClone(base); if (process.env.JWT_SECRET) { box.value = process.env.JWT_SECRET; } const JWT_SECRET = box.value;`,
    true,
    "hardcoded JWT_SECRET variable initializer",
  ],
  [
    "hardcoded member write after an environment write is refused",
    `const config = {}; config.jwtSecret = process.env.JWT_SECRET; config.jwtSecret = "${hardcoded}"; const key = config.jwtSecret;`,
    true,
    "hardcoded JWT_SECRET assignment",
  ],
  [
    "hardcoded nested member write after an environment write is refused",
    `const config = { auth: {} }; config.auth.jwtSecret = process.env.JWT_SECRET; config.auth.jwtSecret = "${hardcoded}"; const key = config.auth.jwtSecret;`,
    true,
    "hardcoded JWT_SECRET assignment",
  ],
  [
    "hardcoded array slot write after an environment push is refused",
    `const slots = []; slots.push(process.env.JWT_SECRET); slots[0] = "${hardcoded}"; const key = slots[0];`,
    true,
    "hardcoded JWT_SECRET assignment",
  ],
  [
    "deferred read of a member overwritten with a literal is refused",
    `const config = {}; config.jwtSecret = process.env.JWT_SECRET; function sign() { return config.jwtSecret; } config.jwtSecret = "${hardcoded}"; const key = sign();`,
    true,
    "hardcoded JWT_SECRET assignment",
  ],
  [
    "frozen environment container passes",
    `const config = { jwtSecret: process.env.JWT_SECRET }; Object.freeze(config); const JWT_SECRET = config.jwtSecret;`,
    false,
  ],
  [
    "sealed environment container passes",
    `const config = { jwtSecret: process.env.JWT_SECRET }; Object.seal(config); const JWT_SECRET = config.jwtSecret;`,
    false,
  ],
  [
    "environment write onto a class instance field passes",
    `class Settings { } const cfg = new Settings(); cfg.jwtSecret = process.env.JWT_SECRET; const JWT_SECRET = cfg.jwtSecret;`,
    false,
  ],
  [
    "sibling read of a two-spread merge source passes",
    `const base = { jwtSecret: process.env.JWT_SECRET }; const extra = { region: "ap-south-1" }; const merged = { ...base, ...extra }; const JWT_SECRET = base.jwtSecret;`,
    false,
  ],
  [
    "local helper returning a literal cannot launder a container member",
    `function bakedKey() { return "${hardcoded}"; } const runtime = {}; runtime.signingKey = bakedKey(); if (process.env.JWT_SECRET) { runtime.signingKey = process.env.JWT_SECRET; } const JWT_SECRET = runtime.signingKey;`,
    true,
    "hardcoded JWT_SECRET variable initializer",
  ],
  [
    "template wrapped helper cannot launder a container member",
    `function bakedKey() { return "${hardcoded}"; } const runtime = {}; runtime.signingKey = \`\${bakedKey()}\`; if (process.env.JWT_SECRET) { runtime.signingKey = process.env.JWT_SECRET; } const JWT_SECRET = runtime.signingKey;`,
    true,
    "hardcoded JWT_SECRET variable initializer",
  ],
  [
    "second container read cannot launder a container member",
    `const baked = {}; baked.k = "${hardcoded}"; const runtime = {}; runtime.signingKey = baked.k; if (process.env.JWT_SECRET) { runtime.signingKey = process.env.JWT_SECRET; } const JWT_SECRET = runtime.signingKey;`,
    true,
    "hardcoded JWT_SECRET variable initializer",
  ],
  [
    "nested globalThis-qualified Reflect set is refused",
    `const config = {}; globalThis.globalThis.Reflect.set(config, "JWT_SECRET", "${hardcoded}");`,
    true,
    "hardcoded JWT_SECRET reflective assignment",
  ],
  [
    "aliased global chain Reflect set is refused",
    `const g = globalThis.globalThis; const config = {}; g.Reflect.set(config, "JWT_SECRET", "${hardcoded}");`,
    true,
    "hardcoded JWT_SECRET reflective assignment",
  ],
  [
    "namespace held in an object member is refused",
    `const ns = { R: Reflect }; const config = {}; ns.R.set(config, "JWT_SECRET", "${hardcoded}");`,
    true,
    "hardcoded JWT_SECRET reflective assignment",
  ],
  [
    "namespace held in an array element is refused",
    `const ns = [Reflect]; const config = {}; ns[0].set(config, "JWT_SECRET", "${hardcoded}");`,
    true,
    "hardcoded JWT_SECRET reflective assignment",
  ],
  [
    "Reflect.set invoked through call is refused",
    `const config = {}; Reflect.set.call(null, config, "JWT_SECRET", "${hardcoded}");`,
    true,
    "hardcoded JWT_SECRET reflective assignment",
  ],
  [
    "Reflect.set invoked through apply is refused",
    `const config = {}; Reflect.set.apply(null, [config, "JWT_SECRET", "${hardcoded}"]);`,
    true,
    "hardcoded JWT_SECRET reflective assignment",
  ],
  [
    "Reflect.apply of defineProperty is refused",
    `const config = {}; Reflect.apply(Object.defineProperty, null, [config, "JWT_SECRET", { value: "${hardcoded}" }]);`,
    true,
    "hardcoded JWT_SECRET reflective assignment",
  ],
  [
    "secret entry pair inside a Map constructor is refused",
    `const config = Object.fromEntries(new Map([["JWT_SECRET", "${hardcoded}"]])); export const token = config.JWT_SECRET;`,
    true,
    "hardcoded JWT_SECRET secret entry pair",
  ],
  [
    "secret entry pair reached through a generator is refused",
    `function* pairs() { yield ["JWT_SECRET", "${hardcoded}"]; } const config = Object.fromEntries(pairs());`,
    true,
    "hardcoded JWT_SECRET secret entry pair",
  ],
  [
    "environment-sourced entry pair passes",
    `const config = Object.fromEntries(new Map([["JWT_SECRET", process.env.JWT_SECRET]])); export const token = config.JWT_SECRET;`,
    false,
  ],
  [
    "uppercase alphanumeric entry pair value is refused",
    `const config = new Map([["JWT_SECRET", "XK7QP2MZ9RT4LN8V"]]);`,
    true,
    "hardcoded JWT_SECRET secret entry pair",
  ],
  [
    "underscored uppercase entry pair value is refused",
    `const config = new Map([["JWT_SECRET", "PROD_KEY_A1B2C3D4E5"]]);`,
    true,
    "hardcoded JWT_SECRET secret entry pair",
  ],
  [
    "entry pair inside a Set constructor is refused",
    `const config = new Set([["JWT_SECRET", "XK7QP2MZ9RT4LN8V"]]);`,
    true,
    "hardcoded JWT_SECRET secret entry pair",
  ],
  [
    "entry pair carrying a third element is refused",
    `const config = new Map([["JWT_SECRET", "3f9c1e77a4b8d2065e1f4a7c9b3d5e80", 0]]);`,
    true,
    "hardcoded JWT_SECRET secret entry pair",
  ],
  [
    "entry pair describing a secret passes",
    `const DESCRIPTIONS = [["JWT_SECRET", "Signing key for access tokens"]];`,
    false,
  ],
  [
    "entry pair carrying a minimum length passes",
    `const MIN_LENGTHS = [["JWT_SECRET", 32], ["MONGODB_URI", 12]];`,
    false,
  ],
  [
    "entry pair carrying a required flag passes",
    `const REQUIRED = [["JWT_SECRET", true]];`,
    false,
  ],
  [
    "entry pair carrying a remediation sentence passes",
    `const MESSAGES = [["JWT_SECRET", "must be set before the API starts"]];`,
    false,
  ],
  [
    "entry pair carrying a redaction marker passes",
    `const REDACTED = [["JWT_SECRET", "[redacted]"]];`,
    false,
  ],
  [
    "entry pair mapping one secret name to another passes",
    `const ALIASES = [["JWT_SECRET", "GOOGLE_CLIENT_SECRET"]];`,
    false,
  ],
  [
    "container built from filtered environment entries passes",
    `const config = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("APP_"))); export const token = config.JWT_SECRET;`,
    false,
  ],
  [
    "container spreading defaults then environment passes",
    `const defaults = {}; const config = { ...defaults, ...process.env }; export const token = config.JWT_SECRET;`,
    false,
  ],
  [
    "container spreading an empty object then environment passes",
    `const config = { ...{}, ...process.env }; export const token = config.JWT_SECRET;`,
    false,
  ],
  [
    "null-prototype container filled from the environment passes",
    `const config = Object.create(null); config.JWT_SECRET = process.env.JWT_SECRET; export const token = config.JWT_SECRET;`,
    false,
  ],
  [
    "container spreading environment alongside a literal is refused",
    `const config = { ...process.env, JWT_SECRET: "${hardcoded}" }; export const token = config.JWT_SECRET;`,
    true,
    "hardcoded JWT_SECRET object or class property",
  ],
  [
    "container created from an unknown prototype stays opaque",
    `const config = Object.create(base); export const JWT_SECRET = config.JWT_SECRET;`,
    true,
    "hardcoded JWT_SECRET variable initializer",
  ],
  [
    "comment naming a secret and a source path passes",
    `// JWT_SECRET is validated by src/config/environment.js\nexport const token = process.env.JWT_SECRET;`,
    false,
  ],
  [
    "bound entry pair with a short value is refused",
    `const table = new Map([["JWT_SECRET", "abc123XYZ0"]]); export const token = table.get("JWT_SECRET");`,
    true,
    "hardcoded JWT_SECRET secret entry pair",
  ],
  [
    "bound entry pair carrying a passphrase is refused",
    `const table = new Map([["JWT_SECRET", "correct horse battery staple"]]);`,
    true,
    "hardcoded JWT_SECRET secret entry pair",
  ],
  [
    "bound entry pair carrying a tab is refused",
    `const table = new Map([["JWT_SECRET", "s3cr3t\\tvalue1234"]]);`,
    true,
    "hardcoded JWT_SECRET secret entry pair",
  ],
  [
    "bound entry pair carrying a Buffer is refused",
    `const table = new Map([["JWT_SECRET", Buffer.from("${hardcoded}")]]);`,
    true,
    "hardcoded JWT_SECRET secret entry pair",
  ],
  [
    "secret written through a map setter is refused",
    `const table = new Map(); table.set("JWT_SECRET", "${hardcoded}");`,
    true,
    "hardcoded JWT_SECRET secret entry pair",
  ],
  [
    "unbound pair naming a legacy variable passes",
    `const ALIASES = [["JWT_SECRET", "LEGACY_JWT_SIGNING_KEY"]];`,
    false,
  ],
  [
    "unbound pair naming a source file passes",
    `const VALIDATORS = [["JWT_SECRET", "src/config/environment.js"]];`,
    false,
  ],
  [
    "unbound pair naming a docs url passes",
    `const DOCS = [["JWT_SECRET", "https://docs.example.invalid/env#jwt"]];`,
    false,
  ],
  [
    "unbound pair naming an error code passes",
    `const CODES = [["JWT_SECRET", "ERR_JWT_SECRET_MISSING"]];`,
    false,
  ],
  [
    "decorative environment mention does not disarm opacity",
    `const config = Object.create(base ?? process.env); export const JWT_SECRET = config.JWT_SECRET;`,
    true,
    "hardcoded JWT_SECRET variable initializer",
  ],
  [
    "environment entries behind a fallback stay opaque",
    `const config = Object.fromEntries(pairs || Object.entries(process.env)); export const JWT_SECRET = config.JWT_SECRET;`,
    true,
    "hardcoded JWT_SECRET variable initializer",
  ],
  [
    "container built from mapped environment entries passes",
    `const config = Object.fromEntries(Object.entries(process.env).map(([k, v]) => [k, v])); export const token = config.JWT_SECRET;`,
    false,
  ],
  [
    "class getter returning a literal is refused",
    `class Config { get JWT_SECRET() { return "${hardcoded}"; } } export const config = new Config();`,
    true,
    "hardcoded JWT_SECRET object or class property",
  ],
  [
    "static class getter returning a literal is refused",
    `class Config { static get JWT_SECRET() { return "${hardcoded}"; } }`,
    true,
    "hardcoded JWT_SECRET object or class property",
  ],
  [
    "class method returning a literal is refused",
    `class Config { JWT_SECRET() { return "${hardcoded}"; } }`,
    true,
    "hardcoded JWT_SECRET object or class property",
  ],
  [
    "class getter returning the environment passes",
    `class Config { get JWT_SECRET() { return process.env.JWT_SECRET; } } export const config = new Config();`,
    false,
  ],
  [
    "loop-written entry pair is refused",
    `const env = {}; for (const [k, v] of [["JWT_SECRET", "${hardcoded}"]]) { env[k] = v; } export const token = env.JWT_SECRET;`,
    true,
    "hardcoded JWT_SECRET secret entry pair",
  ],
  [
    "loop over a minimum length table passes",
    `const MIN = [["JWT_SECRET", 32], ["MONGODB_URI", 12]]; for (const [name, min] of MIN) { assertLength(name, min); }`,
    false,
  ],
  [
    "loop over a description table passes",
    `const D = [["JWT_SECRET", "Signing key for access tokens"]]; for (const [name, text] of D) { describe(name, text); }`,
    false,
  ],
  [
    "loop over environment entries passes",
    `const config = {}; for (const [k, v] of Object.entries(process.env)) { config[k] = v; } export const token = config.JWT_SECRET;`,
    false,
  ],
  [
    "documented connection string format passes",
    `export const shape = "mongodb+srv://<user>:<password>@cluster.example.invalid/db";`,
    false,
  ],
  [
    "credentialed connection string is refused",
    `export const uri = "mongodb+srv://svcuser:Pa55w0rdLongEnough@cluster0.abcd.mongodb.net/app";`,
    true,
    "hardcoded credentialed MongoDB URI static provider credential",
  ],
  [
    "stray angle bracket is not read as a placeholder",
    `export const uri = "mongodb://svcuser:Pa55w0rd<Long@cluster0.abcd.mongodb.net/app";`,
    true,
    "hardcoded credentialed MongoDB URI static provider credential",
  ],
  [
    "unrelated object method named call passes",
    `const api = { send: { call(target, value) { return value; } } }; api.send.call(null, process.env.JWT_SECRET);`,
    false,
  ],
  [
    "computed Reflect set of a secret-named key is refused",
    `const config = {}; Reflect["set"](config, "JWT_SECRET", "${hardcoded}");`,
    true,
    "hardcoded JWT_SECRET reflective assignment",
  ],
  [
    "globalThis-qualified Reflect set is refused",
    `const config = {}; globalThis.Reflect.set(config, "JWT_SECRET", "${hardcoded}");`,
    true,
    "hardcoded JWT_SECRET reflective assignment",
  ],
  [
    "aliased Reflect namespace set is refused",
    `const R = Reflect; const config = {}; R.set(config, "JWT_SECRET", "${hardcoded}");`,
    true,
    "hardcoded JWT_SECRET reflective assignment",
  ],
  [
    "destructured Reflect set is refused",
    `const { set } = Reflect; const config = {}; set(config, "JWT_SECRET", "${hardcoded}");`,
    true,
    "hardcoded JWT_SECRET reflective assignment",
  ],
  [
    "Object.fromEntries through an identifier is refused",
    `const entries = [["JWT_SECRET", "${hardcoded}"]]; const bag = Object.fromEntries(entries);`,
    true,
    "hardcoded JWT_SECRET reflective assignment",
  ],
  [
    "computed Reflect set from the environment passes",
    `const config = {}; Reflect["set"](config, "JWT_SECRET", process.env.JWT_SECRET);`,
    false,
  ],
  [
    "aliased Reflect namespace set from the environment passes",
    `const R = Reflect; const config = {}; R.set(config, "JWT_SECRET", process.env.JWT_SECRET);`,
    false,
  ],
  [
    "unrelated object method named set passes",
    `const store = { set(key, value) { return value; } }; store.set("JWT_SECRET", process.env.JWT_SECRET);`,
    false,
  ],
  [
    "Reflect.set of a secret-named key with a literal is refused",
    `const bag = {}; Reflect.set(bag, "JWT_SECRET", "${hardcoded}");`,
    true,
    "hardcoded JWT_SECRET reflective assignment",
  ],
  [
    "Object.defineProperty of a secret-named key with a literal is refused",
    `const bag = {}; Object.defineProperty(bag, "JWT_SECRET", { value: "${hardcoded}" });`,
    true,
    "hardcoded JWT_SECRET reflective assignment",
  ],
  [
    "Object.fromEntries with a secret-named literal entry is refused",
    `const bag = Object.fromEntries([["JWT_SECRET", "${hardcoded}"]]);`,
    true,
    "hardcoded JWT_SECRET reflective assignment",
  ],
  [
    "renamed export of a hardcoded local is refused",
    `const inner = "${hardcoded}"; export { inner as JWT_SECRET };`,
    true,
    "hardcoded JWT_SECRET renamed export",
  ],
  [
    "Reflect.set of a secret-named key from the environment passes",
    `const bag = {}; Reflect.set(bag, "JWT_SECRET", process.env.JWT_SECRET);`,
    false,
  ],
  [
    "renamed export of an environment value passes",
    `const inner = process.env.JWT_SECRET; export { inner as JWT_SECRET };`,
    false,
  ],
  [
    "Reflect.set write cannot launder a container member",
    `const runtime = {}; Reflect.set(runtime, "signingKey", "${hardcoded}"); if (process.env.JWT_SECRET) { runtime.signingKey = process.env.JWT_SECRET; } const JWT_SECRET = runtime.signingKey;`,
    true,
    "hardcoded JWT_SECRET variable initializer",
  ],
  [
    "Object.fromEntries container cannot launder a member",
    `const runtime = Object.fromEntries([["signingKey", "${hardcoded}"]]); if (process.env.JWT_SECRET) { runtime.signingKey = process.env.JWT_SECRET; } const JWT_SECRET = runtime.signingKey;`,
    true,
    "hardcoded JWT_SECRET variable initializer",
  ],
  [
    "class instance field cannot launder a container member",
    `class Cfg { constructor() { this.signingKey = "${hardcoded}"; } } const runtime = new Cfg(); if (process.env.JWT_SECRET) { runtime.signingKey = process.env.JWT_SECRET; } const JWT_SECRET = runtime.signingKey;`,
    true,
    "hardcoded JWT_SECRET variable initializer",
  ],
  [
    "multi-spread container copy cannot launder a member",
    `const a = { signingKey: "${hardcoded}" }; const b = { other: 1 }; const runtime = { ...a, ...b }; if (process.env.JWT_SECRET) { runtime.signingKey = process.env.JWT_SECRET; } const JWT_SECRET = runtime.signingKey;`,
    true,
    "hardcoded JWT_SECRET variable initializer",
  ],
  [
    "computed key write cannot launder a container member",
    `const runtime = {}; const field = "signingKey"; runtime[field] = "${hardcoded}"; if (process.env.JWT_SECRET) { runtime.signingKey = process.env.JWT_SECRET; } const JWT_SECRET = runtime.signingKey;`,
    true,
    "hardcoded JWT_SECRET variable initializer",
  ],
  [
    "array index write cannot launder a container member",
    `const runtime = { slots: [] }; runtime.slots[0] = "${hardcoded}"; if (process.env.JWT_SECRET) { runtime.slots[0] = process.env.JWT_SECRET; } const JWT_SECRET = runtime.slots[0];`,
    true,
    "hardcoded JWT_SECRET variable initializer",
  ],
  [
    "parameter-defaulted accessor passes",
    `const config = { SESSION_SECRET(fallback = process.env.JWT_SECRET) { return fallback; } };`,
    false,
  ],
  [
    "single spread environment container copy passes",
    `const base = { signingKey: process.env.JWT_SECRET }; const runtime = { ...base }; const JWT_SECRET = runtime.signingKey;`,
    false,
  ],
  [
    "environment container member read through an alias passes",
    `const config = {}; config.jwtSecret = process.env.JWT_SECRET; const alias = config.jwtSecret; const JWT_SECRET = alias;`,
    false,
  ],
  [
    "environment container member read through a function passes",
    `const config = {}; config.jwtSecret = process.env.JWT_SECRET; function read() { return config.jwtSecret; } const JWT_SECRET = read();`,
    false,
  ],
  [
    "destructuring default sourced from another environment variable passes",
    `const { JWT_SECRET = process.env.MONGO_URI } = process.env;`,
    false,
  ],
  [
    "unprovable secrets file read remains refused",
    `const JWT_SECRET = readFileSync("/run/secrets/jwt", "utf8").trim();`,
    true,
    "hardcoded JWT_SECRET variable initializer",
  ],
  [
    "getter returning a hardcoded secret is still refused",
    `const config = { get JWT_SECRET() { return "${hardcoded}"; } };`,
    true,
    "hardcoded JWT_SECRET object or class property",
  ],
  [
    "arrow thunk returning a hardcoded secret is still refused",
    `const config = { JWT_SECRET: () => "${hardcoded}" };`,
    true,
    "hardcoded JWT_SECRET object or class property",
  ],
  [
    "resolvable fallback helper returning a hardcoded secret is still refused",
    `function getFallback() { return "${hardcoded}"; } const JWT_SECRET = process.env.JWT_SECRET ?? getFallback();`,
    true,
    "hardcoded JWT_SECRET fallback",
  ],
  [
    "String.fromCharCode provider assembly is refused",
    `const apiKey = String.fromCharCode(${[...`${resendPrefix}${resendSuffix}`].map((character) => character.codePointAt(0)).join(", ")});`,
    true,
    "hardcoded Resend API key static provider credential",
  ],
  [
    "spread String.fromCharCode provider assembly is refused",
    `const codes = [${[...`${resendPrefix}${resendSuffix}`].map((character) => character.codePointAt(0)).join(", ")}]; const apiKey = String.fromCharCode(...codes);`,
    true,
    "hardcoded Resend API key static provider credential",
  ],
  [
    "Buffer.from byte array provider assembly is refused",
    `const apiKey = Buffer.from([${[...`${resendPrefix}${resendSuffix}`].map((character) => character.codePointAt(0)).join(", ")}]).toString("utf8");`,
    true,
    "hardcoded Resend API key static provider credential",
  ],
  [
    "mapped fromCharCode provider assembly is refused",
    `const apiKey = [${[...`${resendPrefix}${resendSuffix}`].map((character) => character.codePointAt(0)).join(", ")}].map((code) => String.fromCharCode(code)).join("");`,
    true,
    "hardcoded Resend API key static provider credential",
  ],
  [
    "non-credential character code assembly passes",
    `const label = String.fromCharCode(67, 65, 32, 80, 82, 79);`,
    false,
  ],
  [
    "dynamic character code assembly passes",
    `const apiKey = String.fromCharCode(...process.env.RESEND_CODES.split(",").map(Number));`,
    false,
  ],
  [
    "provider array literal spread assembly is refused",
    `const prefix = ["${resendPrefix}"]; const parts = [...prefix, "${resendSuffix}"]; const apiKey = parts.join("");`,
    true,
    "hardcoded Resend API key static provider credential",
  ],
  [
    "incomplete mutable provider spread assembly passes",
    `const parts = []; parts.push(...["${resendPrefix}", "short"]); const apiKey = parts.join("");`,
    false,
  ],
  [
    "incomplete provider array literal spread assembly passes",
    `const prefix = ["${resendPrefix}"]; const parts = [...prefix, "short"]; const apiKey = parts.join("");`,
    false,
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
    "package manifest environment input is refused",
    `const signingKey = process.env.npm_package_config_JWT_SECRET;`,
    true,
    "hardcoded npm_package_config_JWT_SECRET manifest-controlled environment reference",
  ],
  [
    "destructured package manifest environment input is refused",
    `const { npm_package_config_JWT_SECRET: signingKey } = process.env;`,
    true,
    "hardcoded npm_package_config_JWT_SECRET manifest-controlled environment reference",
  ],
  [
    "Reflect package manifest environment input is refused",
    `const signingKey = Reflect.get(process.env, "npm_package_config_JWT_SECRET");`,
    true,
    "hardcoded npm_package_config_JWT_SECRET manifest-controlled environment reference",
  ],
  [
    "destructured ordinary runtime environment input passes",
    `const { JWT_SECRET: signingKey } = process.env;`,
    false,
  ],
  [
    "Reflect ordinary runtime environment input passes",
    `const signingKey = Reflect.get(process.env, "JWT_SECRET");`,
    false,
  ],
  [
    "ordinary runtime environment input passes",
    `const signingKey = process.env.JWT_SECRET;`,
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

// A script block the browser will not execute is still shipped in the file, so
// its body is offered to the scanner. Because such a block legitimately carries
// a template rather than JavaScript, a parse failure has to mean there is
// nothing to scan; without that, extracting the block at all would turn every
// templated page into a refusal. What must not change is that a real secret
// inside such a block is still found.
function scanTaggedSource(name, source, parseOptional, shouldReject) {
  const result = runScanner({
    mode: "javascript-fixtures",
    files: [{ parseOptional, path: `${name.replaceAll(" ", "-")}.js`, source }],
    secretNames,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const refusalLines = output
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("REFUSED: "));
  record(
    name,
    shouldReject
      ? result.status !== 0 && !result.error && refusalLines.length === 1
      : result.status === 0 && refusalLines.length === 0,
    result,
  );
}

const templateBody = "{{# each items }} <<< {{/ each }}";
scanTaggedSource(
  "unparsable non-executable block is skipped",
  templateBody,
  true,
  false,
);
scanTaggedSource(
  "unparsable executable block is still refused",
  templateBody,
  false,
  true,
);
scanTaggedSource(
  "secret inside a non-executable block is still refused",
  `const v = "${hardcoded}"; const JWT_SECRET = v;`,
  true,
  true,
);
record(
  "non-boolean parseOptional is rejected",
  (() => {
    const result = runScanner({
      mode: "javascript-fixtures",
      files: [
        { parseOptional: "yes", path: "tagged.js", source: "const a=1;" },
      ],
      secretNames,
    });
    return (
      result.status !== 0 &&
      `${result.stdout ?? ""}${result.stderr ?? ""}`.includes(
        "contains an invalid file",
      )
    );
  })(),
);

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
  config: { JWT_SECRET: hardcoded },
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
  [
    "matching optional root reaches graph range validation",
    mutateJson(packageJsonSource, (manifest) => {
      manifest.optionalDependencies = { accepts: "^999.0.0" };
    }),
    mutateJson(packageLockSource, (manifest) => {
      manifest.packages[""].optionalDependencies = {
        accepts: "^999.0.0",
      };
    }),
    true,
    "runtime dependency does not satisfy package.json: accepts",
  ],
  [
    "matching peer root reaches graph range validation",
    mutateJson(packageJsonSource, (manifest) => {
      manifest.peerDependencies = { accepts: "^999.0.0" };
    }),
    mutateJson(packageLockSource, (manifest) => {
      manifest.packages[""].peerDependencies = { accepts: "^999.0.0" };
    }),
    true,
    "runtime dependency does not satisfy package.json: accepts",
  ],
  [
    "matching optional root reaches classification validation",
    mutateJson(packageJsonSource, (manifest) => {
      manifest.optionalDependencies = { accepts: "1.3.8" };
    }),
    mutateJson(packageLockSource, (manifest) => {
      manifest.packages[""].optionalDependencies = { accepts: "1.3.8" };
      manifest.packages["node_modules/accepts"].dev = true;
    }),
    true,
    "runtime-reachable package is classified as development-only: node_modules/accepts",
  ],
  [
    "matching peer root reaches classification validation",
    mutateJson(packageJsonSource, (manifest) => {
      manifest.peerDependencies = { accepts: "1.3.8" };
    }),
    mutateJson(packageLockSource, (manifest) => {
      manifest.packages[""].peerDependencies = { accepts: "1.3.8" };
      manifest.packages["node_modules/accepts"].dev = true;
    }),
    true,
    "runtime-reachable package is classified as development-only: node_modules/accepts",
  ],
  [
    "matching optional root preserves independent optional edge checks",
    mutateJson(packageJsonSource, (manifest) => {
      manifest.optionalDependencies = { accepts: "1.3.8" };
    }),
    mutateJson(packageLockSource, (manifest) => {
      manifest.packages[""].optionalDependencies = { accepts: "1.3.8" };
      manifest.packages["node_modules/accepts"].optionalDependencies = {
        "mime-types": "^999.0.0",
      };
    }),
    true,
    "optionalDependencies dependency mime-types does not satisfy node_modules/accepts",
  ],
  [
    "matching peer root preserves independent peer edge checks",
    mutateJson(packageJsonSource, (manifest) => {
      manifest.peerDependencies = { accepts: "1.3.8" };
    }),
    mutateJson(packageLockSource, (manifest) => {
      manifest.packages[""].peerDependencies = { accepts: "1.3.8" };
      manifest.packages["node_modules/accepts"].peerDependencies = {
        "mime-types": "^999.0.0",
      };
    }),
    true,
    "peerDependencies dependency mime-types does not satisfy node_modules/accepts",
  ],
  [
    "matching optional root reaches reachability validation",
    mutateJson(packageJsonSource, (manifest) => {
      manifest.optionalDependencies = { "optional-root-probe": "1.3.8" };
    }),
    mutateJson(packageLockSource, (manifest) => {
      manifest.packages[""].optionalDependencies = {
        "optional-root-probe": "1.3.8",
      };
      const source = manifest.packages["node_modules/accepts"];
      manifest.packages["node_modules/optional-root-probe"] = {
        ...source,
        resolved:
          "https://registry.npmjs.org/optional-root-probe/-/optional-root-probe-1.3.8.tgz",
      };
      manifest.packages["node_modules/unreachable-optional-probe"] = {
        ...source,
        resolved:
          "https://registry.npmjs.org/unreachable-optional-probe/-/unreachable-optional-probe-1.3.8.tgz",
      };
    }),
    true,
    "contains an unreachable package entry: node_modules/unreachable-optional-probe",
  ],
  [
    "matching peer root reaches reachability validation",
    mutateJson(packageJsonSource, (manifest) => {
      manifest.peerDependencies = { "peer-root-probe": "1.3.8" };
    }),
    mutateJson(packageLockSource, (manifest) => {
      manifest.packages[""].peerDependencies = {
        "peer-root-probe": "1.3.8",
      };
      const source = manifest.packages["node_modules/accepts"];
      manifest.packages["node_modules/peer-root-probe"] = {
        ...source,
        resolved:
          "https://registry.npmjs.org/peer-root-probe/-/peer-root-probe-1.3.8.tgz",
      };
      manifest.packages["node_modules/unreachable-peer-probe"] = {
        ...source,
        resolved:
          "https://registry.npmjs.org/unreachable-peer-probe/-/unreachable-peer-probe-1.3.8.tgz",
      };
    }),
    true,
    "contains an unreachable package entry: node_modules/unreachable-peer-probe",
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
    "unapproved package manifest metadata is refused",
    mutateJson(packageJsonSource, (manifest) => {
      manifest.publishConfig = { access: "private" };
    }),
    packageLockSource,
    true,
    "unsupported manifest field: publishConfig",
  ],
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
    "unsupported semver OR alternative is refused before digest validation",
    packageJsonSource,
    mutateJson(packageLockSource, (manifest) => {
      manifest.packages["node_modules/express"].dependencies.accepts =
        "~1.3.8 || git+https://example.invalid/accepts.git";
    }),
    true,
    "package-lock.json node_modules/express dependencies.accepts contains an unsupported dependency range: git+https://example.invalid/accepts.git",
  ],
  [
    "empty semver OR alternative is refused before digest validation",
    packageJsonSource,
    mutateJson(packageLockSource, (manifest) => {
      manifest.packages["node_modules/express"].dependencies.accepts =
        "~1.3.8 || ";
    }),
    true,
    "package-lock.json node_modules/express dependencies.accepts contains an empty dependency range alternative",
  ],
  [
    "missing optional dependency edge is refused before digest validation",
    packageJsonSource,
    mutateJson(packageLockSource, (manifest) => {
      manifest.packages["node_modules/accepts"].optionalDependencies = {
        "missing-optional-probe": "1.0.0",
      };
    }),
    true,
    "is missing optionalDependencies dependency missing-optional-probe required by node_modules/accepts",
  ],
  [
    "development-only package without dev classification is refused",
    packageJsonSource,
    mutateJson(packageLockSource, (manifest) => {
      delete manifest.packages["node_modules/acorn"].dev;
    }),
    true,
    "development-only package lacks a development classification: node_modules/acorn",
  ],
  [
    "invalid package JSON is refused",
    packageJsonSource.replace(/\n}\s*$/, ",\n}"),
    packageLockSource,
    true,
    "package.json is not strict JSON",
  ],
  [
    "package-lock mismatch is refused",
    packageJsonSource.replace(
      '"compression": "^1.8.1"',
      '"compression": "^1.8.2"',
    ),
    packageLockSource,
    true,
    "package-lock.json root dependencies.compression differs from package.json",
  ],
  [
    "mutable dependency source is refused",
    packageJsonSource.replace(
      '"compression": "^1.8.1"',
      '"compression": "github:user/repo#main"',
    ),
    packageLockSource,
    true,
    "package.json contains a mutable dependency source: compression",
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
    "runtime dependency does not satisfy package.json: compression",
  ],
  [
    "direct dependency tarball substitution is refused",
    packageJsonSource,
    mutateJson(packageLockSource, (manifest) => {
      manifest.packages["node_modules/acorn"].resolved =
        "https://registry.npmjs.org/not-acorn/-/not-acorn-8.18.0.tgz";
    }),
    true,
    "package tarball does not match its path: node_modules/acorn",
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
    "package tarball does not match its path: node_modules/accepts",
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
    "contains an untrusted package entry: node_modules/compression",
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
    "contains an untrusted package entry: node_modules/compression",
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
    "contains an untrusted package entry: node_modules/acorn",
  ],
  [
    "missing transitive lock entry is refused",
    packageJsonSource,
    mutateJson(packageLockSource, (manifest) => {
      delete manifest.packages["node_modules/accepts"];
    }),
    true,
    "is missing dependencies dependency accepts required by node_modules/express",
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

const expectedManifestReasonByName = new Map([
  [
    "overlapping optional root dependency is refused",
    "package.json declares compression in both dependencies and optionalDependencies",
  ],
  [
    "orphan root peer metadata is refused",
    "package.json.peerDependenciesMeta.missing does not identify a peer dependency",
  ],
  [
    "matching optional root reaches graph range validation",
    "package-lock.json runtime dependency does not satisfy package.json: accepts",
  ],
  [
    "matching peer root reaches graph range validation",
    "package-lock.json runtime dependency does not satisfy package.json: accepts",
  ],
  [
    "matching optional root reaches classification validation",
    "package-lock.json runtime-reachable package is classified as development-only: node_modules/accepts",
  ],
  [
    "matching peer root reaches classification validation",
    "package-lock.json runtime-reachable package is classified as development-only: node_modules/accepts",
  ],
  [
    "matching optional root preserves independent optional edge checks",
    "package-lock.json optionalDependencies dependency mime-types does not satisfy node_modules/accepts",
  ],
  [
    "matching peer root preserves independent peer edge checks",
    "package-lock.json peerDependencies dependency mime-types does not satisfy node_modules/accepts",
  ],
  [
    "matching optional root reaches reachability validation",
    "package-lock.json contains an unreachable package entry: node_modules/unreachable-optional-probe",
  ],
  [
    "matching peer root reaches reachability validation",
    "package-lock.json contains an unreachable package entry: node_modules/unreachable-peer-probe",
  ],
  ...Object.keys(unsupportedManifestFieldValues).map((field) => [
    `unsupported root ${field} is refused`,
    `package.json contains unsupported install field: ${field}`,
  ]),
  [
    "unapproved package manifest metadata is refused",
    "package.json contains unsupported manifest field: publishConfig",
  ],
  [
    // The digest here is the one the MUTATED fixture produces, so it moves whenever the real
    // package-lock.json moves - it did on 2026-09-09 for the morgan/body-parser/multer security
    // bumps. The mutation and the reason it is refused are unchanged: swapping one transitive
    // package's integrity for another's is still caught, and still caught by the trusted-lock
    // digest rather than by a narrower check, which is the point this row makes.
    "valid-length transitive integrity substitution is refused",
    "package-lock.json canonical SHA-256 does not match the trusted lock (6f1a1a7465d094bf519a8429cdd5150b83b7468c234724837de5b7e891be803a)",
  ],
  [
    "runtime package classified as development-only is refused",
    "package-lock.json runtime-reachable package is classified as development-only: node_modules/compression",
  ],
  [
    "conflicting duplicate peer range is refused",
    "package-lock.json peerDependencies dependency mime-types does not satisfy node_modules/accepts",
  ],
  [
    // Same as above: the mutated fixture's digest moved with the base lock on 2026-09-09. Widening
    // a transitive range to "*" is still refused, and still by the digest check.
    "widened transitive dependency range is refused",
    "package-lock.json canonical SHA-256 does not match the trusted lock (5acab20303b69d577c2dd57b9ae9b0b6d90a3b6234ab5994286be0275abad845)",
  ],
  [
    "unsupported semver OR alternative is refused before digest validation",
    "node_modules/express -> accepts contains an unsupported dependency range: git+https://example.invalid/accepts.git",
  ],
  [
    "empty semver OR alternative is refused before digest validation",
    "node_modules/express -> accepts contains an empty dependency range alternative",
  ],
  [
    "missing optional dependency edge is refused before digest validation",
    "package-lock.json is missing optionalDependencies dependency missing-optional-probe required by node_modules/accepts",
  ],
  [
    "development-only package without dev classification is refused",
    "package-lock.json development-only package lacks a development classification: node_modules/acorn",
  ],
  [
    "invalid package JSON is refused",
    "package.json is not strict JSON: Expected double-quoted property name in JSON at position 797 (line 34 column 1)",
  ],
  [
    "incompatible direct lock version is refused",
    "package-lock.json runtime dependency does not satisfy package.json: compression",
  ],
  [
    "direct dependency tarball substitution is refused",
    "package-lock.json package tarball does not match its path: node_modules/acorn",
  ],
  [
    "transitive package tarball substitution is refused",
    "package-lock.json package tarball does not match its path: node_modules/accepts",
  ],
  [
    "transitive dependency range mismatch is refused",
    "package-lock.json dependencies dependency mime-types does not satisfy node_modules/accepts",
  ],
  [
    "prerelease direct version is refused",
    "package-lock.json contains an untrusted package entry: node_modules/compression",
  ],
  [
    "leading-zero direct version is refused",
    "package-lock.json contains an untrusted package entry: node_modules/compression",
  ],
  [
    "unreachable lock entry is refused",
    "package-lock.json contains an unreachable package entry: node_modules/unreachable-package",
  ],
  [
    "short lock integrity is refused",
    "package-lock.json contains an untrusted package entry: node_modules/acorn",
  ],
  [
    "missing transitive lock entry is refused",
    "package-lock.json is missing dependencies dependency accepts required by node_modules/express",
  ],
  [
    "prestart lifecycle script is refused",
    "package.json contains forbidden lifecycle script: prestart",
  ],
  [
    "poststart lifecycle script is refused",
    "package.json contains forbidden lifecycle script: poststart",
  ],
  [
    "install lifecycle script is refused",
    "package.json contains forbidden lifecycle script: postinstall",
  ],
]);

for (const [
  name,
  packageJson,
  packageLock,
  shouldReject,
  expectedReason,
] of manifestCases) {
  const result = runScanner({
    mode: "archive",
    files: [],
    secretNames,
    manifests: { packageJson, packageLock },
  });
  const rejected = result.status !== 0 && !result.error;
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const refusalLines = output
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("REFUSED: "));
  const exactExpectedReason =
    expectedManifestReasonByName.get(name) ?? expectedReason;
  const expectedRefusal =
    typeof exactExpectedReason === "string" &&
    exactExpectedReason.trim().length > 0
      ? `REFUSED: ${exactExpectedReason}`
      : null;
  record(
    name,
    shouldReject
      ? rejected &&
          expectedRefusal !== null &&
          refusalLines.length === 1 &&
          refusalLines[0] === expectedRefusal
      : result.status === 0 &&
          refusalLines.length === 0 &&
          expectedReason === undefined,
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
  // The count is pinned so a new runtime file cannot appear unscanned and
  // unnoticed. Raised from 148 to 150 for the index provisioning service and its
  // command-line wrapper, added as the production index-management step. Raised
  // from 150 to 151 for src/data/audit-topic-reference.js, added by commit
  // c195087 alongside the redesigned insights prompt; that commit updated
  // tools/run-gates.ps1 with its two new suites but missed this pin, so the gate
  // ran green locally (git ls-files legitimately reported 151) while this
  // assertion silently compared against the stale 150 until a full run-gates.ps1
  // pass caught the mismatch. Raised from 151 to 152 for
  // src/services/data-retention.service.js, added in commit 716f559 without this
  // pin being updated alongside it - the same class of drift as the 150-to-151
  // case above, caught the same way: a full run-gates.ps1 pass, not the file's
  // own commit. Raised from 152 to 153 for public/unsubscribe.js, added in
  // commit fcf2a25 (digest one-click unsubscribe) alongside public/unsubscribe
  // .html (not matched by the .cjs/.js/.mjs filter, so it does not count) --
  // same drift class as every prior entry above, caught the same way: running
  // this suite directly rather than assuming a prior green run-gates.ps1 pass
  // was current. Raised from 153 to 158 for the 5 files added in commit
  // 1d4f4b0 (statutory date parsing, desktop-release/update routes, provider
  // metering, engagement-reviewer relaxation, ops tooling): src/middleware/
  // client-version.middleware.js and rate-limit.middleware.js, src/models/
  // ProviderUsage.js, src/services/desktop-release.service.js and provider-
  // usage-index-readiness.service.js -- identified via `git log --diff-filter=A
  // --name-only fcf2a25..HEAD -- src public`, and independently re-scanned in
  // isolation (`node tools/scan-deploy-secrets.mjs`, mode javascript-fixtures,
  // all 158 current files) confirming `status: 0` before raising the pin --
  // the same drift class as every prior entry above, not a new failure mode.
  // Raised from 158 to 161 for the 3 files added by L12's erasure cascade:
  // src/models/ErasureReceipt.js, src/services/erasure-classification.js and
  // src/services/firm-erasure.service.js -- identified with `git log
  // --diff-filter=A --name-only 1d4f4b0..HEAD -- src public`, and the scan
  // itself independently confirmed clean over all 161 before the pin moved
  // (`make-deploy-archive.ps1 -ValidateOnly` -> "JavaScript secret AST scan:
  // PASS (161 files)"). Same drift class again, and caught the same way: a full
  // run-gates.ps1 pass, not the commit that added the files. Worth noting the
  // pin is doing its job -- it is deliberately a COUNT, so a new runtime file
  // cannot enter the deploy surface without a human confirming it was scanned.
  // Raised from 161 to 162 for src/utils/user-facing-error.js, added by the
  // V13-P12-F2 fix (telling a message written for a user apart from the text of
  // an accident, so exception text stops reaching a firm through a 200 OK body).
  // Caught exactly as designed and exactly as every entry above was: not by the
  // commit that added the file, but by running this suite -- in this case the
  // first run of the Mongo-dependent suites after standing up a local mongod,
  // the 23 of them having been blocked for several sessions. Confirmed clean
  // before the pin moved, independently of this file: `make-deploy-archive.ps1
  // -ValidateOnly` -> "JavaScript secret AST scan: PASS (162 files)". The new
  // file holds no configuration of any kind -- it is one factory and two
  // predicates -- so it is the least interesting possible member of the scanned
  // set, which is precisely why the count and not a judgement call is what
  // guards the surface.
  // Raised from 162 to 163 for src/services/reminder-delivery-alert.service.js,
  // added by T3 (.kiro/PLAN.md) -- a 15-minute scheduler that reuses T1's
  // deliveryHealth classification and emails the owner via the existing Resend
  // integration when the fleet-wide failed-delivery count crosses a threshold.
  // Confirmed clean before the pin moved, independently of this file:
  // `make-deploy-archive.ps1 -ValidateOnly` -> "JavaScript secret AST scan: PASS
  // (163 files)". No secret, credential, or external endpoint of any kind in the
  // new file -- it reads Reminder/AppConfig documents and calls an
  // injected sendAlertEmail callback; the actual Resend call lives in the
  // already-scanned email.service.js, unchanged in shape by this addition.
  // Raised from 163 to 164 for src/services/import-shape.service.js, added so
  // an uploaded register's shape is settled before any value is read from it:
  // which row is the header, which columns are real, which rows are not
  // records. Caught exactly as designed and exactly as every entry above was
  // -- not by the commit that added the file, but by a full run-gates.ps1
  // pass, in this case while a deploy was being staged, which the pin
  // correctly refused. Confirmed clean before the pin moved, independently of
  // this file: `make-deploy-archive.ps1 -ValidateOnly` -> "JavaScript secret
  // AST scan: PASS (164 files)". The new file holds no secret, credential,
  // configuration or external endpoint of any kind -- it is pure table
  // geometry over an array of arrays, and it takes its one dictionary from
  // the already-scanned robust-normalize.service.js rather than carrying a
  // copy, so it adds no new data to the scanned surface either.
  // Raised from 164 to 165 for src/services/audit-numerical-integrity.service.js,
  // added to close AA-02 (.kiro/audit-assistance-defects.md): it reconciles the
  // itemised amounts in submitted audit text against a stated aggregate, so a
  // population that does not add up is flagged before any procedure is
  // performed on it. Caught exactly as designed and exactly as every entry
  // above was -- not by the commit that added the file, but by a full
  // run-gates.ps1 pass immediately afterwards, which the pin correctly refused.
  // Confirmed clean before the pin moved, independently of this file:
  // `make-deploy-archive.ps1 -ValidateOnly` -> "JavaScript secret AST scan:
  // PASS (165 files)". The new file holds no secret, credential, configuration
  // or external endpoint of any kind -- it is arithmetic and regular
  // expressions over a string, reads no environment variable and makes no
  // network or database call, so it adds nothing to the scanned surface beyond
  // its own arithmetic.
  // Raised from 165 to 168 for three services added to close AA-01, AA-03 and
  // AA-04/AA-26 (.kiro/audit-assistance-defects.md):
  // src/services/audit-coverage.service.js accounts for which parts of a
  // submitted document a review actually reached, so an incomplete answer
  // cannot ship silently; src/services/audit-contradiction.service.js finds
  // statements in one document that cannot both hold, and quotes both rather
  // than resolving the conflict; src/services/audit-finding-guard.service.js
  // stops a finding asserting a misstatement and stops a fabricated standard
  // reference reaching the reader. Caught exactly as designed and exactly as
  // every entry above was -- not by the commits that added the files, but by
  // the full run-gates.ps1 pass immediately afterwards, which the pin
  // correctly refused. Confirmed clean before the pin moved, independently of
  // this file: `make-deploy-archive.ps1 -ValidateOnly` -> "JavaScript secret
  // AST scan: PASS (168 files)". None of the three holds a secret, credential,
  // configuration value or external endpoint: all three are regular
  // expressions and string arithmetic over text passed in by the caller, none
  // reads an environment variable, and none makes a network or database call,
  // so they add nothing to the scanned surface beyond their own logic.
  // Raised from 173 to 174 for src/services/audit-linking.service.js, added to close
  // AA-11, AA-12 and AA-18: it names the sub-populations a document's own wording
  // divides, with the residual stated explicitly, and links findings that are the same
  // problem seen twice. Confirmed clean before the pin moved, independently of this
  // file: `make-deploy-archive.ps1 -ValidateOnly` -> "JavaScript secret AST scan: PASS
  // (174 files)". Pattern matching over caller-supplied text; no environment variable,
  // no network or database call, no secret, credential, configuration value or endpoint.
  // Raised from 172 to 173 for src/services/audit-reasoning.service.js, added to
  // close AA-05, AA-15, AA-23, AA-24 and AA-25: it supplies the question that must be
  // answered before a treatment follows, the escalation ladder for a refusal, the fraud
  // triangle with its missing legs named, the eight estimate dimensions, and the
  // alternative-procedure branch for an unanswered confirmation. Confirmed clean before
  // the pin moved, independently of this file: `make-deploy-archive.ps1 -ValidateOnly`
  // -> "JavaScript secret AST scan: PASS (173 files)". Pattern matching over
  // caller-supplied text; no environment variable, no network or database call, no
  // secret, credential, configuration value or endpoint.
  // Raised from 171 to 172 for src/services/audit-aggregation.service.js, added to
  // close AA-13, AA-16 and AA-17: it classifies post-reporting-date events three ways,
  // accumulates individually-small amounts against materiality, and states why an item
  // survives a purely quantitative filter. Confirmed clean before the pin moved,
  // independently of this file: `make-deploy-archive.ps1 -ValidateOnly` ->
  // "JavaScript secret AST scan: PASS (172 files)". Pattern matching and arithmetic
  // over caller-supplied values; no environment variable, no network or database call,
  // no secret, credential, configuration value or endpoint.
  // Raised from 170 to 171 for src/services/audit-finding-model.service.js, added
  // to close AA-09: it builds the structured finding object the caller's schema
  // asked for and renders the reader-facing text back out of it, so a finding is
  // data rather than a paragraph. Confirmed clean before the pin moved,
  // independently of this file: `make-deploy-archive.ps1 -ValidateOnly` ->
  // "JavaScript secret AST scan: PASS (171 files)". It is pattern matching and
  // object construction over values passed in by the caller; it reads no
  // environment variable, makes no network or database call, and holds no secret,
  // credential, configuration value or endpoint.
  // Raised from 169 to 170 for src/services/audit-materiality.service.js, added to close
  // AA-07: it names the quantitative bases a document supplies with their figures and the
  // inputs still missing before a materiality figure can be set, replacing a placeholder
  // that would have read identically on a blank page. It never names a percentage.
  // Confirmed clean before the pin moved, independently of this file:
  // `make-deploy-archive.ps1 -ValidateOnly` -> "JavaScript secret AST scan: PASS (170
  // files)". It is regular expressions and arithmetic over a caller-supplied string,
  // reads no environment variable, makes no network or database call, and reuses the
  // already-scanned amount parser rather than carrying its own copy.
  // Raised from 168 to 169 for src/services/audit-injection.service.js, added to close the
  // injection half of AA-06 (.kiro/audit-assistance-defects.md): it finds text inside a
  // submitted document that is addressed to the review tool rather than describing the
  // client, and reports it rather than filtering it out, because a working paper carrying
  // directions to an automated reviewer is itself evidence about the engagement. Caught by
  // the pin exactly as the four entries above were. Confirmed clean before the pin moved,
  // independently of this file: `make-deploy-archive.ps1 -ValidateOnly` -> "JavaScript
  // secret AST scan: PASS (169 files)". The file is regular expressions over a string
  // passed in by the caller; it reads no environment variable, makes no network or
  // database call, and holds no secret, credential, configuration value or endpoint.
  // Raised from 174 to 179 for the five files of the firm invitation feature:
  // src/models/FirmInvite.js, src/services/firm-authority.service.js,
  // src/services/firm-invite.service.js, src/services/firm-admission.service.js and
  // src/controllers/firm-invite.controller.js. Caught by the pin exactly as the entries
  // above were. Confirmed clean before the pin moved, independently of this file:
  // `make-deploy-archive.ps1 -ValidateOnly` -> "JavaScript secret AST scan: PASS (179
  // files)".
  //
  // Worth stating precisely what these five hold, since one of them generates an
  // admission credential. FirmInvite.generateCode reads crypto.randomBytes and an
  // alphabet constant; the code it produces is stored per row, never a configuration
  // value and never in source. The only environment variable any of them reads is
  // FIRM_INVITE_BASE_URL, a public https origin for a share link, and it is read through
  // an injected `env` parameter that defaults to process.env rather than at module scope.
  // None of them makes a network call, none holds a secret, credential or endpoint, and
  // the controller deliberately never names the account-level FIRM_ADMIN grant at all.
  // Raised from 179 to 181 for the two files of the reporting-tree and adoption work:
  // src/services/firm-org.service.js and src/controllers/firm-org.controller.js. Caught by the
  // pin, as every entry above was. Confirmed clean before the pin moved, independently of this
  // file: `make-deploy-archive.ps1 -ValidateOnly` -> "JavaScript secret AST scan: PASS (181
  // files)".
  //
  // What the two hold: firm-org.service.js is pure graph and arithmetic over rows handed in -- a
  // cycle check, a tree builder and a day count -- with no import of any model, no environment
  // variable and no clock it does not receive as a parameter. firm-org.controller.js reads
  // FirmMembership, User and Task, and runs two aggregations both scoped to req.user's firm; it
  // holds no secret, credential, endpoint or configuration value, and it writes exactly one field
  // (reportsToUserId) and never User.role.
  record(
    `all ${files.length} tracked runtime JavaScript files pass`,
    files.length === 181 && result.status === 0,
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

// ---------------------------------------------------------------------------
// The deploy archive must not REMAIN publicly downloadable after a build.
//
// On 2026-09-08 a real deploy left the whole backend source at
// https://api.caprotoolkit.in/capro-backend.zip - 835,325 bytes, unauthenticated. The archive has
// to be in the domain's served document root for the build to read it (an archive outside it
// cannot be resolved: the settings endpoint answers 404), and the file service exposes no delete
// (TUS DELETE in all three shapes answers 404). So the archive is necessarily public for the
// length of one build, and what must be guaranteed is that it is not public afterwards.
//
// hostinger-deploy-backend.mjs now overwrites the path and then asserts what is served. These
// tests cover the predicate that assertion uses. They are offline and deterministic on purpose:
// the live check can only run against production, so the decision logic is pinned here where it
// runs on every gate.
// ---------------------------------------------------------------------------

const realArchiveBytes = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.alloc(900_000, 7),
]);
const realArchiveSha = sha256Hex(realArchiveBytes);

record(
  "a body starting with the PK zip signature is exposure",
  classifyServedArchive({
    bytes: realArchiveBytes,
    status: 200,
    archiveSha256: realArchiveSha,
    createHash,
  }).safe === false,
);

record(
  "PK is caught even when the archive hash is unknown to the checker",
  classifyServedArchive({
    bytes: Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    status: 200,
    archiveSha256: null,
    createHash,
  }).safe === false,
);

record(
  "a body byte-identical to the deployed archive is exposure even without PK",
  (() => {
    // Deliberately SMALL - under MAX_SAFE_BODY_BYTES and with no PK signature - so neither the
    // size ceiling nor the signature check can account for the refusal. Only identity can. The
    // first version of this test used a 6 KB body, which the ceiling already refused, so deleting
     // the identity comparison altogether still passed.
    const disguised = Buffer.concat([Buffer.from("XX"), Buffer.alloc(120, 3)]);
    const verdict = classifyServedArchive({
      bytes: disguised,
      status: 200,
      archiveSha256: sha256Hex(disguised),
      createHash,
    });
    return (
      disguised.length < MAX_SAFE_BODY_BYTES &&
      verdict.safe === false &&
      verdict.reason.includes("identical")
    );
  })(),
);

record(
  "the size ceiling is small enough to be worth having",
  // Pinned as an ABSOLUTE bound. The refusal test below uses a real archive size rather than
  // MAX_SAFE_BODY_BYTES + 1, because a threshold-relative test keeps passing however far the
  // threshold is raised - raising it to 100 MB left every test green.
  MAX_SAFE_BODY_BYTES <= 65_536,
);

record(
  "a body the size of the real archive is refused",
  classifyServedArchive({
    // 835,325 bytes is the size of the archive that was actually exposed on 2026-09-08. No PK, and
    // a hash the checker does not know, so only the ceiling can refuse it.
    bytes: Buffer.alloc(835_325, 65),
    status: 200,
    archiveSha256: null,
    createHash,
  }).safe === false,
);

record(
  "a large unrecognised body fails closed rather than passing",
  classifyServedArchive({
    bytes: Buffer.alloc(MAX_SAFE_BODY_BYTES + 1, 65),
    status: 200,
    archiveSha256: realArchiveSha,
    createHash,
  }).safe === false,
);

record(
  "the placeholder the deploy writes is accepted",
  classifyServedArchive({
    bytes: Buffer.from(PLACEHOLDER_BODY, "utf8"),
    status: 200,
    archiveSha256: realArchiveSha,
    createHash,
  }).safe === true,
);

record(
  "the placeholder carries no PK signature",
  PLACEHOLDER_BODY.charCodeAt(0) !== 0x50 || PLACEHOLDER_BODY.charCodeAt(1) !== 0x4b,
);

record(
  "a path that is not served at all is the best outcome, not a failure",
  classifyServedArchive({ bytes: null, status: 404, archiveSha256: realArchiveSha, createHash }).safe === true &&
    classifyServedArchive({ bytes: null, status: 403, archiveSha256: realArchiveSha, createHash }).safe === true,
);

record(
  "every refusal states a reason",
  [
    { bytes: realArchiveBytes, status: 200 },
    { bytes: Buffer.alloc(MAX_SAFE_BODY_BYTES + 1, 1), status: 200 },
  ].every((input) => {
    const verdict = classifyServedArchive({ ...input, archiveSha256: realArchiveSha, createHash });
    return verdict.safe === false && typeof verdict.reason === "string" && verdict.reason.length > 0;
  }),
);

record(
  "the live assertion throws when the served body is the archive",
  await (async () => {
    // The fetch is injected, so the refusal path is exercised without touching production.
    try {
      await assertArchivePathNotExposed({
        domain: "example.invalid",
        remotePath: "capro-backend.zip",
        archiveSha256: realArchiveSha,
        createHash,
        fetchImpl: async () => ({
          status: 200,
          ok: true,
          arrayBuffer: async () => realArchiveBytes,
        }),
      });
      return false;
    } catch (err) {
      return String(err).includes("STILL PUBLIC");
    }
  })(),
);

record(
  "the live assertion refuses to pass when it cannot run at all",
  await (async () => {
    // A network failure is an unproven claim, not a clean bill of health.
    try {
      await assertArchivePathNotExposed({
        domain: "example.invalid",
        remotePath: "capro-backend.zip",
        archiveSha256: realArchiveSha,
        createHash,
        fetchImpl: async () => {
          throw new Error("network down");
        },
      });
      return false;
    } catch (err) {
      return String(err).includes("could not run");
    }
  })(),
);

record(
  "the live assertion accepts a neutralised path",
  await (async () => {
    const body = Buffer.from(PLACEHOLDER_BODY, "utf8");
    const result = await assertArchivePathNotExposed({
      domain: "example.invalid",
      remotePath: "capro-backend.zip",
      archiveSha256: realArchiveSha,
      createHash,
      fetchImpl: async () => ({ status: 200, ok: true, arrayBuffer: async () => body }),
    });
    return result.bytes === body.length;
  })(),
);

console.log(`Result: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
