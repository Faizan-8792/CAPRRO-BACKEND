// tests/caro-contract.mjs
//
// W10 AP29 (2026-10-17). The data-driven clauses of CARO 2020: the engine against the two hand-worked years of the
// ratios fixture plus statutory dues and borrowings of its own (pure, in paise), each threshold to the paisa,
// first-in-first-out ageing of dues to the day, automated breakages, and - with a scratch MongoDB - the pack through
// the real routes, with the (xix) narrative drafted by a stand-in provider and the conclusion left to a person.
//
// Added to the ratios fixture for this year (rupees):
//   TDS Payable (Duties & Taxes), PF Payable (Current Liabilities, read as statutory by its name)
//   30 Apr  salaries 10,000 accrued to TDS     7 May  paid 4,000     31 Oct  salaries 20,000 accrued     7 Jan  paid 6,000
//   31 Dec  salaries 5,000 accrued to PF       1 Aug  term loan drawn 50,000      31 Dec  term loan repaid 1,00,000
// so: net profit 3,04,000 - 35,000 = 2,69,000; current assets 10,09,000; current liabilities 4,80,000; debt 4,00,000
// (4,50,000 at the start); GST payable 1,38,800 all more than six months past due; TDS 20,000 and PF 5,000 not.
//
// Run: node tests/caro-contract.mjs
//      MONGODB_URI=mongodb://127.0.0.1:27117/scratch-gates-caro node tests/caro-contract.mjs

import { mutantChecks, runMutants } from "./lib/mutants.mjs";
import { AMOUNTS, CURRENT_LEDGERS, PRIOR_LEDGERS, currentVouchers, ledgerDocs, priorVouchers, rupees, voucher } from "./lib/ratios-fixture.mjs";

const LEDGERS = [...CURRENT_LEDGERS, ["TDS Payable", "DUTIES_TAXES", 0], ["PF Payable", "CURRENT_LIABILITIES", 0]];

function vouchers() {
  const base = currentVouchers();
  return [
    ...base,
    voucher("2025-04-30", ["Salaries", -10000], ["TDS Payable", 10000]),
    voucher("2025-05-07", ["TDS Payable", -4000], ["State Bank", 4000]),
    voucher("2025-10-31", ["Salaries", -20000], ["TDS Payable", 20000]),
    voucher("2026-01-07", ["TDS Payable", -6000], ["State Bank", 6000]),
    voucher("2025-12-31", ["Salaries", -5000], ["PF Payable", 5000]),
    voucher("2025-08-01", ["State Bank", -50000], ["Term Loan", 50000]),
    voucher("2025-12-31", ["Term Loan", -100000], ["State Bank", 100000]),
  ];
}

const CARO_AMOUNTS = { DEPRECIATION: AMOUNTS.DEPRECIATION };

