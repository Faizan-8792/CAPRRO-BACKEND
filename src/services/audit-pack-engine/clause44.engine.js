// src/services/audit-pack-engine/clause44.engine.js
//
// W10 AP7 (2026-10-15). Form 3CD Clause 44 - the break-up of the year's expenditure by the GST
// status of the person it was paid to - computed from three things the firm already holds: the
// client's trial balance (AP5), the purchase register and the year's GSTR-2B (both imported for
// GST reconciliation). Every source research stream named Clause 44 the worst clause of the tax
// audit: "voluminous, clerical work" a junior builds by hand in a spreadsheet each September.
//
// PURE. No I/O, no clock, no randomness: the same inputs always give the same rows in the same
// order (the contract suite builds every fixture twice and compares). Money is integer paise and
// every sum is BigInt-checked.
//
// WHAT IT DOES NOT DO. It never decides a ledger or a supplier status for the CA: every row starts
// COMPUTED (a proposal with the rule that produced it) or PENDING_INPUT (no rule can say), and the
// clause's figures stay provisional until a person has decided every row. A missing GSTR-2B month
// is reported as missing - never read as "this supplier did not appear" - and the unregistered
// column is a labelled balancing figure, because the books do not name the suppliers behind it.
//
// THE CLAUSE (Form 3CD, clause 44, the table's columns):
//   2  total expenditure incurred during the year
//   3  expenditure in respect of registered entities, relating to exempt goods or services
//   4  ... relating to entities in the composition scheme
//   5  ... relating to other registered entities
//   6  total payment to registered entities (3 + 4 + 5)
//   7  expenditure relating to entities not registered under GST (2 - 6 here)

import { createHash } from "node:crypto";

export const CLAUSE44_RULE_VERSION = "clause44-v1";

export const ROW_STATES = Object.freeze(["COMPUTED", "CONFIRMED", "EXCLUDED", "PENDING_INPUT"]);

// What a trial-balance ledger is, for this clause.
export const LEDGER_TREATMENTS = Object.freeze([
  "REVENUE_EXPENDITURE", // counted in column 2; split by supplier status through the registers
  "CAPITAL_ADDITIONS", // the year's additions (debit transactions), counted in column 2
  "EXCLUDED", // not expenditure on a supply: depreciation, provisions, write-offs, employee costs, taxes
  "NOT_EXPENDITURE", // a balance-sheet or income ledger
  "COL3_EXEMPT", // a person said: wholly exempt supplies from registered persons
  "COL4_COMPOSITION", // a person said: wholly from composition suppliers
  "COL7_UNREGISTERED", // a person said: wholly from unregistered persons
  "UNCLASSIFIED", // no rule could tell; a person must say
]);

export const SUPPLIER_STATUSES = Object.freeze([
  "REGISTERED", // in at least one of the year's GSTR-2B months: a regular registered supplier
  "NOT_IN_2B", // has a GSTIN but never appears in a 2B month that was loaded: composition, exempt-only or not filing
  "COMPOSITION", // set by a person after checking the supplier on the GST portal
  "EXEMPT_SUPPLIER", // set by a person: everything this supplier supplies is exempt
]);

const COUNTED_TREATMENTS = new Set([
  "REVENUE_EXPENDITURE", "CAPITAL_ADDITIONS", "COL3_EXEMPT", "COL4_COMPOSITION", "COL7_UNREGISTERED",
]);

/**
 * The figure a ledger carries under a treatment. A person chooses the treatment; the amount always
 * comes from the books: the closing balance for expenditure (and for an excluded ledger, shown but
 * never counted), the year's debit transactions for a fixed asset's additions, nothing for a ledger
 * outside the clause. null: the books do not give it (additions without a Debit transactions column).
 */
export function ledgerAmountFor(treatment, values = {}) {
  if (treatment === "CAPITAL_ADDITIONS") {
    return Number.isSafeInteger(values.additionsMinor) ? values.additionsMinor : null;
  }
  if (COUNTED_TREATMENTS.has(treatment) || treatment === "EXCLUDED") {
    return Number.isSafeInteger(values.closingMinor) ? values.closingMinor : null;
  }
  return 0;
}

// ─── money ──────────────────────────────────────────────────────────────

