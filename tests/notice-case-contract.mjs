// tests/notice-case-contract.mjs
// Pins the Notices and Cases HTTP contract that the desktop client depends on,
// with the OCR and file-intake half first because that is the part a client
// cannot safely infer.
//
// Why this file exists. Every OCR failure code was missing from
// PUBLIC_ERROR_CODES in src/app.js, so production replaced all of them with a
// generic message: a missing consent read "Some submitted information could not
// be accepted. Review the form and try again." when there is no form field to
// correct, and an unsupported file type fell through to the catch-all and never
// told the user that only PDF, PNG and JPEG are accepted. Nothing anywhere in
// tests/ referenced PUBLIC_ERROR_CODES, so the omission was invisible. These
// assertions make a new OCR code impossible to add silently.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKEND = join(__dirname, "..");

const app = readFileSync(join(BACKEND, "src", "app.js"), "utf8");
const routes = readFileSync(
  join(BACKEND, "src", "routes", "case.routes.js"),
  "utf8",
);
const controller = readFileSync(
  join(BACKEND, "src", "controllers", "case.controller.js"),
  "utf8",
);
const ocr = readFileSync(
  join(BACKEND, "src", "services", "ocr-space.service.js"),
  "utf8",
);
const validation = readFileSync(
  join(BACKEND, "src", "services", "case-validation.service.js"),
  "utf8",
);

const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass, detail });

// ─── Parsing helpers ───────────────────────────────────────────────
// These must be conservative: a parse that silently returns nothing would make
// every "is a member of" assertion below pass for the wrong reason. Each
// extraction is therefore asserted to be non-empty and of an expected size.

function stripLineComments(source) {
  return source
    .split("\n")
    .map((line) => {
      const marker = line.indexOf("//");
      return marker === -1 ? line : line.slice(0, marker);
    })
    .join("\n");
}

