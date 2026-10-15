// src/services/books-normalization.service.js
//
// W10 AP5 (2026-10-15): the BOOKS import family - the firm's own books, beside the GST and TDS
// families. Today it holds one kind, TRIAL_BALANCE; Tally ledgers and vouchers join it in AP18.
//
// WHY A TRIAL BALANCE
// -------------------
// Clause 44 of Form 3CD splits the year's expenditure by the GST status of the supplier, and the
// year's expenditure lives in the books, not in any GST return. A trial balance is the one export
// every small client can produce from Tally, Busy or Zoho, and it is what a CA already asks for on
// day one of a tax audit. Nothing here infers a figure: each row keeps the ledger's own name, the
// group the file gives it (if it gives one), and its balances, exactly as exported.
//
// SIGN CONVENTION: debit positive, credit negative, in integer paise (parseFlexibleMoneyMinor
// already reads "1,250.00 Cr" as -125000). A closing balance comes either from one signed column
// or from a Debit column and a Credit column, never from a guess about which side a ledger is on.

import { createHash } from "node:crypto";
import { BOOKS_IMPORT_KINDS } from "../models/BooksImportRow.js";
import { parseFlexibleMoneyMinor } from "./robust-normalize.service.js";
import { userFacingError, userFacingMessage } from "../utils/user-facing-error.js";

const BOOKS_NORMALIZATION_VERSION = "books-import-v1";

const BOOKS_IMPORT_SPECS = Object.freeze({
  TRIAL_BALANCE: {
    required: ["ledgerName"],
    allowed: [
      "ledgerName",
      "groupName",
      "openingBalance",
      "openingDebit",
      "openingCredit",
      "debitTotal",
      "creditTotal",
      "closingBalance",
      "closingDebit",
      "closingCredit",
    ],
    // One of these groups must be mapped in full. A Debit column alone would read every credit
    // balance as nil, so the pair is all-or-nothing.
    requiredOneOf: [["closingBalance"], ["closingDebit", "closingCredit"]],
  },
});

const BOOKS_SOURCE_LABELS = Object.freeze({
  TRIAL_BALANCE: "User-imported trial balance",
});

// Tally's predefined groups (the 28 every company starts with). A row named exactly like one of
// them, in a file with no group column, is most likely a group total printed above its ledgers:
// importing it beside those ledgers would count the same money twice. It is never dropped or
// re-labelled here - the preview warns, and every pack built on the file asks a person.
const TALLY_PREDEFINED_GROUPS = Object.freeze([
  "branch / divisions", "capital account", "current assets", "current liabilities",
  "direct expenses", "direct incomes", "fixed assets", "indirect expenses", "indirect incomes",
  "investments", "loans (liability)", "misc. expenses (asset)", "purchase accounts",
  "sales accounts", "suspense a/c", "bank accounts", "bank od a/c", "cash-in-hand",
  "deposits (asset)", "duties & taxes", "loans & advances (asset)", "provisions",
  "reserves & surplus", "secured loans", "stock-in-hand", "sundry creditors", "sundry debtors",
  "unsecured loans",
]);

const MAX_NAME_LENGTH = 240;

