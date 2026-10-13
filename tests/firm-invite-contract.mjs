// Firm invitations: codes, ceilings, expiry, caps, stats, and the elevation queue.
//
//   node capro-backend/tests/firm-invite-contract.mjs
//
// THE TWO THINGS THIS SUITE EXISTS FOR
// ------------------------------------
// 1. An invite is an ADMISSION CREDENTIAL for a compliance product. A code that is guessable, a
//    cap that can be beaten, an expiry that fails open, or a ceiling that can be raised by the
//    person redeeming it are all the same defect: somebody in a firm's statutory data who was
//    never admitted to it.
//
// 2. An ADMIN-ceiling invite must NEVER activate on redemption, and must NEVER touch User.role.
//    TASK-MANAGEMENT-DESIGN.md section 1.5: wiring a firm owner's invite to the account-level
//    FIRM_ADMIN grant would let a firm owner mint authority reaching beyond their own firm. The
//    two approval paths stay separate, and the last test in this file reads the controller source
//    to prove the boundary is not merely intended.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  firmInviteStatus,
  inviteShareBaseUrl,
  inviteShareUrl,
  isInviteRedeemable,
  resolveInviteGrant,
  serializeFirmInvite,
  validateInviteRequest,
} from "../src/services/firm-invite.service.js";
import { resolveAdmissionCode } from "../src/services/firm-admission.service.js";
import { CODE_ALPHABET, CODE_LENGTH } from "../src/models/FirmInvite.js";
import {
  highestInvitableRole,
  resolveFirmAuthority,
} from "../src/services/firm-authority.service.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const repoRoot = join(root, "..");

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

const NOW = new Date("2026-09-07T12:00:00.000Z");

// ---------------------------------------------------------------------------
// The code
// ---------------------------------------------------------------------------

await test("the code alphabet has exactly 32 characters, so the modulo is unbiased", () => {
  // 32 divides 256. generateCode does `randomBytes[i] % alphabet.length`, so at any other length
  // the low-index characters become more likely and the real keyspace shrinks. This is not
  // stylistic: it is the difference between 32^10 and something smaller by an unstated factor.
  assert.equal(CODE_ALPHABET.length, 32);
  assert.equal(256 % CODE_ALPHABET.length, 0);
});

await test("the alphabet excludes every character people transcribe wrongly", () => {
  for (const ambiguous of ["I", "O", "0", "1"]) {
    assert.equal(
      CODE_ALPHABET.includes(ambiguous),
      false,
      `${ambiguous} must not be in an alphabet for codes read aloud`,
    );
  }
  // No duplicates, or the modulo is biased toward whichever character repeats.
  assert.equal(new Set(CODE_ALPHABET).size, CODE_ALPHABET.length);
});

await test("a code fits the bounds every shipped client already enforces", () => {
  // THE CHECK THAT CAUGHT A REAL BREAK. The code was written as 12 characters first. The
  // extension is in production and validates before it submits, so a 12-character code was
  // refused in the tax-worker surface without a request ever reaching the server.
  //
  // Both bounds are READ from the clients rather than restated here, so widening one of them is
  // what changes this test -- a restated constant would agree with itself forever.
  const taxWorker = readFileSync(
    join(repoRoot, "audit-nlp-extension", "tax-worker.js"),
    "utf8",
  );
  const extensionBound = taxWorker.match(/\^\[A-Z0-9\]\{(\d+),(\d+)\}\$/);
  assert.ok(extensionBound, "the extension's join-code pattern has moved or changed shape");
  assert.ok(
    CODE_LENGTH >= Number(extensionBound[1]) &&
      CODE_LENGTH <= Number(extensionBound[2]),
    `CODE_LENGTH ${CODE_LENGTH} is outside the extension's ${extensionBound[1]}-${extensionBound[2]}`,
  );

  const desktop = readFileSync(
    join(
      repoRoot,
      "apps/desktop-native/src/CaPro.Desktop.Core/Models/FirmSettings.cs",
    ),
    "utf8",
  );
  const min = Number(desktop.match(/MinJoinCodeLength = (\d+)/)?.[1]);
  const max = Number(desktop.match(/MaxJoinCodeLength = (\d+)/)?.[1]);
  assert.ok(Number.isInteger(min) && Number.isInteger(max), "desktop bounds have moved");
  assert.ok(
    CODE_LENGTH >= min && CODE_LENGTH <= max,
    `CODE_LENGTH ${CODE_LENGTH} is outside the desktop's ${min}-${max}`,
  );

  // Every character must satisfy the extension's charset too, not just the length.
  assert.match(CODE_ALPHABET, /^[A-Z0-9]+$/);
});

