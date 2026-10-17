// src/services/audit-pack-kinds/caro.kind.js
//
// W10 AP29 (2026-10-17): the data-driven clauses of the Companies (Auditor's Report) Order, 2020 as a pack. The rules
// and arithmetic are caro.engine.js; this file is the request it accepts and the columns of its filing sheet. It reads
// this year's books and the year before's (the cash-loss clause and the internal audit thresholds need both), three
// facts about the company the books do not hold, and the amounts the books do not group.

import { AMOUNT_COLUMNS, AMOUNT_ROWS, CARO_RULE_VERSION, CHOICES, COMPANY_TYPES, YES_NO, buildCaroRows, createCaroBook } from "../audit-pack-engine/caro.engine.js";
import { createMeasure, formatRatio } from "../audit-pack-engine/ratios.engine.js";
import { formatRupees } from "../audit-pack-engine/clause21d.engine.js";
import { defineFindingKind, previousFinancialYear } from "./finding-kind.js";
import { amountsInput, choiceInput, readAmounts } from "./inputs.js";

const COMPANY = choiceInput("companyType", "Kind of company", COMPANY_TYPES, "UNSPECIFIED", "The Order's exclusions and the internal audit thresholds depend on it. Left as 'not stated', the applicability row says it cannot be told.");
const GROUP = choiceInput("groupCompany", "Subsidiary or holding company of a public company", YES_NO, "UNSPECIFIED", "A private company that is one is not exempt from the Order on size.");
const LISTED = choiceInput("listed", "Listed company", YES_NO, "UNSPECIFIED", "A listed company must have an internal audit whatever its size.");
const AMOUNTS = amountsInput("amounts", "Amounts the books do not hold", AMOUNT_ROWS, AMOUNT_COLUMNS, "Optional. Depreciation for both years is needed for the cash-loss clause. A row left blank is not entered: where an answer needs it, the row says so.");

const optionValues = (descriptor) => descriptor.options.map((o) => o.value);

async function stream(source, consumers) {
  for await (const voucher of source()) for (const consumer of consumers) consumer.add(voucher);
}

const answerWords = Object.fromEntries(Object.values(CHOICES).map((c) => [c.value, c.label]));

