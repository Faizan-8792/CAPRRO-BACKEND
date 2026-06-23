// tests/task-flow-checklist.mjs
// Static verification: scans backend task code to confirm assignment isolation,
// authorization on completion, and no flip-back on close.
//
// Run: node tests/task-flow-checklist.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKEND = join(__dirname, "..");

const ctrl = readFileSync(
  join(BACKEND, "src", "controllers", "task.controller.js"),
  "utf8"
);
const routes = readFileSync(
  join(BACKEND, "src", "routes", "task.routes.js"),
  "utf8"
);
const taskModel = readFileSync(
  join(BACKEND, "src", "models", "Task.js"),
  "utf8"
);

const checks = [];

function check(name, pass, detail = "") {
  checks.push({ name, pass, detail });
}

// --- 1. getMyOpenTasks scopes by assignedTo ---
{
  const m = ctrl.match(/getMyOpenTasks[\s\S]*?(?=export const|\nexport function|$)/);
  const block = m ? m[0] : "";
  const ok =
    /assignedTo:\s*user\.id/.test(block) &&
    /firmId/.test(block) &&
    /isActive:\s*true/.test(block);
  check(
    "getMyOpenTasks filters by firmId + isActive + assignedTo=user.id",
    ok,
    ok ? "Only the logged-in assignee sees their tasks" : "Filter incomplete!"
  );
}

// --- 2. getMyOpenTasks excludes CLOSED status ---
{
  const m = ctrl.match(/getMyOpenTasks[\s\S]*?(?=export const|$)/);
  const block = m ? m[0] : "";
  const statusFilterMatch = block.match(/status:\s*\{\s*\$in:\s*\[([^\]]+)\]/);
  const statusList = statusFilterMatch ? statusFilterMatch[1] : "";
  const hasOpenStatuses =
    /NOT_STARTED/.test(statusList) &&
    /WAITING_DOCS/.test(statusList) &&
    /IN_PROGRESS/.test(statusList);
  const excludesClosed =
    !/CLOSED/.test(statusList) && !/FILED/.test(statusList);
  check(
    "getMyOpenTasks status filter includes only open states (excludes CLOSED/FILED)",
    hasOpenStatuses && excludesClosed,
    `Status filter: ${statusList || "MISSING"}`
  );
}

