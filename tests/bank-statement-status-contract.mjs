import assert from "node:assert/strict";
import {
  BANK_STATEMENT_PROFILE_STATE as PROFILE,
  BANK_STATEMENT_STATUS as STATUS,
  BANK_STATEMENT_STATUS_CODES as C,
  calculateBankStatementStatus,
  createBankStatementException,
  exportStatusToken,
} from "../src/services/bank-statement-status.service.js";

const checks = [];
function check(name, callback) {
  try { callback(); checks.push({ name, pass: true }); }
  catch (error) { checks.push({ name, pass: false, detail: error.message }); }
}

const fullyVerified = [
  { id: "V-B1", result: "PASS" },
  { id: "V-C2", result: "PASS" },
];

check("the same exception evidence always has the same non-content identifier", () => {
  const first = createBankStatementException({ fileHash: "a".repeat(64), page: 3, position: "42:610", code: "E-ARITH" });
  const second = createBankStatementException({ fileHash: "a".repeat(64), page: 3, position: "42:610", code: "E-ARITH" });
  assert.equal(first.id, second.id);
  assert.equal(first.severity, "ERROR");
  assert.equal(first.id.includes("E-ARITH"), false);
});

check("Passed requires an approved profile, balance chain, and independent statement control", () => {
  assert.equal(calculateBankStatementStatus({ profileState: PROFILE.APPROVED, checks: fullyVerified }).status, STATUS.PASSED);
  const missingControl = calculateBankStatementStatus({ profileState: PROFILE.APPROVED, checks: [{ id: "V-B1", result: "PASS" }] });
  assert.equal(missingControl.status, STATUS.PASSED_WITH_WARNINGS);
  assert.equal(missingControl.warnings[0].code, C.NO_CHECK);
});

check("a draft or review-only layout cannot claim Passed", () => {
  const result = calculateBankStatementStatus({ profileState: PROFILE.REVIEW_ONLY, checks: fullyVerified });
  assert.equal(result.status, STATUS.PASSED_WITH_WARNINGS);
  assert.ok(result.warnings.some((warning) => warning.code === C.LAYOUT));
});

check("an error or failed check always wins over review state", () => {
  assert.equal(calculateBankStatementStatus({ profileState: PROFILE.APPROVED, checks: [...fullyVerified, { id: "V-B1", result: "FAIL" }] }).status, STATUS.FAILED);
  assert.equal(calculateBankStatementStatus({ profileState: PROFILE.APPROVED, checks: fullyVerified, exceptions: [{ severity: "ERROR", code: "E-ARITH" }] }).status, STATUS.FAILED);
});

check("a reviewer edit never produces Passed", () => {
  const result = calculateBankStatementStatus({ profileState: PROFILE.APPROVED, checks: fullyVerified, reviewerEdits: true });
  assert.equal(result.status, STATUS.PASSED_WITH_WARNINGS);
  assert.ok(result.warnings.some((warning) => warning.code === C.USER_EDIT));
});

check("export tokens preserve the draft distinction", () => {
  assert.equal(exportStatusToken(STATUS.FAILED), "FAILED_DRAFT");
  assert.equal(exportStatusToken(STATUS.PASSED_WITH_WARNINGS), "PassedWithWarnings");
});

const failed = checks.filter((entry) => !entry.pass);
for (const result of checks) console.log(`${result.pass ? "PASS" : "FAIL"} ${result.name}${result.detail ? `: ${result.detail}` : ""}`);
if (failed.length) { process.exitCode = 1; console.error(`bank-statement status contract failed: ${failed.length}/${checks.length}`); }
else console.log(`bank-statement status contract passed: ${checks.length}/${checks.length}`);
