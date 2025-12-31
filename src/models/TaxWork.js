import mongoose from "mongoose";

const TaxWorkSchema = new mongoose.Schema(
  {
    firmId: mongoose.Schema.Types.ObjectId,
    userId: mongoose.Schema.Types.ObjectId,
    serviceType: String,
    clientName: String,
    dueDate: String,
    checklist: Object
  },
  { timestamps: true }
);

export default mongoose.model("TaxWork", TaxWorkSchema);
