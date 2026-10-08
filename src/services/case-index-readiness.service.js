import CaseAnalysis from "../models/CaseAnalysis.js";
import CaseDraft from "../models/CaseDraft.js";
import CaseMatter from "../models/CaseMatter.js";
import CaseProviderOperation from "../models/CaseProviderOperation.js";
import CaseSubmission from "../models/CaseSubmission.js";
import CaseTimelineEvent from "../models/CaseTimelineEvent.js";
import Reminder from "../models/Reminder.js";
import Task from "../models/Task.js";

function stringPartial(field) {
  return { [field]: { $type: "string" } };
}

const REQUIRED_CASE_INDEXES = Object.freeze([
  {
    model: CaseMatter,
    label: "CaseMatter intake replay",
    key: { firmId: 1, intakeMutationKey: 1 },
    unique: true,
    partial: stringPartial("intakeMutationKey"),
  },
  {
    model: CaseMatter,
    label: "CaseMatter stable list",
    key: { firmId: 1, createdAt: -1, _id: -1 },
  },
  {
    model: CaseAnalysis,
    label: "CaseAnalysis version",
    key: { firmId: 1, caseId: 1, version: -1 },
    unique: true,
  },
  {
    model: CaseAnalysis,
    label: "CaseAnalysis replay",
    key: { firmId: 1, caseId: 1, mutationKey: 1 },
    unique: true,
    partial: stringPartial("mutationKey"),
  },
  {
    model: CaseDraft,
    label: "CaseDraft version",
    key: { firmId: 1, caseId: 1, version: -1 },
    unique: true,
  },
  {
    model: CaseDraft,
    label: "CaseDraft creation replay",
    key: { firmId: 1, caseId: 1, mutationKey: 1 },
    unique: true,
    partial: stringPartial("mutationKey"),
  },
  {
    model: CaseDraft,
    label: "CaseDraft review submission replay",
    key: { firmId: 1, caseId: 1, reviewSubmissionMutationKey: 1 },
    unique: true,
    partial: stringPartial("reviewSubmissionMutationKey"),
  },
  {
    model: CaseDraft,
    label: "CaseDraft review decision replay",
    key: { firmId: 1, caseId: 1, reviewDecisionMutationKey: 1 },
    unique: true,
    partial: stringPartial("reviewDecisionMutationKey"),
  },
  {
    model: CaseDraft,
    label: "CaseDraft finalization replay",
    key: { firmId: 1, caseId: 1, finalizationMutationKey: 1 },
    unique: true,
    partial: stringPartial("finalizationMutationKey"),
  },
  {
    model: CaseDraft,
    label: "CaseDraft submission claim",
    key: { firmId: 1, caseId: 1, submissionMutationKey: 1 },
    unique: true,
    partial: stringPartial("submissionMutationKey"),
  },
  {
    model: CaseDraft,
    label: "CaseDraft one final",
    key: { firmId: 1, caseId: 1, status: 1 },
    unique: true,
    partial: { status: "FINAL" },
  },
  {
    model: CaseSubmission,
    label: "CaseSubmission version",
    key: { firmId: 1, caseId: 1, version: -1 },
    unique: true,
  },
  {
    model: CaseSubmission,
    label: "CaseSubmission replay",
    key: { firmId: 1, caseId: 1, mutationKey: 1 },
    unique: true,
    partial: stringPartial("mutationKey"),
  },
  {
    model: CaseSubmission,
    label: "CaseSubmission acknowledgment",
    key: { firmId: 1, caseId: 1, acknowledgmentReference: 1 },
    unique: true,
  },
  {
    model: CaseTimelineEvent,
    label: "Case timeline replay",
    key: { firmId: 1, caseId: 1, mutationKey: 1 },
    unique: true,
    partial: stringPartial("mutationKey"),
  },
  {
    model: CaseProviderOperation,
    label: "Case provider operation reservation",
    key: { firmId: 1, caseId: 1, mutationKey: 1 },
    unique: true,
  },
  {
    model: Task,
    label: "Case Task projection",
    key: { firmId: 1, generationKey: 1 },
    unique: true,
    partial: stringPartial("generationKey"),
  },
  {
    model: Reminder,
    label: "Case Reminder projection",
    key: { firmId: 1, generationKey: 1 },
    unique: true,
    partial: stringPartial("generationKey"),
  },
]);

function sameKey(actual, expected) {
  const actualEntries = Object.entries(actual || {});
  const expectedEntries = Object.entries(expected);
  return (
    actualEntries.length === expectedEntries.length &&
    expectedEntries.every(
      ([field, direction], index) =>
        actualEntries[index]?.[0] === field &&
        Number(actualEntries[index]?.[1]) === direction,
    )
  );
}

function matchesPartial(actual, expected) {
  if (!expected) return true;
  return (
    JSON.stringify(actual?.partialFilterExpression || null) ===
    JSON.stringify(expected)
  );
}

async function collectionIndexes(model) {
  try {
    return await model.collection.listIndexes().toArray();
  } catch (error) {
    if (error?.codeName === "NamespaceNotFound" || error?.code === 26)
      return [];
    throw error;
  }
}

async function getCaseIndexReadiness() {
  const byCollection = new Map();
  const missing = [];
  for (const requirement of REQUIRED_CASE_INDEXES) {
    const collectionName = requirement.model.collection.collectionName;
    if (!byCollection.has(collectionName)) {
      byCollection.set(
        collectionName,
        await collectionIndexes(requirement.model),
      );
    }
    const indexes = byCollection.get(collectionName);
    const present = indexes.some(
      (index) =>
        sameKey(index.key, requirement.key) &&
        (!requirement.unique || index.unique === true) &&
        matchesPartial(index, requirement.partial),
    );
    if (!present) {
      missing.push({
        collection: collectionName,
        label: requirement.label,
        key: requirement.key,
        unique: Boolean(requirement.unique),
      });
    }
  }
  return {
    ready: missing.length === 0,
    checked: REQUIRED_CASE_INDEXES.length,
    missing,
  };
}

async function assertCaseIndexesReady() {
  const readiness = await getCaseIndexReadiness();
  if (!readiness.ready) {
    const error = new Error(
      `Notice/Case indexes are not ready: ${readiness.missing.map((item) => item.label).join(", ")}`,
    );
    error.statusCode = 503;
    error.code = "CASE_INDEXES_NOT_READY";
    error.readiness = readiness;
    throw error;
  }
  return readiness;
}

export { REQUIRED_CASE_INDEXES, assertCaseIndexesReady, getCaseIndexReadiness };
