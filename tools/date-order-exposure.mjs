#!/usr/bin/env node
// .kiro/finalreleasefix.md C9 -- measures how many GST/TDS rows committed BEFORE C3's fix landed
// (ImportBatch.dateOrder missing or empty) may hold a date that was silently guessed day-first.
//
// READ-ONLY. This script never writes or deletes anything. It cannot recover which reading
// (day-first or month-first) was actually correct for an ambiguous batch -- CA PRO stores only
// the SHA-256 of the source text, never the text itself, and a stored ISO date of 2026-03-13 is
// produced identically by a day-first "13/03/2026" and a month-first "03/13/2026". This tool
// measures exposure; it does not and must not attempt correction. See C9's own task text for the
// full reasoning and the owner decision this report exists to inform.
//
// Usage:
//   node tools/date-order-exposure.mjs                 (uses process.env.MONGODB_URI)
//   MONGODB_URI="mongodb://..." node tools/date-order-exposure.mjs

import mongoose from "mongoose";
import ImportBatch from "../src/models/ImportBatch.js";
import ImportRow from "../src/models/ImportRow.js";
import TdsImportRow from "../src/models/TdsImportRow.js";

const GST_KINDS_WITH_DATES = new Set(["GST_PURCHASE", "GSTR2B", "GSTR3B_SUMMARY"]);
const TDS_DATE_FIELDS = ["transactionDate", "challanDate", "filedDate", "creditDate"];

function dayOfMonth(isoDate) {
  // isoDate is a "YYYY-MM-DD" string (or null/empty); the day-of-month is the last 2 digits.
  if (!isoDate || typeof isoDate !== "string" || isoDate.length < 10) return null;
  const day = Number(isoDate.slice(8, 10));
  return Number.isInteger(day) ? day : null;
}

async function collectGstDateValues(batchId) {
  const rows = await ImportRow.find({ batchId }).select("documentDate").lean();
  return rows
    .map((row) => dayOfMonth(row.documentDate))
    .filter((day) => day !== null);
}

async function collectTdsDateValues(batchId) {
  const rows = await TdsImportRow.find({ batchId })
    .select(TDS_DATE_FIELDS.join(" "))
    .lean();
  const days = [];
  for (const row of rows) {
    for (const field of TDS_DATE_FIELDS) {
      const day = dayOfMonth(row[field]);
      if (day !== null) days.push(day);
    }
  }
  return days;
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("REFUSED: MONGODB_URI is not set. This is a read-only report; nothing runs without it.");
    process.exit(1);
  }

  mongoose.set("strictQuery", true);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });

  try {
    const batches = await ImportBatch.find({
      dateOrder: { $in: [null, ""] },
      kind: { $nin: ["CLIENTS"] }, // CLIENTS imports carry no statutory transaction date
    })
      .select("firmId kind gstin tan period sourceName committedAt")
      .lean();

    console.log(`ImportBatch documents with missing/empty dateOrder (pre-C3, date-bearing kinds only): ${batches.length}`);
    console.log("");

    let fullyGuessedCount = 0;
    let partiallyExposedCount = 0;
    let totalExposedRows = 0;

    for (const batch of batches) {
      const isGst = GST_KINDS_WITH_DATES.has(batch.kind);
      const days = isGst
        ? await collectGstDateValues(batch._id)
        : await collectTdsDateValues(batch._id);

      if (days.length === 0) {
        // No dated rows at all (e.g. a TDS_DEDUCTIONS batch whose rows never populated a date
        // field, or a fully empty import) -- nothing to measure, correctly omitted rather than
        // reported as either exposed or safe.
        continue;
      }

      const exposedRows = days.filter((day) => day <= 12).length;
      const hasDisambiguatingRow = days.some((day) => day > 12);
      totalExposedRows += exposedRows;

      if (exposedRows === 0) continue; // every date > 12, no ambiguity at all for this batch

      if (!hasDisambiguatingRow) {
        fullyGuessedCount += 1;
      } else {
        partiallyExposedCount += 1;
      }

      const identifier = batch.gstin || batch.tan || "(no gstin/tan)";
      console.log(
        [
          `firmId=${batch.firmId}`,
          `batchId=${batch._id}`,
          `kind=${batch.kind}`,
          `identifier=${identifier}`,
          `period=${batch.period || "(none)"}`,
          `sourceName=${batch.sourceName || "(none)"}`,
          `committedAt=${batch.committedAt ? batch.committedAt.toISOString() : "(none)"}`,
          `totalDatedValues=${days.length}`,
          `exposedValues=${exposedRows}`,
          hasDisambiguatingRow
            ? "exposure=PARTIAL (at least one date >12, direction still unknowable from the stored ISO value)"
            : "exposure=FULL (every date <=12, no disambiguating row -- entire date column was guessed)",
        ].join("  ")
      );
    }

    console.log("");
    console.log("===== SUMMARY =====");
    console.log(`batches fully guessed (highest exposure): ${fullyGuessedCount}`);
    console.log(`batches partially exposed (lower, not zero, exposure): ${partiallyExposedCount}`);
    console.log(`total individual date values <=12 across all exposed batches: ${totalExposedRows}`);
    console.log("");
    console.log(
      "REMINDER: the original day-first/month-first reading is NOT recoverable from stored data."
    );
    console.log(
      "This report measures exposure only. Do not write a migration that rewrites stored dates --"
    );
    console.log("any such rewrite would be a second silent guess on top of the first.");
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error("REFUSED: " + error.message);
  process.exit(1);
});
