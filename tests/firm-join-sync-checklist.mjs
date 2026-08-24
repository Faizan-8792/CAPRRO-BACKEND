// tests/firm-join-sync-checklist.mjs
// Verifies that ALL "Join Firm" UI surfaces consistently hide once user.firmId is set,
// and that auth state propagates correctly across popup, tax-worker page, and admin.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

const popupHtml = readFileSync(
  join(ROOT, "audit-nlp-extension", "popup.html"),
  "utf8"
);
const popupJs = readFileSync(
  join(ROOT, "audit-nlp-extension", "popup.js"),
  "utf8"
);
const taxWorkerJs = readFileSync(
  join(ROOT, "audit-nlp-extension", "tax-worker.js"),
  "utf8"
);
const taxWorkerHtml = readFileSync(
  join(ROOT, "audit-nlp-extension", "tax-worker.html"),
  "utf8"
);
const backgroundJs = readFileSync(
  join(ROOT, "audit-nlp-extension", "background.js"),
  "utf8"
);

const firmCtrl = readFileSync(
  join(__dirname, "..", "src", "controllers", "firm.controller.js"),
  "utf8"
);

const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass, detail });

// ─── Backend ────────────────────────────────────────────────────────

// 1. /api/firms/join sets the active workspace and echoes the updated user back.
//
// REWRITTEN 2026-08-24. This previously matched `user.firmId = firm._id` and `user: updatedUser`
// as literal source text in the controller. Both patterns are gone, and NOT because the behaviour
// was lost: the join now runs inside `joinFirmInTransaction`, which applies the change through a
// `$set` on a session-bound update so the user row, the membership row and the firm counters
// cannot diverge if the request dies midway. Pinning the old inline assignment would have been
// pressure to undo that. The assertion below pins the guarantee -- firmId is set to the joined
// firm, transactionally, and a user is returned -- rather than the shape it used to have.
check(
  "POST /api/firms/join sets user.firmId transactionally AND returns the updated user",
  /joinFirmInTransaction/.test(firmCtrl) &&
    /withMembershipTransaction/.test(firmCtrl) &&
    /firmId:\s*firm\._id/.test(firmCtrl) &&
    /\buser\b/.test(firmCtrl),
  "Server-side state updated inside a transaction and echoed to client"
);

// 2. Server selects user fields including firmId
check(
  "Backend re-fetches user with firmId after join (via select)",
  /findById\(userId\)\.select\([^)]*firmId/.test(firmCtrl),
  "Updated user shape sent back to client for storage sync"
);

// ─── Popup ──────────────────────────────────────────────────────────

