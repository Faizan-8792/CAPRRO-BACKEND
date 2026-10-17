// tests/ratios-contract.mjs
//
// W10 AP28 (2026-10-17). The eleven Schedule III ratios: the engine against two hand-worked years (pure, in paise),
// the 25% test to the edge, what is asked for and what is read as nil, stock valuation journals however they were
// booked, automated breakages of the engine, and - with a scratch MongoDB - the same pack through the real routes
// with the typed amounts.
//
// FY 2025-26 (rupees; the openings are the closing balances of the year before it is NOT assumed - each year is its own
// snapshot). Balance sheet at 31 March 2026, worked by hand:
//   current assets    stock 2,00,000 + debtors 1,00,000 + cash 1,85,000 + bank 5,84,000          = 10,69,000
//   current liabilities creditors 1,96,200 + outstanding 30,000 + GST 1,38,800 + provision 40,000 + OD 50,000 = 4,55,000
//   total debt        term loan 4,00,000 + bank OD 50,000                                          = 4,50,000
//   equity            capital 5,00,000 + reserve 1,50,000 + profit 3,04,000                        = 9,54,000 (opening 6,50,000)
//   net sales         10,00,000 + 2,00,000 + 1,00,000 - 50,000 returned                           = 12,50,000
//   net profit        income 12,62,000 - expenses 9,58,000 (the stock journal credits 50,000)       = 3,04,000
//   cost of goods     1,50,000 + 6,90,000 + 20,000 - 2,00,000                                       = 6,60,000
//   credit sales      10,00,000 + 0 (cash) + 50,000 (the debtor's half of 1,18,000) - 50,000 return = 10,00,000
//   credit purchases  6,00,000 - 10,000 returned                                                    = 5,90,000
// Typed: finance costs 48,000; depreciation 60,000; principal repaid 1,00,000; tax 40,000; income from investments 12,000.
// FY 2024-25 is built the same way (see PRIOR below); its balance sheet is 16,36,000 a side.
//
// Run: node tests/ratios-contract.mjs
//      MONGODB_URI=mongodb://127.0.0.1:27117/scratch-gates-ratios node tests/ratios-contract.mjs

import { mutantChecks, runMutants } from "./lib/mutants.mjs";
import { STANDARD_GROUPS } from "../src/services/books/group-mapping.js";

const rupees = (value) => Math.round(value * 100);

// ─── the books ─────────────────────────────────────────────────────────────

// [name, standard group, opening in rupees (credit +, debit -)]
const CURRENT_LEDGERS = [
  ["Capital", "CAPITAL_ACCOUNT", 500000],
  ["General Reserve", "RESERVES_SURPLUS", 150000],
  ["Term Loan", "LOANS_SECURED", 400000],
  ["Bank OD", "BANK_OD", 50000],
  ["Vendor A", "SUNDRY_CREDITORS", 100000],
  ["Outstanding Expenses", "CURRENT_LIABILITIES", 30000],
  ["GST Payable", "DUTIES_TAXES", 20000],
  ["Provision for Tax", "PROVISIONS", 0],
  ["Plant", "FIXED_ASSETS", -600000],
  ["Mutual Fund", "INVESTMENTS", -200000],
  ["Stock in Hand", "STOCK", -150000],
  ["Customer X", "SUNDRY_DEBTORS", -120000],
  ["Cash", "CASH", -10000],
  ["State Bank", "BANK", -170000],
  ["Sales", "SALES", 0],
  ["Purchases", "PURCHASE", 0],
  ["Closing Stock", "DIRECT_EXPENSES", 0],
  ["Freight", "DIRECT_EXPENSES", 0],
  ["Salaries", "INDIRECT_EXPENSES", 0],
  ["Interest Paid", "INDIRECT_EXPENSES", 0],
  ["Depreciation", "INDIRECT_EXPENSES", 0],
  ["Income Tax", "INDIRECT_EXPENSES", 0],
  ["Dividend Received", "INDIRECT_INCOMES", 0],
];

const PRIOR_LEDGERS = CURRENT_LEDGERS.map(([name, group]) => [
  name,
  group,
  {
    Capital: 500000, "General Reserve": 100000, "Term Loan": 500000, "Bank OD": 60000, "Vendor A": 80000, "Outstanding Expenses": 25000,
    "GST Payable": 15000, Plant: -700000, "Mutual Fund": -150000, "Stock in Hand": -100000, "Customer X": -100000, Cash: -10000, "State Bank": -220000,
  }[name] ?? 0,
]);

let counter = 0;
// pairs: [ledger, signed rupees (Tally: debit negative, credit positive)]
const voucher = (date, ...pairs) => ({ _id: `v${++counter}`, guid: `g${counter}`, alterId: counter, date, type: "Journal", number: String(counter), cancelled: false, optional: false, entries: pairs.map(([ledger, amount]) => ({ ledger, amountMinor: rupees(amount) })), bills: [], banks: [], warnings: [] });