function extractSetLiterals(source, declaration) {
  const start = source.indexOf(declaration);
  if (start === -1) return null;
  const end = source.indexOf("]);", start);
  if (end === -1) return null;
  // Comments inside this block quote user-facing sentences, which are themselves
  // double-quoted. Without stripping them first those sentences parse as codes.
  const body = stripLineComments(source.slice(start + declaration.length, end));
  return [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

const publicErrorCodes = extractSetLiterals(
  app,
  "const PUBLIC_ERROR_CODES = new Set([",
);

// httpError(status, message, code) — message is double-quoted or a template literal.
const HTTP_ERROR_CALL =
  /httpError\(\s*(\d{3})\s*,\s*(?:"([^"]*)"|`([^`]*)`)\s*,\s*"([A-Z0-9_]+)"\s*\)/g;

const ocrThrows = [...ocr.matchAll(HTTP_ERROR_CALL)].map((match) => ({
  status: Number(match[1]),
  message: match[2] ?? match[3] ?? "",
  code: match[4],
}));

const ocrCodes = [...new Set(ocrThrows.map((entry) => entry.code))].sort();

// ─── The parse is sound ────────────────────────────────────────────

check(
  "PUBLIC_ERROR_CODES parsed from src/app.js",
  Array.isArray(publicErrorCodes) && publicErrorCodes.length >= 20,
  `parsed ${publicErrorCodes ? publicErrorCodes.length : 0} codes`,
);

check(
  "PUBLIC_ERROR_CODES parse stripped comment prose",
  Array.isArray(publicErrorCodes) &&
    publicErrorCodes.every((code) => /^[A-Z0-9_]+$/.test(code)),
  "every parsed entry is an UPPER_SNAKE code, so no quoted sentence from a comment leaked in",
);

check(
  "negative control: parse discriminates membership",
  Array.isArray(publicErrorCodes) &&
    !publicErrorCodes.includes("OCR_DEFINITELY_NOT_A_REAL_CODE"),
  "an invented code is absent, so the membership assertions below are not vacuously true",
);

check(
  "OCR failure codes extracted from ocr-space.service.js",
  ocrCodes.length === 10,
  `found ${ocrCodes.length}: ${ocrCodes.join(", ")}`,
);

// ─── The rule: every reachable OCR code is public, with one named exception ──

const OCR_MESSAGE_EMBEDS_HTTP = "OCR_PROVIDER_ERROR";

const missingFromPublic = ocrCodes.filter(
  (code) =>
    code !== OCR_MESSAGE_EMBEDS_HTTP && !publicErrorCodes.includes(code),
);

check(
  "every OCR code is public except the one whose message embeds a status line",
  missingFromPublic.length === 0,
  missingFromPublic.length
    ? `not public, so production would genericise these: ${missingFromPublic.join(", ")}`
    : `all ${ocrCodes.length - 1} reachable OCR codes are public`,
);

check(
  `${OCR_MESSAGE_EMBEDS_HTTP} is deliberately NOT public`,
  !publicErrorCodes.includes(OCR_MESSAGE_EMBEDS_HTTP),
  "its message interpolates the provider status, and no user-facing string may contain HTTP",
);

check(
  `${OCR_MESSAGE_EMBEDS_HTTP} still has the message that justifies excluding it`,
  ocrThrows.some(
    (entry) =>
      entry.code === OCR_MESSAGE_EMBEDS_HTTP && /\bHTTP\b/.test(entry.message),
  ),
  "if this message is ever rewritten without HTTP, make the code public and update this test",
);

// A public code returns err.message verbatim to the user (src/app.js
// publicErrorMessage: `if (publicCode && err?.message) return err.message`), so
// each public message must satisfy the user-facing copy rules directly.
const FORBIDDEN_IN_PUBLIC_COPY =
  /\bHTTP\b|\bnull\b|\bexception\b|\b(?:401|403|429)\b/i;

const leakyPublicMessages = ocrThrows.filter(
  (entry) =>
    publicErrorCodes.includes(entry.code) &&
    FORBIDDEN_IN_PUBLIC_COPY.test(entry.message),
);

check(
  "no public OCR message contains HTTP, null, exception, or a bare status code",
  leakyPublicMessages.length === 0,
  leakyPublicMessages.length
    ? leakyPublicMessages
        .map((entry) => `${entry.code}: ${entry.message}`)
        .join(" | ")
    : "all public OCR messages are safe to show verbatim",
);

// ─── Every third-party consent gate must be public ─────────────────
// Three gates exist for sending client data to an external provider. All three
// tell the user something no generic 400 can convey, because there is no form
// field to correct -- the requirement is consent to data egress. One was public
// and two were not, which is how the OCR family was found.

const consentCodes = [
  "AUDIT_AI_CONSENT_REQUIRED",
  "OCR_CONSENT_REQUIRED",
  "CASE_AI_CONSENT_REQUIRED",
];

const nonPublicConsentGates = consentCodes.filter(
  (code) => !publicErrorCodes.includes(code),
);

check(
  "every third-party data-egress consent gate is public",
  nonPublicConsentGates.length === 0,
  nonPublicConsentGates.length
    ? `genericised, so the user is told to review a form instead: ${nonPublicConsentGates.join(", ")}`
    : `all ${consentCodes.length} consent gates return their own message`,
);

// Codes intentionally left non-public because their wording is engineer-facing.
// Pinned so that "make it public" is a deliberate act accompanied by new copy,
// and so the list cannot quietly grow.
const DEFERRED_CASE_CODES = [
  "CASE_NOT_FOUND",
  "INVALID_CASE_CURSOR",
  "INVALID_CASE_SNAPSHOT",
  "CASE_REPLAY_TARGET_MISSING",
];

const unexpectedlyPublic = DEFERRED_CASE_CODES.filter((code) =>
  publicErrorCodes.includes(code),
);

check(
  "engineer-facing CASE_* codes are still deferred, not silently exposed",
  unexpectedlyPublic.length === 0,
  unexpectedlyPublic.length
    ? `now public without new copy: ${unexpectedlyPublic.join(", ")} — rewrite the messages first`
    : "their messages name cursors and snapshots, which mean nothing to a reviewer",
);

// ─── The multer fileFilter rejection must carry a code ─────────────
// multer 2.2.0 passes a fileFilter error through unwrapped (make-middleware.js
// abortWithError -> next(err)), so it arrives as a plain Error. Without a code
// the global handler cannot treat its message as public, and because this filter
// runs before the controller the identical check inside ocr-space.service.js is
// unreachable over HTTP. The code has to be set at the filter.

check(
  "multer fileFilter rejection carries code OCR_TYPE_UNSUPPORTED",
  /statusCode\s*=\s*415/.test(routes) &&
    /error\.code\s*=\s*"OCR_TYPE_UNSUPPORTED"/.test(routes),
  "otherwise an unsupported file type answers the catch-all and never names the accepted types",
);

check(
  "OCR_TYPE_UNSUPPORTED is public, so the fileFilter message reaches the user",
  publicErrorCodes.includes("OCR_TYPE_UNSUPPORTED"),
  "the filter message names PDF, PNG and JPEG",
);

// ─── Intake bounds ─────────────────────────────────────────────────

check(
  "OCR size ceiling is 8 MiB",
  /OCR_MAX_BYTES\s*=\s*8\s*\*\s*1024\s*\*\s*1024/.test(ocr),
  "the desktop must refuse a larger file before uploading it",
);

check(
  "OCR accepts exactly PDF, PNG and JPEG",
  /OCR_MIME_TYPES\s*=\s*new Set\(\[\s*"application\/pdf",\s*"image\/png",\s*"image\/jpeg"\s*\]\)/.test(
    ocr,
  ),
  "three types, no more",
);

check(
  "multer limits bound size, file count and field count",
  /limits:\s*\{\s*fileSize:\s*OCR_MAX_BYTES,\s*files:\s*1,\s*fields:\s*5\s*\}/.test(
    routes,
  ),
  "one file, five text fields, size shared with the service ceiling",
);

check(
  "upload reads the single field named file",
  /upload\.single\("file"\)/.test(routes),
  "any other field name yields MulterError LIMIT_UNEXPECTED_FILE and a 400",
);

check(
  "OCR stores no binary",
  /binaryStored:\s*false/.test(ocr),
  "the uploaded bytes are never persisted, so the client must not imply they were",
);

check(
  "consent is required before any file leaves for the provider",
  /consent\s*!==\s*true/.test(ocr) && /"OCR_CONSENT_REQUIRED"/.test(ocr),
  "the file is sent to a third party, so this gate is a data-egress consent, not a form field",
);

check(
  "consent is checked before the buffer, size, type and provider key",
  ocr.indexOf('"OCR_CONSENT_REQUIRED"') < ocr.indexOf('"OCR_FILE_REQUIRED"') &&
    ocr.indexOf('"OCR_FILE_REQUIRED"') <
      ocr.indexOf('"OCR_PROVIDER_UNAVAILABLE"'),
  "so a request lacking consent reports consent, not a file problem",
);

check(
  "provider filename is bounded and defaulted",
  /String\(fileName \|\| "notice-file"\)\.slice\(0, 240\)/.test(ocr),
  "an absent or oversized upload filename cannot reach the provider unbounded",
);

// ─── The Content-Type guard exempts exactly one path ───────────────

check(
  "multipart is permitted only on the exact path /api/cases/ocr",
  /req\.path === "\/api\/cases\/ocr" && ct\.includes\("multipart\/form-data"\)/.test(
    app,
  ),
  "an exact match, so /api/cases/ocr/ with a trailing slash is refused by the guard",
);

check(
  "the guard's 415 is emitted directly, without the error handler's envelope",
  /Unsupported Media Type/.test(app) &&
    !/Unsupported Media Type[\s\S]{0,200}category:/.test(app),
  "this one response has no category and no requestId, so a client error reader must tolerate their absence",
);

// ─── Authorization shape of the route table ────────────────────────

// Matched by regex, not by an indexOf on a literal containing "\n": this file is
// CRLF, so a literal newline match silently fails and leaves ocrChain empty --
// which would make the negative assertion below pass vacuously.
const ocrRouteMatch = /router\.post\(\s*"\/ocr"/.exec(routes);
const ocrRouteIndex = ocrRouteMatch ? ocrRouteMatch.index : -1;
const routerUseIndex = routes.indexOf("router.use(");

check(
  "POST /ocr is declared before the shared router.use guard",
  ocrRouteIndex !== -1 &&
    routerUseIndex !== -1 &&
    ocrRouteIndex < routerUseIndex,
  "so it does not inherit that chain and must list its own middleware",
);

const ocrChain =
  ocrRouteIndex === -1 || routerUseIndex <= ocrRouteIndex
    ? ""
    : routes.slice(ocrRouteIndex, routerUseIndex);

check(
  "the POST /ocr middleware chain was located",
  ocrChain.length > 0,
  `extracted ${ocrChain.length} characters; the two assertions below are meaningless if this is empty`,
);

check(
  "POST /ocr requires authentication, firm membership and the noticeCases flag",
  /authRequiredWithoutUsageTracking/.test(ocrChain) &&
    /requireFirmMember/.test(ocrChain) &&
    /requireFeatureFlag\("noticeCases"\)/.test(ocrChain),
  "it is not an unauthenticated route",
);

// Pinned, not changed. POST /ocr omits requireFirmWriteAccess while all fifteen
// other case routes require it, so a read-only firm member can run OCR. It is a
// zero-write preview, which is an argument for allowing it, but it also sends a
// client's notice to a third party. Changing a server authorization rule is a
// policy decision for the human, so this test records the current rule and will
// fail if it moves either way without that decision being taken.
check(
  "POST /ocr does NOT require write access (pinned asymmetry, awaiting a decision)",
  ocrChain.length > 0 &&
    !/requireFirmWriteAccess/.test(ocrChain) &&
    /requireFirmWriteAccess/.test(routes),
  "read-only members can preview OCR; every other case route requires write access",
);

const routeCount = [
  ...routes.matchAll(/router\.(post|get|patch|put|delete)\(/g),
].length;

// T103/B11 added GET /:id/references (17th), on top of an already-stale 16 this
// check had drifted to before that. Recounted directly from case.routes.js
// rather than carried forward from the ledger or coordination board, which this
// check's own failure message shows had drifted first.
check(
  "the case router exposes 17 handlers",
  routeCount === 17,
  `counted ${routeCount}`,
);

// ─── Never claim an automatic filing ──────────────────────────────

check(
  "recording a submission states that nothing was filed",
  /automaticSubmissionPerformed:\s*false/.test(controller),
  "PLAN.md forbids the product from filing returns; the response says so explicitly",
);

check(
  "the OCR preview declares itself zero-write",
  /zeroWrite:\s*true/.test(controller),
  "a preview must not imply anything was saved",
);

// ─── Money and idempotency, which the desktop must model exactly ──

check(
  "money fields are validated as non-negative safe integers in minor units",
  /Number\.isSafeInteger\(amount\)\s*\|\|\s*amount\s*<\s*0/.test(validation) &&
    /AMOUNT_FIELDS\s*=\s*new Set\(\["demandMinor", "disputedMinor"\]\)/.test(
      validation,
    ),
  "safe-integer, not int32, so demandMinor can exceed 2,147,483,647 paise and must be read as 64-bit",
);

check(
  "mutationKey reuse with a different payload is a 409",
  /"MUTATION_KEY_REUSED"/.test(validation) && /409/.test(validation),
  "the idempotency token is compared by request hash, so a retry must resend an identical body",
);

check(
  "mutationKey and reuse codes are public",
  publicErrorCodes.includes("INVALID_MUTATION_KEY") &&
    publicErrorCodes.includes("MUTATION_KEY_REUSED"),
  "both already public, unlike the OCR family",
);

check(
  "pagination defaults to 25 and clamps at 100",
  /defaultLimit = 25, maxLimit = 100/.test(validation),
  "differs from the GST surface, which clamps at 50",
);

// ─── Report ───────────────────────────────────────────────────────

let passed = 0;
for (const entry of checks) {
  const mark = entry.pass ? "PASS" : "FAIL";
  if (entry.pass) passed += 1;
  console.log(
    `[${mark}] ${entry.name}${entry.detail ? ` — ${entry.detail}` : ""}`,
  );
}

const total = checks.length;
console.log(`\nNotices and Cases contract: ${passed}/${total}`);

if (passed !== total) {
  console.error(`\n${total - passed} check(s) failed.`);
  process.exit(1);
}
