import mongoose from "mongoose";

const ItemSchema = new mongoose.Schema(
  {
    key: { type: String },
    label: { type: String },
    status: {
      type: String,
      enum: ["REQUESTED", "RECEIVED", "INCOMPLETE", "PENDING"],
      default: "REQUESTED",
    },
    note: { type: String },
    updatedAt: { type: Date },
  },
  { _id: false }
);

const DocumentRequestSchema = new mongoose.Schema(
  {
    firmId: { type: mongoose.Schema.Types.ObjectId, ref: "Firm", required: true },
    clientId: { type: String },
    clientName: { type: String },
    items: { type: [ItemSchema], default: [] },
    status: {
      type: String,
      enum: ["REQUESTED", "PENDING", "RECEIVED", "INCOMPLETE"],
      default: "REQUESTED",
    },
    dueDateISO: { type: String },
    meta: { type: mongoose.Schema.Types.Mixed },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

const DocumentRequest = mongoose.model("DocumentRequest", DocumentRequestSchema);
export default DocumentRequest;
