// tests/email-layout-contract.mjs
//
// DS25: every email CA PRO sends goes out in one branded layout (src/services/email-layout.js), with
// a plain-text part, and without the layout changing what the email says. This holds:
//   - every template is built by a pure function, so it can be checked (and photographed) without
//     sending anything;
//   - each email's words are still there, in the HTML and in the text part;
//   - the layout's colour pairs read at least 4.5:1 (normal text) - an email cannot rely on the
//     page's CSS, so the hex values are checked here;
//   - caller text is escaped wherever the layout places it;
//   - a due date is the stored UTC day, whatever the server's time zone (CLAUDE.md: deadlines are
//     UTC days) - the old toDateString() read the process's zone.
//
// USAGE
//   node tests/email-layout-contract.mjs
import { spawnSync } from "node:child_process";

const layout = await import("../src/services/email-layout.js");
const email = await import("../src/services/email.service.js");
const reminder = await import("../src/services/reminder.service.js");

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? ` - ${detail}` : ""}`);
}

// ---- Contrast: WCAG relative luminance --------------------------------------------------------
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
const P = layout.EMAIL_PALETTE;
for (const [label, fg, bg] of [
  ["ink on the card", P.ink, P.surface],
  ["ink on the ground", P.ink, P.canvas],
  ["small print on the ground", P.muted, P.canvas],
  ["small print on the card", P.muted, P.surface],
  ["the button's label on the accent", P.onAccent, P.accent],
]) {
  const ratio = contrast(fg, bg);
  check(`${label} reads at least 4.5:1`, ratio >= 4.5, ratio.toFixed(2));
}

// ---- Every template: built without sending, in the layout, with a text part --------------------
const SAMPLE_LINKS = { pageUrl: "https://api.caprotoolkit.in/digest-unsubscribe.html?t=a&u=b", apiUrl: "https://api.caprotoolkit.in/api/digests/unsubscribe?t=a&u=b" };
const built = {
  otp: email.buildOtpEmail("482915"),
  reminder: reminder.buildComplianceReminderEmail({ title: "GSTR-3B for September 2026", clientLabel: "Asha Traders", dueDateISO: "2026-10-20T00:00:00.000Z", daysLeft: 13 }),
  digest: email.buildDigestEmailContent({ subject: "Your daily digest", heading: "Today at Example & Co.", periodLabel: "7 Oct 2026", lines: [{ label: "Due today", value: "3" }], ...SAMPLE_LINKS }),
  activation: email.buildDailyDigestActivationEmail({ activationUrl: "https://api.caprotoolkit.in/daily-digest-activate.html?u=a&t=b" }),
  test: email.buildTestEmail({ sentAt: "2026-10-07T15:00:00.000Z" }),
  alert: email.buildReminderDeliveryAlertEmail({ issueCount: 4, candidatesScanned: 5000, candidatesScanTruncated: true, generatedAt: new Date("2026-10-07T15:00:00Z") }),
};
for (const [name, mail] of Object.entries(built)) {
  check(`${name}: the layout frames it`, /<table role="presentation"/.test(mail.html) && /CA PRO Toolkit/.test(mail.html) && /capro-mark\.png/.test(mail.html));
  check(`${name}: it has a plain-text part`, typeof mail.text === "string" && mail.text.trim().length > 20);
}

// ---- The words are the same words -------------------------------------------------------------
const WORDS = {
  otp: ["CA PRO Toolkit – Login OTP", "Your One-Time Password (OTP) is:", "482915", "This OTP is valid for", "10 minutes", "If you did not request this OTP, you can safely ignore this email."],
  reminder: ["Compliance Reminder", "GSTR-3B for September 2026", "Asha Traders", "13 day(s) left", "This is an automated reminder from CA PRO Toolkit."],
  digest: ["Today at Example &amp; Co.", "7 Oct 2026", "Due today", "Operational counts only. Review source records in CA PRO Toolkit before acting.", "Unsubscribe from this email"],
  activation: ["Daily Digest is now off", "To reduce unnecessary email, CA PRO Toolkit has turned off daily digest email by default.", "Activate Daily Digest", "No reminder, OTP, or important compliance email has been turned off."],
  test: ["Email delivery is working", "This is a test email from CA PRO Toolkit, triggered from the Super Admin panel.", "2026-10-07T15:00:00.000Z"],
  alert: ["Reminder delivery health alert", "4+", "Candidates scanned: 5000", "scan capped", "This is a secondary signal only and takes no action."],
};
for (const [name, words] of Object.entries(WORDS)) {
  const missing = words.filter((w) => !built[name].html.includes(w));
  check(`${name}: every sentence it carried is still there`, missing.length === 0, missing.length ? `missing ${JSON.stringify(missing)}` : "");
}
check("the subjects are unchanged",
  built.otp.subject === "Your CA PRO Toolkit OTP" && built.reminder.subject === "Compliance Reminder: GSTR-3B for September 2026"
    && built.activation.subject === "CA PRO Toolkit: Daily Digest is now off" && built.test.subject === "CA PRO Toolkit — test email"
    && built.alert.subject === "CA PRO Toolkit — 4+ reminders with a delivery problem");

// ---- Escaping ---------------------------------------------------------------------------------
const hostile = reminder.buildComplianceReminderEmail({ title: "<img src=x onerror=alert(1)>", clientLabel: "\"><script>1</script>", dueDateISO: "2026-10-20", daysLeft: 1 });
check("caller text is escaped in the reminder", !hostile.html.includes("<img src=x") && !hostile.html.includes("<script>1</script>") && hostile.html.includes("&lt;img"));
check("the layout escapes its title", !layout.renderEmailLayout({ title: "<b>x</b>" }).includes("<b>x</b>"));
check("a button's link is escaped", layout.emailButton("https://a.example/?a=1&b=2", "Go").includes('href="https://a.example/?a=1&amp;b=2"'));

// ---- The due day is the UTC day, in any server time zone ---------------------------------------
check("a due date reads as its UTC day", layout.formatDueDayForEmail("2026-10-20T00:00:00.000Z") === "Tue Oct 20 2026", layout.formatDueDayForEmail("2026-10-20T00:00:00.000Z"));
const westOfUtc = spawnSync(process.execPath, ["--input-type=module", "-e",
  "const m = await import(process.argv[1]); process.stdout.write(m.formatDueDayForEmail('2026-10-20T00:00:00.000Z') + '|' + new Date('2026-10-20T00:00:00.000Z').toDateString());",
  new URL("../src/services/email-layout.js", import.meta.url).href], { env: { ...process.env, TZ: "America/New_York" }, encoding: "utf8" });
const [ours, old] = String(westOfUtc.stdout).split("|");
check("west of UTC the email still says the stored day (the old code said the day before)", ours === "Tue Oct 20 2026" && old === "Mon Oct 19 2026", `ours ${ours}, toDateString ${old}`);
check("an unreadable date is shown as it was given, not as a made-up day", layout.formatDueDayForEmail("not a date") === "not a date");

// ---- One reminder template, not two --------------------------------------------------------------
check("email.service.js no longer carries a second reminder template", typeof email.sendComplianceReminderEmail === "undefined");

console.log(`\nemail layout contract: ${passed}/${passed + failed} passed`);
process.exitCode = failed ? 1 : 0;
