// src/services/email-layout.js
//
// DS25: one branded layout for every email CA PRO sends - the OTP, reminders, digests, the digest
// activation notice, the test email and the delivery alert. Before this, each template carried its
// own inline styles in an off-brand grey and blue, and four of the six had no plain-text part.
//
// Email is not a web page. What this layout does, and why:
//   - Tables and inline styles only: Outlook's Word engine ignores most CSS, and Gmail strips
//     <style> blocks in several of its clients. Nothing here depends on a stylesheet.
//   - The palette's light values, written out as hex (an email cannot read CSS variables): paper
//     ground, a white card on a hairline, teal-black ink, the muted grey for small print, the teal
//     accent for the one button. Every pair reads at least 4.5:1 (tests/email-layout-contract.mjs).
//   - The brand rule is three cells - navy, teal, emerald - because no mail client draws a gradient
//     reliably; the mark is an absolute https image with alt text, so a client that blocks images
//     still shows "CA PRO" in the header beside it.
//   - IBM Plex is named first and the system faces after it: most clients will not load a web font,
//     and none is fetched.
//   - Every caller-supplied string is escaped here or by the caller before it reaches the layout;
//     the layout escapes what it is given as text (title, preheader, footer lines).
//
// What an email SAYS is the caller's: this module never adds, removes or rewords content. It frames.

const PALETTE = Object.freeze({
  canvas: "#FBFAF7",
  surface: "#FFFFFF",
  subtle: "#F4F1E8",
  border: "#E0DBCD",
  ink: "#13262C",
  muted: "#6B6357",
  accent: "#177184",
  onAccent: "#FFFFFF",
  cream: "#F4EFDC",
  navy: "#183C84",
  emerald: "#119D75",
});

const FONT = "'IBM Plex Sans', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MARK_URL = "https://api.caprotoolkit.in/admin/ui/capro-mark.png";

export function escapeEmailHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * A due date - a UTC calendar day - in the form Date.prototype.toDateString() gives ("Wed Oct 07
 * 2026"), read in UTC. toDateString() reads the server's own time zone, so on a server west of UTC a
 * date stored as that day's UTC midnight came out as the day before (CLAUDE.md: deadlines are UTC
 * days). Same words, same order, never moved across a day.
 */
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function formatDueDayForEmail(dueDateISO) {
  const due = new Date(dueDateISO);
  if (Number.isNaN(due.getTime())) return String(dueDateISO);
  return `${WEEKDAYS[due.getUTCDay()]} ${MONTHS[due.getUTCMonth()]} ${String(due.getUTCDate()).padStart(2, "0")} ${due.getUTCFullYear()}`;
}

/** The one button an email may carry: a table, so Outlook draws it as a button and not a link. */
export function emailButton(href, label) {
  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 16px;">
  <tr>
    <td style="border-radius:8px;background:${PALETTE.accent};">
      <a href="${escapeEmailHtml(href)}" style="display:inline-block;padding:10px 18px;font-family:${FONT};font-size:15px;line-height:20px;font-weight:600;color:${PALETTE.onAccent};text-decoration:none;border-radius:8px;">${escapeEmailHtml(label)}</a>
    </td>
  </tr>
</table>`;
}

/**
 * Frames an email's own content.
 *   title       the heading, as text (escaped here)
 *   bodyHtml    the email's content, already escaped by the caller
 *   preheader   the line inbox lists show beside the subject (text, escaped here; optional)
 *   footerLines small print under the card (text, escaped here)
 *   footerHtml  small print that needs markup - an unsubscribe link (already escaped)
 */
export function renderEmailLayout({ title, bodyHtml = "", preheader = "", footerLines = [], footerHtml = "" }) {
  const footer = [
    ...footerLines.map((line) => `<p style="margin:0 0 6px;font-family:${FONT};font-size:12px;line-height:18px;color:${PALETTE.muted};">${escapeEmailHtml(line)}</p>`),
    footerHtml ? `<p style="margin:0 0 6px;font-family:${FONT};font-size:12px;line-height:18px;color:${PALETTE.muted};">${footerHtml}</p>` : "",
    `<p style="margin:0;font-family:${FONT};font-size:12px;line-height:18px;color:${PALETTE.muted};">CA PRO Toolkit &middot; caprotoolkit.in</p>`,
  ].join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeEmailHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:${PALETTE.canvas};">
${preheader ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${escapeEmailHtml(preheader)}</div>` : ""}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PALETTE.canvas};">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
        <tr>
          <td style="padding:0 0 12px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="width:36px;height:36px;background:${PALETTE.cream};border-radius:8px;text-align:center;vertical-align:middle;">
                  <img src="${MARK_URL}" width="28" height="28" alt="CA PRO" style="display:block;margin:4px auto;border:0;">
                </td>
                <td style="padding-left:10px;font-family:${FONT};font-size:16px;line-height:22px;font-weight:600;color:${PALETTE.ink};">CA PRO Toolkit</td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="background:${PALETTE.surface};border:1px solid ${PALETTE.border};border-radius:12px;overflow:hidden;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="height:4px;line-height:4px;font-size:0;background:${PALETTE.navy};">&nbsp;</td>
                <td style="height:4px;line-height:4px;font-size:0;background:${PALETTE.accent};">&nbsp;</td>
                <td style="height:4px;line-height:4px;font-size:0;background:${PALETTE.emerald};">&nbsp;</td>
              </tr>
            </table>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="padding:24px 24px 8px;font-family:${FONT};font-size:15px;line-height:22px;color:${PALETTE.ink};">
                  <h1 style="margin:0 0 12px;font-family:${FONT};font-size:20px;line-height:28px;font-weight:600;color:${PALETTE.ink};">${escapeEmailHtml(title)}</h1>
                  ${bodyHtml}
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 4px 0;">${footer}</td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

export const EMAIL_PALETTE = PALETTE;
