import mongoose from "mongoose";

const TDS_IMPORT_KINDS = Object.freeze([
  "TDS_DEDUCTIONS",
  "TDS_CHALLANS",
  "TDS_STATEMENTS",
  "TDS_26AS",
]);
const TDS_STATEMENT_TYPES = Object.freeze(["24Q", "26Q", "27Q", "27EQ"]);
const TDS_QUARTERS = Object.freeze(["Q1", "Q2", "Q3", "Q4"]);
const TDS_FILING_STATUSES = Object.freeze([
  "NOT_FILED",
  "FILED",
  "CORRECTION_PENDING",
  "CORRECTED",
]);
const TDS_CORRECTION_STATUSES = Object.freeze(["NONE", "PENDING", "COMPLETED"]);
const TDS_CERTIFICATE_STATUSES = Object.freeze(["NOT_TRACKED", "PENDING", "ISSUED"]);

const safeInteger = {
  validator: (value) => value == null || Number.isSafeInteger(value),
  message: "{PATH} must be a safe integer in the smallest currency unit",
};
const isoDay = {
  validator: (value) => !value || /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value),
  message: "{PATH} must be an ISO calendar day",
};

const TdsImportRowSchema = new mongoose.Schema(
  {
    firmId: { type: mongoose.Schema.Types.ObjectId, ref: "Firm", required: true },
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: "Client", required: true },
    batchId: { type: mongoose.Schema.Types.ObjectId, ref: "ImportBatch", required: true },
    importGeneration: { type: String, required: true, trim: true, maxlength: 80 },
    kind: { type: String, enum: TDS_IMPORT_KINDS, required: true },
    sourceRow: { type: Number, required: true, min: 2 },
    sourceHash: { type: String, required: true, trim: true, match: /^[a-f0-9]{64}$/i },
    rowFingerprint: { type: String, required: true, trim: true, match: /^[a-f0-9]{64}$/i },
    normalizationVersion: { type: String, required: true, trim: true, maxlength: 80 },
    dateOrder: { type: String, enum: ["", "DAY_FIRST", "MONTH_FIRST", "NOT_APPLICABLE"], default: "" },
    sourceLabel: { type: String, required: true, trim: true, maxlength: 160 },
    tan: { type: String, required: true, uppercase: true, trim: true, match: /^[A-Z]{4}[0-9]{5}[A-Z]$/ },
    financialYear: { type: String, required: true, trim: true, match: /^\d{4}-\d{2}$/ },
    quarter: { type: String, enum: TDS_QUARTERS, required: true },
    statementType: { type: String, enum: TDS_STATEMENT_TYPES, required: true },

    deducteeName: { type: String, trim: true, maxlength: 240, default: "" },
    deducteePan: { type: String, trim: true, uppercase: true, maxlength: 20, default: "" },
    sectionCode: { type: String, trim: true, uppercase: true, maxlength: 30, default: "" },
    transactionDate: { type: String, trim: true, default: "", validate: isoDay },
    amountPaidMinor: { type: Number, default: 0, validate: safeInteger },
    deductedMinor: { type: Number, default: 0, validate: safeInteger },
    surchargeMinor: { type: Number, default: 0, validate: safeInteger },
    cessMinor: { type: Number, default: 0, validate: safeInteger },

    bsrCode: { type: String, trim: true, maxlength: 7, default: "" },
    challanSerial: { type: String, trim: true, maxlength: 5, default: "" },
    challanDate: { type: String, trim: true, default: "", validate: isoDay },
    depositedMinor: { type: Number, default: 0, validate: safeInteger },

    filingStatus: { type: String, enum: TDS_FILING_STATUSES, default: "NOT_FILED" },
    statementReference: { type: String, trim: true, maxlength: 160, default: "" },
    filedDate: { type: String, trim: true, default: "", validate: isoDay },
    reportedMinor: { type: Number, default: 0, validate: safeInteger },
    correctionStatus: { type: String, enum: TDS_CORRECTION_STATUSES, default: "NONE" },
    correctionReference: { type: String, trim: true, maxlength: 160, default: "" },
    certificateStatus: { type: String, enum: TDS_CERTIFICATE_STATUSES, default: "NOT_TRACKED" },
    certificateType: { type: String, enum: ["", "FORM_16", "FORM_16A"], default: "" },

    creditDate: { type: String, trim: true, default: "", validate: isoDay },
    creditedMinor: { type: Number, default: 0, validate: safeInteger },
    sourceReference: { type: String, trim: true, maxlength: 500, default: "" },
  },
  { timestamps: true }
);

TdsImportRowSchema.index(
  { firmId: 1, batchId: 1, importGeneration: 1, sourceRow: 1 },
  { unique: true, name: "unique_tds_import_row_generation" }
);
TdsImportRowSchema.index({ firmId: 1, clientId: 1, financialYear: 1, quarter: 1, statementType: 1, kind: 1 });
TdsImportRowSchema.index({ firmId: 1, batchId: 1, importGeneration: 1, deducteePan: 1, sectionCode: 1 });
TdsImportRowSchema.index({ firmId: 1, batchId: 1, importGeneration: 1, bsrCode: 1, challanSerial: 1 });

const TdsImportRow = mongoose.model("TdsImportRow", TdsImportRowSchema);

export {
  TDS_CERTIFICATE_STATUSES,
  TDS_CORRECTION_STATUSES,
  TDS_FILING_STATUSES,
  TDS_IMPORT_KINDS,
  TDS_QUARTERS,
  TDS_STATEMENT_TYPES,
};
export default TdsImportRow;
