import assert from "node:assert/strict";
import { createWorkspaceOperationService } from "../src/services/workspace-operation.service.js";

const clone = (value) => structuredClone(value);

// Mongoose applies .select() before .lean(), so the fakes must too. A service
// that projects the wrong fields returns bare documents here instead of
// silently working, which is how the receipt-projection defect stayed hidden.
function query(load) {
  let projection = null;

  async function resolve() {
    const document = await load();
    if (!document) return null;
    if (!projection) return clone(document);

    const projected = {};
    if ("_id" in document) projected._id = clone(document._id);
    for (const field of projection) {
      if (field in document) projected[field] = clone(document[field]);
    }
    return projected;
  }

  const api = {
    select(fields) {
      projection = String(fields).split(/\s+/).filter(Boolean);
      return api;
    },
    lean: resolve,
    then: (onFulfilled, onRejected) => resolve().then(onFulfilled, onRejected),
  };
  return api;
}

class FakeOperationModel {
  constructor() {
    this.items = [];
    this.nextId = 1;
  }

  async create(value) {
    if (
      this.items.some(
        (item) =>
          item.userId === value.userId &&
          item.operationId === value.operationId,
      )
    ) {
      const error = new Error("duplicate");
      error.code = 11000;
      throw error;
    }
    const item = {
      ...clone(value),
      _id: String(this.nextId++),
      createdAt: new Date("2026-08-01T09:00:00.000Z"),
    };
    this.items.push(item);
    return clone(item);
  }

  findOne(filter) {
    return query(
      async () =>
        this.items.find(
          (item) =>
            item.userId === filter.userId &&
            item.operationId === filter.operationId,
        ) || null,
    );
  }

  async updateOne(filter, update) {
    const item = this.items.find(
      (candidate) =>
        candidate._id === String(filter._id) &&
        (!filter.status || candidate.status === filter.status),
    );
    if (!item) return { matchedCount: 0, modifiedCount: 0 };
    Object.assign(item, clone(update.$set || {}));
    return { matchedCount: 1, modifiedCount: 1 };
  }
}

class FakeUserModel {
  constructor() {
    this.users = new Map([
      [
        "user-a",
        {
          _id: "user-a",
          firmId: "firm-a",
          role: "USER",
          accountType: "FIRM_USER",
          isActive: true,
          tokenVersion: 0,
          workspaceOperationReceipts: [],
        },
      ],
      [
        "user-b",
        {
          _id: "user-b",
          firmId: "firm-b",
          role: "USER",
          accountType: "FIRM_USER",
          isActive: true,
          tokenVersion: 0,
          workspaceOperationReceipts: [],
        },
      ],
    ]);
  }

  findById(userId) {
    return query(async () => this.users.get(String(userId)) || null);
  }

  // Field matching follows MongoDB, not JavaScript truthiness: a document with
  // no tokenVersion field is matched by null, never by 0.
  matches(user, filter) {
    if (!user) return false;
    if (
      filter.isActive?.$ne !== undefined &&
      user.isActive === filter.isActive.$ne
    ) {
      return false;
    }
    if (filter.tokenVersion !== undefined) {
      const stored = "tokenVersion" in user ? user.tokenVersion : undefined;
      const allowed = Array.isArray(filter.tokenVersion?.$in)
        ? filter.tokenVersion.$in
        : [filter.tokenVersion];
      const matchesVersion = allowed.some((candidate) =>
        candidate === null ? stored === undefined : stored === candidate,
      );
      if (!matchesVersion) return false;
    }
    return true;
  }

  async findOneAndUpdate(filter, update) {
    const user = this.users.get(String(filter._id));
    if (!this.matches(user, filter)) return null;

    Object.assign(user, clone(update.$set || {}));
    const push = update.$push?.workspaceOperationReceipts;
    if (push) {
      user.workspaceOperationReceipts.push(...clone(push.$each));
      user.workspaceOperationReceipts = user.workspaceOperationReceipts.slice(
        push.$slice,
      );
    }
    return clone(user);
  }

  async updateOne(filter, update) {
    const user = this.users.get(String(filter._id));
    if (!user) return { matchedCount: 0, modifiedCount: 0 };
    const pull = update.$pull?.workspaceOperationReceipts;
    if (pull?.operationId) {
      user.workspaceOperationReceipts = user.workspaceOperationReceipts.filter(
        (item) => item.operationId !== pull.operationId,
      );
    }
    return { matchedCount: 1, modifiedCount: 1 };
  }
}

