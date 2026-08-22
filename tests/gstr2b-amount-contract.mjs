// tests/gstr2b-amount-contract.mjs
//
// Why this exists. capro-backend/src/services/gstr2b-json.service.js's num() used to
// return 0 for any value Number() could not read, with no warning at all -- so a portal
// export (or a hand-edited one) carrying "1,18,000.00" or "n/a" produced a row with zero
// IGST and no sign anything was wrong. A CA would reconcile against a tax figure of nil
// and the file would look perfectly clean. This is the same defect class as the date-order
// guess (C1-C10 in .kiro/finalreleasefix.md), on money instead of dates.
//
// Pure logic only - no database, no network, no server import.
//
// Run: node tests/gstr2b-amount-contract.mjs

import assert from "node:assert/strict";
import { convertGstr2bJson } from "../src/services/gstr2b-json.service.js";
import { parseMappedImport } from "../src/services/import-preview.service.js";

const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass, detail });

function docWithIgst(igst) {
  return {
    data: {
      gstin: "27AABCR0000A1Z5",
      rtnprd: "042026",
      docdata: { b2b: [{ ctin: "27AABCS1111A1Z5", inv: [{ inum: "INV-1", dt: "05-04-2026", txval: 1000, igst }] }] },
    },
  };
}

function docWithItems(igstValues) {
  return {
    data: {
      gstin: "27AABCR0000A1Z5",
      rtnprd: "042026",
      docdata: {
        b2b: [{
          ctin: "27AABCS1111A1Z5",
          inv: [{
            inum: "INV-1",
            dt: "05-04-2026",
            items: igstValues.map((igst) => ({ txval: 100, igst })),
          }],
        }],
      },
    },
  };
}

// ─── Negative control: the readability distinction actually discriminates ────

check(
  "negative control: '1,18,000.00' and 'n/a' are told apart -- the assertions below are not vacuously true",
  (() => {
    const good = convertGstr2bJson(docWithIgst("1,18,000.00")).warnings.some((w) => w.code === "AMOUNT_UNREADABLE");
    const bad = convertGstr2bJson(docWithIgst("n/a")).warnings.some((w) => w.code === "AMOUNT_UNREADABLE");
    return good === false && bad === true;
  })(),
);

// ─── A comma-grouped Indian amount survives instead of vanishing ─────────────

check(
  "convertGstr2bJson: igst '1,18,000.00' produces the CSV cell '1,18,000.00', no warning, and igstMinor 11800000 downstream",
  (() => {
    const conversion = convertGstr2bJson(docWithIgst("1,18,000.00"));
    const hasWarning = conversion.warnings.some((w) => w.code === "AMOUNT_UNREADABLE");
    const cellIsExact = conversion.csv.includes('"1,18,000.00"');
    const parsed = parseMappedImport({ kind: "GSTR2B", text: conversion.csv, mapping: conversion.mapping });
    return !hasWarning && cellIsExact && parsed.rows[0].values.igstMinor === 11_800_000;
  })(),
);

// ─── A genuinely unreadable amount warns at conversion and fails at import ───

check(
  "convertGstr2bJson: igst 'n/a' emits one AMOUNT_UNREADABLE warning and yields INVALID_MONEY downstream with invalidRows 1",
  (() => {
    const conversion = convertGstr2bJson(docWithIgst("n/a"));
    const unreadableWarnings = conversion.warnings.filter((w) => w.code === "AMOUNT_UNREADABLE");
    const parsed = parseMappedImport({ kind: "GSTR2B", text: conversion.csv, mapping: conversion.mapping });
    return unreadableWarnings.length === 1
      && parsed.summary.invalidRows === 1
      && parsed.errors.some((e) => e.code === "INVALID_MONEY");
  })(),
);

// ─── A genuinely absent tax head stays a real, unwarned nil ──────────────────

check(
  "convertGstr2bJson: an absent igst key yields 0 with no warning (a genuinely nil tax head must not become an error)",
  (() => {
    const conversion = convertGstr2bJson(docWithIgst(undefined));
    const hasWarning = conversion.warnings.some((w) => w.code === "AMOUNT_UNREADABLE");
    const parsed = parseMappedImport({ kind: "GSTR2B", text: conversion.csv, mapping: conversion.mapping });
    return !hasWarning && parsed.rows[0].values.igstMinor === 0;
  })(),
);

// ─── Summed (items-array) path: unreadable member flagged, sum still computed ──

check(
  "convertGstr2bJson: a summed document with one unreadable item member is flagged, and the sum still totals the readable members",
  (() => {
    const conversion = convertGstr2bJson(docWithItems([100, "garbage", 50]));
    const hasWarning = conversion.warnings.some((w) => w.code === "AMOUNT_UNREADABLE");
    const parsed = parseMappedImport({ kind: "GSTR2B", text: conversion.csv, mapping: conversion.mapping });
    return hasWarning && parsed.rows[0].values.igstMinor === 15_000; // 100 + 50, in paise
  })(),
);
check(
  "convertGstr2bJson: a summed document with every item readable is not flagged",
  !convertGstr2bJson(docWithItems([100, 50])).warnings.some((w) => w.code === "AMOUNT_UNREADABLE"),
);

// ─── Report ───────────────────────────────────────────────────────

let passed = 0;
for (const entry of checks) {
  const mark = entry.pass ? "PASS" : "FAIL";
  if (entry.pass) passed += 1;
  console.log(`[${mark}] ${entry.name}${entry.detail ? ` — ${entry.detail}` : ""}`);
}

const total = checks.length;
console.log(`\nGSTR-2B amount contract: ${passed}/${total}`);

if (passed !== total) {
  console.error(`\n${total - passed} check(s) failed.`);
  process.exit(1);
}
