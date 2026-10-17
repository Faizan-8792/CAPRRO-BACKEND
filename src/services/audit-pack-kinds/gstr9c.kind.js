// src/services/audit-pack-kinds/gstr9c.kind.js
//
// W10 AP13-AP15 (2026-10-17): the GSTR-9 / 9C reconciliation pack as the pack service sees it - what it
// accepts, how its inputs are read, how a decision is checked, how a row is shown and how it is exported.
// The arithmetic is gstr9c.engine.js; nothing here computes a figure.
//
// AP13 deviation from the plan as written (recorded in the ledger): the GSTR-9 figures are typed by the
// CA from the return as filed (about a dozen amounts), not imported from a portal download. No real
// GSTR-9 download was available to pin a reader against, and a reader written from memory of the portal's
// layout is how a wrong figure gets in. Typed figures are checked, stored with the run, and sit in its
// fingerprint, so a changed figure is a new pack.

import BooksImportRow from "../../models/BooksImportRow.js";
import ImportRow from "../../models/ImportRow.js";
import {
  GSTR9C_RULE_VERSION,
  buildGstr9cRows,
  effectiveRow,
  normalizeGstr9Figures,
  summarizeGstr9c,
  validateGstr9cDecision,
} from "../audit-pack-engine/gstr9c.engine.js";
import { RESIDUAL_CHOICES, SHARED_REASON_WORDS, financialYearMonths } from "./kit.js";
import { choiceInput, gstr9FiguresInput, importBatchInput, importBatchesInput } from "./inputs.js";
import { assemblePackWorkbook, packFileName, words, ruleText } from "./workbook-generic.js";

// The GSTR-9 rows a person may type, named as the return names them (shortened). `primary` marks the rows the
// comparisons read; the others are the neighbours a person naturally copies in. The codes are the engine's own
// GSTR9_FIGURE_CODES - audit-pack-catalogue-contract fails if the two lists drift.
const GSTR9_ROW_LABELS = Object.freeze({
  "4A": "Outward supplies to unregistered persons (B2C)",
  "4B": "Outward supplies to registered persons (B2B)",
  "4C": "Zero rated supplies (export) on payment of tax",
  "4D": "Supplies to SEZs on payment of tax",
  "4E": "Deemed exports",
  "4F": "Advances on which tax is paid, invoice not yet issued",
  "4G": "Inward supplies liable to reverse charge",
  "4H": "Sub-total (A to G)",
  "4I": "Credit notes issued",
  "4J": "Debit notes issued",
  "4K": "Supplies declared through amendments",
  "4L": "Supplies reduced through amendments",
  "4M": "Sub-total (I to L)",
  "4N": "Supplies and advances on which tax is paid (H + M)",
  "5A": "Zero rated supplies (export) without payment of tax",
  "5B": "Supplies to SEZs without payment of tax",
  "5C": "Supplies on which tax is paid by the recipient on reverse charge",
  "5D": "Exempted supplies",
  "5E": "Nil rated supplies",
  "5F": "Non-GST supplies",
  "5G": "Sub-total (A to F)",
  "5H": "Credit notes issued",
  "5I": "Debit notes issued",
  "5J": "Supplies declared through amendments",
  "5K": "Supplies reduced through amendments",
  "5L": "Sub-total (H to K)",
  "5M": "Turnover on which tax is not to be paid (G + L)",
  "5N": "Total turnover including advances (4N + 5M less 4G)",
  "6A": "Total input tax credit availed through GSTR-3B (its table 4A)",
  "6B": "Inward supplies other than imports and reverse charge: inputs, capital goods, input services",
  "6C": "Reverse charge supplies from unregistered persons, credit availed",
  "6D": "Reverse charge supplies from registered persons, credit availed",
  "6E": "Import of goods (including from SEZs)",
  "6F": "Import of services",
  "6G": "Credit received from an input service distributor",
  "6H": "Credit reclaimed under the Act",
  "6I": "Sub-total (B to H)",
  "6J": "Difference (I less A)",
  "6K": "Transition credit through TRAN-I",
  "6L": "Transition credit through TRAN-II",
  "6M": "Any other credit availed but not specified above",
  "6N": "Sub-total (K to M)",
  "6O": "Total input tax credit availed (I + N)",
  "7A": "Reversed as per rule 37",
  "7B": "Reversed as per rule 39",
  "7C": "Reversed as per rule 42",
  "7D": "Reversed as per rule 43",
  "7E": "Reversed as per section 17(5)",
  "7F": "Reversal of TRAN-I credit",
  "7G": "Reversal of TRAN-II credit",
  "7H": "Other reversals",
  "7I": "Total credit reversed (A to H)",
  "7J": "Net credit available for utilisation (6O less 7I)",
  "8A": "Credit as per GSTR-2A / 2B",
  "8B": "Credit as per rows 6B and 6H",
  "8C": "Credit on the previous year's supplies availed in the first months of this year",
  "8D": "Difference (A less B + C)",
  "8E": "Credit available but not availed",
  "8F": "Credit available but ineligible",
  "8G": "IGST paid on import of goods",
  "8H": "IGST credit availed on import of goods (6E)",
  "8I": "Difference (G less H)",
  "8J": "Credit available but not availed on import of goods",
  "8K": "Total credit to lapse in the current year (E + F + J)",
});
const GSTR9_PRIMARY = new Set(["4G", "4N", "5A", "5B", "5C", "5N", "6A", "7I", "8A", "8C"]);

