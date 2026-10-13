// The signed portal map's server side (GD28): what is refused, by whom, and why.
//
// A version is accepted only when it is signed with the owner's offline key, has exactly the
// expected shape, and is numbered above every version already published - and only from the super
// admin, past three guards. No database is needed: the model's few calls are replaced for the
// duration, and every refusal is decided before anything could be written.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.NODE_ENV = process.env.NODE_ENV || "development";
process.env.JWT_SECRET = process.env.JWT_SECRET || "local-verification-only";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const { default: PortalMapVersion, PORTAL_MAP_LIMITS } = await import("../src/models/PortalMapVersion.js");
const service = await import("../src/services/portal-map.service.js");
const { publishPortalMapVersion } = await import("../src/controllers/super.controller.js");
const { getLatestPortalMap, getPortalMapVersion } = await import("../src/controllers/portal-map.controller.js");
const { requireSuperAdmin } = await import("../src/middleware/authorization.middleware.js");
const { authRequired } = await import("../src/middleware/auth.middleware.js");
const { sanitizeInputs } = await import("../src/middleware/sanitize.middleware.js");

let passed = 0;
let failed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (error) {
    failed++;
    failures.push(`${name}: ${error.message}`);
  }
}

const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
const PUBLIC_TEXT = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("base64");
const KEY = service.portalMapPublicKey(PUBLIC_TEXT);
const other = crypto.generateKeyPairSync("ed25519");

const MAP = { mapVersion: 2, minExtensionVersion: "1.4.6", routes: { login: "https://services.gst.gov.in/services/login" } };
function signed(map = MAP, key = privateKey) {
  const content = JSON.stringify(map);
  return { version: map.mapVersion, content, signature: crypto.sign(null, Buffer.from(content), key).toString("base64"), notes: "Login page moved" };
}
const SUPER = { _id: "64b7f0c2a1b2c3d4e5f60718", role: "SUPER_ADMIN", email: "saifullahfaizan786@gmail.com" };

function fakeReqRes(user, extra = {}) {
  const state = { status: 200, body: null, headers: {}, nextError: undefined, nextCalled: false };
  const req = { user, headers: {}, params: {}, body: undefined, id: "test", ...extra };
  const res = {
    status(code) { state.status = code; return res; },
    json(payload) { state.body = payload; return res; },
    set(name, value) { state.headers[name] = value; return res; },
  };
  const next = (error) => { state.nextCalled = true; state.nextError = error; };
  return { req, res, next, state };
}

// The model's calls, replaced for the run: `stored` is the collection.
let stored = [];
let created = [];
let indexFailure = null;
let createFailure = null;
const real = { findOne: PortalMapVersion.findOne, create: PortalMapVersion.create, createIndexes: PortalMapVersion.createIndexes };
PortalMapVersion.createIndexes = async () => {
  if (indexFailure) throw indexFailure;
};
PortalMapVersion.findOne = (filter = {}) => {
  const pick = () => {
    const rows = filter.version === undefined ? stored : stored.filter((row) => row.version === filter.version);
    return rows.length ? [...rows].sort((a, b) => b.version - a.version)[0] : null;
  };
  const query = { sort: () => query, lean: async () => pick() };
  return query;
};
PortalMapVersion.create = async (doc) => {
  if (createFailure) throw createFailure;
  created.push(doc);
  stored.push(doc);
  return doc;
};

// ------------------------------------------------------------------ the acceptance decision

await check("a correctly signed, well-formed, higher version is accepted", () => {
  const verdict = service.checkPortalMapSubmission(signed(), { publicKey: KEY, latestVersion: 1 });
  assert.equal(verdict.ok, true, verdict.message);
  assert.equal(verdict.record.minExtensionVersion, "1.4.6", "the minimum version is not taken from the signed content");
  assert.equal(verdict.record.content, JSON.stringify(MAP));
});

