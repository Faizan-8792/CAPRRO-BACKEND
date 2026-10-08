// L12 Verify bullet 7, mechanised: the desktop erasure card must state what will and will not be
// erased "in wording identical to the L11 policy text", proved by diffing the two strings.
//
//   node tests/erasure-copy-parity.mjs
//
// There are two ways that promise can break, and this covers both.
//
//   1. The desktop could paraphrase the policy on its way to the screen. It cannot: the card
//      renders `retention.accountDeletion` verbatim, and AccountErasureRequestTests asserts the
//      rendered text is reference-equal in content to the policy string it was handed. That is a
//      property, not a literal, so it holds for any sentence the server sends.
//
//   2. The desktop's own TEST could be validating against a sentence the server no longer serves.
//      Then the property above still passes while the fixture it is proved with is fiction, and
//      nobody notices the shipped copy changed. That is the gap this file closes: it reads the
//      literal out of the C# test and diffs it against what describeRetentionPolicy() actually
//      returns today.
//
// A cross-language string diff is unusual, and it is here deliberately. The alternative is two
// copies of a legally-operative sentence in two repositories drifting apart silently, which is the
// exact failure L10 was opened to fix.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describeRetentionPolicy } from "../src/services/data-retention.service.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  } catch (error) {
    failed += 1;
    failures.push(name);
    console.log(`  FAIL ${name}`);
    console.log(`       ${error.message.split("\n").slice(0, 6).join("\n       ")}`);
  }
}

/**
 * Pull a `private const string NAME = "..." + "...";` literal out of a C# source file and rebuild
 * the string it declares. Deliberately strict: an unexpected shape throws rather than silently
 * returning a partial sentence, because a partial sentence would compare unequal and be read as
 * drift that is not there.
 */
function readCSharpConstant(file, name) {
  const source = readFileSync(file, "utf8");
  const start = source.indexOf(`const string ${name} =`);
  assert.ok(start !== -1, `${name} not found in ${file}`);

  const end = source.indexOf(";", start);
  assert.ok(end !== -1, `${name} has no terminating semicolon`);

  const body = source.slice(start, end);
  const parts = [...body.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  assert.ok(parts.length > 0, `${name} declares no string literal`);

  return parts
    .join("")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

const CARD_TEST = join(
  repoRoot,
  "apps", "desktop-native", "tests", "CaPro.Desktop.Core.Tests", "AccountErasureRequestTests.cs",
);
const PRESENTER = join(
  repoRoot,
  "apps", "desktop-native", "src", "CaPro.Desktop.Core", "Presentation", "AccountErasureRequest.cs",
);
const PAGE = join(
  repoRoot,
  "apps", "desktop-native", "src", "CaPro.Desktop.App", "Views", "SecurityPage.xaml.cs",
);

const served = describeRetentionPolicy().accountDeletion;
const desktopFixture = readCSharpConstant(CARD_TEST, "PolicySentence");

console.log("=== the desktop card's wording against the served policy ===");

test("the sentence the desktop card is tested with is the sentence the server serves", () => {
  // If this fails, one of the two moved. Update the C# constant to match the server -- never the
  // other way round: the server's copy is the one users and the published policy page read.
  assert.equal(desktopFixture, served);
});

test("the served policy is not empty, so the diff above is not two blanks matching", () => {
  assert.ok(typeof served === "string" && served.trim().length > 200, `served policy is ${served?.length} chars`);
});

test("the policy states both halves: what is erased and what is kept", () => {
  assert.match(served, /required by law to keep are retained/i);
  assert.match(served, /is erased/i);
});

test("the policy names the grievance channel the card extracts", () => {
  assert.match(served, /caprotoolkit\.in/i);
});

console.log("");
console.log("=== the card renders the policy rather than restating it ===");

test("the presenter assigns the policy text through, with no rewriting", () => {
  const source = readFileSync(PRESENTER, "utf8");
  // The property must be assigned straight from the policy field.
  assert.match(source, /PolicyText\s*=\s*text\b/);
});

test("neither the presenter nor the page hard-codes the policy sentence", () => {
  // A second copy of the sentence in client code is the drift this whole file exists to prevent.
  const opening = served.slice(0, 60);
  for (const file of [PRESENTER, PAGE]) {
    const source = readFileSync(file, "utf8");
    assert.ok(
      !source.includes(opening),
      `${file} contains a literal copy of the policy sentence; it must render the server's string instead`,
    );
  }
});

test("the page shows the policy text and the not-a-delete line from the presenter", () => {
  const source = readFileSync(PAGE, "utf8");
  assert.match(source, /ErasurePolicyLine\.Text\s*=\s*view\.PolicyText/);
  assert.match(source, /ErasureNotADeleteLine\.Text\s*=\s*AccountErasureRequestView\.NotADeleteButtonLine/);
});

console.log("");
console.log(`erasure copy parity: ${passed}/${passed + failed} passed`);
if (failed > 0) {
  for (const name of failures) console.error(`  FAIL ${name}`);
  process.exit(1);
}
