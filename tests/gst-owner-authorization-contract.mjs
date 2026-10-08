// tests/gst-owner-authorization-contract.mjs
//
// Guards the GST disposition owner check (ledger task T17b, board item B7).
//
// The check used to be User.exists({ _id, firmId, isActive }) alone, which was wrong
// in both directions:
//
//   1. It accepted a REMOVED member. FirmMembership is the source of truth for who
//      belongs to a firm; User.firmId only records which workspace a user is
//      currently switched into. So a User row still carrying firmId after their
//      membership went to REMOVED was accepted as the owner of a statutory
//      input-tax-credit line, and only a client-side filter stood in the way.
//      Client filtering is not authorization.
//   2. It rejected a legitimate member. A user may hold ACTIVE memberships in
//      several firms while User.firmId points at one, so an active colleague working
//      in another workspace was refused -- and the desktop picker, which reads
//      ACTIVE memberships, would offer exactly that person.
//
// validateDispositionReferences is module-private in gst-reconciliation.service.js
// and reaches Mongo directly, so this suite asserts the contract at source in the
// style already used by production-readiness-checklist.mjs and the flow checklists.
// It is written so that it cannot pass for the wrong reason: it includes a negative
// control against the old vulnerable query, and it checks that every call site is
// covered, because repairing the function is worthless if a caller bypasses it.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKEND = join(__dirname, "..");

const service = readFileSync(
  join(BACKEND, "src", "services", "gst-reconciliation.service.js"),
  "utf8",
);
const membershipModel = readFileSync(
  join(BACKEND, "src", "models", "FirmMembership.js"),
  "utf8",
);

const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass, detail });

// ─── Locate the function, so nothing below is vacuous ──────────────