await check("a bad signature is refused", () => {
  const byOtherKey = signed(MAP, other.privateKey);
  const tampered = { ...signed(), content: JSON.stringify({ ...MAP, routes: { login: "https://services.gst.gov.in/services/logout" } }) };
  const zeros = { ...signed(), signature: Buffer.alloc(64).toString("base64") };
  for (const [what, body] of [["another key", byOtherKey], ["content changed after signing", tampered], ["a zero signature", zeros]]) {
    const verdict = service.checkPortalMapSubmission(body, { publicKey: KEY, latestVersion: 0 });
    assert.equal(verdict.ok, false, `${what} was accepted`);
    assert.equal(verdict.code, "PORTAL_MAP_BAD_SIGNATURE", what);
    assert.equal(verdict.status, 422, what);
  }
});

await check("a lower or equal version is refused, even correctly signed", () => {
  for (const latestVersion of [2, 5]) {
    const verdict = service.checkPortalMapSubmission(signed(), { publicKey: KEY, latestVersion });
    assert.equal(verdict.code, "PORTAL_MAP_VERSION_NOT_HIGHER", `latest ${latestVersion}`);
    assert.equal(verdict.status, 409);
    assert.match(verdict.message, /rollback is a new, higher version/);
  }
});

await check("a malformed body is refused, each for its own reason", () => {
  const good = signed();
  const withMap = (map) => signed(map);
  const cases = [
    ["null", null],
    ["an array", [good]],
    ["text", "version=2"],
    ["an extra field", { ...good, code: "alert(1)" }],
    ["no content", { ...good, content: undefined }],
    ["content that is not JSON", { ...good, content: "{mapVersion:2" }],
    ["content that is a JSON list", { ...good, content: "[2]" }],
    ["a mapVersion that is not the version", { ...withMap({ ...MAP, mapVersion: 3 }), version: 2 }],
    ["a version given as text", { ...good, version: "2" }],
    ["version 0", withMap({ ...MAP, mapVersion: 0 })],
    ["a fractional version", withMap({ ...MAP, mapVersion: 2.5 })],
    ["a signature that is not base64", { ...good, signature: "not base64!" }],
    ["a signature of the wrong length", { ...good, signature: Buffer.alloc(63).toString("base64") }],
    ["notes too long", { ...good, notes: "x".repeat(PORTAL_MAP_LIMITS.notesChars + 1) }],
    ["notes that are not text", { ...good, notes: 7 }],
    ["content over the size limit", withMap({ ...MAP, padding: "x".repeat(PORTAL_MAP_LIMITS.contentBytes) })],
    ["a minimum version that is not a version", withMap({ ...MAP, minExtensionVersion: "latest" })],
  ];
  for (const [what, body] of cases) {
    const verdict = service.checkPortalMapSubmission(body, { publicKey: KEY, latestVersion: 0 });
    assert.equal(verdict.ok, false, `${what} was accepted`);
    assert.equal(verdict.code, "PORTAL_MAP_MALFORMED", `${what}: ${verdict.code}`);
    assert.equal(verdict.status, 400, what);
  }
});

await check("with no key configured, nothing is accepted", () => {
  const verdict = service.checkPortalMapSubmission(signed(), { publicKey: null, latestVersion: 0 });
  assert.equal(verdict.code, "PORTAL_MAP_SIGNING_NOT_CONFIGURED");
  assert.equal(verdict.status, 503);
  for (const raw of ["", "   ", "abc", Buffer.alloc(31).toString("base64"), `${PUBLIC_TEXT}!`, undefined]) {
    assert.equal(service.portalMapPublicKey(raw), null, `${JSON.stringify(raw)} was taken for a key`);
  }
  assert.ok(service.portalMapPublicKey(PUBLIC_TEXT), "the real public key was refused");
  assert.ok(service.portalMapPublicKey(PUBLIC_TEXT.replace(/=+$/, "")), "the key without its padding was refused");
});

// ----------------------------------------------------------------- the signed bytes survive

