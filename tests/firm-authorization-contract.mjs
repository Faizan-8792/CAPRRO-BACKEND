import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createFirmAuthorization } from "../src/middleware/authorization.middleware.js";

const FIRM_A = "firm-a";
const OWNER_ID = "user-owner";
const MUTATING_METHODS = ["POST", "PUT", "PATCH", "DELETE"];
const WRITE_GUARD_ROUTES = [
  "case.routes.js",
  "gst-reconciliation.routes.js",
  "import.routes.js",
  "task.routes.js",
  "tds-health.routes.js",
];

function project(document, selection) {
  if (!document || !selection) return document;

  const projected = {};
  for (const field of String(selection).trim().split(/\s+/)) {
    if (!field || field.startsWith("-") || !Object.hasOwn(document, field)) {
      continue;
    }
    projected[field] = document[field];
  }
  return projected;
}

function query(load, recordSelection) {
  let selection = "";
  const api = {
    select(fields) {
      selection = String(fields || "");
      recordSelection?.(selection);
      return api;
    },
    lean: async () => load(selection),
  };
  return api;
}

function sequenceValue(values, index) {
  return values[Math.min(index, values.length - 1)];
}

function models(options = {}) {
  const includeMemberAccess = options.includeMemberAccess !== false;
  const defaultFirm = {
    _id: FIRM_A,
    ownerUserId: OWNER_ID,
    isActive: options.isActive !== false,
    ...(Object.hasOwn(options, "kind") ? { kind: options.kind } : {}),
    ...(includeMemberAccess
      ? {
          memberAccess: Object.hasOwn(options, "memberAccess")
            ? options.memberAccess
            : "EDIT",
        }
      : {}),
  };
  const firmSequence = options.firmSequence || [defaultFirm];
  const membershipSequence = options.membershipSequence || null;
  const memberships = options.memberships || [];
  const state = {
    firmLoads: 0,
    membershipLoads: 0,
    firmSelections: [],
    membershipSelections: [],
  };

  return {
    FirmModel: {
      findOne: (filter) =>
        query(
          (selection) => {
            const loadIndex = state.firmLoads;
            state.firmLoads += 1;
            if (Object.hasOwn(options, "firmLookupError")) {
              throw options.firmLookupError;
            }

            const firm = sequenceValue(firmSequence, loadIndex);
            if (!firm || String(filter._id) !== FIRM_A) return null;
            if (filter.isActive === true && firm.isActive === false)
              return null;
            return project(firm, selection);
          },
          (selection) => state.firmSelections.push(selection),
        ),
    },
    MembershipModel: {
      findOne: (filter) =>
        query(
          (selection) => {
            const loadIndex = state.membershipLoads;
            state.membershipLoads += 1;
            if (Object.hasOwn(options, "membershipLookupError")) {
              throw options.membershipLookupError;
            }

            const membership = membershipSequence
              ? sequenceValue(membershipSequence, loadIndex)
              : memberships.find(
                  (item) =>
                    item.userId === String(filter.userId) &&
                    item.firmId === String(filter.firmId),
                ) || null;
            if (
              membership &&
              (membership.userId !== String(filter.userId) ||
                membership.firmId !== String(filter.firmId))
            ) {
              return null;
            }
            return project(membership, selection);
          },
          (selection) => state.membershipSelections.push(selection),
        ),
    },
    state,
  };
}

async function runChain(guards, { user, method = "GET", requestId = "req-1" }) {
  const outcome = {
    status: null,
    body: null,
    passed: false,
    nextError: null,
  };
  const req = { user, method, id: requestId };
  let finish;
  const completed = new Promise((resolve) => {
    finish = resolve;
  });
  const res = {
    status(code) {
      outcome.status = code;
      return res;
    },
    json(body) {
      outcome.body = body;
      finish();
      return res;
    },
  };

  function dispatch(index) {
    if (index === guards.length) {
      outcome.passed = true;
      finish();
      return;
    }

    try {
      const returned = guards[index](req, res, (error) => {
        if (error) {
          outcome.nextError = error;
          finish();
          return;
        }
        dispatch(index + 1);
      });
      Promise.resolve(returned).catch((error) => {
        outcome.nextError = error;
        finish();
      });
    } catch (error) {
      outcome.nextError = error;
      finish();
    }
  }

  dispatch(0);
  await completed;
  return outcome;
}

function read(auth, user) {
  return runChain([auth.requireFirmMember], { user });
}

function write(auth, user, method = "POST") {
  // Mirrors each production router that uses the write-policy middleware.
  return runChain([auth.requireFirmMember, auth.requireFirmWriteAccess], {
    user,
    method,
  });
}

function isolatedWrite(auth, user, method = "POST") {
  return runChain([auth.requireFirmWriteAccess], { user, method });
}

