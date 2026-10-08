// L12 step 1: enumerate the erasure surface MECHANICALLY, and classify it against the L9 decision.
//
//   node tools/enumerate-erasure-surface.mjs            # human-readable report
//   node tools/enumerate-erasure-surface.mjs --json     # machine-readable, for the coverage gate
//
// WHY MECHANICAL
// --------------
// L12 step 1 is explicit: "Enumerate the erasure surface mechanically rather than by hand, because
// a hand-written list is how 28 collections got missed the first time." Nothing in this file is a
// typed list of model names. Every fact is read out of src/models.
//
// TRAPS THIS AVOIDS, each of which has already bitten this project once:
//   * File count != model count. DigestDelivery.js registers TWO models (DigestDelivery and
//     DigestRecoveryCursor), so counting files gives 38 where the answer is 39.
//   * Five models carry `rejectMutation` query middleware — ActivityEvent, AuditWorkingPaperRow,
//     CaseAnalysis, CaseSubmission, CaseTimelineEvent. `Model.deleteMany()` on those is refused by
//     design, so an erasure cascade written as a loop over models silently fails on exactly the
//     append-only collections that matter most. They need a deliberate, documented strategy.
//   * A TTL index is not erasure. TaskBulkOperation expires on its own schedule, which is a
//     retention rule, not a response to an erasure request.
//
// The classification below is DERIVED from properties read out of the files plus one explicit,
// reason-carrying table for the cases that cannot be derived. Anything that is neither derivable
// nor listed is reported as UNCLASSIFIED and makes this tool exit non-zero — that is the coverage
// gate L12's second Verify bullet asks for.

import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The classification table lives in the service layer, not here. Both this gate and the cascade
// (`src/services/firm-erasure.service.js`) read the SAME module, so the gate cannot pass while the
// cascade is working from a different list — which is the original L12 defect in a new place.
import {
  PINNED_FIRM_SCOPED,
  classify,
} from "../src/services/erasure-classification.js";

const here = dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = join(here, "..", "src", "models");

const files = readdirSync(MODELS_DIR).filter((f) => f.endsWith(".js")).sort();
const models = [];

for (const file of files) {
  const src = readFileSync(join(MODELS_DIR, file), "utf8");
  const registrations = [...src.matchAll(/mongoose\.model\(\s*["'`]([A-Za-z0-9_]+)["'`]/g)].map((m) => m[1]);
  for (const name of registrations) {
    models.push({
      name,
      file,
      hasFirmId: /\bfirmId\s*:/.test(src),
      hasUserId: /\buserId\s*:/.test(src),
      rejectsMutation: /rejectMutation/.test(src),
      hasTtl: /expireAfterSeconds/.test(src) || /\bexpires\s*:/.test(src),
    });
  }
}

for (const m of models) {
  const { strategy, reason, derived } = classify(m.name, m);
  m.strategy = strategy ?? "OUT-OF-SCOPE";
  m.reason = reason;
  m.derived = derived;
}

const firmScoped = models.filter((m) => m.hasFirmId);
const unclassified = firmScoped.filter((m) => !m.strategy || m.strategy === "UNCLASSIFIED" || !m.reason);

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ models, firmScopedCount: firmScoped.length, unclassified: unclassified.map((m) => m.name) }, null, 2));
  process.exit(unclassified.length === 0 ? 0 : 1);
}

console.log("=== erasure surface, read from src/models ===");
console.log(`  files scanned        : ${files.length}`);
console.log(`  models registered    : ${models.length}`);
console.log(`  carrying firmId      : ${firmScoped.length}`);
console.log(`  rejectMutation       : ${models.filter((m) => m.rejectsMutation).length}`);
console.log(`  TTL index            : ${models.filter((m) => m.hasTtl).length}`);

const perFile = {};
for (const m of models) perFile[m.file] = (perFile[m.file] || 0) + 1;
const multi = Object.entries(perFile).filter(([, n]) => n > 1);
if (multi.length) {
  console.log("");
  console.log("  files registering more than one model (why file count != model count):");
  for (const [f, n] of multi) {
    console.log(`    ${f} -> ${n}: ${models.filter((m) => m.file === f).map((m) => m.name).join(", ")}`);
  }
}

console.log("");
console.log("=== classification of the firm-scoped surface ===");
for (const s of ["PURGE", "PSEUDONYMISE", "RETAIN"]) {
  const group = firmScoped.filter((m) => m.strategy === s).sort((a, b) => a.name.localeCompare(b.name));
  console.log("");
  console.log(`  ${s} (${group.length})`);
  for (const m of group) {
    const flags = [m.rejectsMutation ? "rejectMutation" : "", m.hasTtl ? "TTL" : ""].filter(Boolean).join(" ");
    console.log(`    ${m.name.padEnd(28)}${flags ? "[" + flags + "] " : ""}${m.derived ? "(derived)" : "(reasoned)"}`);
  }
}

// Drift against the pinned baseline. This is the coverage gate: a new firm-scoped model must be
// noticed and classified, never silently absorbed by the derived default.
const actual = firmScoped.map((m) => m.name).sort();
const pinned = [...PINNED_FIRM_SCOPED].sort();
const added = actual.filter((n) => !pinned.includes(n));
const removed = pinned.filter((n) => !actual.includes(n));

console.log("");
console.log("=== drift against the pinned surface ===");
console.log(`  pinned ${pinned.length}, found ${actual.length}`);
if (added.length) {
  console.log(`  NEW firm-scoped model(s) not in the baseline: ${added.join(", ")}`);
  console.log("  Classify each in REASONS with a written reason, then add it to PINNED_FIRM_SCOPED.");
}
if (removed.length) {
  console.log(`  model(s) in the baseline but no longer present: ${removed.join(", ")}`);
  console.log("  If a collection was retired, remove it from PINNED_FIRM_SCOPED deliberately.");
}
if (!added.length && !removed.length) console.log("  no drift");

console.log("");
if (added.length || removed.length) {
  console.log("=== FAILED: the erasure surface changed ===");
  process.exit(1);
}
if (unclassified.length) {
  console.log(`=== UNCLASSIFIED: ${unclassified.length} ===`);
  for (const m of unclassified) console.log(`    ${m.name} (${m.file})`);
  console.log("");
  console.log("A firm-scoped collection with no strategy is how collections get missed. Add it to");
  console.log("REASONS with a written reason, or give it a derivable shape.");
  process.exit(1);
}
console.log("=== every firm-scoped collection is classified with a reason ===");
process.exit(0);
