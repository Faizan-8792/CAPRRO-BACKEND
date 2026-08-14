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

    if (res?.error) {
      // Resend returns a soft error object (unverified domain, invalid key, etc.)
      // without throwing. Surface it so we never report a false "OTP sent".
      throw new Error(
        String(res.error.message || "Resend rejected the OTP email"),
      );
    }
    console.log(
      `📧 OTP email sent to: ${toEmail}`,
      res?.data?.id || res?.id || "",
    );
    return res;
  } catch (err) {
    // Surface the full Resend error body so you can diagnose domain/key issues
    console.error(
      "❌ Resend OTP error:",
      err?.message,
      JSON.stringify(err?.response?.data ?? err?.cause ?? {}),
    );
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

    if (res?.error) {
      throw new Error(
        String(res.error.message || "Resend rejected the reminder email"),
      );
    }
    console.log(
      `📧 Compliance reminder sent to: ${toEmail}`,
      res?.data?.id || res?.id || "",
    );
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

// A bare, unstyled http(s) URL only - one of these is placed verbatim inside
// a List-Unsubscribe header (a strict mail-header value, no HTML/quoting
// rules apply there the way they do inside an href), the other as the
// literal href in the HTML footer. Rejecting anything else means a caller
// mistake (a relative path, a javascript: URL, a stray angle bracket) fails
// loudly here rather than reaching a real inbox.
function requireUnsubscribeUrl(url, label) {
  const value = String(url || "").trim();
  if (!/^https:\/\/[^\s<>"]+$/.test(value) || value.length > 2000) {
    throw new Error(`sendDigestEmail: ${label} must be a bare https:// URL`);
  }
  return value;
}

// Pure content builder, deliberately separated from sendDigestEmail's
// Resend call below: this is the part with actual branching logic worth
// unit-testing directly (URL validation, escaping, the RFC 8058 headers,
// html/text parity), while the Resend call itself is a thin, untestable-
// without-a-live-key wrapper around it. Throws the same errors sendDigestEmail
// always threw for these inputs, so callers see no behavioural change.
export function buildDigestEmailContent({
  subject,
  heading,
  periodLabel,
  lines = [],
  pageUrl,
  apiUrl,
}) {
  if (!subject || !heading) {
    throw new Error("sendDigestEmail: subject and heading are required");
  }
  if (!Array.isArray(lines) || lines.length > 30) {
    throw new Error("sendDigestEmail: lines must contain at most 30 entries");
  }
  // Required, not optional: a digest is an automated, recurring email, which
  // is exactly the class of message RFC 8058/CAN-SPAM require an unsubscribe
  // path for. Making the caller supply both here - rather than defaulting to
  // "no link" - means a future call site can never silently ship a digest
  // with no way to stop receiving it. pageUrl is the visible footer link a
  // human clicks (opens the confirmation page); apiUrl is what a mail
  // client's automatic one-click handler POSTs to directly (see the header
  // below) - two different readers, two different URLs, and they are not
  // interchangeable: a POST to the static confirmation page would do nothing.
  const safePageUrl = requireUnsubscribeUrl(pageUrl, "pageUrl");
  const safeApiUrl = requireUnsubscribeUrl(apiUrl, "apiUrl");

  const safeLines = lines.map((line) => ({
    label: String(line?.label || "").slice(0, 120),
    value: String(line?.value ?? "").slice(0, 240),
  }));
  const html = `
    <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; padding:16px; color:#111827;">
      <h2 style="margin-top:0;">${escapeHtml(heading)}</h2>
      ${
        periodLabel
          ? `<p style="color:#4b5563;">${escapeHtml(periodLabel)}</p>`
          : ""
      }
      <table style="border-collapse:collapse; width:100%; max-width:640px;">
        <tbody>
          ${safeLines
            .map(
              (line) => `
                <tr>
                  <th scope="row" style="text-align:left; padding:8px; border-bottom:1px solid #e5e7eb;">${escapeHtml(line.label)}</th>
                  <td style="text-align:right; padding:8px; border-bottom:1px solid #e5e7eb;">${escapeHtml(line.value)}</td>
                </tr>`,
            )
            .join("")}
        </tbody>
      </table>
      <p style="font-size:12px; color:#6b7280; margin-top:16px;">
        Operational counts only. Review source records in CA PRO Toolkit before acting.
      </p>
      <p style="font-size:12px; color:#6b7280; margin-top:8px;">
        <a href="${escapeHtml(safePageUrl)}" style="color:#6b7280;">Unsubscribe from this email</a>
      </p>
    </div>
  `;
  // Plain-text alternative: some mail clients render text/plain by default,
  // and a text part is also what a screen reader or a low-bandwidth client
  // falls back to. safeLines are already length-bounded above.
  const text = [
    heading,
    ...(periodLabel ? [periodLabel] : []),
    "",
    ...safeLines.map((line) => `${line.label}: ${line.value}`),
    "",
    "Operational counts only. Review source records in CA PRO Toolkit before acting.",
    "",
    `Unsubscribe from this email: ${safePageUrl}`,
  ].join("\n");

  return {
    html,
    text,
    // RFC 8058: List-Unsubscribe-Post lets a compliant mail client (Gmail,
    // Outlook, Apple Mail) unsubscribe with a direct POST and no human ever
    // opening the link - the "one-click" in one-click unsubscribe. The two
    // headers must be offered together; a List-Unsubscribe header with no
    // List-Unsubscribe-Post is treated by those clients as "manual visit
    // only", not one-click.
    headers: {
      "List-Unsubscribe": `<${safeApiUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}

export async function sendDigestEmail({
  toEmail,
  subject,
  heading,
  periodLabel,
  lines = [],
  idempotencyKey,
  pageUrl,
  apiUrl,
}) {
  if (!toEmail) {
    throw new Error("sendDigestEmail: toEmail is required");
  }
  const normalizedIdempotencyKey = String(idempotencyKey || "").trim();
  if (
    !normalizedIdempotencyKey ||
    normalizedIdempotencyKey.length > 256 ||
    /[^\x21-\x7E]/.test(normalizedIdempotencyKey)
  ) {
    throw new Error(
      "sendDigestEmail: idempotencyKey must contain 1 to 256 visible ASCII characters",
    );
  }
  const { html, text, headers } = buildDigestEmailContent({
    subject,
    heading,
    periodLabel,
    lines,
    pageUrl,
    apiUrl,
  });

  try {
    const response = await getResend().emails.send(
      {
        from: FROM_EMAIL,
        to: toEmail,
        subject: String(subject).slice(0, 240),
        html,
        text,
        headers,
      },
      { idempotencyKey: normalizedIdempotencyKey },
    );
    if (response?.error) {
      throw new Error(
        String(response.error.message || "Resend rejected digest email"),
      );
    }
    console.log(
      `Digest email sent to: ${toEmail}`,
      response?.data?.id || response?.id || "",
    );
    return response;
  } catch (error) {
    console.error("Resend digest error:", error?.message || error);
    throw error;
  }
}

/**
 * ================================
 * TEST EMAIL (admin diagnostics)
 * ================================
 * Sends a small "it works" email so an admin can confirm the email pipeline
 * (Resend key + verified domain) is delivering. Returns the provider response.
 */
export async function sendTestEmail(toEmail) {
  if (!toEmail) throw new Error("sendTestEmail: toEmail is required");
  const sentAt = new Date().toISOString();
  const res = await getResend().emails.send({
    from: FROM_EMAIL,
    to: toEmail,
    subject: "CA PRO Toolkit — test email",
    html: `
      <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; padding:16px; color:#111827;">
        <h2 style="margin-top:0;">Email delivery is working ✅</h2>
        <p>This is a test email from CA PRO Toolkit, triggered from the Super Admin panel.</p>
        <p style="font-size:12px; color:#6b7280;">Sent at ${escapeHtml(sentAt)}</p>
      </div>
    `,
  });
  if (res?.error)
    throw new Error(String(res.error.message || "Resend rejected test email"));
  console.log(
    `📧 Test email sent to: ${toEmail}`,
    res?.data?.id || res?.id || "",
  );
  return res;
}
