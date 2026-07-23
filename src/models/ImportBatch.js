import mongoose from "mongoose";

const IMPORT_KINDS = Object.freeze([
  "CLIENTS",
  "GST_PURCHASE",
  "GSTR2B",
  "GSTR3B_SUMMARY",
  "TDS_DEDUCTIONS",
  "TDS_CHALLANS",
  "TDS_STATEMENTS",
  "TDS_26AS",
]);
const TDS_STATEMENT_TYPES = Object.freeze(["24Q", "26Q", "27Q", "27EQ"]);
const TDS_QUARTERS = Object.freeze(["Q1", "Q2", "Q3", "Q4"]);
const IMPORT_STATUSES = Object.freeze([
  "QUEUED",
  "PROCESSING",
  "COMPLETED",
  "PARTIAL",
  "FAILED",
  "CANCELLED",
]);

const safeInteger = {
  validator: Number.isSafeInteger,
  message: "{PATH} must be a safe integer in the smallest currency unit",
};

const ImportBatchSchema = new mongoose.Schema(
  {
    firmId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Firm",
      required: true,
      index: true,
    },
    clientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      default: null,
      index: true,
    },
    kind: { type: String, enum: IMPORT_KINDS, required: true },
    gstin: {
      type: String,
      trim: true,
      uppercase: true,
      maxlength: 15,
      default: "",
      validate: {
        validator: (value) => !value || /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(value),
        message: "Invalid GSTIN",
      },
    },
    period: {
      type: String,
      trim: true,
      default: "",
      validate: {
        validator: (value) => !value || /^\d{4}-(0[1-9]|1[0-2])$/.test(value),
        message: "Invalid return period",
      },
    },
    tan: {
      type: String,
      trim: true,
      uppercase: true,
      maxlength: 10,
      default: "",
      validate: {
        validator: (value) => !value || /^[A-Z]{4}[0-9]{5}[A-Z]$/.test(value),
        message: "Invalid TAN",
      },
    },
    financialYear: {
      type: String,
      trim: true,
      maxlength: 7,
      default: "",
      validate: {
        validator: (value) => {
          if (!value) return true;
          const match = /^(\d{4})-(\d{2})$/.exec(value);
          return Boolean(match) && (Number(match[1]) + 1) % 100 === Number(match[2]);
        },
        message: "Invalid financial year",
      },
    },
    quarter: { type: String, enum: ["", ...TDS_QUARTERS], default: "" },
    statementType: { type: String, enum: ["", ...TDS_STATEMENT_TYPES], default: "" },
    sourceName: { type: String, trim: true, maxlength: 240, default: "" },
    sourceHash: { type: String, required: true, trim: true, maxlength: 128 },
    importFingerprint: { type: String, trim: true, maxlength: 128, default: null },
    normalizationVersion: { type: String, trim: true, maxlength: 80, default: "legacy" },
    delimiter: { type: String, enum: [",", ";", "TAB"], default: "," },
    mapping: { type: mongoose.Schema.Types.Mixed, required: true },
    status: { type: String, enum: IMPORT_STATUSES, default: "QUEUED", index: true },
    totalRows: { type: Number, min: 0, default: 0 },
    validRows: { type: Number, min: 0, default: 0 },
    invalidRows: { type: Number, min: 0, default: 0 },
    currencyScale: { type: Number, enum: [2], default: 2 },
    totalTaxMinor: { type: Number, default: 0, validate: safeInteger },
    errorSummary: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    jobId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AutomationJob",
      default: null,
    },
    requestId: { type: String, trim: true, maxlength: 160, default: "" },
    processingToken: { type: String, trim: true, maxlength: 80, default: null },
    processingExpiresAt: { type: Date, default: null },
    activeImportGeneration: { type: String, trim: true, maxlength: 80, default: null },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    committedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

ImportBatchSchema.index(
  { firmId: 1, kind: 1, importFingerprint: 1 },
  {
    unique: true,
    partialFilterExpression: { importFingerprint: { $type: "string" } },
  }
);
ImportBatchSchema.index({ firmId: 1, status: 1, createdAt: -1 });
ImportBatchSchema.index({ firmId: 1, clientId: 1, period: -1, createdAt: -1 });
ImportBatchSchema.index({ firmId: 1, clientId: 1, financialYear: -1, quarter: 1, statementType: 1, createdAt: -1 });

const ImportBatch = mongoose.model("ImportBatch", ImportBatchSchema);

export { IMPORT_KINDS, IMPORT_STATUSES, TDS_QUARTERS, TDS_STATEMENT_TYPES };
export default ImportBatch;
