// Contract for deterministic materiality guidance. AA-07 in .kiro/audit-assistance-defects.md.
//
// The defect: given profit before tax, revenue, total assets and an explicit instruction not to
// invent a percentage, the product answered "Determine materiality and performance materiality for
// this area and document the basis for sample size and item selection." That sentence would be
// identical on a blank page.
//
// The property that matters most is NEGATIVE and is pinned first below: this module must never
// name a percentage. Choosing a benchmark and a rate depends on the entity, its users, prior-year
// misstatements and the engagement partner, none of which is in a pasted working paper. A number
// invented here would be copied into a file and relied on, and would be wrong for reasons nobody
// could see.
//
//   node capro-backend/tests/audit-materiality-contract.mjs

import assert from "node:assert/strict";
import {
  extractMaterialityBases,
  findMissingMaterialityInputs,
  buildMaterialityGuidance,
} from "../src/services/audit-materiality.service.js";
import { guardFinding, findOverConclusions } from "../src/services/audit-finding-guard.service.js";

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

// The reviewer's case: all three bases present, and an explicit instruction not to invent a rate.
const THREE_BASES =
  "Draft financial statements for the year ended 31 March 2026.\n" +
  "Profit before tax is Rs 3.20 crore for the year.\n" +
  "Revenue for the year is Rs 84.60 crore.\n" +
  "Total assets stand at Rs 46.10 crore at the reporting date.\n";

// ── the negative property, first ──────────────────────────────────────────

check("no percentage is ever named, in any field", () => {
  // Every shape of rate an auditor might expect to be handed, and none may appear.
  const FORBIDDEN = [
    /\d+(?:\.\d+)?\s*%/,
    /\d+(?:\.\d+)?\s*per\s*cent/i,
    /\bone\s+per\s*cent\b/i,
    /\bhalf\s+a?\s*per\s*cent\b/i,
    /\bbasis\s+points?\b/i,
  ];
  const texts = [
    THREE_BASES,
    "Profit before tax is Rs 3.20 crore.\n",
    "Total expenditure for the year was Rs 12.40 crore.\n",
    "Net assets are Rs 22.00 crore and revenue is Rs 84.60 crore.\n",
  ];
  for (const text of texts) {
    const guidance = buildMaterialityGuidance(text);
    if (!guidance) continue;
    for (const field of ["detail", "nextAction"]) {
      for (const pattern of FORBIDDEN) {
        assert.doesNotMatch(
          guidance[field],
          pattern,
          `${field} named a rate, which this module must never do: ${guidance[field]}`,
        );
      }
    }
  }
});

check("it never presents a computed materiality figure as the answer", () => {
  const guidance = buildMaterialityGuidance(THREE_BASES);
  // The only amounts it may state are the bases themselves, quoted from the document.
  const stated = [...guidance.detail.matchAll(/Rs\s[\d.]+\s*(?:crore|lakh)?/gi)].map((m) => m[0]);
  for (const amount of stated) {
    assert.ok(
      /3\.20 crore|84\.60 crore|46\.10 crore/.test(amount),
      `"${amount}" is not one of the document's own figures, so it was computed here`,
    );
  }
});

// ── it must say what the document actually supplies ───────────────────────

check("every quantitative base in the text is listed with its figure", () => {
  const bases = extractMaterialityBases(THREE_BASES);
  const ids = bases.map((b) => b.id);
  assert.ok(ids.includes("profit-before-tax"), `missing PBT: ${JSON.stringify(ids)}`);
  assert.ok(ids.includes("revenue"), `missing revenue: ${JSON.stringify(ids)}`);
  assert.ok(ids.includes("total-assets"), `missing total assets: ${JSON.stringify(ids)}`);

  const pbt = bases.find((b) => b.id === "profit-before-tax");
  // 3.20 crore = 3.20 x 10,000,000 rupees = 32,000,000 rupees = 3,200,000,000 paise.
  // Written out because the first version of this assertion was wrong by a factor of ten, and an
  // amount assertion that is merely "a big number" catches nothing.
  assert.equal(pbt.amountMinor, 3.2 * 10_000_000 * 100, "Rs 3.20 crore in integer paise");
  assert.equal(pbt.amountMinor, 3_200_000_000);
  assert.equal(pbt.formatted, "Rs 3.20 crore");
});

check("the guidance names each base and its figure to the reader", () => {
  const guidance = buildMaterialityGuidance(THREE_BASES);
  for (const fragment of [
    "profit before tax",
    "Rs 3.20 crore",
    "revenue",
    "Rs 84.60 crore",
    "total assets",
    "Rs 46.10 crore",
  ]) {
    assert.ok(guidance.detail.includes(fragment), `the detail must name ${fragment}`);
  }
});

check("it explains what makes a benchmark suitable, not just that one exists", () => {
  const guidance = buildMaterialityGuidance(THREE_BASES);
  assert.match(guidance.detail, /breakeven|volatile|swings/i, "PBT's instability is the whole reason a second base matters");
  assert.match(guidance.detail, /users of the accounts|steadier/i);
});

check("it states precisely what is missing before a figure can be set", () => {
  const guidance = buildMaterialityGuidance(THREE_BASES);
  assert.ok(guidance.missing.includes("performance-materiality"));
  assert.ok(guidance.missing.includes("prior-year"));
  assert.match(guidance.nextAction, /performance materiality/i);
  // Executable: it must name the inputs, not say "obtain the necessary information".
  assert.doesNotMatch(guidance.nextAction, /\b(?:as (?:necessary|appropriate|required)|further information)\b/i);
});

