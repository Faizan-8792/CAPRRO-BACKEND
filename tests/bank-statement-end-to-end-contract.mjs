// In-memory integration path across the new converter boundaries. No filesystem, network,
// database, or user statement is used.

import assert from "node:assert/strict";
import {
  BANK_STATEMENT_ROW_ORDER as ORDER,
  normalizeStatementRow,
  validateBalanceChain,
} from "../src/services/bank-statement-normalization.service.js";
import { BANK_STATEMENT_PROFILE_STATE as PROFILE, BANK_STATEMENT_STATUS as STATUS, calculateBankStatementStatus } from "../src/services/bank-statement-status.service.js";
import { buildBankStatementWorkbook } from "../src/services/bank-statement-xlsx.service.js";

const period = { from: "2026-04-01", to: "2026-04-30" };
const sourceRows = [
  { date: "05/04/2026", narration: "UPI/ABC STORES", debit: "1,250.00", credit: "", balance: "48,750.00 Cr" },
  { date: "06/04/2026", narration: "NEFT/ACME LTD/SALARY", debit: "", credit: "25,000.00", balance: "73,750.00 Cr" },
  { date: "08/04/2026", narration: "ATM WDL/CITY BRANCH", debit: "10,000.00", credit: "", balance: "63,750.00 Cr" },
];
const rows = sourceRows.map((row, index) => normalizeStatementRow({ ...row, source: { page: 1, position: `x=10,y=${600 - index * 20}`, sequence: index + 1 } }, { period }));
const checks = validateBalanceChain(rows, { openingBalance: 5000000n, order: ORDER.ASCENDING });
assert.ok(checks.every((check) => check.pass), "reference savings statement must reconcile exactly");

const status = calculateBankStatementStatus({
  profileState: PROFILE.APPROVED,
  checks: [{ id: "V-B1", result: "PASS" }, { id: "V-C1", result: "PASS" }, { id: "V-C2", result: "PASS" }, { id: "V-C3", result: "PASS" }, { id: "V-C4", result: "PASS" }, { id: "V-C5", result: "PASS" }],
});
assert.equal(status.status, STATUS.PASSED);

const workbook = buildBankStatementWorkbook({
  fileName: "savings-april.pdf", metadata: { sha256: "b".repeat(64), pageCount: 1, converterVersion: "test" },
  profile: { id: "EXAMPLE_SB_01", version: "1" }, rows, exceptions: [], checks, statusResult: status,
});
assert.equal(workbook.filename, "savings-april_converted_Passed.xlsx");
assert.equal(workbook.verification.transactionRows, 3);

// A one-digit movement extraction fault has to fail its own row rather than being corrected.
const faulted = sourceRows.map((row) => ({ ...row }));
faulted[2].debit = "1,000.00";
const faultRows = faulted.map((row, index) => normalizeStatementRow({ ...row, source: { page: 1, position: `x=10,y=${600 - index * 20}`, sequence: index + 1 } }, { period }));
const faultChecks = validateBalanceChain(faultRows, { openingBalance: 5000000n, order: ORDER.ASCENDING });
assert.deepEqual(faultChecks.map((check) => check.pass), [true, true, false]);
assert.equal(calculateBankStatementStatus({ profileState: PROFILE.APPROVED, checks: faultChecks.map((check, index) => ({ id: `V-B1-${index + 1}`, result: check.pass ? "PASS" : "FAIL" })) }).status, STATUS.FAILED);

// Deterministic property sweep: valid exact-paise chains never acquire a rounding failure.
let seed = 0x5eed1234;
function next() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed; }
for (let sample = 0; sample < 25; sample += 1) {
  let balance = BigInt(1_000_000 + (next() % 10_000_000));
  const generated = [];
  for (let index = 0; index < 100; index += 1) {
    const debit = next() % 2 ? BigInt(next() % 100_000) : null;
    const credit = debit === null ? BigInt(next() % 100_000) : null;
    balance = balance - (debit ?? 0n) + (credit ?? 0n);
    generated.push({ debit, credit, balance });
  }
  const opening = generated.reduceRight((current, row) => current + (row.debit ?? 0n) - (row.credit ?? 0n), balance);
  assert.ok(validateBalanceChain(generated, { openingBalance: opening }).every((check) => check.pass), `generated exact-paise chain ${sample} must pass`);
}

console.log("bank-statement end-to-end contract passed: 1 reference pipeline + 1 fault pipeline + 25 exact-paise chains");
