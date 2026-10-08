// src/services/mailer.js
// The ONE email path (IMPROVEMENT-PLAN-V2-2026-09-28 Part 1).
//
// Before this module there were three separate Resend clients (email.service.js,
// reminder.service.js, scripts/launch-campaign.mjs), none of which recorded
// anything beyond a console line. This factory is the single client, and every
// send it makes:
//   1. checks EmailSuppression and refuses suppressed addresses (recording the
//      refusal as a failed delivery so the panel shows why nothing arrived),
//   2. sends through one lazy Resend client,
//   3. ALWAYS writes an EmailDelivery row (status, provider id, timestamps),
//   4. returns the delivery id alongside the provider response.
//
// Recording is best-effort: a delivery-row write failure logs and never fails
// the send itself — observability must not be able to break the email it
// observes. The suppression check, by contrast, is a hard gate by design.
//
// sendEmail here does NOT render content. Callers keep their own builders
// (email.service.js's digest builder stays where its tests pin it); this module
// owns transport, recording, and suppression only.

import { Resend } from "resend";
import mongoose from "mongoose";
import EmailDelivery, {
  EMAIL_DELIVERY_TYPES,
  EMAIL_SUBJECT_TEMPLATES,
  EMAIL_DELIVERY_EVENT_TRANSITIONS,
} from "../models/EmailDelivery.js";
import EmailSuppression from "../models/EmailSuppression.js";

let _resend = null;
function getResend() {
  if (!_resend) {
    const key = process.env.RESEND_API_KEY;
    if (!key) throw new Error("RESEND_API_KEY env var is required");
    _resend = new Resend(key);
  }
  return _resend;
}

// Recording needs a live Mongo connection. Offline scripts (launch-campaign)
// send through this same factory without one; their sends must not stall on a
// buffering Mongoose call, so recording is skipped loudly instead.
function isDatabaseConnected() {
  return mongoose.connection.readyState === 1;
}

export const FROM_EMAIL = "CA PRO Toolkit <noreply@caprotoolkit.in>";

function assertEnum(value, allowed, label) {
  if (!allowed.includes(value)) {
    throw new Error(`mailer: ${label} "${value}" is not an allowed value`);
  }
}

/**
 * Send one email and record it.
 *
 * @param {object} args
 * @param {string} args.to                       recipient address (used for the
 *   send; never stored raw — hashed + last4 on the delivery row)
 * @param {string} args.type                     EMAIL_DELIVERY_TYPES key
 * @param {string} args.subjectTemplateName     EMAIL_SUBJECT_TEMPLATES key
 * @param {string} args.subject                  rendered subject (goes to the
 *   provider, NOT to the delivery row)
 * @param {string} [args.html] [args.text]       body parts
 * @param {object} [args.headers]                extra headers (RFC 8058 etc.)
 * @param {string} [args.replyTo]                reply-to address (campaign sends)
 * @param {string} [args.idempotencyKey]         passed through to Resend
 * @param {string} [args.firmId] [args.userId]   attribution (null for pre-auth sends)
 * @param {object} [args.meta]                   { reminderId?, digestDeliveryId? }
 * @returns {Promise<{deliveryId, providerMessageId, suppressed}>}
 */
