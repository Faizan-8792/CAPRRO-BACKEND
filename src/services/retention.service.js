import AccountingRecord from "../models/AccountingRecord.js";

/**
 * Deletes expired accounting records permanently
 * Called only from controllers (no cron, no background job)
 */
export async function cleanupExpiredAccountingRecords(firmId = null) {
  const now = new Date();

  const filter = {
    expiresAt: { $lte: now },
  };

  if (firmId) {
    filter.firmId = firmId;
  }

  const result = await AccountingRecord.deleteMany(filter);
  return result.deletedCount || 0;
}
