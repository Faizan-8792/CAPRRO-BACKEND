// src/services/audit-pack-kinds/clause34.kind.js
//
// W10 AP26 (2026-10-17): Form 3CD clause 34 - TDS/TCS not deposited in time, the interest section 201(1A)(ii)
// charges and the fee section 234E charges for a late statement - as a pack over the same imported TDS rows
// the TDS health check reads. The rules and arithmetic are clause34.engine.js; this file is the request it
// accepts and the columns of its filing sheet.

import TdsImportRow from "../../models/TdsImportRow.js";
import { CLAUSE34_RULE_VERSION, buildClause34Rows } from "../audit-pack-engine/clause34.engine.js";
import { SHARED_REASON_WORDS, STATE_WORDS } from "./kit.js";
import { assemblePackWorkbook, isDecided, packFileName, ruleText, words } from "./workbook-generic.js";

const SECTIONS = Object.freeze([
  { code: "DEPOSIT_TIMING", label: "Tax not deposited within the allowed time (34(a), 201(1A)(ii))" },
  { code: "STATEMENT_TIMING", label: "Statements filed late (34(c), 234E)" },
  { code: "INPUT_GAPS", label: "What could not be checked" },
]);

const DEPOSIT_WORDS = Object.freeze({
  REPORT: "Report it: not deposited within the allowed time, with the 201(1A)(ii) interest",
  QUARTERLY_DEPOSITOR: "The client deposits quarterly, so the deposit was within the allowed time",
  REGULARISED: "The late deposit and its interest were regularised before the return was due",
  OTHER_EXPLAINED: "Another reason, given in the note",
});
const STATEMENT_WORDS = Object.freeze({
  REPORT: "Report it: the statement was filed late, with the 234E fee",
  FILED_IN_TIME: "It was in fact filed by the due date (or a correction regularised it)",
  FEE_KNOWN_ELSEWHERE: "It was filed late and the fee is known and paid - the figure is in the note",
  OTHER_EXPLAINED: "Another reason, given in the note",
});
const CHOICE_WORDS = Object.freeze({ ...DEPOSIT_WORDS, ...STATEMENT_WORDS });

const PROJECTION = "quarter statementType transactionDate deductedMinor challanDate depositedMinor filingStatus filedDate reportedMinor deducteeName sectionCode";

const withIds = (row) => ({ ...row, rowId: String(row._id), batchId: String(row.batchId) });

const effectiveRow = (row) => {
  const decision = row.decision || null;
  return { ...row, state: decision?.state || row.state, choice: decision?.choice || "" };
};

function summarize(rows) {
  const effective = rows.map(effectiveRow);
  const decidable = effective.filter((r) => r.decidable);
  const undecided = decidable.filter((r) => !isDecided(r));
  const gaps = effective.filter((r) => !r.decidable && r.state === "PENDING_INPUT");
  const reportable = decidable.filter((r) => r.state === "CONFIRMED" && r.choice === "REPORT");
  const amountOf = (row) => (Number.isSafeInteger(row.values?.amountMinor) ? row.values.amountMinor : 0);
  const reasons = [];
  if (undecided.length) reasons.push({ code: "ROWS_NOT_DECIDED", count: undecided.length, blocking: true });
  if (gaps.length) reasons.push({ code: "INPUTS_MISSING", count: gaps.length, blocking: true });
  return {
    ruleVersion: CLAUSE34_RULE_VERSION,
    provisional: reasons.length > 0,
    reasons,
    totals: {
      reportableMinor: reportable.reduce((a, r) => a + amountOf(r), 0),
      reportableCount: reportable.length,
      findings: decidable.length,
      decided: decidable.length - undecided.length,
      undecided: undecided.length,
      inputGaps: gaps.length,
    },
    counts: Object.fromEntries(SECTIONS.map((s) => [s.code, effective.filter((r) => r.section === s.code).length])),
  };
}

