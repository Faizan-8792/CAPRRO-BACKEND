// src/models/BooksVoucher.js - W10 AP18 (2026-10-17): a Tally voucher in one books snapshot, with its ledger
// entries, bill allocations and bank allocations. Amounts are integer paise with Tally's sign: negative is
// debit. lineHash is the SHA-256 of the voucher's canonical line, so two snapshots can be compared without
// holding either in memory.
import mongoose from "mongoose";

const EntrySchema = new mongoose.Schema({ ledger: { type: String, maxlength: 300, default: "" }, amountMinor: { type: Number, default: null } }, { _id: false });
const BillSchema = new mongoose.Schema(
  {
    ledger: { type: String, maxlength: 300, default: "" },
    name: { type: String, maxlength: 300, default: "" },
    billType: { type: String, maxlength: 60, default: "" },
    amountMinor: { type: Number, default: null },
    creditPeriodDays: { type: Number, min: 0, default: null },
  },
  { _id: false },
);
const BankSchema = new mongoose.Schema(
  {
    ledger: { type: String, maxlength: 300, default: "" },
    instrumentNumber: { type: String, maxlength: 60, default: "" },
    instrumentDate: { type: String, match: /^\d{4}-\d{2}-\d{2}$/, default: null },
    transactionType: { type: String, maxlength: 60, default: "" },
    bankName: { type: String, maxlength: 120, default: "" },
    amountMinor: { type: Number, default: null },
  },
  { _id: false },
);

const BooksVoucherSchema = new mongoose.Schema(
  {
    firmId: { type: mongoose.Schema.Types.ObjectId, ref: "Firm", required: true },
    snapshotId: { type: mongoose.Schema.Types.ObjectId, ref: "BooksSnapshot", required: true },
    chunkToken: { type: String, required: true, maxlength: 40 },
    recordKey: { type: String, required: true, maxlength: 100 },
    lineHash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    guid: { type: String, trim: true, maxlength: 80, default: "" },
    alterId: { type: Number, min: 0, default: null },
    date: { type: String, match: /^\d{4}-\d{2}-\d{2}$/, default: null },
    type: { type: String, trim: true, maxlength: 80, default: "" },
    number: { type: String, trim: true, maxlength: 80, default: "" },
    narration: { type: String, maxlength: 4000, default: "" },
    partyLedger: { type: String, maxlength: 300, default: "" },
    reference: { type: String, maxlength: 120, default: "" },
    cancelled: { type: Boolean, default: false },
    optional: { type: Boolean, default: false },
    entries: { type: [EntrySchema], default: () => [] },
    bills: { type: [BillSchema], default: () => [] },
    banks: { type: [BankSchema], default: () => [] },
    warnings: { type: [String], default: () => [] },
  },
  { timestamps: false },
);

BooksVoucherSchema.index({ firmId: 1, snapshotId: 1, recordKey: 1 }, { unique: true, name: "unique_books_voucher_snapshot_key" });
BooksVoucherSchema.index({ firmId: 1, snapshotId: 1, date: 1 });

export default mongoose.model("BooksVoucher", BooksVoucherSchema);
