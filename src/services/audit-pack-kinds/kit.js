// src/services/audit-pack-kinds/kit.js
//
// W10 (2026-10-17): what every pack engine after Clause 44 shares, so no pack carries a private copy
// of the row model, the money arithmetic or the comparison shape (plan design rule 8).
//
// PURE. No I/O, no clock, no randomness. Money is integer paise and every sum is BigInt-checked: a
// float anywhere in a statutory total is a defect, and a total that leaves the safe range throws
// rather than rounding.

import { createHash } from "node:crypto";
import { financialYearMonths } from "../audit-pack-engine/clause44.engine.js";

export { financialYearMonths };

export const ROW_STATES = Object.freeze(["COMPUTED", "CONFIRMED", "EXCLUDED", "PENDING_INPUT"]);

// A reconciliation that agrees to the rupee is rare: returns are filed in whole rupees by some and in
// paise by others. Within ten rupees a difference is rounding and is labelled so; above it, it is a
// residual a person must explain. Versioned with each pack's rule version, because moving it moves
// which rows need an answer.
export const ROUNDING_TOLERANCE_MINOR = 1_000;

const MAX_EMBEDDED_SOURCES = 100;

export function hit(rule, detail, threshold = null) {
  return { rule, threshold, detail };
}

export const norm = (value) => String(value ?? "").toLowerCase().replace(/\s+/g, " ").trim();

export function sumMinor(values, label = "amount") {
  let total = 0n;
  for (const value of values) {
    if (!Number.isSafeInteger(value)) throw new TypeError(`${label}: ${value} is not integer paise`);
    total += BigInt(value);
  }
  if (total > BigInt(Number.MAX_SAFE_INTEGER) || total < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(`${label}: a total exceeds the safe currency range`);
  }
  return Number(total);
}

/** The first day of a financial year as a UTC date string, and the day after its last. */
export function financialYearBounds(financialYear) {
  const months = financialYearMonths(financialYear);
  const first = months[0];
  const last = months[11];
  const [lastYear, lastMonth] = last.split("-").map(Number);
  const nextYear = lastMonth === 12 ? lastYear + 1 : lastYear;
  const nextMonth = lastMonth === 12 ? 1 : lastMonth + 1;
  return {
    startDay: `${first}-01`,
    endDayExclusive: `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`,
    months,
  };
}

/** True when a yyyy-mm-dd document date falls in the financial year. A date that is not one never does. */
export function dateInYear(documentDate, financialYear) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(documentDate || ""))) return false;
  const { startDay, endDayExclusive } = financialYearBounds(financialYear);
  return documentDate >= startDay && documentDate < endDayExclusive;
}

function digest(sources) {
  return createHash("sha256")
    .update(sources.map((s) => `${s.kind}:${s.batchId}:${s.rowId}:${s.sourceRow}`).join("\n"))
    .digest("hex");
}

/**
 * The row factory of one pack. A row with no source rows throws unless it is derived (worked out from
 * other rows) - the same rule Clause 44 holds itself to, so a number on screen can always be walked back
 * to the voucher, ledger or return line behind it.
 */
export function rowFactory(ruleVersion, packLabel) {
  const rowKeyFor = (section, identity) =>
    createHash("sha256").update(`${ruleVersion}|${section}|${identity}`).digest("hex");

  return function makeRow({ section, identity, label, values, ruleHits = [], state, sources = [], derived = false, party = null }) {
    if (!ROW_STATES.includes(state)) throw new Error(`${packLabel}: ${state} is not a row state`);
    if (!derived && sources.length === 0) {
      throw new Error(`${packLabel}: a ${section} row (${label}) has no source rows`);
    }
    const ordered = [...sources].sort((a, b) =>
      `${a.kind}:${a.batchId}:${String(a.sourceRow).padStart(9, "0")}:${a.rowId}`.localeCompare(
        `${b.kind}:${b.batchId}:${String(b.sourceRow).padStart(9, "0")}:${b.rowId}`));
    return {
      section,
      rowKey: rowKeyFor(section, identity),
      label,
      party,
      values,
      ruleHits,
      state,
      decidable: !derived,
      sourceRows: ordered.slice(0, MAX_EMBEDDED_SOURCES),
      allSources: ordered,
      sourceEvidenceCount: ordered.length,
      sourceEvidenceHash: digest(ordered),
    };
  };
}

/** The reasons code → sentence table every generic pack shares in its workbook and its reader. */
export const SHARED_REASON_WORDS = Object.freeze({
  ROWS_NOT_DECIDED: (r) => `${r.count} row(s) not yet confirmed or excluded by a person`,
  INPUTS_MISSING: (r) => `${r.count} check(s) cannot be made until the missing input is loaded`,
  MONTHS_MISSING: (r) => `${r.what || "Returns"} not loaded for ${(r.months || []).join(", ")}`,
  UNEXPLAINED_RESIDUALS: (r) => `${r.count} difference(s) a person has recorded as unexplained`,
});

export const STATE_WORDS = Object.freeze({
  COMPUTED: "Computed, not yet confirmed",
  CONFIRMED: "Confirmed by a person",
  EXCLUDED: "Excluded by a person",
  PENDING_INPUT: "Needs a person's answer or a missing input",
});

/**
 * One two-sided comparison. A side that is null is not loaded - never zero - and the difference is
 * then null as well.
 */
export function compare(leftMinor, rightMinor, tolerance = ROUNDING_TOLERANCE_MINOR) {
  const known = Number.isSafeInteger(leftMinor) && Number.isSafeInteger(rightMinor);
  if (!known) return { leftMinor: leftMinor ?? null, rightMinor: rightMinor ?? null, differenceMinor: null, withinRounding: false, known: false };
  const differenceMinor = sumMinor([leftMinor, -rightMinor], "difference");
  return { leftMinor, rightMinor, differenceMinor, withinRounding: Math.abs(differenceMinor) <= tolerance, known: true };
}

export const RESIDUAL_CHOICES = Object.freeze([
  ["TIMING_ADVANCES", "Timing: advances received or adjusted"],
  ["CREDIT_OR_DEBIT_NOTES", "Credit or debit notes"],
  ["TRADE_DISCOUNTS", "Trade discounts"],
  ["UNBILLED_REVENUE", "Unbilled revenue"],
  ["EXEMPT_OR_NON_GST_SUPPLIES", "Exempt, nil-rated or non-GST supplies"],
  ["ZERO_RATED_CLASSIFICATION", "Zero-rated supplies classified differently"],
  ["LATE_REPORTED_DOCUMENTS", "Documents reported in a later period"],
  ["ITC_NOT_AVAILED_OR_INELIGIBLE", "ITC not availed or ineligible"],
  ["REVERSALS", "Reversals"],
  ["ROUNDING", "Rounding"],
  ["OTHER_EXPLAINED", "Other (explained in the note)"],
  ["UNEXPLAINED", "Not explained"],
]);

export const RESIDUAL_CHOICE_CODES = Object.freeze(RESIDUAL_CHOICES.map(([code]) => code));

/** A choice a person may give on a row, the way an engine offers it. */
export const choice = (value, label, { needsNote = false } = {}) => ({ value, label, needsNote });
