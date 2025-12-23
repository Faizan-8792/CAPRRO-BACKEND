// src/services/reminder.service.js

import { getEmailTransporter } from "../config/email.js";

function escHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

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

  const transporter = getEmailTransporter();
  const from = process.env.EMAIL_FROM || process.env.EMAIL_USER;

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

  await transporter.sendMail({
    from,
    to: toEmail,
    subject,
    text,
    html,
  });
}