await test("the keyspace is not guessable under the global rate limit", () => {
  // 200 requests per 15 minutes per IP (app.js globalLimiter). Stated as an assertion so that
  // shortening the code has to confront the number rather than a comment.
  //
  // Measured, not guessed: 32^10 = 1.126e15 codes, 7,008,000 attempts per year per IP, so about
  // 1.6e8 years to exhaust the space and half that for even odds. A first draft of this test
  // asserted 1e9 years and failed -- the assertion was wrong, not the code. A million years is
  // the bar, and it is met with a margin of 160.
  const keyspace = CODE_ALPHABET.length ** CODE_LENGTH;
  const perYear = (200 / 15) * 60 * 24 * 365;
  const years = keyspace / perYear;
  assert.ok(
    years > 1e6,
    `${keyspace} codes at ${perYear}/year is only ${years} years`,
  );
});

// ---------------------------------------------------------------------------
// Derived status. Never stored, so it cannot drift.
// ---------------------------------------------------------------------------

const live = { maxUses: null, usedCount: 0, expiresAt: null, revokedAt: null };

await test("a fresh uncapped invite with no expiry is LIVE", () => {
  assert.equal(firmInviteStatus(live, NOW), "LIVE");
  assert.equal(isInviteRedeemable(live, NOW), true);
});

await test("status precedence is REVOKED, then EXPIRED, then EXHAUSTED", () => {
  // All three conditions at once. The answer must not depend on which check ran first.
  const everything = {
    revokedAt: new Date("2026-09-01T00:00:00Z"),
    expiresAt: new Date("2026-09-02T00:00:00Z"),
    maxUses: 1,
    usedCount: 9,
  };
  assert.equal(firmInviteStatus(everything, NOW), "REVOKED");
  assert.equal(
    firmInviteStatus({ ...everything, revokedAt: null }, NOW),
    "EXPIRED",
  );
  assert.equal(
    firmInviteStatus({ ...everything, revokedAt: null, expiresAt: null }, NOW),
    "EXHAUSTED",
  );
});

await test("expiry is exclusive at its own instant", () => {
  // "Expires at 17:00" must not also mean "and at 17:00". An inclusive closing edge leaves an
  // admission window open for one more request.
  assert.equal(firmInviteStatus({ ...live, expiresAt: NOW }, NOW), "EXPIRED");
  assert.equal(
    firmInviteStatus({ ...live, expiresAt: new Date(NOW.getTime() + 1) }, NOW),
    "LIVE",
  );
  assert.equal(
    firmInviteStatus({ ...live, expiresAt: new Date(NOW.getTime() - 1) }, NOW),
    "EXPIRED",
  );
});

await test("a null cap is unlimited, not zero", () => {
  // Reading null as 0 would exhaust every uncapped invite instantly -- the same class of mistake
  // as showing a provisional total as 0.00.
  assert.equal(firmInviteStatus({ ...live, maxUses: null, usedCount: 9999 }, NOW), "LIVE");
  assert.equal(firmInviteStatus({ ...live, usedCount: 9999 }, NOW), "LIVE");
  // An absent field behaves the same as an explicit null.
  assert.equal(firmInviteStatus({ usedCount: 5 }, NOW), "LIVE");
});

