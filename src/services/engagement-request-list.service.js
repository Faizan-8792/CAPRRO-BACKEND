// src/services/engagement-request-list.service.js
//
// W10 AP41 (2026-10-17). The measured request list and the chase draft.
//
// The old reminder draft stated how long something had been pending, and when no figure was sent the
// server wrote 3 - a sentence about a client that nothing had checked. This module is the other way
// round. A request enters the engagement's list WITH the moment it was asked for, so "pending for N
// days" is a subtraction of two recorded UTC days, never a default; and a chase draft is built only
// from requests that carry that moment. A draft with nothing measured is refused, not filled in.
//
// Two pure halves live here (the engagement service does the writing):
//   proposalsFromGapRows  what a pack could not complete that only the CLIENT can supply, grouped, in
//                         words a client understands. A closed table: a gap that is the CA's own job
//                         (map a group, supply a bank rate) is never turned into a request to a client.
//   buildChaseDraft       the DRAFT FOR REVIEW - NOT SENT text, from requests with a recorded date.

import { utcDayNumber } from "./deadline-catalogue.service.js";

export const CHASE_LABEL = "DRAFT FOR REVIEW - NOT SENT";
export const CHASE_NOTHING_SENT = "Nothing has been sent and nothing has been recorded against the client. Edit this text, then send it yourself from your own email or messaging app.";
export const PACK_REQUEST_CATEGORY = "PACK_INPUT";
export const PACK_REQUEST_LIMIT = 200; // the engagement's clientRequests array limit

/**
 * The gaps a client can close, by the rule code the pack row carries. `title` is the request as it will
 * read on the list; `{n}` is the number of rows in the group. Wording is operational (what to send),
 * claims nothing about the law, and the person reviews it before it is added.
 */
export const CLIENT_ACTION_GAPS = Object.freeze({
  UDYAM_UNKNOWN: { title: "Micro or small enterprise status (Udyam certificate) of {n} supplier(s)", detail: "The party master does not say whether these suppliers are micro or small enterprises, so clause 22 could not be checked for them." },
  UDYAM_CATEGORY_UNANSWERED: { title: "Micro or small enterprise status (Udyam certificate) of {n} supplier(s)", detail: "The ageing could not separate micro and small enterprises from other suppliers until their status is known." },
  PURCHASES_NOT_BILLWISE: { title: "Bill-wise details of purchases from {n} supplier(s)", detail: "Purchases were posted without bill references, so no due date could be worked out for them." },
  PAYMENTS_NOT_AGAINST_BILLS: { title: "The bills that payments to {n} supplier(s) were made against", detail: "Payments were posted without bill references, so they could not be matched to bills." },
  NEXT_YEAR_PAYMENTS_NOT_LOADED: { title: "Payments made after the year end, up to the return due date (vouchers or bank statement)", detail: "Without them it cannot be seen whether the dues outstanding at year end were paid in time." },
  FILING_DATE_UNKNOWN: { title: "Filing dates (acknowledgements) of the TDS statements", detail: "The dates the statements were filed were not in the data, so lateness could not be measured." },
  NO_CHALLAN_ROWS: { title: "TDS challan details", detail: "No challan rows were loaded, so deposits could not be matched to deductions." },
  NO_STATEMENT_ROW: { title: "TDS statement details for {n} quarter(s)", detail: "No statement was found for these quarters." },
  NO_TDS_ROWS: { title: "TDS deduction details", detail: "No TDS rows were loaded." },
  NO_LENDER_ACCOUNTS: { title: "Details of loans and deposits taken: lender names and accounts", detail: "No lender account could be identified in the books." },
  STOCK_NOT_POSTED: { title: "Closing stock valuation for the year", detail: "The closing stock was not posted in the books, so the ratios that use it could not be completed." },
  CAPITAL_ADDITIONS_UNKNOWN: { title: "Details of capital additions during the year", detail: "The additions were not identifiable from the books." },
  NO_VOUCHERS: { title: "The day book (vouchers) for the year", detail: "No vouchers were loaded, so the scans could not run." },
});

/**
 * Group a run's PENDING_INPUT rows into proposals. A row counts toward the proposal of its first rule
 * hit's code; a code outside the table is ignored. `alreadyRequested` is filled by the caller.
 *
 * @param {string} kind        the run's pack kind
 * @param {Array}  rows        the run's PENDING_INPUT rows ({ ruleHits: [{ rule }], label })
 * @returns {Array<{ code, kind, count, title, detail, sampleLabels }>}
 */
