// tests/error-contract-invariants.mjs
//
// Server-wide invariants on the public error contract.
//
// Why this exists. Under T31 every OCR_* code turned out to be missing from
// PUBLIC_ERROR_CODES in src/app.js, so production replaced each OCR failure with
// a generic message chosen from the HTTP status alone. Nothing anywhere in tests/
// referenced that allow-list, which is why the omission survived. The allow-list
// decides the wording of every user-facing server error, so it needs invariants
// rather than per-surface spot checks.
//
// Three throw patterns exist and all three are covered. Missing one under-reports
// badly: a scan matching only httpError() reports seven live public codes as dead.
//
//   httpError(status, message, code)                  most services
//   serviceError(message, status, { code })           gst-import.service.js
//   importRequestError(message, code, { fields })     import-preview.service.js

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKEND = join(__dirname, "..");
const SRC = join(BACKEND, "src");

const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass, detail });

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (/\.(js|mjs)$/.test(entry)) acc.push(full);
  }
  return acc;
}

function stripLineComments(source) {
  return source
    .split("\n")
    .map((line) => {
      const marker = line.indexOf("//");
      return marker === -1 ? line : line.slice(0, marker);
    })
    .join("\n");
}

// ─── The public allow-list ─────────────────────────────────────────

const app = readFileSync(join(SRC, "app.js"), "utf8");
const DECLARATION = "const PUBLIC_ERROR_CODES = new Set([";
const declarationStart = app.indexOf(DECLARATION);
const declarationEnd = app.indexOf("]);", declarationStart);
const publicCodes =
  declarationStart === -1 || declarationEnd === -1
    ? []
    : [
        ...stripLineComments(
          app.slice(declarationStart + DECLARATION.length, declarationEnd)
        ).matchAll(/"([^"]+)"/g),
      ].map((match) => match[1]);

check(
  "PUBLIC_ERROR_CODES parsed from src/app.js",
  publicCodes.length >= 30,
  `parsed ${publicCodes.length} codes`
);

check(
  "every parsed allow-list entry is an UPPER_SNAKE code",
  publicCodes.length > 0 && publicCodes.every((code) => /^[A-Z][A-Z0-9_]+$/.test(code)),
  "so no quoted sentence from a comment leaked into the set"
);

check(
  "negative control: the allow-list does not contain an invented code",
  !publicCodes.includes("DEFINITELY_NOT_A_REAL_CODE"),
  "membership assertions below are therefore not vacuously true"
);

// ─── Every thrown code, across all three helpers ────────────────────

const PATTERNS = [
  {
    // httpError(status, "message", "CODE")
    name: "httpError",
    regex:
      /httpError\(\s*(\d{3})\s*,\s*(?:"([^"]*)"|`([^`]*)`)\s*,\s*"([A-Z][A-Z0-9_]+)"\s*\)/g,
    read: (m) => ({ status: m[1], message: m[2] ?? m[3] ?? "", code: m[4] }),
  },
  {
    // serviceError("message", status, { code: "CODE", ... })
    name: "serviceError",
    regex:
      /serviceError\(\s*(?:"([^"]*)"|`([^`]*)`)\s*,\s*(\d{3})\s*,\s*\{[^}]*?code:\s*"([A-Z][A-Z0-9_]+)"/g,
    read: (m) => ({ status: m[3], message: m[1] ?? m[2] ?? "", code: m[4] }),
  },
  {
    // importRequestError("message", "CODE", ...) — always a 400 by construction
    name: "importRequestError",
    regex:
      /importRequestError\(\s*(?:"([^"]*)"|`([^`]*)`)\s*,\s*"([A-Z][A-Z0-9_]+)"/g,
    read: (m) => ({ status: "400", message: m[1] ?? m[2] ?? "", code: m[3] }),
  },
];

const thrown = new Map();
const perPattern = new Map(PATTERNS.map((p) => [p.name, 0]));

for (const file of walk(SRC)) {
  const text = readFileSync(file, "utf8");
  const rel = file.slice(BACKEND.length + 1).replace(/\\/g, "/");
  for (const pattern of PATTERNS) {
    for (const match of text.matchAll(pattern.regex)) {
      const { status, message, code } = pattern.read(match);
      const line = text.slice(0, match.index).split(/\r?\n/).length;
      perPattern.set(pattern.name, perPattern.get(pattern.name) + 1);
      if (!thrown.has(code)) thrown.set(code, []);
      thrown.get(code).push({ rel, line, status, message, helper: pattern.name });
    }
  }
}

check(
  "thrown codes extracted from src/",
  thrown.size >= 90,
  `${thrown.size} distinct codes; ` +
    [...perPattern.entries()].map(([n, c]) => `${n}=${c}`).join(" ")
);

