import { createHash } from "node:crypto";
import {
  aliasLookup,
  parseFlexibleDateIso,
  parseFlexibleMoneyMinor,
} from "./robust-normalize.service.js";

// Bumped to v2 when dateOrder joined the fingerprint material (C3) -- a batch
// committed under v1 will not replay against a re-submission of the same file.
// See GST_IMPORT_NORMALIZATION_VERSION in gst-import.service.js for why.
const TDS_NORMALIZATION_VERSION = "tds-import-v2";

// Label alias tables (keys are UPPERCASE alphanumeric-only; see aliasLookup).
const FILING_STATUS_ALIASES = Object.freeze({
  FILED: "FILED", EFILED: "FILED", ORIGINAL: "FILED", ORIGINALFILED: "FILED",
  NOTFILED: "NOT_FILED", NOTYETFILED: "NOT_FILED", UNFILED: "NOT_FILED",
  CORRECTIONPENDING: "CORRECTION_PENDING", REVISIONPENDING: "CORRECTION_PENDING",
  CORRECTED: "CORRECTED", REVISED: "CORRECTED",
});
const CORRECTION_STATUS_ALIASES = Object.freeze({
  NONE: "NONE", NA: "NONE", NIL: "NONE", ORIGINAL: "NONE", ORIGINALRETURN: "NONE", NOCORRECTION: "NONE",
  PENDING: "PENDING", REQUIRED: "PENDING", INPROGRESS: "PENDING",
  COMPLETED: "COMPLETED", DONE: "COMPLETED", CORRECTED: "COMPLETED", FILED: "COMPLETED",
});
const CERT_STATUS_ALIASES = Object.freeze({
  NOTTRACKED: "NOT_TRACKED", NONE: "NOT_TRACKED", NA: "NOT_TRACKED", NIL: "NOT_TRACKED",
  PENDING: "PENDING", NOTISSUED: "PENDING", INPROGRESS: "PENDING",
  ISSUED: "ISSUED", GENERATED: "ISSUED", DONE: "ISSUED", DELIVERED: "ISSUED",
});
const CERT_TYPE_ALIASES = Object.freeze({
  FORM16: "FORM_16", FORM16A: "FORM_16A", "16": "FORM_16", "16A": "FORM_16A",
  FORM_16: "FORM_16", FORM_16A: "FORM_16A",
});
const TDS_IMPORT_KINDS = Object.freeze([
  "TDS_DEDUCTIONS",
  "TDS_CHALLANS",
  "TDS_STATEMENTS",
  "TDS_26AS",
]);
const TDS_STATEMENT_TYPES = Object.freeze(["24Q", "26Q", "27Q"]);
const TDS_QUARTERS = Object.freeze(["Q1", "Q2", "Q3", "Q4"]);
const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const TAN_PATTERN = /^[A-Z]{4}[0-9]{5}[A-Z]$/;

const TDS_IMPORT_SPECS = Object.freeze({
  TDS_DEDUCTIONS: {
    required: ["transactionDate", "amountPaid", "deductedAmount"],
    allowed: [
      "deducteeName", "deducteePan", "sectionCode", "transactionDate",
      "amountPaid", "deductedAmount", "surcharge", "cess",
    ],
  },
  TDS_CHALLANS: {
    required: ["bsrCode", "challanSerial", "challanDate", "depositedAmount"],
    allowed: ["bsrCode", "challanSerial", "challanDate", "depositedAmount", "sectionCode"],
  },
  TDS_STATEMENTS: {
    required: ["filingStatus", "reportedAmount"],
    allowed: [
      "filingStatus", "statementReference", "filedDate", "reportedAmount",
      "deducteePan", "sectionCode", "correctionStatus", "correctionReference",
      "certificateStatus", "certificateType",
    ],
  },
  TDS_26AS: {
    required: ["deducteePan", "creditDate", "creditedAmount", "sourceReference"],
    allowed: ["deducteeName", "deducteePan", "creditDate", "creditedAmount", "sectionCode", "sourceReference"],
  },
});

