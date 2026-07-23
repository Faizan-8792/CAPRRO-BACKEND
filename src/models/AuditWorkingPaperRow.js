import mongoose from "mongoose";

const rowArrayLimit = (maximum, label) => ({
  validator: (values) => values.length <= maximum,
  message: `${label} exceeds ${maximum} entries`,
});

const AuditWorkingPaperRowSchema = new mongoose.Schema(
  {
    firmId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Firm",
      required: true,
      immutable: true,
    },
    workingPaperId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AuditWorkingPaper",
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
    rowKey: {
      type: String,
      trim: true,
      uppercase: true,
      maxlength: 120,
      required: true,
      immutable: true,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 2000,
      required: true,
      immutable: true,
    },
    observedValue: {
      type: String,
      trim: true,
      maxlength: 4000,
      default: "",
      immutable: true,
    },
    currentAmountMinor: {
      type: Number,
      default: null,
      immutable: true,
      validate: {
        validator: (value) => value == null || Number.isSafeInteger(value),
        message: "Current amount must be a safe integer in minor units",
      },
    },
    sourceReference: {
      type: String,
      trim: true,
      maxlength: 2000,
      required: true,
      immutable: true,
    },
    assertionTags: {
      type: [String],
      default: [],
      immutable: true,
      validate: rowArrayLimit(20, "Assertion tags"),
    },
    note: {
      type: String,
      trim: true,
      maxlength: 5000,
      default: "",
      immutable: true,
    },
    contentHash: {
      type: String,
      match: /^[a-f0-9]{64}$/,
      required: true,
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
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

AuditWorkingPaperRowSchema.index(
  { firmId: 1, workingPaperId: 1, creationMutationKey: 1 },
  { unique: true, name: "unique_audit_working_paper_row_creation" }
);
AuditWorkingPaperRowSchema.index(
  { firmId: 1, workingPaperId: 1, rowKey: 1 },
  { unique: true, name: "unique_audit_working_paper_row_key" }
);
AuditWorkingPaperRowSchema.index(
  { firmId: 1, workingPaperId: 1, createdAt: 1, _id: 1 },
  { name: "audit_working_paper_row_created_asc" }
);

const rejectMutation = function rejectMutation(next) {
  next(new Error("Audit working-paper source rows are append-only"));
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
  AuditWorkingPaperRowSchema.pre(hook, rejectMutation);
}

const AuditWorkingPaperRow = mongoose.model(
  "AuditWorkingPaperRow",
  AuditWorkingPaperRowSchema
);
export default AuditWorkingPaperRow;