function currentVouchers() {
  counter = 0;
  return [
    voucher("2025-05-10", ["Customer X", -1180000], ["Sales", 1000000], ["GST Payable", 180000]),
    voucher("2025-06-10", ["Cash", -236000], ["Sales", 200000], ["GST Payable", 36000]),
    voucher("2025-07-10", ["Customer X", -59000], ["Cash", -59000], ["Sales", 100000], ["GST Payable", 18000]),
    voucher("2025-08-10", ["Sales", -50000], ["GST Payable", -9000], ["Customer X", 59000]),
    voucher("2025-09-01", ["State Bank", -1200000], ["Customer X", 1200000]),
    voucher("2025-06-20", ["Purchases", -600000], ["GST Payable", -108000], ["Vendor A", 708000]),
    voucher("2025-07-20", ["Purchases", -100000], ["Cash", 100000]),
    voucher("2025-08-20", ["Vendor A", -11800], ["Purchases", 10000], ["GST Payable", 1800]),
    voucher("2025-09-20", ["Vendor A", -600000], ["State Bank", 600000]),
    voucher("2025-10-01", ["Freight", -20000], ["Cash", 20000]),
    voucher("2025-10-31", ["Salaries", -150000], ["State Bank", 150000]),
    voucher("2025-11-30", ["Interest Paid", -48000], ["State Bank", 48000]),
    voucher("2026-03-31", ["Depreciation", -60000], ["Plant", 60000]),
    voucher("2026-03-01", ["State Bank", -12000], ["Dividend Received", 12000]),
    voucher("2026-03-31", ["Income Tax", -40000], ["Provision for Tax", 40000]),
    voucher("2026-03-31", ["Stock in Hand", -50000], ["Closing Stock", 50000]),
  ];
}

function priorVouchers() {
  counter = 100;
  return [
    voucher("2024-06-10", ["Customer X", -944000], ["Sales", 800000], ["GST Payable", 144000]),
    voucher("2024-07-10", ["Cash", -118000], ["Sales", 100000], ["GST Payable", 18000]),
    voucher("2024-09-01", ["State Bank", -900000], ["Customer X", 900000]),
    voucher("2024-06-20", ["Purchases", -500000], ["GST Payable", -90000], ["Vendor A", 590000]),
    voucher("2024-09-20", ["Vendor A", -500000], ["State Bank", 500000]),
    voucher("2024-10-01", ["Freight", -15000], ["Cash", 15000]),
    voucher("2024-10-31", ["Salaries", -120000], ["State Bank", 120000]),
    voucher("2024-11-30", ["Interest Paid", -60000], ["State Bank", 60000]),
    voucher("2025-03-31", ["Depreciation", -70000], ["Plant", 70000]),
    voucher("2025-03-01", ["State Bank", -9000], ["Dividend Received", 9000]),
    voucher("2025-03-31", ["Income Tax", -20000], ["Provision for Tax", 20000]),
    voucher("2025-03-31", ["Stock in Hand", -50000], ["Closing Stock", 50000]),
  ];
}

const ledgerDocs = (rows) => rows.map(([name, group, open], i) => ({ name, standardGroup: group, parent: STANDARD_GROUPS[group].label, openingMinor: open === 0 ? null : rupees(open), alterId: 100 + i }));

const AMOUNTS = {
  FINANCE_COSTS: { current: rupees(48000), prior: rupees(60000) },
  DEPRECIATION: { current: rupees(60000), prior: rupees(70000) },
  PRINCIPAL_REPAID: { current: rupees(100000), prior: rupees(50000) },
  TAX_EXPENSE: { current: rupees(40000), prior: rupees(20000) },
  INVESTMENT_INCOME: { current: rupees(12000), prior: rupees(9000) },
};

// Expected ratios in hundredths of a percent of the ratio itself (ratio x 10,000), rounded half away from zero.
const EXPECTED = {
  CURRENT_RATIO: [23495, 23646, false],
  DEBT_EQUITY: [4717, 7235, true],
  DEBT_SERVICE_COVERAGE: [27838, 27636, false],
  RETURN_ON_EQUITY: [3791, 2533, true],
  INVENTORY_TURNOVER: [37714, 37200, false],
  RECEIVABLES_TURNOVER: [90909, 65574, true],
  PAYABLES_TURNOVER: [39838, 40000, false],
  NET_CAPITAL_TURNOVER: [20358, 18219, false],
  NET_PROFIT_RATIO: [2432, 1933, true],
  RETURN_ON_CAPITAL_EMPLOYED: [2792, 1904, true],
  RETURN_ON_INVESTMENT: [600, 600, false],
};

