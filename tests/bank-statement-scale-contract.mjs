// The Phase-1 limit is 50,000 transaction rows. Exercise validation and the four-sheet writer at
// that bound using synthetic values only; this deliberately avoids customer files and the PDF layer.

import assert from "node:assert/strict";
import { validateBalanceChain } from "../src/services/bank-statement-normalization.service.js";
import { BANK_STATEMENT_PROFILE_STATE as PROFILE, BANK_STATEMENT_STATUS as STATUS, calculateBankStatementStatus } from "../src/services/bank-statement-status.service.js";
import { buildBankStatementWorkbook } from "../src/services/bank-statement-xlsx.service.js";

const rowCount = 50_000;
let balance = 50_000_000n;
const rows = [];
for (let index = 0; index < rowCount; index += 1) {
  const debit = index % 2 === 0 ? 12345n : null;
  const credit = index % 2 === 1 ? 23456n : null;
  balance = balance - (debit ?? 0n) + (credit ?? 0n);
  rows.push({
    source: { page: Math.floor(index / 100) + 1, sequence: index + 1 },
    values: { date: "2026-04-05", narration: `Synthetic transaction ${index + 1}`, debit, credit, balance },
    issues: [],
  });
}
const started = performance.now();
const chain = validateBalanceChain(rows, { openingBalance: 50_000_000n });
assert.ok(chain.every((item) => item.pass));
const status = calculateBankStatementStatus({ profileState: PROFILE.APPROVED, checks: [{ id: "V-B1", result: "PASS" }, { id: "V-C1", result: "PASS" }] });
assert.equal(status.status, STATUS.PASSED);
const workbook = buildBankStatementWorkbook({
  fileName: "synthetic-scale.pdf", metadata: { sha256: "c".repeat(64), pageCount: 300, converterVersion: "test" },
  profile: { id: "SCALE_TEST", version: "1" }, rows, checks: [], exceptions: [], statusResult: status,
});
const elapsedMs = performance.now() - started;
assert.equal(workbook.verification.transactionRows, rowCount);
assert.ok(elapsedMs < 60_000, `50,000-row validation/export took ${elapsedMs.toFixed(0)} ms`);
console.log(`bank-statement scale contract passed: rows=${rowCount} elapsedMs=${elapsedMs.toFixed(0)} workbookMB=${(workbook.bytes.length / 1024 / 1024).toFixed(1)}`);
