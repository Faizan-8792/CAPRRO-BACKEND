import mongoose from "mongoose";

const FINDING_STATUSES = Object.freeze([
  "OPEN",
  "MANAGEMENT_RESPONSE_PENDING",
  "ACTION_IN_PROGRESS",
  "FOLLOW_UP_PENDING",
  "READY_FOR_REVIEW",
  "CLOSED",
  "ACCEPTED_RISK",
]);
const FINDING_RISKS = Object.freeze(["UNASSESSED", "LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const FOLLOW_UP_RESULTS = Object.freeze([
  "NOT_STARTED",
  "EFFECTIVE",
  "PARTIAL",
  "INEFFECTIVE",
  "NOT_APPLICABLE",
]);

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

const EngagementFindingSchema = new mongoose.Schema(
  {
    firmId: { type: mongoose.Schema.Types.ObjectId, ref: "Firm", required: true },
    engagementId: { type: mongoose.Schema.Types.ObjectId, ref: "Engagement", required: true },
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: "Client", required: true },
    title: { type: String, trim: true, maxlength: 500, required: true },
    description: { type: String, trim: true, maxlength: 10000, required: true },
    category: { type: String, trim: true, uppercase: true, maxlength: 120, required: true },
    risk: { type: String, enum: FINDING_RISKS, default: "UNASSESSED" },
    status: { type: String, enum: FINDING_STATUSES, default: "OPEN" },
    evidenceReferences: {
      type: [String],
      default: [],
      validate: {
        validator: (values) => values.length <= 100 && values.every((value) => value.length <= 2000),
        message: "Finding evidence references exceed allowed bounds",
      },
    },
    aiProvenance: {
      type: new mongoose.Schema(
        {
          source: {
            type: String,
            enum: ["AUDIT_WORKING_PAPER"],
            required: true,
            immutable: true,
          },
          workingPaperId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "AuditWorkingPaper",
            required: true,
            immutable: true,
          },
          analysisId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "AuditWorkingPaperAnalysis",
            required: true,
            immutable: true,
          },
          proposalId: {
            type: String,
            trim: true,
            maxlength: 120,
            required: true,
            immutable: true,
          },
          sourceRows: {
            type: [
              new mongoose.Schema(
                {
                  rowId: {
                    type: mongoose.Schema.Types.ObjectId,
                    ref: "AuditWorkingPaperRow",
                    required: true,
                    immutable: true,
                  },
                  contentHash: {
                    type: String,
                    match: /^[a-f0-9]{64}$/,
                    required: true,
                    immutable: true,
                  },
                },
                { _id: false }
              ),
            ],
            required: true,
            immutable: true,
            validate: [
              {
                validator: (values) => values.length > 0 && values.length <= 50,
                message: "AI provenance must cite 1-50 working-paper rows",
              },
              {
                validator: (values) =>
                  new Set(values.map((value) => String(value.rowId))).size === values.length,
                message: "AI provenance source rows must be unique",
              },
            ],
          },
          humanDecision: {
            type: String,
            enum: ["ACCEPTED", "EDITED"],
            required: true,
            immutable: true,
          },
          decidedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            immutable: true,
          },
          decidedAt: { type: Date, required: true, immutable: true },
          provenanceVersion: {
            type: String,
            trim: true,
            maxlength: 80,
            default: "",
            immutable: true,
          },
          decisionSnapshot: {
            type: new mongoose.Schema(
              {
                title: { type: String, trim: true, maxlength: 500, required: true },
                description: { type: String, trim: true, maxlength: 10000, required: true },
                category: { type: String, trim: true, uppercase: true, maxlength: 120, required: true },
                risk: { type: String, enum: FINDING_RISKS, required: true },
                evidenceReferences: {
                  type: [String],
                  required: true,
                  validate: {
                    validator: (values) =>
                      values.length > 0 &&
                      values.length <= 100 &&
                      values.every((value) => value.length <= 2000),
                    message: "AI decision snapshot evidence references exceed allowed bounds",
                  },
                },
              },
              { _id: false }
            ),
            default: null,
            immutable: true,
          },
          decisionContentHash: {
            type: String,
            match: /^[a-f0-9]{64}$/,
            default: null,
            immutable: true,
          },
          currentContentHash: {
            type: String,
            match: /^[a-f0-9]{64}$/,
            default: null,
          },
          humanEditLineage: {
            type: [
              new mongoose.Schema(
                {
                  mutationKey: {
                    type: String,
                    trim: true,
                    maxlength: 120,
                    required: true,
                    immutable: true,
                  },
                  editedBy: {
                    type: mongoose.Schema.Types.ObjectId,
                    ref: "User",
                    required: true,
                    immutable: true,
                  },
                  editedAt: { type: Date, required: true, immutable: true },
                  changedFields: {
                    type: [{ type: String, enum: ["title", "description", "category", "risk", "evidenceReferences"] }],
                    required: true,
                    immutable: true,
                    validate: {
                      validator: (values) =>
                        values.length > 0 &&
                        values.length <= 5 &&
                        new Set(values).size === values.length,
                      message: "AI finding edit lineage fields must be unique and bounded",
                    },
                  },
                  beforeContentHash: {
                    type: String,
                    match: /^[a-f0-9]{64}$/,
                    required: true,
                    immutable: true,
                  },
                  afterContentHash: {
                    type: String,
                    match: /^[a-f0-9]{64}$/,
                    required: true,
                    immutable: true,
                  },
                },
                { _id: false }
              ),
            ],
            default: [],
            validate: [
              {
                validator: (values) => values.length <= 500,
                message: "AI finding edit lineage limit reached",
              },
              {
                validator: (values) =>
                  new Set(values.map((value) => value.mutationKey)).size === values.length,
                message: "AI finding edit lineage mutation keys must be unique",
              },
            ],
          },
        },
        { _id: false }
      ),
      default: null,
    },
    managementResponse: {
      text: { type: String, trim: true, maxlength: 10000, default: "" },
      respondedAt: { type: Date, default: null },
      recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    },
    action: {
      plan: { type: String, trim: true, maxlength: 10000, default: "" },
      ownerUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      dueAt: { type: Date, default: null },
      completedAt: { type: Date, default: null },
      completionNote: { type: String, trim: true, maxlength: 5000, default: "" },
    },
    followUp: {
      result: { type: String, enum: FOLLOW_UP_RESULTS, default: "NOT_STARTED" },
      note: { type: String, trim: true, maxlength: 10000, default: "" },
      verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      verifiedAt: { type: Date, default: null },
    },
    review: {
      decision: { type: String, enum: ["PENDING", "APPROVED", "CHANGES_REQUESTED"], default: "PENDING" },
      note: { type: String, trim: true, maxlength: 5000, default: "" },
      reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      reviewedAt: { type: Date, default: null },
    },
    closedAt: { type: Date, default: null },
    closedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    professionalConclusionGenerated: {
      type: Boolean,
      default: false,
      immutable: true,
      validate: {
        validator: (value) => value === false,
        message: "Professional conclusion generation is disabled",
      },
    },
    creationMutationKey: { type: String, trim: true, maxlength: 120, required: true, immutable: true },
    creationRequestHash: { type: String, match: /^[a-f0-9]{64}$/, required: true, immutable: true },
    mutationReceipts: {
      type: [MutationReceiptSchema],
      default: [],
      validate: [
        {
          validator: (values) => values.length <= 1000,
          message: "Finding mutation receipt limit reached",
        },
        {
          validator: (values) => new Set(values.map((value) => value.key)).size === values.length,
          message: "Finding mutation receipt keys must be unique",
        },
      ],
    },
    revision: { type: Number, min: 1, default: 1 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true, optimisticConcurrency: true }
);

EngagementFindingSchema.index(
  { firmId: 1, engagementId: 1, creationMutationKey: 1 },
  { unique: true, name: "unique_engagement_finding_creation_mutation" }
);
EngagementFindingSchema.index(
  { firmId: 1, engagementId: 1, createdAt: -1, _id: -1 },
  { name: "engagement_finding_created_desc" }
);
EngagementFindingSchema.index(
  { firmId: 1, engagementId: 1, status: 1, risk: 1, updatedAt: -1, _id: -1 },
  { name: "engagement_finding_status_risk" }
);

const EngagementFinding = mongoose.model("EngagementFinding", EngagementFindingSchema);

export { FINDING_RISKS, FINDING_STATUSES, FOLLOW_UP_RESULTS };
export default EngagementFinding;