function administer(auth, user) {
  return runChain([auth.requireFirmAdmin], { user });
}

function assertAllowed(outcome) {
  assert.equal(outcome.nextError, null);
  assert.equal(outcome.passed, true);
  assert.equal(outcome.status, null);
  assert.equal(outcome.body, null);
}

function assertDenied(outcome, { status = 403, error } = {}) {
  assert.equal(outcome.nextError, null);
  assert.equal(outcome.passed, false);
  assert.equal(outcome.status, status);
  assert.equal(outcome.body?.ok, false);
  assert.equal(outcome.body?.requestId, "req-1");
  if (error instanceof RegExp) assert.match(outcome.body.error, error);
  else if (error) assert.equal(outcome.body.error, error);
}

const results = [];
async function test(name, action) {
  try {
    await action();
    results.push({ name, pass: true });
    console.log(`[PASS] ${name}`);
  } catch (error) {
    results.push({ name, pass: false });
    console.error(`[FAIL] ${name}: ${error.stack || error.message}`);
  }
}

const member = { id: "user-member", role: "USER", firmId: FIRM_A };
const staleGlobalAdmin = {
  id: "user-member",
  role: "FIRM_ADMIN",
  firmId: FIRM_A,
};
const owner = { id: OWNER_ID, role: "USER", firmId: FIRM_A };
const superAdmin = {
  id: "user-super",
  role: "SUPER_ADMIN",
  firmId: FIRM_A,
};

function membershipFor(user, { role = "MEMBER", status = "ACTIVE" } = {}) {
  return { userId: user.id, firmId: FIRM_A, role, status };
}

const activeMember = membershipFor(member);
const removedMember = membershipFor(member, { status: "REMOVED" });

await test("Unauthenticated request is denied", async () => {
  const auth = createFirmAuthorization(models());
  assertDenied(await read(auth, null), {
    status: 401,
    error: "Unauthorized",
  });
});

await test("User with no active workspace is denied", async () => {
  const auth = createFirmAuthorization(models());
  const user = { id: member.id, role: "USER", firmId: null };
  assertDenied(await read(auth, user), { error: "Firm membership required" });
});

await test("Non-member cannot read workspace data", async () => {
  const auth = createFirmAuthorization(models());
  assertDenied(await read(auth, member), { error: "Firm membership required" });
});

await test("Non-member cannot mutate workspace data", async () => {
  const auth = createFirmAuthorization(models());
  assertDenied(await write(auth, member), {
    error: "Firm membership required",
  });
});

await test("Non-member cannot administer workspace", async () => {
  const auth = createFirmAuthorization(models());
  assertDenied(await administer(auth, member), {
    error: "Firm membership required",
  });
});

await test("Isolated mutation guard denies a non-member", async () => {
  const auth = createFirmAuthorization(models());
  assertDenied(await isolatedWrite(auth, member), {
    error: "Firm membership required",
  });
});

await test("Stale global FIRM_ADMIN without membership cannot read", async () => {
  const auth = createFirmAuthorization(models());
  assertDenied(await read(auth, staleGlobalAdmin), {
    error: "Firm membership required",
  });
});

await test("Stale global FIRM_ADMIN without membership cannot mutate", async () => {
  const auth = createFirmAuthorization(models());
  assertDenied(await write(auth, staleGlobalAdmin), {
    error: "Firm membership required",
  });
  assertDenied(await isolatedWrite(auth, staleGlobalAdmin), {
    error: "Firm membership required",
  });
});

await test("Stale global FIRM_ADMIN without membership cannot administer", async () => {
  const auth = createFirmAuthorization(models());
  assertDenied(await administer(auth, staleGlobalAdmin), {
    error: "Firm membership required",
  });
});

await test("ACTIVE MEMBER can read workspace data", async () => {
  const auth = createFirmAuthorization(models({ memberships: [activeMember] }));
  assertAllowed(await read(auth, member));
});

await test("ACTIVE MEMBER can use every mutation method when member access is EDIT", async () => {
  const auth = createFirmAuthorization(
    models({ memberAccess: "EDIT", memberships: [activeMember] }),
  );
  for (const method of MUTATING_METHODS) {
    assertAllowed(await write(auth, member, method));
  }
});

await test("Legacy firm without memberAccess allows ACTIVE MEMBER writes", async () => {
  const auth = createFirmAuthorization(
    models({ includeMemberAccess: false, memberships: [activeMember] }),
  );
  assertAllowed(await write(auth, member));
});

await test("READ_ONLY ACTIVE MEMBER can read workspace data", async () => {
  const auth = createFirmAuthorization(
    models({ memberAccess: "READ_ONLY", memberships: [activeMember] }),
  );
  assertAllowed(await read(auth, member));
});

