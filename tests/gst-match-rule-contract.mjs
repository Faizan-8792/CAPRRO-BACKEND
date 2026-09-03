// tests/gst-match-rule-contract.mjs
//
// Why this exists. src/services/gst-matching.service.js labels every exact-key pair that
// is not a perfect match with matchRule "TOLERANT":
//
//     matchRule: status === "MATCHED" ? "EXACT" : "TOLERANT",
//
// The size of the difference is never consulted. apps/desktop-native renders that verbatim
// as "Matched within tolerance" (Core/Presentation/GstFormat.cs), so a books/portal pair
// differing by lakhs is presented to a chartered accountant as reconciled within tolerance.
// The run's own roundingToleranceMinor is not involved: it is read only inside
// candidateScore(), on the fuzzy path, so the tolerance a user configured has no effect on
// the route that produces this label.
//
// This file PINS THE CURRENT BEHAVIOUR rather than asserting the desired behaviour. It is
// deliberately not a fix: matchRule decides how statutory input tax credit is presented, and
// CLAUDE.md section 14 reserves that change for the owner ("changing a server authorization
// rule (pin the current behaviour with a test and raise it)"). Raised as OWNER-TODO item 16.
//
// When the owner settles the corrected rule, the assertions marked DEFECT below are the ones
// to invert; the assertions above them are the behaviour that must survive any fix.
//
// Pure logic only - no database, no network, no server import.
//
// Run: node tests/gst-match-rule-contract.mjs

import assert from "node:assert/strict";
import { buildReconciliationItems } from "../src/services/gst-matching.service.js";

const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass, detail });

const SUPPLIER = "27AABCS1111A1Z5";

function row(overrides = {}) {
  return {
    _id: overrides._id || "id",
    sourceRow: overrides.sourceRow ?? 1,
    supplierGstin: SUPPLIER,
    invoiceNumberNormalized: "INV1",
    documentType: "INVOICE",
    documentDate: "2026-04-05",
    taxableValueMinor: 100_000,
    igstMinor: 18_000,
    cgstMinor: 0,
    sgstMinor: 0,
    cessMinor: 0,
    totalTaxMinor: 18_000,
    ...overrides,
  };
}

// An item carries booksRowId / portalRowId, not embedded rows.
function booksItem(items) {
  return items.find((item) => item.booksRowId) || items[0];
}

function matchOne(booksOverrides, portalOverrides, config = {}) {
  return booksItem(
    buildReconciliationItems({
      booksRows: [row({ _id: "b1", ...booksOverrides })],
      portalRows: [row({ _id: "p1", ...portalOverrides })],
      ...config,
    }),
  );
}

// ─── Behaviour that must survive any fix ──────────────────────────

const exact = matchOne({}, {});
check(
  "an identical pair is EXACT, MATCHED and auto-accepted",
  exact.matchRule === "EXACT" && exact.status === "MATCHED" && exact.autoAccepted === true,
  `matchRule=${exact.matchRule} status=${exact.status} auto=${exact.autoAccepted}`,
);

const tinyDifference = matchOne({}, { igstMinor: 18_001, totalTaxMinor: 18_001 });
check(
  "a one-paisa tax difference is never auto-accepted",
  tinyDifference.autoAccepted === false && tinyDifference.status === "TAX_AMOUNT_MISMATCH",
  `status=${tinyDifference.status} auto=${tinyDifference.autoAccepted}`,
);

const hugeDifference = matchOne({}, { igstMinor: 40_000_000, totalTaxMinor: 40_000_000 });
check(
  "a pair differing by lakhs is never auto-accepted",
  hugeDifference.autoAccepted === false,
  `auto=${hugeDifference.autoAccepted}`,
);

check(
  "a difference of any size is still reported as a mismatch status",
  hugeDifference.status === "TAX_AMOUNT_MISMATCH",
  `status=${hugeDifference.status}`,
);

// ─── DEFECT: pinned as it currently behaves, not as it should ─────

