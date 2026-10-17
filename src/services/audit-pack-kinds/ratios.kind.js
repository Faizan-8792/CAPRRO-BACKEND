// src/services/audit-pack-kinds/ratios.kind.js
//
// W10 AP28 (2026-10-17): the eleven Schedule III ratios as a pack. The rules and arithmetic are ratios.engine.js;
// this file is the request it accepts and the columns of its filing sheet. It reads this year's books and the year
// before's (both required: the change test needs both), and the amounts the books do not group (finance costs,
// depreciation, and so on) that the person types, one column for each year.

import {
  AMOUNT_COLUMNS,
  AMOUNT_ROWS,
  CHOICES,
  RATIOS_RULE_VERSION,
  buildRatioRows,
  createMeasure,
  formatRatio,
} from "../audit-pack-engine/ratios.engine.js";
import { defineFindingKind, previousFinancialYear } from "./finding-kind.js";
import { amountsInput, readAmounts } from "./inputs.js";

const AMOUNTS = amountsInput(
  "amounts",
  "Amounts the books do not group",
  AMOUNT_ROWS,
  AMOUNT_COLUMNS,
  "Optional. Type what you have from the financial statements, for this year and the year before. A row left blank is not entered: a ratio that cannot be worked without it says so, and one that can be worked without it reads it as nil and says that too.",
);

async function measureYear({ financialYear, ledgers, stream }) {
  const measure = createMeasure({ financialYear, ledgers });
  for await (const voucher of stream()) measure.add(voucher);
  return measure.finish();
}

const shown = (r, which) => {
  const bp = which === "current" ? r.values.valueBp : r.values.priorValueBp;
  return Number.isSafeInteger(bp) ? formatRatio(bp, r.values.unit) : "Not available";
};

export const ratiosKind = defineFindingKind({
  kind: "SCHEDULE3_RATIOS",
  label: "Schedule III ratios: the eleven ratios and the change from the previous year",
  ruleVersion: RATIOS_RULE_VERSION,
  needsPrior: true,
  sections: [
    { code: "RATIOS", label: "The eleven ratios" },
    { code: "INPUT_GAPS", label: "What could not be placed" },
  ],
  extraCreateFields: ["amounts"],
  extraInputs: [AMOUNTS],

  prepareParams(input, { httpError }) {
    try {
      return { amounts: readAmounts(AMOUNTS, input.amounts) };
    } catch (error) {
      throw httpError(400, error.message, "AUDIT_PACK_SOURCE_REFUSED");
    }
  },

  async build({ financialYear, masters, vouchers, priorVouchers, prior, snapshot, params, assertLease }) {
    const current = await measureYear({ financialYear, ledgers: masters.ledgers, stream: vouchers });
    await assertLease();
    const priorYear = previousFinancialYear(financialYear);
    const before = await measureYear({ financialYear: priorYear, ledgers: prior.ledgers, stream: priorVouchers });
    return buildRatioRows({
      financialYear,
      snapshotId: String(snapshot._id),
      priorFinancialYear: priorYear,
      current,
      prior: before,
      amounts: params.amounts || {},
    });
  },

  reportChoices: [CHOICES.REPORT.value, CHOICES.REPORT_EXPLAINED.value, CHOICES.NOT_APPLICABLE.value],
  filingColumns: [
    { header: "Ratio", width: 38, cell: (r) => r.label },
    { header: "Numerator", width: 44, cell: (r) => r.values.numeratorLabel },
    { header: "Denominator", width: 36, cell: (r) => r.values.denominatorLabel },
    { header: "This year", width: 16, cell: (r) => (r.choice === "NOT_APPLICABLE" ? "Not applicable" : shown(r, "current")) },
    { header: "Previous year", width: 16, cell: (r) => (r.choice === "NOT_APPLICABLE" ? "Not applicable" : shown(r, "prior")) },
    { header: "Change, per cent", width: 16, cell: (r) => (Number.isSafeInteger(r.values.changeBp) ? `${(r.values.changeBp / 100).toFixed(2)}` : "Not tested") },
    { header: "Reason for a change above 25%", width: 70, cell: (r) => r.stored?.decision?.note || "" },
  ],
  choiceWords: Object.fromEntries(Object.values(CHOICES).map((c) => [c.value, c.label])),
  filePrefix: "schedule-iii-ratios",
  readMe: [
    ["What this is", "The eleven ratios Schedule III asks a company to disclose, from the Tally books of this year and the year before, each with the figures that went into it so you can redo it by hand."],
    ["The change test", "A ratio that moved by more than 25% from the previous year is flagged and needs its reason in the note. The comparison is exact (the ratios are kept as fractions of paise); the percentage shown is rounded to two decimals."],
    ["Averages", "A turnover or return that Schedule III works on an average uses the simple average of the opening and closing balance. The opening is the ledgers' opening balance; the closing is the opening plus the year's movement."],
    ["What you type", "Finance costs, depreciation, principal repaid, tax and income from investments are not Tally groups; you type them for each year. A ratio that cannot be worked without one says which. An optional one you leave blank is read as nil and the row says so."],
    ["Not applicable", "A ratio whose denominator is nil has no value. You are asked to confirm it as not applicable; it is never shown as nil."],
    ["Not decided here", "Whether the books' classification into current and non-current is right for this company is your judgement; the conventions are stated on each row."],
  ],
});
