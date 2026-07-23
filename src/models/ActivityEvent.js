import mongoose from "mongoose";

const ACTIVITY_SOURCES = Object.freeze([
  "USER",
  "AUTOMATION",
  "IMPORT",
  "AI_ASSISTED",
  "SUPER_ADMIN",
]);

const ActivityEventSchema = new mongoose.Schema(
  {
    firmId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Firm",
      default: null,
      index: true,
    },
    actorUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    source: { type: String, enum: ACTIVITY_SOURCES, required: true },
    action: { type: String, required: true, trim: true, maxlength: 120 },
    entityType: { type: String, required: true, trim: true, maxlength: 100 },
    entityId: { type: String, required: true, trim: true, maxlength: 160 },
    beforeSummary: { type: mongoose.Schema.Types.Mixed, default: null },
    afterSummary: { type: mongoose.Schema.Types.Mixed, default: null },
    requestId: { type: String, trim: true, maxlength: 160, default: "" },
    batchId: { type: String, trim: true, maxlength: 160, default: "" },
    metadata: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    occurredAt: { type: Date, default: Date.now, immutable: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

ActivityEventSchema.index({ firmId: 1, occurredAt: -1 });
ActivityEventSchema.index({ firmId: 1, _id: -1 });
ActivityEventSchema.index({ firmId: 1, entityType: 1, entityId: 1, occurredAt: -1 });
ActivityEventSchema.index({ firmId: 1, actorUserId: 1, occurredAt: -1 });

const rejectMutation = function rejectMutation(next) {
  next(new Error("Activity events are append-only"));
};
for (const hook of [
  "updateOne",
  "updateMany",
  "findOneAndUpdate",
  "replaceOne",
  "deleteOne",
  "deleteMany",
  "findOneAndDelete",
]) {
  ActivityEventSchema.pre(hook, rejectMutation);
}

const ActivityEvent = mongoose.model("ActivityEvent", ActivityEventSchema);

export { ACTIVITY_SOURCES };
export default ActivityEvent;
