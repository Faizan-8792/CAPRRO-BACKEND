import {
  parseFlexibleDateIso,
  parseFlexibleMoneyMinor,
} from "./robust-normalize.service.js";
import { userFacingError, userFacingMessage } from "../utils/user-facing-error.js";

const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

const GSTR3B_CATEGORY_ALIASES = Object.freeze({
  ITCCLAIMED: "ITC_CLAIMED",
  NETITC: "ITC_CLAIMED",
  NETITCAVAILABLE: "ITC_CLAIMED",
  "4C": "ITC_CLAIMED",
  ITCAVAILABLE: "ITC_AVAILABLE",
  GROSSITC: "ITC_AVAILABLE",
  "4A": "ITC_AVAILABLE",
  ITCREVERSED: "ITC_REVERSED",
  ITCREVERSAL: "ITC_REVERSED",
  "4B": "ITC_REVERSED",
  ITCINELIGIBLE: "ITC_INELIGIBLE",
  INELIGIBLEITC: "ITC_INELIGIBLE",
  "4D": "ITC_INELIGIBLE",

  // Table 3.1 - what the return DECLARES as outward supply, as against the Table 4 ITC rows
  // above. Both halves live in the same summary file because that is how the portal's own PDF
  // is laid out: one return, two halves. Keeping them in one import kind is what lets a single
  // GSTR-3B upload serve the ITC reconciliation AND the turnover reconciliation, instead of
  // asking a firm to upload the same return twice under two names.
  OUTWARDTAXABLE: "OUTWARD_TAXABLE",
  OUTWARDTAXABLESUPPLIES: "OUTWARD_TAXABLE",
  TAXABLEOUTWARD: "OUTWARD_TAXABLE",
  "31A": "OUTWARD_TAXABLE",
  OUTWARDZERORATED: "OUTWARD_ZERO_RATED",
  ZERORATED: "OUTWARD_ZERO_RATED",
  ZERORATEDSUPPLIES: "OUTWARD_ZERO_RATED",
  "31B": "OUTWARD_ZERO_RATED",
  OUTWARDNILEXEMPT: "OUTWARD_NIL_EXEMPT",
  NILRATEDEXEMPT: "OUTWARD_NIL_EXEMPT",
  "31C": "OUTWARD_NIL_EXEMPT",
  INWARDREVERSECHARGE: "INWARD_REVERSE_CHARGE",
  REVERSECHARGEINWARD: "INWARD_REVERSE_CHARGE",
  "31D": "INWARD_REVERSE_CHARGE",
  OUTWARDNONGST: "OUTWARD_NON_GST",
  NONGSTOUTWARD: "OUTWARD_NON_GST",
  "31E": "OUTWARD_NON_GST",
});

/// The Table 3.1 half. Separated so the ITC arithmetic can ignore it by name rather than by luck.
const GSTR3B_OUTWARD_CATEGORIES = Object.freeze([
  "OUTWARD_TAXABLE",
  "OUTWARD_ZERO_RATED",
  "OUTWARD_NIL_EXEMPT",
  "OUTWARD_NON_GST",
  "INWARD_REVERSE_CHARGE",
]);

/// Only these count as turnover declared in GSTR-3B. Nil/exempt and non-GST carry no tax and are
/// not part of the comparison against GSTR-1's taxable outward supply; inward reverse charge is
/// not outward supply at all.
const GSTR3B_TURNOVER_CATEGORIES = Object.freeze(["OUTWARD_TAXABLE", "OUTWARD_ZERO_RATED"]);

const GSTR3B_CATEGORIES = Object.freeze([
  "ITC_CLAIMED",
  "ITC_AVAILABLE",
  "ITC_REVERSED",
  "ITC_INELIGIBLE",
  ...GSTR3B_OUTWARD_CATEGORIES,
]);

/// GSTR-1 outward supply sections, named as the return itself names them.
const GSTR1_CATEGORIES = Object.freeze([
  "B2B",
  "B2C",
  "CDNR",
  "CDNUR",
  "EXPORT",
  "NIL_RATED",
  "ADVANCES",
  "AMENDMENT",
  "DNR",
  "DNUR",
]);

