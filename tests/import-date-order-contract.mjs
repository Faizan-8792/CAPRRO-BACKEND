// tests/import-date-order-contract.mjs
//
// Why this exists. capro-backend/src/services/robust-normalize.service.js used to guess
// day-first for every ambiguous numeric date (both fields <= 12 -- roughly 39% of a typical
// register). A US-locale Excel export of a GST purchase register is MM/DD/YYYY, so
// 03/05/2026 was silently booked as 3 May instead of the intended 5 March, with no warning
// and no record that a guess was ever made. That wrong document date then decided which
// return period an input tax credit fell into, and flowed into gst-matching.service.js as a
// false DATE_MISMATCH. The only prior test of parseFlexibleDateIso used a month NAME
// ("05-Apr-2026"), which can never be ambiguous, so the branch that decided 39% of rows had
// zero coverage. This file exists so that gap cannot reopen silently.
//
// Pure logic only - no database, no network, no server import.
//
// Run: node tests/import-date-order-contract.mjs

import assert from "node:assert/strict";
import {
  DATE_ORDER,
  DATE_ORDER_STATUS,
  classifyDateColumn,
  classifyNumericDate,
  parseFlexibleDateIso,
  resolveDateOrder,
} from "../src/services/robust-normalize.service.js";
import { parseMappedImport } from "../src/services/import-preview.service.js";
import { convertGstr2bJson } from "../src/services/gstr2b-json.service.js";
import {
  buildImportFingerprint,
} from "../src/services/gst-import.service.js";
import {
  buildTdsImportFingerprint,
} from "../src/services/tds-import.service.js";

const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass, detail });

const GST_MAPPING = {
  supplierGstin: "S",
  recipientGstin: "R",
  invoiceNumber: "Inv",
  documentDate: "Dt",
  documentType: "Ty",
  taxableValue: "Tax",
  igst: "I",
  cgst: "C",
  sgst: "Sg",
  cess: "Ce",
};

function gstRow(inv, date) {
  return `27AABCS1111A1Z5,27AABCR0000A1Z5,${inv},${date},Invoice,1000,180,0,0,0`;
}

function gstCsv(...dates) {
  const rows = dates.map((d, i) => gstRow(`INV${i + 1}`, d)).join("\n");
  return `S,R,Inv,Dt,Ty,Tax,I,C,Sg,Ce\n${rows}\n`;
}

// ─── Negative control: the swap logic actually discriminates ─────────

check(
  "negative control: parseFlexibleDateIso's dateOrder parameter changes an ambiguous row's reading",
  parseFlexibleDateIso("03/05/2026", { dateOrder: "MONTH_FIRST" }) !==
    parseFlexibleDateIso("03/05/2026"),
  "so the assertions below cannot pass against a parser that silently ignores the option " +
    `(default=${parseFlexibleDateIso("03/05/2026")}, MONTH_FIRST=${parseFlexibleDateIso("03/05/2026", { dateOrder: "MONTH_FIRST" })})`,
);

// ─── parseFlexibleDateIso: both-fields-<=12 in each direction ────────

check(
  "parseFlexibleDateIso: 03/05/2026 defaults to day-first (2026-05-03)",
  parseFlexibleDateIso("03/05/2026") === "2026-05-03",
);
check(
  "parseFlexibleDateIso: 03/05/2026 under MONTH_FIRST reads as 2026-03-05 (the exact bug case)",
  parseFlexibleDateIso("03/05/2026", { dateOrder: "MONTH_FIRST" }) === "2026-03-05",
);

// ─── A proving row is immune to the file's resolved order ────────────

check(
  "parseFlexibleDateIso: a proving row (25/06) is read the same way under BOTH orders",
  parseFlexibleDateIso("25/06/2026") === "2026-06-25" &&
    parseFlexibleDateIso("25/06/2026", { dateOrder: "MONTH_FIRST" }) === "2026-06-25",
);

// ─── Both fields > 12 is impossible under either order ───────────────

check(
  "parseFlexibleDateIso: 13/13/2026 (both fields > 12) is null under either order",
  parseFlexibleDateIso("13/13/2026") === null &&
    parseFlexibleDateIso("13/13/2026", { dateOrder: "MONTH_FIRST" }) === null,
);

