import mongoose from "mongoose";

const TermsAcceptanceSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      maxlength: 320,
      immutable: true,
    },
    termsVersion: {
      type: String,
      required: true,
      trim: true,
      maxlength: 64,
      immutable: true,
    },
    documentHash: {
      type: String,
      required: true,
      match: /^[a-f0-9]{64}$/,
      immutable: true,
    },
    source: {
      type: String,
      required: true,
      enum: ["DESKTOP"],
      immutable: true,
    },
    acceptedAt: {
      type: Date,
      required: true,
      default: Date.now,
      immutable: true,
    },
  },
  {
    versionKey: false,
  }
);

TermsAcceptanceSchema.index(
  { userId: 1, termsVersion: 1 },
  { unique: true, name: "unique_user_terms_version" }
);
TermsAcceptanceSchema.index({ acceptedAt: -1 });
TermsAcceptanceSchema.index({ email: 1, acceptedAt: -1 });

const TermsAcceptance = mongoose.model(
  "TermsAcceptance",
  TermsAcceptanceSchema
);

export default TermsAcceptance;