async function runChecks(engine) {
  const { buildRatioRows, changeOf, createMeasure, formatRatio, measureVouchers, CHANGE_THRESHOLD_BP, RATIO_CODES } = engine;
  const checks = [];
  const check = (name, fn) => Promise.resolve().then(fn).then(() => checks.push({ name, pass: true })).catch((error) => checks.push({ name, pass: false, detail: String(error.message).split("\n")[0] }));
  const eq = (actual, expected, what = "") => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${what ? `${what}: ` : ""}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };

  const measures = ({ ledgers = CURRENT_LEDGERS, vouchers = currentVouchers(), priorLedgers = PRIOR_LEDGERS, prior = priorVouchers() } = {}) => ({
    current: measureVouchers({ financialYear: "2025-26", ledgers: ledgerDocs(ledgers), vouchers }),
    prior: measureVouchers({ financialYear: "2024-25", ledgers: ledgerDocs(priorLedgers), vouchers: prior }),
  });
  const build = ({ amounts = AMOUNTS, ...rest } = {}) => {
    const { current, prior } = measures(rest);
    return buildRatioRows({ financialYear: "2025-26", snapshotId: "S1", priorFinancialYear: "2024-25", current, prior, amounts }).rows;
  };
  const rows = build();
  const ratio = (code, from = rows) => from.find((r) => r.section === "RATIOS" && r.values.ratio === code);
  const gaps = (from = rows) => from.filter((r) => r.section === "INPUT_GAPS");
  const rules = (row) => row.ruleHits.map((h) => h.rule);

  await check("the eleven ratios are the Schedule's, in its order", () => {
    eq(rows.filter((r) => r.section === "RATIOS").map((r) => r.values.ratio), RATIO_CODES);
    eq(rows.filter((r) => r.section === "RATIOS").map((r) => r.label.slice(0, 3)), ["(a)", "(b)", "(c)", "(d)", "(e)", "(f)", "(g)", "(h)", "(i)", "(j)", "(k)"]);
  });
  await check("the year's figures are worked by hand: sales, profit, cost of goods, credit sales and purchases, both sides of the balance sheet", () => {
    const { current } = measures();
    eq({
      netSales: current.netSales, netProfit: current.netProfit, purchases: current.purchases, directExpenses: current.directExpenses, creditSales: current.creditSales, creditPurchases: current.creditPurchases,
      currentAssets: current.currentAssets, currentLiabilities: current.currentLiabilities, debt: current.debt, equityOpening: current.equityOpening, equityClosing: current.equityClosing,
      stockClosing: current.stockClosing, debtorsClosing: current.debtorsClosing, creditorsClosing: current.creditorsClosing,
    }, {
      netSales: rupees(1250000), netProfit: rupees(304000), purchases: rupees(690000), directExpenses: rupees(20000), creditSales: rupees(1000000), creditPurchases: rupees(590000),
      currentAssets: rupees(1069000), currentLiabilities: rupees(455000), debt: rupees(450000), equityOpening: rupees(650000), equityClosing: rupees(954000),
      stockClosing: rupees(200000), debtorsClosing: rupees(100000), creditorsClosing: rupees(196200),
    });
  });
  await check("the books balance: assets equal liabilities and equity, a side each, both years", () => {
    const { current, prior } = measures();
    eq(current.balanceMinor, 0);
    eq(prior.balanceMinor, 0);
    eq(prior.netProfit, rupees(174000));
    eq(prior.currentAssets, rupees(856000));
    eq(prior.currentLiabilities, rupees(362000));
  });

  const labels = {
    CURRENT_RATIO: "(a) current ratio: 10,69,000 / 4,55,000",
    DEBT_EQUITY: "(b) debt-equity: 4,50,000 / 9,54,000",
    DEBT_SERVICE_COVERAGE: "(c) debt service coverage: (3,04,000 + 60,000 + 48,000) / (48,000 + 1,00,000)",
    RETURN_ON_EQUITY: "(d) return on equity: 3,04,000 / average of 6,50,000 and 9,54,000",
    INVENTORY_TURNOVER: "(e) inventory turnover: cost of goods 6,60,000 / average stock 1,75,000",
    RECEIVABLES_TURNOVER: "(f) receivables turnover: credit sales 10,00,000 / average debtors 1,10,000",
    PAYABLES_TURNOVER: "(g) payables turnover: credit purchases 5,90,000 / average creditors 1,48,100",
    NET_CAPITAL_TURNOVER: "(h) net capital turnover: 12,50,000 / working capital 6,14,000",
    NET_PROFIT_RATIO: "(i) net profit ratio: 3,04,000 / 12,50,000",
    RETURN_ON_CAPITAL_EMPLOYED: "(j) return on capital employed: (3,04,000 + 40,000 + 48,000) / 14,04,000",
    RETURN_ON_INVESTMENT: "(k) return on investment: 12,000 / average investments 2,00,000",
  };
  for (const [code, [now, before]] of Object.entries(EXPECTED)) {
    await check(`${labels[code]} - this year and last, to the hundredth of a percent`, () => {
      const row = ratio(code);
      eq([row.state, row.values.valueBp, row.values.priorValueBp], ["COMPUTED", now, before]);
    });
  }
  await check("the numerators and denominators are disclosed in paise: current ratio, return on equity (averaged) and debt service coverage", () => {
    const a = ratio("CURRENT_RATIO").values;
    eq([a.numeratorMinor, a.denominatorMinor, a.priorNumeratorMinor, a.priorDenominatorMinor, a.averaged], [rupees(1069000), rupees(455000), rupees(856000), rupees(362000), false]);
    const d = ratio("RETURN_ON_EQUITY").values;
    eq([d.numeratorMinor, d.denominatorMinor, d.averaged], [rupees(304000), rupees(802000), true]);
    const c = ratio("DEBT_SERVICE_COVERAGE").values;
    eq([c.numeratorMinor, c.denominatorMinor], [rupees(412000), rupees(148000)]);
    eq(ratio("RETURN_ON_EQUITY").values.lines.some((l) => /opening/.test(l.label) && l.value === rupees(650000)), true, "opening equity shown");
  });
  await check("the 25% flag is set exactly where the change is over a quarter: debt-equity, return on equity, receivables, net profit, return on capital employed", () => {
    for (const [code, [, , over]] of Object.entries(EXPECTED)) eq(ratio(code).values.changeOver25, over, code);
  });
  await check("a change just over 25% is flagged though it shows as 25.79%: net profit ratio 24.32% against 19.33%", () => {
    const r = ratio("NET_PROFIT_RATIO").values;
    eq(r.changeBp, 2579);
    eq(r.changeOver25, true);
    eq(r.lines.find((l) => l.label === "Change").value, "+25.79%");
  });
  await check("a flagged ratio can only be confirmed with a reason; an unflagged one with none; a nil denominator only as not applicable", () => {
    eq(ratio("DEBT_EQUITY").values.choices.map((c) => [c.value, c.needsNote]), [["REPORT_EXPLAINED", true]]);
    eq(ratio("CURRENT_RATIO").values.choices.map((c) => [c.value, c.needsNote]), [["REPORT", false]]);
  });
  await check("the 25% test is exact: 25.000% is not over, 25.001% is, and a change that rounds to 25.00% can still be over", () => {
    const f = (n, d) => ({ n: BigInt(n), d: BigInt(d) });
    eq(CHANGE_THRESHOLD_BP, 2500);
    eq(changeOf(f(125, 100), f(1, 1)), { changeBp: 2500, over: false }, "exactly a quarter");
    eq(changeOf(f(125001, 100000), f(1, 1)), { changeBp: 2500, over: true }, "25.001% rounds to 25.00% and is over");
    eq(changeOf(f(75, 100), f(1, 1)).over, false, "down exactly a quarter");
    eq(changeOf(f(74999, 100000), f(1, 1)).over, true, "down by just over a quarter");
    eq(changeOf(f(1, 1), f(0, 1)), null, "no change against a nil ratio");
    eq(changeOf(f(-3, 1), f(-2, 1)), { changeBp: -5000, over: true }, "a negative ratio is compared on its size");
  });
  await check("a ratio is shown as the Schedule does: two decimals, times or per cent, negative signed", () => {
    eq([formatRatio(23495, "TIMES"), formatRatio(4717, "TIMES"), formatRatio(3791, "PERCENT"), formatRatio(-50, "PERCENT"), formatRatio(null, "TIMES")], ["2.35 times", "0.47 times", "37.91%", "-0.50%", "Not available"]);
  });

  await check("figures the books do not hold, left untyped, make exactly the ratios that need them pending, naming them - never nil", () => {
    const bare = build({ amounts: {} });
    eq(["DEBT_SERVICE_COVERAGE", "RETURN_ON_CAPITAL_EMPLOYED", "RETURN_ON_INVESTMENT"].map((c) => ratio(c, bare).state), ["PENDING_INPUT", "PENDING_INPUT", "PENDING_INPUT"]);
    eq(RATIO_CODES.filter((c) => ratio(c, bare).state === "COMPUTED").length, 8);
    const hitOf = (code, rule) => ratio(code, bare).ruleHits.find((h) => h.rule === rule)?.detail || "";
    for (const name of ["Finance costs", "Depreciation and amortisation", "Principal repaid on borrowings and leases"]) eq(hitOf("DEBT_SERVICE_COVERAGE", "INPUT_MISSING").includes(name), true, name);
    eq(hitOf("DEBT_SERVICE_COVERAGE", "INPUT_MISSING").includes("Income tax"), false, "tax is not asked for by this ratio");
    for (const name of ["Finance costs", "Income tax and deferred tax charged"]) eq(hitOf("RETURN_ON_CAPITAL_EMPLOYED", "INPUT_MISSING").includes(name), true, name);
    eq(hitOf("RETURN_ON_CAPITAL_EMPLOYED", "INPUT_MISSING").includes("Depreciation"), false);
    eq(hitOf("RETURN_ON_INVESTMENT", "INPUT_MISSING").includes("Income from investments"), true);
    const dscr = ratio("DEBT_SERVICE_COVERAGE", bare);
    eq([dscr.values.valueBp, dscr.values.numeratorMinor, dscr.values.choices], [null, null, []]);
    eq(dscr.values.lines.some((l) => /FY 2025-26: /.test(l.label)), false, "no part lines for a year with a missing input");
  });
  await check("a row waiting on an input cannot be confirmed (it offers no answer) but is still evidence-backed, so it can be excluded with a reason", () => {
    const dscr = ratio("DEBT_SERVICE_COVERAGE", build({ amounts: {} }));
    eq([dscr.decidable, dscr.sourceEvidenceCount > 0], [true, true]);
  });
  await check("an optional figure left untyped is read as nil and the row says so; typed, it is used and the saying stops", () => {
    const a = ratio("CURRENT_RATIO");
    eq(rules(a).includes("INPUT_READ_AS_NIL"), true);
    eq(a.ruleHits.filter((h) => h.rule === "INPUT_READ_AS_NIL").some((h) => /Current maturities/.test(h.detail)), true);
    const typed = build({ amounts: { ...AMOUNTS, CURRENT_MATURITIES: { current: rupees(100000), prior: rupees(0) } } });
    eq(ratio("CURRENT_RATIO", typed).values.valueBp, 19261, "10,69,000 / 5,55,000");
    eq(ratio("CURRENT_RATIO", typed).values.priorValueBp, 23646, "an explicit nil changes nothing");
    eq(ratio("CURRENT_RATIO", typed).ruleHits.filter((h) => h.rule === "INPUT_READ_AS_NIL").length, 0);
    eq(ratio("NET_CAPITAL_TURNOVER", typed).values.denominatorMinor, rupees(514000), "working capital falls by the maturities");
    eq(ratio("DEBT_EQUITY", typed).values.valueBp, 4717, "debt is the same either way");
  });
  await check("optional figures change the ratios that use them: preference dividend, exceptional items, deferred tax, intangibles, other non-cash items", () => {
    const typed = build({ amounts: { ...AMOUNTS, PREFERENCE_DIVIDEND: { current: rupees(4000) }, EXCEPTIONAL_ITEMS: { current: rupees(10000) }, DEFERRED_TAX_LIABILITY: { current: rupees(6000) }, INTANGIBLES: { current: rupees(20000) }, OTHER_NON_CASH: { current: rupees(-8000) } } });
    eq(ratio("RETURN_ON_EQUITY", typed).values.numeratorMinor, rupees(300000), "profit less preference dividend");
    eq(ratio("RETURN_ON_CAPITAL_EMPLOYED", typed).values.numeratorMinor, rupees(382000), "exceptional gain taken out of earnings");
    eq(ratio("RETURN_ON_CAPITAL_EMPLOYED", typed).values.denominatorMinor, rupees(954000 - 20000 + 450000 + 6000), "equity less intangibles plus debt plus deferred tax");
    eq(ratio("DEBT_SERVICE_COVERAGE", typed).values.numeratorMinor, rupees(404000), "non-cash loss negative add-back");
  });
  await check("the previous year's missing amount leaves this year's ratio worked and the change untested, said so, with both answers open", () => {
    const partial = build({ amounts: { ...AMOUNTS, FINANCE_COSTS: { current: rupees(48000) } } });
    const c = ratio("DEBT_SERVICE_COVERAGE", partial);
    eq([c.state, c.values.valueBp, c.values.priorValueBp, c.values.changeBp, c.values.changeOver25], ["COMPUTED", 27838, null, null, null]);
    eq(rules(c).includes("CHANGE_NOT_KNOWN"), true);
    eq(c.values.choices.map((x) => x.value), ["REPORT", "REPORT_EXPLAINED"]);
  });
  await check("a nil denominator is not applicable, never 0 or an error: no stock, no investments and no debt service", () => {
    // A services company: no stock, no investments. What those ledgers held is moved into the bank so the books still balance.
    const without = (ledgers, movedToBank) => ledgers.filter(([n]) => !["Stock in Hand", "Mutual Fund", "Closing Stock"].includes(n)).map(([n, g, o]) => [n, g, n === "State Bank" ? o - movedToBank : o]);
    const noStock = (vouchers) => vouchers.filter((v) => !v.entries.some((e) => ["Stock in Hand", "Closing Stock"].includes(e.ledger)));
    const { INVESTMENT_INCOME: untyped, ...amounts } = AMOUNTS;
    void untyped;
    const bare = build({ amounts, ledgers: without(CURRENT_LEDGERS, 350000), vouchers: noStock(currentVouchers()), priorLedgers: without(PRIOR_LEDGERS, 250000), prior: noStock(priorVouchers()) });
    const inventory = ratio("INVENTORY_TURNOVER", bare);
    eq([inventory.state, inventory.values.valueBp, inventory.values.choices.map((c) => c.value), rules(inventory).includes("DENOMINATOR_NIL")], ["COMPUTED", null, ["NOT_APPLICABLE"], true]);
    const investment = ratio("RETURN_ON_INVESTMENT", bare);
    eq([investment.state, investment.values.valueBp, investment.values.choices.map((c) => c.value)], ["COMPUTED", null, ["NOT_APPLICABLE"]]);
    eq(rules(investment).includes("INPUT_MISSING"), false, "income from investments is not asked for when there are none");
    const none = build({ amounts: { ...AMOUNTS, FINANCE_COSTS: { current: 0, prior: 0 }, PRINCIPAL_REPAID: { current: 0, prior: 0 } } });
    eq(ratio("DEBT_SERVICE_COVERAGE", none).values.valueBp, null, "no debt service, no ratio");
    eq(ratio("DEBT_SERVICE_COVERAGE", none).values.choices.map((c) => c.value), ["NOT_APPLICABLE"]);
  });

  await check("a closing-stock journal gives the same ratios however its offsetting leg was booked: direct expenses, direct incomes or indirect incomes", () => {
    const rebook = (group) => {
      const ledgers = CURRENT_LEDGERS.map(([n, g, o]) => (n === "Closing Stock" ? [n, group, o] : [n, g, o]));
      return build({ ledgers });
    };
    for (const group of ["DIRECT_EXPENSES", "DIRECT_INCOMES", "INDIRECT_INCOMES", "PURCHASE"]) {
      const rebooked = rebook(group);
      eq([ratio("INVENTORY_TURNOVER", rebooked).values.numeratorMinor, ratio("NET_PROFIT_RATIO", rebooked).values.numeratorMinor, ratio("NET_PROFIT_RATIO", rebooked).values.denominatorMinor], [rupees(660000), rupees(304000), rupees(1250000)], group);
    }
  });
  await check("stock bought through the stock account is a purchase, not a change in valuation: cost of goods is unchanged and the average stock rises", () => {
    const withBought = [...currentVouchers(), voucher("2025-12-01", ["Stock in Hand", -100000], ["Vendor A", 100000])];
    const bought = build({ vouchers: withBought });
    const inventory = ratio("INVENTORY_TURNOVER", bought).values;
    eq([inventory.numeratorMinor, inventory.denominatorMinor], [rupees(660000), rupees(225000)]);
  });
  await check("credit sales are each voucher's sales times the debtor's share of its debit side, rounded half away from zero to the paisa", () => {
    const { current } = measures({ vouchers: [...currentVouchers(), voucher("2025-12-05", ["Customer X", -0.01], ["Cash", -0.01], ["Sales", 0.01], ["GST Payable", 0.01])] });
    eq(current.creditSales - rupees(1000000), 1, "1 paisa of sales, half billed to the debtor: 0.5 paisa rounds to 1");
  });
  await check("amounts beyond 32 bits of paise change nothing: every figure a thousand times larger gives the same ratios", () => {
    const big = (n) => n * 1000;
    const { current, prior } = measures({
      ledgers: CURRENT_LEDGERS.map(([n, g, o]) => [n, g, big(o)]),
      vouchers: currentVouchers().map((v) => ({ ...v, entries: v.entries.map((e) => ({ ...e, amountMinor: e.amountMinor * 1000 })) })),
      priorLedgers: PRIOR_LEDGERS.map(([n, g, o]) => [n, g, big(o)]),
      prior: priorVouchers().map((v) => ({ ...v, entries: v.entries.map((e) => ({ ...e, amountMinor: e.amountMinor * 1000 })) })),
    });
    const scaled = Object.fromEntries(Object.entries(AMOUNTS).map(([k, v]) => [k, { current: v.current * 1000, prior: v.prior * 1000 }]));
    const bigRows = buildRatioRows({ financialYear: "2025-26", snapshotId: "S1", priorFinancialYear: "2024-25", current, prior, amounts: scaled }).rows;
    eq(current.currentAssets > 2 ** 31, true, "past 32 bits");
    for (const [code, [now, before]] of Object.entries(EXPECTED)) eq([ratio(code, bigRows).values.valueBp, ratio(code, bigRows).values.priorValueBp], [now, before], code);
  });

  await check("a clean year has no gap rows; every ratio row is decidable, evidence-backed and keyed uniquely", () => {
    eq(gaps().length, 0);
    for (const r of rows) eq(r.sourceEvidenceCount > 0, true, r.label);
    eq(new Set(rows.map((r) => r.rowKey)).size, rows.length);
    eq(JSON.stringify(build()), JSON.stringify(build()));
  });
  await check("a ledger under an unmapped group, a voucher with no date, an unreadable amount or an unknown ledger each become a named gap that cannot be decided", () => {
    // A ledger whose group is not mapped has no standard group code; build its doc by hand.
    const docs = ledgerDocs(CURRENT_LEDGERS).concat([{ name: "Mystery", standardGroup: null, parent: "Mystery", openingMinor: null }]);
    const current = measureVouchers({ financialYear: "2025-26", ledgers: docs, vouchers: [...currentVouchers(), { ...voucher("2025-05-01", ["Cash", -1], ["Sales", 1]), date: null }, voucher("2025-05-02", ["Cash", -1], ["Ghost", 1]), { ...voucher("2025-05-03", ["Cash", -1], ["Sales", 1]), entries: [{ ledger: "Cash", amountMinor: 1.5 }, { ledger: "Sales", amountMinor: -1 }] }] });
    const prior = measureVouchers({ financialYear: "2024-25", ledgers: ledgerDocs(PRIOR_LEDGERS), vouchers: priorVouchers() });
    const out = buildRatioRows({ financialYear: "2025-26", snapshotId: "S1", priorFinancialYear: "2024-25", current, prior, amounts: AMOUNTS }).rows;
    const byRule = Object.fromEntries(gaps(out).map((g) => [g.ruleHits[0].rule, g]));
    eq(Object.keys(byRule).sort(), ["GROUPS_NOT_MAPPED", "UNREADABLE_VOUCHERS"]);
    eq([byRule.GROUPS_NOT_MAPPED.decidable, byRule.UNREADABLE_VOUCHERS.decidable, byRule.UNREADABLE_VOUCHERS.values.count], [false, false, 3]);
    eq(byRule.UNREADABLE_VOUCHERS.label.startsWith("FY 2025-26"), true, "names the year");
  });
  await check("books out of balance (a missing opening), purchases with no stock entry and a suspense balance are named gaps a person can exclude with a reason", () => {
    const noBank = build({ ledgers: CURRENT_LEDGERS.map(([n, g, o]) => (n === "State Bank" ? [n, g, 0] : [n, g, o])) });
    const out = gaps(noBank).find((g) => g.ruleHits[0].rule === "BOOKS_DO_NOT_BALANCE");
    eq([out.decidable, out.state, out.values.differenceMinor], [true, "PENDING_INPUT", rupees(170000)], "credits exceed debits by the missing bank opening");
    const noJournal = build({ vouchers: currentVouchers().filter((v) => !v.entries.some((e) => e.ledger === "Closing Stock")) });
    const stock = gaps(noJournal).find((g) => g.ruleHits[0].rule === "STOCK_NOT_POSTED");
    eq([stock.decidable, stock.values.purchasesMinor], [true, rupees(690000)]);
    const withSuspense = build({ ledgers: [...CURRENT_LEDGERS.map(([n, g, o]) => (n === "Cash" ? [n, g, o + 5000] : [n, g, o])), ["Suspense A/c", "SUSPENSE", -5000]] });
    const suspense = gaps(withSuspense).find((g) => g.ruleHits[0].rule === "BALANCE_LEFT_OUT");
    eq([suspense.decidable, suspense.values.balanceMinor], [true, -rupees(5000)]);
  });
  await check("the same inputs always give the same rows, in the same order, and every ratio row's rule hits name the formula and the conventions", () => {
    for (const r of rows.filter((x) => x.section === "RATIOS")) {
      eq(rules(r)[0], "FORMULA", r.label);
      eq(rules(r).includes("CONVENTION"), true, r.label);
    }
  });
  return checks;
}

