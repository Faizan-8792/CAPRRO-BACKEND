// The four-tier firm role ladder, and the migration onto it.
//
//   node capro-backend/tests/firm-role-tier-contract.mjs
//
// WHAT THIS GUARDS
// ----------------
// VIEWER lands on CanWriteFirmData's server twin, requireFirmWriteAccess -- the single gate every
// write in the product passes through. TASK-MANAGEMENT-DESIGN.md section 2.3 says so plainly:
//
//   "a VIEWER that accidentally reads as MEMBER grants firm-wide write access to everyone who was
//    read-only"
//
// So this suite exists before the enum gains a value, and it does two separate jobs.
//
// JOB 1 -- PIN, by differential comparison.
// The full authority matrix is evaluated twice: once through the real middleware chain against stub
// models, and once through the new resolveFirmAuthority accessor. Every combination must agree.
// That is what makes centralising three copies of the ladder into one accessor provably
// behaviour-preserving rather than hopefully so, and it is stronger than a golden file, because
// nobody had to write down what the old behaviour was -- the old code is one of the two answers.
//
// JOB 2 -- the migration itself (DESIGN section 2.2), which must preserve every existing member's
// effective access exactly:
//
//     firm memberAccess EDIT      + MEMBER  ->  MEMBER   (writes, as before)
//     firm memberAccess READ_ONLY + MEMBER  ->  VIEWER   (no writes, as before)
//     memberAccess absent (legacy) + MEMBER ->  MEMBER   (absent means EDIT, as before)
//     any                         + OWNER   ->  unchanged
//     any                         + ADMIN   ->  unchanged
//
// HOW THIS SUITE WAS PROVEN TO BE A CHECK AT ALL
// ----------------------------------------------
// It asserts the FINAL behaviour, including that a VIEWER is refused a write. Run against the
// middleware BEFORE it was refactored onto the accessor, it reported 21/22 passed, and the single
// failure named its own disagreements:
//
//     8 of 216 combinations disagreed, and ALL EIGHT were "ACTIVE VIEWER" write cases
//     ('USER / ACTIVE VIEWER / EDIT / SHARED / owns: middleware=true accessor=false', and so on)
//
// which is the point. The old middleware had no VIEWER branch, so it let a VIEWER write. The read
// comparison, the administer comparison and the GET check all passed 216/216 unchanged.
//
// So: 208 of 216 write verdicts were identical before the refactor, and 216 of 216 after. The
// eight that moved are the eight the feature exists to move, and no document can be affected by
// them, because nothing in this repository has ever written role: "VIEWER". That measurement is
// the whole evidence behind "adding VIEWER changed no existing verdict" -- if this suite ever
// reports a disagreement that is NOT a VIEWER write case, something else moved and the claim is
// void.

import assert from "node:assert/strict";
import { createFirmAuthorization } from "../src/middleware/authorization.middleware.js";
import {
  DEFAULT_INVITE_ROLE,
  FIRM_ROLE_LADDER,
  INVITABLE_FIRM_ROLES,
  PENDING_ELEVATION_ROLE,
  effectiveFirmRole,
  highestInvitableRole,
  isInvitableRole,
  resolveFirmAuthority,
  roleAtLeast,
} from "../src/services/firm-authority.service.js";

const FIRM_ID = "firm-a";
const OWNER_ID = "user-owner";

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

// ---------------------------------------------------------------------------
// Stub models. Mongoose's findOne(...).select(...).lean() shape, no database.
// ---------------------------------------------------------------------------

function stubModels(firm, membership) {
  const chain = (value) => ({
    select: () => ({ lean: async () => value }),
  });
  return {
    FirmModel: {
      findOne: (filter) => {
        if (!firm) return chain(null);
        if (String(filter._id) !== FIRM_ID) return chain(null);
        if (filter.isActive === true && firm.isActive === false) {
          return chain(null);
        }
        return chain(firm);
      },
    },
    MembershipModel: { findOne: () => chain(membership) },
  };
}

/** Runs one middleware guard and reports only whether it let the request through. */
async function middlewareAllows(guard, user, method) {
  let allowed = false;
  let settle;
  const done = new Promise((resolve) => {
    settle = resolve;
  });
  const res = {
    status: () => res,
    json: () => {
      settle();
      return res;
    },
  };
  await guard({ user, method, id: "req-1" }, res, (error) => {
    if (!error) allowed = true;
    settle();
  });
  await done;
  return allowed;
}

