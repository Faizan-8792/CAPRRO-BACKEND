import mongoose from "mongoose";
import {
  ENGAGEMENT_STATUSES,
  ENGAGEMENT_TYPES,
} from "../config/engagement-templates.js";

const MutationReceiptSchema = new mongoose.Schema(
  {
    key: { type: String, trim: true, maxlength: 120, required: true },
    action: { type: String, trim: true, maxlength: 80, required: true },
    requestHash: { type: String, match: /^[a-f0-9]{64}$/, required: true },
    resultId: { type: String, trim: true, maxlength: 120, default: "" },
    appliedRevision: { type: Number, min: 1, required: true },
    appliedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const ChecklistItemSchema = new mongoose.Schema(
  {
    templateKey: { type: String, trim: true, maxlength: 120, required: true },
    title: { type: String, trim: true, maxlength: 500, required: true },
    category: { type: String, trim: true, maxlength: 80, default: "" },
    required: { type: Boolean, default: true },
    status: {
      type: String,
      enum: ["OPEN", "IN_PROGRESS", "BLOCKED", "COMPLETE", "NOT_APPLICABLE"],
      default: "OPEN",
    },
    ownerUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    dueAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    completedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    evidenceReference: { type: String, trim: true, maxlength: 2000, default: "" },
    note: { type: String, trim: true, maxlength: 5000, default: "" },
  },
  { _id: true }
);

const MilestoneSchema = new mongoose.Schema(
  {
    templateKey: { type: String, trim: true, maxlength: 120, required: true },
    title: { type: String, trim: true, maxlength: 500, required: true },
    category: { type: String, trim: true, maxlength: 80, default: "" },
    required: { type: Boolean, default: true },
    status: {
      type: String,
      enum: ["PENDING", "IN_PROGRESS", "BLOCKED", "COMPLETE", "NOT_APPLICABLE"],
      default: "PENDING",
    },
    ownerUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    dueAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    completedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    note: { type: String, trim: true, maxlength: 5000, default: "" },
  },
  { _id: true }
);

const ClientRequestSchema = new mongoose.Schema(
  {
    templateKey: { type: String, trim: true, maxlength: 120, required: true },
    title: { type: String, trim: true, maxlength: 500, required: true },
    category: { type: String, trim: true, maxlength: 80, default: "" },
    required: { type: Boolean, default: true },
    status: {
      type: String,
      enum: ["NOT_REQUESTED", "REQUESTED", "PARTIAL", "RECEIVED", "WAIVED"],
      default: "NOT_REQUESTED",
    },
    ownerUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    dueAt: { type: Date, default: null },
    requestedAt: { type: Date, default: null },
    receivedAt: { type: Date, default: null },
    responseReference: { type: String, trim: true, maxlength: 2000, default: "" },
    note: { type: String, trim: true, maxlength: 5000, default: "" },
  },
  { _id: true }
);

const DeliverableSchema = new mongoose.Schema(
  {
    templateKey: { type: String, trim: true, maxlength: 120, required: true },
    title: { type: String, trim: true, maxlength: 500, required: true },
    category: { type: String, trim: true, maxlength: 80, default: "" },
    required: { type: Boolean, default: true },
    status: {
      type: String,
      enum: ["NOT_STARTED", "DRAFT", "IN_REVIEW", "APPROVED", "ISSUED", "NOT_APPLICABLE"],
      default: "NOT_STARTED",
    },
    ownerUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    dueAt: { type: Date, default: null },
    reference: { type: String, trim: true, maxlength: 2000, default: "" },
    note: { type: String, trim: true, maxlength: 5000, default: "" },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    approvedAt: { type: Date, default: null },
    issuedAt: { type: Date, default: null },
  },
  { _id: true }
);

const ReviewPointSchema = new mongoose.Schema(
  {
    title: { type: String, trim: true, maxlength: 500, required: true },
    detail: { type: String, trim: true, maxlength: 5000, default: "" },
    status: { type: String, enum: ["OPEN", "RESOLVED", "WAIVED"], default: "OPEN" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    createdAt: { type: Date, default: Date.now },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    resolvedAt: { type: Date, default: null },
    resolutionNote: { type: String, trim: true, maxlength: 5000, default: "" },
  },
  { _id: true }
);

const TemplateReviewSchema = new mongoose.Schema(
  {
    status: { type: String, enum: ["PENDING", "ATTESTED", "CHANGES_REQUESTED"], default: "PENDING" },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    reviewedAt: { type: Date, default: null },
    reviewerName: { type: String, trim: true, maxlength: 300, default: "" },
    credentialReference: { type: String, trim: true, maxlength: 500, default: "" },
    note: { type: String, trim: true, maxlength: 5000, default: "" },
    attestationText: { type: String, trim: true, maxlength: 1000, default: "" },
  },
  { _id: false }
);

const FinalReviewSchema = new mongoose.Schema(
  {
    status: { type: String, enum: ["PENDING", "APPROVED", "CHANGES_REQUESTED"], default: "PENDING" },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    reviewedAt: { type: Date, default: null },
    note: { type: String, trim: true, maxlength: 5000, default: "" },
    reviewedRevision: { type: Number, min: 1, default: null },
    reviewedContentRevision: { type: Number, min: 0, default: null },
    contentFingerprint: { type: String, match: /^[a-f0-9]{64}$/, default: null },
  },
  { _id: false }
);

const arrayLimit = (maximum, label) => ({
  validator: (values) => values.length <= maximum,
  message: `${label} exceeds ${maximum} entries`,
});

const EngagementSchema = new mongoose.Schema(
  {
    firmId: { type: mongoose.Schema.Types.ObjectId, ref: "Firm", required: true },
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: "Client", required: true },
    engagementType: { type: String, enum: ENGAGEMENT_TYPES, required: true },
    title: { type: String, trim: true, maxlength: 500, required: true },
    period: { type: String, trim: true, maxlength: 120, default: "" },
    scope: { type: String, trim: true, maxlength: 20000, required: true },
    ownerUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    teamUserIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
      default: [],
      validate: arrayLimit(50, "Engagement team"),
    },
    reviewerUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    status: { type: String, enum: ENGAGEMENT_STATUSES, default: "DRAFT" },
    stage: { type: String, trim: true, maxlength: 120, default: "INTAKE" },
    startDate: { type: Date, default: null },
    targetDate: { type: Date, required: true },
    completedAt: { type: Date, default: null },
    completedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    archivedAt: { type: Date, default: null },
    linkedTaskIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "Task" }],
      default: [],
      validate: arrayLimit(200, "Linked tasks"),
    },
    linkedTaxWorkSessionIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "TaxWorkSession" }],
      default: [],
      validate: arrayLimit(100, "Linked Tax Work sessions"),
    },
    linkedCaseIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "CaseMatter" }],
      default: [],
      validate: arrayLimit(100, "Linked cases"),
    },
    templateSnapshot: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },
    templateHash: { type: String, match: /^[a-f0-9]{64}$/, required: true, immutable: true },
    templateReview: { type: TemplateReviewSchema, default: () => ({}) },
    finalReview: { type: FinalReviewSchema, default: () => ({}) },
    checklist: {
      type: [ChecklistItemSchema],
      default: [],
      validate: arrayLimit(300, "Checklist"),
    },
    milestones: {
      type: [MilestoneSchema],
      default: [],
      validate: arrayLimit(100, "Milestones"),
    },
    clientRequests: {
      type: [ClientRequestSchema],
      default: [],
      validate: arrayLimit(200, "Client requests"),
    },
    deliverables: {
      type: [DeliverableSchema],
      default: [],
      validate: arrayLimit(100, "Deliverables"),
    },
    reviewPoints: {
      type: [ReviewPointSchema],
      default: [],
      validate: arrayLimit(500, "Review points"),
    },
    closureSummary: { type: String, trim: true, maxlength: 10000, default: "" },
    outcome: { type: String, trim: true, maxlength: 10000, default: "" },
    professionalConclusionGenerated: {
      type: Boolean,
      default: false,
      immutable: true,
      validate: {
        validator: (value) => value === false,
        message: "Professional conclusion generation is disabled",
      },
    },
    automaticPortalSubmissionPerformed: {
      type: Boolean,
      default: false,
      immutable: true,
      validate: {
        validator: (value) => value === false,
        message: "Automatic portal submission is disabled",
      },
    },
    templateQualificationVerifiedByPlatform: {
      type: Boolean,
      default: false,
      immutable: true,
      validate: {
        validator: (value) => value === false,
        message: "Platform qualification verification is not supported",
      },
    },
    creationMutationKey: { type: String, trim: true, maxlength: 120, required: true, immutable: true },
    creationRequestHash: { type: String, match: /^[a-f0-9]{64}$/, required: true, immutable: true },
    mutationReceipts: {
      type: [MutationReceiptSchema],
      default: [],
      validate: [
        arrayLimit(1000, "Engagement mutation receipts"),
        {
          validator: (values) => new Set(values.map((value) => value.key)).size === values.length,
          message: "Engagement mutation receipt keys must be unique",
        },
      ],
    },
    contentRevision: { type: Number, min: 0, default: 0 },
    revision: { type: Number, min: 1, default: 1 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true, optimisticConcurrency: true }
);

EngagementSchema.index(
  { firmId: 1, creationMutationKey: 1 },
  { unique: true, name: "unique_engagement_creation_mutation" }
);
EngagementSchema.index(
  { firmId: 1, createdAt: -1, _id: -1 },
  { name: "engagement_firm_created_desc" }
);
EngagementSchema.index(
  { firmId: 1, clientId: 1, engagementType: 1, status: 1, updatedAt: -1, _id: -1 },
  { name: "engagement_client_type_status" }
);
EngagementSchema.index(
  { firmId: 1, reviewerUserId: 1, status: 1, updatedAt: -1, _id: -1 },
  { name: "engagement_reviewer_queue" }
);

const Engagement = mongoose.model("Engagement", EngagementSchema);

export { ENGAGEMENT_STATUSES, ENGAGEMENT_TYPES };
export default Engagement;
