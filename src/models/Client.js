import mongoose from "mongoose";

const ClientSchema = new mongoose.Schema(
  {
    firmId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Firm",
      required: true,
    },
    name: { type: String, required: true, trim: true },
    gstin: { type: String, trim: true, uppercase: true },
    pan: { type: String, trim: true, uppercase: true },
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

const Client = mongoose.model("Client", ClientSchema);
export default Client;