// ---------------------------------------------------------------------------
// The matrix. Every combination that can reach an authority decision.
// ---------------------------------------------------------------------------

const ACCOUNT_ROLES = ["USER", "FIRM_ADMIN", "SUPER_ADMIN"];
const MEMBERSHIPS = [
  { label: "no membership", value: null },
  { label: "ACTIVE OWNER", value: { status: "ACTIVE", role: "OWNER" } },
  { label: "ACTIVE ADMIN", value: { status: "ACTIVE", role: "ADMIN" } },
  { label: "ACTIVE MEMBER", value: { status: "ACTIVE", role: "MEMBER" } },
  { label: "ACTIVE VIEWER", value: { status: "ACTIVE", role: "VIEWER" } },
  { label: "REMOVED MEMBER", value: { status: "REMOVED", role: "MEMBER" } },
];
const ACCESS_POLICIES = [
  { label: "EDIT", memberAccess: "EDIT" },
  { label: "READ_ONLY", memberAccess: "READ_ONLY" },
  { label: "absent (legacy)", memberAccess: undefined },
];
const KINDS = ["SHARED", "PERSONAL"];

function* matrix() {
  for (const accountRole of ACCOUNT_ROLES) {
    for (const membership of MEMBERSHIPS) {
      for (const access of ACCESS_POLICIES) {
        for (const kind of KINDS) {
          for (const ownsFirm of [true, false]) {
            const userId = ownsFirm ? OWNER_ID : "user-other";
            const firm = {
              _id: FIRM_ID,
              ownerUserId: OWNER_ID,
              isActive: true,
              kind,
              ...(access.memberAccess === undefined
                ? {}
                : { memberAccess: access.memberAccess }),
            };
            yield {
              label: `${accountRole} / ${membership.label} / ${access.label} / ${kind} / ${ownsFirm ? "owns" : "not owner"}`,
              user: { id: userId, role: accountRole, firmId: FIRM_ID },
              firm,
              membership: membership.value,
            };
          }
        }
      }
    }
  }
}

const cases = [...matrix()];

await test(`the matrix covers ${cases.length} combinations`, () => {
  // 3 account roles x 6 memberships x 3 access policies x 2 kinds x 2 ownership = 216.
  assert.equal(cases.length, 216);
});

// JOB 1: the middleware and the accessor must agree on every combination.
await test("write access: middleware and accessor agree on all 216 combinations", async () => {
  const disagreed = [];
  for (const item of cases) {
    const guards = createFirmAuthorization(stubModels(item.firm, item.membership));
    const middleware = await middlewareAllows(
      guards.requireFirmWriteAccess,
      item.user,
      "POST",
    );
    const accessor = resolveFirmAuthority(item).canWrite;
    if (middleware !== accessor) {
      disagreed.push(`${item.label}: middleware=${middleware} accessor=${accessor}`);
    }
  }
  assert.deepEqual(disagreed, []);
});

await test("read access: middleware and accessor agree on all 216 combinations", async () => {
  const disagreed = [];
  for (const item of cases) {
    const guards = createFirmAuthorization(stubModels(item.firm, item.membership));
    const middleware = await middlewareAllows(
      guards.requireFirmMember,
      item.user,
      "GET",
    );
    const accessor = resolveFirmAuthority(item).canRead;
    if (middleware !== accessor) {
      disagreed.push(`${item.label}: middleware=${middleware} accessor=${accessor}`);
    }
  }
  assert.deepEqual(disagreed, []);
});

await test("administer access: middleware and accessor agree on all 216 combinations", async () => {
  const disagreed = [];
  for (const item of cases) {
    const guards = createFirmAuthorization(stubModels(item.firm, item.membership));
    const middleware = await middlewareAllows(
      guards.requireFirmAdmin,
      item.user,
      "GET",
    );
    const accessor = resolveFirmAuthority(item).canAdminister;
    if (middleware !== accessor) {
      disagreed.push(`${item.label}: middleware=${middleware} accessor=${accessor}`);
    }
  }
  assert.deepEqual(disagreed, []);
});

