// src/services/email.service.js

import { Resend } from "resend";

/**
 * Lazy Resend client — initialized on first use so missing env var
 * doesn't crash the module at import time.
 */
let _resend = null;
function getResend() {
  if (!_resend) {
    const key = process.env.RESEND_API_KEY;
    if (!key) throw new Error("RESEND_API_KEY env var is required");
    _resend = new Resend(key);
  }
  return _resend;
}

/**
 * VERIFIED sender (must match verified domain in Resend)
 */
const FROM_EMAIL = "CA PRO Toolkit <noreply@caprotoolkit.in>";

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

    const res = await getResend().emails.send({
      from: FROM_EMAIL,
      to: toEmail,
      subject: "Your CA PRO Toolkit OTP",
      html: `
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
      `,
    });

    console.log(`📧 OTP email sent to: ${toEmail}`, res?.id || "");
    return res;
  } catch (err) {
    // Surface the full Resend error body so you can diagnose domain/key issues
    console.error("❌ Resend OTP error:", err?.message, JSON.stringify(err?.response?.data ?? err?.cause ?? {}));
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

    const res = await getResend().emails.send({
      from: FROM_EMAIL,
      to: toEmail,
      subject,
      html,
    });

    console.log(`📧 Compliance reminder sent to: ${toEmail}`, res?.id || "");
    return res;
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

export async function sendDigestEmail({
  toEmail,
  subject,
  heading,
  periodLabel,
  lines = [],
  idempotencyKey,
}) {
  if (!toEmail || !subject || !heading) {
    throw new Error(
      "sendDigestEmail: toEmail, subject, and heading are required"
    );
  }
  if (!Array.isArray(lines) || lines.length > 30) {
    throw new Error("sendDigestEmail: lines must contain at most 30 entries");
  }
  const normalizedIdempotencyKey = String(idempotencyKey || "").trim();
  if (
    !normalizedIdempotencyKey ||
    normalizedIdempotencyKey.length > 256 ||
    /[^\x21-\x7E]/.test(normalizedIdempotencyKey)
  ) {
    throw new Error(
      "sendDigestEmail: idempotencyKey must contain 1 to 256 visible ASCII characters"
    );
  }

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
                </tr>`
            )
            .join("")}
        </tbody>
      </table>
      <p style="font-size:12px; color:#6b7280; margin-top:16px;">
        Operational counts only. Review source records in CA PRO Toolkit before acting.
      </p>
    </div>
  `;

  try {
    const response = await getResend().emails.send(
      {
        from: FROM_EMAIL,
        to: toEmail,
        subject: String(subject).slice(0, 240),
        html,
      },
      { idempotencyKey: normalizedIdempotencyKey }
    );
    if (response?.error) {
      throw new Error(
        String(response.error.message || "Resend rejected digest email")
      );
    }
    console.log(`Digest email sent to: ${toEmail}`, response?.data?.id || response?.id || "");
    return response;
  } catch (error) {
    console.error("Resend digest error:", error?.message || error);
    throw error;
  }
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
  const res = await getResend().emails.send({
    from: FROM_EMAIL,
    to: toEmail,
    subject: "CA PRO Toolkit — test email",
    html: `
      <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; padding:16px; color:#111827;">
        <h2 style="margin-top:0;">Email delivery is working ✅</h2>
        <p>This is a test email from CA PRO Toolkit, triggered from the Super Admin panel.</p>
        <p style="font-size:12px; color:#6b7280;">Sent at ${escapeHtml(sentAt)}</p>
      </div>
    `,
  });
  if (res?.error) throw new Error(String(res.error.message || "Resend rejected test email"));
  console.log(`📧 Test email sent to: ${toEmail}`, res?.data?.id || res?.id || "");
  return res;
}
