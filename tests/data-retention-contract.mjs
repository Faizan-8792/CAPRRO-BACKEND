// tests/data-retention-contract.mjs
//
// Verifies the retention policy decided in PLAN.md section 33: that the 30-day
// purge removes what it is supposed to, refuses to touch anything else, and above
// all leaves a firm's work product and the provenance of its findings intact.
//
// The point of this suite is the negative assertions. A purge that deletes the
// right rows is easy; one that cannot be talked into deleting an evidence row even
// when a caller asks it to is the property that matters, because the failure mode
// is a chartered accountant losing audit evidence with no undo.
//
// No MongoDB. Models are stubbed with the query-builder shape the service actually
// uses (find().select().limit().lean()), so a change to how the service queries
// breaks these tests rather than silently passing.

import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

process.env.NODE_ENV = process.env.NODE_ENV || "development";
process.env.JWT_SECRET = process.env.JWT_SECRET || "local-verification-only";
process.env.MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/capro-retention-check";

const {
  RETENTION_WINDOW_DAYS,
  RETENTION_WINDOW_MS,
  RETENTION_BATCH_LIMIT,
  RETENTION_CLASSES,
  RETENTION_CLASSIFICATION,
  RETENTION_SKIPS,
  classifyCollection,
  isPurgeable,
  assertPurgeable,
  assertClassificationCoversModels,
  retentionCutoff,
  purgeExpiredCaseSourceText,
  purgeExpiredWorkingPaperAnalyses,
  runRetentionPurge,
  describeRetentionPolicy,
} = await import("../src/services/data-retention.service.js");

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      throw new Error("use testAsync for async cases");
    }
    passed++;
  } catch (error) {
    failed++;
    failures.push(`${name}: ${error.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
  } catch (error) {
    failed++;
    failures.push(`${name}: ${error.message}`);
  }
}

const NOW = new Date("2026-08-13T10:00:00.000Z");
const OLD = new Date(NOW.getTime() - 31 * 24 * 60 * 60 * 1000);
const RECENT = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000);

// A stub shaped like the mongoose query chain the service uses. Records every
// filter it was given so a test can assert on what the service asked for, not
// only on what it did with the answer.
function makeFindStub(rows, log, label) {
  return (filter) => {
    log.push({ op: `${label}.find`, filter });
    const chain = {
      select() {
        return chain;
      },
      limit(n) {
        chain._limit = n;
        return chain;
      },
      lean: async () => (chain._limit ? rows.slice(0, chain._limit) : rows),
    };
    return chain;
  };
}

// ---------------------------------------------------------------- window & cutoff

test("retention window is 30 days", () => {
  assert.equal(RETENTION_WINDOW_DAYS, 30);
  assert.equal(RETENTION_WINDOW_MS, 30 * 24 * 60 * 60 * 1000);
});

test("cutoff is measured back from now, so it tracks storage time not access", () => {
  const cutoff = retentionCutoff(NOW);
  assert.equal(cutoff.toISOString(), "2026-07-14T10:00:00.000Z");
  assert.equal(NOW.getTime() - cutoff.getTime(), RETENTION_WINDOW_MS);
});

test("an invalid now is refused rather than silently treated as epoch", () => {
  assert.throws(
    () => retentionCutoff("not-a-date"),
    /RETENTION_INVALID_NOW|not a valid date/,
  );
});

// -------------------------------------------------------------- classification

test("all 39 models are classified", () => {
  // 38 -> 39: L12 added ErasureReceipt.js, the record of a completed erasure. This guard firing on
  // that addition is the guard working -- a new model must be classified, not silently inherited.
  assert.equal(Object.keys(RETENTION_CLASSIFICATION).length, 39);
});

test("classification matches the real src/models directory exactly", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const modelNames = readdirSync(join(here, "..", "src", "models"))
    .filter((name) => name.endsWith(".js"))
    .map((name) => name.replace(/\.js$/, ""));
  assert.equal(modelNames.length, 39);
  const result = assertClassificationCoversModels(modelNames);
  assert.equal(result.classified, 39);
});

test("a new unclassified model makes the guard throw, naming it", () => {
  const withExtra = Object.keys(RETENTION_CLASSIFICATION).concat(
    "BrandNewModel",
  );
  assert.throws(
    () => assertClassificationCoversModels(withExtra),
    (error) =>
      error.code === "RETENTION_CLASSIFICATION_STALE" &&
      /BrandNewModel/.test(error.message),
  );
});

test("a removed model also makes the guard throw, so the table cannot rot", () => {
  const withMissing = Object.keys(RETENTION_CLASSIFICATION).filter(
    (name) => name !== "Task",
  );
  assert.throws(
    () => assertClassificationCoversModels(withMissing),
    (error) =>
      error.code === "RETENTION_CLASSIFICATION_STALE" &&
      /Task/.test(error.message),
  );
});

// PLAN.md 33.9 itself (repo root) still says 37/RETAIN:29 as of this test's
// last edit -- it was not updated when ProviderUsage.js (O10's spend-metering
// model) landed without a retention classification. This suite is the source
// of truth for the code (data-retention.service.js's RETENTION_CLASSIFICATION,
// asserted immediately above to equal the real src/models directory), so its
// own expected totals are updated to 38/RETAIN:30 to match; PLAN.md's prose
// count is a documentation drift left for whoever next edits PLAN.md, since
// this session's task explicitly scoped changes to capro-backend/ only.
test("classification totals match PLAN.md 33.9 (see note above: PLAN.md's own prose count is stale pending an out-of-scope doc edit)", () => {
  const counts = Object.values(RETENTION_CLASSIFICATION).reduce(
    (acc, value) => {
      acc[value] = (acc[value] || 0) + 1;
      return acc;
    },
    {},
  );
  // 30 -> 31 with ErasureReceipt, which is RETAIN for the reason recorded beside it in
  // data-retention.service.js: it is the proof an erasure happened and must outlive the data.
  assert.equal(counts[RETENTION_CLASSES.RETAIN], 31);
  assert.equal(counts[RETENTION_CLASSES.PURGE_FIELD], 1);
  assert.equal(counts[RETENTION_CLASSES.PURGE_CONDITIONAL], 1);
  assert.equal(counts[RETENTION_CLASSES.SELF_EXPIRING], 6);
  assert.equal(
    Object.values(counts).reduce((total, value) => total + value, 0),
    39,
  );
});

// ------------------------------------------------- the work product is protected
// Each of these is a collection that a purge must never be able to touch. The
// assertion is that assertPurgeable refuses, which is the gate every purge helper
// calls before it queries anything.

const NEVER_PURGEABLE = [
  "AuditWorkingPaper",
  "AuditWorkingPaperRow",
  "EngagementFinding",
  "Engagement",
  "CaseAnalysis",
  "CaseDraft",
  "CaseSubmission",
  "CaseTimelineEvent",
  "ReconciliationRun",
  "ReconciliationItem",
  "TdsHealthRun",
  "TdsHealthCheck",
  "TdsHealthEvidenceLink",
  "ActivityEvent",
  "Client",
  "Task",
  "User",
  "Firm",
  "FirmMembership",
  "TermsAcceptance",
];

for (const collection of NEVER_PURGEABLE) {
  test(`${collection} cannot be purged even when asked directly`, () => {
    assert.equal(isPurgeable(collection), false);
    assert.throws(
      () => assertPurgeable(collection),
      (error) => error.code === "RETENTION_COLLECTION_NOT_PURGEABLE",
    );
  });
}

test("an unknown collection is refused as unclassified, not silently allowed", () => {
  assert.throws(
    () => assertPurgeable("SomeFutureCollection"),
    (error) => error.code === "RETENTION_COLLECTION_UNCLASSIFIED",
  );
});

test("only the two intended collections are purgeable", () => {
  const purgeable = Object.keys(RETENTION_CLASSIFICATION).filter(isPurgeable);
  assert.deepEqual(purgeable.sort(), [
    "AuditWorkingPaperAnalysis",
    "CaseMatter",
  ]);
});

// ------------------------------------------------------- case source text purge

await testAsync("expired extracted text is cleared", async () => {
  const log = [];
  const CaseMatter = {
    find: makeFindStub(
      [{ _id: "case-1" }, { _id: "case-2" }],
      log,
      "CaseMatter",
    ),
    updateMany: async (filter, update) => {
      log.push({ op: "CaseMatter.updateMany", filter, update });
      return { modifiedCount: 2 };
    },
  };
  const result = await purgeExpiredCaseSourceText({ CaseMatter, nowUtc: NOW });
  assert.equal(result.cleared, 2);
  assert.equal(result.field, "source.extractedText");
});

await testAsync(
  "the purge asks only for text older than the cutoff",
  async () => {
    const log = [];
    const CaseMatter = {
      find: makeFindStub([], log, "CaseMatter"),
      updateMany: async () => ({ modifiedCount: 0 }),
    };
    await purgeExpiredCaseSourceText({ CaseMatter, nowUtc: NOW });
    const filter = log[0].filter;
    assert.equal(
      filter["source.extractedAt"].$lt.toISOString(),
      "2026-07-14T10:00:00.000Z",
    );
  },
);

await testAsync(
  "only the text field is written, nothing else on the case",
  async () => {
    const log = [];
    const CaseMatter = {
      find: makeFindStub([{ _id: "case-1" }], log, "CaseMatter"),
      updateMany: async (filter, update) => {
        log.push({ op: "CaseMatter.updateMany", filter, update });
        return { modifiedCount: 1 };
      },
    };
    await purgeExpiredCaseSourceText({ CaseMatter, nowUtc: NOW });
    const update = log.find(
      (entry) => entry.op === "CaseMatter.updateMany",
    ).update;
    // Exactly one operator, exactly one field. A $unset, a second field, or an
    // update that reached confirmedFacts would all fail here.
    assert.deepEqual(Object.keys(update), ["$set"]);
    assert.deepEqual(Object.keys(update.$set), ["source.extractedText"]);
    assert.equal(update.$set["source.extractedText"], "");
  },
);

await testAsync(
  "nothing expired means no write is attempted at all",
  async () => {
    const log = [];
    let updateCalled = false;
    const CaseMatter = {
      find: makeFindStub([], log, "CaseMatter"),
      updateMany: async () => {
        updateCalled = true;
        return { modifiedCount: 0 };
      },
    };
    const result = await purgeExpiredCaseSourceText({
      CaseMatter,
      nowUtc: NOW,
    });
    assert.equal(result.cleared, 0);
    assert.equal(updateCalled, false);
  },
);

await testAsync(
  "the batch is bounded so a first run cannot be unbounded",
  async () => {
    const log = [];
    const many = Array.from({ length: 5000 }, (_, index) => ({
      _id: `case-${index}`,
    }));
    let updatedIds = 0;
    const CaseMatter = {
      find: makeFindStub(many, log, "CaseMatter"),
      updateMany: async (filter) => {
        updatedIds = filter._id.$in.length;
        return { modifiedCount: updatedIds };
      },
    };
    await purgeExpiredCaseSourceText({ CaseMatter, nowUtc: NOW });
    assert.equal(updatedIds, RETENTION_BATCH_LIMIT);
  },
);

await testAsync(
  "a missing model is refused rather than crashing mid-write",
  async () => {
    await assert.rejects(
      () => purgeExpiredCaseSourceText({ nowUtc: NOW }),
      (error) => error.code === "RETENTION_MODEL_MISSING",
    );
  },
);

// ------------------------------------------------ working paper analysis purge

function makeAnalysisStubs({ candidates, citedAnalysisIds, log }) {
  return {
    AuditWorkingPaperAnalysis: {
      find: makeFindStub(candidates, log, "Analysis"),
      deleteMany: async (filter) => {
        log.push({ op: "Analysis.deleteMany", filter });
        return { deletedCount: filter._id.$in.length };
      },
    },
    EngagementFinding: {
      find: makeFindStub(
        citedAnalysisIds.map((id) => ({ evidence: [{ analysisId: id }] })),
        log,
        "Finding",
      ),
    },
  };
}

await testAsync("an old analysis nothing cites is deleted", async () => {
  const log = [];
  const stubs = makeAnalysisStubs({
    candidates: [{ _id: "analysis-old" }],
    citedAnalysisIds: [],
    log,
  });
  const result = await purgeExpiredWorkingPaperAnalyses({
    ...stubs,
    nowUtc: NOW,
  });
  assert.equal(result.deleted, 1);
  assert.equal(result.retainedBecauseCited, 0);
});

await testAsync(
  "an analysis a finding cites is NOT deleted, so no conclusion loses its basis",
  async () => {
    const log = [];
    const stubs = makeAnalysisStubs({
      candidates: [{ _id: "analysis-cited" }],
      citedAnalysisIds: ["analysis-cited"],
      log,
    });
    const result = await purgeExpiredWorkingPaperAnalyses({
      ...stubs,
      nowUtc: NOW,
    });
    assert.equal(result.deleted, 0);
    assert.equal(result.retainedBecauseCited, 1);
    assert.equal(
      log.some((entry) => entry.op === "Analysis.deleteMany"),
      false,
      "deleteMany must not be called when every candidate is cited",
    );
  },
);

await testAsync("a mixed batch deletes only the un-cited half", async () => {
  const log = [];
  const stubs = makeAnalysisStubs({
    candidates: [
      { _id: "keep-me" },
      { _id: "drop-me" },
      { _id: "keep-me-too" },
    ],
    citedAnalysisIds: ["keep-me", "keep-me-too"],
    log,
  });
  const result = await purgeExpiredWorkingPaperAnalyses({
    ...stubs,
    nowUtc: NOW,
  });
  assert.equal(result.deleted, 1);
  assert.equal(result.retainedBecauseCited, 2);
  const deleted = log.find((entry) => entry.op === "Analysis.deleteMany");
  assert.deepEqual(deleted.filter._id.$in, ["drop-me"]);
});

await testAsync(
  "the citation check runs even when dispositions look clean, because the two can disagree",
  async () => {
    const log = [];
    // Candidate query already excludes ACCEPTED/EDITED, yet a finding exists.
    // That happens if a finding was written and the disposition write then failed.
    const stubs = makeAnalysisStubs({
      candidates: [{ _id: "orphan-risk" }],
      citedAnalysisIds: ["orphan-risk"],
      log,
    });
    const result = await purgeExpiredWorkingPaperAnalyses({
      ...stubs,
      nowUtc: NOW,
    });
    assert.equal(result.deleted, 0);
    assert.equal(
      log.some((entry) => entry.op === "Finding.find"),
      true,
      "the findings collection must be consulted, not just the disposition field",
    );
  },
);

await testAsync(
  "accepted and edited proposals are excluded by the query itself",
  async () => {
    const log = [];
    const stubs = makeAnalysisStubs({
      candidates: [],
      citedAnalysisIds: [],
      log,
    });
    await purgeExpiredWorkingPaperAnalyses({ ...stubs, nowUtc: NOW });
    const filter = log[0].filter;
    assert.deepEqual(filter["proposals.disposition.decision"].$nin, [
      "ACCEPTED",
      "EDITED",
    ]);
    assert.equal(
      filter.createdAt.$lt.toISOString(),
      "2026-07-14T10:00:00.000Z",
    );
  },
);

await testAsync(
  "a single evidence object, not an array, is still read",
  async () => {
    const log = [];
    const stubs = {
      AuditWorkingPaperAnalysis: {
        find: makeFindStub([{ _id: "analysis-1" }], log, "Analysis"),
        deleteMany: async (filter) => ({ deletedCount: filter._id.$in.length }),
      },
      EngagementFinding: {
        // Not wrapped in an array. A reader that assumed an array would miss the
        // citation and delete a cited analysis.
        find: makeFindStub(
          [{ evidence: { analysisId: "analysis-1" } }],
          log,
          "Finding",
        ),
      },
    };
    const result = await purgeExpiredWorkingPaperAnalyses({
      ...stubs,
      nowUtc: NOW,
    });
    assert.equal(result.deleted, 0);
    assert.equal(result.retainedBecauseCited, 1);
  },
);

// -------------------------------------------------------------------- full pass

await testAsync(
  "a full pass reports each step and the total changed",
  async () => {
    const log = [];
    const models = {
      CaseMatter: {
        find: makeFindStub([{ _id: "case-1" }], log, "CaseMatter"),
        updateMany: async () => ({ modifiedCount: 1 }),
      },
      AuditWorkingPaperAnalysis: {
        find: makeFindStub([{ _id: "analysis-1" }], log, "Analysis"),
        deleteMany: async (filter) => ({ deletedCount: filter._id.$in.length }),
      },
      EngagementFinding: { find: makeFindStub([], log, "Finding") },
    };
    const summary = await runRetentionPurge({ models, nowUtc: NOW });
    assert.equal(summary.windowDays, 30);
    assert.equal(summary.steps.length, 2);
    assert.equal(summary.failures.length, 0);
    assert.equal(summary.changed, 2);
  },
);

await testAsync(
  "one failing step is reported and does not prevent the other from running",
  async () => {
    const log = [];
    const models = {
      CaseMatter: {
        find: () => {
          throw new Error("case query exploded");
        },
      },
      AuditWorkingPaperAnalysis: {
        find: makeFindStub([{ _id: "analysis-1" }], log, "Analysis"),
        deleteMany: async (filter) => ({ deletedCount: filter._id.$in.length }),
      },
      EngagementFinding: { find: makeFindStub([], log, "Finding") },
    };
    const summary = await runRetentionPurge({ models, nowUtc: NOW });
    assert.equal(summary.failures.length, 1);
    assert.equal(summary.failures[0].step, "case-source-text");
    assert.equal(summary.steps.length, 1);
    assert.equal(summary.changed, 1);
  },
);

await testAsync(
  "every run names CaseAnalysis as skipped, with the reason",
  async () => {
    const log = [];
    const models = {
      CaseMatter: {
        find: makeFindStub([], log, "CaseMatter"),
        updateMany: async () => ({ modifiedCount: 0 }),
      },
      AuditWorkingPaperAnalysis: { find: makeFindStub([], log, "Analysis") },
      EngagementFinding: { find: makeFindStub([], log, "Finding") },
    };
    const summary = await runRetentionPurge({ models, nowUtc: NOW });
    const skipped = summary.skipped.find(
      (entry) => entry.collection === "CaseAnalysis",
    );
    assert.ok(skipped, "CaseAnalysis must appear in the skipped list");
    assert.match(skipped.reason, /append-only/);
    assert.match(skipped.reason, /33\.10/);
  },
);

test("the skip list documents the unresolved conflict rather than hiding it", () => {
  assert.ok(RETENTION_SKIPS.CaseAnalysis);
  assert.match(RETENTION_SKIPS.CaseAnalysis, /33\.10/);
});

// ------------------------------------------------------------------ honest copy

test("the policy description does not claim all audit data is deleted", () => {
  const policy = describeRetentionPolicy();
  const everything = JSON.stringify(policy).toLowerCase();
  // The dangerous sentence. If a future edit lets the UI say this, a firm would
  // believe its working papers were gone when they are deliberately kept.
  assert.equal(/all (your )?audit data/.test(everything), false);
  assert.equal(/everything is deleted/.test(everything), false);
});

test("the policy states the window, what goes, what stays, and who controls what", () => {
  const policy = describeRetentionPolicy();
  assert.equal(policy.windowDays, 30);
  assert.ok(policy.removedAutomatically.length >= 2);
  assert.ok(policy.keptDeliberately.length >= 3);
  assert.ok(policy.userControlled.length >= 1);
  assert.match(policy.keptDeliberately.join(" "), /work product/i);
});

test("the policy says work product is never removed automatically", () => {
  const kept = describeRetentionPolicy()
    .keptDeliberately.join(" ")
    .toLowerCase();
  assert.match(kept, /working papers/);
  assert.match(kept, /evidence/);
  assert.match(kept, /findings/);
});

// L10 (.kiro/finalreleasefix.md): both tests below were RENAMED and strengthened, not just left to
// pass. Their old names ("states no third-party disclosure", "states plainly that accounts are not
// deleted") asserted the exact framing that turned out to be false, so a suite that kept them would
// keep vouching for the retired claim even while the shipped string was corrected. A test name is
// part of the contract it documents.
test("the disclosure names its real recipients instead of hiding them behind a category", () => {
  const policy = describeRetentionPolicy();
  // Still true and still asserted: nothing is sold.
  assert.match(policy.disclosure, /Nothing is sold/i);
  // The claim that replaced the self-contradicting one: each recipient is named. A regression back
  // to "an AI provider" or "a third party" fails here, which is the point.
  for (const recipient of ["DeepSeek", "OCR.space", "Resend", "Google"]) {
    assert.ok(
      policy.disclosure.includes(recipient),
      `disclosure must name ${recipient} rather than a generic category`,
    );
  }
  // The old text's self-contradiction, pinned so it cannot come back: a blanket "nothing is
  // shared/disclosed to a third party" cannot coexist with naming providers that receive data.
  assert.doesNotMatch(policy.disclosure, /not sold, shared or disclosed/i);
});

test("account removal is described truthfully: no self-service delete, but a super-admin route does exist", () => {
  const policy = describeRetentionPolicy();
  // Kept: the true and reassuring half.
  assert.match(policy.accountDeletion, /not deleted/i);
  // The false clause that was removed. super.routes.js still exposes real DELETE routes for a
  // firm and for a user within it, so any text claiming no such route exists is disprovable from
  // this same repository. (Since L12 the user route tombstones rather than calling deleteOne, and
  // the firm route runs the full classified cascade before deleting the firm row — the routes are
  // no less real for that.)
  assert.doesNotMatch(policy.accountDeletion, /no route that removes/i);
  // What replaced it must actually say who can remove an account and on what basis.
  assert.match(policy.accountDeletion, /super administrator/i);
  assert.match(policy.accountDeletion, /written request/i);
  assert.match(policy.accountDeletion, /required by law to keep are retained/i);
  // L12 completed the cascade, so these two are now true and pinned: identity does not survive
  // inside retained work product, and the operation produces a receipt. Both are asserted against
  // a real run in tests/firm-erasure-e2e.mjs; pinning the wording here stops the copy drifting
  // away from behaviour that is now verified.
  assert.match(policy.accountDeletion, /name and email address are removed/i);
  assert.match(policy.accountDeletion, /receipt/i);
  // Still must not claim retained work product is destroyed, because it is not.
  assert.doesNotMatch(policy.accountDeletion, /everything is (deleted|erased|destroyed)/i);
});

test("the policy contains no engineering leakage a user should never see", () => {
  const everything = JSON.stringify(describeRetentionPolicy());
  for (const banned of [
    "401",
    "403",
    "429",
    "HTTP",
    "null",
    "exception",
    "ObjectId",
  ]) {
    assert.equal(
      everything.includes(banned),
      false,
      `user-facing retention copy must not contain ${banned}`,
    );
  }
});

test("clearing history is described as irreversible, not softened", () => {
  const controlled = describeRetentionPolicy().userControlled.join(" ");
  assert.match(controlled, /cannot be undone/i);
});

// --------------------------------------------------------------------- results

console.log(`data retention contract: ${passed}/${passed + failed} passed`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  FAIL ${failure}`);
  process.exit(1);
}