async function runChecks(modules) {
  const { caro, ratios } = modules;
  const { CRORE, THRESHOLDS, addMonths, ageStatutory, applicability, buildCaroRows, cashProfit, createCaroBook, internalAuditRequired, isStatutoryLedger } = caro;
  const { createMeasure } = ratios;
  const checks = [];
  const check = (name, fn) => Promise.resolve().then(fn).then(() => checks.push({ name, pass: true })).catch((error) => checks.push({ name, pass: false, detail: String(error.message).split("\n")[0] }));
  const eq = (actual, expected, what = "") => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${what ? `${what}: ` : ""}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };

  const measureYear = (financialYear, ledgers, list, withBook = false) => {
    const measure = createMeasure({ financialYear, ledgers: ledgerDocs(ledgers) });
    const book = createCaroBook({ financialYear, ledgers: ledgerDocs(ledgers) });
    for (const v of list) {
      measure.add(v);
      if (withBook) book.add(v);
    }
    return { measure: measure.finish(), book: book.finish() };
  };
  const build = ({ companyType = "PUBLIC", group = "NO", listed = "NO", amounts = CARO_AMOUNTS, extra = [], priorExtra = [] } = {}) => {
    const now = measureYear("2025-26", LEDGERS, [...vouchers(), ...extra], true);
    const before = measureYear("2024-25", PRIOR_LEDGERS, [...priorVouchers(), ...priorExtra]);
    return buildCaroRows({ financialYear: "2025-26", snapshotId: "S1", priorFinancialYear: "2024-25", current: now.measure, prior: before.measure, book: now.book, companyType, group, listed, amounts }).rows;
  };
  const rows = build();
  const clause = (id, from = rows) => from.filter((r) => r.values.clause === id);
  const at = (value) => ({ minor: value, source: "typed" });
  const facts = (over = {}) => ({
    paidUp: at(5 * CRORE), priorPaidUp: at(5 * CRORE), capitalAndReserves: 9 * CRORE, revenue: 8 * CRORE, turnover: 8 * CRORE, priorTurnover: 8 * CRORE,
    booksBorrowingsHigh: 0, priorBooksBorrowingsHigh: 0, bankBorrowingsHigh: undefined, priorBankBorrowingsHigh: undefined, deposits: undefined, priorDeposits: undefined, ...over,
  });

  await check("the statutory thresholds are the Order's and the Act's, in paise", () => {
    eq(CRORE, 1_000_000_000);
    eq(THRESHOLDS, {
      PRIVATE_CAPITAL_AND_RESERVES: 1 * CRORE, PRIVATE_BORROWINGS: 1 * CRORE, PRIVATE_REVENUE: 10 * CRORE, SMALL_PAID_UP: 4 * CRORE, SMALL_TURNOVER: 40 * CRORE,
      INTERNAL_AUDIT_PAID_UP: 50 * CRORE, INTERNAL_AUDIT_TURNOVER: 200 * CRORE, INTERNAL_AUDIT_BORROWINGS: 100 * CRORE, INTERNAL_AUDIT_DEPOSITS: 25 * CRORE,
    });
  });

  // ── applicability
  await check("a bank or insurance company, a section 8 company and a one person company are outside the Order, whatever their size", () => {
    for (const type of ["BANKING_OR_INSURANCE", "SECTION_8", "OPC"]) eq(applicability({ facts: facts({ capitalAndReserves: 900 * CRORE, revenue: 900 * CRORE, turnover: 900 * CRORE }), companyType: type, group: "YES" }).verdict, "NOT_APPLICABLE", type);
  });
  await check("a public company is within the Order; a private company that is a subsidiary or holding company of a public company is too, however small", () => {
    eq(applicability({ facts: facts(), companyType: "PUBLIC", group: "NO" }).verdict, "APPLICABLE");
    eq(applicability({ facts: facts({ paidUp: at(1), capitalAndReserves: 1, revenue: 1, turnover: 1 }), companyType: "PUBLIC", group: "NO" }).verdict, "APPLICABLE", "a tiny public company");
    eq(applicability({ facts: facts({ paidUp: at(1), capitalAndReserves: 1, revenue: 1, turnover: 1 }), companyType: "PRIVATE", group: "YES" }).verdict, "APPLICABLE", "a tiny private subsidiary");
  });
  await check("a small company is outside the Order: private, not in a group, paid-up capital within 4 crore and turnover within 40 crore - each to the paisa", () => {
    const small = (over) => applicability({ facts: facts({ capitalAndReserves: 9 * CRORE, revenue: 90 * CRORE, ...over }), companyType: "PRIVATE", group: "NO" });
    eq(small({ paidUp: at(4 * CRORE), turnover: 40 * CRORE }).verdict, "NOT_APPLICABLE", "exactly 4 crore and 40 crore");
    eq(small({ paidUp: at(4 * CRORE + 1), turnover: 40 * CRORE }).verdict, "APPLICABLE", "a paisa over the paid-up limit");
    eq(small({ paidUp: at(4 * CRORE), turnover: 40 * CRORE + 1 }).verdict, "APPLICABLE", "a paisa over the turnover limit");
  });
  await check("a private company within 1 crore of capital and reserves, 1 crore of borrowings and 10 crore of revenue is outside the Order, and each limit is to the paisa", () => {
    // Small-company status is switched off (paid-up capital over 4 crore typed) so the paragraph 1(2) test stands alone.
    const base = { paidUp: at(5 * CRORE), turnover: 5 * CRORE, capitalAndReserves: 1 * CRORE, revenue: 10 * CRORE, booksBorrowingsHigh: 1 * CRORE };
    const sentences = (over) => applicability({ facts: facts({ ...base, ...over }), companyType: "PRIVATE", group: "NO" }).because.filter((b) => /small private company/.test(b)).length;
    eq(sentences({}), 1, "exactly at all three limits");
    eq(sentences({ capitalAndReserves: 1 * CRORE + 1 }), 0, "a paisa over on capital and reserves");
    eq(sentences({ revenue: 10 * CRORE + 1 }), 0, "a paisa over on revenue");
    eq(sentences({ booksBorrowingsHigh: 1 * CRORE + 1, bankBorrowingsHigh: 1 * CRORE + 1 }), 0, "a paisa over on typed borrowings");
    eq(sentences({ booksBorrowingsHigh: 50 * CRORE, bankBorrowingsHigh: 1 * CRORE }), 1, "total borrowings above the limit, bank borrowings typed within it");
  });
  await check("the books' total borrowings are an upper bound: above the limit with nothing typed, the Order cannot be ruled out and the row asks for the bank and institution figure", () => {
    const answer = applicability({ facts: facts({ paidUp: at(5 * CRORE), turnover: 5 * CRORE, capitalAndReserves: 1 * CRORE, revenue: 2 * CRORE, booksBorrowingsHigh: 3 * CRORE }), companyType: "PRIVATE", group: "NO" });
    eq(answer.verdict, "UNKNOWN");
    eq(answer.missing.some((m) => /highest borrowings from banks and financial institutions/.test(m)), true);
  });
  await check("what is not stated is asked for, not guessed: no kind of company, or a private company with no answer on its group", () => {
    const none = applicability({ facts: facts(), companyType: "UNSPECIFIED", group: "UNSPECIFIED" });
    eq([none.verdict, none.missing], ["UNKNOWN", ["the kind of company"]]);
    const noGroup = applicability({ facts: facts({ paidUp: at(1), capitalAndReserves: 1, revenue: 1, turnover: 1 }), companyType: "PRIVATE", group: "UNSPECIFIED" });
    eq([noGroup.verdict, noGroup.missing.length], ["UNKNOWN", 1]);
    eq(applicability({ facts: facts({ paidUp: at(1), capitalAndReserves: 1, revenue: 1, turnover: 1 }), companyType: "UNSPECIFIED", group: "YES" }).verdict, "UNKNOWN", "an unstated kind cannot be told from its size");
  });
  await check("the applicability row shows the figures the test stood on, the sentences that led to it and the thresholds, and offers both answers to the person", () => {
    const row = clause("1(2)", build({ companyType: "PRIVATE", group: "NO" }))[0];
    eq(row.section, "APPLICABILITY");
    eq([row.values.verdict, row.values.paidUpSource, row.values.paidUpMinor], ["NOT_APPLICABLE", "books", rupees(500000)]);
    eq(row.values.choices.map((c) => c.value), ["APPLICABLE", "NOT_APPLICABLE"]);
    eq(row.ruleHits.map((h) => h.rule).includes("THRESHOLDS"), true);
    eq(row.values.lines.some((l) => /Total revenue/.test(l.label) && l.value === rupees(1262000)), true);
  });

  // ── statutory dues
  await check("calendar months are added with the day clamped to the month's length", () => {
    eq([addMonths("2025-08-31", 6), addMonths("2025-09-30", 6), addMonths("2025-12-31", 2), addMonths("2024-08-31", 6)], ["2026-02-28", "2026-03-30", "2026-02-28", "2025-02-28"]);
  });
  await check("a due is in arrears once six months have passed since it became payable: the day before is not, the day after is, and a credit becomes payable thirty days after its date", () => {
    const entry = (date, amount) => ({ date, amountMinor: amount, order: 0, id: date });
    // payable 2025-09-30 -> six months on is 2026-03-30
    eq(ageStatutory({ openingMinor: 0, entries: [entry("2025-08-31", 100)], yearEndDay: "2026-03-30" }).arrearsMinor, 0, "year end is exactly six months on: not yet");
    eq(ageStatutory({ openingMinor: 0, entries: [entry("2025-08-31", 100)], yearEndDay: "2026-03-31" }).arrearsMinor, 100, "a day later: in arrears");
    eq(ageStatutory({ openingMinor: 0, entries: [entry("2025-09-01", 100)], yearEndDay: "2026-03-31" }).arrearsMinor, 0, "payable a day later again: not");
  });
  await check("payments settle the oldest due first, and what stood at the start of the year is more than six months old at the end", () => {
    const entry = (date, amount, id) => ({ date, amountMinor: amount, order: 0, id });
    const aged = ageStatutory({ openingMinor: 500, entries: [entry("2025-05-01", 300, "a"), entry("2025-06-01", 200, "b"), entry("2025-06-15", -600, "c"), entry("2026-03-01", 40, "d")], yearEndDay: "2026-03-31" });
    // 500 opening + 300 + 200 = 1,000 less 600 paid = 400 left: 200 of May's credit... (opening 500 settled, 100 of May's) -> May 200 + June 200 + March 40
    eq([aged.closingMinor, aged.arrearsMinor], [440, 400], "the oldest are settled first");
    const reversed = ageStatutory({ openingMinor: 500, entries: [entry("2025-05-01", 300, "a"), entry("2025-06-01", 200, "b"), entry("2025-06-15", -600, "c")], yearEndDay: "2026-03-31" });
    eq(reversed.arrearsMinor, 400);
    eq(ageStatutory({ openingMinor: 500, entries: [], yearEndDay: "2026-03-31" }).arrearsMinor, 500, "opening only");
  });
  await check("a payment ahead of any due, or an opening debit balance, is held to settle the next due and is never negative arrears", () => {
    const entry = (date, amount, id) => ({ date, amountMinor: amount, order: 0, id });
    const ahead = ageStatutory({ openingMinor: 0, entries: [entry("2025-04-10", -300, "a"), entry("2025-05-01", 200, "b")], yearEndDay: "2026-03-31" });
    eq([ahead.closingMinor, ahead.arrearsMinor, ahead.prepaidMinor], [-100, 0, 100]);
    const prepaidOpening = ageStatutory({ openingMinor: -250, entries: [entry("2025-05-01", 200, "a")], yearEndDay: "2026-03-31" });
    eq([prepaidOpening.closingMinor, prepaidOpening.arrearsMinor, prepaidOpening.prepaidMinor], [-50, 0, 50]);
  });
  await check("the dues ledgers are Duties & Taxes, and any Current Liabilities ledger a statutory name marks; provisions and ordinary creditors are not", () => {
    eq(isStatutoryLedger({ name: "GST Payable", standardGroup: "DUTIES_TAXES" }), true);
    eq(isStatutoryLedger({ name: "Anything", standardGroup: "DUTIES_TAXES" }), true);
    eq(isStatutoryLedger({ name: "PF Payable", standardGroup: "CURRENT_LIABILITIES" }), true);
    eq(isStatutoryLedger({ name: "Outstanding Expenses", standardGroup: "CURRENT_LIABILITIES" }), false);
    eq(isStatutoryLedger({ name: "Provision for Tax", standardGroup: "PROVISIONS" }), false);
    eq(isStatutoryLedger({ name: "TDS Payable", standardGroup: "SUNDRY_CREDITORS" }), false);
  });
  await check("clause (vii)(a) from the books: GST payable 1,38,800 is all in arrears, TDS 20,000 and PF 5,000 are not, and a ledger read as statutory by its name says so", () => {
    const vii = clause("(vii)(a)");
    eq(vii.map((r) => r.values.ledger), ["GST Payable", "PF Payable", "TDS Payable"]);
    const by = Object.fromEntries(vii.map((r) => [r.values.ledger, r.values]));
    eq([by["GST Payable"].closingMinor, by["GST Payable"].arrearsMinor], [rupees(138800), rupees(138800)]);
    eq([by["TDS Payable"].closingMinor, by["TDS Payable"].arrearsMinor, by["TDS Payable"].oldestPayableDay], [rupees(20000), 0, "2025-11-30"]);
    eq([by["PF Payable"].closingMinor, by["PF Payable"].arrearsMinor], [rupees(5000), 0]);
    eq(vii.find((r) => r.values.ledger === "PF Payable").ruleHits.some((h) => h.rule === "READ_AS_STATUTORY"), true);
    eq(vii.find((r) => r.values.ledger === "GST Payable").ruleHits.some((h) => h.rule === "READ_AS_STATUTORY"), false);
    eq(vii[0].values.choices.map((c) => c.value), ["REGULAR", "ARREARS"]);
  });

  // ── borrowings
  await check("clause (ix)(a) from the books: each borrowing's opening, drawings, repayments and closing, and no default read from them", () => {
    const ix = clause("(ix)(a)");
    eq(ix.map((r) => r.values.ledger), ["Bank OD", "Term Loan"]);
    const loan = ix.find((r) => r.values.ledger === "Term Loan").values;
    eq([loan.openingMinor, loan.additionsMinor, loan.repaymentsMinor, loan.closingMinor], [rupees(400000), rupees(50000), rupees(100000), rupees(350000)]);
    const od = ix.find((r) => r.values.ledger === "Bank OD").values;
    eq([od.openingMinor, od.closingMinor], [rupees(50000), rupees(50000)]);
    eq(loan.choices.map((c) => c.value), ["NO_DEFAULT", "DEFAULT"]);
    eq(ix[0].ruleHits[0].rule, "NO_SCHEDULE_IN_BOOKS");
  });

  // ── internal audit
  await check("a listed company needs an internal audit whatever its size", () => {
    eq(internalAuditRequired({ facts: facts({ priorTurnover: 1, priorPaidUp: at(1) }), companyType: "PUBLIC", listed: "YES" }).verdict, "REQUIRED");
  });
  await check("an unlisted public company: paid-up capital 50 crore, turnover 200 crore, borrowings 100 crore or deposits 25 crore - each reaches it exactly and not a paisa short", () => {
    const only = (over) => internalAuditRequired({ facts: facts({ priorPaidUp: at(1), priorTurnover: 1, priorBooksBorrowingsHigh: 0, priorDeposits: 0, ...over }), companyType: "PUBLIC", listed: "NO" }).verdict;
    eq(only({}), "NOT_REQUIRED");
    eq([only({ priorPaidUp: at(50 * CRORE) }), only({ priorPaidUp: at(50 * CRORE - 1) })], ["REQUIRED", "NOT_REQUIRED"], "paid-up capital");
    eq([only({ priorTurnover: 200 * CRORE }), only({ priorTurnover: 200 * CRORE - 1 })], ["REQUIRED", "NOT_REQUIRED"], "turnover");
    eq([only({ priorBooksBorrowingsHigh: 100 * CRORE, priorBankBorrowingsHigh: 100 * CRORE }), only({ priorBooksBorrowingsHigh: 100 * CRORE, priorBankBorrowingsHigh: 100 * CRORE - 1 })], ["REQUIRED", "NOT_REQUIRED"], "borrowings, typed");
    eq([only({ priorDeposits: 25 * CRORE }), only({ priorDeposits: 25 * CRORE - 1 })], ["REQUIRED", "NOT_REQUIRED"], "deposits");
  });
  await check("a private company: turnover 200 crore or borrowings 100 crore, and paid-up capital and deposits do not count", () => {
    const only = (over) => internalAuditRequired({ facts: facts({ priorPaidUp: at(900 * CRORE), priorTurnover: 1, priorBooksBorrowingsHigh: 0, priorDeposits: 900 * CRORE, ...over }), companyType: "PRIVATE", listed: "NO" }).verdict;
    eq(only({}), "NOT_REQUIRED", "huge paid-up capital and deposits do not count for a private company");
    eq([only({ priorTurnover: 200 * CRORE }), only({ priorTurnover: 200 * CRORE - 1 })], ["REQUIRED", "NOT_REQUIRED"]);
    eq(only({ priorBooksBorrowingsHigh: 100 * CRORE, priorBankBorrowingsHigh: 100 * CRORE }), "REQUIRED");
  });
  await check("the books' total borrowings above the limit cannot say bank borrowings are, and a public company's listing must be known before 'not required'", () => {
    const unsure = internalAuditRequired({ facts: facts({ priorPaidUp: at(1), priorTurnover: 1, priorBooksBorrowingsHigh: 150 * CRORE, priorDeposits: 0 }), companyType: "PRIVATE", listed: "NO" });
    eq(unsure.verdict, "UNKNOWN");
    eq(unsure.missing.some((m) => /borrowings from banks and financial institutions/.test(m)), true);
    const unlisted = internalAuditRequired({ facts: facts({ priorPaidUp: at(1), priorTurnover: 1, priorBooksBorrowingsHigh: 0, priorDeposits: 0 }), companyType: "PUBLIC", listed: "UNSPECIFIED" });
    eq([unlisted.verdict, unlisted.missing], ["UNKNOWN", ["whether the company is listed"]]);
  });
  await check("clause (xiv) is read on the previous year's figures and offers the person all three answers", () => {
    const xiv = clause("(xiv)", build({ companyType: "PRIVATE", group: "NO" }))[0];
    eq(xiv.values.verdict, "NOT_REQUIRED");
    eq(xiv.values.choices.map((c) => c.value), ["AUDIT_SYSTEM_OK", "AUDIT_SYSTEM_NOT_OK", "AUDIT_NOT_REQUIRED"]);
    eq(xiv.values.lines.some((l) => /Turnover, the previous year/.test(l.label) && l.value === rupees(900000)), true);
  });

  // ── cash losses
  await check("cash profit is the net result plus depreciation plus other non-cash items; blank depreciation is missing, never nil", () => {
    const { measure } = measureYear("2025-26", LEDGERS, vouchers());
    eq(cashProfit({ measure, typed: CARO_AMOUNTS, column: "current" }).profitMinor, rupees(269000 + 60000));
    eq(cashProfit({ measure, typed: { DEPRECIATION: { current: rupees(60000) }, OTHER_NON_CASH: { current: -rupees(8000) } }, column: "current" }).profitMinor, rupees(321000));
    eq(cashProfit({ measure, typed: {}, column: "current" }).profitMinor, null);
  });
  await check("clause (xvii): both years have a cash profit, so only 'no cash loss' is offered; depreciation untyped makes the row wait", () => {
    const xvii = clause("(xvii)")[0];
    eq([xvii.values.cashProfitMinor, xvii.values.priorCashProfitMinor, xvii.values.cashLoss, xvii.values.priorCashLoss], [rupees(329000), rupees(244000), false, false]);
    eq(xvii.values.choices.map((c) => c.value), ["NO_CASH_LOSS"]);
    const waiting = clause("(xvii)", build({ amounts: {} }))[0];
    eq([waiting.state, waiting.values.choices, waiting.ruleHits.some((h) => h.rule === "INPUT_MISSING")], ["PENDING_INPUT", [], true]);
    const oneYear = clause("(xvii)", build({ amounts: { DEPRECIATION: { current: rupees(60000) } } }))[0];
    eq(oneYear.state, "PENDING_INPUT", "the previous year's depreciation is needed too");
  });
  await check("a loss that is only depreciation is not a cash loss; a loss beyond it is, and either year counts", () => {
    const heavy = [voucher("2026-03-30", ["Freight", -600000], ["Cash", 600000])];
    const loss = clause("(xvii)", build({ extra: heavy }))[0];
    eq([loss.values.cashProfitMinor, loss.values.cashLoss, loss.values.choices.map((c) => c.value)], [rupees(269000 - 600000 + 60000), true, ["CASH_LOSS"]]);
    const cover = clause("(xvii)", build({ extra: heavy, amounts: { DEPRECIATION: { current: rupees(400000), prior: rupees(70000) } } }))[0];
    eq([cover.values.cashProfitMinor, cover.values.cashLoss], [rupees(269000 - 600000 + 400000), false], "depreciation of 4,00,000 turns a net loss into a cash profit");
    const nil = clause("(xvii)", build({ extra: [voucher("2026-03-30", ["Freight", -329000], ["Cash", 329000])] }))[0];
    eq([nil.values.cashProfitMinor, nil.values.cashLoss], [0, false], "a cash profit of exactly nil is not a loss");
    const priorLoss = clause("(xvii)", build({ priorExtra: [voucher("2025-03-30", ["Freight", -500000], ["Cash", 500000])] }))[0];
    eq([priorLoss.values.priorCashLoss, priorLoss.values.cashLoss, priorLoss.values.choices.map((c) => c.value)], [true, false, ["CASH_LOSS"]], "the year before alone");
  });

  // ── (xix)
  await check("clause (xix) quotes the indicators and offers both conclusions to the person; nothing in the row concludes", () => {
    const xix = clause("(xix)")[0];
    eq([xix.values.currentRatioBp, xix.values.priorCurrentRatioBp, xix.values.workingCapitalMinor, xix.values.cashProfitMinor, xix.values.debtMinor], [21021, 23646, rupees(529000), rupees(329000), rupees(400000)]);
    eq(xix.values.choices.map((c) => c.value), ["NO_MATERIAL_UNCERTAINTY", "MATERIAL_UNCERTAINTY"]);
    eq(xix.values.choices.every((c) => c.needsNote), true);
    const words = JSON.stringify(xix);
    eq(/we conclude|in our opinion no|no material uncertainty exists\./i.test(words.replace(/My conclusion: no material uncertainty exists/g, "")), false);
  });

  // ── the whole pack
  await check("the pack has applicability, nine clause rows (three dues, two borrowings, three single clauses... counted below) and no gaps for a clean year", () => {
    eq(rows.filter((r) => r.section === "APPLICABILITY").length, 1);
    eq(rows.filter((r) => r.section === "CLAUSES").length, 3 + 2 + 3);
    eq(rows.filter((r) => r.section === "INPUT_GAPS").length, 0);
    for (const r of rows) eq(r.sourceEvidenceCount > 0, true, r.label);
    eq(new Set(rows.map((r) => r.rowKey)).size, rows.length);
    eq(JSON.stringify(build()), JSON.stringify(build()));
  });
  await check("an unreadable voucher in either year, or an unmapped group, is a gap a person cannot decide", () => {
    const bad = { ...voucher("2025-09-09", ["Cash", -1], ["Sales", 1]), date: null };
    const out = build({ extra: [bad], priorExtra: [{ ...bad, date: null }] });
    const gaps = out.filter((r) => r.section === "INPUT_GAPS");
    eq(gaps.map((g) => g.ruleHits[0].rule), ["UNREADABLE_VOUCHERS", "UNREADABLE_VOUCHERS"]);
    eq(gaps.every((g) => g.decidable === false), true);
  });
  return checks;
}

