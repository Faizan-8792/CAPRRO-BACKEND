// tests/desktop-fixture-drift-contract.mjs
//
// V12 (.kiro/finalreleasefix.md) step 5: the drift gate. Re-captures every desktop fixture into
// a disposable temp directory via tools/capture-desktop-fixtures.mjs --out, then compares each
// against the committed copy under apps/desktop-native/tests/CaPro.Desktop.Core.Tests/Fixtures.
// A difference fails this gate naming the route and the field, so a controller cannot rename or
// drop a desktop-consumed field without this suite noticing before the backend deploys.
//
// Deliberately a SHAPE diff, not a byte diff. Every fixture body carries fields this project has
// no control over between two captures of the same route -- Mongo ObjectIds, createdAt/updatedAt
// timestamps, generated join codes -- so a raw text diff would report "drift" on every single run
// even with zero real backend change. This walks both JSON trees and compares only the SET OF
// KEY PATHS present at each level (e.g. "engagement.scope", "engagement.checklist[].status"),
// which is exactly what a renamed or removed field changes and exactly what a fresh ObjectId
// never does.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let passed = 0;
let failed = 0;
function record(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL  ${name}`);
  if (detail) console.error(detail);
}

const repoRoot = process.cwd();
const committedDir = resolve(
  repoRoot,
  "..",
  "apps",
  "desktop-native",
  "tests",
  "CaPro.Desktop.Core.Tests",
  "Fixtures",
);

// Collects every key PATH in a JSON value, using "[]" for array elements so index does not
// itself count as a key -- two arrays of different length are not "drift" on their own; a
// missing field on an element that exists in both is.
function collectKeyPaths(value, prefix, into) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectKeyPaths(item, `${prefix}[]`, into);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      into.add(path);
      collectKeyPaths(child, path, into);
    }
  }
}

function keyPathsOf(fixtureJson) {
  const paths = new Set();
  collectKeyPaths(fixtureJson.body, "body", paths);
  return paths;
}

function diffFixture(fileName, committedPath, freshPath) {
  const committed = JSON.parse(readFileSync(committedPath, "utf8"));
  const fresh = JSON.parse(readFileSync(freshPath, "utf8"));

  const committedKeys = keyPathsOf(committed);
  const freshKeys = keyPathsOf(fresh);

  const removed = [...committedKeys].filter((key) => !freshKeys.has(key));
  const added = [...freshKeys].filter((key) => !committedKeys.has(key));

  if (removed.length === 0 && added.length === 0) {
    return null;
  }

  const parts = [];
  if (removed.length > 0) parts.push(`removed: ${removed.join(", ")}`);
  if (added.length > 0) parts.push(`added: ${added.join(", ")}`);
  return `${fileName} (${committed.method} ${committed.path}) -- ${parts.join("; ")}`;
}

if (!existsSync(committedDir)) {
  record(
    "committed Fixtures directory exists",
    false,
    `Expected ${committedDir} -- run tools/capture-desktop-fixtures.mjs at least once and commit its output.`,
  );
} else {
  const tempDir = mkdtempSync(join(tmpdir(), "capro-desktop-fixture-drift-"));
  try {
    execFileSync(
      process.execPath,
      [resolve(repoRoot, "tools", "capture-desktop-fixtures.mjs"), "--out", tempDir],
      {
        cwd: repoRoot,
        stdio: "pipe",
        timeout: 60_000,
        // A database NAME, deliberately, not a URI: the capture tool prefers the replica set and
        // falls back on its own. Pinning a standalone URI here used to strip transaction support
        // from the re-capture only, so the two transactional routes came back different and the
        // gate reported real field drift that did not exist.
        env: {
          ...process.env,
          MONGODB_URI: "",
          CAPTURE_DB_NAME: "capro-desktop-fixture-drift-check",
        },
      },
    );
    record("re-capture into the temp directory exits 0", true);
  } catch (error) {
    record(
      "re-capture into the temp directory exits 0",
      false,
      error.stdout?.toString() || error.message,
    );
  }

  // Refuse to compare captures taken against different database classes. Two routes
  // (PATCH api/digests/settings, POST api/firms/join) open MongoDB transactions, so a capture taken
  // without a replica set genuinely cannot produce their success shapes. Comparing across the two
  // reports real, alarming-looking field drift for a reason that has nothing to do with the code --
  // which is exactly what this gate did on its first run after the replica set arrived.
  const manifestOf = (dir) => {
    try {
      return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    } catch {
      return null;
    }
  };
  const committedManifest = manifestOf(committedDir);
  const freshManifest = manifestOf(tempDir);
  if (
    committedManifest
    && freshManifest
    && committedManifest.transactionsAvailable !== freshManifest.transactionsAvailable
  ) {
    record(
      "the re-capture used the same database class as the committed fixtures",
      false,
      `committed fixtures were captured with transactionsAvailable=${committedManifest.transactionsAvailable} ` +
        `but this re-capture had ${freshManifest.transactionsAvailable}. Start the replica set ` +
        `(capro-mongo-rs on 27118) and re-run; the difference below would be the database, not the code.`,
    );
  }

  const committedFiles = readdirSync(committedDir).filter(
    (name) => name.endsWith(".json") && name !== "manifest.json",
  );
  const freshFiles = new Set(
    existsSync(tempDir)
      ? readdirSync(tempDir).filter((name) => name.endsWith(".json") && name !== "manifest.json")
      : [],
  );

  const driftLines = [];
  for (const fileName of committedFiles) {
    const freshPath = join(tempDir, fileName);
    if (!freshFiles.has(fileName)) {
      driftLines.push(`${fileName} -- present in committed Fixtures/ but no longer captured at all`);
      continue;
    }
    const drift = diffFixture(fileName, join(committedDir, fileName), freshPath);
    if (drift) driftLines.push(drift);
  }

  for (const fileName of freshFiles) {
    if (!committedFiles.includes(fileName)) {
      driftLines.push(`${fileName} -- newly captured but never committed to Fixtures/`);
    }
  }

  record(
    `all ${committedFiles.length} committed fixtures still match their route's real shape`,
    driftLines.length === 0,
    driftLines.join("\n"),
  );

  rmSync(tempDir, { recursive: true, force: true });
}

console.log(`Result: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
