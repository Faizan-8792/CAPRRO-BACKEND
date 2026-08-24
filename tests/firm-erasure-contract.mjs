// L12 contract test: seed one document in EVERY firm-scoped collection, run the cascade, and
// assert each collection reached its classified end state.
//
//   node tests/firm-erasure-contract.mjs
//
// Runs against the scratch replica set (capro-mongo-rs, host port 27118) into a database whose name
// must contain "scratch". The guard below refuses anything else — this suite deletes data, and a
// mis-set MONGODB_URI is the one mistake that must never be survivable.

import assert from "node:assert/strict";
import mongoose from "mongoose";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const mod = (...p) => pathToFileURL(join(repoRoot, ...p)).href;

process.env.NODE_ENV = "production";
process.env.JWT_SECRET = process.env.JWT_SECRET || "scratch-erasure-secret";
process.env.MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27118/scratch-erasure?replicaSet=rs0";

const dbName = (process.env.MONGODB_URI.split("/").pop() || "").split("?")[0];
if (!/scratch/i.test(dbName)) {
  console.error(`REFUSING TO RUN: database name "${dbName}" is not a scratch database.`);
  process.exit(2);
}

const { PINNED_FIRM_SCOPED, STRATEGY, classify } = await import(
  mod("src", "services", "erasure-classification.js")
);
const { eraseFirm, buildErasurePlan, getErasureReceipt } = await import(
  mod("src", "services", "firm-erasure.service.js")
);

// Import every model file so mongoose has them all registered.
const { readdirSync } = await import("node:fs");
for (const f of readdirSync(join(repoRoot, "src", "models")).filter((x) => x.endsWith(".js"))) {
  await import(mod("src", "models", f));
}

await mongoose.connect(process.env.MONGODB_URI);
await mongoose.connection.dropDatabase();

