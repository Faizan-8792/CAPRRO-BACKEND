import Engagement from "../models/Engagement.js";
import EngagementFinding from "../models/EngagementFinding.js";

const REQUIRED_ENGAGEMENT_INDEXES = Object.freeze([
  {
    model: Engagement,
    label: "Engagement creation replay",
    key: { firmId: 1, creationMutationKey: 1 },
    unique: true,
  },
  {
    model: Engagement,
    label: "Engagement stable list",
    key: { firmId: 1, createdAt: -1, _id: -1 },
  },
  {
    model: Engagement,
    label: "Engagement client/type/status lookup",
    key: { firmId: 1, clientId: 1, engagementType: 1, status: 1, updatedAt: -1, _id: -1 },
  },
  {
    model: Engagement,
    label: "Engagement reviewer queue",
    key: { firmId: 1, reviewerUserId: 1, status: 1, updatedAt: -1, _id: -1 },
  },
  {
    model: EngagementFinding,
    label: "Engagement finding creation replay",
    key: { firmId: 1, engagementId: 1, creationMutationKey: 1 },
    unique: true,
  },
  {
    model: EngagementFinding,
    label: "Engagement finding stable list",
    key: { firmId: 1, engagementId: 1, createdAt: -1, _id: -1 },
  },
  {
    model: EngagementFinding,
    label: "Engagement finding status/risk lookup",
    key: { firmId: 1, engagementId: 1, status: 1, risk: 1, updatedAt: -1, _id: -1 },
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

async function getEngagementIndexReadiness() {
  const byCollection = new Map();
  const missing = [];
  for (const requirement of REQUIRED_ENGAGEMENT_INDEXES) {
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
    checked: REQUIRED_ENGAGEMENT_INDEXES.length,
    missing,
  };
}

async function assertEngagementIndexesReady() {
  const readiness = await getEngagementIndexReadiness();
  if (!readiness.ready) {
    const error = new Error(
      `Engagement indexes are not ready: ${readiness.missing
        .map((item) => item.label)
        .join(", ")}`
    );
    error.statusCode = 503;
    error.code = "ENGAGEMENT_INDEXES_NOT_READY";
    error.readiness = readiness;
    throw error;
  }
  return readiness;
}

export {
  REQUIRED_ENGAGEMENT_INDEXES,
  assertEngagementIndexesReady,
  getEngagementIndexReadiness,
};