// ─── 2-digit years across the expandYear boundary, in both orders ────

check(
  "parseFlexibleDateIso: 2-digit year boundary (03/05/26 -> 2026, 03/05/80 -> 1980), both orders",
  parseFlexibleDateIso("03/05/26") === "2026-05-03" &&
    parseFlexibleDateIso("03/05/26", { dateOrder: "MONTH_FIRST" }) === "2026-03-05" &&
    parseFlexibleDateIso("03/05/80") === "1980-05-03" &&
    parseFlexibleDateIso("03/05/80", { dateOrder: "MONTH_FIRST" }) === "1980-03-05",
);

// ─── DD-Mon-YYYY, ISO, YYYYMMDD, Excel serial: unaffected by dateOrder ──

check(
  "parseFlexibleDateIso: DD-Mon-YYYY / 'D Month YY' unaffected by dateOrder",
  parseFlexibleDateIso("05-Apr-2026") === "2026-04-05" &&
    parseFlexibleDateIso("05-Apr-2026", { dateOrder: "MONTH_FIRST" }) === "2026-04-05" &&
    parseFlexibleDateIso("5 April 26") === "2026-04-05",
);
check(
  "parseFlexibleDateIso: ISO / YYYYMMDD / Excel serial unaffected by dateOrder",
  parseFlexibleDateIso("2026-05-03") === "2026-05-03" &&
    parseFlexibleDateIso("2026-05-03", { dateOrder: "MONTH_FIRST" }) === "2026-05-03" &&
    parseFlexibleDateIso("20260503") === "2026-05-03" &&
    parseFlexibleDateIso("20260503", { dateOrder: "MONTH_FIRST" }) === "2026-05-03" &&
    parseFlexibleDateIso("46143") === parseFlexibleDateIso("46143", { dateOrder: "MONTH_FIRST" }),
);

// ─── classifyNumericDate: shape and proof ─────────────────────────────

check(
  "classifyNumericDate: NUMERIC/proves DAY_FIRST, MONTH_FIRST, null (ambiguous), IMPOSSIBLE",
  classifyNumericDate("25/06/2026").proves === "DAY_FIRST" &&
    classifyNumericDate("06/25/2026").proves === "MONTH_FIRST" &&
    classifyNumericDate("03/05/2026").proves === null &&
    classifyNumericDate("13/13/2026").proves === "IMPOSSIBLE",
);
check(
  "classifyNumericDate: UNAMBIGUOUS for ISO/month-name/serial, UNPARSEABLE for junk",
  classifyNumericDate("2026-05-03").shape === "UNAMBIGUOUS" &&
    classifyNumericDate("05-Apr-2026").shape === "UNAMBIGUOUS" &&
    classifyNumericDate("46143").shape === "UNAMBIGUOUS" &&
    classifyNumericDate("not a date").shape === "UNPARSEABLE",
);

// ─── classifyDateColumn: five branches ────────────────────────────────

check(
  "classifyDateColumn: DAY_FIRST (one proving row) names the evidence row",
  (() => {
    const r = classifyDateColumn([{ row: 2, value: "03/05/2026" }, { row: 3, value: "25/06/2026" }]);
    return r.status === "DAY_FIRST" && r.dayFirstEvidenceRow === 3 && r.ambiguousRows === 1;
  })(),
);
check(
  "classifyDateColumn: MONTH_FIRST (one proving row)",
  (() => {
    const r = classifyDateColumn([{ row: 2, value: "03/05/2026" }, { row: 3, value: "07/25/2026" }]);
    return r.status === "MONTH_FIRST" && r.monthFirstEvidenceRow === 3;
  })(),
);
check(
  "classifyDateColumn: CONFLICTING (rows proving both orders) names both evidence rows",
  (() => {
    const r = classifyDateColumn([{ row: 2, value: "25/06/2026" }, { row: 3, value: "06/25/2026" }]);
    return r.status === "CONFLICTING" && r.dayFirstEvidenceRow === 2 && r.monthFirstEvidenceRow === 3;
  })(),
);
check(
  "classifyDateColumn: AMBIGUOUS (no row disambiguates, but numeric rows exist)",
  classifyDateColumn([{ row: 2, value: "03/05/2026" }]).status === "AMBIGUOUS",
);
check(
  "classifyDateColumn: NOT_APPLICABLE (no numeric-shaped row at all)",
  classifyDateColumn([
    { row: 2, value: "2026-05-03" },
    { row: 3, value: "05-Apr-2026" },
    { row: 4, value: "46143" },
  ]).status === "NOT_APPLICABLE",
);

