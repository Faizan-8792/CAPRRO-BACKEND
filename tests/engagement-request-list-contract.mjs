// tests/engagement-request-list-contract.mjs
//
// W10 AP41 (2026-10-17). The measured request list and the chase draft.
//
//   - A pack's gaps that only the CLIENT can close are proposed in plain words; a gap that is the CA's own
//     job (a bank rate, a missing ledger group) is never offered as a request to a client.
//   - Adding a proposal records WHEN it was asked for, so "pending for N days" is the difference of two
//     recorded UTC days. The write goes through the engagement's mutation key and revision fence, adds
//     nothing twice, and refuses another client's pack and another firm's.
//   - The chase draft is built only from requests that carry that moment. A draft with no measured figure
//     is REFUSED (409 NO_MEASURED_REQUESTS), never defaulted to a number - the old reminder route wrote 3.
//   - The draft is labelled DRAFT FOR REVIEW - NOT SENT, and drafting writes nothing.
//
// Pure checks always run. The route checks need the replica set (engagement creation uses transactions):
// MONGODB_URI is set by tools/run-gates.ps1 (replica-set suite list); by hand with
//   MONGODB_URI=mongodb://127.0.0.1:27118/scratch-gates-engagement-requests?replicaSet=rs0
// Without it the route checks are reported as not run, never as passed.

import assert from "node:assert/strict";
import {
  CHASE_LABEL,
  CLIENT_ACTION_GAPS,
  buildChaseDraft,
  daysPending,
  formatUtcDay,
  packRequestKey,
  proposalsFromGapRows,
} from "../src/services/engagement-request-list.service.js";

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

const gapRow = (rule, label = rule) => ({ label, ruleHits: [{ rule, detail: "x" }] });
const request = (over = {}) => ({ _id: "r" + Math.random().toString(16).slice(2, 8), title: "Udyam certificates", status: "REQUESTED", requestedAt: new Date("2026-10-10T08:00:00Z"), dueAt: null, ...over });

// ── Pure ───────────────────────────────────────────────────────────────────────────────────────

await check("gaps the client can close are grouped and counted in plain words", () => {
  const proposals = proposalsFromGapRows("CLAUSE22", [
    gapRow("UDYAM_UNKNOWN", "Sharma: not known"), gapRow("UDYAM_UNKNOWN", "Verma: not known"), gapRow("UDYAM_UNKNOWN", "Rao: not known"),
    gapRow("PURCHASES_NOT_BILLWISE", "Iyer: purchases with no bill detail"),
  ]);
  assert.deepEqual(proposals.map((p) => [p.code, p.count]), [["PURCHASES_NOT_BILLWISE", 1], ["UDYAM_UNKNOWN", 3]]);
  const udyam = proposals.find((p) => p.code === "UDYAM_UNKNOWN");
  assert.match(udyam.title, /of 3 supplier\(s\)/);
  assert.deepEqual(udyam.sampleLabels, ["Sharma: not known", "Verma: not known", "Rao: not known"]);
  assert.ok(udyam.detail.length > 20);
});

await check("a gap that is the CA's own job is never proposed as a request to a client", () => {
  for (const code of ["BANK_RATE_NOT_SUPPLIED", "NO_SUPPLIERS", "GROUPS_NOT_MAPPED", "UNREADABLE_VOUCHERS", "NOT_MSME_SUPPLIERS", "LOOKS_LIKE_GROUP_TOTAL", "BOOKS_DO_NOT_BALANCE", "UNMAPPED_PAYEES"]) {
    assert.deepEqual(proposalsFromGapRows("CLAUSE22", [gapRow(code)]), [], `${code} must not become a client request`);
    assert.ok(!(code in CLIENT_ACTION_GAPS), `${code} is in the client-action table`);
  }
  assert.deepEqual(proposalsFromGapRows("CLAUSE22", [{ label: "no hits", ruleHits: [] }, { label: "no field" }, null]), []);
});

await check("a pack request's key is stable and names the kind, the gap and the year", () => {
  assert.equal(packRequestKey("CLAUSE22", "UDYAM_UNKNOWN", "2025-26"), "pack:CLAUSE22:UDYAM_UNKNOWN:2025-26");
});

