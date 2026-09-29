// tests/super-emails-controller-contract.mjs
//
// Why this exists. The Emails routes (IMPROVEMENT-PLAN-V2 Part 1) had model-level
// coverage but no contract that drives the CONTROLLERS, so `mongoose.isValidObjectId`
// shipped in super.controller.js without the mongoose import and every affected call
// answered 500 in production the first time the panel used it — the exact failure
// shape usage-stats-contract.mjs was written to prevent after its own 500. This suite
// drives the real controllers with seeded rows through a scratch database.
//
// Covered: email detail (200 + timeline + hash excluded, 404 invalid, 404 missing),
// the list's firmId filter and recipientHash search (both reach mongoose.isValidObjectId),
// suppression removal (200, row gone, 404s), and the super-admin-only guard on each.
//
// Run: MONGODB_URI=...scratch... node tests/super-emails-controller-contract.mjs

import assert from "node:assert/strict";

const uri = process.env.MONGODB_URI || "";
if (!/^mongodb(\+srv)?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(uri) || !uri.includes("scratch")) {
  console.error("Refusing to run: MONGODB_URI must be loopback and scratch-marked.");
  process.exit(1);
}

const mongoose = (await import("mongoose")).default;
await mongoose.connect(uri);

const { default: EmailDelivery } = await import("../src/models/EmailDelivery.js");
const { default: EmailSuppression } = await import("../src/models/EmailSuppression.js");
const { default: Firm } = await import("../src/models/Firm.js");
const { default: ActivityEvent } = await import("../src/models/ActivityEvent.js");
const { default: User } = await import("../src/models/User.js");
const { ensurePersonalFirm } = await import("../src/services/firm-provisioning.service.js");
const {
  getEmailDeliveryForSuper,
  listEmailDeliveriesForSuper,
  deleteEmailSuppressionForSuper,
} = await import("../src/controllers/super.controller.js");

const SUPER = { id: new mongoose.Types.ObjectId().toString(), role: "SUPER_ADMIN", email: "saifullahfaizan786@gmail.com" };

const call = async (handler, req) => {
  let status = 0;
  let body = null;
  const res = {
    status(c) { status = c; return this; },
    json(b) { body = b; return this; },
  };
  await handler({ user: SUPER, query: {}, params: {}, ...req }, res, (err) => {
    status = err?.statusCode ?? 500;
    body = { error: err?.message };
  });
  return { status, body };
};

const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass, detail });

