// End-to-end proof for the two bulk actions the owner asked for:
//   POST /api/reminders/deactivate-all   - turn off every manual reminder
//   POST /api/digests/inbox/read-all     - mark the whole digest inbox read
//
// Both replace work a person would otherwise repeat once per row, and both are only safe if they
// reach EXACTLY the rows the per-row action would have reached and no further. That is what this
// suite checks, against the real Express app and a real MongoDB, by seeding rows the caller must
// not be allowed to touch and asserting they survive.
//
// Follows the repo's Mongo-suite convention: run-gates.ps1 injects a scratch MONGODB_URI, and with
// none the suite SKIPS rather than fails. It refuses to run against anything but a loopback
// database carrying a scratch marker, because it drops the database it uses.

import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// Captured before .env is read; .env points at the production cluster and must never fill this in.
const injected = process.env.MONGODB_URI || "";

for (const line of readFileSync(join(repoRoot, ".env"), "utf8").split(/\r?\n/)) {
  const eq = line.indexOf("=");
  if (eq < 1 || line.trim().startsWith("#")) continue;
  const key = line.slice(0, eq).trim();
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
  if (key === "MONGODB_URI") continue;
  if (process.env[key] === undefined) {
    process.env[key] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
}

if (!injected) {
  console.log(
    "Bulk actions end-to-end: SKIPPED - no MONGODB_URI.\n"
      + "This suite boots the real server against a scratch database and exercises the reminders\n"
      + "deactivate-all and digests read-all routes. Start a local Mongo and re-run the gates.",
  );
  process.exit(0);
}

if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)[:/]/.test(injected) || !/scratch/i.test(injected)) {
  console.error(
    "REFUSED: MONGODB_URI must be loopback and carry a scratch marker. This suite drops its\n"
      + "database and will not run against anything else.",
  );
  process.exit(1);
}

