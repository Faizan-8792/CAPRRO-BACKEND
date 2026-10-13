// src/services/firm-org.service.js
//
// The reporting tree, and the adoption figures.
//
// Pure functions over rows the caller already loaded. No database and no clock unless one is handed
// in, so every rule below is testable and none of them can behave differently in a test than in
// production.
//
// THE TWO THINGS THIS FILE EXISTS TO GET RIGHT
// --------------------------------------------
// 1. A REPORTING GRAPH CAN CONTAIN A CYCLE, and a tree walk over one runs forever. Nothing in a
//    mongoose schema can prevent it: `reportsToUserId` is a ref, and a ref cannot say "not one of
//    my own descendants". So the cycle check is here, it runs before every save, and the tree
//    builder is written to terminate even if a cycle somehow reaches it.
//
// 2. THE ADOPTION FIGURES ARE NUMBERS ABOUT NAMED PEOPLE. This product already treats that as a
//    hazard -- TeamWorkloadPage ships a server-written disclaimer because a page of per-person
//    counts reads as a ranking. The same care applies here, and then some, because "last active"
//    invites a conclusion about somebody's diligence that the data cannot support: it records when
//    a request last carried their token, not whether they were working.

/** Nobody is recorded. Deliberately distinct from "top of the tree" -- see buildOrgTree. */
export const NO_MANAGER = null;

/**
 * Walks up from `startUserId` and reports every id on the way, nearest first.
 *
 * Bounded by the number of memberships, so it terminates even on a graph that already contains a
 * cycle -- which can only happen if a row was written by something other than this module, but
 * "cannot happen" is not a reason to write a loop that would hang if it did.
 */
export function managerChain(memberships, startUserId) {
  const byUser = new Map(
    memberships.map((row) => [String(row.userId), row]),
  );

  const chain = [];
  const seen = new Set([String(startUserId)]);
  let current = byUser.get(String(startUserId));

  while (current?.reportsToUserId) {
    const next = String(current.reportsToUserId);
    if (seen.has(next)) break; // a cycle that should not exist; stop rather than spin
    chain.push(next);
    seen.add(next);
    current = byUser.get(next);
  }

  return chain;
}

/**
 * Why this reporting line may not be set, or null when it may.
 *
 * Every refusal is a plain sentence, and they are written here rather than in the controller so the
 * rules and their wording stay together.
 */
export function describeReportingRefusal(memberships, userId, managerUserId) {
  const subject = String(userId || "");
  const manager = managerUserId === null || managerUserId === undefined
    ? null
    : String(managerUserId);

  if (!subject) {
    return "Name the person whose reporting line you are setting";
  }

  const byUser = new Map(memberships.map((row) => [String(row.userId), row]));
  if (!byUser.has(subject)) {
    return "That person is not an active member of this workspace";
  }

  // Clearing is always allowed. A firm that reorganises must be able to empty a line before
  // setting a new one, and refusing that would force people through an invalid intermediate state.
  if (manager === null || manager === "") {
    return null;
  }

  if (manager === subject) {
    return "Somebody cannot report to themselves";
  }

  if (!byUser.has(manager)) {
    // Covers both "not in this firm" and "no longer active", which the caller cannot tell apart
    // either -- the membership list it passes in is already filtered to ACTIVE.
    return "That manager is not an active member of this workspace";
  }

  // THE CYCLE CHECK. Setting subject -> manager is a cycle exactly when subject already appears
  // above manager. Asked by walking UP from the proposed manager, which is bounded by the chain
  // length rather than by the size of the firm.
  if (managerChain(memberships, manager).includes(subject)) {
    return "That would make two people report to each other, directly or through somebody else";
  }

  return null;
}

/**
 * The reporting tree: roots first, each with its reports nested.
 *
 * A ROOT IS NOT "THE BOSS". A member with no manager recorded is a root here, and on a firm that
 * has never filled this in that means every single member is a root. The caller must render that as
 * "no reporting lines recorded" rather than as a flat org chart of equals, which is why
 * `hasAnyLine` is returned alongside.
 *
 * Any member caught in a cycle is returned under `orphaned` rather than dropped or forced into the
 * tree: dropping them would silently shrink the firm, and forcing them in would produce a tree that
 * contains itself.
 */
