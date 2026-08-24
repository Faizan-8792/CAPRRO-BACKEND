// L12 Verify bullets 3, 4 and 5 — the end-to-end that the contract test deliberately does not try
// to be.
//
//   node tests/firm-erasure-e2e.mjs
//
// The contract test seeds one minimal document per collection and asks "did each collection reach
// its classified end state?". That proves coverage. It does NOT prove that a real firm's
// identifying data is actually gone, because a minimal document contains nothing worth finding.
//
// So this seeds a realistic firm — clients with genuine-format PAN and GSTIN, audit working papers,
// a case, a TDS run, an import batch, activity events — and then does the thing that cannot be
// faked: scans EVERY collection in the database for the literal strings afterwards.
//
//   bullet 3  populate, erase, then grep the whole database for the identifying literals
//   bullet 4  compare the receipt's per-collection counts against direct queries
//   bullet 5  SIGKILL the cascade mid-run from a separate process, then resume
//
// Runs against the scratch replica set only; the guard below refuses anything else.

import mongoose from "mongoose";
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const mod = (...p) => pathToFileURL(join(repoRoot, ...p)).href;

process.env.NODE_ENV = "production";
process.env.JWT_SECRET = process.env.JWT_SECRET || "scratch-erasure-secret";
process.env.MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27118/scratch-erasure-e2e?replicaSet=rs0";

const dbName = process.env.MONGODB_URI.split("/").pop().split("?")[0];
if (!/scratch/i.test(dbName)) {
  console.error(`REFUSING TO RUN: database "${dbName}" is not a scratch database.`);
  process.exit(2);
}

const { PINNED_FIRM_SCOPED, STRATEGY, classify } = await import(
  mod("src", "services", "erasure-classification.js")
);
const { eraseFirm, getErasureReceipt } = await import(
  mod("src", "services", "firm-erasure.service.js")
);
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
const db = mongoose.connection.db;

// ------------------------------------------------------------------------------------------------
// The literals. Distinctive on purpose: a scan that hits a common substring proves nothing.
// ------------------------------------------------------------------------------------------------
const CA_EMAIL = "zt7-erasure-subject@zzq-example.invalid";
const CA_NAME = "Zyrelle Thackmore-Quint";
const CLIENT_NAME = "Vondrasek Polymers Private Limited";
const CLIENT_PAN = "AAQCV9182K";
const CLIENT_GSTIN = "27AAQCV9182K1ZQ";
const CLIENT_TAN = "MUMV19827E";
const DEDUCTEE_PAN = "BXQPT4471M";

// Identity of the chartered accountant. L9 point 6: statutory retention of work product is NOT a
// basis for keeping this forever, so these must be gone from EVERY collection, retained ones too.
const CA_IDENTITY = [CA_EMAIL, CA_NAME];
// Client work-product identifiers. Must be gone from PURGE collections. They may legitimately
// survive inside RETAIN collections, which is the whole point of RETAIN — reported, not asserted away.
const CLIENT_IDENTIFIERS = [CLIENT_NAME, CLIENT_PAN, CLIENT_GSTIN, CLIENT_TAN, DEDUCTEE_PAN];

const firmId = oid();
const otherFirmId = oid();
const caUserId = oid();
const clientId = oid();