await test("READ_ONLY ACTIVE MEMBER cannot use any mutation method", async () => {
  const fake = models({
    memberAccess: "READ_ONLY",
    memberships: [activeMember],
  });
  const auth = createFirmAuthorization(fake);

  for (const method of MUTATING_METHODS) {
    assertDenied(await write(auth, member, method), { error: /read-only/i });
  }
  assert.equal(
    fake.state.firmSelections.some((fields) => fields.includes("memberAccess")),
    true,
  );
});

await test("ACTIVE MEMBER cannot administer workspace", async () => {
  const auth = createFirmAuthorization(models({ memberships: [activeMember] }));
  assertDenied(await administer(auth, member), { error: "Firm admin only" });
});

await test("Stale global FIRM_ADMIN with ACTIVE MEMBER keeps only member rights", async () => {
  const editableAuth = createFirmAuthorization(
    models({ memberAccess: "EDIT", memberships: [activeMember] }),
  );
  assertAllowed(await write(editableAuth, staleGlobalAdmin));
  assertDenied(await administer(editableAuth, staleGlobalAdmin), {
    error: "Firm admin only",
  });

  const readOnlyAuth = createFirmAuthorization(
    models({ memberAccess: "READ_ONLY", memberships: [activeMember] }),
  );
  assertDenied(await write(readOnlyAuth, staleGlobalAdmin), {
    error: /read-only/i,
  });
});

await test("ACTIVE ADMIN membership grants administration and READ_ONLY writes", async () => {
  const activeAdmin = membershipFor(member, { role: "ADMIN" });
  const auth = createFirmAuthorization(
    models({ memberAccess: "READ_ONLY", memberships: [activeAdmin] }),
  );
  assertAllowed(await administer(auth, member));
  for (const method of MUTATING_METHODS) {
    assertAllowed(await write(auth, member, method));
  }
});

await test("ACTIVE stale OWNER row keeps member rights but cannot administer or bypass READ_ONLY", async () => {
  const staleOwnerMembership = membershipFor(member, { role: "OWNER" });
  const editableAuth = createFirmAuthorization(
    models({ memberAccess: "EDIT", memberships: [staleOwnerMembership] }),
  );
  assertAllowed(await read(editableAuth, member));
  assertAllowed(await write(editableAuth, member));
  assertDenied(await administer(editableAuth, member), {
    error: "Firm admin only",
  });

  const readOnlyAuth = createFirmAuthorization(
    models({ memberAccess: "READ_ONLY", memberships: [staleOwnerMembership] }),
  );
  assertAllowed(await read(readOnlyAuth, member));
  assertDenied(await write(readOnlyAuth, member), { error: /read-only/i });
  assertDenied(await administer(readOnlyAuth, member), {
    error: "Firm admin only",
  });
});

await test("Matching owner pointer with ACTIVE MEMBER keeps member rights only", async () => {
  const ownerMember = membershipFor(owner);
  const editableAuth = createFirmAuthorization(
    models({ memberAccess: "EDIT", memberships: [ownerMember] }),
  );
  assertAllowed(await read(editableAuth, owner));
  assertAllowed(await write(editableAuth, owner));
  assertDenied(await administer(editableAuth, owner), {
    error: "Firm admin only",
  });

  const readOnlyAuth = createFirmAuthorization(
    models({ memberAccess: "READ_ONLY", memberships: [ownerMember] }),
  );
  assertDenied(await write(readOnlyAuth, owner), { error: /read-only/i });
});

await test("Matching owner pointer with ACTIVE OWNER can administer and bypass READ_ONLY", async () => {
  const ownerMembership = membershipFor(owner, { role: "OWNER" });
  const auth = createFirmAuthorization(
    models({ memberAccess: "READ_ONLY", memberships: [ownerMembership] }),
  );
  assertAllowed(await read(auth, owner));
  assertAllowed(await administer(auth, owner));
  assertAllowed(await write(auth, owner));
  assertAllowed(await isolatedWrite(auth, owner));
});

await test("Matching owner pointer without membership has no workspace authority", async () => {
  const auth = createFirmAuthorization(models({ memberAccess: "READ_ONLY" }));
  const denial = { error: "Firm membership required" };
  assertDenied(await read(auth, owner), denial);
  assertDenied(await administer(auth, owner), denial);
  assertDenied(await write(auth, owner), denial);
  assertDenied(await isolatedWrite(auth, owner), denial);
});

await test("Matching owner pointer with REMOVED OWNER has no workspace authority", async () => {
  const ownerMembership = membershipFor(owner, {
    role: "OWNER",
    status: "REMOVED",
  });
  const auth = createFirmAuthorization(
    models({ memberAccess: "READ_ONLY", memberships: [ownerMembership] }),
  );
  const denial = { error: /no longer a member/i };
  assertDenied(await read(auth, owner), denial);
  assertDenied(await administer(auth, owner), denial);
  assertDenied(await write(auth, owner), denial);
  assertDenied(await isolatedWrite(auth, owner), denial);
});