const operations = new FakeOperationModel();
const users = new FakeUserModel();
let tick = 0;
const service = createWorkspaceOperationService({
  OperationModel: operations,
  UserModel: users,
  now: () => new Date(Date.UTC(2026, 7, 1, 9, tick++, 0)),
});

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

const operationId = "0123456789abcdef0123456789abcdef";
const payload = { firmId: "firm-c" };
const switchChanges = { accountType: "FIRM_USER", role: "USER" };
let pendingClaim;

await test("legacy requests remain untracked when operationId is absent", async () => {
  const claim = await service.claim({
    userId: "user-a",
    kind: "SWITCH",
    payload,
  });
  assert.equal(claim.tracked, false);
  assert.equal(operations.items.length, 0);
});

await test("exact operation is durably pending before workspace mutation", async () => {
  pendingClaim = await service.claim({
    userId: "user-a",
    operationId,
    kind: "SWITCH",
    payload,
  });
  assert.equal(pendingClaim.isNew, true);
  const receipt = await service.statusFor("user-a", operationId);
  assert.equal(receipt.status, "PENDING");
  assert.equal(receipt.operationId, operationId);
  assert.equal(receipt.kind, "SWITCH");
});

await test("operation status is user-scoped", async () => {
  await assert.rejects(
    service.statusFor("user-b", operationId),
    (error) =>
      error.statusCode === 404 &&
      error.code === "WORKSPACE_OPERATION_NOT_FOUND",
  );
});

await test("operationId reuse with another payload is rejected", async () => {
  await assert.rejects(
    service.claim({
      userId: "user-a",
      operationId,
      kind: "SWITCH",
      payload: { firmId: "firm-d" },
    }),
    (error) =>
      error.statusCode === 409 && error.code === "WORKSPACE_OPERATION_REUSED",
  );
});

await test("retrying the same pending request replays its exact receipt", async () => {
  const replay = await service.claim({
    userId: "user-a",
    operationId,
    kind: "SWITCH",
    payload,
  });
  assert.equal(replay.isNew, false);
  assert.equal(replay.receipt.operationId, operationId);
  assert.equal(replay.receipt.status, "PENDING");
  assert.equal(replay.receipt.kind, "SWITCH");
});

await test("workspace selection cannot rewrite protected account fields", async () => {
  for (const field of ["isActive", "tokenVersion", "email"]) {
    await assert.rejects(
      service.succeed(pendingClaim, {
        userId: "user-a",
        activeFirmId: "firm-c",
        userChanges: { ...switchChanges, [field]: true },
      }),
      (error) => error instanceof TypeError && error.message.includes(field),
    );
  }
  assert.equal(users.users.get("user-a").firmId, "firm-a");
});

await test("a revoked session cannot commit a workspace change admitted earlier", async () => {
  await assert.rejects(
    service.succeed(pendingClaim, {
      userId: "user-a",
      activeFirmId: "firm-c",
      userChanges: switchChanges,
      expectedTokenVersion: 7,
    }),
    (error) =>
      error.statusCode === 409 &&
      error.code === "WORKSPACE_OPERATION_AUTHORITY_CHANGED",
  );
  assert.equal(users.users.get("user-a").firmId, "firm-a");
});

await test("a suspended account cannot commit a workspace change", async () => {
  users.users.get("user-a").isActive = false;
  await assert.rejects(
    service.succeed(pendingClaim, {
      userId: "user-a",
      activeFirmId: "firm-c",
      userChanges: switchChanges,
      expectedTokenVersion: 0,
    }),
    (error) =>
      error.statusCode === 409 &&
      error.code === "WORKSPACE_OPERATION_AUTHORITY_CHANGED" &&
      /no longer active/i.test(error.message) &&
      !/sign in again/i.test(error.message),
  );
  assert.equal(users.users.get("user-a").firmId, "firm-a");
  users.users.get("user-a").isActive = true;
});

