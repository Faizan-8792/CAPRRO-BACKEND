// src/models/BooksParty.js
//
// W10 AP20 (2026-10-17): the party master completed from Tally - one row per debtor/creditor/lender
// ledger of a client, carrying what Tally holds (GSTIN, PAN, Udyam number, credit period, bill-wise) and
// the flags the 3CD and Schedule III packs need. UNKNOWN is a real value.
//
// Seeded from a snapshot and never overwriting what a person set. The GST status of a party with a GSTIN
// is NOT stored here: it is the Clause 44 party master's (PartyMaster), read at the point of use, so there
// is one authority for it. An Udyam NUMBER does not say micro, small or medium: the category stays
// UNKNOWN until a person (or a certificate they confirm) says.
import mongoose from "mongoose";

const BOOKS_PARTY_UDYAM = Object.freeze(["UNKNOWN", "MICRO", "SMALL", "MEDIUM", "NOT_MSME"]);

const BooksPartySchema = new mongoose.Schema(
  {
    firmId: { type: mongoose.Schema.Types.ObjectId, ref: "Firm", required: true },
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: "Client", required: true },
    nameKey: { type: String, required: true, trim: true, maxlength: 320 },
    name: { type: String, required: true, trim: true, maxlength: 300 },
    standardGroup: { type: String, trim: true, maxlength: 40, default: "" },
    gstin: { type: String, trim: true, uppercase: true, maxlength: 20, default: "" },
    pan: { type: String, trim: true, uppercase: true, maxlength: 12, default: "" },
    gstRegistrationType: { type: String, trim: true, maxlength: 60, default: "" },
    udyamNumber: { type: String, trim: true, uppercase: true, maxlength: 40, default: "" },
    udyamCategory: { type: String, enum: BOOKS_PARTY_UDYAM, default: "UNKNOWN" },
    relatedPerson: { type: Boolean, default: null },
    lenderOrDepositor: { type: Boolean, default: null },
    // What Tally's group says (loan and deposit groups); a person confirms before it counts.
    lenderHint: { type: Boolean, default: null },
    creditPeriodDays: { type: Number, min: 0, default: null },
    isBillwise: { type: Boolean, default: null },
    blanks: { type: [String], default: () => [] },
    seededFromSnapshotId: { type: mongoose.Schema.Types.ObjectId, ref: "BooksSnapshot", default: null },
    version: { type: Number, min: 0, default: 0 },
    confirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    confirmedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

BooksPartySchema.index({ firmId: 1, clientId: 1, nameKey: 1 }, { unique: true, name: "unique_books_party_client_name" });

export { BOOKS_PARTY_UDYAM };
export default mongoose.model("BooksParty", BooksPartySchema);
