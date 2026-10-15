// tests/audit-usage-tracking-contract.mjs
//
// AP1 (2026-10-15). WHY THIS EXISTS
// ---------------------------------
// "audit_review" was in the WorkflowUsage enum from the start, but no route recorded it, and
// engagements and working papers had no count at all. The admin panel could therefore never show
// whether anyone used audit assistance, engagements or working papers - the question the owner
// asked ("many things like audit assistance are not used by users, I do not know why"). The only
// signal was the shared AI-provider counter, which every AI feature feeds at once.
//
// workflow-usage-contract.mjs pins the route SOURCE (the tracker is written there). This suite pins
// the BEHAVIOUR through the real Express app against a scratch database:
//   - one answered request to each route family records exactly one row under its own name, and
//     never under the other two (the engagement router picks one name per request by path);
//   - a refused request (400) records nothing;
//   - the super-admin dashboard reports engagements by type and status and a working-paper count.
//
// The AI key is blanked before the app loads, so /api/audit/refine answers 200 "not configured"
// without any provider call: this suite never spends a paid request.
//
// SAFETY: refuses to run unless MONGODB_URI is loopback and names a scratch database; it drops that
// database at the start. Ends with process.exitCode, never process.exit() (V32: exiting after a
// fetch aborts Node 24 on Windows).
import mongoose from "mongoose";
import jwt from "jsonwebtoken";

process.env.NODE_ENV = "production";
process.env.JWT_SECRET = process.env.JWT_SECRET || "scratch-only-secret-not-a-real-credential-0000";
// No default database: like resend-webhook-e2e and usage-stats-contract, this suite runs only where
// the gate runner (or a person) names a scratch database. Run:
//   MONGODB_URI=mongodb://127.0.0.1:27117/scratch-audit-usage node tests/audit-usage-tracking-contract.mjs
// Blank, not deleted: dotenv never overrides a variable that is already defined, so an empty value
// keeps the real key in .env out of this process.
process.env.DEEPSEEK_API_KEY = "";
process.env.OCR_SPACE_API_KEY = "";

const uri = process.env.MONGODB_URI || "";
const dbName = (uri.split("/").pop() || "").split("?")[0];
const loopback = /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(uri);

if (!loopback || !/scratch/i.test(dbName)) {
  console.error(`REFUSING TO RUN: "${uri}" is not a loopback scratch database.`);
  process.exitCode = 2;
} else {
  process.exitCode = await runSuite();
}