function groupKey(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
const PREDEFINED_GROUP_KEYS = new Set(TALLY_PREDEFINED_GROUPS.map(groupKey));

function looksLikePredefinedGroup(name) {
  return PREDEFINED_GROUP_KEYS.has(groupKey(name));
}

function cleanName(value) {
  return String(value ?? "")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeBooksImportRow(kind, mapped) {
  const errors = [];
  const warnings = [];
  const addError = (field, code, message = "") => errors.push({ field, code, message });
  const addWarning = (field, code) => warnings.push({ field, code });

  if (kind !== "TRIAL_BALANCE") {
    addError("kind", "UNSUPPORTED_KIND", "This file kind is not part of the books import.");
    return { values: {}, errors, warnings };
  }

  const ledgerName = cleanName(mapped.ledgerName);
  if (!ledgerName) addError("ledgerName", "REQUIRED");
  if (ledgerName.length > MAX_NAME_LENGTH) addError("ledgerName", "TOO_LONG");
  const groupName = cleanName(mapped.groupName);
  if (groupName.length > MAX_NAME_LENGTH) addError("groupName", "TOO_LONG");

  const money = (field, options = {}) => {
    if (!(field in mapped)) return null;
    try {
      return parseFlexibleMoneyMinor(mapped[field], { allowBlank: true, field, ...options });
    } catch (error) {
      addError(field, "INVALID_AMOUNT", userFacingMessage(error, `${field} is not an amount we can read.`));
      return null;
    }
  };

  // The opening balance, like the closing one, comes as one signed column or as a Debit and a
  // Credit column; each side is read as a magnitude, the column says which side it is.
  let openingMinor = money("openingBalance");
  if (openingMinor === null && ("openingDebit" in mapped || "openingCredit" in mapped)) {
    const debit = money("openingDebit");
    const credit = money("openingCredit");
    if (debit !== null && credit !== null) openingMinor = Math.abs(debit) - Math.abs(credit);
  }
  // Transaction totals are sides, not balances: a negative debit total is a typing error.
  const debitTotalMinor = money("debitTotal", { nonNegative: true });
  const creditTotalMinor = money("creditTotal", { nonNegative: true });

  let closingMinor = null;
  if ("closingBalance" in mapped) {
    closingMinor = money("closingBalance");
  } else if ("closingDebit" in mapped || "closingCredit" in mapped) {
    // Each side is read as a magnitude: Tally prints both columns unsigned, and some exports add
    // their own "Dr"/"Cr" to each. The column says which side it is.
    const debit = money("closingDebit");
    const credit = money("closingCredit");
    if (debit !== null && credit !== null) {
      const debitAbs = Math.abs(debit);
      const creditAbs = Math.abs(credit);
      if (debitAbs > 0 && creditAbs > 0) addWarning("closingDebit", "BOTH_SIDES_FILLED");
      closingMinor = debitAbs - creditAbs;
    }
  }

  if (ledgerName && !groupName && looksLikePredefinedGroup(ledgerName)) {
    addWarning("ledgerName", "LOOKS_LIKE_GROUP_TOTAL");
  }

  return {
    values: {
      ledgerName,
      groupName,
      openingMinor: openingMinor ?? 0,
      hasOpening: openingMinor !== null,
      debitTotalMinor: debitTotalMinor ?? 0,
      creditTotalMinor: creditTotalMinor ?? 0,
      hasTransactionTotals: debitTotalMinor !== null || creditTotalMinor !== null,
      closingMinor: closingMinor ?? 0,
    },
    errors,
    warnings,
  };
}

function addSafe(values) {
  let total = 0n;
  for (const value of values) total += BigInt(value || 0);
  if (total > BigInt(Number.MAX_SAFE_INTEGER) || total < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error("Trial balance total exceeds the safe currency range");
  }
  return Number(total);
}

// The preview's figures: closing debits, closing credits, and what separates them. A trial
// balance that does not tie is shown as not tying - never quietly balanced - because a missing
// ledger, a duplicated group total or an unmapped column all show up first as a difference here.
function summarizeBooksRows(kind, rows) {
  if (kind !== "TRIAL_BALANCE") return null;
  const closings = rows.map((row) => row.values.closingMinor || 0);
  const closingDebitMinor = addSafe(closings.filter((value) => value > 0));
  const closingCreditMinor = addSafe(closings.filter((value) => value < 0).map((value) => -value));
  return {
    ledgerCount: rows.length,
    closingDebitMinor,
    closingCreditMinor,
    differenceMinor: closingDebitMinor - closingCreditMinor,
    groupedRows: rows.filter((row) => row.values.groupName).length,
  };
}

function fingerprintBooksRow(kind, values) {
  return createHash("sha256")
    .update(JSON.stringify({
      kind,
      ledgerName: values.ledgerName,
      groupName: values.groupName,
      openingMinor: values.openingMinor,
      debitTotalMinor: values.debitTotalMinor,
      creditTotalMinor: values.creditTotalMinor,
      closingMinor: values.closingMinor,
    }))
    .digest("hex");
}

// A trial balance belongs to one client and one financial year ("2025-26"). The year is the
// statutory one the clause workings report on, so it is checked for shape and for the two halves
// being consecutive; nothing else about the client is assumed.
const FINANCIAL_YEAR_PATTERN = /^(\d{4})-(\d{2})$/;

function normalizeBooksContext({ financialYear } = {}) {
  const value = String(financialYear || "").trim();
  const match = FINANCIAL_YEAR_PATTERN.exec(value);
  if (!match || (Number(match[1]) + 1) % 100 !== Number(match[2])) {
    throw userFacingError("Choose the financial year this trial balance is for, as 2025-26.");
  }
  return { financialYear: value };
}

export {
  BOOKS_IMPORT_KINDS,
  BOOKS_IMPORT_SPECS,
  BOOKS_NORMALIZATION_VERSION,
  BOOKS_SOURCE_LABELS,
  TALLY_PREDEFINED_GROUPS,
  fingerprintBooksRow,
  looksLikePredefinedGroup,
  normalizeBooksContext,
  normalizeBooksImportRow,
  summarizeBooksRows,
};
