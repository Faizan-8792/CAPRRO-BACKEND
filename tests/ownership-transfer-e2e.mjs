// An owner hands a shared firm to another active member (R27).
//
// Until this route existed a shared firm's owner could never leave: leaveFirm answers the owner
// with 409 "Transfer ownership before leaving this firm" and nothing transferred it. This suite
// drives the real route against the real express app and pins what it does, and what it refuses:
//
//   * only the confirmed owner may transfer (Firm.ownerUserId AND an ACTIVE OWNER membership), so
//     an administrator, a member, a viewer, an outsider and a stale OWNER row are all refused;
//   * every refusal leaves the firm, every membership, every account role and the activity trail
//     exactly as they were;
//   * a transfer moves the owner pointer, makes the new owner OWNER and the previous owner ADMIN,
//     keeps the account role of whoever has the firm active in step, records one activity event,
//     and signs nobody out;
//   * afterwards the previous owner may leave and the new owner may not;
//   * two transfers at once leave exactly one owner;
//   * GET /api/firms/:firmId/members says canTransferOwnership to the owner alone, and
//     canReceiveOwnership only for the members the route would accept.
//
// The route runs in a MongoDB transaction, so this suite needs the scratch replica set; run-gates.ps1
// lists it with the other replica-set suites, which skip (not fail) when nothing listens on 27118.
// Scored by tools/mutations/ownership-transfer.mjs.

