// tests/lib/ratios-fixture.mjs
//
// W10 AP28 (2026-10-17): the two hand-worked years the ratios contract and the draft contract both stand on. The
// arithmetic behind every figure is in the header of tests/ratios-contract.mjs.

import { STANDARD_GROUPS } from "../../src/services/books/group-mapping.js";

export const rupees = (value) => Math.round(value * 100);

// ─── the books ─────────────────────────────────────────────────────────────

// [name, standard group, opening in rupees (credit +, debit -)]
export const CURRENT_LEDGERS = [
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

export const PRIOR_LEDGERS = CURRENT_LEDGERS.map(([name, group]) => [
  name,
  group,
  {
    Capital: 500000, "General Reserve": 100000, "Term Loan": 500000, "Bank OD": 60000, "Vendor A": 80000, "Outstanding Expenses": 25000,
    "GST Payable": 15000, Plant: -700000, "Mutual Fund": -150000, "Stock in Hand": -100000, "Customer X": -100000, Cash: -10000, "State Bank": -220000,
  }[name] ?? 0,
]);

let counter = 0;
// pairs: [ledger, signed rupees (Tally: debit negative, credit positive)]
export const voucher = (date, ...pairs) => ({ _id: `v${++counter}`, guid: `g${counter}`, alterId: counter, date, type: "Journal", number: String(counter), cancelled: false, optional: false, entries: pairs.map(([ledger, amount]) => ({ ledger, amountMinor: rupees(amount) })), bills: [], banks: [], warnings: [] });

export function currentVouchers() {
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

export function priorVouchers() {
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

export const ledgerDocs = (rows) => rows.map(([name, group, open], i) => ({ name, standardGroup: group, parent: STANDARD_GROUPS[group].label, openingMinor: open === 0 ? null : rupees(open), alterId: 100 + i }));

export const AMOUNTS = {
  FINANCE_COSTS: { current: rupees(48000), prior: rupees(60000) },
  DEPRECIATION: { current: rupees(60000), prior: rupees(70000) },
  PRINCIPAL_REPAID: { current: rupees(100000), prior: rupees(50000) },
  TAX_EXPENSE: { current: rupees(40000), prior: rupees(20000) },
  INVESTMENT_INCOME: { current: rupees(12000), prior: rupees(9000) },
};

// Expected ratios in hundredths of a percent of the ratio itself (ratio x 10,000), rounded half away from zero.
export const EXPECTED = {
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

