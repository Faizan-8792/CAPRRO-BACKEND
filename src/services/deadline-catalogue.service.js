// src/services/deadline-catalogue.service.js
//
// W10 AP40 (2026-10-17). The deadline catalogue: for a form, a client type and a financial year, the
// STATUTORY date and - stored separately, never merged into it - any NOTIFIED EXTENSION with the
// reference that notified it. The owner publishes it from the admin panel (an AppConfig document), so a
// new notification reaches both clients without a release.
//
// THE RULE THIS FILE EXISTS FOR: a due date is a UTC day, and nothing here ever builds a local Date.
// Converting 2026-10-31 to local time and reading the day back moves it to 30 Oct in a zone west of
// UTC and to 1 Nov in one far enough east, and a statutory deadline that crosses a day boundary lands
// in a different return period (CLAUDE.md section 8). So a day travels as the string "YYYY-MM-DD",
// is checked by a UTC round trip, and is compared as an integer day number (UTC milliseconds / 86 400
// 000). tests/deadline-catalogue-contract.mjs runs the same computations under five time zones, one of
// them UTC+14 and one UTC-11, and fails if any answer differs - and proves a local-time version would
// have, so the test is not vacuous.
//
// NOTHING IS PRE-FILLED. A statutory date is a fact the owner publishes from the notification, not one
// this code remembers: an empty catalogue is the honest state until then.

import { ENTITY_TYPES } from "../models/Client.js";

export const DEADLINE_ENTRY_LIMIT = 300;
export const DEADLINE_CLIENT_TYPES = Object.freeze(["ALL", ...ENTITY_TYPES]);
export const DEADLINE_REASON_MIN = 3;

const MS_PER_DAY = 86_400_000;
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const FORM_KEY = /^[A-Z0-9][A-Z0-9 _\-/]{0,39}$/;
const FINANCIAL_YEAR = /^(\d{4})-(\d{2})$/;

/** "2026-10-31" -> { year, month, day, dayNumber }, or null for anything that is not a real calendar day. */
export function parseIsoDay(value) {
  if (typeof value !== "string") return null;
  const match = ISO_DAY.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const ms = Date.UTC(year, month - 1, day);
  const back = new Date(ms);
  // Date.UTC rolls 2026-02-30 forward to 2 March; the round trip through UTC getters catches it.
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) return null;
  return { year, month, day, dayNumber: ms / MS_PER_DAY };
}

/** The UTC day a moment falls in, as an integer day number. Never reads the local zone. */
export function utcDayNumber(moment = new Date()) {
  const ms = moment instanceof Date ? moment.getTime() : Number(moment);
  return Math.floor(ms / MS_PER_DAY);
}

/** An integer day number back to "YYYY-MM-DD" (UTC). */
export function isoDayFromNumber(dayNumber) {
  const d = new Date(dayNumber * MS_PER_DAY);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getUTCFullYear(), 4)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/** Whole UTC days from `now`'s UTC day to the given day: positive = days left, 0 = today, negative = days overdue. */
export function daysUntil(isoDay, now = new Date()) {
  const parsed = parseIsoDay(isoDay);
  if (!parsed) return null;
  return parsed.dayNumber - utcDayNumber(now);
}

const clean = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");

/**
 * Checks and normalises a catalogue. Returns { ok: true, entries } or { ok: false, errors } naming the
 * entry (1-based) and the field, so the admin panel can say exactly what to fix. Nothing is written for
 * a catalogue with any error: a half-published statutory calendar is worse than the old one.
 */
export function validateCatalogueEntries(entries) {
  const errors = [];
  const fail = (index, field, message) => errors.push({ entry: index + 1, field, message });
  if (!Array.isArray(entries)) return { ok: false, errors: [{ entry: 0, field: "entries", message: "The catalogue must be a list of entries." }] };
  if (entries.length > DEADLINE_ENTRY_LIMIT) {
    return { ok: false, errors: [{ entry: 0, field: "entries", message: `The catalogue holds at most ${DEADLINE_ENTRY_LIMIT} entries.` }] };
  }

  const seen = new Set();
  const out = [];
  entries.forEach((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      fail(index, "entry", "An entry must be an object.");
      return;
    }
    const formKey = clean(raw.formKey, 40).toUpperCase();
    if (!FORM_KEY.test(formKey)) fail(index, "formKey", "The form key is required: capitals, digits, space, - _ / only, at most 40 characters.");
    const label = clean(raw.label, 120);
    if (label.length < 2) fail(index, "label", "A label is required (what the date is for).");
    const clientType = clean(raw.clientType ?? "ALL", 40).toUpperCase() || "ALL";
    if (!DEADLINE_CLIENT_TYPES.includes(clientType)) fail(index, "clientType", `The client type must be one of ${DEADLINE_CLIENT_TYPES.join(", ")}.`);
    const financialYear = clean(raw.financialYear, 7);
    const fy = FINANCIAL_YEAR.exec(financialYear);
    if (!fy || (Number(fy[1]) + 1) % 100 !== Number(fy[2])) fail(index, "financialYear", "The financial year is written 2025-26: four digits, a dash and the next year's last two.");

    const statutory = parseIsoDay(raw.statutoryDate);
    if (!statutory) fail(index, "statutoryDate", "The statutory date is required, as a real day written YYYY-MM-DD.");

    let extendedDate = null;
    let extensionReference = "";
    const hasExtendedDate = raw.extendedDate !== undefined && raw.extendedDate !== null && raw.extendedDate !== "";
    if (hasExtendedDate) {
      const extended = parseIsoDay(raw.extendedDate);
      if (!extended) fail(index, "extendedDate", "The extended date must be a real day written YYYY-MM-DD.");
      else if (statutory && extended.dayNumber < statutory.dayNumber) fail(index, "extendedDate", "An extension cannot fall before the statutory date.");
      else extendedDate = raw.extendedDate;
      extensionReference = clean(raw.extensionReference, 300);
      if (extensionReference.length < 3) fail(index, "extensionReference", "An extension needs the reference of the notification that granted it.");
    } else if (clean(raw.extensionReference, 300)) {
      fail(index, "extendedDate", "An extension reference was given without an extended date.");
    }

    const key = `${formKey}|${clientType}|${financialYear}`;
    if (seen.has(key)) fail(index, "formKey", "Another entry already covers this form, client type and financial year.");
    seen.add(key);

    out.push({
      formKey,
      label,
      clientType,
      financialYear,
      statutoryDate: statutory ? raw.statutoryDate : "",
      extendedDate,
      extensionReference,
      note: clean(raw.note, 500),
    });
  });

  return errors.length ? { ok: false, errors } : { ok: true, entries: out };
}

/** The date a person should work to: the extension if one was notified, else the statutory date. Both stay on the entry. */
export function effectiveDate(entry) {
  return entry.extendedDate || entry.statutoryDate;
}

/**
 * What the public config serves for a stored catalogue, or null when none was ever published. Dates stay
 * strings; the clients compute "days left" from the UTC day with the same rules as daysUntil above.
 */
export function publishableCatalogue(stored) {
  if (!stored || !Number.isSafeInteger(stored.version) || stored.version < 1 || !Array.isArray(stored.entries)) return null;
  return {
    version: stored.version,
    publishedAt: stored.publishedAt || null,
    entries: stored.entries.map((e) => ({
      formKey: e.formKey,
      label: e.label,
      clientType: e.clientType,
      financialYear: e.financialYear,
      statutoryDate: e.statutoryDate,
      extendedDate: e.extendedDate || null,
      extensionReference: e.extensionReference || "",
      note: e.note || "",
      effectiveDate: effectiveDate(e),
    })),
  };
}