console.log("=== seed a realistic firm ===");
{
  const ins = (name, doc) => mongoose.model(name).collection.insertOne({ firmId, ...doc });

  await mongoose.model("Firm").collection.insertOne({ _id: firmId, name: "Thackmore-Quint & Co" });
  await mongoose.model("User").collection.insertOne({
    _id: caUserId, firmId, email: CA_EMAIL, name: CA_NAME, role: "FIRM_ADMIN",
    tokenVersion: 3, isActive: true, phone: "+91 98200 11111",
  });
  await ins("FirmMembership", { userId: caUserId, status: "ACTIVE", role: "OWNER" });

  await ins("Client", {
    _id: clientId, name: CLIENT_NAME, pan: CLIENT_PAN, gstin: CLIENT_GSTIN, tan: CLIENT_TAN,
    ownerUserId: caUserId, entityType: "COMPANY",
  });

  const engagementId = oid();
  const workingPaperId = oid();
  await ins("Engagement", { _id: engagementId, clientId, title: `Statutory audit — ${CLIENT_NAME}` });
  await ins("AuditWorkingPaper", { _id: workingPaperId, engagementId, clientId, title: "Trade receivables" });
  await ins("AuditWorkingPaperRow", {
    workingPaperId, engagementId, clientId, rowKey: "TR-001",
    description: `Confirmation from ${CLIENT_NAME} (PAN ${CLIENT_PAN})`,
    observedValue: "1,20,00,000", createdBy: caUserId,
  });

  await ins("CaseMatter", { clientId, authority: "CIT(A) Mumbai", assessmentYear: "2024-25" });
  await ins("TdsHealthRun", { clientId, tan: CLIENT_TAN, deductedMinor: 100000 });
  await ins("TdsImportRow", { clientId, deducteePan: DEDUCTEE_PAN, amountMinor: 50000 });
  await ins("ImportBatch", {
    _id: oid(), clientId, kind: "GSTR2B", gstin: CLIENT_GSTIN, tan: CLIENT_TAN,
    sourceHash: "abc123", mapping: {}, sourceName: `${CLIENT_NAME} GSTR2B.csv`,
  });
  await ins("Task", { title: `File GSTR-3B for ${CLIENT_NAME}`, clientId });
  await ins("Reminder", { clientId, note: `Chase ${CLIENT_NAME} for PAN copy` });

  // Activity events: the interesting case. actorUserId is the link the cascade nulls, but Mixed
  // fields can carry the same identity in free-form form, which is exactly what a scan catches.
  await ins("ActivityEvent", {
    actorUserId: caUserId, source: "API", action: "client.create", entityType: "Client",
    entityId: String(clientId),
    beforeSummary: null,
    afterSummary: { name: CLIENT_NAME, pan: CLIENT_PAN },
    metadata: { actorEmail: CA_EMAIL, actorName: CA_NAME },
    occurredAt: new Date(),
  });

  // A second firm that must be entirely unaffected.
  await mongoose.model("User").collection.insertOne({
    _id: oid(), firmId: otherFirmId, email: "bystander@other.invalid", name: "Bystander", tokenVersion: 0,
  });
  await mongoose.model("Client").collection.insertOne({
    firmId: otherFirmId, name: CLIENT_NAME, pan: CLIENT_PAN, gstin: CLIENT_GSTIN, ownerUserId: oid(),
  });

  const seededCollections = (await db.listCollections().toArray()).length;
  console.log(`  seeded across ${seededCollections} collections, plus a second firm holding the same client literals`);
}

// ------------------------------------------------------------------------------------------------
// Scan every collection in the database for a literal. Reads documents and string-searches their
// JSON, so it finds a literal wherever it hides — including inside Mixed fields, nested objects and
// arrays, which a field-by-field query would miss.
// ------------------------------------------------------------------------------------------------
async function scanForLiterals(literals, { excludeOtherFirms = false } = {}) {
  const hits = [];
  for (const { name: coll } of await db.listCollections().toArray()) {
    for (const doc of await db.collection(coll).find({}).toArray()) {
      // A document owned by another firm is not this erasure's business. The bystander firm holds
      // the same client literals on purpose — that is the isolation evidence, not a leak.
      if (excludeOtherFirms && doc.firmId && String(doc.firmId) !== String(firmId)) continue;
      const blob = JSON.stringify(doc);
      for (const lit of literals) {
        if (blob.includes(lit)) hits.push({ coll, id: String(doc._id), literal: lit, firmId: doc.firmId ? String(doc.firmId) : null });
      }
    }
  }
  return hits;
}