let pass = 0;
let fail = 0;
const failures = [];
function check(id, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  PASS ${id}  ${detail}`);
  } else {
    fail += 1;
    failures.push(id);
    console.log(`  FAIL ${id}  ${detail}`);
  }
}

const oid = () => new mongoose.Types.ObjectId();
const firmA = oid();
const firmB = oid();

/**
 * Seed one document per firm-scoped collection, for BOTH firms. Writing directly through the
 * driver rather than the models: several schemas have required fields and append-only guards, and
 * this test is about the cascade's coverage, not about satisfying every unrelated validator.
 */
async function seed(firmId) {
  const seeded = {};
  for (const name of PINNED_FIRM_SCOPED) {
    const model = mongoose.model(name);
    const doc = { firmId, _seededBy: "firm-erasure-contract" };
    if (name === "User") {
      doc.email = `seed-${String(firmId).slice(-6)}-${Math.random().toString(36).slice(2, 8)}@example.invalid`;
      doc.name = "Seed User";
      doc.tokenVersion = 0;
    }
    if (name === "ActivityEvent") doc.actorUserId = oid();
    if (name === "ErasureReceipt") {
      doc.operationId = `seed-${String(firmId)}-${Math.random().toString(36).slice(2, 8)}`;
      doc.status = "COMPLETED";
      doc.steps = [];
    }
    const res = await model.collection.insertOne(doc);
    seeded[name] = res.insertedId;
  }
  return seeded;
}

// Verify bullet 2 requires THIS test to fail, naming the model, when a firm-scoped collection is
// added without a classification — not merely the standalone enumerator. So the contract test runs
// the coverage gate as part of itself. If the surface has drifted, nothing below is trustworthy
// anyway: the plan would be built from a stale list, and every assertion under it would be
// measuring the wrong set of collections.
console.log("=== coverage gate (Verify bullet 2) ===");
{
  const { spawnSync } = await import("node:child_process");
  const gate = spawnSync(
    process.execPath,
    [join(repoRoot, "tools", "enumerate-erasure-surface.mjs")],
    { encoding: "utf8" },
  );
  const out = `${gate.stdout || ""}${gate.stderr || ""}`;
  const added = out.match(/NEW firm-scoped model\(s\) not in the baseline: (.+)/);
  const removed = out.match(/model\(s\) in the baseline but no longer present: (.+)/);
  const unclassified = out.match(/^=== UNCLASSIFIED: (\d+) ===/m);
  const drifted = gate.status !== 0;

  check(
    "COVERAGE-gate",
    !drifted,
    drifted
      ? `erasure surface is not fully classified${added ? ` — unclassified/new: ${added[1].trim()}` : ""}${removed ? ` — retired: ${removed[1].trim()}` : ""}${unclassified ? ` — ${unclassified[1]} without a reason` : ""}`
      : "every firm-scoped collection is classified with a written reason",
  );

  if (drifted) {
    console.log("");
    console.log("  A firm-scoped collection with no classification means the cascade would either");
    console.log("  skip it or purge it by a default nobody chose. Refusing to run the rest of the");
    console.log("  contract against a surface that is already known to be wrong.");
    console.log("");
    console.log(
      `=== firm erasure contract: ABORTED — ${added ? `unclassified model(s): ${added[1].trim()}` : "erasure surface drift"} ===`,
    );
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    process.exit(1);
  }
}

console.log("");
console.log("=== plan ===");
const plan = buildErasurePlan();
const counts = plan.reduce((acc, r) => ({ ...acc, [r.strategy]: (acc[r.strategy] || 0) + 1 }), {});
console.log(`  ${plan.length} collections: ${JSON.stringify(counts)}`);
check(
  "PLAN-covers-surface",
  plan.length === PINNED_FIRM_SCOPED.length,
  `plan covers all ${PINNED_FIRM_SCOPED.length} pinned firm-scoped collections`,
);
check(
  "PLAN-order",
  plan.findIndex((r) => r.strategy === STRATEGY.PURGE) <
    plan.findIndex((r) => r.strategy === STRATEGY.PSEUDONYMISE),
  "PURGE steps are ordered before PSEUDONYMISE",
);
check(
  "PLAN-all-registered",
  plan.every((r) => r.registered),
  `every pinned collection resolves to a registered model (${plan.filter((r) => !r.registered).map((r) => r.collectionName).join(", ") || "none missing"})`,
);

console.log("");
console.log("=== seed both firms ===");
const seededA = await seed(firmA);
const seededB = await seed(firmB);
console.log(
  `  firm A: ${Object.keys(seededA).length} collections | firm B: ${Object.keys(seededB).length} collections`,
);

console.log("");
console.log("=== run the cascade on firm A ===");
const receipt = await eraseFirm({
  operationId: "contract-run-1",
  firmId: firmA,
  firmDisplayName: "Contract Firm A",
  authorisedByUserId: oid(),
  requestReference: "TICKET-CONTRACT-1",
});
check("RUN-status", receipt.status === "COMPLETED", `receipt status ${receipt.status}`);
check(
  "RUN-all-steps",
  receipt.steps.length === PINNED_FIRM_SCOPED.length && receipt.steps.every((s) => s.status === "COMPLETED"),
  `${receipt.steps.filter((s) => s.status === "COMPLETED").length}/${receipt.steps.length} steps COMPLETED`,
);

console.log("");
console.log("=== each collection reached its classified end state ===");
for (const name of PINNED_FIRM_SCOPED) {
  const model = mongoose.model(name);
  const { strategy } = classify(name, { hasFirmId: true });
  // Assert on the seeded document by _id, not on a { firmId } count. Two collections legitimately
  // move off the firm: the User tombstone nulls firmId, and the cascade writes its own
  // ErasureReceipt for this firm alongside the seeded one. A count would score both wrong.
  const alive = await model.collection.countDocuments({ _id: seededA[name] });

  if (strategy === STRATEGY.PURGE) {
    check(`PURGE:${name}`, alive === 0, `seeded document ${alive ? "still present" : "deleted"} (want deleted)`);
  } else if (strategy === STRATEGY.RETAIN) {
    check(`RETAIN:${name}`, alive === 1, `seeded document ${alive ? "retained" : "MISSING"} (want retained)`);
  } else if (strategy === STRATEGY.PSEUDONYMISE) {
    check(`KEPT:${name}`, alive === 1, `seeded row ${alive ? "survives" : "was DELETED"} (want survives)`);
  }
}

console.log("");
console.log("=== identity is actually gone, not merely 'kept' ===");
{
  const User = mongoose.model("User");
  const tombstoned = await User.collection.findOne({ _id: seededA.User });
  check(
    "PSEUDO-user-detached",
    tombstoned?.firmId === null,
    "the erased firm is no longer the account's active workspace",
  );
  check(
    "PSEUDO-user-email",
    Boolean(tombstoned) && /^erased-[0-9a-f]{24}@erased\.invalid$/i.test(tombstoned.email),
    `user email is a per-account tombstone (${tombstoned ? tombstoned.email : "no user found"})`,
  );
  check("PSEUDO-user-name", tombstoned?.name === "Erased account", `name is "${tombstoned?.name}"`);
  check("PSEUDO-user-inactive", tombstoned?.isActive === false, "account deactivated");
  check(
    "PSEUDO-user-sessions",
    (tombstoned?.tokenVersion ?? 0) >= 1,
    `tokenVersion bumped to ${tombstoned?.tokenVersion} so existing JWTs stop validating`,
  );

  const AE = mongoose.model("ActivityEvent");
  const ev = await AE.collection.findOne({ _id: seededA.ActivityEvent });
  check("PSEUDO-activity-kept", Boolean(ev), "the audit event itself survives");
  check(
    "PSEUDO-activity-actor",
    ev && ev.actorUserId === null,
    `actorUserId is ${ev ? JSON.stringify(ev.actorUserId) : "n/a"} (want null)`,
  );
}

console.log("");
console.log("=== rejectMutation collections were handled, not silently skipped ===");
for (const name of ["ActivityEvent", "AuditWorkingPaperRow", "CaseAnalysis", "CaseSubmission", "CaseTimelineEvent"]) {
  const step = receipt.steps.find((s) => s.collection === name);
  check(
    `GUARDED:${name}`,
    step && step.status === "COMPLETED",
    `step present and COMPLETED (strategy ${step?.strategy})`,
  );
}

console.log("");
console.log("=== firm B is untouched ===");
{
  let intact = 0;
  for (const name of PINNED_FIRM_SCOPED) {
    const n = await mongoose.model(name).collection.countDocuments({ firmId: firmB });
    if (n === 1) intact += 1;
  }
  check(
    "ISOLATION",
    intact === PINNED_FIRM_SCOPED.length,
    `${intact}/${PINNED_FIRM_SCOPED.length} of firm B's collections still hold their document`,
  );
}