const SOURCE_LABELS = Object.freeze({
  TDS_DEDUCTIONS: "User-imported deduction register",
  TDS_CHALLANS: "User-imported ITNS 281 challan evidence",
  TDS_STATEMENTS: "User-imported quarterly TDS statement data",
  TDS_26AS: "Optional user-imported 26AS/TRACES evidence",
});

function normalizeCode(value) {
  return String(value || "").trim().toUpperCase();
}

function parseMinorUnits(value, { field, required = false, nonNegative = true } = {}) {
  // Robust superset: ₹/Rs/INR, Indian & intl grouping, "/-", CR/DR, unicode minus.
  return parseFlexibleMoneyMinor(value, { allowBlank: !required, nonNegative, field });
}

function addSafeMinorUnits(values) {
  let total = 0n;
  for (const value of values) {
    if (!Number.isSafeInteger(value)) throw new Error("Currency total contains an unsafe integer");
    total += BigInt(value);
  }
  if (total > BigInt(Number.MAX_SAFE_INTEGER) || total < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error("Currency total exceeds safe integer range");
  }
  return Number(total);
}

function normalizeIsoDay(value, { field, required = false, dateOrder } = {}) {
  const normalized = String(value || "").trim();
  if (!normalized && !required) return "";
  const iso = parseFlexibleDateIso(normalized, { dateOrder });
  if (!iso) throw new Error(`${field} must be a real date (YYYY-MM-DD or common formats)`);
  return iso;
}

function validateFinancialYear(value) {
  const normalized = String(value || "").trim();
  const match = /^(\d{4})-(\d{2})$/.exec(normalized);
  if (!match) return false;
  return (Number(match[1]) + 1) % 100 === Number(match[2]);
}

function normalizeTdsContext({ tan, financialYear, quarter, statementType }) {
  const normalizedTan = normalizeCode(tan);
  const normalizedFinancialYear = String(financialYear || "").trim();
  const normalizedQuarter = normalizeCode(quarter);
  const normalizedStatementType = normalizeCode(statementType).replace(/[^A-Z0-9]/g, "");
  if (["GSTR7", "GSTR-7"].includes(normalizeCode(statementType))) {
    throw new Error("GSTR-7 is GST TDS evidence and cannot be used for Income-tax TDS health");
  }
  if (!TAN_PATTERN.test(normalizedTan)) throw new Error("TAN must match AAAA99999A format");
  if (!validateFinancialYear(normalizedFinancialYear)) throw new Error("Financial year must be consecutive YYYY-YY");
  if (!TDS_QUARTERS.includes(normalizedQuarter)) throw new Error("Quarter must be Q1, Q2, Q3, or Q4");
  if (!TDS_STATEMENT_TYPES.includes(normalizedStatementType)) {
    throw new Error(
      "Statement type must be 24Q, 26Q, or 27Q; 27EQ/TCS is unavailable until collection, collectee, and Form 27D support is implemented"
    );
  }
  return {
    tan: normalizedTan,
    financialYear: normalizedFinancialYear,
    quarter: normalizedQuarter,
    statementType: normalizedStatementType,
  };
}

function localPanFormatStatus(value) {
  const pan = normalizeCode(value);
  if (!pan) return "MISSING";
  return PAN_PATTERN.test(pan) ? "FORMAT_VALID" : "FORMAT_INVALID";
}