export const GSTR9_ROWS = Object.freeze(
  Object.entries(GSTR9_ROW_LABELS).map(([code, label]) => Object.freeze({ code, label, primary: GSTR9_PRIMARY.has(code) })),
);

const SECTIONS = Object.freeze([
  { code: "MONTHLY", label: "Month by month" },
  { code: "TURNOVER", label: "Turnover" },
  { code: "ITC", label: "Input tax credit" },
]);

const CHOICE_WORDS = Object.freeze(Object.fromEntries(RESIDUAL_CHOICES));

const MAX_BATCHES = 24;

const PROJECTION_SUMMARY = "_id batchId sourceRow summaryCategory taxableValueMinor igstMinor cgstMinor sgstMinor cessMinor totalTaxMinor";
const PROJECTION_2B = "_id batchId sourceRow supplierGstin documentDate documentType taxableValueMinor igstMinor cgstMinor sgstMinor cessMinor totalTaxMinor";
const PROJECTION_TB = "_id batchId sourceRow ledgerName groupName openingMinor hasOpening debitTotalMinor creditTotalMinor hasTransactionTotals closingMinor";

const withIds = (row) => ({ ...row, rowId: String(row._id), batchId: String(row.batchId) });

const REASON_WORDS = Object.freeze({
  ...SHARED_REASON_WORDS,
});

function uniqueMonths(batches, label, financialYear, httpError) {
  const months = new Set(financialYearMonths(financialYear));
  const seen = new Set();
  for (const batch of batches) {
    const period = String(batch.period || "");
    if (!months.has(period)) throw httpError(400, `A chosen ${label} import is for ${period || "no month"}, which is not in ${financialYear}.`, "AUDIT_PACK_SOURCE_REFUSED");
    if (seen.has(period)) throw httpError(400, `Two ${label} imports were chosen for ${period}. Choose one.`, "AUDIT_PACK_SOURCE_REFUSED");
    seen.add(period);
  }
}