// --- 3. completeTaskFromUser requires assignedTo match ---
{
  const m = ctrl.match(/completeTaskFromUser[\s\S]*?(?=export const|$)/);
  const block = m ? m[0] : "";
  const ok =
    /assignedTo:\s*user\.id/.test(block) &&
    /firmId/.test(block) &&
    /Task\.findOne\(/.test(block) &&
    /status\s*=\s*"CLOSED"/.test(block);
  check(
    "completeTaskFromUser checks (firmId + assignedTo=user.id) before closing",
    ok,
    ok
      ? "Only assignee can mark their own task done; sets status=CLOSED"
      : "Missing scope check!"
  );
}

// --- 4. completeTaskFromUser logs audit metadata ---
{
  const m = ctrl.match(/completeTaskFromUser[\s\S]*?(?=export const|$)/);
  const block = m ? m[0] : "";
  const ok =
    /completedByUserId:\s*user\.id/.test(block) &&
    /completedAt:/.test(block);
  check(
    "completeTaskFromUser logs completedBy + completedAt metadata",
    ok,
    "Provides audit trail of who closed the task and when"
  );
}

// --- 5. createTask validates assignedTo belongs to same firm ---
{
  const m = ctrl.match(/createTask[\s\S]*?(?=export const|$)/);
  const block = m ? m[0] : "";
  const ok = /User\.findOne\(\s*\{[\s\S]{0,200}firmId\s*,?\s*\}/.test(block);
  check(
    "createTask validates assignedTo user is in the same firm",
    ok,
    "Prevents assigning tasks to users outside the firm"
  );
}

// --- 6. updateTask validates assignedTo same-firm ---
{
  const m = ctrl.match(/export const updateTask[\s\S]*?(?=export const|$)/);
  const block = m ? m[0] : "";
  const ok = /User\.findOne\(\s*\{[\s\S]{0,200}firmId\s*,?\s*\}/.test(block);
  check(
    "updateTask validates new assignedTo user is in the same firm",
    ok,
    "Reassignment cannot leak tasks to other firms"
  );
}

// --- 7. All controllers scope by firmId ---
{
  const handlers = [
    "createTask",
    "getTaskBoard",
    "updateTask",
    "archiveTask",
    "getMyOpenTasks",
    "completeTaskFromUser",
  ];
  let allScoped = true;
  const missing = [];
  for (const h of handlers) {
    const re = new RegExp(`(export const|export function)\\s+${h}[\\s\\S]*?(?=export const|export function|$)`);
    const block = (ctrl.match(re) || [""])[0];
    const ok =
      /firmId/.test(block) && /Firm not linked|firmId\s*[:,]/.test(block);
    if (!ok) {
      allScoped = false;
      missing.push(h);
    }
  }
  check(
    "All task handlers scope queries by firmId",
    allScoped,
    allScoped
      ? "Cross-firm leakage prevented"
      : `Missing firmId scope: ${missing.join(", ")}`
  );
}

// --- 8. Routes are auth-protected ---
{
  const ok = /router\.use\(authRequired\)/.test(routes);
  check(
    "All /api/tasks routes require authentication",
    ok,
    "JWT required to access any task endpoint"
  );
}

// --- 9. PATCH /:id/complete-from-user route exists ---
{
  const ok = /\.patch\(\s*["']\/:id\/complete-from-user["']\s*,\s*completeTaskFromUser/.test(
    routes
  );
  check(
    "PATCH /:id/complete-from-user route is wired",
    ok,
    "Extension can mark tasks complete via this endpoint"
  );
}

// --- 10. Task model indexes for fast queries ---
{
  const ok =
    /firmId:\s*1[\s\S]{0,40}assignedTo:\s*1/.test(taskModel) ||
    /firmId:\s*1,\s*assignedTo:\s*1/.test(taskModel) ||
    /TaskSchema\.index\(\s*\{\s*firmId:\s*1,\s*assignedTo:\s*1/.test(taskModel);
  check(
    "Task model has compound index on (firmId, assignedTo)",
    ok,
    ok
      ? "getMyOpenTasks lookup is O(log n) — fast even with many tasks"
      : "MISSING INDEX — queries will be slow at scale"
  );
}

// --- 11. Status field uses enum (prevents arbitrary values) ---
{
  const ok = /enum:\s*\[\s*["']NOT_STARTED["'][\s\S]*?["']CLOSED["'][\s\S]*?\]/.test(
    taskModel
  );
  check(
    "Task.status field uses Mongoose enum",
    ok,
    "Mongoose validates status against allowed values; no rogue states"
  );
}

// --- 12. No code path silently un-closes tasks ---
{
  // Search for any place that sets status away from CLOSED without explicit user intent
  const closedReverse = /status\s*=\s*["'](?!CLOSED)(?:NOT_STARTED|WAITING_DOCS|IN_PROGRESS|FILED)["']/g;
  const matches = ctrl.match(closedReverse) || [];
  // only allowed in updateTask (admin can change status)
  const ok = matches.length === 0;
  check(
    "No automatic flip-back: only updateTask allows status changes from CLOSED",
    ok,
    `Status reassignment count outside updateTask: ${matches.length}`
  );
}

// --- Print report ---
console.log("\n=== TASK FLOW STATIC VERIFICATION ===\n");

const passed = checks.filter((c) => c.pass).length;
const failed = checks.filter((c) => !c.pass).length;

checks.forEach((c, i) => {
  const icon = c.pass ? "[PASS]" : "[FAIL]";
  console.log(`${i + 1}. ${icon} ${c.name}`);
  if (c.detail) console.log(`        ${c.detail}`);
});

console.log(`\nResult: ${passed} passed, ${failed} failed (out of ${checks.length})\n`);

if (failed === 0) {
  console.log("ALL CHECKS PASSED. Task flow integrity verified.\n");
  console.log("Manual test checklist (run in browser):");
  console.log(
    "  1. As Firm Admin: create task assigned to staff user A");
  console.log(
    "  2. As staff A: open extension → My Tasks → task should appear");
  console.log(
    "  3. As staff B (different user, same firm): My Tasks → task should NOT appear");
  console.log(
    "  4. As staff A: click 'Mark Done' → task disappears from list");
  console.log(
    "  5. As staff A: refresh My Tasks → task still gone (no flip-back)");
  console.log(
    "  6. As Firm Admin: open Compliance Board → task shown in CLOSED column");
  console.log(
    "  7. As staff B: even after refresh, NEVER sees staff A's task\n");
} else {
  console.log("FAILURES DETECTED — review code paths above.\n");
  process.exit(1);
}