const MUTANTS = [
  { name: "the small private company limit on capital and reserves is 2 crore", from: "PRIVATE_CAPITAL_AND_RESERVES: 1 * CRORE,", to: "PRIVATE_CAPITAL_AND_RESERVES: 2 * CRORE," },
  { name: "the small private company limit on borrowings is 2 crore", from: "PRIVATE_BORROWINGS: 1 * CRORE,", to: "PRIVATE_BORROWINGS: 2 * CRORE," },
  { name: "the small private company limit on revenue is 20 crore", from: "PRIVATE_REVENUE: 10 * CRORE,", to: "PRIVATE_REVENUE: 20 * CRORE," },
  { name: "the small company paid-up limit is 2 crore", from: "SMALL_PAID_UP: 4 * CRORE,", to: "SMALL_PAID_UP: 2 * CRORE," },
  { name: "the small company turnover limit is 20 crore", from: "SMALL_TURNOVER: 40 * CRORE,", to: "SMALL_TURNOVER: 20 * CRORE," },
  { name: "the internal audit paid-up limit is 5 crore", from: "INTERNAL_AUDIT_PAID_UP: 50 * CRORE,", to: "INTERNAL_AUDIT_PAID_UP: 5 * CRORE," },
  { name: "the internal audit turnover limit is 100 crore", from: "INTERNAL_AUDIT_TURNOVER: 200 * CRORE,", to: "INTERNAL_AUDIT_TURNOVER: 100 * CRORE," },
  { name: "the internal audit borrowings limit is 1,000 crore", from: "INTERNAL_AUDIT_BORROWINGS: 100 * CRORE,", to: "INTERNAL_AUDIT_BORROWINGS: 1000 * CRORE," },
  { name: "the internal audit deposits limit is 250 crore", from: "INTERNAL_AUDIT_DEPOSITS: 25 * CRORE,", to: "INTERNAL_AUDIT_DEPOSITS: 250 * CRORE," },
  { name: "a one person company is not excluded", from: '["BANKING_OR_INSURANCE", "SECTION_8", "OPC"].includes(companyType)', to: '["BANKING_OR_INSURANCE", "SECTION_8"].includes(companyType)' },
  { name: "a subsidiary or holding company of a public company may be a small company", from: "const small = and(isPrivate, inGroup === null ? null : !inGroup,", to: "const small = and(isPrivate," },
  { name: "the size limits are 'less than' instead of 'not more than'", from: "const atMost = (value, limit) => (Number.isSafeInteger(value) ? value <= limit : null);", to: "const atMost = (value, limit) => (Number.isSafeInteger(value) ? value < limit : null);" },
  { name: "the internal audit limits are 'more than' instead of 'or more'", from: "const atLeast = (value, limit) => (Number.isSafeInteger(value) ? value >= limit : null);", to: "const atLeast = (value, limit) => (Number.isSafeInteger(value) ? value > limit : null);" },
  { name: "a listed company is not required to have an internal audit by that fact alone", from: 'if (listed === "YES") return', to: 'if (false) return' },
  { name: "dues are aged from the credit date, not thirty days after it", from: "export const DUE_LAG_DAYS = 30;", to: "export const DUE_LAG_DAYS = 0;" },
  { name: "arrears start after five months, not six", from: "export const ARREARS_MONTHS = 6;", to: "export const ARREARS_MONTHS = 5;" },
  { name: "a due exactly six months old is in arrears", from: "addMonths(bucket.payableDay, ARREARS_MONTHS) < yearEndDay", to: "addMonths(bucket.payableDay, ARREARS_MONTHS) <= yearEndDay" },
  { name: "the opening balance is not old", from: "bucket.payableDay === null || addMonths", to: "bucket.payableDay !== null && addMonths" },
  { name: "payments settle the newest due first", from: "const take = Math.min(left, buckets[0].amountMinor);\n      buckets[0].amountMinor -= take;\n      left -= take;\n      if (buckets[0].amountMinor === 0) buckets.shift();", to: "const last = buckets.length - 1;\n      const take = Math.min(left, buckets[last].amountMinor);\n      buckets[last].amountMinor -= take;\n      left -= take;\n      if (buckets[last].amountMinor === 0) buckets.pop();" },
  { name: "a payment ahead of any due is lost instead of held for the next", from: "    prepaid += left;\n  };", to: "  };" },
  { name: "depreciation is not added back to find a cash loss", from: "profitMinor: sumMinor([measure.netProfit, dep, otherMinor], \"cash profit\")", to: "profitMinor: sumMinor([measure.netProfit, otherMinor], \"cash profit\")" },
  { name: "a cash profit of nil is a cash loss", from: "const lossNow = now.profitMinor === null ? null : now.profitMinor < 0;", to: "const lossNow = now.profitMinor === null ? null : now.profitMinor <= 0;" },
  { name: "a cash loss in the year before alone is not offered as one", from: "choices: missingCash.length ? [] : lossNow || lossBefore ? [CHOICES.CASH_LOSS] : [CHOICES.NO_CASH_LOSS],", to: "choices: missingCash.length ? [] : lossNow ? [CHOICES.CASH_LOSS] : [CHOICES.NO_CASH_LOSS]," },
  { name: "statutory ledgers are found only under Duties & Taxes", from: '  return ledger.standardGroup === "CURRENT_LIABILITIES" && STATUTORY_NAME.test(ledger.name || "");', to: "  return false;" },
  { name: "a provision is read as a statutory due", from: 'if (ledger.standardGroup === "DUTIES_TAXES") return true;', to: 'if (ledger.standardGroup === "DUTIES_TAXES" || ledger.standardGroup === "PROVISIONS") return true;' },
  { name: "the previous year's turnover is replaced by this year's for the internal audit test", from: "priorTurnover: prior.netSales,", to: "priorTurnover: current.netSales," },
  { name: "the opinion rows offer no way to say a material uncertainty exists", from: "choices: [CHOICES.NO_MATERIAL_UNCERTAINTY, CHOICES.MATERIAL_UNCERTAINTY],", to: "choices: [CHOICES.NO_MATERIAL_UNCERTAINTY]," },
];

