// Creates the MongoDB indexes that startup asserts, for environments where
// Mongoose does not create them itself.
//
// src/config/db.js connects with `autoIndex: process.env.NODE_ENV !== "production"`,
// so indexes are created automatically in development and are expected to be
// "managed in prod". The readiness services only ever *assert* — they never
// create — and nothing in this repository created them either, so a production
// deploy of a feature that declares a new index could never reach readiness:
// bootstrap() throws DIGEST_INDEXES_NOT_READY, retries every 30 seconds, and
// /health stays 503 with background "initializing" forever, which also means the
// reminder, digest and automation schedulers never start.
//
// This script is that missing step. Run it once against the target database
// after deploying a change that adds an index requirement:
//
//   node src/maintenance/ensure-indexes.mjs
//
// It is idempotent, so running it when everything already exists is a no-op.
// Startup retries on a fixed delay, so a running instance recovers on its own
// within about 30 seconds of this completing; no restart is needed.
//
// It only ever creates the indexes the models declare. It never drops one --
// syncIndexes() would remove indexes absent from the schema, which is not a
// decision a deployment script should take unattended.

import "../config/load-env.js";

import mongoose from "mongoose";

import { REQUIRED_AUDIT_WORKING_PAPER_INDEXES } from "../services/audit-working-paper-index-readiness.service.js";
import { REQUIRED_CASE_INDEXES } from "../services/case-index-readiness.service.js";
import { REQUIRED_DIGEST_INDEXES } from "../services/digest-index-readiness.service.js";
import { REQUIRED_ENGAGEMENT_INDEXES } from "../services/engagement-index-readiness.service.js";

// Taking the model set from the same requirement lists startup asserts against
// keeps the two in step. A hand-maintained list here would drift the moment
// someone added a requirement, and the symptom of that drift is a deploy that
// cannot reach readiness.
const REQUIREMENT_GROUPS = [
  ["digest", REQUIRED_DIGEST_INDEXES],
  ["notice cases", REQUIRED_CASE_INDEXES],
  ["assurance engagements", REQUIRED_ENGAGEMENT_INDEXES],
  ["audit working papers", REQUIRED_AUDIT_WORKING_PAPER_INDEXES],
];

function collectModels() {
  const models = new Map();
  for (const [group, requirements] of REQUIREMENT_GROUPS) {
    if (!Array.isArray(requirements)) {
      throw new TypeError(`Requirement list for ${group} is not an array`);
    }
    for (const requirement of requirements) {
      const model = requirement?.model;
      const name = model?.collection?.collectionName;
      if (!model || !name) {
        throw new TypeError(
          `Requirement "${requirement?.label ?? "unlabelled"}" in ${group} has no usable model`,
        );
      }
      if (!models.has(name)) models.set(name, model);
    }
  }
  return [...models.entries()].sort(([a], [b]) => a.localeCompare(b));
}

async function indexNames(model) {
  try {
    const indexes = await model.collection.listIndexes().toArray();
    return indexes.map((index) => index.name).sort();
  } catch (error) {
    // A collection that does not exist yet has no indexes; createIndexes will
    // create both. Any other failure is real and must surface.
    if (error?.codeName === "NamespaceNotFound" || error?.code === 26)
      return [];
    throw error;
  }
}

async function main() {
  // Resolved before the environment is checked, so a malformed requirement list
  // is reported wherever this runs rather than only where a database is reachable.
  const models = collectModels();
  console.log(`ensure-indexes: ${models.length} collections to check`);
  for (const [name] of models) console.log(`  - ${name}`);

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error(
      "MONGODB_URI is not set. Run this from the application root so .env, " +
        "env.runtime or the host environment is loaded.",
    );
    process.exitCode = 1;
    return;
  }

  await mongoose.connect(uri, {
    autoIndex: false,
    connectTimeoutMS: 15000,
    serverSelectionTimeoutMS: 10000,
  });

  let created = 0;
  let failed = 0;
  try {
    for (const [name, model] of models) {
      const before = await indexNames(model);
      try {
        await model.createIndexes();
      } catch (error) {
        // A unique index cannot be built over existing duplicates. Report the
        // collection and carry on, so one bad collection does not hide the state
        // of the rest.
        failed += 1;
        console.error(`  ${name}: FAILED ${error?.message ?? error}`);
        continue;
      }
      const after = await indexNames(model);
      const added = after.filter((index) => !before.includes(index));
      created += added.length;
      console.log(
        added.length > 0
          ? `  ${name}: created ${added.join(", ")}`
          : `  ${name}: already current (${after.length} indexes)`,
      );
    }
  } finally {
    await mongoose.disconnect();
  }

  console.log(
    `ensure-indexes: ${created} created, ${failed} collections failed`,
  );
  if (failed > 0) process.exitCode = 1;
}

await main();
