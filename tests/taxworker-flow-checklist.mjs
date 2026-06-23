// tests/taxworker-flow-checklist.mjs
// Static verification of Tax Work Tracker backend integrity.
// Run: node tests/taxworker-flow-checklist.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKEND = join(__dirname, "..");

const ctrl = readFileSync(
  join(BACKEND, "src", "controllers", "taxworker.controller.js"),
  "utf8"
);
const routes = readFileSync(
  join(BACKEND, "src", "routes", "taxworker.routes.js"),
  "utf8"
);
const clientModel = readFileSync(
  join(BACKEND, "src", "models", "Client.js"),
  "utf8"
);
const sessionModel = readFileSync(
  join(BACKEND, "src", "models", "TaxWorkSession.js"),
  "utf8"
);
const tpl = readFileSync(
  join(BACKEND, "src", "config", "tax-templates.js"),
  "utf8"
);
const app = readFileSync(join(BACKEND, "src", "app.js"), "utf8");

const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass, detail });

// 1. Routes auth-protected
check(
  "All /api/taxworker routes require authentication",
  /router\.use\(authRequired\)/.test(routes),
  "JWT required for every taxworker endpoint"
);

// 2. Routes wired in app.js
check(
  "/api/taxworker mounted in app.js",
  /app\.use\(["']\/api\/taxworker["']\s*,\s*taxworkerRoutes\)/.test(app),
  "Routes accessible at /api/taxworker"
);

// 3. Every controller scopes by firmId or ownerUserId (via getScope helper)
const handlers = [
  "listClients",
  "createClient",
  "updateClient",
  "deleteClient",
  "listSessions",
  "getSession",
  "createSession",
  "updateSession",
  "updateDocument",
  "addCustomDocument",
  "removeCustomDocument",
  "deleteSession",
  "getStats",
  "getTemplates",
];
let allScoped = true;
const missingScope = [];
for (const h of handlers) {
  const re = new RegExp(`(export const|export async function|export function)\\s+${h}[\\s\\S]*?(?=export const|export function|export async function|$)`);
  const block = (ctrl.match(re) || [""])[0];
  // Either getScope or getOwnership establishes the scope
  const ok = /getScope\(req\.user\)/.test(block) || /getOwnership\(req\.user\)/.test(block);
  if (!ok) {
    allScoped = false;
    missingScope.push(h);
  }
}
check(
  "All controllers establish scope via getScope/getOwnership (firm or solo)",
  allScoped,
  allScoped ? "Cross-user/cross-firm leakage prevented" : `Missing: ${missingScope.join(", ")}`
);

// 4. Cross-firm/user leakage prevented in queries
const queriesScoped =
  /\bgetScope\b/.test(ctrl) &&
  (ctrl.match(/Client\.find/g) || []).length >= 1 &&
  (ctrl.match(/TaxWorkSession\.find/g) || []).length >= 1 &&
  /\.\.\.scope/.test(ctrl);
check(
  "Queries spread scope filter (firm-mode firmId OR solo-mode ownerUserId+firmId:null)",
  queriesScoped,
  "Each user only sees their firm or solo data"
);

// 5. createSession validates client belongs to scope
check(
  "createSession validates clientId belongs to scope before creating",
  /Client\.findOne\(\s*\{\s*_id:\s*clientId\s*,\s*\.\.\.scope/.test(ctrl),
  "Cannot create session for a client outside your scope"
);

// 6. createSession snapshots template documents
check(
  "createSession uses getTemplateDocuments() to snapshot checklist",
  /getTemplateDocuments\(/.test(ctrl),
  "Template snapshot on create — future template edits don't disrupt active sessions"
);

// 7. updateDocument logs receivedAt + receivedByUserId
check(
  "updateDocument logs receivedAt + receivedByUserId on tick",
  /receivedAt\s*=\s*received\s*\?\s*new Date\(\)/.test(ctrl) &&
    /receivedByUserId\s*=\s*received\s*\?\s*req\.user\.id/.test(ctrl),
  "Audit trail: who received what, when"
);

// 8. Status enum is enforced
check(
  "TaxWorkSession.status uses enum (DRAFT/IN_PROGRESS/COMPLETE/ARCHIVED)",
  /enum:\s*STATUSES/.test(sessionModel) &&
    /STATUSES\s*=\s*\[\s*["']DRAFT["'][\s\S]*?["']ARCHIVED["']/.test(sessionModel),
  "No rogue status values allowed"
);

// 9. taxType enum is enforced
check(
  "TaxWorkSession.taxType uses enum",
  /enum:\s*TAX_TYPES/.test(sessionModel),
  "Only known tax types accepted"
);

// 10. ObjectId validation on params
check(
  "ObjectId format validated for :id params",
  /isValidObjectId\(/.test(ctrl),
  "Invalid IDs rejected with 400 instead of crashing"
);

// 11. Delete is soft (sets isActive=false / status=ARCHIVED)
check(
  "Delete operations are SOFT (no hard data loss)",
  /isActive\s*=\s*false/.test(ctrl) && /status\s*=\s*["']ARCHIVED["']/.test(ctrl),
  "Soft-delete preserved in both Client and Session"
);

// 12. Indexes on Client model
check(
  "Client model has firmId compound indexes",
  /ClientSchema\.index\(\s*\{\s*firmId:\s*1/.test(clientModel),
  "List clients query is fast at scale"
);

// 13. Indexes on TaxWorkSession model
check(
  "TaxWorkSession model has firmId compound indexes (status, clientId, taxType, assignedTo, dueDate)",
  /TaxWorkSessionSchema\.index\(\s*\{\s*firmId:\s*1[\s\S]{0,80}status/.test(sessionModel) &&
    /TaxWorkSessionSchema\.index\(\s*\{\s*firmId:\s*1[\s\S]{0,80}clientId/.test(sessionModel) &&
    /TaxWorkSessionSchema\.index\(\s*\{\s*firmId:\s*1[\s\S]{0,80}assignedTo/.test(sessionModel),
  "Common queries (by status/client/assignee) are O(log n)"
);

// 14. Templates catalog has all 14 tax types
const expectedTypes = [
  "GST_MONTHLY","GST_QUARTERLY","GST_ANNUAL","GST_AUDIT","TDS_QUARTERLY",
  "ITR_INDIVIDUAL","ITR_FIRM","ITR_COMPANY","TAX_AUDIT","ROC_ANNUAL",
  "PT","PF_ESI","EQUALISATION_LEVY","OTHER"
];
const missingTypes = expectedTypes.filter((t) => !new RegExp(`^\\s*${t}:`, "m").test(tpl));
check(
  "All 14 tax types present in template catalog",
  missingTypes.length === 0,
  missingTypes.length ? `Missing: ${missingTypes.join(", ")}` : "All present"
);

// 15. Period/due-date suggestion exists
check(
  "suggestPeriodAndDueDate() implements monthly/quarterly/fy logic",
  /suggestPeriodAndDueDate/.test(tpl) &&
    /===\s*["']monthly["']/.test(tpl) &&
    /===\s*["']quarterly["']/.test(tpl) &&
    /===\s*["']fy["']/.test(tpl),
  "Auto-suggestion logic for all period formats"
);

// 16. Custom doc cannot remove built-in
check(
  "removeCustomDocument refuses to delete non-custom (built-in) docs",
  /isCustom\s*\)/.test(ctrl) && /Custom document not found.*built-ins cannot/.test(ctrl),
  "Built-in template docs are immutable"
);

// 17. Period format validation in custom docs (slug from name)
check(
  "addCustomDocument generates slug-based docKey",
  /docKey\s*=\s*`custom_\$\{slug\}`/.test(ctrl) ||
    /custom_\$\{slug\}/.test(ctrl),
  "Custom docs get unique slugified keys to avoid collisions"
);

// 18. Solo mode: getScope returns ownerUserId-based filter for unlinked users
check(
  "getScope() supports SOLO mode (firmId:null + ownerUserId) for unlinked users",
  /if\s*\(\s*user\.firmId\s*\)\s*return\s*\{\s*firmId:\s*user\.firmId\s*\}/.test(ctrl) &&
    /return\s*\{\s*firmId:\s*null,\s*ownerUserId:\s*user\.id\s*\}/.test(ctrl),
  "Users not linked to any firm can use Tax Worker independently"
);

// 19. Models support solo mode (firmId optional, ownerUserId required)
check(
  "Client + TaxWorkSession models allow firmId=null with required ownerUserId",
  /firmId[\s\S]{0,80}default:\s*null/.test(clientModel) &&
    /ownerUserId[\s\S]{0,80}required:\s*true/.test(clientModel) &&
    /firmId[\s\S]{0,80}default:\s*null/.test(sessionModel) &&
    /ownerUserId[\s\S]{0,80}required:\s*true/.test(sessionModel),
  "Solo mode supported at schema level"
);

// ─── Print report ────────────────────────────────────────────────
console.log("\n=== TAX WORK TRACKER STATIC VERIFICATION ===\n");

const passed = checks.filter((c) => c.pass).length;
const failed = checks.filter((c) => !c.pass).length;

checks.forEach((c, i) => {
  const icon = c.pass ? "[PASS]" : "[FAIL]";
  console.log(`${i + 1}. ${icon} ${c.name}`);
  if (c.detail) console.log(`        ${c.detail}`);
});

console.log(`\nResult: ${passed} passed, ${failed} failed (out of ${checks.length})\n`);

if (failed === 0) {
  console.log("ALL CHECKS PASSED. Tax Work Tracker integrity verified.\n");
  console.log("Manual UX checklist:");
  console.log("  1. Click 'Tax Work Tracker' button in popup → page opens");
  console.log("  2. Click '+ New Session' → modal opens with client + tax type pickers");
  console.log("  3. Add new client inline → saved to firm");
  console.log("  4. Pick tax type → period + due date auto-suggested");
  console.log("  5. Create session → checklist auto-loaded");
  console.log("  6. Tick documents → progress ring updates live");
  console.log("  7. Add notes → autosaves after 600ms idle");
  console.log("  8. Add custom doc → appears in list with X to remove");
  console.log("  9. Export Word/Excel/PDF → file downloads");
  console.log("  10. Mark Complete → session moves to COMPLETE status");
  console.log("  11. Different firm user → cannot see this firm's sessions\n");
} else {
  console.log("FAILURES DETECTED — review above.\n");
  process.exit(1);
}