function sum(values) {
  let total = 0n;
  for (const value of values) {
    if (!Number.isSafeInteger(value)) throw new TypeError(`Clause 44: amount ${value} is not integer paise`);
    total += BigInt(value);
  }
  if (total > BigInt(Number.MAX_SAFE_INTEGER) || total < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError("Clause 44: a total exceeds the safe currency range");
  }
  return Number(total);
}

// ─── classification rules (versioned with CLAUSE44_RULE_VERSION) ────────────

const norm = (value) => String(value ?? "").toLowerCase().replace(/\s+/g, " ").trim();

// Tally's predefined groups, by what they mean for this clause.
const GROUP_TREATMENT = new Map([
  ["purchase accounts", "REVENUE_EXPENDITURE"],
  ["direct expenses", "REVENUE_EXPENDITURE"],
  ["indirect expenses", "REVENUE_EXPENDITURE"],
  ["fixed assets", "CAPITAL_ADDITIONS"],
  ...[
    "branch / divisions", "capital account", "current assets", "current liabilities", "direct incomes",
    "indirect incomes", "investments", "loans (liability)", "misc. expenses (asset)", "sales accounts",
    "suspense a/c", "bank accounts", "bank od a/c", "cash-in-hand", "deposits (asset)", "duties & taxes",
    "loans & advances (asset)", "provisions", "reserves & surplus", "secured loans", "stock-in-hand",
    "sundry creditors", "sundry debtors", "unsecured loans",
  ].map((group) => [group, "NOT_EXPENDITURE"]),
]);

// A custom group name ("Administrative Expenses", "Plant and Machinery") read by its words. Order
// matters: "Capital Work-in-Progress" is capital before "expenditure" can call it revenue, and
// "Computer Expenses" is an expense before "computer" can call it an asset.
const GROUP_WORDS = [
  [/\bcapital (work|expenditure)/, "CAPITAL_ADDITIONS"],
  [/\b(purchase|expense|expenditure|overhead|cost)s?\b/, "REVENUE_EXPENDITURE"],
  [/\b(fixed asset|plant|machinery|furniture|vehicle|computer|building|equipment)s?\b/, "CAPITAL_ADDITIONS"],
  [/\b(debtor|creditor|bank|cash|loan|capital|reserve|surplus|income|sales|revenue|deposit|investment|stock|duties|tax payable|provision|advance|receivable|payable|liabilit|asset)/, "NOT_EXPENDITURE"],
];

// Ledgers inside an expense group that are not expenditure on a supply. Checked before anything
// else, on the ledger's own name. Each has a code and the reason a CA reads beside the row. The
// words are narrow on purpose: "Auditor's Remuneration", "GST Consultancy Fees" and "Income Tax
// Return Filing Fees" are services bought from a supplier and must stay in the clause.
const EXCLUSIONS = [
  ["DEPRECIATION", /\b(depreciation|amortis|amortiz)/, "Depreciation and amortisation are not expenditure on a supply."],
  ["PROVISION", /\bprovision for\b|^provisions?\b/, "A provision is an estimate, not expenditure on a supply."],
  ["WRITE_OFF", /\b(bad debts?|written off|write[- ]?off)\b/, "A write-off is not expenditure on a supply."],
  ["EMPLOYEE", /\b(salar(y|ies)|wages|bonus|gratuity|leave encashment|stipend|ex[- ]?gratia|(directors?'?|partners?'?) remuneration|remuneration to (directors?|partners?))\b/, "Payments to employees, directors and partners for their services are not a supply (CGST Act, Schedule III)."],
  ["EMPLOYEE_CONTRIBUTION", /\b(provident fund|pf contribution|contribution to (pf|esi|provident fund)|esi contribution|employees.? state insurance|superannuation|labour welfare fund)\b/, "Statutory contributions for employees are not consideration for a supply."],
  ["TAX_OR_LEVY", /\b(rates (and|&) taxes|professional tax|property tax|municipal tax|house tax|stamp duty|penalt(y|ies)|late fees?|interest on (income[- ]?tax|tds|tcs|gst|advance tax))\b|\bincome[- ]?tax\b(?! (consult\w*|return|filing|fees?|audit))|^(tds|tcs)( (paid|payable|deducted|receivable))?$/, "Taxes, duties, penalties and interest on them are levies, not supplies."],
  ["ROUNDING", /\bround(ing)?[- ]?off\b/, "Rounding differences are not expenditure on a supply."],
];

