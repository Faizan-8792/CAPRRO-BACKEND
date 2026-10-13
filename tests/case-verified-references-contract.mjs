// tests/case-verified-references-contract.mjs
//
// Ledger task T103 (board item B11). addVerifiedReference already stores each reference in
// CaseMatter.verifiedReferences (capped at 100), but nothing read it back: POST /:id/references's
// own response was the only copy of a reference's id that would ever exist, so a draft citing it
// later (via referenceIds) had no list to pick from.
//
// This test proves three things directly against the service layer, without re-testing
// addVerifiedReference itself (already covered elsewhere and untouched by this change):
//   1. getCaseDetail's case payload carries verifiedReferences (it always did - no projection
//      excluded it - but nothing consumed it, which is the desktop-side half of B11).
//   2. listCaseMatters' list payload does NOT carry verifiedReferences (newly excluded, to keep
//      the list projection lean, matching the two other detail-only fields already excluded
//      there: extractionProposals, confirmationEvidence).
//   3. The new listVerifiedReferences (GET /:id/references) returns exactly the case's
//      references, independent of the rest of the detail payload.
//
// Monkey-patches CaseMatter/CaseTimelineEvent/CaseAnalysis/CaseDraft/CaseSubmission statics,
// matching the pattern already used for directly-imported Mongoose models elsewhere in this
// suite (tests/terms-acceptance-contract.mjs, tests/task-version-guard-contract.mjs).

import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV || "development";
process.env.JWT_SECRET = process.env.JWT_SECRET || "local-verification-only";
process.env.MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/capro-case-references-check";

const { default: CaseMatter } = await import("../src/models/CaseMatter.js");
const { default: CaseTimelineEvent } = await import("../src/models/CaseTimelineEvent.js");
const { default: CaseAnalysis } = await import("../src/models/CaseAnalysis.js");
const { default: CaseDraft } = await import("../src/models/CaseDraft.js");
const { default: CaseSubmission } = await import("../src/models/CaseSubmission.js");
const { getCaseDetail, listCaseMatters, listVerifiedReferences } = await import(
  "../src/services/case-record.service.js"
);

const originals = {
  findOne: CaseMatter.findOne,
  find: CaseMatter.find,
  countDocuments: CaseMatter.countDocuments,
  timelineFind: CaseTimelineEvent.find,
  analysisFind: CaseAnalysis.find,
  draftFind: CaseDraft.find,
  submissionFind: CaseSubmission.find,
};

const FIRM_1 = "670aaa11bb22cc33dd44ee01";
const CASE_1 = "670aaa11bb22cc33dd44ee55";
const USER_1 = "670aaa11bb22cc33dd44ee11";

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  return fn()
    .then(() => {
      passed++;
    })
    .catch((error) => {
      failed++;
      failures.push(`${name}: ${error.message}`);
    });
}

function threeReferences() {
  return [
    {
      _id: "670aaa11bb22cc33dd44ea01",
      sourceType: "USER_VERIFIED",
      title: "Section 148 notice, para 3",
      locator: "Notice PDF, page 2",
      excerpt: "",
      verifiedBy: USER_1,
      verifiedAt: new Date("2026-08-01T10:00:00.000Z"),
    },
    {
      _id: "670aaa11bb22cc33dd44ea02",
      sourceType: "USER_VERIFIED",
      title: "CBDT circular 4/2026",
      locator: "",
      excerpt: "Assessees may file a rectification within thirty days.",
      verifiedBy: USER_1,
      verifiedAt: new Date("2026-08-01T10:05:00.000Z"),
    },
    {
      _id: "670aaa11bb22cc33dd44ea03",
      sourceType: "USER_VERIFIED",
      title: "Prior year assessment order",
      locator: "AO order dated 2025-03-15",
      excerpt: "",
      verifiedBy: USER_1,
      verifiedAt: new Date("2026-08-01T10:10:00.000Z"),
    },
  ];
}

function caseFixture(overrides = {}) {
  return {
    _id: CASE_1,
    firmId: FIRM_1,
    caseType: "INCOME_TAX_NOTICE",
    title: "AY 2025-26 scrutiny notice",
    status: "IN_PROGRESS",
    extractionStatus: "CONFIRMED",
    confirmedFacts: {},
    extractionProposals: [],
    confirmationEvidence: [],
    verifiedReferences: threeReferences(),
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T10:10:00.000Z"),
    revision: 4,
    ...overrides,
  };
}

