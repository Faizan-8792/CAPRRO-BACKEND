import mongoose from "mongoose";

const CASE_EVENT_TYPES = Object.freeze([
  "INTAKE_CREATED",
  "EXTRACTION_PROPOSED",
  "FIELDS_CONFIRMED",
  "STATUS_CHANGED",
  "NOTE_ADDED",
  "HEARING_RECORDED",
  "DEADLINE_ARTIFACTS_SYNCED",
  "REFERENCE_VERIFIED",
  "ANALYSIS_CREATED",
  "DRAFT_CREATED",
  "DRAFT_REVIEWED",
  "DRAFT_FINALIZED",
  "SUBMISSION_RECORDED",
  "OUTCOME_RECORDED",
]);

const CaseTimelineEventSchema = new mongoose.Schema(
  {
    firmId: { type: mongoose.Schema.Types.ObjectId, ref: "Firm", required: true },
    caseId: { type: mongoose.Schema.Types.ObjectId, ref: "CaseMatter", required: true },
    type: { type: String, enum: CASE_EVENT_TYPES, required: true },
    title: { type: String, trim: true, maxlength: 500, required: true },
    detail: { type: String, trim: true, maxlength: 5000, default: "" },
    occurredAt: { type: Date, default: Date.now, immutable: true },
    actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    mutationKey: {
      type: String,
      trim: true,
      maxlength: 180,
      default: null,
      immutable: true,
    },
    requestHash: {
      type: String,
      match: /^[a-f0-9]{64}$/,
      default: null,
      immutable: true,
    },
    metadata: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

CaseTimelineEventSchema.index({ firmId: 1, caseId: 1, occurredAt: -1, _id: -1 });
CaseTimelineEventSchema.index(
  { firmId: 1, caseId: 1, mutationKey: 1 },
  {
    unique: true,
    partialFilterExpression: { mutationKey: { $type: "string" } },
    name: "unique_case_event_mutation",
  }
);

function rejectMutation(next) {
  next(new Error("Case timeline events are append-only"));
}
for (const hook of [
  "updateOne",
  "updateMany",
  "findOneAndUpdate",
  "replaceOne",
  "deleteOne",
  "deleteMany",
  "findOneAndDelete",
]) {
  CaseTimelineEventSchema.pre(hook, rejectMutation);
}

const CaseTimelineEvent = mongoose.model("CaseTimelineEvent", CaseTimelineEventSchema);

export { CASE_EVENT_TYPES };
export default CaseTimelineEvent;