await test("SUPER_ADMIN without membership can read, administer, and mutate READ_ONLY", async () => {
  const auth = createFirmAuthorization(models({ memberAccess: "READ_ONLY" }));
  assertAllowed(await read(auth, superAdmin));
  assertAllowed(await administer(auth, superAdmin));
  assertAllowed(await write(auth, superAdmin));
});

await test("SUPER_ADMIN bypasses REMOVED membership in active firm", async () => {
  const superMembership = membershipFor(superAdmin, { status: "REMOVED" });
  const auth = createFirmAuthorization(
    models({
      memberAccess: "READ_ONLY",
      memberships: [superMembership],
    }),
  );
  assertAllowed(await read(auth, superAdmin));
  assertAllowed(await administer(auth, superAdmin));
  assertAllowed(await write(auth, superAdmin));
});

await test("Foreign explicit PERSONAL firm denies ACTIVE MEMBER across all paths", async () => {
  const auth = createFirmAuthorization(
    models({ kind: "PERSONAL", memberships: [activeMember] }),
  );
  const denial = { status: 403, error: "Firm membership required" };

  assertDenied(await read(auth, member), denial);
  assertDenied(await administer(auth, member), denial);
  assertDenied(await write(auth, member), denial);
  assertDenied(await isolatedWrite(auth, member), denial);
});

await test("Foreign explicit PERSONAL firm denies ACTIVE ADMIN across all paths", async () => {
  const activeAdmin = membershipFor(member, { role: "ADMIN" });
  const auth = createFirmAuthorization(
    models({ kind: "PERSONAL", memberships: [activeAdmin] }),
  );
  const denial = { status: 403, error: "Firm membership required" };

  assertDenied(await read(auth, member), denial);
  assertDenied(await administer(auth, member), denial);
  assertDenied(await write(auth, member), denial);
  assertDenied(await isolatedWrite(auth, member), denial);
});

await test("Foreign explicit PERSONAL firm denies ACTIVE OWNER membership across all paths", async () => {
  const activeMembershipOwner = membershipFor(member, { role: "OWNER" });
  const auth = createFirmAuthorization(
    models({ kind: "PERSONAL", memberships: [activeMembershipOwner] }),
  );
  const denial = { status: 403, error: "Firm membership required" };

  assertDenied(await read(auth, member), denial);
  assertDenied(await administer(auth, member), denial);
  assertDenied(await write(auth, member), denial);
  assertDenied(await isolatedWrite(auth, member), denial);
});

await test("Actual owner with ACTIVE OWNER row can access explicit PERSONAL firm", async () => {
  const ownerMembership = membershipFor(owner, { role: "OWNER" });
  const auth = createFirmAuthorization(
    models({ kind: "PERSONAL", memberships: [ownerMembership] }),
  );

  assertAllowed(await read(auth, owner));
  assertAllowed(await administer(auth, owner));
  assertAllowed(await write(auth, owner));
  assertAllowed(await isolatedWrite(auth, owner));
});

await test("SUPER_ADMIN can access explicit PERSONAL firm across all paths", async () => {
  const auth = createFirmAuthorization(models({ kind: "PERSONAL" }));

  assertAllowed(await read(auth, superAdmin));
  assertAllowed(await administer(auth, superAdmin));
  assertAllowed(await write(auth, superAdmin));
  assertAllowed(await isolatedWrite(auth, superAdmin));
});

await test("REMOVED ordinary member cannot read", async () => {
  const auth = createFirmAuthorization(
    models({ memberships: [removedMember] }),
  );
  assertDenied(await read(auth, member), { error: /no longer a member/i });
});

await test("REMOVED ordinary member cannot mutate", async () => {
  const auth = createFirmAuthorization(
    models({ memberships: [removedMember] }),
  );
  assertDenied(await write(auth, member), { error: /no longer a member/i });
  assertDenied(await isolatedWrite(auth, member), {
    error: /no longer a member/i,
  });
});

await test("REMOVED ordinary member cannot administer", async () => {
  const auth = createFirmAuthorization(
    models({ memberships: [removedMember] }),
  );
  assertDenied(await administer(auth, member), {
    error: /no longer a member/i,
  });
});

await test("REMOVED stale global FIRM_ADMIN cannot read, mutate, or administer", async () => {
  const auth = createFirmAuthorization(
    models({ memberships: [removedMember] }),
  );
  assertDenied(await read(auth, staleGlobalAdmin), {
    error: /no longer a member/i,
  });
  assertDenied(await isolatedWrite(auth, staleGlobalAdmin), {
    error: /no longer a member/i,
  });
  assertDenied(await administer(auth, staleGlobalAdmin), {
    error: /no longer a member/i,
  });
});

