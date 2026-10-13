import assert from "node:assert/strict";
import {
  detectBankStatementLayoutProfile,
  validateBankStatementLayoutProfile,
} from "../src/services/bank-statement-profile.service.js";

const profile = {
  id: "EXAMPLE_SB_01", version: "1.0", bank: "Example Bank", state: "REVIEW_ONLY", accountTypes: ["SAVINGS"],
  amountShape: "SEPARATE_DEBIT_CREDIT", fingerprint: { requiredText: ["Example Bank"], headers: ["Transaction Date", "Debit", "Credit", "Balance"] },
  columns: [{ field: "date", minX: 0, maxX: 80 }, { field: "debit", minX: 200, maxX: 280 }], dateFormats: ["DD-MM-YYYY"],
  narrationJoin: "SPACE", balanceConvention: "Cr positive, Dr negative", balancePattern: "ASCENDING",
};

assert.deepEqual(validateBankStatementLayoutProfile(profile), []);
assert.equal(validateBankStatementLayoutProfile({ ...profile, state: "APPROVED", columns: [] }).length > 0, true);
const matched = detectBankStatementLayoutProfile({ profiles: [profile], pages: [{ items: [{ text: "Example Bank Transaction Date Debit Credit Balance" }] }] });
assert.equal(matched.reason, "MATCHED");
assert.equal(matched.profile.id, profile.id);
assert.equal(detectBankStatementLayoutProfile({ profiles: [profile], pages: [{ items: [{ text: "Other Bank Date Amount" }] }] }).reason, "UNRECOGNISED");
assert.equal(detectBankStatementLayoutProfile({ profiles: [profile, { ...profile, id: "EXAMPLE_SB_02" }], pages: [{ items: [{ text: "Example Bank Transaction Date Debit Credit Balance" }] }] }).reason, "AMBIGUOUS");
console.log("bank-statement profile contract passed: 5/5");
