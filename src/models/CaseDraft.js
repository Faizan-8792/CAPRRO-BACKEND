import mongoose from "mongoose";

const DRAFT_STATUSES = Object.freeze([
  "DRAFT",
  "IN_REVIEW",
  "APPROVED",
  "REJECTED",
  "FINALIZING",
  "FINAL",
  "SUPERSEDED",
]);

const AuthorityClaimBindingSchema = new mongoose.Schema(
  {
    claimTextHash: {
      type: String,
      match: /^[a-f0-9]{64}$/,
      required: true,
    },
    referenceIds: {
      type: [mongoose.Schema.Types.ObjectId],
      required: true,
      validate: {
        validator: (values) => values.length >= 1 && values.length <= 10,
        message: "Authority claim bindings require 1-10 references",
      },
    },
  },
  { _id: false }
);

const CaseDraftSchema = new mongoose.Schema(
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
    parentDraftId: { type: mongoose.Schema.Types.ObjectId, ref: "CaseDraft", default: null, immutable: true },
    origin: { type: String, enum: ["USER", "AI_ASSISTED"], required: true, immutable: true },
    title: { type: String, trim: true, maxlength: 500, required: true, immutable: true },
    content: { type: String, maxlength: 250000, required: true, immutable: true },
    contentHash: { type: String, match: /^[a-f0-9]{64}$/, required: true, immutable: true },
    referenceIds: {
      type: [mongoose.Schema.Types.ObjectId],
      default: [],
      immutable: true,
      validate: {
        validator: (values) => values.length <= 100,
        message: "Too many draft references",
      },
    },
    authorityClaims: {
      type: [AuthorityClaimBindingSchema],
      default: [],
      immutable: true,
      validate: {
        validator: (values) => values.length <= 100,
        message: "Too many authority claim bindings",
      },
    },
    basedOnAnalysisVersion: { type: Number, min: 1, default: null, immutable: true },
    provider: { type: String, trim: true, maxlength: 80, default: "", immutable: true },
    model: { type: String, trim: true, maxlength: 120, default: "", immutable: true },
    status: { type: String, enum: DRAFT_STATUSES, default: "DRAFT" },
    reviewSubmissionMutationKey: { type: String, trim: true, maxlength: 120, default: null },
    reviewSubmissionRequestHash: { type: String, match: /^[a-f0-9]{64}$/, default: null },
    reviewDecisionMutationKey: { type: String, trim: true, maxlength: 120, default: null },
    reviewDecisionRequestHash: { type: String, match: /^[a-f0-9]{64}$/, default: null },
    finalizationMutationKey: { type: String, trim: true, maxlength: 120, default: null },
    finalizationRequestHash: { type: String, match: /^[a-f0-9]{64}$/, default: null },
    submissionMutationKey: { type: String, trim: true, maxlength: 120, default: null },
    submissionRequestHash: { type: String, match: /^[a-f0-9]{64}$/, default: null },
    submittedVersionAt: { type: Date, default: null },
    submittedVersionBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
    reviewNote: { type: String, trim: true, maxlength: 5000, default: "" },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    reviewedAt: { type: Date, default: null },
    finalizedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    finalizedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

CaseDraftSchema.index({ firmId: 1, caseId: 1, version: -1 }, { unique: true });
CaseDraftSchema.index({ firmId: 1, caseId: 1, status: 1, updatedAt: -1 });
CaseDraftSchema.index(
  { firmId: 1, caseId: 1, mutationKey: 1 },
  {
    unique: true,
    partialFilterExpression: { mutationKey: { $type: "string" } },
    name: "unique_case_draft_mutation",
  }
);
for (const field of [
  "reviewSubmissionMutationKey",
  "reviewDecisionMutationKey",
  "finalizationMutationKey",
  "submissionMutationKey",
]) {
  CaseDraftSchema.index(
    { firmId: 1, caseId: 1, [field]: 1 },
    {
      unique: true,
      partialFilterExpression: { [field]: { $type: "string" } },
      name: `unique_case_draft_${field}`,
    }
  );
}
CaseDraftSchema.index(
  { firmId: 1, caseId: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "FINAL" },
    name: "one_final_draft_per_case",
  }
);

CaseDraftSchema.pre("save", function preventContentRewrite(next) {
  if (!this.isNew) {
    const immutableFields = [
      "firmId",
      "caseId",
      "version",
      "mutationKey",
      "requestHash",
      "parentDraftId",
      "origin",
      "title",
      "content",
      "contentHash",
      "referenceIds",
      "authorityClaims",
      "basedOnAnalysisVersion",
      "provider",
      "model",
      "createdBy",
    ];
    if (immutableFields.some((field) => this.isModified(field))) {
      return next(new Error("Draft content versions are immutable"));
    }
  }
  return next();
});

const CaseDraft = mongoose.model("CaseDraft", CaseDraftSchema);

export { DRAFT_STATUSES };
export default CaseDraft;
