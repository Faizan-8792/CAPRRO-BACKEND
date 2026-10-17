// tests/pack-working-paper-contract.mjs
//
// W10 AP36 (2026-10-17). A confirmed pack row lands as a working-paper row, and nothing unconfirmed does:
// the gate is the route contract, through the real Express app on a scratch replica-set database. The
// engagement and the working paper are created through their own real routes, so the documents the pack
// row lands in are the ones the product makes.
//
// The assertions:
//   the CONFIRMED row lands once and replays idempotently; description, amount, the observed lines, the
//     decision's preparer and date and the rule that fired are all on the row;
//   the engagement's clause checklist item moves OPEN -> IN_PROGRESS with the pack row as evidence, and
//     no checklist item ever moves to COMPLETE by itself;
//   the COMPUTED and the EXCLUDED rows are refused 409 AUDIT_PACK_ROW_NOT_CONFIRMED and nothing is written;
//   a pack run of another firm reads 404; a run of another client of the same firm is refused 409;
//   the fields the pack fills cannot be sent beside packRow (400); the revision fence still bites (409).
//
// Needs the replica set: MONGODB_URI, set by tools/run-gates.ps1 (replica-set suite list); by hand with
// mongodb://127.0.0.1:27118/scratch-gates-pack-wp?replicaSet=rs0. Refuses a non-scratch, non-loopback
// database, and drops its own database when done.

import assert from "node:assert/strict";

