import mongoose from "mongoose";

const ENTITY_TYPES = Object.freeze([
  "INDIVIDUAL",
  "HUF",
  "PROPRIETORSHIP",
  "PARTNERSHIP",
  "LLP",
  "PRIVATE_LIMITED",
  "PUBLIC_LIMITED",
  "TRUST",
  "SOCIETY",
  "AOP_BOI",
  "OTHER",
]);
const APPLICABILITY_STATUSES = Object.freeze([
  "APPLICABLE",
  "NOT_APPLICABLE",
  "NEEDS_REVIEW",
]);
const ONBOARDING_SOURCES = Object.freeze(["MANUAL", "CSV"]);

const ComplianceSettingSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      maxlength: 80,
    },
    applicability: {
      type: String,
      enum: APPLICABILITY_STATUSES,
      default: "NEEDS_REVIEW",
    },
    frequency: {
      type: String,
      enum: ["MONTHLY", "QUARTERLY", "ANNUAL", "EVENT_DRIVEN", "OTHER"],
      default: "OTHER",
    },
    reminderOffsets: {
      type: [Number],
      default: [],
      validate: {
        validator: (values) =>
          values.every(
            (value) => Number.isInteger(value) && value >= -365 && value <= 365
          ),
        message: "Reminder offsets must be whole days between -365 and 365",
      },
    },
    notes: { type: String, trim: true, maxlength: 500, default: "" },
    updatedAt: { type: Date, default: Date.now },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { _id: false }
);

const ClientSchema = new mongoose.Schema(
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
    name: { type: String, required: true, trim: true },
    gstin: { type: String, trim: true, uppercase: true },
    pan: { type: String, trim: true, uppercase: true },
    tan: { type: String, trim: true, uppercase: true, select: false },
    clientCode: {
      type: String,
      trim: true,
      uppercase: true,
      maxlength: 80,
      select: false,
    },
    entityType: {
      type: String,
      enum: ENTITY_TYPES,
      default: "OTHER",
      select: false,
    },
    tags: {
      type: [String],
      default: [],
      select: false,
      set: (values) =>
        Array.isArray(values)
          ? [...new Set(values.map((value) => String(value).trim()).filter(Boolean))].slice(0, 50)
          : [],
    },
    complianceProfile: {
      type: [ComplianceSettingSchema],
      default: [],
      select: false,
    },
    profileReviewedAt: { type: Date, default: null, select: false },
    profileReviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      select: false,
    },
    onboardingSource: {
      type: String,
      enum: ONBOARDING_SOURCES,
      default: "MANUAL",
      select: false,
    },
    contactPerson: { type: String, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    notes: { type: String, trim: true },
    isActive: { type: Boolean, default: true },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

ClientSchema.index({ firmId: 1, isActive: 1 });
ClientSchema.index({ firmId: 1, name: 1 });
ClientSchema.index({ firmId: 1, gstin: 1 });
ClientSchema.index({ firmId: 1, pan: 1 });
ClientSchema.index({ firmId: 1, clientCode: 1 });
ClientSchema.index({ firmId: 1, "complianceProfile.code": 1 });
ClientSchema.index({ ownerUserId: 1, firmId: 1, isActive: 1 });

const Client = mongoose.model("Client", ClientSchema);

export {
  ENTITY_TYPES,
  APPLICABILITY_STATUSES,
  ONBOARDING_SOURCES,
};
export default Client;