for (const role of ["ADMIN", "OWNER"]) {
  await test(`REMOVED ${role} membership cannot elevate`, async () => {
    const removedElevatedMembership = membershipFor(member, {
      role,
      status: "REMOVED",
    });
    const auth = createFirmAuthorization(
      models({ memberships: [removedElevatedMembership] }),
    );
    assertDenied(await read(auth, member), { error: /no longer a member/i });
    assertDenied(await isolatedWrite(auth, member), {
      error: /no longer a member/i,
    });
    assertDenied(await administer(auth, member), {
      error: /no longer a member/i,
    });
  });
}

await test("Inactive firm denies ACTIVE MEMBER", async () => {
  const auth = createFirmAuthorization(
    models({ isActive: false, memberships: [activeMember] }),
  );
  assertDenied(await read(auth, member), { error: /inactive or unavailable/i });
  assertDenied(await isolatedWrite(auth, member), {
    error: /inactive or unavailable/i,
  });
});

await test("Inactive firm denies owner across read, write, and admin chains", async () => {
  const auth = createFirmAuthorization(models({ isActive: false }));
  assertDenied(await read(auth, owner), { error: /inactive or unavailable/i });
  assertDenied(await isolatedWrite(auth, owner), {
    error: /inactive or unavailable/i,
  });
  assertDenied(await administer(auth, owner), {
    error: /inactive or unavailable/i,
  });
});

await test("Inactive firm denies SUPER_ADMIN across read, write, and admin chains", async () => {
  const auth = createFirmAuthorization(models({ isActive: false }));
  assertDenied(await read(auth, superAdmin), {
    error: /inactive or unavailable/i,
  });
  assertDenied(await isolatedWrite(auth, superAdmin), {
    error: /inactive or unavailable/i,
  });
  assertDenied(await administer(auth, superAdmin), {
    error: /inactive or unavailable/i,
  });
});

await test("Mutation recheck denies membership removed after initial authorization", async () => {
  const auth = createFirmAuthorization(
    models({ membershipSequence: [activeMember, removedMember] }),
  );
  assertDenied(await write(auth, member), { error: /no longer a member/i });
});

await test("Mutation recheck denies firm deactivated after initial authorization", async () => {
  const auth = createFirmAuthorization(
    models({
      firmSequence: [
        {
          _id: FIRM_A,
          ownerUserId: OWNER_ID,
          isActive: true,
          memberAccess: "EDIT",
        },
        {
          _id: FIRM_A,
          ownerUserId: OWNER_ID,
          isActive: false,
          memberAccess: "EDIT",
        },
      ],
      memberships: [activeMember],
    }),
  );
  assertDenied(await write(auth, member), {
    error: /inactive or unavailable/i,
  });
});

await test("Mutation recheck applies downgraded firm role before READ_ONLY write", async () => {
  const activeAdmin = membershipFor(member, { role: "ADMIN" });
  const auth = createFirmAuthorization(
    models({
      memberAccess: "READ_ONLY",
      membershipSequence: [activeAdmin, activeMember],
    }),
  );
  assertDenied(await write(auth, member), { error: /read-only/i });
});

await test("Isolated mutation guard forwards lookup errors by exact identity", async () => {
  for (const errorOption of ["firmLookupError", "membershipLookupError"]) {
    const lookupError = { source: errorOption };
    const auth = createFirmAuthorization(
      models({ memberships: [activeMember], [errorOption]: lookupError }),
    );
    const outcome = await isolatedWrite(auth, member);
    assert.equal(outcome.nextError, lookupError);
    assert.equal(outcome.passed, false);
    assert.equal(outcome.status, null);
    assert.equal(outcome.body, null);
  }
});

await test("Non-mutating write-policy middleware remains a pass-through", async () => {
  const fake = models();
  const auth = createFirmAuthorization(fake);
  assertAllowed(await isolatedWrite(auth, null, "GET"));
  assert.equal(fake.state.firmLoads, 0);
  assert.equal(fake.state.membershipLoads, 0);
});

