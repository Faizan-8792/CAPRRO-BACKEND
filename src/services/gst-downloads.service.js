// The GST downloader's run records, per firm (GD30; GST-DOWNLOADER-PLAN section 8.13; owner
// decision OD4, 2026-10-04).
//
// After a run the extension sends what each file reached - GSTIN, return, format, period, the
// state in its one vocabulary, the file's name, size and SHA-256 - how each client filed per
// quarter, and (decision D4, GD33) whether each client had filed GSTR-1 and GSTR-3B for the months
// the run read, for the firm's filing board. They are stored as METADATA only, upserted per key, so the storage is bounded by
// clients x periods. The firm's recording switch decides whether anything is written: off means
// zero writes. Every key the client sends is validated again here; a row that fails is refused by
// itself and named in the answer, never stored, and never fails the rows around it. A row older
// than the one stored is not written over it: two devices syncing out of order keep the newest.
//
// Models are injectable so the contract test can run the rules with fakes and against a scratch
// database alike.

import mongoose from "mongoose";
import { isValidGstin } from "./gst-normalization.service.js";
import GstDownloadRecordModel, {
  GST_DOWNLOAD_FILE_TYPES,
  GST_DOWNLOAD_LIMITS,
  GST_DOWNLOAD_RETURN_TYPES,
  GST_DOWNLOAD_STATES,
} from "../models/GstDownloadRecord.js";
import GstFrequencyObservationModel, { GST_FREQUENCY_SOURCES } from "../models/GstFrequencyObservation.js";
import FilingStatusObservationModel, {
  FILING_STATUS_CLASSES,
  FILING_STATUS_RETURN_TYPES,
} from "../models/FilingStatusObservation.js";
import FirmModel from "../models/Firm.js";

export const GST_DOWNLOAD_BULK_LIMITS = Object.freeze({ records: 500, frequency: 200, filingStatus: 500, readRows: 5000 });

const PERIOD = /^(20\d{2}-(0[1-9]|1[0-2])|FY:20\d{2}-\d{2}|ledger)$/;
const FY = /^20\d{2}-\d{2}$/;
const MONTH = /^20\d{2}-(0[1-9]|1[0-2])$/;
const OUTCOME = /^[a-z0-9-]{1,48}$/;
const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PORTAL_DATE = /^\d{2}-\d{2}-\d{4}$/;
// No path ever travels: a file name is one name, without a folder or a control character.
const FILE_NAME = /^[^\\/:*?"<>|\u0000-\u001f]{1,200}$/;
// Dates outside this window are not a run's: 2017 is when GST began.
const EARLIEST = Date.UTC(2017, 6, 1);

function dateFrom(value, now) {
  if (value === null || value === undefined || value === "") return null;
  const at = new Date(value);
  const ms = at.getTime();
  if (!Number.isFinite(ms) || ms < EARLIEST || ms > now + 24 * 60 * 60 * 1000) return undefined;
  return at;
}

function gstinFrom(value) {
  const gstin = String(value || "").trim().toUpperCase();
  return isValidGstin(gstin) ? gstin : "";
}

// One record from the client, checked key by key: { ok: true, key, set } or { ok: false, reason }.
export function readRecord(input, { now = Date.now() } = {}) {
  const row = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const gstin = gstinFrom(row.gstin);
  if (!gstin) return { ok: false, reason: "gstin" };
  if (!GST_DOWNLOAD_RETURN_TYPES.includes(row.returnType)) return { ok: false, reason: "returnType" };
  if (!GST_DOWNLOAD_FILE_TYPES.includes(row.fileType)) return { ok: false, reason: "fileType" };
  if (!PERIOD.test(String(row.period || ""))) return { ok: false, reason: "period" };
  if (!GST_DOWNLOAD_STATES.includes(row.state)) return { ok: false, reason: "state" };
  const observedAt = dateFrom(row.observedAt, now);
  if (!observedAt) return { ok: false, reason: "observedAt" };
  const outcome = row.outcome === undefined || row.outcome === "" ? "" : String(row.outcome);
  if (outcome && !OUTCOME.test(outcome)) return { ok: false, reason: "outcome" };
  const fileName = row.fileName === undefined || row.fileName === "" ? "" : String(row.fileName);
  if (fileName && !FILE_NAME.test(fileName)) return { ok: false, reason: "fileName" };
  const bytes = row.bytes === undefined ? 0 : Number(row.bytes);
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > GST_DOWNLOAD_LIMITS.highestBytes) return { ok: false, reason: "bytes" };
  const sha256 = row.sha256 === undefined || row.sha256 === "" ? "" : String(row.sha256);
  if (sha256 && !SHA256.test(sha256)) return { ok: false, reason: "sha256" };
  const savedAt = dateFrom(row.savedAt, now);
  if (savedAt === undefined) return { ok: false, reason: "savedAt" };
  const runId = row.runId === undefined || row.runId === "" ? "" : String(row.runId);
  if (runId && !RUN_ID.test(runId)) return { ok: false, reason: "runId" };
  const mapVersion = row.mapVersion === undefined ? 1 : Number(row.mapVersion);
  if (!Number.isSafeInteger(mapVersion) || mapVersion < 1 || mapVersion > GST_DOWNLOAD_LIMITS.highestMapVersion) {
    return { ok: false, reason: "mapVersion" };
  }
  const generated = row.gstr2bGeneratedOn === undefined || row.gstr2bGeneratedOn === "" ? "" : String(row.gstr2bGeneratedOn);
  if (generated && !PORTAL_DATE.test(generated)) return { ok: false, reason: "gstr2bGeneratedOn" };
  const source = row.ledger && typeof row.ledger === "object" && !Array.isArray(row.ledger) ? row.ledger : {};
  const requests = source.requests === undefined ? 0 : Number(source.requests);
  if (!Number.isSafeInteger(requests) || requests < 0 || requests > GST_DOWNLOAD_LIMITS.highestRequests) {
    return { ok: false, reason: "ledger.requests" };
  }
  const firstRequestedAt = dateFrom(source.firstRequestedAt, now);
  const lastRequestedAt = dateFrom(source.lastRequestedAt, now);
  const cappedAt = dateFrom(source.cappedAt, now);
  if (firstRequestedAt === undefined || lastRequestedAt === undefined || cappedAt === undefined) {
    return { ok: false, reason: "ledger.dates" };
  }
  const capReason = source.capReason === undefined ? "" : String(source.capReason);
  if (!["", "no-file", "stuck"].includes(capReason)) return { ok: false, reason: "ledger.capReason" };
  return {
    ok: true,
    key: { gstin, returnType: row.returnType, fileType: row.fileType, period: String(row.period) },
    set: {
      state: row.state,
      outcome,
      fileName,
      bytes,
      sha256,
      savedAt,
      observedAt,
      runId,
      mapVersion,
      gstr2bGeneratedOn: generated,
      ledger: {
        requests,
        firstRequestedAt,
        lastRequestedAt,
        capped: source.capped === true,
        cappedAt,
        capReason,
      },
    },
  };
}

