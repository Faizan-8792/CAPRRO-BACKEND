import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

// Default Resend domain (no custom domain needed)
const FROM_EMAIL = "CA PRO Toolkit <onboarding@resend.dev>";

/**
 * TASK / REMINDER EMAIL
 */
export async function sendReminderEmail({ to, subject, html, text }) {
  try {
    const { error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: [to],
      subject,
      html,
      text,
    });

    if (error) {
      console.error("❌ Resend reminder error:", error);
      return false;
    }

    console.log("📧 Reminder email sent to:", to);
    return true;
  } catch (err) {
    console.error("❌ Reminder email failed:", err.message);
    return false;
  }
}

/**
 * OTP EMAIL
 */
export async function sendOtpEmail(to, otp) {
  try {
    const { error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: [to],
      subject: "Your CA PRO Toolkit Login OTP",
      html: `
        <div style="font-family: Arial, sans-serif">
          <h2>CA PRO Toolkit</h2>
          <p>Your login OTP is:</p>
          <h1 style="letter-spacing:2px">${otp}</h1>
          <p>This OTP is valid for 10 minutes.</p>
        </div>
      `,
      text: `Your OTP is ${otp}. Valid for 10 minutes.`,
    });

    if (error) {
      console.error("❌ Resend OTP error:", error);
      return false;
    }

    console.log("📧 OTP email sent to:", to);
    return true;
  } catch (err) {
    console.error("❌ OTP email failed:", err.message);
    return false;
  }
}
