import { getEmailTransporter } from '../config/email.js';

export async function sendOtpEmail(toEmail, otpCode) {
  const transporter = getEmailTransporter();

  const from = process.env.EMAIL_FROM || process.env.EMAIL_USER;

  const mailOptions = {
    from,
    to: toEmail,
    subject: 'Your CA PRO Toolkit login code',
    text: `Your login OTP is ${otpCode}. It will expire in 10 minutes.`,
    html: `
      <p>Hi There,</p>
      <p>Your <b>CA PRO Toolkit</b> login code is:</p>
      <p style="font-size: 24px; font-weight: bold;">${otpCode}</p>
      <p>This code will expire in 10 minutes. If you did not request this, you can ignore this email.</p>
    `
  };

  await transporter.sendMail(mailOptions);
}