await test("Stats firm overview route requires firm-admin authority after its role guard", async () => {
  const source = await readFile(
    new URL("../src/routes/stats.routes.js", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /router\.get\(\s*"\/firm\/:firmId\/overview",\s*requireRoles\("FIRM_ADMIN",\s*"SUPER_ADMIN"\),\s*requireFirmAdmin,\s*getFirmOverviewStats\s*,?\s*\);/s,
  );
});

await test("Stats chase read route requires firm membership after its role guard", async () => {
  const source = await readFile(
    new URL("../src/routes/stats.routes.js", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /router\.get\(\s*"\/clients-to-chase-today",\s*requireRoles\("FIRM_ADMIN",\s*"USER",\s*"SUPER_ADMIN"\),\s*requireFirmMember,\s*getClientsToChaseToday\s*,?\s*\);/s,
  );
});

await test("Stats chase completion route rechecks membership then write access", async () => {
  const source = await readFile(
    new URL("../src/routes/stats.routes.js", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /router\.post\(\s*"\/clients-to-chase-today\/complete",\s*requireRoles\("FIRM_ADMIN",\s*"USER",\s*"SUPER_ADMIN"\),\s*requireFirmMember,\s*requireFirmWriteAccess,\s*postChaseComplete\s*,?\s*\);/s,
  );
});

await test("Production write routers order authentication, membership, then write policy", async () => {
  const expectedChain =
    /router\.use\(\s*authRequired(?:WithoutUsageTracking)?,\s*requireFirmMember,\s*requireFirmWriteAccess(?:,|\s*\))/s;

  for (const routeFile of WRITE_GUARD_ROUTES) {
    const source = await readFile(
      new URL(`../src/routes/${routeFile}`, import.meta.url),
      "utf8",
    );
    assert.match(
      source,
      expectedChain,
      `${routeFile} must keep the safe chain`,
    );
  }
});

await test("Rejection preserves response object shape", async () => {
  const auth = createFirmAuthorization(models());
  const outcome = await read(auth, member);
  assert.equal(outcome.status, 403);
  assert.deepEqual(outcome.body, {
    ok: false,
    error: "Firm membership required",
    requestId: "req-1",
  });
});

function controllerProjection(value, selection) {
  if (Array.isArray(value)) {
    return value.map((item) => controllerProjection(item, selection));
  }
  if (!value || typeof value !== "object" || !selection) {
    return structuredClone(value);
  }

  const fields = String(selection)
    .trim()
    .split(/\s+/)
    .filter((field) => field && !field.startsWith("-"));
  const projected = {};
  if (Object.hasOwn(value, "_id")) projected._id = value._id;
  for (const field of fields) {
    if (Object.hasOwn(value, field)) projected[field] = value[field];
  }
  return projected;
}

function controllerQuery(load) {
  let selection = "";
  let sortSpec = null;
  const resolve = async () => {
    const loaded = await load();
    const value = Array.isArray(loaded) ? [...loaded] : loaded;
    if (Array.isArray(value) && sortSpec) {
      for (const [field, direction] of Object.entries(sortSpec).reverse()) {
        value.sort((left, right) => {
          if (left[field] === right[field]) return 0;
          return left[field] < right[field] ? -direction : direction;
        });
      }
    }
    return controllerProjection(value, selection);
  };
  const api = {
    select(fields) {
      selection = String(fields || "");
      return api;
    },
    sort(spec) {
      sortSpec = spec;
      return api;
    },
    lean: resolve,
    then(onFulfilled, onRejected) {
      return resolve().then(onFulfilled, onRejected);
    },
  };
  return api;
}

async function withControllerPatches(patches, action) {
  const originals = patches.map(([target, key]) => [target, key, target[key]]);
  for (const [target, key, replacement] of patches) target[key] = replacement;
  try {
    return await action();
  } finally {
    for (const [target, key, original] of originals.reverse()) {
      target[key] = original;
    }
  }
}

async function invokeController(handler, req) {
  const outcome = { statusCode: 200, body: null, nextError: null };
  const res = {
    status(statusCode) {
      outcome.statusCode = statusCode;
      return res;
    },
    json(body) {
      outcome.body = body;
      return res;
    },
  };
  await handler(req, res, (error) => {
    outcome.nextError = error;
  });
  return outcome;
}

const { default: ControllerFirm } = await import("../src/models/Firm.js");
const { default: ControllerMembership } =
  await import("../src/models/FirmMembership.js");
const { default: ControllerUser } = await import("../src/models/User.js");
const { default: ControllerReminder } =
  await import("../src/models/Reminder.js");
const { default: ControllerTask } = await import("../src/models/Task.js");
const { getFirmOverviewStats } =
  await import("../src/controllers/stats.controller.js");
const { listFirms, listFirmUsersForSuper, updateFirmPlan } =
  await import("../src/controllers/super.controller.js");

const controllerSuper = {
  id: "super-user",
  role: "SUPER_ADMIN",
  email: "saifullahfaizan786@gmail.com",
};

await test("Super firm user list follows ACTIVE memberships, preserves order, and redacts PERSONAL code", async () => {
  const firmId = "firm-personal";
  const firm = {
    _id: firmId,
    ownerUserId: "owner-user",
    displayName: "Personal",
    kind: "PERSONAL",
    joinCode: "PERSON1",
    createdAt: "2025-01-01T00:00:00.000Z",
  };
  const users = [
    {
      _id: "owner-user",
      email: "owner@example.test",
      name: "Owner",
      firmId,
      role: "FIRM_ADMIN",
      accountType: "FIRM_USER",
      isActive: true,
      createdAt: "2026-01-03T00:00:00.000Z",
    },
    {
      _id: "active-elsewhere",
      email: "elsewhere@example.test",
      name: "Elsewhere",
      firmId: "different-workspace",
      role: "USER",
      accountType: "FIRM_USER",
      isActive: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      _id: "suspended-user",
      email: "suspended@example.test",
      name: "Suspended",
      firmId,
      role: "USER",
      accountType: "FIRM_USER",
      isActive: false,
      createdAt: "2026-01-02T00:00:00.000Z",
    },
    {
      _id: "removed-user",
      email: "removed@example.test",
      name: "Removed",
      firmId,
      role: "USER",
      accountType: "FIRM_USER",
      isActive: true,
      createdAt: "2026-01-04T00:00:00.000Z",
    },
    {
      _id: "no-membership-user",
      email: "stale@example.test",
      name: "Stale Pointer",
      firmId,
      role: "USER",
      accountType: "FIRM_USER",
      isActive: true,
      createdAt: "2026-01-05T00:00:00.000Z",
    },
  ];
  const memberships = [
    {
      _id: "membership-owner",
      firmId,
      userId: "owner-user",
      status: "ACTIVE",
    },
    {
      _id: "membership-elsewhere",
      firmId,
      userId: "active-elsewhere",
      status: "ACTIVE",
    },
    {
      _id: "membership-suspended",
      firmId,
      userId: "suspended-user",
      status: "ACTIVE",
    },
    {
      _id: "membership-removed",
      firmId,
      userId: "removed-user",
      status: "REMOVED",
    },
  ];
  const activeUserIds = ["owner-user", "active-elsewhere", "suspended-user"];
  const sourceFirm = structuredClone(firm);

  const outcome = await withControllerPatches(
    [
      [
        ControllerFirm,
        "findById",
        (value) =>
          controllerQuery(() =>
            String(value) === firmId ? structuredClone(firm) : null,
          ),
      ],
      [
        ControllerMembership,
        "find",
        (filter) => {
          assert.deepEqual(filter, { firmId, status: "ACTIVE" });
          return controllerQuery(() =>
            memberships.filter(
              (membership) =>
                membership.firmId === firmId && membership.status === "ACTIVE",
            ),
          );
        },
      ],
      [
        ControllerUser,
        "find",
        (filter) => {
          assert.deepEqual(filter, { _id: { $in: activeUserIds } });
          const selected = new Set(filter._id.$in.map(String));
          return controllerQuery(() =>
            users.filter((user) => selected.has(String(user._id))),
          );
        },
      ],
    ],
    () =>
      invokeController(listFirmUsersForSuper, {
        user: controllerSuper,
        params: { firmId },
      }),
  );

  assert.equal(outcome.nextError, null);
  assert.equal(outcome.statusCode, 200);
  const expectedFirm = structuredClone(firm);
  delete expectedFirm.joinCode;
  assert.deepEqual(outcome.body.firm, expectedFirm);
  assert.deepEqual(
    outcome.body.users.map((user) => user._id),
    ["active-elsewhere", "suspended-user", "owner-user"],
  );
  assert.deepEqual(
    outcome.body.users.map((user) => Object.keys(user)),
    [
      ["_id", "email", "name", "role", "accountType", "isActive", "createdAt"],
      ["_id", "email", "name", "role", "accountType", "isActive", "createdAt"],
      ["_id", "email", "name", "role", "accountType", "isActive", "createdAt"],
    ],
  );
  assert.deepEqual(firm, sourceFirm);
});

await test("Super firm list redacts PERSONAL and legacy codes but preserves SHARED code", async () => {
  const firms = [
    {
      _id: "firm-personal",
      ownerUserId: "owner-personal",
      displayName: "Personal",
      kind: "PERSONAL",
      joinCode: "PERSON1",
      createdAt: "2026-01-03T00:00:00.000Z",
    },
    {
      _id: "firm-shared",
      ownerUserId: "owner-shared",
      displayName: "Shared",
      kind: "SHARED",
      joinCode: "SHARED1",
      createdAt: "2026-01-02T00:00:00.000Z",
    },
    {
      _id: "firm-legacy",
      ownerUserId: "owner-legacy",
      displayName: "Legacy",
      joinCode: "LEGACY1",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ];
  const owners = firms.map((firm) => ({
    _id: firm.ownerUserId,
    email: `${firm.ownerUserId}@example.test`,
    name: firm.ownerUserId,
    role: "FIRM_ADMIN",
    isActive: true,
    firmId: firm._id,
  }));
  const sourceFirms = structuredClone(firms);

  const outcome = await withControllerPatches(
    [
      [ControllerFirm, "find", () => controllerQuery(() => firms)],
      [
        ControllerUser,
        "find",
        (filter) => {
          assert.deepEqual(filter, {
            _id: { $in: firms.map((firm) => firm.ownerUserId) },
          });
          return controllerQuery(() => owners);
        },
      ],
    ],
    () => invokeController(listFirms, { user: controllerSuper, query: {} }),
  );

  assert.equal(outcome.nextError, null);
  const byId = new Map(
    outcome.body.firms.map((firm) => [String(firm._id), firm]),
  );
  assert.equal(Object.hasOwn(byId.get("firm-personal"), "joinCode"), false);
  assert.equal(byId.get("firm-shared").joinCode, "SHARED1");
  assert.equal(Object.hasOwn(byId.get("firm-legacy"), "joinCode"), false);
  assert.deepEqual(firms, sourceFirms);
});

await test("Super PERSONAL plan response omits code without deleting stored value", async () => {
  const storedFirm = {
    _id: "firm-personal",
    ownerUserId: "owner-personal",
    displayName: "Personal",
    kind: "PERSONAL",
    joinCode: "PERSON1",
    planType: "LEGACY",
    planExpiry: "2026-12-31T00:00:00.000Z",
    isActive: true,
    async save() {},
    toObject() {
      return {
        _id: this._id,
        ownerUserId: this.ownerUserId,
        displayName: this.displayName,
        kind: this.kind,
        joinCode: this.joinCode,
        planType: this.planType,
        planExpiry: this.planExpiry,
        isActive: this.isActive,
      };
    },
  };

  const outcome = await withControllerPatches(
    [[ControllerFirm, "findById", async () => storedFirm]],
    () =>
      invokeController(updateFirmPlan, {
        user: controllerSuper,
        params: { firmId: storedFirm._id },
        body: {},
      }),
  );

  assert.equal(outcome.nextError, null);
  assert.equal(Object.hasOwn(outcome.body.firm, "joinCode"), false);
  assert.equal(storedFirm.joinCode, "PERSON1");
  assert.equal(outcome.body.firm.planType, "FREE");
  assert.equal(outcome.body.firm.planExpiry, null);
});

await test("Firm overview counts active accounts from ACTIVE memberships", async () => {
  const firmId = "firm-a";
  const memberships = [
    { _id: "m-owner", firmId, userId: "owner-user", status: "ACTIVE" },
    {
      _id: "m-elsewhere",
      firmId,
      userId: "active-elsewhere",
      status: "ACTIVE",
    },
    {
      _id: "m-inactive",
      firmId,
      userId: "inactive-account",
      status: "ACTIVE",
    },
    { _id: "m-removed", firmId, userId: "removed-user", status: "REMOVED" },
  ];
  const users = [
    { _id: "owner-user", firmId, isActive: true },
    {
      _id: "active-elsewhere",
      firmId: "different-workspace",
      isActive: true,
    },
    { _id: "inactive-account", firmId, isActive: false },
    { _id: "removed-user", firmId, isActive: true },
    { _id: "stale-pointer", firmId, isActive: true },
  ];
  const activeMembershipUserIds = [
    "owner-user",
    "active-elsewhere",
    "inactive-account",
  ];

  const outcome = await withControllerPatches(
    [
      [
        ControllerMembership,
        "find",
        (filter) => {
          assert.deepEqual(filter, { firmId, status: "ACTIVE" });
          return controllerQuery(() =>
            memberships.filter((membership) => membership.status === "ACTIVE"),
          );
        },
      ],
      [
        ControllerUser,
        "countDocuments",
        async (filter) => {
          assert.deepEqual(filter, {
            _id: { $in: activeMembershipUserIds },
            isActive: true,
          });
          const included = new Set(filter._id.$in.map(String));
          return users.filter(
            (user) => included.has(String(user._id)) && user.isActive === true,
          ).length;
        },
      ],
      [
        ControllerReminder,
        "countDocuments",
        async (filter) => {
          assert.deepEqual(filter, { firmId });
          return 3;
        },
      ],
      [
        ControllerTask,
        "countDocuments",
        async (filter) => {
          assert.deepEqual(filter, { firmId, isActive: true });
          return 4;
        },
      ],
    ],
    () =>
      invokeController(getFirmOverviewStats, {
        user: { id: "owner-user", role: "FIRM_ADMIN", firmId },
        params: { firmId },
      }),
  );

  assert.equal(outcome.nextError, null);
  assert.deepEqual(outcome.body, {
    ok: true,
    stats: {
      userCount: 2,
      taskCount: 4,
      reminderCount: 3,
      scanCount: 0,
    },
  });
});

const failures = results.filter((item) => !item.pass);
const passed = results.length - failures.length;
console.log(
  `\nResult: ${passed} passed, ${failures.length} failed, ${results.length} total`,
);
process.exitCode = failures.length === 0 ? 0 : 1;
