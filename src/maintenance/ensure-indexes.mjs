// Command-line wrapper around the index provisioning startup runs itself.
//
// Startup provisions these indexes automatically, so this is not normally needed.
// It exists for the cases where running it by hand is the right move: creating
// indexes ahead of a deploy so the new version reaches readiness immediately, or
// reporting which collection is refusing a unique index because it holds
// duplicates.
//
//   node src/maintenance/ensure-indexes.mjs
//
// Run it from the application root so .env, env.runtime or the host environment
// is loaded. It is idempotent, only ever creates what the models declare, and
// never drops an index.

import "../config/load-env.js";

import mongoose from "mongoose";

import {
  collectRequiredModels,
  ensureRequiredIndexes,
} from "../services/index-provisioning.service.js";

async function main() {
  // Resolved before the environment is checked, so a malformed requirement list
  // is reported wherever this runs rather than only where a database is reachable.
  const models = collectRequiredModels();
  console.log(`ensure-indexes: ${models.length} collections to check`);
  for (const [collection] of models) console.log(`  - ${collection}`);

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

  let summary;
  try {
    summary = await ensureRequiredIndexes();
  } finally {
    await mongoose.disconnect();
  }

  for (const entry of summary.created) {
    console.log(`  created ${entry.collection}.${entry.name}`);
  }
  for (const failure of summary.failures) {
    console.error(`  FAILED ${failure.collection}: ${failure.reason}`);
  }
  console.log(
    `ensure-indexes: checked ${summary.checked}, created ${summary.created.length}, failed ${summary.failures.length}`,
  );
  if (summary.failures.length > 0) process.exitCode = 1;
}

await main();
