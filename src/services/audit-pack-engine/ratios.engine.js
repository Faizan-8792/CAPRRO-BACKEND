// src/services/audit-pack-engine/ratios.engine.js
//
// W10 AP28 (2026-10-17). The eleven ratios Schedule III (Division I, the note on additional regulatory information)
// asks a company to disclose, worked out from the Tally books of the year and of the year before, with the figures
// that went into each and the 25% change test.
//
// WHAT IS DISCLOSED. Every row shows its numerator and denominator in paise as they were read, for this year and
// the year before, the averaging it used, and the Tally groups the figures came from. Nothing is hidden in a
// ratio: a person can redo each by hand from the lines.
//
// WHAT THE BOOKS CANNOT SAY, AND THE ROW SAYS. Finance costs, depreciation, the principal repaid, tax, income from
// investments and the like are not groups in Tally; they are typed by the person (the pack's amounts input), one
// column for each year. A figure a ratio cannot be worked without and that was not typed makes that row PENDING_INPUT
// naming it - never nil. A figure a ratio can be worked without in the ordinary case (preference dividend, exceptional
// items, current maturities, deferred tax, intangibles) that was not typed is read as nil, and the row says so.
// A ratio whose denominator is nil is "not applicable", never a division by zero and never 0.
//
// THE 25% TEST is exact: the two ratios are kept as fractions of paise and compared without rounding, so a change of
// 25.001% is over and 25.000% is not. The percentage shown is rounded to two decimals; the test is not.
//
// CONVENTIONS (shown on the rows; a different convention is a different pack version):
//   current assets      Tally's Stock-in-hand, Sundry Debtors, Cash, Bank, Current Assets, Deposits and Loans & Advances
//   current liabilities Sundry Creditors, Current Liabilities, Duties & Taxes, Provisions, Bank OD, + current maturities
//   total debt          Loans (liability), Secured and Unsecured Loans, Bank OD
//   equity              Capital Account + Reserves & Surplus + the year's profit (Tally does not close the profit
//                       and loss account by a voucher)
//   net sales           Sales Accounts + Direct Incomes, net of the debits in them (returns)
//   cost of goods sold  opening stock + purchases + direct expenses - closing stock
//   credit sales        each sales voucher's net sales x the debtor ledgers' share of that voucher's debit side
//   credit purchases    each purchase voucher's net purchases x the creditor ledgers' share of its credit side
//   averages            (opening + closing) / 2, simple; the opening is the ledger opening balance, the closing is
//                       opening + the year's movement
// Balances are netted within a group as the books carry them (a credit balance in a debtor ledger reduces the
// debtors). Suspense and branch balances are left out and named.
//
// PURE: no I/O. A measurement is built one voucher at a time so a large day book is never held in memory.

import { choice, dateInYear, hit, norm, rowFactory } from "../audit-pack-kinds/kit.js";
import { STANDARD_GROUPS } from "../books/group-mapping.js";
import { formatRupees } from "./clause21d.engine.js";
import { indexLedgers, ledgerSource } from "./voucher-kit.js";

export const RATIOS_RULE_VERSION = "ratios-v1";

/** A change above this many hundredths of a percent (25.00%) needs a reason. Fixed by the rule version. */
export const CHANGE_THRESHOLD_BP = 2_500;

/** The most ledgers a ratio row lists as its evidence. */
const MAX_EVIDENCE_LEDGERS = 2_000;

/** A trial balance out by this much or more (Rs 1) is reported. */
const BALANCE_TOLERANCE_MINOR = 100;

const makeRow = rowFactory(RATIOS_RULE_VERSION, "Ratios");

export const AMOUNT_COLUMNS = Object.freeze([
  { key: "current", label: "This year" },
  { key: "prior", label: "Previous year" },
]);

export const AMOUNT_ROWS = Object.freeze([
  { key: "FINANCE_COSTS", label: "Finance costs", help: "Interest and other borrowing costs charged to the profit and loss account, including interest on lease liabilities. Needed for the debt service and capital employed ratios.", signed: false },
  { key: "DEPRECIATION", label: "Depreciation and amortisation", help: "Charged to the profit and loss account in the year. Needed for the debt service coverage ratio.", signed: false },
  { key: "PRINCIPAL_REPAID", label: "Principal repaid on borrowings and leases", help: "Repaid in the year. Needed for the debt service coverage ratio.", signed: false },
  { key: "TAX_EXPENSE", label: "Income tax and deferred tax charged", help: "Charged to the profit and loss account in the year. Needed for the return on capital employed.", signed: false },
  { key: "INVESTMENT_INCOME", label: "Income from investments", help: "Dividend, interest and gains on treasury investments. Needed for the return on investment where the books show investments.", signed: false },
  { key: "OTHER_NON_CASH", label: "Other non-cash items to add back", help: "Impairment, loss on sale of assets and similar charges (a gain is negative). Optional; if left blank it is read as nil.", signed: true },
  { key: "EXCEPTIONAL_ITEMS", label: "Exceptional items", help: "A gain positive, a loss negative. Optional; if left blank it is read as nil.", signed: true },
  { key: "PREFERENCE_DIVIDEND", label: "Preference dividend", help: "For the return on equity. Optional; if left blank it is read as nil.", signed: false },
  { key: "CURRENT_MATURITIES", label: "Current maturities of long-term borrowings", help: "Due within twelve months at the year end. The books carry all loans together, so without this they are all non-current. Optional; if left blank it is read as nil.", signed: false },
  { key: "DEFERRED_TAX_LIABILITY", label: "Deferred tax liability", help: "At the year end, for capital employed. Optional; if left blank it is read as nil.", signed: false },
  { key: "INTANGIBLES", label: "Intangible assets", help: "At the year end, including those under development, taken off capital employed. Optional; if left blank it is read as nil.", signed: false },
]);

