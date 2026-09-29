// src/controllers/webhook.controller.js
// Resend webhook receiver (IMPROVEMENT-PLAN-V2-2026-09-28 Part 1).
//
// POST /api/webhooks/resend — public route, signature-verified. Resend signs
// with the Svix scheme (standardwebhooks spec): an HMAC-SHA256 over
// `${id}.${timestamp}.${payload}` using a base64 secret, delivered in the
// `webhook-signature` header as one or more `v1,<base64>` signatures. The
// verification here is implemented directly rather than through the
// `standardwebhooks` package because that package is only a transitive
// dependency of the Resend SDK — importing a transitive dep directly would
// break the moment the SDK dropped or moved it.
//
// Behavior:
//   - unsigned / bad-signature / stale-timestamp requests are refused (401)
//   - email.sent / delivered / bounced / complained advance the matching
//     EmailDelivery row through forward-only transitions (duplicate webhooks
//     are no-ops by construction)
//   - a permanent bounce or ANY complaint inserts an EmailSuppression row so
//     the shared mailer refuses the address on every future send
//   - the payload's recipient addresses are used ONLY to key the suppression
//     (hashed on write) — nothing content-bearing is stored.

import { createHmac, timingSafeEqual } from "node:crypto";
import AppConfig from "../models/AppConfig.js";
import EmailDelivery, { EMAIL_DELIVERY_EVENT_TRANSITIONS } from "../models/EmailDelivery.js";
import EmailSuppression from "../models/EmailSuppression.js";
import { applyResendEvent } from "../services/mailer.js";

const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

function verifySvixSignature({ secret, id, timestamp, signatureHeader, payload }) {
  if (!secret || !id || !timestamp || !signatureHeader || payload == null) {
    return false;
  }
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const skew = Math.abs(Date.now() / 1000 - ts);
  if (skew > WEBHOOK_TOLERANCE_SECONDS) return false;

  const secretPart = String(secret).replace(/^whsec_/, "");
  const key = Buffer.from(secretPart, "base64");
  const signedContent = `${id}.${timestamp}.${payload}`;
  const expected = createHmac("sha256", key).update(signedContent).digest("base64");

  // The header may carry multiple `v1,<sig>` entries (secret rotation). Any
  // match verifies the message.
  const signatures = String(signatureHeader)
    .split(/\s+/)
    .map((part) => part.split(","))
    .filter(([version, digest]) => version === "v1" && Boolean(digest))
    .map(([, digest]) => digest);

  if (!signatures.length) return false;
  const expectedBuf = Buffer.from(expected, "base64");
  return signatures.some((sig) => {
    const sigBuf = Buffer.from(sig, "base64");
    return sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf);
  });
}

export const resendWebhook = async (req, res) => {
  // The secret arrives from the environment when the host provides it, else
  // from the super-admin-configured value in AppConfig (see the model comment
  // for why a database field exists at all). Neither present: refuse rather
  // than accept unsigned payloads.
  let secret = process.env.RESEND_WEBHOOK_SECRET || null;
  if (!secret) {
    try {
      secret = await AppConfig.getResendWebhookSecret();
    } catch {
      secret = null; // database unavailable: stay fail-closed
    }
  }
  if (!secret) {
    return res.status(503).json({ ok: false, error: "Webhook is not configured" });
  }

  // The raw body is what was signed. express.json's verify hook stashes it.
  const rawBody = req.rawBody ?? (typeof req.body === "string" ? req.body : null);
  if (rawBody == null) {
    return res.status(400).json({ ok: false, error: "Webhook body unavailable" });
  }

  const verified = verifySvixSignature({
    secret,
    id: req.headers["webhook-id"],
    timestamp: req.headers["webhook-timestamp"],
    signatureHeader: req.headers["webhook-signature"],
    payload: rawBody,
  });
  if (!verified) {
    return res.status(401).json({ ok: false, error: "Invalid webhook signature" });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ ok: false, error: "Webhook body is not valid JSON" });
  }

  const type = String(event?.type || "");
  const emailId = String(event?.data?.email_id || event?.data?.id || "");
  const to = Array.isArray(event?.data?.to) ? event.data.to : [];

  // Acknowledge everything else (we only model the four delivery events).
  if (!EMAIL_DELIVERY_EVENT_TRANSITIONS[type]) {
    return res.json({ ok: true, ignored: type || "unknown" });
  }

  const outcome = await applyResendEvent({
    type,
    emailId,
    occurredAt: new Date(),
  });

  if (outcome.transitioned) {
    const isPermanentBounce =
      type === "email.bounced" &&
      String(event?.data?.bounce?.type || "permanent") === "permanent";
    if (type === "email.complained" || isPermanentBounce) {
      const reason = type === "email.complained" ? "complaint" : "hard_bounce";
      // One suppression per address; the first of several webhook deliveries wins.
      await Promise.all(
        to.map((address) =>
          EmailSuppression.suppress({ email: address, reason }).catch((err) => {
            console.error("webhook: suppression insert failed:", err?.message);
          }),
        ),
      );
      if (to.length === 0) {
        console.warn(`webhook: ${type} for ${emailId} carried no recipient addresses; suppression skipped`);
      }
    }
  }

  return res.json({
    ok: true,
    type,
    transitioned: outcome.transitioned || false,
  });
};

export { verifySvixSignature, EmailDelivery as _emailDeliveryModelForTests };