// A ledger name that reads as an expense, used only when the file gives no group.
const EXPENSE_WORDS = /\b(expenses?|charges|rent|fees?|purchases?|repairs?|maintenance|freight|carriage|cartage|power|electricity|telephone|internet|mobile|printing|stationery|travel(l?ing)?|conveyance|advertis\w*|insurance|commission|brokerage|legal|professional|consultancy|postage|courier|packing|job ?work|discount allowed|interest|hire)\b/;

function hit(rule, detail, threshold = null) {
  return { rule, threshold, detail };
}

/**
 * One trial-balance ledger, classified. Returns its treatment, the amount the clause would count,
 * the rules that fired and the row state. Exported so the contract suite can pin each rule alone.
 */
export function classifyLedger(ledger) {
  const name = norm(ledger.ledgerName);
  const group = norm(ledger.groupName);
  const ruleHits = [];
  let treatment = "UNCLASSIFIED";

  if (!group && ledger.looksLikeGroupTotal) {
    ruleHits.push(hit("LOOKS_LIKE_GROUP_TOTAL", "This row is named like a Tally group, so it may be the group's total printed above its ledgers. Counting it with them would count the same money twice."));
    return { treatment, amountMinor: 0, ruleHits, state: "PENDING_INPUT" };
  }

  let groupTreatment = null;
  if (group) {
    if (GROUP_TREATMENT.has(group)) {
      groupTreatment = GROUP_TREATMENT.get(group);
      ruleHits.push(hit("TALLY_GROUP", `Group "${ledger.groupName}" is Tally's predefined group for this.`));
    } else {
      for (const [pattern, mapped] of GROUP_WORDS) {
        if (pattern.test(group)) {
          groupTreatment = mapped;
          ruleHits.push(hit("GROUP_WORDS", `Group "${ledger.groupName}" reads as ${mapped === "NOT_EXPENDITURE" ? "a balance-sheet or income group" : mapped === "CAPITAL_ADDITIONS" ? "fixed assets" : "expenses"}.`));
          break;
        }
      }
    }
  }

  if (groupTreatment === "NOT_EXPENDITURE") {
    return { treatment: "NOT_EXPENDITURE", amountMinor: 0, ruleHits, state: "COMPUTED" };
  }

  // Exclusions apply inside expense groups and to ungrouped ledgers alike.
  for (const [code, pattern, reason] of EXCLUSIONS) {
    if (pattern.test(name)) {
      ruleHits.push(hit(`EXCLUDED_${code}`, reason));
      return { treatment: "EXCLUDED", amountMinor: ledger.closingMinor || 0, ruleHits, state: "COMPUTED", exclusion: code };
    }
  }

  if (groupTreatment === "CAPITAL_ADDITIONS") {
    if (!ledger.hasTransactionTotals) {
      ruleHits.push(hit("CAPITAL_ADDITIONS_UNKNOWN", "The year's additions to this asset are not in the trial balance: map its Debit transactions column to count them."));
      return { treatment: "CAPITAL_ADDITIONS", amountMinor: 0, ruleHits, state: "PENDING_INPUT" };
    }
    ruleHits.push(hit("CAPITAL_ADDITIONS_FROM_DEBITS", "The year's additions are taken as this asset's debit transactions."));
    return { treatment: "CAPITAL_ADDITIONS", amountMinor: ledger.debitTotalMinor || 0, ruleHits, state: "COMPUTED" };
  }

  if (groupTreatment === "REVENUE_EXPENDITURE" || (!group && EXPENSE_WORDS.test(name))) {
    if (!group) ruleHits.push(hit("NAME_READS_AS_EXPENSE", "The file gives no group; the ledger's name reads as an expense."));
    if (ledger.hasOpening && (ledger.openingMinor || 0) !== 0) {
      ruleHits.push(hit("OPENING_ON_EXPENSE", "An expense ledger normally starts the year at nil; this one shows an opening balance. The closing balance is counted."));
    }
    if ((ledger.closingMinor || 0) < 0) {
      ruleHits.push(hit("CREDIT_BALANCE", "A credit balance on an expense ledger (returns, discounts) reduces the year's expenditure."));
    }
    if (/\binterest\b/.test(name)) {
      ruleHits.push(hit("INTEREST_USUALLY_EXEMPT", "Interest paid to a bank or a lender is usually an exempt supply (column 3) when the lender is registered. Say so if it is."));
    }
    return { treatment: "REVENUE_EXPENDITURE", amountMinor: ledger.closingMinor || 0, ruleHits, state: "COMPUTED" };
  }

  ruleHits.push(hit("UNCLASSIFIED", group
    ? `Group "${ledger.groupName}" is not one CA PRO recognises. Say whether this ledger is expenditure.`
    : "The file gives no group and the name does not say. Say whether this ledger is expenditure."));
  return { treatment, amountMinor: 0, ruleHits, state: "PENDING_INPUT" };
}

