// src/services/email.service.js

import { Resend } from "resend";
import { sendReminderEmail } from "../config/email.js";

/**
 * Resend client (optional)
 *
 * In local/dev environments we don't want the whole server to crash if
 * RESEND_API_KEY isn't set. We'll lazily create the client when needed.
 */
let resend = null;
function getResendClient() {
  if (resend) return resend;
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  resend = new Resend(key);
  return resend;
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

    const resendClient = getResendClient();
    if (!resendClient) {
      // Fallback: nodemailer transporter (if configured)
      try {
        const subject = "Your CA PRO Toolkit OTP";
        const text = `Your One-Time Password (OTP) is: ${otp}. This OTP is valid for 10 minutes.`;
        await sendReminderEmail(toEmail, subject, text);
        console.log(`📧 OTP email sent via SMTP to: ${toEmail}`);
        return { id: "smtp_fallback" };
      } catch (smtpErr) {
        console.warn(
          "⚠️ No RESEND_API_KEY and SMTP not configured. Skipping OTP email in dev.",
          smtpErr?.message || smtpErr
        );
        return { id: "skipped_no_email_config" };
      }
    }

    const res = await resendClient.emails.send({
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
    console.error("❌ Resend OTP error:", err);
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

    const resendClient = getResendClient();

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

    let res;
    if (resendClient) {
      res = await resendClient.emails.send({
        from: FROM_EMAIL,
        to: toEmail,
        subject,
        html,
      });
    } else {
      // Fallback: nodemailer transporter
      try {
        const text = `Compliance Reminder\n\nTitle: ${title}\nClient: ${clientLabel || ""}\n${whenLine}\nDue: ${dueText}`;
        await sendReminderEmail(toEmail, subject, text);
        res = { id: "smtp_fallback" };
      } catch (smtpErr) {
        console.warn(
          "⚠️ No RESEND_API_KEY and SMTP not configured. Skipping reminder email in dev.",
          smtpErr?.message || smtpErr
        );
        res = { id: "skipped_no_email_config" };
      }
    }

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
