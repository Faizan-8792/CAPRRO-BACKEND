// src/services/notice-catalogue.service.js
//
// W11 IN21 (2026-10-21): the notice catalogue the owner publishes from the admin panel - for each notice form,
// the standard reply window in days and what it runs from, with the reference it comes from; and the rule for
// which Income-tax Act governs a period. Stored on AppConfig like the deadline catalogue, so a correction
// reaches both clients without a release.
//
// NOTHING IS PRE-FILLED. A reply window and the Act transition are statutory facts the owner publishes from the
// rule or notification; this code only checks their shape and does the day arithmetic. Until something is
// published, the case screen shows the date the notice states and nothing else.
//
// Dates are UTC days ("YYYY-MM-DD") and the arithmetic is on integer day numbers (deadline-catalogue.service.js),
// so no time zone can move a reply-by date. The date the notice STATES is never replaced: a computed date is shown
// beside it only when the two differ, with both sources.

import { NOTICE_RECOGNISERS } from "./notice-rules/index.js";
import { isoDayFromNumber, parseIsoDay } from "./deadline-catalogue.service.js";

export const NOTICE_CATALOGUE_ENTRY_LIMIT = 60;
export const NOTICE_WINDOW_BASES = Object.freeze(["ISSUE_DATE", "RECEIPT_DATE"]);
export const NOTICE_FORM_IDS = Object.freeze(NOTICE_RECOGNISERS.map((entry) => entry.id));

const text = (value) => (typeof value === "string" ? value.trim() : "");

/** Checks a whole published catalogue. Returns { ok, entries, actTransition } or { ok: false, errors }. */
export function validateNoticeCatalogue(input) {
  const errors = [];
  const entries = [];
  const raw = Array.isArray(input?.entries) ? input.entries : null;
  if (!raw) errors.push("entries must be a list (it may be empty).");
  else if (raw.length > NOTICE_CATALOGUE_ENTRY_LIMIT) errors.push(`At most ${NOTICE_CATALOGUE_ENTRY_LIMIT} entries.`);
  const seen = new Set();
  (raw || []).slice(0, NOTICE_CATALOGUE_ENTRY_LIMIT).forEach((entry, index) => {
    const at = `Entry ${index + 1}`;
    const form = text(entry?.form);
    if (!NOTICE_FORM_IDS.includes(form)) errors.push(`${at}: form must be one of ${NOTICE_FORM_IDS.join(", ")}.`);
    else if (seen.has(form)) errors.push(`${at}: ${form} is listed twice.`);
    seen.add(form);
    const windowDays = entry?.windowDays;
    if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 365) errors.push(`${at}: windowDays must be a whole number of days from 1 to 365.`);
    const basis = text(entry?.basis);
    if (!NOTICE_WINDOW_BASES.includes(basis)) errors.push(`${at}: basis must be ISSUE_DATE or RECEIPT_DATE.`);
    const sourceReference = text(entry?.sourceReference);
    if (sourceReference.length < 3 || sourceReference.length > 300) errors.push(`${at}: sourceReference (the rule or notification) is required, 3 to 300 characters.`);
    entries.push({ form, windowDays, basis, sourceReference });
  });
  let actTransition = null;
  if (input?.actTransition !== undefined && input.actTransition !== null) {
    const at = input.actTransition;
    const effectiveFrom = text(at?.effectiveFrom);
    const before = text(at?.before);
    const after = text(at?.after);
    const sourceReference = text(at?.sourceReference);
    if (!parseIsoDay(effectiveFrom)) errors.push("actTransition.effectiveFrom must be a real day written YYYY-MM-DD.");
    if (before.length < 3 || before.length > 120) errors.push("actTransition.before must name the earlier Act (3 to 120 characters).");
    if (after.length < 3 || after.length > 120) errors.push("actTransition.after must name the later Act (3 to 120 characters).");
    if (sourceReference.length < 3 || sourceReference.length > 300) errors.push("actTransition.sourceReference is required, 3 to 300 characters.");
    actTransition = { effectiveFrom, before, after, sourceReference };
  }
  return errors.length ? { ok: false, errors } : { ok: true, entries, actTransition };
}

/** The catalogue as clients see it, or null while nothing has been published. */
export function publishableNoticeCatalogue(stored) {
  if (!stored || !Number.isSafeInteger(stored.version) || stored.version < 1) return null;
  return {
    version: stored.version,
    publishedAt: stored.publishedAt ? new Date(stored.publishedAt).toISOString() : null,
    entries: (stored.entries || []).map(({ form, windowDays, basis, sourceReference }) => ({ form, windowDays, basis, sourceReference })),
    actTransition: stored.actTransition?.effectiveFrom
      ? {
          effectiveFrom: stored.actTransition.effectiveFrom,
          before: stored.actTransition.before,
          after: stored.actTransition.after,
          sourceReference: stored.actTransition.sourceReference,
        }
      : null,
  };
}

/**
 * The stated reply-by date against the published window. Returns null when there is nothing to compare (no
 * entry for the form, no stated date, or no start day for the window's basis). `consistent` is true when the
 * stated date equals the computed one; when it is false, both are shown and the stated date stands.
 */
export function replyWindowCheck({ catalogue, formId, statedDueDate, issueDate, receivedDate }) {
  const entry = catalogue?.entries?.find((candidate) => candidate.form === formId);
  if (!entry) return null;
  const stated = parseIsoDay(statedDueDate || "");
  const start = parseIsoDay((entry.basis === "RECEIPT_DATE" ? receivedDate : issueDate) || "");
  if (!start) return { stated: stated ? statedDueDate : null, computed: null, consistent: null, windowDays: entry.windowDays, basis: entry.basis, sourceReference: entry.sourceReference, note: entry.basis === "RECEIPT_DATE" ? "Record the date the notice was received to compare." : "The issue date is not known yet." };
  const computed = isoDayFromNumber(start.dayNumber + entry.windowDays);
  return {
    stated: stated ? statedDueDate : null,
    computed,
    consistent: stated ? stated.dayNumber === start.dayNumber + entry.windowDays : null,
    windowDays: entry.windowDays,
    basis: entry.basis,
    sourceReference: entry.sourceReference,
    note: "",
  };
}

/** The first day of a period the case states (financial year, assessment year's previous year, or a period). */
export function periodStartDay({ financialYear, assessmentYear, period }) {
  const fy = /^(20\d{2})-\d{2}$/.exec(String(financialYear || ""));
  if (fy) return `${fy[1]}-04-01`;
  const ay = /^(20\d{2})-\d{2}$/.exec(String(assessmentYear || ""));
  if (ay) return `${Number(ay[1]) - 1}-04-01`;
  const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const p = /^(?:From\s+)?([A-Za-z]{3})[A-Za-z]*[,\s]+(20\d{2})/i.exec(String(period || ""));
  if (p && months[p[1].toLowerCase()]) return `${p[2]}-${String(months[p[1].toLowerCase()]).padStart(2, "0")}-01`;
  return null;
}

/** Which Act the published rule names for a period, or null when no rule is published or no period is known. */
export function actForPeriod(catalogue, periodFacts) {
  const transition = catalogue?.actTransition;
  if (!transition) return null;
  const start = periodStartDay(periodFacts);
  const day = parseIsoDay(start || "");
  const from = parseIsoDay(transition.effectiveFrom);
  if (!day || !from) return null;
  return {
    act: day.dayNumber < from.dayNumber ? transition.before : transition.after,
    periodStart: start,
    sourceReference: transition.sourceReference,
    basis: `Published rule: periods beginning on or after ${transition.effectiveFrom} fall under ${transition.after}.`,
  };
}
