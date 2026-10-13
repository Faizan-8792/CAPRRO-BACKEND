// Declares the indexes the Emails page (IMPROVEMENT-PLAN-V2-2026-09-28 Part 1)
// and the Resend webhook depend on. The date filter is the page's primary axis,
// and the webhook joins on providerMessageId — that one MUST be unique-sparse,
// because a send blocked before reaching the provider leaves a row with a null
// provider id and two such rows must not collide.
import EmailDelivery from "../models/EmailDelivery.js";
import EmailSuppression from "../models/EmailSuppression.js";

const REQUIRED_EMAIL_INDEXES = Object.freeze([
  {
    model: EmailDelivery,
    label: "EmailDelivery provider message id uniqueness (sparse)",
    key: { providerMessageId: 1 },
    unique: true,
    sparse: true,
  },
  {
    model: EmailDelivery,
    label: "EmailDelivery date filter (sentAt descending)",
    key: { sentAt: -1 },
    unique: false,
  },
  {
    model: EmailDelivery,
    label: "EmailDelivery type + date filter",
    key: { type: 1, sentAt: -1 },
    unique: false,
  },
  {
    model: EmailDelivery,
    label: "EmailDelivery firm + date filter",
    key: { firmId: 1, sentAt: -1 },
    unique: false,
  },
  {
    model: EmailSuppression,
    label: "EmailSuppression address hash uniqueness",
    key: { emailHash: 1 },
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

async function getEmailIndexReadiness({
  requirements = REQUIRED_EMAIL_INDEXES,
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
      (index) =>
        Boolean(index?.unique) === Boolean(requirement.unique) &&
        (requirement.sparse ? index?.sparse === true : true),
    );

    if (!validIndex) {
      diagnostics.push({
        collection,
        label: requirement.label,
        key: requirement.key,
        reason: matching.length ? "wrong options" : "missing",
        code: matching.length ? "INDEX_WRONG_OPTIONS" : "INDEX_MISSING",
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

async function assertEmailIndexesReady(options) {
  const readiness = await getEmailIndexReadiness(options);
  if (!readiness.ready) {
    const error = new Error(
      `Email indexes are not ready: ${readiness.diagnostics
        .map((item) => item.label)
        .join(" ")}`,
    );
    error.statusCode = 503;
    error.code = "EMAIL_INDEXES_NOT_READY";
    error.readiness = readiness;
    throw error;
  }
  return readiness;
}

export {
  REQUIRED_EMAIL_INDEXES,
  assertEmailIndexesReady,
  getEmailIndexReadiness,
};
