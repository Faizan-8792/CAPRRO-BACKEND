// src/models/BooksLedger.js - W10 AP18 (2026-10-17): a Tally ledger in one books snapshot, with the party
// fields Tally keeps on it. A field the export did not give is null or empty - never a default.
import mongoose from "mongoose";

const BooksLedgerSchema = new mongoose.Schema(
  {
    firmId: { type: mongoose.Schema.Types.ObjectId, ref: "Firm", required: true },
    snapshotId: { type: mongoose.Schema.Types.ObjectId, ref: "BooksSnapshot", required: true },
    chunkToken: { type: String, required: true, maxlength: 40 },
    recordKey: { type: String, required: true, maxlength: 320 },
    guid: { type: String, trim: true, maxlength: 80, default: "" },
    alterId: { type: Number, min: 0, default: null },
    name: { type: String, required: true, trim: true, maxlength: 300 },
    parent: { type: String, trim: true, maxlength: 300, default: "" },
    openingMinor: { type: Number, default: null },
    gstin: { type: String, trim: true, uppercase: true, maxlength: 20, default: "" },
    pan: { type: String, trim: true, uppercase: true, maxlength: 12, default: "" },
    gstRegistrationType: { type: String, trim: true, maxlength: 60, default: "" },
    isBillwise: { type: Boolean, default: null },
    creditPeriodDays: { type: Number, min: 0, default: null },
    udyam: { type: String, trim: true, uppercase: true, maxlength: 40, default: "" },
    warnings: { type: [String], default: () => [] },
  },
  { timestamps: false },
);

BooksLedgerSchema.index({ firmId: 1, snapshotId: 1, recordKey: 1 }, { unique: true, name: "unique_books_ledger_snapshot_key" });

export default mongoose.model("BooksLedger", BooksLedgerSchema);