// A chainable stand-in that supports .populate/.select/.sort/.limit/.lean in any order, matching
// the different chains getCaseDetail and listCaseMatters each build.
function chainable(result) {
  const api = {
    populate: () => api,
    select: () => api,
    sort: () => api,
    limit: () => api,
    session: () => api,
    lean: async () => result,
  };
  return api;
}

function stubEmptyHistoryCollections() {
  CaseTimelineEvent.find = () => chainable([]);
  CaseAnalysis.find = () => chainable([]);
  CaseDraft.find = () => chainable([]);
  CaseSubmission.find = () => chainable([]);
}

await test("getCaseDetail's case payload carries verifiedReferences with stable ids", async () => {
  const fixture = caseFixture();
  CaseMatter.findOne = () => chainable(fixture);
  stubEmptyHistoryCollections();

  const detail = await getCaseDetail({ caseId: CASE_1, firmId: FIRM_1, query: {} });

  assert.ok(Array.isArray(detail.case.verifiedReferences), "detail.case must carry verifiedReferences");
  assert.equal(detail.case.verifiedReferences.length, 3);
  assert.deepEqual(
    detail.case.verifiedReferences.map((reference) => String(reference._id)),
    ["670aaa11bb22cc33dd44ea01", "670aaa11bb22cc33dd44ea02", "670aaa11bb22cc33dd44ea03"],
  );
});

await test("listCaseMatters' list payload does not carry verifiedReferences (kept lean)", async () => {
  let selectedFields = "";
  CaseMatter.find = () => {
    const api = {
      select(fields) {
        selectedFields = fields;
        return api;
      },
      populate: () => api,
      sort: () => api,
      limit: () => api,
      lean: async () => [
        // A lean() result with the field physically absent, as Mongoose's own projection would
        // produce - the assertion that matters is on the .select() argument below, this just
        // confirms the handler does not separately re-add it.
        (() => {
          const { verifiedReferences, ...rest } = caseFixture();
          return rest;
        })(),
      ],
    };
    return api;
  };
  CaseMatter.countDocuments = async () => 1;

  const result = await listCaseMatters({ firmId: FIRM_1, query: {} });

  assert.match(selectedFields, /-verifiedReferences\b/, "the list projection must exclude verifiedReferences");
  assert.equal(result.cases.length, 1);
  assert.equal(
    Object.hasOwn(result.cases[0], "verifiedReferences"),
    false,
    "a list item must not carry the reference list",
  );
});

await test("listVerifiedReferences (GET /:id/references) returns exactly the case's references", async () => {
  const fixture = caseFixture();
  CaseMatter.findOne = () => chainable(fixture);

  const references = await listVerifiedReferences({ caseId: CASE_1, firmId: FIRM_1 });

  assert.equal(references.length, 3);
  assert.deepEqual(
    references.map((reference) => reference.title),
    [
      "Section 148 notice, para 3",
      "CBDT circular 4/2026",
      "Prior year assessment order",
    ],
  );
});

await test("listVerifiedReferences on a case with none returns an empty array, not null/undefined", async () => {
  const fixture = caseFixture({ verifiedReferences: [] });
  CaseMatter.findOne = () => chainable(fixture);

  const references = await listVerifiedReferences({ caseId: CASE_1, firmId: FIRM_1 });

  assert.deepEqual(references, []);
});

await test("listVerifiedReferences 404s through the same firm-scoped lookup as every other case route", async () => {
  CaseMatter.findOne = () => chainable(null);

  await assert.rejects(
    () => listVerifiedReferences({ caseId: CASE_1, firmId: FIRM_1 }),
    (error) => {
      assert.equal(error.statusCode, 404);
      assert.equal(error.code, "CASE_NOT_FOUND");
      return true;
    },
  );
});

CaseMatter.findOne = originals.findOne;
CaseMatter.find = originals.find;
CaseMatter.countDocuments = originals.countDocuments;
CaseTimelineEvent.find = originals.timelineFind;
CaseAnalysis.find = originals.analysisFind;
CaseDraft.find = originals.draftFind;
CaseSubmission.find = originals.submissionFind;

console.log(`case verified-references contract: ${passed}/${passed + failed} passed`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  FAIL ${failure}`);
  process.exit(1);
}
