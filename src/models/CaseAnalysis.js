import mongoose from "mongoose";

const BoundedListSchema = {
  type: [String],
  default: [],
  validate: {
    validator: (values) => values.length <= 100 && values.every((value) => value.length <= 2000),
    message: "Analysis section exceeds allowed bounds",
  },
};

const CaseAnalysisSchema = new mongoose.Schema(
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
    sourceTextHash: { type: String, match: /^[a-f0-9]{64}$/, required: true, immutable: true },
    confirmedFactsHash: { type: String, match: /^[a-f0-9]{64}$/, required: true, immutable: true },
    confirmedFacts: BoundedListSchema,
    missingInformation: BoundedListSchema,
    requestedActions: BoundedListSchema,
    deadlineSummary: BoundedListSchema,
    potentialResponseStructure: BoundedListSchema,
    riskIndicators: BoundedListSchema,
    professionalReviewQuestions: BoundedListSchema,
    provider: { type: String, trim: true, maxlength: 80, required: true, immutable: true },
    model: { type: String, trim: true, maxlength: 120, required: true, immutable: true },
    disclaimer: {
      type: String,
      maxlength: 1000,
      default: "AI-assisted working analysis. Professional review required; no legal correctness is claimed.",
      immutable: true,
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

CaseAnalysisSchema.index({ firmId: 1, caseId: 1, version: -1 }, { unique: true });
CaseAnalysisSchema.index(
  { firmId: 1, caseId: 1, mutationKey: 1 },
  {
    unique: true,
    partialFilterExpression: { mutationKey: { $type: "string" } },
    name: "unique_case_analysis_mutation",
  }
);

function rejectMutation(next) {
  next(new Error("Case analyses are append-only"));
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
  CaseAnalysisSchema.pre(hook, rejectMutation);
}

const CaseAnalysis = mongoose.model("CaseAnalysis", CaseAnalysisSchema);
export default CaseAnalysis;
