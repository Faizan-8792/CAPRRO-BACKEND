// tests/lib/mutants.mjs
//
// W10 (2026-10-17): the "deliberate breakage" half of an engine gate, automated. Every engine contract
// says "each rule has a fixture and a recorded mutation: broke X, test Y failed"; before this, that was a
// sentence in a comment. Here a mutant is a copy of the engine's source with one exact replacement,
// written next to the original (so its relative imports still resolve), imported, run through the same
// checks and deleted. A mutant that every check survives means the checks do not pin that rule, and the
// suite fails naming it.
//
//   const report = await runMutants({
//     enginePath: new URL("../../src/services/audit-pack-engine/x.engine.js", import.meta.url),
//     mutants: [{ name: "drop the 4G subtraction", from: "- (parts[\"4G\"] ?? 0)", to: "" }],
//     runChecks: async (engineModule) => [{ name, pass }, ...],
//   });

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function runMutants({ enginePath, mutants, runChecks }) {
  const path = enginePath instanceof URL ? fileURLToPath(enginePath) : String(enginePath);
  const source = readFileSync(path, "utf8");
  const results = [];
  let index = 0;
  for (const mutant of mutants) {
    index += 1;
    const occurrences = source.split(mutant.from).length - 1;
    if (occurrences !== 1) {
      results.push({ name: mutant.name, applied: false, killedBy: [], detail: `the replaced text occurs ${occurrences} times, expected exactly once` });
      continue;
    }
    const mutantPath = join(dirname(path), `__mutant_${process.pid}_${index}_${basename(path)}`);
    try {
      writeFileSync(mutantPath, source.replace(mutant.from, () => mutant.to));
      const module = await import(`${pathToFileURL(mutantPath).href}?m=${index}`);
      const checks = await runChecks(module);
      const killedBy = checks.filter((c) => !c.pass).map((c) => c.name);
      results.push({ name: mutant.name, applied: true, killedBy, detail: killedBy.length ? "" : "every check passed with this rule broken" });
    } catch (error) {
      // A mutant that does not even load or throws mid-check is caught by the suite as well, but that is
      // a weaker kill than a named check failing: report it so it is seen.
      results.push({ name: mutant.name, applied: true, killedBy: [`threw: ${String(error.message).split("\n")[0]}`], detail: "" });
    } finally {
      rmSync(mutantPath, { force: true });
    }
  }
  return results;
}

/** Turns mutant results into checks: one per mutant, passing only if some check noticed the breakage. */
export function mutantChecks(results) {
  return results.map((r) => ({
    name: `mutation: ${r.name} is caught${r.killedBy.length ? ` (by: ${r.killedBy[0]})` : ""}`,
    pass: r.applied && r.killedBy.length > 0,
    detail: r.detail,
  }));
}

// Kept for suites that want a scratch folder of their own.
export function scratchDir(path) {
  mkdirSync(path, { recursive: true });
  return path;
}