/// Only CREDIT notes reduce declared turnover. A DEBIT note under section 34(3) CGST increases
/// the value of the supply, so it is added like any other outward supply - it has its own
/// categories below rather than sharing the credit-note bucket.
///
/// Getting this sign wrong is the single easiest way to make a turnover reconciliation lie, and
/// it lies in the worst direction: a debit note subtracted instead of added moves declared
/// turnover by TWICE the note, and the difference then points a firm at amending a GSTR-3B that
/// was correct all along.
const GSTR1_NEGATIVE_CATEGORIES = Object.freeze(["CDNR", "CDNUR"]);

/// Nil-rated and non-GST supplies carry no tax and are excluded from the taxable comparison,
/// matching the GSTR-3B side, which compares Table 3.1(a) and 3.1(b) only.
const GSTR1_TURNOVER_CATEGORIES = Object.freeze([
  "B2B",
  "B2C",
  "CDNR",
  "CDNUR",
  "DNR",
  "DNUR",
  "EXPORT",
  "ADVANCES",
  "AMENDMENT",
]);

const GSTR1_CATEGORY_ALIASES = Object.freeze({
  B2B: "B2B",
  B2BINVOICES: "B2B",
  "4A": "B2B",
  B2C: "B2C",
  B2CS: "B2C",
  B2CL: "B2C",
  B2COTHERS: "B2C",
  "7": "B2C",
  CDNR: "CDNR",
  CREDITNOTEREGISTERED: "CDNR",
  CREDITNOTE: "CDNR",
  // Table 9B holds credit AND debit notes for registered recipients. A row labelled only with
  // the table number is the section total, which the portal presents net of credit notes, so it
  // keeps the credit-note sign. A row that names itself a DEBIT note is unambiguous and is read
  // as one.
  "9B": "CDNR",
  CDNUR: "CDNUR",
  CREDITNOTEUNREGISTERED: "CDNUR",
  DNR: "DNR",
  DEBITNOTE: "DNR",
  DEBITNOTEREGISTERED: "DNR",
  DNUR: "DNUR",
  DEBITNOTEUNREGISTERED: "DNUR",
  EXPORT: "EXPORT",
  EXPORTS: "EXPORT",
  EXP: "EXPORT",
  "6A": "EXPORT",
  NILRATED: "NIL_RATED",
  NILEXEMPTNONGST: "NIL_RATED",
  EXEMPTED: "NIL_RATED",
  "8": "NIL_RATED",
  ADVANCES: "ADVANCES",
  ADVANCERECEIVED: "ADVANCES",
  "11A": "ADVANCES",
  AMENDMENT: "AMENDMENT",
  AMENDED: "AMENDMENT",
  B2BA: "AMENDMENT",
  // An amendment OF a credit note is still a credit note: it belongs with the sign of the
  // section it amends, not with the generic (positive) amendment bucket.
  CDNRA: "CDNR",
  CDNURA: "CDNUR",
  DNRA: "DNR",
  "9A": "AMENDMENT",
});

/// Electronic credit ledger movement, as the portal's ledger download presents it.
const ECREDIT_CATEGORIES = Object.freeze([
  "OPENING_BALANCE",
  "CREDIT",
  "DEBIT",
  "CLOSING_BALANCE",
]);

const ECREDIT_CATEGORY_ALIASES = Object.freeze({
  OPENINGBALANCE: "OPENING_BALANCE",
  OPENING: "OPENING_BALANCE",
  BALANCEBROUGHTFORWARD: "OPENING_BALANCE",
  CREDIT: "CREDIT",
  CREDITED: "CREDIT",
  ITCCREDITED: "CREDIT",
  DEBIT: "DEBIT",
  DEBITED: "DEBIT",
  ITCUTILISED: "DEBIT",
  ITCUTILIZED: "DEBIT",
  CLOSINGBALANCE: "CLOSING_BALANCE",
  CLOSING: "CLOSING_BALANCE",
  BALANCE: "CLOSING_BALANCE",
});

