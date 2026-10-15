// src/models/BooksImportRow.js
//
// W10 AP5 (2026-10-15): one row of the firm's own books as imported - today a trial-balance
// ledger. Mirrors TdsImportRow's lifecycle (batch, import generation, source row, fingerprint) so
// a re-commit replaces a whole generation and a reader never sees half of one.
//
// BOOKS_IMPORT_KINDS is defined HERE and imported by books-normalization.service.js, so the kind
// list has one source. (TDS keeps two copies of its list and they have already drifted apart on
// statement types; this family does not repeat that.)

import mongoose from "mongoose";

const BOOKS_IMPORT_KINDS = Object.freeze(["TRIAL_BALANCE"]);

const safeInteger = {
  validator: (value) => value == null || Number.isSafeInteger(value),
  message: "{PATH} must be a safe integer in the smallest currency unit",
};

const BooksImportRowSchema = new mongoose.Schema(
  {
    firmId: { type: mongoose.Schema.Types.ObjectId, ref: "Firm", required: true },
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: "Client", required: true },
    batchId: { type: mongoose.Schema.Types.ObjectId, ref: "ImportBatch", required: true },
    importGeneration: { type: String, required: true, trim: true, maxlength: 80 },
    kind: { type: String, enum: BOOKS_IMPORT_KINDS, required: true },
    sourceRow: { type: Number, required: true, min: 2 },
    sourceHash: { type: String, required: true, trim: true, match: /^[a-f0-9]{64}$/i },
    rowFingerprint: { type: String, required: true, trim: true, match: /^[a-f0-9]{64}$/i },
    normalizationVersion: { type: String, required: true, trim: true, maxlength: 80 },
    sourceLabel: { type: String, required: true, trim: true, maxlength: 160 },
    financialYear: { type: String, required: true, trim: true, match: /^\d{4}-\d{2}$/ },

    ledgerName: { type: String, required: true, trim: true, maxlength: 240 },
    groupName: { type: String, trim: true, maxlength: 240, default: "" },
    // Debit positive, credit negative, integer paise.
    openingMinor: { type: Number, default: 0, validate: safeInteger },
    hasOpening: { type: Boolean, default: false },
    debitTotalMinor: { type: Number, default: 0, min: 0, validate: safeInteger },
    creditTotalMinor: { type: Number, default: 0, min: 0, validate: safeInteger },
    hasTransactionTotals: { type: Boolean, default: false },
    closingMinor: { type: Number, default: 0, validate: safeInteger },
  },
  { timestamps: true },
);

BooksImportRowSchema.index(
  { firmId: 1, batchId: 1, importGeneration: 1, sourceRow: 1 },
  { unique: true, name: "unique_books_import_row_generation" },
);
BooksImportRowSchema.index({ firmId: 1, clientId: 1, financialYear: 1, kind: 1 });

const BooksImportRow = mongoose.model("BooksImportRow", BooksImportRowSchema);

export { BOOKS_IMPORT_KINDS };
export default BooksImportRow;
