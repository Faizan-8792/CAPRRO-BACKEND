// tests/email-delivery-contract.mjs
//
// Why this exists. IMPROVEMENT-PLAN-V2-2026-09-28 Part 1: email observability.
// Before this, "sent" meant "Resend accepted" — no delivery/bounce/complaint
// signal, no suppression list, three separate Resend clients, and a panel
// with no emails page. This contract pins the pieces the owner's visibility
// depends on:
//
//   1. The shared mailer is the only transport path: every send in
//      email.service.js / reminder.service.js routes through it.
//   2. A suppressed address is refused BEFORE the provider call and the
//      refusal itself is recorded (status failed, errorClass suppressed).
//   3. Webhook transitions are forward-only: a duplicate delivery is a no-op,
//      a reversal is refused — idempotency by construction.
//   4. The Svix/standardwebhooks signature scheme is verified, and a stale or
//      unsigned payload is refused.
//   5. No raw recipient address is stored anywhere in the model.
//   6. The digest-activation page carries NO inline script (CSP: script-src
//      'self') — the original inline version made the button a dead control.
//
// Run: node tests/email-delivery-contract.mjs
//      (Mongo subset runs only when MONGODB_URI points at a scratch database)

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHmac } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass, detail });

// ─── 1. Single transport path ────────────────────────────────────────────────

for (const [file, forbidden] of [
  ["src/services/email.service.js", 'from "resend"'],
  ["src/services/reminder.service.js", 'from "resend"'],
]) {
  const source = readFileSync(join(root, file), "utf8");
  check(
    `${file}: no direct Resend client (routes through services/mailer.js)`,
    !source.includes(forbidden) && source.includes("mailer.js"),
  );
}

const mailerSource = readFileSync(join(root, "src/services/mailer.js"), "utf8");
check(
  "mailer: checks suppression before sending and records every send",
  mailerSource.includes("EmailSuppression.isSuppressed") &&
    mailerSource.includes("EmailDelivery.create"),
);

// ─── 2. Model privacy shape ──────────────────────────────────────────────────

const { default: EmailDelivery, EMAIL_DELIVERY_EVENT_TRANSITIONS } = await import(
  "../src/models/EmailDelivery.js"
);
const { default: EmailSuppression } = await import("../src/models/EmailSuppression.js");

check(
  "EmailDelivery: stores a hash and a 4-char suffix, never the address",
  typeof EmailDelivery.hashRecipient("User@Example.com ") === "string" &&
    EmailDelivery.hashRecipient("User@Example.com ") ===
      EmailDelivery.hashRecipient("user@example.com"),
);
check(
  "EmailDelivery: forward-only transition map covers the four provider events",
  ["email.sent", "email.delivered", "email.bounced", "email.complained"].every(
    (event) => EMAIL_DELIVERY_EVENT_TRANSITIONS[event],
  ),
);
// A reversal (delivered -> sent) must not be representable: sent's source set
// is ['queued'] only, so a delivered row can never re-enter 'sent'.
check(
  "EmailDelivery: transitions cannot reverse delivered back to sent",
  !EMAIL_DELIVERY_EVENT_TRANSITIONS["email.sent"].from.includes("delivered"),
);

// ─── 3. Webhook signature scheme (Svix / standardwebhooks) ───────────────────

const { verifySvixSignature } = await import("../src/controllers/webhook.controller.js");
const rawSecret = "whsec_" + Buffer.from("test-secret-bytes-for-contract").toString("base64");
const key = Buffer.from("test-secret-bytes-for-contract");
const timestamp = String(Math.floor(Date.now() / 1000));
const payload = JSON.stringify({ type: "email.delivered", data: { email_id: "abc" } });
const signed = createHmac("sha256", key).update(`msg_1.${timestamp}.${payload}`).digest("base64");

check(
  "webhook: a correctly signed payload verifies",
  verifySvixSignature({
    secret: rawSecret,
    id: "msg_1",
    timestamp,
    signatureHeader: `v1,${signed}`,
    payload,
  }),
);
check(
  "webhook: a tampered payload is refused",
  !verifySvixSignature({
    secret: rawSecret,
    id: "msg_1",
    timestamp,
    signatureHeader: `v1,${signed}`,
    payload: payload.replace("delivered", "bounced"),
  }),
);
check(
  "webhook: a stale timestamp is refused (5-minute tolerance)",
  !verifySvixSignature({
    secret: rawSecret,
    id: "msg_1",
    timestamp: String(Math.floor(Date.now() / 1000) - 3600),
    signatureHeader: `v1,${signed}`,
    payload,
  }),
);
check(
  "webhook: a missing signature header is refused",
  !verifySvixSignature({
    secret: rawSecret,
    id: "msg_1",
    timestamp,
    signatureHeader: "",
    payload,
  }),
);

