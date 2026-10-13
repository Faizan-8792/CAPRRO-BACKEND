import assert from "node:assert/strict";
import { BANK_STATEMENT_STATUS as STATUS } from "../src/services/bank-statement-status.service.js";
import {
  BANK_STATEMENT_SHEETS,
  BANK_STATEMENT_TRANSACTION_HEADERS,
  buildBankStatementWorkbook,
  verifyBankStatementWorkbook,
} from "../src/services/bank-statement-xlsx.service.js";

const result = buildBankStatementWorkbook({
  fileName: "April statement.pdf",
  metadata: { sha256: "a".repeat(64), pageCount: 2, converterVersion: "test" },
  profile: { id: "TEST-SB-01", version: "1" },
  statusResult: { status: STATUS.PASSED_WITH_WARNINGS, errorCount: 0, warningCount: 1, infoCount: 0 },
  rows: [{
    source: { page: 1, sequence: 1 },
    values: { date: "2026-04-05", narration: "=UPI/ABC <stores>", debit: 125000n, credit: null, balance: 4875000n, reference: "000123" },
    issues: [{ code: "W-NARR-EMPTY" }],
    exceptionIds: ["abc123"],
  }],
  exceptions: [{ id: "abc123", severity: "WARNING", code: "W-NARR-EMPTY", page: 1, sequence: 1, field: "Narration", rawText: "=UPI/ABC <stores>", issue: "Example", evidence: "test" }],
  checks: [{ id: "V-B1", name: "Running-balance arithmetic", scope: "Statement", result: "PASS", rowsChecked: 1, rowsFailed: 0 }],
});

assert.equal(result.filename, "April statement_converted_PassedWithWarnings.xlsx");
assert.ok(Buffer.isBuffer(result.bytes));
assert.deepEqual(result.verification.sheetNames, BANK_STATEMENT_SHEETS);
assert.equal(result.verification.transactionRows, 1);
assert.deepEqual(verifyBankStatementWorkbook(result.bytes, { transactionRows: 1 }).sheetNames, BANK_STATEMENT_SHEETS);

const transactions = result.bytes.toString("latin1");
assert.ok(transactions.includes("t=\"inlineStr\""), "untrusted text must be inline strings");
assert.ok(transactions.includes(">=UPI/ABC &lt;stores&gt;<"), "formula-like narration must remain literal escaped text");
assert.ok(BANK_STATEMENT_TRANSACTION_HEADERS.every((header) => transactions.includes(header)));
console.log("bank-statement xlsx contract passed: 9/9");
