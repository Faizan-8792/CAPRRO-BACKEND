import mongoose from "mongoose";

const TAX_TYPES = [
  "GST_MONTHLY",
  "GST_QUARTERLY",
  "GST_ANNUAL",
  "GST_AUDIT",
  "TDS_QUARTERLY",
  "ITR_INDIVIDUAL",
  "ITR_FIRM",
  "ITR_COMPANY",
  "TAX_AUDIT",
  "ROC_ANNUAL",
  "PT",
  "PF_ESI",
  "EQUALISATION_LEVY",
  "OTHER",
];

const STATUSES = ["DRAFT", "IN_PROGRESS", "COMPLETE", "ARCHIVED"];

const DocItemSchema = new mongoose.Schema(
  {
    docKey: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    required: { type: Boolean, default: true },
    received: { type: Boolean, default: false },
    receivedAt: { type: Date, default: null },
    receivedByUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    notes: { type: String, trim: true, default: "" },
    fileRef: { type: String, default: null }, // reserved for future file uploads
    isCustom: { type: Boolean, default: false },
  },
  { _id: false }
);

const TaxWorkSessionSchema = new mongoose.Schema(
  {
    firmId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Firm",
      default: null,
      index: true,
    },
    ownerUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    clientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      required: true,
    },
    taxType: { type: String, enum: TAX_TYPES, required: true },
    period: { type: String, trim: true, default: "" },
    dueDate: { type: Date, default: null },
    status: { type: String, enum: STATUSES, default: "DRAFT" },
    documents: { type: [DocItemSchema], default: [] },
    source: {
      type: String,
      enum: [
        "MANUAL",
        "COMPLIANCE_RULE",
        "IMPORT",
        "CASE",
        "ENGAGEMENT",
      ],
      default: "MANUAL",
    },
    taskId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Task",
      default: null,
    },
    reminderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Reminder",
      default: null,
    },
    complianceRuleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ComplianceRule",
      default: null,
    },
    complianceRuleVersion: { type: Number, min: 1, default: null },
    complianceCode: {
      type: String,
      trim: true,
      uppercase: true,
      maxlength: 80,
      default: null,
    },
    ruleSourceReference: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: null,
    },
    generationKey: {
      type: String,
      trim: true,
      maxlength: 200,
      default: null,
    },
    automationJobId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AutomationJob",
      default: null,
    },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    completedAt: { type: Date, default: null },
    notes: { type: String, trim: true, default: "" },
  },
  { timestamps: true }
);

TaxWorkSessionSchema.index({ firmId: 1, status: 1 });
TaxWorkSessionSchema.index({ firmId: 1, clientId: 1 });
TaxWorkSessionSchema.index({ firmId: 1, taxType: 1 });
TaxWorkSessionSchema.index({ firmId: 1, assignedTo: 1 });
TaxWorkSessionSchema.index({ firmId: 1, dueDate: 1 });
TaxWorkSessionSchema.index(
  { firmId: 1, status: 1, dueDate: 1, _id: 1 },
  { name: "workspace_session_firm_due" }
);
TaxWorkSessionSchema.index(
  { firmId: 1, assignedTo: 1, status: 1, dueDate: 1, _id: 1 },
  { name: "workspace_session_assignee_due" }
);
TaxWorkSessionSchema.index(
  { firmId: 1, ownerUserId: 1, status: 1, dueDate: 1, _id: 1 },
  { name: "workspace_session_owner_due" }
);
TaxWorkSessionSchema.index(
  { firmId: 1, completedAt: -1, _id: 1 },
  { name: "workspace_session_completion" }
);
TaxWorkSessionSchema.index({ ownerUserId: 1, firmId: 1, status: 1 });
TaxWorkSessionSchema.index({ ownerUserId: 1, firmId: 1, dueDate: 1 });
TaxWorkSessionSchema.index(
  { firmId: 1, generationKey: 1 },
  {
    unique: true,
    partialFilterExpression: { generationKey: { $type: "string" } },
    name: "unique_generated_tax_work_session_per_firm",
  }
);

const TaxWorkSession = mongoose.model("TaxWorkSession", TaxWorkSessionSchema);

export { TAX_TYPES, STATUSES };
export default TaxWorkSession;
