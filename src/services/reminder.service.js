// src/services/reminder.service.js
//
// The compliance-reminder send routes through the shared mailer
// (services/mailer.js) — one Resend client, suppression checking, and an
// EmailDelivery row per send (IMPROVEMENT-PLAN-V2-2026-09-28 Part 1).

import { sendEmail as recordAndSend } from "./mailer.js";

// ---------- Helper ----------
function escHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// ---------- Provider-bound delivery (through the shared mailer) ----------
export async function sendComplianceReminderEmail({
  toEmail,
  title,
  clientLabel,
  dueDateISO,
  daysLeft,
  idempotencyKey,
  reminderId = null,
  firmId = null,
  userId = null,
}) {
  if (!toEmail) {
    throw new Error("sendComplianceReminderEmail: toEmail is required");
  }

  const normalizedIdempotencyKey = String(idempotencyKey || "").trim();
  if (!normalizedIdempotencyKey) {
    throw new Error("sendComplianceReminderEmail: idempotencyKey is required");
  }

  const due = new Date(dueDateISO);
  const dueText = Number.isNaN(due.getTime())
    ? String(dueDateISO)
    : due.toDateString();

  let whenLine;
  if (daysLeft < 0) {
    whenLine = `Overdue by ${Math.abs(daysLeft)} day(s)`;
  } else if (daysLeft === 0) {
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

  const result = await recordAndSend({
    to: toEmail,
    type: "reminder",
    subjectTemplateName: "compliance_reminder",
    subject,
    text,
    html,
    idempotencyKey: normalizedIdempotencyKey,
    firmId,
    userId,
    meta: { reminderId: reminderId || null },
  });

  console.log("📧 Compliance reminder sent to", toEmail);
  return { providerMessageId: result.providerMessageId, deliveryId: result.deliveryId };
}
