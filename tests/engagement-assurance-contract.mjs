// tests/engagement-assurance-contract.mjs
//
// W10 AP38 (2026-10-17). Attribution, independence and the 60-day assembly of an engagement's file.
//
//   - Independence is confirmed by each team member FOR THEMSELF, dated; nobody else's, and not by people
//     off the team. Confirming twice is two dated confirmations (the later is current), a replayed request
//     is one.
//   - The assigned reviewer (and nobody else) sets the report date and records the assembly; the timer
//     counts UTC DAYS from the report date, identically under every time zone.
//   - After assembly a change is LOGGED with a reason; before it there is nothing to log; and the working-
//     paper rows added after assembly are counted from their own creation times.
//   - Every schedule shows who prepared it and who reviews the engagement.
//   - Time is append-only: a mistaken entry is voided, and more than 24 hours for one person on one day
//     is refused.
//
// Pure checks always run. Route checks need the replica set (engagement creation uses transactions);
// MONGODB_URI is set by tools/run-gates.ps1; by hand:
//   MONGODB_URI=mongodb://127.0.0.1:27118/scratch-gates-engagement-assurance?replicaSet=rs0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ASSEMBLY_DAYS, INDEPENDENCE_STATEMENT, assemblyStatus } from "../src/services/engagement-assurance.service.js";

const here = dirname(fileURLToPath(import.meta.url));

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

// ── Pure: the timer ────────────────────────────────────────────────────────────────────────────

await check("the assembly period is 60 UTC days from the report date", () => {
  assert.equal(ASSEMBLY_DAYS, 60);
  const s = assemblyStatus({ reportDate: "2026-08-01", assembledAt: null }, new Date("2026-08-01T10:00:00Z"));
  assert.equal(s.deadline, "2026-09-30");
  assert.equal(s.daysLeft, 60);
  assert.equal(s.state, "OPEN");
});

await check("the last day is still open; the next UTC day is overdue by one", () => {
  const last = assemblyStatus({ reportDate: "2026-08-01", assembledAt: null }, new Date("2026-09-30T23:59:59Z"));
  assert.deepEqual([last.state, last.daysLeft], ["OPEN", 0]);
  const next = assemblyStatus({ reportDate: "2026-08-01", assembledAt: null }, new Date("2026-10-01T00:00:00Z"));
  assert.deepEqual([next.state, next.daysLeft, next.lateByDays], ["OVERDUE", -1, 1]);
});

await check("assembled on or before the deadline is ASSEMBLED; after it, ASSEMBLED_LATE by the days over", () => {
  const ok = assemblyStatus({ reportDate: "2026-08-01", assembledAt: new Date("2026-09-30T23:00:00Z") });
  assert.deepEqual([ok.state, ok.assembledOn, ok.lateByDays], ["ASSEMBLED", "2026-09-30", 0]);
  const late = assemblyStatus({ reportDate: "2026-08-01", assembledAt: new Date("2026-10-02T01:00:00Z") });
  assert.deepEqual([late.state, late.assembledOn, late.lateByDays], ["ASSEMBLED_LATE", "2026-10-02", 2]);
});

await check("no report date, or an unreadable one, is NOT_SET - never a guessed deadline", () => {
  for (const reportDate of [null, undefined, "", "2026-02-30", "garbage"]) {
    const s = assemblyStatus({ reportDate, assembledAt: null });
    assert.equal(s.state, "NOT_SET");
    assert.equal(s.deadline, null);
    assert.equal(s.daysLeft, null);
  }
});

await check("the timer's answers are identical under UTC, India, Los Angeles, UTC-11 and UTC+14", () => {
  const zones = ["UTC", "Asia/Kolkata", "America/Los_Angeles", "Pacific/Pago_Pago", "Pacific/Kiritimati"];
  const answers = zones.map((zone) => {
    const run = spawnSync(process.execPath, [join(here, "lib", "assurance-tz-probe.mjs")], { env: { ...process.env, TZ: zone }, encoding: "utf8" });
    assert.equal(run.status, 0, `probe failed under ${zone}: ${(run.stderr || "").slice(0, 200)}`);
    return [zone, run.stdout.trim()];
  });
  for (const [zone, answer] of answers) assert.equal(answer, answers[0][1], `${zone} answered differently from ${answers[0][0]}`);
  const parsed = JSON.parse(answers[0][1]);
  assert.deepEqual(parsed.open["2026-09-30T23:59:59Z"], ["OPEN", "2026-09-30", 0, 0]);
  assert.deepEqual(parsed.open["2026-10-01T00:00:00Z"], ["OVERDUE", "2026-09-30", -1, 1]);
});

