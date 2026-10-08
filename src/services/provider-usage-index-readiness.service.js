// Declares the compound unique index ProviderUsage.reserveProviderCall (via
// tryIncrement's findOneAndUpdate-with-upsert) depends on for its atomicity
// guarantee, so it can be provisioned the same way the other collections in
// this codebase are: src/config/db.js disables Mongoose's autoIndex in
// production ("Index in dev, manage in prod"), and index-provisioning.service.js
// is what "manage in prod" actually means -- it walks REQUIREMENT_GROUPS and
// calls model.createIndexes() unconditionally at every boot, in every
// environment. Before this file existed, ProviderUsage was not a member of
// any REQUIREMENT_GROUPS entry, so in production its unique index on
// {userId, provider, periodKey} was NEVER created at all: autoIndex was off
// (by design, for prod) and nothing else ever asked Mongo to build it. Found
// live against a real MongoDB while closing out O10's gates: `db.providerusages
// .getIndexes()` on a freshly-connected, never-before-provisioned database
// showed only `_id_` and the schema's incidental single-field `userId_1` index
// (from `index: true` on the userId path) -- the compound unique index this
// whole feature's atomicity rests on was simply absent. Firing 20 concurrent
// callDeepSeek() calls at that database from one user already at cap-minus-1
// (see tests/provider-quota-contract.mjs Part E) let all 20 through: with no
// unique index to collide against, ProviderUsage.tryIncrement's upsert path
// never throws E11000, so every concurrent request independently inserts (or
// matches) its own row and is told "allowed". The per-request atomic $inc is
// real; without the index backing it, it has nothing to be atomic against.
import ProviderUsage from "../models/ProviderUsage.js";

const REQUIRED_PROVIDER_USAGE_INDEXES = Object.freeze([
  {
    model: ProviderUsage,
    label: "ProviderUsage per-user/provider/period uniqueness",
    key: { userId: 1, provider: 1, periodKey: 1 },
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
      `Provider-usage index requirement "${requirement.label || "unlabelled"}" has no collection`,
    );
  }
  return collection;
}

// Deliberately narrower than digest-index-readiness.service.js's exhaustive
// malformation checks (hidden / prepareUnique / TTL / wildcard / partial /
// sparse / collation) -- this is the one index this collection declares, it
// has none of those modifiers in the schema, and the failure mode this file
// exists to catch is strictly "does the unique index exist at all", which is
// the one that was actually found missing. A future edit that adds a modifier
// to the schema should extend this check to match, not silently pass it.
function isFullyValidExactIndex(index) {
  return index?.unique === true && index?.sparse !== true;
}

function isNamespaceNotFound(error) {
  return error?.codeName === "NamespaceNotFound" || Number(error?.code) === 26;
}

async function loadCollectionIndexes(model) {
  return model.collection.listIndexes().toArray();
}

async function getProviderUsageIndexReadiness({
  requirements = REQUIRED_PROVIDER_USAGE_INDEXES,
  indexLoader = loadCollectionIndexes,
} = {}) {
  const diagnostics = [];

  for (const requirement of requirements) {
    const collection = collectionNameFor(requirement);
    const expectedKey = formatKey(requirement.key);
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
    const validIndex = matching.find(isFullyValidExactIndex);

    if (!validIndex) {
      diagnostics.push({
        collection,
        label: requirement.label,
        key: requirement.key,
        unique: true,
        reason: matching.length ? "non-unique" : "missing",
        code: matching.length
          ? "INDEX_NOT_UNIQUE"
          : "INDEX_MISSING",
        message: matching.length
          ? `${requirement.label}: an index on ${collection} has key ${expectedKey} but is not unique; expected unique: true.`
          : `${requirement.label}: missing unique index on ${collection}; expected exact ordered key ${expectedKey}.`,
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

async function assertProviderUsageIndexesReady(options) {
  const readiness = await getProviderUsageIndexReadiness(options);
  if (!readiness.ready) {
    const error = new Error(
      `Provider-usage indexes are not ready: ${readiness.diagnostics
        .map((item) => item.message)
        .join(" ")}`,
    );
    error.statusCode = 503;
    error.code = "PROVIDER_USAGE_INDEXES_NOT_READY";
    error.readiness = readiness;
    throw error;
  }
  return readiness;
}

export {
  REQUIRED_PROVIDER_USAGE_INDEXES,
  assertProviderUsageIndexesReady,
  getProviderUsageIndexReadiness,
};
