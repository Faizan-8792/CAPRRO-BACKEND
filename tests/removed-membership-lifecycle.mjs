import assert from "node:assert/strict";
import mongoose from "mongoose";
import Firm from "../src/models/Firm.js";
import FirmMembership from "../src/models/FirmMembership.js";
import User from "../src/models/User.js";
import WorkspaceOperation from "../src/models/WorkspaceOperation.js";
import {
  ensureFirmMembership,
  ensurePersonalFirm,
} from "../src/services/firm-provisioning.service.js";
import {
  deleteFirmUser,
  getFirmById,
  getMyFirm,
  joinFirmByCode,
  leaveFirm,
  listWorkspaces,
  switchWorkspace,
} from "../src/controllers/firm.controller.js";

const clone = (value) => structuredClone(value);
const id = (value) => String(value ?? "");

function membershipKey(firmId, userId) {
  return `${id(firmId)}:${id(userId)}`;
}

function mapFrom(items) {
  return new Map(items.map((item) => [id(item._id), clone(item)]));
}

function createState({
  users = [],
  firms = [],
  memberships = [],
  operations = [],
}) {
  return {
    users: mapFrom(users),
    firms: mapFrom(firms),
    memberships: new Map(
      memberships.map((item) => [
        membershipKey(item.firmId, item.userId),
        clone(item),
      ]),
    ),
    operations: mapFrom(operations),
  };
}

function snapshotState(state) {
  const sorted = (values) =>
    [...values]
      .map((value) => clone(value))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return {
    users: sorted(state.users.values()),
    firms: sorted(state.firms.values()),
    memberships: sorted(state.memberships.values()),
    operations: sorted(state.operations.values()),
  };
}

function restoreState(state, snapshot) {
  state.users = mapFrom(snapshot.users);
  state.firms = mapFrom(snapshot.firms);
  state.memberships = new Map(
    snapshot.memberships.map((item) => [
      membershipKey(item.firmId, item.userId),
      clone(item),
    ]),
  );
  state.operations = mapFrom(snapshot.operations);
}

function matches(value, expected, fieldExists = true) {
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    if ("$exists" in expected) {
      if (fieldExists !== Boolean(expected.$exists)) return false;
      if (Object.keys(expected).length === 1) return true;
    }
    if ("$ne" in expected) return id(value) !== id(expected.$ne);
    if ("$in" in expected) {
      return expected.$in.some((candidate) => id(candidate) === id(value));
    }
  }
  return id(value) === id(expected);
}

function matchesFilter(value, filter) {
  return Object.entries(filter || {}).every(([field, expected]) =>
    matches(value[field], expected, Object.hasOwn(value, field)),
  );
}

function projectSelected(value, selection) {
  if (!value || !selection) return value;
  if (Array.isArray(value)) {
    return value.map((item) => projectSelected(item, selection));
  }
  if (typeof value !== "object") return value;

  const fields = String(selection).trim().split(/\s+/).filter(Boolean);
  const included = fields.filter((field) => !field.startsWith("-"));
  const excluded = new Set(
    fields
      .filter((field) => field.startsWith("-"))
      .map((field) => field.slice(1)),
  );
  const projected = {};

  if (included.length > 0) {
    if (Object.hasOwn(value, "_id") && !excluded.has("_id")) {
      projected._id = value._id;
    }
    for (const field of included) {
      if (Object.hasOwn(value, field)) projected[field] = value[field];
    }
  } else {
    for (const [field, fieldValue] of Object.entries(value)) {
      if (!excluded.has(field)) projected[field] = fieldValue;
    }
  }

  const saveDescriptor = Object.getOwnPropertyDescriptor(value, "save");
  if (saveDescriptor) Object.defineProperty(projected, "save", saveDescriptor);
  return projected;
}

function shouldFailRead(failure, event) {
  if (!failure) return false;
  const candidates = Array.isArray(failure) ? failure : [failure];
  return candidates.some((candidate) => {
    if (typeof candidate === "string") return candidate === event.label;
    return (
      candidate?.label === event.label &&
      (candidate.occurrence === undefined ||
        candidate.occurrence === event.occurrence) &&
      (candidate.phase === undefined || candidate.phase === event.phase)
    );
  });
}

