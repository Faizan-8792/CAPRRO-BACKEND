// tools/snap-emails.mjs
//
// Renders every email CA PRO sends - from the same pure builders the send functions use - and
// photographs each one in headless Chrome, at a desktop mail-pane width and at a phone width
// (DS25). Nothing is sent: no mailer, no provider key, no database. The invented recipients and
// values are the only data in the pictures.
//
// USAGE
//   node tools/snap-emails.mjs --out <dir>
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { withBrowser } from "./browser-drive.mjs";

const args = process.argv.slice(2);
const at = args.indexOf("--out");
const outDir = resolve(at >= 0 && args[at + 1] ? args[at + 1] : "email-snaps");

for (const key of ["RESEND_API_KEY"]) process.env[key] = "";
const email = await import("../src/services/email.service.js");
const reminder = await import("../src/services/reminder.service.js");

const LINKS = {
  pageUrl: "https://api.caprotoolkit.in/unsubscribe.html?u=example&k=DAILY_PERSONAL&t=example",
  apiUrl: "https://api.caprotoolkit.in/api/digests/unsubscribe?u=example&k=DAILY_PERSONAL&t=example",
};
const emails = {
  otp: email.buildOtpEmail("482915"),
  reminder: reminder.buildComplianceReminderEmail({ title: "GSTR-3B for September 2026", clientLabel: "Asha Traders", dueDateISO: "2026-10-20T00:00:00.000Z", daysLeft: 13 }),
  "reminder-overdue": reminder.buildComplianceReminderEmail({ title: "TDS return 26Q, quarter 2", clientLabel: "Bharat Exports", dueDateISO: "2026-10-04T00:00:00.000Z", daysLeft: -3 }),
  digest: email.buildDigestEmailContent({
    subject: "Your daily digest",
    heading: "Today at Example & Co. Chartered Accountants",
    periodLabel: "Wednesday 7 October 2026",
    lines: [
      { label: "Due today", value: "3" },
      { label: "Overdue", value: "1" },
      { label: "Waiting for documents", value: "2" },
    ],
    ...LINKS,
  }),
  activation: email.buildDailyDigestActivationEmail({ activationUrl: "https://api.caprotoolkit.in/daily-digest-activate.html?u=example&t=example" }),
  test: email.buildTestEmail({ sentAt: "2026-10-07T15:00:00.000Z" }),
  alert: email.buildReminderDeliveryAlertEmail({ issueCount: 4, candidatesScanned: 5000, candidatesScanTruncated: true, generatedAt: new Date("2026-10-07T15:00:00Z") }),
};

mkdirSync(outDir, { recursive: true });
const written = [];
await withBrowser(async (page) => {
  for (const [name, mail] of Object.entries(emails)) {
    const file = join(outDir, `${name}.html`);
    writeFileSync(file, mail.html);
    writeFileSync(join(outDir, `${name}.txt`), `Subject: ${mail.subject}\n\n${mail.text}\n`);
    for (const [label, width] of [["desktop", 720], ["phone", 390]]) {
      await page.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: label === "phone" });
      await page.goto(pathToFileURL(file).href, { waitMs: 1200 });
      const height = Math.min(4000, Number(await page.evaluate("document.documentElement.scrollHeight")) || 900);
      await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: label === "phone" });
      const shot = await page.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width, height, scale: 1 } });
      const png = join(outDir, `${name}-${label}.png`);
      writeFileSync(png, Buffer.from(shot.data, "base64"));
      written.push(`${png}  ${width}x${height}`);
    }
  }
});
console.log(written.join("\n"));
