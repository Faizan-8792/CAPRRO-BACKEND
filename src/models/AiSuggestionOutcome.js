// src/models/AiSuggestionOutcome.js
//
// W11 IN5 (2026-10-21): what people did with suggestions, counted per firm per UTC day. A suggestion comes
// either from a server rule (source RULE, key = the rule id, e.g. "R4") or from the model (source MODEL, key =
// the AI task). Counters only: no item, no text, no client - the same kind of content-free count as
// WorkflowUsage. The plan's keep-or-retire measures (section 10.3) read this.

import mongoose from "mongoose";

export const SUGGESTION_SOURCES = Object.freeze(["RULE", "MODEL"]);
export const SUGGESTION_SURFACES = Object.freeze(["gst_cause", "gst_chase", "import_mapping", "tds_action", "notice_rules"]);
export const SUGGESTION_OUTCOME_FIELDS = Object.freeze({
  ADOPTED_UNCHANGED: "adoptedUnchanged",
  EDITED: "edited",
  DISCARDED: "discarded",
});

const AiSuggestionOutcomeSchema = new mongoose.Schema(
  {
    firmId: { type: mongoose.Schema.Types.ObjectId, ref: "Firm", required: true, immutable: true },
    day: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/, immutable: true },
    surface: { type: String, enum: SUGGESTION_SURFACES, required: true, immutable: true },
    source: { type: String, enum: SUGGESTION_SOURCES, required: true, immutable: true },
    key: { type: String, required: true, trim: true, maxlength: 40, match: /^[A-Za-z0-9_]+$/, immutable: true },
    adoptedUnchanged: { type: Number, min: 0, default: 0 },
    edited: { type: Number, min: 0, default: 0 },
    discarded: { type: Number, min: 0, default: 0 },
  },
  { timestamps: true },
);

AiSuggestionOutcomeSchema.index(
  { firmId: 1, day: 1, surface: 1, source: 1, key: 1 },
  { unique: true, name: "unique_ai_suggestion_outcome_day" },
);

export default mongoose.model("AiSuggestionOutcome", AiSuggestionOutcomeSchema);