// ─── resolveDateOrder: stated overrides, CONFLICTING/NOT_APPLICABLE never do ──

check(
  "resolveDateOrder: a stated value resolves an AMBIGUOUS classification",
  resolveDateOrder({
    classification: classifyDateColumn([{ row: 2, value: "03/05/2026" }]),
    stated: "MONTH_FIRST",
  }).resolved === "MONTH_FIRST",
);
check(
  "resolveDateOrder: CONFLICTING stays CONFLICTING regardless of a stated value",
  resolveDateOrder({
    classification: classifyDateColumn([{ row: 2, value: "25/06/2026" }, { row: 3, value: "06/25/2026" }]),
    stated: "DAY_FIRST",
  }).status === "CONFLICTING",
);
check(
  "resolveDateOrder: NOT_APPLICABLE stays NOT_APPLICABLE with resolved null, regardless of a stated value",
  (() => {
    const r = resolveDateOrder({
      classification: classifyDateColumn([{ row: 2, value: "2026-05-03" }]),
      stated: "MONTH_FIRST",
    });
    return r.status === "NOT_APPLICABLE" && r.resolved === null;
  })(),
);
check(
  "resolveDateOrder: an unsupported stated value is reported, not silently ignored",
  resolveDateOrder({
    classification: classifyDateColumn([{ row: 2, value: "03/05/2026" }]),
    stated: "SIDEWAYS_FIRST",
  }).status === "UNSUPPORTED",
);

// ─── File-level behaviour through parseMappedImport: GST_PURCHASE ─────

check(
  "parseMappedImport (GST_PURCHASE): a day-first-proving file parses every ambiguous row day-first",
  (() => {
    const r = parseMappedImport({ kind: "GST_PURCHASE", text: gstCsv("03/05/2026", "04/06/2026", "25/07/2026"), mapping: GST_MAPPING });
    return r.dateOrder.status === "DAY_FIRST"
      && r.dateOrder.dayFirstEvidenceRow === 4
      && r.rows[0].values.documentDate === "2026-05-03"
      && r.rows[1].values.documentDate === "2026-06-04";
  })(),
);
check(
  "parseMappedImport (GST_PURCHASE): the SAME file with one date flipped resolves MONTH_FIRST -- the exact bug case",
  (() => {
    const r = parseMappedImport({ kind: "GST_PURCHASE", text: gstCsv("03/05/2026", "04/06/2026", "07/25/2026"), mapping: GST_MAPPING });
    return r.dateOrder.status === "MONTH_FIRST" && r.rows[0].values.documentDate === "2026-03-05";
  })(),
);
check(
  "parseMappedImport (GST_PURCHASE): a conflicting file throws 400 IMPORT_DATE_ORDER_CONFLICTING naming both rows",
  (() => {
    try {
      parseMappedImport({ kind: "GST_PURCHASE", text: gstCsv("25/06/2026", "06/25/2026"), mapping: GST_MAPPING });
      return false;
    } catch (error) {
      return error.statusCode === 400
        && error.code === "IMPORT_DATE_ORDER_CONFLICTING"
        && error.details?.dayFirstEvidenceRow === 2
        && error.details?.monthFirstEvidenceRow === 3;
    }
  })(),
);
check(
  "parseMappedImport (GST_PURCHASE): an ambiguous file returns 0 invalidRows, previewRows===totalRows, one warning per affected row",
  (() => {
    const r = parseMappedImport({ kind: "GST_PURCHASE", text: gstCsv("03/05/2026", "04/06/2026"), mapping: GST_MAPPING });
    const dorWarnings = r.warnings.filter((w) => w.code === "DATE_ORDER_REQUIRED");
    return r.dateOrder.status === "AMBIGUOUS"
      && r.summary.invalidRows === 0
      && r.summary.previewRows === r.summary.totalRows
      && dorWarnings.length === 2;
  })(),
);
check(
  "parseMappedImport (GST_PURCHASE): a stated order on the same ambiguous text resolves it with source STATED",
  (() => {
    const r = parseMappedImport({ kind: "GST_PURCHASE", text: gstCsv("03/05/2026", "04/06/2026"), mapping: GST_MAPPING, dateOrder: "MONTH_FIRST" });
    return r.dateOrder.status === "AMBIGUOUS" && r.dateOrder.source === "STATED" && r.rows[0].values.documentDate === "2026-03-05";
  })(),
);

