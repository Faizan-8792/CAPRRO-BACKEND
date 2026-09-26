// The isolated process boundary for bank-statement PDFs: it must give exactly the in-process
// answer for a real document, fail closed on every boundary failure, and actually refuse the
// escapes it claims to close. Nothing here writes a statement to disk or opens a network socket.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BANK_STATEMENT_INTAKE_CODES as C,
  extractBankStatementTextPositions,
  inspectBankStatementPdf,
} from "../src/services/bank-statement-intake.service.js";
import {
  bankStatementSandboxInvocation,
  runBankStatementPdfInSandbox,
} from "../src/services/bank-statement-sandbox.service.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures", "bank-statement-sandbox");

function positionedPdf() {
  const stream = "BT /F1 12 Tf 10 100 Td (Txn Date) Tj 60 0 Td (Debit) Tj 40 0 Td (Credit) Tj 40 0 Td (Balance) Tj -140 -20 Td (01/04/2026) Tj 90 0 Td (1,250.00) Tj 90 0 Td (98,750.00) Tj ET";
  const header = "%PDF-1.4\n";
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    `5 0 obj\n<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}\nendstream\nendobj\n`,
  ];
  let length = Buffer.byteLength(header, "ascii");
  const offsets = objects.map((object) => { const offset = length; length += Buffer.byteLength(object, "ascii"); return offset; });
  return Buffer.from(`${header}${objects.join("")}xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`, "ascii");
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

await check("the sandbox gives exactly the in-process intake verdict for a real statement", async () => {
  const bytes = positionedPdf();
  const isolated = await runBankStatementPdfInSandbox({ operation: "inspect", bytes, fileName: "statement.pdf" });
  const direct = await inspectBankStatementPdf({ bytes, fileName: "statement.pdf" });
  assert.equal(isolated.accepted, true, JSON.stringify(isolated.rejection));
  assert.deepEqual(isolated, direct);
});

await check("the sandbox gives exactly the in-process positional text, in coordinate order", async () => {
  const bytes = positionedPdf();
  const isolated = await runBankStatementPdfInSandbox({ operation: "extract", bytes, fileName: "statement.pdf" });
  const direct = await extractBankStatementTextPositions({ bytes, fileName: "statement.pdf" });
  assert.deepEqual(isolated, direct);
  assert.deepEqual(isolated.pages[0].items.map((item) => item.text), [
    "Txn Date", "Debit", "Credit", "Balance", "01/04/2026", "1,250.00", "98,750.00",
  ]);
});

await check("document rejections pass through unchanged", async () => {
  const notPdf = Buffer.from("not a PDF");
  assert.deepEqual(
    await runBankStatementPdfInSandbox({ operation: "inspect", bytes: notPdf, fileName: "x.pdf" }),
    await inspectBankStatementPdf({ bytes: notPdf, fileName: "x.pdf" }),
  );
  const truncated = positionedPdf().subarray(0, 120);
  const isolated = await runBankStatementPdfInSandbox({ operation: "inspect", bytes: truncated });
  assert.equal(isolated.rejection.code, C.INVALID_PDF);
});

await check("an over-limit file is refused before it crosses the boundary", async () => {
  const result = await runBankStatementPdfInSandbox({ operation: "inspect", bytes: positionedPdf(), limits: { maxBytes: 100 } });
  assert.equal(result.rejection.code, C.FILE_LIMIT);
  assert.match(result.file.sha256, /^[a-f0-9]{64}$/);
});

await check("a child that outlives the deadline is killed and the file fails closed as R-07", async () => {
  const startedAt = Date.now();
  const result = await runBankStatementPdfInSandbox({ operation: "inspect", bytes: positionedPdf(), timeoutMs: 1 });
  assert.equal(result.accepted, false);
  assert.equal(result.rejection.code, C.UNSAFE);
  assert.ok(Date.now() - startedAt < 5_000, "the deadline did not end the run");
});

await check("a child that crashes before answering fails closed as R-07", async () => {
  const result = await runBankStatementPdfInSandbox({ operation: "inspect", bytes: positionedPdf(), entry: join(FIXTURES, "crash.mjs") });
  assert.equal(result.rejection.code, C.UNSAFE);
});

await check("an answer about a different document is refused, never passed on", async () => {
  const result = await runBankStatementPdfInSandbox({ operation: "inspect", bytes: positionedPdf(), entry: join(FIXTURES, "wrong-document.mjs") });
  assert.equal(result.accepted, false);
  assert.equal(result.rejection.code, C.UNSAFE);
  assert.notEqual(result.file.sha256, "0".repeat(64));
});

await check("an unknown operation is a programming error, not a document verdict", async () => {
  assert.throws(() => runBankStatementPdfInSandbox({ operation: "render", bytes: positionedPdf() }), TypeError);
});

await check("inside the boundary, network, secrets, files, processes, workers and eval are all refused", async () => {
  const invocation = bankStatementSandboxInvocation({ entry: join(FIXTURES, "probe.mjs") });
  assert.ok(invocation, "this Node runtime has no stable permission model");
  assert.deepEqual(invocation.options.env, {});
  assert.ok(!invocation.args.some((arg) => /^--allow-(fs-write|child-process|worker|addons|wasi)/.test(arg)));

  const canaryName = "BANK_STATEMENT_SANDBOX_CANARY";
  process.env[canaryName] = "must-not-cross";
  const writeFile = join(tmpdir(), `bank-statement-sandbox-probe-${process.pid}.txt`);
  const report = await new Promise((settle, fail) => {
    const child = spawn(invocation.command, invocation.args, invocation.options);
    const timer = setTimeout(() => { child.kill("SIGKILL"); fail(new Error("probe timed out")); }, 20_000);
    child.once("message", (message) => { clearTimeout(timer); settle(message); });
    child.once("close", (code) => { clearTimeout(timer); fail(new Error(`probe exited ${code} without a report`)); });
    child.send({ secretFile: resolve(HERE, "..", "src", "server.js"), writeFile, canaryName });
  });
  delete process.env[canaryName];
  const written = existsSync(writeFile);
  if (written) rmSync(writeFile, { force: true });

  const allowed = Object.entries(report).filter(([, outcome]) => outcome !== "refused");
  assert.deepEqual(allowed, [], `escapes that were not refused: ${JSON.stringify(allowed)}`);
  assert.equal(written, false);
  assert.ok(Object.keys(report).length >= 20, "the probe did not run every attempt");
});

for (const result of checks) {
  console.log(`${result.pass ? "PASS" : "FAIL"} ${result.name}${result.pass ? "" : ` - ${result.detail}`}`);
}
const failed = checks.filter((result) => !result.pass);
if (failed.length) {
  console.error(`bank-statement sandbox contract failed: ${failed.length}/${checks.length}`);
  process.exit(1);
}
console.log(`bank-statement sandbox contract passed: ${checks.length}/${checks.length}`);
