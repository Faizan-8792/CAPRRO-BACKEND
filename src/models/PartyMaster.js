// src/models/PartyMaster.js
//
// W10 AP6 (2026-10-15): what is known about each of a client's suppliers - its GST status today,
// and in later phases its Udyam category and whether it is a related person or a lender. One row
// per (firm, client, GSTIN).
//
// A status here is a PERSON's answer, never the engine's guess. The Clause 44 engine derives
// REGISTERED or NOT_IN_2B from the year's GSTR-2B on every run and reads only the statuses people
// set here (COMPOSITION, EXEMPT_SUPPLIER, or REGISTERED confirmed). That keeps an answer given
// once - "this supplier is a composition dealer, checked on the portal" - for every later run and
// year, and keeps it attributable: who set it and when. UNKNOWN is a real value, not a default for
// a missing answer to be read as something else.

import mongoose from "mongoose";

const PARTY_GST_STATUSES = Object.freeze(["UNKNOWN", "REGISTERED", "COMPOSITION", "EXEMPT_SUPPLIER"]);
const PARTY_UDYAM_CATEGORIES = Object.freeze(["UNKNOWN", "MICRO", "SMALL", "MEDIUM", "NOT_MSME"]);

const PartyMasterSchema = new mongoose.Schema(
  {
    firmId: { type: mongoose.Schema.Types.ObjectId, ref: "Firm", required: true },
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: "Client", required: true },
    gstin: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      match: /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/,
    },
    name: { type: String, trim: true, maxlength: 240, default: "" },
    gstStatus: { type: String, enum: PARTY_GST_STATUSES, default: "UNKNOWN" },
    gstStatusNote: { type: String, trim: true, maxlength: 500, default: "" },
    udyamCategory: { type: String, enum: PARTY_UDYAM_CATEGORIES, default: "UNKNOWN" },
    relatedPerson: { type: Boolean, default: null },
    lenderOrDepositor: { type: Boolean, default: null },
    version: { type: Number, min: 0, default: 0 },
    confirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    confirmedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

PartyMasterSchema.index(
  { firmId: 1, clientId: 1, gstin: 1 },
  { unique: true, name: "unique_party_master_client_gstin" },
);

const PartyMaster = mongoose.model("PartyMaster", PartyMasterSchema);

export { PARTY_GST_STATUSES, PARTY_UDYAM_CATEGORIES };
export default PartyMaster;
