import mongoose from "mongoose";

/**
 * The latest state of one GST downloader file, for one firm (GD30; GST-DOWNLOADER-PLAN section 8.13;
 * owner decision OD4, 2026-10-04: run records on the server, per firm, behind a recording switch
 * that starts on).
 *
 * One row per (firm, GSTIN, return, format, period) - an upsert, so the collection is bounded by
 * clients x returns x periods however many runs there are. It holds run METADATA only: what state
 * the file reached, its name, size and SHA-256, when it was saved, which run and portal-map version
 * produced it, the GSTR-2B generation stamp and the generation ledger's counts. Never the file,
 * never an amount, never a credential. It names no person: the firm is the owner of the record.
 */
export const GST_DOWNLOAD_RETURN_TYPES = Object.freeze([
  "GSTR-1",
  "GSTR-2A",
  "GSTR-2B",
  "GSTR-2BQ",
  "GSTR-3B",
  "GSTR-9",
  "GSTR-9C",
  "GSTR-9 8A",
  "ECL",
  "ECASH",
]);
export const GST_DOWNLOAD_FILE_TYPES = Object.freeze(["pdf", "excel", "json", "word"]);
// The extension's one status vocabulary (failure-taxonomy.js ITEM_STATES).
export const GST_DOWNLOAD_STATES = Object.freeze([
  "queued",
  "needs-sign-in",
  "preparing",
  "downloading",
  "downloaded",
  "nothing-on-portal",
  "not-filed",
  "not-due-quarterly",
  "failed-retrying",
  "failed-retryable",
  "failed-final",
  "already-downloaded",
  "stopped",
]);
export const GST_DOWNLOAD_LIMITS = Object.freeze({
  outcomeChars: 48,
  fileNameChars: 200,
  runIdChars: 64,
  highestMapVersion: 1000000,
  highestBytes: 2 ** 40,
  highestRequests: 1000,
});

const GstDownloadRecordSchema = new mongoose.Schema(
  {
    firmId: { type: mongoose.Schema.Types.ObjectId, ref: "Firm", required: true },
    gstin: { type: String, required: true, minlength: 15, maxlength: 15 },
    returnType: { type: String, required: true, enum: GST_DOWNLOAD_RETURN_TYPES },
    fileType: { type: String, required: true, enum: GST_DOWNLOAD_FILE_TYPES },
    // "2025-04", the annual "FY:2025-26", or the ledger's "ledger".
    period: { type: String, required: true, maxlength: 12 },
    state: { type: String, required: true, enum: GST_DOWNLOAD_STATES },
    outcome: { type: String, default: "", maxlength: GST_DOWNLOAD_LIMITS.outcomeChars },
    fileName: { type: String, default: "", maxlength: GST_DOWNLOAD_LIMITS.fileNameChars },
    bytes: { type: Number, default: 0, min: 0, max: GST_DOWNLOAD_LIMITS.highestBytes },
    sha256: { type: String, default: "", maxlength: 64 },
    savedAt: { type: Date, default: null },
    // When the run recorded this state: a later sync never overwrites a newer state.
    observedAt: { type: Date, required: true },
    runId: { type: String, default: "", maxlength: GST_DOWNLOAD_LIMITS.runIdChars },
    mapVersion: { type: Number, default: 1, min: 1, max: GST_DOWNLOAD_LIMITS.highestMapVersion },
    // GST Portal's own generation date of a GSTR-2B statement, as the portal writes it (dd-mm-yyyy).
    gstr2bGeneratedOn: { type: String, default: "", maxlength: 10 },
    // The generation ledger's fields (GD14): how often GST Portal was asked to prepare the file.
    ledger: {
      requests: { type: Number, default: 0, min: 0, max: GST_DOWNLOAD_LIMITS.highestRequests },
      firstRequestedAt: { type: Date, default: null },
      lastRequestedAt: { type: Date, default: null },
      capped: { type: Boolean, default: false },
      cappedAt: { type: Date, default: null },
      capReason: { type: String, enum: ["", "no-file", "stuck"], default: "" },
    },
    firstRecordedAt: { type: Date, required: true },
  },
  { collection: "gstdownloadrecords", versionKey: false, timestamps: { createdAt: false, updatedAt: true } },
);

GstDownloadRecordSchema.index({ firmId: 1, gstin: 1, returnType: 1, fileType: 1, period: 1 }, { unique: true });
GstDownloadRecordSchema.index({ firmId: 1, period: 1 });

export default mongoose.model("GstDownloadRecord", GstDownloadRecordSchema);