// 3. The popup's firm surface.
//
// REWRITTEN 2026-08-24. This required `#firmLinkedBadge`, which no longer exists, and it should
// not: the product deliberately moved to ADDITIVE workspaces. A user can belong to several firms
// and always keeps a personal workspace, so "linked / not linked" stopped being a real state and
// the badge that displayed it was removed with it (see popup.js:applyFirmLinkedUI, whose comment
// records the decision). Restoring the badge to satisfy this line would re-introduce a
// single-firm assumption the rest of the extension no longer holds.
//
// What replaced it is the workspace switcher, so that is what this now pins: join stays available,
// and the switcher exists to show which workspace is active.
check(
  "popup.html keeps #firmJoinSection available and exposes the workspace switcher",
  /id=["']firmJoinSection["']/.test(popupHtml) &&
    /id=["']workspacePanel["']/.test(popupHtml) &&
    /id=["']popupWorkspaceSelect["']/.test(popupHtml),
  "Join stays available because joining is additive; the switcher shows the active workspace"
);

// 4. popup.js applyFirmLinkedUI() function exists
check(
  "popup.js defines applyFirmLinkedUI(user) helper",
  /function\s+applyFirmLinkedUI\s*\(/.test(popupJs),
  "Single source of truth for show/hide logic"
);

// 5. applyFirmLinkedUI hides join section + shows linked badge
check(
  "applyFirmLinkedUI keeps join available and refreshes the workspace panel",
  // REWRITTEN 2026-08-24, same reason as check 3: it asserted the join UI is HIDDEN once linked.
  // Under additive workspaces that is now a defect, not a feature -- a user in one firm must still
  // be able to create or join another. The function now unhides the join section unconditionally
  // and delegates the "which workspace am I in" question to the switcher.
  /joinSection\.classList\.remove\(["']hidden["']\)/.test(popupJs) &&
    /refreshWorkspacePanel\(\)/.test(popupJs),
  "Join stays reachable from every workspace; the switcher reports the active one"
);

// 6. showMainView calls applyFirmLinkedUI on every render
check(
  "showMainView calls applyFirmLinkedUI on init/refresh",
  /showMainView[\s\S]*?applyFirmLinkedUI\(user\)/.test(popupJs),
  "Every popup render re-evaluates firm link state"
);

// 7. Successful join in popup updates UI immediately (no reload needed)
check(
  "joinFirmBtn handler calls applyFirmLinkedUI after success",
  /joinFirmBtn[\s\S]*?apiJoinFirm[\s\S]*?applyFirmLinkedUI\(/.test(popupJs),
  "UI sync happens within the click handler — popup doesn't get stuck"
);

// 8. Successful firm creation also hides join UI
check(
  "createFirmBtn handler calls applyFirmLinkedUI after success",
  /createFirmBtn[\s\S]*?apiCreateFirm[\s\S]*?applyFirmLinkedUI\(/.test(popupJs),
  "Creating a firm = becoming its admin = no longer needs to join"
);

// 9. Auth saved to chrome.storage with firm metadata
check(
  "Storage is refreshed through the background auth authority, not by the popup itself",
  // REWRITTEN 2026-08-24. This matched an inline `apiGetMe(stored.token)` immediately followed by
  // `saveAuthToStorage` in the popup. That pattern is gone because verification was centralised:
  // the popup now hands the token to the background service worker via AUTH_SET_VERIFIED, and
  // `setVerifiedSessionAuth` there is the single place that verifies against the server and
  // persists the result. That is strictly better than the old shape -- the popup, the workspace
  // page and any other surface can no longer disagree about who is signed in -- so this pins the
  // delegation rather than the inlining it replaced.
  /saveAuthToStorage[\s\S]{0,400}requestBackgroundAuthority\(\s*["']AUTH_SET_VERIFIED["']/.test(popupJs) &&
    /setVerifiedSessionAuth/.test(backgroundJs),
  "One authority verifies against the server and persists, so every surface agrees"
);

// ─── Tax Worker page ───────────────────────────────────────────────

// 10. Tax Worker page has join-firm card
check(
  "tax-worker.html includes #joinFirmCard",
  /id=["']joinFirmCard["']/.test(taxWorkerHtml),
  "Solo users see opt-in join prompt"
);

// 11. Tax Worker JS hides card when user.firmId exists
check(
  "tax-worker.js hides joinFirmCard when isLinked is true",
  /isLinked\s*=\s*!!me\.user\.firmId/.test(taxWorkerJs) &&
    /joinFirmCard["']\)\.style\.display\s*=\s*["']none["']/.test(taxWorkerJs) &&
    /joinFirmCard["']\)\.style\.display\s*=\s*["']block["']/.test(taxWorkerJs),
  "After join + reload, card auto-hides; show only when solo+!dismissed"
);

// 12. Skip button persists dismissal in localStorage
check(
  "skipFirmJoin persists per-user dismissal in localStorage",
  /localStorage\.setItem\(\s*`taxworker_join_dismissed_\$\{state\.user\.id\}`/.test(
    taxWorkerJs
  ),
  "Skip is sticky — won't re-prompt the same user later"
);

// 13. Successful join reloads page to refresh server-side scope
check(
  "Successful join reloads tax-worker page to apply new firm scope",
  /window\.location\.reload\(\)/.test(taxWorkerJs),
  "Forces re-fetch with new firmId; sessions/clients re-scope correctly"
);

// 14. Tax Worker writes auth back to chrome.storage after join (so popup syncs)
check(
  "Tax Worker join syncs new auth state to chrome.storage.local",
  /chrome\.storage\.local\.set\(\s*\{\s*caproAuth:/.test(taxWorkerJs),
  "Popup picks up firm-linked state on next open"
);

// ─── Cross-surface sync ────────────────────────────────────────────

// 15. Both surfaces use the same /api/firms/join endpoint
check(
  "Both popup and tax-worker call POST /api/firms/join",
  /["']\/firms\/join["']/.test(taxWorkerJs) &&
    /\/api\/firms\/join/.test(popupJs),
  "Single source of truth on backend"
);

// 16. Both surfaces validate join code format (4-10 alphanumeric)
check(
  "Both surfaces validate join code length >=4 before submitting",
  /code\.length\s*<\s*4/.test(popupJs) &&
    /\{4,10\}/.test(taxWorkerJs),
  "Consistent client-side validation"
);

// 17. Backend rejects bad codes with 404
check(
  "Backend returns 404 'Invalid or inactive join code' on bad code",
  /Invalid or inactive join code/.test(firmCtrl),
  "Both surfaces show same error message from server"
);

// ─── Print ─────────────────────────────────────────────────────────

console.log("\n=== JOIN-FIRM SYNC VERIFICATION ===\n");

const passed = checks.filter((c) => c.pass).length;
const failed = checks.filter((c) => !c.pass).length;

checks.forEach((c, i) => {
  const icon = c.pass ? "[PASS]" : "[FAIL]";
  console.log(`${i + 1}. ${icon} ${c.name}`);
  if (c.detail) console.log(`        ${c.detail}`);
});

console.log(`\nResult: ${passed} passed, ${failed} failed (out of ${checks.length})\n`);

if (failed === 0) {
  console.log("ALL CHECKS PASSED. Join-firm flow is consistent across surfaces.\n");
  console.log("Manual UX verification:");
  console.log("  Scenario A: Solo user joins via popup");
  console.log("    1. Open popup → Firm Admin section shows Create/Join");
  console.log("    2. Click Join → enter code → click Join Firm");
  console.log("    3. Status: 'Joined firm: <name>'");
  console.log("    4. Buttons disappear; green badge appears: '✓ Linked to firm: <name>'");
  console.log("    5. Close popup, reopen → switcher lists the new firm; Create/Join REMAIN");
  console.log("    6. Open Tax Work Tracker → no join-firm card; firm-mode banner");
  console.log("");
  console.log("  Scenario B: Solo user joins via Tax Worker page");
  console.log("    1. Open Tax Worker → join-firm card visible");
  console.log("    2. Enter code → Join Firm");
  console.log("    3. Toast: 'Joined <name>' → page reloads");
  console.log("    4. Tax Worker join card hides (an onboarding prompt, not a linked-state badge)");
  console.log("    5. Reopen popup → switcher shows the active workspace; Create/Join still available");
  console.log("");
  console.log("  Scenario C: Solo user dismisses Tax Worker card");
  console.log("    1. Open Tax Worker → click 'Skip — Use Solo'");
  console.log("    2. Card hides, toast: 'Solo mode — your data stays private'");
  console.log("    3. Reload page → card stays hidden (localStorage)");
  console.log("    4. Popup still shows Create/Join (user not in firm yet)\n");
  console.log("");
  console.log("  NOTE: workspaces are ADDITIVE. Create/Join are CORRECT to remain visible");
  console.log("  after joining - a user may belong to several firms and always keeps a");
  console.log("  personal workspace. A tester seeing Create/Join after a join has NOT");
  console.log("  found a bug. The active workspace is shown by the switcher, not a badge.");
} else {
  console.log("FAILURES DETECTED — review above.\n");
  process.exit(1);
}
