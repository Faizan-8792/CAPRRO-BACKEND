// Mutations for the reporting tree and the adoption figures.
//
//   node tools/mutation-harness.mjs tools/mutations/firm-org.mjs
//
// Mutations 1-5 are the cycle check, which is the reason firm-org.service.js exists as its own
// module: a reporting graph can contain a loop, no mongoose schema can prevent one because a ref
// cannot say "not one of my own descendants", and a tree walk over a loop runs forever. Mutation 3
// is the bug this suite ACTUALLY caught while being written -- buildOrgTree asked the cycle
// question from the node instead of from its manager, and detected nothing at all.
//
// Mutations 9-14 are the adoption figures, where every plausible error is the same error: turning
// an absence into a number. A member never recorded as active is not a member last active at the
// epoch, and zero tasks created is not the same fact as "we have no record".

export const target = "src/services/firm-org.service.js";
export const suite = "tests/firm-org-contract.mjs";

export const mutations = [
  // --- the cycle check ------------------------------------------------------
  {
    name: "1. the cycle check is removed outright",
    find: `  if (managerChain(memberships, manager).includes(subject)) {
    return "That would make two people report to each other, directly or through somebody else";
  }`,
    replace: "",
  },
  {
    name: "2. the cycle check only catches a DIRECT loop, not one through a third person",
    find: "  if (managerChain(memberships, manager).includes(subject)) {",
    replace: "  if (byUser.get(manager)?.reportsToUserId === subject) {",
  },
  {
    name: "3. buildOrgTree asks the cycle question from the node instead of its manager",
    find: "    if (managerChain(rows, manager).includes(row.userId)) {",
    replace: "    if (managerChain(rows, row.userId).includes(row.userId)) {",
  },
  {
    name: "4. managerChain stops guarding against revisiting, so a loop spins forever",
    find: "    if (seen.has(next)) break; // a cycle that should not exist; stop rather than spin",
    replace: "    if (false) break;",
  },
  {
    name: "5. somebody may report to themselves",
    find: `  if (manager === subject) {
    return "Somebody cannot report to themselves";
  }`,
    replace: "",
  },

  // --- membership scoping ---------------------------------------------------
  {
    name: "6. a manager outside the firm is accepted",
    find: `  if (!byUser.has(manager)) {`,
    replace: `  if (false) {`,
  },
  {
    name: "7. clearing a reporting line is refused, trapping a firm mid-reorganisation",
    find: `  if (manager === null || manager === "") {
    return null;
  }`,
    replace: "",
  },

  // --- what a root means ----------------------------------------------------
  {
    name: "8. hasAnyLine is always true, so an empty firm looks like a flat hierarchy",
    find: "    hasAnyLine: rows.some((row) => row.reportsToUserId),",
    replace: "    hasAnyLine: true,",
  },
  {
    name: "9. a member whose manager left is DROPPED instead of becoming a root",
    find: `    if (!manager || !byUser.has(manager)) {
      roots.push(row.userId);
      continue;
    }`,
    replace: `    if (!manager || !byUser.has(manager)) {
      continue;
    }`,
  },
  {
    name: "10. the tree loses its stable ordering",
    find: `    roots: roots.slice().sort().map((userId) => nest(userId, 0)),`,
    replace: `    roots: roots.map((userId) => nest(userId, 0)),`,
  },

  // --- adoption: turning an absence into a number ---------------------------
  {
    name: "11. a member never recorded as active reports a date instead of null",
    find: "      lastActiveAt: lastActive ? lastActive.toISOString() : null,",
    replace: "      lastActiveAt: (lastActive || new Date(0)).toISOString(),",
  },
  {
    name: "12. days since active is reported as 0 rather than null when never recorded",
    find: `      daysSinceActive: lastActive
        ? Math.max(0, Math.floor((now.getTime() - lastActive.getTime()) / 86_400_000))
        : null,`,
    replace: `      daysSinceActive: lastActive
        ? Math.max(0, Math.floor((now.getTime() - lastActive.getTime()) / 86_400_000))
        : 0,`,
  },
  {
    name: "13. clock skew can report a negative number of days",
    find: "        ? Math.max(0, Math.floor((now.getTime() - lastActive.getTime()) / 86_400_000))",
    replace: "        ? Math.floor((now.getTime() - lastActive.getTime()) / 86_400_000)",
  },
  {
    name: "14. days is rounded rather than floored, so 14.6 days reads as 15",
    find: "        ? Math.max(0, Math.floor((now.getTime() - lastActive.getTime()) / 86_400_000))",
    replace: "        ? Math.max(0, Math.round((now.getTime() - lastActive.getTime()) / 86_400_000))",
  },
  {
    name: "15. the page becomes a leaderboard, ordered by task count",
    find: `    if (a.daysSinceActive !== b.daysSinceActive) {
      return a.daysSinceActive - b.daysSinceActive;
    }`,
    replace: `    if (a.tasksCreated !== b.tasksCreated) {
      return b.tasksCreated - a.tasksCreated;
    }`,
  },
  {
    name: "16. never-recorded members sort FIRST, as though they were the most recently active",
    find: `    if (a.daysSinceActive === null) return 1;
    if (b.daysSinceActive === null) return -1;`,
    replace: `    if (a.daysSinceActive === null) return -1;
    if (b.daysSinceActive === null) return 1;`,
  },
  {
    name: "17. the disclaimer stops saying the figures are not a measure of work",
    find: `      "These figures show what this workspace's records contain, not how much work somebody has done. "`,
    replace: `      "Team adoption figures for this workspace. "`,
  },
  {
    name: "18. the disclaimer drops the innocent reasons last-active moves",
    find: `      + "Last active records when an account last made a request, so leave, fieldwork or working from another device all change it. "`,
    replace: `      + "Last active records when an account last made a request. "`,
  },
];
