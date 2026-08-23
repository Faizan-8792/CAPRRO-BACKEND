// scripts/launch-campaign.mjs
//
// One-off marketing / announcement email campaign for CA PRO Toolkit.
// This is an operational script — it is NOT wired into the product/API.
//
// It sends an announcement email (with a "Add to Chrome" button linking to the
// Chrome Web Store listing) to CA PRO Toolkit users via Resend.
//
// SAFETY MODEL
//   --test        Send ONLY to the super-admin address (TEST_TO). Default mode.
//   --all         Send to every real user (fetched live from the super API).
//   --dry-run     Build + write preview.html, resolve recipients, send NOTHING.
//
// Always writes a rendered preview to scripts/preview.html and appends a JSON
// line per send to scripts/campaign-log.jsonl.
//
// REQUIREMENTS
//   env RESEND_API_KEY   Resend API key (server-side secret; never committed).
//   super-token.txt      Super-admin JWT (repo root of capro-backend), used to
//                        fetch the recipient list for --all. Already gitignored.
//
// USAGE (PowerShell)
//   $env:RESEND_API_KEY="re_xxx"; node scripts/launch-campaign.mjs --test
//   $env:RESEND_API_KEY="re_xxx"; node scripts/launch-campaign.mjs --all
//   node scripts/launch-campaign.mjs --all --dry-run

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resend } from "resend";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..");

/* ─────────────────────────── Configuration ─────────────────────────── */

const FROM_EMAIL = "CA PRO Toolkit <noreply@caprotoolkit.in>";
const REPLY_TO = "saifullahfaizan786@gmail.com";
const TEST_TO = "saifullahfaizan786@gmail.com";

const API_BASE = "https://api.caprotoolkit.in";

// Chrome Web Store listing (email-attributed UTM for tracking). Kept as a
// secondary/fallback link — the store blocks being opened inside framed/in-app
// email views (ERR_BLOCKED_BY_RESPONSE), so it is NOT the primary CTA target.
const CHROME_URL =
  "https://chromewebstore.google.com/detail/ca-pro-toolkit/emimafaefblkocfndndcgghbliodhnkp?hl=en-US&utm_source=email&utm_medium=announcement&utm_campaign=whats_new_2026";
const WEBSITE_URL = "https://caprotoolkit.in";
// Primary CTA target: the website opens reliably in every client and routes to
// the store via its own top-level "Add to Chrome" button.
const WEBSITE_CTA_URL =
  "https://caprotoolkit.in/?utm_source=email&utm_medium=announcement&utm_campaign=whats_new_2026";

// Unique campaign id — part of the Resend idempotency key so a re-run never
// double-sends to the same recipient for this campaign.
const CAMPAIGN_ID = "whats-new-2026-02"; // bumped after CTA fix so the corrected email re-sends (v01 idempotency keys would suppress it)

const SUBJECT = "What's new in CA PRO Toolkit — audit, GST, TDS & more";
const PREHEADER =
  "New tools are live: AI audit review with Standards mapping, GST & TDS reviews, notices, cases and shared firm workspaces.";

// Addresses that must never receive the campaign in --all mode.
const EXCLUDE = new Set(["test@example.com"]);

// Politeness delay between sends (Resend allows ~2 req/s on default plans).
const SEND_DELAY_MS = 600;

const LOG_FILE = path.join(__dirname, "campaign-log.jsonl");
const PREVIEW_FILE = path.join(__dirname, "preview.html");

/* ───────────────────────────── Helpers ─────────────────────────────── */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function firstName(name, email) {
  const n = String(name || "").trim();
  if (n) return n.split(/\s+/)[0];
  // Fall back to a friendly generic greeting rather than an email local-part.
  return "there";
}

function parseArgs(argv) {
  const raw = argv.slice(2);
  const args = new Set(raw);

  // Extract a value-bearing flag in both "--flag value" and "--flag=value" forms.
  const valueOf = (flag) => {
    for (let i = 0; i < raw.length; i++) {
      const a = raw[i];
      if (a === flag) return raw[i + 1] || "";
      if (a.startsWith(flag + "=")) return a.slice(flag.length + 1);
    }
    return "";
  };

  const all = args.has("--all");
  return {
    mode: all ? "all" : "test",
    dryRun: args.has("--dry-run"),
    forceTestButAll: all && args.has("--test"),
    // Override the test recipient (test mode only), e.g. --to someone@x.com
    to: valueOf("--to").trim().toLowerCase(),
    // Diagnostic: look up delivery status of a previously-sent Resend id.
    statusId: valueOf("--status").trim(),
    // Verify delivery after sending. On by default in test mode.
    verify: args.has("--verify") || (!all && !args.has("--no-verify")),
  };
}

