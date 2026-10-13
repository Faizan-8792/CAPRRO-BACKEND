// tools/verify-doc-citations.mjs
//
// Checks every `file.js:line` citation in a contract document against the source
// it names. Written because the first draft of docs/tds-health-contract.md had 6
// of 12 citations wrong: a doc whose line numbers are stale is worse than no doc,
// because a reader trusts it and stops checking.
//
// Two levels of checking:
//   bounds  — the file exists and the cited line number is within it
//   content — an optional `[[expect: text]]` marker on the same line of the doc
//             must appear in the cited source line (or its range)
//
// Usage:
//   node tools/verify-doc-citations.mjs docs/notices-cases-contract.md
//
// Exits non-zero if any citation is out of bounds or fails its content check.

import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const BACKEND = resolve(
  new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
);

const docArg = process.argv[2];
if (!docArg) {
  console.error(
    "usage: node tools/verify-doc-citations.mjs <doc path relative to repo root>",
  );
  process.exit(2);
}

const docPath = resolve(BACKEND, docArg);
if (!existsSync(docPath)) {
  console.error(`document not found: ${docPath}`);
  process.exit(2);
}

const doc = readFileSync(docPath, "utf8");
const docLines = doc.split(/\r?\n/);

// Matches src/services/foo.service.js:123 and :123-145 and :123,145
const CITATION =
  /((?:src|tests|tools|public)\/[A-Za-z0-9._/-]+\.(?:js|mjs|ps1)):(\d+)(?:\s*[-–]\s*(\d+))?/g;

const sourceCache = new Map();
function sourceLines(relPath) {
  if (!sourceCache.has(relPath)) {
    const full = join(BACKEND, relPath);
    sourceCache.set(
      relPath,
      existsSync(full) ? readFileSync(full, "utf8").split(/\r?\n/) : null,
    );
  }
  return sourceCache.get(relPath);
}

let total = 0;
let bad = 0;
const problems = [];

docLines.forEach((line, index) => {
  const expectMatch = /\[\[expect:\s*([^\]]+)\]\]/.exec(line);
  const expected = expectMatch ? expectMatch[1].trim() : null;

  for (const match of line.matchAll(CITATION)) {
    total += 1;
    const [, relPath, startRaw, endRaw] = match;
    const start = Number(startRaw);
    const end = endRaw ? Number(endRaw) : start;
    const src = sourceLines(relPath);
    const docLineNo = index + 1;

    if (!src) {
      bad += 1;
      problems.push(`${docPath}:${docLineNo}  MISSING FILE  ${relPath}`);
      continue;
    }
    if (start < 1 || end > src.length || end < start) {
      bad += 1;
      problems.push(
        `${docPath}:${docLineNo}  OUT OF BOUNDS  ${relPath}:${startRaw}${
          endRaw ? `-${endRaw}` : ""
        } (file has ${src.length} lines)`,
      );
      continue;
    }
    if (expected) {
      const window = src.slice(start - 1, end).join("\n");
      if (!window.includes(expected)) {
        bad += 1;
        problems.push(
          `${docPath}:${docLineNo}  CONTENT MISMATCH  ${relPath}:${startRaw}${
            endRaw ? `-${endRaw}` : ""
          }\n      expected to find: ${expected}\n      actual line ${start}: ${src[start - 1].trim()}`,
        );
      }
    }
  }
});

// --print dumps every citation beside the source line it names, so the content of
// each claim can be reviewed rather than only its line number bounds-checked.
if (process.argv.includes("--print")) {
  docLines.forEach((line, index) => {
    for (const match of line.matchAll(CITATION)) {
      const [, relPath, startRaw] = match;
      const src = sourceLines(relPath);
      const start = Number(startRaw);
      const actual =
        src && start >= 1 && start <= src.length
          ? src[start - 1].trim()
          : "<OUT OF BOUNDS>";
      console.log(`doc:${index + 1}  ${relPath}:${startRaw}\n      ${actual}`);
    }
  });
  console.log("");
}

console.log(`citations found: ${total}`);
console.log(`citations checked against source: ${total - bad} ok, ${bad} bad`);

if (problems.length) {
  console.error("\n" + problems.join("\n"));
  process.exit(1);
}
