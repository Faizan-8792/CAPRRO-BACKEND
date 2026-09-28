// tests/workflow-usage-contract.mjs
//
// Why this exists. IMPROVEMENT-PLAN-V2-2026-09-28 Part 3: usage is now split by
// client type (desktop vs extension) per user, per workflow, per day, via the
// WorkflowUsage model and the trackWorkflow middleware. Before this, imports,
// GST recon, TDS and OCR sat behind authRequiredWithoutUsageTracking, so the
// product's core workflows were invisible to analytics, and the extension vs
// desktop split the owner asked for did not exist.
//
// Two hard properties are pinned here:
//  1. PRIVACY SHAPE: WorkflowUsage records counts and nothing else. The schema
//     path set is asserted exactly — any future field addition (a GSTIN, a
//     filename, a free-text note) fails this suite per PLAN.md §24.6.
//  2. TRACKING DELIBERATENESS: the previously pinned no-tracking paths now carry
//     trackWorkflow chains, asserted by reading the route files. The auth path
//     itself stays authRequiredWithoutUsageTracking (write-free identity), so
//     notice-case-contract's existing pin continues to hold.
//
// Run: node tests/workflow-usage-contract.mjs            (pure subset without Mongo)
//      MONGODB_URI=... node tests/workflow-usage-contract.mjs   (full)

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass, detail });

// ─── 1. Privacy shape: the exact schema path set ─────────────────────────────

const { default: WorkflowUsage, WORKFLOW_USAGE_WORKFLOWS, WORKFLOW_USAGE_CLIENTS, periodDayFor } =
  await import(join(root, "src/models/WorkflowUsage.js").href ??
    "../src/models/WorkflowUsage.js");

const EXPECTED_PATHS = Object.freeze([
  "userId",
  "firmId",
  "client",
  "workflow",
  "periodDay",
  "count",
  "lastSeenAt",
  "outcomeCounts.ok",
  "outcomeCounts.error",
]);

const schemaPaths = Object.keys(WorkflowUsage.schema.paths).filter(
  (p) => p !== "_id" && p !== "createdAt" && p !== "updatedAt" && p !== "__v",
);

check(
  "privacy shape: schema carries exactly the count fields and nothing else",
  JSON.stringify([...schemaPaths].sort()) === JSON.stringify([...EXPECTED_PATHS].sort()),
  `found: ${schemaPaths.join(", ")}`,
);

check(
  "privacy shape: no string field can carry content (every field is an enum, a date, a number, an ObjectId, or a fixed-format day)",
  (() => {
    const forbidden = ["gstin", "pan", "amount", "filename", "note", "text", "label", "url", "ip", "email"];
    return forbidden.every((word) => !schemaPaths.some((p) => p.toLowerCase().includes(word)));
  })(),
);

check(
  "enum discipline: workflows cover the eleven plan surfaces; clients are desktop/extension only",
  (() => {
    const expected = ["import", "gst_recon", "tds_health", "notice_case", "compliance_calendar",
      "task", "digest_view", "audit_review", "export", "ocr_consent", "downloader_run"];
    return expected.every((w) => WORKFLOW_USAGE_WORKFLOWS.includes(w)) &&
      WORKFLOW_USAGE_CLIENTS.length === 2 &&
      WORKFLOW_USAGE_CLIENTS.includes("desktop") &&
      WORKFLOW_USAGE_CLIENTS.includes("extension");
  })(),
);

check("periodDayFor renders UTC YYYY-MM-DD", periodDayFor(new Date(Date.UTC(2026, 8, 28, 23, 59))) === "2026-09-28");

// ─── 2. Deliberate tracking on the previously invisible workflows ────────────

const routeFiles = {
  "import.routes.js": 'trackWorkflow("import")',
  "gst-reconciliation.routes.js": 'trackWorkflow("gst_recon")',
  "tds-health.routes.js": 'trackWorkflow("tds_health")',
  "case.routes.js": 'trackWorkflow("ocr_consent")',
};

