// tests/engagement-reviewer-authorization-contract.mjs
//
// Ledger task R15 (.kiro/finalreleasefix.md, R8's live-gate follow-up). createEngagement's
// assertReviewerRole required the reviewer's global User.role to be exactly "FIRM_ADMIN" -- a
// formal, super-admin-approved designation entirely separate from a firm's own membership role
// (FirmMembership.role: OWNER/ADMIN/MEMBER) and from the account-level SUPER_ADMIN role. A brand
// new firm has no member who could ever pass that check, and the desktop app has no UI anywhere
// to request or grant FIRM_ADMIN, so no firm created through the product could ever create an
// engagement. Confirmed live: creating a real engagement in a real throwaway firm, with the
// firm's own owner (and separately a SUPER_ADMIN account) as reviewer, was refused both times
// with ENGAGEMENT_REVIEWER_ROLE_REQUIRED.
//
// assertReviewerRole now also accepts a reviewer whose FirmMembership.role for the engagement's
// own firm is OWNER or ADMIN -- the same authority the app already trusts a firm's owner/admin
// with elsewhere (removing a member, rotating the join code). The formal FIRM_ADMIN account role
// stays valid too, for a firm that has one; an ordinary MEMBER is still refused.
//
// Exercises the real, unmodified createEngagement (not a copy, and not the unexported
// assertReviewerRole directly -- this file's whole dependency graph is a private implementation
// detail this codebase does not export for testing, matching the established convention already
// used for this exact service in this file's own sibling contract tests). Monkey-patches
// Engagement/Client/User/FirmMembership/AppConfig/ActivityEvent statics and
// ActivityEvent.prototype.save, matching the pattern already used for directly-imported
// Mongoose models elsewhere in this suite (tests/case-verified-references-contract.mjs,
// tests/task-date-contract.mjs) -- no live database needed.

import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV || "development";
process.env.JWT_SECRET = process.env.JWT_SECRET || "local-verification-only";
process.env.MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/capro-engagement-reviewer-check";

const { default: Engagement } = await import("../src/models/Engagement.js");
const { default: Client } = await import("../src/models/Client.js");
const { default: User } = await import("../src/models/User.js");
const { default: FirmMembership } = await import("../src/models/FirmMembership.js");
const { default: AppConfig } = await import("../src/models/AppConfig.js");
const { default: ActivityEvent } = await import("../src/models/ActivityEvent.js");
const { createEngagement } = await import("../src/services/engagement.service.js");

const FIRM = "670bbb11bb22cc33dd44ff01";
const CLIENT = "670bbb11bb22cc33dd44ff02";
const ACTOR = "670bbb11bb22cc33dd44ff03";
const REVIEWER_PLAIN_MEMBER = "670bbb11bb22cc33dd44ff04";
const REVIEWER_OWNER = "670bbb11bb22cc33dd44ff05";
const REVIEWER_ADMIN = "670bbb11bb22cc33dd44ff06";
const REVIEWER_GLOBAL_FIRM_ADMIN = "670bbb11bb22cc33dd44ff07";

const USERS = new Map([
  [ACTOR, { _id: ACTOR, name: "Acting User", email: "actor@example.test", role: "USER" }],
  [REVIEWER_PLAIN_MEMBER, { _id: REVIEWER_PLAIN_MEMBER, name: "Plain Member", email: "member@example.test", role: "USER" }],
  [REVIEWER_OWNER, { _id: REVIEWER_OWNER, name: "Firm Owner", email: "owner@example.test", role: "USER" }],
  [REVIEWER_ADMIN, { _id: REVIEWER_ADMIN, name: "Firm Admin Member", email: "admin@example.test", role: "USER" }],
  [REVIEWER_GLOBAL_FIRM_ADMIN, { _id: REVIEWER_GLOBAL_FIRM_ADMIN, name: "Global Firm Admin", email: "fa@example.test", role: "FIRM_ADMIN" }],
]);

const MEMBERSHIPS = new Map([
  [REVIEWER_PLAIN_MEMBER, "MEMBER"],
  [REVIEWER_OWNER, "OWNER"],
  [REVIEWER_ADMIN, "ADMIN"],
  [REVIEWER_GLOBAL_FIRM_ADMIN, "MEMBER"],
]);