// One frequency observation from the client, checked the same way.
export function readFrequency(input, { now = Date.now() } = {}) {
  const row = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const gstin = gstinFrom(row.gstin);
  if (!gstin) return { ok: false, reason: "gstin" };
  const fy = String(row.fy || "");
  const match = FY.exec(fy);
  if (!match || Number(fy.slice(5)) !== (Number(fy.slice(0, 4)) + 1) % 100) return { ok: false, reason: "fy" };
  const quarter = Number(row.quarter);
  if (!Number.isInteger(quarter) || quarter < 1 || quarter > 4) return { ok: false, reason: "quarter" };
  if (row.freq !== "M" && row.freq !== "Q") return { ok: false, reason: "freq" };
  if (!GST_FREQUENCY_SOURCES.includes(row.source)) return { ok: false, reason: "source" };
  const seenAt = dateFrom(row.seenAt, now);
  if (!seenAt) return { ok: false, reason: "seenAt" };
  return {
    ok: true,
    key: { gstin, fy, quarter },
    set: { freq: row.freq, provisional: row.provisional === true, source: row.source },
    seenAt,
  };
}

// One filing status from the client (decision D4): a month's coarse class for GSTR-1 or GSTR-3B.
export function readFilingStatus(input, { now = Date.now() } = {}) {
  const row = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const gstin = gstinFrom(row.gstin);
  if (!gstin) return { ok: false, reason: "gstin" };
  if (!FILING_STATUS_RETURN_TYPES.includes(row.returnType)) return { ok: false, reason: "returnType" };
  const period = String(row.period || "");
  if (!MONTH.test(period)) return { ok: false, reason: "period" };
  if (!FILING_STATUS_CLASSES.includes(row.statusClass)) return { ok: false, reason: "statusClass" };
  const seenAt = dateFrom(row.seenAt, now);
  if (!seenAt) return { ok: false, reason: "seenAt" };
  const runId = row.runId === undefined || row.runId === "" ? "" : String(row.runId);
  if (runId && !RUN_ID.test(runId)) return { ok: false, reason: "runId" };
  return {
    ok: true,
    key: { gstin, returnType: row.returnType, period },
    set: { statusClass: row.statusClass, sourceRunId: runId },
    seenAt,
  };
}

// The financial year's period tokens: its twelve months and its annual token.
export function periodsOfYear(fy) {
  if (!FY.test(String(fy || ""))) return null;
  const start = Number(String(fy).slice(0, 4));
  const months = [];
  for (let offset = 0; offset < 12; offset += 1) {
    const month = ((3 + offset) % 12) + 1;
    const year = month >= 4 ? start : start + 1;
    months.push(`${year}-${String(month).padStart(2, "0")}`);
  }
  return [...months, `FY:${fy}`];
}

