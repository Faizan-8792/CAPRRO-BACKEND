// Enforces the data retention policy decided in PLAN.md section 33 (2026-08-13).
//
// Three things in this file are load-bearing and should not be "tidied away":
//
// 1. RETENTION_CLASSIFICATION is an allow-list, not documentation. Every purge
//    helper calls assertPurgeable() first, so a collection that is not explicitly
//    classified as purgeable cannot be touched even if a caller names it. And
//    assertClassificationCoversModels() refuses when a model file exists with no
//    entry, so adding a model fails closed instead of being silently purged or
//    silently retained. Section 33.9 is the human-readable copy of this table and
//    the two must agree; a test asserts they do.
//
// 2. This is a scheduled field-unset and a conditional delete, NOT a Mongo TTL
//    index. A TTL index deletes whole documents. On CaseMatter that would destroy
//    a firm's work product in order to remove one field, and it could not express
//    the "only if nothing cites it" condition at all. A TTL index would also fail
//    assertAuditWorkingPaperIndexesReady(), which rejects any index carrying
//    expireAfterSeconds.
//
// 3. The citation checks are the safety property, not an optimisation.
//    EngagementFinding.evidence.analysisId is a required, immutable reference to
//    an AuditWorkingPaperAnalysis. Purging a cited analysis would leave a
//    professional conclusion standing with its basis deleted, which is worse than
//    keeping both or deleting both. So an analysis is removed only when nothing
//    references it.
//
// CaseAnalysis is deliberately NOT purged. Its schema forbids deletion outright
// and doing it anyway would need a driver-level bypass of an explicit guard. That
// conflict is recorded in PLAN.md section 33.10 and reported by every run rather
// than being silently resolved here.

export const RETENTION_WINDOW_DAYS = 30;
export const RETENTION_WINDOW_MS = RETENTION_WINDOW_DAYS * 24 * 60 * 60 * 1000;

// Bounds one pass so a first run against a large backlog cannot monopolise the
// connection pool. Anything left over is taken on the next tick.
export const RETENTION_BATCH_LIMIT = 500;

export const RETENTION_CLASSES = Object.freeze({
  RETAIN: "RETAIN",
  PURGE_FIELD: "PURGE_FIELD",
  PURGE_CONDITIONAL: "PURGE_CONDITIONAL",
  SELF_EXPIRING: "SELF_EXPIRING",
});

const PURGEABLE_CLASSES = Object.freeze([
  RETENTION_CLASSES.PURGE_FIELD,
  RETENTION_CLASSES.PURGE_CONDITIONAL,
]);

// All 37 models in src/models, classified. Mirrors PLAN.md section 33.9.
export const RETENTION_CLASSIFICATION = Object.freeze({
  ActivityEvent: RETENTION_CLASSES.RETAIN,
  AppConfig: RETENTION_CLASSES.RETAIN,
  AuditWorkingPaper: RETENTION_CLASSES.RETAIN,
  AuditWorkingPaperAnalysis: RETENTION_CLASSES.PURGE_CONDITIONAL,
  AuditWorkingPaperRow: RETENTION_CLASSES.RETAIN,
  AutomationJob: RETENTION_CLASSES.SELF_EXPIRING,
  CaseAnalysis: RETENTION_CLASSES.RETAIN,
  CaseDraft: RETENTION_CLASSES.RETAIN,
  CaseMatter: RETENTION_CLASSES.PURGE_FIELD,
  CaseProviderOperation: RETENTION_CLASSES.SELF_EXPIRING,
  CaseSubmission: RETENTION_CLASSES.RETAIN,
  CaseTimelineEvent: RETENTION_CLASSES.RETAIN,
  Client: RETENTION_CLASSES.RETAIN,
  ComplianceOverride: RETENTION_CLASSES.RETAIN,
  ComplianceRule: RETENTION_CLASSES.RETAIN,
  DigestDelivery: RETENTION_CLASSES.RETAIN,
  Engagement: RETENTION_CLASSES.RETAIN,
  EngagementFinding: RETENTION_CLASSES.RETAIN,
  Firm: RETENTION_CLASSES.RETAIN,
  FirmMembership: RETENTION_CLASSES.RETAIN,
  ImportBatch: RETENTION_CLASSES.RETAIN,
  ImportRow: RETENTION_CLASSES.RETAIN,
  Otp: RETENTION_CLASSES.SELF_EXPIRING,
  ReconciliationItem: RETENTION_CLASSES.RETAIN,
  ReconciliationRun: RETENTION_CLASSES.RETAIN,
  Reminder: RETENTION_CLASSES.RETAIN,
  SystemTestRun: RETENTION_CLASSES.SELF_EXPIRING,
  Task: RETENTION_CLASSES.RETAIN,
  TaskBulkOperation: RETENTION_CLASSES.SELF_EXPIRING,
  TaxWorkSession: RETENTION_CLASSES.RETAIN,
  TdsHealthCheck: RETENTION_CLASSES.RETAIN,
  TdsHealthEvidenceLink: RETENTION_CLASSES.RETAIN,
  TdsHealthRun: RETENTION_CLASSES.RETAIN,
  TdsImportRow: RETENTION_CLASSES.RETAIN,
  TermsAcceptance: RETENTION_CLASSES.RETAIN,
  User: RETENTION_CLASSES.RETAIN,
  WorkspaceOperation: RETENTION_CLASSES.SELF_EXPIRING,
});

