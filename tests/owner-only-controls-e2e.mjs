// Who the server lets rotate a firm's join code, and who it lets leave the firm (R26).
//
// Both clients now offer these two buttons by role: Rotate the join code to the owner alone, Leave to
// everybody but the owner. This suite pins the server behaviour those choices follow, against the
// real routes: rotateJoinCode accepts only the confirmed owner, and leaveFirm accepts every member
// except the owner of a shared firm, whom it answers with 409 - so for the owner Leave cannot
// succeed until ownership is transferred (R27: POST /api/firms/:firmId/transfer-ownership, pinned by
// tests/ownership-transfer-e2e.mjs).
//
// leaveFirm runs in a MongoDB transaction, so this suite needs the scratch replica set; run-gates.ps1
// lists it with the other replica-set suites, which skip (not fail) when nothing listens on 27118.

import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// Captured before .env is read; .env points at the production cluster and must never fill this in.
const target = process.env.MONGODB_URI || "mongodb://127.0.0.1:27118/scratch-owner-controls-e2e?replicaSet=rs0";

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
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)[:/]/.test(target) || !/scratch/i.test(target)) {
  console.error(
    "REFUSED: MONGODB_URI must be loopback and carry a scratch marker. This suite drops its\n"
      + "database and will not run against anything else.",
  );
  process.exitCode = 1;
} else {
  process.env.MONGODB_URI = target;
  process.exitCode = await runSuite();
}

async function runSuite() {
  const SCRATCH_DB = new URL(target).pathname.replace(/^\//, "");
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

    const person = async (label) => {
      const created = await User.create({
        email: `owner-controls-${label}@example.invalid`,
        name: `Owner controls ${label}`,
        role: "USER",
        accountType: "INDIVIDUAL",
        isActive: true,
      });
      return ensurePersonalFirm(created);
    };

    const owner = await person("owner");
    const firm = await Firm.create({
      displayName: "Owner controls firm",
      handle: "owner-controls",
      ownerUserId: owner._id,
      kind: "SHARED",
      joinCode: "OWNCTL-CODE",
      memberAccess: "EDIT",
    });

    const join = async (user, role) => {
      await FirmMembership.create({ firmId: firm._id, userId: user._id, role, status: "ACTIVE" });
      await User.updateOne({ _id: user._id }, { $set: { firmId: firm._id } });
      return User.findById(user._id).lean();
    };

    const callers = [
      { label: "owner", role: "OWNER", user: await join(owner, "OWNER") },
      { label: "admin", role: "ADMIN", user: await join(await person("admin"), "ADMIN") },
      { label: "member", role: "MEMBER", user: await join(await person("member"), "MEMBER") },
      { label: "viewer", role: "VIEWER", user: await join(await person("viewer"), "VIEWER") },
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

    const id = String(firm._id);

    // Rotation first, while everybody is still a member.
    for (const caller of callers) {
      const rotated = await call("POST", `api/firms/${id}/join-code/rotate`, tokenFor(caller.user), {});
      const expected = caller.role === "OWNER" ? 200 : 403;
      check(
        `${caller.label}: rotating the join code answers ${expected}`,
        rotated.status === expected,
        `status ${rotated.status}${rotated.json?.error ? `, "${rotated.json.error}"` : ""}`,
      );
    }

    // Then leaving: the owner is refused with 409, everybody else leaves.
    for (const caller of callers) {
      const left = await call("POST", `api/firms/${id}/leave`, tokenFor(caller.user), {});
      if (caller.role === "OWNER") {
        check(
          "owner: leaving the shared firm is refused with 409, transfer first",
          left.status === 409 && /Transfer ownership/i.test(String(left.json?.error || "")),
          `status ${left.status}, "${left.json?.error || ""}"`,
        );
      } else {
        const membership = await FirmMembership.findOne({ firmId: firm._id, userId: caller.user._id }).lean();
        check(
          `${caller.label}: leaving succeeds and the membership is no longer active`,
          left.status === 200 && membership?.status !== "ACTIVE",
          `status ${left.status}, membership ${membership?.status}`,
        );
      }
    }

    // Leave is not worth offering the owner: the owner leaves only after ownership has moved, and
    // exactly one route moves it (R27). With every other member gone there is nobody to move it to.
    const { default: firmRoutes } = await import(toFileUrl("src", "routes", "firm.routes.js"));
    const routes = (firmRoutes.stack || []).map((layer) => layer.route).filter(Boolean);
    const transferRoutes = routes.filter((route) => /transfer|owner/i.test(route.path));
    check(
      "exactly one firm route transfers ownership: POST /:firmId/transfer-ownership",
      routes.length > 5
        && transferRoutes.length === 1
        && transferRoutes[0].path === "/:firmId/transfer-ownership"
        && transferRoutes[0].methods?.post === true,
      `${routes.length} firm routes, ${transferRoutes.length} transferring`,
    );
    const nobody = await call("POST", `api/firms/${id}/transfer-ownership`, tokenFor(callers[0].user), {
      toUserId: String(callers[1].user._id),
      confirmHandle: "owner-controls",
    });
    check(
      "owner: with every other member gone, a transfer to a former member is refused 404",
      nobody.status === 404 && /not an active member/i.test(String(nobody.json?.error || "")),
      `status ${nobody.status}, "${nobody.json?.error || ""}"`,
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
  console.log(`\nOwner-only controls end-to-end: ${passed}/${checks.length}`);
  if (passed !== checks.length) {
    console.error(`\n${checks.length - passed} check(s) failed.`);
    return 1;
  }
  return 0;
}