await test("a cap is reached at equality, not one past it", () => {
  assert.equal(firmInviteStatus({ ...live, maxUses: 3, usedCount: 2 }, NOW), "LIVE");
  assert.equal(firmInviteStatus({ ...live, maxUses: 3, usedCount: 3 }, NOW), "EXHAUSTED");
  assert.equal(firmInviteStatus({ ...live, maxUses: 3, usedCount: 4 }, NOW), "EXHAUSTED");
  assert.equal(firmInviteStatus({ ...live, maxUses: 1, usedCount: 1 }, NOW), "EXHAUSTED");
});

await test("an absent invite is never LIVE", () => {
  // Fails closed. A caller that lost its document must not read that as permission.
  assert.equal(firmInviteStatus(null, NOW), "REVOKED");
  assert.equal(firmInviteStatus(undefined, NOW), "REVOKED");
  assert.equal(isInviteRedeemable(null, NOW), false);
});

// ---------------------------------------------------------------------------
// What redeeming grants
// ---------------------------------------------------------------------------

await test("an ADMIN ceiling grants MEMBER and leaves the elevation PENDING", () => {
  // The sharpest safety point in the design. A self-service path into an admin tier is exactly
  // the mistake worth proving cannot happen.
  assert.deepEqual(resolveInviteGrant("ADMIN"), {
    role: "MEMBER",
    requestedRole: "ADMIN",
    approvalState: "PENDING",
  });
});

await test("MEMBER and VIEWER ceilings activate immediately", () => {
  assert.deepEqual(resolveInviteGrant("MEMBER"), {
    role: "MEMBER",
    requestedRole: "MEMBER",
    approvalState: "NOT_REQUIRED",
  });
  assert.deepEqual(resolveInviteGrant("VIEWER"), {
    role: "VIEWER",
    requestedRole: "VIEWER",
    approvalState: "NOT_REQUIRED",
  });
});

await test("an OWNER or unreadable ceiling grants nothing at all", () => {
  // Returning null forces the caller to refuse. Falling back to MEMBER here would turn a
  // corrupted or future role value into a silent grant of firm write access.
  for (const value of ["OWNER", "SUPER_ADMIN", "FIRM_ADMIN", "", null, undefined, "member"]) {
    assert.equal(resolveInviteGrant(value), null, `resolveInviteGrant(${value})`);
  }
});

// ---------------------------------------------------------------------------
// Creating an invite: the ceiling comes from the caller, never from the body
// ---------------------------------------------------------------------------

const sharedFirm = {
  _id: "firm-a",
  ownerUserId: "owner-1",
  isActive: true,
  kind: "SHARED",
  memberAccess: "EDIT",
};
const ownerAuthority = resolveFirmAuthority({
  user: { id: "owner-1", role: "USER" },
  firm: sharedFirm,
  membership: { status: "ACTIVE", role: "OWNER" },
});
const adminAuthority = resolveFirmAuthority({
  user: { id: "admin-1", role: "USER" },
  firm: sharedFirm,
  membership: { status: "ACTIVE", role: "ADMIN" },
});
const memberAuthority = resolveFirmAuthority({
  user: { id: "member-1", role: "USER" },
  firm: sharedFirm,
  membership: { status: "ACTIVE", role: "MEMBER" },
});

await test("the ceiling defaults to MEMBER when the body names nothing", () => {
  for (const body of [{}, { grantsRole: undefined }, { grantsRole: null }, { grantsRole: "" }]) {
    const { value, error } = validateInviteRequest(body, {
      ceiling: highestInvitableRole(ownerAuthority),
      now: NOW,
    });
    assert.equal(error, undefined);
    assert.equal(value.grantsRole, "MEMBER", `body ${JSON.stringify(body)}`);
  }
});

