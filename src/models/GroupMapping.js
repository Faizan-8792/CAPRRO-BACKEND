// src/models/GroupMapping.js - W10 AP19 (2026-10-17): a person's answer to "which standard group is this Tally
// group?", kept per client so it is asked once. Written only by a signed-in decision (or the acceptance of
// an AI suggestion, recorded as such); never inferred and never defaulted.
import mongoose from "mongoose";

const GroupMappingSchema = new mongoose.Schema(
  {
    firmId: { type: mongoose.Schema.Types.ObjectId, ref: "Firm", required: true },
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: "Client", required: true },
    groupKey: { type: String, required: true, trim: true, maxlength: 320 },
    groupName: { type: String, required: true, trim: true, maxlength: 300 },
    standardGroup: { type: String, required: true, trim: true, maxlength: 40 },
    source: { type: String, enum: ["USER", "AI_ACCEPTED"], default: "USER" },
    setBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    setAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

GroupMappingSchema.index({ firmId: 1, clientId: 1, groupKey: 1 }, { unique: true, name: "unique_group_mapping_client_group" });

export default mongoose.model("GroupMapping", GroupMappingSchema);
