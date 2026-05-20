// src/services/reminder.service.js

import { Resend } from "resend";

// Lazy Resend client
let _resend = null;
function getResend() {
  if (!_resend) {
    const key = process.env.RESEND_API_KEY;
    if (!key) throw new Error("RESEND_API_KEY env var is required");
    _resend = new Resend(key);
  }
  return _resend;
}

// Default Resend sender (no custom domain required)
const FROM_EMAIL = "CA PRO Toolkit <noreply@caprotoolkit.in>";


// ---------- Helper ----------
function escHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// ---------- SAME FUNCTION, SAME SIGNATURE ----------
// ONLY email sending engine is changed (nodemailer → Resend)
export async function sendComplianceReminderEmail({
  toEmail,
  title,
  clientLabel,
  dueDateISO,
  daysLeft,
}) {
  if (!toEmail) {
    throw new Error("sendComplianceReminderEmail: toEmail is required");
  }

  const due = new Date(dueDateISO);
  const dueText = Number.isNaN(due.getTime())
    ? String(dueDateISO)
    : due.toDateString();

  let whenLine;
  if (daysLeft === 0) {
    whenLine = "Due today";
  } else if (daysLeft === 1) {
    whenLine = "Due tomorrow";
  } else {
    whenLine = `${daysLeft} day(s) left`;
  }

  const clientLine = clientLabel ? `Client: ${clientLabel}` : "";

  const subject = `Compliance Reminder: ${title}`;

  const text = [
    "Compliance Reminder",
    `Title: ${title}`,
    clientLine,
    `When: ${whenLine}`,
    `Due date: ${dueText}`,
    "",
    "This is an automated reminder from CA PRO Toolkit.",
  ]
    .filter(Boolean)
    .join("\n");

  const html = `
    <div style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding:16px; color:#111827;">
      <h2 style="margin-top:0; color:#111827;">Compliance Reminder</h2>
      <p><strong>Title:</strong> ${escHtml(title)}</p>
      ${
        clientLabel
          ? `<p><strong>Client:</strong> ${escHtml(clientLabel)}</p>`
          : ""
      }
      <p><strong>When:</strong> ${escHtml(whenLine)}</p>
      <p><strong>Due date:</strong> ${escHtml(dueText)}</p>
      <hr style="margin:16px 0; border:none; border-top:1px solid #e5e7eb;" />
      <p style="font-size:12px; color:#6b7280;">
        This is an automated reminder from CA PRO Toolkit.
      </p>
    </div>
  `;

  const { error } = await getResend().emails.send({
    from: FROM_EMAIL,
    to: [toEmail],
    subject,
    text,
    html,
  });

  if (error) {
    console.error("❌ Resend compliance reminder failed:", error);
    throw new Error("Compliance reminder email failed");
  }

  console.log("📧 Compliance reminder sent to", toEmail);
}
