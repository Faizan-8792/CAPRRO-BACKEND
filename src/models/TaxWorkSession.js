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
TaxWorkSessionSchema.index({ ownerUserId: 1, firmId: 1, status: 1 });
TaxWorkSessionSchema.index({ ownerUserId: 1, firmId: 1, dueDate: 1 });

const TaxWorkSession = mongoose.model("TaxWorkSession", TaxWorkSessionSchema);

export { TAX_TYPES, STATUSES };
export default TaxWorkSession;
