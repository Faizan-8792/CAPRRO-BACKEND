// src/models/WorkflowUsage.js
// Per-user, per-client-type, per-workflow, per-day usage counters (Part 3 of
// IMPROVEMENT-PLAN-V2-2026-09-28: the desktop-vs-extension split).
//
// One document per (userId, client, workflow, periodDay). Writes are atomic
// $inc upserts in the ProviderUsage pattern: the unique compound index is what
// makes the upsert collision-safe under concurrent requests, which is why the
// index is provisioned at boot (workflow-usage-index-readiness.service.js) and
// asserted, never trusted to autoIndex (off in production).
//
// PRIVACY SHAPE — this row is analytics, not a log. It records that a workflow
// ran, for which client type, and whether it ended ok or errored. It carries NO
// content field: no GSTIN, PAN, amount, filename, URL, or free text of any
// kind. PLAN.md §24.6's automated forbidden-field checks and
// tests/workflow-usage-contract.mjs pin the exact schema path set, so a future
// edit that adds a content-shaped field fails a gate instead of shipping.
//
// Client attribution: `client` comes from the signed JWT `client` claim, which
// the desktop receives only from its verified Google installed-app audience
// (never from a request body field — PLAN.md: clientType is untrusted). The
// X-CaPro-Client header is corroborating metadata only and can never override
// the claim; a disagreement is logged as a coarse anomaly with no identifiers.
//
// Retention: classified RETAIN in data-retention.service.js today — like
// ProviderUsage, nothing expires these rows yet. The 180-day raw → aggregate
// policy in IMPROVEMENT-PLAN-V2-2026-09-28 §3.2 is a future aggregation job,
// a deliberate decision that has not been built; calling this SELF_EXPIRING
// now would be the false claim that file's header warns against.

import mongoose from "mongoose";

export const WORKFLOW_USAGE_CLIENTS = Object.freeze(["desktop", "extension"]);

export const WORKFLOW_USAGE_WORKFLOWS = Object.freeze([
  "import",
  "gst_recon",
  "tds_health",
  "notice_case",
  "compliance_calendar",
  "task",
  "digest_view",
  "audit_review",
  "export",
  "ocr_consent",
  "downloader_run",
]);

const WorkflowUsageSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
      index: true,
    },
    firmId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Firm",
      default: null,
      immutable: true,
    },
    client: {
      type: String,
      enum: WORKFLOW_USAGE_CLIENTS,
      required: true,
      immutable: true,
    },
    workflow: {
      type: String,
      enum: WORKFLOW_USAGE_WORKFLOWS,
      required: true,
      immutable: true,
    },
    periodDay: {
      type: String,
      required: true,
      trim: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
      immutable: true,
    },
    count: { type: Number, default: 0, min: 0 },
    lastSeenAt: { type: Date, default: Date.now },
    outcomeCounts: {
      ok: { type: Number, default: 0, min: 0 },
      error: { type: Number, default: 0, min: 0 },
    },
  },
  { timestamps: true },
);

WorkflowUsageSchema.index(
  { userId: 1, client: 1, workflow: 1, periodDay: 1 },
  { unique: true, name: "unique_workflow_usage_day" },
);
WorkflowUsageSchema.index({ firmId: 1, periodDay: 1 });

function periodDayFor(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

// Atomic increment of one (userId, client, workflow, periodDay) counter.
// `outcome` is "ok" or "error" — decided by the response status, never by the
// caller's claim. Returns the post-increment document (or null only if the
// write itself failed, which callers treat as best-effort: analytics must not
// break the workflow it is counting).
WorkflowUsageSchema.statics.recordUsage = async function recordUsage({
  userId,
  firmId,
  client,
  workflow,
  outcome,
  at = new Date(),
}) {
  if (!WORKFLOW_USAGE_CLIENTS.includes(client)) return null;
  if (!WORKFLOW_USAGE_WORKFLOWS.includes(workflow)) return null;
  const outcomeKey = outcome === "error" ? "error" : "ok";
  try {
    return await this.findOneAndUpdate(
      {
        userId,
        client,
        workflow,
        periodDay: periodDayFor(at),
      },
      {
        $setOnInsert: { firmId: firmId || null },
        $inc: { count: 1, [`outcomeCounts.${outcomeKey}`]: 1 },
        $set: { lastSeenAt: at },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  } catch (error) {
    // A unique-index collision here means a concurrent request created the row
    // between our insert attempt and ours; retrying once as a plain increment
    // resolves it. Anything else is logged by the caller (middleware) and
    // swallowed: usage analytics is fire-and-forget by contract.
    if (error?.code === 11000) {
      return this.findOneAndUpdate(
        { userId, client, workflow, periodDay: periodDayFor(at) },
        {
          $inc: { count: 1, [`outcomeCounts.${outcomeKey}`]: 1 },
          $set: { lastSeenAt: at },
        },
        { new: true },
      );
    }
    throw error;
  }
};

const WorkflowUsage = mongoose.model("WorkflowUsage", WorkflowUsageSchema);

export { periodDayFor };
export default WorkflowUsage;
