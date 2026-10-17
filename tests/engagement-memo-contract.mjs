// tests/engagement-memo-contract.mjs
//
// W10 AP37 (2026-10-17). Drafted materiality, sampling and significant-matters memos.
//
//   WORDING CONTRACT (the gate): no memo this service writes says "we conclude", "verified", "complies" or a
//   kin of them - checked on every template, and the guard is shown to bite. The team's OWN words are quoted
//   faithfully even when they say "verified": the contract is about what the product writes.
//
//   - Memos are ASSEMBLED from the team's inputs and the packs' recorded state; every figure is computed in
//     integer paise (BigInt), rounded down, and listed with the inputs that produced it.
//   - A memo is a DRAFT FOR REVIEW until the engagement's assigned reviewer signs it; the signature keeps a
//     hash of the exact text; a signed memo cannot be edited; only the reviewer signs.
//   - Another client's pack and another firm's pack are refused; people off the team are refused.
//
// Pure checks always run. Route checks need the replica set: MONGODB_URI (tools/run-gates.ps1); by hand:
//   MONGODB_URI=mongodb://127.0.0.1:27118/scratch-gates-engagement-memo?replicaSet=rs0

import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  MEMO_DRAFT_LABEL,
  buildMaterialityMemo,
  buildSamplingMemo,
  buildSignificantMattersMemo,
  findForbiddenWording,
  guarded,
  readMaterialityInputs,
} from "../src/services/engagement-memo.service.js";


// ENGAGEMENT_FILE_DUMP_DIR=<folder>: write the responses the desktop's tests pin as fixtures (CaPro.Desktop.Core.Tests/Fixtures/EngagementFile).
// Real answers from the real routes, fields the desktop does not read included, so a server rename breaks a test instead of emptying a screen.
const dumpDir = process.env.ENGAGEMENT_FILE_DUMP_DIR || "";
const dump = async (name, json) => {
  if (!dumpDir) return;
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(dumpDir, { recursive: true });
  await writeFile(`${dumpDir}/${name}.json`, JSON.stringify(json, null, 2));
};

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

const engagement = { title: "Tax audit FY 2025-26", period: "FY 2025-26" };
const baseInputs = { benchmarkName: "Revenue from operations", benchmarkAmountMinor: 5_000_000_000, percentageBasisPoints: 100, performanceBasisPoints: 7500, trivialBasisPoints: 500, rationale: "Stable revenue base; users look at turnover." };

// ── Pure ───────────────────────────────────────────────────────────────────────────────────────

await check("materiality is computed in paise from the inputs and rounded down: 1% of Rs 5 crore, 75% of that, 5% of that", () => {
  const m = buildMaterialityMemo({ inputs: readMaterialityInputs(baseInputs), clientName: "Sharma Traders", engagement });
  assert.deepEqual(m.figures.map((f) => [f.label, f.minor]), [["Overall materiality", 50_000_000], ["Performance materiality", 37_500_000], ["Clearly trivial threshold", 2_500_000]]);
  assert.equal(m.figures[0].value, "₹5,00,000.00");
  assert.equal(m.figures[1].value, "₹3,75,000.00");
  assert.match(m.text, /Benchmark amount: ₹5,00,00,000\.00/, "Indian grouping, and an amount above 2^31 paise is read whole");
  assert.match(m.text, /Overall materiality: ₹5,00,000\.00 \(benchmark amount x percentage\)/);
});

await check("rounding is down, to the paisa: 1% of 12,345 paise is 123", () => {
  const m = buildMaterialityMemo({ inputs: readMaterialityInputs({ benchmarkName: "Profit", benchmarkAmountMinor: 12_345, percentageBasisPoints: 100 }), clientName: "X", engagement });
  assert.equal(m.figures[0].minor, 123);
  assert.equal(m.figures.length, 1, "no performance or trivial figure when none was asked for");
});

await check("percentages read as people write them: 1.5%, 1.25%, 1%, 0.01%", () => {
  const listed = (bp) => buildMaterialityMemo({ inputs: readMaterialityInputs({ ...baseInputs, percentageBasisPoints: bp }), clientName: "X", engagement }).inputsListed.find((i) => i.label.startsWith("Percentage")).value;
  assert.deepEqual([150, 125, 100, 1].map(listed), ["1.5%", "1.25%", "1%", "0.01%"]);
});