check("an input the document DOES supply is not demanded again", () => {
  const withPerf =
    THREE_BASES +
    "Performance materiality has been documented separately in the planning memorandum.\n" +
    "The prior year comparative figures are set out alongside.\n";
  const guidance = buildMaterialityGuidance(withPerf);
  assert.ok(
    !guidance.missing.includes("performance-materiality"),
    "asking for something the document already states is the placeholder problem again",
  );
  assert.ok(!guidance.missing.includes("prior-year"));
});

// ── each benchmark independently load-bearing ─────────────────────────────

const BENCHMARK_FIXTURES = [
  { id: "profit-before-tax", text: "Profit before tax is Rs 3.20 crore for the year." },
  { id: "profit-before-tax", text: "PBT for the period was Rs 88.00 lakh." },
  { id: "revenue", text: "Turnover for the year is Rs 84.60 crore." },
  { id: "revenue", text: "Sales of Rs 12.40 crore were recorded in the period." },
  { id: "total-assets", text: "Total assets stand at Rs 46.10 crore at the year end." },
  { id: "gross-profit", text: "Gross profit for the year is Rs 18.20 crore." },
  { id: "net-assets", text: "Net assets are Rs 22.00 crore at the reporting date." },
  { id: "net-assets", text: "Shareholders' funds total Rs 9.40 crore." },
  { id: "total-expenses", text: "Total expenditure for the year was Rs 12.40 crore." },
];

for (const fixture of BENCHMARK_FIXTURES) {
  check(`benchmark is load-bearing: ${fixture.id} — "${fixture.text.slice(0, 38)}"`, () => {
    const ids = extractMaterialityBases(fixture.text).map((b) => b.id);
    assert.ok(ids.includes(fixture.id), `expected ${fixture.id}, got ${JSON.stringify(ids)}`);
  });
}

// ── it must not offer a base the document does not supply ─────────────────

check("a benchmark named without a figure is not offered as a base", () => {
  // "Revenue recognition was tested" names revenue and supplies nothing. Offering it as a
  // quantitative base would be exactly the emptiness the placeholder had.
  const text =
    "Revenue recognition was tested for the year.\n" +
    "Total assets were reviewed for impairment indicators.\n";
  assert.deepEqual(extractMaterialityBases(text), []);
  assert.equal(buildMaterialityGuidance(text), null, "with nothing to work with, it stays silent");
});

check("an amount far from its label is not claimed as that label's figure", () => {
  const text =
    "Profit before tax was discussed at the planning meeting and the approach agreed with the " +
    "engagement partner in a memorandum dated 12 April, and separately the petty cash float is " +
    "Rs 25,000.\n";
  const ids = extractMaterialityBases(text).map((b) => b.id);
  assert.ok(
    !ids.includes("profit-before-tax"),
    "the petty cash float is not profit before tax merely because it appears later",
  );
});

check("a document with no figures at all yields nothing", () => {
  for (const value of ["", "   ", null, undefined, 42, {}, "Materiality was considered."]) {
    assert.deepEqual(extractMaterialityBases(value), []);
    assert.equal(buildMaterialityGuidance(value), null);
  }
});

// ── cross-defect regression ───────────────────────────────────────────────

check("the guidance passes the AA-04 guard without being softened", () => {
  const guidance = buildMaterialityGuidance(THREE_BASES);
  const finding = {
    title: "Set materiality against the bases this document supplies",
    detail: guidance.detail,
    nextAction: guidance.nextAction,
    standard: "SA 320",
  };
  assert.deepEqual(findOverConclusions(finding.detail), [], finding.detail);
  assert.deepEqual(findOverConclusions(finding.nextAction), [], finding.nextAction);
  const guarded = guardFinding(finding);
  assert.equal(guarded.guard, undefined, "nothing here over-concludes");
  assert.equal(guarded.standard, "SA 320", "SA 320 is real and must survive AA-26");
});

check("the guidance no longer reads the same on any document", () => {
  // The actual defect: one sentence that would be identical on a blank page. Two different
  // documents must produce two different answers.
  const a = buildMaterialityGuidance(THREE_BASES);
  const b = buildMaterialityGuidance(
    "Total expenditure for the year was Rs 12.40 crore for the trust.\n",
  );
  assert.notEqual(a.detail, b.detail, "the guidance must depend on the document");
  assert.match(b.detail, /total expenditure/i);
  assert.doesNotMatch(b.detail, /profit before tax/i, "it must not offer a base this text lacks");
});

check("every sentence in the detail starts with a capital", () => {
  // Live output read ". revenue is a steadier base ... . total assets is usually preferred",
  // because the benchmark notes were joined raw. It makes a working paper look machine-written
  // before anyone reads what it says.
  const guidance = buildMaterialityGuidance(THREE_BASES);
  for (const field of ["detail", "nextAction"]) {
    // Only boundaries where a LETTER follows the full stop: "Rs 3.20 crore" contains a period
    // that does not end a sentence, and splitting on it would compare "20 crore..." against a
    // capitalisation rule that does not apply to it.
    const sentences = guidance[field]
      .split(/(?<=\.)\s+(?=[A-Za-z])/)
      .filter((part) => part.trim().length > 0);
    for (const sentence of sentences) {
      const first = sentence.trim().charAt(0);
      assert.ok(
        first === first.toUpperCase(),
        `a sentence starts lowercase in ${field}: "${sentence.slice(0, 60)}"`,
      );
    }
  }
});

// ── report ───────────────────────────────────────────────────────────────

console.log(`\nResult: ${passed} passed, ${failed} failed (out of ${passed + failed})`);
if (failed > 0) {
  console.error("\nAA-07 materiality contract FAILED.");
  process.exit(1);
}
console.log("AA-07 materiality contract OK");
