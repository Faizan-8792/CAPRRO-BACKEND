// src/services/email.service.js
//
// All sends route through the shared mailer (services/mailer.js) — one Resend
// client, suppression checking, and an EmailDelivery row per send
// (IMPROVEMENT-PLAN-V2-2026-09-28 Part 1). This module keeps only what its
// callers and tests care about: content building, validation, and the
// call-signature contract.

import {
  sendEmail as recordAndSend,
} from "./mailer.js";

/**
 * ================================
 * OTP EMAIL
 * ================================
 */
export async function sendOtpEmail(toEmail, otp) {
  try {
    if (!toEmail || !otp) {
      throw new Error("sendOtpEmail: toEmail and otp are required");
    }

    const html = `
        <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; padding:16px; color:#111827;">
          <h2 style="margin-top:0;">CA PRO Toolkit – Login OTP</h2>
          <p>Your One-Time Password (OTP) is:</p>
          <p style="font-size:24px; font-weight:bold; letter-spacing:2px;">
            ${otp}
          </p>
          <p>This OTP is valid for <b>10 minutes</b>.</p>
          <hr style="margin:16px 0;" />
          <p style="font-size:12px; color:#6b7280;">
            If you did not request this OTP, you can safely ignore this email.
          </p>
        </div>
      `;

    const result = await recordAndSend({
      to: toEmail,
      type: "otp",
      subjectTemplateName: "otp_code",
      subject: "Your CA PRO Toolkit OTP",
      html,
    });

    console.log(`📧 OTP email sent to: ${toEmail}`, result.providerMessageId || "");
    return result;
  } catch (err) {
    // Surface the full Resend error body so you can diagnose domain/key issues
    console.error(
      "❌ Resend OTP error:",
      err?.message,
      JSON.stringify(err?.response?.data ?? err?.cause ?? {}),
    );
    throw err;
  }
}

/**
 * ================================
 * COMPLIANCE / TASK REMINDER EMAIL
 * ================================
 */
export async function sendComplianceReminderEmail({
  toEmail,
  title,
  clientLabel,
  dueDateISO,
  daysLeft,
}) {
  try {
    if (!toEmail) {
      throw new Error("sendComplianceReminderEmail: toEmail is required");
    }

    const due = new Date(dueDateISO);
    const dueText = Number.isNaN(due.getTime())
      ? String(dueDateISO)
      : due.toDateString();

    let whenLine;
    if (daysLeft === 0) whenLine = "Due today";
    else if (daysLeft === 1) whenLine = "Due tomorrow";
    else whenLine = `${daysLeft} day(s) left`;

    const subject = `Compliance Reminder: ${title}`;

    const html = `
      <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; padding:16px; color:#111827;">
        <h2 style="margin-top:0;">Compliance Reminder</h2>

        <p><strong>Title:</strong> ${escapeHtml(title)}</p>
        ${
          clientLabel
            ? `<p><strong>Client:</strong> ${escapeHtml(clientLabel)}</p>`
            : ""
        }
        <p><strong>When:</strong> ${escapeHtml(whenLine)}</p>
        <p><strong>Due date:</strong> ${escapeHtml(dueText)}</p>

        <hr style="margin:16px 0;" />

        <p style="font-size:12px; color:#6b7280;">
          This is an automated reminder from CA PRO Toolkit.
        </p>
      </div>
    `;

    const result = await recordAndSend({
      to: toEmail,
      type: "reminder",
      subjectTemplateName: "compliance_reminder",
      subject,
      html,
    });

    console.log(`📧 Compliance reminder sent to: ${toEmail}`, result.providerMessageId || "");
    return result;
  } catch (err) {
    console.error("❌ Resend reminder error:", err);
    throw err;
  }
}

/**
 * ================================
 * HTML ESCAPE HELPER
 * ================================
 */