const SCRATCH_DB = new URL(injected).pathname.replace(/^\//, "");
process.env.NODE_ENV = "development";
process.env.DEEPSEEK_API_KEY = "";
process.env.OCR_SPACE_API_KEY = "";
process.env.RESEND_API_KEY = "";

const checks = [];
const check = (name, pass, detail = "") => {
  checks.push({ name, pass, detail });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
};

const toFileUrl = (...segments) => pathToFileURL(join(repoRoot, ...segments)).href;
let server = null;

try {
  const { connectDB } = await import(toFileUrl("src", "config", "db.js"));
  const { default: app } = await import(toFileUrl("src", "app.js"));
  const { default: User } = await import(toFileUrl("src", "models", "User.js"));
  const { default: Reminder } = await import(toFileUrl("src", "models", "Reminder.js"));
  const { default: AppConfig, DEFAULT_FEATURE_FLAGS } = await import(
    toFileUrl("src", "models", "AppConfig.js"),
  );
  const { ensurePersonalFirm } = await import(
    toFileUrl("src", "services", "firm-provisioning.service.js"),
  );
  const { ensureRequiredIndexes } = await import(
    toFileUrl("src", "services", "index-provisioning.service.js"),
  );

  await connectDB();
  if (mongoose.connection.name !== SCRATCH_DB) {
    throw new Error(`connected to ${mongoose.connection.name}, expected ${SCRATCH_DB}`);
  }
  await mongoose.connection.dropDatabase();
  await ensureRequiredIndexes();
  await AppConfig.create({
    _id: "singleton",
    featureFlags: Object.fromEntries(Object.keys(DEFAULT_FEATURE_FLAGS).map((k) => [k, true])),
  });

  // Two separate people, so "all" can be proved to mean "mine" rather than "everyone's".
  const makeUser = async (email) => {
    const created = await User.create({
      email,
      name: email,
      role: "USER",
      accountType: "INDIVIDUAL",
      isActive: true,
    });
    return ensurePersonalFirm(created);
  };

  const me = await makeUser("bulk-owner@example.invalid");
  const someoneElse = await makeUser("bulk-other@example.invalid");

  const tokenFor = (user) =>
    jwt.sign(
      {
        id: String(user._id),
        email: user.email,
        role: user.role,
        accountType: user.accountType,
        firmId: user.firmId,
        isActive: user.isActive,
        tv: user.tokenVersion || 0,
      },
      process.env.JWT_SECRET,
      { expiresIn: "1h" },
    );

  server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, path, token, body) => {
    const res = await fetch(`${base}/${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json };
  };

  const myToken = tokenFor(me);

  // ─── reminders: deactivate-all ────────────────────────────────────────────
  //
  // Four rows, and only ONE of them may be switched off:
  //   mine + MANUAL + active     -> must be switched off
  //   mine + MANUAL + already off -> must not be counted twice
  //   mine + CASE   + active     -> projected from a case, not mine to switch off
  //   someone else's + MANUAL    -> another person's row, must never be reached
  const seedReminder = (user, overrides) =>
    Reminder.create({
      userId: user._id,
      firmId: user.firmId,
      typeId: "GSTR3B",
      clientLabel: "Bulk test",
      dueDateISO: "2026-10-20",
      isActive: true,
      source: "MANUAL",
      ...overrides,
    });

  const mineActive = await seedReminder(me, {});
  const mineAlreadyOff = await seedReminder(me, { isActive: false });
  const mineFromCase = await seedReminder(me, { source: "CASE" });
  const theirs = await seedReminder(someoneElse, {});

  const deactivate = await call("POST", "api/reminders/deactivate-all", myToken);
  check(
    "deactivate-all answers 200 and reports how many it changed",
    deactivate.status === 200 && deactivate.json?.deactivated === 1,
    `status ${deactivate.status}, deactivated ${JSON.stringify(deactivate.json?.deactivated)} (want 1)`,
  );

  const after = async (doc) => (await Reminder.findById(doc._id).lean())?.isActive;

  check(
    "my own active manual reminder is switched off",
    (await after(mineActive)) === false,
    `isActive ${await after(mineActive)}`,
  );
  check(
    "a reminder projected from a case is left alone, not refused",
    (await after(mineFromCase)) === true,
    `isActive ${await after(mineFromCase)} (want true - skipped, and the call still succeeded)`,
  );
  check(
    "another person's reminder is never reached",
    (await after(theirs)) === true,
    `isActive ${await after(theirs)}`,
  );
  check(
    "an already-inactive reminder is not counted as changed",
    (await after(mineAlreadyOff)) === false && deactivate.json?.deactivated === 1,
    "count stays 1",
  );

  const second = await call("POST", "api/reminders/deactivate-all", myToken);
  check(
    "running it again is a success with zero, not an error",
    second.status === 200 && second.json?.deactivated === 0,
    `status ${second.status}, deactivated ${JSON.stringify(second.json?.deactivated)}`,
  );

  // ─── digests: read-all ────────────────────────────────────────────────────
  //
  // Seeded through the model directly: a DigestDelivery is normally produced by the scheduler, and
  // this suite is about the bulk route rather than about how a digest comes to exist.
  const { default: DigestDelivery } = await import(
    toFileUrl("src", "models", "DigestDelivery.js"),
  );

  // periodKey varies per row: {firmId, kind, periodKey, recipientUserId} is a unique index, so two
  // digests for the same person and period cannot both exist.
  let periodCounter = 0;
  const seedDigest = (user, overrides = {}) =>
    DigestDelivery.create({
      firmId: user.firmId,
      recipientUserId: user._id,
      kind: "DAILY_PERSONAL",
      periodKey: `2026-10-${String(++periodCounter).padStart(2, "0")}`,
      timezone: "Asia/Kolkata",
      scheduledFor: new Date(),
      subject: "Bulk test digest",
      summary: { counts: { open: 0, overdue: 0, dueSoon: 0 } },
      inApp: { state: "AVAILABLE" },
      ...overrides,
    });

  const readAt = new Date("2026-01-01T00:00:00.000Z");
  const myUnread = await seedDigest(me);
  const myAlreadyRead = await seedDigest(me, { inApp: { state: "READ", readAt } });
  const theirUnread = await seedDigest(someoneElse);

  const readAll = await call("POST", "api/digests/inbox/read-all", myToken);
  check(
    "read-all answers 200 and reports how many it changed",
    readAll.status === 200 && readAll.json?.digests?.updated === 1,
    `status ${readAll.status}, updated ${JSON.stringify(readAll.json?.digests?.updated)} (want 1)`,
  );

  const digestAfter = async (doc) => (await DigestDelivery.findById(doc._id).lean())?.inApp;

  check(
    "my unread digest is marked read",
    (await digestAfter(myUnread))?.state === "READ",
    `state ${(await digestAfter(myUnread))?.state}`,
  );
  check(
    "a digest already read keeps its ORIGINAL read time",
    new Date((await digestAfter(myAlreadyRead))?.readAt).getTime() === readAt.getTime(),
    `readAt ${(await digestAfter(myAlreadyRead))?.readAt} (want ${readAt.toISOString()})`,
  );
  check(
    "another person's digest is never reached",
    (await digestAfter(theirUnread))?.state === "AVAILABLE",
    `state ${(await digestAfter(theirUnread))?.state}`,
  );

  const readAllAgain = await call("POST", "api/digests/inbox/read-all", myToken);
  check(
    "an inbox with nothing unread is a success with zero, not a 404",
    readAllAgain.status === 200 && readAllAgain.json?.digests?.updated === 0,
    `status ${readAllAgain.status}, updated ${JSON.stringify(readAllAgain.json?.digests?.updated)}`,
  );

  // ─── both routes refuse an unauthenticated caller ─────────────────────────
  for (const path of ["api/reminders/deactivate-all", "api/digests/inbox/read-all"]) {
    const res = await fetch(`${base}/${path}`, { method: "POST" });
    check(
      `${path} refuses a caller with no session`,
      res.status === 401,
      `status ${res.status}`,
    );
  }
} catch (error) {
  check("the harness ran to completion", false, error?.message || String(error));
  console.error(error?.stack || error);
} finally {
  try { if (server) server.close(); } catch { /* ignore */ }
  try {
    if (mongoose.connection?.readyState === 1 && mongoose.connection.name === SCRATCH_DB) {
      await mongoose.connection.dropDatabase();
    }
  } catch { /* ignore */ }
  try { await mongoose.disconnect(); } catch { /* ignore */ }
}

const passed = checks.filter((entry) => entry.pass).length;
console.log(`\nBulk actions end-to-end: ${passed}/${checks.length}`);
if (passed !== checks.length) {
  console.error(`\n${checks.length - passed} check(s) failed.`);
  process.exit(1);
}
process.exit(0);