console.log("");
console.log("=== before erasure the literals are findable (proving the scan works) ===");
{
  const before = await scanForLiterals([...CA_IDENTITY, ...CLIENT_IDENTIFIERS]);
  const collsHit = new Set(before.map((h) => h.coll));
  check(
    "SCAN-control",
    before.length > 0 && collsHit.size >= 5,
    `${before.length} hit(s) across ${collsHit.size} collections before the run — a clean scan afterwards means something`,
  );
  for (const lit of [...CA_IDENTITY, ...CLIENT_IDENTIFIERS]) {
    const n = before.filter((h) => h.literal === lit).length;
    if (n === 0) check(`SCAN-control:${lit.slice(0, 22)}`, false, "literal was never seeded — the later zero would be meaningless");
  }
}

console.log("");
console.log("=== run the erasure ===");
const receipt = await eraseFirm({
  operationId: "e2e-run",
  firmId,
  firmDisplayName: "Thackmore-Quint & Co",
  authorisedByUserId: oid(),
  requestReference: "GRIEVANCE-2026-0007",
});
check("E2E-status", receipt.status === "COMPLETED", `receipt status ${receipt.status}`);

console.log("");
console.log("=== bullet 3a: the CA's own identity is gone from EVERY collection ===");
{
  // No exclusion here, deliberately: the erased CA's name and email must not survive ANYWHERE,
  // including on a document that has since been detached from the firm.
  const hits = await scanForLiterals(CA_IDENTITY);
  check(
    "IDENTITY-erased-everywhere",
    hits.length === 0,
    hits.length === 0
      ? "zero hits for the erased user's name or email anywhere in the database, retained collections included"
      : `${hits.length} surviving hit(s): ${hits.slice(0, 6).map((h) => `${h.coll}.${h.id} (${h.literal})`).join("; ")}`,
  );
}

console.log("");
console.log("=== the retained audit trail keeps its skeleton but not its payload ===");
{
  const ev = await mongoose.model("ActivityEvent").collection.findOne({ firmId });
  check("AUDIT-event-survives", Boolean(ev), "the activity event itself is retained");
  check(
    "AUDIT-skeleton-kept",
    ev?.action === "client.create" && ev?.entityType === "Client" && Boolean(ev?.occurredAt),
    `action/entityType/occurredAt intact (${ev?.action}, ${ev?.entityType})`,
  );
  check("AUDIT-actor-cleared", ev?.actorUserId === null, "actorUserId cleared");
  check(
    "AUDIT-payload-cleared",
    ev?.beforeSummary === null && ev?.afterSummary === null && ev?.metadata?.payloadErased === true,
    "beforeSummary/afterSummary/metadata cleared and marked payloadErased",
  );
}

console.log("");
console.log("=== bullet 3b: client identifiers are gone from every PURGE collection ===");
{
  const purgeCollections = new Set(
    PINNED_FIRM_SCOPED.filter((n) => classify(n, { hasFirmId: true }).strategy === STRATEGY.PURGE)
      .map((n) => mongoose.model(n).collection.collectionName),
  );
  const hits = (await scanForLiterals(CLIENT_IDENTIFIERS, { excludeOtherFirms: true })).filter(
    (h) => purgeCollections.has(h.coll),
  );
  check(
    "PURGE-literals-gone",
    hits.length === 0,
    hits.length === 0
      ? `zero PAN/GSTIN/TAN/client-name hits across all ${purgeCollections.size} PURGE collections`
      : `${hits.length} surviving hit(s): ${hits.slice(0, 6).map((h) => `${h.coll} (${h.literal})`).join("; ")}`,
  );

  // No firm-scoped document may remain in a PURGE collection at all.
  let stragglers = [];
  for (const name of PINNED_FIRM_SCOPED) {
    if (classify(name, { hasFirmId: true }).strategy !== STRATEGY.PURGE) continue;
    const n = await mongoose.model(name).collection.countDocuments({ firmId });
    if (n > 0) stragglers.push(`${name}:${n}`);
  }
  check(
    "PURGE-empty",
    stragglers.length === 0,
    stragglers.length === 0 ? "no firm-scoped documents remain in any PURGE collection" : `remaining: ${stragglers.join(", ")}`,
  );
}

