// src/models/BooksSnapshot.js
//
// W10 AP18 (2026-10-17): one export of a client's books for one financial year - a Tally day book and
// masters, read by the client (extension or Windows app) and sent here as small, hashed NDJSON chunks. A
// snapshot is written while DRAFT, verified by count and by the digest of its chunks when sealed, and
// never changed after: a second export is a second snapshot, and what changed between them is a diff
// (AP21), which is the only honest evidence this product can give about edits after the first export.

import mongoose from "mongoose";

const BOOKS_SNAPSHOT_SOURCES = Object.freeze(["TALLY_XML", "EXCEL"]);
const BOOKS_SNAPSHOT_STATUSES = Object.freeze(["DRAFT", "SEALED"]);
const BOOKS_CHUNK_KINDS = Object.freeze(["groups", "ledgers", "vouchers"]);

const ChunkLogSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: BOOKS_CHUNK_KINDS, required: true },
    seq: { type: Number, required: true, min: 0 },
    hash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    count: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const BooksSnapshotSchema = new mongoose.Schema(
  {
    firmId: { type: mongoose.Schema.Types.ObjectId, ref: "Firm", required: true },
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: "Client", required: true },
    financialYear: { type: String, required: true, trim: true, match: /^\d{4}-\d{2}$/ },
    source: { type: String, enum: BOOKS_SNAPSHOT_SOURCES, required: true },
    label: { type: String, trim: true, maxlength: 120, default: "" },
    schemaVersion: { type: String, trim: true, maxlength: 40, default: "tally-canonical-v1" },
    status: { type: String, enum: BOOKS_SNAPSHOT_STATUSES, default: "DRAFT" },
    // How many chunks of each kind have been accepted: the next chunk of a kind must carry exactly this seq.
    chunkCounts: {
      groups: { type: Number, min: 0, default: 0 },
      ledgers: { type: Number, min: 0, default: 0 },
      vouchers: { type: Number, min: 0, default: 0 },
    },
    chunkLog: { type: [ChunkLogSchema], default: () => [] },
    counts: {
      groups: { type: Number, min: 0, default: 0 },
      ledgers: { type: Number, min: 0, default: 0 },
      vouchers: { type: Number, min: 0, default: 0 },
    },
    alterId: {
      min: { type: Number, min: 0, default: null },
      max: { type: Number, min: 0, default: null },
    },
    voucherDates: {
      min: { type: String, match: /^\d{4}-\d{2}-\d{2}$/, default: null },
      max: { type: String, match: /^\d{4}-\d{2}-\d{2}$/, default: null },
    },
    // What the server found in the records themselves (never taken from the client's say-so).
    warnings: {
      recordsWithWarnings: { type: Number, min: 0, default: 0 },
      amountsUnreadable: { type: Number, min: 0, default: 0 },
      datesUnreadable: { type: Number, min: 0, default: 0 },
    },
    contentHash: { type: String, match: /^[a-f0-9]{64}$/, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    sealedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    sealedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

BooksSnapshotSchema.index({ firmId: 1, clientId: 1, financialYear: 1, createdAt: -1 });

const BooksSnapshot = mongoose.model("BooksSnapshot", BooksSnapshotSchema);

export { BOOKS_CHUNK_KINDS, BOOKS_SNAPSHOT_SOURCES, BOOKS_SNAPSHOT_STATUSES };
export default BooksSnapshot;