export function buildOrgTree(memberships) {
  const rows = memberships.map((row) => ({
    userId: String(row.userId),
    reportsToUserId: row.reportsToUserId ? String(row.reportsToUserId) : null,
    role: row.role || "MEMBER",
  }));

  const byUser = new Map(rows.map((row) => [row.userId, row]));
  const children = new Map();
  const roots = [];
  const orphaned = [];

  for (const row of rows) {
    const manager = row.reportsToUserId;

    // A line pointing at somebody who is no longer here is treated as no line, and the person is
    // reported as a root rather than vanishing. Their manager left; they did not.
    if (!manager || !byUser.has(manager)) {
      roots.push(row.userId);
      continue;
    }

    // In a cycle: reachable from itself walking up. Asked from the MANAGER, not from the node
    // itself, and that distinction is the whole check -- managerChain seeds its `seen` set with
    // the id it starts from, so a chain started at the node breaks on returning to it and can
    // never contain it. Started at the manager, a cycle shows up as the node appearing above
    // itself, which is exactly what describeReportingRefusal asks on the write path.
    //
    // The first draft asked from the node and silently detected nothing: a two-person cycle nested
    // each of them under the other, and the orphaned list came back empty on data that was
    // entirely cyclic.
    if (managerChain(rows, manager).includes(row.userId)) {
      orphaned.push(row.userId);
      continue;
    }

    if (!children.has(manager)) children.set(manager, []);
    children.get(manager).push(row.userId);
  }

  const nest = (userId, depth) => ({
    userId,
    role: byUser.get(userId)?.role || "MEMBER",
    depth,
    // Bounded by the membership count through the cycle check above, so this cannot recurse
    // forever even on data written outside this module.
    reports: (children.get(userId) || [])
      .slice()
      .sort()
      .map((child) => nest(child, depth + 1)),
  });

  return {
    roots: roots.slice().sort().map((userId) => nest(userId, 0)),
    orphaned: orphaned.slice().sort(),
    hasAnyLine: rows.some((row) => row.reportsToUserId),
    memberCount: rows.length,
  };
}

/**
 * Adoption: per person, what the firm's own records say they have done.
 *
 * `created` and `completed` are counts the CALLER aggregated from Task; `lastActiveAt` is whatever
 * the user document holds. This function only assembles and orders them, and attaches the wording
 * that stops the result being read as a performance table.
 *
 * NOTHING HERE IS DERIVED OR ESTIMATED. A member the aggregation returned no row for gets zero,
 * because zero tasks created is a real and correct answer; a member whose lastActiveAt is absent
 * gets null, because "never recorded" is not the same as "never active" and must not render as a
 * date.
 */
export function buildAdoption(memberships, taskCounts, { now = new Date() } = {}) {
  const created = new Map(
    (taskCounts?.created || []).map((row) => [String(row._id), Number(row.count) || 0]),
  );
  const completed = new Map(
    (taskCounts?.completed || []).map((row) => [String(row._id), Number(row.count) || 0]),
  );

  const rows = memberships.map((row) => {
    const userId = String(row.userId);
    const lastActive = row.lastActiveAt ? new Date(row.lastActiveAt) : null;

    return {
      userId,
      role: row.role || "MEMBER",
      tasksCreated: created.get(userId) || 0,
      tasksCompleted: completed.get(userId) || 0,
      lastActiveAt: lastActive ? lastActive.toISOString() : null,
      // Whole days, floored, or null. Computed server-side so two clients cannot disagree about
      // what "14 days" means across a timezone.
      daysSinceActive: lastActive
        ? Math.max(0, Math.floor((now.getTime() - lastActive.getTime()) / 86_400_000))
        : null,
    };
  });

  // Ordered by name-less, stable keys: most recently active first, never-recorded last, then by id
  // so two runs cannot disagree. NOT ordered by task count, which would make the page a leaderboard
  // by construction.
  rows.sort((a, b) => {
    if (a.daysSinceActive === null && b.daysSinceActive === null) {
      return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
    }
    if (a.daysSinceActive === null) return 1;
    if (b.daysSinceActive === null) return -1;
    if (a.daysSinceActive !== b.daysSinceActive) {
      return a.daysSinceActive - b.daysSinceActive;
    }
    return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
  });

  return {
    rows,
    /**
     * The disclaimer, shipped WITH the data so a client cannot render the numbers without it.
     *
     * The same shape TeamWorkload already uses, and for a stronger reason: "last active" is the
     * most misreadable figure in this product. It records when a request last carried somebody's
     * token, which a holiday, a phone, or a quiet fortnight of audit fieldwork all change without
     * saying anything about the work.
     */
    disclaimer:
      "These figures show what this workspace's records contain, not how much work somebody has done. "
      + "Last active records when an account last made a request, so leave, fieldwork or working from another device all change it. "
      + "Tasks created and completed count only tasks tracked in CA PRO.",
    neverActive: rows.filter((row) => row.lastActiveAt === null).length,
  };
}