// Named so the skip is visible in the run report and in logs, not only in PLAN.md.
export const RETENTION_SKIPS = Object.freeze({
  CaseAnalysis:
    "schema forbids deletion (append-only guard); unresolved, see PLAN.md 33.10",
});

export function classifyCollection(collectionName) {
  const name = String(collectionName || "");
  return Object.prototype.hasOwnProperty.call(RETENTION_CLASSIFICATION, name)
    ? RETENTION_CLASSIFICATION[name]
    : null;
}

export function isPurgeable(collectionName) {
  return PURGEABLE_CLASSES.includes(classifyCollection(collectionName));
}

// Fails closed. A caller naming an unclassified or non-purgeable collection is a
// bug, and the error says which so it is obvious from the log line alone.
export function assertPurgeable(collectionName) {
  const name = String(collectionName || "");
  const retentionClass = classifyCollection(name);
  if (retentionClass === null) {
    const error = new Error(
      `retention purge refused: ${name || "(unnamed)"} is not classified in PLAN.md 33.9`,
    );
    error.code = "RETENTION_COLLECTION_UNCLASSIFIED";
    throw error;
  }
  if (!PURGEABLE_CLASSES.includes(retentionClass)) {
    const error = new Error(
      `retention purge refused: ${name} is classified ${retentionClass} and must not be purged`,
    );
    error.code = "RETENTION_COLLECTION_NOT_PURGEABLE";
    throw error;
  }
  return retentionClass;
}

// Guards against a new model arriving without a retention decision. Called by the
// classification test with the real directory listing.
export function assertClassificationCoversModels(modelNames) {
  const provided = Array.from(new Set((modelNames || []).map(String))).sort();
  const classified = Object.keys(RETENTION_CLASSIFICATION).sort();
  const missing = provided.filter((name) => !classified.includes(name));
  const extra = classified.filter((name) => !provided.includes(name));
  if (missing.length > 0 || extra.length > 0) {
    const parts = [];
    if (missing.length > 0) {
      parts.push(`unclassified models: ${missing.join(", ")}`);
    }
    if (extra.length > 0) {
      parts.push(`classified but absent from src/models: ${extra.join(", ")}`);
    }
    const error = new Error(`retention classification is out of date - ${parts.join("; ")}`);
    error.code = "RETENTION_CLASSIFICATION_STALE";
    throw error;
  }
  return { classified: classified.length };
}

function resolveNow(nowUtc) {
  const now = nowUtc instanceof Date ? nowUtc : new Date(nowUtc ?? Date.now());
  if (!Number.isFinite(now.getTime())) {
    const error = new Error("retention purge refused: nowUtc is not a valid date");
    error.code = "RETENTION_INVALID_NOW";
    throw error;
  }
  return now;
}

