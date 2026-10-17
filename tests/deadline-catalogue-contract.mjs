// tests/deadline-catalogue-contract.mjs
//
// W10 AP40 (2026-10-17). The deadline catalogue: the statutory date and the notified extension stored
// apart, as UTC days, published by the owner from the admin panel. The gate is twofold:
//
//   1. a date never moves across a day boundary under any local time zone - the same computations are run
//      in child processes under UTC, India, Los Angeles, Pago Pago (UTC-11) and Kiritimati (UTC+14) and
//      must print identical answers; and the same probe run the naive way (local Date methods) must
//      DIFFER between those zones, otherwise the comparison proves nothing;
//   2. a catalogue is published only whole and only by the super admin, with a reason, fenced on the
//      version the panel read, recorded in the control-change history, and served by the public config.
//
// The pure checks always run. The route checks run against a scratch database (MONGODB_URI, set by
// tools/run-gates.ps1); without one they are reported as not run, never as passed.
//
//   node tests/deadline-catalogue-contract.mjs
//   MONGODB_URI=mongodb://127.0.0.1:27117/scratch-gates-deadline-catalogue node tests/deadline-catalogue-contract.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEADLINE_ENTRY_LIMIT,
  daysUntil,
  effectiveDate,
  isoDayFromNumber,
  parseIsoDay,
  publishableCatalogue,
  utcDayNumber,
  validateCatalogueEntries,
} from "../src/services/deadline-catalogue.service.js";