async function main() {
  const caroPath = new URL("../src/services/audit-pack-engine/caro.engine.js", import.meta.url);
  const caro = await import(caroPath.href);
  const ratios = await import("../src/services/audit-pack-engine/ratios.engine.js");
  const checks = await runChecks({ caro, ratios });
  checks.push(...mutantChecks(await runMutants({ enginePath: caroPath, mutants: MUTANTS, runChecks: (m) => runChecks({ caro: m, ratios }) })));

  const uri = process.env.MONGODB_URI || "";
  const scratch = /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(uri) && /scratch/i.test((uri.split("/").pop() || "").split("?")[0]);
  let note = "engine only (no scratch MONGODB_URI)";
  if (scratch) {
    const { runSnapshotPackFlow } = await import("./lib/snapshot-pack-routes.mjs");
    const decide = (row) => {
      if (row.state === "PENDING_INPUT") return { state: "EXCLUDED", reason: "Not available when the pack was made" };
      const option = row.choices?.options?.[0];
      return option ? { state: "CONFIRMED", choice: option.value, note: "Decided in the contract" } : null;
    };
    checks.push(...(await runSnapshotPackFlow({
      uri,
      label: "Caro",
      kind: "CARO",
      ledgers: ledgerDocs(LEDGERS),
      vouchers: vouchers().map(({ _id, ...v }) => v),
      priorSnapshot: { financialYear: "2024-25", ledgers: ledgerDocs(PRIOR_LEDGERS), vouchers: priorVouchers().map(({ _id, ...v }) => v) },
      body: { companyType: "PUBLIC", groupCompany: "NO", listed: "NO", amounts: { DEPRECIATION: AMOUNTS.DEPRECIATION } },
      decide,
      expectedWorkbookSheets: ["For filing"],
      expect: async ({ run, section, call, A, snapshotId, priorSnapshotId, clientId, runId, mock }) => {
        const out = [];
        const c = (name, pass, detail = "") => out.push({ name, pass: Boolean(pass), detail });
        c("the run names its three sections", run.sections.map((s) => s.code).join(",") === "APPLICABILITY,CLAUSES,INPUT_GAPS", run.sections.map((s) => s.code).join(","));
        c("one applicability row, eight clause rows and no gaps are read by section", section("APPLICABILITY").length === 1 && section("CLAUSES").length === 8 && section("INPUT_GAPS").length === 0, `${section("APPLICABILITY").length}/${section("CLAUSES").length}/${section("INPUT_GAPS").length}`);
        c("a public company is told the Order applies, and the row says so in its figures", section("APPLICABILITY")[0].values.verdict === "APPLICABLE");
        const gst = section("CLAUSES").find((r) => r.values.ledger === "GST Payable");
        c("the GST payable arrears survive the database in paise", gst?.values.arrearsMinor === 13_880_000 && gst?.values.closingMinor === 13_880_000, JSON.stringify(gst?.values));
        c("the dues row's amount is the arrears, for the filing sheet", gst?.values.amountMinor === 13_880_000);

        const xix = section("CLAUSES").find((r) => r.values.clause === "(xix)");
        const others = section("CLAUSES").filter((r) => r.values.clause !== "(xix)");
        c("only the going-concern row can be drafted", xix?.draftable === true && others.every((r) => r.draftable === false), others.map((r) => r.draftable).join(","));
        const picture = async () => JSON.stringify((await call("GET", `/api/audit-packs/${runId}/rows?section=CLAUSES&limit=100`, A.token)).json?.rows?.map((r) => ({ k: r.rowKey, v: r.values, s: r.state, d: r.decision, ch: r.choices })));
        const before = await picture();
        mock.on(() => "The current ratio is 2.10 times against 2.36 times last year, and working capital is positive. The expected dates of realisation and payment and the board's plans are not among these figures.");
        const drafted = await call("POST", `/api/audit-packs/${runId}/rows/${xix.rowKey}/draft`, A.token, {});
        c("a narrative is drafted, labelled DRAFT FOR REVIEW", drafted.json?.available === true && drafted.json.row.draft?.label === "DRAFT FOR REVIEW" && drafted.json.row.draft.purpose === "CARO_XIX_NARRATIVE", JSON.stringify(drafted.json)?.slice(0, 200));
        const prompt = mock.calls.at(-1).body.messages[1].content;
        c("the provider is told not to conclude, and is sent the indicators only", /Do not say whether a material uncertainty exists/.test(prompt) && /Current ratio this year: 2.10 times/.test(prompt) && /Working capital at the year end: ₹5,29,000.00/.test(prompt) && !/GST Payable|Term Loan/.test(prompt), prompt.slice(0, 400));
        c("the draft changes nothing the pack computed and chooses nothing: the row is still undecided with both answers on offer", (await picture()) === before && JSON.stringify(xix.choices.options.map((o) => o.value)) === JSON.stringify(["NO_MATERIAL_UNCERTAINTY", "MATERIAL_UNCERTAINTY"]));
        const withoutChoice = await call("POST", `/api/audit-packs/${runId}/rows/${xix.rowKey}/decision`, A.token, { expectedVersion: 0, state: "CONFIRMED", note: drafted.json.row.draft.text });
        c("the drafted words cannot stand in for the conclusion: confirming (xix) without choosing is refused", withoutChoice.status === 400, `status ${withoutChoice.status}`);
        const noNote = await call("POST", `/api/audit-packs/${runId}/rows/${xix.rowKey}/decision`, A.token, { expectedVersion: 0, state: "CONFIRMED", choice: "NO_MATERIAL_UNCERTAINTY" });
        c("a conclusion on (xix) needs the person's note", noNote.status === 400, `status ${noNote.status}`);
        mock.off();

        const bad = await call("POST", "/api/audit-packs", A.token, { kind: "CARO", clientId: String(clientId), financialYear: "2025-26", snapshotId, priorSnapshotId, companyType: "PARTNERSHIP" });
        c("a kind of company the pack does not know is refused", bad.status === 400, `status ${bad.status}`);
        const noPrior = await call("POST", "/api/audit-packs", A.token, { kind: "CARO", clientId: String(clientId), financialYear: "2025-26", snapshotId });
        c("without the previous year's books the request is refused", noPrior.status === 400, `status ${noPrior.status}`);
        return out;
      },
    })));
    note = "scratch Mongo included";
  }

  let failed = 0;
  for (const c of checks) {
    if (c.pass) console.log(`PASS  ${c.name}`);
    else {
      failed += 1;
      console.error(`FAIL  ${c.name}${c.detail ? `\n      ${c.detail}` : ""}`);
    }
  }
  console.log(`\ncaro-contract: ${checks.length - failed}/${checks.length} passed (${note})`);
  process.exitCode = failed ? 1 : 0;
}

await main();