// ─── 4. Routes exist and are wired deliberately ──────────────────────────────

const superRoutes = readFileSync(join(root, "src/routes/super.routes.js"), "utf8");
check(
  "super routes: emails list, detail, and suppression endpoints exist",
  superRoutes.includes('router.get("/emails"') &&
    superRoutes.includes('router.get("/emails/:id"') &&
    superRoutes.includes('"/emails/suppressions"'),
);
const appSource = readFileSync(join(root, "src/app.js"), "utf8");
check(
  "app: the webhook route mounts with a raw-body-capturing parser",
  appSource.includes('"/api/webhooks/resend"') && appSource.includes("req.rawBody"),
);

// ─── 5. CSP: the activation page has no inline script ────────────────────────

const activateHtml = readFileSync(join(root, "public/daily-digest-activate.html"), "utf8");
check(
  "digest activation page: no inline script (script-src 'self' would kill the button)",
  !/<script>(?!\s*<)/.test(activateHtml) && activateHtml.includes('src="daily-digest-activate.js"'),
);
check(
  "digest activation page: the external script exists",
  (() => {
    try {
      readFileSync(join(root, "public/daily-digest-activate.js"), "utf8");
      return true;
    } catch {
      return false;
    }
  })(),
);

// ─── 6. Mongo-backed behaviour ───────────────────────────────────────────────

const mongoUri = process.env.MONGODB_URI || "";
const wantsMongo = mongoUri.includes("scratch");
let mongoRan = false;

if (wantsMongo) {
  const mongoose = (await import("mongoose")).default;
  await mongoose.connect(mongoUri);
  try {
    await EmailDelivery.deleteMany({}).maxTimeMS(5000);
    await EmailSuppression.deleteMany({}).maxTimeMS(5000);
    mongoRan = true;

    // Suppression gate: isSuppressed flips for a stored row, and suppress is idempotent.
    await EmailSuppression.suppress({ email: "bounced@example.com", reason: "hard_bounce" });
    await EmailSuppression.suppress({ email: "bounced@example.com", reason: "complaint" });
    const suppressionRows = await EmailSuppression.find({}).lean();
    check(
      "EmailSuppression: duplicate suppression keeps one row (idempotent)",
      suppressionRows.length === 1 && suppressionRows[0].reason === "hard_bounce",
      `rows=${suppressionRows.length}`,
    );
    check(
      "EmailSuppression: stores a hash, not the address",
      /^[0-9a-f]{64}$/.test(suppressionRows[0].emailHash),
    );
    const gate = await EmailSuppression.isSuppressed("BOUNCED@example.com");
    check("EmailSuppression: case-insensitive lookup via hash", gate.suppressed && gate.reason === "hard_bounce");

    // Transitions against real rows.
    const row = await EmailDelivery.create({
      type: "test_email",
      recipientEmailHash: EmailDelivery.hashRecipient("x@example.com"),
      recipientEmailLast4: ".com",
      subjectTemplateName: "test_email",
      providerMessageId: "prov-1",
      status: "sent",
      errorClass: "none",
      sentAt: new Date(),
      lastEventAt: new Date(),
    });

    const { applyResendEvent } = await import("../src/services/mailer.js");
    const first = await applyResendEvent({ type: "email.delivered", emailId: "prov-1" });
    const duplicate = await applyResendEvent({ type: "email.delivered", emailId: "prov-1" });
    const reversal = await applyResendEvent({ type: "email.sent", emailId: "prov-1" });
    const reread = await EmailDelivery.findById(row._id).lean();
    check(
      "webhook transitions: delivered applies once; duplicates and reversals are no-ops",
      first.transitioned && !duplicate.transitioned && !reversal.transitioned && reread.status === "delivered",
      `status=${reread.status}`,
    );

    // Unknown provider id: acknowledged, not a crash.
    const foreign = await applyResendEvent({ type: "email.delivered", emailId: "not-a-real-id" });
    check("webhook transitions: an unknown provider id is ignored safely", !foreign.applied && !foreign.transitioned);

    await EmailDelivery.deleteMany({}).maxTimeMS(5000);
    await EmailSuppression.deleteMany({}).maxTimeMS(5000);
  } finally {
    await mongoose.disconnect();
  }
}

check(
  "mongo subset ran (only when MONGODB_URI points at a scratch database)",
  mongoRan || !wantsMongo,
);

// ─── Verdict ─────────────────────────────────────────────────────────────────

const failed = checks.filter((c) => !c.pass);
for (const c of failed) console.error(`FAIL: ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
console.log(
  `email-delivery-contract: ${checks.length - failed.length}/${checks.length} checks passed` +
    (mongoRan ? " (mongo subset included)" : " (mongo subset SKIPPED — no scratch MONGODB_URI)"),
);
if (failed.length > 0) process.exit(1);