await test("an owner may create an ADMIN invite; an admin may not", () => {
  const asOwner = validateInviteRequest(
    { grantsRole: "ADMIN" },
    { ceiling: highestInvitableRole(ownerAuthority), now: NOW },
  );
  assert.equal(asOwner.error, undefined);
  assert.equal(asOwner.value.grantsRole, "ADMIN");

  const asAdmin = validateInviteRequest(
    { grantsRole: "ADMIN" },
    { ceiling: highestInvitableRole(adminAuthority), now: NOW },
  );
  assert.match(asAdmin.error, /above your own/);
  assert.equal(asAdmin.value, undefined);
});

await test("an admin may still create MEMBER and VIEWER invites", () => {
  for (const role of ["MEMBER", "VIEWER"]) {
    const outcome = validateInviteRequest(
      { grantsRole: role },
      { ceiling: highestInvitableRole(adminAuthority), now: NOW },
    );
    assert.equal(outcome.error, undefined, `admin creating ${role}`);
    assert.equal(outcome.value.grantsRole, role);
  }
});

await test("an ordinary member may create no invite at all", () => {
  const outcome = validateInviteRequest(
    { grantsRole: "MEMBER" },
    { ceiling: highestInvitableRole(memberAuthority), now: NOW },
  );
  assert.match(outcome.error, /cannot create invites/);
});

await test("OWNER is refused as a ceiling however it is requested", () => {
  // The MESSAGE is asserted, not just the refusal, and that distinction is not cosmetic.
  //
  // Found by mutation: deleting the isInvitableRole check from validateInviteRequest SURVIVED an
  // earlier version of this test, because the ceiling comparison below it also refuses an
  // unknown role -- roleAtLeast returns false for anything off the ladder. The verdict was
  // identical; only the reason changed. Somebody requesting a role that does not exist was told
  // it was "above your own designation", which sends them to ask the owner for a promotion that
  // would not have helped.
  //
  // So a refusal is only checked when it names the right remedy.
  for (const role of ["OWNER", "owner", "SUPER_ADMIN", "ANYTHING", "Viewer"]) {
    const outcome = validateInviteRequest(
      { grantsRole: role },
      { ceiling: highestInvitableRole(ownerAuthority), now: NOW },
    );
    assert.match(
      outcome.error || "",
      /Choose a designation of Admin, Member or Viewer/,
      `${role} must be refused as unreadable, not as above the caller's tier`,
    );
    assert.equal(outcome.value, undefined);
  }

  // ... and the ceiling refusal keeps its own separate wording, for a role that IS real but is
  // above the caller. Two remedies, two sentences.
  assert.match(
    validateInviteRequest(
      { grantsRole: "ADMIN" },
      { ceiling: highestInvitableRole(adminAuthority), now: NOW },
    ).error,
    /above your own/,
  );
});

await test("a usage cap must be a whole number of at least one", () => {
  const ceiling = highestInvitableRole(ownerAuthority);
  for (const bad of [0, -1, 1.5, "two", Number.NaN, Infinity]) {
    const outcome = validateInviteRequest({ maxUses: bad }, { ceiling, now: NOW });
    assert.ok(outcome.error, `maxUses ${bad} must be refused`);
  }
  assert.equal(validateInviteRequest({ maxUses: 1 }, { ceiling, now: NOW }).value.maxUses, 1);
  // Absent means unlimited, matching what one firm-wide joinCode always did.
  for (const absent of [{}, { maxUses: null }, { maxUses: "" }]) {
    assert.equal(
      validateInviteRequest(absent, { ceiling, now: NOW }).value.maxUses,
      null,
    );
  }
});

await test("an expiry in the past is refused rather than accepted and dead", () => {
  const ceiling = highestInvitableRole(ownerAuthority);
  const past = validateInviteRequest(
    { expiresAt: "2026-09-06T00:00:00.000Z" },
    { ceiling, now: NOW },
  );
  assert.match(past.error, /must be in the future/);

  // Its own instant is also refused, matching the exclusive edge in firmInviteStatus. Accepting
  // it would hand somebody a code that was never going to work.
  assert.ok(
    validateInviteRequest({ expiresAt: NOW.toISOString() }, { ceiling, now: NOW }).error,
  );

  const unreadable = validateInviteRequest(
    { expiresAt: "not a date" },
    { ceiling, now: NOW },
  );
  assert.match(unreadable.error, /could not be read/);

  const future = validateInviteRequest(
    { expiresAt: "2026-12-31T00:00:00.000Z" },
    { ceiling, now: NOW },
  );
  assert.equal(future.error, undefined);
  assert.equal(future.value.expiresAt.toISOString(), "2026-12-31T00:00:00.000Z");
});