function normalizeTdsImportRow(kind, mapped, { dateOrder } = {}) {
  const normalizedKind = normalizeCode(kind);
  if (["GSTR7", "GSTR-7"].includes(normalizedKind)) {
    throw new Error("GSTR-7 is not Income-tax TDS evidence");
  }
  if (!TDS_IMPORT_KINDS.includes(normalizedKind)) throw new Error(`Unsupported TDS import kind: ${normalizedKind}`);
  const values = {};
  const errors = [];
  const warnings = [];
  const capture = (field, callback) => {
    try {
      values[field] = callback();
    } catch (error) {
      errors.push({ field, code: "INVALID_VALUE", message: error.message });
    }
  };

  if (normalizedKind === "TDS_DEDUCTIONS") {
    values.deducteeName = String(mapped.deducteeName || "").trim();
    values.deducteePan = normalizeCode(mapped.deducteePan);
    values.sectionCode = normalizeCode(mapped.sectionCode);
    capture("transactionDate", () => normalizeIsoDay(mapped.transactionDate, { field: "transactionDate", required: true, dateOrder }));
    capture("amountPaidMinor", () => parseMinorUnits(mapped.amountPaid, { field: "amountPaid", required: true, nonNegative: true }));
    capture("deductedMinor", () => parseMinorUnits(mapped.deductedAmount, { field: "deductedAmount", required: true, nonNegative: true }));
    capture("surchargeMinor", () => parseMinorUnits(mapped.surcharge, { field: "surcharge", nonNegative: true }));
    capture("cessMinor", () => parseMinorUnits(mapped.cess, { field: "cess", nonNegative: true }));
    const panStatus = localPanFormatStatus(values.deducteePan);
    if (panStatus === "MISSING") warnings.push({ field: "deducteePan", code: "PAN_MISSING", message: "PAN is missing; health review will flag it" });
    if (panStatus === "FORMAT_INVALID") warnings.push({ field: "deducteePan", code: "PAN_FORMAT_INVALID", message: "Local PAN format check failed; this is not portal verification" });
    if (!values.sectionCode) warnings.push({ field: "sectionCode", code: "SECTION_REVIEW_REQUIRED", message: "Section is missing; no rate is inferred" });
  } else if (normalizedKind === "TDS_CHALLANS") {
    values.bsrCode = String(mapped.bsrCode || "").trim();
    values.challanSerial = String(mapped.challanSerial || "").trim();
    values.sectionCode = normalizeCode(mapped.sectionCode);
    if (!/^\d{7}$/.test(values.bsrCode)) errors.push({ field: "bsrCode", code: "INVALID_BSR", message: "ITNS 281 BSR code must contain 7 digits" });
    if (!/^\d{1,5}$/.test(values.challanSerial)) errors.push({ field: "challanSerial", code: "INVALID_CHALLAN_SERIAL", message: "Challan serial must contain 1 to 5 digits" });
    capture("challanDate", () => normalizeIsoDay(mapped.challanDate, { field: "challanDate", required: true, dateOrder }));
    capture("depositedMinor", () => parseMinorUnits(mapped.depositedAmount, { field: "depositedAmount", required: true, nonNegative: true }));
  } else if (normalizedKind === "TDS_STATEMENTS") {
    values.filingStatus = aliasLookup(mapped.filingStatus, FILING_STATUS_ALIASES, normalizeCode(mapped.filingStatus));
    values.statementReference = String(mapped.statementReference || "").trim();
    values.deducteePan = normalizeCode(mapped.deducteePan);
    values.sectionCode = normalizeCode(mapped.sectionCode);
    values.correctionStatus = aliasLookup(mapped.correctionStatus, CORRECTION_STATUS_ALIASES, mapped.correctionStatus ? normalizeCode(mapped.correctionStatus) : "NONE");
    values.correctionReference = String(mapped.correctionReference || "").trim();
    values.certificateStatus = aliasLookup(mapped.certificateStatus, CERT_STATUS_ALIASES, mapped.certificateStatus ? normalizeCode(mapped.certificateStatus) : "NOT_TRACKED");
    values.certificateType = aliasLookup(mapped.certificateType, CERT_TYPE_ALIASES, normalizeCode(mapped.certificateType));
    if (!["NOT_FILED", "FILED", "CORRECTION_PENDING", "CORRECTED"].includes(values.filingStatus)) {
      errors.push({ field: "filingStatus", code: "INVALID_FILING_STATUS", message: "Filing status must be NOT_FILED, FILED, CORRECTION_PENDING, or CORRECTED" });
    }
    if (!["NONE", "PENDING", "COMPLETED"].includes(values.correctionStatus)) {
      errors.push({ field: "correctionStatus", code: "INVALID_CORRECTION_STATUS" });
    }
    if (!["NOT_TRACKED", "PENDING", "ISSUED"].includes(values.certificateStatus)) {
      errors.push({ field: "certificateStatus", code: "INVALID_CERTIFICATE_STATUS" });
    }
    if (values.certificateType && !["FORM_16", "FORM_16A"].includes(values.certificateType)) {
      errors.push({ field: "certificateType", code: "INVALID_CERTIFICATE_TYPE" });
    }
    capture("filedDate", () => normalizeIsoDay(mapped.filedDate, { field: "filedDate", dateOrder }));
    capture("reportedMinor", () => parseMinorUnits(mapped.reportedAmount, { field: "reportedAmount", required: true, nonNegative: true }));
    if (["FILED", "CORRECTED"].includes(values.filingStatus) && !values.filedDate) {
      warnings.push({ field: "filedDate", code: "FILED_DATE_MISSING" });
    }
    if (values.deducteePan && localPanFormatStatus(values.deducteePan) === "FORMAT_INVALID") {
      warnings.push({ field: "deducteePan", code: "PAN_FORMAT_INVALID", message: "Local PAN format check failed; this is not portal verification" });
    }
  } else {
    values.deducteeName = String(mapped.deducteeName || "").trim();
    values.deducteePan = normalizeCode(mapped.deducteePan);
    values.sectionCode = normalizeCode(mapped.sectionCode);
    values.sourceReference = String(mapped.sourceReference || "").trim();
    capture("creditDate", () => normalizeIsoDay(mapped.creditDate, { field: "creditDate", required: true, dateOrder }));
    capture("creditedMinor", () => parseMinorUnits(mapped.creditedAmount, { field: "creditedAmount", required: true, nonNegative: true }));
    if (localPanFormatStatus(values.deducteePan) !== "FORMAT_VALID") {
      warnings.push({ field: "deducteePan", code: "PAN_REVIEW_REQUIRED", message: "Imported credit PAN cannot be matched confidently" });
    }
  }

  return { values, errors, warnings };
}