await check("the signed content reaches the route byte for byte; other routes are still sanitised", () => {
  const map = { ...MAP, phrases: { cue: [" <b>Session</b> expired ", "onload=x"] } };
  const body = signed(map);
  const onRoute = { method: "POST", path: "/api/super/gst-portal-map", body: { ...body }, query: {}, params: {} };
  sanitizeInputs(onRoute, {}, () => {});
  assert.equal(onRoute.body.content, body.content, "the sanitiser rewrote the signed content");
  assert.equal(service.checkPortalMapSubmission(onRoute.body, { publicKey: KEY }).ok, true);
  const elsewhere = { method: "POST", path: "/api/tasks", body: { title: " <b>x</b> onload=y " }, query: {}, params: {} };
  sanitizeInputs(elsewhere, {}, () => {});
  assert.equal(elsewhere.body.title, "x y", "the exemption reached a route it was not written for");
  const getOnRoute = { method: "GET", path: "/api/super/gst-portal-map", body: { note: " <i>a</i> " }, query: {}, params: {} };
  sanitizeInputs(getOnRoute, {}, () => {});
  assert.equal(getOnRoute.body.note, "a", "the exemption is not limited to the POST");
});

// ---------------------------------------------------------------------- the three guards

await check("guard 1: no signed-in user, no request", async () => {
  const { req, res, next, state } = fakeReqRes(undefined, { headers: {} });
  await authRequired(req, res, next);
  assert.equal(state.status, 401);
  assert.equal(state.nextCalled, false);
});

await check("guard 2: requireSuperAdmin refuses everyone but the super admin", () => {
  for (const [user, status] of [
    [null, 401],
    [{ role: "FIRM_ADMIN", email: "saifullahfaizan786@gmail.com" }, 403],
    [{ role: "SUPER_ADMIN", email: "someone@example.com" }, 403],
    [{ role: "USER", email: "a@b.c" }, 403],
  ]) {
    const { req, res, next, state } = fakeReqRes(user);
    requireSuperAdmin(req, res, next);
    assert.equal(state.status, status, JSON.stringify(user));
    assert.equal(state.nextCalled, false);
  }
  const { req, res, next, state } = fakeReqRes(SUPER);
  requireSuperAdmin(req, res, next);
  assert.equal(state.nextCalled, true);
});

await check("guard 3: the controller itself refuses a non-super caller, and stores nothing", async () => {
  stored = [];
  created = [];
  process.env.GST_PORTAL_MAP_PUBLIC_KEY = PUBLIC_TEXT;
  for (const user of [null, { _id: "x", role: "FIRM_ADMIN", email: "saifullahfaizan786@gmail.com" }, { ...SUPER, email: "SAIFULLAHFAIZAN786@gmail.com " }]) {
    const { req, res, next, state } = fakeReqRes(user, { body: signed() });
    await publishPortalMapVersion(req, res, next);
    assert.equal(state.nextError?.statusCode, 403, JSON.stringify(user));
  }
  assert.deepEqual(created, [], "a non-super caller stored a version");
});