// A non-mutating method skips the write gate entirely. Asserted separately because the matrix
// above drives it with POST, and a guard that let GET through for the wrong reason would hide here.
await test("the write gate does not run on a GET, whatever the tier", async () => {
  for (const item of cases) {
    const guards = createFirmAuthorization(stubModels(item.firm, item.membership));
    assert.equal(
      await middlewareAllows(guards.requireFirmWriteAccess, item.user, "GET"),
      true,
      `${item.label} should have skipped the write gate on GET`,
    );
  }
});

// ---------------------------------------------------------------------------
// JOB 2: the migration, DESIGN section 2.2, one row at a time.
// ---------------------------------------------------------------------------

const sharedFirm = (memberAccess) => ({
  _id: FIRM_ID,
  ownerUserId: OWNER_ID,
  isActive: true,
  kind: "SHARED",
  ...(memberAccess === undefined ? {} : { memberAccess }),
});

await test("migration: EDIT + MEMBER stays MEMBER and keeps writing", () => {
  const firm = sharedFirm("EDIT");
  const membership = { status: "ACTIVE", role: "MEMBER" };
  assert.equal(effectiveFirmRole(firm, membership, "user-other"), "MEMBER");
  assert.equal(
    resolveFirmAuthority({
      user: { id: "user-other", role: "USER" },
      firm,
      membership,
    }).canWrite,
    true,
  );
});

await test("migration: READ_ONLY + MEMBER becomes VIEWER and still cannot write", () => {
  const firm = sharedFirm("READ_ONLY");
  const membership = { status: "ACTIVE", role: "MEMBER" };
  assert.equal(effectiveFirmRole(firm, membership, "user-other"), "VIEWER");
  const authority = resolveFirmAuthority({
    user: { id: "user-other", role: "USER" },
    firm,
    membership,
  });
  assert.equal(authority.canWrite, false);
  // Read-only means read-only, not shut out. A VIEWER who could not read would be a regression
  // dressed as a security improvement.
  assert.equal(authority.canRead, true);
});

await test("migration: an absent memberAccess is EDIT, not read-only", () => {
  // Legacy documents predate the field. Reading absence as READ_ONLY would silently strip write
  // access from every member of every firm created before it existed.
  const firm = sharedFirm(undefined);
  const membership = { status: "ACTIVE", role: "MEMBER" };
  assert.equal(effectiveFirmRole(firm, membership, "user-other"), "MEMBER");
  assert.equal(
    resolveFirmAuthority({
      user: { id: "user-other", role: "USER" },
      firm,
      membership,
    }).canWrite,
    true,
  );
});

await test("migration: OWNER and ADMIN ignore memberAccess, both before and after", () => {
  for (const access of ["EDIT", "READ_ONLY", undefined]) {
    const firm = sharedFirm(access);
    assert.equal(
      effectiveFirmRole(firm, { status: "ACTIVE", role: "OWNER" }, OWNER_ID),
      "OWNER",
      `owner under memberAccess=${access}`,
    );
    assert.equal(
      effectiveFirmRole(firm, { status: "ACTIVE", role: "ADMIN" }, "user-other"),
      "ADMIN",
      `admin under memberAccess=${access}`,
    );
    assert.equal(
      resolveFirmAuthority({
        user: { id: "user-other", role: "USER" },
        firm,
        membership: { status: "ACTIVE", role: "ADMIN" },
      }).canWrite,
      true,
      `admin write under memberAccess=${access}`,
    );
  }
});

await test("an explicit VIEWER cannot write even when the firm allows member edits", () => {
  // The whole point of the tier: per-member, not firm-wide.
  const firm = sharedFirm("EDIT");
  const authority = resolveFirmAuthority({
    user: { id: "user-other", role: "USER" },
    firm,
    membership: { status: "ACTIVE", role: "VIEWER" },
  });
  assert.equal(authority.role, "VIEWER");
  assert.equal(authority.canWrite, false);
  assert.equal(authority.canRead, true);
  assert.equal(authority.canAdminister, false);
});