console.log("");
console.log("=== bullet 3c: RETAIN collections are intact ===");
{
  const retained = [];
  for (const name of PINNED_FIRM_SCOPED) {
    if (classify(name, { hasFirmId: true }).strategy !== STRATEGY.RETAIN) continue;
    const n = await mongoose.model(name).collection.countDocuments({ firmId });
    retained.push(`${name}:${n}`);
  }
  const wp = await mongoose.model("AuditWorkingPaperRow").collection.findOne({ firmId });
  check("RETAIN-intact", Boolean(wp), `working-paper row survives the erasure (${retained.join(", ")})`);
  check(
    "RETAIN-workproduct-kept",
    wp && String(wp.observedValue).includes("1,20,00,000"),
    "its audited figure is unchanged — retention means unchanged, not blanked",
  );
  // Honest reporting: the client identifiers deliberately DO survive here. That is what RETAIN
  // means, and stating it is better than a silent pass.
  const survivingClient = CLIENT_IDENTIFIERS.filter((l) => JSON.stringify(wp || {}).includes(l));
  console.log(
    `  NOTE  client identifiers still present in retained work product, by design: ${survivingClient.join(", ") || "none"}`,
  );
  console.log("        L9 point 6 governs the CA's own identity, asserted above; client work product is the statutory record.");
}

console.log("");
console.log("=== the other firm is untouched ===");
{
  const otherClient = await mongoose.model("Client").collection.findOne({ firmId: otherFirmId });
  const otherUser = await mongoose.model("User").collection.findOne({ firmId: otherFirmId });
  check("OTHER-firm-client", otherClient?.pan === CLIENT_PAN, "the other firm still holds the same PAN literal");
  check("OTHER-firm-user", otherUser?.email === "bystander@other.invalid", "the other firm's user is untouched");
}

console.log("");
console.log("=== bullet 4: the receipt's counts match direct queries ===");
{
  let mismatches = [];
  for (const step of receipt.steps) {
    const model = mongoose.model(step.collection);
    if (step.strategy === STRATEGY.RETAIN) {
      const actual = await model.collection.countDocuments({ firmId });
      if (actual !== step.affected) mismatches.push(`${step.collection}: receipt ${step.affected}, db ${actual}`);
    } else if (step.strategy === STRATEGY.PURGE) {
      const actual = await model.collection.countDocuments({ firmId });
      if (actual !== 0) mismatches.push(`${step.collection}: receipt purged ${step.affected} but ${actual} remain`);
    }
  }
  check(
    "RECEIPT-matches-db",
    mismatches.length === 0,
    mismatches.length === 0
      ? `all ${receipt.steps.length} per-collection counts reconcile against direct queries`
      : mismatches.join(" | "),
  );

  // The receipt must report what it observed, not what it planned. The planned Client purge count
  // is 1; if the row had already been gone, an honest receipt says 0.
  const clientStep = receipt.steps.find((s) => s.collection === "Client");
  check("RECEIPT-observed", clientStep?.affected === 1, `Client step reports the 1 document it actually deleted (${clientStep?.affected})`);
  check(
    "RECEIPT-no-identity",
    !CA_IDENTITY.concat(CLIENT_IDENTIFIERS).some((l) => JSON.stringify(receipt).includes(l)),
    "the receipt itself carries none of the erased literals",
  );
}