await test("a label is trimmed and bounded, never rejected", () => {
  const ceiling = highestInvitableRole(ownerAuthority);
  assert.equal(
    validateInviteRequest({ label: "  Audit team  " }, { ceiling, now: NOW }).value.label,
    "Audit team",
  );
  assert.equal(
    validateInviteRequest({ label: "x".repeat(500) }, { ceiling, now: NOW }).value.label
      .length,
    80,
  );
  assert.equal(validateInviteRequest({}, { ceiling, now: NOW }).value.label, "");
});

// ---------------------------------------------------------------------------
// What is shown: stats, and the link that must not be invented
// ---------------------------------------------------------------------------

await test("a share link is null when no base is configured", () => {
  // THE HONEST ANSWER, AND IT MUST STAY REACHABLE. There is no /join page on caprotoolkit.in and
  // the desktop registers no URI scheme, so a link built on a guess would be a dead link
  // presented as a way in.
  assert.equal(inviteShareBaseUrl({}), null);
  assert.equal(inviteShareUrl("ABCDEFGHJK", {}), null);
  assert.equal(
    serializeFirmInvite({ ...live, _id: "i1", code: "ABCDEFGHJK" }, { env: {}, now: NOW })
      .shareUrl,
    null,
  );
});

await test("a share link is https only", () => {
  // An invite code in a URL is an admission credential.
  assert.equal(inviteShareBaseUrl({ FIRM_INVITE_BASE_URL: "http://example.test" }), null);
  assert.equal(inviteShareBaseUrl({ FIRM_INVITE_BASE_URL: "not a url" }), null);
  assert.equal(
    inviteShareBaseUrl({ FIRM_INVITE_BASE_URL: "https://caprotoolkit.in/" }),
    "https://caprotoolkit.in",
  );
  assert.equal(
    inviteShareUrl("ABCDEFGHJK", { FIRM_INVITE_BASE_URL: "https://caprotoolkit.in" }),
    "https://caprotoolkit.in/join?code=ABCDEFGHJK",
  );
});

await test("stats are derived, so LIVE can never sit beside nothing remaining", () => {
  const view = serializeFirmInvite(
    {
      _id: "i1",
      code: "ABCDEFGHJK",
      grantsRole: "MEMBER",
      maxUses: 5,
      usedCount: 2,
      expiresAt: null,
      revokedAt: null,
      acceptances: [
        { userId: "u1", resultingRole: "MEMBER", approvalState: "NOT_REQUIRED" },
        { userId: "u2", resultingRole: "MEMBER", approvalState: "PENDING" },
        { userId: "u3", resultingRole: "ADMIN", approvalState: "APPROVED" },
      ],
    },
    { env: {}, now: NOW },
  );
  assert.equal(view.status, "LIVE");
  assert.equal(view.remainingUses, 3);
  assert.equal(view.usedCount, 2);
  assert.equal(view.pendingApprovals, 1);
  assert.equal(view.acceptances.length, 3);
  // An uncapped invite has no remaining count, and null must not be shown as a number.
  assert.equal(
    serializeFirmInvite({ ...live, _id: "i2", code: "C" }, { env: {}, now: NOW })
      .remainingUses,
    null,
  );
  // Never negative, even if usedCount ever overshot the cap.
  assert.equal(
    serializeFirmInvite(
      { _id: "i3", code: "C", maxUses: 2, usedCount: 7, acceptances: [] },
      { env: {}, now: NOW },
    ).remainingUses,
    0,
  );
});

