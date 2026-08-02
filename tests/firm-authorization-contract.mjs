import assert from "node:assert/strict";
import { createFirmAuthorization } from "../src/middleware/authorization.middleware.js";

// Authority matrix for firm-scoped requests. The case that matters most is a
// member removed from a firm while User.firmId still points at it: the request
// must be refused even though the account, token, and firm are all valid.

const FIRM_A = "firm-a";
const OWNER_ID = "user-owner";

function query(load) {
  const api = {
    select: () => api,
    lean: async () => load(),
    then: (onFulfilled, onRejected) =>
      Promise.resolve(load()).then(onFulfilled, onRejected),
  };
  return api;
}

function models({ memberAccess = "EDIT", isActive = true, memberships = [] }) {
  return {
    FirmModel: {
      findOne: (filter) =>
        query(() => {
          if (String(filter._id) !== FIRM_A) return null;
          if (filter.isActive === true && !isActive) return null;
          return { _id: FIRM_A, ownerUserId: OWNER_ID, memberAccess };
        }),
    },
    MembershipModel: {
      findOne: (filter) =>
        query(
          () =>
            memberships.find(
              (item) =>
                item.userId === String(filter.userId) &&
                item.firmId === String(filter.firmId),
            ) || null,
        ),
    },
  };
}

async function run(guard, { user, method = "GET" }) {
  const outcome = { status: null, body: null, passed: false, error: null };
  const res = {
    status(code) {
      outcome.status = code;
      return res;
    },
    json(body) {
      outcome.body = body;
      return res;
    },
  };
  await guard({ user, method, id: "req-1" }, res, (error) => {
    if (error) outcome.error = error;
    else outcome.passed = true;
  });
  return outcome;
}

const cases = [];
async function test(name, action) {
  try {
    await action();
    cases.push({ name, pass: true });
    console.log(`[PASS] ${name}`);
  } catch (error) {
    cases.push({ name, pass: false });
    console.error(`[FAIL] ${name}: ${error.stack || error.message}`);
  }
}

const member = { id: "user-member", role: "USER", firmId: FIRM_A };
const staleAdmin = { id: "user-member", role: "FIRM_ADMIN", firmId: FIRM_A };
const owner = { id: OWNER_ID, role: "FIRM_ADMIN", firmId: FIRM_A };
const superAdmin = { id: "user-super", role: "SUPER_ADMIN", firmId: FIRM_A };

const activeMember = {
  userId: "user-member",
  firmId: FIRM_A,
  role: "MEMBER",
  status: "ACTIVE",
};
const removedMember = { ...activeMember, status: "REMOVED" };

await test("an active member reads firm data", async () => {
  const auth = createFirmAuthorization(models({ memberships: [activeMember] }));
  const outcome = await run(auth.requireFirmMember, { user: member });
  assert.equal(outcome.passed, true);
  assert.equal(outcome.status, null);
});

await test("a removed member is refused even while firmId still points at the firm", async () => {
  const auth = createFirmAuthorization(
    models({ memberships: [removedMember] }),
  );

  const read = await run(auth.requireFirmMember, { user: member });
  assert.equal(read.passed, false);
  assert.equal(read.status, 403);
  assert.match(read.body.error, /no longer a member/i);

  const write = await run(auth.requireFirmWriteAccess, {
    user: member,
    method: "POST",
  });
  assert.equal(write.passed, false);
  assert.equal(write.status, 403);

  const admin = await run(auth.requireFirmAdmin, { user: member });
  assert.equal(admin.passed, false);
  assert.equal(admin.status, 403);
});

await test("a removed member cannot regain write access with a stale FIRM_ADMIN role", async () => {
  const auth = createFirmAuthorization(
    models({ memberships: [removedMember] }),
  );

  const write = await run(auth.requireFirmWriteAccess, {
    user: staleAdmin,
    method: "POST",
  });

  assert.equal(write.passed, false);
  assert.equal(write.status, 403);
  assert.match(write.body.error, /no longer a member/i);
});

await test("a stale FIRM_ADMIN role does not grant admin authority to a plain member", async () => {
  const auth = createFirmAuthorization(models({ memberships: [activeMember] }));

  const outcome = await run(auth.requireFirmAdmin, { user: staleAdmin });

  assert.equal(outcome.passed, false);
  assert.equal(outcome.status, 403);
  assert.equal(outcome.body.error, "Firm admin only");
});