await test("an account predating the tokenVersion field still commits", async () => {
  const legacyId = "1111111111111111aaaaaaaaaaaaaaaa";
  delete users.users.get("user-a").tokenVersion;
  const claim = await service.claim({
    userId: "user-a",
    operationId: legacyId,
    kind: "SWITCH",
    payload: { firmId: "firm-legacy" },
  });

  const completed = await service.succeed(claim, {
    userId: "user-a",
    activeFirmId: "firm-legacy",
    userChanges: switchChanges,
    expectedTokenVersion: 0,
  });

  assert.equal(completed.user.firmId, "firm-legacy");
  const receipt = await service.statusFor("user-a", legacyId);
  assert.equal(receipt.status, "SUCCEEDED");

  users.users.get("user-a").tokenVersion = 0;
  users.users.get("user-a").firmId = "firm-a";
});

await test("a revoked token version is refused even when the field is absent", async () => {
  const revokedId = "2222222222222222bbbbbbbbbbbbbbbb";
  delete users.users.get("user-a").tokenVersion;
  const claim = await service.claim({
    userId: "user-a",
    operationId: revokedId,
    kind: "SWITCH",
    payload: { firmId: "firm-revoked" },
  });

  await assert.rejects(
    service.succeed(claim, {
      userId: "user-a",
      activeFirmId: "firm-revoked",
      userChanges: switchChanges,
      expectedTokenVersion: 3,
    }),
    (error) =>
      error.statusCode === 409 &&
      error.code === "WORKSPACE_OPERATION_AUTHORITY_CHANGED" &&
      /signed out on the server/i.test(error.message),
  );
  assert.equal(users.users.get("user-a").firmId, "firm-a");
  users.users.get("user-a").tokenVersion = 0;
});

await test("delayed success atomically records active firm and terminal receipt", async () => {
  const completed = await service.succeed(pendingClaim, {
    userId: "user-a",
    activeFirmId: "firm-c",
    userChanges: switchChanges,
    expectedTokenVersion: 0,
  });
  assert.equal(completed.user.firmId, "firm-c");
  assert.equal(completed.user.isActive, true);
  const receipt = await service.statusFor("user-a", operationId);
  assert.equal(receipt.status, "SUCCEEDED");
  assert.equal(receipt.operationId, operationId);
  assert.equal(receipt.activeFirmId, "firm-c");
});

await test("same successful request replays its exact terminal receipt", async () => {
  const replay = await service.claim({
    userId: "user-a",
    operationId,
    kind: "SWITCH",
    payload,
  });
  assert.equal(replay.isNew, false);
  assert.equal(replay.receipt.status, "SUCCEEDED");
  assert.equal(replay.receipt.activeFirmId, "firm-c");
});

await test("rollback withdraws a committed receipt and reports rejection", async () => {
  const rolledBackId = "abcdef0123456789abcdef0123456789";
  const rollbackPayload = { firmId: "firm-e" };
  const claim = await service.claim({
    userId: "user-a",
    operationId: rolledBackId,
    kind: "SWITCH",
    payload: rollbackPayload,
  });
  await service.succeed(claim, {
    userId: "user-a",
    activeFirmId: "firm-e",
    userChanges: switchChanges,
    expectedTokenVersion: 0,
  });

  const receipt = await service.rollback(claim, {
    userId: "user-a",
    httpStatus: 409,
    message: "Membership changed before the switch completed",
  });

  assert.equal(receipt.status, "REJECTED");
  assert.equal(receipt.operationId, rolledBackId);
  assert.equal(receipt.error.httpStatus, 409);
  assert.equal(
    users.users
      .get("user-a")
      .workspaceOperationReceipts.some(
        (item) => item.operationId === rolledBackId,
      ),
    false,
  );
  const reread = await service.statusFor("user-a", rolledBackId);
  assert.equal(reread.status, "REJECTED");
});

await test("known rejection is terminal and bounded", async () => {
  const rejectedId = "fedcba9876543210fedcba9876543210";
  const claim = await service.claim({
    userId: "user-a",
    operationId: rejectedId,
    kind: "JOIN",
    payload: { joinCode: "INVALID" },
  });
  await service.reject(claim, 404, "x".repeat(500));
  const receipt = await service.statusFor("user-a", rejectedId);
  assert.equal(receipt.status, "REJECTED");
  assert.equal(receipt.operationId, rejectedId);
  assert.equal(receipt.error.httpStatus, 404);
  assert.equal(receipt.error.message.length, 300);
});

const failures = cases.filter((item) => !item.pass);
console.log(
  `\nResult: ${cases.length - failures.length} passed, ${failures.length} failed`,
);
process.exitCode = failures.length === 0 ? 0 : 1;