await check("materiality inputs are checked: a float, a negative, a missing benchmark, a percentage outside 1-10000 basis points", () => {
  const bad = [
    { ...baseInputs, benchmarkAmountMinor: 12.5 }, { ...baseInputs, benchmarkAmountMinor: -1 }, { ...baseInputs, benchmarkAmountMinor: "100" },
    { ...baseInputs, benchmarkName: "" }, { ...baseInputs, percentageBasisPoints: 0 }, { ...baseInputs, percentageBasisPoints: 10001 }, { ...baseInputs, percentageBasisPoints: 1.5 },
    { ...baseInputs, performanceBasisPoints: 20000 }, { ...baseInputs, rationale: "x".repeat(3001) }, null, [],
  ];
  for (const inputs of bad) assert.throws(() => readMaterialityInputs(inputs), (e) => e.statusCode === 400 || e.status === 400, JSON.stringify(inputs)?.slice(0, 60));
});

const selected = [
  { label: "Cash payment above the threshold", values: { voucherNumber: "PV-114", date: "2026-02-10", amountMinor: 250_000_00 } },
  { label: "Round-sum cash receipt", values: { voucherNumber: "RV-9", date: "2026-03-30", amountMinor: 100_000_00 } },
  { label: "Suspense entry with no amount read", values: {} },
];
const run = { kind: "LEDGER_SCAN", financialYear: "2025-26" };

await check("the sampling memo counts what the pack recorded and lists the items", () => {
  const m = buildSamplingMemo({ inputs: { method: "All items the team marked", populationNote: "", rationale: "" }, clientName: "X", engagement, run, kindLabel: "Ledger scans", selected });
  assert.deepEqual(m.figures.map((f) => [f.label, f.value]), [["Items the team selected", "3"], ["Of these, with an amount", "2"], ["Total of those amounts", "₹3,50,000.00"]]);
  assert.match(m.text, /1\. Cash payment above the threshold \(PV-114 2026-02-10\) - ₹2,50,000\.00/);
  assert.match(m.text, /3\. Suspense entry with no amount read\n/);
  assert.match(m.text, /None recorded\./);
});

const packs = [
  { kind: "CLAUSE22", kindLabel: "Clause 22", financialYear: "2025-26", open: 33, gaps: 2, reported: 4, openLabels: Array.from({ length: 30 }, (_, i) => `Supplier ${i + 1}: bill late`) },
  { kind: "CARO", kindLabel: "CARO 2020", financialYear: "2025-26", open: 0, gaps: 0, reported: 0, openLabels: [] },
];

await check("the significant matters memo totals the open flags across packs and says how many are not listed", () => {
  const m = buildSignificantMattersMemo({ inputs: { runIds: ["a", "b"], matters: "" }, clientName: "X", engagement, packs });
  assert.deepEqual(m.figures.map((f) => [f.label, f.value]), [["Flags still undecided", "33"], ["Items the packs could not complete for want of an input", "2"], ["Flags a person confirmed to be reported", "4"]]);
  assert.match(m.text, /  - and 3 more/);
  assert.match(m.text, /a flag is a question, not a finding/);
});

await check("WORDING CONTRACT: nothing the three templates write says we conclude, verified, complies, certified or in our opinion", () => {
  const texts = [
    buildMaterialityMemo({ inputs: readMaterialityInputs(baseInputs), clientName: "X", engagement }),
    buildSamplingMemo({ inputs: { method: "m", populationNote: "p", rationale: "r" }, clientName: "X", engagement, run, kindLabel: "Ledger scans", selected }),
    buildSignificantMattersMemo({ inputs: { runIds: ["a"], matters: "m" }, clientName: "X", engagement, packs }),
  ].map((m) => `${m.title}\n${m.text}`);
  for (const text of texts) assert.equal(findForbiddenWording(text), null, `forbidden wording found: ${findForbiddenWording(text)}`);
  for (const text of texts) assert.match(text, /states no conclusion/i);
  for (const text of texts) assert.match(text, /DRAFT FOR REVIEW/);
});

await check("the wording check recognises the phrases it exists for, and not their innocent neighbours", () => {
  for (const bad of ["We conclude that", "has been verified", "It complies with", "the company complied", "fully compliant", "In our opinion", "we certify", "certified by"]) {
    assert.ok(findForbiddenWording(bad), `"${bad}" must be caught`);
  }
  for (const fine of ["states no conclusion", "verification pending", "the conclusion is the partner's", "compliance work", "a certificate"]) {
    assert.equal(findForbiddenWording(fine), null, `"${fine}" must pass`);
  }
});

