import mongoose from "mongoose";

/**
 * How one taxpayer filed in one quarter, as the GST downloader read it (GD30; GST-DOWNLOADER-PLAN
 * section 8.13; owner decision OD4): monthly or quarterly, whether the reading is still provisional
 * (a quarter whose opt-in window is open), where it was read, and when it was first and last seen.
 *
 * One row per (firm, GSTIN, financial year, quarter), upserted. Metadata about a filing choice
 * only: no return content, no amount, no person.
 */
export const GST_FREQUENCY_SOURCES = Object.freeze(["rolestatus", "scan", "profile"]);

const GstFrequencyObservationSchema = new mongoose.Schema(
  {
    firmId: { type: mongoose.Schema.Types.ObjectId, ref: "Firm", required: true },
    gstin: { type: String, required: true, minlength: 15, maxlength: 15 },
    fy: { type: String, required: true, minlength: 7, maxlength: 7 },
    quarter: { type: Number, required: true, min: 1, max: 4 },
    freq: { type: String, required: true, enum: ["M", "Q"] },
    provisional: { type: Boolean, default: false },
    source: { type: String, required: true, enum: GST_FREQUENCY_SOURCES },
    firstSeenAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
  },
  { collection: "gstfrequencyobservations", versionKey: false },
);

GstFrequencyObservationSchema.index({ firmId: 1, gstin: 1, fy: 1, quarter: 1 }, { unique: true });

export default mongoose.model("GstFrequencyObservation", GstFrequencyObservationSchema);
