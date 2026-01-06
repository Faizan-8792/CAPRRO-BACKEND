// src/services/reminder.service.js

// NOTE:
// This service is kept for backward compatibility. The actual sending logic
// lives in email.service.js (which supports Resend, SMTP fallback, and a dev
// no-op when neither is configured).

import { sendComplianceReminderEmail as sendEmailComplianceReminderEmail } from "./email.service.js";


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
  return sendEmailComplianceReminderEmail({
    toEmail,
    title,
    clientLabel,
    dueDateISO,
    daysLeft,
  });
}