console.log("");
console.log("=== idempotency: running the same operation again changes nothing ===");
{
  const User = mongoose.model("User");
  const before = await User.collection.findOne({ email: /^erased-/ });
  const again = await eraseFirm({ operationId: "contract-run-1", firmId: firmA });
  const after = await User.collection.findOne({ email: /^erased-/ });
  check("IDEMPOTENT-status", again.status === "COMPLETED", `second run status ${again.status}`);
  check("IDEMPOTENT-attempts", again.attempts === 2, `attempts recorded as ${again.attempts}`);
  check(
    "IDEMPOTENT-no-rewrite",
    before?.tokenVersion === after?.tokenVersion,
    `tokenVersion unchanged on the second run (${before?.tokenVersion} -> ${after?.tokenVersion})`,
  );
}

console.log("");
console.log("=== a reused operationId against a DIFFERENT firm is refused ===");
{
  let code = null;
  try {
    await eraseFirm({ operationId: "contract-run-1", firmId: firmB });
  } catch (e) {
    code = e.code;
  }
  check("CONFLICT", code === "ERASURE_OPERATION_ID_CONFLICT", `refused with ${code}`);
  const n = await mongoose.model("Task").collection.countDocuments({ firmId: firmB });
  check("CONFLICT-no-damage", n === 1, `firm B's Task row still present (${n})`);
}

console.log("");
console.log("=== interruption: a run that dies midway resumes to the correct end state ===");
{
  const firmC = oid();
  await seed(firmC);

  // Kill the cascade after the 4th step, the way a process death would: the receipt keeps whatever
  // was durably recorded, and nothing rolls back.
  let killedAfter = 0;
  let thrown = null;
  try {
    await eraseFirm({
      operationId: "contract-interrupted",
      firmId: firmC,
      onStepComplete: async () => {
        killedAfter += 1;
        if (killedAfter === 4) {
          const e = new Error("simulated process kill");
          e.code = "SIMULATED_KILL";
          throw e;
        }
      },
    });
  } catch (e) {
    thrown = e.code;
  }
  check("INTERRUPT-stopped", thrown === "SIMULATED_KILL", `cascade aborted with ${thrown}`);

  const partial = await getErasureReceipt("contract-interrupted");
  const done = partial.steps.filter((s) => s.status === "COMPLETED").length;
  check(
    "INTERRUPT-partial-recorded",
    done > 0 && done < PINNED_FIRM_SCOPED.length,
    `${done}/${PINNED_FIRM_SCOPED.length} steps durably recorded as COMPLETED — a real partial state`,
  );
  check(
    "INTERRUPT-not-claimed-complete",
    partial.status !== "COMPLETED",
    `status is ${partial.status}, so the partial run does not masquerade as finished`,
  );

  // Resume with the same operationId.
  const resumed = await eraseFirm({ operationId: "contract-interrupted", firmId: firmC });
  check("RESUME-status", resumed.status === "COMPLETED", `resumed run status ${resumed.status}`);
  check(
    "RESUME-all-steps",
    resumed.steps.every((s) => s.status === "COMPLETED"),
    `${resumed.steps.filter((s) => s.status === "COMPLETED").length}/${resumed.steps.length} steps COMPLETED after resume`,
  );

  let leftovers = 0;
  for (const name of PINNED_FIRM_SCOPED) {
    const { strategy } = classify(name, { hasFirmId: true });
    if (strategy !== STRATEGY.PURGE) continue;
    leftovers += await mongoose.model(name).collection.countDocuments({ firmId: firmC });
  }
  check(
    "RESUME-end-state",
    leftovers === 0,
    `${leftovers} purgeable document(s) remain for the interrupted firm (want 0)`,
  );
}