const isDuplicateKey = (error) => error?.code === 11000;

export function createGstDownloadsService({
  Record = GstDownloadRecordModel,
  Frequency = GstFrequencyObservationModel,
  Filing = FilingStatusObservationModel,
  Firm = FirmModel,
  now = () => Date.now(),
} = {}) {
  async function recordingFor(firmId) {
    const firm = await Firm.findById(firmId).select("gstDownloaderRecording").lean();
    if (!firm) return null;
    // Absent on a legacy document: the switch starts on (OD4).
    return firm.gstDownloaderRecording !== false;
  }

  // Writes one bulk of a run's records, frequency readings and filing statuses, or nothing when
  // the switch is off.
  async function recordRun({ firmId, records, frequency, filingStatus }) {
    const recording = await recordingFor(firmId);
    if (recording === null) return { ok: false, status: 404, code: "FIRM_NOT_FOUND", error: "This firm could not be found." };
    const rows = Array.isArray(records) ? records : [];
    const seen = Array.isArray(frequency) ? frequency : [];
    const filed = Array.isArray(filingStatus) ? filingStatus : [];
    if (
      rows.length > GST_DOWNLOAD_BULK_LIMITS.records ||
      seen.length > GST_DOWNLOAD_BULK_LIMITS.frequency ||
      filed.length > GST_DOWNLOAD_BULK_LIMITS.filingStatus
    ) {
      return {
        ok: false,
        status: 400,
        code: "GST_DOWNLOADS_TOO_MANY",
        error: `Send at most ${GST_DOWNLOAD_BULK_LIMITS.records} records, ${GST_DOWNLOAD_BULK_LIMITS.frequency} frequency readings and ${GST_DOWNLOAD_BULK_LIMITS.filingStatus} filing statuses at a time.`,
      };
    }
    if (!recording) return { ok: true, recording: false, recorded: 0, frequencyRecorded: 0, filingRecorded: 0, stale: 0, refused: [] };

    const at = now();
    const refused = [];
    const recordOps = [];
    rows.forEach((input, index) => {
      const read = readRecord(input, { now: at });
      if (!read.ok) {
        refused.push({ index, kind: "record", reason: read.reason });
        return;
      }
      // Only a state at least as new as the stored one is written: a stale row matches nothing,
      // tries to insert, and meets the unique key - counted as stale, never written.
      recordOps.push({
        updateOne: {
          filter: {
            firmId,
            ...read.key,
            $or: [{ observedAt: { $lte: read.set.observedAt } }, { observedAt: { $exists: false } }],
          },
          update: { $set: read.set, $setOnInsert: { firstRecordedAt: new Date(at) } },
          upsert: true,
        },
      });
    });
    const frequencyOps = [];
    seen.forEach((input, index) => {
      const read = readFrequency(input, { now: at });
      if (!read.ok) {
        refused.push({ index, kind: "frequency", reason: read.reason });
        return;
      }
      frequencyOps.push({
        updateOne: {
          filter: {
            firmId,
            ...read.key,
            $or: [{ lastSeenAt: { $lte: read.seenAt } }, { lastSeenAt: { $exists: false } }],
          },
          update: { $set: { ...read.set, lastSeenAt: read.seenAt }, $setOnInsert: { firstSeenAt: read.seenAt } },
          upsert: true,
        },
      });
    });
    const filingOps = [];
    filed.forEach((input, index) => {
      const read = readFilingStatus(input, { now: at });
      if (!read.ok) {
        refused.push({ index, kind: "filingStatus", reason: read.reason });
        return;
      }
      filingOps.push({
        updateOne: {
          filter: {
            firmId,
            ...read.key,
            $or: [{ lastSeenAt: { $lte: read.seenAt } }, { lastSeenAt: { $exists: false } }],
          },
          update: { $set: { ...read.set, lastSeenAt: read.seenAt }, $setOnInsert: { firstSeenAt: read.seenAt } },
          upsert: true,
        },
      });
    });

    // A row now holding the state sent: newly inserted, or matched (changed or already equal -
    // which is what makes a repeated sync idempotent).
    const holding = (result) =>
      Number(result?.upsertedCount ?? result?.nUpserted ?? 0) + Number(result?.matchedCount ?? result?.nMatched ?? 0);
    let stale = 0;
    const write = async (Model, ops) => {
      if (!ops.length) return 0;
      try {
        return holding(await Model.bulkWrite(ops, { ordered: false }));
      } catch (error) {
        const writeErrors = [].concat(error?.writeErrors || error?.result?.writeErrors || []);
        const duplicates = writeErrors.filter((one) => isDuplicateKey(one?.err || one));
        if (!writeErrors.length || duplicates.length !== writeErrors.length) throw error;
        stale += duplicates.length;
        return holding(error.result);
      }
    };
    const recorded = await write(Record, recordOps);
    const frequencyRecorded = await write(Frequency, frequencyOps);
    const filingRecorded = await write(Filing, filingOps);
    return { ok: true, recording: true, recorded, frequencyRecorded, filingRecorded, stale, refused };
  }

  // The firm's matrix: every record, optionally for one GSTIN and one financial year, bounded. A year
  // also carries the ledger downloads (GD83): a ledger is recorded as "ledger", which belongs to no year,
  // so a year-by-year reader would otherwise never see one.
  async function listRecords({ firmId, gstin, fy, limit }) {
    const filter = { firmId };
    if (gstin !== undefined && gstin !== "") {
      const one = gstinFrom(gstin);
      if (!one) return { ok: false, status: 400, code: "GST_DOWNLOADS_BAD_GSTIN", error: "That is not a GSTIN." };
      filter.gstin = one;
    }
    if (fy !== undefined && fy !== "") {
      const periods = periodsOfYear(fy);
      if (!periods) return { ok: false, status: 400, code: "GST_DOWNLOADS_BAD_FY", error: "A financial year reads like 2025-26." };
      filter.period = { $in: [...periods, "ledger"] };
    }
    const cap = Math.min(Math.max(Number(limit) || 2000, 1), GST_DOWNLOAD_BULK_LIMITS.readRows);
    const rows = await Record.find(filter)
      .select("-_id -firmId")
      .sort({ gstin: 1, returnType: 1, fileType: 1, period: 1 })
      .limit(cap + 1)
      .lean();
    return { ok: true, records: rows.slice(0, cap), truncated: rows.length > cap };
  }

  async function listFrequency({ firmId, gstin }) {
    const filter = { firmId };
    if (gstin !== undefined && gstin !== "") {
      const one = gstinFrom(gstin);
      if (!one) return { ok: false, status: 400, code: "GST_DOWNLOADS_BAD_GSTIN", error: "That is not a GSTIN." };
      filter.gstin = one;
    }
    const cap = GST_DOWNLOAD_BULK_LIMITS.readRows;
    const rows = await Frequency.find(filter).select("-_id -firmId").sort({ gstin: 1, fy: 1, quarter: 1 }).limit(cap + 1).lean();
    return { ok: true, frequency: rows.slice(0, cap), truncated: rows.length > cap };
  }

  // The firm's filing board (decision D4): every month's class, optionally for one GSTIN and one
  // financial year, bounded.
  async function listFilingStatus({ firmId, gstin, fy }) {
    const filter = { firmId };
    if (gstin !== undefined && gstin !== "") {
      const one = gstinFrom(gstin);
      if (!one) return { ok: false, status: 400, code: "GST_DOWNLOADS_BAD_GSTIN", error: "That is not a GSTIN." };
      filter.gstin = one;
    }
    if (fy !== undefined && fy !== "") {
      const periods = periodsOfYear(fy);
      if (!periods) return { ok: false, status: 400, code: "GST_DOWNLOADS_BAD_FY", error: "A financial year reads like 2025-26." };
      filter.period = { $in: periods.filter((period) => MONTH.test(period)) };
    }
    const cap = GST_DOWNLOAD_BULK_LIMITS.readRows;
    const rows = await Filing.find(filter).select("-_id -firmId").sort({ gstin: 1, returnType: 1, period: 1 }).limit(cap + 1).lean();
    return { ok: true, filingStatus: rows.slice(0, cap), truncated: rows.length > cap };
  }

  async function readSettings({ firmId }) {
    const recording = await recordingFor(firmId);
    if (recording === null) return { ok: false, status: 404, code: "FIRM_NOT_FOUND", error: "This firm could not be found." };
    return { ok: true, settings: { recording } };
  }

  async function writeSettings({ firmId, input }) {
    if (!input || typeof input !== "object" || typeof input.recording !== "boolean") {
      return { ok: false, status: 400, code: "GST_DOWNLOADS_BAD_SETTINGS", error: "Say whether the firm records downloader runs: true or false." };
    }
    const updated = await Firm.findByIdAndUpdate(firmId, { $set: { gstDownloaderRecording: input.recording } }, { new: true })
      .select("gstDownloaderRecording")
      .lean();
    if (!updated) return { ok: false, status: 404, code: "FIRM_NOT_FOUND", error: "This firm could not be found." };
    return { ok: true, settings: { recording: updated.gstDownloaderRecording !== false } };
  }

  return { recordRun, listRecords, listFrequency, listFilingStatus, readSettings, writeSettings };
}

export const gstDownloadsService = createGstDownloadsService();

export function isFirmId(value) {
  return mongoose.isValidObjectId(value);
}