function chainable(result) {
  return { select: () => ({ lean: async () => result }) };
}

const originals = {
  engagementFindOne: Engagement.findOne,
  engagementCreate: Engagement.create,
  clientFindOne: Client.findOne,
  userFind: User.find,
  membershipFindOne: FirmMembership.findOne,
  appConfigAssertVersion: AppConfig.assertFeatureFlagVersion,
  activityFindOne: ActivityEvent.findOne,
  activitySave: ActivityEvent.prototype.save,
};

Engagement.findOne = async () => null;
Engagement.create = async (doc) => ({ ...doc, _id: "670bbb11bb22cc33dd44ffee" });

Client.findOne = (query) =>
  chainable(
    String(query?._id) === CLIENT && String(query?.firmId) === FIRM
      ? { _id: CLIENT, name: "Test Co", gstin: "", pan: "" }
      : null,
  );

User.find = (query) => {
  const ids = (query?._id?.$in ?? []).map(String);
  const matches = ids.map((id) => USERS.get(id)).filter(Boolean);
  return chainable(matches);
};

FirmMembership.findOne = (query) => {
  const role = MEMBERSHIPS.get(String(query?.userId));
  return chainable(
    role && String(query?.firmId) === FIRM && query?.status === "ACTIVE" ? { role } : null,
  );
};

AppConfig.assertFeatureFlagVersion = async () => ({
  enabled: true,
  version: 1,
  publicationFence: "",
});

ActivityEvent.findOne = () => chainable(null);
ActivityEvent.prototype.save = async function () {
  return this;
};

const publication = { version: 1, publicationFence: "", writeStarted: false };

let passed = 0;
let failed = 0;
const failures = [];

async function attemptCreate(reviewerUserId, mutationKeySuffix) {
  return createEngagement({
    firmId: FIRM,
    actorUserId: ACTOR,
    requestId: "req-" + mutationKeySuffix,
    publication: { ...publication },
    input: {
      mutationKey: "engagement-reviewer-check-" + mutationKeySuffix,
      clientId: CLIENT,
      engagementType: "STATUTORY_AUDIT",
      title: "Reviewer authorization check",
      scope: "Exercised only by this test.",
      targetDate: "2026-09-01",
      reviewerUserId,
    },
  });
}

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`[PASS] ${name}`);
  } catch (error) {
    failed += 1;
    failures.push(name);
    console.log(`[FAIL] ${name} — ${error.message}`);
  }
}

await check("an ordinary firm MEMBER reviewer is still refused", async () => {
  await assert.rejects(
    () => attemptCreate(REVIEWER_PLAIN_MEMBER, "member"),
    (error) => {
      assert.equal(error.code, "ENGAGEMENT_REVIEWER_ROLE_REQUIRED");
      assert.equal(error.statusCode, 400);
      return true;
    },
  );
});

await check("the firm's own OWNER is now accepted as reviewer", async () => {
  const engagement = await attemptCreate(REVIEWER_OWNER, "owner");
  assert.equal(engagement.reviewerUserId, REVIEWER_OWNER);
});

await check("the firm's own ADMIN is now accepted as reviewer", async () => {
  const engagement = await attemptCreate(REVIEWER_ADMIN, "admin");
  assert.equal(engagement.reviewerUserId, REVIEWER_ADMIN);
});

await check("a global FIRM_ADMIN reviewer is still accepted (no regression)", async () => {
  const engagement = await attemptCreate(REVIEWER_GLOBAL_FIRM_ADMIN, "global-firm-admin");
  assert.equal(engagement.reviewerUserId, REVIEWER_GLOBAL_FIRM_ADMIN);
});

Engagement.findOne = originals.engagementFindOne;
Engagement.create = originals.engagementCreate;
Client.findOne = originals.clientFindOne;
User.find = originals.userFind;
FirmMembership.findOne = originals.membershipFindOne;
AppConfig.assertFeatureFlagVersion = originals.appConfigAssertVersion;
ActivityEvent.findOne = originals.activityFindOne;
ActivityEvent.prototype.save = originals.activitySave;

console.log(`\nEngagement reviewer authorization contract: ${passed}/${passed + failed}`);
if (failed > 0) {
  console.error(`\n${failed} check(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