const FUNCTION_START = /async function validateDispositionReferences\(/;
const startMatch = FUNCTION_START.exec(service);
const startIndex = startMatch ? startMatch.index : -1;
// The function ends at the next top-level `async function` / `function` declaration.
const afterStart = startIndex === -1 ? "" : service.slice(startIndex + 1);
const nextDeclaration = /\n(?:async )?function [a-zA-Z]/.exec(afterStart);
const body =
  startIndex === -1
    ? ""
    : afterStart.slice(
        0,
        nextDeclaration ? nextDeclaration.index : afterStart.length,
      );

check(
  "validateDispositionReferences was located",
  body.length > 0,
  body.length
    ? `extracted ${body.length} characters; every assertion below reads this body only`
    : "function not found — the assertions below would otherwise pass vacuously",
);

// Structural assertions run against a normalised form: comments stripped and
// whitespace collapsed. Both matter and both were learned the hard way.
//
// Comments must go because the explanatory comment on this very fix quotes the old
// vulnerable query verbatim, which made the negative control below match the comment
// rather than the code and fail a correct implementation.
//
// Whitespace must be collapsed because the editor's formatter rewraps these calls at
// 80 columns, so a regex written against one line silently stops matching after an
// unrelated edit. That is a test that reports a defect which is not there.
function normalise(source) {
  return source
    .split("\n")
    .map((line) => {
      const marker = line.indexOf("//");
      return marker === -1 ? line : line.slice(0, marker);
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

// Split the owner branch from the task branch so a match in one cannot satisfy the
// other. The task branch legitimately still scopes by firmId.
const taskBranchIndex = body.indexOf("if (taskId)");
const ownerBranch = normalise(
  taskBranchIndex === -1 ? body : body.slice(0, taskBranchIndex),
);
const taskBranch = normalise(
  taskBranchIndex === -1 ? "" : body.slice(taskBranchIndex),
);

check(
  "the owner branch and the task branch were separated",
  ownerBranch.includes("ownerUserId") && taskBranch.includes("Task.exists"),
  "so an assertion about the owner check cannot be satisfied by the task check",
);

// ─── The fix ───────────────────────────────────────────────────────

check(
  "FirmMembership is imported by the GST reconciliation service",
  /import FirmMembership from "\.\.\/models\/FirmMembership\.js";/.test(
    service,
  ),
  "the source of truth for firm belonging",
);

check(
  "the owner check requires an ACTIVE FirmMembership scoped to the firm",
  /FirmMembership\.exists\(\{ userId: ownerUserId, firmId, status: "ACTIVE",? \}\)/.test(
    ownerBranch,
  ),
  "a REMOVED membership is therefore refused server-side, not filtered client-side",
);

check(
  "the refusal triggers when either the user or the membership is missing",
  /if\s*\(!user\s*\|\|\s*!activeMembership\)/.test(ownerBranch),
  "both conditions are required; neither alone admits an owner",
);

check(
  "the owner's User row must still be active",
  /User\.exists\(\{\s*_id:\s*ownerUserId,\s*isActive:\s*\{\s*\$ne:\s*false\s*\}\s*\}\)/.test(
    ownerBranch,
  ),
  "a deactivated account is refused even with an ACTIVE membership",
);

// ─── Negative control: the old vulnerable query is gone ────────────

check(
  "negative control: the User query no longer scopes by firmId",
  !/User\.exists\(\{[^}]*firmId/.test(ownerBranch),
  "User.firmId is the active workspace, not firm membership; scoping by it both " +
    "admitted removed members and refused members working in another workspace",
);

check(
  "negative control: firmId is still used, so it was not simply deleted everywhere",
  /firmId/.test(ownerBranch) &&
    /Task\.exists\(\{\s*_id:\s*taskId,\s*firmId\s*\}\)/.test(taskBranch),
  "the membership query scopes by firmId and the task check still does too",
);

// ─── The wording the desktop surfaces verbatim ─────────────────────

check(
  "the 404 wording is unchanged",
  /serviceError\("Owner not found in active firm",\s*404\)/.test(ownerBranch),
  "the desktop shows this string verbatim as of T17a; changing it is a client-visible change",
);

check(
  "exactly one owner refusal message exists",
  (service.match(/Owner not found in active firm/g) || []).length === 1,
  "a second copy would drift from the first",
);

// ─── Every call site is covered ────────────────────────────────────
// Repairing the function achieves nothing if a caller reaches disposition without it.

const callSites = (
  service.match(/await validateDispositionReferences\(\{/g) || []
).length;

check(
  "all three disposition paths validate references",
  callSites === 3,
  `${callSites} call sites — single item disposition, bulk preview and bulk commit`,
);

const ownerCarryingCallSites = (
  service.match(
    /await validateDispositionReferences\(\{\s*firmId,\s*ownerUserId:/g,
  ) || []
).length;

check(
  "every call site passes ownerUserId",
  ownerCarryingCallSites === 3,
  `${ownerCarryingCallSites} of ${callSites} call sites forward the owner for validation`,
);

// ─── The membership status enum cannot grow silently ───────────────
// If a third status is introduced, "ACTIVE" alone may no longer mean "belongs to the
// firm", and this check forces that decision to be made rather than assumed.

const statusEnum = /status:\s*\{[\s\S]*?enum:\s*\[([^\]]*)\]/.exec(
  membershipModel,
);
const statuses = statusEnum
  ? statusEnum[1]
      .split(",")
      .map((value) => value.trim().replace(/^"|"$/g, ""))
      .filter(Boolean)
  : [];

check(
  "FirmMembership.status is exactly ACTIVE and REMOVED",
  statuses.length === 2 &&
    statuses.includes("ACTIVE") &&
    statuses.includes("REMOVED"),
  statuses.length
    ? `found ${statuses.join(", ")} — a third status means "ACTIVE" may no longer mean "belongs to the firm"`
    : "status enum could not be parsed",
);

check(
  "one membership document per firm and user",
  /FirmMembershipSchema\.index\(\{\s*firmId:\s*1,\s*userId:\s*1\s*\},\s*\{\s*unique:\s*true\s*\}\)/.test(
    membershipModel,
  ),
  "so the exists() check cannot be satisfied by a stale duplicate",
);

// ─── Report ───────────────────────────────────────────────────────

let passed = 0;
for (const entry of checks) {
  const mark = entry.pass ? "PASS" : "FAIL";
  if (entry.pass) passed += 1;
  console.log(
    `[${mark}] ${entry.name}${entry.detail ? ` — ${entry.detail}` : ""}`,
  );
}

const total = checks.length;
console.log(`\nGST owner authorization contract: ${passed}/${total}`);

if (passed !== total) {
  console.error(`\n${total - passed} check(s) failed.`);
  process.exit(1);
}