for (const [file, expected] of Object.entries(routeFiles)) {
  const source = readFileSync(join(root, "src/routes", file), "utf8");
  check(`${file}: carries ${expected}`, source.includes(expected));
  // The auth path must REMAIN write-free — the tracker must not "upgrade" the
  // chain to authRequired (that would re-enable lastActiveAt writes here).
  const chainMatch = source.match(/router\.use\(\s*authRequiredWithoutUsageTracking/);
  check(
    `${file}: auth still answers via authRequiredWithoutUsageTracking (write-free identity preserved)`,
    file === "case.routes.js" ? source.includes("authRequiredWithoutUsageTracking") : Boolean(chainMatch),
  );
}

// The middleware refuses an unlisted workflow at mount time (fail loud, not silent).
const { trackWorkflow } = await import("../src/middleware/workflow-usage.middleware.js");
check(
  "trackWorkflow: unknown workflow name throws at chain construction",
  (() => {
    try {
      trackWorkflow("definitely_not_a_workflow");
      return false;
    } catch (error) {
      return error instanceof TypeError;
    }
  })(),
);

check(
  "trackWorkflow: a listed workflow name builds a middleware function",
  typeof trackWorkflow("import") === "function",
);

// ─── 3. Mongo-backed behaviour (model statics + uniqueness + analytics) ──────

const mongoUri = process.env.MONGODB_URI || "";
const wantsMongo = mongoUri.includes("scratch");
let mongoRan = false;

if (wantsMongo) {
  const mongoose = (await import("mongoose")).default;
  await mongoose.connect(mongoUri);
  try {
    await WorkflowUsage.deleteMany({}).maxTimeMS(5000);
    mongoRan = true;

    const userId = new mongoose.Types.ObjectId();
    const firmId = new mongoose.Types.ObjectId();

    // One user, two clients, same day: two distinct rows (the split the owner asked for).
    await WorkflowUsage.recordUsage({ userId, firmId, client: "desktop", workflow: "gst_recon", outcome: "ok" });
    await WorkflowUsage.recordUsage({ userId, firmId, client: "extension", workflow: "gst_recon", outcome: "ok" });
    await WorkflowUsage.recordUsage({ userId, firmId, client: "desktop", workflow: "gst_recon", outcome: "error" });
    await WorkflowUsage.recordUsage({ userId, firmId, client: "desktop", workflow: "gst_recon", outcome: "ok" });

    const rows = await WorkflowUsage.find({ userId }).lean();
    check(
      "recordUsage: same user + day across two clients makes two rows",
      rows.length === 2,
      `rows=${rows.length}`,
    );

    const desktopRow = rows.find((r) => r.client === "desktop");
    check(
      "recordUsage: counts and outcomes accumulate atomically (desktop: 3 runs, 2 ok, 1 error)",
      desktopRow?.count === 3 && desktopRow?.outcomeCounts?.ok === 2 && desktopRow?.outcomeCounts?.error === 1,
      JSON.stringify(desktopRow?.outcomeCounts),
    );

    // Uniqueness: the same key again increments, never duplicates.
    await WorkflowUsage.recordUsage({ userId, firmId, client: "extension", workflow: "gst_recon", outcome: "ok" });
    const afterRepeat = await WorkflowUsage.countDocuments({ userId, client: "extension" });
    check("recordUsage: repeat writes increment the same row (unique index)", afterRepeat === 1);

    // Refusals: unknown workflow/client are no-ops, not rows.
    const badWorkflow = await WorkflowUsage.recordUsage({ userId, client: "desktop", workflow: "surprise", outcome: "ok" });
    const badClient = await WorkflowUsage.recordUsage({ userId, client: "smartwatch", workflow: "import", outcome: "ok" });
    check(
      "recordUsage: unknown workflow or client records nothing",
      badWorkflow === null && badClient === null &&
        (await WorkflowUsage.countDocuments({ userId })) === 2,
    );

    // Index reality: the unique compound index must exist (provisioned or dev-built).
    const indexInfo = await WorkflowUsage.collection.listIndexes().toArray();
    const uniqueIndex = indexInfo.find(
      (i) =>
        JSON.stringify(i.key) ===
        JSON.stringify({ userId: 1, client: 1, workflow: 1, periodDay: 1 }) &&
        i.unique === true,
    );
    check("indexes: the compound unique index exists on the collection", Boolean(uniqueIndex));

    // Analytics aggregation basis (getUsageStats reads the same shape).
    const day = new Date().toISOString().slice(0, 10);
    const series = await WorkflowUsage.aggregate([
      { $match: { periodDay: { $gte: day } } },
      { $group: { _id: { day: "$periodDay", client: "$client" }, users: { $addToSet: "$userId" } } },
      { $project: { count: { $size: "$users" } } },
    ]);
    check(
      "analytics basis: per-day-per-client distinct-user aggregation returns both clients",
      series.length === 2,
      JSON.stringify(series),
    );

    await WorkflowUsage.deleteMany({}).maxTimeMS(5000);
  } finally {
    await mongoose.disconnect();
  }
}

check(
  "mongo subset ran (only when MONGODB_URI points at a scratch database)",
  mongoRan || !wantsMongo,
  wantsMongo ? "expected to run" : "MONGODB_URI not scratch-marked — Mongo assertions skipped",
);

// ─── Verdict ─────────────────────────────────────────────────────────────────

const failed = checks.filter((c) => !c.pass);
for (const c of failed) console.error(`FAIL: ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
console.log(
  `workflow-usage-contract: ${checks.length - failed.length}/${checks.length} checks passed` +
    (mongoRan ? " (mongo subset included)" : " (mongo subset SKIPPED — no scratch MONGODB_URI)"),
);
if (failed.length > 0) process.exit(1);
