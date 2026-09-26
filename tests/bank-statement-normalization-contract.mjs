// Phase-1 bank-statement normalization contract. These are the PDF v1.1 Section 6.4 minimum
// cases plus exact-arithmetic and raw-evidence checks. Pure logic only: no PDF, network, database,
// or spreadsheet writer is claimed by this test.

import assert from "node:assert/strict";
import {
  BANK_STATEMENT_CODES as C,
  BANK_STATEMENT_ROW_ORDER as ORDER,
  normalizeStatementAmount,
  normalizeStatementDate,
  normalizeStatementMovement,
  normalizeStatementRow,
  paiseToDecimalString,
  validateBalanceChain,
} from "../src/services/bank-statement-normalization.service.js";

const checks = [];
function check(name, callback) {
  try {
    callback();
    checks.push({ name, pass: true });
  } catch (error) {
    checks.push({ name, pass: false, detail: error.message });
  }
}

function amount(raw, options = {}) {
  return normalizeStatementAmount(raw, options).value;
}

check("Indian and international grouped movement amounts are exact paise", () => {
  assert.equal(amount("1,23,456.78"), 12345678n);
  assert.equal(amount("123,456.78"), 12345678n);
  assert.equal(amount(" 1,250.00₹", { column: "Credit" }), 125000n);
  assert.equal(amount("Rs.500"), 50000n);
});

check("Dr, Cr, parentheses, and trailing minus give the specified signed balance", () => {
  assert.equal(amount("1,250.00 Dr", { kind: "balance" }), -125000n);
  assert.equal(amount("48,200.50 Cr", { kind: "balance" }), 4820050n);
  assert.equal(amount("(2,500.00)", { kind: "balance" }), -250000n);
  assert.equal(amount("2,500.00-", { kind: "balance" }), -250000n);
});

check("invalid numeric forms and movement signs are refused, never repaired", () => {
  assert.equal(normalizeStatementAmount("-500.00").issues[0].code, C.AMOUNT_SIGN);
  assert.equal(normalizeStatementAmount("12,34,5.00").issues[0].code, C.AMOUNT_INVALID);
  assert.equal(normalizeStatementAmount("1,250.005").issues[0].code, C.AMOUNT_INVALID);
  assert.equal(normalizeStatementAmount("1,250.00 Cr", { column: "Debit" }).issues[0].code, C.COLUMN_MAPPING);
});

check("zero is blanked only in a non-applicable movement column and two values are an error", () => {
  const blanked = normalizeStatementMovement({ debit: "1,250.00", credit: "0.00" });
  assert.equal(blanked.debit, 125000n);
  assert.equal(blanked.credit, null);
  assert.ok(blanked.issues.some((item) => item.code === C.ZERO_BLANKED));
  assert.ok(normalizeStatementMovement({ debit: "1,000.00", credit: "500.00" }).issues.some((item) => item.code === C.BOTH_MOVEMENTS));
  assert.ok(normalizeStatementMovement({ debit: "0.00", credit: "0.00" }).issues.some((item) => item.code === C.NO_MOVEMENT));
});

check("day-first date formats and period-aware two-digit years normalize exactly", () => {
  const april = { from: "2026-04-01", to: "2026-04-30" };
  assert.equal(normalizeStatementDate("05/04/2026", { period: april }).value, "2026-04-05");
  assert.equal(normalizeStatementDate("5-Apr-26", { period: april }).value, "2026-04-05");
  assert.equal(normalizeStatementDate("05.04.26", { period: { from: "2026-03-01", to: "2026-04-30" } }).value, "2026-04-05");
  assert.equal(normalizeStatementDate("01/01/27", { period: { from: "2026-12-01", to: "2027-01-31" } }).value, "2027-01-01");
});

check("invalid, ambiguous, and month-first-looking dates are not re-read", () => {
  assert.equal(normalizeStatementDate("01/01/27", { period: { from: "2026-04-01", to: "2026-04-30" } }).issues[0].code, C.DATE_AMBIGUOUS);
  assert.equal(normalizeStatementDate("31/02/2026").issues[0].code, C.DATE_INVALID);
  assert.equal(normalizeStatementDate("04/13/2026").issues[0].code, C.DATE_INVALID);
  assert.equal(normalizeStatementDate("29/02/2028").value, "2028-02-29");
  assert.equal(normalizeStatementDate("29/02/2027").issues[0].code, C.DATE_INVALID);
});

check("the typed row keeps raw fields, source evidence, and exact output values", () => {
  const row = normalizeStatementRow({
    date: "05/04/2026", narration: "UPI/ABC\n STORES", debit: "1,250.00", credit: "", balance: "48,750.00 Cr",
    source: { page: 2, position: "x=42,y=612", sequence: 7 },
  }, { period: { from: "2026-04-01", to: "2026-04-30" } });
  assert.equal(row.raw.narration, "UPI/ABC\n STORES");
  assert.equal(row.values.narration, "UPI/ABC STORES");
  assert.equal(row.values.debit, 125000n);
  assert.equal(row.values.credit, null);
  assert.equal(row.values.balance, 4875000n);
  assert.deepEqual(row.source, { page: 2, position: "x=42,y=612", sequence: 7 });
});

check("the balance chain catches a dropped digit and does not cascade the failure", () => {
  const rows = [
    { debit: 125000n, credit: null, balance: 4875000n },
    { debit: null, credit: 2500000n, balance: 7375000n },
    { debit: 100000n, credit: null, balance: 6375000n },
  ];
  const checks = validateBalanceChain(rows, { openingBalance: 5000000n });
  assert.deepEqual(checks.map((entry) => entry.pass), [true, true, false]);
  assert.equal(checks[2].code, C.ARITHMETIC);
  assert.equal(paiseToDecimalString(checks[2].difference), "-9000.00");
});

check("newest-first statements validate against the next printed balance", () => {
  const rows = [
    { debit: 1000000n, credit: null, balance: 6375000n },
    { debit: null, credit: 2500000n, balance: 7375000n },
    { debit: 125000n, credit: null, balance: 4875000n },
  ];
  const checks = validateBalanceChain(rows, { openingBalance: 5000000n, order: ORDER.DESCENDING });
  assert.ok(checks.every((entry) => entry.pass));
});

const failed = checks.filter((entry) => !entry.pass);
for (const result of checks) console.log(`${result.pass ? "PASS" : "FAIL"} ${result.name}${result.detail ? `: ${result.detail}` : ""}`);
if (failed.length) {
  console.error(`bank-statement normalization contract failed: ${failed.length}/${checks.length}`);
  process.exitCode = 1;
} else {
  console.log(`bank-statement normalization contract passed: ${checks.length}/${checks.length}`);
}
