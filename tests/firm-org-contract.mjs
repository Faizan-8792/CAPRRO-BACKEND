// The reporting tree and the adoption figures.
//
//   node capro-backend/tests/firm-org-contract.mjs
//
// TWO THINGS THIS SUITE EXISTS FOR
// --------------------------------
// 1. A REPORTING GRAPH CAN CONTAIN A CYCLE, and a tree walk over one runs forever. No mongoose
//    schema can prevent it -- reportsToUserId is a ref, and a ref cannot say "not one of my own
//    descendants". So the check is in firm-org.service.js, and these tests are what keep it there:
//    the direct case, the indirect case, and the property that the tree builder terminates even on
//    a cycle that reached the database some other way.
//
// 2. THE ADOPTION FIGURES ARE NUMBERS ABOUT NAMED PEOPLE. "Last active" records when an account
//    last made a request -- not whether somebody was working -- and a page of per-person counts
//    reads as a ranking unless it says otherwise. The disclaimer is shipped WITH the rows so a
//    client cannot render the numbers without it, and that is asserted here rather than hoped for.
//
// The third thing, quieter but just as easy to get wrong: NULL IS NOT ZERO AND NOT A ROOT. A member
// with no manager recorded is not "the boss", and a member with no lastActiveAt has not "never been
// active" -- both are absences, and both are rendered as absences.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  buildAdoption,
  buildOrgTree,
  describeReportingRefusal,
  managerChain,
} from "../src/services/firm-org.service.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const results = [];
async function test(name, action) {
  try {
    await action();
    results.push({ name, pass: true });
    console.log(`[PASS] ${name}`);
  } catch (error) {
    results.push({ name, pass: false });
    console.error(`[FAIL] ${name}: ${error.message}`);
  }
}

/** memberships, in the shape loadActiveMembers produces. */
const member = (userId, reportsToUserId = null, role = "MEMBER", extra = {}) => ({
  userId,
  reportsToUserId,
  role,
  ...extra,
});

// ---------------------------------------------------------------------------
// The cycle check -- the reason this file exists
// ---------------------------------------------------------------------------

await test("a direct cycle is refused", () => {
  // a reports to b. Setting b -> a closes the loop.
  const rows = [member("a", "b"), member("b")];
  assert.match(
    describeReportingRefusal(rows, "b", "a"),
    /report to each other/,
  );
});

await test("an indirect cycle is refused, however long the chain", () => {
  // a -> b -> c -> d. Setting d -> a closes a four-deep loop, and nothing shorter would catch it.
  const rows = [member("a", "b"), member("b", "c"), member("c", "d"), member("d")];
  assert.match(
    describeReportingRefusal(rows, "d", "a"),
    /report to each other/,
  );

  // Setting d -> c is a cycle too, and so is d -> b: anything at or above d in that chain closes
  // a loop, because the whole chain already runs down to d.
  assert.match(describeReportingRefusal(rows, "d", "c"), /report to each other/);
  assert.match(describeReportingRefusal(rows, "d", "b"), /report to each other/);

  // ... and a move that does NOT close a loop is allowed. a currently reports to b; pointing it at
  // d instead leaves a -> d and b -> c -> d, which is a tree.
  assert.equal(describeReportingRefusal(rows, "a", "d"), null);
});

await test("somebody cannot report to themselves", () => {
  const rows = [member("a"), member("b")];
  assert.match(describeReportingRefusal(rows, "a", "a"), /cannot report to themselves/);
});

await test("the tree builder terminates on a cycle it did not create", () => {
  // The write path refuses to make one. This asserts the READ path survives one anyway, because
  // "cannot happen" is not a reason to ship a walk that would hang if it did. A row written by a
  // migration, a script, or a future bug reaches this function, not the write path.
  const rows = [member("a", "b"), member("b", "a"), member("c")];

  const tree = buildOrgTree(rows);

  // Both cycle members are held aside rather than nested or dropped.
  assert.deepEqual(tree.orphaned, ["a", "b"]);
  assert.deepEqual(tree.roots.map((node) => node.userId), ["c"]);
  assert.equal(tree.memberCount, 3);
});

await test("managerChain stops at a cycle instead of spinning", () => {
  const rows = [member("a", "b"), member("b", "a")];
  const chain = managerChain(rows, "a");
  assert.ok(chain.length <= rows.length, `chain ran to ${chain.length}`);
  assert.deepEqual(chain, ["b"]);
});

// ---------------------------------------------------------------------------
// The other refusals
// ---------------------------------------------------------------------------

await test("a manager outside the firm is refused", () => {
  const rows = [member("a"), member("b")];
  assert.match(
    describeReportingRefusal(rows, "a", "stranger"),
    /not an active member/,
  );
});

await test("a subject outside the firm is refused", () => {
  const rows = [member("a")];
  assert.match(
    describeReportingRefusal(rows, "stranger", "a"),
    /not an active member/,
  );
});

