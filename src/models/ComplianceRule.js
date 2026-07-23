import mongoose from "mongoose";
import { TAX_TYPES } from "./TaxWorkSession.js";

const RULE_STATUSES = Object.freeze(["DRAFT", "IN_REVIEW", "ACTIVE", "RETIRED"]);
const RULE_FREQUENCIES = Object.freeze([
  "MONTHLY",
  "QUARTERLY",
  "ANNUAL",
  "EVENT_DRIVEN",
]);
const DUE_DATE_POLICIES = Object.freeze([
  "DAY_OF_MONTH",
  "DAYS_AFTER_PERIOD_END",
  "MANUAL",
]);
const TITLE_TEMPLATE_FIELDS = Object.freeze([
  "clientName",
  "code",
  "period",
  "ruleTitle",
  "dueDate",
]);
const TITLE_TEMPLATE_PATTERN = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

function isValidTitleTemplate(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  const unknownPlaceholder = [...value.matchAll(TITLE_TEMPLATE_PATTERN)].some(
    (match) => !TITLE_TEMPLATE_FIELDS.includes(match[1])
  );
  if (unknownPlaceholder) return false;
  return !/[{}]/.test(value.replace(TITLE_TEMPLATE_PATTERN, ""));
}

const DueDatePolicySchema = new mongoose.Schema(
  {
    type: { type: String, enum: DUE_DATE_POLICIES, required: true },
    day: { type: Number, min: 1, max: 31, default: null },
    monthOffset: { type: Number, min: 0, max: 24, default: 0 },
    offsetDays: { type: Number, min: -365, max: 730, default: 0 },
  },
  { _id: false }
);

const GenerationPolicySchema = new mongoose.Schema(
  {
    createTask: { type: Boolean, default: true },
    createTaxWorkSession: { type: Boolean, default: true },
    createReminder: { type: Boolean, default: true },
    taskServiceType: {
      type: String,
      enum: ["GST", "TDS", "ITR", "ROC", "AUDIT", "OTHER"],
      default: "OTHER",
    },
    taxWorkType: {
      type: String,
      enum: TAX_TYPES,
      trim: true,
      default: "OTHER",
    },
    titleTemplate: {
      type: String,
      trim: true,
      maxlength: 240,
      default: "{clientName} - {code} - {period}",
      validate: {
        validator: isValidTitleTemplate,
        message: `Title templates may use only: ${TITLE_TEMPLATE_FIELDS.join(", ")}`,
      },
    },
  },
  { _id: false }
);

const ComplianceRuleSchema = new mongoose.Schema(
  {
    firmId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Firm",
      default: null,
      index: true,
    },
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      maxlength: 80,
      match: /^[A-Z0-9_]+$/,
    },
    version: { type: Number, required: true, min: 1 },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    status: { type: String, enum: RULE_STATUSES, default: "DRAFT", index: true },
    frequency: { type: String, enum: RULE_FREQUENCIES, required: true },
    entityTypes: { type: [String], default: [] },
    dueDatePolicy: { type: DueDatePolicySchema, required: true },
    generationPolicy: { type: GenerationPolicySchema, default: () => ({}) },
    defaultReminderOffsets: {
      type: [Number],
      default: [-7, -3, -1, 0],
      validate: {
        validator: (values) =>
          values.every(
            (value) => Number.isInteger(value) && value >= -365 && value <= 365
          ),
        message: "Reminder offsets must be whole days between -365 and 365",
      },
    },
    effectiveFrom: { type: Date, required: true },
    effectiveTo: { type: Date, default: null },
    sourceReference: { type: String, trim: true, maxlength: 1000, default: "" },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    reviewedAt: { type: Date, default: null },
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

ComplianceRuleSchema.pre("validate", function validateActiveRule(next) {
  if (this.status === "ACTIVE") {
    if (!this.reviewedBy || !this.reviewedAt || !this.sourceReference) {
      return next(
        new Error("Active rules require reviewer, review timestamp, and source reference")
      );
    }
  }

  const policy = this.dueDatePolicy || {};
  if (policy.type === "DAY_OF_MONTH" && !Number.isInteger(policy.day)) {
    return next(new Error("DAY_OF_MONTH rules require a valid day"));
  }
  if (
    policy.type === "DAYS_AFTER_PERIOD_END" &&
    (policy.day != null || Number(policy.monthOffset || 0) !== 0)
  ) {
    return next(
      new Error("DAYS_AFTER_PERIOD_END cannot include day or monthOffset")
    );
  }
  if (
    policy.type === "MANUAL" &&
    (policy.day != null ||
      Number(policy.monthOffset || 0) !== 0 ||
      Number(policy.offsetDays || 0) !== 0)
  ) {
    return next(new Error("MANUAL due dates cannot include calculated fields"));
  }

  const generationPolicy = this.generationPolicy || {};
  if (
    !generationPolicy.createTask &&
    !generationPolicy.createTaxWorkSession &&
    !generationPolicy.createReminder
  ) {
    return next(new Error("Generation policy must create at least one artifact"));
  }
  if (!isValidTitleTemplate(generationPolicy.titleTemplate)) {
    return next(
      new Error(
        `Title templates may use only: ${TITLE_TEMPLATE_FIELDS.join(", ")}`
      )
    );
  }
  if (this.effectiveTo && this.effectiveTo < this.effectiveFrom) {
    return next(new Error("effectiveTo cannot be before effectiveFrom"));
  }
  this.defaultReminderOffsets = [...new Set(this.defaultReminderOffsets)].sort(
    (a, b) => a - b
  );
  return next();
});

ComplianceRuleSchema.index({ firmId: 1, code: 1, version: 1 }, { unique: true });
ComplianceRuleSchema.index(
  { firmId: 1, code: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "ACTIVE" },
    name: "one_active_compliance_rule_per_scope",
  }
);
ComplianceRuleSchema.index({ firmId: 1, status: 1, effectiveFrom: 1, effectiveTo: 1 });
ComplianceRuleSchema.index({ code: 1, status: 1, effectiveFrom: 1 });

const ComplianceRule = mongoose.model("ComplianceRule", ComplianceRuleSchema);

export { RULE_STATUSES, RULE_FREQUENCIES, DUE_DATE_POLICIES };
export default ComplianceRule;