const GST_IMPORT_SPECS = Object.freeze({
  GST_PURCHASE: {
    required: [
      "supplierGstin",
      "recipientGstin",
      "invoiceNumber",
      "documentDate",
      "documentType",
      "taxableValue",
      "igst",
      "cgst",
      "sgst",
      "cess",
    ],
    allowed: [
      "supplierGstin",
      "recipientGstin",
      "invoiceNumber",
      "documentDate",
      "documentType",
      "taxableValue",
      "igst",
      "cgst",
      "sgst",
      "cess",
      "totalTax",
      "reverseCharge",
      "placeOfSupply",
    ],
  },
  GSTR2B: {
    required: [
      "supplierGstin",
      "recipientGstin",
      "invoiceNumber",
      "documentDate",
      "documentType",
      "taxableValue",
      "igst",
      "cgst",
      "sgst",
      "cess",
    ],
    allowed: [
      "supplierGstin",
      "recipientGstin",
      "invoiceNumber",
      "documentDate",
      "documentType",
      "taxableValue",
      "igst",
      "cgst",
      "sgst",
      "cess",
      "totalTax",
      "reverseCharge",
      "placeOfSupply",
    ],
  },
  GSTR3B_SUMMARY: {
    // taxableValue is ALLOWED but not required: a Table 4 ITC row has no taxable value, while a
    // Table 3.1 outward row is meaningless without one. Requiring it would refuse every ITC-only
    // file that imports correctly today.
    required: ["category", "igst", "cgst", "sgst", "cess"],
    allowed: ["category", "taxableValue", "igst", "cgst", "sgst", "cess", "totalTax"],
  },
  GSTR1_SUMMARY: {
    required: ["category", "taxableValue", "igst", "cgst", "sgst", "cess"],
    allowed: ["category", "taxableValue", "igst", "cgst", "sgst", "cess", "totalTax"],
  },
  ECREDIT_LEDGER: {
    // A ledger movement is tax only - there is no taxable value in a credit ledger.
    required: ["category", "igst", "cgst", "sgst", "cess"],
    allowed: ["category", "igst", "cgst", "sgst", "cess", "totalTax"],
  },
});

function cleanText(value, maxLength = 240) {
  return String(value ?? "")
    .trim()
    .replace(/\0/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/javascript:/gi, "")
    .replace(/on\w+\s*=/gi, "")
    .slice(0, maxLength);
}

function normalizeGstin(value) {
  return cleanText(value, 32).replace(/\s+/g, "").toUpperCase();
}

function normalizeInvoiceNumber(value) {
  const original = cleanText(value, 120).toUpperCase();
  let normalized = original.replace(/[^A-Z0-9]/g, "");
  if (/^\d+$/.test(normalized)) normalized = normalized.replace(/^0+(?=\d)/, "");
  return { original, normalized };
}

function normalizeDocumentType(value) {
  const normalized = cleanText(value, 40)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (!normalized) return "INVOICE";
  const aliases = {
    INV: "INVOICE",
    INVOICE: "INVOICE",
    TAXINVOICE: "INVOICE",
    TAXINV: "INVOICE",
    I: "INVOICE",
    BILL: "INVOICE",
    BILLOFSUPPLY: "INVOICE",
    BOS: "INVOICE",
    B2B: "INVOICE",
    B2C: "INVOICE",
    RETAILINVOICE: "INVOICE",
    CN: "CREDIT_NOTE",
    C: "CREDIT_NOTE",
    CRN: "CREDIT_NOTE",
    CREDIT: "CREDIT_NOTE",
    CREDITNOTE: "CREDIT_NOTE",
    CRNOTE: "CREDIT_NOTE",
    DN: "DEBIT_NOTE",
    D: "DEBIT_NOTE",
    DBN: "DEBIT_NOTE",
    DEBIT: "DEBIT_NOTE",
    DEBITNOTE: "DEBIT_NOTE",
    DRNOTE: "DEBIT_NOTE",
  };
  return aliases[normalized] || normalized;
}