await test("clearing a reporting line is always allowed", () => {
  // A firm reorganising must be able to empty a line before setting a new one. Refusing that
  // forces people through an invalid intermediate state, so every "no manager" spelling passes.
  const rows = [member("a", "b"), member("b")];
  for (const cleared of [null, undefined, ""]) {
    assert.equal(
      describeReportingRefusal(rows, "a", cleared),
      null,
      `clearing with ${JSON.stringify(cleared)}`,
    );
  }
});

await test("an unnamed subject is refused before anything else", () => {
  assert.match(describeReportingRefusal([], "", "a"), /Name the person/);
});

// ---------------------------------------------------------------------------
// The tree, and what a root does NOT mean
// ---------------------------------------------------------------------------

await test("a firm with no lines recorded says so, rather than looking flat", () => {
  // THE DISTINCTION THAT MATTERS. Every member is a root here, which is structurally identical to
  // a flat firm where everybody genuinely reports to the owner. hasAnyLine is how a client tells
  // "nothing recorded" from "recorded, and flat" -- without it the page would invent a hierarchy.
  const tree = buildOrgTree([member("a"), member("b"), member("c")]);

  assert.equal(tree.hasAnyLine, false);
  assert.equal(tree.roots.length, 3);
  assert.equal(tree.memberCount, 3);

  const withOne = buildOrgTree([member("a"), member("b", "a")]);
  assert.equal(withOne.hasAnyLine, true);
});

await test("the tree nests reports under their manager, with depth", () => {
  const tree = buildOrgTree([
    member("owner", null, "OWNER"),
    member("lead", "owner", "ADMIN"),
    member("junior", "lead"),
    member("other", "owner"),
  ]);

  const root = assertSingle(tree.roots);
  assert.equal(root.userId, "owner");
  assert.equal(root.depth, 0);
  assert.equal(root.role, "OWNER");

  assert.deepEqual(root.reports.map((node) => node.userId), ["lead", "other"]);

  const lead = root.reports[0];
  assert.equal(lead.depth, 1);
  assert.equal(lead.role, "ADMIN");
  assert.deepEqual(lead.reports.map((node) => node.userId), ["junior"]);
  assert.equal(lead.reports[0].depth, 2);
});

await test("a line pointing at somebody who left makes a root, not a disappearance", () => {
  // Their manager was removed from the firm; they were not. Dropping them would silently shrink
  // the firm on a page whose whole job is showing who is in it.
  const tree = buildOrgTree([member("a", "departed"), member("b")]);

  assert.deepEqual(tree.roots.map((node) => node.userId), ["a", "b"]);
  assert.equal(tree.memberCount, 2);
  assert.deepEqual(tree.orphaned, []);
});

await test("the tree is ordered stably, so it cannot reshuffle between reads", () => {
  // MULTIPLE ROOTS, supplied out of order, and reports under one of them also out of order. The
  // first version of this test had a single root, so removing the sort from `roots` changed
  // nothing and a mutation that did exactly that SURVIVED. One root cannot demonstrate an ordering.
  const rows = [
    member("zeta"),
    member("c", "alpha"),
    member("alpha"),
    member("b", "alpha"),
    member("mid"),
  ];

  const tree = buildOrgTree(rows);
  assert.deepEqual(
    tree.roots.map((node) => node.userId),
    ["alpha", "mid", "zeta"],
    "roots must come back sorted, not in arrival order",
  );
  assert.deepEqual(
    tree.roots[0].reports.map((node) => node.userId),
    ["b", "c"],
    "reports must come back sorted too",
  );

  // ... and the whole shape is identical whatever order the rows arrive in.
  assert.equal(
    JSON.stringify(tree),
    JSON.stringify(buildOrgTree(rows.slice().reverse())),
  );
});

// ---------------------------------------------------------------------------
// Adoption
// ---------------------------------------------------------------------------

const NOW = new Date("2026-09-08T12:00:00.000Z");

await test("a member with no tasks counts zero, and one never active is null", () => {
  // Zero and null are different answers. Zero tasks created is a real, correct measurement;
  // lastActiveAt absent means the server never recorded one, which must not render as a date and
  // must not be reported as a very old one.
  const adoption = buildAdoption(
    [member("a"), member("b")],
    { created: [{ _id: "a", count: 3 }], completed: [] },
    { now: NOW },
  );

  const a = adoption.rows.find((row) => row.userId === "a");
  const b = adoption.rows.find((row) => row.userId === "b");

  assert.equal(a.tasksCreated, 3);
  assert.equal(a.tasksCompleted, 0);
  assert.equal(b.tasksCreated, 0);
  assert.equal(b.lastActiveAt, null);
  assert.equal(b.daysSinceActive, null);
  assert.equal(adoption.neverActive, 2);
});

await test("days since active is whole days, floored, computed server-side", () => {
  const adoption = buildAdoption(
    [
      member("recent", null, "MEMBER", { lastActiveAt: "2026-09-08T06:00:00.000Z" }),
      member("older", null, "MEMBER", { lastActiveAt: "2026-08-25T12:00:00.000Z" }),
    ],
    { created: [], completed: [] },
    { now: NOW },
  );

  assert.equal(adoption.rows.find((r) => r.userId === "recent").daysSinceActive, 0);
  assert.equal(adoption.rows.find((r) => r.userId === "older").daysSinceActive, 14);
  assert.equal(adoption.neverActive, 0);
});

