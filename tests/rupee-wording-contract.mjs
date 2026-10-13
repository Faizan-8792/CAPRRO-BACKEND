// A sentence a person reads names rupees, never paise (2026-10-13).
//
// Amounts are kept and compared as integer paise. Found while recording the tutorials: TDS Health
// explained a gap as "1250000 minor units" - that is Rs 12,500.00, and readable as twelve lakh - and
// the working-paper analysis, handed paise, wrote that a debtor balance of Rs 4,12,500 was
// "41,250,000 minor units". Runs with no database: the formatter is pure; the rest is read from source.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rupeesFromPaise, rupeesText } from "../src/utils/rupees.js";

const BACKEND = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = (file) => readFileSync(resolve(BACKEND, file), "utf8");

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

check("paise read as rupees, grouped the Indian way", () => {
  assert.equal(rupeesFromPaise(0), "₹0.00");
  assert.equal(rupeesFromPaise(5), "₹0.05");
  assert.equal(rupeesFromPaise(12345), "₹123.45");
  assert.equal(rupeesFromPaise(1250000), "₹12,500.00");
  assert.equal(rupeesFromPaise(41250000), "₹4,12,500.00");
  assert.equal(rupeesFromPaise(125000000), "₹12,50,000.00");
  assert.equal(rupeesFromPaise(123456789012), "₹1,23,45,67,890.12");
  assert.equal(rupeesFromPaise(-1250000), "-₹12,500.00");
  assert.equal(rupeesFromPaise(10n ** 15n), "₹1,00,00,00,00,00,000.00");
});

check("a value that is not whole paise is refused, and a sentence never says null", () => {
  for (const bad of [1.5, Number.NaN, null, undefined, "1250000", Number.MAX_SAFE_INTEGER + 2]) {
    assert.equal(rupeesFromPaise(bad), null, String(bad));
    assert.doesNotMatch(rupeesText(bad), /null|undefined|NaN/);
  }
});

check("TDS Health explains a gap in rupees", () => {
  const engine = source("src/services/tds-health-engine.service.js");
  assert.doesNotMatch(engine, /minor units/, "an explanation still says minor units");
  const explanations = [...engine.matchAll(/explanation: `([^`]*)`/g)].map((match) => match[1]);
  assert.ok(explanations.length >= 7, `found ${explanations.length} explanations`);
  for (const text of explanations.filter((t) => /Minor\b/.test(t))) {
    assert.match(text, /\$\{rupeesText\(/, `an amount reaches the sentence unformatted: ${text}`);
  }
});

check("the working-paper analysis is given rupees, and asked to quote them as written", () => {
  const service = source("src/services/audit-working-paper.service.js");
  const start = service.indexOf("function buildAuditAiPrompt(");
  const body = service.slice(start, service.indexOf("\n}\n", start));
  assert.ok(start >= 0, "buildAuditAiPrompt is where the prompt is built");
  assert.match(body, /currentAmount: rupeesFromPaise\(row\.currentAmountMinor\)/);
  assert.doesNotMatch(body, /currentAmountMinor: row\.currentAmountMinor/);
  assert.match(body, /quote it exactly as written/);
  assert.match(service, /ANALYSIS_PROMPT_VERSION = "audit-working-paper-findings-v2"/, "a changed prompt carries a new version");
});

console.log(`\nrupee-wording-contract: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