// ─── financial year ─────────────────────────────────────────────────────

export function financialYearMonths(financialYear) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(financialYear || ""));
  if (!match || (Number(match[1]) + 1) % 100 !== Number(match[2])) {
    throw new RangeError(`Clause 44: "${financialYear}" is not a financial year like 2025-26`);
  }
  const start = Number(match[1]);
  const months = [];
  for (let i = 0; i < 12; i += 1) {
    const monthIndex = (3 + i) % 12; // April = 3
    const year = start + (3 + i >= 12 ? 1 : 0);
    months.push(`${year}-${String(monthIndex + 1).padStart(2, "0")}`);
  }
  return months;
}

// ─── rows ───────────────────────────────────────────────────────────────

const MAX_EMBEDDED_SOURCES = 100;

function rowKeyFor(section, identity) {
  return createHash("sha256").update(`${CLAUSE44_RULE_VERSION}|${section}|${identity}`).digest("hex");
}

function sourceDigest(sources) {
  return createHash("sha256")
    .update(sources.map((s) => `${s.kind}:${s.batchId}:${s.rowId}:${s.sourceRow}`).join("\n"))
    .digest("hex");
}

function makeRow({ section, identity, label, values, ruleHits = [], state, sources = [], derived = false, party = null }) {
  if (!derived && sources.length === 0) {
    throw new Error(`Clause 44: a ${section} row (${label}) has no source rows`);
  }
  const ordered = [...sources].sort((a, b) =>
    `${a.kind}:${a.batchId}:${String(a.sourceRow).padStart(9, "0")}`.localeCompare(
      `${b.kind}:${b.batchId}:${String(b.sourceRow).padStart(9, "0")}`));
  return {
    section,
    rowKey: rowKeyFor(section, identity),
    label,
    party,
    values,
    ruleHits,
    state,
    decidable: !derived,
    sourceRows: ordered.slice(0, MAX_EMBEDDED_SOURCES),
    allSources: ordered,
    sourceEvidenceCount: ordered.length,
    sourceEvidenceHash: sourceDigest(ordered),
  };
}

function signedTaxable(row) {
  const value = row.taxableValueMinor || 0;
  if (row.documentType === "CREDIT_NOTE") return -Math.abs(value);
  return value;
}

function totalTax(row) {
  return sum([row.igstMinor || 0, row.cgstMinor || 0, row.sgstMinor || 0, row.cessMinor || 0]);
}

/**
 * Build every row of the pack.
 *
 * @param {object} input
 * @param {string} input.financialYear           "2025-26"
 * @param {object[]} input.trialBalance          BooksImportRow-shaped rows, each with rowId and batchId
 * @param {object[]} input.purchases             GST_PURCHASE ImportRow-shaped rows
 * @param {object[]} input.gstr2b                GSTR2B ImportRow-shaped rows, each with `period` ("2025-04")
 * @param {string[]} input.gstr2bMonths          the months whose 2B was loaded (a quarterly 2B counts for its three)
 * @param {object[]} [input.parties]             party-master statuses set by a person: { gstin, gstStatus }
 */
