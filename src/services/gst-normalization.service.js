import {
  parseFlexibleDateIso,
  parseFlexibleMoneyMinor,
} from "./robust-normalize.service.js";

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
});

const GSTR3B_CATEGORIES = Object.freeze([
  "ITC_CLAIMED",
  "ITC_AVAILABLE",
  "ITC_REVERSED",
  "ITC_INELIGIBLE",
]);

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

function normalizeGstr3bCategory(value) {
  const normalized = cleanText(value, 80)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return GSTR3B_CATEGORY_ALIASES[normalized] || null;
}

function calculateGstr3bClaimed(rows) {
  const byCategory = new Map(
    GSTR3B_CATEGORIES.map((category) => [category, []])
  );
  for (const source of rows) {
    const row = typeof source?.toObject === "function" ? source.toObject() : source;
    const category = normalizeGstr3bCategory(row?.summaryCategory);
    if (!category) throw new Error("GSTR-3B summary contains an unsupported category");
    for (const field of ["igstMinor", "cgstMinor", "sgstMinor", "cessMinor"]) {
      if (Number(row?.[field] || 0) < 0) {
        throw new Error("GSTR-3B category amounts must be non-negative");
      }
    }
    byCategory.get(category).push(row);
  }

  const claimedRows = byCategory.get("ITC_CLAIMED");
  const availableRows = byCategory.get("ITC_AVAILABLE");
  const reversalRows = byCategory.get("ITC_REVERSED");
  if (claimedRows.length && (availableRows.length || reversalRows.length)) {
    throw new Error(
      "GSTR-3B summary cannot mix net ITC claimed with gross available or reversal rows"
    );
  }
  if (!claimedRows.length && !availableRows.length) {
    throw new Error("GSTR-3B summary requires ITC_CLAIMED or ITC_AVAILABLE rows");
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
      addError(field, "INVALID_MONEY", error.message);
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
        taxableValueMinor: 0,
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
    addError("reverseCharge", "INVALID_BOOLEAN", error.message);
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
  GST_IMPORT_SPECS,
  GSTR3B_CATEGORIES,
  GSTIN_PATTERN,
  PERIOD_PATTERN,
  addSafeIntegers,
  calculateGstr3bClaimed,
  cleanText,
  dateDifferenceDays,
  formatMoneyMinor,
  isValidGstin,
  isValidPeriod,
  normalizeDocumentDate,
  normalizeDocumentType,
  normalizeGstImportRow,
  normalizeGstr3bCategory,
  normalizeGstin,
  normalizeInvoiceNumber,
  parseMoneyMinor,
};
