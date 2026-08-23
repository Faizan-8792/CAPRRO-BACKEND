// tests/terms-acceptance-contract.mjs
// Verifies the canonical Terms document, desktop consent enforcement, legacy
// auth compatibility, receipt stability, and persistence deduplication without
// calling Google, MongoDB, or any other external service.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const WEB_CLIENT_ID = "web-client.apps.googleusercontent.com";
const DESKTOP_CLIENT_ID = "desktop-client.apps.googleusercontent.com";

process.env.NODE_ENV = process.env.NODE_ENV || "development";
process.env.JWT_SECRET = process.env.JWT_SECRET || "local-verification-only";
process.env.MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/capro-terms-check";
process.env.GOOGLE_CLIENT_ID = WEB_CLIENT_ID;
process.env.GOOGLE_DESKTOP_CLIENT_ID = DESKTOP_CLIENT_ID;
process.env.GOOGLE_DESKTOP_CLIENT_SECRET =
  process.env.GOOGLE_DESKTOP_CLIENT_SECRET || "local-placeholder";

const { OAuth2Client } = await import("google-auth-library");
const { default: User } = await import("../src/models/User.js");
const { default: Firm } = await import("../src/models/Firm.js");
const { default: FirmMembership } = await import(
  "../src/models/FirmMembership.js"
);
const { default: TermsAcceptance } = await import(
  "../src/models/TermsAcceptance.js"
);
const { CURRENT_TERMS } = await import("../src/config/current-terms.js");
const { recordCurrentTermsAcceptance } = await import(
  "../src/services/terms-acceptance.service.js"
);

const originals = {
  verifyIdToken: OAuth2Client.prototype.verifyIdToken,
  userFindOne: User.findOne,
  firmFindOne: Firm.findOne,
  membershipFindOne: FirmMembership.findOne,
  acceptanceFindOneAndUpdate: TermsAcceptance.findOneAndUpdate,
  acceptanceFindOne: TermsAcceptance.findOne,
};

const userId = "507f1f77bcf86cd799439011";
const personalFirmId = "507f1f77bcf86cd799439012";
const activeFirmId = "507f1f77bcf86cd799439013";
const acceptanceId = "507f1f77bcf86cd799439014";
const fixedAcceptedAt = new Date("2026-08-01T12:34:56.789Z");

const fakeUser = {
  _id: userId,
  email: "legacy.user@example.test",
  name: "Legacy User",
  role: "USER",
  accountType: "FIRM_USER",
  firmId: activeFirmId,
  personalFirmId,
  isActive: true,
  tokenVersion: 0,
  save: async () => fakeUser,
};

const personalFirm = {
  _id: personalFirmId,
  ownerUserId: userId,
  kind: "PERSONAL",
};
const activeFirm = {
  _id: activeFirmId,
  ownerUserId: "507f1f77bcf86cd799439099",
  kind: "SHARED",
};

let userLookupCount = 0;
let acceptanceUpserts = [];
let acceptanceFallbackCount = 0;
let duplicateRacePending = false;

OAuth2Client.prototype.verifyIdToken = async ({ idToken, audience }) => {
  assert.deepEqual(audience, [WEB_CLIENT_ID, DESKTOP_CLIENT_ID]);
  const isDesktopAudience = idToken === "desktop-id-token";
  return {
    getPayload: () => ({
      aud: isDesktopAudience ? DESKTOP_CLIENT_ID : WEB_CLIENT_ID,
      email: "legacy.user@example.test",
      email_verified: true,
      name: "Legacy User",
    }),
  };
};

User.findOne = async () => {
  userLookupCount += 1;
  return fakeUser;
};

Firm.findOne = (filter) => ({
  select: async () =>
    String(filter?._id) === personalFirmId ? personalFirm : activeFirm,
});

FirmMembership.findOne = async ({ firmId }) => ({
  status: "ACTIVE",
  role: String(firmId) === personalFirmId ? "OWNER" : "MEMBER",
  isPersonal: String(firmId) === personalFirmId,
  save: async () => undefined,
});

const persistedAcceptance = {
  _id: acceptanceId,
  userId,
  email: "legacy.user@example.test",
  termsVersion: CURRENT_TERMS.version,
  documentHash: CURRENT_TERMS.documentHash,
  source: "DESKTOP",
  acceptedAt: fixedAcceptedAt,
};