// ---------------------------------------------------------------------------
// Resolving a typed code. The firm's own code must still win.
// ---------------------------------------------------------------------------

/** A findOne(...) that supports the optional .session() the resolver calls. */
function stubQuery(value) {
  const query = Promise.resolve(value);
  query.session = () => query;
  return query;
}
function stubModel(match) {
  return { findOne: (filter) => stubQuery(match(filter)) };
}

const inviteFirm = {
  _id: "firm-a",
  isActive: true,
  kind: "SHARED",
  displayName: "Test and Co",
};

await test("a firm's own join code still resolves first, and grants MEMBER", () => {
  // The order is what makes invites additive: every code that worked before resolves by the same
  // query, to the same firm, with the same grant, before any invite is considered.
  return resolveAdmissionCode("firmcd", {
    FirmModel: stubModel((filter) =>
      filter.joinCode === "FIRMCD" && filter.kind === "SHARED" ? inviteFirm : null,
    ),
    InviteModel: stubModel(() => {
      throw new Error("the invite collection must not be consulted for a firm join code");
    }),
    now: NOW,
  }).then((resolved) => {
    assert.equal(resolved.firm, inviteFirm);
    assert.equal(resolved.invite, null);
    assert.deepEqual(resolved.grant, {
      role: "MEMBER",
      requestedRole: "MEMBER",
      approvalState: "NOT_REQUIRED",
    });
  });
});

async function resolveWithInvite(invite, { firm = inviteFirm } = {}) {
  return resolveAdmissionCode("ABCDEFGHJK", {
    FirmModel: stubModel((filter) => (filter.joinCode ? null : firm)),
    InviteModel: stubModel(() => invite),
    now: NOW,
  });
}

await test("an invite code resolves to its firm and its grant", async () => {
  const resolved = await resolveWithInvite({
    _id: "i1",
    firmId: "firm-a",
    code: "ABCDEFGHJK",
    grantsRole: "VIEWER",
    ...live,
  });
  assert.equal(resolved.firm, inviteFirm);
  assert.equal(resolved.invite.code, "ABCDEFGHJK");
  assert.equal(resolved.grant.role, "VIEWER");
});

await test("an ADMIN invite resolves to a MEMBER grant with a pending elevation", async () => {
  const resolved = await resolveWithInvite({
    _id: "i1",
    firmId: "firm-a",
    code: "ABCDEFGHJK",
    grantsRole: "ADMIN",
    ...live,
  });
  assert.equal(resolved.grant.role, "MEMBER");
  assert.equal(resolved.grant.requestedRole, "ADMIN");
  assert.equal(resolved.grant.approvalState, "PENDING");
});

await test("each unusable invite is refused with its own remedy", async () => {
  const cases = [
    [{ revokedAt: NOW }, /revoked/],
    [{ expiresAt: new Date("2026-01-01T00:00:00Z") }, /expired/],
    [{ maxUses: 1, usedCount: 1 }, /maximum number of times/],
  ];
  for (const [overrides, expected] of cases) {
    await assert.rejects(
      resolveWithInvite({
        _id: "i1",
        firmId: "firm-a",
        code: "ABCDEFGHJK",
        grantsRole: "MEMBER",
        ...live,
        ...overrides,
      }),
      (error) => {
        assert.equal(error.statusCode, 403);
        assert.match(error.message, expected);
        return true;
      },
      `overrides ${JSON.stringify(overrides)}`,
    );
  }
});

await test("an unknown code is answered exactly as it was before invites existed", async () => {
  // A wrong guess must read identically whether or not invites are in play.
  await assert.rejects(
    resolveAdmissionCode("NOSUCHCODE", {
      FirmModel: stubModel(() => null),
      InviteModel: stubModel(() => null),
      now: NOW,
    }),
    (error) => {
      assert.equal(error.statusCode, 404);
      assert.equal(error.message, "Invalid or inactive join code");
      return true;
    },
  );
});

