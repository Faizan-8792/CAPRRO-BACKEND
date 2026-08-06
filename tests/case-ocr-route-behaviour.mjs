// tests/case-ocr-route-behaviour.mjs
//
// Executes POST /api/cases/ocr end to end, in production mode, past authentication,
// firm authorization and the feature-flag gate, and observes the real responses.
//
// This closes the gap that T31 left open. T31 changed user-facing behaviour: nine
// OCR_* codes plus CASE_AI_CONSENT_REQUIRED were added to PUBLIC_ERROR_CODES, and the
// multer fileFilter was given a code so its 415 could stop being genericised. Every
// one of those paths sits behind authentication, so none of it could be verified. The
// evidence was a source assertion and a code reading. That is exactly the situation
// the ledger warns about: "a passing build is not evidence that a feature works".
//
// No database and no network. The narrow set of model reads that the middleware makes
// is stubbed; everything after that is the real router, the real multer instance, the
// real service and the real global error handler.
//
// Deliberately stubbed at the LOWEST level that works: AppConfig.getInstance and
// AppConfig.findById, not getFeatureFlagState. That way the real flag-state, version
// and publication-fence logic executes rather than being replaced by a fixture.
//
// ocr.space is never called. Every case here fails before the provider request, and
// OCR_SPACE_API_KEY is explicitly cleared so the last one fails at the key check.

import mongoose from "mongoose";
import jwt from "jsonwebtoken";

mongoose.set("bufferTimeoutMS", 50);

process.env.NODE_ENV = "production";
process.env.JWT_SECRET = process.env.JWT_SECRET || "local-verification-only";
process.env.MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/capro-ocr-behaviour";
// Cleared so the provider branch is reached and refused without any outbound call.
delete process.env.OCR_SPACE_API_KEY;

const USER_ID = "6512ab00ab00ab00ab00ab01";
const FIRM_ID = "6512ab00ab00ab00ab00ab02";

const { default: User } = await import("../src/models/User.js");
const { default: Firm } = await import("../src/models/Firm.js");
const { default: FirmMembership } = await import("../src/models/FirmMembership.js");
const { default: AppConfig } = await import("../src/models/AppConfig.js");

// ─── The smallest stub surface that reaches the route ───────────────

function chain(value) {
  const api = {
    select: () => api,
    lean: async () => value,
    session: () => api,
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  };
  return api;
}

const state = {
  flagEnabled: true,
  membershipStatus: "ACTIVE",
  membershipRole: "MEMBER",
  memberAccess: "EDIT",
  userActive: true,
};

User.findById = () =>
  chain({
    _id: USER_ID,
    email: "reviewer@example.invalid",
    role: "USER",
    accountType: "FIRM",
    firmId: FIRM_ID,
    isActive: state.userActive,
    tokenVersion: 0,
  });

Firm.findOne = () =>
  chain({
    _id: FIRM_ID,
    ownerUserId: "6512ab00ab00ab00ab00ab09",
    kind: "SHARED",
    memberAccess: state.memberAccess,
    isActive: true,
  });

FirmMembership.findOne = () =>
  chain({ role: state.membershipRole, status: state.membershipStatus });

function appConfigDocument() {
  return {
    maintenanceMode: false,
    featureFlags: { noticeCases: state.flagEnabled },
    featureFlagVersions: { noticeCases: 3 },
    featureFlagPublicationFences: { noticeCases: "" },
  };
}

AppConfig.getInstance = async () => appConfigDocument();
AppConfig.findById = () => chain(appConfigDocument());

const { default: app } = await import("../src/app.js");

const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const ROUTE = "/api/cases/ocr";

const token = jwt.sign({ id: USER_ID, tv: 0 }, process.env.JWT_SECRET);

const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass, detail });

// A tiny but structurally plausible PDF. Never parsed here: every case fails before
// the provider, so the bytes only have to satisfy multer's declared MIME type.
const PDF_BYTES = new TextEncoder().encode("%PDF-1.4\n%%EOF\n");

