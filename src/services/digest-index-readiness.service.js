import AutomationJob from "../models/AutomationJob.js";
import DigestDelivery from "../models/DigestDelivery.js";

const REQUIRED_DIGEST_INDEXES = Object.freeze([
  {
    model: DigestDelivery,
    label: "DigestDelivery recipient-period uniqueness",
    key: { firmId: 1, kind: 1, periodKey: 1, recipientUserId: 1 },
    unique: true,
  },
  {
    model: AutomationJob,
    label: "AutomationJob idempotency uniqueness",
    key: { firmId: 1, kind: 1, idempotencyKey: 1 },
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

function hasSameKeyFields(actual, expected) {
  const actualFields = orderedKeyEntries(actual).map(([field]) => field);
  const expectedFields = orderedKeyEntries(expected).map(([field]) => field);
  if (actualFields.length !== expectedFields.length) return false;

  const actualFieldSet = new Set(actualFields);
  return expectedFields.every((field) => actualFieldSet.has(field));
}

function hasSameKeyDirections(actual, expected) {
  const actualEntries = orderedKeyEntries(actual);
  const expectedEntries = orderedKeyEntries(expected);
  if (actualEntries.length !== expectedEntries.length) return false;

  const actualByField = new Map(actualEntries);
  return expectedEntries.every(
    ([field, direction]) => actualByField.get(field) === direction,
  );
}

function formatKey(key) {
  return `{ ${orderedKeyEntries(key)
    .map(([field, direction]) => `${field}: ${direction}`)
    .join(", ")} }`;
}

function collectionNameFor(requirement) {
  const collection =
    requirement.collection || requirement.model?.collection?.collectionName;
  if (!collection) {
    throw new TypeError(
      `Digest index requirement "${requirement.label || "unlabelled"}" has no collection`,
    );
  }
  return collection;
}

function hasPartialFilter(index) {
  return index?.partialFilterExpression !== undefined;
}

function hasNonSimpleCollation(index) {
  return (
    index?.collation !== undefined && index?.collation?.locale !== "simple"
  );
}

function isHidden(index) {
  return index?.hidden === true;
}

function isPreparingUnique(index) {
  return index?.prepareUnique === true;
}

function hasTtl(index) {
  return index?.expireAfterSeconds !== undefined;
}

function hasWildcardConfiguration(index) {
  return (
    index?.wildcardProjection !== undefined ||
    Object.keys(index?.key || {}).some((field) => field.includes("$**"))
  );
}

function isFullyValidExactIndex(index) {
  return (
    index?.unique === true &&
    index?.sparse !== true &&
    !hasPartialFilter(index) &&
    !isHidden(index) &&
    !isPreparingUnique(index) &&
    !hasTtl(index) &&
    !hasWildcardConfiguration(index) &&
    !hasNonSimpleCollation(index)
  );
}

function describeIndex(index) {
  return {
    name: index?.name || null,
    key: index?.key || {},
    unique: index?.unique === true,
    sparse: index?.sparse === true,
    partialFilterExpression: index?.partialFilterExpression ?? null,
    hidden: index?.hidden === true,
    prepareUnique: index?.prepareUnique === true,
    expireAfterSeconds: index?.expireAfterSeconds ?? null,
    wildcardProjection: index?.wildcardProjection ?? null,
    collation: index?.collation ?? null,
  };
}

function diagnostic(requirement, reason, code, actualIndex, message) {
  return {
    collection: collectionNameFor(requirement),
    label: requirement.label,
    key: requirement.key,
    unique: true,
    reason,
    code,
    actualIndex: actualIndex ? describeIndex(actualIndex) : null,
    message,
  };
}

function namedIndex(index) {
  return index?.name ? ` "${index.name}"` : "";
}

function checkDigestIndexReadiness(requirement, indexes) {
  const collection = collectionNameFor(requirement);
  const expectedKey = formatKey(requirement.key);
  const exactOrderedIndexes = indexes.filter((index) =>
    hasExactOrderedKey(index.key, requirement.key),
  );
  const malformedExactIndexes = exactOrderedIndexes.filter(
    (index) => !isFullyValidExactIndex(index),
  );
  const sameFieldSetNonExactIndexes = indexes.filter(
    (index) =>
      !hasExactOrderedKey(index.key, requirement.key) &&
      hasSameKeyFields(index.key, requirement.key),
  );
  const wrongOrderIndexes = sameFieldSetNonExactIndexes.filter((index) =>
    hasSameKeyDirections(index.key, requirement.key),
  );
  const wrongDirectionIndexes = sameFieldSetNonExactIndexes.filter(
    (index) => !hasSameKeyDirections(index.key, requirement.key),
  );
  const validExactIndex = exactOrderedIndexes.find(isFullyValidExactIndex);

  const exactIndexes = malformedExactIndexes;
  const hiddenIndex = exactIndexes.find(isHidden);
  if (hiddenIndex) {
    return diagnostic(
      requirement,
      "hidden",
      "INDEX_HIDDEN",
      hiddenIndex,
      `${requirement.label}: index${namedIndex(hiddenIndex)} on ${collection} has the expected ordered key ${expectedKey}, but hidden is true; expected a visible unique index.`,
    );
  }

  const preparingUniqueIndex = exactIndexes.find(isPreparingUnique);
  if (preparingUniqueIndex) {
    return diagnostic(
      requirement,
      "prepare-unique",
      "INDEX_PREPARE_UNIQUE",
      preparingUniqueIndex,
      `${requirement.label}: index${namedIndex(preparingUniqueIndex)} on ${collection} has the expected ordered key ${expectedKey}, but prepareUnique is true; expected a completed unique index.`,
    );
  }

  const ttlIndex = exactIndexes.find(hasTtl);
  if (ttlIndex) {
    return diagnostic(
      requirement,
      "ttl",
      "INDEX_TTL",
      ttlIndex,
      `${requirement.label}: index${namedIndex(ttlIndex)} on ${collection} has the expected ordered key ${expectedKey}, but expireAfterSeconds is set; expected a non-TTL unique index.`,
    );
  }

  const wildcardIndex = exactIndexes.find(hasWildcardConfiguration);
  if (wildcardIndex) {
    return diagnostic(
      requirement,
      "wildcard",
      "INDEX_WILDCARD",
      wildcardIndex,
      `${requirement.label}: index${namedIndex(wildcardIndex)} on ${collection} has the expected ordered key ${expectedKey}, but has wildcard configuration; expected a non-wildcard unique index.`,
    );
  }

  const partialIndex = exactIndexes.find(hasPartialFilter);
  if (partialIndex) {
    return diagnostic(
      requirement,
      "partial",
      "INDEX_PARTIAL_FILTER",
      partialIndex,
      `${requirement.label}: index${namedIndex(partialIndex)} on ${collection} has the expected ordered key ${expectedKey}, but has partialFilterExpression; expected a non-partial unique index.`,
    );
  }

  const sparseIndex = exactIndexes.find((index) => index?.sparse === true);
  if (sparseIndex) {
    return diagnostic(
      requirement,
      "sparse",
      "INDEX_SPARSE",
      sparseIndex,
      `${requirement.label}: index${namedIndex(sparseIndex)} on ${collection} has the expected ordered key ${expectedKey}, but sparse is true; expected sparse false or omitted on a unique index.`,
    );
  }

  const collatedIndex = exactIndexes.find(hasNonSimpleCollation);
  if (collatedIndex) {
    const locale = collatedIndex.collation?.locale ?? null;
    return diagnostic(
      requirement,
      "non-simple-collation",
      "INDEX_COLLATION_NOT_SIMPLE",
      collatedIndex,
      `${requirement.label}: index${namedIndex(collatedIndex)} on ${collection} has the expected ordered key ${expectedKey}, but collation locale is ${JSON.stringify(locale)}; expected collation omitted or locale "simple" on a unique index.`,
    );
  }

  const nonUniqueIndex = exactIndexes.find((index) => index?.unique !== true);
  if (nonUniqueIndex) {
    return diagnostic(
      requirement,
      "non-unique",
      "INDEX_NOT_UNIQUE",
      nonUniqueIndex,
      `${requirement.label}: index${namedIndex(nonUniqueIndex)} on ${collection} has the expected ordered key ${expectedKey}, but unique is not true; expected unique: true.`,
    );
  }

  const wrongOrderIndex = wrongOrderIndexes[0];
  if (wrongOrderIndex) {
    const actual = describeIndex(wrongOrderIndex);
    return diagnostic(
      requirement,
      "wrong-order",
      "INDEX_KEY_ORDER_MISMATCH",
      wrongOrderIndex,
      `${requirement.label}: index${namedIndex(wrongOrderIndex)} on ${collection} has key order ${formatKey(actual.key)}; expected exact order ${expectedKey} on a visible, completed, non-TTL, non-wildcard, non-partial, non-sparse unique index with simple or omitted collation.`,
    );
  }

  const wrongDirectionIndex = wrongDirectionIndexes[0];
  if (wrongDirectionIndex) {
    const actual = describeIndex(wrongDirectionIndex);
    return diagnostic(
      requirement,
      "wrong-direction",
      "INDEX_KEY_DIRECTION_MISMATCH",
      wrongDirectionIndex,
      `${requirement.label}: index${namedIndex(wrongDirectionIndex)} on ${collection} has key pattern ${formatKey(actual.key)}; expected exact directions and order ${expectedKey} on a visible, completed, non-TTL, non-wildcard, non-partial, non-sparse unique index with simple or omitted collation.`,
    );
  }

  if (validExactIndex) return null;

  return diagnostic(
    requirement,
    "missing",
    "INDEX_MISSING",
    null,
    `${requirement.label}: missing index on ${collection}; expected exact ordered key ${expectedKey} on a visible, completed, non-TTL, non-wildcard, non-partial, non-sparse unique index with simple or omitted collation.`,
  );
}

function isNamespaceNotFound(error) {
  return error?.codeName === "NamespaceNotFound" || Number(error?.code) === 26;
}

async function loadCollectionIndexes(model) {
  return model.collection.listIndexes().toArray();
}

async function getDigestIndexReadiness({
  requirements = REQUIRED_DIGEST_INDEXES,
  indexLoader = loadCollectionIndexes,
} = {}) {
  const byCollection = new Map();
  const diagnostics = [];

  for (const requirement of requirements) {
    const collection = collectionNameFor(requirement);
    if (!byCollection.has(collection)) {
      let indexes;
      try {
        indexes = await indexLoader(requirement.model, requirement);
      } catch (error) {
        if (!isNamespaceNotFound(error)) throw error;
        indexes = [];
      }
      if (!Array.isArray(indexes)) {
        throw new TypeError(
          `Digest index loader for ${collection} must return an array`,
        );
      }
      byCollection.set(collection, indexes);
    }

    const issue = checkDigestIndexReadiness(
      requirement,
      byCollection.get(collection),
    );
    if (issue) diagnostics.push(issue);
  }

  return {
    ready: diagnostics.length === 0,
    checked: requirements.length,
    missing: diagnostics,
    diagnostics,
  };
}

async function assertDigestIndexesReady(options) {
  const readiness = await getDigestIndexReadiness(options);
  if (!readiness.ready) {
    const error = new Error(
      `Digest indexes are not ready: ${readiness.diagnostics
        .map((item) => item.message)
        .join(" ")}`,
    );
    error.statusCode = 503;
    error.code = "DIGEST_INDEXES_NOT_READY";
    error.readiness = readiness;
    throw error;
  }
  return readiness;
}

export {
  REQUIRED_DIGEST_INDEXES,
  assertDigestIndexesReady,
  checkDigestIndexReadiness,
  getDigestIndexReadiness,
};
