// src/services/audit-pack-export.service.js
//
// W10 AP9 (2026-10-15): the Clause 44 workbook. Six sheets: Read me, Clause 44, Pending, Ledger
// working, Supplier working, Tie-outs.
//
// THE RULE THAT MATTERS: the Clause 44 sheet carries the clause's figures only when every row has
// been decided by a person, no GSTR-2B month is missing and the balancing column is not negative.
// Until then it says, in words, that the figures are provisional and why, and the working sheets
// carry the computation for review. A CA copying "the number from the CA PRO workbook" into Form
// 3CD must never be copying a number nobody confirmed - the CPC acts on what the report says.
//
// Money is integer paise written as exact rupee decimals in the Indian grouping (workbook.service.js).

import mongoose from "mongoose";
import AuditPackRun from "../models/AuditPackRun.js";
import AuditPackRow from "../models/AuditPackRow.js";
import Client from "../models/Client.js";
import { effectiveRow, summarizeClause44 } from "./audit-pack-engine/clause44.engine.js";
import { buildWorkbook } from "./workbook.service.js";

function httpError(statusCode, message, code = "") {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

const TREATMENT_WORDS = Object.freeze({
  REVENUE_EXPENDITURE: "Expenditure (revenue)",
  CAPITAL_ADDITIONS: "Capital additions",
  EXCLUDED: "Not expenditure on a supply",
  NOT_EXPENDITURE: "Not expenditure (balance sheet or income)",
  COL3_EXEMPT: "Exempt supplies from registered persons (column 3)",
  COL4_COMPOSITION: "Composition suppliers (column 4)",
  COL7_UNREGISTERED: "Unregistered persons (column 7)",
  UNCLASSIFIED: "Not classified yet",
});
const STATUS_WORDS = Object.freeze({
  REGISTERED: "Registered (in GSTR-2B)",
  NOT_IN_2B: "Not in GSTR-2B: check on the GST portal",
  COMPOSITION: "Composition dealer",
  EXEMPT_SUPPLIER: "Exempt supplies only",
});
const STATE_WORDS = Object.freeze({
  COMPUTED: "Computed, not yet confirmed",
  CONFIRMED: "Confirmed by a person",
  EXCLUDED: "Excluded by a person",
  PENDING_INPUT: "Needs a person's answer",
});
const REASON_WORDS = Object.freeze({
  ROWS_NOT_DECIDED: (r) => `${r.count} row(s) not yet confirmed or excluded by a person`,
  ROWS_PENDING_INPUT: (r) => `${r.count} row(s) need a person's answer`,
  LEDGER_AMOUNT_UNKNOWN: (r) => `${r.count} ledger(s) whose amount the trial balance does not give`,
  SUPPLIER_STATUS_UNKNOWN: (r) => `${r.count} supplier(s) not in GSTR-2B whose status nobody has set`,
  GSTR2B_MONTHS_MISSING: (r) => `GSTR-2B not loaded for ${r.months.join(", ")}`,
  REGISTERED_EXCEEDS_TOTAL: () => "Payments to registered suppliers exceed the year's expenditure in the trial balance",
});

const CLAUSE44_COLUMNS = Object.freeze([
  ["col2", "2", "Total amount of expenditure incurred during the year"],
  ["col3", "3", "Expenditure in respect of entities registered under GST: relating to goods or services exempt from GST"],
  ["col4", "4", "Expenditure in respect of entities registered under GST: relating to entities falling under the composition scheme"],
  ["col5", "5", "Expenditure in respect of entities registered under GST: relating to other registered entities"],
  ["col6", "6", "Total payment to registered entities (3 + 4 + 5)"],
  ["col7", "7", "Expenditure relating to entities not registered under GST (column 2 less column 6)"],
]);

const words = (table, key) => table[key] || String(key || "");
const rules = (row) => (row.ruleHits || []).map((hit) => hit.detail).filter(Boolean).join(" ");
const decided = (row) => ["CONFIRMED", "EXCLUDED"].includes(row.state);

function slug(value) {
  return String(value || "client")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "client";
}

function engineRow(raw) {
  return {
    section: raw.section,
    rowKey: raw.rowKey,
    label: raw.label,
    party: raw.party,
    values: raw.values || {},
    ruleHits: raw.ruleHits || [],
    state: raw.state,
    decidable: raw.decidable,
    decision: raw.decision?.state
      ? { state: raw.decision.state, treatment: raw.decision.treatment || undefined, status: raw.decision.status || undefined }
      : null,
    stored: raw,
  };
}

export async function exportAuditPackWorkbook({ firmId, runId }) {
  if (!mongoose.isValidObjectId(runId)) throw httpError(400, "Pack is not a valid id");
  const run = await AuditPackRun.findOne({ _id: runId, firmId }).lean();
  if (!run) throw httpError(404, "That audit pack is not in this firm.");
  if (run.status !== "REVIEW") throw httpError(409, "This pack is still being computed.", "AUDIT_PACK_NOT_READY");
  const [stored, client] = await Promise.all([
    AuditPackRow.find({ firmId, runId: run._id, generationAttempt: run.activeGenerationAttempt }).sort({ ordinal: 1 }).lean(),
    Client.findOne({ _id: run.clientId, firmId }).select("name").lean(),
  ]);
  const rows = stored.map(engineRow);
  const summary = summarizeClause44(rows);
  const effective = rows.map((row) => ({ ...effectiveRow(row), stored: row.stored }));
  const ledgers = effective.filter((r) => r.section === "LEDGER");
  const suppliers = effective.filter((r) => r.section === "SUPPLIER");
  const tieouts = effective.filter((r) => r.section === "TIEOUT");
  const pending = effective.filter((r) => r.decidable && !decided(r));
  const clientName = client?.name || "Client";

  const readMe = [
    ["Pack", "Form 3CD clause 44: expenditure by the GST status of the supplier"],
    ["Client", clientName],
    ["Financial year", run.financialYear],
    ["Rule version", run.ruleVersion],
    ["Computed", run.publishedAt ? new Date(run.publishedAt).toISOString().slice(0, 10) : ""],
    ["Status", summary.provisional
      ? `Provisional: ${summary.reasons.map((r) => (REASON_WORDS[r.code] || (() => r.code))(r)).join("; ")}.`
      : "Every row has been decided by a person."],
    ["Clause 44", summary.provisional
      ? "The Clause 44 sheet shows no figures until every row is decided. The working sheets carry the computation."
      : "The Clause 44 sheet carries the figures from the rows as decided."],
    ["Column 7", "Column 7 is the balance: the year's expenditure less payments to registered entities. The books do not name the suppliers behind it."],
    ["Who reports", "CA PRO computed these workings from the client's own imports. What Form 3CD reports is the auditor's decision; CA PRO uploads nothing."],
    ["Pending", "Rows still waiting for a person's decision."],
    ["Ledger working", "Every trial-balance ledger, how it was read, and the rule that read it."],
    ["Supplier working", "Every supplier in the purchase register for the year, and its GST status."],
    ["Tie-outs", "The purchase register against GSTR-2B, and the books' purchases against the register."],
    ...(run.sourceBatches || []).map((batch) => [
      `Source: ${batch.kind}${batch.period ? ` ${batch.period}` : ""}`,
      `import ${String(batch.batchId)}, file fingerprint ${batch.sourceHash}`,
    ]),
  ];

  const clauseRows = summary.provisional
    ? [["Provisional", "No figures: " + summary.reasons.map((r) => (REASON_WORDS[r.code] || (() => r.code))(r)).join("; ") + ".", null]]
    : CLAUSE44_COLUMNS.map(([key, column, description]) => [column, description, { money: summary.columns[key] }]);

  const sheets = [
    { name: "Read me", headers: ["Item", "Detail"], rows: readMe.map(([a, b]) => [a, { text: b, wrap: true }]), widths: [22, 110] },
    { name: "Clause 44", headers: ["Column", "Description", "Amount"], rows: clauseRows, widths: [12, 90, 20] },
    {
      name: "Pending",
      headers: ["Section", "Row", "State", "Why", "Amount"],
      rows: pending.map((r) => [
        r.section === "LEDGER" ? "Ledger" : r.section === "SUPPLIER" ? "Supplier" : r.section,
        r.label,
        words(STATE_WORDS, r.state),
        { text: rules(r), wrap: true },
        r.section === "LEDGER" ? { money: r.values.amountMinor ?? 0 } : { money: r.values.totalMinor ?? 0 },
      ]),
      widths: [10, 36, 26, 80, 18],
    },
    {
      name: "Ledger working",
      headers: ["Ledger", "Group", "Treatment", "Amount counted", "Closing balance", "State", "Decision reason", "Note", "How it was read"],
      rows: ledgers.map((r) => [
        r.label,
        r.values.groupName || "",
        words(TREATMENT_WORDS, r.values.treatment),
        { money: ["REVENUE_EXPENDITURE", "CAPITAL_ADDITIONS", "COL3_EXEMPT", "COL4_COMPOSITION", "COL7_UNREGISTERED"].includes(r.values.treatment) && r.state !== "EXCLUDED" ? r.values.amountMinor ?? 0 : 0 },
        { money: r.values.closingMinor ?? 0 },
        words(STATE_WORDS, r.state),
        r.stored.decision?.reason || "",
        r.stored.decision?.note || "",
        { text: rules(r), wrap: true },
      ]),
      widths: [32, 24, 34, 18, 18, 26, 30, 30, 80],
    },
    {
      name: "Supplier working",
      headers: ["Supplier GSTIN", "Status", "Taxable value with tax", "Taxable value without tax", "Total", "Documents", "Months in GSTR-2B", "State", "How it was read"],
      rows: suppliers.map((r) => [
        r.label,
        words(STATUS_WORDS, r.values.status),
        { money: r.values.taxedMinor ?? 0 },
        { money: r.values.untaxedMinor ?? 0 },
        { money: r.values.totalMinor ?? 0 },
        { integer: r.values.documentCount ?? 0 },
        { integer: (r.values.in2bMonths || []).length },
        words(STATE_WORDS, r.state),
        { text: rules(r), wrap: true },
      ]),
      widths: [20, 34, 20, 20, 18, 12, 14, 26, 80],
    },
    {
      name: "Tie-outs",
      headers: ["Check", "Left", "Left amount", "Right", "Right amount", "Difference", "Notes"],
      rows: tieouts.map((r) => [
        r.label,
        r.values.leftLabel || "",
        { money: r.values.leftMinor ?? 0 },
        r.values.rightLabel || "",
        { money: r.values.rightMinor ?? 0 },
        { money: r.values.differenceMinor ?? 0 },
        { text: rules(r), wrap: true },
      ]),
      widths: [40, 40, 18, 40, 18, 18, 70],
    },
  ];

  const bytes = buildWorkbook({ sheets });
  const fileName = `clause44_${slug(clientName)}_${run.financialYear}${summary.provisional ? "_provisional" : ""}.xlsx`;
  return { bytes, fileName, provisional: summary.provisional, summary };
}
