// scripts/backfill-email-deliveries.mjs
//
// One-time backfill of the EmailDelivery table from Resend's List Emails API
// (IMPROVEMENT-PLAN-V2-2026-09-28 Part 1). Resend keeps email logs for 30 DAYS
// — anything older is permanently unavailable and this script cannot recover
// it; that limit is documented in the plan rather than hidden.
//
//   node scripts/backfill-email-deliveries.mjs           # last 30 days
//   node scripts/backfill-email-deliveries.mjs --dry-run # count without writing
//
// Every inserted row is marked backfilled: true — its status is "sent" (the
// list endpoint has no delivery history) unless a webhook event corrects it
// later. Rows whose providerMessageId already exists are skipped, so the
// script is safe to re-run.

import "dotenv/config";
import mongoose from "mongoose";

const RESEND_API = "https://api.resend.com/emails";
const DRY_RUN = process.argv.includes("--dry-run");

async function fetchAllEmails(apiKey, { windowDays = 30, pageSize = 100 } = {}) {
  const out = [];
  let after = undefined;
  for (let page = 0; page < 100; page += 1) {
    const url = new URL(RESEND_API);
    url.searchParams.set("limit", String(pageSize));
    if (after) url.searchParams.set("after", after);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) {
      throw new Error(`Resend list emails failed: HTTP ${res.status} ${await res.text()}`);
    }
    const body = await res.json();
    const rows = Array.isArray(body?.data) ? body.data : [];
    out.push(...rows);
    if (rows.length < pageSize) break;
    after = rows[rows.length - 1]?.id;
  }
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  return out.filter((row) => {
    const t = row?.created_at ? Date.parse(row.created_at) : Date.now();
    return Number.isFinite(t) && t >= cutoff;
  });
}

async function main() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY is required (it lives in capro-backend/.env)");
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is required");
  if (!/localhost|127\.0\.0\.1/.test(new URL(uri).hostname) || !uri.includes("scratch")) {
    throw new Error("Refusing to run: the target database must be loopback AND scratch-marked for a local backfill rehearsal. For production, run against the production URI deliberately.");
  }

  const emails = await fetchAllEmails(apiKey);
  console.log(`Fetched ${emails.length} emails from Resend (last 30 days).`);

  if (DRY_RUN) {
    console.log("Dry run: nothing written.");
    return;
  }

  await mongoose.connect(uri);
  try {
    const { default: EmailDelivery } = await import("../src/models/EmailDelivery.js");
    let inserted = 0;
    let skipped = 0;
    for (const email of emails) {
      if (!email?.id) continue;
      const exists = await EmailDelivery.exists({ providerMessageId: email.id });
      if (exists) {
        skipped += 1;
        continue;
      }
      const to = Array.isArray(email.to) ? email.to[0] : email.to;
      const sentAt = email.created_at ? new Date(email.created_at) : new Date();
      // The list endpoint does not say which builder produced the email; the
      // coarse "other" template key and the subject-derived type guess keep
      // the row honest without fabricating detail.
      const typeGuess = /otp/i.test(String(email.subject || ""))
        ? "otp"
        : /reminder/i.test(String(email.subject || ""))
          ? "reminder"
          : /digest/i.test(String(email.subject || ""))
            ? "daily_digest"
            : "other";
      await EmailDelivery.create({
        recipientEmailHash: EmailDelivery.hashRecipient(to || ""),
        recipientEmailLast4: String(to || "").slice(-4),
        type: typeGuess,
        subjectTemplateName: "other",
        providerMessageId: email.id,
        status: "sent",
        errorClass: "none",
        sentAt,
        lastEventAt: sentAt,
        backfilled: true,
      });
      inserted += 1;
    }
    console.log(`Backfill complete: ${inserted} inserted, ${skipped} already present.`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error("Backfill failed:", err?.message || err);
  process.exit(1);
});
