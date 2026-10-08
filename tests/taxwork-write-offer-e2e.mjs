// canWrite on the tax work reads must say what a tax work write will actually do.
//
// Every route under /api/taxworker passes requireFirmWriteAccess, so a read-only member - a VIEWER,
// or a MEMBER of a firm whose memberAccess is READ_ONLY - can read tax work and change none of it.
// The extension's tax work page offered every change regardless (new tax work, documents received,
// notes, mark complete, archive), each one refused by the server. The two reads it loads from,
// GET /api/taxworker/sessions and GET /api/taxworker/sessions/:id, now carry canWrite, the write
// guard's own answer asked without enforcing it.
//
// Differential, like task-completion-offer-e2e: for every caller, the canWrite the reads report must
// equal whether a PATCH to the same session then succeeds.
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
    "Tax work write offer end-to-end: SKIPPED - no MONGODB_URI.\n"
      + "This suite boots the real server against a scratch database and compares canWrite with a\n"
      + "tax work write for every firm role. Start a local Mongo and re-run the gates.",
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
    const { default: Client } = await import(toFileUrl("src", "models", "Client.js"));
    const { default: TaxWorkSession } = await import(toFileUrl("src", "models", "TaxWorkSession.js"));
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

    const owner = await User.create({
      email: "taxwork-owner@example.invalid",
      name: "Tax work owner",
      role: "USER",
      accountType: "INDIVIDUAL",
      isActive: true,
    });
    const makeFirm = async (handle, memberAccess) => {
      const firm = await Firm.create({
        displayName: `Tax work ${handle}`,
        handle,
        ownerUserId: owner._id,
        kind: "SHARED",
        joinCode: `${handle.toUpperCase()}-CODE`,
        memberAccess,
      });
      const client = await Client.create({
        firmId: firm._id,
        ownerUserId: owner._id,
        createdBy: owner._id,
        name: `Tax work client ${handle}`,
      });
      const session = await TaxWorkSession.create({
        firmId: firm._id,
        ownerUserId: owner._id,
        clientId: client._id,
        taxType: "GST_MONTHLY",
        period: "Sep 2026",
        createdBy: owner._id,
      });
      return { firm, session };
    };
    const edit = await makeFirm("taxwork-edit", "EDIT");
    const readOnly = await makeFirm("taxwork-readonly", "READ_ONLY");

    const member = async (label, place, role) => {
      const user = label === "owner"
        ? owner
        : await User.create({
            email: `taxwork-${label}@example.invalid`,
            name: `Tax work ${label}`,
            role: "USER",
            accountType: "INDIVIDUAL",
            isActive: true,
          });
      await FirmMembership.create({ firmId: place.firm._id, userId: user._id, role, status: "ACTIVE" });
      await User.updateOne({ _id: user._id }, { $set: { firmId: place.firm._id } });
      return { label, session: place.session, user: await User.findById(user._id).lean() };
    };

    const callers = [
      await member("owner", edit, "OWNER"),
      await member("admin", edit, "ADMIN"),
      await member("editor", edit, "MEMBER"),
      await member("viewer", edit, "VIEWER"),
      await member("readonly-member", readOnly, "MEMBER"),
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
      const id = String(caller.session._id);

      const list = await call("GET", "api/taxworker/sessions", token);
      check(
        `${caller.label}: the session list is readable and says canWrite ${expectWrite[caller.label]}`,
        list.status === 200
          && (list.json?.sessions || []).some((s) => String(s._id) === id)
          && list.json?.canWrite === expectWrite[caller.label],
        `status ${list.status}, canWrite ${JSON.stringify(list.json?.canWrite)}`,
      );

      const one = await call("GET", `api/taxworker/sessions/${id}`, token);
      check(
        `${caller.label}: one session says canWrite ${expectWrite[caller.label]}`,
        one.status === 200 && one.json?.canWrite === expectWrite[caller.label],
        `status ${one.status}, canWrite ${JSON.stringify(one.json?.canWrite)}`,
      );

      // The differential: what the reads promised against what a write does.
      const write = await call("PATCH", `api/taxworker/sessions/${id}`, token, { notes: `note by ${caller.label}` });
      const accepted = write.status === 200;
      check(
        `${caller.label}: a write is ${accepted ? "accepted" : "refused"}, as canWrite said`,
        accepted === list.json?.canWrite && accepted === one.json?.canWrite,
        `PATCH ${write.status}, canWrite ${JSON.stringify(one.json?.canWrite)}`,
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
  console.log(`\nTax work write offer end-to-end: ${passed}/${checks.length}`);
  if (passed !== checks.length) {
    console.error(`\n${checks.length - passed} check(s) failed.`);
    return 1;
  }
  return 0;
}
