// Pure/preflight intake checks plus a real PDF.js parse of a valid blank PDF. This never submits a
// statement and never writes any input to disk.

import assert from "node:assert/strict";
import {
  BANK_STATEMENT_INTAKE_CODES as C,
  extractBankStatementTextPositions,
  inspectBankStatementPdf,
  orderBankStatementTextItems,
} from "../src/services/bank-statement-intake.service.js";

function tinyPdf() {
  const header = "%PDF-1.4\n";
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>\nendobj\n",
  ];
  let length = Buffer.byteLength(header, "ascii");
  const offsets = objects.map((chunk) => {
    const offset = length;
    length += Buffer.byteLength(chunk, "ascii");
    return offset;
  });
  const xrefOffset = length;
  return Buffer.from(`${header}${objects.join("")}xref\n0 4\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`, "ascii");
}

function positionedPdf() {
  const stream = "BT /F1 12 Tf 10 100 Td (Debit) Tj 40 0 Td (Credit) Tj 40 0 Td (Balance) Tj -80 -20 Td (Date) Tj 40 0 Td (Narration) Tj ET";
  const header = "%PDF-1.4\n";
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    `5 0 obj\n<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}\nendstream\nendobj\n`,
  ];
  let length = Buffer.byteLength(header, "ascii");
  const offsets = objects.map((object) => { const offset = length; length += Buffer.byteLength(object, "ascii"); return offset; });
  const xrefOffset = length;
  return Buffer.from(`${header}${objects.join("")}xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`, "ascii");
}

const checks = [];
async function check(name, callback) {
  try {
    await callback();
    checks.push({ name, pass: true });
  } catch (error) {
    checks.push({ name, pass: false, detail: error.message });
  }
}

await check("content, not the extension, decides whether a file is a PDF", async () => {
  const result = await inspectBankStatementPdf({ bytes: Buffer.from("not a PDF"), fileName: "statement.pdf" });
  assert.equal(result.rejection.code, C.INVALID_PDF);
  assert.match(result.file.sha256, /^[a-f0-9]{64}$/);
});

await check("active PDF content is rejected before a parser is invoked", async () => {
  const result = await inspectBankStatementPdf({ bytes: Buffer.from("%PDF-1.4\n1 0 obj << /JavaScript 2 0 R >>"), fileName: "safe-name.pdf" });
  assert.equal(result.rejection.code, C.UNSAFE);
});

await check("a genuine PDF with no visible text is rejected as unsupported instead of being guessed", async () => {
  const result = await inspectBankStatementPdf({ bytes: tinyPdf(), fileName: "blank.pdf" });
  assert.equal(result.rejection.code, C.SCANNED);
  assert.deepEqual(result.rejection.pages, [1]);
});

await check("file-size, page-count, and processing-time limits fail closed", async () => {
  const bytes = positionedPdf();
  assert.equal((await inspectBankStatementPdf({ bytes, limits: { maxBytes: 1 } })).rejection.code, C.FILE_LIMIT);
  assert.equal((await inspectBankStatementPdf({ bytes, limits: { maxPages: 0 } })).rejection.code, C.FILE_LIMIT);
  assert.equal((await inspectBankStatementPdf({ bytes, limits: { maxProcessingMs: -1 } })).rejection.code, C.UNSAFE);
});

await check("coordinate order wins over PDF content-stream order", async () => {
  const ordered = orderBankStatementTextItems([
    { text: "right", x: 80, y: 100 }, { text: "below", x: 0, y: 70 }, { text: "left", x: 10, y: 100 },
  ]);
  assert.deepEqual(ordered.map((item) => item.text), ["left", "right", "below"]);
});

await check("positional extraction returns visible text with page coordinates only after safe intake", async () => {
  const result = await extractBankStatementTextPositions({ bytes: positionedPdf(), fileName: "layout.pdf" });
  assert.equal(result.accepted, true);
  assert.equal(result.pages.length, 1);
  assert.deepEqual(result.pages[0].items.map((item) => item.text), ["Debit", "Credit", "Balance", "Date", "Narration"]);
  assert.ok(result.pages[0].items.every((item) => Number.isFinite(item.x) && Number.isFinite(item.y)));
});

const failed = checks.filter((entry) => !entry.pass);
for (const result of checks) console.log(`${result.pass ? "PASS" : "FAIL"} ${result.name}${result.detail ? `: ${result.detail}` : ""}`);
if (failed.length) {
  console.error(`bank-statement intake contract failed: ${failed.length}/${checks.length}`);
  process.exitCode = 1;
} else {
  console.log(`bank-statement intake contract passed: ${checks.length}/${checks.length}`);
}
