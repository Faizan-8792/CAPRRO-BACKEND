import mongoose from "mongoose";

const OVERRIDE_ACTIONS = Object.freeze(["APPLY", "SKIP", "DATE_OVERRIDE"]);

const ComplianceOverrideSchema = new mongoose.Schema(
  {
    firmId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Firm",
      required: true,
      index: true,
    },
    clientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      required: true,
      index: true,
    },
    ruleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ComplianceRule",
      required: true,
    },
    ruleVersion: { type: Number, required: true, min: 1 },
    ruleCode: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      maxlength: 80,
    },
    period: { type: String, required: true, trim: true, maxlength: 80 },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    action: { type: String, enum: OVERRIDE_ACTIONS, required: true },
    dueDate: { type: Date, default: null },
    reason: { type: String, required: true, trim: true, maxlength: 1000 },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    reviewedAt: { type: Date, required: true, default: Date.now },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true, optimisticConcurrency: true }
);

ComplianceOverrideSchema.pre("validate", function validateOverride(next) {
  if (this.action === "DATE_OVERRIDE" && !this.dueDate) {
    return next(new Error("DATE_OVERRIDE requires dueDate"));
  }
  if (this.action !== "DATE_OVERRIDE") this.dueDate = null;
  if (this.periodStart && this.periodEnd && this.periodEnd < this.periodStart) {
    return next(new Error("periodEnd cannot be before periodStart"));
  }
  return next();
});

ComplianceOverrideSchema.index(
  { firmId: 1, clientId: 1, ruleCode: 1, period: 1 },
  { unique: true }
);
ComplianceOverrideSchema.index({ firmId: 1, period: 1, ruleCode: 1 });
ComplianceOverrideSchema.index({ firmId: 1, ruleId: 1, periodStart: 1 });

const ComplianceOverride = mongoose.model(
  "ComplianceOverride",
  ComplianceOverrideSchema
);

export { OVERRIDE_ACTIONS };
export default ComplianceOverride;