await test("an ADMIN membership grants admin authority without a global role", async () => {
  const auth = createFirmAuthorization(
    models({ memberships: [{ ...activeMember, role: "ADMIN" }] }),
  );

  const outcome = await run(auth.requireFirmAdmin, { user: member });

  assert.equal(outcome.passed, true);
});

await test("the firm owner keeps admin authority", async () => {
  const auth = createFirmAuthorization(models({ memberships: [] }));
  const outcome = await run(auth.requireFirmAdmin, { user: owner });
  assert.equal(outcome.passed, true);
});

await test("a legacy account without a membership document is not locked out", async () => {
  const auth = createFirmAuthorization(models({ memberships: [] }));

  const read = await run(auth.requireFirmMember, { user: member });
  assert.equal(read.passed, true);

  const admin = await run(auth.requireFirmAdmin, { user: staleAdmin });
  assert.equal(admin.passed, true);
});

await test("a read-only member cannot write but can still read", async () => {
  const auth = createFirmAuthorization(
    models({ memberAccess: "READ_ONLY", memberships: [activeMember] }),
  );

  const read = await run(auth.requireFirmMember, { user: member });
  assert.equal(read.passed, true);

  const write = await run(auth.requireFirmWriteAccess, {
    user: member,
    method: "POST",
  });
  assert.equal(write.passed, false);
  assert.equal(write.status, 403);
  assert.match(write.body.error, /read-only/i);
});

await test("a stale FIRM_ADMIN role cannot write in a read-only workspace", async () => {
  const auth = createFirmAuthorization(
    models({ memberAccess: "READ_ONLY", memberships: [activeMember] }),
  );

  const write = await run(auth.requireFirmWriteAccess, {
    user: staleAdmin,
    method: "POST",
  });

  assert.equal(write.passed, false);
  assert.equal(write.status, 403);
  assert.match(write.body.error, /read-only/i);
});

await test("an ADMIN membership may write in a read-only workspace", async () => {
  const auth = createFirmAuthorization(
    models({
      memberAccess: "READ_ONLY",
      memberships: [{ ...activeMember, role: "ADMIN" }],
    }),
  );

  const write = await run(auth.requireFirmWriteAccess, {
    user: member,
    method: "POST",
  });

  assert.equal(write.passed, true);
});

await test("a legacy account keeps write access in a read-only workspace", async () => {
  const auth = createFirmAuthorization(
    models({ memberAccess: "READ_ONLY", memberships: [] }),
  );

  const write = await run(auth.requireFirmWriteAccess, {
    user: staleAdmin,
    method: "POST",
  });

  assert.equal(write.passed, true);
});

await test("a user with no active workspace is refused", async () => {
  const auth = createFirmAuthorization(models({ memberships: [] }));
  const outcome = await run(auth.requireFirmMember, {
    user: { id: "user-member", role: "USER", firmId: null },
  });
  assert.equal(outcome.passed, false);
  assert.equal(outcome.status, 403);
  assert.equal(outcome.body.error, "Firm membership required");
});

await test("an unauthenticated request is refused before any lookup", async () => {
  const auth = createFirmAuthorization(models({ memberships: [] }));
  const outcome = await run(auth.requireFirmMember, { user: null });
  assert.equal(outcome.passed, false);
  assert.equal(outcome.status, 401);
});

await test("an inactive firm is refused", async () => {
  const auth = createFirmAuthorization(
    models({ isActive: false, memberships: [activeMember] }),
  );
  const outcome = await run(auth.requireFirmMember, { user: member });
  assert.equal(outcome.passed, false);
  assert.equal(outcome.status, 403);
  assert.match(outcome.body.error, /inactive or unavailable/i);
});

await test("super admin retains platform access to a firm", async () => {
  const auth = createFirmAuthorization(models({ memberships: [] }));
  const outcome = await run(auth.requireFirmAdmin, { user: superAdmin });
  assert.equal(outcome.passed, true);
});

const failures = cases.filter((item) => !item.pass);
console.log(
  `\nResult: ${cases.length - failures.length} passed, ${failures.length} failed`,
);
process.exitCode = failures.length === 0 ? 0 : 1;