console.log("");
console.log("=== bullet 5: SIGKILL mid-cascade, then resume ===");
{
  const killFirmId = oid();
  // Seed enough that the cascade has real work to be interrupted in the middle of.
  for (const name of PINNED_FIRM_SCOPED) {
    const doc = { firmId: killFirmId };
    if (name === "User") { doc.email = `kill-${Math.random().toString(36).slice(2, 9)}@example.invalid`; doc.name = "Kill Test"; doc.tokenVersion = 0; }
    if (name === "ActivityEvent") doc.actorUserId = oid();
    if (name === "ErasureReceipt") { doc.operationId = `seed-kill-${Math.random().toString(36).slice(2, 9)}`; doc.status = "COMPLETED"; doc.steps = []; }
    await mongoose.model(name).collection.insertOne(doc);
  }

  const child = spawn(
    process.execPath,
    [join(here, "helpers", "erase-firm-child.mjs"), "e2e-killed", String(killFirmId), "120"],
    { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
  );

  let steps = 0;
  let killed = false;
  await new Promise((resolve) => {
    child.stdout.on("data", (buf) => {
      for (const line of String(buf).split("\n")) {
        if (!line.startsWith("STEP ")) continue;
        steps += 1;
        // Kill once it is genuinely mid-cascade — several steps done, many still to go.
        if (steps === 5 && !killed) {
          killed = true;
          child.kill("SIGKILL");
        }
      }
    });
    child.on("exit", (code, signal) => {
      console.log(`  child exited: code=${code} signal=${signal} after ${steps} step(s)`);
      resolve();
    });
  });

  check("KILL-was-signal", killed, `the child was SIGKILLed after ${steps} completed step(s), not asked to stop`);

  const partial = await getErasureReceipt("e2e-killed");
  const done = partial.steps.filter((s) => s.status === "COMPLETED").length;
  check(
    "KILL-partial-durable",
    done >= 1 && done < PINNED_FIRM_SCOPED.length,
    `${done}/${PINNED_FIRM_SCOPED.length} steps survived the kill as durably COMPLETED`,
  );
  check(
    "KILL-half-erased-visible",
    partial.status !== "COMPLETED",
    `status is ${partial.status} — a killed run does not read as finished`,
  );

  // A half-erased firm really does exist at this instant. That is the state the resume must clear.
  let leftBehind = 0;
  for (const name of PINNED_FIRM_SCOPED) {
    if (classify(name, { hasFirmId: true }).strategy !== STRATEGY.PURGE) continue;
    leftBehind += await mongoose.model(name).collection.countDocuments({ firmId: killFirmId });
  }
  check("KILL-really-partial", leftBehind > 0, `${leftBehind} purgeable document(s) still present mid-way — a genuine half-erased firm`);

  const resumed = await eraseFirm({ operationId: "e2e-killed", firmId: killFirmId });
  check("RESUME-completed", resumed.status === "COMPLETED", `resumed to ${resumed.status}`);

  let after = 0;
  for (const name of PINNED_FIRM_SCOPED) {
    if (classify(name, { hasFirmId: true }).strategy !== STRATEGY.PURGE) continue;
    after += await mongoose.model(name).collection.countDocuments({ firmId: killFirmId });
  }
  check("RESUME-no-half-erased-firm", after === 0, `${after} purgeable document(s) remain after resume (want 0)`);

  let receiptMismatch = [];
  for (const step of resumed.steps) {
    if (step.strategy !== STRATEGY.RETAIN) continue;
    const actual = await mongoose.model(step.collection).collection.countDocuments({ firmId: killFirmId });
    if (actual !== step.affected) receiptMismatch.push(`${step.collection}: ${step.affected} vs ${actual}`);
  }
  check(
    "RESUME-receipt-accurate",
    receiptMismatch.length === 0,
    receiptMismatch.length === 0 ? "the resumed receipt reconciles against the database" : receiptMismatch.join(" | "),
  );
  check("RESUME-attempts", resumed.attempts === 2, `the receipt records ${resumed.attempts} attempts, so the interruption is visible in the audit trail`);
}

console.log("");
console.log(`=== firm erasure e2e: ${pass} passed, ${fail} failed ===`);
if (failures.length) console.log(`  failed: ${failures.join(", ")}`);

await mongoose.connection.dropDatabase();
await mongoose.disconnect();
process.exit(fail === 0 ? 0 : 1);