import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// Captured before .env is read; .env points at the production cluster and must never fill this in.
const target = process.env.MONGODB_URI || "mongodb://127.0.0.1:27118/scratch-ownership-transfer-e2e?replicaSet=rs0";

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
    const { default: ActivityEvent } = await import(toFileUrl("src", "models", "ActivityEvent.js"));
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

    const person = async (label, extra = {}) => {
      const created = await User.create({
        email: `transfer-${label}@example.invalid`,
        name: `Transfer ${label}`,
        role: "USER",
        accountType: "INDIVIDUAL",
        isActive: true,
        ...extra,
      });
      return ensurePersonalFirm(created);
    };

    const owner = await person("owner");
    const firm = await Firm.create({
      displayName: "Transfer firm",
      handle: "transfer-firm",
      ownerUserId: owner._id,
      kind: "SHARED",
      joinCode: "XFER-CODE",
      memberAccess: "EDIT",
    });
    const firmId = String(firm._id);

    // Every person below has this firm active, as they would after switching into it, and holds the
    // account role setActiveWorkspace gives that rung: FIRM_ADMIN for the owner and an administrator.
    const join = async (user, role, status = "ACTIVE") => {
      await FirmMembership.create({ firmId: firm._id, userId: user._id, role, status });
      const elevated = status === "ACTIVE" && (role === "OWNER" || role === "ADMIN");
      await User.updateOne(
        { _id: user._id },
        { $set: { firmId: firm._id, accountType: "FIRM_USER", role: elevated ? "FIRM_ADMIN" : "USER" } },
      );
      return User.findById(user._id).lean();
    };

    const ownerUser = await join(owner, "OWNER");
    const admin = await join(await person("admin"), "ADMIN");
    const member = await join(await person("member"), "MEMBER");
    const viewer = await join(await person("viewer"), "VIEWER");
    const removed = await join(await person("removed"), "MEMBER", "REMOVED");
    const inactive = await join(await person("inactive"), "MEMBER");
    await User.updateOne({ _id: inactive._id }, { $set: { isActive: false } });
    // An OWNER row the firm does not agree with: stale data, never authority.
    const stale = await join(await person("stale"), "OWNER");
    const outsider = await person("outsider");

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

    const call = async (method, path, user, body) => {
      const res = await fetch(`${base}/${path}`, {
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenFor(user)}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, json };
    };
    const transfer = (caller, body, id = firmId) =>
      call("POST", `api/firms/${id}/transfer-ownership`, caller, body);
    const members = (caller) => call("GET", `api/firms/${firmId}/members`, caller);

    // Everything a transfer could touch, so a refusal can be proved to have changed nothing.
    const snapshot = async () => {
      const firmNow = await Firm.findById(firm._id).lean();
      const rows = await FirmMembership.find({ firmId: firm._id }).sort({ userId: 1 }).lean();
      const people = await User.find({}).sort({ _id: 1 }).select("role firmId tokenVersion isActive").lean();
      const events = await ActivityEvent.countDocuments({ firmId: firm._id });
      return JSON.stringify({
        owner: String(firmNow.ownerUserId),
        rows: rows.map((r) => `${r.userId}:${r.role}:${r.status}`),
        people: people.map((p) => `${p._id}:${p.role}:${p.firmId}:${p.tokenVersion || 0}`),
        events,
      });
    };
    const refused = async (label, caller, body, expectedStatus, pattern, id = firmId) => {
      const before = await snapshot();
      const res = await transfer(caller, body, id);
      const after = await snapshot();
      const error = String(res.json?.error || "");
      check(
        `${label}: refused ${expectedStatus}, nothing changed`,
        res.status === expectedStatus && pattern.test(error) && before === after,
        `status ${res.status}, "${error}", ${before === after ? "unchanged" : "STATE CHANGED"}`,
      );
    };

    const toMember = { toUserId: String(member._id), confirmHandle: "transfer-firm" };

    // 1. The members read: the owner alone is offered Transfer, and only acceptable members listed.
    {
      const read = await members(ownerUser);
      const byId = new Map((read.json?.members || []).map((m) => [String(m.userId), m]));
      const receivable = [...byId.values()].filter((m) => m.canReceiveOwnership).map((m) => String(m.userId)).sort();
      const expected = [admin, member, viewer, stale].map((u) => String(u._id)).sort();
      check(
        "owner: the members read says canTransferOwnership",
        read.status === 200 && read.json?.canTransferOwnership === true,
        `status ${read.status}, canTransferOwnership ${read.json?.canTransferOwnership}`,
      );
      check(
        "owner: canReceiveOwnership for every active member with an active account, never the owner, the inactive account or the removed member",
        JSON.stringify(receivable) === JSON.stringify(expected)
          && byId.get(String(owner._id))?.canReceiveOwnership === false
          && byId.get(String(inactive._id))?.canReceiveOwnership === false
          && !byId.has(String(removed._id)),
        `${receivable.length} receivable of ${byId.size} listed`,
      );
    }
    for (const [label, caller] of [["admin", admin], ["member", member], ["viewer", viewer], ["stale OWNER row", stale]]) {
      const read = await members(caller);
      const anyReceivable = (read.json?.members || []).some((m) => m.canReceiveOwnership !== false);
      check(
        `${label}: the members read offers no transfer`,
        read.status === 200 && read.json?.canTransferOwnership === false && !anyReceivable,
        `status ${read.status}, canTransferOwnership ${read.json?.canTransferOwnership}`,
      );
    }

    // 2. Nobody but the confirmed owner may transfer.
    await refused("admin caller", admin, toMember, 403, /Only the workspace owner/);
    await refused("member caller", member, { ...toMember, toUserId: String(viewer._id) }, 403, /Only the workspace owner/);
    await refused("viewer caller", viewer, toMember, 403, /Only the workspace owner/);
    await refused("stale OWNER row caller", stale, toMember, 403, /Only the workspace owner/);
    await refused("outsider caller", outsider, toMember, 403, /Only the workspace owner/);

    // 3. The owner's own requests that the route must refuse.
    await refused("personal workspace", ownerUser, { toUserId: String(member._id), confirmHandle: "x" }, 400, /personal workspace/, String(owner.personalFirmId));
    await refused("no toUserId", ownerUser, { confirmHandle: "transfer-firm" }, 400, /Choose the member/);
    await refused("a malformed toUserId", ownerUser, { toUserId: "not-an-id", confirmHandle: "transfer-firm" }, 400, /Choose the member/);
    await refused("no confirmHandle", ownerUser, { toUserId: String(member._id) }, 400, /Type the workspace handle/);
    await refused("a wrong confirmHandle", ownerUser, { toUserId: String(member._id), confirmHandle: "another-firm" }, 400, /not this workspace's handle/);
    await refused("oneself", ownerUser, { toUserId: String(owner._id), confirmHandle: "transfer-firm" }, 409, /already own/);
    await refused("an outsider target", ownerUser, { toUserId: String(outsider._id), confirmHandle: "transfer-firm" }, 404, /not an active member/);
    await refused("a removed member target", ownerUser, { toUserId: String(removed._id), confirmHandle: "transfer-firm" }, 404, /not an active member/);
    await refused("an inactive account target", ownerUser, { toUserId: String(inactive._id), confirmHandle: "transfer-firm" }, 409, /account is not active/);
    await refused("an unknown firm", ownerUser, toMember, 404, /Workspace not found/, String(new mongoose.Types.ObjectId()));
    await refused("a malformed firm id", ownerUser, toMember, 404, /Workspace not found/, "not-a-firm");

    // The stale row has done its job; from here "exactly one OWNER row" means exactly one owner.
    await FirmMembership.updateOne({ firmId: firm._id, userId: stale._id }, { $set: { status: "REMOVED" } });

    // 4. The transfer itself: owner to an ordinary member, the handle typed with an @ and capitals.
    const tokenVersionsBefore = await User.find({ _id: { $in: [owner._id, member._id] } }).select("tokenVersion").lean();
    const moved = await transfer(ownerUser, { toUserId: String(member._id), confirmHandle: " @Transfer-Firm " });
    {
      const firmNow = await Firm.findById(firm._id).lean();
      const rows = await FirmMembership.find({ firmId: firm._id, status: "ACTIVE" }).lean();
      const roleOf = (u) => rows.find((r) => String(r.userId) === String(u._id))?.role;
      const ownerRows = rows.filter((r) => r.role === "OWNER");
      const events = await ActivityEvent.find({ firmId: firm._id, action: "FIRM_OWNERSHIP_TRANSFERRED" }).lean();
      const people = await User.find({ _id: { $in: [owner._id, member._id] } }).lean();
      const accountRole = (u) => people.find((p) => String(p._id) === String(u._id))?.role;
      const versionsAfter = people.map((p) => `${p._id}:${p.tokenVersion || 0}`).sort();
      const versionsBefore = tokenVersionsBefore.map((p) => `${p._id}:${p.tokenVersion || 0}`).sort();

      check(
        "owner to member: 200, the response names the new owner and the caller as administrator",
        moved.status === 200
          && String(moved.json?.newOwner?.userId) === String(member._id)
          && moved.json?.newOwner?.role === "OWNER"
          && moved.json?.newOwner?.previousRole === "MEMBER"
          && String(moved.json?.previousOwner?.userId) === String(owner._id)
          && moved.json?.previousOwner?.role === "ADMIN"
          && moved.json?.workspace?.role === "ADMIN"
          && String(moved.json?.firm?.ownerUserId) === String(member._id),
        `status ${moved.status}${moved.json?.error ? `, "${moved.json.error}"` : ""}, workspace role ${moved.json?.workspace?.role}`,
      );
      check(
        "the firm's owner pointer names the new owner, whose membership is OWNER; the previous owner's is ADMIN",
        String(firmNow.ownerUserId) === String(member._id)
          && roleOf(member) === "OWNER" && roleOf(owner) === "ADMIN" && ownerRows.length === 1,
        `owner ${firmNow.ownerUserId === undefined ? "none" : "moved"}, member ${roleOf(member)}, previous owner ${roleOf(owner)}, OWNER rows ${ownerRows.length}`,
      );
      check(
        "account roles: both have this firm active and both are firm administrators",
        accountRole(member) === "FIRM_ADMIN" && accountRole(owner) === "FIRM_ADMIN",
        `new owner ${accountRole(member)}, previous owner ${accountRole(owner)}`,
      );
      check(
        "one FIRM_OWNERSHIP_TRANSFERRED event, by the previous owner, naming both owners",
        events.length === 1
          && String(events[0].actorUserId) === String(owner._id)
          && events[0].entityType === "Firm" && events[0].entityId === firmId
          && events[0].beforeSummary?.ownerUserId === String(owner._id)
          && events[0].afterSummary?.ownerUserId === String(member._id),
        `${events.length} event(s)`,
      );
      check(
        "nobody is signed out by it (token versions unchanged)",
        JSON.stringify(versionsAfter) === JSON.stringify(versionsBefore),
        versionsAfter.join(", "),
      );
    }

    // 5. Authority follows the pointer at once.
    const newOwner = await User.findById(member._id).lean();
    const previousOwner = await User.findById(owner._id).lean();
    await refused("the previous owner again", previousOwner, { toUserId: String(admin._id), confirmHandle: "transfer-firm" }, 403, /Only the workspace owner/);
    {
      const rotatePrevious = await call("POST", `api/firms/${firmId}/join-code/rotate`, previousOwner, {});
      const rotateNew = await call("POST", `api/firms/${firmId}/join-code/rotate`, newOwner, {});
      check(
        "rotating the join code: the previous owner is now refused, the new owner accepted",
        rotatePrevious.status === 403 && rotateNew.status === 200,
        `previous ${rotatePrevious.status}, new ${rotateNew.status}`,
      );
      const readNew = await members(newOwner);
      const readPrevious = await members(previousOwner);
      check(
        "the members read now offers Transfer to the new owner and not to the previous one",
        readNew.json?.canTransferOwnership === true && readPrevious.json?.canTransferOwnership === false,
        `new ${readNew.json?.canTransferOwnership}, previous ${readPrevious.json?.canTransferOwnership}`,
      );
      const leaveNew = await call("POST", `api/firms/${firmId}/leave`, newOwner, {});
      check(
        "the new owner may not leave: 409, transfer first",
        leaveNew.status === 409 && /Transfer ownership/.test(String(leaveNew.json?.error || "")),
        `status ${leaveNew.status}, "${leaveNew.json?.error || ""}"`,
      );
    }

    // 6. Two transfers at once, to two different people: exactly one owner afterwards.
    {
      const [a, b] = await Promise.all([
        transfer(newOwner, { toUserId: String(admin._id), confirmHandle: "transfer-firm" }),
        transfer(newOwner, { toUserId: String(viewer._id), confirmHandle: "transfer-firm" }),
      ]);
      const statuses = [a.status, b.status];
      const winners = [a, b].filter((r) => r.status === 200);
      const firmNow = await Firm.findById(firm._id).lean();
      const ownerRows = await FirmMembership.find({ firmId: firm._id, status: "ACTIVE", role: "OWNER" }).lean();
      const events = await ActivityEvent.countDocuments({ firmId: firm._id, action: "FIRM_OWNERSHIP_TRANSFERRED" });
      const winnerId = String(winners[0]?.json?.newOwner?.userId || "");
      check(
        "two transfers at once: one accepted, the other refused, one OWNER row, the pointer on the winner",
        winners.length === 1
          && statuses.some((s) => s === 403 || s === 409)
          && ownerRows.length === 1
          && String(ownerRows[0].userId) === winnerId
          && String(firmNow.ownerUserId) === winnerId
          && events === 2,
        `statuses ${statuses.join(" and ")}, OWNER rows ${ownerRows.length}, events ${events}`,
      );
    }

    // 7. The previous owner, now an administrator, can leave - the point of the whole feature.
    {
      const left = await call("POST", `api/firms/${firmId}/leave`, previousOwner, {});
      const row = await FirmMembership.findOne({ firmId: firm._id, userId: owner._id }).lean();
      check(
        "the original owner can now leave the firm",
        left.status === 200 && row?.status === "REMOVED",
        `status ${left.status}, membership ${row?.status}`,
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
  console.log(`\nOwnership transfer end-to-end: ${passed}/${checks.length}`);
  if (passed !== checks.length) {
    console.error(`\n${checks.length - passed} check(s) failed.`);
    return 1;
  }
  return 0;
}