export const caroKind = defineFindingKind({
  kind: "CARO",
  label: "CARO 2020: the clauses the books can speak to",
  ruleVersion: CARO_RULE_VERSION,
  needsPrior: true,
  sections: [
    { code: "APPLICABILITY", label: "Does the Order apply" },
    { code: "CLAUSES", label: "Clauses" },
    { code: "INPUT_GAPS", label: "What could not be placed" },
  ],
  extraCreateFields: ["companyType", "groupCompany", "listed", "amounts"],
  extraInputs: [COMPANY, GROUP, LISTED, AMOUNTS],

  prepareParams(input, { httpError }) {
    const pick = (descriptor, value) => {
      const chosen = String(value ?? descriptor.default).toUpperCase();
      if (!optionValues(descriptor).includes(chosen)) throw httpError(400, `${descriptor.label} is one of: ${optionValues(descriptor).join(", ")}.`, "AUDIT_PACK_SOURCE_REFUSED");
      return chosen;
    };
    let amounts;
    try {
      amounts = readAmounts(AMOUNTS, input.amounts);
    } catch (error) {
      throw httpError(400, error.message, "AUDIT_PACK_SOURCE_REFUSED");
    }
    return { companyType: pick(COMPANY, input.companyType), groupCompany: pick(GROUP, input.groupCompany), listed: pick(LISTED, input.listed), amounts };
  },

  async build({ financialYear, masters, vouchers, priorVouchers, prior, snapshot, params, assertLease }) {
    const current = createMeasure({ financialYear, ledgers: masters.ledgers });
    const book = createCaroBook({ financialYear, ledgers: masters.ledgers });
    await stream(vouchers, [current, book]);
    await assertLease();
    const priorYear = previousFinancialYear(financialYear);
    const before = createMeasure({ financialYear: priorYear, ledgers: prior.ledgers });
    await stream(priorVouchers, [before]);
    return buildCaroRows({
      financialYear,
      snapshotId: String(snapshot._id),
      priorFinancialYear: priorYear,
      current: current.finish(),
      prior: before.finish(),
      book: book.finish(),
      companyType: params.companyType,
      group: params.groupCompany,
      listed: params.listed,
      amounts: params.amounts || {},
    });
  },

  /**
   * (xix): the auditor's opinion on material uncertainty. A narrative may be drafted from the indicators; it describes
   * them and never says whether a material uncertainty exists - that is the choice a person makes.
   */
  draftSpec(row) {
    const v = row.values || {};
    if (v.clause !== "(xix)") return null;
    const money = (minor) => (Number.isSafeInteger(minor) ? formatRupees(minor) : "not available");
    const ratio = (bp) => (Number.isSafeInteger(bp) ? formatRatio(bp, "TIMES") : "not available");
    return {
      purpose: "CARO_XIX_NARRATIVE",
      instruction: "Describe, neutrally and using only these indicators, what the figures show about the company's ability to meet its liabilities as they fall due within a year of the balance sheet date. Say which indicators are weaker and which are stronger. Do not say whether a material uncertainty exists, do not use the words 'in our opinion', and do not recommend an answer: the conclusion is the auditor's alone. Say that the expected dates of realisation and payment and the board's plans are not among these figures.",
      facts: [
        { label: "Current ratio this year", value: ratio(v.currentRatioBp) },
        { label: "Current ratio previous year", value: ratio(v.priorCurrentRatioBp) },
        { label: "Working capital at the year end", value: money(v.workingCapitalMinor) },
        { label: "Cash profit this year", value: money(v.cashProfitMinor) },
        { label: "Total borrowings at the year end", value: money(v.debtMinor) },
      ],
    };
  },

  reportChoices: Object.values(CHOICES).map((c) => c.value),
  filingColumns: [
    { header: "Clause", width: 12, cell: (r) => r.values.clause },
    { header: "Item", width: 56, cell: (r) => r.label },
    { header: "Your answer", width: 64, cell: (r) => answerWords[r.choice] || r.choice },
    { header: "Outstanding more than six months", width: 26, cell: (r) => (Number.isSafeInteger(r.values.arrearsMinor) ? { money: r.values.arrearsMinor } : "") },
    { header: "Your note", width: 80, cell: (r) => r.stored?.decision?.note || "" },
  ],
  choiceWords: answerWords,
  filePrefix: "caro-2020",
  readMe: [
    ["What this is", "The clauses of the Companies (Auditor's Report) Order, 2020 that the books can speak to: whether the Order applies, statutory dues outstanding more than six months (vii)(a), borrowings (ix)(a), internal audit (xiv), cash losses (xvii) and the indicators for (xix). Every conclusion is yours."],
    ["Applicability", "The thresholds in paragraph 1(2) are applied to the figures in the books and to the three facts you give. Where they cannot tell, the row says what is missing and your answer decides. If the Order does not apply to the company, the clause rows are not reported."],
    ["Statutory dues", "Dues are aged first-in-first-out from the date of each credit entry plus thirty days; the due date is not in the books. Whether a due is disputed, and the extent of arrears, are your answers."],
    ["Borrowings", "The books carry no repayment schedule, so a default cannot be read from them. The movement on each borrowing is shown; the answer is yours."],
    ["Cash losses", "A cash loss is a loss after adding back depreciation and other non-cash items, for this year and the year before. Depreciation for both years is needed."],
    ["Material uncertainty", "The clause is the auditor's opinion. The indicators are shown, and a narrative can be drafted from them, labelled DRAFT FOR REVIEW; it never chooses the answer."],
  ],
});
