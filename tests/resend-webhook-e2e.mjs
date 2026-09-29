// tests/resend-webhook-e2e.mjs
//
// Why this exists. IMPROVEMENT-PLAN-V2-2026-09-28 Part 1: the Resend webhook
// must be proven against the REAL express app, not just the transition
// function in isolation — the questions that matter live in the HTTP layer:
// an unsigned payload is refused, a stale one is refused, a tampered one is
// refused, a duplicate event does not double-apply, a permanent bounce BOTH
// advances the row AND inserts a suppression, and the suppression then gates
// a real mailer send. This suite boots src/app.js on a scratch database with
// a test webhook secret and drives the whole loop over HTTP.
//
// SAFETY: refuses to run unless MONGODB_URI is loopback AND scratch-marked;
// blanks every outbound provider key in its own process (no email can leave);
// drops only its own scratch database.
//
// Run: MONGODB_URI=mongodb://127.0.0.1:27117/scratch-resend-webhook-e2e node tests/resend-webhook-e2e.mjs

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

const uri = process.env.MONGODB_URI || "";
if (!/\/\/(localhost|127\.0\.0\.1)[:/]/.test(uri) || !uri.includes("scratch")) {
  console.error("Refusing to run: MONGODB_URI must be loopback and scratch-marked.");
  process.exit(1);
}
// No email may leave this process even if a test goes sideways.
delete process.env.RESEND_API_KEY;

const WEBHOOK_SECRET = "whsec_" + Buffer.from(`e2e-test-secret-${Date.now()}`).toString("base64");
process.env.RESEND_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.JWT_SECRET = process.env.JWT_SECRET || "e2e-webhook-suite-secret-000000000000";

const mongoose = (await import("mongoose")).default;
await mongoose.connect(uri);

const { default: EmailDelivery } = await import("../src/models/EmailDelivery.js");
const { default: EmailSuppression } = await import("../src/models/EmailSuppression.js");
const { default: WorkflowUsage } = await import("../src/models/WorkflowUsage.js");
const { default: User } = await import("../src/models/User.js");
const { default: Firm } = await import("../src/models/Firm.js");
const { ensureRequiredIndexes } = await import("../src/services/index-provisioning.service.js");
await ensureRequiredIndexes();

let server;
const app = (await import("../src/app.js")).default;
await new Promise((resolve) => {
  server = app.listen(0, "127.0.0.1", resolve);
});
const base = `http://127.0.0.1:${server.address().port}`;

const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass, detail });