// Poll Resend for the delivery event of a sent email. Newly-sent mail can sit
// in "sent"/"queued" for a few seconds before "delivered", so poll briefly.
async function printStatus(resend, id, email = "") {
  let last = "";
  for (let i = 0; i < 6; i++) {
    try {
      const { data, error } = await resend.emails.get(id);
      if (error) {
        console.error(`  ⚠️  ${id} lookup error: ${String(error.message || error)}`);
        return last;
      }
      last = data?.last_event || data?.status || "unknown";
      const who = email || (Array.isArray(data?.to) ? data.to[0] : "") || "";
      console.log(`  📬 ${who} ${id} → ${last}`);
      if (last && last !== "sent" && last !== "queued") return last;
    } catch (e) {
      console.error(`  ⚠️  ${id} lookup failed: ${String(e?.message || e)}`);
      return last;
    }
    await sleep(2500);
  }
  console.log(`  (still "${last}" after polling — check the Resend dashboard for the final status)`);
  return last;
}

/* ─────────────────────────── Email template ─────────────────────────── */

function buildHtml({ name, email } = {}) {
  const greetName = escapeHtml(firstName(name, email));
  const unsubscribe = `mailto:${REPLY_TO}?subject=${encodeURIComponent(
    "Unsubscribe from CA PRO Toolkit emails"
  )}`;

  const features = [
    {
      title: "AI Audit Review",
      body: "Paste text or upload a PDF/Word working paper — every procedure is mapped to the Standards on Auditing, Ind AS and Companies Act sections that govern it.",
    },
    {
      title: "GST Reconciliation",
      body: "Purchase Register vs GSTR-2B with a GSTR-3B control — exact to the paise, with every ambiguous case held for your review.",
    },
    {
      title: "TDS Review",
      body: "Deductions, ITNS 281 challans, statements, PAN and 26AS turned into clear, source-linked health checks.",
    },
    {
      title: "Notices, Cases & Firm workspaces",
      body: "Track notice deadlines, draft responses, run audit engagements, and share one task board across your whole firm.",
    },
  ];

  const featureRows = features
    .map(
      (f) => `
      <tr>
        <td style="padding:0 0 18px 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
            <tr>
              <td width="8" style="background:#0f5260;border-radius:4px;"></td>
              <td width="16"></td>
              <td style="font-family:Arial,Helvetica,sans-serif;">
                <div style="font-size:16px;font-weight:bold;color:#0f2b31;line-height:1.3;">${escapeHtml(
                  f.title
                )}</div>
                <div style="font-size:14px;color:#4b5563;line-height:1.6;padding-top:4px;">${escapeHtml(
                  f.body
                )}</div>
              </td>
            </tr>
          </table>
        </td>
      </tr>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<title>${escapeHtml(SUBJECT)}</title>
</head>
<body style="margin:0;padding:0;background:#eef2f3;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:#eef2f3;">
    ${escapeHtml(PREHEADER)}
  </div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f3;border-collapse:collapse;">
    <tr>
      <td align="center" style="padding:28px 12px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e2e8ea;">

          <!-- Header -->
          <tr>
            <td style="background:#0f5260;padding:26px 32px;font-family:Arial,Helvetica,sans-serif;">
              <div style="font-size:20px;font-weight:bold;color:#ffffff;letter-spacing:0.2px;">CA PRO Toolkit</div>
              <div style="font-size:12px;color:#bfe0e6;padding-top:2px;">Audit &amp; compliance workspace for CA firms</div>
            </td>
          </tr>

          <!-- Hero -->
          <tr>
            <td style="padding:34px 32px 8px 32px;font-family:Arial,Helvetica,sans-serif;">
              <div style="font-size:24px;font-weight:bold;color:#0f2b31;line-height:1.3;">Hi ${greetName}, here's what's new</div>
              <p style="font-size:15px;color:#4b5563;line-height:1.7;margin:14px 0 0 0;">
                We've been shipping. CA PRO Toolkit now brings your firm's audit review,
                GST and TDS checks, notices, cases and team tasks together in one browser tab —
                and it's free to use. Here are a few highlights worth a fresh look.
              </p>
            </td>
          </tr>

          <!-- Features -->
          <tr>
            <td style="padding:26px 32px 6px 32px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
                ${featureRows}
              </table>
            </td>
          </tr>

          <!-- CTA button (bulletproof) -->
          <tr>
            <td align="center" style="padding:14px 32px 34px 32px;">
              <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:separate;">
                <tr>
                  <td align="center" bgcolor="#0f5260" style="border-radius:10px;">
                    <a href="${WEBSITE_CTA_URL}" target="_blank"
                       style="display:inline-block;padding:15px 34px;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:10px;">
                      Get CA PRO Toolkit &nbsp;&rarr;
                    </a>
                  </td>
                </tr>
              </table>
              <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#94a3b8;padding-top:12px;">
                Free to install &middot; Sign in with Google &middot; No card required
              </div>
              <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#94a3b8;padding-top:8px;">
                Or open the <a href="${CHROME_URL}" target="_blank" style="color:#0f5260;text-decoration:underline;">Chrome Web Store listing</a> directly.
              </div>
            </td>
          </tr>

          <!-- Divider -->
          <tr><td style="padding:0 32px;"><div style="border-top:1px solid #e5e7eb;"></div></td></tr>

          <!-- Footer -->
          <tr>
            <td style="padding:20px 32px 30px 32px;font-family:Arial,Helvetica,sans-serif;">
              <p style="font-size:12px;color:#8a99a3;line-height:1.6;margin:0;">
                You're receiving this because you have a CA PRO Toolkit account.
                CA PRO Toolkit assists professional review and organisation; it does not file to any government portal.
              </p>
              <p style="font-size:12px;color:#8a99a3;line-height:1.6;margin:10px 0 0 0;">
                <a href="${WEBSITE_URL}" target="_blank" style="color:#0f5260;text-decoration:underline;">Website</a>
                &nbsp;&middot;&nbsp;
                <a href="${unsubscribe}" style="color:#0f5260;text-decoration:underline;">Unsubscribe</a>
                &nbsp;&middot;&nbsp;
                <span>&copy; 2026 Saifullah Faizan, sole proprietor, trading as CA PRO Toolkit</span>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function buildText({ name } = {}) {
  const greet = firstName(name);
  return [
    `Hi ${greet}, here's what's new in CA PRO Toolkit.`,
    ``,
    `Your firm's audit review, GST and TDS checks, notices, cases and team tasks — together in one browser tab, free to use.`,
    ``,
    `- AI Audit Review: procedures mapped to Standards on Auditing, Ind AS and Companies Act sections.`,
    `- GST Reconciliation: Purchase Register vs GSTR-2B with a GSTR-3B control, exact to the paise.`,
    `- TDS Review: challans, statements, PAN and 26AS turned into source-linked health checks.`,
    `- Notices, Cases & shared firm workspaces.`,
    ``,
    `Get CA PRO Toolkit: ${WEBSITE_CTA_URL}`,
    `Or open the Chrome Web Store listing directly: ${CHROME_URL}`,
    ``,
    `Website: ${WEBSITE_URL}`,
    `To unsubscribe, reply to this email with "Unsubscribe".`,
    `© 2026 Saifullah Faizan, sole proprietor, trading as CA PRO Toolkit`,
  ].join("\n");
}