const AMOUNT_LABEL = Object.freeze(Object.fromEntries(AMOUNT_ROWS.map((r) => [r.key, r.label])));

export const CHOICES = Object.freeze({
  REPORT: choice("REPORT", "Include in the ratio schedule"),
  REPORT_EXPLAINED: choice("REPORT_EXPLAINED", "Include, with the reason for the change", { needsNote: true }),
  NOT_APPLICABLE: choice("NOT_APPLICABLE", "Show as not applicable"),
});

// ─── groups ────────────────────────────────────────────────────────────────

const GROUPS = Object.freeze({
  CURRENT_ASSETS: ["STOCK", "SUNDRY_DEBTORS", "CASH", "BANK", "CURRENT_ASSETS", "DEPOSITS_ASSET", "LOANS_ADVANCES_ASSET"],
  CURRENT_LIABILITIES: ["SUNDRY_CREDITORS", "CURRENT_LIABILITIES", "DUTIES_TAXES", "PROVISIONS", "BANK_OD"],
  DEBT: ["LOANS_LIABILITY", "LOANS_SECURED", "LOANS_UNSECURED", "BANK_OD"],
  EQUITY: ["CAPITAL_ACCOUNT", "RESERVES_SURPLUS"],
  INVESTMENTS: ["INVESTMENTS"],
  STOCK: ["STOCK"],
  DEBTORS: ["SUNDRY_DEBTORS"],
  CREDITORS: ["SUNDRY_CREDITORS"],
  REVENUE: ["SALES", "DIRECT_INCOMES"],
  OTHER_INCOME: ["INDIRECT_INCOMES"],
  PURCHASES: ["PURCHASE"],
  DIRECT_EXPENSES: ["DIRECT_EXPENSES"],
  INDIRECT_EXPENSES: ["INDIRECT_EXPENSES"],
});

const PL_GROUPS = ["SALES", "DIRECT_INCOMES", "INDIRECT_INCOMES", "PURCHASE", "DIRECT_EXPENSES", "INDIRECT_EXPENSES"];
const PROFIT_AND_LOSS = new Set(Object.values(STANDARD_GROUPS).filter((g) => g.statement === "PROFIT_AND_LOSS").map((g) => g.code));
const LEFT_OUT = new Set(["SUSPENSE", "BRANCH_DIVISIONS"]);

/** The balance in the group's own direction: an asset or an expense is positive when it is a debit. */
function natural(code, tallySigned) {
  const nature = STANDARD_GROUPS[code]?.nature;
  return nature === "ASSET" || nature === "EXPENSE" ? -tallySigned : tallySigned;
}

const add = (a, b, what) => {
  const total = a + b;
  if (!Number.isSafeInteger(total)) throw new RangeError(`${what} is too large to hold exactly`);
  return total;
};

// ─── exact arithmetic ──────────────────────────────────────────────────────

const roundDiv = (n, d) => {
  const negative = n < 0n;
  const a = negative ? -n : n;
  const q = (2n * a + d) / (2n * d);
  return negative ? -q : q;
};

/** A fraction with a positive denominator, or null when the denominator is nil. */
function fraction(n, d) {
  if (d === 0n) return null;
  return d < 0n ? { n: -n, d: -d } : { n, d };
}

export const valueBpOf = (f) => Number(roundDiv(f.n * 10_000n, f.d));

/** The change from `before` to `after` in hundredths of a percent, and whether it is over the threshold. Exact. */
export function changeOf(after, before) {
  if (!after || !before || before.n === 0n) return null;
  const diff = after.n * before.d - before.n * after.d;
  const scale = after.d * (before.n < 0n ? -before.n : before.n);
  const absDiff = diff < 0n ? -diff : diff;
  return {
    changeBp: Number(roundDiv(diff * 10_000n, scale)),
    over: absDiff * 10_000n > BigInt(CHANGE_THRESHOLD_BP) * scale,
  };
}