await check("days pending are the difference of two UTC days: late on the 10th to just after midnight on the 11th is 1 day", () => {
  assert.equal(daysPending(request({ requestedAt: new Date("2026-10-10T23:30:00Z") }), new Date("2026-10-11T00:10:00Z")), 1);
  assert.equal(daysPending(request({ requestedAt: new Date("2026-10-10T00:00:00Z") }), new Date("2026-10-10T23:59:59Z")), 0);
  assert.equal(daysPending(request({ requestedAt: new Date("2026-10-03T12:00:00Z") }), new Date("2026-10-10T12:00:00Z")), 7);
});

await check("no recorded request date, or one in the future, is not a measurement (null)", () => {
  assert.equal(daysPending(request({ requestedAt: null }), new Date()), null);
  assert.equal(daysPending(request({ requestedAt: new Date("2030-01-01T00:00:00Z") }), new Date("2026-10-10T00:00:00Z")), null);
  assert.equal(daysPending(null, new Date()), null);
});

await check("a day is written from its UTC day, whatever the clock in the room says", () => {
  assert.equal(formatUtcDay(new Date("2026-10-31T23:59:59Z")), "31 Oct 2026");
  assert.equal(formatUtcDay(new Date("2026-11-01T00:00:00Z")), "1 Nov 2026");
  assert.equal(formatUtcDay("not a date"), "");
});

const NOW = new Date("2026-10-17T10:00:00Z");

await check("the chase draft states the measured days per item, oldest first, and says nothing was sent", () => {
  const r = buildChaseDraft({
    clientName: "Sharma Traders",
    now: NOW,
    requests: [
      request({ title: "Bill-wise details", requestedAt: new Date("2026-10-14T05:00:00Z") }),
      request({ title: "Udyam certificates", requestedAt: new Date("2026-10-10T05:00:00Z"), dueAt: new Date("2026-10-20T00:00:00Z") }),
    ],
  });
  assert.equal(r.ok, true);
  assert.equal(r.label, CHASE_LABEL);
  assert.equal(r.label, "DRAFT FOR REVIEW - NOT SENT");
  assert.equal(r.nothingSent, true);
  assert.deepEqual(r.items.map((i) => [i.title, i.daysPending]), [["Udyam certificates", 7], ["Bill-wise details", 3]]);
  assert.match(r.body, /1\. Udyam certificates - asked for on 10 Oct 2026, pending for 7 days, due 20 Oct 2026/);
  assert.match(r.body, /2\. Bill-wise details - asked for on 14 Oct 2026, pending for 3 days/);
  assert.match(r.body, /^Dear Sharma Traders,/);
  assert.equal(r.unmeasuredCount, 0);
});

await check("a draft with NOTHING measured is refused, not defaulted - and never says 3 days", () => {
  const none = buildChaseDraft({ clientName: "X", now: NOW, requests: [] });
  assert.equal(none.ok, false);
  assert.equal(none.code, "NO_MEASURED_REQUESTS");
  const undated = buildChaseDraft({ clientName: "X", now: NOW, requests: [request({ requestedAt: null }), request({ requestedAt: null, status: "PARTIAL" })] });
  assert.equal(undated.ok, false);
  assert.equal(undated.code, "NO_MEASURED_REQUESTS");
  assert.match(undated.message, /recorded request date/i);
  assert.equal(undated.body, undefined, "a refused draft must not carry text");
});

