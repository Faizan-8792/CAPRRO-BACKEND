// tests/lib/deadline-tz-probe.mjs
//
// Prints what the deadline catalogue computes at one fixed moment, as JSON. tests/deadline-catalogue-
// contract.mjs runs it as a child process under several TZ values: Node reads TZ when the process
// starts, so only a separate process can change the zone the Date object sees.
//
//   node tests/lib/deadline-tz-probe.mjs           the real implementation
//   node tests/lib/deadline-tz-probe.mjs --naive   the wrong way (local Date methods), used only to prove
//                                                  that the zones DO change a naive answer, so the test
//                                                  comparing the real answers is not vacuous

import {
  daysUntil,
  effectiveDate,
  isoDayFromNumber,
  parseIsoDay,
  publishableCatalogue,
  utcDayNumber,
} from "../../src/services/deadline-catalogue.service.js";

// 23:30 UTC on 31 October is already 1 November in India (UTC+5:30) and 14 hours ahead of that on
// Kiritimati; it is still 31 October (afternoon) in Los Angeles and 12:30 on the 31st in Pago Pago.
const NOW = new Date("2026-10-31T23:30:00Z");
const DAYS = ["2026-10-30", "2026-10-31", "2026-11-01", "2027-03-31", "2028-02-29"];

if (process.argv.includes("--naive")) {
  const out = {};
  for (const iso of DAYS) {
    const d = new Date(iso); // parsed as UTC midnight...
    out[iso] = {
      dayOfMonth: d.getDate(), // ...read back in the local zone: 30 for a zone west of UTC
      month: d.getMonth() + 1,
      localMidnightDelta: Math.round((d - new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate())) / 86_400_000),
    };
  }
  console.log(JSON.stringify(out));
} else {
  const out = { now: utcDayNumber(NOW) };
  for (const iso of DAYS) {
    const parsed = parseIsoDay(iso);
    out[iso] = {
      dayNumber: parsed.dayNumber,
      roundTrip: isoDayFromNumber(parsed.dayNumber),
      daysUntil: daysUntil(iso, NOW),
    };
  }
  out.publishable = publishableCatalogue({
    version: 3,
    publishedAt: null,
    entries: [
      { formKey: "ITR", label: "Income tax return", clientType: "ALL", financialYear: "2025-26", statutoryDate: "2026-07-31", extendedDate: "2026-09-15", extensionReference: "Circular 12/2026", note: "" },
      { formKey: "TAR", label: "Tax audit report", clientType: "ALL", financialYear: "2025-26", statutoryDate: "2026-09-30", extendedDate: null, extensionReference: "", note: "" },
    ],
  }).entries.map((e) => [e.formKey, e.statutoryDate, e.extendedDate, e.effectiveDate]);
  out.effective = [effectiveDate({ statutoryDate: "2026-07-31", extendedDate: null }), effectiveDate({ statutoryDate: "2026-07-31", extendedDate: "2026-09-15" })];
  console.log(JSON.stringify(out));
}
