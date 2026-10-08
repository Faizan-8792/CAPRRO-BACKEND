// src/middleware/workflow-usage.middleware.js
// Per-workflow usage recording (Part 3 of IMPROVEMENT-PLAN-V2-2026-09-28).
//
// The core workflows — imports, GST reconciliation, TDS health, notice OCR —
// ran behind authRequiredWithoutUsageTracking, whose contract forbids the
// throttled lastActiveAt write. That made the product's actual workflows
// invisible to analytics: totalApiCalls counted 5-minute active windows and
// never saw any of them. This middleware replaces that blanket invisibility
// with a deliberate, narrow record: one WorkflowUsage counter row per
// (user, client type, workflow, day) with an ok/error outcome — and NOTHING
// else. No request body, path parameters, query string, file name, or header
// value is ever read beyond the identity already on req.user and the client
// claim the auth layer resolved from the signed JWT. PLAN.md §24.6's
// forbidden-field rejection test pins that shape.
//
// Recording happens on res "finish", fire-and-forget: an analytics failure
// must never fail the workflow being counted.

import WorkflowUsage, {
  WORKFLOW_USAGE_WORKFLOWS,
} from "../models/WorkflowUsage.js";

export function trackWorkflow(workflow) {
  if (!WORKFLOW_USAGE_WORKFLOWS.includes(workflow)) {
    throw new TypeError(
      `trackWorkflow: "${workflow}" is not in WORKFLOW_USAGE_WORKFLOWS — add it to the model's enum deliberately, with its privacy shape reviewed`,
    );
  }

  return function workflowUsageTracker(req, res, next) {
    res.on("finish", () => {
      try {
        if (!req.user?.id) return;
        // A failed auth (401) never reaches the chain past authRequired*, and a
        // 4xx (forbidden, validation, rate-limited probe) is not usage. A 5xx
        // IS usage that errored: the caller did the work and the server failed
        // it, which is exactly the outcomeCounts.error signal.
        const status = res.statusCode;
        if (!status || status < 200 || (status >= 400 && status < 500)) return;
        const outcome = status >= 500 ? "error" : "ok";
        WorkflowUsage.recordUsage({
          userId: req.user.id,
          firmId: req.user.firmId || null,
          client: req.user.client || "extension",
          workflow,
          outcome,
        }).catch((err) => {
          console.warn("workflow usage record failed:", err?.message);
        });
      } catch (err) {
        console.warn("workflow usage tracker error:", err?.message);
      }
    });
    next();
  };
}