export async function sendEmail({
  to,
  type,
  subjectTemplateName,
  subject,
  html,
  text,
  headers,
  replyTo,
  idempotencyKey,
  firmId = null,
  userId = null,
  meta,
}) {
  if (!to) throw new Error("mailer: to is required");
  if (!subject) throw new Error("mailer: subject is required");
  assertEnum(type, EMAIL_DELIVERY_TYPES, "type");
  assertEnum(subjectTemplateName, EMAIL_SUBJECT_TEMPLATES, "subjectTemplateName");

  const options = idempotencyKey
    ? { idempotencyKey: String(idempotencyKey).slice(0, 256) }
    : undefined;

  // Hard gate: an address that hard-bounced or complained must not be emailed
  // again. The refusal is itself recorded, so the panel can answer "why did
  // nothing arrive" instead of silently dropping the send.
  // When the database is offline, skip the check rather than buffering a query —
  // connected deployments always check; offline scripts never do.
  const suppression = isDatabaseConnected()
    ? await EmailSuppression.isSuppressed(to).catch(() => ({ suppressed: false }))
    : { suppressed: false };
  if (suppression.suppressed) {
    const row = await EmailDelivery.create({
      firmId: firmId || null,
      userId: userId || null,
      type,
      recipientEmailHash: EmailDelivery.hashRecipient(to),
      recipientEmailLast4: String(to).slice(-4),
      subjectTemplateName,
      providerMessageId: null,
      status: "failed",
      errorClass: "suppressed",
      sentAt: null,
      lastEventAt: new Date(),
      meta: { reminderId: meta?.reminderId || null, digestDeliveryId: meta?.digestDeliveryId || null },
    });
    console.warn(`mailer: blocked send to a suppressed address (type=${type})`);
    return { deliveryId: row._id, providerMessageId: null, suppressed: true };
  }

  const payload = {
    from: FROM_EMAIL,
    to,
    subject: String(subject).slice(0, 240),
    ...(html ? { html } : {}),
    ...(text ? { text } : {}),
    ...(headers ? { headers } : {}),
    ...(replyTo ? { replyTo } : {}),
  };

  let response;
  try {
    response = await getResend().emails.send(payload, options);
  } catch (err) {
    if (isDatabaseConnected()) {
      await recordFailure({ to, type, subjectTemplateName, firmId, userId, meta }).catch(() => {});
    }
    throw err;
  }

  if (response?.error) {
    if (isDatabaseConnected()) {
      await recordFailure({ to, type, subjectTemplateName, firmId, userId, meta }).catch(() => {});
    }
    throw new Error(String(response.error.message || "Resend rejected the email"));
  }

  const providerMessageId = response?.data?.id || response?.id || null;
  const sentAt = new Date();
  let deliveryId = null;
  if (!isDatabaseConnected()) {
    console.warn("mailer: no database connection — send NOT recorded in EmailDelivery");
  } else {
    try {
      const row = await EmailDelivery.create({
        firmId: firmId || null,
        userId: userId || null,
        type,
        recipientEmailHash: EmailDelivery.hashRecipient(to),
        recipientEmailLast4: String(to).slice(-4),
        subjectTemplateName,
        providerMessageId,
        status: "sent",
        errorClass: "none",
        sentAt,
        lastEventAt: sentAt,
        meta: { reminderId: meta?.reminderId || null, digestDeliveryId: meta?.digestDeliveryId || null },
      });
      deliveryId = row._id;
    } catch (err) {
      // Best-effort: the email is already sent; a recording failure must not
      // turn a sent email into a thrown error (the caller may retry → duplicate).
      console.error("mailer: EmailDelivery write failed after send:", err?.message);
    }
  }

  return { deliveryId, providerMessageId, suppressed: false };
}

async function recordFailure({ to, type, subjectTemplateName, firmId, userId, meta }) {
  await EmailDelivery.create({
    firmId: firmId || null,
    userId: userId || null,
    type,
    recipientEmailHash: EmailDelivery.hashRecipient(to),
    recipientEmailLast4: String(to).slice(-4),
    subjectTemplateName,
    providerMessageId: null,
    status: "failed",
    errorClass: "rejected_by_provider",
    sentAt: null,
    lastEventAt: new Date(),
    meta: { reminderId: meta?.reminderId || null, digestDeliveryId: meta?.digestDeliveryId || null },
  });
}

/**
 * Apply one Resend webhook event to its delivery row. Forward-only transitions
 * (see EMAIL_DELIVERY_EVENT_TRANSITIONS) make duplicate deliveries no-ops.
 * A permanent bounce or a complaint also inserts a suppression row.
 * Returns { applied, transitioned } — never throws for an unknown or
 * already-applied event, because webhooks retry what you fail.
 */
export async function applyResendEvent({ type, emailId, occurredAt }) {
  const transition = EMAIL_DELIVERY_EVENT_TRANSITIONS[type];
  if (!transition || !emailId) return { applied: false, transitioned: false };

  const row = await EmailDelivery.findOne({ providerMessageId: emailId });
  if (!row) return { applied: false, transitioned: false }; // pre-backfill send or foreign id

  if (transition.from.includes(row.status)) {
    row.status = transition.to;
    row.lastEventAt = occurredAt || new Date();
    if (transition.to === "delivered") row.deliveredAt = row.lastEventAt;
    await row.save();
  } else {
    return { applied: true, transitioned: false }; // duplicate or illegal reversal: no-op
  }

  if (type === "email.complained") {
    // The address itself is not on the row — the webhook payload carries it.
    return { applied: true, transitioned: true, needsSuppression: "complaint" };
  }
  if (type === "email.bounced") return { applied: true, transitioned: true, needsSuppression: "hard_bounce" };
  return { applied: true, transitioned: true };
}