// Measured from the moment the data was stored, per the decision, not from last
// access. Returns the instant on or before which stored data is expired.
export function retentionCutoff(nowUtc) {
  return new Date(resolveNow(nowUtc).getTime() - RETENTION_WINDOW_MS);
}

function resolveLimit(limit) {
  const requested = Number(limit);
  if (!Number.isInteger(requested) || requested <= 0) return RETENTION_BATCH_LIMIT;
  return Math.min(requested, RETENTION_BATCH_LIMIT);
}

// Unsets CaseMatter.source.extractedText once it is older than the window.
//
// Only that one field goes. textHash, sizeBytes, sourceName, method,
// extractionProvider and extractedAt all stay, so the record of what was
// processed and when survives without the content itself -- which is what lets a
// reviewer still see that a notice was read from a scan on a given date.
export async function purgeExpiredCaseSourceText({
  CaseMatter,
  nowUtc,
  limit,
} = {}) {
  assertPurgeable("CaseMatter");
  if (!CaseMatter) {
    const error = new Error("retention purge refused: CaseMatter model was not supplied");
    error.code = "RETENTION_MODEL_MISSING";
    throw error;
  }
  const cutoff = retentionCutoff(nowUtc);
  const batchLimit = resolveLimit(limit);

  const expired = await CaseMatter.find({
    "source.extractedAt": { $lt: cutoff },
    "source.extractedText": { $nin: ["", null] },
  })
    .select("_id")
    .limit(batchLimit)
    .lean();

  const ids = (expired || []).map((row) => row._id);
  if (ids.length === 0) {
    return { collection: "CaseMatter", field: "source.extractedText", cleared: 0, cutoff };
  }

  // $set to "" rather than $unset: the schema declares a default of "" and a
  // required textHash beside it, so an absent field and an empty one are not the
  // same shape to every reader. Empty keeps the document valid.
  const result = await CaseMatter.updateMany(
    { _id: { $in: ids } },
    { $set: { "source.extractedText": "" } },
  );

  return {
    collection: "CaseMatter",
    field: "source.extractedText",
    cleared: Number(result?.modifiedCount ?? result?.nModified ?? 0),
    cutoff,
  };
}

// Deletes AuditWorkingPaperAnalysis documents older than the window, but only
// those that nothing references.
//
// Two independent citations are checked, and both must be absent:
//   - EngagementFinding.evidence.analysisId, a required immutable ObjectId. A
//     finding whose analysis was deleted is a conclusion with its basis missing.
//   - the analysis's own proposals, where any disposition other than PENDING or
//     REJECTED means a human acted on it and the record of that decision matters.
export async function purgeExpiredWorkingPaperAnalyses({
  AuditWorkingPaperAnalysis,
  EngagementFinding,
  nowUtc,
  limit,
} = {}) {
  assertPurgeable("AuditWorkingPaperAnalysis");
  if (!AuditWorkingPaperAnalysis || !EngagementFinding) {
    const error = new Error(
      "retention purge refused: AuditWorkingPaperAnalysis and EngagementFinding models are both required",
    );
    error.code = "RETENTION_MODEL_MISSING";
    throw error;
  }
  const cutoff = retentionCutoff(nowUtc);
  const batchLimit = resolveLimit(limit);

  const candidates = await AuditWorkingPaperAnalysis.find({
    createdAt: { $lt: cutoff },
    "proposals.disposition.decision": { $nin: ["ACCEPTED", "EDITED"] },
  })
    .select("_id")
    .limit(batchLimit)
    .lean();

  const candidateIds = (candidates || []).map((row) => row._id);
  if (candidateIds.length === 0) {
    return {
      collection: "AuditWorkingPaperAnalysis",
      deleted: 0,
      retainedBecauseCited: 0,
      cutoff,
    };
  }

  // Ask the findings which of these are cited rather than trusting the
  // disposition alone. The two can disagree: a finding is a separate document and
  // a disposition write could have failed after the finding was created.
  const cited = await EngagementFinding.find({
    "evidence.analysisId": { $in: candidateIds },
  })
    .select("evidence.analysisId")
    .lean();

  const citedIds = new Set();
  for (const finding of cited || []) {
    const evidence = Array.isArray(finding?.evidence)
      ? finding.evidence
      : [finding?.evidence].filter(Boolean);
    for (const entry of evidence) {
      if (entry?.analysisId) citedIds.add(String(entry.analysisId));
    }
  }

  const deletableIds = candidateIds.filter((id) => !citedIds.has(String(id)));
  if (deletableIds.length === 0) {
    return {
      collection: "AuditWorkingPaperAnalysis",
      deleted: 0,
      retainedBecauseCited: candidateIds.length,
      cutoff,
    };
  }

  const result = await AuditWorkingPaperAnalysis.deleteMany({
    _id: { $in: deletableIds },
  });

  return {
    collection: "AuditWorkingPaperAnalysis",
    deleted: Number(result?.deletedCount ?? 0),
    retainedBecauseCited: candidateIds.length - deletableIds.length,
    cutoff,
  };
}

