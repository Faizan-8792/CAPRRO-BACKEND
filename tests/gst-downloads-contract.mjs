// The GST downloader's run records, per firm (GD30; GST-DOWNLOADER-PLAN section 8.13; owner
// decision OD4, 2026-10-04), and the filing board they feed (GD33; decision D4, V2 section 4.9).
//
//   1. Every key the extension sends is validated again on the server; a bad row is refused by
//      itself, named, and never stored.
//   2. The routes: the signed-in member's own firm only; a run's record is a write that counts one
//      downloader_run; the recording switch is an admin's.
//   3. Both collections are classified for retention and for erasure.
//   4. Against a scratch database: firm A cannot read firm B's records; the upsert is idempotent;
//      an older state never overwrites a newer one; the switch off means zero writes; a request
//      past the bounds writes nothing; the unique index exists.
//   5. Decision D4's acceptance: one 10-client run gives 10 board rows; the switch off gives zero
//      writes.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (path) => readFileSync(join(root, path), "utf8");

const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass: Boolean(pass), detail });

const service = await import("../src/services/gst-downloads.service.js");
const { RETENTION_CLASSIFICATION } = await import("../src/services/data-retention.service.js");
const { PINNED_FIRM_SCOPED, classify } = await import("../src/services/erasure-classification.js");

const NOW = Date.parse("2026-10-04T09:00:00Z");
const A_GSTIN = "27AAAAA0000A1Z5";
const good = (over = {}) => ({
  gstin: A_GSTIN,
  returnType: "GSTR-3B",
  fileType: "pdf",
  period: "2025-04",
  state: "downloaded",
  outcome: "downloaded",
  fileName: `${A_GSTIN}_GSTR-3B_2025-26_2025-04_Apr.pdf`,
  bytes: 48211,
  sha256: "a".repeat(64),
  savedAt: "2026-10-04T08:59:00Z",
  observedAt: "2026-10-04T08:59:30Z",
  runId: "run_1",
  mapVersion: 1,
  ...over,
});

// ─── 1. Validation ───────────────────────────────────────────────────────────

const ok = service.readRecord(good(), { now: NOW });
check("a well-formed record is accepted, keyed by GSTIN, return, format and period", ok.ok && ok.key.period === "2025-04" && ok.set.bytes === 48211);
check("a lower-case GSTIN is stored upper-case", service.readRecord(good({ gstin: A_GSTIN.toLowerCase() }), { now: NOW }).key?.gstin === A_GSTIN);
const refusals = [
  ["gstin", { gstin: "27AAAAA0000A1Z" }],
  ["returnType", { returnType: "GSTR-4" }],
  ["fileType", { fileType: "zip" }],
  ["period", { period: "2025-13" }],
  ["state", { state: "filed" }],
  ["observedAt", { observedAt: "2026-12-01T00:00:00Z" }],
  ["observedAt", { observedAt: "2016-01-01T00:00:00Z" }],
  ["observedAt", { observedAt: "yesterday" }],
  ["fileName", { fileName: "../../secret.pdf" }],
  ["fileName", { fileName: "C:\\Users\\x.pdf" }],
  ["bytes", { bytes: -1 }],
  ["bytes", { bytes: 1.5 }],
  ["sha256", { sha256: "XYZ" }],
  ["mapVersion", { mapVersion: 0 }],
  ["outcome", { outcome: "<script>" }],
  ["runId", { runId: "a b" }],
  ["gstr2bGeneratedOn", { gstr2bGeneratedOn: "2025/05/14" }],
  ["ledger.requests", { ledger: { requests: 5000 } }],
  ["ledger.capReason", { ledger: { capReason: "bored" } }],
];
for (const [reason, over] of refusals) {
  const verdict = service.readRecord(good(over), { now: NOW });
  check(`a record with a bad ${reason} is refused (${JSON.stringify(over)})`, !verdict.ok && verdict.reason === reason, JSON.stringify(verdict));
}
check("the annual and ledger periods are accepted", ["FY:2025-26", "ledger"].every((period) => service.readRecord(good({ period }), { now: NOW }).ok));