export const gstr9cKind = Object.freeze({
  kind: "GSTR9C",
  label: "GSTR-9 / 9C reconciliation",
  ruleVersion: GSTR9C_RULE_VERSION,
  sections: SECTIONS,
  createFields: ["gstr1BatchIds", "gstr3bBatchIds", "gstr2bBatchIds", "trialBalanceBatchId", "gstr2bFrequency", "gstr9"],
  inputs: Object.freeze([
    importBatchesInput("gstr1BatchIds", "GSTR1_SUMMARY", "GSTR-1 for each month of the year", { required: true, help: "One import per month. A month with none is named in the pack, not read as nil." }),
    importBatchesInput("gstr3bBatchIds", "GSTR3B_SUMMARY", "GSTR-3B for each month of the year", { required: true, help: "One import per month." }),
    importBatchesInput("gstr2bBatchIds", "GSTR2B", "GSTR-2B for the year", { required: true, help: "Monthly files, or one per quarter for a quarterly filer." }),
    importBatchInput("trialBalanceBatchId", "TRIAL_BALANCE", "Trial balance for the year", { help: "Optional. Without it the turnover and the input tax credit in the books are not shown." }),
    choiceInput("gstr2bFrequency", "The client files GSTR-3B", [["MONTHLY", "Monthly"], ["QUARTERLY", "Quarterly (QRMP)"]], "MONTHLY"),
    gstr9FiguresInput("gstr9", "GSTR-9 figures as filed", GSTR9_ROWS, "Type the rows from the GSTR-9 you filed. Row 4N is required; a row you leave out is read as not entered, never as nil."),
  ]),
  reasonWords: REASON_WORDS,

  /** Reads and checks the request. Returns the source batches and the parameters stored with the run. */
  async prepare({ firmId, client, financialYear, input, helpers }) {
    const { loadSourceBatches, httpError } = helpers;
    const frequency = String(input.gstr2bFrequency || "MONTHLY").toUpperCase();
    if (!["MONTHLY", "QUARTERLY"].includes(frequency)) throw httpError(400, "GSTR-2B frequency is MONTHLY or QUARTERLY.");
    const list = (key) => (Array.isArray(input[key]) ? input[key] : []);
    const g1 = list("gstr1BatchIds");
    const g3 = list("gstr3bBatchIds");
    const g2 = list("gstr2bBatchIds");
    if ([g1, g3, g2].some((ids) => ids.length > MAX_BATCHES)) throw httpError(400, `Choose at most ${MAX_BATCHES} imports of each kind.`);
    if (g1.length + g3.length + g2.length === 0) throw httpError(400, "Choose the year's GSTR-1, GSTR-3B and GSTR-2B imports.", "AUDIT_PACK_SOURCE_REFUSED");

    let figures;
    try {
      figures = normalizeGstr9Figures(input.gstr9?.figures ?? input.gstr9 ?? {});
    } catch (error) {
      throw httpError(400, error.message, "AUDIT_PACK_SOURCE_REFUSED");
    }
    if (!figures["4N"]) throw httpError(400, "Enter GSTR-9 table 4N (taxable turnover); the turnover checks compare with it.", "AUDIT_PACK_SOURCE_REFUSED");

    const gstr1 = await loadSourceBatches({ firmId, clientId: client._id, ids: g1, kind: "GSTR1_SUMMARY", label: "GSTR-1" });
    const gstr3b = await loadSourceBatches({ firmId, clientId: client._id, ids: g3, kind: "GSTR3B_SUMMARY", label: "GSTR-3B" });
    const gstr2b = await loadSourceBatches({ firmId, clientId: client._id, ids: g2, kind: "GSTR2B", label: "GSTR-2B" });
    uniqueMonths(gstr1, "GSTR-1", financialYear, httpError);
    uniqueMonths(gstr3b, "GSTR-3B", financialYear, httpError);
    const batches = [...gstr1, ...gstr3b, ...gstr2b];
    if (input.trialBalanceBatchId) {
      const [trialBalance] = await loadSourceBatches({ firmId, clientId: client._id, ids: [input.trialBalanceBatchId], kind: "TRIAL_BALANCE", label: "trial balance" });
      if (trialBalance.financialYear !== financialYear) throw httpError(400, `The chosen trial balance is for ${trialBalance.financialYear}, not ${financialYear}.`, "AUDIT_PACK_SOURCE_REFUSED");
      batches.push(trialBalance);
    }
    return { batches, params: { frequency, gstr9: figures } };
  },

  /** Reads the imports behind the run and builds its rows (the engine is pure; this is the I/O). */
  async compute({ run, readRows, assertLease, batchPeriodMonths }) {
    const batchesOf = (kind) => run.sourceBatches.filter((b) => b.kind === kind);
    const filterOf = (batch) => ({ firmId: run.firmId, batchId: batch.batchId, importGeneration: batch.importGeneration });
    const frequency = run.params?.frequency || "MONTHLY";

    const gstr1ByMonth = {};
    for (const batch of batchesOf("GSTR1_SUMMARY")) {
      gstr1ByMonth[batch.period] = { rows: (await readRows(ImportRow, filterOf(batch), PROJECTION_SUMMARY)).map(withIds) };
    }
    await assertLease();
    const gstr3bByMonth = {};
    for (const batch of batchesOf("GSTR3B_SUMMARY")) {
      gstr3bByMonth[batch.period] = { rows: (await readRows(ImportRow, filterOf(batch), PROJECTION_SUMMARY)).map(withIds) };
    }
    await assertLease();
    const gstr2b = [];
    const gstr2bMonths = [];
    for (const batch of batchesOf("GSTR2B")) {
      gstr2bMonths.push(...batchPeriodMonths(batch, frequency));
      const rows = await readRows(ImportRow, filterOf(batch), PROJECTION_2B);
      gstr2b.push(...rows.map((row) => ({ ...withIds(row), period: batch.period })));
    }
    await assertLease();
    const tb = batchesOf("TRIAL_BALANCE")[0];
    const trialBalance = tb ? (await readRows(BooksImportRow, filterOf(tb), PROJECTION_TB)).map(withIds) : null;

    return buildGstr9cRows({
      financialYear: run.financialYear,
      gstr1ByMonth,
      gstr3bByMonth,
      gstr2b,
      gstr2bMonths,
      trialBalance,
      gstr9Figures: run.params?.gstr9 || {},
    });
  },

  effectiveRow,
  summarize: summarizeGstr9c,

  /** Checks a person's decision against the row. Throws RangeError with a sentence they can act on. */
  validateDecision: (row, decision) => validateGstr9cDecision(row, decision),

  /** The lines a client shows for a row without knowing the pack: label, value and how to format it. */
  displayLines(row) {
    const v = row.values || {};
    if (v.leftLabel === undefined) return [];
    const lines = [
      { label: v.leftLabel, value: v.leftMinor ?? null, kind: "money" },
      { label: v.rightLabel, value: v.rightMinor ?? null, kind: "money" },
      { label: "Difference", value: v.differenceMinor ?? null, kind: "money" },
    ];
    if (v.differenceMinor != null) lines.push({ label: "Reading", value: v.withinRounding ? "Agrees within rounding" : "Differs by more than rounding: say why", kind: "text" });
    if (v.monthsMissing?.length) lines.push({ label: "Not loaded", value: v.monthsMissing.join(", "), kind: "text" });
    return lines;
  },

  /** What a person may choose on a row, or null when the row takes no choice. */
  choicesFor(row) {
    if (!row.decidable) return null;
    return { field: "choice", options: RESIDUAL_CHOICES.map(([value, label]) => ({ value, label })), requiredWhenDifferent: true };
  },

  /** { sheets, fileName, provisional } for a stored run and its stored rows (with decisions). */
  workbook({ run, clientName, effectiveRows, summary }) {
    const comparisonRows = (rows) => rows.map((r) => [
      r.label,
      r.values.leftLabel || "",
      { money: r.values.leftMinor ?? null },
      r.values.rightLabel || "",
      { money: r.values.rightMinor ?? null },
      { money: r.values.differenceMinor ?? null },
      r.values.differenceMinor == null ? "Not made" : r.values.withinRounding ? "Agrees within rounding" : "Differs",
      words({ CONFIRMED: "Confirmed by a person", EXCLUDED: "Excluded by a person", COMPUTED: "Not yet decided", PENDING_INPUT: "Missing input" }, r.state),
      words(CHOICE_WORDS, r.stored?.decision?.choice || ""),
      { text: [r.stored?.decision?.reason, r.stored?.decision?.note].filter(Boolean).join(" - "), wrap: true },
      { text: ruleText(r), wrap: true },
    ]);
    const checkHeaders = ["Check", "Left", "Left amount", "Right", "Right amount", "Difference", "Reading", "State", "Reason chosen", "Note", "How it was read"];
    const checkWidths = [44, 40, 18, 40, 18, 18, 24, 24, 34, 50, 80];
    const checks = effectiveRows.filter((r) => r.section !== "MONTHLY");
    const monthly = effectiveRows.filter((r) => r.section === "MONTHLY");
    const confirmed = checks.filter((r) => r.state === "CONFIRMED");

    const sheets = [
      summary.provisional
        ? { name: "Reconciliation", headers: ["Provisional"], rows: [["No reconciliation is certified here: rows are still undecided or an input is missing. See Pending."]], widths: [100] }
        : { name: "Reconciliation", headers: checkHeaders, rows: comparisonRows(confirmed), widths: checkWidths },
      { name: "All checks", headers: checkHeaders, rows: comparisonRows(checks), widths: checkWidths },
      { name: "Month by month", headers: checkHeaders, rows: comparisonRows(monthly), widths: checkWidths },
    ];
    return {
      sheets: assemblePackWorkbook({
        run,
        packLabel: "GSTR-9 / 9C reconciliation working",
        clientName,
        summary,
        reasonWords: REASON_WORDS,
        effectiveRows,
        choiceWords: CHOICE_WORDS,
        extraReadMe: [
          ["What this is", "The year's returns, the trial balance and the GSTR-9 figures as filed, set side by side with every difference shown as a residual. It does not reproduce the lines of the GSTR-9C certificate."],
          ["Comparators", "GSTR-1 and GSTR-3B turnover are compared with GSTR-9 4N less 4G plus 5A, 5B and 5C; books turnover with 5N; ITC with tables 6A and 8A. Each row states what it compared."],
          ["Missing months", "A return not loaded for a month is named; the year's total is then not shown as complete."],
          ["Rounding", "A difference of ten rupees or less is read as rounding and is labelled so."],
          ["GSTR-9 figures", "Typed by a person from the return as filed; they are stored with the pack and a changed figure makes a new pack."],
        ],
        sheets,
      }),
      fileName: packFileName(run, clientName, "gstr-9c-working"),
      provisional: summary.provisional,
    };
  },
});
