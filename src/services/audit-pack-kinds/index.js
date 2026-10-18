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

import { ageingKind } from "./ageing.kind.js";
import { caroKind } from "./caro.kind.js";
import { clause21dKind } from "./clause21d.kind.js";
import { clause22Kind } from "./clause22.kind.js";
import { clause26Kind } from "./clause26.kind.js";
import { clause31Kind } from "./clause31.kind.js";
import { clause34Kind } from "./clause34.kind.js";
import { gstr9cKind } from "./gstr9c.kind.js";
import { ledgerScanKind } from "./ledger-scan.kind.js";
import { ratiosKind } from "./ratios.kind.js";
import { rule11gKind } from "./rule11g.kind.js";

const KINDS = Object.freeze({
  [gstr9cKind.kind]: gstr9cKind,
  [clause21dKind.kind]: clause21dKind,
  [clause22Kind.kind]: clause22Kind,
  [clause26Kind.kind]: clause26Kind,
  [clause31Kind.kind]: clause31Kind,
  [clause34Kind.kind]: clause34Kind,
  [ageingKind.kind]: ageingKind,
  [ratiosKind.kind]: ratiosKind,
  [caroKind.kind]: caroKind,
  [rule11gKind.kind]: rule11gKind,
  [ledgerScanKind.kind]: ledgerScanKind,
});

export const GENERIC_PACK_KINDS = Object.freeze(Object.keys(KINDS));

/** The descriptor of a generic pack kind, or null (CLAUSE44, or a kind that does not exist). */
export function getPackKind(kind) {
  return Object.prototype.hasOwnProperty.call(KINDS, kind) ? KINDS[kind] : null;
}

/**
 * What a pack is called wherever a person reads it (W10 AP44): "Clause 44" for the pack that predates this registry,
 * the descriptor's label for every other, and the stored code only for a kind this build does not know. Sent on every
 * run as `kindLabel` and used by the drafted memos, so a client, a memo and the Audit page's quotation of a flagged row
 * all name a pack alike. Before this, Clause 44 reached people as "CLAUSE44".
 */
export function packLabel(kind) {
  if (kind === "CLAUSE44") return "Clause 44";
  return getPackKind(kind)?.label || String(kind ?? "");
}

/**
 * What a client needs to offer every generic pack without carrying a copy of it: the label, the sections the
 * rows fall into, and the inputs the create request takes (see inputs.js for the vocabulary). Clause 44 is not
 * here: it predates the registry and both clients still have their own screen for it.
 */
export function describeKinds() {
  return Object.values(KINDS).map((k) => ({
    kind: k.kind,
    label: k.label,
    ruleVersion: k.ruleVersion,
    sections: k.sections.map((s) => ({ code: s.code, label: s.label })),
    inputs: k.inputs,
  }));
}

/** Every field any pack's create request may carry; the pack's own list narrows it. */
export function allCreateFields() {
  return new Set(Object.values(KINDS).flatMap((k) => k.createFields));
}