async function runSuite() {
  const checks = [];
  const check = (name, pass, detail = "") => checks.push({ name, pass: Boolean(pass), detail });

  const { default: app } = await import("../src/app.js");
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
  await mongoose.connection.dropDatabase();
  const { ensureRequiredIndexes } = await import("../src/services/index-provisioning.service.js");
  await ensureRequiredIndexes();

  const raw = (name) => mongoose.connection.collection(name);
  const oid = () => new mongoose.Types.ObjectId();
  const now = new Date();

  // One firm and its owner (the shape cross-tenant-isolation.mjs documents as load-bearing).
  const ownerId = oid();
  const firmId = oid();
  await raw("users").insertOne({
    _id: ownerId, email: "owner-usage@scratch.test", name: "Owner Usage", role: "FIRM_ADMIN",
    accountType: "FIRM_USER", isActive: true, tokenVersion: 0, firmId, createdAt: now, updatedAt: now,
  });
  await raw("firms").insertOne({
    _id: firmId, name: "Scratch Usage Firm", displayName: "Scratch Usage Firm",
    handle: "scratch-usage", ownerId, ownerUserId: ownerId, type: "FIRM", isActive: true,
    joinCode: `SCRATCHUSAGE${Date.now().toString(36).toUpperCase()}`, createdAt: now, updatedAt: now,
  });
  await raw("firmmemberships").insertOne({
    _id: oid(), firmId, userId: ownerId, status: "ACTIVE", role: "OWNER", memberAccess: "FULL",
    createdAt: now, updatedAt: now,
  });
  const ownerToken = jwt.sign(
    { id: ownerId, email: "owner-usage@scratch.test", role: "FIRM_ADMIN", accountType: "FIRM_USER",
      firmId, isActive: true, tv: 0 },
    process.env.JWT_SECRET, { expiresIn: "30m" },
  );

  // The super admin is identified by role AND the one address super.controller.js names. It owns no
  // firm here, so the owner-account exclusion leaves the scratch firm's records in the counts.
  const superId = oid();
  const superEmail = "saifullahfaizan786@gmail.com";
  await raw("users").insertOne({
    _id: superId, email: superEmail, name: "Super Scratch", role: "SUPER_ADMIN",
    accountType: "FIRM_USER", isActive: true, tokenVersion: 0, createdAt: now, updatedAt: now,
  });
  const superToken = jwt.sign(
    { id: superId, email: superEmail, role: "SUPER_ADMIN", accountType: "FIRM_USER", isActive: true, tv: 0 },
    process.env.JWT_SECRET, { expiresIn: "30m" },
  );

  // Engagement routes sit behind two flags that default off; with them off every request answers
  // 404 and nothing is counted, which would read like a passing "nothing recorded" check.
  await raw("appconfigs").insertOne({
    _id: "singleton",
    featureFlags: { assuranceEngagements: true, auditWorkingPapers: true, fullTabWorkspace: true },
    createdAt: now, updatedAt: now,
  });

  // One engagement and one working paper in the firm, for the dashboard counts. Native inserts:
  // the subject here is counting, not the create paths.
  const engagementId = oid();
  await raw("engagements").insertOne({
    _id: engagementId, firmId, engagementType: "STATUTORY_AUDIT", status: "PLANNING", title: "Scratch",
    createdAt: now, updatedAt: now,
  });
  await raw("auditworkingpapers").insertOne({
    _id: oid(), firmId, engagementId, clientId: oid(), title: "Scratch paper",
    createdAt: now, updatedAt: now,
  });

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, token, body) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, json };
  };

  const usageRows = () => raw("workflowusages").find({}).toArray();
  // Recording happens on the response's "finish" event, after the client already has the answer.
  const waitForRows = async (expectedCount) => {
    for (let i = 0; i < 40; i += 1) {
      const rows = await usageRows();
      const total = rows.reduce((sum, row) => sum + (row.count || 0), 0);
      if (total >= expectedCount) return rows;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return usageRows();
  };

  try {
    const refine = await call("POST", "/api/audit/refine", ownerToken, {
      rawText: "Physical verification of inventory was carried out on 31 March by management.",
    });
    check("POST /api/audit/refine answers 200 without an AI key (no provider call)",
      refine.status === 200 && refine.json?.refined === false, `status ${refine.status}`);

    const templates = await call("GET", "/api/engagements/templates", ownerToken);
    check("GET /api/engagements/templates answers 200", templates.status === 200, `status ${templates.status}`);

    // The list is per engagement: without ?engagementId it is refused 400, which is not use.
    const papers = await call("GET", `/api/engagements/working-papers?engagementId=${engagementId}`, ownerToken);
    check("GET /api/engagements/working-papers?engagementId= answers 200 with the firm's paper",
      papers.status === 200 && papers.json?.pagination?.total === 1, `status ${papers.status}`);

    let rows = await waitForRows(3);
    const byName = Object.fromEntries(rows.map((row) => [row.workflow, row]));
    for (const name of ["audit_review", "engagement", "working_paper"]) {
      check(`one answered request records exactly one "${name}" row with count 1`,
        byName[name]?.count === 1 && byName[name]?.outcomeCounts?.ok === 1,
        JSON.stringify(byName[name] ? { count: byName[name].count, ok: byName[name].outcomeCounts?.ok } : null));
    }
    check("no request was counted under any other name",
      rows.every((row) => ["audit_review", "engagement", "working_paper"].includes(row.workflow)),
      rows.map((row) => row.workflow).join(", "));
    check("the rows carry the firm and the signed-in client, nothing else identifying",
      rows.every((row) => String(row.firmId) === String(firmId) && row.client === "extension"));

    // A refused request is not use.
    const refused = await call("POST", "/api/audit/refine", ownerToken, {});
    check("a request without text is refused 400", refused.status === 400, `status ${refused.status}`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    rows = await usageRows();
    const audit = rows.find((row) => row.workflow === "audit_review");
    check("the refused request recorded nothing (audit_review still 1)", audit?.count === 1, `count ${audit?.count}`);

    // The dashboard reports what was never visible before.
    const dashboard = await call("GET", "/api/super/dashboard-stats", superToken);
    const stats = dashboard.json?.stats || {};
    check("dashboard-stats answers 200 for the super admin", dashboard.status === 200, `status ${dashboard.status}`);
    check("dashboard counts 1 engagement", stats.engagements?.total === 1, JSON.stringify(stats.engagements));
    check("dashboard breaks engagements down by type",
      JSON.stringify(stats.engagements?.typeBreakdown) === JSON.stringify([{ _id: "STATUTORY_AUDIT", count: 1 }]));
    check("dashboard breaks engagements down by status",
      JSON.stringify(stats.engagements?.statusBreakdown) === JSON.stringify([{ _id: "PLANNING", count: 1 }]));
    check("dashboard counts 1 working paper", stats.workingPapers?.total === 1, JSON.stringify(stats.workingPapers));

    // The owner exclusion applies to the new counts too: a firm owned by an owner-pattern account is
    // left out, and comes back with includeOwn=1.
    const ownFirmId = oid();
    const ownUserId = oid();
    await raw("users").insertOne({
      _id: ownUserId, email: "wb.robotics.scratch@scratch.test", name: "Own", role: "FIRM_ADMIN",
      accountType: "FIRM_USER", isActive: true, tokenVersion: 0, firmId: ownFirmId, createdAt: now, updatedAt: now,
    });
    await raw("firms").insertOne({
      _id: ownFirmId, name: "Own Firm", displayName: "Own Firm", handle: "scratch-own", ownerId: ownUserId,
      ownerUserId: ownUserId, type: "FIRM", isActive: true, joinCode: `SCRATCHOWN${Date.now().toString(36).toUpperCase()}`,
      createdAt: now, updatedAt: now,
    });
    await raw("engagements").insertOne({
      _id: oid(), firmId: ownFirmId, engagementType: "BANK_AUDIT", status: "DRAFT", title: "Own",
      createdAt: now, updatedAt: now,
    });
    const leftOut = await call("GET", "/api/super/dashboard-stats", superToken);
    const included = await call("GET", "/api/super/dashboard-stats?includeOwn=1", superToken);
    check("an owner-account firm's engagement is left out by default",
      leftOut.json?.stats?.engagements?.total === 1, JSON.stringify(leftOut.json?.stats?.engagements?.total));
    check("and counted with includeOwn=1",
      included.json?.stats?.engagements?.total === 2, JSON.stringify(included.json?.stats?.engagements?.total));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase().catch(() => {});
    await mongoose.disconnect();
  }

  const failed = checks.filter((c) => !c.pass);
  for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.pass || !c.detail ? "" : ` -- ${c.detail}`}`);
  console.log(`\naudit-usage-tracking-contract: ${checks.length - failed.length}/${checks.length} passed`);
  return failed.length ? 1 : 0;
}
