// src/services/audit-pack-kinds/workbook-generic.js
//
// W10 (2026-10-17): the workbook every pack after Clause 44 hands back. One shape, so the sheets a CA
// opens look the same whichever pack made them: Read me, the pack's own sheets, Pending, Decisions.
//
// THE RULE: figures a person has not decided never appear in a "for filing" sheet. A pack's filing sheet
// (when it has one) carries CONFIRMED rows only; everything else is listed under Pending with why, and
// the Read me says in words whether the pack is provisional. The Read me also lists every source import
// with its fingerprint, so a workbook can be tied back to exactly the files it was made from.

import { STATE_WORDS } from "./kit.js";

const slug = (value) =>
  String(value || "client").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "client";

export const words = (table, key) => table[key] || String(key || "");
export const ruleText = (row) => (row.ruleHits || []).map((h) => h.detail).filter(Boolean).join(" ");
export const isDecided = (row) => ["CONFIRMED", "EXCLUDED"].includes(row.state);

export function reasonSentence(reason, table) {
  const make = table[reason.code];
  return make ? make(reason) : reason.code;
}

/**
 * @param {object} args
 * @param {object} args.run                the stored run
 * @param {string} args.packLabel          "GSTR-9 / 9C reconciliation"
 * @param {string} args.clientName
 * @param {object} args.summary            the pack's summary ({ provisional, reasons })
 * @param {object} args.reasonWords        code → (reason) => sentence
 * @param {object[]} args.effectiveRows    rows with the decision overlaid, each carrying `stored`
 * @param {Array} args.extraReadMe         [[item, detail], ...] pack-specific explanations
 * @param {Array} args.sheets              the pack's own sheets, after Read me
 * @param {object} [args.choiceWords]      code → words, for the Decisions sheet
 */
export function assemblePackWorkbook({ run, packLabel, clientName, summary, reasonWords, effectiveRows, extraReadMe = [], sheets, choiceWords = {} }) {
  const pending = effectiveRows.filter((r) => r.decidable && !isDecided(r));
  const blocked = effectiveRows.filter((r) => !r.decidable && r.state === "PENDING_INPUT");
  const status = summary.provisional
    ? `Provisional: ${summary.reasons.filter((r) => r.blocking !== false).map((r) => reasonSentence(r, reasonWords)).join("; ")}.`
    : "Every row has been decided by a person.";

  const readMe = [
    ["Pack", packLabel],
    ["Client", clientName],
    ["Financial year", run.financialYear],
    ["Rule version", run.ruleVersion],
    ["Computed", run.publishedAt ? new Date(run.publishedAt).toISOString().slice(0, 10) : ""],
    ["Status", status],
    ...extraReadMe,
    ["Who reports", "CA PRO computed these workings from the client's own imports. What is reported or certified is the professional's decision; CA PRO files, uploads and signs nothing."],
    ["Pending", "Rows still waiting for a person's decision, and checks that cannot be made until a missing input is loaded."],
    ["Decisions", "Every row a person confirmed or excluded, with their reason and note."],
    ...(run.sourceBatches || []).map((batch) => [
      `Source: ${batch.kind}${batch.period ? ` ${batch.period}` : ""}`,
      `${String(batch.batchId)}, fingerprint ${batch.sourceHash}`,
    ]),
  ];

  const pendingSheet = {
    name: "Pending",
    headers: ["Section", "Row", "State", "Why"],
    rows: [
      ...pending.map((r) => [r.section, r.label, words(STATE_WORDS, r.state), { text: ruleText(r), wrap: true }]),
      ...blocked.map((r) => [r.section, r.label, "Missing input", { text: ruleText(r), wrap: true }]),
    ],
    widths: [14, 52, 28, 90],
  };

  const decisionsSheet = {
    name: "Decisions",
    headers: ["Section", "Row", "Decision", "Reason chosen", "Why excluded", "Note", "Note written by", "Decided at"],
    rows: effectiveRows.filter((r) => r.stored?.decision?.state).map((r) => [
      r.section,
      r.label,
      words(STATE_WORDS, r.stored.decision.state),
      words(choiceWords, r.stored.decision.choice || r.stored.decision.treatment || ""),
      r.stored.decision.reason || "",
      { text: r.stored.decision.note || "", wrap: true },
      r.stored.decision.note ? (r.stored.decision.noteSource === "AI_DRAFT" ? "Drafted by AI, adopted as drafted" : "The person who decided") : "",
      r.stored.decision.decidedAt ? new Date(r.stored.decision.decidedAt).toISOString().slice(0, 10) : "",
    ]),
    widths: [14, 48, 28, 38, 40, 60, 30, 14],
  };

  return [
    { name: "Read me", headers: ["Item", "Detail"], rows: readMe.map(([a, b]) => [a, { text: b, wrap: true }]), widths: [26, 110] },
    ...sheets,
    pendingSheet,
    decisionsSheet,
  ];
}

export function packFileName(run, clientName, prefix) {
  return `${prefix}-${slug(clientName)}-${run.financialYear}.xlsx`;
}