export const clause34Kind = Object.freeze({
  kind: "CLAUSE34",
  label: "Form 3CD clause 34: TDS not deposited in time, section 201(1A)(ii) interest and section 234E fees",
  ruleVersion: CLAUSE34_RULE_VERSION,
  sections: SECTIONS,
  createFields: ["deductionBatchIds", "challanBatchIds", "statementBatchIds"],
  reasonWords: { ...SHARED_REASON_WORDS },

  async prepare({ firmId, client, financialYear, input, helpers }) {
    const { loadSourceBatches, httpError } = helpers;
    const list = (key) => (Array.isArray(input[key]) ? input[key] : []);
    const deductions = list("deductionBatchIds");
    const challans = list("challanBatchIds");
    const statements = list("statementBatchIds");
    if ([deductions, challans, statements].some((ids) => ids.length > 24)) throw httpError(400, "Choose at most 24 imports of each TDS kind.");
    if (deductions.length + statements.length === 0) throw httpError(400, "Choose the year's TDS deduction register and its quarterly statements (challans are optional).", "AUDIT_PACK_SOURCE_REFUSED");
    const batches = [];
    if (deductions.length) batches.push(...await loadSourceBatches({ firmId, clientId: client._id, ids: deductions, kind: "TDS_DEDUCTIONS", label: "TDS deduction register" }));
    if (challans.length) batches.push(...await loadSourceBatches({ firmId, clientId: client._id, ids: challans, kind: "TDS_CHALLANS", label: "TDS challans" }));
    if (statements.length) batches.push(...await loadSourceBatches({ firmId, clientId: client._id, ids: statements, kind: "TDS_STATEMENTS", label: "TDS quarterly statements" }));
    return { batches, params: {} };
  },

  async compute({ run, readRows, assertLease }) {
    const filterOf = (batch) => ({ firmId: run.firmId, batchId: batch.batchId, importGeneration: batch.importGeneration });
    const rowsFor = async (kind) => {
      const out = [];
      for (const batch of run.sourceBatches.filter((b) => b.kind === kind)) {
        out.push(...(await readRows(TdsImportRow, filterOf(batch), PROJECTION)).map(withIds));
      }
      await assertLease();
      return out;
    };
    const deductions = await rowsFor("TDS_DEDUCTIONS");
    const challans = await rowsFor("TDS_CHALLANS");
    const statements = await rowsFor("TDS_STATEMENTS");
    return buildClause34Rows({ financialYear: run.financialYear, deductions, challans, statements });
  },

  effectiveRow,
  summarize,

  validateDecision(row, { state, choice, reason, note }) {
    if (state === "EXCLUDED") {
      if (!reason) throw new RangeError("Say why this row is excluded.");
      return;
    }
    const table = row.section === "DEPOSIT_TIMING" ? DEPOSIT_WORDS : STATEMENT_WORDS;
    const picked = Object.entries(table).find(([value]) => value === choice);
    if (!picked) throw new RangeError("Choose one of the answers offered for this row.");
    if ((row.section === "STATEMENT_TIMING" && choice === "FEE_KNOWN_ELSEWHERE") || ["QUARTERLY_DEPOSITOR", "REGULARISED", "FILED_IN_TIME", "OTHER_EXPLAINED"].includes(choice)) {
      if (!String(note || "").trim()) throw new RangeError("Say what supports this answer in the note.");
    }
  },

  displayLines(row) {
    return (row.values?.lines || []).map((l) => ({ label: l.label, value: l.value ?? null, kind: l.kind || "text" }));
  },

  choicesFor(row) {
    if (!row.decidable) return null;
    const table = row.section === "DEPOSIT_TIMING" ? DEPOSIT_WORDS : STATEMENT_WORDS;
    const options = Object.entries(table).map(([value, label]) => ({ value, label }));
    return options.length ? { field: "choice", options, requiredWhenDifferent: true } : null;
  },

  workbook({ run, clientName, effectiveRows, summary }) {
    const filing = effectiveRows.filter((r) => r.decidable && r.state === "CONFIRMED" && r.choice === "REPORT");
    const filingSheet = summary.provisional
      ? { name: "For filing", headers: ["Provisional"], rows: [["Nothing is offered for filing: rows are still undecided or an input is missing. See Pending."]], widths: [100] }
      : { name: "For filing", headers: [
          "Clause", "Quarter", "Amount not deposited in time", "Interest 201(1A)(ii)", "Fee 234E", "How it was worked out",
        ], rows: filing.map((r) => [
          r.section === "DEPOSIT_TIMING" ? "34(a) with 201(1A)(ii)" : "34(c) with 234E",
          r.values.quarter,
          { money: r.section === "DEPOSIT_TIMING" ? r.values.amountMinor : null },
          { money: r.section === "DEPOSIT_TIMING" ? r.values.interestMinor : null },
          { money: r.section === "STATEMENT_TIMING" ? r.values.feeMinor : null },
          { text: ruleText(r), wrap: true },
        ]), widths: [26, 10, 24, 20, 18, 90] };
    const allFindings = {
      name: "All findings",
      headers: ["Section", "Row", "State", "Your answer", "Amount", "Note", "How it was read"],
      rows: effectiveRows.map((r) => [
        r.section,
        r.label,
        words(STATE_WORDS, r.state),
        words(CHOICE_WORDS, r.choice || ""),
        { money: Number.isSafeInteger(r.values?.amountMinor) ? r.values.amountMinor : null },
        { text: [r.stored?.decision?.reason, r.stored?.decision?.note].filter(Boolean).join(" - "), wrap: true },
        { text: ruleText(r), wrap: true },
      ]),
      widths: [18, 46, 26, 40, 18, 50, 90],
    };
    return {
      sheets: assemblePackWorkbook({
        run,
        packLabel: "Form 3CD clause 34: TDS deposit and statement timing",
        clientName,
        summary,
        reasonWords: { ...SHARED_REASON_WORDS },
        effectiveRows,
        choiceWords: CHOICE_WORDS,
        extraReadMe: [
          ["What this is", "Tax deducted at source and not deposited within the allowed time, with the interest section 201(1A)(ii) charges, and the fee section 234E charges for a quarterly statement filed late. Computed from the same imported TDS rows the TDS health check reads."],
          ["The allowed time", "The seventh day of the month after deduction, and 30 April for tax deducted in March. The import does not say whether the client may deposit quarterly; if it may, answer so on that row."],
          ["The interest", "One and a half per cent for every month or part of a month from the day of deduction to the day of deposit, in whole paise. On anything not deposited it is computed to 31 March and marked as still running."],
          ["The fee", "Two hundred rupees a day the statement is late, capped at the quarter's tax. A statement recorded as filed with no filing date gives no fee - unknown, never nil."],
          ["Attribution", "Challans settle the quarter's deductions in deduction order; the books do not say which deduction a challan pays for. The earliest recorded filing date is used for a quarter."],
          ["Not computed", "Section 201(1A)(i) interest for tax never deducted, and whether the client was in fact a quarterly depositor."],
        ],
        sheets: [filingSheet, allFindings],
      }),
      fileName: packFileName(run, clientName, "clause-34"),
      provisional: summary.provisional,
    };
  },
});
