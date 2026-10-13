// scripts/backfill-email-deliveries.mjs
//
// One-time backfill of the EmailDelivery table from Resend's List Emails API
// (IMPROVEMENT-PLAN-V2-2026-09-28 Part 1). Resend keeps email logs for 30 DAYS
// — anything older is permanently unavailable and this script cannot recover
// it; that limit is documented in the plan rather than hidden.
//
//   node scripts/backfill-email-deliveries.mjs           # last 30 days
//   node scripts/backfill-email-deliveries.mjs --dry-run # count without writing
//   node scripts/backfill-email-deliveries.mjs --production # the real backfill
//
// A run without --production must target a loopback, scratch-marked database
// (a rehearsal). --production is the deliberate opt-in that runs against
// MONGODB_URI as configured in .env.
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

// The list endpoint does not say which builder produced the email, so the type
// is guessed from the subject — the honest coarse signal — and the row keeps
// subjectTemplateName "other" rather than inventing a template key. The guesses
// are ordered most-specific first: production subjects are "Daily work
// digest · <date>", "Weekly firm summary · <date>", "Compliance Reminder: X",
// "Your CA PRO Toolkit OTP", "CA PRO Toolkit — test email", and the digest
// rollout notice ("Daily Digest is now off"), which the old ordering misfiled
// under daily_digest because it merely contains the word digest.
function guessTypeFromSubject(subject) {
  const s = String(subject || "");
  if (/test email/i.test(s)) return "test_email";
  if (/otp/i.test(s)) return "otp";
  if (/reminder/i.test(s)) return "reminder";
  if (/is now off|rollout|notice/i.test(s)) return "rollout_notice";
  if (/weekly|firm summary/i.test(s)) return "weekly_digest";
  if (/digest/i.test(s)) return "daily_digest";
  return "other";
}

async function main() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY is required (it lives in capro-backend/.env)");
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is required");
  // A local run writes to a database, so it must be loopback AND scratch-marked.
  // Production is reached only through the explicit --production flag: the flag is
  // the deliberate act this message always asked for but the old check made
  // impossible, because it threw on EVERY non-loopback URI, production included.
  const PRODUCTION = process.argv.includes("--production");
  // A production Atlas URI lists several comma-separated hosts, which the WHATWG
  // URL parser rejects outright ("Invalid URL"), so the loopback check reads the
  // scheme's host portion as text instead of parsing it as a web URL.
  const isLoopback = /^mongodb(\+srv)?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(uri);
  if (PRODUCTION && isLoopback) {
    throw new Error("--production given but MONGODB_URI is loopback; drop --production for a local scratch run.");
  }
  if (!PRODUCTION && (!isLoopback || !uri.includes("scratch"))) {
    throw new Error("Refusing to run: a local backfill must target a loopback, scratch-marked database. Pass --production to run against the production URI deliberately.");
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
    let refined = 0;
    for (const email of emails) {
      if (!email?.id) continue;
      const typeGuess = guessTypeFromSubject(email.subject);
      const existing = await EmailDelivery.findOne({ providerMessageId: email.id })
        .select("_id type backfilled")
        .lean();
      if (existing) {
        skipped += 1;
        // Refine our OWN earlier guesses (backfilled rows only — provider-built
        // records are never touched): the pre-2026-09-29 mapping filed the
        // weekly summaries and the rollout notice under daily_digest/other.
        if (existing.backfilled === true && existing.type !== typeGuess) {
          await EmailDelivery.updateOne({ _id: existing._id }, { $set: { type: typeGuess } });
          refined += 1;
        }
        continue;
      }
      const to = Array.isArray(email.to) ? email.to[0] : email.to;
      const sentAt = email.created_at ? new Date(email.created_at) : new Date();
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
    console.log(`Backfill complete: ${inserted} inserted, ${skipped} already present, ${refined} types refined.`);
  } finally {
    await mongoose.disconnect();
  }
}

// process.exitCode, not process.exit(): exiting after a fetch aborts Node 24 on Windows (V32).
main().catch((err) => {
  console.error("Backfill failed:", err?.message || err);
  process.exitCode = 1;
});
