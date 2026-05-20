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