const MUTANTS = [
  { name: "the 25% threshold is 26%", from: "export const CHANGE_THRESHOLD_BP = 2_500;", to: "export const CHANGE_THRESHOLD_BP = 2_600;" },
  { name: "exactly 25% counts as over", from: "over: absDiff * 10_000n > BigInt(CHANGE_THRESHOLD_BP) * scale,", to: "over: absDiff * 10_000n >= BigInt(CHANGE_THRESHOLD_BP) * scale," },
  { name: "the 25% test is made on the rounded percentage", from: "over: absDiff * 10_000n > BigInt(CHANGE_THRESHOLD_BP) * scale,", to: "over: Math.abs(Number(roundDiv(diff * 10_000n, scale))) > CHANGE_THRESHOLD_BP," },
  { name: "an average is the sum, not the half", from: "fraction(average ? BigInt(figures.numerator.minor) * 2n : BigInt(figures.numerator.minor), BigInt(denominatorMinor))", to: "fraction(BigInt(figures.numerator.minor), BigInt(denominatorMinor))" },
  { name: "the year's profit is left out of closing equity", from: 'equityClosing: add(close(GROUPS.EQUITY), netProfit, "equity"),', to: "equityClosing: close(GROUPS.EQUITY)," },
  { name: "closing stock is added to cost of goods instead of taken off", from: "y.stockAdditions, -y.stockClosing), parts", to: "y.stockAdditions, y.stockClosing), parts" },
  { name: "a stock valuation journal's profit and loss leg is counted as a sale, purchase or expense", from: "if (valuation) continue;", to: "if (false) continue;" },
  { name: "stock bought through the stock account is ignored", from: "if (touchesStock && !touchesProfitAndLoss) stockAdditions = add(", to: "if (false) stockAdditions = add(" },
  { name: "credit sales are all sales", from: 'creditSales = add(creditSales, share(sales, debtorDebits, debits), "credit sales");', to: 'creditSales = add(creditSales, sales, "credit sales");' },
  { name: "credit purchases are all purchases", from: 'creditPurchases = add(creditPurchases, share(purchases, creditorCredits, credits), "credit purchases");', to: 'creditPurchases = add(creditPurchases, purchases, "credit purchases");' },
  { name: "bank overdraft is not a current liability", from: 'CURRENT_LIABILITIES: ["SUNDRY_CREDITORS", "CURRENT_LIABILITIES", "DUTIES_TAXES", "PROVISIONS", "BANK_OD"],', to: 'CURRENT_LIABILITIES: ["SUNDRY_CREDITORS", "CURRENT_LIABILITIES", "DUTIES_TAXES", "PROVISIONS"],' },
  { name: "bank overdraft is not debt", from: 'DEBT: ["LOANS_LIABILITY", "LOANS_SECURED", "LOANS_UNSECURED", "BANK_OD"],', to: 'DEBT: ["LOANS_LIABILITY", "LOANS_SECURED", "LOANS_UNSECURED"],' },
  { name: "stock is not a current asset", from: 'CURRENT_ASSETS: ["STOCK", "SUNDRY_DEBTORS", "CASH", "BANK", "CURRENT_ASSETS", "DEPOSITS_ASSET", "LOANS_ADVANCES_ASSET"],', to: 'CURRENT_ASSETS: ["SUNDRY_DEBTORS", "CASH", "BANK", "CURRENT_ASSETS", "DEPOSITS_ASSET", "LOANS_ADVANCES_ASSET"],' },
  { name: "an input a ratio cannot be worked without is not recorded as missing", from: "missing.push(AMOUNT_LABEL[key]);", to: "void AMOUNT_LABEL[key];" },
  { name: "depreciation is optional for the debt service coverage ratio", from: 'const depreciation = ask.need("DEPRECIATION");', to: 'const depreciation = ask.optional("DEPRECIATION");' },
  { name: "tax is optional for the return on capital employed", from: 'const tax = ask.need("TAX_EXPENSE");', to: 'const tax = ask.optional("TAX_EXPENSE");' },
  { name: "finance costs are not added back in debt service coverage", from: "minor: sum(y.netProfit, depreciation, finance, other)", to: "minor: sum(y.netProfit, depreciation, other)" },
  { name: "preference dividend is added to profit", from: "sum(y.netProfit, -preference)", to: "sum(y.netProfit, preference)" },
  { name: "exceptional items are left in earnings", from: "sum(y.netProfit, tax, finance, -exceptional)", to: "sum(y.netProfit, tax, finance, exceptional)" },
  { name: "the current maturities are not added to current liabilities", from: 'denominator: { label: "Current liabilities", minor: liabilities,', to: 'denominator: { label: "Current liabilities", minor: y.currentLiabilities,' },
  { name: "payables turnover averages the debtors", from: "average: { openingMinor: y.creditorsOpening, closingMinor: y.creditorsClosing }", to: "average: { openingMinor: y.debtorsOpening, closingMinor: y.debtorsClosing }" },
  { name: "working capital adds the liabilities", from: "minor: sum(y.currentAssets, -liabilities)", to: "minor: sum(y.currentAssets, liabilities)" },
  { name: "a nil denominator gives a ratio of nothing", from: "  if (d === 0n) return null;", to: "  if (d === 0n) return { n: 0n, d: 1n };" },
  { name: "income from investments is asked for even when there are no investments", from: 'minor: anyInvestments ? ask.need("INVESTMENT_INCOME") : 0,', to: 'minor: ask.need("INVESTMENT_INCOME"),' },
  { name: "a ratio is rounded down instead of to the nearest", from: "const q = (2n * a + d) / (2n * d);", to: "const q = (2n * a) / (2n * d);" },
  { name: "a flagged ratio can be confirmed without a reason", from: "choices = [CHOICES.REPORT_EXPLAINED];", to: "choices = [CHOICES.REPORT];" },
  { name: "a voucher with no date is dropped without a word", from: "if (!voucher.date) {", to: "if (false) {" },
  { name: "a trial balance that does not balance is not reported", from: "if (Math.abs(measure.balanceMinor) >= BALANCE_TOLERANCE_MINOR) {", to: "if (false) {" },
  { name: "purchases with no stock entry are not reported", from: "if (measure.purchases > 0 && measure.stockEntries === 0) {", to: "if (false) {" },
];