function summarizeTdsRows(kind, rows) {
  const values = rows.map((row) => row.values || row);
  const baseDeductedMinor = addSafeMinorUnits(values.map((row) => row.deductedMinor || 0));
  const surchargeMinor = addSafeMinorUnits(values.map((row) => row.surchargeMinor || 0));
  const cessMinor = addSafeMinorUnits(values.map((row) => row.cessMinor || 0));
  const totals = {
    amountPaidMinor: addSafeMinorUnits(values.map((row) => row.amountPaidMinor || 0)),
    baseDeductedMinor,
    surchargeMinor,
    cessMinor,
    deductedMinor: addSafeMinorUnits([baseDeductedMinor, surchargeMinor, cessMinor]),
    depositedMinor: addSafeMinorUnits(values.map((row) => row.depositedMinor || 0)),
    reportedMinor: addSafeMinorUnits(values.map((row) => row.reportedMinor || 0)),
    creditedMinor: addSafeMinorUnits(values.map((row) => row.creditedMinor || 0)),
  };
  return { ...totals, sourceLabel: SOURCE_LABELS[kind] || "User-imported TDS source" };
}

function fingerprintTdsRow(kind, values) {
  return createHash("sha256")
    .update(JSON.stringify({ kind, values }))
    .digest("hex");
}

export {
  PAN_PATTERN,
  SOURCE_LABELS,
  TAN_PATTERN,
  TDS_IMPORT_KINDS,
  TDS_IMPORT_SPECS,
  TDS_NORMALIZATION_VERSION,
  TDS_QUARTERS,
  TDS_STATEMENT_TYPES,
  addSafeMinorUnits,
  fingerprintTdsRow,
  localPanFormatStatus,
  normalizeTdsContext,
  normalizeTdsImportRow,
  parseMinorUnits,
  summarizeTdsRows,
  validateFinancialYear,
};
