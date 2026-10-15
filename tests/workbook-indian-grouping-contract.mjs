// tests/workbook-indian-grouping-contract.mjs
//
// W10 AP9 (2026-10-15): the one workbook writer the server uses for audit pack exports.
//
// Pinned:
//   - money arrives as integer paise and is written by integer arithmetic: exact at a crore, above
//     the Int32 ceiling and at the largest safe integer, negatives included; a float is refused;
//   - money cells carry the Indian-grouped rupee format (the extension's numFmt 164 code);
//   - text is an inline string, so "=SUM(A1)" or "+91..." is stored and shown as text, never a
//     formula, and the round-trip check refuses any <f> element;
//   - a bare number is refused (an amount must say it is money);
//   - sheet names are unique and legal; the package's root relationship is typed officeDocument.
//
// Run: node tests/workbook-indian-grouping-contract.mjs

import assert from "node:assert/strict";
import {
  INDIAN_RUPEE_FORMAT,
  buildWorkbook,
  paiseToRupeeString,
  readWorkbookParts,
} from "../src/services/workbook.service.js";

const checks = [];
const check = (name, fn) => {
  try {
    fn();
    checks.push({ name, pass: true });
  } catch (error) {
    checks.push({ name, pass: false, detail: error.message.split("\n")[0] });
  }
};

check("paise to rupees is exact, including above Int32 and at the safe-integer edge", () => {
  assert.equal(paiseToRupeeString(0), "0.00");
  assert.equal(paiseToRupeeString(5), "0.05");
  assert.equal(paiseToRupeeString(123456789), "1234567.89");
  assert.equal(paiseToRupeeString(-123456789), "-1234567.89");
  assert.equal(paiseToRupeeString(2_147_483_648), "21474836.48");
  assert.equal(paiseToRupeeString(Number.MAX_SAFE_INTEGER), "90071992547409.91");
});
check("a float or an unsafe integer is refused as money", () => {
  assert.throws(() => paiseToRupeeString(10.5), /integer paise/);
  assert.throws(() => paiseToRupeeString(Number.MAX_SAFE_INTEGER + 2), /integer paise/);
});
check("the money format is the Indian-grouped rupee code the extension uses", () => {
  assert.equal(INDIAN_RUPEE_FORMAT, "[>=10000000]\"₹\"##\\,##\\,##\\,##0.00;[>=100000]\"₹\"##\\,##\\,##0.00;\"₹\"##,##0.00");
});

const bytes = buildWorkbook({
  sheets: [
    {
      name: "Clause 44",
      headers: ["Column", "Description", "Amount"],
      rows: [
        ["2", "Total expenditure", { money: 1234567890 }],
        ["7", "=SUM(A1:A9)", { money: -2_147_483_648 }],
        ["note", "+91 98765 43210", { integer: 42 }],
        ["date", { text: "@risk", wrap: true }, { date: "2026-03-31" }],
      ],
    },
    { name: "Read me", headers: ["Item", "Detail"], rows: [["Rule version", "clause44-v1"]] },
  ],
});
const parts = readWorkbookParts(bytes);
const sheet = parts.get("xl/worksheets/sheet1.xml").toString("utf8");
const styles = parts.get("xl/styles.xml").toString("utf8");

check("money cells hold exact rupee decimals with the money style", () => {
  assert.match(sheet, /<c r="C2" s="2"><v>12345678\.90<\/v><\/c>/);
  assert.match(sheet, /<c r="C3" s="2"><v>-21474836\.48<\/v><\/c>/);
});
check("the money style applies the Indian-grouped format", () => {
  const escaped = INDIAN_RUPEE_FORMAT.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  assert.ok(styles.includes(`<numFmt numFmtId="164" formatCode="${escaped}"/>`));
  assert.match(styles, /<cellXfs count="6">(?:<xf[^>]*\/>){2}<xf numFmtId="164"[^>]*applyNumberFormat="1"\/>/);
});
check("text that looks like a formula is an inline string, never a formula", () => {
  assert.match(sheet, /<c r="B3" t="inlineStr"><is><t xml:space="preserve">=SUM\(A1:A9\)<\/t><\/is><\/c>/);
  assert.match(sheet, /<t xml:space="preserve">\+91 98765 43210<\/t>/);
  assert.match(sheet, /<t xml:space="preserve">@risk<\/t>/);
  assert.ok(!/<f[\s>]/.test(sheet));
});
check("integers and dates are numeric cells with their own styles", () => {
  assert.match(sheet, /<c r="C4" s="3"><v>42<\/v><\/c>/);
  assert.match(sheet, /<c r="C5" s="4"><v>46112<\/v><\/c>/); // 31-Mar-2026 in Excel's 1900 system
});
check("headers are frozen and filterable", () => {
  assert.match(sheet, /<pane ySplit="1"/);
  assert.match(sheet, /<autoFilter ref="A1:C5"\/>/);
});
check("the root relationship is typed officeDocument and every sheet is listed in order", () => {
  assert.ok(parts.get("_rels/.rels").toString("utf8").includes("relationships/officeDocument\" Target=\"xl/workbook.xml\""));
  const workbook = parts.get("xl/workbook.xml").toString("utf8");
  assert.deepEqual([...workbook.matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]), ["Clause 44", "Read me"]);
});
check("a bare number is refused - an amount must say it is money", () => {
  assert.throws(() => buildWorkbook({ sheets: [{ name: "S", headers: ["A"], rows: [[12.5]] }] }), /bare number/);
});
check("duplicate or illegal sheet names are refused", () => {
  assert.throws(() => buildWorkbook({ sheets: [{ name: "A", headers: [], rows: [] }, { name: "A", headers: [], rows: [] }] }), /unique/);
  assert.throws(() => buildWorkbook({ sheets: [{ name: "A/B", headers: [], rows: [] }] }), /unique/);
});

const failed = checks.filter((c) => !c.pass);
for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.pass ? "" : ` -- ${c.detail}`}`);
console.log(`\nworkbook-indian-grouping-contract: ${checks.length - failed.length}/${checks.length} passed`);
process.exitCode = failed.length ? 1 : 0;
