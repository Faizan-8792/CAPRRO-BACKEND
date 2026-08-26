// tests/user-facing-error-contract.mjs
//
// Finding V13-P12-F2: exception text reaching a user through a 200 OK body.
//
// Why this exists, and why error-contract-invariants.mjs does not already cover it. That file
// guards the THROWN path — PUBLIC_ERROR_CODES, and the wording app.js picks for a status. It is
// thorough about it. But the Express error handler only ever sees an error that was thrown out of
// a route. The sites this file guards do the opposite: they CATCH, and then copy `error.message`
// into a value that is serialised into a normal success response — a preview's `errors[]`, a
// batch's `errorSummary`, a run's `lastError`. Nothing on that path passes through
// publicErrorMessage, so the allow-list has no say and the invariants above cannot see it.
//
// The consequence is specific rather than theoretical. A TypeError raised by a bug in our own
// spreadsheet parsing arrived beside a row number and a column name, reading to a chartered
// accountant as a statement about their GSTR-3B or their TDS return.
//
// The fix is a discriminator the codebase had already invented twice — importRequestError and
// StatutoryDateError both set statusCode = 400 to mark copy that was written for a user.
// src/utils/user-facing-error.js names that convention; these checks keep every known sink using
// it, so a new unguarded catch fails here rather than shipping.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  isUserFacingError,
  userFacingError,
  userFacingMessage,
} from "../src/utils/user-facing-error.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, "..", "src");

const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass, detail });
const read = (rel) => readFileSync(join(SRC, rel), "utf8");

// ─── 1. The discriminator itself ──────────────────────────────────

check(
  "userFacingError marks its message as authored",
  isUserFacingError(userFacingError("Amount cannot be negative")) === true,
);

check(
  "a bare exception is not treated as authored",
  isUserFacingError(new TypeError("x.y is not a function")) === false,
);

check(
  "a 5xx is not treated as authored",
  isUserFacingError(Object.assign(new Error("index missing"), { statusCode: 503 })) === false,
  "503 readiness errors say what OUR storage is doing, not what the user typed",
);

check(
  "the existing importRequestError convention is recognised",
  isUserFacingError(Object.assign(new Error("Date order must be DAY_FIRST…"), { statusCode: 400 })),
  "no third marker was invented beside the two already in the codebase",
);

check(
  "userFacingMessage forwards authored copy verbatim",
  userFacingMessage(userFacingError("amountPaid cannot be negative"), "fallback")
    === "amountPaid cannot be negative",
  "the column name is the point — a generic fallback here would erase it",
);

check(
  "userFacingMessage replaces the text of an accident",
  userFacingMessage(new TypeError("Cannot read properties of undefined"), "fallback") === "fallback",
);

check(
  "an authored error with an empty message still yields the fallback",
  userFacingMessage(Object.assign(new Error("   "), { statusCode: 400 }), "fallback") === "fallback",
  "an empty string beside a row number reads as a blank accusation",
);

// ─── 2. Every known user-visible sink is gated ────────────────────
//
// Each entry is a place whose value was PROVED to reach a client, with the proof recorded so the
// claim can be argued with rather than taken on faith.

// `value` deliberately runs PAST the field name: comments explaining each gate sit between the
// anchor and the value, so a pattern that stopped at `message:` would report every gated site as
// ungated. It is the assignment that has to be inspected, not the key.
const VALUE = "[\\s\\S]{0,220}";
// The errorSummary sinks carry a `code:` field AND a three-line explanation between the
// opening brace and the assignment, so they need a wider window than the rest.
const WIDE = "[\\s\\S]{0,520}";

const SINKS = [
  {
    file: "services/import-preview.service.js",
    sink: new RegExp(`code: "INVALID_GSTR3B_SUMMARY",${VALUE}`),
    why: "preview errors[] are returned in a 200 OK body",
  },
  {
    file: "services/tds-normalization.service.js",
    sink: new RegExp(`code: "INVALID_VALUE",${VALUE}`),
    why: "capture() feeds the same preview body",
  },
  {
    file: "services/gst-import.service.js",
    // Anchored on errorSummary rather than on `status: "FAILED"`: four unrelated fields sit
    // between the two, so a window wide enough to span them would also swallow neighbouring
    // objects and report a gate that is not there.
    sink: new RegExp(`errorSummary: \\{${WIDE}message:${VALUE}`),
    why: "errorSummary is serialised back into the batch view",
  },
  {
    file: "services/tds-import.service.js",
    sink: new RegExp(`errorSummary: \\{${WIDE}message:${VALUE}`),
    why: "returned as `failure` on a FAILED batch",
  },
  {
    file: "services/gst-reconciliation.service.js",
    sink: new RegExp(`status: "FAILED",${VALUE}lastError:${VALUE}`),
    why: "read back into the run view as `lastError: run.lastError || \"\"`",
  },
  {
    file: "services/tds-health.service.js",
    sink: new RegExp(`status: "FAILED",${VALUE}lastError: cleanText\\(${VALUE}`),
    why: "read back into the run view as `lastError: run.lastError || \"\"`",
  },
];

for (const { file, sink, why } of SINKS) {
  const source = read(file);
  const matches = source.match(new RegExp(sink.source, "g")) || [];
  const gated = matches.filter((m) => /userFacingMessage/.test(m));
  check(
    `${file}: every user-visible failure sink is gated`,
    matches.length > 0 && gated.length === matches.length,
    matches.length === 0
      ? "SINK NOT FOUND — the code moved; re-point this check rather than deleting it"
      : `${gated.length}/${matches.length} gated (${why})`,
  );
}

// ─── 3. The parsers' authored copy stays tagged ───────────────────
//
// If these throws lose their tag the gates above still hold, but they start replacing messages the
// user genuinely needs — "amountPaid cannot be negative" would become generic copy. That failure
// is silent and user-hostile in the opposite direction, so it gets its own check.

const robust = read("services/robust-normalize.service.js");
const moneyThrows = robust.match(/throw userFacingError\(`\$\{field\}/g) || [];
check(
  "the money parser's field-naming throws stay tagged user-facing",
  moneyThrows.length === 4,
  `${moneyThrows.length}/4 tagged — these name the user's own column`,
);

check(
  "no untagged throw remains in parseFlexibleMoneyMinor",
  !/function parseFlexibleMoneyMinor[\s\S]*?\n\}/.exec(robust)?.[0]?.includes("throw new Error("),
);

const gstNorm = read("services/gst-normalization.service.js");
check(
  "the GSTR-3B authored messages stay tagged",
  (gstNorm.match(/throw userFacingError\(/g) || []).length === 4,
  "the four sentences a firm reads about their own summary",
);

// ─── 4. No new sink slips in unnoticed ────────────────────────────

check(
  "the shared helper is the only marker in use",
  !/isAuthoredUserMessage/.test(read("services/gst-normalization.service.js")),
  "an earlier draft of this fix invented a second flag; one convention only",
);

// ─── Report ───────────────────────────────────────────────────────

let passed = 0;
for (const entry of checks) {
  const mark = entry.pass ? "PASS" : "FAIL";
  if (entry.pass) passed += 1;
  console.log(`[${mark}] ${entry.name}${entry.detail ? ` — ${entry.detail}` : ""}`);
}

const total = checks.length;
console.log(`\nUser-facing error contract: ${passed}/${total}`);

if (passed !== total) {
  console.error(`\n${total - passed} check(s) failed.`);
  process.exit(1);
}