const DEFAULT_URI = "mongodb://127.0.0.1:27118/scratch-gates-pack-wp?replicaSet=rs0";
const uri = process.env.MONGODB_URI || DEFAULT_URI;
process.env.MONGODB_URI = uri; // the app import requires it, even when we defaulted it
const dbName = (uri.split("/").pop() || "").split("?")[0];
const host = (uri.split("//")[1] || "").split("/")[0];
if (!/scratch/i.test(dbName) || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
  console.error(`REFUSING TO RUN: ${host}/${dbName} is not a loopback scratch database.`);
  process.exitCode = 1;
} else {
  process.env.NODE_ENV = "production";
  process.env.JWT_SECRET = process.env.JWT_SECRET || "scratch-only-secret-not-a-real-credential-0000";
  process.env.DEEPSEEK_API_KEY = "";
  process.env.OCR_SPACE_API_KEY = "";

  const { default: app } = await import("../src/app.js");
  const jwt = (await import("jsonwebtoken")).default;
  const mongoose2 = (await import("mongoose")).default;
  await mongoose2.connect(uri, { serverSelectionTimeoutMS: 20000 });
  await mongoose2.connection.dropDatabase();
  const { ensureRequiredIndexes } = await import("../src/services/index-provisioning.service.js");
  await ensureRequiredIndexes();

  const raw = (name) => mongoose2.connection.collection(name);
  const oid = () => new mongoose2.Types.ObjectId();
  const now = new Date();
  let passed = 0;
  let failed = 0;
  const check = async (name, fn) => {
    try {
      await fn();
      passed += 1;
      console.log(`[PASS] ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`[FAIL] ${name}: ${String(error.message).split("\n")[0]}`);
    }
  };

  const ownerId = oid();
  const reviewerId = oid();
  const firmId = oid();
  const clientId = oid();
  const otherFirmId = oid();
  const otherClientId = oid();
  const mkUser = (id, tag) => raw("users").insertOne({ _id: id, email: `${tag}@scratch.test`, name: `User ${tag}`, role: "FIRM_ADMIN", accountType: "FIRM_USER", isActive: true, tokenVersion: 0, firmId, createdAt: now, updatedAt: now });
  await mkUser(ownerId, "owner-packwp");
  await mkUser(reviewerId, "reviewer-packwp");
  await raw("firms").insertOne({ _id: firmId, name: "Pack WP Firm", displayName: "Pack WP Firm", handle: "scratch-pack-wp", ownerId, ownerUserId: ownerId, type: "FIRM", isActive: true, joinCode: "JPCKWP1", createdAt: now, updatedAt: now });
  await raw("firmmemberships").insertMany([
    { _id: oid(), firmId, userId: ownerId, status: "ACTIVE", role: "OWNER", memberAccess: "FULL", createdAt: now, updatedAt: now },
    { _id: oid(), firmId, userId: reviewerId, status: "ACTIVE", role: "FIRM_ADMIN", memberAccess: "FULL", createdAt: now, updatedAt: now },
  ]);
  await raw("clients").insertOne({ _id: clientId, firmId, name: "Pack WP Client", isActive: true, createdAt: now, updatedAt: now });
  await raw("appconfigs").insertOne({ _id: "singleton", featureFlags: { auditPacks: true, auditWorkingPapers: true, assuranceEngagements: true }, createdAt: now, updatedAt: now });
  // Another firm whose pack run must read 404.
  const otherOwnerId = oid();
  await raw("users").insertOne({ _id: otherOwnerId, email: "other-packwp@scratch.test", name: "Other", role: "FIRM_ADMIN", accountType: "FIRM_USER", isActive: true, tokenVersion: 0, firmId: otherFirmId, createdAt: now, updatedAt: now });
  await raw("firms").insertOne({ _id: otherFirmId, name: "Other Firm", displayName: "Other Firm", handle: "scratch-pack-wp-o", ownerId: otherOwnerId, ownerUserId: otherOwnerId, type: "FIRM", isActive: true, joinCode: "JPCKWP2", createdAt: now, updatedAt: now });
  await raw("firmmemberships").insertOne({ _id: oid(), firmId: otherFirmId, userId: otherOwnerId, status: "ACTIVE", role: "OWNER", memberAccess: "FULL", createdAt: now, updatedAt: now });
  await raw("clients").insertOne({ _id: otherClientId, firmId, name: "Pack WP Client Two", isActive: true, createdAt: now, updatedAt: now });

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const token = jwt.sign({ id: ownerId, email: "owner-packwp@scratch.test", role: "FIRM_ADMIN", accountType: "FIRM_USER", firmId, isActive: true, tv: 0 }, process.env.JWT_SECRET, { expiresIn: "30m" });
  const reviewerToken = jwt.sign({ id: reviewerId, email: "reviewer-packwp@scratch.test", role: "FIRM_ADMIN", accountType: "FIRM_USER", firmId, isActive: true, tv: 0 }, process.env.JWT_SECRET, { expiresIn: "30m" });
  const callAs = async (tok, method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  };
  const call = async (method, path, body) => callAs(token, method, path, body);

  // The engagement and the working paper, through their own real routes.
  const engagementReply = await call("POST", "/api/engagements", {
    mutationKey: "seed-engagement-1",
    clientId: String(clientId),
    engagementType: "TAX_AUDIT",
    reviewerUserId: String(reviewerId),
    scope: "Statutory audit under section 44AB for FY 2025-26.",
    startDate: "2026-04-01",
    targetDate: "2026-10-15",
  });
  const engagementId = engagementReply.json?.engagement?.id || engagementReply.json?.engagement?._id;
  // Working-paper work needs the assigned reviewer's template attestation - the reviewer's own token.
  const attest = await callAs(reviewerToken, "POST", `/api/engagements/${engagementId}/review`, {
    mutationKey: "seed-attest-1",
    action: "ATTEST_TEMPLATE",
    expectedRevision: engagementReply.json?.engagement?.revision ?? 1,
    reviewerName: "Reviewer Pack WP",
    confirmed: true,
    credentialReference: "SCRATCH-MEMBER-00000",
  });
  if (attest.status !== 200 && attest.status !== 201) {
    console.error(`[SEED] attestation failed: ${attest.status} ${JSON.stringify(attest.json)?.slice(0, 200)}`);
  }
  const paperReply = await call("POST", "/api/engagements/working-papers", {
    mutationKey: "seed-paper-1",
    engagementId: String(engagementId),
    title: "Clause 22 working",
    purpose: "The clause 22 pack's confirmed rows, carried into the file.",
    period: "FY 2025-26",
  });
  const paperId = paperReply.json?.paper?.id || paperReply.json?.paper?._id;

  // The pack run under test: REVIEW, three rows - confirmed, computed, excluded.
  const runId = oid();
  const confirmedKey = "a".repeat(64);
  const computedKey = "b".repeat(64);
  const excludedKey = "c".repeat(64);
  const packRow = (key, label, state, decision) => ({
    _id: oid(), firmId, runId, generationAttempt: 1, ordinal: 1, rowKey: key, section: "MSME_LATE",
    label, party: null, decidable: true, state,
    values: {
      amountMinor: 12_500_000,
      supplier: label,
      lines: [
        { label: "Supplier", value: label, kind: "text" },
        { label: "Bill amount", value: 12_500_000, kind: "money" },
      ],
      choices: [{ value: "REPORT", label: "Report it" }],
    },
    ruleHits: [{ rule: "PAID_BEYOND_APPOINTED_TIME", threshold: 45, detail: "Paid after the appointed time." }],
    decision: decision || { version: 0 },
    sourceRows: [], sourceEvidenceCount: 0, sourceEvidenceHash: "d".repeat(64),
    createdAt: now, updatedAt: now,
  });
  await raw("auditpackruns").insertOne({
    _id: runId, firmId, clientId, kind: "CLAUSE22", financialYear: "2025-26", status: "REVIEW",
    activeGenerationAttempt: 1, generationAttempt: 1, ruleVersion: "clause22-v1", rowCount: 3,
    sourceBatches: [], sourceFingerprint: "fp-pack-wp", summary: { provisional: false, reasons: [], totals: {}, counts: {} },
    createdAt: now, updatedAt: now,
  });
  await raw("auditpackrows").insertMany([
    packRow(confirmedKey, "Sharma: bill SHARMA-11", "CONFIRMED", { version: 1, state: "CONFIRMED", choice: "REPORT", decidedBy: ownerId, decidedAt: new Date("2026-01-05T10:00:00Z"), reason: "Past the appointed time.", note: "Seen on the ledger." }),
    packRow(computedKey, "Sharma: bill SHARMA-12", "COMPUTED"),
    packRow(excludedKey, "Sharma: bill SHARMA-13", "EXCLUDED", { version: 1, state: "EXCLUDED", reason: "Not a due.", decidedBy: ownerId, decidedAt: now }),
  ]);
  const foreignRunId = oid();
  await raw("auditpackruns").insertOne({ _id: foreignRunId, firmId: otherFirmId, clientId: otherClientId, kind: "CLAUSE22", financialYear: "2025-26", status: "REVIEW", activeGenerationAttempt: 1, generationAttempt: 1, ruleVersion: "clause22-v1", rowCount: 1, sourceBatches: [], sourceFingerprint: "fp-other", summary: { provisional: false, reasons: [], totals: {}, counts: {} }, createdAt: now, updatedAt: now });
  await raw("auditpackrows").insertMany([packRow(confirmedKey, "Other firm's row", "CONFIRMED", { version: 1, state: "CONFIRMED", choice: "REPORT", decidedBy: otherOwnerId, decidedAt: now })].map((r) => ({ ...r, _id: oid(), firmId: otherFirmId, runId: foreignRunId })));
  const otherClientRunId = oid();
  await raw("auditpackruns").insertOne({ _id: otherClientRunId, firmId, clientId: otherClientId, kind: "CLAUSE22", financialYear: "2025-26", status: "REVIEW", activeGenerationAttempt: 1, generationAttempt: 1, ruleVersion: "clause22-v1", rowCount: 1, sourceBatches: [], sourceFingerprint: "fp-other-client", summary: { provisional: false, reasons: [], totals: {}, counts: {} }, createdAt: now, updatedAt: now });
  await raw("auditpackrows").insertMany([packRow(confirmedKey, "Other client's row", "CONFIRMED", { version: 1, state: "CONFIRMED", choice: "REPORT", decidedBy: ownerId, decidedAt: now })].map((r) => ({ ...r, _id: oid(), runId: otherClientRunId })));

  const addRow = (body) => call("POST", `/api/engagements/working-papers/${paperId}/rows`, body);
  const engagementDoc = () => raw("engagements").findOne({ _id: new mongoose2.Types.ObjectId(engagementId) });
  const wpRowCount = async () => raw("auditworkingpaperrows").countDocuments({ firmId, workingPaperId: new mongoose2.Types.ObjectId(paperId) });

  let revision = 1; // a working paper is born at revision 1
  let landedRowKey = "";
  let originalRequest = null;

  await check("the engagement and the working paper were created by their own routes", async () => {
    assert.ok(engagementId, `engagement creation failed: ${JSON.stringify(engagementReply.json)?.slice(0, 200)}`);
    assert.ok(paperId, `working paper creation failed: ${JSON.stringify(paperReply.json)?.slice(0, 200)}`);
    const engagement = await engagementDoc();
    assert.ok(engagement.checklist.some((i) => i.templateKey === "clause_22_43bh"), "the TAX_AUDIT template carries the clause 22 item");
  });

  await check("a CONFIRMED pack row lands, its fields filled from the pack and the decision", async () => {
    originalRequest = { mutationKey: "wp-land-1", expectedRevision: revision, packRow: { runId: String(runId), rowKey: confirmedKey } };
    const reply = await addRow(originalRequest);
    assert.equal(reply.status, 201, JSON.stringify(reply.json)?.slice(0, 300));
    const row = reply.json.row;
    assert.match(row.rowKey, /^PACK-CLAUSE22-/);
    assert.match(row.description, /section 43B\(h\)/);
    assert.match(row.description, /Sharma: bill SHARMA-11/);
    assert.equal(row.currentAmountMinor, 12_500_000);
    assert.match(row.sourceReference, /run [0-9a-f]{24} row a{64}/);
    assert.match(row.observedValue, /Bill amount/);
    assert.match(row.note, /Confirmed by user/);
    assert.match(row.note, /2026-01-05/);
    assert.match(row.note, /Past the appointed time/);
    assert.match(row.note, /Paid after the appointed time/);
    revision = reply.json.paper?.revision ?? revision + 1;
    landedRowKey = row.rowKey;
  });

  await check("the engagement's clause item moved OPEN -> IN_PROGRESS with the pack row as evidence, and nothing is COMPLETE", async () => {
    const engagement = await engagementDoc();
    const clause22 = engagement.checklist.find((i) => i.templateKey === "clause_22_43bh");
    assert.equal(clause22.status, "IN_PROGRESS");
    assert.match(clause22.evidenceReference, /Pack CLAUSE22 row/);
    assert.equal(engagement.checklist.find((i) => i.templateKey === "clause_26").status, "OPEN", "an unrelated clause item must not move");
    assert.ok(engagement.checklist.every((i) => i.status !== "COMPLETE"), "no checklist item may tick itself COMPLETE");
  });

  await check("the same pack row lands once: the replay answers the same row, not a second one", async () => {
    const before = await wpRowCount();
    const reply = await addRow(originalRequest); // the exact same payload: the retry is idempotent
    assert.equal(reply.status, 201, `status ${reply.status} ${JSON.stringify(reply.json)?.slice(0, 200)}`);
    assert.equal(reply.json.row.rowKey, landedRowKey);
    assert.equal(await wpRowCount(), before);
  });

  await check("a still-COMPUTED pack row is refused 409 with the public code, and nothing is written", async () => {
    const before = await wpRowCount();
    const reply = await addRow({ mutationKey: "wp-land-computed", expectedRevision: revision, packRow: { runId: String(runId), rowKey: computedKey } });
    assert.equal(reply.status, 409, `status ${reply.status} body ${JSON.stringify(reply.json)?.slice(0, 240)}`);
    assert.equal(reply.json.code, "AUDIT_PACK_ROW_NOT_CONFIRMED");
    assert.equal(await wpRowCount(), before);
  });

  await check("an EXCLUDED pack row is refused the same way", async () => {
    const reply = await addRow({ mutationKey: "wp-land-excluded", expectedRevision: revision, packRow: { runId: String(runId), rowKey: excludedKey } });
    assert.equal(reply.status, 409);
    assert.equal(reply.json.code, "AUDIT_PACK_ROW_NOT_CONFIRMED");
  });

  await check("a pack row of another firm reads 404", async () => {
    const reply = await addRow({ mutationKey: "wp-land-foreign", expectedRevision: revision, packRow: { runId: String(foreignRunId), rowKey: confirmedKey } });
    assert.equal(reply.status, 404);
  });

  await check("a pack run of another client of the same firm is refused 409", async () => {
    const before = await wpRowCount();
    const reply = await addRow({ mutationKey: "wp-land-otherclient", expectedRevision: revision, packRow: { runId: String(otherClientRunId), rowKey: confirmedKey } });
    assert.equal(reply.status, 409);
    assert.equal(reply.json.code, "AUDIT_PACK_ROW_NOT_CONFIRMED");
    assert.equal(await wpRowCount(), before);
  });

  await check("the fields the pack fills cannot be sent beside packRow", async () => {
    const reply = await addRow({ mutationKey: "wp-land-overreach", expectedRevision: revision, packRow: { runId: String(runId), rowKey: confirmedKey }, description: "my own text" });
    assert.equal(reply.status, 400);
  });

  await check("the working paper's revision fence still bites", async () => {
    const reply = await addRow({ mutationKey: "wp-land-stale", expectedRevision: 9999, packRow: { runId: String(runId), rowKey: confirmedKey } });
    assert.equal(reply.status, 409);
  });

  await check("a plain (non-pack) row still lands the old way: the shared path did not regress", async () => {
    const reply = await addRow({ mutationKey: "wp-plain-1", expectedRevision: revision, rowKey: "PLAIN-OBS-1", description: "Observation written by hand.", sourceReference: "Manual note" });
    assert.equal(reply.status, 201, `status ${reply.status} ${JSON.stringify(reply.json)?.slice(0, 200)}`);
  });

  await check("exactly two working-paper rows exist across everything: one pack, one plain", async () => {
    const count = await wpRowCount();
    assert.equal(count, 2, `the paper holds ${count} row(s): the confirmed pack row and the plain one`);
  });

  await new Promise((resolve) => server.close(resolve));
  await mongoose2.connection.dropDatabase().catch(() => {});
  await mongoose2.disconnect();
  console.log(`\npack-working-paper-contract: ${passed}/${passed + failed} passed`);
  process.exitCode = failed ? 1 : 0;
}