function query(harness, label, load) {
  let suppliedSession = null;
  let selection = "";
  let sortSpec = null;

  async function resolve() {
    const occurrence = (harness.readCounts.get(label) || 0) + 1;
    harness.readCounts.set(label, occurrence);
    const phase = harness.transactionOpen
      ? "transaction"
      : harness.transactionCommits > 0
        ? "post-commit"
        : harness.transactionRollbacks > 0
          ? "post-rollback"
          : "outside";
    const event = {
      type: "read",
      label,
      session: suppliedSession,
      phase,
      occurrence,
      failed: false,
    };
    harness.readEvents.push(event);
    if (harness.transactionOpen) harness.sessionEvents.push(event);
    if (shouldFailRead(harness.failOnRead, event)) {
      event.failed = true;
      throw new Error(`Injected read failure at ${label}`);
    }

    const loaded = await load();
    if (Array.isArray(loaded) && sortSpec) {
      const fields = Object.entries(sortSpec);
      loaded.sort((left, right) => {
        for (const [field, direction] of fields) {
          if (left[field] === right[field]) continue;
          return left[field] < right[field] ? -direction : direction;
        }
        return 0;
      });
    }
    return projectSelected(loaded, selection);
  }

  const api = {
    session(session) {
      suppliedSession = session;
      return api;
    },
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

function documentFor(harness, collectionName, key, value, label) {
  if (!value) return null;
  const document = clone(value);
  // Mongoose applies the Firm.kind default during hydration. Keep persisted
  // filter matching against raw state above, then mirror that runtime behavior
  // so a property-only SHARED check cannot hide missing-kind ambiguity.
  if (collectionName === "firms" && document.kind === undefined) {
    document.kind = "SHARED";
  }
  Object.defineProperty(document, "save", {
    enumerable: false,
    value: async (options = {}) => {
      if (harness.transactionOpen) {
        harness.sessionEvents.push({
          type: "write",
          label,
          session: options.session || null,
        });
      }
      if (harness.failOnWrite === label) {
        throw new Error(`Injected failure at ${label}`);
      }
      harness.state[collectionName].set(key, clone(document));
      return document;
    },
  });
  return document;
}

function createHarness(
  seed,
  { failOnWrite = null, failOnRead = null, existsResults = [] } = {},
) {
  const harness = {
    state: createState(seed),
    failOnWrite,
    failOnRead,
    existsResults: [...existsResults],
    transactionOpen: false,
    sessionEvents: [],
    readEvents: [],
    readCounts: new Map(),
    firmCreates: 0,
    sessionStarts: 0,
    transactionRuns: 0,
    transactionCommits: 0,
    transactionRollbacks: 0,
    sessionEnds: 0,
    transactionOptions: null,
    lastSession: null,
  };

  harness.findFirm = (filter) => {
    const value = [...harness.state.firms.values()].find((item) =>
      matchesFilter(item, filter),
    );
    return value
      ? documentFor(harness, "firms", id(value._id), value, "Firm.save")
      : null;
  };

  harness.findUser = (filter) => {
    const value = [...harness.state.users.values()].find((item) =>
      matchesFilter(item, filter),
    );
    return value
      ? documentFor(harness, "users", id(value._id), value, "User.save")
      : null;
  };

  harness.findMembership = (filter) => {
    const value = [...harness.state.memberships.values()].find((item) =>
      matchesFilter(item, filter),
    );
    return value
      ? documentFor(
          harness,
          "memberships",
          membershipKey(value.firmId, value.userId),
          value,
          "FirmMembership.save",
        )
      : null;
  };

  harness.startSession = async () => {
    harness.sessionStarts += 1;
    const session = {
      async withTransaction(action, options) {
        harness.transactionRuns += 1;
        harness.transactionOptions = clone(options);
        const before = snapshotState(harness.state);
        harness.transactionOpen = true;
        try {
          const result = await action();
          harness.transactionCommits += 1;
          return result;
        } catch (error) {
          restoreState(harness.state, before);
          harness.transactionRollbacks += 1;
          throw error;
        } finally {
          harness.transactionOpen = false;
        }
      },
      async endSession() {
        harness.sessionEnds += 1;
      },
    };
    harness.lastSession = session;
    return session;
  };

  return harness;
}

let activeHarness = null;
const restorations = [];

function patch(target, key, replacement) {
  const original = target[key];
  target[key] = replacement;
  restorations.push(() => {
    target[key] = original;
  });
}

patch(mongoose, "startSession", (...args) =>
  activeHarness.startSession(...args),
);
patch(Firm, "findById", (firmId) =>
  query(activeHarness, "Firm.findById", () =>
    activeHarness.findFirm({ _id: firmId }),
  ),
);
patch(Firm, "findOne", (filter) =>
  query(activeHarness, "Firm.findOne", () => activeHarness.findFirm(filter)),
);
patch(Firm, "create", async (value) => {
  activeHarness.firmCreates += 1;
  const created = {
    ...clone(value),
    _id: `created-firm-${activeHarness.firmCreates}`,
  };
  activeHarness.state.firms.set(id(created._id), created);
  return activeHarness.findFirm({ _id: created._id });
});
patch(FirmMembership, "findOne", (filter) =>
  query(activeHarness, "FirmMembership.findOne", () =>
    activeHarness.findMembership(filter),
  ),
);
patch(FirmMembership, "exists", (filter) =>
  query(activeHarness, "FirmMembership.exists", () => {
    if (activeHarness.existsResults.length > 0) {
      return activeHarness.existsResults.shift();
    }
    const membership = activeHarness.findMembership(filter);
    return membership ? { _id: membership._id } : null;
  }),
);
patch(FirmMembership, "countDocuments", (filter) =>
  query(
    activeHarness,
    "FirmMembership.countDocuments",
    () =>
      [...activeHarness.state.memberships.values()].filter((item) =>
        matchesFilter(item, filter),
      ).length,
  ),
);
patch(FirmMembership, "find", (filter) =>
  query(activeHarness, "FirmMembership.find", () =>
    [...activeHarness.state.memberships.values()]
      .filter((item) => matchesFilter(item, filter))
      .map((item) => clone(item)),
  ),
);
patch(FirmMembership, "create", async (value, options = {}) => {
  const isBatch = Array.isArray(value);
  const values = isBatch ? value : [value];
  if (activeHarness.transactionOpen) {
    activeHarness.sessionEvents.push({
      type: "write",
      label: "FirmMembership.create",
      session: options.session || null,
    });
  }
  if (activeHarness.failOnWrite === "FirmMembership.create") {
    throw new Error("Injected failure at FirmMembership.create");
  }
  const created = values.map((item, index) => {
    const membership = {
      ...clone(item),
      _id:
        item._id ||
        `created-membership-${activeHarness.state.memberships.size + index + 1}`,
    };
    activeHarness.state.memberships.set(
      membershipKey(membership.firmId, membership.userId),
      membership,
    );
    return activeHarness.findMembership({
      firmId: membership.firmId,
      userId: membership.userId,
    });
  });
  return isBatch ? created : created[0];
});
patch(WorkspaceOperation, "create", async (value) => {
  const duplicate = [...activeHarness.state.operations.values()].some(
    (operation) =>
      id(operation.userId) === id(value.userId) &&
      operation.operationId === value.operationId,
  );
  if (duplicate) {
    const error = new Error("Duplicate workspace operation");
    error.code = 11000;
    throw error;
  }
  const created = {
    ...clone(value),
    _id: `workspace-operation-${activeHarness.state.operations.size + 1}`,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };
  activeHarness.state.operations.set(id(created._id), created);
  return documentFor(
    activeHarness,
    "operations",
    id(created._id),
    created,
    "WorkspaceOperation.save",
  );
});
patch(WorkspaceOperation, "findOne", (filter) =>
  query(activeHarness, "WorkspaceOperation.findOne", () => {
    const value = [...activeHarness.state.operations.values()].find((item) =>
      matchesFilter(item, filter),
    );
    return value
      ? documentFor(
          activeHarness,
          "operations",
          id(value._id),
          value,
          "WorkspaceOperation.save",
        )
      : null;
  }),
);
patch(WorkspaceOperation, "updateOne", async (filter, update, options = {}) => {
  const phase = activeHarness.transactionOpen
    ? "transaction"
    : activeHarness.transactionRollbacks > 0
      ? "post-rollback"
      : activeHarness.transactionCommits > 0
        ? "post-commit"
        : "outside";
  const event = {
    type: "write",
    label: "WorkspaceOperation.updateOne",
    session: options.session || null,
    phase,
    failed: false,
  };
  if (activeHarness.transactionOpen) {
    activeHarness.sessionEvents.push(event);
  }
  const failure = activeHarness.failOnWrite;
  if (
    failure === "WorkspaceOperation.updateOne" ||
    (failure?.label === "WorkspaceOperation.updateOne" &&
      (failure.phase === undefined || failure.phase === phase))
  ) {
    event.failed = true;
    throw new Error("Injected failure at WorkspaceOperation.updateOne");
  }
  const entry = [...activeHarness.state.operations.entries()].find(([, item]) =>
    matchesFilter(item, filter),
  );
  if (!entry) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
  const [operationId, operation] = entry;
  Object.assign(operation, clone(update.$set || {}));
  activeHarness.state.operations.set(operationId, operation);
  return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
});
patch(User, "findById", (userId) =>
  query(activeHarness, "User.findById", () =>
    activeHarness.findUser({ _id: userId }),
  ),
);
patch(User, "findOneAndUpdate", async (filter, update, options = {}) => {
  if (activeHarness.transactionOpen) {
    activeHarness.sessionEvents.push({
      type: "write",
      label: "User.findOneAndUpdate",
      session: options.session || null,
    });
  }
  if (activeHarness.failOnWrite === "User.findOneAndUpdate") {
    throw new Error("Injected failure at User.findOneAndUpdate");
  }
  const entry = [...activeHarness.state.users.entries()].find(([, item]) =>
    matchesFilter(item, filter),
  );
  if (!entry) return null;

  const [userId, source] = entry;
  const updated = clone(source);
  Object.assign(updated, clone(update.$set || {}));
  for (const [field, push] of Object.entries(update.$push || {})) {
    const values = Array.isArray(push?.$each)
      ? clone(push.$each)
      : [clone(push)];
    let next = [
      ...(Array.isArray(updated[field]) ? updated[field] : []),
      ...values,
    ];
    if (Number.isInteger(push?.$slice)) {
      next =
        push.$slice < 0 ? next.slice(push.$slice) : next.slice(0, push.$slice);
    }
    updated[field] = next;
  }
  activeHarness.state.users.set(userId, updated);
  return activeHarness.findUser({ _id: userId });
});
patch(User, "find", (filter) =>
  query(activeHarness, "User.find", () =>
    [...activeHarness.state.users.values()]
      .filter((item) => matchesFilter(item, filter))
      .map((item) => clone(item)),
  ),
);

function sharedHealingSeed(role) {
  const userId = "user-a";
  const personalFirmId = "firm-personal";
  const sharedFirmId = "firm-shared";
  return {
    userId,
    personalFirmId,
    sharedFirmId,
    seed: {
      users: [
        {
          _id: userId,
          email: "user@example.test",
          name: "User",
          firmId: sharedFirmId,
          personalFirmId,
          role: "FIRM_ADMIN",
          accountType: "FIRM_USER",
          isActive: true,
          tokenVersion: 2,
        },
      ],
      firms: [
        {
          _id: personalFirmId,
          ownerUserId: userId,
          displayName: "Personal",
          handle: "personal",
          kind: "PERSONAL",
          isActive: true,
        },
        {
          _id: sharedFirmId,
          ownerUserId: role === "OWNER" ? userId : "owner-user",
          displayName: "Shared",
          handle: "shared",
          kind: "SHARED",
          isActive: true,
          sharingEnabled: true,
        },
      ],
      memberships: [
        {
          _id: "membership-personal",
          userId,
          firmId: personalFirmId,
          role: "OWNER",
          status: "REMOVED",
          isPersonal: true,
        },
        {
          _id: "membership-shared",
          userId,
          firmId: sharedFirmId,
          role,
          status: "REMOVED",
          isPersonal: false,
        },
      ],
    },
  };
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

async function invoke(handler, req) {
  const res = responseRecorder();
  let nextError = null;
  await handler(req, res, (error) => {
    nextError = error;
  });
  if (nextError) throw nextError;
  return res;
}

function assertTransactionDiscipline(harness) {
  assert.equal(harness.sessionStarts, 1);
  assert.equal(harness.transactionRuns, 1);
  assert.equal(harness.sessionEnds, 1);
  assert.deepEqual(harness.transactionOptions, {
    readConcern: { level: "snapshot" },
    writeConcern: { w: "majority" },
  });
  assert.ok(harness.sessionEvents.length > 0);
  for (const event of harness.sessionEvents) {
    assert.equal(
      event.session,
      harness.lastSession,
      `${event.type} ${event.label} did not use transaction session`,
    );
  }
}

function assertNoPostCommitReads(harness) {
  const postCommitReads = harness.readEvents.filter(
    (event) => event.phase === "post-commit",
  );
  assert.deepEqual(
    postCommitReads,
    [],
    `database reads occurred after commit: ${postCommitReads
      .map((event) => event.label)
      .join(", ")}`,
  );
}

function assertFailedReadInTransaction(harness, label) {
  const failedRead = harness.readEvents.find(
    (event) => event.label === label && event.failed,
  );
  assert.ok(failedRead, `missing injected failure for ${label}`);
  assert.equal(failedRead.phase, "transaction");
  assert.equal(failedRead.session, harness.lastSession);
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

try {
  function firmAdminAuthoritySeed(membership) {
    const ownerId = "owner-user";
    const firmId = "firm-shared";
    return {
      ownerId,
      firmId,
      seed: {
        users: [],
        firms: [
          {
            _id: firmId,
            ownerUserId: ownerId,
            displayName: "Shared",
            handle: "shared",
            kind: "SHARED",
            isActive: true,
          },
        ],
        memberships: membership
          ? [
              {
                _id: "owner-membership",
                userId: ownerId,
                firmId,
                isPersonal: false,
                ...membership,
              },
            ]
          : [],
      },
    };
  }

  for (const authorityCase of [
    { label: "missing membership", membership: null },
    {
      label: "REMOVED OWNER membership",
      membership: { role: "OWNER", status: "REMOVED" },
    },
    {
      label: "ACTIVE MEMBER membership",
      membership: { role: "MEMBER", status: "ACTIVE" },
    },
    {
      label: "ACTIVE ADMIN membership",
      membership: { role: "ADMIN", status: "ACTIVE" },
    },
    {
      label: "ACTIVE OWNER membership with nonmatching owner pointer",
      membership: { role: "OWNER", status: "ACTIVE" },
      ownerUserId: "different-owner",
      testName:
        "assertFirmAdmin rejects nonmatching owner pointer with ACTIVE OWNER membership",
    },
  ]) {
    await test(
      authorityCase.testName ||
        `assertFirmAdmin rejects matching owner pointer with ${authorityCase.label}`,
      async () => {
        const setup = firmAdminAuthoritySeed(authorityCase.membership);
        if (authorityCase.ownerUserId) {
          setup.seed.firms[0].ownerUserId = authorityCase.ownerUserId;
        }
        activeHarness = createHarness(setup.seed);
        const before = snapshotState(activeHarness.state);

        await assert.rejects(
          invoke(getFirmById, {
            user: { id: setup.ownerId },
            params: { firmId: setup.firmId },
            body: {},
          }),
          (error) =>
            error.statusCode === 403 &&
            error.message === "Not authorized for this firm",
        );

        assert.deepEqual(snapshotState(activeHarness.state), before);
        assert.equal(activeHarness.sessionStarts, 0);
      },
    );
  }

  await test("assertFirmAdmin allows matching owner pointer with ACTIVE OWNER membership", async () => {
    const setup = firmAdminAuthoritySeed({ role: "OWNER", status: "ACTIVE" });
    activeHarness = createHarness(setup.seed);

    const response = await invoke(getFirmById, {
      user: { id: setup.ownerId },
      params: { firmId: setup.firmId },
      body: {},
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.firm._id, setup.firmId);
    assert.equal(activeHarness.sessionStarts, 0);
  });

  await test("sign-in healing rejects foreign PERSONAL pointer and restores exact owned state", async () => {
    const userId = "user-a";
    const personalFirmId = "firm-personal";
    const foreignPersonalFirmId = "firm-foreign-personal";
    activeHarness = createHarness({
      users: [
        {
          _id: userId,
          email: "user@example.test",
          name: "User",
          firmId: foreignPersonalFirmId,
          personalFirmId,
          role: "USER",
          accountType: "INDIVIDUAL",
          isActive: true,
          tokenVersion: 4,
        },
      ],
      firms: [
        {
          _id: personalFirmId,
          ownerUserId: userId,
          displayName: "Owned Personal",
          handle: "owned-personal",
          kind: "PERSONAL",
          isActive: true,
        },
        {
          _id: foreignPersonalFirmId,
          ownerUserId: "other-owner",
          displayName: "Foreign Personal",
          handle: "foreign-personal",
          kind: "PERSONAL",
          isActive: true,
        },
      ],
      memberships: [
        {
          _id: "membership-personal",
          userId,
          firmId: personalFirmId,
          role: "MEMBER",
          status: "ACTIVE",
          isPersonal: false,
        },
      ],
    });

    await ensurePersonalFirm(activeHarness.findUser({ _id: userId }));

    assert.deepEqual(activeHarness.state.users.get(userId), {
      _id: userId,
      email: "user@example.test",
      name: "User",
      firmId: personalFirmId,
      personalFirmId,
      role: "FIRM_ADMIN",
      accountType: "FIRM_USER",
      isActive: true,
      tokenVersion: 4,
    });
    assert.deepEqual(
      activeHarness.state.memberships.get(
        membershipKey(personalFirmId, userId),
      ),
      {
        _id: "membership-personal",
        userId,
        firmId: personalFirmId,
        role: "OWNER",
        status: "ACTIVE",
        isPersonal: true,
      },
    );
    assert.equal(
      activeHarness.state.memberships.has(
        membershipKey(foreignPersonalFirmId, userId),
      ),
      false,
    );
    assert.equal(activeHarness.state.memberships.size, 1);
  });

  for (const ownerCase of [
    { label: "missing", value: undefined },
    { label: "null", value: null },
  ]) {
    await test(`sign-in healing never infers ownership from ${ownerCase.label} SHARED ownerUserId`, async () => {
      const userId = "user-a";
      const personalFirmId = "firm-personal";
      const sharedFirmId = "firm-shared";
      const sharedFirm = {
        _id: sharedFirmId,
        displayName: "Shared",
        handle: "shared",
        kind: "SHARED",
        isActive: true,
      };
      if (ownerCase.value !== undefined) {
        sharedFirm.ownerUserId = ownerCase.value;
      }
      activeHarness = createHarness({
        users: [
          {
            _id: userId,
            email: "user@example.test",
            firmId: sharedFirmId,
            personalFirmId,
            role: "USER",
            accountType: "FIRM_USER",
            isActive: true,
            tokenVersion: 4,
          },
        ],
        firms: [
          {
            _id: personalFirmId,
            ownerUserId: userId,
            displayName: "Owned Personal",
            handle: "owned-personal",
            kind: "PERSONAL",
            isActive: true,
          },
          sharedFirm,
        ],
        memberships: [
          {
            _id: "membership-personal",
            userId,
            firmId: personalFirmId,
            role: "OWNER",
            status: "ACTIVE",
            isPersonal: true,
          },
          {
            _id: "membership-shared",
            userId,
            firmId: sharedFirmId,
            role: "MEMBER",
            status: "ACTIVE",
            isPersonal: false,
          },
        ],
      });

      await ensurePersonalFirm(activeHarness.findUser({ _id: userId }));

      const storedUser = activeHarness.state.users.get(userId);
      const sharedMembership = activeHarness.state.memberships.get(
        membershipKey(sharedFirmId, userId),
      );
      assert.equal(storedUser.firmId, sharedFirmId);
      assert.equal(storedUser.role, "USER");
      assert.equal(storedUser.accountType, "FIRM_USER");
      assert.equal(sharedMembership.role, "MEMBER");
      assert.equal(sharedMembership.status, "ACTIVE");
      assert.equal(sharedMembership.isPersonal, false);
    });
  }

  function switchRestoreRaceSeed({
    includePriorFirm = true,
    priorFirmActive = true,
    priorFirmKind = "SHARED",
    priorMembershipRole = "MEMBER",
    includePersonalFallback = true,
  } = {}) {
    const userId = "user-a";
    const priorFirmId = "firm-prior";
    const targetFirmId = "firm-target";
    const personalFirmId = "firm-personal";
    const firms = [
      ...(includePriorFirm
        ? [
            {
              _id: priorFirmId,
              ownerUserId: "different-owner",
              displayName: "Prior",
              handle: "prior",
              kind: priorFirmKind,
              isActive: priorFirmActive,
            },
          ]
        : []),
      {
        _id: targetFirmId,
        ownerUserId: "target-owner",
        displayName: "Target",
        handle: "target",
        kind: "SHARED",
        isActive: true,
      },
    ];
    const memberships = [
      {
        _id: "membership-prior",
        userId,
        firmId: priorFirmId,
        role: priorMembershipRole,
        status: "ACTIVE",
        isPersonal: priorFirmKind === "PERSONAL",
      },
      {
        _id: "membership-target",
        userId,
        firmId: targetFirmId,
        role: "MEMBER",
        status: "ACTIVE",
        isPersonal: false,
      },
    ];

    if (includePersonalFallback) {
      firms.push({
        _id: personalFirmId,
        ownerUserId: userId,
        displayName: "Owned Personal",
        handle: "owned-personal",
        kind: "PERSONAL",
        isActive: true,
      });
      memberships.push({
        _id: "membership-personal",
        userId,
        firmId: personalFirmId,
        role: "OWNER",
        status: "ACTIVE",
        isPersonal: true,
      });
    }

    return {
      userId,
      priorFirmId,
      targetFirmId,
      personalFirmId,
      seed: {
        users: [
          {
            _id: userId,
            email: "user@example.test",
            firmId: priorFirmId,
            personalFirmId: includePersonalFallback ? personalFirmId : null,
            role:
              priorMembershipRole === "ADMIN" || priorMembershipRole === "OWNER"
                ? "FIRM_ADMIN"
                : "USER",
            accountType: "FIRM_USER",
            isActive: true,
            tokenVersion: 4,
          },
        ],
        firms,
        memberships,
      },
    };
  }

  async function invokeSwitchRestoreRace(setup) {
    activeHarness = createHarness(setup.seed, { existsResults: [null] });

    const response = await invoke(switchWorkspace, {
      user: { id: setup.userId, tokenVersion: 4 },
      params: {},
      body: { firmId: setup.targetFirmId },
    });

    assert.equal(response.statusCode, 409);
    assert.deepEqual(response.body, {
      ok: false,
      error:
        "Your membership in this workspace changed before the switch completed",
    });
    assert.equal(activeHarness.readCounts.get("FirmMembership.exists"), 1);
    assert.equal(activeHarness.existsResults.length, 0);
    assert.equal(
      activeHarness.state.memberships.get(
        membershipKey(setup.targetFirmId, setup.userId),
      ).status,
      "ACTIVE",
    );
    return activeHarness.state.users.get(setup.userId);
  }

  function assertRestoredToOwnedPersonal(setup, restoredUser) {
    assert.equal(restoredUser.firmId, setup.personalFirmId);
    assert.equal(restoredUser.role, "FIRM_ADMIN");
    const personalFirm = activeHarness.state.firms.get(setup.personalFirmId);
    assert.equal(personalFirm._id, setup.personalFirmId);
    assert.equal(personalFirm.ownerUserId, setup.userId);
    assert.equal(personalFirm.kind, "PERSONAL");
    assert.equal(personalFirm.isActive, true);
    const personalMembership = activeHarness.state.memberships.get(
      membershipKey(setup.personalFirmId, setup.userId),
    );
    assert.equal(personalMembership.status, "ACTIVE");
    assert.equal(personalMembership.role, "OWNER");
  }

  for (const restoreCase of [
    {
      name: "switch race skips missing prior firm and restores exact owned PERSONAL",
      options: { includePriorFirm: false },
    },
    {
      name: "switch race skips inactive prior firm despite ACTIVE membership and restores exact owned PERSONAL",
      options: {
        priorFirmActive: false,
        priorMembershipRole: "ADMIN",
      },
    },
  ]) {
    await test(restoreCase.name, async () => {
      const setup = switchRestoreRaceSeed(restoreCase.options);
      const restoredUser = await invokeSwitchRestoreRace(setup);

      assertRestoredToOwnedPersonal(setup, restoredUser);
      assert.notEqual(restoredUser.firmId, setup.priorFirmId);
    });
  }

  for (const staleRole of ["ADMIN", "OWNER"]) {
    await test(`switch race rejects foreign PERSONAL prior ${staleRole} membership without elevation`, async () => {
      const setup = switchRestoreRaceSeed({
        priorFirmKind: "PERSONAL",
        priorMembershipRole: staleRole,
        includePersonalFallback: false,
      });
      const restoredUser = await invokeSwitchRestoreRace(setup);

      assert.equal(restoredUser.firmId, null);
      assert.equal(restoredUser.role, "USER");
      const foreignFirm = activeHarness.state.firms.get(setup.priorFirmId);
      assert.equal(foreignFirm.kind, "PERSONAL");
      assert.equal(foreignFirm.ownerUserId, "different-owner");
      const staleMembership = activeHarness.state.memberships.get(
        membershipKey(setup.priorFirmId, setup.userId),
      );
      assert.equal(staleMembership.status, "ACTIVE");
      assert.equal(staleMembership.role, staleRole);
    });
  }

  await test("switch rejects retained foreign PERSONAL membership without moving pointer", async () => {
    const userId = "user-a";
    const personalFirmId = "firm-personal";
    const foreignPersonalFirmId = "firm-foreign-personal";
    activeHarness = createHarness({
      users: [
        {
          _id: userId,
          email: "user@example.test",
          firmId: personalFirmId,
          personalFirmId,
          role: "FIRM_ADMIN",
          accountType: "FIRM_USER",
          isActive: true,
          tokenVersion: 4,
        },
      ],
      firms: [
        {
          _id: personalFirmId,
          ownerUserId: userId,
          displayName: "Owned Personal",
          handle: "owned-personal",
          kind: "PERSONAL",
          isActive: true,
        },
        {
          _id: foreignPersonalFirmId,
          ownerUserId: "other-owner",
          displayName: "Foreign Personal",
          handle: "foreign-personal",
          kind: "PERSONAL",
          isActive: true,
        },
      ],
      memberships: [
        {
          _id: "membership-personal",
          userId,
          firmId: personalFirmId,
          role: "OWNER",
          status: "ACTIVE",
          isPersonal: true,
        },
        {
          _id: "membership-foreign-personal",
          userId,
          firmId: foreignPersonalFirmId,
          role: "MEMBER",
          status: "ACTIVE",
          isPersonal: false,
        },
      ],
    });
    const before = snapshotState(activeHarness.state);

    const response = await invoke(switchWorkspace, {
      user: { id: userId, tokenVersion: 4 },
      params: {},
      body: { firmId: foreignPersonalFirmId },
    });

    assert.equal(response.statusCode, 403);
    assert.deepEqual(response.body, {
      ok: false,
      error: "You are not a member of this firm",
    });
    assert.deepEqual(snapshotState(activeHarness.state), before);
    assert.equal(activeHarness.state.users.get(userId).firmId, personalFirmId);
  });

  await test("workspace listing hides retained foreign PERSONAL membership", async () => {
    patch(Firm, "find", (filter) =>
      query(activeHarness, "Firm.find", () =>
        [...activeHarness.state.firms.values()]
          .filter((item) => matchesFilter(item, filter))
          .map((item) => clone(item)),
      ),
    );
    patch(FirmMembership, "aggregate", async (pipeline) => {
      const matchStage = pipeline.find((stage) => stage.$match)?.$match || {};
      const counts = new Map();
      for (const membership of activeHarness.state.memberships.values()) {
        if (!matchesFilter(membership, matchStage)) continue;
        const firmId = id(membership.firmId);
        counts.set(firmId, (counts.get(firmId) || 0) + 1);
      }
      return [...counts].map(([firmId, count]) => ({ _id: firmId, count }));
    });

    const userId = "user-a";
    const personalFirmId = "firm-personal";
    const sharedFirmId = "firm-shared";
    const foreignPersonalFirmId = "firm-foreign-personal";
    activeHarness = createHarness({
      users: [
        {
          _id: userId,
          firmId: sharedFirmId,
          personalFirmId,
          role: "USER",
          accountType: "FIRM_USER",
          isActive: true,
          tokenVersion: 4,
        },
      ],
      firms: [
        {
          _id: personalFirmId,
          ownerUserId: userId,
          displayName: "Owned Personal",
          handle: "owned-personal",
          kind: "PERSONAL",
          isActive: true,
        },
        {
          _id: sharedFirmId,
          ownerUserId: "shared-owner",
          displayName: "Shared",
          handle: "shared",
          kind: "SHARED",
          isActive: true,
        },
        {
          _id: foreignPersonalFirmId,
          ownerUserId: "other-owner",
          displayName: "Foreign Personal",
          handle: "foreign-personal",
          kind: "PERSONAL",
          isActive: true,
        },
      ],
      memberships: [
        {
          _id: "membership-personal",
          userId,
          firmId: personalFirmId,
          role: "OWNER",
          status: "ACTIVE",
          isPersonal: true,
        },
        {
          _id: "membership-shared",
          userId,
          firmId: sharedFirmId,
          role: "MEMBER",
          status: "ACTIVE",
          isPersonal: false,
        },
        {
          _id: "membership-foreign-personal",
          userId,
          firmId: foreignPersonalFirmId,
          role: "MEMBER",
          status: "ACTIVE",
          isPersonal: false,
        },
      ],
    });

    const response = await invoke(listWorkspaces, {
      user: { id: userId },
      params: {},
      body: {},
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(
      response.body.workspaces.map((workspace) => id(workspace.id)),
      [personalFirmId, sharedFirmId],
    );
    assert.equal(response.body.activeFirmId, sharedFirmId);
    assert.equal(response.body.personalFirmId, personalFirmId);
    assert.equal(
      activeHarness.state.memberships.get(
        membershipKey(foreignPersonalFirmId, userId),
      ).status,
      "ACTIVE",
    );
  });

  for (const role of ["ADMIN", "OWNER"]) {
    await test(`generic sign-in healing keeps removed shared ${role} membership removed`, async () => {
      const setup = sharedHealingSeed(role);
      activeHarness = createHarness(setup.seed);
      const user = activeHarness.findUser({ _id: setup.userId });

      await ensurePersonalFirm(user);

      const storedUser = activeHarness.state.users.get(setup.userId);
      const personalMembership = activeHarness.state.memberships.get(
        membershipKey(setup.personalFirmId, setup.userId),
      );
      const sharedMembership = activeHarness.state.memberships.get(
        membershipKey(setup.sharedFirmId, setup.userId),
      );
      assert.equal(personalMembership.status, "ACTIVE");
      assert.equal(sharedMembership.status, "REMOVED");
      assert.equal(storedUser.firmId, setup.personalFirmId);
      assert.equal(storedUser.role, "FIRM_ADMIN");
      assert.equal(storedUser.accountType, "FIRM_USER");
    });
  }

  await test("ambiguous legacy personal pointer is skipped without reactivation", async () => {
    const setup = sharedHealingSeed("OWNER");
    setup.seed.users[0].personalFirmId = setup.sharedFirmId;
    setup.seed.users[0].firmId = setup.personalFirmId;

    const ambiguousFirm = setup.seed.firms.find(
      (firm) => firm._id === setup.sharedFirmId,
    );
    ambiguousFirm.ownerUserId = setup.userId;
    delete ambiguousFirm.kind;
    setup.seed.memberships.find(
      (membership) => membership.firmId === setup.personalFirmId,
    ).status = "ACTIVE";
    setup.seed.users.push({
      _id: "collaborator-user",
      firmId: setup.sharedFirmId,
      role: "USER",
      accountType: "FIRM_USER",
      isActive: true,
      tokenVersion: 0,
    });
    setup.seed.memberships.push({
      _id: "collaborator-membership",
      userId: "collaborator-user",
      firmId: setup.sharedFirmId,
      role: "MEMBER",
      status: "ACTIVE",
      isPersonal: false,
    });
    activeHarness = createHarness(setup.seed);
    const user = activeHarness.findUser({ _id: setup.userId });

    await ensurePersonalFirm(user);

    const storedUser = activeHarness.state.users.get(setup.userId);
    const storedAmbiguousFirm = activeHarness.state.firms.get(
      setup.sharedFirmId,
    );
    assert.equal(storedUser.personalFirmId, setup.personalFirmId);
    assert.equal(storedUser.firmId, setup.personalFirmId);
    assert.equal(storedAmbiguousFirm.kind, undefined);
    assert.equal(
      activeHarness.state.memberships.get(
        membershipKey(setup.sharedFirmId, setup.userId),
      ).status,
      "REMOVED",
    );
    assert.equal(
      activeHarness.state.memberships.get(
        membershipKey(setup.sharedFirmId, "collaborator-user"),
      ).status,
      "ACTIVE",
    );
  });

  for (const roleCase of [
    {
      membershipRole: "ADMIN",
      expectedUserRole: "FIRM_ADMIN",
      label: "non-owner ACTIVE ADMIN membership at FIRM_ADMIN",
    },
    {
      membershipRole: "OWNER",
      expectedUserRole: "USER",
      label: "non-owner ACTIVE stale OWNER membership to USER",
    },
    {
      membershipRole: "MEMBER",
      expectedUserRole: "USER",
      label: "non-owner ACTIVE MEMBER membership to USER",
    },
  ]) {
    await test(`generic sign-in healing maps ${roleCase.label}`, async () => {
      const userId = "user-a";
      const personalFirmId = "firm-personal";
      const sharedFirmId = "firm-shared";
      activeHarness = createHarness({
        users: [
          {
            _id: userId,
            firmId: sharedFirmId,
            personalFirmId,
            role: "FIRM_ADMIN",
            accountType: "FIRM_USER",
            isActive: true,
            tokenVersion: 3,
          },
        ],
        firms: [
          {
            _id: personalFirmId,
            ownerUserId: userId,
            kind: "PERSONAL",
            isActive: true,
          },
          {
            _id: sharedFirmId,
            ownerUserId: "different-owner",
            kind: "SHARED",
            isActive: true,
          },
        ],
        memberships: [
          {
            _id: "membership-personal",
            userId,
            firmId: personalFirmId,
            role: "OWNER",
            status: "ACTIVE",
            isPersonal: true,
          },
          {
            _id: "membership-shared",
            userId,
            firmId: sharedFirmId,
            role: roleCase.membershipRole,
            status: "ACTIVE",
            isPersonal: false,
          },
        ],
      });
      const originalSharedMembership = clone(
        activeHarness.state.memberships.get(
          membershipKey(sharedFirmId, userId),
        ),
      );

      await ensurePersonalFirm(activeHarness.findUser({ _id: userId }));

      const storedUser = activeHarness.state.users.get(userId);
      assert.equal(storedUser.firmId, sharedFirmId);
      assert.equal(storedUser.role, roleCase.expectedUserRole);
      assert.equal(storedUser.accountType, "FIRM_USER");
      assert.deepEqual(
        activeHarness.state.memberships.get(
          membershipKey(sharedFirmId, userId),
        ),
        originalSharedMembership,
      );
    });
  }

  await test("missing-kind ACTIVE ADMIN membership keeps current workspace and FIRM_ADMIN role", async () => {
    const userId = "user-a";
    const personalFirmId = "firm-personal";
    const legacyFirmId = "firm-legacy";
    activeHarness = createHarness({
      users: [
        {
          _id: userId,
          firmId: legacyFirmId,
          personalFirmId,
          role: "USER",
          accountType: "FIRM_USER",
          isActive: true,
          tokenVersion: 3,
        },
      ],
      firms: [
        {
          _id: personalFirmId,
          ownerUserId: userId,
          kind: "PERSONAL",
          isActive: true,
        },
        {
          _id: legacyFirmId,
          ownerUserId: "legacy-owner",
          isActive: true,
        },
      ],
      memberships: [
        {
          _id: "membership-personal",
          userId,
          firmId: personalFirmId,
          role: "OWNER",
          status: "ACTIVE",
          isPersonal: true,
        },
        {
          _id: "membership-legacy",
          userId,
          firmId: legacyFirmId,
          role: "ADMIN",
          status: "ACTIVE",
          isPersonal: false,
        },
      ],
    });
    const originalLegacyMembership = clone(
      activeHarness.state.memberships.get(membershipKey(legacyFirmId, userId)),
    );

    await ensurePersonalFirm(activeHarness.findUser({ _id: userId }));

    const storedUser = activeHarness.state.users.get(userId);
    assert.equal(storedUser.firmId, legacyFirmId);
    assert.equal(storedUser.role, "FIRM_ADMIN");
    assert.equal(storedUser.accountType, "FIRM_USER");
    assert.deepEqual(
      activeHarness.state.memberships.get(membershipKey(legacyFirmId, userId)),
      originalLegacyMembership,
    );
    assert.equal(activeHarness.state.firms.get(legacyFirmId).kind, undefined);
    assert.equal(activeHarness.state.memberships.size, 2);
  });

  await test("missing-kind removed membership falls back and stays removed", async () => {
    const userId = "user-a";
    const personalFirmId = "firm-personal";
    const legacyFirmId = "firm-legacy";
    activeHarness = createHarness({
      users: [
        {
          _id: userId,
          firmId: legacyFirmId,
          personalFirmId,
          role: "USER",
          accountType: "FIRM_USER",
          isActive: true,
          tokenVersion: 3,
        },
      ],
      firms: [
        {
          _id: personalFirmId,
          ownerUserId: userId,
          kind: "PERSONAL",
          isActive: true,
        },
        {
          _id: legacyFirmId,
          ownerUserId: "legacy-owner",
          isActive: true,
        },
      ],
      memberships: [
        {
          _id: "membership-personal",
          userId,
          firmId: personalFirmId,
          role: "OWNER",
          status: "ACTIVE",
          isPersonal: true,
        },
        {
          _id: "membership-legacy",
          userId,
          firmId: legacyFirmId,
          role: "ADMIN",
          status: "REMOVED",
          isPersonal: true,
        },
      ],
    });
    const originalLegacyMembership = clone(
      activeHarness.state.memberships.get(membershipKey(legacyFirmId, userId)),
    );

    await ensurePersonalFirm(activeHarness.findUser({ _id: userId }));

    const storedUser = activeHarness.state.users.get(userId);
    assert.equal(storedUser.firmId, personalFirmId);
    assert.equal(storedUser.role, "FIRM_ADMIN");
    assert.deepEqual(
      activeHarness.state.memberships.get(membershipKey(legacyFirmId, userId)),
      originalLegacyMembership,
    );
    assert.equal(activeHarness.state.firms.get(legacyFirmId).kind, undefined);
    assert.equal(activeHarness.state.memberships.size, 2);
  });

  await test("transactional leave rejects SHARED personal pointer and nulls active workspace", async () => {
    const userId = "user-a";
    const activeSharedFirmId = "firm-active-shared";
    const corruptedSharedPersonalFirmId = "firm-corrupted-shared";
    activeHarness = createHarness({
      users: [
        {
          _id: userId,
          firmId: activeSharedFirmId,
          personalFirmId: corruptedSharedPersonalFirmId,
          role: "FIRM_ADMIN",
          accountType: "FIRM_USER",
          isActive: true,
          tokenVersion: 9,
        },
      ],
      firms: [
        {
          _id: activeSharedFirmId,
          ownerUserId: "other-owner",
          displayName: "Active Shared",
          handle: "active-shared",
          kind: "SHARED",
          isActive: true,
        },
        {
          _id: corruptedSharedPersonalFirmId,
          ownerUserId: userId,
          displayName: "Corrupted Shared Pointer",
          handle: "corrupted-shared",
          kind: "SHARED",
          isActive: true,
        },
      ],
      memberships: [
        {
          _id: "active-shared-membership",
          userId,
          firmId: activeSharedFirmId,
          role: "MEMBER",
          status: "ACTIVE",
          isPersonal: false,
        },
        {
          _id: "corrupted-shared-membership",
          userId,
          firmId: corruptedSharedPersonalFirmId,
          role: "OWNER",
          status: "ACTIVE",
          isPersonal: false,
        },
      ],
    });

    const response = await invoke(leaveFirm, {
      user: { id: userId },
      params: { firmId: activeSharedFirmId },
      body: {},
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { ok: true, activeWorkspace: null });
    const storedUser = activeHarness.state.users.get(userId);
    assert.equal(storedUser.firmId, null);
    assert.equal(storedUser.role, "USER");
    assert.equal(storedUser.accountType, "INDIVIDUAL");
    assert.equal(storedUser.tokenVersion, 10);
    assert.equal(
      activeHarness.state.memberships.get(
        membershipKey(corruptedSharedPersonalFirmId, userId),
      ).status,
      "ACTIVE",
    );
    assertNoPostCommitReads(activeHarness);
    assertTransactionDiscipline(activeHarness);
    assert.equal(activeHarness.transactionCommits, 1);
  });

  await test("transactional leave rejects missing-kind personal fallback", async () => {
    const userId = "user-a";
    const activeSharedFirmId = "firm-active-shared";
    const ambiguousPersonalFirmId = "firm-ambiguous-personal";
    activeHarness = createHarness({
      users: [
        {
          _id: userId,
          firmId: activeSharedFirmId,
          personalFirmId: ambiguousPersonalFirmId,
          role: "FIRM_ADMIN",
          accountType: "FIRM_USER",
          isActive: true,
          tokenVersion: 9,
        },
      ],
      firms: [
        {
          _id: activeSharedFirmId,
          ownerUserId: "other-owner",
          kind: "SHARED",
          isActive: true,
        },
        {
          _id: ambiguousPersonalFirmId,
          ownerUserId: userId,
          isActive: true,
        },
      ],
      memberships: [
        {
          _id: "active-shared-membership",
          userId,
          firmId: activeSharedFirmId,
          role: "MEMBER",
          status: "ACTIVE",
          isPersonal: false,
        },
        {
          _id: "ambiguous-personal-membership",
          userId,
          firmId: ambiguousPersonalFirmId,
          role: "OWNER",
          status: "ACTIVE",
          isPersonal: true,
        },
      ],
    });

    const response = await invoke(leaveFirm, {
      user: { id: userId },
      params: { firmId: activeSharedFirmId },
      body: {},
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { ok: true, activeWorkspace: null });
    const storedUser = activeHarness.state.users.get(userId);
    assert.equal(storedUser.firmId, null);
    assert.equal(storedUser.role, "USER");
    assert.equal(storedUser.accountType, "INDIVIDUAL");
    assert.equal(storedUser.tokenVersion, 10);
    assert.equal(
      activeHarness.state.firms.get(ambiguousPersonalFirmId).kind,
      undefined,
    );
    assert.equal(
      activeHarness.state.memberships.get(
        membershipKey(ambiguousPersonalFirmId, userId),
      ).status,
      "ACTIVE",
    );
    assertNoPostCommitReads(activeHarness);
    assertTransactionDiscipline(activeHarness);
  });

  for (const removableCase of [
    { label: "SHARED", kind: "SHARED" },
    { label: "missing-kind", kind: undefined },
  ]) {
    await test(`self-leave ignores stale personal marker on ${removableCase.label} firm`, async () => {
      const userId = "user-a";
      const personalFirmId = "firm-personal";
      const activeFirmId = "firm-active";
      const activeFirm = {
        _id: activeFirmId,
        ownerUserId: "other-owner",
        isActive: true,
      };
      if (removableCase.kind !== undefined)
        activeFirm.kind = removableCase.kind;
      activeHarness = createHarness({
        users: [
          {
            _id: userId,
            firmId: activeFirmId,
            personalFirmId,
            role: "USER",
            accountType: "FIRM_USER",
            isActive: true,
            tokenVersion: 6,
          },
        ],
        firms: [
          {
            _id: personalFirmId,
            ownerUserId: userId,
            kind: "PERSONAL",
            isActive: true,
          },
          activeFirm,
        ],
        memberships: [
          {
            _id: "membership-personal",
            userId,
            firmId: personalFirmId,
            role: "OWNER",
            status: "ACTIVE",
            isPersonal: true,
          },
          {
            _id: "membership-active",
            userId,
            firmId: activeFirmId,
            role: "MEMBER",
            status: "ACTIVE",
            isPersonal: true,
          },
        ],
      });

      const response = await invoke(leaveFirm, {
        user: { id: userId },
        params: { firmId: activeFirmId },
        body: {},
      });

      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.body, {
        ok: true,
        activeWorkspace: {
          id: personalFirmId,
          displayName: undefined,
          handle: undefined,
          kind: "PERSONAL",
          isPersonal: true,
          role: "OWNER",
          memberCount: 1,
          joinCode: undefined,
          sharingEnabled: true,
          memberAccess: "EDIT",
          isActive: true,
        },
      });
      const membership = activeHarness.state.memberships.get(
        membershipKey(activeFirmId, userId),
      );
      const storedUser = activeHarness.state.users.get(userId);
      assert.equal(membership.status, "REMOVED");
      assert.equal(membership.isPersonal, true);
      assert.equal(storedUser.firmId, personalFirmId);
      assert.equal(storedUser.tokenVersion, 7);
      assertNoPostCommitReads(activeHarness);
      assert.equal(activeHarness.transactionCommits, 1);
      assertTransactionDiscipline(activeHarness);
    });
  }

  await test("owned explicit PERSONAL workspace stays non-leavable with false marker", async () => {
    const userId = "user-a";
    const personalFirmId = "firm-personal";
    activeHarness = createHarness({
      users: [
        {
          _id: userId,
          firmId: personalFirmId,
          personalFirmId,
          role: "FIRM_ADMIN",
          accountType: "FIRM_USER",
          isActive: true,
          tokenVersion: 6,
        },
      ],
      firms: [
        {
          _id: personalFirmId,
          ownerUserId: userId,
          kind: "PERSONAL",
          isActive: true,
        },
      ],
      memberships: [
        {
          _id: "membership-personal",
          userId,
          firmId: personalFirmId,
          role: "OWNER",
          status: "ACTIVE",
          isPersonal: false,
        },
      ],
    });
    const before = snapshotState(activeHarness.state);

    const response = await invoke(leaveFirm, {
      user: { id: userId },
      params: { firmId: personalFirmId },
      body: {},
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.body.error, "Your personal workspace cannot be left");
    assert.deepEqual(snapshotState(activeHarness.state), before);
    assert.equal(activeHarness.transactionCommits, 0);
    assert.equal(activeHarness.transactionRollbacks, 1);
    assertTransactionDiscipline(activeHarness);
  });

  for (const missingMembershipCase of [
    { label: "SHARED", missingKind: false },
    { label: "missing-kind", missingKind: true },
  ]) {
    await test(`${missingMembershipCase.label} workspace without membership falls back to exact owned PERSONAL without backfill`, async () => {
      const setup = sharedHealingSeed("ADMIN");
      setup.seed.memberships = setup.seed.memberships.filter(
        (item) => item.firmId !== setup.sharedFirmId,
      );
      setup.seed.memberships[0].status = "ACTIVE";
      if (missingMembershipCase.missingKind) {
        delete setup.seed.firms.find((firm) => firm._id === setup.sharedFirmId)
          .kind;
      }
      activeHarness = createHarness(setup.seed);
      const user = activeHarness.findUser({ _id: setup.userId });

      await ensurePersonalFirm(user);

      assert.equal(
        activeHarness.state.memberships.has(
          membershipKey(setup.sharedFirmId, setup.userId),
        ),
        false,
      );
      assert.equal(activeHarness.state.memberships.size, 1);
      const storedUser = activeHarness.state.users.get(setup.userId);
      assert.equal(storedUser.firmId, setup.personalFirmId);
      assert.equal(storedUser.role, "FIRM_ADMIN");
      assert.equal(storedUser.accountType, "FIRM_USER");
      const personalMembership = activeHarness.state.memberships.get(
        membershipKey(setup.personalFirmId, setup.userId),
      );
      assert.equal(personalMembership.status, "ACTIVE");
      assert.equal(personalMembership.role, "OWNER");
      assert.equal(personalMembership.isPersonal, true);
    });
  }

  await test("fresh personal provisioning does not create SHARED membership from User.firmId", async () => {
    const userId = "user-fresh";
    const sharedFirmId = "firm-shared";
    activeHarness = createHarness({
      users: [
        {
          _id: userId,
          email: "fresh@example.test",
          name: "Fresh User",
          firmId: sharedFirmId,
          personalFirmId: null,
          role: "USER",
          accountType: "FIRM_USER",
          isActive: true,
          tokenVersion: 0,
        },
      ],
      firms: [
        {
          _id: sharedFirmId,
          ownerUserId: "different-owner",
          displayName: "Shared",
          handle: "shared",
          kind: "SHARED",
          isActive: true,
        },
      ],
      memberships: [],
    });

    await ensurePersonalFirm(activeHarness.findUser({ _id: userId }));

    const storedUser = activeHarness.state.users.get(userId);
    assert.equal(activeHarness.firmCreates, 1);
    assert.notEqual(storedUser.personalFirmId, sharedFirmId);
    assert.equal(storedUser.firmId, storedUser.personalFirmId);
    assert.equal(storedUser.role, "FIRM_ADMIN");
    assert.equal(storedUser.accountType, "FIRM_USER");
    const personalFirm = activeHarness.state.firms.get(
      id(storedUser.personalFirmId),
    );
    assert.equal(personalFirm.kind, "PERSONAL");
    assert.equal(personalFirm.ownerUserId, userId);
    assert.equal(
      activeHarness.state.memberships.has(membershipKey(sharedFirmId, userId)),
      false,
    );
    assert.equal(activeHarness.state.memberships.size, 1);
    const personalMembership = activeHarness.state.memberships.get(
      membershipKey(storedUser.personalFirmId, userId),
    );
    assert.equal(personalMembership.status, "ACTIVE");
    assert.equal(personalMembership.role, "OWNER");
    assert.equal(personalMembership.isPersonal, true);
  });

  await test("explicit validated reactivation restores removed admin as member", async () => {
    const setup = sharedHealingSeed("ADMIN");
    setup.seed.users[0].role = "USER";
    activeHarness = createHarness(setup.seed);

    const membership = await ensureFirmMembership(
      setup.userId,
      setup.sharedFirmId,
      {
        role: "MEMBER",
        isPersonal: false,
        reactivateRemoved: true,
      },
    );

    assert.equal(membership.status, "ACTIVE");
    assert.equal(membership.role, "MEMBER");
    const storedMembership = activeHarness.state.memberships.get(
      membershipKey(setup.sharedFirmId, setup.userId),
    );
    assert.equal(storedMembership.status, "ACTIVE");
    assert.equal(storedMembership.role, "MEMBER");
    assert.equal(activeHarness.state.users.get(setup.userId).role, "USER");
  });

  for (const genericCase of [
    { label: "default options", options: undefined },
    {
      label: "reactivateRemoved false",
      options: { role: "MEMBER", isPersonal: false, reactivateRemoved: false },
    },
  ]) {
    await test(`generic ensureFirmMembership with ${genericCase.label} leaves retained shared membership removed`, async () => {
      const setup = sharedHealingSeed("ADMIN");
      activeHarness = createHarness(setup.seed);
      const before = clone(
        activeHarness.state.memberships.get(
          membershipKey(setup.sharedFirmId, setup.userId),
        ),
      );

      const membership = await ensureFirmMembership(
        setup.userId,
        setup.sharedFirmId,
        genericCase.options,
      );

      assert.equal(membership.status, "REMOVED");
      assert.deepEqual(
        activeHarness.state.memberships.get(
          membershipKey(setup.sharedFirmId, setup.userId),
        ),
        before,
      );
    });
  }

  function getMyFirmJoinCodeSeed({
    membershipRole,
    memberAccess = "EDIT",
    userRole,
    ownerMatches = false,
  }) {
    const setup = sharedHealingSeed(membershipRole);
    setup.seed.memberships.forEach((membership) => {
      membership.status = "ACTIVE";
    });
    setup.seed.users[0].role = userRole;
    const sharedFirm = setup.seed.firms.find(
      (firm) => firm._id === setup.sharedFirmId,
    );
    sharedFirm.ownerUserId = ownerMatches ? setup.userId : "owner-user";
    sharedFirm.joinCode = "JOIN123";
    sharedFirm.memberAccess = memberAccess;
    return setup;
  }

  for (const authorityCase of [
    {
      name: "getMyFirm omits join code for ACTIVE MEMBER",
      membershipRole: "MEMBER",
      userRole: "USER",
    },
    {
      name: "getMyFirm omits join code for ACTIVE MEMBER in READ_ONLY firm",
      membershipRole: "MEMBER",
      memberAccess: "READ_ONLY",
      userRole: "USER",
    },
    {
      name: "getMyFirm ignores stale global FIRM_ADMIN for ACTIVE MEMBER",
      membershipRole: "MEMBER",
      userRole: "FIRM_ADMIN",
    },
    {
      name: "getMyFirm omits join code for nonmatching ACTIVE OWNER",
      membershipRole: "OWNER",
      userRole: "FIRM_ADMIN",
    },
    {
      name: "getMyFirm includes join code for ACTIVE ADMIN",
      membershipRole: "ADMIN",
      userRole: "FIRM_ADMIN",
      expectedJoinCode: "JOIN123",
    },
    {
      name: "getMyFirm includes join code for matching ACTIVE OWNER",
      membershipRole: "OWNER",
      userRole: "FIRM_ADMIN",
      ownerMatches: true,
      expectedJoinCode: "JOIN123",
    },
  ]) {
    await test(authorityCase.name, async () => {
      const setup = getMyFirmJoinCodeSeed(authorityCase);
      const sourceFirm = clone(
        setup.seed.firms.find((firm) => firm._id === setup.sharedFirmId),
      );
      activeHarness = createHarness(setup.seed);

      const response = await invoke(getMyFirm, {
        user: { id: setup.userId },
        params: {},
        body: {},
      });

      assert.equal(response.statusCode, 200);
      assert.deepEqual(Object.keys(response.body).sort(), [
        "firm",
        "ok",
        "workspace",
      ]);
      assert.equal(response.body.ok, true);
      const expectedFirm = clone(sourceFirm);
      if (!authorityCase.expectedJoinCode) delete expectedFirm.joinCode;
      assert.deepEqual(response.body.firm, expectedFirm);
      assert.equal(
        response.body.workspace.joinCode,
        authorityCase.expectedJoinCode,
      );
      assert.deepEqual(
        activeHarness.state.firms.get(setup.sharedFirmId),
        sourceFirm,
      );
    });
  }

  async function invokeGetMyFirmWithExactFirm(setup, exactFirm) {
    activeHarness = createHarness(setup.seed);
    const harnessFindById = Firm.findById;
    Firm.findById = (firmId) =>
      id(firmId) === id(setup.sharedFirmId)
        ? exactFirm
        : harnessFindById(firmId);
    try {
      return await invoke(getMyFirm, {
        user: { id: setup.userId },
        params: {},
        body: {},
      });
    } finally {
      Firm.findById = harnessFindById;
    }
  }

  await test("getMyFirm redaction does not mutate an exact plain firm result", async () => {
    const setup = getMyFirmJoinCodeSeed({
      membershipRole: "MEMBER",
      userRole: "USER",
    });
    const sourceFirm = clone(
      setup.seed.firms.find((firm) => firm._id === setup.sharedFirmId),
    );
    const exactFirm = clone(sourceFirm);

    const response = await invokeGetMyFirmWithExactFirm(setup, exactFirm);

    const expectedFirm = clone(sourceFirm);
    delete expectedFirm.joinCode;
    assert.deepEqual(response.body.firm, expectedFirm);
    assert.equal(response.body.workspace.joinCode, undefined);
    assert.deepEqual(exactFirm, sourceFirm);
    assert.equal(exactFirm.joinCode, "JOIN123");
  });

  await test("getMyFirm preserves hydrated Mongoose fields without mutating the document", async () => {
    const userId = "64b000000000000000000001";
    const ownerId = "64b000000000000000000002";
    const sharedFirmId = "64b000000000000000000003";
    const personalFirmId = "64b000000000000000000004";
    const sharedFirm = {
      _id: sharedFirmId,
      ownerUserId: ownerId,
      displayName: "Shared",
      handle: "shared",
      kind: "SHARED",
      description: "Review workspace",
      practiceAreas: ["Audit", "GST"],
      joinCode: "JOIN123",
      planType: "FREE",
      planExpiry: null,
      isActive: true,
      sharingEnabled: true,
      memberAccess: "EDIT",
      timezone: "Asia/Kolkata",
      digestSettings: { dailyHour: 8, weeklyDay: 1, weeklyHour: 8 },
      createdAt: new Date("2025-01-01T00:00:00.000Z"),
      updatedAt: new Date("2025-01-02T00:00:00.000Z"),
    };
    const setup = {
      userId,
      sharedFirmId,
      seed: {
        users: [
          {
            _id: userId,
            firmId: sharedFirmId,
            personalFirmId,
            role: "USER",
            accountType: "FIRM_USER",
            isActive: true,
            tokenVersion: 0,
          },
        ],
        firms: [
          {
            _id: personalFirmId,
            ownerUserId: userId,
            displayName: "Personal",
            handle: "personal",
            kind: "PERSONAL",
            joinCode: "PERSON1",
            isActive: true,
          },
          sharedFirm,
        ],
        memberships: [
          {
            _id: "personal-membership",
            userId,
            firmId: personalFirmId,
            role: "OWNER",
            status: "ACTIVE",
            isPersonal: true,
          },
          {
            _id: "shared-membership",
            userId,
            firmId: sharedFirmId,
            role: "MEMBER",
            status: "ACTIVE",
            isPersonal: false,
          },
        ],
      },
    };
    const mongooseFirm = Firm.hydrate(sharedFirm);
    const sourceSnapshot = mongooseFirm.toJSON();

    const response = await invokeGetMyFirmWithExactFirm(setup, mongooseFirm);

    const expectedFirm = mongooseFirm.toJSON();
    delete expectedFirm.joinCode;
    assert.deepEqual(response.body.firm, expectedFirm);
    assert.equal(response.body.workspace.joinCode, undefined);
    assert.deepEqual(mongooseFirm.toJSON(), sourceSnapshot);
    assert.equal(mongooseFirm.joinCode, "JOIN123");
  });

  await test("getMyFirm falls away from removed shared workspace", async () => {
    const setup = sharedHealingSeed("ADMIN");
    setup.seed.memberships[0].status = "ACTIVE";
    activeHarness = createHarness(setup.seed);

    const response = await invoke(getMyFirm, {
      user: { id: setup.userId },
      params: {},
      body: {},
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.firm._id, setup.personalFirmId);
    assert.equal(response.body.workspace.id, setup.personalFirmId);
    assert.equal(
      activeHarness.state.memberships.get(
        membershipKey(setup.sharedFirmId, setup.userId),
      ).status,
      "REMOVED",
    );
  });

  await test("committed leave repairs stale personal fallback and revokes sessions", async () => {
    const setup = sharedHealingSeed("ADMIN");
    setup.seed.memberships.forEach((item) => {
      item.status = "ACTIVE";
    });
    const personalMembershipSeed = setup.seed.memberships.find(
      (item) => item.firmId === setup.personalFirmId,
    );
    personalMembershipSeed.role = "MEMBER";
    personalMembershipSeed.isPersonal = false;
    activeHarness = createHarness(setup.seed);

    const response = await invoke(leaveFirm, {
      user: { id: setup.userId },
      params: { firmId: setup.sharedFirmId },
      body: {},
    });

    assert.equal(response.statusCode, 200);
    const storedUser = activeHarness.state.users.get(setup.userId);
    assert.equal(
      activeHarness.state.memberships.get(
        membershipKey(setup.sharedFirmId, setup.userId),
      ).status,
      "REMOVED",
    );
    assert.equal(storedUser.firmId, setup.personalFirmId);
    assert.equal(storedUser.role, "FIRM_ADMIN");
    assert.equal(storedUser.accountType, "FIRM_USER");
    assert.equal(storedUser.tokenVersion, 3);
    const repairedPersonalMembership = activeHarness.state.memberships.get(
      membershipKey(setup.personalFirmId, setup.userId),
    );
    assert.equal(repairedPersonalMembership.role, "OWNER");
    assert.equal(repairedPersonalMembership.isPersonal, true);
    assert.deepEqual(response.body, {
      ok: true,
      activeWorkspace: {
        id: setup.personalFirmId,
        displayName: "Personal",
        handle: "personal",
        kind: "PERSONAL",
        isPersonal: true,
        role: "OWNER",
        memberCount: 1,
        joinCode: undefined,
        sharingEnabled: true,
        memberAccess: "EDIT",
        isActive: true,
      },
    });
    assertNoPostCommitReads(activeHarness);
    assertTransactionDiscipline(activeHarness);
    assert.equal(activeHarness.transactionCommits, 1);
  });

  await test("workspace summary read failure rolls back leave authority mutations", async () => {
    const setup = sharedHealingSeed("ADMIN");
    setup.seed.memberships.forEach((membership) => {
      membership.status = "ACTIVE";
    });
    activeHarness = createHarness(setup.seed, {
      failOnRead: "FirmMembership.countDocuments",
    });
    const before = snapshotState(activeHarness.state);

    await assert.rejects(
      invoke(leaveFirm, {
        user: { id: setup.userId },
        params: { firmId: setup.sharedFirmId },
        body: {},
      }),
      /Injected read failure at FirmMembership\.countDocuments/,
    );

    assert.deepEqual(snapshotState(activeHarness.state), before);
    assert.equal(activeHarness.transactionCommits, 0);
    assert.equal(activeHarness.transactionRollbacks, 1);
    assertFailedReadInTransaction(
      activeHarness,
      "FirmMembership.countDocuments",
    );
    assertTransactionDiscipline(activeHarness);
  });

  await test("leaving an inactive workspace still revokes sessions", async () => {
    const setup = sharedHealingSeed("ADMIN");
    setup.seed.memberships.forEach((item) => {
      item.status = "ACTIVE";
    });
    setup.seed.users[0].firmId = setup.personalFirmId;
    activeHarness = createHarness(setup.seed);

    const response = await invoke(leaveFirm, {
      user: { id: setup.userId },
      params: { firmId: setup.sharedFirmId },
      body: {},
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { ok: true, activeWorkspace: null });
    const storedUser = activeHarness.state.users.get(setup.userId);
    assert.equal(storedUser.firmId, setup.personalFirmId);
    assert.equal(storedUser.tokenVersion, 3);
    assertNoPostCommitReads(activeHarness);
    assertTransactionDiscipline(activeHarness);
  });

  await test("user save failure rolls back membership removal and fallback repair", async () => {
    const setup = sharedHealingSeed("ADMIN");
    setup.seed.memberships.forEach((item) => {
      item.status = "ACTIVE";
    });
    const personalMembershipSeed = setup.seed.memberships.find(
      (item) => item.firmId === setup.personalFirmId,
    );
    personalMembershipSeed.role = "MEMBER";
    personalMembershipSeed.isPersonal = false;
    activeHarness = createHarness(setup.seed, { failOnWrite: "User.save" });
    const before = snapshotState(activeHarness.state);

    await assert.rejects(
      invoke(leaveFirm, {
        user: { id: setup.userId },
        params: { firmId: setup.sharedFirmId },
        body: {},
      }),
      /Injected failure at User\.save/,
    );

    assert.deepEqual(snapshotState(activeHarness.state), before);
    const restoredPersonalMembership = activeHarness.state.memberships.get(
      membershipKey(setup.personalFirmId, setup.userId),
    );
    assert.equal(restoredPersonalMembership.role, "MEMBER");
    assert.equal(restoredPersonalMembership.isPersonal, false);
    assert.equal(activeHarness.transactionRollbacks, 1);
    assertTransactionDiscipline(activeHarness);
  });

  await test("committed owner removal ignores stale shared personal marker and revokes target", async () => {
    const ownerId = "owner-user";
    const targetId = "target-user";
    const sharedFirmId = "firm-shared";
    activeHarness = createHarness({
      users: [
        {
          _id: ownerId,
          firmId: sharedFirmId,
          personalFirmId: "owner-personal",
          role: "FIRM_ADMIN",
          accountType: "FIRM_USER",
          isActive: true,
          tokenVersion: 0,
        },
        {
          _id: targetId,
          firmId: sharedFirmId,
          personalFirmId: null,
          role: "FIRM_ADMIN",
          accountType: "FIRM_USER",
          isActive: true,
          tokenVersion: 4,
        },
      ],
      firms: [
        {
          _id: sharedFirmId,
          ownerUserId: ownerId,
          displayName: "Shared",
          handle: "shared",
          kind: "SHARED",
          isActive: true,
        },
      ],
      memberships: [
        {
          _id: "owner-membership",
          userId: ownerId,
          firmId: sharedFirmId,
          role: "OWNER",
          status: "ACTIVE",
          isPersonal: false,
        },
        {
          _id: "target-membership",
          userId: targetId,
          firmId: sharedFirmId,
          role: "ADMIN",
          status: "ACTIVE",
          isPersonal: true,
        },
      ],
    });

    const response = await invoke(deleteFirmUser, {
      user: { id: ownerId },
      params: { firmId: sharedFirmId, userId: targetId },
      body: {},
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {
      ok: true,
      firm: {
        id: sharedFirmId,
        displayName: "Shared",
        handle: "shared",
      },
      users: [
        {
          _id: ownerId,
          role: "FIRM_ADMIN",
          accountType: "FIRM_USER",
          isActive: true,
          membershipRole: "OWNER",
        },
      ],
    });
    const target = activeHarness.state.users.get(targetId);
    assert.equal(
      activeHarness.state.memberships.get(membershipKey(sharedFirmId, targetId))
        .status,
      "REMOVED",
    );
    assert.equal(target.firmId, null);
    assert.equal(target.role, "USER");
    assert.equal(target.accountType, "INDIVIDUAL");
    assert.equal(target.tokenVersion, 5);
    assertNoPostCommitReads(activeHarness);
    assertTransactionDiscipline(activeHarness);
    assert.equal(activeHarness.transactionCommits, 1);
  });

  await test("owner removal failure rolls back every target field", async () => {
    const ownerId = "owner-user";
    const targetId = "target-user";
    const sharedFirmId = "firm-shared";
    activeHarness = createHarness(
      {
        users: [
          {
            _id: ownerId,
            firmId: sharedFirmId,
            role: "FIRM_ADMIN",
            accountType: "FIRM_USER",
            isActive: true,
            tokenVersion: 0,
          },
          {
            _id: targetId,
            firmId: sharedFirmId,
            personalFirmId: null,
            role: "USER",
            accountType: "FIRM_USER",
            isActive: true,
            tokenVersion: 1,
          },
        ],
        firms: [
          {
            _id: sharedFirmId,
            ownerUserId: ownerId,
            displayName: "Shared",
            handle: "shared",
            kind: "SHARED",
            isActive: true,
          },
        ],
        memberships: [
          {
            _id: "owner-membership",
            userId: ownerId,
            firmId: sharedFirmId,
            role: "OWNER",
            status: "ACTIVE",
            isPersonal: false,
          },
          {
            _id: "target-membership",
            userId: targetId,
            firmId: sharedFirmId,
            role: "MEMBER",
            status: "ACTIVE",
            isPersonal: false,
          },
        ],
      },
      { failOnWrite: "User.save" },
    );
    const before = snapshotState(activeHarness.state);

    await assert.rejects(
      invoke(deleteFirmUser, {
        user: { id: ownerId },
        params: { firmId: sharedFirmId, userId: targetId },
        body: {},
      }),
      /Injected failure at User\.save/,
    );

    assert.deepEqual(snapshotState(activeHarness.state), before);
    assert.equal(activeHarness.transactionRollbacks, 1);
    assertTransactionDiscipline(activeHarness);
  });

  await test("owner removal still protects super admin target", async () => {
    const ownerId = "owner-user";
    const targetId = "super-user";
    const sharedFirmId = "firm-shared";
    activeHarness = createHarness({
      users: [
        {
          _id: ownerId,
          firmId: sharedFirmId,
          role: "FIRM_ADMIN",
          accountType: "FIRM_USER",
          isActive: true,
          tokenVersion: 0,
        },
        {
          _id: targetId,
          firmId: sharedFirmId,
          role: "SUPER_ADMIN",
          accountType: "FIRM_USER",
          isActive: true,
          tokenVersion: 7,
        },
      ],
      firms: [
        {
          _id: sharedFirmId,
          ownerUserId: ownerId,
          displayName: "Shared",
          handle: "shared",
          kind: "SHARED",
          isActive: true,
        },
      ],
      memberships: [
        {
          _id: "owner-membership",
          userId: ownerId,
          firmId: sharedFirmId,
          role: "OWNER",
          status: "ACTIVE",
          isPersonal: false,
        },
        {
          _id: "target-membership",
          userId: targetId,
          firmId: sharedFirmId,
          role: "MEMBER",
          status: "ACTIVE",
          isPersonal: false,
        },
      ],
    });
    const before = snapshotState(activeHarness.state);

    const response = await invoke(deleteFirmUser, {
      user: { id: ownerId },
      params: { firmId: sharedFirmId, userId: targetId },
      body: {},
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.body.error, "Cannot remove super admin account");
    assert.deepEqual(snapshotState(activeHarness.state), before);
  });

  for (const blockedJoin of [
    { label: "PERSONAL", kind: "PERSONAL" },
    { label: "missing-kind", kind: undefined },
  ]) {
    await test(`${blockedJoin.label} join code is rejected without user or membership writes`, async () => {
      const setup = sharedHealingSeed("ADMIN");
      const blockedFirm = setup.seed.firms.find(
        (firm) => firm._id === setup.personalFirmId,
      );
      blockedFirm.joinCode = "PERSONAL1";
      if (blockedJoin.kind === undefined) delete blockedFirm.kind;
      else blockedFirm.kind = blockedJoin.kind;
      activeHarness = createHarness(setup.seed);
      const before = snapshotState(activeHarness.state);

      const response = await invoke(joinFirmByCode, {
        user: { id: setup.userId, tokenVersion: 2 },
        params: {},
        body: { joinCode: "personal1" },
      });

      assert.equal(response.statusCode, 404);
      assert.equal(response.body.error, "Invalid or inactive join code");
      assert.deepEqual(snapshotState(activeHarness.state), before);
    });
  }

  await test("private join does not reactivate a removed membership", async () => {
    const setup = sharedHealingSeed("ADMIN");
    setup.seed.users[0].firmId = setup.personalFirmId;
    setup.seed.memberships[0].status = "ACTIVE";
    const sharedFirm = setup.seed.firms.find(
      (firm) => firm._id === setup.sharedFirmId,
    );
    sharedFirm.joinCode = "JOIN123";
    sharedFirm.sharingEnabled = false;
    activeHarness = createHarness(setup.seed);

    const response = await invoke(joinFirmByCode, {
      user: { id: setup.userId, tokenVersion: 2 },
      params: {},
      body: { joinCode: "join123" },
    });

    assert.equal(response.statusCode, 403);
    assert.equal(
      activeHarness.state.memberships.get(
        membershipKey(setup.sharedFirmId, setup.userId),
      ).status,
      "REMOVED",
    );
    assert.equal(
      activeHarness.state.users.get(setup.userId).firmId,
      setup.personalFirmId,
    );
  });

  function removedMembershipJoinSeed({ includeSharedMembership = true } = {}) {
    const setup = sharedHealingSeed("ADMIN");
    setup.seed.users[0].firmId = setup.personalFirmId;
    setup.seed.users[0].personalFirmId = setup.sharedFirmId;
    setup.seed.memberships[0].status = "ACTIVE";
    const sharedMembership = setup.seed.memberships.find(
      (membership) => membership.firmId === setup.sharedFirmId,
    );
    sharedMembership.isPersonal = true;
    if (!includeSharedMembership) {
      setup.seed.memberships = setup.seed.memberships.filter(
        (membership) => membership.firmId !== setup.sharedFirmId,
      );
    }
    const sharedFirm = setup.seed.firms.find(
      (firm) => firm._id === setup.sharedFirmId,
    );
    sharedFirm.joinCode = "JOIN123";
    sharedFirm.sharingEnabled = true;
    return setup;
  }

  function invokeJoin(setup, { tokenVersion = 2, operationId } = {}) {
    return invoke(joinFirmByCode, {
      user: { id: setup.userId, tokenVersion },
      params: {},
      body: {
        joinCode: "join123",
        ...(operationId ? { operationId } : {}),
      },
    });
  }

  await test("validated join reactivates removed admin as member and clears stale personal marker", async () => {
    const setup = removedMembershipJoinSeed();
    activeHarness = createHarness(setup.seed);

    const response = await invokeJoin(setup);

    assert.equal(response.statusCode, 200);
    const membership = activeHarness.state.memberships.get(
      membershipKey(setup.sharedFirmId, setup.userId),
    );
    const user = activeHarness.state.users.get(setup.userId);
    assert.equal(membership.status, "ACTIVE");
    assert.equal(membership.role, "MEMBER");
    assert.equal(membership.isPersonal, false);
    assert.equal(user.firmId, setup.sharedFirmId);
    assert.equal(user.role, "USER");
    assert.equal(response.body.workspace.role, "MEMBER");
    assert.equal(response.body.user.role, "USER");
    assertNoPostCommitReads(activeHarness);
    assert.equal(activeHarness.transactionCommits, 1);
    assertTransactionDiscipline(activeHarness);
  });

  await test("join with stale authenticated tokenVersion rolls back removed membership and active workspace", async () => {
    const setup = removedMembershipJoinSeed();
    setup.seed.users[0].tokenVersion = 3;
    activeHarness = createHarness(setup.seed);
    const before = snapshotState(activeHarness.state);

    const response = await invokeJoin(setup, { tokenVersion: 2 });

    assert.equal(response.statusCode, 409);
    assert.equal(
      response.body.error,
      "This session was signed out on the server, so the workspace change was not applied. Sign in again, then retry.",
    );
    assert.deepEqual(snapshotState(activeHarness.state), before);
    assert.equal(activeHarness.transactionCommits, 0);
    assert.equal(activeHarness.transactionRollbacks, 1);
    assertTransactionDiscipline(activeHarness);
  });

  await test("join membership reactivation save failure rolls back removed membership and active workspace", async () => {
    const setup = removedMembershipJoinSeed();
    activeHarness = createHarness(setup.seed, {
      failOnWrite: "FirmMembership.save",
    });
    const before = snapshotState(activeHarness.state);

    await assert.rejects(
      invokeJoin(setup),
      /Injected failure at FirmMembership\.save/,
    );

    assert.deepEqual(snapshotState(activeHarness.state), before);
    assert.equal(activeHarness.transactionCommits, 0);
    assert.equal(activeHarness.transactionRollbacks, 1);
    assertTransactionDiscipline(activeHarness);
  });

  await test("join activation CAS write failure rolls back reactivated membership and active workspace", async () => {
    const setup = removedMembershipJoinSeed();
    activeHarness = createHarness(setup.seed, {
      failOnWrite: "User.findOneAndUpdate",
    });
    const before = snapshotState(activeHarness.state);

    await assert.rejects(
      invokeJoin(setup),
      /Injected failure at User\.findOneAndUpdate/,
    );

    assert.deepEqual(snapshotState(activeHarness.state), before);
    assert.equal(activeHarness.transactionCommits, 0);
    assert.equal(activeHarness.transactionRollbacks, 1);
    assertTransactionDiscipline(activeHarness);
  });

  await test("fresh untracked join creates membership and activation in one transaction", async () => {
    const setup = removedMembershipJoinSeed({
      includeSharedMembership: false,
    });
    activeHarness = createHarness(setup.seed);

    const response = await invokeJoin(setup);

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.alreadyMember, false);
    const membership = activeHarness.state.memberships.get(
      membershipKey(setup.sharedFirmId, setup.userId),
    );
    assert.equal(membership.status, "ACTIVE");
    assert.equal(membership.role, "MEMBER");
    assert.equal(membership.isPersonal, false);
    const creation = activeHarness.sessionEvents.find(
      (event) => event.label === "FirmMembership.create",
    );
    assert.ok(creation);
    assert.equal(creation.session, activeHarness.lastSession);
    assertNoPostCommitReads(activeHarness);
    assert.equal(activeHarness.transactionCommits, 1);
    assertTransactionDiscipline(activeHarness);
  });

  await test("tracked join commits authority and receipt together then reuses success", async () => {
    const setup = removedMembershipJoinSeed();
    const operationId = "0123456789abcdef0123456789abcdef";
    activeHarness = createHarness(setup.seed);

    const first = await invokeJoin(setup, { operationId });

    assert.equal(first.statusCode, 200);
    assert.deepEqual(Object.keys(first.body).sort(), [
      "alreadyMember",
      "firm",
      "ok",
      "operation",
      "user",
      "workspace",
    ]);
    assert.equal(first.body.operation.operationId, operationId);
    assert.equal(first.body.operation.kind, "JOIN");
    assert.equal(first.body.operation.status, "SUCCEEDED");
    assert.equal(first.body.operation.activeFirmId, setup.sharedFirmId);
    const storedUser = activeHarness.state.users.get(setup.userId);
    assert.equal(storedUser.workspaceOperationReceipts.length, 1);
    assert.equal(
      storedUser.workspaceOperationReceipts[0].operationId,
      operationId,
    );
    const operation = [...activeHarness.state.operations.values()][0];
    assert.equal(operation.status, "SUCCEEDED");
    assert.equal(operation.activeFirmId, setup.sharedFirmId);
    const operationWrite = activeHarness.sessionEvents.find(
      (event) => event.label === "WorkspaceOperation.updateOne",
    );
    assert.ok(operationWrite);
    assert.equal(operationWrite.session, activeHarness.lastSession);
    assertNoPostCommitReads(activeHarness);
    assert.equal(activeHarness.transactionCommits, 1);
    assertTransactionDiscipline(activeHarness);

    const committed = snapshotState(activeHarness.state);
    const transactionRuns = activeHarness.transactionRuns;
    const replay = await invokeJoin(setup, { operationId });

    assert.equal(replay.statusCode, 200);
    assert.deepEqual(replay.body, {
      ok: true,
      operation: first.body.operation,
    });
    assert.equal(activeHarness.transactionRuns, transactionRuns);
    assert.deepEqual(snapshotState(activeHarness.state), committed);
  });

  await test("tracked join operation status write failure rolls back authority and reuses terminal rejection", async () => {
    const setup = removedMembershipJoinSeed();
    const operationId = "33333333333333333333333333333333";
    activeHarness = createHarness(setup.seed, {
      failOnWrite: {
        label: "WorkspaceOperation.updateOne",
        phase: "transaction",
      },
    });
    const originalUser = clone(activeHarness.state.users.get(setup.userId));
    const originalMembership = clone(
      activeHarness.state.memberships.get(
        membershipKey(setup.sharedFirmId, setup.userId),
      ),
    );

    const response = await invokeJoin(setup, { operationId });

    assert.equal(response.statusCode, 500);
    assert.equal(response.body.ok, false);
    assert.equal(response.body.error, "Workspace join could not be completed");
    assert.equal(response.body.operation.operationId, operationId);
    assert.equal(response.body.operation.kind, "JOIN");
    assert.equal(response.body.operation.status, "REJECTED");
    assert.equal(response.body.operation.error.httpStatus, 500);
    assert.equal(
      response.body.operation.error.message,
      "Workspace join could not be completed",
    );
    assert.deepEqual(activeHarness.state.users.get(setup.userId), originalUser);
    assert.deepEqual(
      activeHarness.state.memberships.get(
        membershipKey(setup.sharedFirmId, setup.userId),
      ),
      originalMembership,
    );
    const operation = [...activeHarness.state.operations.values()][0];
    assert.equal(operation.status, "REJECTED");
    assert.equal(operation.activeFirmId ?? null, null);
    const failedOperationWrite = activeHarness.sessionEvents.find(
      (event) =>
        event.label === "WorkspaceOperation.updateOne" && event.failed === true,
    );
    assert.ok(failedOperationWrite);
    assert.equal(failedOperationWrite.phase, "transaction");
    assert.equal(activeHarness.transactionCommits, 0);
    assert.equal(activeHarness.transactionRollbacks, 1);
    assertTransactionDiscipline(activeHarness);

    const rejectedState = snapshotState(activeHarness.state);
    const transactionRuns = activeHarness.transactionRuns;
    const replay = await invokeJoin(setup, { operationId });

    assert.equal(replay.statusCode, 500);
    assert.deepEqual(replay.body, response.body);
    assert.equal(activeHarness.transactionRuns, transactionRuns);
    assert.deepEqual(snapshotState(activeHarness.state), rejectedState);
  });

  for (const trackedFailureCase of [
    {
      label: "membership reactivation save failure",
      failOnWrite: "FirmMembership.save",
      operationId: "11111111111111111111111111111111",
    },
    {
      label: "activation CAS write failure",
      failOnWrite: "User.findOneAndUpdate",
      operationId: "22222222222222222222222222222222",
    },
  ]) {
    await test(`tracked join ${trackedFailureCase.label} rolls back authority and reuses terminal rejection`, async () => {
      const setup = removedMembershipJoinSeed();
      activeHarness = createHarness(setup.seed, {
        failOnWrite: trackedFailureCase.failOnWrite,
      });
      const originalUser = clone(activeHarness.state.users.get(setup.userId));
      const originalMembership = clone(
        activeHarness.state.memberships.get(
          membershipKey(setup.sharedFirmId, setup.userId),
        ),
      );

      const response = await invokeJoin(setup, {
        operationId: trackedFailureCase.operationId,
      });

      assert.equal(response.statusCode, 500);
      assert.equal(response.body.ok, false);
      assert.equal(
        response.body.error,
        "Workspace join could not be completed",
      );
      assert.equal(response.body.operation.status, "REJECTED");
      assert.equal(response.body.operation.error.httpStatus, 500);
      assert.equal(
        response.body.operation.error.message,
        "Workspace join could not be completed",
      );
      assert.deepEqual(
        activeHarness.state.users.get(setup.userId),
        originalUser,
      );
      assert.deepEqual(
        activeHarness.state.memberships.get(
          membershipKey(setup.sharedFirmId, setup.userId),
        ),
        originalMembership,
      );
      const operation = [...activeHarness.state.operations.values()][0];
      assert.equal(operation.status, "REJECTED");
      assert.equal(operation.activeFirmId ?? null, null);
      assert.equal(activeHarness.transactionCommits, 0);
      assert.equal(activeHarness.transactionRollbacks, 1);
      assertTransactionDiscipline(activeHarness);

      const transactionRuns = activeHarness.transactionRuns;
      const replay = await invokeJoin(setup, {
        operationId: trackedFailureCase.operationId,
      });

      assert.equal(replay.statusCode, 500);
      assert.deepEqual(replay.body, response.body);
      assert.equal(activeHarness.transactionRuns, transactionRuns);
      assert.deepEqual(
        activeHarness.state.users.get(setup.userId),
        originalUser,
      );
      assert.deepEqual(
        activeHarness.state.memberships.get(
          membershipKey(setup.sharedFirmId, setup.userId),
        ),
        originalMembership,
      );
    });
  }

  await test("stale non-owner removed owner rejoins as member", async () => {
    const setup = sharedHealingSeed("ADMIN");
    setup.seed.users[0].firmId = setup.personalFirmId;
    setup.seed.memberships[0].status = "ACTIVE";
    const sharedMembership = setup.seed.memberships.find(
      (membership) => membership.firmId === setup.sharedFirmId,
    );
    sharedMembership.role = "OWNER";
    const sharedFirm = setup.seed.firms.find(
      (firm) => firm._id === setup.sharedFirmId,
    );
    sharedFirm.joinCode = "JOIN123";
    sharedFirm.sharingEnabled = true;
    activeHarness = createHarness(setup.seed);

    const response = await invoke(joinFirmByCode, {
      user: { id: setup.userId, tokenVersion: 2 },
      params: {},
      body: { joinCode: "join123" },
    });

    assert.equal(response.statusCode, 200);
    const membership = activeHarness.state.memberships.get(
      membershipKey(setup.sharedFirmId, setup.userId),
    );
    const user = activeHarness.state.users.get(setup.userId);
    assert.equal(membership.status, "ACTIVE");
    assert.equal(membership.role, "MEMBER");
    assert.equal(user.firmId, setup.sharedFirmId);
    assert.equal(user.role, "USER");
    assert.equal(response.body.workspace.role, "MEMBER");
    assert.equal(response.body.user.role, "USER");
  });

  await test("actual firm owner rejoins as owner", async () => {
    const setup = sharedHealingSeed("OWNER");
    setup.seed.users[0].firmId = setup.personalFirmId;
    setup.seed.memberships[0].status = "ACTIVE";
    const sharedFirm = setup.seed.firms.find(
      (firm) => firm._id === setup.sharedFirmId,
    );
    sharedFirm.joinCode = "JOIN123";
    sharedFirm.sharingEnabled = true;
    activeHarness = createHarness(setup.seed);

    const response = await invoke(joinFirmByCode, {
      user: { id: setup.userId, tokenVersion: 2 },
      params: {},
      body: { joinCode: "join123" },
    });

    assert.equal(response.statusCode, 200);
    const membership = activeHarness.state.memberships.get(
      membershipKey(setup.sharedFirmId, setup.userId),
    );
    const user = activeHarness.state.users.get(setup.userId);
    assert.equal(membership.status, "ACTIVE");
    assert.equal(membership.role, "OWNER");
    assert.equal(user.firmId, setup.sharedFirmId);
    assert.equal(user.role, "FIRM_ADMIN");
    assert.equal(response.body.workspace.role, "OWNER");
    assert.equal(response.body.user.role, "FIRM_ADMIN");
  });

  await test("already-active admin valid join stays admin and clears stale personal marker", async () => {
    const setup = sharedHealingSeed("ADMIN");
    setup.seed.users[0].firmId = setup.personalFirmId;
    setup.seed.users[0].personalFirmId = setup.sharedFirmId;
    setup.seed.memberships.forEach((membership) => {
      membership.status = "ACTIVE";
    });
    setup.seed.memberships.find(
      (membership) => membership.firmId === setup.sharedFirmId,
    ).isPersonal = true;
    const sharedFirm = setup.seed.firms.find(
      (firm) => firm._id === setup.sharedFirmId,
    );
    sharedFirm.joinCode = "JOIN123";
    sharedFirm.sharingEnabled = true;
    activeHarness = createHarness(setup.seed);

    const response = await invoke(joinFirmByCode, {
      user: { id: setup.userId, tokenVersion: 2 },
      params: {},
      body: { joinCode: "join123" },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.alreadyMember, true);
    const membership = activeHarness.state.memberships.get(
      membershipKey(setup.sharedFirmId, setup.userId),
    );
    const user = activeHarness.state.users.get(setup.userId);
    assert.equal(membership.status, "ACTIVE");
    assert.equal(membership.role, "ADMIN");
    assert.equal(membership.isPersonal, false);
    assert.equal(user.firmId, setup.sharedFirmId);
    assert.equal(user.role, "FIRM_ADMIN");
    assert.equal(response.body.workspace.role, "ADMIN");
    assert.equal(response.body.user.role, "FIRM_ADMIN");
  });

  await test("actual firm owner cannot leave members behind when membership role drifted", async () => {
    const setup = sharedHealingSeed("OWNER");
    setup.seed.memberships.forEach((membership) => {
      membership.status = "ACTIVE";
    });
    setup.seed.memberships.find(
      (membership) => membership.firmId === setup.sharedFirmId,
    ).role = "MEMBER";
    setup.seed.memberships.push({
      _id: "other-active-membership",
      userId: "other-active-user",
      firmId: setup.sharedFirmId,
      role: "MEMBER",
      status: "ACTIVE",
      isPersonal: false,
    });
    activeHarness = createHarness(setup.seed);
    const before = snapshotState(activeHarness.state);

    const response = await invoke(leaveFirm, {
      user: { id: setup.userId },
      params: { firmId: setup.sharedFirmId },
      body: {},
    });

    assert.equal(response.statusCode, 409);
    assert.equal(
      response.body.error,
      "Transfer ownership before leaving this firm",
    );
    assert.deepEqual(snapshotState(activeHarness.state), before);
    const firmRead = activeHarness.sessionEvents.find(
      (event) => event.label === "Firm.findById",
    );
    assert.ok(firmRead);
    assert.equal(firmRead.session, activeHarness.lastSession);
    assert.equal(activeHarness.transactionRollbacks, 1);
    assertTransactionDiscipline(activeHarness);
  });

  await test("stale OWNER membership does not block a non-owner from leaving", async () => {
    const setup = sharedHealingSeed("ADMIN");
    setup.seed.memberships.forEach((membership) => {
      membership.status = "ACTIVE";
    });
    setup.seed.memberships.find(
      (membership) => membership.firmId === setup.sharedFirmId,
    ).role = "OWNER";
    setup.seed.memberships.push({
      _id: "actual-owner-membership",
      userId: "owner-user",
      firmId: setup.sharedFirmId,
      role: "OWNER",
      status: "ACTIVE",
      isPersonal: false,
    });
    activeHarness = createHarness(setup.seed);

    const response = await invoke(leaveFirm, {
      user: { id: setup.userId },
      params: { firmId: setup.sharedFirmId },
      body: {},
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {
      ok: true,
      activeWorkspace: {
        id: setup.personalFirmId,
        displayName: "Personal",
        handle: "personal",
        kind: "PERSONAL",
        isPersonal: true,
        role: "OWNER",
        memberCount: 1,
        joinCode: undefined,
        sharingEnabled: true,
        memberAccess: "EDIT",
        isActive: true,
      },
    });
    assert.equal(
      activeHarness.state.memberships.get(
        membershipKey(setup.sharedFirmId, setup.userId),
      ).status,
      "REMOVED",
    );
    assert.equal(
      activeHarness.state.users.get(setup.userId).firmId,
      setup.personalFirmId,
    );
    const firmRead = activeHarness.sessionEvents.find(
      (event) => event.label === "Firm.findById",
    );
    assert.ok(firmRead);
    assert.equal(firmRead.session, activeHarness.lastSession);
    assertNoPostCommitReads(activeHarness);
    assert.equal(activeHarness.transactionCommits, 1);
    assertTransactionDiscipline(activeHarness);
  });

  await test("SHARED owner self-leave is 409 even with zero other members", async () => {
    const setup = sharedHealingSeed("OWNER");
    setup.seed.memberships.forEach((membership) => {
      membership.status = "ACTIVE";
    });
    activeHarness = createHarness(setup.seed);
    const before = snapshotState(activeHarness.state);

    const response = await invoke(leaveFirm, {
      user: { id: setup.userId },
      params: { firmId: setup.sharedFirmId },
      body: {},
    });

    assert.equal(response.statusCode, 409);
    assert.deepEqual(response.body, {
      ok: false,
      error: "Transfer ownership before leaving this firm",
    });
    assert.deepEqual(snapshotState(activeHarness.state), before);
    assert.equal(
      activeHarness.readEvents.some(
        (event) => event.label === "FirmMembership.countDocuments",
      ),
      false,
    );
    assert.equal(activeHarness.transactionCommits, 0);
    assert.equal(activeHarness.transactionRollbacks, 1);
    assertTransactionDiscipline(activeHarness);
  });

  function ownerRemovalSeed() {
    const ownerId = "owner-user";
    const targetId = "target-user";
    const sharedFirmId = "firm-shared";
    const targetPersonalFirmId = "target-personal";
    return {
      ownerId,
      targetId,
      sharedFirmId,
      targetPersonalFirmId,
      seed: {
        users: [
          {
            _id: ownerId,
            firmId: sharedFirmId,
            role: "FIRM_ADMIN",
            accountType: "FIRM_USER",
            isActive: true,
            tokenVersion: 0,
          },
          {
            _id: targetId,
            firmId: targetPersonalFirmId,
            personalFirmId: targetPersonalFirmId,
            role: "FIRM_ADMIN",
            accountType: "FIRM_USER",
            isActive: true,
            tokenVersion: 4,
          },
        ],
        firms: [
          {
            _id: sharedFirmId,
            ownerUserId: ownerId,
            displayName: "Shared",
            handle: "shared",
            kind: "SHARED",
            isActive: true,
          },
          {
            _id: targetPersonalFirmId,
            ownerUserId: targetId,
            displayName: "Target Personal",
            handle: "target-personal",
            kind: "PERSONAL",
            isActive: true,
          },
        ],
        memberships: [
          {
            _id: "owner-membership",
            userId: ownerId,
            firmId: sharedFirmId,
            role: "OWNER",
            status: "ACTIVE",
            isPersonal: false,
          },
          {
            _id: "target-membership",
            userId: targetId,
            firmId: sharedFirmId,
            role: "MEMBER",
            status: "ACTIVE",
            isPersonal: false,
          },
          {
            _id: "target-personal-membership",
            userId: targetId,
            firmId: targetPersonalFirmId,
            role: "OWNER",
            status: "ACTIVE",
            isPersonal: true,
          },
        ],
      },
    };
  }

  await test("owner removal revokes target active in another workspace", async () => {
    const setup = ownerRemovalSeed();
    activeHarness = createHarness(setup.seed);

    const response = await invoke(deleteFirmUser, {
      user: { id: setup.ownerId },
      params: { firmId: setup.sharedFirmId, userId: setup.targetId },
      body: {},
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {
      ok: true,
      firm: {
        id: setup.sharedFirmId,
        displayName: "Shared",
        handle: "shared",
      },
      users: [
        {
          _id: setup.ownerId,
          role: "FIRM_ADMIN",
          accountType: "FIRM_USER",
          isActive: true,
          membershipRole: "OWNER",
        },
      ],
    });
    assertNoPostCommitReads(activeHarness);
    const target = activeHarness.state.users.get(setup.targetId);
    assert.equal(target.firmId, setup.targetPersonalFirmId);
    assert.equal(target.role, "FIRM_ADMIN");
    assert.equal(target.accountType, "FIRM_USER");
    assert.equal(target.tokenVersion, 5);
    assert.equal(
      activeHarness.state.memberships.get(
        membershipKey(setup.sharedFirmId, setup.targetId),
      ).status,
      "REMOVED",
    );
    assertTransactionDiscipline(activeHarness);
  });

  for (const projectionRead of ["FirmMembership.find", "User.find"]) {
    await test(`member-list ${projectionRead} failure rolls back removal authority mutations`, async () => {
      const setup = ownerRemovalSeed();
      activeHarness = createHarness(setup.seed, {
        failOnRead: projectionRead,
      });
      const before = snapshotState(activeHarness.state);

      await assert.rejects(
        invoke(deleteFirmUser, {
          user: { id: setup.ownerId },
          params: {
            firmId: setup.sharedFirmId,
            userId: setup.targetId,
          },
          body: {},
        }),
        (error) =>
          error.message === `Injected read failure at ${projectionRead}`,
      );

      assert.deepEqual(snapshotState(activeHarness.state), before);
      assert.equal(activeHarness.transactionCommits, 0);
      assert.equal(activeHarness.transactionRollbacks, 1);
      assertFailedReadInTransaction(activeHarness, projectionRead);
      assertTransactionDiscipline(activeHarness);
    });
  }

  for (const actorMembershipCase of [
    {
      label: "missing actor membership",
      arrange(setup) {
        setup.seed.memberships = setup.seed.memberships.filter(
          (membership) => membership.userId !== setup.ownerId,
        );
      },
    },
    {
      label: "REMOVED OWNER actor membership",
      arrange(setup) {
        setup.seed.memberships.find(
          (membership) => membership.userId === setup.ownerId,
        ).status = "REMOVED";
      },
    },
    {
      label: "ACTIVE MEMBER actor membership",
      arrange(setup) {
        setup.seed.memberships.find(
          (membership) => membership.userId === setup.ownerId,
        ).role = "MEMBER";
      },
    },
    {
      label: "ACTIVE ADMIN actor membership",
      arrange(setup) {
        setup.seed.memberships.find(
          (membership) => membership.userId === setup.ownerId,
        ).role = "ADMIN";
      },
    },
  ]) {
    await test(`member removal rejects matching owner pointer with ${actorMembershipCase.label}`, async () => {
      const setup = ownerRemovalSeed();
      actorMembershipCase.arrange(setup);
      activeHarness = createHarness(setup.seed);
      const before = snapshotState(activeHarness.state);

      await assert.rejects(
        invoke(deleteFirmUser, {
          user: { id: setup.ownerId },
          params: {
            firmId: setup.sharedFirmId,
            userId: setup.targetId,
          },
          body: {},
        }),
        (error) =>
          error.statusCode === 403 &&
          error.message === "Not authorized for this firm" &&
          error.forwardToErrorMiddleware === true,
      );

      assert.deepEqual(snapshotState(activeHarness.state), before);
      assert.equal(activeHarness.transactionCommits, 0);
      assert.equal(activeHarness.transactionRollbacks, 1);
      assertTransactionDiscipline(activeHarness);
    });
  }

  for (const authorityCase of [
    {
      name: "missing firm authority error uses global middleware",
      statusCode: 404,
      message: "Firm not found",
      arrange(setup) {
        setup.seed.firms = [];
      },
    },
    {
      name: "inactive owner cannot remove a member",
      statusCode: 403,
      message: "Account is inactive",
      arrange(setup) {
        setup.seed.users[0].isActive = false;
      },
    },
    {
      name: "active non-owner cannot remove a member",
      statusCode: 403,
      message: "Not authorized for this firm",
      arrange(setup) {
        setup.seed.firms[0].ownerUserId = "different-owner";
      },
    },
  ]) {
    await test(authorityCase.name, async () => {
      const setup = ownerRemovalSeed();
      authorityCase.arrange(setup);
      activeHarness = createHarness(setup.seed);
      const before = snapshotState(activeHarness.state);

      await assert.rejects(
        invoke(deleteFirmUser, {
          user: { id: setup.ownerId },
          params: { firmId: setup.sharedFirmId, userId: setup.targetId },
          body: {},
        }),
        (error) =>
          error.statusCode === authorityCase.statusCode &&
          error.message === authorityCase.message &&
          error.forwardToErrorMiddleware === true,
      );

      assert.deepEqual(snapshotState(activeHarness.state), before);
      assert.equal(activeHarness.transactionCommits, 0);
      assert.equal(activeHarness.transactionRollbacks, 1);
      assertTransactionDiscipline(activeHarness);
    });
  }

  const { listFirmUsers, rotateJoinCode, updateFirm } =
    await import("../src/controllers/firm.controller.js");

  await test("owner user list follows ACTIVE memberships and preserves selected user shape", async () => {
    const ownerId = "owner-user";
    const activeElsewhereId = "active-elsewhere";
    const suspendedId = "suspended-user";
    const removedId = "removed-user";
    const noMembershipId = "no-membership-user";
    const firmId = "firm-shared";
    const ownerCreatedAt = "2026-01-03T00:00:00.000Z";
    const activeCreatedAt = "2026-01-01T00:00:00.000Z";
    const suspendedCreatedAt = "2026-01-02T00:00:00.000Z";
    activeHarness = createHarness({
      users: [
        {
          _id: ownerId,
          email: "owner@example.test",
          name: "Owner",
          firmId,
          role: "FIRM_ADMIN",
          accountType: "FIRM_USER",
          createdAt: ownerCreatedAt,
          isActive: true,
          tokenVersion: 0,
        },
        {
          _id: activeElsewhereId,
          email: "elsewhere@example.test",
          name: "Active Elsewhere",
          firmId: "different-active-workspace",
          role: "USER",
          accountType: "FIRM_USER",
          createdAt: activeCreatedAt,
          isActive: true,
          tokenVersion: 0,
        },
        {
          _id: suspendedId,
          email: "suspended@example.test",
          name: "Suspended",
          firmId,
          role: "USER",
          accountType: "FIRM_USER",
          createdAt: suspendedCreatedAt,
          isActive: false,
          tokenVersion: 1,
        },
        {
          _id: removedId,
          email: "removed@example.test",
          name: "Removed",
          firmId,
          role: "USER",
          accountType: "FIRM_USER",
          createdAt: "2026-01-04T00:00:00.000Z",
          isActive: true,
        },
        {
          _id: noMembershipId,
          email: "stale@example.test",
          name: "Stale Pointer",
          firmId,
          role: "USER",
          accountType: "FIRM_USER",
          createdAt: "2026-01-05T00:00:00.000Z",
          isActive: true,
        },
      ],
      firms: [
        {
          _id: firmId,
          ownerUserId: ownerId,
          displayName: "Shared",
          handle: "shared",
          kind: "SHARED",
          isActive: true,
        },
      ],
      memberships: [
        {
          _id: "membership-owner",
          userId: ownerId,
          firmId,
          role: "OWNER",
          status: "ACTIVE",
          isPersonal: false,
        },
        {
          _id: "membership-active-elsewhere",
          userId: activeElsewhereId,
          firmId,
          role: "MEMBER",
          status: "ACTIVE",
          isPersonal: false,
        },
        {
          _id: "membership-suspended",
          userId: suspendedId,
          firmId,
          role: "MEMBER",
          status: "ACTIVE",
          isPersonal: false,
        },
        {
          _id: "membership-removed",
          userId: removedId,
          firmId,
          role: "MEMBER",
          status: "REMOVED",
          isPersonal: false,
        },
      ],
    });

    const response = await invoke(listFirmUsers, {
      user: { id: ownerId },
      params: { firmId },
      body: {},
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(Object.keys(response.body).sort(), [
      "firm",
      "ok",
      "users",
    ]);
    assert.deepEqual(response.body.firm, {
      id: firmId,
      displayName: "Shared",
      handle: "shared",
    });
    assert.deepEqual(response.body.users, [
      {
        _id: ownerId,
        email: "owner@example.test",
        name: "Owner",
        role: "FIRM_ADMIN",
        accountType: "FIRM_USER",
        createdAt: ownerCreatedAt,
        isActive: true,
      },
      {
        _id: activeElsewhereId,
        email: "elsewhere@example.test",
        name: "Active Elsewhere",
        role: "USER",
        accountType: "FIRM_USER",
        createdAt: activeCreatedAt,
        isActive: true,
      },
      {
        _id: suspendedId,
        email: "suspended@example.test",
        name: "Suspended",
        role: "USER",
        accountType: "FIRM_USER",
        createdAt: suspendedCreatedAt,
        isActive: false,
      },
    ]);
  });

  await test("workspace list hides PERSONAL and legacy join codes but keeps SHARED ADMIN code", async () => {
    const previousFirmFind = Firm.find;
    const previousMembershipAggregate = FirmMembership.aggregate;
    Firm.find = (filter) =>
      query(activeHarness, "Firm.find", () =>
        [...activeHarness.state.firms.values()]
          .filter((item) => matchesFilter(item, filter))
          .map((item) => clone(item)),
      );
    FirmMembership.aggregate = async (pipeline) => {
      const matchStage = pipeline.find((stage) => stage.$match)?.$match || {};
      const counts = new Map();
      for (const membership of activeHarness.state.memberships.values()) {
        if (!matchesFilter(membership, matchStage)) continue;
        const firmId = id(membership.firmId);
        counts.set(firmId, (counts.get(firmId) || 0) + 1);
      }
      return [...counts].map(([firmId, count]) => ({ _id: firmId, count }));
    };

    const userId = "workspace-user";
    const personalFirmId = "firm-personal";
    const sharedFirmId = "firm-shared";
    const legacyFirmId = "firm-legacy";
    activeHarness = createHarness({
      users: [
        {
          _id: userId,
          firmId: sharedFirmId,
          personalFirmId,
          role: "FIRM_ADMIN",
          accountType: "FIRM_USER",
          isActive: true,
        },
      ],
      firms: [
        {
          _id: personalFirmId,
          ownerUserId: userId,
          displayName: "Personal",
          handle: "personal",
          kind: "PERSONAL",
          joinCode: "PERSON1",
          isActive: true,
        },
        {
          _id: sharedFirmId,
          ownerUserId: "shared-owner",
          displayName: "Shared",
          handle: "shared",
          kind: "SHARED",
          joinCode: "SHARED1",
          isActive: true,
        },
        {
          _id: legacyFirmId,
          ownerUserId: "legacy-owner",
          displayName: "Legacy",
          handle: "legacy",
          joinCode: "LEGACY1",
          isActive: true,
        },
      ],
      memberships: [
        {
          _id: "membership-personal",
          userId,
          firmId: personalFirmId,
          role: "OWNER",
          status: "ACTIVE",
          isPersonal: true,
        },
        {
          _id: "membership-shared",
          userId,
          firmId: sharedFirmId,
          role: "ADMIN",
          status: "ACTIVE",
          isPersonal: false,
        },
        {
          _id: "membership-legacy",
          userId,
          firmId: legacyFirmId,
          role: "ADMIN",
          status: "ACTIVE",
          isPersonal: false,
        },
      ],
    });

    try {
      const response = await invoke(listWorkspaces, {
        user: { id: userId },
        params: {},
        body: {},
      });
      const wire = JSON.parse(JSON.stringify(response.body));
      const byId = new Map(
        wire.workspaces.map((workspace) => [id(workspace.id), workspace]),
      );

      assert.equal(Object.hasOwn(byId.get(personalFirmId), "joinCode"), false);
      assert.equal(byId.get(sharedFirmId).joinCode, "SHARED1");
      assert.equal(Object.hasOwn(byId.get(legacyFirmId), "joinCode"), false);
    } finally {
      Firm.find = previousFirmFind;
      FirmMembership.aggregate = previousMembershipAggregate;
    }
  });

  function personalJoinCodeSeed() {
    const userId = "personal-owner";
    const firmId = "personal-firm";
    return {
      userId,
      firmId,
      seed: {
        users: [
          {
            _id: userId,
            email: "personal@example.test",
            name: "Personal Owner",
            firmId,
            personalFirmId: firmId,
            role: "FIRM_ADMIN",
            accountType: "FIRM_USER",
            isActive: true,
            tokenVersion: 0,
          },
        ],
        firms: [
          {
            _id: firmId,
            ownerUserId: userId,
            displayName: "Personal",
            handle: "personal",
            kind: "PERSONAL",
            joinCode: "PERSON1",
            isActive: true,
          },
        ],
        memberships: [
          {
            _id: "personal-owner-membership",
            userId,
            firmId,
            role: "OWNER",
            status: "ACTIVE",
            isPersonal: true,
          },
        ],
      },
    };
  }

  await test("getMyFirm hides PERSONAL join code in firm and workspace without mutation", async () => {
    const setup = personalJoinCodeSeed();
    activeHarness = createHarness(setup.seed);
    const before = snapshotState(activeHarness.state);

    const response = await invoke(getMyFirm, {
      user: { id: setup.userId },
      params: {},
      body: {},
    });
    const wire = JSON.parse(JSON.stringify(response.body));

    assert.equal(response.statusCode, 200);
    assert.equal(Object.hasOwn(wire.firm, "joinCode"), false);
    assert.equal(Object.hasOwn(wire.workspace, "joinCode"), false);
    assert.deepEqual(snapshotState(activeHarness.state), before);
    assert.equal(
      activeHarness.state.firms.get(setup.firmId).joinCode,
      "PERSON1",
    );
  });

  await test("owner firm serialization hides PERSONAL join code without mutation", async () => {
    const setup = personalJoinCodeSeed();
    activeHarness = createHarness(setup.seed);
    const before = snapshotState(activeHarness.state);

    const response = await invoke(getFirmById, {
      user: { id: setup.userId },
      params: { firmId: setup.firmId },
      body: {},
    });
    const wire = JSON.parse(JSON.stringify(response.body));

    assert.equal(response.statusCode, 200);
    assert.equal(Object.hasOwn(wire.firm, "joinCode"), false);
    assert.deepEqual(snapshotState(activeHarness.state), before);
  });

  await test("hydrated legacy default does not count as persisted SHARED kind", async () => {
    const userId = "64b000000000000000000011";
    const firmId = "64b000000000000000000012";
    activeHarness = createHarness({
      users: [],
      firms: [
        {
          _id: firmId,
          ownerUserId: userId,
          displayName: "Legacy",
          handle: "legacy",
          joinCode: "LEGACY1",
          isActive: true,
        },
      ],
      memberships: [
        {
          _id: "legacy-owner-membership",
          userId,
          firmId,
          role: "OWNER",
          status: "ACTIVE",
          isPersonal: false,
        },
      ],
    });
    const legacyFirm = Firm.hydrate({
      _id: firmId,
      ownerUserId: userId,
      displayName: "Legacy",
      handle: "legacy",
      joinCode: "LEGACY1",
      isActive: true,
    });
    assert.equal(legacyFirm.kind, "SHARED");
    assert.equal(legacyFirm.$isDefault("kind"), true);
    const previousFindById = Firm.findById;
    Firm.findById = async () => legacyFirm;

    try {
      const response = await invoke(getFirmById, {
        user: { id: userId },
        params: { firmId },
        body: {},
      });
      const wire = JSON.parse(JSON.stringify(response.body));
      assert.equal(Object.hasOwn(wire.firm, "joinCode"), false);
      assert.equal(legacyFirm.joinCode, "LEGACY1");
    } finally {
      Firm.findById = previousFindById;
    }
  });

  await test("PERSONAL update response omits joinCode while retaining stored value", async () => {
    const setup = personalJoinCodeSeed();
    activeHarness = createHarness(setup.seed);

    const response = await invoke(updateFirm, {
      user: { id: setup.userId },
      params: { firmId: setup.firmId },
      body: { description: "Updated personal workspace" },
    });
    const wire = JSON.parse(JSON.stringify(response.body));

    assert.equal(response.statusCode, 200);
    assert.equal(Object.hasOwn(wire.firm, "joinCode"), false);
    assert.equal(
      activeHarness.state.firms.get(setup.firmId).joinCode,
      "PERSON1",
    );
    assert.equal(
      activeHarness.state.firms.get(setup.firmId).description,
      "Updated personal workspace",
    );
  });

  await test("PERSONAL join-code rotation response omits generated code", async () => {
    const setup = personalJoinCodeSeed();
    activeHarness = createHarness(setup.seed);
    const previousGenerateJoinCode = Firm.generateJoinCode;
    Firm.generateJoinCode = () => "ROTATE1";

    try {
      const response = await invoke(rotateJoinCode, {
        user: { id: setup.userId },
        params: { firmId: setup.firmId },
        body: {},
      });
      const wire = JSON.parse(JSON.stringify(response.body));

      assert.equal(response.statusCode, 200);
      assert.deepEqual(wire, { ok: true });
      assert.equal(
        activeHarness.state.firms.get(setup.firmId).joinCode,
        "ROTATE1",
      );
    } finally {
      Firm.generateJoinCode = previousGenerateJoinCode;
    }
  });
} finally {
  restorations.reverse().forEach((restore) => restore());
}

const failures = cases.filter((item) => !item.pass);
console.log(
  `\nResult: ${cases.length - failures.length} passed, ${failures.length} failed`,
);
process.exitCode = failures.length === 0 ? 0 : 1;
