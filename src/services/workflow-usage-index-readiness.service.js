// Declares the compound unique index WorkflowUsage.recordUsage depends on for
// its atomic upsert, in the same shape as provider-usage-index-readiness.service.js.
// autoIndex is off in production and index-provisioning.service.js is what
// "manage in prod" means, so a model absent from a REQUIREMENT_GROUPS entry has
// NO index in production — the exact defect found live for ProviderUsage (see
// that file's header). WorkflowUsage's per-day counters are written concurrently
// by every workflow request, so the {userId, client, workflow, periodDay} unique
// index is load-bearing from the first request, not an optimisation.
import WorkflowUsage from "../models/WorkflowUsage.js";

const REQUIRED_WORKFLOW_USAGE_INDEXES = Object.freeze([
  {
    model: WorkflowUsage,
    label: "WorkflowUsage per-user/client/workflow/day uniqueness",
    key: { userId: 1, client: 1, workflow: 1, periodDay: 1 },
    unique: true,
  },
]);

function orderedKeyEntries(key) {
  return Object.entries(key || {}).map(([field, direction]) => [
    field,
    Number(direction),
  ]);
}

function hasExactOrderedKey(actual, expected) {
  const actualEntries = orderedKeyEntries(actual);
  const expectedEntries = orderedKeyEntries(expected);
  return (
    actualEntries.length === expectedEntries.length &&
    expectedEntries.every(
      ([field, direction], index) =>
        actualEntries[index]?.[0] === field &&
        actualEntries[index]?.[1] === direction,
    )
  );
}

function isNamespaceNotFound(error) {
  return error?.codeName === "NamespaceNotFound" || Number(error?.code) === 26;
}

async function loadCollectionIndexes(model) {
  return model.collection.listIndexes().toArray();
}

async function getWorkflowUsageIndexReadiness({
  requirements = REQUIRED_WORKFLOW_USAGE_INDEXES,
  indexLoader = loadCollectionIndexes,
} = {}) {
  const diagnostics = [];

  for (const requirement of requirements) {
    const collection = requirement.model.collection.collectionName;
    let indexes;
    try {
      indexes = await indexLoader(requirement.model, requirement);
    } catch (error) {
      if (!isNamespaceNotFound(error)) throw error;
      indexes = [];
    }

    const matching = indexes.filter((index) =>
      hasExactOrderedKey(index.key, requirement.key),
    );
    const validIndex = matching.find(
      (index) => index?.unique === true && index?.sparse !== true,
    );

    if (!validIndex) {
      diagnostics.push({
        collection,
        label: requirement.label,
        key: requirement.key,
        reason: matching.length ? "non-unique" : "missing",
        code: matching.length ? "INDEX_NOT_UNIQUE" : "INDEX_MISSING",
      });
    }
  }

  return {
    ready: diagnostics.length === 0,
    checked: requirements.length,
    missing: diagnostics,
    diagnostics,
  };
}

async function assertWorkflowUsageIndexesReady(options) {
  const readiness = await getWorkflowUsageIndexReadiness(options);
  if (!readiness.ready) {
    const error = new Error(
      `Workflow-usage indexes are not ready: ${readiness.diagnostics
        .map((item) => item.label)
        .join(" ")}`,
    );
    error.statusCode = 503;
    error.code = "WORKFLOW_USAGE_INDEXES_NOT_READY";
    error.readiness = readiness;
    throw error;
  }
  return readiness;
}

export {
  REQUIRED_WORKFLOW_USAGE_INDEXES,
  assertWorkflowUsageIndexesReady,
  getWorkflowUsageIndexReadiness,
};