check(
  "DEFECT: a pair differing by lakhs is labelled TOLERANT, the same as one differing by a paisa",
  hugeDifference.matchRule === "TOLERANT" && tinyDifference.matchRule === "TOLERANT",
  `huge=${hugeDifference.matchRule} tiny=${tinyDifference.matchRule} ` +
    "- the desktop renders both as \"Matched within tolerance\"",
);

const withGenerousTolerance = matchOne(
  {},
  { igstMinor: 18_050, totalTaxMinor: 18_050 },
  { roundingToleranceMinor: 10_000 },
);
check(
  "DEFECT: a configured rounding tolerance does not make an in-tolerance pair MATCHED",
  withGenerousTolerance.status === "TAX_AMOUNT_MISMATCH" &&
    withGenerousTolerance.matchRule === "TOLERANT",
  `50 paise apart under a Rs 100.00 tolerance still reports ${withGenerousTolerance.status}` +
    " - roundingToleranceMinor is read only in candidateScore(), never on the exact-key path",
);

const withGenerousDateTolerance = matchOne(
  {},
  { documentDate: "2026-04-06" },
  { dateToleranceDays: 30 },
);
check(
  "DEFECT: a configured date tolerance does not make a one-day-apart pair MATCHED",
  withGenerousDateTolerance.status === "DATE_MISMATCH",
  `one day apart under a 30-day tolerance still reports ${withGenerousDateTolerance.status}`,
);

// ─── Statuses the matcher declares but can never emit ─────────────

const differentSupplier = buildReconciliationItems({
  booksRows: [row({ _id: "b1" })],
  portalRows: [row({ _id: "p1", supplierGstin: "29AABCS2222A1Z5" })],
});
check(
  "DEFECT: a supplier GSTIN difference reports MISSING_IN_2B, never GSTIN_MISMATCH",
  booksItem(differentSupplier).status === "MISSING_IN_2B",
  "both exactKey() and candidateScore() require an identical supplierGstin, so the declared " +
    "GSTIN_MISMATCH and NEEDS_REVIEW statuses are unreachable",
);

// ─── Guards that must not regress ─────────────────────────────────

check(
  "a negative rounding tolerance is rejected rather than silently treated as zero",
  (() => {
    try {
      buildReconciliationItems({ booksRows: [], portalRows: [], roundingToleranceMinor: -1 });
      return false;
    } catch (_) {
      return true;
    }
  })(),
);

const booksOnly = buildReconciliationItems({ booksRows: [row({ _id: "b1" })], portalRows: [] });
check(
  "a books row with no portal counterpart is MISSING_IN_2B with matchRule NONE",
  booksOnly[0].status === "MISSING_IN_2B" && booksOnly[0].matchRule === "NONE",
  `status=${booksOnly[0].status} matchRule=${booksOnly[0].matchRule}`,
);

const portalOnly = buildReconciliationItems({ booksRows: [], portalRows: [row({ _id: "p1" })] });
check(
  "a portal row with no books counterpart is MISSING_IN_BOOKS with matchRule NONE",
  portalOnly[0].status === "MISSING_IN_BOOKS" && portalOnly[0].matchRule === "NONE",
  `status=${portalOnly[0].status} matchRule=${portalOnly[0].matchRule}`,
);

// ─── Report ───────────────────────────────────────────────────────

let passed = 0;
for (const entry of checks) {
  const mark = entry.pass ? "PASS" : "FAIL";
  if (entry.pass) passed += 1;
  console.log(`[${mark}] ${entry.name}${entry.detail ? ` — ${entry.detail}` : ""}`);
}

const total = checks.length;
console.log(`\nGST match rule contract: ${passed}/${total}`);
console.log(
  "\nFour checks above are labelled DEFECT: they pin behaviour that is wrong and awaiting the",
);
console.log("owner's decision (OWNER-TODO item 16), not behaviour to preserve.");

if (passed !== total) {
  console.error(`\n${total - passed} check(s) failed.`);
  process.exit(1);
}