async function main() {
  const enginePath = new URL("../src/services/audit-pack-engine/ratios.engine.js", import.meta.url);
  const engine = await import(enginePath.href);
  const checks = await runChecks(engine);
  checks.push(...mutantChecks(await runMutants({ enginePath, mutants: MUTANTS, runChecks: (m) => runChecks(m) })));

  const uri = process.env.MONGODB_URI || "";
  const scratch = /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(uri) && /scratch/i.test((uri.split("/").pop() || "").split("?")[0]);
  let note = "engine only (no scratch MONGODB_URI)";
  if (scratch) {
    const { runSnapshotPackFlow } = await import("./lib/snapshot-pack-routes.mjs");
    const typed = { amounts: Object.fromEntries(Object.entries(AMOUNTS).map(([k, v]) => [k, v])) };
    const decide = (row) => {
      // A ratio waiting for an amount the person has not got can only be left out, with the reason.
      if (row.state === "PENDING_INPUT") return { state: "EXCLUDED", reason: "The amount was not available when the pack was made" };
      if (row.values?.changeOver25) return { state: "CONFIRMED", choice: "REPORT_EXPLAINED", note: "Explained in the contract" };
      return row.choices?.options?.[0] ? { state: "CONFIRMED", choice: row.choices.options[0].value } : null;
    };
    const flowBase = { uri, label: "Ratios", kind: "SCHEDULE3_RATIOS", ledgers: ledgerDocs(CURRENT_LEDGERS), vouchers: currentVouchers().map(({ _id, ...v }) => v), priorSnapshot: { financialYear: "2024-25", ledgers: ledgerDocs(PRIOR_LEDGERS), vouchers: priorVouchers().map(({ _id, ...v }) => v) }, decide };
    checks.push(...(await runSnapshotPackFlow({
      ...flowBase,
      body: typed,
      expectedWorkbookSheets: ["For filing"],
      expect: async ({ run, section, call, A, snapshotId, priorSnapshotId, clientId, readWorkbookParts, runId }) => {
        const out = [];
        const c = (name, pass, detail = "") => out.push({ name, pass: Boolean(pass), detail });
        const ratios = section("RATIOS");
        c("the run names its two sections", run.sections.map((s) => s.code).join(",") === "RATIOS,INPUT_GAPS", run.sections.map((s) => s.code).join(","));
        c("eleven ratio rows and no gaps are read by section", ratios.length === 11 && section("INPUT_GAPS").length === 0, `${ratios.length}/${section("INPUT_GAPS").length}`);
        c("every ratio survives the database to the hundredth of a percent, this year and last", ratios.every((r) => EXPECTED[r.values.ratio]?.[0] === r.values.valueBp && EXPECTED[r.values.ratio]?.[1] === r.values.priorValueBp), JSON.stringify(ratios.map((r) => [r.values.ratio, r.values.valueBp, r.values.priorValueBp])));
        c("the typed amounts were stored with the run in paise and reproduce the ratios that need them", ratios.find((r) => r.values.ratio === "DEBT_SERVICE_COVERAGE")?.values.valueBp === 27838);
        c("a flagged row offers only the answer that needs a reason", ratios.find((r) => r.values.ratio === "DEBT_EQUITY")?.choices?.options?.map((o) => o.value).join(",") === "REPORT_EXPLAINED");
        const same = await call("POST", "/api/audit-packs", A.token, { kind: "SCHEDULE3_RATIOS", clientId: String(clientId), financialYear: "2025-26", snapshotId, priorSnapshotId: snapshotId });
        c("a prior-year snapshot that is the same export is refused", same.status === 400, `status ${same.status}`);
        const noPrior = await call("POST", "/api/audit-packs", A.token, { kind: "SCHEDULE3_RATIOS", clientId: String(clientId), financialYear: "2025-26", snapshotId });
        c("a request without the previous year's books is refused: the change test needs it", noPrior.status === 400, `status ${noPrior.status} ${JSON.stringify(noPrior.json)?.slice(0, 120)}`);
        for (const [what, amounts] of [["a float", { FINANCE_COSTS: { current: 1.5 } }], ["a negative on an unsigned row", { FINANCE_COSTS: { current: -5 } }], ["a row nobody asked for", { NOT_A_ROW: { current: 5 } }], ["a column nobody asked for", { FINANCE_COSTS: { next: 5 } }], ["a string", { FINANCE_COSTS: { current: "5" } }]]) {
          const refused = await call("POST", "/api/audit-packs", A.token, { kind: "SCHEDULE3_RATIOS", clientId: String(clientId), financialYear: "2025-26", snapshotId, priorSnapshotId, amounts });
          c(`typed amounts with ${what} are refused, not coerced`, refused.status === 400, `status ${refused.status} ${JSON.stringify(refused.json)?.slice(0, 120)}`);
        }
        const other = await call("POST", "/api/audit-packs", A.token, { kind: "SCHEDULE3_RATIOS", clientId: String(clientId), financialYear: "2025-26", snapshotId, priorSnapshotId, amounts: { ...typed.amounts, TAX_EXPENSE: { current: rupees(41000), prior: rupees(20000) } } });
        c("different typed amounts are a different request, not a replay of the first", other.status === 202 && other.json?.run?.id !== runId, `status ${other.status}`);
        void readWorkbookParts;
        return out;
      },
    })));
    // Without any typed amounts the same books leave three ratios pending and the pack provisional.
    checks.push(...(await runSnapshotPackFlow({
      ...flowBase,
      label: "Ratios bare",
      expect: async ({ section }) => {
        const out = [];
        const states = Object.fromEntries(section("RATIOS").map((r) => [r.values.ratio, r.state]));
        out.push({ name: "with no amounts typed the debt service, capital employed and investment ratios wait for them", pass: ["DEBT_SERVICE_COVERAGE", "RETURN_ON_CAPITAL_EMPLOYED", "RETURN_ON_INVESTMENT"].every((k) => states[k] === "PENDING_INPUT") && states.CURRENT_RATIO === "COMPUTED", detail: JSON.stringify(states) });
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
  console.log(`\nratios-contract: ${checks.length - failed}/${checks.length} passed (${note})`);
  process.exitCode = failed ? 1 : 0;
}

await main();