await check("the guard bites on a template, and quotes the team's own words even when they say 'verified'", () => {
  assert.throws(() => guarded({ title: "Memo", text: "We conclude that the sample is sufficient." }), /must never say/);
  const own = "Benchmark verified against the trial balance.";
  const ok = guarded({ title: "Memo", text: `Reasons:\n${own}` }, [own]);
  assert.match(ok.text, /verified against the trial balance/);
  const memo = buildMaterialityMemo({ inputs: readMaterialityInputs({ ...baseInputs, rationale: own }), clientName: "X", engagement });
  assert.match(memo.text, /Benchmark verified against the trial balance\./, "the team's words are quoted as written");
});

// ── Routes ─────────────────────────────────────────────────────────────────────────────────────

// Transactions need the replica set; tools/run-gates.ps1 does not override this URI for the replica-set suites.
const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27118/scratch-gates-engagement-memo?replicaSet=rs0";
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

  const ownerId = oid(); const reviewerId = oid(); const memberId = oid(); const outsiderId = oid(); const otherFirmUserId = oid();
  const firmId = oid(); const otherFirmId = oid(); const clientId = oid(); const otherClientId = oid();
  for (const [id, tag, fid] of [[ownerId, "owner", firmId], [reviewerId, "reviewer", firmId], [memberId, "member", firmId], [outsiderId, "outsider", firmId], [otherFirmUserId, "elsewhere", otherFirmId]]) {
    await raw("users").insertOne({ _id: id, email: `${tag}-memo@scratch.test`, name: `Person ${tag}`, role: "FIRM_ADMIN", accountType: "FIRM_USER", isActive: true, tokenVersion: 0, firmId: fid, createdAt: now, updatedAt: now });
    await raw("firmmemberships").insertOne({ _id: oid(), firmId: fid, userId: id, status: "ACTIVE", role: id === ownerId || id === otherFirmUserId ? "OWNER" : "FIRM_ADMIN", memberAccess: "FULL", createdAt: now, updatedAt: now });
  }
  await raw("firms").insertMany([
    { _id: firmId, name: "Memo Firm", displayName: "Memo Firm", handle: "scratch-memo", ownerId, ownerUserId: ownerId, type: "FIRM", isActive: true, joinCode: "JMEMO01", createdAt: now, updatedAt: now },
    { _id: otherFirmId, name: "Other Firm", displayName: "Other Firm", handle: "scratch-memo-o", ownerId: otherFirmUserId, ownerUserId: otherFirmUserId, type: "FIRM", isActive: true, joinCode: "JMEMO02", createdAt: now, updatedAt: now },
  ]);
  await raw("clients").insertMany([
    { _id: clientId, firmId, name: "Sharma Traders", isActive: true, createdAt: now, updatedAt: now },
    { _id: otherClientId, firmId, name: "Verma Stores", isActive: true, createdAt: now, updatedAt: now },
  ]);
  await raw("appconfigs").insertOne({ _id: "singleton", featureFlags: { auditPacks: true, auditWorkingPapers: true, assuranceEngagements: true }, createdAt: now, updatedAt: now });

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const tokenFor = (id, tag, fid) => jwt.sign({ id, email: `${tag}-memo@scratch.test`, role: "FIRM_ADMIN", accountType: "FIRM_USER", firmId: fid, isActive: true, tv: 0 }, process.env.JWT_SECRET, { expiresIn: "30m" });
  const T = { owner: tokenFor(ownerId, "owner", firmId), reviewer: tokenFor(reviewerId, "reviewer", firmId), member: tokenFor(memberId, "member", firmId), outsider: tokenFor(outsiderId, "outsider", firmId), elsewhere: tokenFor(otherFirmUserId, "elsewhere", otherFirmId) };
  const call = async (who, method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { Authorization: `Bearer ${T[who]}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, json: await response.json().catch(() => null) };
  };
  const created = await call("owner", "POST", "/api/engagements", { mutationKey: "seed-engagement-memo", clientId: String(clientId), engagementType: "TAX_AUDIT", reviewerUserId: String(reviewerId), teamUserIds: [String(memberId)], scope: "Statutory audit under section 44AB for FY 2025-26.", startDate: "2026-04-01", targetDate: "2026-10-15" });
  const engagementId = created.json?.engagement?.id || created.json?.engagement?._id;
  const M = (suffix = "") => `/api/engagements/${engagementId}/memos${suffix}`;
  let n = 0;
  const key = (label) => `${label}-${(n += 1)}-memo`;
  const record = () => raw("engagementassurances").findOne({ engagementId: new mongoose.Types.ObjectId(engagementId) });

  // Packs: a ledger scan with decisions; two further packs for the significant-matters memo.
  const mkRun = (kind, cid, fid = firmId) => { const id = oid(); return raw("auditpackruns").insertOne({ _id: id, firmId: fid, clientId: cid, kind, financialYear: "2025-26", status: "REVIEW", activeGenerationAttempt: "1", generationAttempt: "1", ruleVersion: `${kind}-v1`, rowCount: 5, sourceBatches: [], sourceFingerprint: `fp-${id}`, summary: { provisional: true, reasons: [], totals: {}, counts: {} }, createdAt: now, updatedAt: now }).then(() => id); };
  const mkRow = (runId, ordinal, label, state, extra = {}) => raw("auditpackrows").insertOne({ _id: oid(), firmId, runId, generationAttempt: "1", ordinal, rowKey: `${ordinal}`.padStart(64, "0"), section: "CASH", label, party: null, decidable: state !== "PENDING_INPUT", state, values: { amountMinor: null, lines: [], choices: [], ...(extra.values || {}) }, ruleHits: [{ rule: "R", threshold: null, detail: "d" }], decision: extra.decision || { version: 0 }, sourceRows: [], sourceEvidenceCount: 0, sourceEvidenceHash: "d".repeat(64), createdAt: now, updatedAt: now });
  const confirmed = (choice) => ({ version: 1, state: "CONFIRMED", choice, decidedBy: ownerId, decidedAt: now, reason: "r" });
  const scanRun = await mkRun("LEDGER_SCAN", clientId);
  await mkRow(scanRun, 1, "Cash payment above the threshold", "CONFIRMED", { values: { voucherNumber: "PV-114", date: "2026-02-10", amountMinor: 25_000_000 }, decision: confirmed("REPORT") });
  await mkRow(scanRun, 2, "Round-sum cash receipt", "CONFIRMED", { values: { voucherNumber: "RV-9", date: "2026-03-30", amountMinor: 10_000_000 }, decision: confirmed("REPORT") });
  await mkRow(scanRun, 3, "Expected Sunday movement", "CONFIRMED", { decision: confirmed("EXPECTED_OCCURRENCE") });
  await mkRow(scanRun, 4, "Not yet decided", "COMPUTED");
  const emptyRun = await mkRun("LEDGER_SCAN", clientId);
  await mkRow(emptyRun, 1, "Not yet decided either", "COMPUTED");
  const matterRun = await mkRun("CLAUSE22", clientId);
  for (let i = 1; i <= 3; i += 1) await mkRow(matterRun, i, `Supplier ${i}: bill late`, "COMPUTED");
  await mkRow(matterRun, 4, "Bank rate not supplied", "PENDING_INPUT");
  await mkRow(matterRun, 5, "Supplier 5: confirmed late", "CONFIRMED", { decision: confirmed("REPORT") });
  const otherClientRun = await mkRun("LEDGER_SCAN", otherClientId);
  const foreignRun = await mkRun("LEDGER_SCAN", clientId, otherFirmId);

  await check("the engagement was created", () => assert.ok(engagementId, "engagement creation failed"));

  let materialityId = "";
  await check("a team member drafts a materiality memo: DRAFT FOR REVIEW, figures computed, inputs listed, a replayed request once", async () => {
    const k = key("mem");
    const r = await call("member", "POST", M(), { mutationKey: k, kind: "MATERIALITY", inputs: baseInputs });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const memo = r.json.memos[0];
    materialityId = memo.id;
    assert.equal(memo.status, "DRAFT");
    assert.equal(memo.label, MEMO_DRAFT_LABEL);
    assert.equal(memo.source, "TEMPLATE");
    assert.match(memo.text, /Client: Sharma Traders/);
    assert.match(memo.text, /Overall materiality: ₹5,00,000\.00/);
    assert.equal(memo.inputsListed.find((i) => i.label === "Benchmark").value, "Revenue from operations");
    assert.equal(memo.createdBy.name, "Person member");
    assert.equal(findForbiddenWording(memo.text), null);
    await call("member", "POST", M(), { mutationKey: k, kind: "MATERIALITY", inputs: baseInputs });
    assert.equal((await record()).memos.length, 1);
  });

  await check("bad materiality inputs, an unknown kind, an outsider and another firm are all refused - nothing written", async () => {
    const before = (await record()).memos.length;
    assert.equal((await call("member", "POST", M(), { mutationKey: key("mem"), kind: "MATERIALITY", inputs: { ...baseInputs, percentageBasisPoints: 0 } })).status, 400);
    assert.equal((await call("member", "POST", M(), { mutationKey: key("mem"), kind: "MATERIALITY", inputs: { ...baseInputs, benchmarkAmountMinor: 1.5 } })).status, 400);
    assert.equal((await call("member", "POST", M(), { mutationKey: key("mem"), kind: "OPINION", inputs: {} })).status, 400);
    const off = await call("outsider", "POST", M(), { mutationKey: key("mem"), kind: "MATERIALITY", inputs: baseInputs });
    assert.equal(off.status, 403);
    assert.equal(off.json.code, "ENGAGEMENT_TEAM_REQUIRED");
    assert.equal((await call("elsewhere", "POST", M(), { mutationKey: key("mem"), kind: "MATERIALITY", inputs: baseInputs })).status, 404);
    assert.equal((await call("elsewhere", "GET", M())).status, 404);
    assert.equal((await record()).memos.length, before);
  });

  await check("the team's own word 'verified' is quoted as written and is not refused", async () => {
    const r = await call("member", "POST", M(), { mutationKey: key("mem"), kind: "MATERIALITY", inputs: { ...baseInputs, rationale: "Benchmark verified against the trial balance." } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.match(r.json.memos[0].text, /Benchmark verified against the trial balance\./);
  });

  await check("a sampling memo lists exactly the rows a person confirmed to be looked at, with counts and total", async () => {
    const r = await call("member", "POST", M(), { mutationKey: key("mem"), kind: "SAMPLING", inputs: { runId: String(scanRun), method: "Every item the team marked", populationNote: "All cash vouchers", rationale: "Marked at the close." } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const memo = r.json.memos[0];
    assert.deepEqual(memo.figures.map((f) => f.value), ["2", "2", "₹3,50,000.00"]);
    assert.match(memo.text, /Cash payment above the threshold \(PV-114 2026-02-10\)/);
    assert.ok(!memo.text.includes("Expected Sunday movement") && !memo.text.includes("Not yet decided"), "rows not confirmed to be looked at must not be listed");
    assert.equal(findForbiddenWording(memo.text), null);
  });

  await check("a pack with nothing confirmed to be looked at gives 409 MEMO_NOTHING_SELECTED; another client's pack 409; another firm's 404", async () => {
    const none = await call("member", "POST", M(), { mutationKey: key("mem"), kind: "SAMPLING", inputs: { runId: String(emptyRun), method: "All" } });
    assert.equal(none.status, 409);
    assert.equal(none.json.code, "MEMO_NOTHING_SELECTED");
    const wrong = await call("member", "POST", M(), { mutationKey: key("mem"), kind: "SAMPLING", inputs: { runId: String(otherClientRun), method: "All" } });
    assert.equal(wrong.status, 409);
    assert.equal(wrong.json.code, "ENGAGEMENT_PACK_CLIENT_MISMATCH");
    assert.equal((await call("member", "POST", M(), { mutationKey: key("mem"), kind: "SAMPLING", inputs: { runId: String(foreignRun), method: "All" } })).status, 404);
  });

  await check("the significant matters memo counts the flags left open across the chosen packs", async () => {
    const r = await call("member", "POST", M(), { mutationKey: key("mem"), kind: "SIGNIFICANT_MATTERS", inputs: { runIds: [String(matterRun), String(emptyRun)], matters: "Supplier timing needs the partner." } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const memo = r.json.memos[0];
    assert.deepEqual(memo.figures.map((f) => f.value), ["4", "1", "1"], "3 + 1 undecided, 1 gap, 1 confirmed to be reported");
    assert.match(memo.text, /Supplier 1: bill late/);
    assert.match(memo.text, /Supplier timing needs the partner\./);
    assert.equal((await call("member", "POST", M(), { mutationKey: key("mem"), kind: "SIGNIFICANT_MATTERS", inputs: { runIds: [] } })).status, 400);
    assert.equal((await call("member", "POST", M(), { mutationKey: key("mem"), kind: "SIGNIFICANT_MATTERS", inputs: { runIds: Array.from({ length: 11 }, () => String(oid())) } })).status, 400, "eleven distinct packs are over the limit of ten");
  });

  await check("the team edits a draft: the source records that it was edited, by whom; short text is refused", async () => {
    const edited = "MATERIALITY MEMO - edited by the team. Overall materiality as recorded above stays the same.";
    const r = await call("member", "PATCH", M(`/${materialityId}`), { mutationKey: key("edit"), text: edited });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const memo = r.json.memos.find((m) => m.id === materialityId);
    assert.equal(memo.source, "TEMPLATE_EDITED");
    assert.equal(memo.editedBy.name, "Person member");
    assert.equal(memo.text, edited);
    assert.equal((await call("member", "PATCH", M(`/${materialityId}`), { mutationKey: key("edit"), text: "short" })).status, 400);
    assert.equal((await call("outsider", "PATCH", M(`/${materialityId}`), { mutationKey: key("edit"), text: edited })).status, 403);
  });

  await check("only the assigned reviewer signs: a member and the owner are refused", async () => {
    for (const who of ["member", "owner"]) {
      const r = await call(who, "POST", M(`/${materialityId}/sign`), { mutationKey: key("sign") });
      assert.equal(r.status, 403, who);
      assert.equal(r.json.code, "ENGAGEMENT_REVIEWER_REQUIRED");
    }
    assert.equal((await record()).memos.find((m) => String(m._id) === materialityId).status, "DRAFT");
  });

  await check("the reviewer signs: SIGNED, named and dated, the text's hash kept; signing again is the same; editing after is refused", async () => {
    const r = await call("reviewer", "POST", M(`/${materialityId}/sign`), { mutationKey: key("sign") });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const memo = r.json.memos.find((m) => m.id === materialityId);
    assert.equal(memo.status, "SIGNED");
    assert.equal(memo.label, "SIGNED");
    assert.equal(memo.signedBy.name, "Person reviewer");
    assert.equal(memo.textMatchesSigned, true);
    const stored = (await record()).memos.find((m) => String(m._id) === materialityId);
    assert.equal(stored.signedTextHash, crypto.createHash("sha256").update(stored.text, "utf8").digest("hex"));
    assert.equal((await call("reviewer", "POST", M(`/${materialityId}/sign`), { mutationKey: key("sign") })).status, 200);
    const edit = await call("member", "PATCH", M(`/${materialityId}`), { mutationKey: key("edit"), text: "A later change that must not be allowed to land." });
    assert.equal(edit.status, 409);
    assert.equal(edit.json.code, "MEMO_SIGNED");
    assert.equal((await record()).memos.find((m) => String(m._id) === materialityId).text, stored.text);
  });

  await check("the memos, dumped for the desktop's fixtures (a signed one and drafts of the other kinds)", async () => {
    const r = await call("owner", "GET", M());
    assert.equal(r.status, 200);
    await dump("memos", r.json);
  });

  await check("a memo changed behind the signature is reported: the text no longer matches what was signed", async () => {
    await raw("engagementassurances").updateOne({ engagementId: new mongoose.Types.ObjectId(engagementId) }, { $set: { "memos.$[m].text": "Tampered with directly in the database." } }, { arrayFilters: [{ "m._id": new mongoose.Types.ObjectId(materialityId) }] });
    const r = await call("owner", "GET", M());
    assert.equal(r.json.memos.find((m) => m.id === materialityId).textMatchesSigned, false);
  });

  await check("an engagement holds at most 40 memos: the 41st is refused 409", async () => {
    const have = (await record()).memos.length;
    for (let i = have; i < 40; i += 1) {
      const ok = await call("member", "POST", M(), { mutationKey: key("fill"), kind: "MATERIALITY", inputs: baseInputs });
      assert.equal(ok.status, 200, `memo ${i + 1}: ${JSON.stringify(ok.json)?.slice(0, 120)}`);
    }
    const over = await call("member", "POST", M(), { mutationKey: key("over"), kind: "MATERIALITY", inputs: baseInputs });
    assert.equal(over.status, 409);
    assert.equal(over.json.code, "ASSURANCE_LIMIT");
  });

  server.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}

console.log(`\nengagement-memo-contract: ${passed}/${passed + failed} passed${uri ? " (scratch Mongo included)" : " (pure checks only - no scratch Mongo)"}`);
if (failed) process.exitCode = 1;
