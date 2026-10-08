import mongoose from "mongoose";

/**
 * Whether one taxpayer had filed one return for one month, as a CA-started GST downloader run
 * read it (decision D4, IMPROVEMENT-PLAN-V2 section 4.9; GD33; the firm's recording switch is
 * owner decision OD4): the coarse class only, when the row was first and last seen, and the run
 * that last saw it.
 *
 * One row per (firm, GSTIN, return, month), upserted, so the multi-client filing board is bounded
 * by clients x returns x months, not by runs. No amount, no document content, no person. The V2
 * design keyed the row on (GSTIN, return, period); the firm leads the key here because two firms
 * can serve one client and must never share a row.
 */
export const FILING_STATUS_RETURN_TYPES = Object.freeze(["GSTR-1", "GSTR-3B"]);
export const FILING_STATUS_CLASSES = Object.freeze(["filed", "not_filed", "late_fee_flagged", "invalid"]);

const FilingStatusObservationSchema = new mongoose.Schema(
  {
    firmId: { type: mongoose.Schema.Types.ObjectId, ref: "Firm", required: true },
    gstin: { type: String, required: true, minlength: 15, maxlength: 15 },
    returnType: { type: String, required: true, enum: FILING_STATUS_RETURN_TYPES },
    period: { type: String, required: true, match: /^20\d{2}-(0[1-9]|1[0-2])$/ },
    statusClass: { type: String, required: true, enum: FILING_STATUS_CLASSES },
    firstSeenAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
    sourceRunId: { type: String, default: "", maxlength: 64 },
  },
  { collection: "filingstatusobservations", versionKey: false },
);

FilingStatusObservationSchema.index({ firmId: 1, gstin: 1, returnType: 1, period: 1 }, { unique: true });

export default mongoose.model("FilingStatusObservation", FilingStatusObservationSchema);