const frequency = (over = {}) => ({ gstin: A_GSTIN, fy: "2025-26", quarter: 1, freq: "Q", provisional: false, source: "rolestatus", seenAt: "2026-10-04T08:00:00Z", ...over });
check("a frequency reading is accepted", service.readFrequency(frequency(), { now: NOW }).ok);
for (const [reason, over] of [["fy", { fy: "2025-27" }], ["quarter", { quarter: 5 }], ["freq", { freq: "Y" }], ["source", { source: "guess" }], ["seenAt", { seenAt: "" }]]) {
  const verdict = service.readFrequency(frequency(over), { now: NOW });
  check(`a frequency reading with a bad ${reason} is refused`, !verdict.ok && verdict.reason === reason, JSON.stringify(verdict));
}
const filing = (over = {}) => ({ gstin: A_GSTIN, returnType: "GSTR-3B", period: "2025-09", statusClass: "filed", seenAt: "2026-10-04T08:50:00Z", runId: "run_1", ...over });
const readFiling = service.readFilingStatus(filing(), { now: NOW });
check(
  "a filing status is accepted, keyed by GSTIN, return and month, with the run that saw it",
  readFiling.ok && readFiling.key.period === "2025-09" && readFiling.set.statusClass === "filed" && readFiling.set.sourceRunId === "run_1",
  JSON.stringify(readFiling),
);
check("every class of the board is accepted", ["filed", "not_filed", "late_fee_flagged", "invalid"].every((statusClass) => service.readFilingStatus(filing({ statusClass }), { now: NOW }).ok));
for (const [reason, over] of [
  ["gstin", { gstin: "27AAAAA0000A1Z" }],
  ["returnType", { returnType: "GSTR-2B" }],
  ["period", { period: "FY:2025-26" }],
  ["period", { period: "2025-13" }],
  ["statusClass", { statusClass: "ready-to-file" }],
  ["statusClass", { statusClass: "Filed" }],
  ["seenAt", { seenAt: "2026-12-01T00:00:00Z" }],
  ["runId", { runId: "a b" }],
]) {
  const verdict = service.readFilingStatus(filing(over), { now: NOW });
  check(`a filing status with a bad ${reason} is refused (${JSON.stringify(over)})`, !verdict.ok && verdict.reason === reason, JSON.stringify(verdict));
}

const year = service.periodsOfYear("2025-26");
check(
  "a financial year's periods are its twelve months, April to March, and its annual token",
  year?.length === 13 && year[0] === "2025-04" && year[11] === "2026-03" && year[12] === "FY:2025-26",
  JSON.stringify(year),
);
check("a bad financial year has no periods", service.periodsOfYear("2025") === null);

// ─── 2. Routes and controller ────────────────────────────────────────────────

const routes = read("src/routes/gst-downloads.routes.js");
check("every route needs a signed-in member of the firm", /router\.use\(authRequiredWithoutUsageTracking, requireFirmMember\);/.test(routes));
check(
  "recording a run is a write and counts one downloader_run",
  /router\.post\("\/records\/bulk", requireFirmWriteAccess, trackWorkflow\("downloader_run"\), recordGstDownloads\);/.test(routes),
);
check("the recording switch is changed by firm admins only", /router\.patch\("\/settings", requireFirmAdmin, patchGstDownloadSettings\);/.test(routes));
check("the filing board is a member's read", /router\.get\("\/filing-status", listGstFilingStatus\);/.test(routes));
const settingsController = read("src/controllers/gst-downloads.controller.js");
check(
  "the settings say whether this account may change the switch, from the same verdict as requireFirmAdmin",
  /const canChange = \(req\) => req\.firmAuthority\?\.canAdminister === true;/.test(settingsController) &&
    (settingsController.match(/settings: \{ \.\.\.done\.settings, canChange: canChange\(req\) \}/g) || []).length === 2,
);
check(
  "a run's filing statuses reach the service from the body, beside its records and frequency",
  /records: body\.records,\s+frequency: body\.frequency,\s+filingStatus: body\.filingStatus,/.test(read("src/controllers/gst-downloads.controller.js")),
);
check("the routes are mounted at /api/gst-downloads", /app\.use\("\/api\/gst-downloads", gstDownloadsRoutes\);/.test(read("src/app.js")));
const controller = read("src/controllers/gst-downloads.controller.js");
check(
  "the firm is the signed-in user's own, never one the client names",
  (controller.match(/firmId: req\.user\.firmId/g) || []).length === 6 && !/(body|query|params)\??\.firmId/.test(controller),
);