await test("a stale OWNER row is not authority", () => {
  // A membership saying OWNER on a firm owned by somebody else follows ordinary member policy --
  // preserved verbatim from the middleware it replaced.
  const firm = sharedFirm("EDIT");
  const membership = { status: "ACTIVE", role: "OWNER" };
  const authority = resolveFirmAuthority({
    user: { id: "user-other", role: "USER" },
    firm,
    membership,
  });
  assert.equal(authority.isOwner, false);
  assert.equal(authority.role, "MEMBER");
  assert.equal(authority.canWrite, true);
  assert.equal(authority.canAdminister, false);
  assert.equal(authority.canTransferOwnership, false);

  // ... and in a read-only firm that same stale row lands on VIEWER, not on MEMBER.
  assert.equal(
    resolveFirmAuthority({
      user: { id: "user-other", role: "USER" },
      firm: sharedFirm("READ_ONLY"),
      membership,
    }).canWrite,
    false,
  );
});

await test("no active membership is null, not the bottom rung", () => {
  // Absence of a rung and standing on the lowest rung are different facts. A caller that treated
  // null as VIEWER would grant read access to a removed colleague.
  const firm = sharedFirm("EDIT");
  assert.equal(effectiveFirmRole(firm, null, "user-other"), null);
  assert.equal(
    effectiveFirmRole(firm, { status: "REMOVED", role: "MEMBER" }, "user-other"),
    null,
  );
  const removed = resolveFirmAuthority({
    user: { id: "user-other", role: "USER" },
    firm,
    membership: { status: "REMOVED", role: "MEMBER" },
  });
  assert.equal(removed.role, null);
  assert.equal(removed.canRead, false);
  assert.equal(removed.canWrite, false);
  // A removal row reads differently from never having been a member, which is what lets the
  // middleware say "you are no longer a member" instead of "membership required".
  assert.equal(removed.wasRemoved, true);
  assert.equal(
    resolveFirmAuthority({
      user: { id: "user-other", role: "USER" },
      firm,
      membership: null,
    }).wasRemoved,
    false,
  );
});

// ---------------------------------------------------------------------------
// The ladder, and the invite ceiling rules that depend on it.
// ---------------------------------------------------------------------------

await test("the ladder is ordered lowest authority first", () => {
  assert.deepEqual(FIRM_ROLE_LADDER, ["VIEWER", "MEMBER", "ADMIN", "OWNER"]);
  assert.equal(roleAtLeast("OWNER", "ADMIN"), true);
  assert.equal(roleAtLeast("ADMIN", "ADMIN"), true);
  assert.equal(roleAtLeast("MEMBER", "ADMIN"), false);
  assert.equal(roleAtLeast("VIEWER", "MEMBER"), false);
});

await test("an unknown or absent role is never at or above any rung", () => {
  // Fails closed. A typo in a role string must not read as authority.
  for (const value of ["", null, undefined, "SUPER_ADMIN", "owner", "Admin", "ANYTHING"]) {
    assert.equal(roleAtLeast(value, "VIEWER"), false, `roleAtLeast(${value})`);
  }
});

await test("OWNER can never be granted by an invite", () => {
  assert.equal(INVITABLE_FIRM_ROLES.includes("OWNER"), false);
  assert.equal(isInvitableRole("OWNER"), false);
  assert.deepEqual(INVITABLE_FIRM_ROLES, ["ADMIN", "MEMBER", "VIEWER"]);
  for (const value of ["", null, undefined, "SUPER_ADMIN", "FIRM_ADMIN", "member"]) {
    assert.equal(isInvitableRole(value), false, `isInvitableRole(${value})`);
  }
});

await test("an invite ceiling never defaults to the top tier", () => {
  assert.equal(DEFAULT_INVITE_ROLE, "MEMBER");
  assert.notEqual(DEFAULT_INVITE_ROLE, "ADMIN");
  assert.notEqual(DEFAULT_INVITE_ROLE, "OWNER");
});

