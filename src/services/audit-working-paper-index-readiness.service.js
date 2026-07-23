import AuditWorkingPaper from "../models/AuditWorkingPaper.js";
import AuditWorkingPaperAnalysis from "../models/AuditWorkingPaperAnalysis.js";
import AuditWorkingPaperRow from "../models/AuditWorkingPaperRow.js";

const REQUIRED_AUDIT_WORKING_PAPER_INDEXES = Object.freeze([
  {
    model: AuditWorkingPaper,
    label: "Audit working-paper creation replay",
    key: { firmId: 1, engagementId: 1, creationMutationKey: 1 },
    unique: true,
  },
  {
    model: AuditWorkingPaper,
    label: "Audit working-paper stable list",
    key: { firmId: 1, engagementId: 1, createdAt: -1, _id: -1 },
  },
  {
    model: AuditWorkingPaper,
    label: "Audit prior-period lookup",
    key: { firmId: 1, priorWorkingPaperId: 1 },
  },
  {
    model: AuditWorkingPaperRow,
    label: "Audit source-row creation replay",
    key: { firmId: 1, workingPaperId: 1, creationMutationKey: 1 },
    unique: true,
  },
  {
    model: AuditWorkingPaperRow,
    label: "Audit source-row key",
    key: { firmId: 1, workingPaperId: 1, rowKey: 1 },
    unique: true,
  },
  {
    model: AuditWorkingPaperRow,
    label: "Audit source-row stable list",
    key: { firmId: 1, workingPaperId: 1, createdAt: 1, _id: 1 },
  },
  {
    model: AuditWorkingPaperAnalysis,
    label: "Audit analysis creation replay",
    key: { firmId: 1, workingPaperId: 1, creationMutationKey: 1 },
    unique: true,
  },
  {
    model: AuditWorkingPaperAnalysis,
    label: "Audit analysis stable list",
    key: { firmId: 1, workingPaperId: 1, createdAt: -1, _id: -1 },
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
        Number(actualEntries[index]?.[1]) === direction
    )
  );
}

function indexOptionsCompatible(index, requirement) {
  if (Boolean(index.unique) !== Boolean(requirement.unique)) return false;
  if (index.sparse === true || index.hidden === true || index.prepareUnique === true) return false;
  if (index.partialFilterExpression != null) return false;
  if (index.expireAfterSeconds != null || index.wildcardProjection != null) return false;
  if (index.collation && index.collation.locale !== "simple") return false;
  return true;
}

async function collectionIndexes(model) {
  try {
    return await model.collection.listIndexes().toArray();
  } catch (error) {
    if (error?.codeName === "NamespaceNotFound" || error?.code === 26) return [];
    throw error;
  }
}

async function getAuditWorkingPaperIndexReadiness() {
  const byCollection = new Map();
  const missing = [];
  for (const requirement of REQUIRED_AUDIT_WORKING_PAPER_INDEXES) {
    const collectionName = requirement.model.collection.collectionName;
    if (!byCollection.has(collectionName)) {
      byCollection.set(collectionName, await collectionIndexes(requirement.model));
    }
    const present = byCollection.get(collectionName).some(
      (index) =>
        sameKey(index.key, requirement.key) &&
        indexOptionsCompatible(index, requirement)
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
    checked: REQUIRED_AUDIT_WORKING_PAPER_INDEXES.length,
    missing,
  };
}

async function assertAuditWorkingPaperIndexesReady() {
  const readiness = await getAuditWorkingPaperIndexReadiness();
  if (!readiness.ready) {
    const error = new Error(
      `Audit working-paper indexes are not ready: ${readiness.missing
        .map((item) => item.label)
        .join(", ")}`
    );
    error.statusCode = 503;
    error.code = "AUDIT_WORKING_PAPER_INDEXES_NOT_READY";
    error.readiness = readiness;
    throw error;
  }
  return readiness;
}

export {
  REQUIRED_AUDIT_WORKING_PAPER_INDEXES,
  assertAuditWorkingPaperIndexesReady,
  getAuditWorkingPaperIndexReadiness,
};
