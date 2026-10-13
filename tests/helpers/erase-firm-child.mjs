// Child process for the L12 interruption test.
//
//   node tests/helpers/erase-firm-child.mjs <operationId> <firmId> <stepDelayMs>
//
// Runs the real cascade, pausing after each step so the parent can SIGKILL this process while it is
// genuinely mid-cascade. That is the point: L12's Verify asks for a process kill, not a thrown
// exception. A `throw` unwinds cleanly and gives the code a chance to tidy up; SIGKILL does not,
// so whatever the receipt says afterwards is what actually survived on disk.
//
// Prints "STEP <n> <collection>" per completed step so the parent can wait for real progress rather
// than guessing with a timer.

import mongoose from "mongoose";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

const [operationId, firmId, delayRaw] = process.argv.slice(2);
const stepDelayMs = Number(delayRaw || 150);

if (!operationId || !firmId) {
  console.error("usage: erase-firm-child.mjs <operationId> <firmId> [stepDelayMs]");
  process.exit(2);
}

const uri = process.env.MONGODB_URI;
const dbName = (uri || "").split("/").pop().split("?")[0];
if (!/scratch/i.test(dbName)) {
  console.error(`REFUSING TO RUN: database "${dbName}" is not a scratch database.`);
  process.exit(2);
}

for (const f of readdirSync(join(repoRoot, "src", "models")).filter((x) => x.endsWith(".js"))) {
  await import(pathToFileURL(join(repoRoot, "src", "models", f)).href);
}
const { eraseFirm } = await import(
  pathToFileURL(join(repoRoot, "src", "services", "firm-erasure.service.js")).href
);

await mongoose.connect(uri);

let n = 0;
await eraseFirm({
  operationId,
  firmId: new mongoose.Types.ObjectId(firmId),
  onStepComplete: async (row) => {
    n += 1;
    // Unbuffered, so the parent sees progress before the kill lands.
    process.stdout.write(`STEP ${n} ${row.collectionName}\n`);
    await new Promise((r) => setTimeout(r, stepDelayMs));
  },
});

console.log("CHILD-COMPLETED");
await mongoose.disconnect();