await test("an admin cannot mint another admin; only the owner can", () => {
  const firm = sharedFirm("EDIT");
  const owner = resolveFirmAuthority({
    user: { id: OWNER_ID, role: "USER" },
    firm,
    membership: { status: "ACTIVE", role: "OWNER" },
  });
  const admin = resolveFirmAuthority({
    user: { id: "user-other", role: "USER" },
    firm,
    membership: { status: "ACTIVE", role: "ADMIN" },
  });
  const member = resolveFirmAuthority({
    user: { id: "user-other", role: "USER" },
    firm,
    membership: { status: "ACTIVE", role: "MEMBER" },
  });

  assert.equal(highestInvitableRole(owner), "ADMIN");
  assert.equal(highestInvitableRole(admin), "MEMBER");
  assert.equal(highestInvitableRole(member), null);
  assert.equal(highestInvitableRole(undefined), null);

  // The four owner-only powers an Admin must not hold. If any of these ever reads true for an
  // Admin, the elevation gate is decorative.
  for (const power of [
    "canTransferOwnership",
    "canManageAdmins",
    "canApproveElevation",
    "canInviteAdmins",
    "canChangeFirmPolicy",
  ]) {
    assert.equal(owner[power], true, `owner should hold ${power}`);
    assert.equal(admin[power], false, `admin must NOT hold ${power}`);
    assert.equal(member[power], false, `member must NOT hold ${power}`);
  }

  // ... but an Admin does hold everything below that line.
  assert.equal(admin.canAdminister, true);
  assert.equal(admin.canManageMembers, true);
  assert.equal(admin.canManageInvites, true);
});

await test("a pending elevation lands on MEMBER, never on the tier being requested", () => {
  assert.equal(PENDING_ELEVATION_ROLE, "MEMBER");
  assert.notEqual(PENDING_ELEVATION_ROLE, "ADMIN");
});

await test("a super admin bypasses the ladder but is not on it", () => {
  const firm = sharedFirm("READ_ONLY");
  const superAdmin = resolveFirmAuthority({
    user: { id: "user-super", role: "SUPER_ADMIN" },
    firm,
    membership: null,
  });
  assert.equal(superAdmin.canWrite, true);
  assert.equal(superAdmin.canAdminister, true);
  // Not a rung: the role field reports what the membership says, which is nothing.
  assert.equal(superAdmin.role, null);
  assert.equal(FIRM_ROLE_LADDER.includes("SUPER_ADMIN"), false);
});

await test("nobody else reaches another person's personal workspace", () => {
  const personal = {
    _id: FIRM_ID,
    ownerUserId: OWNER_ID,
    isActive: true,
    kind: "PERSONAL",
    memberAccess: "EDIT",
  };
  // Even an ACTIVE ADMIN membership row on somebody else's personal firm grants nothing.
  const intruder = resolveFirmAuthority({
    user: { id: "user-other", role: "FIRM_ADMIN" },
    firm: personal,
    membership: { status: "ACTIVE", role: "ADMIN" },
  });
  assert.equal(intruder.isForeignPersonalWorkspace, true);
  assert.equal(intruder.canRead, false);
  assert.equal(intruder.canWrite, false);
  assert.equal(intruder.canAdminister, false);

  // The owner of it is unaffected.
  const mine = resolveFirmAuthority({
    user: { id: OWNER_ID, role: "USER" },
    firm: personal,
    membership: { status: "ACTIVE", role: "OWNER" },
  });
  assert.equal(mine.isForeignPersonalWorkspace, false);
  assert.equal(mine.canWrite, true);
});

await test("an account-level FIRM_ADMIN is not firm-local authority", () => {
  // The account-level grant unlocks the platform's own admin surfaces. It must not, on its own,
  // make somebody an administrator of a firm they merely belong to.
  const authority = resolveFirmAuthority({
    user: { id: "user-other", role: "FIRM_ADMIN" },
    firm: sharedFirm("EDIT"),
    membership: { status: "ACTIVE", role: "MEMBER" },
  });
  assert.equal(authority.canWrite, true);
  assert.equal(authority.canAdminister, false);
  assert.equal(authority.canManageMembers, false);
});

await test("an absent user, firm or membership denies everything", () => {
  for (const input of [
    undefined,
    {},
    { user: { id: "u", role: "USER" } },
    { firm: sharedFirm("EDIT") },
    { user: { id: "u", role: "USER" }, firm: sharedFirm("EDIT") },
  ]) {
    const authority = resolveFirmAuthority(input);
    assert.equal(authority.canRead, false);
    assert.equal(authority.canWrite, false);
    assert.equal(authority.canAdminister, false);
    assert.equal(authority.canTransferOwnership, false);
  }
});

const failures = results.filter((item) => !item.pass);
const passed = results.length - failures.length;
console.log(
  `\nFirm role tier contract: ${passed}/${results.length} passed, ${failures.length} failed`,
);
process.exitCode = failures.length === 0 ? 0 : 1;
