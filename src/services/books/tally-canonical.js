// src/services/books/tally-canonical.js
//
// W10 AP18 (2026-10-17): reads and validates one chunk of canonical Tally records (the NDJSON the client
// readers write - audit-nlp-extension/tally/tally-xml.js and Core/Books/TallyXmlReader.cs). Strict on
// purpose: an unknown key, a float where paise belong, a string where a date belongs or a record larger
// than any real voucher is refused with the line named, so a reader bug or a tampered upload is a visible
// 400 and not a silently wrong ledger.
//
// PURE: no I/O.

import { createHash } from "node:crypto";

export const MAX_CHUNK_RECORDS = 5_000;
export const MAX_LINE_BYTES = 256 * 1024;
const MAX_ENTRIES = 1_000;
const MAX_BILLS = 1_000;
const MAX_BANKS = 500;
const ALLOWED_WARNINGS = new Set(["AMOUNT_UNREADABLE", "DATE_UNREADABLE"]);

export const KIND_TO_TYPE = Object.freeze({ groups: "group", ledgers: "ledger", vouchers: "voucher" });

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function fail(lineNumber, message) {
  throw new RangeError(`Line ${lineNumber}: ${message}`);
}

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

function str(lineNumber, record, key, max, { allowNewlines = false } = {}) {
  const value = record[key];
  if (typeof value !== "string") fail(lineNumber, `${key} must be text`);
  if (value.length > max) fail(lineNumber, `${key} is longer than ${max} characters`);
  if (CONTROL.test(value)) fail(lineNumber, `${key} contains a control character`);
  if (!allowNewlines && /[\r\n]/.test(value)) fail(lineNumber, `${key} contains a line break`);
  return value;
}

function nullableInt(lineNumber, record, key, { min = null } = {}) {
  const value = record[key];
  if (value === null) return null;
  if (!Number.isSafeInteger(value)) fail(lineNumber, `${key} must be a whole number or null`);
  if (min !== null && value < min) fail(lineNumber, `${key} cannot be below ${min}`);
  return value;
}

function nullableBool(lineNumber, record, key) {
  const value = record[key];
  if (value === null || typeof value === "boolean") return value;
  return fail(lineNumber, `${key} must be true, false or null`);
}

function nullableDate(lineNumber, record, key) {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(lineNumber, `${key} must be a date like 2025-04-15 or null`);
  const [y, m, d] = value.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) fail(lineNumber, `${key} is not a day that exists`);
  return value;
}

function warnings(lineNumber, record) {
  if (!Array.isArray(record.warnings)) fail(lineNumber, "warnings must be a list");
  for (const w of record.warnings) if (!ALLOWED_WARNINGS.has(w)) fail(lineNumber, `warning "${String(w).slice(0, 40)}" is not one this server knows`);
  return [...record.warnings];
}

function exactKeys(lineNumber, record, keys) {
  const extra = Object.keys(record).filter((k) => !keys.includes(k));
  const missing = keys.filter((k) => !Object.prototype.hasOwnProperty.call(record, k));
  if (extra.length) fail(lineNumber, `unknown field ${extra.slice(0, 3).join(", ")}`);
  if (missing.length) fail(lineNumber, `missing field ${missing.slice(0, 3).join(", ")}`);
}

const nameKey = (value) => value.toLowerCase().replace(/\s+/g, " ").trim();

function groupDoc(n, r) {
  exactKeys(n, r, ["t", "guid", "alterId", "name", "parent", "reserved", "warnings"]);
  const name = str(n, r, "name", 300);
  if (!name.trim()) fail(n, "a group needs a name");
  return {
    recordKey: nameKey(name),
    guid: str(n, r, "guid", 80),
    alterId: nullableInt(n, r, "alterId", { min: 0 }),
    name,
    parent: str(n, r, "parent", 300),
    reserved: str(n, r, "reserved", 120),
    _warnings: warnings(n, r),
  };
}

function ledgerDoc(n, r) {
  exactKeys(n, r, ["t", "guid", "alterId", "name", "parent", "openingMinor", "gstin", "pan", "gstRegistrationType", "isBillwise", "creditPeriodDays", "udyam", "warnings"]);
  const name = str(n, r, "name", 300);
  if (!name.trim()) fail(n, "a ledger needs a name");
  return {
    recordKey: nameKey(name),
    guid: str(n, r, "guid", 80),
    alterId: nullableInt(n, r, "alterId", { min: 0 }),
    name,
    parent: str(n, r, "parent", 300),
    openingMinor: nullableInt(n, r, "openingMinor"),
    gstin: str(n, r, "gstin", 20),
    pan: str(n, r, "pan", 12),
    gstRegistrationType: str(n, r, "gstRegistrationType", 60),
    isBillwise: nullableBool(n, r, "isBillwise"),
    creditPeriodDays: nullableInt(n, r, "creditPeriodDays", { min: 0 }),
    udyam: str(n, r, "udyam", 40),
    warnings: warnings(n, r),
    _warnings: r.warnings,
  };
}