// One pass. Each step is independent: a failure in one is reported and does not
// prevent the others, because a purge that stops half way leaves an inconsistent
// retention state that is harder to reason about than a reported partial failure.
export async function runRetentionPurge({ models, nowUtc, limit } = {}) {
  const now = resolveNow(nowUtc);
  const cutoff = retentionCutoff(now);
  const steps = [];
  const failures = [];

  const tasks = [
    {
      name: "case-source-text",
      run: () =>
        purgeExpiredCaseSourceText({
          CaseMatter: models?.CaseMatter,
          nowUtc: now,
          limit,
        }),
    },
    {
      name: "working-paper-analyses",
      run: () =>
        purgeExpiredWorkingPaperAnalyses({
          AuditWorkingPaperAnalysis: models?.AuditWorkingPaperAnalysis,
          EngagementFinding: models?.EngagementFinding,
          nowUtc: now,
          limit,
        }),
    },
  ];

  for (const task of tasks) {
    try {
      steps.push({ step: task.name, ...(await task.run()) });
    } catch (error) {
      failures.push({
        step: task.name,
        code: error?.code || "RETENTION_STEP_FAILED",
        message: error?.message || String(error),
      });
    }
  }

  return {
    ranAt: now,
    cutoff,
    windowDays: RETENTION_WINDOW_DAYS,
    steps,
    failures,
    skipped: Object.entries(RETENTION_SKIPS).map(([collection, reason]) => ({
      collection,
      reason,
    })),
    changed: steps.reduce(
      (total, step) => total + Number(step.cleared || 0) + Number(step.deleted || 0),
      0,
    ),
  };
}

// The single source of truth for what both clients are allowed to say. Kept here,
// beside the code that actually does it, so the copy cannot drift from the
// behaviour: if the purge scope changes, this changes in the same edit.
//
// Deliberately narrower than "all your audit data is deleted after 30 days".
// Working papers, evidence rows and findings are retained on purpose, and telling
// a firm otherwise would be a false statement about its statutory records.
export function describeRetentionPolicy() {
  return Object.freeze({
    windowDays: RETENTION_WINDOW_DAYS,
    removedAutomatically: Object.freeze([
      "The extracted text of a notice or document, 30 days after it was stored. The file name, size, extraction method and date are kept, so the record that it was read stays even though the text does not.",
      "AI analysis of a working paper, 30 days after it was produced, unless a finding cites it.",
    ]),
    keptDeliberately: Object.freeze([
      "Working papers, their source evidence rows, and your findings. These are your work product and are never removed automatically.",
      "Reconciliation runs, TDS checks, tasks, clients and the activity trail.",
      "AI analysis that a finding is based on, so a conclusion never outlives the basis it cites.",
    ]),
    userControlled: Object.freeze([
      "Review history on this device can be cleared at any time, and clearing it cannot be undone.",
    ]),
    disclosure:
      "Nothing is sold, shared or disclosed to a third party. Where an AI provider is used, only the specific fields listed for that request are sent, and only after you consent to that provider.",
    accountDeletion:
      "Accounts are not deleted. CA PRO has no route that removes a user or a firm, so no session and no mistake can destroy a firm's records.",
  });
}

export default {
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
};