// ─── File-level behaviour through parseMappedImport: TDS_DEDUCTIONS ───

check(
  "parseMappedImport (TDS_DEDUCTIONS): the same file-level resolution applies to transactionDate",
  (() => {
    const csv = "PAN,Sec,Date,Paid,Ded\nABCPS1234K,194J,03/05/2026,1000,100\nABCPS1234K,194J,25/07/2026,1000,100\n";
    const mapping = { deducteePan: "PAN", sectionCode: "Sec", transactionDate: "Date", amountPaid: "Paid", deductedAmount: "Ded" };
    const r = parseMappedImport({ kind: "TDS_DEDUCTIONS", text: csv, mapping });
    return r.dateOrder.status === "DAY_FIRST" && r.rows[0].values.transactionDate === "2026-05-03";
  })(),
);

// ─── GSTR-2B JSON path: pinned day-first, never pushed into a wrong reading ──

check(
  "GSTR-2B JSON: convertGstr2bJson pins day-first per the GSTN schema, so parseMappedImport reports NOT_APPLICABLE",
  (() => {
    const conversion = convertGstr2bJson({
      data: { gstin: "27AABCR0000A1Z5", rtnprd: "042026", docdata: { b2b: [{ ctin: "27AABCS1111A1Z5", inv: [{ inum: "INV-1", dt: "05-04-2026", txval: 1000, igst: 180 }] }] } },
    });
    const parsed = parseMappedImport({ kind: "GSTR2B", text: conversion.csv, mapping: conversion.mapping });
    return conversion.csv.includes("2026-04-05") && parsed.dateOrder.status === "NOT_APPLICABLE";
  })(),
);

// ─── Fingerprint anti-swap: dateOrder is bound into both fingerprints ──

check(
  "buildImportFingerprint (GST): differs when only dateOrder differs",
  (() => {
    const base = { sourceHash: "a".repeat(64), kind: "GST_PURCHASE", mapping: { documentDate: "Dt" }, delimiter: ",", clientId: "c1", gstin: "27AABCS1111A1Z5", period: "2026-04" };
    return buildImportFingerprint({ ...base, dateOrder: "DAY_FIRST" }) !== buildImportFingerprint({ ...base, dateOrder: "MONTH_FIRST" });
  })(),
);
check(
  "buildTdsImportFingerprint (TDS): differs when only dateOrder differs",
  (() => {
    const base = { sourceHash: "b".repeat(64), kind: "TDS_DEDUCTIONS", mapping: { transactionDate: "Dt" }, delimiter: ",", clientId: "c1", tan: "AAAA99999A", financialYear: "2026-27", quarter: "Q1", statementType: "24Q" };
    return buildTdsImportFingerprint({ ...base, dateOrder: "DAY_FIRST" }) !== buildTdsImportFingerprint({ ...base, dateOrder: "MONTH_FIRST" });
  })(),
);

// ─── Report ───────────────────────────────────────────────────────

let passed = 0;
for (const entry of checks) {
  const mark = entry.pass ? "PASS" : "FAIL";
  if (entry.pass) passed += 1;
  console.log(`[${mark}] ${entry.name}${entry.detail ? ` — ${entry.detail}` : ""}`);
}

const total = checks.length;
console.log(`\nImport date-order contract: ${passed}/${total}`);

if (passed !== total) {
  console.error(`\n${total - passed} check(s) failed.`);
  process.exit(1);
}