async function postOcr({ mimeType, fileName, consent, includeFile = true }) {
  const form = new FormData();
  if (includeFile) {
    form.append("file", new Blob([PDF_BYTES], { type: mimeType }), fileName);
  }
  if (consent !== undefined) form.append("consent", String(consent));

  const response = await fetch(base + ROUTE, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

// ─── The harness actually reaches the route ─────────────────────────

const reached = await postOcr({
  mimeType: "application/pdf",
  fileName: "notice.pdf",
  consent: true,
});

check(
  "the request reaches the OCR handler past auth, firm authorization and the flag gate",
  reached.status !== 401 && reached.status !== 403 && reached.status !== 404,
  `status ${reached.status} — a 401/403/404 here would mean every assertion below is meaningless`
);

// ─── The provider branch is reached and refused without a network call ──

check(
  "an unconfigured provider is refused with 503 OCR_PROVIDER_UNAVAILABLE",
  reached.status === 503 && reached.json?.code === "OCR_PROVIDER_UNAVAILABLE",
  `status ${reached.status}, code ${reached.json?.code}`
);

check(
  "that 503 message reaches the user verbatim instead of being genericised",
  reached.json?.error === "OCR provider is not configured",
  `error: ${JSON.stringify(reached.json?.error)}`
);

// ─── THE T31 FIX, EXECUTED ──────────────────────────────────────────
// Before T31 this answered the catch-all "The request could not be completed. Review
// the information and try again." because the multer fileFilter error carried no code
// at all, so no allow-list entry could have helped it.

const wrongType = await postOcr({
  mimeType: "text/plain",
  fileName: "notice.txt",
  consent: true,
});

check(
  "an unsupported file type is refused with 415",
  wrongType.status === 415,
  `status ${wrongType.status}`
);

check(
  "the 415 now names the accepted types instead of the old catch-all",
  wrongType.json?.error === "OCR accepts PDF, PNG, or JPEG files only",
  `error: ${JSON.stringify(wrongType.json?.error)}`
);

check(
  "the 415 carries OCR_TYPE_UNSUPPORTED on the wire",
  wrongType.json?.code === "OCR_TYPE_UNSUPPORTED",
  `code ${wrongType.json?.code} — proves the fileFilter code reaches the allow-list`
);

check(
  "the 415 is NOT the pre-T31 catch-all message",
  wrongType.json?.error !==
    "The request could not be completed. Review the information and try again.",
  "this exact string was the production behaviour before T31"
);

// ─── The consent gate, executed ─────────────────────────────────────
// Before T31 a missing consent read "Some submitted information could not be accepted.
// Review the form and try again." -- misleading, because there is no form field to
// correct: the requirement is consent to send a client's notice to a third party.

const noConsent = await postOcr({
  mimeType: "application/pdf",
  fileName: "notice.pdf",
});

check(
  "a missing consent is refused with 400",
  noConsent.status === 400,
  `status ${noConsent.status}`
);

check(
  "the consent refusal explains the third-party transfer instead of blaming the form",
  noConsent.json?.error ===
    "Explicit consent is required before sending a file to OCR.space",
  `error: ${JSON.stringify(noConsent.json?.error)}`
);

check(
  "the consent refusal carries OCR_CONSENT_REQUIRED on the wire",
  noConsent.json?.code === "OCR_CONSENT_REQUIRED",
  `code ${noConsent.json?.code}`
);

check(
  "the consent refusal is NOT the pre-T31 generic form message",
  noConsent.json?.error !==
    "Some submitted information could not be accepted. Review the form and try again.",
  "this exact string was the production behaviour before T31"
);

const falseConsent = await postOcr({
  mimeType: "application/pdf",
  fileName: "notice.pdf",
  consent: false,
});

check(
  "consent=false is refused the same way as an absent consent",
  falseConsent.status === 400 && falseConsent.json?.code === "OCR_CONSENT_REQUIRED",
  `status ${falseConsent.status}, code ${falseConsent.json?.code}`
);

// ─── Consent is checked before the file is examined ─────────────────

const noFile = await postOcr({ includeFile: false, consent: true });

check(
  "a request with consent but no file is refused with OCR_FILE_REQUIRED",
  noFile.status === 400 && noFile.json?.code === "OCR_FILE_REQUIRED",
  `status ${noFile.status}, code ${noFile.json?.code}`
);

check(
  "that message reaches the user verbatim",
  noFile.json?.error === "OCR file is required",
  `error: ${JSON.stringify(noFile.json?.error)}`
);

// ─── Every public OCR envelope obeys the copy rules ─────────────────

const FORBIDDEN_COPY = /\bHTTP\b|\bnull\b|\bexception\b|\b(?:400|401|403|413|415|422|429|500|502|503|504)\b/i;
const observed = [reached, wrongType, noConsent, falseConsent, noFile];

check(
  "no observed OCR message contains HTTP, null, exception or a bare status number",
  observed.every((result) => !FORBIDDEN_COPY.test(String(result.json?.error || ""))),
  observed.map((r) => r.json?.code || "?").join(", ")
);

check(
  "every observed OCR error carries a category and a requestId",
  observed.every(
    (result) =>
      typeof result.json?.category === "string" &&
      typeof result.json?.requestId === "string" &&
      result.json.requestId.length > 0
  ),
  "unlike the Content-Type guard, these go through the global error handler"
);

// ─── The read-only member asymmetry, executed ───────────────────────
// POST /ocr omits requireFirmWriteAccess while the other fifteen case routes require
// it, so a read-only member can run OCR. Pinned by tests/notice-case-contract.mjs at
// source; this executes it. Raised for a human decision, not changed.

state.memberAccess = "READ_ONLY";
const readOnly = await postOcr({
  mimeType: "application/pdf",
  fileName: "notice.pdf",
});
state.memberAccess = "EDIT";

check(
  "a read-only firm member still reaches the OCR handler",
  readOnly.status === 400 && readOnly.json?.code === "OCR_CONSENT_REQUIRED",
  `status ${readOnly.status}, code ${readOnly.json?.code} — reached the consent gate, so authorization admitted them`
);

// ─── A removed member is refused ────────────────────────────────────

state.membershipStatus = "REMOVED";
const removedMember = await postOcr({
  mimeType: "application/pdf",
  fileName: "notice.pdf",
  consent: true,
});
state.membershipStatus = "ACTIVE";

check(
  "a REMOVED member is refused with 403 before reaching OCR",
  removedMember.status === 403,
  `status ${removedMember.status}, error ${JSON.stringify(removedMember.json?.error)}`
);

// ─── Flag off is a 404, not a 403 ───────────────────────────────────
// This corrected a documentation error. docs/notices-cases-contract.md said a firm
// without the flag gets a 403; requireFeatureFlag returns 404 "Feature unavailable"
// with the flag name attached. Conflating the two matters: the desktop learned under
// T25a that a 404 worded as "this run no longer exists" is wrong for a firm that
// simply does not have the module switched on.

state.flagEnabled = false;
const flagOff = await postOcr({
  mimeType: "application/pdf",
  fileName: "notice.pdf",
  consent: true,
});
state.flagEnabled = true;

check(
  "a firm without the noticeCases flag gets 404, NOT 403",
  flagOff.status === 404,
  `status ${flagOff.status} — 403 would be a permission problem, which this is not`
);

check(
  "the flag refusal names the flag so a client can word it as 'not switched on'",
  flagOff.json?.featureFlag === "noticeCases" &&
    flagOff.json?.error === "Feature unavailable",
  `featureFlag ${flagOff.json?.featureFlag}, error ${JSON.stringify(flagOff.json?.error)}`
);

// ─── An unauthenticated call is still refused ───────────────────────

const anonymous = await fetch(base + ROUTE, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
});

check(
  "the route is still closed to unauthenticated callers",
  anonymous.status === 401,
  `status ${anonymous.status} — the stubs must not have opened the route up`
);

// ─── Report ───────────────────────────────────────────────────────

server.close();

let passed = 0;
for (const entry of checks) {
  const mark = entry.pass ? "PASS" : "FAIL";
  if (entry.pass) passed += 1;
  console.log(`[${mark}] ${entry.name}${entry.detail ? ` — ${entry.detail}` : ""}`);
}

const total = checks.length;
console.log(`\nCase OCR route behaviour: ${passed}/${total}`);

if (passed !== total) {
  console.error(`\n${total - passed} check(s) failed.`);
  process.exit(1);
}
