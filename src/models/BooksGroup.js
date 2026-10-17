// src/models/BooksGroup.js - W10 AP18 (2026-10-17): a Tally group in one books snapshot.
import mongoose from "mongoose";

const BooksGroupSchema = new mongoose.Schema(
  {
    firmId: { type: mongoose.Schema.Types.ObjectId, ref: "Firm", required: true },
    snapshotId: { type: mongoose.Schema.Types.ObjectId, ref: "BooksSnapshot", required: true },
    chunkToken: { type: String, required: true, maxlength: 40 },
    // The identity inside a snapshot: the lower-cased name (Tally names are unique per company).
    recordKey: { type: String, required: true, maxlength: 320 },
    guid: { type: String, trim: true, maxlength: 80, default: "" },
    alterId: { type: Number, min: 0, default: null },
    name: { type: String, required: true, trim: true, maxlength: 300 },
    parent: { type: String, trim: true, maxlength: 300, default: "" },
    reserved: { type: String, trim: true, maxlength: 120, default: "" },
  },
  { timestamps: false },
);

BooksGroupSchema.index({ firmId: 1, snapshotId: 1, recordKey: 1 }, { unique: true, name: "unique_books_group_snapshot_key" });

export default mongoose.model("BooksGroup", BooksGroupSchema);
