// src/services/audit-pack-kinds/finding-kind.js
//
// W10 (2026-10-17): the builder every pack that works over a books snapshot uses (the 3CD clauses, Schedule III
// ageing and ratios, CARO, the ledger scans). A "finding" is something an engine noticed in the books - a cash
// payment over the limit, a bill past its due date, an unusual entry - shown with the rule that fired and the
// vouchers behind it. A person decides each one: report it, or say why not.
//
// What the builder owns, so no pack carries its own copy:
//   - reading the sealed snapshot (and, for packs that compare years, the prior one), refusing a snapshot of
//     another client or year or one that is not sealed;
//   - the decision rules: a choice must be one the row offered, a choice that needs a note needs one, an
//     exclusion needs a reason, and a row that cannot be decided yet (an input is missing) cannot be confirmed;
//   - the summary: provisional until every decidable row is decided and no input is missing, with the amount
//     the person chose to report;
//   - the workbook: Read me, a "For filing" sheet of CONFIRMED rows the person chose to report, every finding,
//     what is pending, every decision.
//
// A pack supplies only: its sections, its engine (build), the columns of its filing sheet and its words.

import BooksSnapshot from "../../models/BooksSnapshot.js";
import { readSnapshotMasters, streamVouchers } from "../books-snapshot.service.js";
import { SHARED_REASON_WORDS, STATE_WORDS, choice, sumMinor } from "./kit.js";
import { booksSnapshotInput } from "./inputs.js";
import { assemblePackWorkbook, isDecided, packFileName, ruleText, words } from "./workbook-generic.js";

export const SNAPSHOT_SOURCE_KIND = "BOOKS_SNAPSHOT";

/** The shape the pack service stores for a snapshot it read, beside the imports other packs read. */
export function snapshotBatch(snapshot, role = "") {
  return {
    _id: snapshot._id,
    kind: SNAPSHOT_SOURCE_KIND,
    activeImportGeneration: String(snapshot.contentHash || "").slice(0, 64),
    sourceHash: String(snapshot.contentHash || ""),
    period: "",
    role,
  };
}

