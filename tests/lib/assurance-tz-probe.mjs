// tests/lib/assurance-tz-probe.mjs
//
// Prints the assembly timer's answers at fixed moments as JSON. tests/engagement-assurance-contract.mjs
// runs it under several TZ values (Node reads TZ at process start) and requires identical output: the
// 60-day timer counts UTC days, so no local zone may move a deadline or change a state.

import { assemblyStatus } from "../../src/services/engagement-assurance.service.js";

const REPORT = "2026-08-01"; // + 60 UTC days = 2026-09-30
const moments = [
  "2026-09-29T00:00:00Z",
  "2026-09-30T00:00:00Z",
  "2026-09-30T23:59:59Z", // still the last day in UTC; already 1 Oct in India
  "2026-10-01T00:00:00Z", // first overdue day
  "2026-10-01T18:00:00Z", // 1 Oct in UTC, 2 Oct on Kiritimati
];
const out = { open: {}, assembled: {} };
for (const m of moments) {
  const s = assemblyStatus({ reportDate: REPORT, assembledAt: null }, new Date(m));
  out.open[m] = [s.state, s.deadline, s.daysLeft, s.lateByDays];
  const a = assemblyStatus({ reportDate: REPORT, assembledAt: new Date(m) }, new Date("2027-01-01T00:00:00Z"));
  out.assembled[m] = [a.state, a.assembledOn, a.lateByDays];
}
console.log(JSON.stringify(out));