/* ─────────────────────────── Recipients ─────────────────────────────── */

async function fetchAllRecipients() {
  const tokenPath = path.join(PKG_ROOT, "super-token.txt");
  if (!fs.existsSync(tokenPath)) {
    throw new Error(`super-token.txt not found at ${tokenPath} (needed for --all)`);
  }
  const token = fs.readFileSync(tokenPath, "utf8").trim();

  const recipients = [];
  let page = 1;
  const limit = 100;
  // Paginate defensively even though the user base is small.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const url = `${API_BASE}/api/super/users?page=${page}&limit=${limit}&sort=signup`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`super/users failed: HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    for (const u of data.users || []) {
      if (!u.email) continue;
      const email = String(u.email).toLowerCase().trim();
      if (EXCLUDE.has(email)) continue;
      if (u.isActive === false) continue;
      recipients.push({ email, name: u.name || "" });
    }
    if (!data.pagination?.hasMore) break;
    page += 1;
    if (page > 50) break; // hard safety stop
  }

  // Dedupe by email.
  const seen = new Set();
  return recipients.filter((r) =>
    seen.has(r.email) ? false : (seen.add(r.email), true)
  );
}

/* ───────────────────────────── Send loop ────────────────────────────── */

function logLine(entry) {
  fs.appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
}