await test("an invite whose ceiling cannot be read fails closed", async () => {
  // Not defaulted to MEMBER. A corrupted or future role value must refuse, not grant.
  await assert.rejects(
    resolveWithInvite({
      _id: "i1",
      firmId: "firm-a",
      code: "ABCDEFGHJK",
      grantsRole: "OWNER",
      ...live,
    }),
    (error) => {
      assert.equal(error.statusCode, 403);
      assert.match(error.message, /could not be read/);
      return true;
    },
  );
});

await test("an invite into an inactive or non-shared firm is refused", async () => {
  for (const firm of [null, { ...inviteFirm, isActive: false }]) {
    await assert.rejects(
      resolveWithInvite(
        {
          _id: "i1",
          firmId: "firm-a",
          code: "ABCDEFGHJK",
          grantsRole: "MEMBER",
          ...live,
        },
        { firm },
      ),
      (error) => {
        assert.equal(error.statusCode, 404);
        return true;
      },
    );
  }
});

await test("an empty code is refused before any lookup", async () => {
  for (const code of ["", "   ", null, undefined, 42]) {
    await assert.rejects(
      resolveAdmissionCode(code, {
        FirmModel: stubModel(() => {
          throw new Error("no lookup should happen for an empty code");
        }),
        InviteModel: stubModel(() => null),
      }),
      (error) => {
        assert.equal(error.statusCode, 400);
        return true;
      },
      `code ${JSON.stringify(code)}`,
    );
  }
});

await test("a code is matched case-insensitively and untrimmed input is accepted", async () => {
  const resolved = await resolveAdmissionCode("  abcdefghjk \n", {
    FirmModel: stubModel((filter) => (filter.joinCode ? null : inviteFirm)),
    InviteModel: stubModel((filter) =>
      filter.code === "ABCDEFGHJK"
        ? { _id: "i1", firmId: "firm-a", code: "ABCDEFGHJK", grantsRole: "MEMBER", ...live }
        : null,
    ),
    now: NOW,
  });
  assert.equal(resolved.invite.code, "ABCDEFGHJK");
});

// ---------------------------------------------------------------------------
// The safety boundary, read from source
// ---------------------------------------------------------------------------

const inviteControllerSource = readFileSync(
  join(root, "src/controllers/firm-invite.controller.js"),
  "utf8",
);

/**
 * Source with comments removed.
 *
 * A forbidden-pattern scan must read CODE, not prose. The first draft of the ladder check below
 * failed against a comment in the controller that says `role === "OWNER"` must not appear -- the
 * prohibition matched the sentence stating it. A scan that a comment can trip is a scan that will
 * be silenced by rewording a comment, which is the opposite of a check.
 */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const inviteController = codeOnly(inviteControllerSource);

await test("the invite controller never writes User.role", async () => {
  // THE BOUNDARY. A firm owner grants firm-local authority only. If this ever fails, a firm owner
  // can mint account-level FIRM_ADMIN -- authority reaching into firms that are not theirs -- by
  // inviting somebody as an admin.
  //
  // Asserted against the source because there is no unit that can observe the absence of a write.
  for (const pattern of [
    /User\.updateOne/,
    /User\.updateMany/,
    /User\.findOneAndUpdate/,
    /User\.findByIdAndUpdate/,
  ]) {
    assert.equal(
      pattern.test(inviteController),
      false,
      `${pattern} appears in firm-invite.controller.js`,
    );
  }

  // Every `<something>.role =` assignment must be onto a membership. The receiver is CAPTURED
  // rather than excluded by a lookahead: a first draft used /\.role\s*=\s*(?!membership)/, which
  // inspects what follows the `=` instead of what precedes the `.role`, and so flagged the one
  // legitimate assignment in the file while it would have missed `user.role = "FIRM_ADMIN"`
  // entirely. An exclusion that does not look at the thing being excluded is not an exclusion.
  const assignments = [...inviteController.matchAll(/(\w+)\.role\s*=[^=]/g)].map(
    (match) => match[1],
  );
  assert.ok(assignments.length > 0, "the role-assignment scan matched nothing at all");
  assert.deepEqual(
    assignments.filter(
      (receiver) => receiver !== "membership" && receiver !== "targetMembership",
    ),
    [],
    `a role is assigned onto something other than a membership: ${assignments.join(", ")}`,
  );

  assert.equal(
    /FIRM_ADMIN/.test(inviteController),
    false,
    "the invite controller must not name the account-level FIRM_ADMIN grant in code",
  );
});

