// A reusable mutation harness for this backend.
//
//   node tools/mutation-harness.mjs tools/mutations/<name>.mjs
//
// WHY A HARNESS AND NOT A SCRIPT PER FEATURE
// ------------------------------------------
// TASK-MANAGEMENT-PLAN.md rule 9: "Mutation testing is the standard of proof, not coverage. A
// check that survives its own mutation proves nothing." Every feature that needs that proof was
// otherwise going to grow its own throwaway mutator, and the two written by hand in this project's
// history both had the same class of bug -- an anchor that silently did not match, which reads
// exactly like "nothing to mutate" and therefore exactly like "every mutation was caught".
//
// So this harness treats a missing anchor as a HARD FAILURE, never as a skip. That is the single
// most important line in the file.
//
// SAFETY, in the order it matters
// -------------------------------
//   1. The original bytes are held in memory and restored with a sha256 comparison. Not the
//      decoded text: CLAUDE.md section 7 records that reading a UTF-8 file through the wrong
//      decoder and writing it back has already mangled a rupee sign in this repository.
//   2. Restore runs in a finally, and again on SIGINT. A harness that dies mid-run must not leave
//      a mutated authorization rule on disk.
//   3. Anchors are plain strings, compared with indexOf and required to be UNIQUE. No regex --
//      rule 16 exists because escapes have been eaten repeatedly here, and a regex anchor that
//      matches two places mutates the wrong one.
//
// A MUTATION FILE looks like:
//
//   export const target = "src/services/firm-authority.service.js";
//   export const suite  = "tests/firm-role-tier-contract.mjs";
//   export const mutations = [
//     { name: "what breaks", find: "exact source text", replace: "broken text" },
//   ];
//
// A mutation is CAUGHT when the suite exits non-zero with it applied. A mutation that SURVIVES is
// a hole in the suite, and the harness exits non-zero so a gate can fail on it.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const configArgument = process.argv[2];
if (!configArgument) {
  console.error("usage: node tools/mutation-harness.mjs <mutation-file>");
  process.exit(2);
}

const config = await import(pathToFileURL(resolve(root, configArgument)).href);
const suitePath = config.suite;
const mutations = config.mutations || [];

if (mutations.length === 0) {
  console.error("This mutation file lists no mutations. That is not a pass.");
  process.exit(2);
}

// A mutation may name its own `target`, falling back to the file's default. One feature's logic
// is often split across two or three modules, and scoring them against one suite in one run is
// the difference between a mutation score for a FEATURE and a score for a file.
const targets = [
  ...new Set(mutations.map((mutation) => mutation.target || config.target)),
];
if (targets.some((target) => !target)) {
  console.error("A mutation has no target and the file declares no default target.");
  process.exit(2);
}

// Bytes, not text, per target. Restored byte-exact, verified by hash.
const baseline = new Map(
  targets.map((target) => {
    const bytes = readFileSync(join(root, target));
    return [
      target,
      {
        bytes,
        hash: createHash("sha256").update(bytes).digest("hex"),
        text: bytes.toString("utf8"),
      },
    ];
  }),
);

function restore() {
  for (const [target, original] of baseline) {
    const path = join(root, target);
    writeFileSync(path, original.bytes);
    const nowHash = createHash("sha256")
      .update(readFileSync(path))
      .digest("hex");
    if (nowHash !== original.hash) {
      console.error(
        `\nFATAL: ${target} was NOT restored byte-exactly. Expected ${original.hash}, got ${nowHash}.`,
      );
      process.exit(3);
    }
  }
}

process.once("SIGINT", () => {
  restore();
  process.exit(130);
});

/**
 * Runs the suite. Caught means it failed, which is what a mutation should do.
 *
 * A mutation file may export `command` (an argv array) and `cwd` instead of `suite`, so this
 * harness can score a C# suite through `dotnet test` as readily as a node one. Mutation testing is
 * the standard of proof for this project on both sides of the wire, and a second harness for the
 * desktop would be a second place for the missing-anchor bug to come back.
 */
const command = config.command || [process.execPath, suitePath];
const commandCwd = config.cwd ? resolve(root, config.cwd) : root;

function suiteFails() {
  const run = spawnSync(command[0], command.slice(1), {
    cwd: commandCwd,
    encoding: "utf8",
    timeout: 1_800_000,
    // A .exe is spawned directly; anything else may need the shell on Windows.
    shell: process.platform === "win32" && !/\.exe$/i.test(command[0]),
  });
  return run.status !== 0;
}

console.log(`Mutating   ${targets.join(", ")}`);
console.log(`Suite      ${command.join(" ")}`);
for (const [target, original] of baseline) {
  console.log(`Baseline   ${target} sha256 ${original.hash.slice(0, 16)}...`);
}
console.log("");

let caught = 0;
const survivors = [];
const unanchored = [];

try {
  // The suite must PASS unmutated. Otherwise every mutation "fails" the suite and every one is
  // reported caught -- a green mutation score sitting on top of a red suite.
  if (suiteFails()) {
    console.error(
      "FATAL: the suite does not pass against unmutated source. Fix that before mutating.",
    );
    process.exit(2);
  }
  console.log("baseline: suite passes unmutated\n");

  for (const mutation of mutations) {
    const target = mutation.target || config.target;
    const original = baseline.get(target);
    const occurrences = original.text.split(mutation.find).length - 1;

    // A missing or ambiguous anchor is a failure of the mutation file, not a skip. This is the
    // guard that the two hand-rolled mutators in this project's history did not have.
    if (occurrences !== 1) {
      unanchored.push(
        `${mutation.name}: anchor occurs ${occurrences} times in ${target}, need exactly 1`,
      );
      console.log(`  ANCHOR  ${mutation.name} (${occurrences} matches)`);
      continue;
    }

    writeFileSync(
      join(root, target),
      Buffer.from(original.text.replace(mutation.find, mutation.replace), "utf8"),
    );
    const wasCaught = suiteFails();
    restore();

    if (wasCaught) {
      caught += 1;
      console.log(`  CAUGHT  ${mutation.name}`);
    } else {
      survivors.push(mutation.name);
      console.log(`  SURVIVED  ${mutation.name}`);
    }
  }
} finally {
  restore();
}

console.log(`\n${caught}/${mutations.length} mutations caught`);
if (unanchored.length) {
  console.log(`\n${unanchored.length} mutation(s) could not be anchored:`);
  for (const item of unanchored) console.log(`  - ${item}`);
}
if (survivors.length) {
  console.log(`\n${survivors.length} SURVIVED - the suite does not check these:`);
  for (const item of survivors) console.log(`  - ${item}`);
}
process.exit(survivors.length || unanchored.length ? 1 : 0);
