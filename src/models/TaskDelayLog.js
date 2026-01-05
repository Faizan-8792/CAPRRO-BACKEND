import mongoose from "mongoose";

const TaskDelayLogSchema = new mongoose.Schema(
  {
    firmId: { type: mongoose.Schema.Types.ObjectId, ref: "Firm", required: true },
    taskId: { type: mongoose.Schema.Types.ObjectId, ref: "Task", required: true },
    reason: {
      type: String,
      enum: ["CLIENT_DELAY", "DOCUMENTS_PENDING", "STAFF_WORKLOAD", "TECHNICAL"],
    },
    note: { type: String },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

const TaskDelayLog = mongoose.model("TaskDelayLog", TaskDelayLogSchema);
export default TaskDelayLog;
