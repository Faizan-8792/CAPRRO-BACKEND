import mongoose from "mongoose";

const AuditWorkingPaperSchema = new mongoose.Schema(
  {
    firmId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Firm",
      required: true,
      immutable: true,
    },
    engagementId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Engagement",
      required: true,
      immutable: true,
    },
    clientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      required: true,
      immutable: true,
    },
    title: { type: String, trim: true, maxlength: 500, required: true, immutable: true },
    purpose: { type: String, trim: true, maxlength: 5000, required: true, immutable: true },
    period: { type: String, trim: true, maxlength: 120, default: "", immutable: true },
    priorWorkingPaperId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AuditWorkingPaper",
      default: null,
      immutable: true,
    },
    creationMutationKey: {
      type: String,
      trim: true,
      maxlength: 120,
      required: true,
      immutable: true,
    },
    creationRequestHash: {
      type: String,
      match: /^[a-f0-9]{64}$/,
      required: true,
      immutable: true,
    },
    contentRevision: { type: Number, min: 0, default: 0 },
    revision: { type: Number, min: 1, default: 1 },
    professionalConclusionGenerated: {
      type: Boolean,
      default: false,
      immutable: true,
      validate: {
        validator: (value) => value === false,
        message: "Professional conclusion generation is disabled",
      },
    },
    privacyReviewPassed: {
      type: Boolean,
      default: false,
      immutable: true,
      validate: {
        validator: (value) => value === false,
        message: "Platform privacy review is not represented by working-paper records",
      },
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true, optimisticConcurrency: true }
);

AuditWorkingPaperSchema.index(
  { firmId: 1, engagementId: 1, creationMutationKey: 1 },
  { unique: true, name: "unique_audit_working_paper_creation" }
);
AuditWorkingPaperSchema.index(
  { firmId: 1, engagementId: 1, createdAt: -1, _id: -1 },
  { name: "audit_working_paper_engagement_created_desc" }
);
AuditWorkingPaperSchema.index(
  { firmId: 1, priorWorkingPaperId: 1 },
  { name: "audit_working_paper_prior_lookup" }
);

const AuditWorkingPaper = mongoose.model("AuditWorkingPaper", AuditWorkingPaperSchema);
export default AuditWorkingPaper;