check(
  "all three error helpers are represented",
  [...perPattern.values()].every((count) => count > 0),
  "a pattern with zero matches means the helper was renamed and this test went blind"
);

// ─── Invariant 1: public messages are safe to show verbatim ─────────
// A public code returns err.message unchanged to the user
// (src/app.js publicErrorMessage: `if (publicCode && err?.message) return err.message`),
// so each public message must satisfy the user-facing copy rules directly.

const FORBIDDEN =
  /\bHTTP\b|\bnull\b|\bexception\b|\b(?:400|401|403|404|409|413|415|422|429|500|502|503|504)\b/i;

const leaky = [];
for (const [code, uses] of thrown) {
  if (!publicCodes.includes(code)) continue;
  for (const use of uses) {
    if (FORBIDDEN.test(use.message)) {
      leaky.push(`${use.rel}:${use.line} ${code} — "${use.message}"`);
    }
  }
}

check(
  "no public error message contains HTTP, null, exception or a bare status number",
  leaky.length === 0,
  leaky.length ? leaky.join(" | ") : "every public message is safe to show verbatim"
);

// ─── Invariant 2: the allow-list does not rot ───────────────────────
// A public code that is never thrown is dead weight, and a reader will assume it
// is live. PUBLIC_IMPORT_ERROR_MESSAGES substitutes fixed copy for some codes, so
// those are allowed to be absent from the throw sites only if they are thrown at
// all — which they are, via serviceError and importRequestError.

const deadPublic = publicCodes.filter((code) => !thrown.has(code)).sort();

check(
  "every public code is thrown somewhere in src/",
  deadPublic.length === 0,
  deadPublic.length
    ? `never thrown, so the allow-list is stale: ${deadPublic.join(", ")}`
    : `all ${publicCodes.length} public codes have at least one throw site`
);

// ─── Invariant 3: one code, one status ─────────────────────────────
// A client keying off the code cannot tell a validation error from a conflict if
// the same code carries both. One known exception is pinned rather than fixed,
// because splitting it is a contract change.

const KNOWN_MULTI_STATUS = new Set(["INVALID_PRIOR_WORKING_PAPER"]);

const multiStatus = [];
for (const [code, uses] of thrown) {
  const statuses = [...new Set(uses.map((use) => use.status))].sort();
  if (statuses.length > 1 && !KNOWN_MULTI_STATUS.has(code)) {
    multiStatus.push(
      `${code}: ${statuses.join("/")} at ${uses
        .map((use) => `${use.rel}:${use.line}`)
        .join(", ")}`
    );
  }
}

check(
  "no error code is thrown with two different statuses",
  multiStatus.length === 0,
  multiStatus.length
    ? multiStatus.join(" | ")
    : `one pinned exception: ${[...KNOWN_MULTI_STATUS].join(", ")}`
);

// The pinned exception must still be real, so this cannot rot into a lie.
for (const code of KNOWN_MULTI_STATUS) {
  const uses = thrown.get(code) || [];
  const statuses = [...new Set(uses.map((use) => use.status))].sort();
  check(
    `pinned exception ${code} still carries more than one status`,
    statuses.length > 1,
    statuses.length > 1
      ? `${statuses.join("/")} — remove it from KNOWN_MULTI_STATUS once split`
      : `now single-status (${statuses.join("") || "not thrown"}); remove the pin`
  );
}

// ─── Invariant 4: consent gates are public ─────────────────────────
// Every gate protecting data egress to a third party must speak for itself; a
// generic 400 tells the user to review a form field that does not exist.

const consentGates = thrown.size
  ? [...thrown.keys()].filter((code) => /CONSENT_REQUIRED$/.test(code)).sort()
  : [];

const nonPublicConsentGates = consentGates.filter((code) => !publicCodes.includes(code));

check(
  "every *_CONSENT_REQUIRED gate is public",
  consentGates.length >= 3 && nonPublicConsentGates.length === 0,
  nonPublicConsentGates.length
    ? `genericised: ${nonPublicConsentGates.join(", ")}`
    : `${consentGates.length} gates, all public: ${consentGates.join(", ")}`
);

// ─── Report ───────────────────────────────────────────────────────

let passed = 0;
for (const entry of checks) {
  const mark = entry.pass ? "PASS" : "FAIL";
  if (entry.pass) passed += 1;
  console.log(`[${mark}] ${entry.name}${entry.detail ? ` — ${entry.detail}` : ""}`);
}

const total = checks.length;
console.log(`\nError contract invariants: ${passed}/${total}`);

if (passed !== total) {
  console.error(`\n${total - passed} check(s) failed.`);
  process.exit(1);
}
