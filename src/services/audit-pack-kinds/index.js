// src/services/audit-pack-kinds/index.js
//
// W10 (2026-10-17): the packs the generic pipeline in audit-pack.service.js knows how to run. CLAUSE44
// predates this registry and keeps its own, tested path; every later pack is a descriptor here:
//
//   kind, label, ruleVersion, sections, createFields, reasonWords
//   prepare({ firmId, client, financialYear, input, helpers })  -> { batches, params }
//   compute({ run, readRows, assertLease, batchPeriodMonths })  -> { rows, monthsLoaded, monthsMissing }
//   effectiveRow(row), summarize(rows), validateDecision(row, decision)
//   displayLines(row), choicesFor(row)                           -> what a client shows without knowing the pack
//   workbook({ run, clientName, effectiveRows, summary })       -> { sheets, fileName, provisional }
//
// A descriptor computes nothing itself: the arithmetic lives in an engine under audit-pack-engine/.

import { clause21dKind } from "./clause21d.kind.js";
import { clause22Kind } from "./clause22.kind.js";
import { clause26Kind } from "./clause26.kind.js";
import { clause31Kind } from "./clause31.kind.js";
import { clause34Kind } from "./clause34.kind.js";
import { gstr9cKind } from "./gstr9c.kind.js";

const KINDS = Object.freeze({
  [gstr9cKind.kind]: gstr9cKind,
  [clause21dKind.kind]: clause21dKind,
  [clause22Kind.kind]: clause22Kind,
  [clause26Kind.kind]: clause26Kind,
  [clause31Kind.kind]: clause31Kind,
  [clause34Kind.kind]: clause34Kind,
});

export const GENERIC_PACK_KINDS = Object.freeze(Object.keys(KINDS));

/** The descriptor of a generic pack kind, or null (CLAUSE44, or a kind that does not exist). */
export function getPackKind(kind) {
  return Object.prototype.hasOwnProperty.call(KINDS, kind) ? KINDS[kind] : null;
}

/** Every field any pack's create request may carry; the pack's own list narrows it. */
export function allCreateFields() {
  return new Set(Object.values(KINDS).flatMap((k) => k.createFields));
}
