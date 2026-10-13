// src/services/reminder.service.js
//
// The compliance-reminder send routes through the shared mailer
// (services/mailer.js) — one Resend client, suppression checking, and an
// EmailDelivery row per send (IMPROVEMENT-PLAN-V2-2026-09-28 Part 1).
//
// DS25: the reminder is built by buildComplianceReminderEmail - a pure function,
// in the one branded email layout - and only sent here. Its due date is read as
// the stored UTC day: toDateString() read the server's own time zone, so west
// of UTC a date stored at that day's UTC midnight came out as the day before.

import { sendEmail as recordAndSend } from "./mailer.js";
import {
  escapeEmailHtml as escHtml,
  formatDueDayForEmail,
  renderEmailLayout,
} from "./email-layout.js";

// ---------- The email itself (pure: no send, no database) ----------
export function buildComplianceReminderEmail({ title, clientLabel, dueDateISO, daysLeft }) {
  const dueText = formatDueDayForEmail(dueDateISO);

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

  const row = (label, value) =>
    `<p style="margin:0 0 8px;"><strong>${label}:</strong> ${escHtml(value)}</p>`;
  const html = renderEmailLayout({
    title: "Compliance Reminder",
    bodyHtml: [
      row("Title", title),
      clientLabel ? row("Client", clientLabel) : "",
      row("When", whenLine),
      row("Due date", dueText),
    ].join(""),
    footerLines: ["This is an automated reminder from CA PRO Toolkit."],
  });

  return { subject: `Compliance Reminder: ${title}`, html, text };
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

  const { subject, html, text } = buildComplianceReminderEmail({ title, clientLabel, dueDateISO, daysLeft });

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