TermsAcceptance.findOneAndUpdate = (filter, update, options) => ({
  lean: async () => {
    acceptanceUpserts.push({ filter, update, options });
    if (duplicateRacePending) {
      duplicateRacePending = false;
      const error = new Error("duplicate key");
      error.code = 11000;
      throw error;
    }
    return persistedAcceptance;
  },
});

TermsAcceptance.findOne = () => ({
  lean: async () => {
    acceptanceFallbackCount += 1;
    return persistedAcceptance;
  },
});

const { default: app } = await import("../src/app.js");
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

async function request(path, { method = "GET", body } = {}) {
  const headers = { Connection: "close" };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(baseUrl + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

const failures = [];
let checkCount = 0;

async function check(name, verify) {
  checkCount += 1;
  try {
    await verify();
    console.log(`[PASS] ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`[FAIL] ${name}: ${error?.message || error}`);
  }
}

try {
  await check("canonical document hash recomputes from the published content", () => {
    const { documentHash, ...document } = CURRENT_TERMS;
    const recomputed = createHash("sha256")
      .update(JSON.stringify(document), "utf8")
      .digest("hex");

    assert.match(documentHash, /^[a-f0-9]{64}$/);
    assert.equal(documentHash, recomputed);
    // Pinned deliberately so a text edit cannot move the document without someone updating this
    // line. Bumped 2026-08-01 -> 2026-08-23 by L13, which named the counterparty, named Kolkata as
    // the forum, replaced the personal contact address, and added section 17 (grievance officer).
    assert.equal(CURRENT_TERMS.version, "2026-08-23");
    assert.equal(CURRENT_TERMS.effectiveDate, "2026-08-23");
    assert.equal(Object.isFrozen(CURRENT_TERMS), true);
    assert.equal(Object.isFrozen(CURRENT_TERMS.sections), true);
  });

  await check("current Terms route is public, mounted, and returns the canonical receipt", async () => {
    const { response, payload } = await request("/api/auth/terms/current");

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.terms.version, CURRENT_TERMS.version);
    assert.equal(payload.terms.documentHash, CURRENT_TERMS.documentHash);
    assert.ok(Array.isArray(payload.terms.sections));
    assert.ok(payload.terms.sections.length > 0);
    assert.match(response.headers.get("cache-control") || "", /max-age=300/);
  });

  await check("legacy OTP route remains mounted without desktop consent fields", async () => {
    const { response, payload } = await request("/api/auth/send-otp", {
      method: "POST",
      body: {},
    });

    assert.equal(response.status, 400);
    assert.equal(payload.ok, false);
    assert.match(String(payload.error), /email is required/i);
    assert.notEqual(payload.code, "TERMS_ACCEPTANCE_REQUIRED");
  });

  await check("legacy Google ID-token login remains successful without Terms payload", async () => {
    const upsertsBefore = acceptanceUpserts.length;
    const { response, payload } = await request("/api/auth/google", {
      method: "POST",
      body: { idToken: "legacy-id-token" },
    });

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.user.email, "legacy.user@example.test");
    assert.equal("termsAcceptanceReceipt" in payload, false);
    assert.equal(acceptanceUpserts.length, upsertsBefore);
  });

  await check("verified desktop audience rejects missing consent before user lookup", async () => {
    const lookupsBefore = userLookupCount;
    const { response, payload } = await request("/api/auth/google", {
      method: "POST",
      body: { idToken: "desktop-id-token" },
    });

    assert.equal(response.status, 400);
    assert.equal(payload.ok, false);
    assert.equal(payload.code, "TERMS_ACCEPTANCE_REQUIRED");
    assert.equal(userLookupCount, lookupsBefore);
  });

  await check("forged desktop declaration cannot create desktop evidence", async () => {
    const lookupsBefore = userLookupCount;
    const upsertsBefore = acceptanceUpserts.length;
    const { response, payload } = await request("/api/auth/google", {
      method: "POST",
      body: { idToken: "legacy-id-token", clientType: "DESKTOP" },
    });

    assert.equal(response.status, 401);
    assert.equal(payload.code, "GOOGLE_DESKTOP_AUDIENCE_REQUIRED");
    assert.equal(userLookupCount, lookupsBefore);
    assert.equal(acceptanceUpserts.length, upsertsBefore);
  });

  await check("stale desktop consent returns current version and hash", async () => {
    const lookupsBefore = userLookupCount;
    const { response, payload } = await request("/api/auth/google", {
      method: "POST",
      body: {
        idToken: "desktop-id-token",
        clientType: "DESKTOP",
        termsAcceptance: {
          version: "2026-01-01",
          documentHash: "0".repeat(64),
          accepted: true,
        },
      },
    });

    assert.equal(response.status, 409);
    assert.equal(payload.code, "TERMS_VERSION_MISMATCH");
    assert.equal(payload.details.currentVersion, CURRENT_TERMS.version);
    assert.equal(
      payload.details.currentDocumentHash,
      CURRENT_TERMS.documentHash
    );
    assert.equal(userLookupCount, lookupsBefore);
  });

  await check("repeated valid desktop login returns one stable acceptance receipt", async () => {
    const body = {
      idToken: "desktop-id-token",
      clientType: "DESKTOP",
      termsAcceptance: {
        version: CURRENT_TERMS.version,
        documentHash: CURRENT_TERMS.documentHash,
        accepted: true,
      },
    };

    const first = await request("/api/auth/google", { method: "POST", body });
    const second = await request("/api/auth/google", { method: "POST", body });

    assert.equal(first.response.status, 200);
    assert.equal(second.response.status, 200);
    assert.deepEqual(first.payload.termsAcceptanceReceipt, {
      acceptanceId,
      version: CURRENT_TERMS.version,
      documentHash: CURRENT_TERMS.documentHash,
      acceptedAt: fixedAcceptedAt.toISOString(),
      source: "DESKTOP",
    });
    assert.deepEqual(
      second.payload.termsAcceptanceReceipt,
      first.payload.termsAcceptanceReceipt
    );

    const lastTwoUpserts = acceptanceUpserts.slice(-2);
    assert.equal(lastTwoUpserts.length, 2);
    for (const call of lastTwoUpserts) {
      assert.deepEqual(call.filter, {
        userId,
        termsVersion: CURRENT_TERMS.version,
      });
      assert.equal(call.options.upsert, true);
      assert.equal(call.options.new, true);
      assert.equal(call.update.$setOnInsert.documentHash, CURRENT_TERMS.documentHash);
      assert.equal(call.update.$setOnInsert.source, "DESKTOP");
    }
  });

  await check("database schema enforces one acceptance per user and version", () => {
    const uniqueIndex = TermsAcceptance.schema.indexes().find(
      ([keys, options]) =>
        keys.userId === 1 &&
        keys.termsVersion === 1 &&
        options.unique === true
    );

    assert.ok(uniqueIndex, "unique user/version index is missing");
    assert.equal(uniqueIndex[1].name, "unique_user_terms_version");
  });

  await check("duplicate-key race reads and returns the existing immutable receipt", async () => {
    duplicateRacePending = true;
    const fallbackBefore = acceptanceFallbackCount;

    const receipt = await recordCurrentTermsAcceptance({
      userId,
      email: "LEGACY.USER@EXAMPLE.TEST",
    });

    assert.deepEqual(receipt, {
      acceptanceId,
      version: CURRENT_TERMS.version,
      documentHash: CURRENT_TERMS.documentHash,
      acceptedAt: fixedAcceptedAt.toISOString(),
      source: "DESKTOP",
    });
    assert.equal(acceptanceFallbackCount, fallbackBefore + 1);
  });
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  server.unref();

  OAuth2Client.prototype.verifyIdToken = originals.verifyIdToken;
  User.findOne = originals.userFindOne;
  Firm.findOne = originals.firmFindOne;
  FirmMembership.findOne = originals.membershipFindOne;
  TermsAcceptance.findOneAndUpdate = originals.acceptanceFindOneAndUpdate;
  TermsAcceptance.findOne = originals.acceptanceFindOne;
}

console.log(
  `\nResult: ${checkCount - failures.length} passed, ${failures.length} failed (out of ${checkCount})`
);
process.exitCode = failures.length === 0 ? 0 : 1;
