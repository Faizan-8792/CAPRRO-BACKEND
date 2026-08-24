// Creates the MongoDB indexes that startup asserts.
//
// src/config/db.js connects with `autoIndex: process.env.NODE_ENV !== "production"`,
// so Mongoose creates indexes itself in development but not in production, where
// they were expected to be "managed in prod". The readiness services only ever
// assert -- they never create -- and nothing in this repository created them
// either. The consequence was a deploy that could never reach readiness: a
// feature declaring a new index shipped, bootstrap threw DIGEST_INDEXES_NOT_READY,
// retried every 30 seconds forever, and because startSchedulers runs after the
// assertion the reminder, digest and automation schedulers never started.
//
// Provisioning is therefore part of startup, immediately before the assertions
// that depend on it. It is deliberately create-only: syncIndexes() would drop
// indexes that are absent from the schema, which is not a decision a boot path
// should take unattended. It also never fails the boot -- the assertions that
// follow remain the authority on whether the database is actually ready, and they
// produce a precise error when it is not.

import { REQUIRED_AUDIT_WORKING_PAPER_INDEXES } from "./audit-working-paper-index-readiness.service.js";
import { REQUIRED_CASE_INDEXES } from "./case-index-readiness.service.js";
import { REQUIRED_DIGEST_INDEXES } from "./digest-index-readiness.service.js";
import { REQUIRED_ENGAGEMENT_INDEXES } from "./engagement-index-readiness.service.js";
import { REQUIRED_PROVIDER_USAGE_INDEXES } from "./provider-usage-index-readiness.service.js";
import { REQUIRED_GST_STORAGE_INDEXES } from "./gst-storage-readiness.service.js";

// Taking the model set from the same requirement lists startup asserts against
// keeps the two in step. A hand-maintained list would drift the moment a
// requirement was added, and the symptom of that drift is a deploy that cannot
// reach readiness.
//
// "providerUsage" is not gated behind a feature flag like the other three
// group names below it -- O10's per-user/monthly/global spend cap on DeepSeek
// and OCR.space applies unconditionally whenever either provider is called,
// so its unique index is provisioned every boot the same way "digest" is.
// Found missing entirely (in every environment, not just production) while
// closing out O10's live-database gates -- see
// provider-usage-index-readiness.service.js's header comment for the direct
// evidence.
const REQUIREMENT_GROUPS = Object.freeze([
  ["digest", REQUIRED_DIGEST_INDEXES],
  ["noticeCases", REQUIRED_CASE_INDEXES],
  ["assuranceEngagements", REQUIRED_ENGAGEMENT_INDEXES],
  ["auditWorkingPapers", REQUIRED_AUDIT_WORKING_PAPER_INDEXES],
  ["providerUsage", REQUIRED_PROVIDER_USAGE_INDEXES],
  // "gstStorage" is not flag-gated either. assertGstStorageIndexes refuses every import commit and
  // every reconciliation while these are missing, and with autoIndex off in production nothing
  // else would ever create them -- so a fresh deployment, or a restore into a new cluster, would
  // come up with GST permanently answering 503. See the export's own comment for the reproduction.
  ["gstStorage", REQUIRED_GST_STORAGE_INDEXES],
]);

function isNamespaceMissing(error) {
  return error?.codeName === "NamespaceNotFound" || error?.code === 26;
}

function collectRequiredModels(groups = REQUIREMENT_GROUPS) {
  const models = new Map();
  for (const [group, requirements] of groups) {
    if (!Array.isArray(requirements)) {
      throw new TypeError(`Requirement list for ${group} is not an array`);
    }
    for (const requirement of requirements) {
      const model = requirement?.model;
      const collection = model?.collection?.collectionName;
      if (!model || !collection) {
        throw new TypeError(
          `Requirement "${requirement?.label ?? "unlabelled"}" in ${group} has no usable model`,
        );
      }
      if (!models.has(collection)) models.set(collection, model);
    }
  }
  return [...models.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
}

async function readIndexNames(model) {
  try {
    const indexes = await model.collection.listIndexes().toArray();
    return indexes.map((index) => index.name).sort();
  } catch (error) {
    // A collection that does not exist yet simply has no indexes; createIndexes
    // will create both it and them. Anything else is real and must surface.
    if (isNamespaceMissing(error)) return [];
    throw error;
  }
}

async function ensureRequiredIndexes({ groups = REQUIREMENT_GROUPS } = {}) {
  const models = collectRequiredModels(groups);
  const created = [];
  const failures = [];

  for (const [collection, model] of models) {
    let before;
    try {
      before = await readIndexNames(model);
    } catch (error) {
      failures.push({ collection, reason: error?.message ?? String(error) });
      continue;
    }
    try {
      await model.createIndexes();
    } catch (error) {
      // A unique index cannot be built over existing duplicates. Record which
      // collection refused and carry on, so one bad collection does not hide the
      // state of the rest.
      failures.push({ collection, reason: error?.message ?? String(error) });
      continue;
    }
    try {
      const after = await readIndexNames(model);
      for (const name of after) {
        if (!before.includes(name)) created.push({ collection, name });
      }
    } catch (error) {
      failures.push({ collection, reason: error?.message ?? String(error) });
    }
  }

  return { checked: models.length, created, failures };
}

export {
  REQUIREMENT_GROUPS,
  collectRequiredModels,
  ensureRequiredIndexes,
  readIndexNames,
};