function signedHeaders({ id, payload, timestamp = String(Math.floor(Date.now() / 1000)), secret = WEBHOOK_SECRET }) {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${timestamp}.${payload}`).digest("base64");
  return {
    "content-type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": `v1,${sig}`,
  };
}

async function deliverEvent(body, headers) {
  const res = await fetch(`${base}/api/webhooks/resend`, {
    method: "POST",
    headers: headers ?? signedHeaders({ id: `evt_${Math.random().toString(36).slice(2)}`, payload: body }),
    body,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // non-JSON refusal bodies are fine
  }
  return { status: res.status, json };
}

async function seedSentEmail(providerMessageId) {
  const row = await EmailDelivery.create({
    type: "test_email",
    recipientEmailHash: EmailDelivery.hashRecipient("victim@example.com"),
    recipientEmailLast4: ".com",
    subjectTemplateName: "test_email",
    providerMessageId,
    status: "sent",
    errorClass: "none",
    sentAt: new Date(),
    lastEventAt: new Date(),
  });
  return row;
}

try {
  await Promise.all([
    EmailDelivery.deleteMany({}).maxTimeMS(5000),
    EmailSuppression.deleteMany({}).maxTimeMS(5000),
    WorkflowUsage.deleteMany({}).maxTimeMS(5000),
  ]);

  // ── 1. Authentication: the endpoint must be fail-closed ──────────────────

  const payloadOk = JSON.stringify({ type: "email.delivered", data: { email_id: "auth-probe" } });
  const unsigned = await deliverEvent(payloadOk, { "content-type": "application/json" });
  check("unsigned payload refused with 401", unsigned.status === 401, `status=${unsigned.status}`);

  const staleTs = String(Math.floor(Date.now() / 1000) - 3600);
  const stale = await deliverEvent(
    payloadOk,
    signedHeaders({ id: "evt_stale", payload: payloadOk, timestamp: staleTs }),
  );
  check("stale timestamp (>5 min) refused with 401", stale.status === 401, `status=${stale.status}`);

  // Signed over a body that says "delivered", delivering a body that says
  // "bounced": the signature must not verify against different content.
  const tampered = JSON.stringify({ type: "email.bounced", data: { email_id: "auth-probe" } });
  const tamperedRes = await deliverEvent(
    tampered,
    signedHeaders({ id: "evt_tampered", payload: payloadOk }),
  );
  check("tampered body refused with 401", tamperedRes.status === 401, `status=${tamperedRes.status}`);

  const wrongSecret = await deliverEvent(
    payloadOk,
    signedHeaders({ id: "evt_wrong", payload: payloadOk, secret: "whsec_" + Buffer.from("attacker-secret").toString("base64") }),
  );
  check("wrong signing secret refused with 401", wrongSecret.status === 401, `status=${wrongSecret.status}`);

  // Svix services sign with svix-prefixed headers; Resend's production
  // dispatches carry svix-id / svix-timestamp / svix-signature, not the
  // webhook- form this suite used to test. A row must transition when the
  // signature arrives under the svix names — this is the exact gap that left
  // every genuine production event refused 401 until 2026-09-29.
  const svixRow = await seedSentEmail("prov-e2e-svix");
  const svixBody = JSON.stringify({ type: "email.delivered", data: { email_id: "prov-e2e-svix" } });
  const svixId = `evt_${Math.random().toString(36).slice(2)}`;
  const svixHeaders = signedHeaders({ id: svixId, payload: svixBody });
  const svixRes = await fetch(`${base}/api/webhooks/resend`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": svixHeaders["webhook-id"],
      "svix-timestamp": svixHeaders["webhook-timestamp"],
      "svix-signature": svixHeaders["webhook-signature"],
    },
    body: svixBody,
  });
  check("svix-prefixed signature headers are accepted (Resend's real shape)",
    svixRes.status === 200 && (await svixRes.json())?.transitioned === true,
    `status=${svixRes.status}`);
  const svixRowAfter = await EmailDelivery.findOne({ providerMessageId: "prov-e2e-svix" }).lean();
  check("the row transitioned under svix headers", svixRowAfter?.status === "delivered", svixRowAfter?.status);

  // ── 2. Delivery transitions on a real row ────────────────────────────────

  const row = await seedSentEmail("prov-e2e-1");
  const goodBody = JSON.stringify({ type: "email.delivered", data: { email_id: "prov-e2e-1" } });
  const first = await deliverEvent(goodBody);
  check("valid delivered event answers ok+transitioned",
    first.status === 200 && first.json?.transitioned === true, JSON.stringify(first.json));
  const reread = await EmailDelivery.findById(row._id).lean();
  check("row transitioned sent -> delivered with a deliveredAt timestamp",
    reread.status === "delivered" && reread.deliveredAt instanceof Date && reread.lastEventAt instanceof Date);

  const duplicate = await deliverEvent(goodBody);
  check("duplicate delivered event is a no-op (forward-only transitions)",
    duplicate.status === 200 && duplicate.json?.transitioned === false);
  const afterDup = await EmailDelivery.findById(row._id).lean();
  check("duplicate did not change the row's status",
    afterDup.status === "delivered" &&
      afterDup.lastEventAt.getTime() === reread.lastEventAt.getTime());

  const reversal = await deliverEvent(
    JSON.stringify({ type: "email.sent", data: { email_id: "prov-e2e-1" } }),
  );
  check("delivered -> sent reversal is refused as a no-op",
    reversal.status === 200 && reversal.json?.transitioned === false);
  check("row still delivered after the reversal attempt",
    (await EmailDelivery.findById(row._id).lean()).status === "delivered");

  // ── 3. Permanent bounce -> suppression, then a gated send ───────────────

  const bounceBody = JSON.stringify({
    type: "email.bounced",
    data: {
      email_id: "prov-e2e-1",
      to: ["victim@example.com"],
      bounce: { type: "permanent" },
    },
  });
  const bounce = await deliverEvent(bounceBody);
  check("permanent bounce answers ok+transitioned",
    bounce.status === 200 && bounce.json?.transitioned === true);
  check("row advanced to bounced", (await EmailDelivery.findById(row._id).lean()).status === "bounced");
  const suppression = await EmailSuppression.isSuppressed("VICTIM@example.com");
  check("suppression row created for the bounced address (hash-keyed, case-insensitive)",
    suppression.suppressed && suppression.reason === "hard_bounce",
    JSON.stringify(suppression));

  const softBounce = await deliverEvent(
    JSON.stringify({
      type: "email.bounced",
      data: { email_id: "prov-e2e-1", to: ["victim@example.com"], bounce: { type: "transient" } },
    }),
  );
  check("transient bounce does not create a second suppression",
    softBounce.status === 200 && (await EmailSuppression.countDocuments({})) === 1);

  // ── 4. Complaint -> suppression ──────────────────────────────────────────

  const complaintRow = await seedSentEmail("prov-e2e-2");
  await deliverEvent(
    JSON.stringify({
      type: "email.complained",
      data: { email_id: "prov-e2e-2", to: ["complainer@example.com"] },
    }),
  );
  check("complaint advances the row", (await EmailDelivery.findById(complaintRow._id).lean()).status === "complained");
  const complaintSuppression = await EmailSuppression.isSuppressed("complainer@example.com");
  check("complaint creates a complaint suppression", complaintSuppression.suppressed && complaintSuppression.reason === "complaint");

  // ── 5. The mailer refuses a suppressed address BEFORE the provider call ──

  // The process has no RESEND_API_KEY (deliberately blanked), so a send that
  // got past the suppression gate would throw on the missing key — proving
  // the gate fired when we instead get a recorded suppressed refusal.
  const { sendEmail } = await import("../src/services/mailer.js");
  const outcome = await sendEmail({
    to: "victim@example.com",
    type: "test_email",
    subjectTemplateName: "test_email",
    subject: "must never be sent",
    html: "<p>nope</p>",
  });
  check("mailer refuses a suppressed address without calling the provider",
    outcome.suppressed === true && outcome.providerMessageId === null, JSON.stringify(outcome));
  const blockedRow = await EmailDelivery.findOne({
    type: "test_email",
    errorClass: "suppressed",
    "meta.reminderId": null,
    subjectTemplateName: "test_email",
  }).sort({ createdAt: -1 }).lean();
  check("the refusal itself is recorded as failed/suppressed",
    blockedRow !== null && blockedRow.status === "failed" && blockedRow.providerMessageId === null);

  // An unsuppressed address with no API key surfaces the provider-layer error
  // (proves the suppression gate is what blocked the previous one).
  let unsuppressedError = null;
  try {
    await sendEmail({
      to: "fresh@example.com",
      type: "test_email",
      subjectTemplateName: "test_email",
      subject: "will fail on the blanked key",
      html: "<p>key missing</p>",
    });
  } catch (err) {
    unsuppressedError = err;
  }
  check("an unsuppressed address reaches the provider layer (fails on the blanked key, as designed)",
    unsuppressedError !== null,
    unsuppressedError?.message ?? "no error — send unexpectedly succeeded");

  // ── 6. Unknown events and unknown ids ────────────────────────────────────

  const unknownType = await deliverEvent(
    JSON.stringify({ type: "email.opened", data: { email_id: "prov-e2e-1" } }),
  );
  check("an unmodelled event type is acknowledged and ignored",
    unknownType.status === 200 && unknownType.json?.ignored === "email.opened");

  const foreignId = await deliverEvent(
    JSON.stringify({ type: "email.delivered", data: { email_id: "not-in-our-table" } }),
  );
  check("an unknown provider id is acknowledged without crashing",
    foreignId.status === 200 && foreignId.json?.transitioned === false);

  // ── 7. A webhook without the configured secret fails closed ──────────────

  const unconfigured = await fetch(`${base}/api/webhooks/resend`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payloadOk,
  });
  check("missing signature headers on a configured deployment still refused", unconfigured.status === 401);
} finally {
  server.close();
  await Promise.all([
    EmailDelivery.deleteMany({}).maxTimeMS(5000),
    EmailSuppression.deleteMany({}).maxTimeMS(5000),
    WorkflowUsage.deleteMany({}).maxTimeMS(5000),
  ]).catch(() => {});
  await mongoose.disconnect();
}

const failed = checks.filter((c) => !c.pass);
for (const c of failed) console.error(`FAIL: ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
console.log(`resend-webhook-e2e: ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) process.exit(1);
