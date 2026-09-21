// One-time, resumable production rollout for the 2026-09-21 digest policy.
// Usage (from capro-backend):
//   node tools/digest-resource-rollout.mjs --prepare
//   node tools/digest-resource-rollout.mjs --send A
//   node tools/digest-resource-rollout.mjs --send B
// The sender never exceeds 50 notices in one invocation; this is below the
// owner's 100-message/day budget and deliberately does not touch reminders.
import "dotenv/config";
import { createHash } from "node:crypto";
import mongoose from "mongoose";
import User from "../src/models/User.js";
import { buildDailyDigestActivationLink } from "../src/services/digest.service.js";
import { sendDailyDigestActivationEmail } from "../src/services/email.service.js";

const ROLLOUT_VERSION = "2026-09-21-daily-off";
const CAMPAIGN = "2026-09-21-daily-digest-off";
const WEEKLY_DAYS = [0, 1, 4];
const MAX_PER_BATCH = 50;
const args = new Set(process.argv.slice(2));
const requestedBatch = args.has("--send")
  ? process.argv[process.argv.indexOf("--send") + 1]?.toUpperCase()
  : null;

if (!args.has("--prepare") && !requestedBatch) {
  throw new Error("Use --prepare, --send A, or --send B.");
}
if (requestedBatch && !["A", "B"].includes(requestedBatch)) {
  throw new Error("--send must be A or B.");
}
if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required");

function assignedWeeklyDay(id) {
  return WEEKLY_DAYS[createHash("sha256").update(String(id)).digest()[0] % WEEKLY_DAYS.length];
}

function validEmail(value) {
  return typeof value === "string" && value.trim().length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

async function prepare() {
  const allUsers = await User.find({})
    .select("_id email isActive digestPreferences")
    .sort({ _id: 1 })
    .lean();
  const migrationWrites = allUsers.map((user) => ({
    updateOne: {
      filter: { _id: user._id, "digestPreferences.dailyRolloutVersion": { $ne: ROLLOUT_VERSION } },
      update: {
        $set: {
          "digestPreferences.dailyFrequency": "OFF",
          "digestPreferences.dailyEnabled": false,
          "digestPreferences.dailyRolloutVersion": ROLLOUT_VERSION,
          "digestPreferences.weeklyDeliveryDay": assignedWeeklyDay(user._id),
        },
      },
    },
  }));
  if (migrationWrites.length) await User.bulkWrite(migrationWrites, { ordered: false });

  const recipients = allUsers.filter((user) => user.isActive && validEmail(user.email));
  const splitAt = Math.ceil(recipients.length / 2);
  const noticeWrites = recipients.map((user, index) => ({
    updateOne: {
      filter: { _id: user._id, "digestPreferences.rolloutNotice.campaign": { $ne: CAMPAIGN } },
      update: {
        $set: {
          "digestPreferences.rolloutNotice.campaign": CAMPAIGN,
          "digestPreferences.rolloutNotice.batch": index < splitAt ? "A" : "B",
          "digestPreferences.rolloutNotice.state": "PENDING",
          "digestPreferences.rolloutNotice.attempts": 0,
          "digestPreferences.rolloutNotice.providerMessageId": "",
          "digestPreferences.rolloutNotice.lastError": "",
          "digestPreferences.rolloutNotice.sentAt": null,
        },
      },
    },
  }));
  if (noticeWrites.length) await User.bulkWrite(noticeWrites, { ordered: false });
  console.log(JSON.stringify({ rollout: ROLLOUT_VERSION, usersMigrated: allUsers.length, eligibleRecipients: recipients.length, batchA: splitAt, batchB: recipients.length - splitAt }));
}

async function sendBatch(batch) {
  let sent = 0;
  let failed = 0;
  while (sent + failed < MAX_PER_BATCH) {
    const user = await User.findOneAndUpdate(
      {
        isActive: true,
        "digestPreferences.rolloutNotice.campaign": CAMPAIGN,
        "digestPreferences.rolloutNotice.batch": batch,
        "digestPreferences.rolloutNotice.state": "PENDING",
      },
      {
        $set: { "digestPreferences.rolloutNotice.state": "SENDING", "digestPreferences.rolloutNotice.lastError": "" },
        $inc: { "digestPreferences.rolloutNotice.attempts": 1 },
      },
      { new: true },
    ).select("email digestPreferences.rolloutNotice").lean();
    if (!user) break;
    const idempotencyKey = `${CAMPAIGN}:${String(user._id)}`;
    try {
      const result = await sendDailyDigestActivationEmail({
        toEmail: user.email,
        activationUrl: buildDailyDigestActivationLink(user._id),
        idempotencyKey,
      });
      await User.updateOne(
        { _id: user._id, "digestPreferences.rolloutNotice.state": "SENDING" },
        { $set: {
          "digestPreferences.rolloutNotice.state": "SENT",
          "digestPreferences.rolloutNotice.providerMessageId": String(result?.data?.id || result?.id || ""),
          "digestPreferences.rolloutNotice.sentAt": new Date(),
        } },
      );
      sent += 1;
    } catch (error) {
      await User.updateOne(
        { _id: user._id, "digestPreferences.rolloutNotice.state": "SENDING" },
        { $set: { "digestPreferences.rolloutNotice.state": "FAILED", "digestPreferences.rolloutNotice.lastError": String(error?.message || error).slice(0, 600) } },
      );
      failed += 1;
    }
  }
  console.log(JSON.stringify({ campaign: CAMPAIGN, batch, sent, failed, cap: MAX_PER_BATCH }));
  if (failed) process.exitCode = 1;
}

await mongoose.connect(process.env.MONGODB_URI);
try {
  if (args.has("--prepare")) await prepare();
  if (requestedBatch) await sendBatch(requestedBatch);
} finally {
  await mongoose.disconnect();
}
