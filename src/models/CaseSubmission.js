import mongoose from "mongoose";

const CaseSubmissionSchema = new mongoose.Schema(
  {
    firmId: { type: mongoose.Schema.Types.ObjectId, ref: "Firm", required: true, immutable: true },
    caseId: { type: mongoose.Schema.Types.ObjectId, ref: "CaseMatter", required: true, immutable: true },
    version: { type: Number, min: 1, required: true, immutable: true },
    mutationKey: {
      type: String,
      trim: true,
      maxlength: 120,
      required: true,
      immutable: true,
    },
    requestHash: {
      type: String,
      match: /^[a-f0-9]{64}$/,
      required: true,
      immutable: true,
    },
    draftId: { type: mongoose.Schema.Types.ObjectId, ref: "CaseDraft", required: true, immutable: true },
    draftVersion: { type: Number, min: 1, required: true, immutable: true },
    method: {
      type: String,
      enum: ["PORTAL", "EMAIL", "PHYSICAL", "HAND_DELIVERY", "OTHER"],
      required: true,
      immutable: true,
    },
    submittedAt: { type: Date, required: true, immutable: true },
    acknowledgmentReference: {
      type: String,
      trim: true,
      maxlength: 500,
      required: true,
      immutable: true,
    },
    notes: { type: String, trim: true, maxlength: 5000, default: "", immutable: true },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

CaseSubmissionSchema.index({ firmId: 1, caseId: 1, version: -1 }, { unique: true });
CaseSubmissionSchema.index(
  { firmId: 1, caseId: 1, mutationKey: 1 },
  {
    unique: true,
    partialFilterExpression: { mutationKey: { $type: "string" } },
    name: "unique_case_submission_mutation",
  }
);
CaseSubmissionSchema.index(
  { firmId: 1, caseId: 1, acknowledgmentReference: 1 },
  { unique: true }
);

function rejectMutation(next) {
  next(new Error("Case submissions are append-only"));
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
  CaseSubmissionSchema.pre(hook, rejectMutation);
}

const CaseSubmission = mongoose.model("CaseSubmission", CaseSubmissionSchema);
export default CaseSubmission;