await test("a part day is floored, not rounded", () => {
  // FLOORED, and the difference is visible only on a fractional gap. The first version of this
  // suite used exactly 14.0 days, where floor and round agree, so a mutation swapping one for the
  // other SURVIVED. 14 days and 14 hours is 14 days elapsed; reporting 15 would age somebody's
  // last activity by a day they have not yet been absent.
  const adoption = buildAdoption(
    [
      member("a", null, "MEMBER", { lastActiveAt: "2026-08-24T22:00:00.000Z" }),
      member("b", null, "MEMBER", { lastActiveAt: "2026-09-08T11:00:00.000Z" }),
    ],
    { created: [], completed: [] },
    { now: NOW },
  );

  // 14 days 14 hours -> 14, not 15.
  assert.equal(adoption.rows.find((r) => r.userId === "a").daysSinceActive, 14);
  // 1 hour -> 0, not 1. "Active today" must not read as "a day ago".
  assert.equal(adoption.rows.find((r) => r.userId === "b").daysSinceActive, 0);
});

await test("a future lastActiveAt is clamped to zero rather than reported negative", () => {
  // Clock skew between the server and whatever wrote the row. "-1 days since active" is nonsense
  // on a screen; zero is the honest floor.
  const adoption = buildAdoption(
    [member("a", null, "MEMBER", { lastActiveAt: "2026-09-09T00:00:00.000Z" })],
    { created: [], completed: [] },
    { now: NOW },
  );
  assert.equal(adoption.rows[0].daysSinceActive, 0);
});

await test("rows are ordered by recency and never by task count", () => {
  // Ordering by tasks would make the page a leaderboard by construction, which is exactly what the
  // disclaimer says it is not.
  const adoption = buildAdoption(
    [
      member("busy", null, "MEMBER", { lastActiveAt: "2026-08-01T00:00:00.000Z" }),
      member("quiet", null, "MEMBER", { lastActiveAt: "2026-09-08T00:00:00.000Z" }),
      member("unknown"),
    ],
    { created: [{ _id: "busy", count: 99 }], completed: [] },
    { now: NOW },
  );

  assert.deepEqual(
    adoption.rows.map((row) => row.userId),
    ["quiet", "busy", "unknown"],
  );
  // Never-recorded sorts LAST, not first: an absence is not the most recent activity.
  assert.equal(adoption.rows.at(-1).userId, "unknown");
});

await test("the disclaimer ships WITH the rows and names what the figures are not", () => {
  const adoption = buildAdoption([member("a")], { created: [], completed: [] }, { now: NOW });

  assert.ok(adoption.disclaimer.length > 0);
  assert.match(adoption.disclaimer, /not how much work/i);
  assert.match(adoption.disclaimer, /last active/i);
  // Names at least one innocent reason the figure moves, so it cannot be read as diligence.
  assert.match(adoption.disclaimer, /leave|fieldwork|another device/i);
});

// ---------------------------------------------------------------------------
// The controller, read from source
// ---------------------------------------------------------------------------

const controller = readFileSync(
  join(root, "src/controllers/firm-org.controller.js"),
  "utf8",
);

await test("the controller asks the accessor and re-derives no authority of its own", () => {
  assert.match(controller, /resolveFirmAuthority/);
  for (const forbidden of [
    /\breq\.user\.role\s*===/,
    /membership\.role\s*===\s*"(OWNER|ADMIN)"/,
    /===\s*"SUPER_ADMIN"/,
  ]) {
    assert.equal(forbidden.test(controller), false, `${forbidden} re-derives authority`);
  }
});

await test("completion is attributed to the assignee, and only finished work counts", () => {
  // Task carries no completedBy. Attributing completion to createdBy would credit whoever raised
  // the task, which on a firm where one administrator raises everything is every task.
  assert.match(controller, /status: \{ \$in: \["FILED", "CLOSED"\] \}/);
  assert.match(controller, /\$group: \{ _id: "\$assignedTo"/);
  // And both aggregations are firm-scoped, which is the isolation rule this whole product turns on.
  const matches = controller.match(/\$match: \{[\s\S]*?firmId: firm\._id/g) || [];
  assert.equal(matches.length, 2, "both aggregations must be scoped to the firm");
});

await test("both reads are administrator-gated", () => {
  assert.match(controller, /canManageMembers/);
  // The adoption read is gated too, not just the org one -- it is a list of named people with a
  // "last active" beside each.
  const gated = controller.split("requireFirmAdministration").length - 1;
  assert.ok(gated >= 4, `requireFirmAdministration is used only ${gated - 1} times`);
});

function assertSingle(items) {
  assert.equal(items.length, 1, `expected exactly one, got ${items.length}`);
  return items[0];
}

const failures = results.filter((item) => !item.pass);
const passed = results.length - failures.length;
console.log(
  `\nFirm org contract: ${passed}/${results.length} passed, ${failures.length} failed`,
);
process.exitCode = failures.length === 0 ? 0 : 1;