console.log("");
console.log("=== an account that still works elsewhere is detached, not erased ===");
{
  const User = mongoose.model("User");
  const FirmMembership = mongoose.model("FirmMembership");
  const firmD = oid(); // erased
  const firmE = oid(); // the person's other firm, untouched
  await seed(firmD);

  // solo: exists only inside the erased firm.
  const solo = oid();
  await User.collection.insertOne({
    _id: solo, firmId: firmD, email: "solo@example.invalid", name: "Solo Member", tokenVersion: 0, isActive: true,
  });
  await FirmMembership.collection.insertOne({ firmId: firmD, userId: solo, status: "ACTIVE" });

  // shared: active in the erased firm AND in another firm.
  const shared = oid();
  await User.collection.insertOne({
    _id: shared, firmId: firmD, email: "shared@example.invalid", name: "Shared Member", tokenVersion: 0, isActive: true,
  });
  await FirmMembership.collection.insertOne({ firmId: firmD, userId: shared, status: "ACTIVE" });
  await FirmMembership.collection.insertOne({ firmId: firmE, userId: shared, status: "ACTIVE" });

  // stale: their only other membership was already REMOVED, so it is history, not participation.
  const stale = oid();
  await User.collection.insertOne({
    _id: stale, firmId: firmD, email: "stale@example.invalid", name: "Stale Member", tokenVersion: 0, isActive: true,
  });
  await FirmMembership.collection.insertOne({ firmId: firmD, userId: stale, status: "ACTIVE" });
  await FirmMembership.collection.insertOne({ firmId: firmE, userId: stale, status: "REMOVED" });

  await eraseFirm({ operationId: "contract-multifirm", firmId: firmD });

  const s1 = await User.collection.findOne({ _id: solo });
  check("MULTIFIRM-solo-erased", /^erased-/.test(s1.email), `solo account tombstoned (${s1.email})`);

  const s2 = await User.collection.findOne({ _id: shared });
  check(
    "MULTIFIRM-shared-kept",
    s2.email === "shared@example.invalid" && s2.name === "Shared Member",
    `account active in another firm keeps its identity (${s2.email})`,
  );
  check("MULTIFIRM-shared-detached", s2.firmId === null, "...but is detached from the erased firm");
  check(
    "MULTIFIRM-shared-usable",
    s2.isActive === true && s2.tokenVersion === 0,
    "...and is not signed out or deactivated",
  );

  const s3 = await User.collection.findOne({ _id: stale });
  check(
    "MULTIFIRM-stale-erased",
    /^erased-/.test(s3.email),
    "a REMOVED membership elsewhere is history, not participation, so the account is erased",
  );

  const survivors = await FirmMembership.collection.countDocuments({ firmId: firmE });
  check("MULTIFIRM-other-firm-intact", survivors === 2, `firm E's ${survivors} membership row(s) untouched`);
}

console.log("");
console.log("=== receipt content ===");
{
  const r = await getErasureReceipt("contract-run-1");
  check("RECEIPT-op", r.operationId === "contract-run-1", `operationId ${r.operationId}`);
  check("RECEIPT-firm", r.firmId === String(firmA), "target firm recorded");
  check("RECEIPT-ref", r.requestReference === "TICKET-CONTRACT-1", "written-request reference recorded");
  check("RECEIPT-authoriser", Boolean(r.authorisedByUserId), "authorising super admin recorded");
  check(
    "RECEIPT-totals",
    r.totals.collections === PINNED_FIRM_SCOPED.length && r.totals.purgedDocuments > 0,
    `${r.totals.collections} collections, ${r.totals.purgedDocuments} purged, ${r.totals.pseudonymisedDocuments} pseudonymised, ${r.totals.retainedDocuments} retained`,
  );
  const blob = JSON.stringify(r);
  check(
    "RECEIPT-no-identity",
    !/@example\.invalid/.test(blob) && !/Seed User/.test(blob),
    "the receipt carries no seeded email or name — it proves the erasure without preserving what was erased",
  );
}

console.log("");
console.log(`=== firm erasure contract: ${pass} passed, ${fail} failed ===`);
if (failures.length) console.log(`  failed: ${failures.join(", ")}`);

await mongoose.connection.dropDatabase();
await mongoose.disconnect();
process.exit(fail === 0 ? 0 : 1);
