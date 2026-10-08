// tests/usage-stats-contract.mjs
//
// Why this exists. The rewritten getUsageStats (IMPROVEMENT-PLAN-V2-2026-09-28 Part 3) carries
// aggregations with $lookup and $unwind that the model-level suites never exercised; the first
// real call on production 500'd because $unwind was given "preserveNullAndEmpty" — the option is
// "preserveNullAndEmptyArrays". This suite drives the CONTROLLER with seeded rows so the whole
// aggregation path runs before deploy, and pins the client-split semantics the owner asked for:
// a user active on both clients counts once under EACH, per-user rows join the user's email, and
// the response is super-admin-only.
//
// Run: MONGODB_URI=...scratch... node tests/usage-stats-contract.mjs

import assert from "node:assert/strict";

const uri = process.env.MONGODB_URI || "";
if (!/\/\/(localhost|127\.0\.0\.1)[:/]/.test(uri) || !uri.includes("scratch")) {
  console.error("Refusing to run: MONGODB_URI must be loopback and scratch-marked.");
  process.exit(1);
}

const mongoose = (await import("mongoose")).default;
await mongoose.connect(uri);

const { default: WorkflowUsage } = await import("../src/models/WorkflowUsage.js");
const { default: User } = await import("../src/models/User.js");
const { getUsageStats } = await import("../src/controllers/super.controller.js");

const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass, detail });

try {
  await Promise.all([WorkflowUsage.deleteMany({}), User.deleteMany({})]).catch(() => {});

  const both = new mongoose.Types.ObjectId();
  const desktopOnly = new mongoose.Types.ObjectId();
  await User.create([
    { _id: both, email: "both@example.com", name: "Both Apps", role: "USER" },
    { _id: desktopOnly, email: "desktop@example.com", name: "Desktop Only", role: "USER" },
  ]);
  await WorkflowUsage.recordUsage({ userId: both, firmId: null, client: "desktop", workflow: "gst_recon", outcome: "ok" });
  await WorkflowUsage.recordUsage({ userId: both, firmId: null, client: "extension", workflow: "import", outcome: "ok" });
  await WorkflowUsage.recordUsage({ userId: both, firmId: null, client: "desktop", workflow: "gst_recon", outcome: "error" });
  await WorkflowUsage.recordUsage({ userId: desktopOnly, firmId: null, client: "desktop", workflow: "tds_health", outcome: "ok" });

  const call = async (user) => {
    let status = 0;
    let body = null;
    const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; } };
    await getUsageStats({ user }, res, (err) => { status = err?.statusCode ?? 500; body = { error: err?.message }; });
    return { status, body };
  };

  const superCall = await call({ id: both.toString(), role: "SUPER_ADMIN", email: "saifullahfaizan786@gmail.com" });
  check("super admin call answers 200", superCall.status === 0 && superCall.body?.ok === true,
    JSON.stringify(superCall.body?.error ?? ""));

  const usage = superCall.body?.usage ?? {};
  check("clientSplit present with daily/weekly/monthly",
    Boolean(usage.clientSplit?.daily && usage.clientSplit?.weekly && usage.clientSplit?.monthly));
  check("a user active on both clients counts once under EACH (the split, not a dedupe)",
    usage.clientSplit?.daily?.desktop === 2 && usage.clientSplit?.daily?.extension === 1,
    JSON.stringify(usage.clientSplit?.daily));
  check("per-user table joins the user's email",
    (usage.perUser ?? []).some((row) => row.email === "both@example.com" && row.desktopCount >= 2),
    JSON.stringify((usage.perUser ?? []).slice(0, 2)));
  check("workflow breakdown names the workflows",
    ["gst_recon", "import", "tds_health"].every((w) => (usage.workflowBreakdown ?? []).some((row) => row.workflow === w)));
  check("legacy fields still present, flagged approximate via basis",
    typeof usage.dau === "number" && String(usage.basis ?? "").includes("approximate"));

  const asFirmAdmin = await call({ id: both.toString(), role: "FIRM_ADMIN", email: "both@example.com" });
  check("non-super-admin is refused (per-user usage never leaves super scope)",
    asFirmAdmin.status !== 0 || asFirmAdmin.body?.ok === false);

  await Promise.all([WorkflowUsage.deleteMany({}), User.deleteMany({})]).catch(() => {});
} finally {
  await mongoose.disconnect();
}

const failed = checks.filter((c) => !c.pass);
for (const c of failed) console.error(`FAIL: ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
console.log(`usage-stats-contract: ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) process.exit(1);