await check("the route chain carries all three guards, and the reads are signed-in only", () => {
  const routes = readFileSync(join(root, "src", "routes", "super.routes.js"), "utf8");
  const useAt = routes.indexOf("router.use(authRequired);");
  const postAt = routes.indexOf('router.post("/gst-portal-map", requireSuperAdmin, publishPortalMapVersion);');
  assert.ok(useAt > 0 && postAt > useAt, "the publish route is not behind authRequired and requireSuperAdmin");
  const controller = readFileSync(join(root, "src", "controllers", "super.controller.js"), "utf8");
  const body = controller.slice(controller.indexOf("export const publishPortalMapVersion"), controller.indexOf("export const getProviderUsageStats"));
  assert.match(body, /^\s*try \{\s*assertSuper\(req\.user\);/m, "assertSuper is not the controller's first act");
  const reads = readFileSync(join(root, "src", "routes", "portal-map.routes.js"), "utf8");
  assert.match(reads, /router\.get\("\/latest", authRequired, getLatestPortalMap\);/);
  assert.match(reads, /router\.get\("\/:version", authRequired, getPortalMapVersion\);/);
  const app = readFileSync(join(root, "src", "app.js"), "utf8");
  const mountAt = app.indexOf('app.use("/api/gst-portal-map", portalMapRoutes);');
  assert.ok(mountAt > 0 && mountAt < app.indexOf('app.use("/api", firmOperationsRoutes);'), "the reads are mounted behind the /api catch-all");
});

// --------------------------------------------------------------- publishing and reading

await check("a store that cannot guarantee unique versions accepts nothing", async () => {
  stored = [];
  created = [];
  indexFailure = new Error("index build failed");
  const { req, res, next, state } = fakeReqRes(SUPER, { body: signed() });
  await publishPortalMapVersion(req, res, next);
  indexFailure = null;
  assert.equal(state.status, 503);
  assert.equal(state.body.code, "PORTAL_MAP_STORE_NOT_READY");
  assert.deepEqual(created, []);
});

await check("the super admin publishes a signed version; the exact signed text is stored", async () => {
  stored = [{ version: 1, content: "{}", signature: "x" }];
  created = [];
  const body = signed();
  const { req, res, next, state } = fakeReqRes(SUPER, { body });
  await publishPortalMapVersion(req, res, next);
  assert.equal(state.status, 201, JSON.stringify(state.body) + String(state.nextError));
  assert.equal(state.body.version, 2);
  assert.equal(state.body.minExtensionVersion, "1.4.6");
  assert.equal(created.length, 1);
  assert.equal(created[0].content, body.content, "the stored text is not the signed text");
  assert.equal(created[0].signature, body.signature);
  assert.equal(created[0].publishedBy, SUPER._id);
  assert.ok(created[0].publishedAt instanceof Date);
  assert.equal(state.body.content, undefined, "the publish answer echoes the content");

  // The same version again, and a lower one: refused, nothing stored.
  for (const again of [signed(), signed({ ...MAP, mapVersion: 1 })]) {
    const second = fakeReqRes(SUPER, { body: again });
    await publishPortalMapVersion(second.req, second.res, second.next);
    assert.equal(second.state.status, 409);
    assert.equal(second.state.body.code, "PORTAL_MAP_VERSION_NOT_HIGHER");
  }
  assert.equal(created.length, 1);

  // A bad signature and a malformed body through the real handler.
  for (const [body2, code, status] of [
    [signed({ ...MAP, mapVersion: 3 }, other.privateKey), "PORTAL_MAP_BAD_SIGNATURE", 422],
    [{ ...signed({ ...MAP, mapVersion: 3 }), extra: 1 }, "PORTAL_MAP_MALFORMED", 400],
  ]) {
    const third = fakeReqRes(SUPER, { body: body2 });
    await publishPortalMapVersion(third.req, third.res, third.next);
    assert.equal(third.state.status, status, code);
    assert.equal(third.state.body.code, code);
  }
  assert.equal(created.length, 1);
});

await check("two requests racing for one version: the loser is told, not given an error page", async () => {
  stored = [];
  createFailure = Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
  const { req, res, next, state } = fakeReqRes(SUPER, { body: signed() });
  await publishPortalMapVersion(req, res, next);
  createFailure = null;
  assert.equal(state.status, 409);
  assert.equal(state.body.code, "PORTAL_MAP_VERSION_NOT_HIGHER");
});

await check("reads: the latest version number, and one version's signed text", async () => {
  stored = [];
  let call = fakeReqRes({ role: "USER" });
  await getLatestPortalMap(call.req, call.res, call.next);
  assert.deepEqual(call.state.body, { version: 0 }, "an empty store must say 0, so the extension keeps its own map");

  const body = signed();
  stored = [{ version: 1, content: "{}", signature: "a" }, { version: 2, content: body.content, signature: body.signature, notes: "n", publishedBy: "p" }];
  call = fakeReqRes({ role: "USER" });
  await getLatestPortalMap(call.req, call.res, call.next);
  assert.deepEqual(call.state.body, { version: 2 });

  call = fakeReqRes({ role: "USER" }, { params: { version: "2" } });
  await getPortalMapVersion(call.req, call.res, call.next);
  assert.deepEqual(call.state.body, { version: 2, content: body.content, signature: body.signature }, "more than the signed text was served");
  assert.match(call.state.headers["Cache-Control"], /^private/);

  call = fakeReqRes({ role: "USER" }, { params: { version: "9" } });
  await getPortalMapVersion(call.req, call.res, call.next);
  assert.equal(call.state.status, 404);
  for (const bad of ["0", "-1", "abc", "2.5", "01", "99999999", ""]) {
    call = fakeReqRes({ role: "USER" }, { params: { version: bad } });
    await getPortalMapVersion(call.req, call.res, call.next);
    assert.equal(call.state.status, 400, `version ${JSON.stringify(bad)}`);
  }
});

// ------------------------------------------------------------------- the offline signing tool

await check("the signing tool keeps its key outside the checkout and writes a request the server accepts", () => {
  const tool = join(root, "tools", "sign-portal-map.mjs");
  const run = (...args) => spawnSync(process.execPath, [tool, ...args], { encoding: "utf8" });
  const folder = mkdtempSync(join(tmpdir(), "capro-portal-map-"));
  // If the tool ever wrongly writes a key into the checkout, this run removes
  // the one it wrote - never one that was there before it started.
  const stray = join(here, "portal-map-signing-key.pem");
  const strayBefore = existsSync(stray);
  try {
    const made = run("keygen", "--out", folder);
    assert.equal(made.status, 0, made.stderr);
    const keyPath = join(folder, "portal-map-signing-key.pem");
    assert.ok(existsSync(keyPath));
    const printed = made.stdout.trim().split(/\r?\n/).pop();
    assert.ok(service.portalMapPublicKey(printed), "keygen did not print a usable public key");
    const again = run("keygen", "--out", folder);
    assert.notEqual(again.status, 0, "an existing key was overwritten");

    // Never inside the checkout - neither written there nor read from there.
    const inside = run("keygen", "--out", here);
    assert.notEqual(inside.status, 0, "a key was written inside the repository");
    assert.match(inside.stderr, /inside the CA PRO checkout/);
    assert.equal(existsSync(join(here, "portal-map-signing-key.pem")), false);
    const mapPath = join(folder, "map.json");
    writeFileSync(mapPath, JSON.stringify({ ...MAP, mapVersion: 7 }, null, 2));
    const readInside = run("sign", "--key", join(here, "key.pem"), "--map", mapPath, "--out", join(folder, "x.json"));
    assert.notEqual(readInside.status, 0);
    assert.match(readInside.stderr, /inside the CA PRO checkout/);

    const requestPath = join(folder, "request.json");
    const signedRun = run("sign", "--key", keyPath, "--map", mapPath, "--out", requestPath, "--notes", "Moved the login page");
    assert.equal(signedRun.status, 0, signedRun.stderr);
    const request = JSON.parse(readFileSync(requestPath, "utf8"));
    assert.deepEqual(Object.keys(request).sort(), ["content", "notes", "signature", "version"]);
    const verdict = service.checkPortalMapSubmission(request, { publicKey: service.portalMapPublicKey(printed), latestVersion: 6 });
    assert.equal(verdict.ok, true, verdict.message);
    assert.equal(verdict.record.version, 7);
    assert.equal(run("verify", "--public", printed, "--request", requestPath).status, 0);
    assert.notEqual(run("verify", "--public", PUBLIC_TEXT, "--request", requestPath).status, 0, "a request verified against the wrong key");

    // A map the server would refuse is never written.
    writeFileSync(mapPath, JSON.stringify({ ...MAP, mapVersion: "8" }));
    const refused = run("sign", "--key", keyPath, "--map", mapPath, "--out", join(folder, "refused.json"));
    assert.notEqual(refused.status, 0);
    assert.equal(existsSync(join(folder, "refused.json")), false);
  } finally {
    rmSync(folder, { recursive: true, force: true });
    if (!strayBefore) rmSync(stray, { force: true });
  }
});

PortalMapVersion.findOne = real.findOne;
PortalMapVersion.create = real.create;
PortalMapVersion.createIndexes = real.createIndexes;

console.log(`portal map contract: ${passed}/${passed + failed} passed`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  FAIL ${failure}`);
  process.exit(1);
}
process.exit(0);
