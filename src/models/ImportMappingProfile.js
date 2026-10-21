// src/models/ImportMappingProfile.js
//
// W11 IN14 (2026-10-21): the column mapping a person confirmed for one client's file layout, so the next file in
// the same layout maps itself. A layout is identified by headerSignature, the sha-256 of the file's normalised,
// ordered headings: the same export from the same software gives the same signature month after month, and a
// changed layout gives a different one (and falls back to the heading synonyms). Per firm and per client - a
// profile is never shared across firms (CLAUDE.md section 8) or used for another client.
//
// The mapping is field -> heading text, exactly the shape the import routes take, so applying it is the same as
// a person choosing it again; the preview and the commit still re-validate everything.

import mongoose from "mongoose";

const ImportMappingProfileSchema = new mongoose.Schema(
  {
    firmId: { type: mongoose.Schema.Types.ObjectId, ref: "Firm", required: true, immutable: true },
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: "Client", required: true, immutable: true },
    kind: { type: String, required: true, trim: true, uppercase: true, maxlength: 60, immutable: true },
    headerSignature: { type: String, required: true, match: /^[a-f0-9]{64}$/, immutable: true },
    headerCount: { type: Number, min: 0, default: 0 },
    mapping: { type: mongoose.Schema.Types.Mixed, required: true },
    confirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    confirmedAt: { type: Date, default: null },
    timesApplied: { type: Number, min: 0, default: 0 },
  },
  { timestamps: true },
);

ImportMappingProfileSchema.index(
  { firmId: 1, clientId: 1, kind: 1, headerSignature: 1 },
  { unique: true, name: "unique_import_mapping_profile" },
);

export default mongoose.model("ImportMappingProfile", ImportMappingProfileSchema);