export function buildClause44Rows({ financialYear, trialBalance = [], purchases = [], gstr2b = [], gstr2bMonths = [], parties = [] }) {
  const months = financialYearMonths(financialYear);
  const monthSet = new Set(months);
  const loadedMonths = [...new Set(gstr2bMonths)].filter((m) => monthSet.has(m)).sort();
  const missingMonths = months.filter((m) => !loadedMonths.includes(m));
  const rows = [];

  // Ledgers.
  const seenLedgers = new Map();
  for (const ledger of trialBalance) {
    const key = norm(ledger.ledgerName);
    const classified = classifyLedger(ledger);
    const source = { kind: "TRIAL_BALANCE", batchId: String(ledger.batchId), rowId: String(ledger.rowId), sourceRow: ledger.sourceRow };
    if (seenLedgers.has(key)) {
      // The same ledger twice in one trial balance cannot both be counted; a person decides.
      seenLedgers.get(key).duplicates.push(source);
      continue;
    }
    seenLedgers.set(key, { ledger, classified, source, duplicates: [] });
  }
  for (const [key, { ledger, classified, source, duplicates }] of [...seenLedgers.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const ruleHits = [...classified.ruleHits];
    let state = classified.state;
    if (duplicates.length) {
      ruleHits.push(hit("DUPLICATE_LEDGER", `This ledger appears ${duplicates.length + 1} times in the trial balance; only one can be counted. Confirming it counts the first, on row ${source.sourceRow}; exclude it if that is not the right one.`));
      state = "PENDING_INPUT";
    }
    rows.push(makeRow({
      section: "LEDGER",
      identity: key,
      label: ledger.ledgerName,
      values: {
        groupName: ledger.groupName || "",
        treatment: classified.treatment,
        amountMinor: classified.amountMinor,
        closingMinor: ledger.closingMinor || 0,
        // The year's additions, when the export has its Debit transactions column; null when not.
        additionsMinor: ledger.hasTransactionTotals ? ledger.debitTotalMinor || 0 : null,
        exclusion: classified.exclusion || "",
      },
      ruleHits,
      state,
      sources: [source, ...duplicates],
    }));
  }

  // Suppliers, from the purchase register for the year.
  const statusByGstin = new Map(parties.filter((p) => p?.gstin).map((p) => [String(p.gstin).toUpperCase(), p.gstStatus]));
  const monthsByGstin = new Map();
  const taxable2bByGstin = new Map();
  for (const row of gstr2b) {
    if (!monthSet.has(row.period)) continue;
    const gstin = String(row.supplierGstin || "").toUpperCase();
    if (!monthsByGstin.has(gstin)) monthsByGstin.set(gstin, new Set());
    monthsByGstin.get(gstin).add(row.period);
    taxable2bByGstin.set(gstin, sum([taxable2bByGstin.get(gstin) || 0, signedTaxable(row)]));
  }

  const bySupplier = new Map();
  let outsideYear = 0;
  for (const row of purchases) {
    const month = String(row.documentDate || "").slice(0, 7);
    if (!monthSet.has(month)) { outsideYear += 1; continue; }
    const gstin = String(row.supplierGstin || "").toUpperCase();
    if (!bySupplier.has(gstin)) bySupplier.set(gstin, []);
    bySupplier.get(gstin).push(row);
  }

  for (const gstin of [...bySupplier.keys()].sort()) {
    const supplierRows = bySupplier.get(gstin);
    const unknownTypes = supplierRows.filter((r) => !["INVOICE", "CREDIT_NOTE", "DEBIT_NOTE"].includes(r.documentType));
    const taxed = supplierRows.filter((r) => r.reverseCharge || totalTax(r) !== 0);
    const untaxed = supplierRows.filter((r) => !r.reverseCharge && totalTax(r) === 0);
    const taxedMinor = sum(taxed.map(signedTaxable));
    const untaxedMinor = sum(untaxed.map(signedTaxable));
    const in2bMonths = [...(monthsByGstin.get(gstin) || [])].sort();
    const decided = statusByGstin.get(gstin);
    const ruleHits = [];
    let status;
    let state = "COMPUTED";
    if (decided === "COMPOSITION" || decided === "EXEMPT_SUPPLIER" || decided === "REGISTERED") {
      status = decided;
      ruleHits.push(hit("STATUS_SET_BY_A_PERSON", "This supplier's status was set by a person in the party master."));
    } else if (in2bMonths.length > 0) {
      status = "REGISTERED";
      ruleHits.push(hit("IN_GSTR2B", `In this year's GSTR-2B for ${in2bMonths.length} of the ${loadedMonths.length} months loaded.`));
    } else {
      status = "NOT_IN_2B";
      state = "PENDING_INPUT";
      ruleHits.push(hit("NOT_IN_GSTR2B", loadedMonths.length
        ? `Not in any of the ${loadedMonths.length} GSTR-2B months loaded: a composition dealer, a supplier of exempt goods only, or one not filing. Check it on the GST portal and set its status.`
        : "No GSTR-2B was loaded for this year, so this supplier's status cannot be read. Load the year's GSTR-2B or set its status."));
    }
    if (status === "REGISTERED" && untaxed.length) {
      ruleHits.push(hit("UNTAXED_INVOICES", `${untaxed.length} of this supplier's documents carry no tax; they are counted as exempt supplies (column 3).`));
    }
    if (unknownTypes.length) {
      ruleHits.push(hit("UNKNOWN_DOCUMENT_TYPE", `${unknownTypes.length} document(s) are neither an invoice nor a credit or debit note; check them before relying on this row.`));
      state = "PENDING_INPUT";
    }
    rows.push(makeRow({
      section: "SUPPLIER",
      identity: gstin,
      label: gstin,
      party: { gstin },
      values: {
        status,
        taxedMinor,
        untaxedMinor,
        totalMinor: sum([taxedMinor, untaxedMinor]),
        documentCount: supplierRows.length,
        in2bMonths,
        gstr2bTaxableMinor: taxable2bByGstin.get(gstin) ?? null,
      },
      ruleHits,
      state,
      sources: supplierRows.map((r) => ({ kind: "GST_PURCHASE", batchId: String(r.batchId), rowId: String(r.rowId), sourceRow: r.sourceRow })),
    }));
  }

  // Tie-outs. Derived rows: they explain, they are never decided.
  const registerTotal = sum([...bySupplier.values()].flat().map(signedTaxable));
  const gstr2bTotal = sum([...taxable2bByGstin.values()]);
  rows.push(makeRow({
    section: "TIEOUT",
    identity: "register-vs-2b",
    label: "Purchase register against GSTR-2B",
    values: {
      leftLabel: "Purchase register, taxable value for the year",
      leftMinor: registerTotal,
      rightLabel: "GSTR-2B, taxable value for the months loaded",
      rightMinor: gstr2bTotal,
      differenceMinor: registerTotal - gstr2bTotal,
      monthsLoaded: loadedMonths,
      monthsMissing: missingMonths,
      suppliersDiffering: [...bySupplier.keys()].filter((g) => {
        const left = sum(bySupplier.get(g).map(signedTaxable));
        return left !== (taxable2bByGstin.get(g) ?? 0);
      }).length,
      purchaseRowsOutsideYear: outsideYear,
    },
    ruleHits: missingMonths.length
      ? [hit("MONTHS_MISSING", `GSTR-2B for ${missingMonths.length} month(s) of the year was not loaded: ${missingMonths.join(", ")}.`)]
      : [],
    state: missingMonths.length ? "PENDING_INPUT" : "COMPUTED",
    derived: true,
  }));

  const ledgerRows = rows.filter((r) => r.section === "LEDGER");
  const booksPurchases = sum(ledgerRows
    .filter((r) => r.values.treatment === "REVENUE_EXPENDITURE" && /purchase/.test(norm(r.values.groupName) || norm(r.label)))
    .map((r) => r.values.amountMinor));
  rows.push(makeRow({
    section: "TIEOUT",
    identity: "books-purchases-vs-register",
    label: "Purchase accounts in the books against the purchase register",
    values: {
      leftLabel: "Purchase ledgers in the trial balance",
      leftMinor: booksPurchases,
      rightLabel: "Purchase register, taxable value for the year",
      rightMinor: registerTotal,
      differenceMinor: booksPurchases - registerTotal,
    },
    ruleHits: [hit("EXPECTED_DIFFERENCE", "The books also hold purchases from unregistered suppliers and purchases without GST, so a difference is expected; a large one is worth a look.")],
    state: "COMPUTED",
    derived: true,
  }));

  return {
    ruleVersion: CLAUSE44_RULE_VERSION,
    financialYear,
    monthsLoaded: loadedMonths,
    monthsMissing: missingMonths,
    rows,
  };
}

// ─── the clause's figures, from rows and the decisions people made ──────────────

/**
 * The effective view of one row: what the engine proposed, overlaid with a person's decision.
 * A decision may set a ledger's treatment or a supplier's status; it never sets an amount.
 */
export function effectiveRow(row) {
  const decision = row.decision || null;
  const values = { ...row.values };
  if (decision?.treatment && row.section === "LEDGER") values.treatment = decision.treatment;
  // Once a person has decided a ledger, its amount is the books' figure for the treatment in force:
  // an unclassified ledger confirmed as expenditure counts its closing balance, not the nil the
  // engine held while it waited for an answer.
  if (decision && row.section === "LEDGER") values.amountMinor = ledgerAmountFor(values.treatment, values);
  if (decision?.status && row.section === "SUPPLIER") values.status = decision.status;
  const state = decision?.state || row.state;
  return { ...row, values, state };
}

/**
 * Columns 2 to 7 of the clause, and whether they may be used. They may be used - `provisional:
 * false` - only when every decidable row has been confirmed or excluded by a person, no month of
 * the year's GSTR-2B is missing, and the balancing column is not negative. Otherwise the figures
 * are still returned for the working, with every reason they are provisional.
 */
export function summarizeClause44(rows) {
  const effective = rows.map(effectiveRow);
  const ledgers = effective.filter((r) => r.section === "LEDGER");
  const suppliers = effective.filter((r) => r.section === "SUPPLIER");
  const counted = ledgers.filter((r) => r.state !== "EXCLUDED" && COUNTED_TREATMENTS.has(r.values.treatment));

  const col2 = sum(counted.map((r) => r.values.amountMinor || 0));
  const ledgerCol = (treatment) => sum(counted.filter((r) => r.values.treatment === treatment).map((r) => r.values.amountMinor || 0));
  const live = suppliers.filter((r) => r.state !== "EXCLUDED");
  const col3 = sum([
    ledgerCol("COL3_EXEMPT"),
    ...live.filter((r) => r.values.status === "EXEMPT_SUPPLIER").map((r) => r.values.totalMinor),
    ...live.filter((r) => r.values.status === "REGISTERED").map((r) => r.values.untaxedMinor),
  ]);
  const col4 = sum([
    ledgerCol("COL4_COMPOSITION"),
    ...live.filter((r) => r.values.status === "COMPOSITION").map((r) => r.values.totalMinor),
  ]);
  const col5 = sum(live.filter((r) => r.values.status === "REGISTERED").map((r) => r.values.taxedMinor));
  const col6 = sum([col3, col4, col5]);
  const col7 = col2 - col6;

  const reasons = [];
  // A ledger confirmed without a treatment is still unclassified: it is not decided.
  const undecided = effective.filter((r) => r.decidable && (!["CONFIRMED", "EXCLUDED"].includes(r.state)
    || (r.section === "LEDGER" && r.state === "CONFIRMED" && r.values.treatment === "UNCLASSIFIED"))).length;
  if (undecided) reasons.push({ code: "ROWS_NOT_DECIDED", count: undecided });
  const pending = effective.filter((r) => r.state === "PENDING_INPUT").length;
  if (pending) reasons.push({ code: "ROWS_PENDING_INPUT", count: pending });
  const amountUnknown = counted.filter((r) => !Number.isSafeInteger(r.values.amountMinor)).length;
  if (amountUnknown) reasons.push({ code: "LEDGER_AMOUNT_UNKNOWN", count: amountUnknown });
  const unresolvedSuppliers = suppliers.filter((r) => r.values.status === "NOT_IN_2B" && r.state !== "EXCLUDED").length;
  if (unresolvedSuppliers) reasons.push({ code: "SUPPLIER_STATUS_UNKNOWN", count: unresolvedSuppliers });
  const missingMonths = rows.find((r) => r.section === "TIEOUT" && r.values.monthsMissing)?.values.monthsMissing || [];
  if (missingMonths.length) reasons.push({ code: "GSTR2B_MONTHS_MISSING", count: missingMonths.length, months: missingMonths });
  if (col7 < 0) reasons.push({ code: "REGISTERED_EXCEEDS_TOTAL", amountMinor: -col7 });

  return {
    ruleVersion: CLAUSE44_RULE_VERSION,
    columns: { col2, col3, col4, col5, col6, col7 },
    col7IsBalancing: true,
    provisional: reasons.length > 0,
    reasons,
    counts: {
      ledgers: ledgers.length,
      suppliers: suppliers.length,
      undecided,
      pendingInput: pending,
      unresolvedSuppliers,
    },
  };
}