/** "2025-26" -> "2024-25": the year a prior-year snapshot must be for. */
export function previousFinancialYear(financialYear) {
  const start = Number(String(financialYear).slice(0, 4)) - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

async function loadSealed({ firmId, client, financialYear, snapshotId, label, helpers }) {
  const { httpError, objectId } = helpers;
  if (!snapshotId) throw httpError(400, `Choose the ${label} snapshot of the client's books.`, "AUDIT_PACK_SOURCE_REFUSED");
  const snapshot = await BooksSnapshot.findOne({ _id: objectId(snapshotId, `${label} snapshot`), firmId }).lean();
  if (!snapshot) throw httpError(404, `The ${label} snapshot is not in this firm.`);
  if (snapshot.status !== "SEALED") throw httpError(409, `The ${label} snapshot has not been sealed.`, "AUDIT_PACK_SOURCE_NOT_READY");
  if (String(snapshot.clientId) !== String(client._id)) throw httpError(400, `The ${label} snapshot belongs to another client.`, "AUDIT_PACK_SOURCE_REFUSED");
  return snapshot;
}

/**
 * @param {object} def
 * @param {string} def.kind               e.g. "CLAUSE21D"
 * @param {string} def.label
 * @param {string} def.ruleVersion
 * @param {{code:string,label:string}[]} def.sections
 * @param {string[]} [def.extraCreateFields]
 * @param {object[]} [def.extraInputs]      one inputs.js descriptor per extraCreateFields entry, in the same order
 * @param {boolean} [def.needsPrior]       the pack also reads the prior year's snapshot (priorSnapshotId), required
 * @param {{field:string,label:string,help:string}} [def.earlierSnapshot]   the pack also compares an earlier export of the SAME year (taken before the one chosen), required
 * @param {boolean} [def.optionalPrior]    the pack reads the prior year's snapshot when one is given, and says what it cannot know without it
 * @param {(input:object, helpers:object) => object} [def.prepareParams]   checks the pack's own request fields
 * @param {(ctx:{financialYear:string,masters:object,vouchers:()=>AsyncIterable,params:object,snapshot:object,prior:object|null}) => Promise<{rows:object[],monthsLoaded?:string[],monthsMissing?:string[]}>} def.build
 * @param {string[]} def.reportChoices     the choices that put an amount into the filing sheet
 * @param {{header:string,width:number,cell:(row:object)=>any}[]} def.filingColumns
 * @param {object} def.choiceWords         choice code -> words, for the Decisions sheet
 * @param {object} [def.reasonWords]
 * @param {string[][]} [def.readMe]        [[item, detail]] pack-specific explanations
 * @param {string} def.filePrefix
 * @param {(row:object) => (object|null)} [def.draftSpec]   words an AI may draft for a row (see draft.js); null for rows that take none
 */
export function defineFindingKind(def) {
  const reasonWords = { ...SHARED_REASON_WORDS, ...(def.reasonWords || {}) };
  const sectionCodes = def.sections.map((s) => s.code);

  const effectiveRow = (row) => {
    const decision = row.decision || null;
    return { ...row, state: decision?.state || row.state, choice: decision?.choice || "" };
  };

  const amountOf = (row) => (Number.isSafeInteger(row.values?.amountMinor) ? row.values.amountMinor : 0);

  function summarize(rows) {
    const effective = rows.map(effectiveRow);
    const decidable = effective.filter((r) => r.decidable);
    const undecided = decidable.filter((r) => !isDecided(r));
    const gaps = effective.filter((r) => !r.decidable && r.state === "PENDING_INPUT");
    const reportable = effective.filter((r) => r.decidable && r.state === "CONFIRMED" && def.reportChoices.includes(r.choice));
    const reasons = [];
    if (undecided.length) reasons.push({ code: "ROWS_NOT_DECIDED", count: undecided.length, blocking: true });
    if (gaps.length) reasons.push({ code: "INPUTS_MISSING", count: gaps.length, blocking: true });
    return {
      ruleVersion: def.ruleVersion,
      provisional: reasons.some((r) => r.blocking),
      reasons,
      totals: {
        reportableMinor: sumMinor(reportable.map(amountOf), `${def.kind} reportable`),
        reportableCount: reportable.length,
        findings: decidable.length,
        decided: decidable.length - undecided.length,
        undecided: undecided.length,
        inputGaps: gaps.length,
      },
      counts: Object.fromEntries(sectionCodes.map((code) => [code, effective.filter((r) => r.section === code).length])),
    };
  }

  return Object.freeze({
    kind: def.kind,
    label: def.label,
    ruleVersion: def.ruleVersion,
    sections: def.sections,
    createFields: ["snapshotId", ...(def.needsPrior || def.optionalPrior ? ["priorSnapshotId"] : []), ...(def.earlierSnapshot ? [def.earlierSnapshot.field] : []), ...(def.extraCreateFields || [])],
    inputs: Object.freeze([
      booksSnapshotInput("snapshotId", "The year's books", "A sealed snapshot of this client's Tally export for this financial year."),
      ...(def.needsPrior
        ? [booksSnapshotInput("priorSnapshotId", "The prior year's books", "A sealed snapshot of the year before; it must be a different export.")]
        : def.optionalPrior
          ? [Object.freeze({ ...booksSnapshotInput("priorSnapshotId", "The prior year's books", "Optional. A sealed snapshot of the year before. Without it, balances brought forward cannot be traced to the bills behind them, and the pack says so."), required: false })]
          : []),
      ...(def.earlierSnapshot ? [booksSnapshotInput(def.earlierSnapshot.field, def.earlierSnapshot.label, def.earlierSnapshot.help)] : []),
      ...(def.extraInputs || []),
    ]),
    reasonWords,
    // The answers that put a row's amount into the filing sheet and the summary's reportable total. Exposed
    // so a test (and any future caller) asks the pack instead of assuming the word REPORT.
    reportChoices: Object.freeze([...def.reportChoices]),

    async prepare({ firmId, client, financialYear, input, helpers }) {
      const snapshot = await loadSealed({ firmId, client, financialYear, snapshotId: input.snapshotId, label: "books", helpers });
      if (snapshot.financialYear !== financialYear) {
        throw helpers.httpError(400, `The chosen snapshot is for ${snapshot.financialYear}, not ${financialYear}.`, "AUDIT_PACK_SOURCE_REFUSED");
      }
      const batches = [snapshotBatch(snapshot, "current")];
      let priorId = null;
      if (def.needsPrior || (def.optionalPrior && input.priorSnapshotId)) {
        const prior = await loadSealed({ firmId, client, financialYear, snapshotId: input.priorSnapshotId, label: "prior-year", helpers });
        if (String(prior._id) === String(snapshot._id)) throw helpers.httpError(400, "The prior-year snapshot must be a different export.", "AUDIT_PACK_SOURCE_REFUSED");
        // A prior year that is not the year before would put another year's figures into every comparison.
        if (prior.financialYear !== previousFinancialYear(financialYear)) {
          throw helpers.httpError(400, `The prior-year snapshot is for ${prior.financialYear}, not ${previousFinancialYear(financialYear)}.`, "AUDIT_PACK_SOURCE_REFUSED");
        }
        batches.push(snapshotBatch(prior, "prior"));
        priorId = String(prior._id);
      }
      let earlierId = null;
      if (def.earlierSnapshot) {
        const earlier = await loadSealed({ firmId, client, financialYear, snapshotId: input[def.earlierSnapshot.field], label: "earlier", helpers });
        if (String(earlier._id) === String(snapshot._id)) throw helpers.httpError(400, "The earlier export must be a different export.", "AUDIT_PACK_SOURCE_REFUSED");
        if (earlier.financialYear !== financialYear) throw helpers.httpError(400, `The earlier export is for ${earlier.financialYear}, not ${financialYear}.`, "AUDIT_PACK_SOURCE_REFUSED");
        if (new Date(earlier.createdAt) >= new Date(snapshot.createdAt)) throw helpers.httpError(400, "The earlier export must have been taken before the one chosen above.", "AUDIT_PACK_SOURCE_REFUSED");
        batches.push(snapshotBatch(earlier, "earlier"));
        earlierId = String(earlier._id);
      }
      const params = def.prepareParams ? def.prepareParams(input, helpers) : {};
      return { batches, params: { ...params, snapshotId: String(snapshot._id), ...(priorId ? { priorSnapshotId: priorId } : {}), ...(earlierId ? { earlierSnapshotId: earlierId } : {}) } };
    },

    async compute({ run, assertLease }) {
      const firmId = run.firmId;
      const masters = await readSnapshotMasters({ firmId, snapshotId: run.params.snapshotId });
      await assertLease();
      const prior = run.params.priorSnapshotId ? await readSnapshotMasters({ firmId, snapshotId: run.params.priorSnapshotId }) : null;
      const vouchers = (snapshotId = run.params.snapshotId) => streamVouchers({ firmId, snapshotId });
      const built = await def.build({
        run,
        financialYear: run.financialYear,
        masters,
        vouchers,
        priorVouchers: prior ? () => streamVouchers({ firmId, snapshotId: run.params.priorSnapshotId }) : null,
        params: run.params,
        snapshot: masters.snapshot,
        prior,
        assertLease,
      });
      return { monthsLoaded: [], monthsMissing: [], ...built };
    },

    effectiveRow,
    summarize,
    draftSpec: def.draftSpec,
    readMe: def.readMe || [],

    validateDecision(row, { state, choice, reason, note }) {
      if (state === "EXCLUDED") {
        if (!reason) throw new RangeError("Say why this row is excluded.");
        return;
      }
      const offered = row.values?.choices || [];
      if (offered.length === 0) throw new RangeError("This row takes no answer; it is worked out from other rows.");
      const picked = offered.find((c) => c.value === choice);
      if (!picked) throw new RangeError("Choose one of the answers offered for this row.");
      if (picked.needsNote && !String(note || "").trim()) throw new RangeError(`${picked.label}: say what supports this in the note.`);
    },

    displayLines: (row) => (row.values?.lines || []).map((l) => ({ label: l.label, value: l.value ?? null, kind: l.kind || "text" })),

    choicesFor(row) {
      if (!row.decidable) return null;
      const options = row.values?.choices || [];
      return options.length ? { field: "choice", options: options.map((c) => ({ value: c.value, label: c.label })), requiredWhenDifferent: true } : null;
    },

    workbook({ run, clientName, effectiveRows, summary }) {
      const filing = effectiveRows.filter((r) => r.decidable && r.state === "CONFIRMED" && def.reportChoices.includes(r.choice));
      const columnsHeaders = def.filingColumns.map((c) => c.header);
      const columnsWidths = def.filingColumns.map((c) => c.width);
      const filingSheet = summary.provisional
        ? { name: "For filing", headers: ["Provisional"], rows: [["Nothing is offered for filing: rows are still undecided or an input is missing. See Pending."]], widths: [100] }
        : { name: "For filing", headers: columnsHeaders, rows: filing.map((r) => def.filingColumns.map((c) => c.cell(r))), widths: columnsWidths };
      const allFindings = {
        name: "All findings",
        headers: ["Section", "Row", "State", "Your answer", "Amount", "Note", "How it was read"],
        rows: effectiveRows.map((r) => [
          r.section,
          r.label,
          words(STATE_WORDS, r.state),
          words(def.choiceWords, r.choice || ""),
          { money: Number.isSafeInteger(r.values?.amountMinor) ? r.values.amountMinor : null },
          { text: [r.stored?.decision?.reason, r.stored?.decision?.note].filter(Boolean).join(" - "), wrap: true },
          { text: ruleText(r), wrap: true },
        ]),
        widths: [16, 56, 26, 40, 18, 50, 90],
      };
      return {
        sheets: assemblePackWorkbook({
          run,
          packLabel: def.label,
          clientName,
          summary,
          reasonWords,
          effectiveRows,
          choiceWords: def.choiceWords,
          extraReadMe: [
            ...(def.readMe || []),
            ["Amount for filing", summary.provisional ? "Not shown until every row is decided and no input is missing." : `${filing.length} row(s) the person chose to report.`],
          ],
          sheets: [filingSheet, allFindings],
        }),
        fileName: packFileName(run, clientName, def.filePrefix),
        provisional: summary.provisional,
      };
    },
  });
}

export { choice };
