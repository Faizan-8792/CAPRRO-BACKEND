// A suggested quarter is a financial-year quarter (2026-10-12).
//
// suggestPeriodAndDueDate numbered calendar quarters under a financial-year label: in October it
// offered "Q3-2026-27" for July-September, which a CA reads as October-December. Runs with no
// database: the function is pure.

import assert from "node:assert/strict";
import { suggestPeriodAndDueDate, TAX_TEMPLATES } from "../src/config/tax-templates.js";

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`[PASS] ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`[FAIL] ${name}: ${error.message}`);
  }
}

const quarterly = Object.keys(TAX_TEMPLATES).find(
  (key) => TAX_TEMPLATES[key].periodFormat === "quarterly" && TAX_TEMPLATES[key].defaultDueDay,
);
const at = (iso) => new Date(`${iso}T06:00:00.000Z`);

check("there is a quarterly template to suggest for", () => {
  assert.ok(quarterly, "no quarterly template with a due day");
});

check("in October the last quarter is Q2 of the financial year: July to September", () => {
  const { period, dueDate } = suggestPeriodAndDueDate(quarterly, at("2026-10-12"));
  assert.equal(period, "Q2-2026-27");
  assert.equal(dueDate.slice(0, 7), "2026-10", "due in the month after the quarter ends");
});

check("in January the last quarter is Q3: October to December", () => {
  const { period, dueDate } = suggestPeriodAndDueDate(quarterly, at("2027-01-10"));
  assert.equal(period, "Q3-2026-27");
  assert.equal(dueDate.slice(0, 7), "2027-01");
});

check("in May the last quarter is Q4 of the year that ended in March", () => {
  const { period, dueDate } = suggestPeriodAndDueDate(quarterly, at("2027-05-02"));
  assert.equal(period, "Q4-2026-27");
  assert.equal(dueDate.slice(0, 7), "2027-04");
});

check("in July the last quarter is Q1: April to June", () => {
  const { period } = suggestPeriodAndDueDate(quarterly, at("2026-07-01"));
  assert.equal(period, "Q1-2026-27");
});

console.log(`\nResult: ${passed} passed, ${failed} failed (out of ${passed + failed})`);
process.exitCode = failed ? 1 : 0;
