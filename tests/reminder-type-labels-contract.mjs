// A reminder's activity reaches a person in words, never as its id (2026-10-13).
//
// Found while recording the tutorials: the compliance calendar titled reminders "Tax Audit 3cd",
// "Mca Aoc4" and "Tds Return 26q", tax work "Itr Firm" and "Gst Monthly", and the reminder email's
// subject read "Compliance Reminder: TAX_AUDIT_3CD". The words now come from the list the extension
// offers when a reminder is set (reminder-types.js, shared by its popup, Reminders page and Daily
// Work Planner) and from each tax work template's
// displayName, as the Tax Work Tracker shows it. Runs with no database: everything here is pure,
// or read from source.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readableCode, REMINDER_TYPE_LABELS, reminderTypeLabel } from "../src/config/reminder-types.js";
import { buildComplianceReminderEmail } from "../src/services/reminder.service.js";

const BACKEND = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION = resolve(BACKEND, "..", "audit-nlp-extension");

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

const extensionTypes = (file) =>
  [...readFileSync(resolve(EXTENSION, file), "utf8").matchAll(/\{ id: "([A-Z0-9_]+)", label: "([^"]+)" \}/g)].map(
    (match) => [match[1], match[2]],
  );

check("every activity the extension offers has the extension's own words", () => {
  assert.ok(existsSync(EXTENSION), "audit-nlp-extension is not checked out; run git submodule update --init");
  for (const file of ["reminder-types.js"]) {
    const offered = extensionTypes(file);
    assert.ok(offered.length >= 20, `${file}: found ${offered.length} reminder types`);
    for (const [id, label] of offered) assert.equal(reminderTypeLabel(id), label, `${file}: ${id}`);
  }
});

check("the ids the server writes itself read as words", () => {
  assert.equal(reminderTypeLabel("CASE_RESPONSE_DUE"), "Notice case: response due");
  assert.equal(reminderTypeLabel("GENERIC"), "Reminder");
  assert.equal(reminderTypeLabel(""), "Reminder");
  assert.equal(reminderTypeLabel(null), "Reminder");
});

check("an id outside the list keeps its form numbers and abbreviations", () => {
  assert.equal(readableCode("TDS_RETURN_26Q"), "TDS return 26Q");
  assert.equal(readableCode("GSTR3B_MONTHLY"), "GSTR3B monthly");
  assert.equal(readableCode("ITR_FIRM"), "ITR firm");
  assert.equal(reminderTypeLabel("ROC_ADT1"), "ROC ADT1");
  assert.equal(readableCode(""), "");
});

check("no label is an id", () => {
  for (const [id, label] of Object.entries(REMINDER_TYPE_LABELS)) {
    assert.notEqual(label, id);
    assert.doesNotMatch(label, /_/, `${id}: ${label}`);
  }
});

check("the reminder email names the activity in words", () => {
  const email = buildComplianceReminderEmail({
    title: reminderTypeLabel("TAX_AUDIT_3CD"),
    clientLabel: "Evergreen Textiles",
    dueDateISO: "2026-10-16T00:00:00.000Z",
    daysLeft: 3,
  });
  assert.equal(email.subject, "Compliance Reminder: Tax Audit: 3CD / Audit report");
  assert.doesNotMatch(email.text, /TAX_AUDIT_3CD/);
});

check("the calendar and the email take their words from here", () => {
  const summary = readFileSync(resolve(BACKEND, "src/services/workspace-summary.service.js"), "utf8");
  assert.match(summary, /item\.title = reminderTypeLabel\(doc\.typeId\)/);
  assert.match(summary, /TAX_TEMPLATES\[doc\.taxType\]\?\.displayName/);
  assert.doesNotMatch(summary, /humanizeCode/);
  const controller = readFileSync(resolve(BACKEND, "src/controllers/reminder.controller.js"), "utf8");
  assert.match(controller, /title: reminderTypeLabel\(reminder\.typeId\)/);
  assert.doesNotMatch(controller, /title: reminder\.typeId\b/);
});

console.log(`\nreminder-type-labels-contract: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
