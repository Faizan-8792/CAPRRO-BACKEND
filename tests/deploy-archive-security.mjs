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
    "valid-length transitive integrity substitution is refused",
    "package-lock.json canonical SHA-256 does not match the trusted lock (924125352518de566a0820d264777d4daf1720d50ee9d592cc70a185b57fc5df)",
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
    "widened transitive dependency range is refused",
    "package-lock.json canonical SHA-256 does not match the trusted lock (afa194d84c35b8cdb6ea1d44655f78e1cbabc3a82cf77611aaf8fb5f6475f344)",
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
