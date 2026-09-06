// Every suite in tests/ is actually run by the release gate.
//
// run-gates.ps1 has said, for a long time and in its own words:
//
//   "V17's invariant is that the runner executes as many suites as exist in tests/, so a new suite
//    left unregistered breaks that gate rather than merely going unrun."
//
// Nothing enforced it. The runner picks suites from a hand-maintained list, so a test file that
// exists is not thereby gated, and the only signal that a suite was forgotten was that its name
// did not appear in a log nobody diffs.
//
// Measured on 2026-09-06: 80 files, 76 run, 2 run in a different step, and FOUR that had simply
// been forgotten - audit-population-boundary, audit-provenance, audit-section-ledger and
// audit-test6-canonical. All four passed. They were not excluded for failing; they were excluded
// for nothing, and had been for as long as they had existed.
//
// A test that never runs is worse than no test: it is a claim of coverage that is not being paid
// for, and this file is what makes the claim true.
//
//   node --test capro-backend/tests/gate-suite-coverage.test.mjs

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const runner = readFileSync(join(root, "tools/run-gates.ps1"), "utf8");

/**
 * The names inside one PowerShell `@( ... )` array literal.
 *
 * Scans to the MATCHING close paren rather than the first one. An earlier attempt at this used
 * indexOf(")"), which stopped at a parenthesis inside a comment and reported 27 unregistered
 * suites - most of which the gate log plainly showed running. A wrong answer that looks alarming
 * is worse than no answer.
 */
function namesInArray(variable) {
  const marker = `$${variable} = @(`;
  const start = runner.indexOf(marker);
  assert.ok(start >= 0, `${marker} is gone from run-gates.ps1`);

  let depth = 0;
  let end = -1;
  for (let i = start + marker.length - 1; i < runner.length; i += 1) {
    if (runner[i] === "(") depth += 1;
    else if (runner[i] === ")") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  assert.ok(end > start, `${marker} is never closed`);

  const body = runner
    .slice(start, end)
    // Comments can hold anything, including quoted words that are not suite names.
    .replace(/#[^\n]*/g, "");
  return [...body.matchAll(/"([A-Za-z0-9][A-Za-z0-9._-]*)"/g)].map((m) => m[1]);
}

// Suites the runner executes in a step of its own rather than from the main list. Each is named
// here with the reason, so this allowlist cannot quietly become a place to hide a forgotten suite.
const RUN_IN_ANOTHER_STEP = new Map([
  ["deploy-archive-security", "invoked directly by the commit-pinned archive validation section"],
  ["deploy-archive-boundary", "invoked directly by the commit-pinned archive validation section"],
]);

test("the suite list parses to something plausible", () => {
  // A parser that silently returns nothing would make every assertion below vacuous.
  const suites = namesInArray("suites");
  assert.ok(
    suites.length > 40,
    `only ${suites.length} suites parsed out of run-gates.ps1; the parser is probably wrong`,
  );
  assert.ok(suites.includes("production-readiness-checklist"), "a known suite is missing");
});

test("every test file is run by the gate", () => {
  const registered = new Set([
    ...namesInArray("suites"),
    ...namesInArray("replicaSetSuites"),
  ]);

  const files = readdirSync(join(root, "tests"))
    .filter((name) => name.endsWith(".mjs"))
    .map((name) => name.replace(/\.mjs$/, ""));

  const forgotten = files.filter(
    (name) => !registered.has(name) && !RUN_IN_ANOTHER_STEP.has(name),
  );

  assert.deepEqual(
    forgotten,
    [],
    `these suites exist in tests/ but the release gate never runs them:\n  ${forgotten.join("\n  ")}\n` +
      `Register each in the $suites array in tools/run-gates.ps1, or add it to RUN_IN_ANOTHER_STEP ` +
      `in this file with the reason it is invoked elsewhere.`,
  );
});

test("the gate does not name a suite that no longer exists", () => {
  // The other direction. A registered name with no file is reported by the runner as
  // "FILE MISSING" and counted as a failure, so it would be noticed - but only on a run that gets
  // that far, and only by someone reading the log.
  const registered = [...namesInArray("suites"), ...namesInArray("replicaSetSuites")];
  const files = new Set(
    readdirSync(join(root, "tests"))
      .filter((name) => name.endsWith(".mjs"))
      .map((name) => name.replace(/\.mjs$/, "")),
  );

  const missing = registered.filter((name) => !files.has(name));
  assert.deepEqual(missing, [], `registered in run-gates.ps1 with no such file: ${missing.join(", ")}`);
});

test("the allowlist only excuses suites the runner really does invoke elsewhere", () => {
  // An allowlist nobody checks becomes the place forgotten suites go. Each entry must actually
  // appear in the runner outside the main list.
  for (const [name, reason] of RUN_IN_ANOTHER_STEP) {
    assert.match(
      runner,
      new RegExp(`tests\\\\${name}\\.mjs`),
      `${name} is excused as "${reason}" but run-gates.ps1 does not invoke it directly`,
    );
  }
});