// ── Routes ─────────────────────────────────────────────────────────────────────────────────────

// Transactions need the replica set; tools/run-gates.ps1 does not override this URI for the replica-set suites.
const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27118/scratch-gates-engagement-assurance?replicaSet=rs0";
const dbName = (uri.split("/").pop() || "").split("?")[0];
const host = (uri.split("//")[1] || "").split("/")[0];

if (!uri) {
  console.log("[NOT RUN] the route checks - no MONGODB_URI (tools/run-gates.ps1 provides the replica-set scratch one)");
} else if (!/scratch/i.test(dbName) || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
  console.error(`[FAIL] refusing to touch ${host}/${dbName}: the database must be loopback and scratch-named`);
  failed += 1;
} else {
  process.env.NODE_ENV = "production";
  process.env.MONGODB_URI = uri; // the app import requires it, even when this file defaulted it (the runner sets none)
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
  const todayUtc = new Date(Math.floor(now.getTime() / 86_400_000) * 86_400_000);
  const dayString = (offsetDays) => new Date(todayUtc.getTime() + offsetDays * 86_400_000).toISOString().slice(0, 10);

  const ownerId = oid();
  const reviewerId = oid();
  const memberId = oid();
  const outsiderId = oid();
  const otherFirmUserId = oid();
  const firmId = oid();
  const otherFirmId = oid();
  const clientId = oid();
  const users = [[ownerId, "owner", firmId], [reviewerId, "reviewer", firmId], [memberId, "member", firmId], [outsiderId, "outsider", firmId], [otherFirmUserId, "elsewhere", otherFirmId]];
  for (const [id, tag, fid] of users) {
    await raw("users").insertOne({ _id: id, email: `${tag}-assure@scratch.test`, name: `Person ${tag}`, role: "FIRM_ADMIN", accountType: "FIRM_USER", isActive: true, tokenVersion: 0, firmId: fid, createdAt: now, updatedAt: now });
    await raw("firmmemberships").insertOne({ _id: oid(), firmId: fid, userId: id, status: "ACTIVE", role: id === ownerId || id === otherFirmUserId ? "OWNER" : "FIRM_ADMIN", memberAccess: "FULL", createdAt: now, updatedAt: now });
  }
  // A view-only member of the firm, put on an engagement's team (nothing stops that; the owner question is whether
  // such a member may confirm their own independence and record their own time - pinned below as it stands).
  const viewerId = oid();
  await raw("users").insertOne({ _id: viewerId, email: "viewer-assure@scratch.test", name: "Person viewer", role: "USER", accountType: "FIRM_USER", isActive: true, tokenVersion: 0, firmId, createdAt: now, updatedAt: now });
  await raw("firmmemberships").insertOne({ _id: oid(), firmId, userId: viewerId, status: "ACTIVE", role: "VIEWER", memberAccess: "FULL", createdAt: now, updatedAt: now });
  await raw("firms").insertMany([
    { _id: firmId, name: "Assurance Firm", displayName: "Assurance Firm", handle: "scratch-assure", ownerId, ownerUserId: ownerId, type: "FIRM", isActive: true, joinCode: "JASSUR1", createdAt: now, updatedAt: now },
    { _id: otherFirmId, name: "Other Firm", displayName: "Other Firm", handle: "scratch-assure-o", ownerId: otherFirmUserId, ownerUserId: otherFirmUserId, type: "FIRM", isActive: true, joinCode: "JASSUR2", createdAt: now, updatedAt: now },
  ]);
  await raw("clients").insertOne({ _id: clientId, firmId, name: "Assure Client", isActive: true, createdAt: now, updatedAt: now });
  await raw("appconfigs").insertOne({ _id: "singleton", featureFlags: { auditPacks: true, auditWorkingPapers: true, assuranceEngagements: true }, createdAt: now, updatedAt: now });

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const tokenFor = (id, tag, fid) => jwt.sign({ id, email: `${tag}-assure@scratch.test`, role: "FIRM_ADMIN", accountType: "FIRM_USER", firmId: fid, isActive: true, tv: 0 }, process.env.JWT_SECRET, { expiresIn: "30m" });
  const T = { owner: tokenFor(ownerId, "owner", firmId), reviewer: tokenFor(reviewerId, "reviewer", firmId), member: tokenFor(memberId, "member", firmId), outsider: tokenFor(outsiderId, "outsider", firmId), elsewhere: tokenFor(otherFirmUserId, "elsewhere", otherFirmId) };
  T.viewer = jwt.sign({ id: viewerId, email: "viewer-assure@scratch.test", role: "USER", accountType: "FIRM_USER", firmId, isActive: true, tv: 0 }, process.env.JWT_SECRET, { expiresIn: "30m" });
  const call = async (who, method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: { Authorization: `Bearer ${T[who]}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  };

  const makeEngagement = async (tag) => {
    const created = await call("owner", "POST", "/api/engagements", {
      mutationKey: `seed-engagement-${tag}`,
      clientId: String(clientId),
      engagementType: "TAX_AUDIT",
      reviewerUserId: String(reviewerId),
      teamUserIds: [String(memberId)],
      scope: "Statutory audit under section 44AB for FY 2025-26.",
      startDate: "2026-04-01",
      targetDate: "2026-10-15",
    });
    return created.json?.engagement?.id || created.json?.engagement?._id;
  };
  const engagementId = await makeEngagement("a");
  const A = (suffix = "") => `/api/engagements/${engagementId}/assurance${suffix}`;
  const record = () => raw("engagementassurances").findOne({ engagementId: new mongoose.Types.ObjectId(engagementId) });
  let n = 0;
  const key = (label) => `${label}-${(n += 1)}-assure`;

  await check("the engagement was created with the member on its team", () => {
    assert.ok(engagementId, "engagement creation failed");
  });

  await check("a fresh engagement: every team member listed with their role, nobody confirmed, no report date, no schedules", async () => {
    const r = await call("owner", "GET", A());
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const a = r.json.assurance;
    assert.deepEqual(a.team.map((m) => m.roles.join("+")).sort(), ["MEMBER", "OWNER", "REVIEWER"]);
    assert.ok(a.team.every((m) => m.independence === null));
    assert.deepEqual(a.independence, { confirmed: 0, pending: 3 });
    assert.equal(a.report.state, "NOT_SET");
    assert.deepEqual(a.schedules, []);
    assert.equal(a.rowsAddedAfterAssembly, null);
    assert.equal(a.assemblyDays, 60);
  });

  await check("a team member confirms independence for themself, dated; a replayed request records it once", async () => {
    const k = key("ind");
    const before = Date.now();
    const r = await call("member", "POST", A("/independence"), { mutationKey: k, confirmed: true, note: "No interests held." });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const mine = r.json.assurance.team.find((m) => m.roles.includes("MEMBER"));
    assert.equal(mine.independence.statement, INDEPENDENCE_STATEMENT);
    assert.equal(mine.independence.note, "No interests held.");
    assert.ok(Math.abs(new Date(mine.independence.confirmedAt).getTime() - before) < 60_000);
    assert.deepEqual(r.json.assurance.independence, { confirmed: 1, pending: 2 });
    await call("member", "POST", A("/independence"), { mutationKey: k, confirmed: true, note: "No interests held." });
    assert.equal((await record()).independence.length, 1, "a replay must not record a second confirmation");
  });

  await check("confirming again with a new key is a second, later confirmation: the record keeps both, the latest is current", async () => {
    const r = await call("member", "POST", A("/independence"), { mutationKey: key("ind"), confirmed: true, note: "Re-confirmed at year end." });
    assert.equal(r.status, 200);
    assert.equal((await record()).independence.length, 2);
    assert.equal(r.json.assurance.team.find((m) => m.roles.includes("MEMBER")).independence.note, "Re-confirmed at year end.");
    assert.deepEqual(r.json.assurance.independence, { confirmed: 1, pending: 2 });
  });

  await check("confirmation needs confirmed:true; a firm member NOT on the team is refused 403; another firm's user 404 - nothing written", async () => {
    const lengthBefore = (await record()).independence.length;
    assert.equal((await call("member", "POST", A("/independence"), { mutationKey: key("ind") })).status, 400);
    const off = await call("outsider", "POST", A("/independence"), { mutationKey: key("ind"), confirmed: true });
    assert.equal(off.status, 403);
    assert.equal(off.json.code, "ENGAGEMENT_TEAM_REQUIRED");
    assert.equal((await call("elsewhere", "POST", A("/independence"), { mutationKey: key("ind"), confirmed: true })).status, 404);
    assert.equal((await call("elsewhere", "GET", A())).status, 404);
    assert.equal((await record()).independence.length, lengthBefore);
  });

  await check("a view-only member on the team reads the file but is refused confirming independence and recording time (the firm write guard) - nothing written", async () => {
    // Pinned as it stands (2026-10-18). Both clients now leave these controls out for a view-only member and say why;
    // whether such a member should be able to confirm their own independence is the owner's question (OWNER-TODO).
    const created = await call("owner", "POST", "/api/engagements", {
      mutationKey: "seed-engagement-viewer",
      clientId: String(clientId),
      engagementType: "TAX_AUDIT",
      reviewerUserId: String(reviewerId),
      teamUserIds: [String(memberId), String(viewerId)],
      scope: "Statutory audit under section 44AB for FY 2025-26.",
      startDate: "2026-04-01",
      targetDate: "2026-10-15",
    });
    const id = created.json?.engagement?.id || created.json?.engagement?._id;
    assert.ok(id, JSON.stringify(created.json));
    const V = (suffix = "") => `/api/engagements/${id}/assurance${suffix}`;
    const read = await call("viewer", "GET", V());
    assert.equal(read.status, 200, JSON.stringify(read.json));
    assert.deepEqual(read.json.assurance.team.find((m) => m.userId === String(viewerId))?.roles, ["MEMBER"], "the viewer is listed on the team");
    for (const [path, body] of [["/independence", { confirmed: true }], ["/time", { workDay: dayString(-1), minutes: 30, note: "x" }]]) {
      const refused = await call("viewer", "POST", V(path), { mutationKey: key("viewer"), ...body });
      assert.equal(refused.status, 403, `${path}: ${JSON.stringify(refused.json)}`);
      assert.match(refused.json.error, /view-only/);
    }
    const stored = await raw("engagementassurances").findOne({ engagementId: new mongoose.Types.ObjectId(id) });
    assert.equal(stored?.independence?.length || 0, 0);
    assert.equal(stored?.timeEntries?.length || 0, 0);
  });

  await check("nothing to log before assembly: a modification is refused 409 NOT_ASSEMBLED", async () => {
    const r = await call("member", "POST", A("/modifications"), { mutationKey: key("mod"), kind: "OTHER", reason: "Corrected a date." });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, "ASSURANCE_NOT_ASSEMBLED");
  });

  await check("assembling needs the report date first", async () => {
    const r = await call("reviewer", "POST", A("/assemble"), { mutationKey: key("asm") });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, "ASSURANCE_REPORT_DATE_REQUIRED");
  });

  await check("only the assigned reviewer sets the report date; a bad day is refused", async () => {
    const wrong = await call("member", "POST", A("/report-date"), { mutationKey: key("rd"), reportDate: dayString(-10) });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.json.code, "ENGAGEMENT_REVIEWER_REQUIRED");
    assert.equal((await call("owner", "POST", A("/report-date"), { mutationKey: key("rd"), reportDate: dayString(-10) })).status, 403, "the owner is not the reviewer");
    for (const bad of ["2026-02-30", "2026-10-31T00:00:00Z", "", null, "tomorrow"]) {
      assert.equal((await call("reviewer", "POST", A("/report-date"), { mutationKey: key("rd"), reportDate: bad })).status, 400, `${bad}`);
    }
    assert.equal((await record()).reportDate ?? null, null);
  });

  await check("the reviewer sets the report date: the deadline is 60 UTC days on and days left count down from today", async () => {
    const r = await call("reviewer", "POST", A("/report-date"), { mutationKey: key("rd"), reportDate: dayString(-10) });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const rep = r.json.assurance.report;
    assert.equal(rep.state, "OPEN");
    assert.equal(rep.reportDate, dayString(-10));
    assert.equal(rep.deadline, dayString(50));
    assert.equal(rep.daysLeft, 50);
    assert.equal(rep.setBy.name, "Person reviewer");
  });

  // A working paper by the member, so a schedule exists and rows can be added after assembly.
  let paperId = "";
  await check("a schedule shows its preparer and the engagement's reviewer", async () => {
    const attest = await call("reviewer", "POST", `/api/engagements/${engagementId}/review`, { mutationKey: key("attest"), action: "ATTEST_TEMPLATE", expectedRevision: (await raw("engagements").findOne({ _id: new mongoose.Types.ObjectId(engagementId) })).revision, reviewerName: "Person reviewer", confirmed: true, credentialReference: "SCRATCH-MEMBER-00000" });
    assert.ok([200, 201].includes(attest.status), `attestation: ${attest.status} ${JSON.stringify(attest.json)?.slice(0, 160)}`);
    const paper = await call("member", "POST", "/api/engagements/working-papers", { mutationKey: key("paper"), engagementId: String(engagementId), title: "Cash and bank", purpose: "Cash and bank tested.", period: "FY 2025-26" });
    paperId = paper.json?.paper?.id || paper.json?.paper?._id;
    assert.ok(paperId, `working paper: ${paper.status} ${JSON.stringify(paper.json)?.slice(0, 160)}`);
    const r = await call("owner", "GET", A());
    assert.deepEqual(r.json.assurance.schedules.map((s) => [s.title, s.preparedBy.name, s.reviewer.name, s.rows]), [["Cash and bank", "Person member", "Person reviewer", 0]]);
  });

  await check("the reviewer records the assembly: ASSEMBLED, and nothing has been added since", async () => {
    const k = key("asm");
    const r = await call("reviewer", "POST", A("/assemble"), { mutationKey: k });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.assurance.report.state, "ASSEMBLED");
    assert.equal(r.json.assurance.report.assembledBy.name, "Person reviewer");
    assert.equal(r.json.assurance.rowsAddedAfterAssembly, 0);
    assert.equal((await call("reviewer", "POST", A("/assemble"), { mutationKey: k })).status, 200, "the same request replayed is fine");
    const again = await call("reviewer", "POST", A("/assemble"), { mutationKey: key("asm") });
    assert.equal(again.status, 409);
    assert.equal(again.json.code, "ASSURANCE_ALREADY_ASSEMBLED");
  });

  await check("once assembled the report date cannot be changed - the change is logged instead", async () => {
    const r = await call("reviewer", "POST", A("/report-date"), { mutationKey: key("rd"), reportDate: dayString(-5) });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, "ASSURANCE_ASSEMBLED");
    assert.equal((await record()).reportDate, dayString(-10));
  });

  await check("a row added to a working paper after assembly is counted from its own creation time", async () => {
    const paperDoc = await raw("auditworkingpapers").findOne({ _id: new mongoose.Types.ObjectId(paperId) });
    const added = await call("member", "POST", `/api/engagements/working-papers/${paperId}/rows`, {
      mutationKey: key("row"),
      expectedRevision: paperDoc.revision,
      rowKey: "POST-ASSEMBLY-1",
      description: "Bank balance agreed to the statement.",
      sourceReference: "Bank statement, 31 March",
    });
    assert.ok([200, 201].includes(added.status), `row: ${added.status} ${JSON.stringify(added.json)?.slice(0, 200)}`);
    const r = await call("owner", "GET", A());
    assert.equal(r.json.assurance.rowsAddedAfterAssembly, 1);
    assert.equal(r.json.assurance.schedules[0].rows, 1);
  });

  await check("after assembly a team member logs a change with its reason; a short reason or unknown kind is refused", async () => {
    const ok = await call("member", "POST", A("/modifications"), { mutationKey: key("mod"), kind: "ADDED_AFTER_ASSEMBLY", reason: "Bank confirmation received late." });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.deepEqual(ok.json.assurance.modifications.map((m) => [m.kind, m.reason, m.by.name]), [["ADDED_AFTER_ASSEMBLY", "Bank confirmation received late.", "Person member"]]);
    assert.equal((await call("member", "POST", A("/modifications"), { mutationKey: key("mod"), kind: "ADDED_AFTER_ASSEMBLY", reason: "x" })).status, 400);
    assert.equal((await call("member", "POST", A("/modifications"), { mutationKey: key("mod"), kind: "SECRET", reason: "Because." })).status, 400);
    assert.equal((await call("outsider", "POST", A("/modifications"), { mutationKey: key("mod"), kind: "OTHER", reason: "Because." })).status, 403);
    assert.equal((await record()).modifications.length, 1);
  });

  await check("late assembly is recorded as late, by how many days", async () => {
    const second = await makeEngagement("late");
    const base = `/api/engagements/${second}/assurance`;
    assert.equal((await call("reviewer", "POST", `${base}/report-date`, { mutationKey: key("rd"), reportDate: dayString(-100) })).status, 200);
    const r = await call("reviewer", "POST", `${base}/assemble`, { mutationKey: key("asm") });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.assurance.report.state, "ASSEMBLED_LATE");
    assert.equal(r.json.assurance.report.lateByDays, 40);
  });

  await check("a report date 70 days ago with no assembly reads OVERDUE by 10 days", async () => {
    const third = await makeEngagement("overdue");
    const r = await call("reviewer", "POST", `/api/engagements/${third}/assurance/report-date`, { mutationKey: key("rd"), reportDate: dayString(-70) });
    assert.equal(r.json.assurance.report.state, "OVERDUE");
    assert.equal(r.json.assurance.report.daysLeft, -10);
  });

  let memberEntryId = "";
  await check("time is recorded for oneself on a real day that has happened; bad minutes, a future day, and over 24 hours are refused", async () => {
    const ok = await call("member", "POST", A("/time"), { mutationKey: key("time"), workDay: dayString(-1), minutes: 90, note: "Cash testing" });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    memberEntryId = ok.json.assurance.time.recent[0].id;
    assert.equal(ok.json.assurance.time.totalMinutes, 90);
    for (const minutes of [0, -5, 1441, 1.5, "90", null]) {
      assert.equal((await call("member", "POST", A("/time"), { mutationKey: key("time"), workDay: dayString(-1), minutes })).status, 400, `minutes ${minutes}`);
    }
    assert.equal((await call("member", "POST", A("/time"), { mutationKey: key("time"), workDay: dayString(3), minutes: 30 })).status, 400, "a future day");
    assert.equal((await call("member", "POST", A("/time"), { mutationKey: key("time"), workDay: "2026-02-30", minutes: 30 })).status, 400);
    const over = await call("member", "POST", A("/time"), { mutationKey: key("time"), workDay: dayString(-1), minutes: 1400 });
    assert.equal(over.status, 409);
    assert.equal(over.json.code, "ASSURANCE_DAY_OVERFLOW");
    assert.equal((await call("outsider", "POST", A("/time"), { mutationKey: key("time"), workDay: dayString(-1), minutes: 30 })).status, 403);
  });

  await check("a replayed time request records once", async () => {
    const k = key("time");
    await call("reviewer", "POST", A("/time"), { mutationKey: k, workDay: dayString(-1), minutes: 45 });
    await call("reviewer", "POST", A("/time"), { mutationKey: k, workDay: dayString(-1), minutes: 45 });
    const live = (await record()).timeEntries.filter((t) => String(t.userId) === String(reviewerId));
    assert.equal(live.length, 1);
  });

  await check("voiding: the person (or the reviewer) can; another team member cannot; the entry stays, marked, and drops out of the total", async () => {
    const other = await call("owner", "POST", A(`/time/${memberEntryId}/void`), { mutationKey: key("void") });
    assert.equal(other.status, 403, "the owner is neither the person nor the reviewer");
    const ok = await call("member", "POST", A(`/time/${memberEntryId}/void`), { mutationKey: key("void") });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    const entry = ok.json.assurance.time.recent.find((t) => t.id === memberEntryId);
    assert.equal(entry.voided, true, "the voided entry stays on the record");
    assert.equal(ok.json.assurance.time.totalMinutes, 45, "only the reviewer's 45 minutes still count");
    const dayAgain = await call("member", "POST", A("/time"), { mutationKey: key("time"), workDay: dayString(-1), minutes: 1400 });
    assert.equal(dayAgain.status, 200, "a voided entry no longer counts toward the day's 24 hours");
  });

  await check("the whole picture after the voiding, dumped for the desktop's fixtures", async () => {
    const r = await call("owner", "GET", A());
    assert.equal(r.status, 200);
    await dump("assurance", r.json);
  });

  await check("with auditPacks off every assurance route answers 404 naming the flag - the owner's one switch for the W10 surfaces", async () => {
    await raw("appconfigs").updateOne({ _id: "singleton" }, { $set: { "featureFlags.auditPacks": false } });
    const routes = [
      ["GET", A()],
      ["POST", A("/independence")],
      ["POST", A("/report-date")],
      ["POST", A("/assemble")],
      ["POST", A("/modifications")],
      ["POST", A("/time")],
      ["POST", A(`/time/${memberEntryId}/void`)],
    ];
    for (const [method, path] of routes) {
      const r = await call("owner", method, path, method === "GET" ? undefined : { mutationKey: key("off") });
      assert.equal(r.status, 404, `${method} ${path}: ${r.status} ${JSON.stringify(r.json)}`);
      assert.equal(r.json.featureFlag, "auditPacks");
    }
  });

  server.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}

console.log(`\nengagement-assurance-contract: ${passed}/${passed + failed} passed${uri ? " (scratch Mongo included)" : " (pure checks only - no scratch Mongo)"}`);
if (failed) process.exitCode = 1;
