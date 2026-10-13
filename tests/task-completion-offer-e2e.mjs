// canComplete must say what the completion route will actually do.
//
// Both clients draw "Mark complete" from canComplete: the extension's task list reads it per task
// from GET /api/tasks/my-open, and the exact-task lookup GET /api/tasks/:id has always carried it.
// It used to be "assigned to you and still open" and nothing more, while the route it advertises,
// PATCH /api/tasks/:id/complete-from-user, sits behind requireFirmWriteAccess. So a read-only
// member - a VIEWER, or a MEMBER of a firm whose memberAccess is READ_ONLY - was offered a control
// that could only ever be refused.
//
// The check here is differential rather than a list of expected booleans: for every caller, the
// canComplete the two reads report must equal whether the PATCH then succeeds. A hint that drifts
// from the gate in either direction fails, whichever side moved.
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

// process.exitCode, never process.exit(): exiting after a fetch aborts Node 24 on Windows (V32).
if (!injected) {
  console.log(
    "Task completion offer end-to-end: SKIPPED - no MONGODB_URI.\n"
      + "This suite boots the real server against a scratch database and compares canComplete with\n"
      + "the completion route for every firm role. Start a local Mongo and re-run the gates.",
  );
} else if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)[:/]/.test(injected) || !/scratch/i.test(injected)) {
  console.error(
    "REFUSED: MONGODB_URI must be loopback and carry a scratch marker. This suite drops its\n"
      + "database and will not run against anything else.",
  );
  process.exitCode = 1;
} else {
  process.exitCode = await runSuite();
}

async function runSuite() {
  const SCRATCH_DB = new URL(injected).pathname.replace(/^\//, "");
  process.env.NODE_ENV = "development";
  process.env.DEEPSEEK_API_KEY = "";
  process.env.OCR_SPACE_API_KEY = "";
  process.env.RESEND_API_KEY = "";

  const checks = [];
  const check = (name, pass, detail = "") => {
    checks.push({ name, pass, detail });
    console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? ` - ${detail}` : ""}`);
  };

  const toFileUrl = (...segments) => pathToFileURL(join(repoRoot, ...segments)).href;
  let server = null;

  try {
    const { connectDB } = await import(toFileUrl("src", "config", "db.js"));
    const { default: app } = await import(toFileUrl("src", "app.js"));
    const { default: User } = await import(toFileUrl("src", "models", "User.js"));
    const { default: Firm } = await import(toFileUrl("src", "models", "Firm.js"));
    const { default: FirmMembership } = await import(toFileUrl("src", "models", "FirmMembership.js"));
    const { default: Task } = await import(toFileUrl("src", "models", "Task.js"));
    const { default: AppConfig, DEFAULT_FEATURE_FLAGS } = await import(
      toFileUrl("src", "models", "AppConfig.js"),
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

    // Two shared firms: one that lets members edit, one switched to read-only for members.
    const owner = await User.create({
      email: "offer-owner@example.invalid",
      name: "Offer owner",
      role: "USER",
      accountType: "INDIVIDUAL",
      isActive: true,
    });
    const makeFirm = (handle, memberAccess) =>
      Firm.create({
        displayName: `Offer ${handle}`,
        handle,
        ownerUserId: owner._id,
        kind: "SHARED",
        joinCode: `${handle.toUpperCase()}-CODE`,
        memberAccess,
      });
    const editFirm = await makeFirm("offer-edit", "EDIT");
    const readOnlyFirm = await makeFirm("offer-readonly", "READ_ONLY");

    const member = async (label, firm, role) => {
      const user = label === "owner"
        ? owner
        : await User.create({
            email: `offer-${label}@example.invalid`,
            name: `Offer ${label}`,
            role: "USER",
            accountType: "INDIVIDUAL",
            isActive: true,
          });
      await FirmMembership.create({ firmId: firm._id, userId: user._id, role, status: "ACTIVE" });
      await User.updateOne({ _id: user._id }, { $set: { firmId: firm._id } });
      const task = await Task.create({
        firmId: firm._id,
        createdBy: owner._id,
        clientName: "Offer client",
        title: `Offer task for ${label}`,
        dueDateISO: "2026-10-20",
        status: "NOT_STARTED",
        assignedTo: user._id,
      });
      return { label, firm, role, user: await User.findById(user._id).lean(), task };
    };

    // Each caller, with what the server's own ladder says about writing. The owner stands in the
    // edit firm; an admin is not seeded in the read-only firm because the owner-only switch does
    // not demote an admin, which firm-role-tier-contract already pins.
    const callers = [
      await member("owner", editFirm, "OWNER"),
      await member("admin", editFirm, "ADMIN"),
      await member("editor", editFirm, "MEMBER"),
      await member("viewer", editFirm, "VIEWER"),
      await member("readonly-member", readOnlyFirm, "MEMBER"),
    ];

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

    const expectWrite = { owner: true, admin: true, editor: true, viewer: false, "readonly-member": false };

    for (const caller of callers) {
      const token = tokenFor(caller.user);
      const id = String(caller.task._id);

      const list = await call("GET", "api/tasks/my-open?page=1&limit=25", token);
      const row = (list.json?.tasks || []).find((task) => String(task._id) === id);
      check(
        `${caller.label}: my-open lists their own open task`,
        list.status === 200 && Boolean(row),
        `status ${list.status}, rows ${(list.json?.tasks || []).length}`,
      );
      check(
        `${caller.label}: my-open says canComplete ${expectWrite[caller.label]}, on the response and on the row`,
        list.json?.canComplete === expectWrite[caller.label] && row?.canComplete === expectWrite[caller.label],
        `response ${JSON.stringify(list.json?.canComplete)}, row ${JSON.stringify(row?.canComplete)}`,
      );

      const source = await call("GET", `api/tasks/${id}`, token);
      check(
        `${caller.label}: the exact-task read says canComplete ${expectWrite[caller.label]}`,
        source.status === 200 && source.json?.canComplete === expectWrite[caller.label],
        `status ${source.status}, canComplete ${JSON.stringify(source.json?.canComplete)}`,
      );

      // The differential: what the reads promised against what the route does.
      const complete = await call("PATCH", `api/tasks/${id}/complete-from-user`, token, {});
      const completed = complete.status === 200;
      check(
        `${caller.label}: the completion route ${completed ? "accepts" : "refuses"}, as canComplete said`,
        completed === source.json?.canComplete && completed === row?.canComplete,
        `PATCH ${complete.status}, canComplete ${JSON.stringify(source.json?.canComplete)}`,
      );
    }

    // A task that is not the caller's is never completable, whatever their tier.
    const editor = callers.find((caller) => caller.label === "editor");
    const ownersTask = callers.find((caller) => caller.label === "admin").task;
    const notMine = await call("GET", `api/tasks/${ownersTask._id}`, tokenFor(editor.user));
    check(
      "a task assigned to somebody else never reads as completable",
      notMine.status === 404 || notMine.json?.canComplete === false,
      `status ${notMine.status}, canComplete ${JSON.stringify(notMine.json?.canComplete)}`,
    );
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
  console.log(`\nTask completion offer end-to-end: ${passed}/${checks.length}`);
  if (passed !== checks.length) {
    console.error(`\n${checks.length - passed} check(s) failed.`);
    return 1;
  }
  return 0;
}
