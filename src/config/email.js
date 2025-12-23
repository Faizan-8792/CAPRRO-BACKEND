import nodemailer from 'nodemailer';

let transporter;

export function getEmailTransporter() {
  if (transporter) return transporter;

  const {
    EMAIL_HOST,
    EMAIL_PORT,
    EMAIL_SECURE,
    EMAIL_USER,
    EMAIL_PASS
  } = process.env;

  if (!EMAIL_HOST || !EMAIL_PORT || !EMAIL_USER || !EMAIL_PASS) {
    throw new Error('Email env vars missing (EMAIL_HOST/PORT/USER/PASS)');
  }

  transporter = nodemailer.createTransport({
    host: EMAIL_HOST,
    port: Number(EMAIL_PORT),
    secure: EMAIL_SECURE === 'true',
    auth: {
      user: EMAIL_USER,
      pass: EMAIL_PASS
    }
  });

  return transporter;
}

// ✅ NEW: helper used by reminder.controller.js
export async function sendReminderEmail(to, subject, text) {
  const tx = getEmailTransporter();

  const from =
    process.env.EMAIL_FROM ||
    process.env.EMAIL_USER ||
    'CA PRO Toolkit <no-reply@capro.local>';

  await tx.sendMail({
    from,
    to,
    subject,
    text
  });
}
