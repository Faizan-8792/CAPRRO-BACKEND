// tools/run-insights-fixture.mjs
//
// Live-model harness for POST /api/audit/insights. Loads a real working-paper
// fixture from tools/audit-fixtures/, calls the actual generateInsights
// controller against the REAL DeepSeek API (no fetch stubbing), and prints
// every returned insight plus a coverage check against every [WP Ref: X-NN]
// tag in the source document.
//
// This is the tool that exists so a human's qualitative critique of the
// output ("it missed B-12 and F-16", "C-13 overclaims", "G-17 has
// duplicates") can be re-run mechanically after every prompt/logic change,
// rather than re-pasting the document into the app by hand each time.
//
// Usage:
//   node tools/run-insights-fixture.mjs stellar-textiles
//   node tools/run-insights-fixture.mjs orion-industrial
//   node tools/run-insights-fixture.mjs orion-industrial --topic="General audit"
//
// Requires DEEPSEEK_API_KEY to be set (loaded from capro-backend/.env via the
// same load-env.js the server itself uses, so this sees exactly what a real
// deployment would).

import "../src/config/load-env.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

const fixtureName = process.argv[2];
if (!fixtureName) {
  console.error(
    "Usage: node tools/run-insights-fixture.mjs <fixture-name> [--topic=Name]",
  );
  console.error(
    "Available fixtures: check tools/audit-fixtures/*.txt",
  );
  process.exit(1);
}

const topicArg = process.argv
  .slice(3)
  .find((arg) => arg.startsWith("--topic="));
const topicName = topicArg ? topicArg.slice("--topic=".length) : "General audit";

if (!process.env.DEEPSEEK_API_KEY) {
  console.error(
    "DEEPSEEK_API_KEY is not set. This harness calls the REAL DeepSeek API " +
      "and cannot run against a stub - set it in capro-backend/.env first.",
  );
  process.exit(1);
}

const fixturePath = path.join(
  currentDir,
  "audit-fixtures",
  `${fixtureName}.txt`,
);

let rawText;
try {
  rawText = await readFile(fixturePath, "utf8");
} catch (error) {
  console.error(`Could not read fixture at ${fixturePath}: ${error.message}`);
  process.exit(1);
}

const { generateInsights } = await import(
  "../src/controllers/audit.controller.js"
);

function fakeReqRes(body) {
  const state = { status: 200, body: null };
  const req = { body };
  const res = {
    status(code) {
      state.status = code;
      return res;
    },
    json(payload) {
      state.body = payload;
      return res;
    },
  };
  return { req, res, state };
}

async function callInsights(body) {
  const { req, res, state } = fakeReqRes(body);
  let nextErr = null;
  await generateInsights(req, res, (err) => {
    nextErr = err;
  });
  if (nextErr) throw nextErr;
  return state;
}

// Every [WP Ref: X-NN] tag in the source, in document order - the ground
// truth for the coverage check. Mirrors the same pattern
// audit.controller.js's findNearestWorkingPaperRef uses, so this harness
// reads the document the same way the controller does.
const WP_REF_PATTERN = /\[?\s*WP\s*Ref\.?\s*:?\s*([A-Za-z]{1,4}-?\d{1,4}(?:\.\d+)?)\s*\]?/gi;

function findAllWorkingPaperRefs(text) {
  const refs = [];
  let match;
  WP_REF_PATTERN.lastIndex = 0;
  while ((match = WP_REF_PATTERN.exec(text))) {
    refs.push(match[1]);
  }
  return [...new Set(refs)];
}

console.log(`\n=== Running fixture: ${fixtureName} ===`);
console.log(`Topic: ${topicName}`);
console.log(`Text length: ${rawText.length} characters`);

const allRefs = findAllWorkingPaperRefs(rawText);
console.log(`WP Refs found in source: ${allRefs.join(", ") || "(none)"}\n`);

const started = Date.now();
const result = await callInsights({ rawText, topicName });
const elapsedMs = Date.now() - started;

console.log(`--- Response (${elapsedMs}ms) ---`);
console.log(`generated: ${result.body?.generated}`);
console.log(`insufficientEvidence: ${result.body?.insufficientEvidence ?? false}`);
if (result.body?.reason) {
  console.log(`reason: ${result.body.reason}`);
}
if (result.body?.partial) {
  console.log(`partial: true (JSON response was truncated by the model)`);
}

const insights = Array.isArray(result.body?.insights) ? result.body.insights : [];
console.log(`\nTotal insights returned: ${insights.length}\n`);

for (const [index, insight] of insights.entries()) {
  console.log(`[${index + 1}] ${insight.title}`);
  console.log(`    Detail:   ${insight.detail}`);
  console.log(`    Risk:     ${insight.risk}`);
  console.log(`    Standard: ${insight.standard || "(none cited)"}`);
  if (insight.evidence) {
    console.log(`    Evidence: "${insight.evidence}"`);
  }
  if (insight.workingPaperRef) {
    console.log(`    WP Ref:   ${insight.workingPaperRef}`);
  }
  if (insight.amountMinor != null) {
    console.log(`    Amount:   Rs ${(insight.amountMinor / 100).toLocaleString("en-IN")}`);
  }
  if (insight.why) {
    console.log(`    Why:      ${insight.why}`);
  }
  if (insight.nextAction) {
    console.log(`    Next:     ${insight.nextAction}`);
  }
  console.log("");
}

// Coverage check: which WP Refs in the source got no document-specific
// (non-mandatory) insight attributed to them at all. This is the mechanical
// version of the human's "you missed B-12 and F-16 entirely" critique -
// every fixture with WP Ref tags gets this for free.
const mandatoryTitles = new Set([
  "Determine materiality and sample basis",
  "Obtain external third-party confirmations",
  "Obtain written representations from management",
]);
const coveredRefs = new Set(
  insights
    .filter((item) => !mandatoryTitles.has(item.title))
    .map((item) => item.workingPaperRef)
    .filter(Boolean),
);
const missedRefs = allRefs.filter((ref) => !coveredRefs.has(ref));

console.log("--- Coverage check ---");
console.log(`WP Refs covered by at least one document-specific insight: ${[...coveredRefs].sort().join(", ") || "(none)"}`);
if (missedRefs.length > 0) {
  console.log(`WP Refs with ZERO document-specific insight: ${missedRefs.join(", ")}  <-- gap`);
} else {
  console.log("Every WP Ref in the source has at least one document-specific insight.");
}

// Duplicate-title / near-duplicate check: two insights whose titles share
// most of their significant words are almost certainly the same underlying
// finding restated, which is the human's G-17 critique made mechanical.
function significantWords(title) {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 3),
  );
}

const nonMandatory = insights.filter((item) => !mandatoryTitles.has(item.title));
const nearDuplicates = [];
for (let i = 0; i < nonMandatory.length; i++) {
  for (let j = i + 1; j < nonMandatory.length; j++) {
    const a = significantWords(nonMandatory[i].title);
    const b = significantWords(nonMandatory[j].title);
    const overlap = [...a].filter((word) => b.has(word)).length;
    const smaller = Math.min(a.size, b.size);
    if (smaller > 0 && overlap / smaller >= 0.6) {
      nearDuplicates.push([nonMandatory[i].title, nonMandatory[j].title]);
    }
  }
}

console.log("\n--- Near-duplicate title check ---");
if (nearDuplicates.length > 0) {
  for (const [a, b] of nearDuplicates) {
    console.log(`  possible duplicate: "${a}"  <->  "${b}"`);
  }
} else {
  console.log("No near-duplicate titles found.");
}

console.log("");
