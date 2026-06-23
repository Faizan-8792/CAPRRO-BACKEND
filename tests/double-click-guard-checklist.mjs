// tests/double-click-guard-checklist.mjs
// Verifies double-click protection wired across critical UI surfaces.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

const taxWorkerJs = readFileSync(
  join(ROOT, "audit-nlp-extension", "tax-worker.js"),
  "utf8"
);
const popupJs = readFileSync(
  join(ROOT, "audit-nlp-extension", "popup.js"),
  "utf8"
);

const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass, detail });

// 1. tax-worker.js exports/defines safeAsyncClick utility
check(
  "tax-worker.js defines safeAsyncClick(triggerEl, asyncFn) helper",
  /function\s+safeAsyncClick\s*\(triggerEl,\s*asyncFn\)/.test(taxWorkerJs),
  "Single source of truth for guarding clicks"
);

// 2. safeAsyncClick disables button + tracks inFlight
check(
  "safeAsyncClick disables trigger and tracks inFlight",
  /inFlight\s*=\s*true/.test(taxWorkerJs) &&
    /triggerEl\.disabled\s*=\s*true/.test(taxWorkerJs) &&
    /inFlight\s*=\s*false/.test(taxWorkerJs),
  "Re-entry prevented during async operation"
);

// 3. Critical Tax Worker buttons are guarded
const expectedTaxWorkerGuards = [
  "btnJoinFirm",
  "btnSaveClient",
  "newSessionCreate",
  "addDocsConfirm",
  "btnComplete",
  "btnDeleteSession",
  "btnExportWord",
  "btnExportExcel",
  "btnExportPDF",
];
const missingGuards = expectedTaxWorkerGuards.filter(
  (id) => !new RegExp(`safeAsyncClick\\(\\s*\\$\\(["']${id}["']\\)`, "m").test(taxWorkerJs)
);
check(
  "All critical Tax Worker buttons wrapped in safeAsyncClick",
  missingGuards.length === 0,
  missingGuards.length
    ? `Missing guards: ${missingGuards.join(", ")}`
    : "All buttons protected"
);

// 4. popup.js also defines safeAsyncClick
check(
  "popup.js defines safeAsyncClick helper",
  /function\s+safeAsyncClick\s*\(triggerEl,\s*asyncFn\)/.test(popupJs),
  "Helper available in popup context too"
);

// 5. Document remove still uses async confirm pattern (no double-fire)
check(
  "Document remove uses confirm() before async DELETE call",
  /async\s+function\s+removeDoc[\s\S]{0,200}confirm\(/.test(taxWorkerJs),
  "Prevents accidental remove on double-click"
);

// 6. Notes autosave uses debounce
check(
  "Notes autosave uses debounce timers (no flooding on rapid input)",
  /debounceSaveDocNotes/.test(taxWorkerJs) && /setTimeout/.test(taxWorkerJs),
  "Notes saves are debounced"
);

// ─── Print ─────────────────────────────────────────────────────────
console.log("\n=== DOUBLE-CLICK GUARD VERIFICATION ===\n");
const passed = checks.filter((c) => c.pass).length;
const failed = checks.filter((c) => !c.pass).length;

checks.forEach((c, i) => {
  const icon = c.pass ? "[PASS]" : "[FAIL]";
  console.log(`${i + 1}. ${icon} ${c.name}`);
  if (c.detail) console.log(`        ${c.detail}`);
});

console.log(`\nResult: ${passed} passed, ${failed} failed (out of ${checks.length})\n`);

if (failed === 0) {
  console.log("ALL CHECKS PASSED. Double-click protection wired across UI.\n");
} else {
  process.exit(1);
}