function normalizeDocumentDate(value, dateOrder) {
  // Accepts ISO, DD/MM/YYYY, DD-Mon-YYYY, Excel serial, YYYYMMDD, 2-digit years,
  // etc. Returns canonical ISO YYYY-MM-DD, or null when not a real date.
  // `dateOrder` is the file-level order resolved once by import-preview.service.js
  // (classifyDateColumn / resolveDateOrder) -- it decides an ambiguous row only;
  // a row that proves its own order (one field > 12) is unaffected by it.
  return parseFlexibleDateIso(cleanText(value, 40), { dateOrder });
}

function parseMoneyMinor(value, { allowBlank = true } = {}) {
  // Delegates to the robust parser: accepts ₹/Rs/INR, Indian & intl grouping,
  // parentheses/CR negatives, "/-" suffix, unicode minus. Exact integer paise.
  return parseFlexibleMoneyMinor(value, { allowBlank, nonNegative: false, field: "Amount" });
}

function formatMoneyMinor(value) {
  if (!Number.isSafeInteger(value)) throw new Error("Amount must be a safe integer");
  const negative = value < 0;
  const absolute = Math.abs(value);
  const formatted = `${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
  return negative ? `-${formatted}` : formatted;
}

function parseBoolean(value) {
  const normalized = cleanText(value, 20).toUpperCase();
  if (["Y", "YES", "TRUE", "1"].includes(normalized)) return true;
  if (["N", "NO", "FALSE", "0", ""].includes(normalized)) return false;
  throw new Error("Expected yes/no boolean value");
}

function addSafeIntegers(values) {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total)) throw new Error("Tax total exceeds safe integer range");
  return total;
}

function categoryToken(value) {
  return cleanText(value, 80)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function normalizeGstr3bCategory(value) {
  return GSTR3B_CATEGORY_ALIASES[categoryToken(value)] || null;
}

function normalizeGstr1Category(value) {
  return GSTR1_CATEGORY_ALIASES[categoryToken(value)] || null;
}

function normalizeEcreditCategory(value) {
  return ECREDIT_CATEGORY_ALIASES[categoryToken(value)] || null;
}

/**
 * Every label that is DATA rather than a totals footer, for one import kind.
 *
 * Built from the real alias tables above, never a hand-written copy, so a category added there is
 * automatically protected here. import-shape.service.js strips rows whose first cell reads as a
 * totals line ("Total", "Opening Balance", "Closing Balance"), which is right for an invoice
 * register and catastrophic for an electronic credit ledger, whose rows carry exactly those words.
 */
function summaryRowDataLabels(kind) {
  const source =
    kind === "ECREDIT_LEDGER"
      ? [...ECREDIT_CATEGORIES, ...Object.keys(ECREDIT_CATEGORY_ALIASES)]
      : kind === "GSTR1_SUMMARY"
        ? [...GSTR1_CATEGORIES, ...Object.keys(GSTR1_CATEGORY_ALIASES)]
        : kind === "GSTR3B_SUMMARY"
          ? [...GSTR3B_CATEGORIES, ...Object.keys(GSTR3B_CATEGORY_ALIASES)]
          : [];
  return source;
}

/// True for a GSTR-3B row that belongs to Table 3.1 rather than Table 4.
function isGstr3bOutwardCategory(category) {
  return GSTR3B_OUTWARD_CATEGORIES.includes(category);
}

function calculateGstr3bClaimed(rows) {
  const byCategory = new Map(
    GSTR3B_CATEGORIES.map((category) => [category, []])
  );
  for (const source of rows) {
    const row = typeof source?.toObject === "function" ? source.toObject() : source;
    const category = normalizeGstr3bCategory(row?.summaryCategory);
    if (!category) throw userFacingError("GSTR-3B summary contains an unsupported category");
    for (const field of ["igstMinor", "cgstMinor", "sgstMinor", "cessMinor"]) {
      if (Number(row?.[field] || 0) < 0) {
        throw userFacingError("GSTR-3B category amounts must be non-negative");
      }
    }
    byCategory.get(category).push(row);
  }

  const claimedRows = byCategory.get("ITC_CLAIMED");
  const availableRows = byCategory.get("ITC_AVAILABLE");
  const reversalRows = byCategory.get("ITC_REVERSED");
  if (claimedRows.length && (availableRows.length || reversalRows.length)) {
    throw userFacingError(
      "GSTR-3B summary cannot mix net ITC claimed with gross available or reversal rows"
    );
  }
  if (!claimedRows.length && !availableRows.length) {
    throw userFacingError(NO_ITC_ROWS_MESSAGE);
  }

  const fields = ["igstMinor", "cgstMinor", "sgstMinor", "cessMinor"];
  const result = {};
  const basis = claimedRows.length ? "NET_ITC_CLAIMED" : "AVAILABLE_LESS_REVERSALS";
  for (const field of fields) {
    const claimed = addSafeIntegers(claimedRows.map((row) => Number(row?.[field] || 0)));
    const available = addSafeIntegers(availableRows.map((row) => Number(row?.[field] || 0)));
    const reversed = addSafeIntegers(reversalRows.map((row) => Number(row?.[field] || 0)));
    result[field] = claimedRows.length
      ? claimed
      : addSafeIntegers([available, -reversed]);
  }
  result.totalTaxMinor = addSafeIntegers(fields.map((field) => result[field]));
  return { claimed: result, basis };
}

const TAX_MINOR_FIELDS = Object.freeze(["igstMinor", "cgstMinor", "sgstMinor", "cessMinor"]);

function plainRow(source) {
  return typeof source?.toObject === "function" ? source.toObject() : source;
}

function emptyTotals() {
  return {
    taxableValueMinor: 0,
    igstMinor: 0,
    cgstMinor: 0,
    sgstMinor: 0,
    cessMinor: 0,
    totalTaxMinor: 0,
  };
}

function withTotalTax(totals) {
  return {
    ...totals,
    totalTaxMinor: addSafeIntegers(TAX_MINOR_FIELDS.map((field) => totals[field] || 0)),
  };
}

/**
 * Outward supply declared in GSTR-3B Table 3.1, or null when the file carries no Table 3.1 rows.
 *
 * Only taxable and zero-rated supplies count. Nil-rated, exempt and non-GST supplies carry no tax
 * and are excluded on both sides of the comparison; inward reverse charge is not outward supply at
 * all, and adding it would inflate declared turnover by the value of a firm's own purchases.
 *
 * Returns null rather than zeroes for an ITC-only return, so the caller can tell "this return
 * declared nothing" apart from "this return's outward half was never imported".
 */
function calculateGstr3bOutward(rows) {
  const outwardRows = [];
  for (const source of rows || []) {
    const row = plainRow(source);
    const category = normalizeGstr3bCategory(row?.summaryCategory);
    if (category && GSTR3B_TURNOVER_CATEGORIES.includes(category)) outwardRows.push(row);
  }

  if (!outwardRows.length) return null;

  const totals = emptyTotals();
  totals.taxableValueMinor = addSafeIntegers(
    outwardRows.map((row) => Number(row?.taxableValueMinor || 0))
  );
  for (const field of TAX_MINOR_FIELDS) {
    totals[field] = addSafeIntegers(outwardRows.map((row) => Number(row?.[field] || 0)));
  }
  return withTotalTax(totals);
}

/**
 * Outward supply declared in GSTR-1, or null when no turnover-bearing section was imported.
 *
 * Credit and debit notes are SUBTRACTED. They arrive as positive amounts under a CDNR/CDNUR
 * category, because that is how the return states them, and the reduction is applied here from
 * the category rather than expected as a negative in the file. Doing it the other way round is
 * the easiest way to make a turnover reconciliation lie by twice the value of every credit note.
 */
function calculateGstr1Outward(rows) {
  const relevant = [];
  for (const source of rows || []) {
    const row = plainRow(source);
    const category = normalizeGstr1Category(row?.summaryCategory);
    if (category && GSTR1_TURNOVER_CATEGORIES.includes(category)) {
      relevant.push({ row, category });
    }
  }

  if (!relevant.length) return null;

  const signed = (row, category, field) => {
    const value = Number(row?.[field] || 0);
    return GSTR1_NEGATIVE_CATEGORIES.includes(category) ? -value : value;
  };

  const totals = emptyTotals();
  totals.taxableValueMinor = addSafeIntegers(
    relevant.map(({ row, category }) => signed(row, category, "taxableValueMinor"))
  );
  for (const field of TAX_MINOR_FIELDS) {
    totals[field] = addSafeIntegers(
      relevant.map(({ row, category }) => signed(row, category, field))
    );
  }
  return withTotalTax(totals);
}

/**
 * The electronic credit ledger's closing balance, or null when no ledger was imported.
 *
 * A file may state the closing balance outright, or state opening plus movements. Both are
 * accepted, and a stated closing balance WINS over a computed one: the portal's own figure is the
 * authority, and quietly preferring our arithmetic over the government's would be the wrong way
 * round. When both are present and they disagree, the disagreement is reported rather than hidden.
 */
function calculateCreditLedgerBalance(rows) {
  const buckets = new Map(ECREDIT_CATEGORIES.map((category) => [category, []]));
  let sawAny = false;

  for (const source of rows || []) {
    const row = plainRow(source);
    const category = normalizeEcreditCategory(row?.summaryCategory);
    if (!category) continue;
    sawAny = true;
    buckets.get(category).push(row);
  }

  if (!sawAny) return null;

  const sum = (list, field) => addSafeIntegers(list.map((row) => Number(row?.[field] || 0)));

  const stated = buckets.get("CLOSING_BALANCE");
  const opening = buckets.get("OPENING_BALANCE");
  const credits = buckets.get("CREDIT");
  const debits = buckets.get("DEBIT");

  const computed = emptyTotals();
  for (const field of TAX_MINOR_FIELDS) {
    computed[field] = addSafeIntegers([
      sum(opening, field),
      sum(credits, field),
      -sum(debits, field),
    ]);
  }

  const hasMovement = opening.length > 0 || credits.length > 0 || debits.length > 0;

  // The credit the ledger RECEIVED in this period, kept separate from the closing balance.
  //
  // These answer different questions and must not be confused. The closing balance is a STOCK: it
  // carries forward whatever was already sitting in the ledger and is reduced by every utilisation
  // in the period. The credit received is a FLOW, and it is the only figure that can be compared
  // with the ITC a return claimed. Comparing a claim against the closing balance lets a brought-
  // forward opening balance cancel a real shortfall - a firm claiming 45,000 whose ledger received
  // only 20,000 reads as agreeing, if 25,000 was carried in - and raises a false exception against
  // every firm that lawfully utilised credit during the month.
  const credited = emptyTotals();
  for (const field of TAX_MINOR_FIELDS) credited[field] = sum(credits, field);

  const movement = {
    credited: withTotalTax(credited),
    hasCreditMovement: credits.length > 0,
  };

  if (!stated.length) {
    if (!hasMovement) return null;
    return {
      closing: withTotalTax(computed),
      basis: "COMPUTED_FROM_MOVEMENT",
      statedDiffers: false,
      ...movement,
    };
  }

  const statedTotals = emptyTotals();
  for (const field of TAX_MINOR_FIELDS) {
    statedTotals[field] = sum(stated, field);
  }

  const statedDiffers =
    hasMovement && TAX_MINOR_FIELDS.some((field) => statedTotals[field] !== computed[field]);

  return {
    closing: withTotalTax(statedTotals),
    basis: "STATED_IN_FILE",
    statedDiffers,
    computed: hasMovement ? withTotalTax(computed) : null,
    ...movement,
  };
}

/**
 * Reads a GSTR-3B summary for BOTH halves, and refuses only when neither half is present.
 *
 * The import path used to call calculateGstr3bClaimed directly, which throws unless Table 4 ITC
 * rows exist. Once Table 3.1 rows became importable that would have rejected an outward-only
 * return - a perfectly valid file - with a message about ITC that its uploader could do nothing
 * about.
 */
const NO_ITC_ROWS_MESSAGE = "GSTR-3B summary requires ITC_CLAIMED or ITC_AVAILABLE rows";

function calculateGstr3bControlTotals(rows) {
  let claimed = null;
  let claimedBasis = null;
  let missingItcRows = false;

  try {
    const itc = calculateGstr3bClaimed(rows);
    claimed = itc.claimed;
    claimedBasis = itc.basis;
  } catch (error) {
    // ONLY "there are no ITC rows" may be tolerated, and only because an outward-only return is
    // a legitimate file. Every other complaint - an unsupported category, a negative amount, net
    // ITC mixed with gross - is a defect in the file itself and must still stop the import,
    // whether or not Table 3.1 happens to be readable. Swallowing those would let a return with a
    // bad ITC row import silently and then reconcile against a figure nobody checked.
    if (error?.message !== NO_ITC_ROWS_MESSAGE) throw error;
    missingItcRows = true;
  }

  const outward = calculateGstr3bOutward(rows);

  if (missingItcRows && !outward) {
    throw userFacingError(NO_ITC_ROWS_MESSAGE);
  }

  return { claimed, claimedBasis, outward };
}

function normalizeGstImportRow(kind, input, { dateOrder } = {}) {
  const errors = [];
  const warnings = [];
  const addError = (field, code, message = "") => errors.push({ field, code, message });
  const addWarning = (field, code) => warnings.push({ field, code });
  const money = {};

  for (const field of ["taxableValue", "igst", "cgst", "sgst", "cess", "totalTax"]) {
    if (!Object.prototype.hasOwnProperty.call(input, field) && field === "totalTax") continue;
    try {
      money[field] = parseMoneyMinor(input[field]);
    } catch (error) {
      money[field] = 0;
      addError(
        field,
        "INVALID_MONEY",
        // V13-P12-F2: forward the parser's authored "<column> cannot be negative"
        // copy, but never the text of an unexpected exception.
        userFacingMessage(error, `${field} is not an amount we can read.`),
      );
    }
  }

  const computedTotal = addSafeIntegers([
    money.igst || 0,
    money.cgst || 0,
    money.sgst || 0,
    money.cess || 0,
  ]);
  if (money.totalTax != null && money.totalTax !== computedTotal) {
    addWarning("totalTax", "TAX_HEAD_TOTAL_MISMATCH");
  }

  if (kind === "GSTR3B_SUMMARY") {
    const summaryCategory = normalizeGstr3bCategory(input.category);
    if (!summaryCategory) {
      addError(
        "category",
        "INVALID_GSTR3B_CATEGORY",
        `Category must be one of ${GSTR3B_CATEGORIES.join(", ")}`
      );
    }
    for (const field of ["igst", "cgst", "sgst", "cess"]) {
      if (Number(money[field] || 0) < 0) {
        addError(
          field,
          "NEGATIVE_GSTR3B_AMOUNT",
          "GSTR-3B category amounts must be non-negative"
        );
      }
    }
    return {
      values: {
        summaryCategory: summaryCategory || "",
        // Carried now rather than zeroed. A Table 3.1 outward row's whole point is its taxable
        // value, and discarding it made the turnover half of the return unreadable. Table 4 ITC
        // rows still arrive with none, so this is 0 for them exactly as before.
        taxableValueMinor: money.taxableValue || 0,
        igstMinor: money.igst || 0,
        cgstMinor: money.cgst || 0,
        sgstMinor: money.sgst || 0,
        cessMinor: money.cess || 0,
        totalTaxMinor: computedTotal,
      },
      errors,
      warnings,
    };
  }

  if (kind === "GSTR1_SUMMARY" || kind === "ECREDIT_LEDGER") {
    const isLedger = kind === "ECREDIT_LEDGER";
    const summaryCategory = isLedger
      ? normalizeEcreditCategory(input.category)
      : normalizeGstr1Category(input.category);

    if (!summaryCategory) {
      addError(
        "category",
        isLedger ? "INVALID_ECREDIT_CATEGORY" : "INVALID_GSTR1_CATEGORY",
        `Category must be one of ${(isLedger ? ECREDIT_CATEGORIES : GSTR1_CATEGORIES).join(", ")}`
      );
    }

    // Non-negative for the same reason GSTR-3B rows are: a credit note reduces turnover through
    // its CATEGORY, not through a negative amount. A file that encodes the reduction twice - a
    // CDNR row carrying a negative value - would be added back in and silently overstate turnover.
    for (const field of ["taxableValue", "igst", "cgst", "sgst", "cess"]) {
      if (Number(money[field] || 0) < 0) {
        addError(
          field,
          isLedger ? "NEGATIVE_ECREDIT_AMOUNT" : "NEGATIVE_GSTR1_AMOUNT",
          isLedger
            ? "Credit ledger amounts must be non-negative"
            : "GSTR-1 category amounts must be non-negative; a credit note reduces turnover through its category"
        );
      }
    }

    return {
      values: {
        summaryCategory: summaryCategory || "",
        taxableValueMinor: isLedger ? 0 : money.taxableValue || 0,
        igstMinor: money.igst || 0,
        cgstMinor: money.cgst || 0,
        sgstMinor: money.sgst || 0,
        cessMinor: money.cess || 0,
        totalTaxMinor: computedTotal,
      },
      errors,
      warnings,
    };
  }

  const supplierGstin = normalizeGstin(input.supplierGstin);
  const recipientGstin = normalizeGstin(input.recipientGstin);
  const invoice = normalizeInvoiceNumber(input.invoiceNumber);
  const documentDate = normalizeDocumentDate(input.documentDate, dateOrder);
  const documentType = normalizeDocumentType(input.documentType);
  let reverseCharge = false;

  if (!GSTIN_PATTERN.test(supplierGstin)) addError("supplierGstin", "INVALID_GSTIN");
  if (!GSTIN_PATTERN.test(recipientGstin)) addError("recipientGstin", "INVALID_GSTIN");
  if (!invoice.original || !invoice.normalized) addError("invoiceNumber", "REQUIRED");
  if (!documentDate) addError("documentDate", "INVALID_DATE");
  if (!documentType) addError("documentType", "REQUIRED");
  try {
    reverseCharge = parseBoolean(input.reverseCharge);
  } catch (error) {
    addError(
        "reverseCharge",
        "INVALID_BOOLEAN",
        userFacingMessage(error, "Reverse charge must read as yes or no."),
      );
  }

  return {
    values: {
      supplierGstin,
      recipientGstin,
      invoiceNumberOriginal: invoice.original,
      invoiceNumberNormalized: invoice.normalized,
      documentDate,
      documentType,
      taxableValueMinor: money.taxableValue || 0,
      igstMinor: money.igst || 0,
      cgstMinor: money.cgst || 0,
      sgstMinor: money.sgst || 0,
      cessMinor: money.cess || 0,
      totalTaxMinor: computedTotal,
      reverseCharge,
      placeOfSupply: cleanText(input.placeOfSupply, 80).toUpperCase(),
      summaryCategory: "",
    },
    errors,
    warnings,
  };
}

function dateDifferenceDays(left, right) {
  if (!left || !right) return null;
  const leftMs = Date.parse(`${left}T00:00:00.000Z`);
  const rightMs = Date.parse(`${right}T00:00:00.000Z`);
  if (!Number.isFinite(leftMs) || !Number.isFinite(rightMs)) return null;
  return Math.round((leftMs - rightMs) / 86_400_000);
}

function isValidGstin(value) {
  return GSTIN_PATTERN.test(normalizeGstin(value));
}

function isValidPeriod(value) {
  return PERIOD_PATTERN.test(String(value || ""));
}

export {
  ECREDIT_CATEGORIES,
  GST_IMPORT_SPECS,
  summaryRowDataLabels,
  GSTR1_CATEGORIES,
  GSTR3B_CATEGORIES,
  GSTR3B_OUTWARD_CATEGORIES,
  GSTIN_PATTERN,
  PERIOD_PATTERN,
  addSafeIntegers,
  calculateCreditLedgerBalance,
  calculateGstr1Outward,
  calculateGstr3bClaimed,
  calculateGstr3bControlTotals,
  calculateGstr3bOutward,
  cleanText,
  dateDifferenceDays,
  formatMoneyMinor,
  isValidGstin,
  isValidPeriod,
  normalizeDocumentDate,
  normalizeDocumentType,
  normalizeGstImportRow,
  normalizeEcreditCategory,
  normalizeGstr1Category,
  normalizeGstr3bCategory,
  normalizeGstin,
  isGstr3bOutwardCategory,
  normalizeInvoiceNumber,
  parseMoneyMinor,
};