const twoDecimals = (hundredths) => {
  const negative = hundredths < 0;
  const abs = Math.abs(hundredths);
  return `${negative ? "-" : ""}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
};

export function formatRatio(valueBp, unit) {
  if (!Number.isSafeInteger(valueBp)) return "Not available";
  if (unit === "PERCENT") return `${twoDecimals(valueBp)}%`;
  return `${twoDecimals(Number(roundDiv(BigInt(valueBp), 100n)))} times`;
}

export const formatChange = (changeBp) => `${changeBp > 0 ? "+" : ""}${twoDecimals(changeBp)}%`;

function share(total, part, whole) {
  if (whole === 0 || part === 0) return 0;
  return Number(roundDiv(BigInt(total) * BigInt(part), BigInt(whole)));
}

// ─── measuring a year ──────────────────────────────────────────────────────

/**
 * One year's figures from a snapshot's ledgers and its day book, voucher by voucher.
 *
 *   const m = createMeasure({ financialYear, ledgers }); for await (const v of vouchers) m.add(v); m.finish()
 */
export function createMeasure({ financialYear, ledgers }) {
  const index = indexLedgers(ledgers);
  const opening = new Map();
  const movement = new Map();
  let balance = 0;
  let unreadable = 0;
  let stockEntries = 0;
  let creditSales = 0;
  let creditPurchases = 0;
  let netSales = 0;
  let operatingPurchases = 0;
  let operatingDirect = 0;
  let stockAdditions = 0;
  const purchasesByLedger = new Map();

  for (const ledger of ledgers) {
    const code = ledger.standardGroup;
    const open = Number.isSafeInteger(ledger.openingMinor) ? ledger.openingMinor : 0;
    balance = add(balance, open, "the trial balance");
    if (!code || PROFIT_AND_LOSS.has(code)) continue;
    opening.set(code, add(opening.get(code) || 0, natural(code, open), `the ${code} opening`));
  }

  return {
    add(voucher) {
      if (voucher.cancelled || voucher.optional) return;
      if (!voucher.date) {
        unreadable += 1;
        return;
      }
      if (!dateInYear(voucher.date, financialYear)) return;
      const entries = voucher.entries || [];
      if (entries.some((e) => !Number.isSafeInteger(e.amountMinor) || !index.has(norm(e.ledger)))) {
        unreadable += 1;
        return;
      }

      // A voucher between a Stock-in-hand ledger and a profit and loss ledger is a stock valuation journal: its
      // profit and loss leg (a "closing stock" credit, wherever the books put it) is the stock moving, not a sale, a
      // purchase or a direct expense, so it stays out of those and the closing stock enters cost of goods sold once.
      // A voucher between a Stock-in-hand ledger and a balance sheet ledger (a creditor, cash) is a purchase booked
      // through the stock account.
      const groupOf = (entry) => index.get(norm(entry.ledger)).standardGroup;
      const touchesStock = entries.some((e) => groupOf(e) === "STOCK");
      const touchesProfitAndLoss = entries.some((e) => PROFIT_AND_LOSS.has(groupOf(e)));
      const valuation = touchesStock && touchesProfitAndLoss;

      let sales = 0;
      let purchases = 0;
      let direct = 0;
      let stockMoved = 0;
      let debits = 0;
      let credits = 0;
      let debtorDebits = 0;
      let debtorCredits = 0;
      let creditorDebits = 0;
      let creditorCredits = 0;
      for (const entry of entries) {
        const ledger = index.get(norm(entry.ledger));
        const code = ledger.standardGroup;
        const amount = entry.amountMinor;
        balance = add(balance, amount, "the trial balance");
        if (amount < 0) debits += -amount;
        else credits += amount;
        if (!code) continue;
        movement.set(code, add(movement.get(code) || 0, natural(code, amount), `the ${code} movement`));
        if (code === "STOCK") {
          stockEntries += 1;
          stockMoved += natural(code, amount);
        }
        if (valuation) continue;
        if (GROUPS.REVENUE.includes(code)) sales += amount;
        if (code === "PURCHASE") {
          purchases += -amount;
          purchasesByLedger.set(norm(ledger.name), ledger);
        }
        if (code === "DIRECT_EXPENSES") direct += -amount;
        if (code === "SUNDRY_DEBTORS") (amount < 0 ? (debtorDebits += -amount) : (debtorCredits += amount));
        if (code === "SUNDRY_CREDITORS") (amount < 0 ? (creditorDebits += -amount) : (creditorCredits += amount));
      }
      netSales = add(netSales, sales, "net sales");
      operatingPurchases = add(operatingPurchases, purchases, "purchases");
      operatingDirect = add(operatingDirect, direct, "direct expenses");
      if (touchesStock && !touchesProfitAndLoss) stockAdditions = add(stockAdditions, stockMoved, "stock bought through the stock account");
      if (sales > 0) creditSales = add(creditSales, share(sales, debtorDebits, debits), "credit sales");
      else if (sales < 0) creditSales = add(creditSales, share(sales, debtorCredits, credits), "credit sales");
      if (purchases > 0) creditPurchases = add(creditPurchases, share(purchases, creditorCredits, credits), "credit purchases");
      else if (purchases < 0) creditPurchases = add(creditPurchases, share(purchases, creditorDebits, debits), "credit purchases");
    },

    finish() {
      const sum = (map, codes) => codes.reduce((t, code) => add(t, map.get(code) || 0, "a group total"), 0);
      const open = (codes) => sum(opening, codes);
      const close = (codes) => add(open(codes), sum(movement, codes), "a group closing");
      const move = (codes) => sum(movement, codes);
      const income = add(move(GROUPS.REVENUE), move(GROUPS.OTHER_INCOME), "income");
      const expense = add(add(move(GROUPS.PURCHASES), move(GROUPS.DIRECT_EXPENSES), "expense"), move(GROUPS.INDIRECT_EXPENSES), "expense");
      const netProfit = add(income, -expense, "the profit");
      const leftOut = [...LEFT_OUT]
        .map((code) => ({ code, label: STANDARD_GROUPS[code].label, minor: close([code]) }))
        .filter((g) => g.minor !== 0);
      return {
        financialYear,
        netSales,
        netProfit,
        totalIncome: income,
        debtOpening: open(GROUPS.DEBT),
        capitalClosing: close(["CAPITAL_ACCOUNT"]),
        reservesClosing: close(["RESERVES_SURPLUS"]),
        purchases: operatingPurchases,
        directExpenses: operatingDirect,
        stockAdditions,
        creditSales,
        creditPurchases,
        currentAssets: close(GROUPS.CURRENT_ASSETS),
        currentLiabilities: close(GROUPS.CURRENT_LIABILITIES),
        debt: close(GROUPS.DEBT),
        equityOpening: open(GROUPS.EQUITY),
        equityClosing: add(close(GROUPS.EQUITY), netProfit, "equity"),
        stockOpening: open(GROUPS.STOCK),
        stockClosing: close(GROUPS.STOCK),
        debtorsOpening: open(GROUPS.DEBTORS),
        debtorsClosing: close(GROUPS.DEBTORS),
        creditorsOpening: open(GROUPS.CREDITORS),
        creditorsClosing: close(GROUPS.CREDITORS),
        investmentsOpening: open(GROUPS.INVESTMENTS),
        investmentsClosing: close(GROUPS.INVESTMENTS),
        stockEntries,
        unreadable,
        balanceMinor: balance,
        leftOut,
        ledgers,
        purchaseLedgers: [...purchasesByLedger.values()],
      };
    },
  };
}

/** Convenience for a day book already in memory (the tests, small books). */
export function measureVouchers({ financialYear, ledgers, vouchers }) {
  const measure = createMeasure({ financialYear, ledgers });
  for (const voucher of vouchers) measure.add(voucher);
  return measure.finish();
}

// ─── the eleven ratios ─────────────────────────────────────────────────────

const sum = (...parts) => parts.reduce((t, p) => add(t, p, "a ratio part"), 0);
const part = (label, minor) => ({ label, minor });

const CONVENTION = Object.freeze({
  CURRENT_ASSETS: "Current assets are Tally's Stock-in-hand, Sundry Debtors, Cash-in-hand, Bank Accounts and Current Assets (with the Deposits and Loans & Advances under it), as Tally classifies them. Balances are netted within each group as the books carry them.",
  CURRENT_LIABILITIES: "Current liabilities are Sundry Creditors, Current Liabilities, Duties & Taxes, Provisions and Bank OD, plus the current maturities of long-term borrowings if you typed them (the books carry all loans together, so otherwise every loan is non-current).",
  DEBT: "Total debt is Loans (Liability), Secured Loans, Unsecured Loans and Bank OD, whether due now or later. Lease liabilities are in it only if the books carry them under those groups.",
  EQUITY: "Shareholders' equity is Capital Account plus Reserves & Surplus plus the profit of the year (Tally does not close the profit and loss account by a voucher). Miscellaneous expenses (asset) not yet written off are not deducted.",
  AVERAGE: "An average is the simple average of the opening and the closing balance. The opening is the ledgers' opening balance; the closing is the opening plus the year's movement.",
  NET_SALES: "Net sales are Sales Accounts plus Direct Incomes, net of the debits in them (returns).",
  CREDIT_SALES: "Credit sales are each sales voucher's net sales multiplied by the debtor ledgers' share of that voucher's debit side, so a part-cash sale counts only for the part billed to a debtor.",
  CREDIT_PURCHASES: "Credit purchases are each purchase voucher's net purchases multiplied by the creditor ledgers' share of that voucher's credit side.",
  COGS: "Cost of goods sold is opening stock plus purchases plus direct expenses less closing stock, with the stock as the Stock-in-hand ledgers carry it. A voucher between a Stock-in-hand ledger and a profit and loss ledger is read as a stock valuation journal: its profit and loss leg, wherever the books put it, is not counted as a purchase, a direct expense or a sale, so the closing stock enters once. A voucher between a Stock-in-hand ledger and a balance sheet ledger is read as a purchase.",
  PROFIT: "Net profit is all income less all expense ledgers of the year, so it is after whatever tax the books provide for.",
  CAPITAL_EMPLOYED: "Capital employed is equity (less intangible assets) plus total debt plus deferred tax liability, at the year end.",
});

/**
 * Each spec turns one year's measurement into numerator and denominator. `ask.need` is an amount the ratio cannot be
 * worked without; `ask.optional` is one it can, read as nil when not typed.
 */
const SPECS = Object.freeze([
  {
    code: "CURRENT_RATIO", letter: "a", label: "Current ratio", unit: "TIMES", formula: "Current assets / Current liabilities",
    groups: [...GROUPS.CURRENT_ASSETS, ...GROUPS.CURRENT_LIABILITIES],
    conventions: [CONVENTION.CURRENT_ASSETS, CONVENTION.CURRENT_LIABILITIES],
    build: (y, ask) => {
      const maturities = ask.optional("CURRENT_MATURITIES");
      const liabilities = sum(y.currentLiabilities, maturities);
      return {
        numerator: { label: "Current assets", minor: y.currentAssets, parts: [] },
        denominator: { label: "Current liabilities", minor: liabilities, parts: maturities ? [part("Current liabilities in the books", y.currentLiabilities), part("Current maturities of long-term borrowings", maturities)] : [] },
      };
    },
  },
  {
    code: "DEBT_EQUITY", letter: "b", label: "Debt-equity ratio", unit: "TIMES", formula: "Total debt / Shareholders' equity",
    groups: [...GROUPS.DEBT, ...GROUPS.EQUITY],
    conventions: [CONVENTION.DEBT, CONVENTION.EQUITY],
    build: (y) => ({
      numerator: { label: "Total debt", minor: y.debt, parts: [] },
      denominator: { label: "Shareholders' equity", minor: y.equityClosing, parts: [] },
    }),
  },
  {
    code: "DEBT_SERVICE_COVERAGE", letter: "c", label: "Debt service coverage ratio", unit: "TIMES", formula: "Earnings available for debt service / Debt service",
    groups: PL_GROUPS,
    conventions: [CONVENTION.PROFIT, "Earnings available for debt service are net profit after tax plus depreciation and amortisation, finance costs and other non-cash items. Debt service is finance costs plus the principal repaid in the year. The amounts you typed are used for the items the books do not group."],
    build: (y, ask) => {
      const finance = ask.need("FINANCE_COSTS");
      const depreciation = ask.need("DEPRECIATION");
      const principal = ask.need("PRINCIPAL_REPAID");
      const other = ask.optional("OTHER_NON_CASH");
      return {
        numerator: { label: "Earnings available for debt service", minor: sum(y.netProfit, depreciation, finance, other), parts: [part("Net profit after tax", y.netProfit), part("Depreciation and amortisation", depreciation), part("Finance costs", finance), part("Other non-cash items", other)] },
        denominator: { label: "Debt service", minor: sum(finance, principal), parts: [part("Finance costs", finance), part("Principal repaid", principal)] },
      };
    },
  },
  {
    code: "RETURN_ON_EQUITY", letter: "d", label: "Return on equity ratio", unit: "PERCENT", formula: "(Net profit after tax - Preference dividend) / Average shareholders' equity",
    groups: [...GROUPS.EQUITY, ...PL_GROUPS],
    conventions: [CONVENTION.PROFIT, CONVENTION.EQUITY, CONVENTION.AVERAGE],
    build: (y, ask) => {
      const preference = ask.optional("PREFERENCE_DIVIDEND");
      return {
        numerator: { label: "Net profit after tax less preference dividend", minor: sum(y.netProfit, -preference), parts: [part("Net profit after tax", y.netProfit), part("Preference dividend", -preference)] },
        denominator: { label: "Average shareholders' equity", average: { openingMinor: y.equityOpening, closingMinor: y.equityClosing } },
      };
    },
  },
  {
    code: "INVENTORY_TURNOVER", letter: "e", label: "Inventory turnover ratio", unit: "TIMES", formula: "Cost of goods sold / Average inventory",
    groups: [...GROUPS.STOCK, ...GROUPS.PURCHASES, ...GROUPS.DIRECT_EXPENSES],
    conventions: [CONVENTION.COGS, CONVENTION.AVERAGE],
    build: (y) => ({
      numerator: { label: "Cost of goods sold", minor: sum(y.stockOpening, y.purchases, y.directExpenses, y.stockAdditions, -y.stockClosing), parts: [part("Opening stock", y.stockOpening), part("Purchases", y.purchases), part("Direct expenses", y.directExpenses), part("Stock bought through the stock account", y.stockAdditions), part("Closing stock", -y.stockClosing)] },
      denominator: { label: "Average inventory", average: { openingMinor: y.stockOpening, closingMinor: y.stockClosing } },
    }),
  },
  {
    code: "RECEIVABLES_TURNOVER", letter: "f", label: "Trade receivables turnover ratio", unit: "TIMES", formula: "Net credit sales / Average trade receivables",
    groups: [...GROUPS.DEBTORS, ...GROUPS.REVENUE],
    conventions: [CONVENTION.CREDIT_SALES, CONVENTION.AVERAGE],
    build: (y) => ({
      numerator: { label: "Net credit sales", minor: y.creditSales, parts: [] },
      denominator: { label: "Average trade receivables", average: { openingMinor: y.debtorsOpening, closingMinor: y.debtorsClosing } },
    }),
  },
  {
    code: "PAYABLES_TURNOVER", letter: "g", label: "Trade payables turnover ratio", unit: "TIMES", formula: "Net credit purchases / Average trade payables",
    groups: [...GROUPS.CREDITORS, ...GROUPS.PURCHASES],
    conventions: [CONVENTION.CREDIT_PURCHASES, CONVENTION.AVERAGE],
    build: (y) => ({
      numerator: { label: "Net credit purchases", minor: y.creditPurchases, parts: [] },
      denominator: { label: "Average trade payables", average: { openingMinor: y.creditorsOpening, closingMinor: y.creditorsClosing } },
    }),
  },
  {
    code: "NET_CAPITAL_TURNOVER", letter: "h", label: "Net capital turnover ratio", unit: "TIMES", formula: "Net sales / Working capital",
    groups: [...GROUPS.CURRENT_ASSETS, ...GROUPS.CURRENT_LIABILITIES, ...GROUPS.REVENUE],
    conventions: [CONVENTION.NET_SALES, "Working capital is current assets less current liabilities, at the year end.", CONVENTION.CURRENT_ASSETS, CONVENTION.CURRENT_LIABILITIES],
    build: (y, ask) => {
      const maturities = ask.optional("CURRENT_MATURITIES");
      const liabilities = sum(y.currentLiabilities, maturities);
      return {
        numerator: { label: "Net sales", minor: y.netSales, parts: [] },
        denominator: { label: "Working capital", minor: sum(y.currentAssets, -liabilities), parts: [part("Current assets", y.currentAssets), part("Current liabilities", -liabilities)] },
      };
    },
  },
  {
    code: "NET_PROFIT_RATIO", letter: "i", label: "Net profit ratio", unit: "PERCENT", formula: "Net profit / Net sales",
    groups: PL_GROUPS,
    conventions: [CONVENTION.PROFIT, CONVENTION.NET_SALES],
    build: (y) => ({
      numerator: { label: "Net profit", minor: y.netProfit, parts: [] },
      denominator: { label: "Net sales", minor: y.netSales, parts: [] },
    }),
  },
  {
    code: "RETURN_ON_CAPITAL_EMPLOYED", letter: "j", label: "Return on capital employed", unit: "PERCENT", formula: "Earnings before interest and tax / Capital employed",
    groups: [...GROUPS.EQUITY, ...GROUPS.DEBT, ...PL_GROUPS],
    conventions: [CONVENTION.PROFIT, CONVENTION.CAPITAL_EMPLOYED, "Earnings before interest and tax are net profit plus tax plus finance costs, without exceptional items."],
    build: (y, ask) => {
      const finance = ask.need("FINANCE_COSTS");
      const tax = ask.need("TAX_EXPENSE");
      const exceptional = ask.optional("EXCEPTIONAL_ITEMS");
      const deferred = ask.optional("DEFERRED_TAX_LIABILITY");
      const intangibles = ask.optional("INTANGIBLES");
      return {
        numerator: { label: "Earnings before interest and tax", minor: sum(y.netProfit, tax, finance, -exceptional), parts: [part("Net profit after tax", y.netProfit), part("Tax", tax), part("Finance costs", finance), part("Exceptional items taken out", -exceptional)] },
        denominator: { label: "Capital employed", minor: sum(y.equityClosing, -intangibles, y.debt, deferred), parts: [part("Shareholders' equity", y.equityClosing), part("Intangible assets", -intangibles), part("Total debt", y.debt), part("Deferred tax liability", deferred)] },
      };
    },
  },
  {
    code: "RETURN_ON_INVESTMENT", letter: "k", label: "Return on investment", unit: "PERCENT", formula: "Income from investments / Average invested funds",
    groups: [...GROUPS.INVESTMENTS],
    conventions: ["Invested funds are the Investments group of the books, at cost as the ledgers carry it.", CONVENTION.AVERAGE],
    build: (y, ask) => {
      const invested = { openingMinor: y.investmentsOpening, closingMinor: y.investmentsClosing };
      const anyInvestments = invested.openingMinor !== 0 || invested.closingMinor !== 0;
      return {
        numerator: { label: "Income from investments", minor: anyInvestments ? ask.need("INVESTMENT_INCOME") : 0, parts: [] },
        denominator: { label: "Average invested funds", average: invested },
      };
    },
  },
]);

export const RATIO_CODES = Object.freeze(SPECS.map((s) => s.code));
export const SPECS_BY_CODE = Object.freeze(Object.fromEntries(SPECS.map((s) => [s.code, s])));

/** Works one ratio for one year. status: OK | MISSING | NOT_APPLICABLE. */
export function evaluateRatio(spec, measure, typed, columnKey) {
  const missing = [];
  const assumptions = [];
  const ask = {
    need(key) {
      const value = typed?.[key]?.[columnKey];
      if (value === undefined) {
        missing.push(AMOUNT_LABEL[key]);
        return 0;
      }
      return value;
    },
    optional(key) {
      const value = typed?.[key]?.[columnKey];
      if (value === undefined) {
        assumptions.push(`${AMOUNT_LABEL[key]} was not typed for ${columnKey === "current" ? "this year" : "the previous year"} and is read as nil.`);
        return 0;
      }
      return value;
    },
  };
  const figures = spec.build(measure, ask);
  const average = figures.denominator.average;
  if (missing.length) return { status: "MISSING", missing: [...new Set(missing)], assumptions, figures };
  const denominatorMinor = average ? sum(average.openingMinor, average.closingMinor) : figures.denominator.minor;
  const f = fraction(average ? BigInt(figures.numerator.minor) * 2n : BigInt(figures.numerator.minor), BigInt(denominatorMinor));
  if (!f) return { status: "NOT_APPLICABLE", assumptions, figures, missing: [] };
  return { status: "OK", fraction: f, valueBp: valueBpOf(f), assumptions, figures, missing: [] };
}

// ─── rows ──────────────────────────────────────────────────────────────────

const averageMinor = (a) => Number(roundDiv(BigInt(a.openingMinor) + BigInt(a.closingMinor), 2n));

function ledgersIn(measure, codes) {
  const wanted = new Set(codes);
  return measure.ledgers.filter((l) => wanted.has(l.standardGroup));
}

function partLines(year, figures) {
  const lines = [];
  const side = (sideName, f) => {
    if (f.average) {
      lines.push({ label: `${year}: ${f.label} - opening`, value: f.average.openingMinor, kind: "money" });
      lines.push({ label: `${year}: ${f.label} - closing`, value: f.average.closingMinor, kind: "money" });
      lines.push({ label: `${year}: ${f.label} (average, to the paisa)`, value: averageMinor(f.average), kind: "money" });
      return;
    }
    for (const p of f.parts || []) if (p.minor !== 0) lines.push({ label: `${year}: ${p.label}`, value: p.minor, kind: "money" });
    lines.push({ label: `${year}: ${f.label}`, value: f.minor, kind: "money" });
  };
  side("numerator", figures.numerator);
  side("denominator", figures.denominator);
  return lines;
}

function ratioRow({ spec, snapshotId, current, prior, currentEval, priorEval, yearLabels }) {
  const change = currentEval.status === "OK" && priorEval.status === "OK" ? changeOf(currentEval.fraction, priorEval.fraction) : null;
  const over = change ? change.over : null;

  const lines = [];
  lines.push({ label: `${spec.label} - ${yearLabels.current}`, value: currentEval.status === "OK" ? formatRatio(currentEval.valueBp, spec.unit) : currentEval.status === "NOT_APPLICABLE" ? "Not applicable" : "Not available - an input is missing", kind: "text" });
  lines.push({ label: `${spec.label} - ${yearLabels.prior}`, value: priorEval.status === "OK" ? formatRatio(priorEval.valueBp, spec.unit) : priorEval.status === "NOT_APPLICABLE" ? "Not applicable" : "Not available - an input is missing", kind: "text" });
  if (change) {
    lines.push({ label: "Change", value: formatChange(change.changeBp), kind: "text" });
    lines.push({ label: "Change above 25%", value: over ? "Yes - give the reason" : "No", kind: "text" });
  }
  // A year with a missing input has no figures to show: the parts were read as nil to get this far and would mislead.
  if (currentEval.status !== "MISSING") lines.push(...partLines(yearLabels.current, currentEval.figures));
  if (priorEval.status !== "MISSING") lines.push(...partLines(yearLabels.prior, priorEval.figures));

  const ruleHits = [hit("FORMULA", `${spec.label} = ${spec.formula}.`)];
  for (const text of spec.conventions) ruleHits.push(hit("CONVENTION", text));
  for (const text of [...new Set([...currentEval.assumptions, ...priorEval.assumptions])]) ruleHits.push(hit("INPUT_READ_AS_NIL", text));

  let state = "COMPUTED";
  let choices;
  if (currentEval.status === "MISSING") {
    state = "PENDING_INPUT";
    choices = [];
    ruleHits.push(hit("INPUT_MISSING", `This ratio cannot be worked out until you type, for ${yearLabels.current}: ${currentEval.missing.join("; ")}. Create the pack again with those amounts, or exclude the row with a reason.`));
  } else if (currentEval.status === "NOT_APPLICABLE") {
    choices = [CHOICES.NOT_APPLICABLE];
    ruleHits.push(hit("DENOMINATOR_NIL", `The denominator (${currentEval.figures.denominator.label}) is nil for ${yearLabels.current}, so the ratio has no value. It is shown as not applicable, never as nil.`));
  } else if (over === true) {
    choices = [CHOICES.REPORT_EXPLAINED];
    ruleHits.push(hit("CHANGE_OVER_25", `The ratio changed by ${formatChange(change.changeBp)} from the previous year, which is more than 25%. Schedule III asks for the reason; write it in the note.`, CHANGE_THRESHOLD_BP));
  } else if (over === false) {
    choices = [CHOICES.REPORT];
  } else {
    choices = [CHOICES.REPORT, CHOICES.REPORT_EXPLAINED];
    const why = priorEval.status === "MISSING" ? `an amount is missing for ${yearLabels.prior}: ${priorEval.missing.join("; ")}` : priorEval.status === "NOT_APPLICABLE" ? `its denominator is nil for ${yearLabels.prior}` : "the previous year's ratio is nil";
    ruleHits.push(hit("CHANGE_NOT_KNOWN", `The change from the previous year cannot be tested because ${why}. If it was more than 25%, give the reason in the note.`));
  }

  const sources = ledgersIn(current, spec.groups).slice(0, MAX_EVIDENCE_LEDGERS).map((l) => ledgerSource(snapshotId, l));
  return makeRow({
    section: "RATIOS",
    identity: `ratio|${spec.code}`,
    label: `(${spec.letter}) ${spec.label}`,
    values: {
      ratio: spec.code,
      unit: spec.unit,
      formula: spec.formula,
      valueBp: currentEval.status === "OK" ? currentEval.valueBp : null,
      priorValueBp: priorEval.status === "OK" ? priorEval.valueBp : null,
      changeBp: change ? change.changeBp : null,
      changeOver25: over,
      numeratorLabel: currentEval.figures.numerator.label,
      denominatorLabel: currentEval.figures.denominator.label,
      numeratorMinor: currentEval.status === "MISSING" ? null : currentEval.figures.numerator.minor,
      denominatorMinor: currentEval.status === "MISSING" ? null : currentEval.figures.denominator.average ? averageMinor(currentEval.figures.denominator.average) : currentEval.figures.denominator.minor,
      priorNumeratorMinor: priorEval.status === "MISSING" ? null : priorEval.figures.numerator.minor,
      priorDenominatorMinor: priorEval.status === "MISSING" ? null : priorEval.figures.denominator.average ? averageMinor(priorEval.figures.denominator.average) : priorEval.figures.denominator.minor,
      averaged: Boolean(currentEval.figures.denominator.average),
      amountMinor: null,
      lines,
      choices,
    },
    ruleHits,
    state,
    sources: sources.length ? sources : current.ledgers.slice(0, 1).map((l) => ledgerSource(snapshotId, l)),
  });
}

function gapRows({ snapshotId, year, measure }) {
  const rows = [];
  const unmapped = measure.ledgers.filter((l) => !l.standardGroup);
  if (unmapped.length) {
    rows.push(makeRow({
      section: "INPUT_GAPS",
      identity: `unmapped-groups|${year}`,
      label: `${year}: ${unmapped.length} ledger(s) sit under a group that is not mapped yet`,
      values: { count: unmapped.length, amountMinor: null, lines: [{ label: "Ledgers whose group is not read", value: String(unmapped.length), kind: "text" }], choices: [] },
      ruleHits: [hit("GROUPS_NOT_MAPPED", `${unmapped.length} ledger(s) in the ${year} books are under a Tally group that is not read as a standard group yet, so their balances are in no ratio. Map the groups under Tally books and create the pack again.`)],
      state: "PENDING_INPUT",
      derived: true,
    }));
  }
  if (measure.unreadable) {
    rows.push(makeRow({
      section: "INPUT_GAPS",
      identity: `unreadable-vouchers|${year}`,
      label: `${year}: ${measure.unreadable} voucher(s) could not be read`,
      values: { count: measure.unreadable, amountMinor: null, lines: [{ label: "Vouchers not read", value: String(measure.unreadable), kind: "text" }], choices: [] },
      ruleHits: [hit("UNREADABLE_VOUCHERS", `${measure.unreadable} voucher(s) in the ${year} books have no readable date, an amount that could not be read, or a ledger that is not in the masters. They are in no figure, so the ratios may be wrong.`)],
      state: "PENDING_INPUT",
      derived: true,
    }));
  }
  if (Math.abs(measure.balanceMinor) >= BALANCE_TOLERANCE_MINOR) {
    const largest = [...measure.ledgers].sort((a, b) => Math.abs(b.openingMinor || 0) - Math.abs(a.openingMinor || 0)).slice(0, 25);
    rows.push(makeRow({
      section: "INPUT_GAPS",
      identity: `books-do-not-balance|${year}`,
      label: `${year}: the books are out of balance by ${formatRupees(Math.abs(measure.balanceMinor))}`,
      values: { amountMinor: null, differenceMinor: measure.balanceMinor, lines: [{ label: "Opening balances plus the year's entries", value: measure.balanceMinor, kind: "money" }], choices: [] },
      ruleHits: [hit("BOOKS_DO_NOT_BALANCE", `The ${year} opening balances and the year's entries do not add to nil (they are out by ${formatRupees(Math.abs(measure.balanceMinor))}). The export may be missing a ledger or its opening balance, such as the Profit & Loss A/c, so every ratio rests on figures that may be incomplete. Take a complete export, or exclude this with the reason.`)],
      state: "PENDING_INPUT",
      sources: largest.map((l) => ledgerSource(snapshotId, l)),
    }));
  }
  if (measure.purchases > 0 && measure.stockEntries === 0) {
    rows.push(makeRow({
      section: "INPUT_GAPS",
      identity: `stock-not-posted|${year}`,
      label: `${year}: purchases of ${formatRupees(measure.purchases)} but no entry on any Stock-in-hand ledger`,
      values: { amountMinor: null, purchasesMinor: measure.purchases, lines: [{ label: "Purchases in the year", value: measure.purchases, kind: "money" }, { label: "Closing stock as the books carry it", value: measure.stockClosing, kind: "money" }], choices: [] },
      ruleHits: [hit("STOCK_NOT_POSTED", `Purchases were booked in ${year} but no entry touches a Stock-in-hand ledger. If the closing stock was not posted to the books, cost of goods sold and the profit are wrong and so is every ratio that uses them. Post the closing stock and take a new export, or exclude this with the reason (for example, the business holds no stock).`)],
      state: "PENDING_INPUT",
      sources: measure.purchaseLedgers.slice(0, 200).map((l) => ledgerSource(snapshotId, l)),
    }));
  }
  for (const group of measure.leftOut) {
    rows.push(makeRow({
      section: "INPUT_GAPS",
      identity: `left-out|${group.code}|${year}`,
      label: `${year}: ${group.label} has a balance of ${formatRupees(Math.abs(group.minor))}`,
      values: { amountMinor: null, balanceMinor: group.minor, lines: [{ label: group.label, value: group.minor, kind: "money" }], choices: [] },
      ruleHits: [hit("BALANCE_LEFT_OUT", `${group.label} in the ${year} books has a balance. It is left out of every ratio because its nature is not known. Clear it in the books, or exclude this with the reason.`)],
      state: "PENDING_INPUT",
      sources: measure.ledgers.filter((l) => l.standardGroup === group.code).map((l) => ledgerSource(snapshotId, l)),
    }));
  }
  return rows;
}

/**
 * @param {object} input
 * @param {string} input.financialYear
 * @param {string} input.snapshotId
 * @param {string} input.priorFinancialYear
 * @param {object} input.current   createMeasure(...).finish() for this year
 * @param {object} input.prior     the same for the year before
 * @param {Object<string,Object<string,number>>} [input.amounts]   what the person typed: { ROW_KEY: { current, prior } }
 */
export function buildRatioRows({ financialYear, snapshotId, priorFinancialYear, current, prior, amounts = {} }) {
  const yearLabels = { current: `FY ${financialYear}`, prior: `FY ${priorFinancialYear}` };
  const rows = SPECS.map((spec) =>
    ratioRow({
      spec,
      snapshotId,
      current,
      prior,
      currentEval: evaluateRatio(spec, current, amounts, "current"),
      priorEval: evaluateRatio(spec, prior, amounts, "prior"),
      yearLabels,
    }));
  rows.push(...gapRows({ snapshotId, year: yearLabels.current, measure: current }));
  rows.push(...gapRows({ snapshotId, year: yearLabels.prior, measure: prior }));
  return { rows };
}