await test("the invite controller asks the accessor and never re-derives the ladder", () => {
  // A fourth copy of the ladder is exactly what firm-authority.service.js was written to prevent.
  assert.match(inviteController, /resolveFirmAuthority/);

  // THE CALLER's tier is authority and must come only from `authority`. Reading the TARGET's
  // tier -- targetMembership.role, the person being edited -- is data about somebody else and is
  // legitimate, which is why that variable is named apart from the caller's `membership`.
  for (const forbidden of [
    /\breq\.user\.role\s*===/,
    /\bauthority\.role\s*===/,
    /(^|[^t])\bmembership\.role\s*===/,
    /===\s*"SUPER_ADMIN"/,
    /===\s*"FIRM_ADMIN"/,
  ]) {
    assert.equal(
      forbidden.test(inviteController),
      false,
      `${forbidden} re-derives the caller's authority instead of asking the accessor`,
    );
  }

  // ... and the legitimate target read is still there, so the two owner-only edges in
  // setFirmMemberRole have not been quietly dropped to make this test pass.
  assert.match(inviteController, /targetMembership\.role === "ADMIN"/);
  assert.match(inviteController, /authority\.canManageAdmins/);
  assert.match(inviteController, /authority\.canInviteAdmins/);
});

await test("the comment stripper does not silently match nothing", () => {
  // The two checks above are only as good as codeOnly(). If stripping ever removed everything,
  // every forbidden pattern would pass and the boundary test would report a green nothing.
  assert.ok(
    inviteController.length > inviteControllerSource.length * 0.4,
    "codeOnly() removed more than half the file",
  );
  assert.match(inviteController, /export const createFirmInvite/);

  // It removes a line comment's CONTENT (whitespace left behind is fine and is not asserted),
  // removes a block comment, and leaves a URL's double slash alone.
  const stripped = codeOnly("a // secret\nc");
  assert.equal(/secret/.test(stripped), false);
  assert.match(stripped, /a\s*\nc/);
  assert.equal(/y/.test(codeOnly("x /* y */ z")), false);
  assert.match(codeOnly('const u = "https://x.test";'), /https:\/\/x\.test/);
});

await test("the invite routes declare fixed segments before parameterized ones", () => {
  // Express matches in order. "/:firmId/invites/:inviteId/revoke" declared before
  // "/:firmId/invites/pending" would capture "pending" as an invite id, and the approval queue
  // would 404 with nothing in the code looking wrong.
  const routes = readFileSync(join(root, "src/routes/firm.routes.js"), "utf8");
  const pendingAt = routes.indexOf('"/:firmId/invites/pending"');
  const inviteIdAt = routes.indexOf('"/:firmId/invites/:inviteId');
  const previewAt = routes.indexOf('"/invites/preview"');
  const firmIdAt = routes.indexOf('"/:firmId"');
  assert.ok(pendingAt > 0 && inviteIdAt > 0 && previewAt > 0 && firmIdAt > 0);
  assert.ok(pendingAt < inviteIdAt, "/invites/pending must precede /invites/:inviteId");
  assert.ok(previewAt < firmIdAt, "/invites/preview must precede /:firmId");
});

const failures = results.filter((item) => !item.pass);
const passed = results.length - failures.length;
console.log(
  `\nFirm invite contract: ${passed}/${results.length} passed, ${failures.length} failed`,
);
process.exitCode = failures.length === 0 ? 0 : 1;