export function proposalsFromGapRows(kind, rows) {
  const groups = new Map();
  for (const row of rows || []) {
    const code = row?.ruleHits?.[0]?.rule;
    if (!code || !Object.prototype.hasOwnProperty.call(CLIENT_ACTION_GAPS, code)) continue;
    const group = groups.get(code) || { code, kind, count: 0, sampleLabels: [] };
    group.count += 1;
    if (group.sampleLabels.length < 3 && row.label) group.sampleLabels.push(String(row.label).slice(0, 160));
    groups.set(code, group);
  }
  return [...groups.values()]
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((g) => ({
      ...g,
      title: CLIENT_ACTION_GAPS[g.code].title.replaceAll("{n}", String(g.count)).slice(0, 500),
      detail: CLIENT_ACTION_GAPS[g.code].detail,
    }));
}

/** The stable key a pack request carries, so the same gap is never added twice. */
export const packRequestKey = (kind, code, financialYear) => `pack:${kind}:${code}:${financialYear}`.slice(0, 120);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A moment as the UTC day it fell in, written "7 Oct 2026". Never reads the local zone. */
export function formatUtcDay(moment) {
  const d = moment instanceof Date ? moment : new Date(moment);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

const OPEN_STATUSES = new Set(["REQUESTED", "PARTIAL"]);

/**
 * The days a request has been pending: the UTC day now minus the UTC day it was asked for. Null when it
 * was never given a request date or the date is in the future (neither is a measurement).
 */
export function daysPending(request, now = new Date()) {
  if (!request?.requestedAt) return null;
  const asked = utcDayNumber(new Date(request.requestedAt));
  if (!Number.isFinite(asked)) return null;
  const days = utcDayNumber(now) - asked;
  return days >= 0 ? days : null;
}

/**
 * A chase message from the real list. Refuses (ok:false, code NO_MEASURED_REQUESTS) when no open request
 * has a recorded request date - there is then no honest figure to state. Requests without a date are
 * listed beside the measured ones with no figure at all, and counted in `unmeasured`.
 */
export function buildChaseDraft({ clientName, requests, now = new Date() }) {
  const open = (requests || []).filter((r) => OPEN_STATUSES.has(r.status));
  const measured = [];
  const unmeasured = [];
  for (const r of open) {
    const days = daysPending(r, now);
    if (days === null) unmeasured.push(r);
    else measured.push({ r, days });
  }
  if (measured.length === 0) {
    return {
      ok: false,
      code: "NO_MEASURED_REQUESTS",
      message: open.length
        ? "None of the open requests has a recorded request date, so no pending time can be stated. Mark them as requested here first, then draft the message."
        : "There is nothing open on the request list to chase.",
    };
  }
  measured.sort((a, b) => b.days - a.days || String(a.r.title).localeCompare(String(b.r.title)));

  const name = String(clientName || "").trim() || "Sir / Madam";
  const lines = measured.map(({ r, days }, i) =>
    `${i + 1}. ${r.title} - asked for on ${formatUtcDay(r.requestedAt)}, pending for ${days} ${days === 1 ? "day" : "days"}${r.dueAt ? `, due ${formatUtcDay(r.dueAt)}` : ""}`);
  const extra = unmeasured.map((r, i) => `${measured.length + i + 1}. ${r.title}`);
  const body = [
    `Dear ${name},`,
    "",
    "We are still waiting for the following, which we asked you for earlier:",
    "",
    ...lines,
    ...extra,
    "",
    "Please send them when you can, so that we can continue the work.",
    "",
    "Regards",
  ].join("\n");

  return {
    ok: true,
    label: CHASE_LABEL,
    nothingSent: true,
    note: CHASE_NOTHING_SENT,
    subject: `Documents still pending - ${name}`.slice(0, 200),
    body,
    items: measured.map(({ r, days }) => ({ id: String(r._id || ""), title: r.title, requestedOn: formatUtcDay(r.requestedAt), daysPending: days })),
    unmeasured: unmeasured.map((r) => ({ id: String(r._id || ""), title: r.title })),
    measuredCount: measured.length,
    unmeasuredCount: unmeasured.length,
  };
}