await check("requests that are closed or not yet asked for are not chased", () => {
  const r = buildChaseDraft({ clientName: "X", now: NOW, requests: [
    request({ title: "Open one", requestedAt: new Date("2026-10-15T00:00:00Z") }),
    request({ title: "Received", status: "RECEIVED" }), request({ title: "Waived", status: "WAIVED" }), request({ title: "Not asked", status: "NOT_REQUESTED" }),
  ] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.items.map((i) => i.title), ["Open one"]);
  assert.ok(!r.body.includes("Received") && !r.body.includes("Waived") && !r.body.includes("Not asked"));
});

await check("undated open requests are listed beside the measured ones with no figure at all", () => {
  const r = buildChaseDraft({ clientName: "X", now: NOW, requests: [request({ title: "Dated", requestedAt: new Date("2026-10-15T00:00:00Z") }), request({ title: "Undated", requestedAt: null })] });
  assert.equal(r.ok, true);
  assert.equal(r.unmeasuredCount, 1);
  assert.match(r.body, /2\. Undated\n/);
  assert.ok(!/Undated.*pending for/.test(r.body), "an unmeasured item must carry no figure");
});

await check("the draft never asserts a conclusion", () => {
  const r = buildChaseDraft({ clientName: "X", now: NOW, requests: [request({ requestedAt: new Date("2026-10-01T00:00:00Z") })] });
  assert.doesNotMatch(`${r.subject}\n${r.body}`, /we conclude|verified|complies|compliant|penalt|default/i);
});

// ── Routes ─────────────────────────────────────────────────────────────────────────────────────

// Transactions need the replica set; tools/run-gates.ps1 does not override this URI for the replica-set suites.
const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27118/scratch-gates-engagement-request-list?replicaSet=rs0";
const dbName = (uri.split("/").pop() || "").split("?")[0];
const host = (uri.split("//")[1] || "").split("/")[0];

if (!uri) {
  console.log("[NOT RUN] the route checks - no MONGODB_URI (tools/run-gates.ps1 provides the replica-set scratch one)");
} else if (!/scratch/i.test(dbName) || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
  console.error(`[FAIL] refusing to touch ${host}/${dbName}: the database must be loopback and scratch-named`);
  failed += 1;
} else {
  process.env.NODE_ENV = "production";
  process.env.JWT_SECRET = process.env.JWT_SECRET || "scratch-only-secret-not-a-real-credential-0000";
  process.env.DEEPSEEK_API_KEY = "";
  process.env.OCR_SPACE_API_KEY = "";
  const { default: app } = await import("../src/app.js");
  const jwt = (await import("jsonwebtoken")).default;
  const mongoose = (await import("mongoose")).default;
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
  await mongoose.connection.dropDatabase();
  const { ensureRequiredIndexes } = await import("../src/services/index-provisioning.service.js");
  await ensureRequiredIndexes();
  const raw = (name) => mongoose.connection.collection(name);
  const oid = () => new mongoose.Types.ObjectId();
  const now = new Date();

  const ownerId = oid();
  const reviewerId = oid();
  const firmId = oid();
  const clientId = oid();
  const otherClientId = oid();
  const otherFirmId = oid();
  const otherOwnerId = oid();
  const mkUser = (id, tag, fid) => raw("users").insertOne({ _id: id, email: `${tag}@scratch.test`, name: `User ${tag}`, role: "FIRM_ADMIN", accountType: "FIRM_USER", isActive: true, tokenVersion: 0, firmId: fid, createdAt: now, updatedAt: now });
  await mkUser(ownerId, "owner-reqlist", firmId);
  await mkUser(reviewerId, "reviewer-reqlist", firmId);
  await mkUser(otherOwnerId, "other-reqlist", otherFirmId);
  await raw("firms").insertMany([
    { _id: firmId, name: "Request List Firm", displayName: "Request List Firm", handle: "scratch-reqlist", ownerId, ownerUserId: ownerId, type: "FIRM", isActive: true, joinCode: "JRQLST1", createdAt: now, updatedAt: now },
    { _id: otherFirmId, name: "Other Firm", displayName: "Other Firm", handle: "scratch-reqlist-o", ownerId: otherOwnerId, ownerUserId: otherOwnerId, type: "FIRM", isActive: true, joinCode: "JRQLST2", createdAt: now, updatedAt: now },
  ]);
  await raw("firmmemberships").insertMany([
    { _id: oid(), firmId, userId: ownerId, status: "ACTIVE", role: "OWNER", memberAccess: "FULL", createdAt: now, updatedAt: now },
    { _id: oid(), firmId, userId: reviewerId, status: "ACTIVE", role: "FIRM_ADMIN", memberAccess: "FULL", createdAt: now, updatedAt: now },
    { _id: oid(), firmId: otherFirmId, userId: otherOwnerId, status: "ACTIVE", role: "OWNER", memberAccess: "FULL", createdAt: now, updatedAt: now },
  ]);
  await raw("clients").insertMany([
    { _id: clientId, firmId, name: "Sharma Traders", isActive: true, createdAt: now, updatedAt: now },
    { _id: otherClientId, firmId, name: "Verma Stores", isActive: true, createdAt: now, updatedAt: now },
  ]);
  await raw("appconfigs").insertOne({ _id: "singleton", featureFlags: { auditPacks: true, auditWorkingPapers: true, assuranceEngagements: true }, createdAt: now, updatedAt: now });

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const tokenFor = (id, tag, fid) => jwt.sign({ id, email: `${tag}@scratch.test`, role: "FIRM_ADMIN", accountType: "FIRM_USER", firmId: fid, isActive: true, tv: 0 }, process.env.JWT_SECRET, { expiresIn: "30m" });
  const token = tokenFor(ownerId, "owner-reqlist", firmId);
  const call = async (method, path, body, tok = token) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  };

  const created = await call("POST", "/api/engagements", {
    mutationKey: "seed-engagement-rl-1",
    clientId: String(clientId),
    engagementType: "TAX_AUDIT",
    reviewerUserId: String(reviewerId),
    scope: "Statutory audit under section 44AB for FY 2025-26.",
    startDate: "2026-04-01",
    targetDate: "2026-10-15",
  });
  const engagementId = created.json?.engagement?.id || created.json?.engagement?._id;
  const eng = () => raw("engagements").findOne({ _id: new mongoose.Types.ObjectId(engagementId) });

  const runId = oid();
  const mkRun = (id, fid, cid) => raw("auditpackruns").insertOne({ _id: id, firmId: fid, clientId: cid, kind: "CLAUSE22", financialYear: "2025-26", status: "REVIEW", activeGenerationAttempt: "1", generationAttempt: "1", ruleVersion: "clause22-v1", rowCount: 5, sourceBatches: [], sourceFingerprint: `fp-${id}`, summary: { provisional: true, reasons: [], totals: {}, counts: {} }, createdAt: now, updatedAt: now });
  await mkRun(runId, firmId, clientId);
  const gap = (rule, label, key) => ({ _id: oid(), firmId, runId, generationAttempt: "1", ordinal: 1, rowKey: key.padEnd(64, "0"), section: "INPUT_GAPS", label, party: null, decidable: false, state: "PENDING_INPUT", values: { amountMinor: null, lines: [], choices: [] }, ruleHits: [{ rule, threshold: null, detail: "d" }], decision: { version: 0 }, sourceRows: [], sourceEvidenceCount: 0, sourceEvidenceHash: "d".repeat(64), createdAt: now, updatedAt: now });
  await raw("auditpackrows").insertMany([
    gap("UDYAM_UNKNOWN", "Sharma: not known", "a1"), gap("UDYAM_UNKNOWN", "Verma: not known", "a2"), gap("UDYAM_UNKNOWN", "Rao: not known", "a3"),
    gap("PURCHASES_NOT_BILLWISE", "Iyer: purchases with no bill detail", "b1"),
    gap("BANK_RATE_NOT_SUPPLIED", "No bank rate was supplied", "c1"),
  ]);
  // A pack of another client of this firm, and a pack of another firm.
  const otherClientRun = oid();
  await mkRun(otherClientRun, firmId, otherClientId);
  const foreignRun = oid();
  await mkRun(foreignRun, otherFirmId, clientId);

  let revision = 1;

  await check("the engagement was created by its own route", () => {
    assert.ok(engagementId, `engagement creation failed: ${JSON.stringify(created.json)?.slice(0, 200)}`);
  });

  await check("the proposals are the client-side gaps only, grouped, none yet requested", async () => {
    const r = await call("GET", `/api/engagements/${engagementId}/requests/proposals?runId=${runId}`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.proposals.map((p) => [p.code, p.count, p.alreadyRequested]), [["PURCHASES_NOT_BILLWISE", 1, false], ["UDYAM_UNKNOWN", 3, false]]);
    assert.ok(!r.json.proposals.some((p) => p.code === "BANK_RATE_NOT_SUPPLIED"), "a bank rate is the CA's to supply, not the client's");
    assert.equal(r.json.kind, "CLAUSE22");
  });

  await check("adding a proposal records WHEN it was asked for, once, through the revision fence", async () => {
    const before = Date.now();
    const r = await call("POST", `/api/engagements/${engagementId}/requests/from-pack`, { mutationKey: "rl-add-1", expectedRevision: revision, runId: String(runId), codes: ["UDYAM_UNKNOWN"] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.added.map((a) => a.code), ["UDYAM_UNKNOWN"]);
    const doc = await eng();
    const added = doc.clientRequests.filter((q) => q.templateKey === "pack:CLAUSE22:UDYAM_UNKNOWN:2025-26");
    assert.equal(added.length, 1);
    assert.equal(added[0].status, "REQUESTED");
    assert.equal(added[0].category, "PACK_INPUT");
    assert.ok(added[0].requestedAt instanceof Date && Math.abs(added[0].requestedAt.getTime() - before) < 60_000, "the request time was not recorded now");
    assert.match(added[0].title, /of 3 supplier\(s\)/);
    assert.equal(doc.revision, revision + 1);
    revision = doc.revision;
  });

  await check("the same call replayed (same mutation key) adds nothing and moves nothing", async () => {
    const lengthBefore = (await eng()).clientRequests.length;
    const r = await call("POST", `/api/engagements/${engagementId}/requests/from-pack`, { mutationKey: "rl-add-1", expectedRevision: revision - 1, runId: String(runId), codes: ["UDYAM_UNKNOWN"] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.replayed, true);
    const doc = await eng();
    assert.equal(doc.clientRequests.length, lengthBefore);
    assert.equal(doc.revision, revision);
  });

  await check("asking again for something already on the list skips it and spends no revision", async () => {
    const r = await call("POST", `/api/engagements/${engagementId}/requests/from-pack`, { mutationKey: "rl-add-2", expectedRevision: revision, runId: String(runId), codes: ["UDYAM_UNKNOWN"] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.skipped, [{ code: "UDYAM_UNKNOWN", reason: "ALREADY_ON_THE_LIST" }]);
    assert.deepEqual(r.json.added, []);
    assert.equal((await eng()).revision, revision);
    const proposals = await call("GET", `/api/engagements/${engagementId}/requests/proposals?runId=${runId}`);
    assert.equal(proposals.json.proposals.find((p) => p.code === "UDYAM_UNKNOWN").alreadyRequested, true);
  });

  await check("a gap the client cannot close, and a code the pack never raised, are refused 400 - nothing written", async () => {
    for (const code of ["BANK_RATE_NOT_SUPPLIED", "NOT_A_REAL_GAP"]) {
      const r = await call("POST", `/api/engagements/${engagementId}/requests/from-pack`, { mutationKey: `rl-bad-${code}`, expectedRevision: revision, runId: String(runId), codes: [code] });
      assert.equal(r.status, 400, `${code}: ${JSON.stringify(r.json)}`);
    }
    const empty = await call("POST", `/api/engagements/${engagementId}/requests/from-pack`, { mutationKey: "rl-bad-empty", expectedRevision: revision, runId: String(runId), codes: [] });
    assert.equal(empty.status, 400);
    assert.equal((await eng()).revision, revision);
  });

  await check("a pack of another client is refused 409, a pack of another firm 404", async () => {
    const wrongClient = await call("POST", `/api/engagements/${engagementId}/requests/from-pack`, { mutationKey: "rl-wrong-client", expectedRevision: revision, runId: String(otherClientRun), codes: ["UDYAM_UNKNOWN"] });
    assert.equal(wrongClient.status, 409);
    assert.equal(wrongClient.json.code, "ENGAGEMENT_PACK_CLIENT_MISMATCH");
    const foreign = await call("POST", `/api/engagements/${engagementId}/requests/from-pack`, { mutationKey: "rl-foreign", expectedRevision: revision, runId: String(foreignRun), codes: ["UDYAM_UNKNOWN"] });
    assert.equal(foreign.status, 404);
  });

  await check("a stale revision is refused 409 and the other firm's user cannot see the engagement at all", async () => {
    const stale = await call("POST", `/api/engagements/${engagementId}/requests/from-pack`, { mutationKey: "rl-stale", expectedRevision: revision - 1, runId: String(runId), codes: ["PURCHASES_NOT_BILLWISE"] });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.code, "ENGAGEMENT_REVISION_CONFLICT");
    const outsider = tokenFor(otherOwnerId, "other-reqlist", otherFirmId);
    assert.equal((await call("GET", `/api/engagements/${engagementId}/requests/proposals?runId=${runId}`, undefined, outsider)).status, 404);
    assert.equal((await call("POST", `/api/engagements/${engagementId}/requests/chase-draft`, {}, outsider)).status, 404);
  });

  await check("the chase draft states the measured days, is labelled NOT SENT, and writes nothing", async () => {
    const asked = new Date(Date.now() - 7 * 86_400_000);
    await raw("engagements").updateOne({ _id: new mongoose.Types.ObjectId(engagementId) }, { $set: { "clientRequests.$[r].requestedAt": asked } }, { arrayFilters: [{ "r.templateKey": "pack:CLAUSE22:UDYAM_UNKNOWN:2025-26" }] });
    const before = await eng();
    const r = await call("POST", `/api/engagements/${engagementId}/requests/chase-draft`, {});
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const draft = r.json.draft;
    assert.equal(draft.label, "DRAFT FOR REVIEW - NOT SENT");
    assert.equal(draft.nothingSent, true);
    assert.deepEqual(draft.items.map((i) => i.daysPending), [7]);
    assert.match(draft.body, /^Dear Sharma Traders,/);
    assert.match(draft.body, /pending for 7 days/);
    const after = await eng();
    assert.equal(after.revision, before.revision, "drafting must not write");
    assert.equal(after.contentRevision, before.contentRevision);
  });

  await check("a draft with no measured figure is refused 409 NO_MEASURED_REQUESTS - never defaulted", async () => {
    await raw("engagements").updateOne({ _id: new mongoose.Types.ObjectId(engagementId) }, { $set: { "clientRequests.$[r].requestedAt": null } }, { arrayFilters: [{ "r.templateKey": "pack:CLAUSE22:UDYAM_UNKNOWN:2025-26" }] });
    const r = await call("POST", `/api/engagements/${engagementId}/requests/chase-draft`, {});
    assert.equal(r.status, 409, JSON.stringify(r.json));
    assert.equal(r.json.code, "NO_MEASURED_REQUESTS");
    assert.doesNotMatch(JSON.stringify(r.json), /3 days/);
  });

  await check("an engagement with nothing open to chase is refused the same way", async () => {
    await raw("engagements").updateOne({ _id: new mongoose.Types.ObjectId(engagementId) }, { $set: { "clientRequests.$[].status": "RECEIVED" } });
    const r = await call("POST", `/api/engagements/${engagementId}/requests/chase-draft`, {});
    assert.equal(r.status, 409);
    assert.equal(r.json.code, "NO_MEASURED_REQUESTS");
  });

  await check("a received request that comes back as a gap can be asked for again", async () => {
    const doc = await eng();
    const r = await call("POST", `/api/engagements/${engagementId}/requests/from-pack`, { mutationKey: "rl-again", expectedRevision: doc.revision, runId: String(runId), codes: ["UDYAM_UNKNOWN"] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.added.map((a) => a.code), ["UDYAM_UNKNOWN"]);
    const open = (await eng()).clientRequests.filter((q) => q.templateKey === "pack:CLAUSE22:UDYAM_UNKNOWN:2025-26" && q.status === "REQUESTED");
    assert.equal(open.length, 1);
  });

  server.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}

console.log(`\nengagement-request-list-contract: ${passed}/${passed + failed} passed${uri ? " (scratch Mongo included)" : " (pure checks only - no scratch Mongo)"}`);
if (failed) process.exitCode = 1;