function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// A bare, unstyled http(s) URL only - one of these is placed verbatim inside
// a List-Unsubscribe header (a strict mail-header value, no HTML/quoting
// rules apply there the way they do inside an href), the other as the
// literal href in the HTML footer. Rejecting anything else means a caller
// mistake (a relative path, a javascript: URL, a stray angle bracket) fails
// loudly here rather than reaching a real inbox.
function requireUnsubscribeUrl(url, label) {
  const value = String(url || "").trim();
  if (!/^https:\/\/[^\s<>"]+$/.test(value) || value.length > 2000) {
    throw new Error(`sendDigestEmail: ${label} must be a bare https:// URL`);
  }
  return value;
}

// Pure content builder, deliberately separated from sendDigestEmail's
// Resend call below: this is the part with actual branching logic worth
// unit-testing directly (URL validation, escaping, the RFC 8058 headers,
// html/text parity), while the Resend call itself is a thin, untestable-
// without-a-live-key wrapper around it. Throws the same errors sendDigestEmail
// always threw for these inputs, so callers see no behavioural change.
export function buildDigestEmailContent({
  subject,
  heading,
  periodLabel,
  lines = [],
  pageUrl,
  apiUrl,
}) {
  if (!subject || !heading) {
    throw new Error("sendDigestEmail: subject and heading are required");
  }
  if (!Array.isArray(lines) || lines.length > 30) {
    throw new Error("sendDigestEmail: lines must contain at most 30 entries");
  }
  // Required, not optional: a digest is an automated, recurring email, which
  // is exactly the class of message RFC 8058/CAN-SPAM require an unsubscribe
  // path for. Making the caller supply both here - rather than defaulting to
  // "no link" - means a future call site can never silently ship a digest
  // with no way to stop receiving it. pageUrl is the visible footer link a
  // human clicks (opens the confirmation page); apiUrl is what a mail
  // client's automatic one-click handler POSTs to directly (see the header
  // below) - two different readers, two different URLs, and they are not
  // interchangeable: a POST to the static confirmation page would do nothing.
  const safePageUrl = requireUnsubscribeUrl(pageUrl, "pageUrl");
  const safeApiUrl = requireUnsubscribeUrl(apiUrl, "apiUrl");

  const safeLines = lines.map((line) => ({
    label: String(line?.label || "").slice(0, 120),
    value: String(line?.value ?? "").slice(0, 240),
  }));
  const html = `
    <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; padding:16px; color:#111827;">
      <h2 style="margin-top:0;">${escapeHtml(heading)}</h2>
      ${
        periodLabel
          ? `<p style="color:#4b5563;">${escapeHtml(periodLabel)}</p>`
          : ""
      }
      <table style="border-collapse:collapse; width:100%; max-width:640px;">
        <tbody>
          ${safeLines
            .map(
              (line) => `
                <tr>
                  <th scope="row" style="text-align:left; padding:8px; border-bottom:1px solid #e5e7eb;">${escapeHtml(line.label)}</th>
                  <td style="text-align:right; padding:8px; border-bottom:1px solid #e5e7eb;">${escapeHtml(line.value)}</td>
                </tr>`,
            )
            .join("")}
        </tbody>
      </table>
      <p style="font-size:12px; color:#6b7280; margin-top:16px;">
        Operational counts only. Review source records in CA PRO Toolkit before acting.
      </p>
      <p style="font-size:12px; color:#6b7280; margin-top:8px;">
        <a href="${escapeHtml(safePageUrl)}" style="color:#6b7280;">Unsubscribe from this email</a>
      </p>
    </div>
  `;
  // Plain-text alternative: some mail clients render text/plain by default,
  // and a text part is also what a screen reader or a low-bandwidth client
  // falls back to. safeLines are already length-bounded above.
  const text = [
    heading,
    ...(periodLabel ? [periodLabel] : []),
    "",
    ...safeLines.map((line) => `${line.label}: ${line.value}`),
    "",
    "Operational counts only. Review source records in CA PRO Toolkit before acting.",
    "",
    `Unsubscribe from this email: ${safePageUrl}`,
  ].join("\n");

  return {
    html,
    text,
    // RFC 8058: List-Unsubscribe-Post lets a compliant mail client (Gmail,
    // Outlook, Apple Mail) unsubscribe with a direct POST and no human ever
    // opening the link - the "one-click" in one-click unsubscribe. The two
    // headers must be offered together; a List-Unsubscribe header with no
    // List-Unsubscribe-Post is treated by those clients as "manual visit
    // only", not one-click.
    headers: {
      "List-Unsubscribe": `<${safeApiUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}

export async function sendDigestEmail({
  toEmail,
  subject,
  heading,
  periodLabel,
  lines = [],
  idempotencyKey,
  pageUrl,
  apiUrl,
  deliveryType,
  firmId = null,
  userId = null,
  digestDeliveryId = null,
}) {
  if (!toEmail) {
    throw new Error("sendDigestEmail: toEmail is required");
  }
  const normalizedIdempotencyKey = String(idempotencyKey || "").trim();
  if (
    !normalizedIdempotencyKey ||
    normalizedIdempotencyKey.length > 256 ||
    /[^\x21-\x7E]/.test(normalizedIdempotencyKey)
  ) {
    throw new Error(
      "sendDigestEmail: idempotencyKey must contain 1 to 256 visible ASCII characters",
    );
  }
  const { html, text, headers } = buildDigestEmailContent({
    subject,
    heading,
    periodLabel,
    lines,
    pageUrl,
    apiUrl,
  });

  try {
    const result = await recordAndSend({
      to: toEmail,
      // digest.service sends both daily and weekly through this builder; the
      // caller may say which. Default preserves the historical daily routing.
      type: deliveryType === "weekly_digest" ? "weekly_digest" : "daily_digest",
      subjectTemplateName: deliveryType === "weekly_digest" ? "weekly_digest" : "daily_digest",
      subject: String(subject).slice(0, 240),
      html,
      text,
      headers,
      idempotencyKey: normalizedIdempotencyKey,
      firmId,
      userId,
      meta: { digestDeliveryId: digestDeliveryId || null },
    });
    console.log(`Digest email sent to: ${toEmail}`, result.providerMessageId || "");
    return result;
  } catch (error) {
    console.error("Resend digest error:", error?.message || error);
    throw error;
  }
}

export async function sendDailyDigestActivationEmail({
  toEmail,
  activationUrl,
  idempotencyKey,
}) {
  if (!toEmail || !activationUrl || !idempotencyKey) {
    throw new Error("sendDailyDigestActivationEmail requires recipient, activation URL, and idempotency key");
  }
  const safeUrl = requireUnsubscribeUrl(activationUrl, "activationUrl");
  const result = await recordAndSend({
    to: toEmail,
    type: "digest_activation",
    subjectTemplateName: "digest_activation_notice",
    subject: "CA PRO Toolkit: Daily Digest is now off",
    html: `
        <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;padding:16px;color:#111827;">
          <h2 style="margin-top:0;">Daily Digest is now off</h2>
          <p>To reduce unnecessary email, CA PRO Toolkit has turned off daily digest email by default.</p>
          <p>If you want to receive your personal daily work digest, choose it yourself:</p>
          <p><a href="${escapeHtml(safeUrl)}" style="display:inline-block;background:#1d4ed8;color:#fff;padding:10px 14px;border-radius:6px;text-decoration:none;">Activate Daily Digest</a></p>
          <p style="font-size:12px;color:#6b7280;">The button opens a confirmation page. No reminder, OTP, or important compliance email has been turned off.</p>
        </div>`,
    text: `Daily Digest is now off by default. To activate your personal daily work digest, open this link and confirm: ${safeUrl}\n\nReminders, OTPs, and important compliance emails are unchanged.`,
    idempotencyKey: String(idempotencyKey).slice(0, 256),
  });
  return result;
}

/**
 * ================================
 * TEST EMAIL (admin diagnostics)
 * ================================
 * Sends a small "it works" email so an admin can confirm the email pipeline
 * (Resend key + verified domain) is delivering. Returns the provider response.
 */
export async function sendTestEmail(toEmail) {
  if (!toEmail) throw new Error("sendTestEmail: toEmail is required");
  const sentAt = new Date().toISOString();
  const result = await recordAndSend({
    to: toEmail,
    type: "test_email",
    subjectTemplateName: "test_email",
    subject: "CA PRO Toolkit — test email",
    html: `
      <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; padding:16px; color:#111827;">
        <h2 style="margin-top:0;">Email delivery is working ✅</h2>
        <p>This is a test email from CA PRO Toolkit, triggered from the Super Admin panel.</p>
        <p style="font-size:12px; color:#6b7280;">Sent at ${escapeHtml(sentAt)}</p>
      </div>
    `,
  });
  console.log(`📧 Test email sent to: ${toEmail}`, result.providerMessageId || "");
  return result;
}

/**
 * ================================
 * REMINDER DELIVERY-HEALTH ALERT (operational, super admin only)
 * ================================
 * T3 (.kiro/PLAN.md): a best-effort, rate-limited email fired by
 * reminder-delivery-alert.service.js when the fleet-wide failed-delivery
 * count crosses a threshold. Never sent to a client -- toEmail is always
 * SUPER_ADMIN_EMAIL, supplied by the caller.
 */
export async function sendReminderDeliveryAlertEmail({
  toEmail,
  issueCount,
  candidatesScanned,
  candidatesScanTruncated,
  generatedAt,
}) {
  if (!toEmail) {
    throw new Error("sendReminderDeliveryAlertEmail: toEmail is required");
  }
  const generatedAtText =
    generatedAt instanceof Date
      ? generatedAt.toISOString()
      : new Date(generatedAt || Date.now()).toISOString();
  // Honest-copy rule (CLAUDE.md): the fleet scan is capped, so once it is
  // truncated issueCount is a floor, not the true total, and must render as
  // "N+", never as a bare N.
  const countText = candidatesScanTruncated
    ? `${issueCount}+`
    : String(issueCount);

  const subject = `CA PRO Toolkit — ${countText} reminders with a delivery problem`;
  const html = `
    <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; padding:16px; color:#111827;">
      <h2 style="margin-top:0;">Reminder delivery health alert</h2>
      <p><strong>${escapeHtml(countText)}</strong> active reminder(s) currently have an unresolved delivery problem (a failed send, an unconfirmed provider outcome, or a stale processing claim).</p>
      <p>Candidates scanned: ${escapeHtml(String(candidatesScanned))}${candidatesScanTruncated ? " (scan capped — the real total may be higher)" : ""}</p>
      <p>Generated at: ${escapeHtml(generatedAtText)}</p>
      <hr style="margin:16px 0;" />
      <p style="font-size:12px; color:#6b7280;">
        This is a secondary signal only and takes no action. Review the full list in the
        Super Admin panel (GET /api/super/reminder-delivery-health) before acting.
      </p>
    </div>
  `;

  const result = await recordAndSend({
    to: toEmail,
    type: "reminder_alert",
    subjectTemplateName: "reminder_alert",
    subject,
    html,
  });
  console.log(
    `📧 Reminder delivery alert sent to: ${toEmail}`,
    result.providerMessageId || "",
  );
  return result;
}
