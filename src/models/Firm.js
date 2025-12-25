import mongoose from "mongoose";

const FirmSchema = new mongoose.Schema({
  displayName: {
    type: String,
    required: true,
    trim: true,
  },
  handle: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true,
  },
  ownerUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  description: {
    type: String,
    trim: true,
  },
  practiceAreas: {
    type: [String],
    default: [],
  },
  joinCode: {
    type: String,
    required: true,
    unique: true,
  },
  planType: {
    type: String,
    enum: ["FREE", "PREMIUM"],
    default: "FREE",
  },
  planExpiry: {
    type: Date,
    default: null,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
}, { timestamps: true });

// FIXED: Correct static method - generates 6-char join code
FirmSchema.statics.generateJoinCode = function () {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";

  for (let i = 0; i < 6; i += 1) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return code;
};

// FIXED: Model definition moved OUTSIDE static method
const Firm = mongoose.model("Firm", FirmSchema);

export default Firm;