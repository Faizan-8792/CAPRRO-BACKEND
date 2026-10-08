import mongoose from "mongoose";

const GST_IMPORT_KINDS = Object.freeze([
  "GST_PURCHASE",
  "GSTR2B",
  "GSTR3B_SUMMARY",
  // Both are summary rows shaped exactly like GSTR3B_SUMMARY - a category and its amounts - so
  // they share this collection and its summaryCategory field rather than needing a schema of
  // their own. GSTR-1 carries a taxable value; the credit ledger does not.
  "GSTR1_SUMMARY",
  "ECREDIT_LEDGER",
]);

const WarningSchema = new mongoose.Schema(
  {
    field: { type: String, trim: true, maxlength: 80, default: "" },
    code: { type: String, trim: true, maxlength: 80, required: true },
  },
  { _id: false }
);

const safeInteger = {
  validator: Number.isSafeInteger,
  message: "{PATH} must be a safe integer in the smallest currency unit",
};

function moneyField() {
  return { type: Number, default: 0, validate: safeInteger };
}

const ImportRowSchema = new mongoose.Schema(
  {
    firmId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Firm",
      required: true,
      index: true,
    },
    batchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ImportBatch",
      required: true,
      index: true,
    },
    clientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      required: true,
      index: true,
    },
    kind: { type: String, enum: GST_IMPORT_KINDS, required: true },
    sourceHash: { type: String, trim: true, maxlength: 128, required: true },
    importGeneration: { type: String, trim: true, maxlength: 80, default: "legacy" },
    sourceRow: { type: Number, min: 2, required: true },
    supplierGstin: { type: String, trim: true, uppercase: true, maxlength: 15, default: "" },
    recipientGstin: { type: String, trim: true, uppercase: true, maxlength: 15, default: "" },
    invoiceNumberOriginal: { type: String, trim: true, maxlength: 120, default: "" },
    invoiceNumberNormalized: { type: String, trim: true, uppercase: true, maxlength: 120, default: "" },
    documentDate: { type: String, match: /^\d{4}-\d{2}-\d{2}$/, default: null },
    dateOrder: { type: String, enum: ["", "DAY_FIRST", "MONTH_FIRST", "NOT_APPLICABLE"], default: "" },
    documentType: { type: String, trim: true, uppercase: true, maxlength: 40, default: "" },
    taxableValueMinor: moneyField(),
    igstMinor: moneyField(),
    cgstMinor: moneyField(),
    sgstMinor: moneyField(),
    cessMinor: moneyField(),
    totalTaxMinor: moneyField(),
    reverseCharge: { type: Boolean, default: false },
    placeOfSupply: { type: String, trim: true, uppercase: true, maxlength: 80, default: "" },
    summaryCategory: { type: String, trim: true, uppercase: true, maxlength: 80, default: "" },
    warnings: { type: [WarningSchema], default: () => [] },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

ImportRowSchema.index(
  { firmId: 1, batchId: 1, importGeneration: 1, sourceRow: 1 },
  { unique: true }
);
ImportRowSchema.index({ firmId: 1, clientId: 1, kind: 1, createdAt: -1 });
ImportRowSchema.index({ firmId: 1, supplierGstin: 1, invoiceNumberNormalized: 1 });

const ImportRow = mongoose.model("ImportRow", ImportRowSchema);

export { GST_IMPORT_KINDS };
export default ImportRow;