const here = dirname(fileURLToPath(import.meta.url));
let passed = 0;
let failed = 0;
const check = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`[PASS] ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`[FAIL] ${name}: ${String(error.message).split("\n")[0]}`);
  }
};

const good = (over = {}) => ({
  formKey: "ITR",
  label: "Income tax return",
  clientType: "ALL",
  financialYear: "2025-26",
  statutoryDate: "2026-07-31",
  extendedDate: null,
  extensionReference: "",
  note: "",
  ...over,
});

// ── Pure: the days ─────────────────────────────────────────────────────────────────────────────

await check("an ISO day is read only when it is a real calendar day", () => {
  assert.equal(parseIsoDay("2026-10-31").dayNumber, 20_757);
  assert.equal(parseIsoDay("2028-02-29")?.day, 29, "a leap day is a day");
  for (const bad of ["2026-02-30", "2026-13-01", "2027-02-29", "2026-1-5", "2026-10-31T00:00:00Z", "31-10-2026", "", null, undefined, 20261031, "2026-00-10"]) {
    assert.equal(parseIsoDay(bad), null, `${JSON.stringify(bad)} must not parse`);
  }
});

await check("the UTC day of a moment is the UTC day, whatever the clock in the room says", () => {
  assert.equal(utcDayNumber(new Date("2026-10-31T23:59:59.999Z")), 20_757);
  assert.equal(utcDayNumber(new Date("2026-11-01T00:00:00.000Z")), 20_758);
  assert.equal(isoDayFromNumber(20_757), "2026-10-31");
  assert.equal(isoDayFromNumber(parseIsoDay("2028-02-29").dayNumber), "2028-02-29");
});

await check("days left count UTC days: today is 0, tomorrow 1, yesterday -1 (overdue), unknown is null", () => {
  const now = new Date("2026-10-31T23:30:00Z");
  assert.equal(daysUntil("2026-10-31", now), 0);
  assert.equal(daysUntil("2026-11-01", now), 1);
  assert.equal(daysUntil("2026-10-30", now), -1);
  assert.equal(daysUntil("2026-02-30", now), null);
});

// ── Pure: the time-zone gate ───────────────────────────────────────────────────────────────────

const ZONES = ["UTC", "Asia/Kolkata", "America/Los_Angeles", "Pacific/Pago_Pago", "Pacific/Kiritimati"];
const probe = (zone, naive = false) => {
  const run = spawnSync(process.execPath, [join(here, "lib", "deadline-tz-probe.mjs"), ...(naive ? ["--naive"] : [])], {
    env: { ...process.env, TZ: zone },
    encoding: "utf8",
  });
  assert.equal(run.status, 0, `probe failed under ${zone}: ${(run.stderr || run.stdout).trim().slice(0, 200)}`);
  return run.stdout.trim();
};

await check("the catalogue's answers are identical under UTC, India, Los Angeles, UTC-11 and UTC+14", () => {
  const answers = ZONES.map((zone) => [zone, probe(zone)]);
  for (const [zone, answer] of answers) {
    assert.equal(answer, answers[0][1], `${zone} answered differently from ${answers[0][0]}`);
  }
  const parsed = JSON.parse(answers[0][1]);
  assert.equal(parsed["2026-10-31"].roundTrip, "2026-10-31");
  assert.equal(parsed["2026-10-31"].daysUntil, 0);
  assert.equal(parsed["2026-11-01"].daysUntil, 1);
});

await check("the same probe done the naive way DOES change with the zone (so the check above is not vacuous)", () => {
  const answers = new Set(ZONES.map((zone) => probe(zone, true)));
  assert.ok(answers.size > 1, "a naive local-Date answer did not change with the zone - the zones are not being applied");
  const la = JSON.parse(probe("America/Los_Angeles", true))["2026-10-31"].dayOfMonth;
  assert.equal(la, 30, "31 October read through local time in Los Angeles should have come out as the 30th");
});

// ── Pure: validation ───────────────────────────────────────────────────────────────────────────

await check("a good catalogue is accepted and normalised; extension and statutory date stay separate", () => {
  const r = validateCatalogueEntries([
    good({ formKey: " itr ", label: " Income tax return ", extendedDate: "2026-09-15", extensionReference: "  Circular 12/2026  " }),
    good({ formKey: "AOC-4", label: "Financial statements", financialYear: "2025-26", statutoryDate: "2026-10-30" }),
  ]);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.entries[0].formKey, "ITR");
  assert.equal(r.entries[0].statutoryDate, "2026-07-31");
  assert.equal(r.entries[0].extendedDate, "2026-09-15");
  assert.equal(r.entries[0].extensionReference, "Circular 12/2026");
  assert.equal(effectiveDate(r.entries[0]), "2026-09-15");
  assert.equal(effectiveDate(r.entries[1]), "2026-10-30", "no extension: the statutory date is the working date");
});

const rejects = (name, entries, entryNumber, field) =>
  check(name, () => {
    const r = validateCatalogueEntries(entries);
    assert.equal(r.ok, false, "must be refused");
    assert.ok(r.errors.some((e) => e.entry === entryNumber && e.field === field), `expected an error on entry ${entryNumber} field ${field}: ${JSON.stringify(r.errors)}`);
  });

await rejects("an impossible statutory date is refused (30 February)", [good({ statutoryDate: "2026-02-30" })], 1, "statutoryDate");
await rejects("a date with a time on it is refused: a day is a day", [good({ statutoryDate: "2026-07-31T00:00:00Z" })], 1, "statutoryDate");
await rejects("a missing statutory date is refused", [good({ statutoryDate: "" })], 1, "statutoryDate");
await rejects("an extension before the statutory date is refused", [good({ extendedDate: "2026-07-30", extensionReference: "Circular 1" })], 1, "extendedDate");
await rejects("an extension without its notification reference is refused", [good({ extendedDate: "2026-09-15", extensionReference: "" })], 1, "extensionReference");
await rejects("a reference with no extended date is refused", [good({ extendedDate: null, extensionReference: "Circular 12/2026" })], 1, "extendedDate");
await rejects("a financial year that is not consecutive is refused (2025-27)", [good({ financialYear: "2025-27" })], 1, "financialYear");
await rejects("a financial year written the long way is refused (2025-2026)", [good({ financialYear: "2025-2026" })], 1, "financialYear");
await rejects("an unknown client type is refused", [good({ clientType: "SPACESHIP" })], 1, "clientType");
await rejects("a form key with odd characters is refused", [good({ formKey: "ITR<script>" })], 1, "formKey");
await rejects("an entry with no label is refused", [good({ label: "" })], 1, "label");
await rejects("the same form, client type and year twice is refused (on the second)", [good(), good({ label: "Again" })], 2, "formKey");

await check("a list that is not a list, and one that is too long, are refused whole", () => {
  assert.equal(validateCatalogueEntries({}).ok, false);
  assert.equal(validateCatalogueEntries("x").ok, false);
  const many = Array.from({ length: DEADLINE_ENTRY_LIMIT + 1 }, (_, i) => good({ formKey: `F${i}` }));
  assert.equal(validateCatalogueEntries(many).ok, false);
  assert.equal(validateCatalogueEntries([]).ok, true, "an empty catalogue is valid (it clears one)");
});

await check("the public shape: null while never published, otherwise the entries with the working date beside both", () => {
  assert.equal(publishableCatalogue(undefined), null);
  assert.equal(publishableCatalogue({ version: 0, entries: [] }), null);
  const shape = publishableCatalogue({ version: 2, publishedAt: new Date("2026-10-01T00:00:00Z"), entries: [good({ extendedDate: "2026-09-15", extensionReference: "Circular 12/2026" })] });
  assert.equal(shape.version, 2);
  assert.equal(shape.entries[0].statutoryDate, "2026-07-31");
  assert.equal(shape.entries[0].extendedDate, "2026-09-15");
  assert.equal(shape.entries[0].effectiveDate, "2026-09-15");
});

// ── Routes: the owner publishes ────────────────────────────────────────────────────────────────

const uri = process.env.MONGODB_URI || "";
const dbName = (uri.split("/").pop() || "").split("?")[0];
const loopback = /^mongodb:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(uri);

if (!uri) {
  console.log("[NOT RUN] the route checks - no MONGODB_URI (tools/run-gates.ps1 provides a scratch one)");
} else if (!/scratch/i.test(dbName) || !loopback) {
  console.error(`[FAIL] refusing to touch ${dbName || "(no name)"}: the database must be loopback and scratch-named`);
  failed += 1;
} else {
  process.env.NODE_ENV = "production";
  process.env.JWT_SECRET = process.env.JWT_SECRET || "scratch-only-secret-not-a-real-credential-0000";
  process.env.DEEPSEEK_API_KEY = "";
  process.env.OCR_SPACE_API_KEY = "";
  const { default: app } = await import("../src/app.js");
  const jwt = (await import("jsonwebtoken")).default;
  const mongoose = (await import("mongoose")).default;
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
  await mongoose.connection.dropDatabase();
  const raw = (name) => mongoose.connection.collection(name);
  const oid = () => new mongoose.Types.ObjectId();
  const now = new Date();

  const superId = oid();
  const adminId = oid();
  const superEmail = "saifullahfaizan786@gmail.com";
  await raw("users").insertMany([
    { _id: superId, email: superEmail, name: "Super Scratch", role: "SUPER_ADMIN", accountType: "FIRM_USER", isActive: true, tokenVersion: 0, createdAt: now, updatedAt: now },
    { _id: adminId, email: "admin-deadline@scratch.test", name: "Admin", role: "FIRM_ADMIN", accountType: "FIRM_USER", isActive: true, tokenVersion: 0, createdAt: now, updatedAt: now },
  ]);
  const sign = (id, email, role) => jwt.sign({ id, email, role, accountType: "FIRM_USER", isActive: true, tv: 0 }, process.env.JWT_SECRET, { expiresIn: "30m" });
  const superToken = sign(superId, superEmail, "SUPER_ADMIN");
  const adminToken = sign(adminId, "admin-deadline@scratch.test", "FIRM_ADMIN");

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const call = async (token, method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  };
  const publicConfig = async () => (await call(null, "GET", "/api/app-config")).json?.config;
  const stored = () => raw("appconfigs").findOne({ _id: "singleton" });

  await check("before anything is published the public config says null, not an empty calendar", async () => {
    const config = await publicConfig();
    assert.ok(config, "the public config did not answer");
    assert.equal(config.deadlineCatalogue, null);
    for (const key of ["maintenanceMode", "featureFlags", "dataRetention", "desktopRelease"]) assert.ok(key in config, `the public config lost ${key}`);
  });

  await check("nobody signed out, and no firm admin, can publish (401, 403) - nothing is written", async () => {
    const body = { entries: [good()], reason: "Circular 12/2026" };
    assert.equal((await call(null, "PATCH", "/api/app-config/deadline-catalogue", body)).status, 401);
    assert.equal((await call(adminToken, "PATCH", "/api/app-config/deadline-catalogue", body)).status, 403);
    assert.equal((await publicConfig()).deadlineCatalogue, null);
  });

  await check("a publish without a reason is refused, whatever the entries", async () => {
    const r = await call(superToken, "PATCH", "/api/app-config/deadline-catalogue", { entries: [good()] });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /why/i);
    assert.equal((await publicConfig()).deadlineCatalogue, null);
  });

  await check("a catalogue with one bad entry is refused whole: the errors name the entry and field, nothing is stored", async () => {
    const r = await call(superToken, "PATCH", "/api/app-config/deadline-catalogue", {
      entries: [good(), good({ formKey: "TAR", statutoryDate: "2026-02-30" })],
      reason: "Circular 12/2026",
    });
    assert.equal(r.status, 400);
    assert.deepEqual(r.json.errors.map((e) => [e.entry, e.field]), [[2, "statutoryDate"]]);
    assert.equal((await publicConfig()).deadlineCatalogue, null, "a refused catalogue must leave nothing behind");
  });

  await check("the super admin publishes: version 1, the statutory date and the extension stored apart, served publicly", async () => {
    const r = await call(superToken, "PATCH", "/api/app-config/deadline-catalogue", {
      entries: [
        good({ extendedDate: "2026-09-15", extensionReference: "Circular 12/2026" }),
        good({ formKey: "TAR", label: "Tax audit report", statutoryDate: "2026-09-30" }),
      ],
      reason: "Circular 12/2026 extends the ITR date",
      expectedVersion: 0,
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.deadlineCatalogue.version, 1);
    const config = await publicConfig();
    const itr = config.deadlineCatalogue.entries.find((e) => e.formKey === "ITR");
    assert.equal(itr.statutoryDate, "2026-07-31");
    assert.equal(itr.extendedDate, "2026-09-15");
    assert.equal(itr.effectiveDate, "2026-09-15");
    const tar = config.deadlineCatalogue.entries.find((e) => e.formKey === "TAR");
    assert.equal(tar.extendedDate, null);
    assert.equal(tar.effectiveDate, "2026-09-30");
    const doc = await stored();
    assert.equal(typeof doc.deadlineCatalogue.entries[0].statutoryDate, "string", "a day is stored as text, not a Date");
  });

  await check("the change is recorded with who, what and why, in the same history as the other switches", async () => {
    const doc = await stored();
    const entry = doc.controlChanges.at(-1);
    assert.equal(entry.kind, "deadlineCatalogue");
    assert.equal(entry.byEmail, superEmail);
    assert.equal(entry.reason, "Circular 12/2026 extends the ITR date");
    assert.match(entry.summary, /version 1, 2 entries/);
    const history = await call(superToken, "GET", "/api/app-config/control-changes");
    assert.equal(history.json.changes[0].kind, "deadlineCatalogue");
  });

  await check("a publish from a stale copy is refused 409 and the newer catalogue stays", async () => {
    const r = await call(superToken, "PATCH", "/api/app-config/deadline-catalogue", { entries: [good({ formKey: "AGM" })], reason: "Stale", expectedVersion: 0 });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, "DEADLINE_CATALOGUE_CHANGED");
    assert.equal(r.json.currentVersion, 1);
    assert.equal((await publicConfig()).deadlineCatalogue.entries.length, 2);
  });

  await check("a second publish replaces the whole catalogue and moves the version on (an empty list clears it)", async () => {
    const r = await call(superToken, "PATCH", "/api/app-config/deadline-catalogue", { entries: [good({ formKey: "AGM", label: "Annual general meeting", statutoryDate: "2026-09-30" })], reason: "AGM date added", expectedVersion: 1 });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.deadlineCatalogue.version, 2);
    assert.deepEqual((await publicConfig()).deadlineCatalogue.entries.map((e) => e.formKey), ["AGM"]);
    const cleared = await call(superToken, "PATCH", "/api/app-config/deadline-catalogue", { entries: [], reason: "Withdrawn pending the notification", expectedVersion: 2 });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.json));
    assert.equal(cleared.json.deadlineCatalogue.version, 3);
    assert.deepEqual(cleared.json.deadlineCatalogue.entries, []);
  });

  server.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}

console.log(`\ndeadline-catalogue-contract: ${passed}/${passed + failed} passed${uri ? " (scratch Mongo included)" : " (pure checks only - no scratch Mongo)"}`);
if (failed) process.exitCode = 1;