// ─── 3. Classification ───────────────────────────────────────────────────────

for (const name of ["GstDownloadRecord", "GstFrequencyObservation", "FilingStatusObservation"]) {
  check(`${name} is classified for retention`, Boolean(RETENTION_CLASSIFICATION[name]));
  check(`${name} is on the firm-scoped erasure surface, purged with the firm`, PINNED_FIRM_SCOPED.includes(name) && classify(name, { hasFirmId: true }).strategy === "PURGE");
}

// ─── 4. Against a scratch database ───────────────────────────────────────────

const mongoUri = process.env.MONGODB_URI || "";
const wantsMongo = mongoUri.includes("scratch");
let mongoRan = false;

if (wantsMongo) {
  const mongoose = (await import("mongoose")).default;
  const { default: Record } = await import("../src/models/GstDownloadRecord.js");
  const { default: Frequency } = await import("../src/models/GstFrequencyObservation.js");
  const { default: Filing } = await import("../src/models/FilingStatusObservation.js");
  const { default: Firm } = await import("../src/models/Firm.js");
  await mongoose.connect(mongoUri);
  try {
    await Promise.all([Record.deleteMany({}), Frequency.deleteMany({}), Filing.deleteMany({})]);
    await Promise.all([Record.syncIndexes(), Frequency.syncIndexes(), Filing.syncIndexes()]);
    mongoRan = true;
    const firmA = new mongoose.Types.ObjectId();
    const firmB = new mongoose.Types.ObjectId();
    // Firm A has never had the switch written (a legacy document); firm B starts on too.
    // handle and joinCode are unique on the collection, so each scratch firm carries its own.
    await Firm.collection.insertMany([
      { _id: firmA, name: "Scratch firm A", handle: `scratch-gd30-${firmA}`, joinCode: `A${String(firmA).slice(-5)}` },
      { _id: firmB, name: "Scratch firm B", handle: `scratch-gd30-${firmB}`, joinCode: `B${String(firmB).slice(-5)}`, gstDownloaderRecording: true },
    ]);
    const svc = service.createGstDownloadsService({ now: () => NOW });

    const first = await svc.recordRun({
      firmId: firmA,
      records: [good(), good({ period: "2025-05", state: "failed-final", outcome: "portal-refused", fileName: "", bytes: 0, sha256: "" }), good({ gstin: "bad" })],
      frequency: [frequency(), frequency({ quarter: 2, freq: "M" })],
    });
    check(
      "a run's records are written, a bad row refused by itself and named",
      first.ok && first.recorded === 2 && first.frequencyRecorded === 2 && first.refused.length === 1 && first.refused[0].index === 2 && first.refused[0].reason === "gstin",
      JSON.stringify(first),
    );

    // Firm A cannot read B, and B cannot read A.
    await svc.recordRun({ firmId: firmB, records: [good({ gstin: "29AAACB1234C1ZB" })] });
    const aView = await svc.listRecords({ firmId: firmA });
    const bView = await svc.listRecords({ firmId: firmB });
    check(
      "firm A sees only its own records, and firm B only its own",
      aView.records.length === 2 && aView.records.every((row) => row.gstin === A_GSTIN) && bView.records.length === 1 && bView.records[0].gstin === "29AAACB1234C1ZB",
      JSON.stringify({ a: aView.records.length, b: bView.records.length }),
    );
    check("a record carries no firm id and no person", aView.records.every((row) => !("firmId" in row) && !("savedBy" in row) && !("_id" in row)));
    const bAsksForA = await svc.listRecords({ firmId: firmB, gstin: A_GSTIN });
    check("firm B asking for firm A's GSTIN gets nothing", bAsksForA.ok && bAsksForA.records.length === 0);

    // Idempotent: the same run sent twice changes nothing.
    const again = await svc.recordRun({ firmId: firmA, records: [good()], frequency: [frequency()] });
    check(
      "the same record sent again is one row, counted as holding its state",
      again.ok && again.recorded === 1 && again.stale === 0 && (await Record.countDocuments({ firmId: firmA })) === 2,
      JSON.stringify(again),
    );

    // Newer wins, older is stale and never written over it.
    const newer = await svc.recordRun({ firmId: firmA, records: [good({ period: "2025-05", state: "downloaded", outcome: "downloaded", observedAt: "2026-10-04T08:59:50Z" })] });
    const older = await svc.recordRun({ firmId: firmA, records: [good({ period: "2025-05", state: "failed-final", outcome: "portal-busy", observedAt: "2026-10-01T08:00:00Z" })] });
    const may = await Record.findOne({ firmId: firmA, period: "2025-05" }).lean();
    check("a newer state replaces the stored one", newer.recorded === 1, JSON.stringify(newer));
    check("an older state is counted stale and the newer one is kept", older.stale === 1 && older.recorded === 0 && may.state === "downloaded" && may.outcome === "downloaded", JSON.stringify({ older, state: may.state }));
    const olderFrequency = await svc.recordRun({ firmId: firmA, frequency: [frequency({ freq: "M", seenAt: "2026-09-01T00:00:00Z" })] });
    const q1 = await Frequency.findOne({ firmId: firmA, quarter: 1 }).lean();
    check("an older frequency reading never overwrites a newer one", olderFrequency.stale === 1 && q1.freq === "Q", JSON.stringify(olderFrequency));

    // The financial-year filter.
    await svc.recordRun({
      firmId: firmA,
      records: [good({ period: "2024-04" }), good({ period: "FY:2025-26", returnType: "GSTR-9", fileType: "pdf" }), good({ period: "ledger", returnType: "ECL", fileType: "pdf" })],
    });
    const fy = await svc.listRecords({ firmId: firmA, fy: "2025-26" });
    check(
      "a financial year lists its months, its annual return and the ledger downloads (GD83), and nothing of another year",
      fy.records.length === 4 && fy.records.every((row) => row.period !== "2024-04") && fy.records.some((row) => row.period === "ledger" && row.returnType === "ECL"),
      JSON.stringify(fy.records.map((row) => row.period)),
    );
    const otherYear = await svc.listRecords({ firmId: firmA, fy: "2024-25" });
    check(
      "the ledger downloads appear in every year, since they belong to none",
      otherYear.records.map((row) => row.period).sort().join(",") === "2024-04,ledger",
      JSON.stringify(otherYear.records.map((row) => row.period)),
    );
    const capped = await svc.listRecords({ firmId: firmA, limit: 2 });
    check("a list past its limit says so", capped.records.length === 2 && capped.truncated === true);

    // The switch: off means zero writes; only a boolean is taken.
    const off = await svc.writeSettings({ firmId: firmA, input: { recording: false } });
    const before = await Record.countDocuments({});
    const whileOff = await svc.recordRun({ firmId: firmA, records: [good({ period: "2025-06" })], frequency: [frequency({ quarter: 3 })] });
    check(
      "with the switch off nothing is written",
      off.ok && off.settings.recording === false && whileOff.ok && whileOff.recording === false && whileOff.recorded === 0 && (await Record.countDocuments({})) === before,
      JSON.stringify(whileOff),
    );
    check("the switch takes only true or false", (await svc.writeSettings({ firmId: firmA, input: { recording: "yes" } })).code === "GST_DOWNLOADS_BAD_SETTINGS");
    const legacy = new mongoose.Types.ObjectId();
    await Firm.collection.insertOne({ _id: legacy, name: "Scratch legacy firm", handle: `scratch-gd30-${legacy}`, joinCode: `C${String(legacy).slice(-5)}` });
    const legacyRun = await svc.recordRun({ firmId: legacy, records: [good({ gstin: "29AAACB1234C1ZB" })] });
    check(
      "a legacy firm without the field reads as recording, and its run is written",
      (await svc.readSettings({ firmId: legacy })).settings.recording === true && legacyRun.recording === true && legacyRun.recorded === 1,
      JSON.stringify(legacyRun),
    );
    await Firm.collection.deleteOne({ _id: legacy });
    await Record.deleteMany({ firmId: legacy });
    await svc.writeSettings({ firmId: firmA, input: { recording: true } });

    // Bounds: a request past them writes nothing at all.
    const flood = await svc.recordRun({ firmId: firmA, records: Array.from({ length: 501 }, (_, index) => good({ runId: `r${index}` })) });
    check("501 records in one request are refused whole", !flood.ok && flood.code === "GST_DOWNLOADS_TOO_MANY" && (await Record.countDocuments({})) === before);

    // The unique key exists on the collection.
    const indexes = await Record.collection.listIndexes().toArray();
    check(
      "the (firm, GSTIN, return, format, period) key is unique",
      indexes.some((index) => index.unique === true && JSON.stringify(index.key) === JSON.stringify({ firmId: 1, gstin: 1, returnType: 1, fileType: 1, period: 1 })),
    );

    // ─── 5. Decision D4: the filing board ──────────────────────────────────────
    // Ten clients, one month each, as the extension's run sync sends them (GD33).
    const tenGstins = Array.from({ length: 10 }, (_, index) => `27AAAAA${String(1000 + index).slice(-4)}A1Z${"ABCDEFGHJK"[index]}`);
    const tenRows = tenGstins.map((gstin, index) => filing({ gstin, statusClass: index % 3 === 2 ? "not_filed" : "filed", runId: "run_10" }));
    const boardRun = await svc.recordRun({ firmId: firmA, filingStatus: tenRows });
    const board = await svc.listFilingStatus({ firmId: firmA });
    check(
      "one 10-client run gives 10 board rows",
      boardRun.ok && boardRun.filingRecorded === 10 && board.ok && board.filingStatus.length === 10 && new Set(board.filingStatus.map((row) => row.gstin)).size === 10,
      JSON.stringify({ boardRun, rows: board.filingStatus?.length }),
    );
    check(
      "a board row is the class, the month and when it was seen - no firm id, no person",
      board.filingStatus.every((row) => !("firmId" in row) && !("_id" in row) && row.sourceRunId === "run_10" && row.firstSeenAt instanceof Date) &&
        board.filingStatus.filter((row) => row.statusClass === "not_filed").length === 3,
    );
    const sameRunAgain = await svc.recordRun({ firmId: firmA, filingStatus: tenRows });
    check("the same run sent again is still 10 rows", sameRunAgain.filingRecorded === 10 && (await Filing.countDocuments({ firmId: firmA })) === 10);
    const filedLater = await svc.recordRun({ firmId: firmA, filingStatus: [filing({ gstin: tenGstins[2], statusClass: "filed", seenAt: "2026-10-04T08:55:00Z", runId: "run_11" })] });
    const staleReading = await svc.recordRun({ firmId: firmA, filingStatus: [filing({ gstin: tenGstins[2], statusClass: "not_filed", seenAt: "2026-10-01T08:00:00Z" })] });
    const client3 = await Filing.findOne({ firmId: firmA, gstin: tenGstins[2] }).lean();
    check(
      "a newer reading replaces the class; an older one never writes over it",
      filedLater.filingRecorded === 1 && staleReading.stale === 1 && client3.statusClass === "filed" && client3.sourceRunId === "run_11" &&
        client3.firstSeenAt.toISOString() === "2026-10-04T08:50:00.000Z",
      JSON.stringify({ staleReading, client3 }),
    );
    check("firm B's board has none of firm A's rows", (await svc.listFilingStatus({ firmId: firmB })).filingStatus.length === 0);
    await svc.recordRun({ firmId: firmA, filingStatus: [filing({ period: "2024-09" })] });
    const boardYear = await svc.listFilingStatus({ firmId: firmA, fy: "2025-26" });
    check("the board's year filter lists that year's months only", boardYear.filingStatus.length === 10 && boardYear.filingStatus.every((row) => row.period === "2025-09"));
    check("the board refuses a GSTIN that is not one", (await svc.listFilingStatus({ firmId: firmA, gstin: "nope" })).code === "GST_DOWNLOADS_BAD_GSTIN");

    // The switch off: zero writes, to any of the three collections.
    await svc.writeSettings({ firmId: firmA, input: { recording: false } });
    const counted = async () => [await Record.countDocuments({}), await Frequency.countDocuments({}), await Filing.countDocuments({})];
    const beforeOff = await counted();
    const offRun = await svc.recordRun({
      firmId: firmA,
      records: [good({ period: "2025-08" })],
      frequency: [frequency({ quarter: 4 })],
      filingStatus: tenGstins.map((gstin) => filing({ gstin, period: "2025-10" })),
    });
    check(
      "with the switch off, a 10-client run writes nothing at all",
      offRun.ok && offRun.recording === false && offRun.filingRecorded === 0 && JSON.stringify(await counted()) === JSON.stringify(beforeOff),
      JSON.stringify({ offRun, beforeOff }),
    );
    await svc.writeSettings({ firmId: firmA, input: { recording: true } });
    const filingFlood = await svc.recordRun({ firmId: firmA, filingStatus: Array.from({ length: 501 }, () => filing()) });
    check("501 filing statuses in one request are refused whole", !filingFlood.ok && filingFlood.code === "GST_DOWNLOADS_TOO_MANY" && (await Filing.countDocuments({})) === beforeOff[2]);
    const filingIndexes = await Filing.collection.listIndexes().toArray();
    check(
      "the (firm, GSTIN, return, month) key is unique",
      filingIndexes.some((index) => index.unique === true && JSON.stringify(index.key) === JSON.stringify({ firmId: 1, gstin: 1, returnType: 1, period: 1 })),
    );

    await Promise.all([Record.deleteMany({}), Frequency.deleteMany({}), Filing.deleteMany({}), Firm.collection.deleteMany({ _id: { $in: [firmA, firmB] } })]);
  } finally {
    await mongoose.disconnect();
  }
}

check(
  "mongo subset ran (only when MONGODB_URI points at a scratch database)",
  mongoRan || !wantsMongo,
  wantsMongo ? "expected to run" : "MONGODB_URI not scratch-marked - Mongo assertions skipped",
);

// ─── Verdict ─────────────────────────────────────────────────────────────────

const failed = checks.filter((c) => !c.pass);
for (const c of failed) console.error(`FAIL: ${c.name}${c.detail ? ` - ${c.detail}` : ""}`);
console.log(
  `gst-downloads-contract: ${checks.length - failed.length}/${checks.length} checks passed` +
    (mongoRan ? " (mongo subset included)" : " (mongo subset SKIPPED - no scratch MONGODB_URI)"),
);
if (failed.length > 0) process.exit(1);