try {
  await Promise.all([
    EmailDelivery.deleteMany({}),
    EmailSuppression.deleteMany({}),
    Firm.deleteMany({}),
    User.deleteMany({}),
    ActivityEvent.deleteMany({}),
  ]).catch(() => {});

  const firmOwner = await User.create({
    email: "firm-owner@example.com",
    name: "Firm Owner",
    role: "FIRM_ADMIN",
    accountType: "INDIVIDUAL",
    isActive: true,
  });
  await ensurePersonalFirm(firmOwner);
  const firmId = firmOwner.firmId; // ensurePersonalFirm returns the USER, whose firmId is the Firm _id
  const seed = async (over = {}) =>
    EmailDelivery.create({
      recipientEmailHash: EmailDelivery.hashRecipient(over.to || "a@example.com"),
      recipientEmailLast4: ".com",
      type: "test_email",
      subjectTemplateName: "other",
      providerMessageId: "contract-" + Math.random().toString(36).slice(2),
      status: "sent",
      errorClass: "none",
      sentAt: new Date(),
      ...over,
    });

  const standalone = await seed();
  const firmRow = await seed({ firmId, type: "reminder", to: "firmrow@example.com" });

  // --- detail ------------------------------------------------------------
  const detail = await call(getEmailDeliveryForSuper, { params: { id: standalone._id.toString() } });
  check("detail answers 200 with ok", detail.status === 0 && detail.body?.ok === true,
    JSON.stringify(detail.body?.error ?? ""));
  check("detail carries a timeline and excludes recipientEmailHash",
    Array.isArray(detail.body?.email?.timeline) &&
    !("recipientEmailHash" in detail.body.email) &&
    detail.body.email.type === "test_email",
    "keys=" + Object.keys(detail.body?.email ?? {}).length);

  const badId = await call(getEmailDeliveryForSuper, { params: { id: "not-an-objectid" } });
  check("detail with a non-ObjectId answers 404", badId.status === 404, "got " + badId.status);
  const missingId = await call(getEmailDeliveryForSuper, { params: { id: new mongoose.Types.ObjectId().toString() } });
  check("detail with an unknown ObjectId answers 404", missingId.status === 404, "got " + missingId.status);

  // --- list filters (the firmId filter reached mongoose.isValidObjectId) ---
  const byFirm = await call(listEmailDeliveriesForSuper, { query: { firmId: firmId.toString() } });
  check("list filtered by firmId answers 200 and returns only that firm's rows",
    byFirm.status === 0 && byFirm.body?.ok === true && byFirm.body?.total === 1 &&
    String(byFirm.body?.emails?.[0]?._id) === String(firmRow._id),
    "status=" + byFirm.status + " total=" + byFirm.body?.total + " err=" + JSON.stringify(byFirm.body?.error ?? ""));
  check("firm filter joins the firm document", byFirm.body?.emails?.[0]?.firmId && typeof byFirm.body.emails[0].firmId === "object",
    JSON.stringify(byFirm.body?.emails?.[0]?.firmId ?? null));

  const byHash = await call(listEmailDeliveriesForSuper, {
    query: { recipientHash: EmailDelivery.hashRecipient("a@example.com") },
  });
  check("list filtered by recipientHash answers 200 with the exact row",
    byHash.status === 0 && byHash.body?.total === 1 && String(byHash.body?.emails?.[0]?._id) === String(standalone._id),
    "status=" + byHash.status + " total=" + byHash.body?.total);
  const byType = await call(listEmailDeliveriesForSuper, { query: { types: "reminder" } });
  check("list filtered by type returns only that type",
    byType.status === 0 && byType.body?.total === 1 && byType.body?.emails?.[0]?.type === "reminder",
    "total=" + byType.body?.total);

  // --- suppression removal -------------------------------------------------
  const suppression = await EmailSuppression.suppress({ email: "bounced@example.com", reason: "hard_bounce" });
  const removed = await call(deleteEmailSuppressionForSuper, { params: { id: suppression._id.toString() } });
  check("suppression removal answers 200", removed.status === 0 && removed.body?.ok === true,
    "status=" + removed.status + " err=" + JSON.stringify(removed.body?.error ?? ""));
  const gone = !(await EmailSuppression.findById(suppression._id));
  check("suppression row is actually deleted", gone === true);
  const audit = await ActivityEvent.findOne({ action: "EMAIL_SUPPRESSION_REMOVED", entityId: suppression._id.toString() });
  check("the removal left the promised audit event", Boolean(audit), audit ? "" : "no ActivityEvent persisted");
  const badSuppress = await call(deleteEmailSuppressionForSuper, { params: { id: "junk" } });
  check("suppression removal with a non-ObjectId answers 404", badSuppress.status === 404, "got " + badSuppress.status);

  // --- guard ---------------------------------------------------------------
  const asMember = async (handler, req) => {
    let status = 0;
    const res = { status(c) { status = c; return this; }, json() { return this; } };
    await handler({ user: { id: SUPER.id, role: "USER", email: "x@example.com" }, query: {}, params: {}, ...req }, res, (err) => {
      status = err?.statusCode ?? 500;
    });
    return status;
  };
  check("detail refuses a non-super-admin", (await asMember(getEmailDeliveryForSuper, { params: { id: standalone._id.toString() } })) === 403);
  check("list refuses a non-super-admin", (await asMember(listEmailDeliveriesForSuper, {})) === 403);
  check("suppression removal refuses a non-super-admin",
    (await asMember(deleteEmailSuppressionForSuper, { params: { id: new mongoose.Types.ObjectId().toString() } })) === 403);

  await Promise.all([
    EmailDelivery.deleteMany({}),
    EmailSuppression.deleteMany({}),
    Firm.deleteMany({}),
    User.deleteMany({}),
  ]).catch(() => {});
} finally {
  await mongoose.disconnect();
}

const failed = checks.filter((c) => !c.pass);
for (const c of failed) console.error(`FAIL: ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
console.log(`super-emails-controller-contract: ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) process.exit(1);