function voucherDoc(n, r, line) {
  exactKeys(n, r, ["t", "guid", "alterId", "date", "type", "number", "narration", "partyLedger", "reference", "cancelled", "optional", "entries", "bills", "banks", "warnings"]);
  for (const [key, max] of [["entries", MAX_ENTRIES], ["bills", MAX_BILLS], ["banks", MAX_BANKS]]) {
    if (!Array.isArray(r[key])) fail(n, `${key} must be a list`);
    if (r[key].length > max) fail(n, `${key} has more than ${max} items`);
  }
  const entries = r.entries.map((e) => {
    if (!e || typeof e !== "object") fail(n, "an entry must be an object");
    exactKeys(n, e, ["ledger", "amountMinor"]);
    return { ledger: str(n, e, "ledger", 300), amountMinor: nullableInt(n, e, "amountMinor") };
  });
  const bills = r.bills.map((b) => {
    if (!b || typeof b !== "object") fail(n, "a bill must be an object");
    exactKeys(n, b, ["ledger", "name", "billType", "amountMinor", "creditPeriodDays"]);
    return { ledger: str(n, b, "ledger", 300), name: str(n, b, "name", 300), billType: str(n, b, "billType", 60), amountMinor: nullableInt(n, b, "amountMinor"), creditPeriodDays: nullableInt(n, b, "creditPeriodDays", { min: 0 }) };
  });
  const banks = r.banks.map((b) => {
    if (!b || typeof b !== "object") fail(n, "a bank allocation must be an object");
    exactKeys(n, b, ["ledger", "instrumentNumber", "instrumentDate", "transactionType", "bankName", "amountMinor"]);
    return { ledger: str(n, b, "ledger", 300), instrumentNumber: str(n, b, "instrumentNumber", 60), instrumentDate: nullableDate(n, b, "instrumentDate"), transactionType: str(n, b, "transactionType", 60), bankName: str(n, b, "bankName", 120), amountMinor: nullableInt(n, b, "amountMinor") };
  });
  const guid = str(n, r, "guid", 80);
  const alterId = nullableInt(n, r, "alterId", { min: 0 });
  const date = nullableDate(n, r, "date");
  const type = str(n, r, "type", 80);
  const number = str(n, r, "number", 80);
  // The identity of a voucher inside a snapshot: its GUID, or - for an export that carries none - the
  // fields that together name it.
  const recordKey = guid || `k:${sha256(`${date}|${type}|${number}|${alterId}`).slice(0, 40)}`;
  if (typeof r.cancelled !== "boolean" || typeof r.optional !== "boolean") fail(n, "cancelled and optional must be true or false");
  return {
    recordKey,
    lineHash: sha256(line),
    guid,
    alterId,
    date,
    type,
    number,
    narration: str(n, r, "narration", 4000, { allowNewlines: true }),
    partyLedger: str(n, r, "partyLedger", 300),
    reference: str(n, r, "reference", 120),
    cancelled: r.cancelled,
    optional: r.optional,
    entries,
    bills,
    banks,
    warnings: warnings(n, r),
    _warnings: r.warnings,
  };
}

/**
 * Parses and validates one chunk. Returns the documents ready to store (without firm, snapshot or chunk token)
 * and what the records said about themselves.
 * @throws {RangeError} naming the line
 */
export function parseChunk(kind, ndjson) {
  if (!Object.prototype.hasOwnProperty.call(KIND_TO_TYPE, kind)) throw new RangeError("A chunk is groups, ledgers or vouchers.");
  if (typeof ndjson !== "string" || ndjson.length === 0) throw new RangeError("A chunk needs at least one record.");
  const lines = ndjson.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) throw new RangeError("A chunk needs at least one record.");
  if (lines.length > MAX_CHUNK_RECORDS) throw new RangeError(`A chunk holds at most ${MAX_CHUNK_RECORDS} records.`);
  const seen = new Set();
  const docs = [];
  let alterMin = null;
  let alterMax = null;
  let dateMin = null;
  let dateMax = null;
  let recordsWithWarnings = 0;
  let amountsUnreadable = 0;
  let datesUnreadable = 0;
  lines.forEach((line, index) => {
    const n = index + 1;
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) fail(n, "the record is larger than any real voucher");
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return fail(n, "not valid JSON");
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) fail(n, "a record must be an object");
    if (record.t !== KIND_TO_TYPE[kind]) fail(n, `expected a ${KIND_TO_TYPE[kind]}, found "${String(record.t).slice(0, 20)}"`);
    const doc = kind === "groups" ? groupDoc(n, record) : kind === "ledgers" ? ledgerDoc(n, record) : voucherDoc(n, record, line);
    if (seen.has(doc.recordKey)) fail(n, "the same record appears twice in this chunk");
    seen.add(doc.recordKey);
    const w = doc._warnings || doc.warnings || [];
    delete doc._warnings;
    if (w.length) {
      recordsWithWarnings += 1;
      if (w.includes("AMOUNT_UNREADABLE")) amountsUnreadable += 1;
      if (w.includes("DATE_UNREADABLE")) datesUnreadable += 1;
    }
    if (doc.alterId !== null && doc.alterId !== undefined) {
      alterMin = alterMin === null ? doc.alterId : Math.min(alterMin, doc.alterId);
      alterMax = alterMax === null ? doc.alterId : Math.max(alterMax, doc.alterId);
    }
    if (kind === "vouchers" && doc.date) {
      dateMin = dateMin === null || doc.date < dateMin ? doc.date : dateMin;
      dateMax = dateMax === null || doc.date > dateMax ? doc.date : dateMax;
    }
    docs.push(doc);
  });
  return { docs, count: docs.length, alterMin, alterMax, dateMin, dateMax, recordsWithWarnings, amountsUnreadable, datesUnreadable };
}

/** The digest a sealed snapshot carries: every chunk's kind, order and hash, so two uploads of the same file agree. */
export function chunkDigest(chunkLog) {
  const order = { groups: 0, ledgers: 1, vouchers: 2 };
  const sorted = [...chunkLog].sort((a, b) => order[a.kind] - order[b.kind] || a.seq - b.seq);
  return sha256(sorted.map((c) => `${c.kind}:${c.seq}:${c.hash}:${c.count}`).join("\n"));
}