async function main() {
  const { mode, dryRun, forceTestButAll, to, statusId, verify } = parseArgs(process.argv);
  if (forceTestButAll) {
    console.error("Refusing to run with both --test and --all. Pick one.");
    process.exit(1);
  }

  // Diagnostic mode: just look up an existing email's delivery status.
  if (statusId) {
    const key = process.env.RESEND_API_KEY;
    if (!key) {
      console.error("❌ RESEND_API_KEY env var is required for --status.");
      process.exit(1);
    }
    console.log(`Checking delivery status for ${statusId}...`);
    await printStatus(new Resend(key), statusId);
    return;
  }

  // Always write a preview so the email can be reviewed in a browser.
  fs.writeFileSync(PREVIEW_FILE, buildHtml({ name: "Saifullah", email: TEST_TO }), "utf8");
  console.log(`📄 Preview written: ${PREVIEW_FILE}`);

  // Resolve recipients.
  let recipients;
  if (mode === "test") {
    const target = to || TEST_TO;
    recipients = [{ email: target, name: "" }];
  } else {
    recipients = await fetchAllRecipients();
  }

  console.log(`Mode: ${mode.toUpperCase()} | recipients: ${recipients.length}${dryRun ? " | DRY RUN" : ""}`);
  recipients.forEach((r, i) => console.log(`  ${i + 1}. ${r.email}`));

  if (dryRun) {
    console.log("Dry run — no emails sent.");
    return;
  }

  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.error("\n❌ RESEND_API_KEY env var is required to send.");
    console.error('   PowerShell: $env:RESEND_API_KEY="re_xxx"; node scripts/launch-campaign.mjs --' + mode);
    process.exit(1);
  }
  const resend = new Resend(key);

  let ok = 0;
  let fail = 0;
  const sent = [];
  for (const r of recipients) {
    try {
      const res = await resend.emails.send(
        {
          from: FROM_EMAIL,
          to: r.email,
          replyTo: REPLY_TO,
          subject: SUBJECT,
          html: buildHtml(r),
          text: buildText(r),
          headers: {
            "List-Unsubscribe": `<mailto:${REPLY_TO}?subject=Unsubscribe>`,
          },
        },
        { idempotencyKey: `${CAMPAIGN_ID}:${r.email}` }
      );
      if (res?.error) throw new Error(String(res.error.message || "Resend rejected the email"));
      const id = res?.data?.id || res?.id || "";
      ok += 1;
      sent.push({ email: r.email, id });
      console.log(`✅ ${r.email} ${id}`);
      logLine({ campaign: CAMPAIGN_ID, mode, email: r.email, status: "sent", id });
    } catch (err) {
      fail += 1;
      const msg = String(err?.message || err).slice(0, 300);
      console.error(`❌ ${r.email} — ${msg}`);
      logLine({ campaign: CAMPAIGN_ID, mode, email: r.email, status: "failed", error: msg });
    }
    await sleep(SEND_DELAY_MS);
  }

  console.log(`\nDone. Sent: ${ok}, Failed: ${fail}, Total: ${recipients.length}`);

  // Confirm delivery with Resend (accepted != delivered).
  if (verify && sent.length) {
    console.log(`\nVerifying delivery with Resend...`);
    for (const s of sent) {
      await printStatus(resend, s.id, s.email);
    }
    console.log(
      `\nNote: "delivered" means the receiving server accepted it. If it's not in the inbox,` +
      ` check Spam/Promotions and add ${FROM_EMAIL.match(/<(.+)>/)?.[1] || FROM_EMAIL} to contacts.`
    );
  }
}

main().catch((err) => {
  console.error("Fatal:", err?.message || err);
  process.exit(1);
});
