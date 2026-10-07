// tools/snap-admin-panels.mjs
//
// Photographs the REAL super-admin and firm-admin panels, served by the REAL backend on a loopback
// port against a scratch database seeded with an invented firm, at a desktop and a phone width, in
// the light and the dark scheme. For design review (DS24); nothing here writes outside the scratch
// database, and nothing here can reach production.
//
// SAFETY, asserted rather than intended (the same three guards as tools/drive-local-panel.mjs):
//   1. The API base must be a loopback address.
//   2. MONGODB_URI must be a loopback address, and its database name must carry the scratch marker.
//   3. The outbound provider keys are blanked in this process, so no email or paid call can leave.
// The scratch database is dropped at the end, including when something fails.
//
// USAGE
//   node tools/snap-admin-panels.mjs --out <dir> [--only super|admin] [--theme light|dark|both]
//                                              [--width desktop|phone|both] [--sections a,b,c]
// Each panel is photographed on each of its sections (default: every page), named
// <panel>-<section>-<width>-<theme>.png. Two extra shots show the dialogs: the firm users dialog
// (super-firms-dialog) and the maintenance question (super-controls-ask).

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { withBrowser } from "./browser-drive.mjs";

const SCRATCH_MARKER = "capro-admin-panel-snap";
const MONGO_URI = `mongodb://127.0.0.1:27117/${SCRATCH_MARKER}`;
const SUPER_EMAIL = "saifullahfaizan786@gmail.com";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const outDir = resolve(option("--out", "admin-panel-snaps"));
const only = option("--only", "both");
const themes = option("--theme", "both") === "both" ? ["light", "dark"] : [option("--theme")];
const widths = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };
const widthNames = option("--width", "both") === "both" ? ["desktop", "phone"] : [option("--width")];

process.env.NODE_ENV = "development";
process.env.JWT_SECRET = "admin-panel-snap-only-not-a-real-secret";
process.env.MONGODB_URI = MONGO_URI;
for (const outbound of ["RESEND_API_KEY", "DEEPSEEK_API_KEY", "OCR_SPACE_API_KEY", "HOSTINGER_API_TOKEN"]) {
  process.env[outbound] = "";
}

function assertLoopback(label, value) {
  const host = /^mongodb:\/\/([^/:]+)/.exec(value)?.[1] ?? new URL(value).hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error(`${label} must be loopback, got ${host} - refusing to run`);
  }
}
assertLoopback("MONGODB_URI", MONGO_URI);
if (!MONGO_URI.includes(SCRATCH_MARKER)) throw new Error("MONGODB_URI must name the scratch database - refusing to run");

const mongoose = (await import("mongoose")).default;
const jwt = (await import("jsonwebtoken")).default;
const { default: app } = await import("../src/app.js");
const { default: User } = await import("../src/models/User.js");
const { default: Firm } = await import("../src/models/Firm.js");
const { default: FirmMembership } = await import("../src/models/FirmMembership.js");
const { default: Task } = await import("../src/models/Task.js");
const { default: AppConfig } = await import("../src/models/AppConfig.js");

const server = app.listen(0);
await new Promise((done) => server.once("listening", done));
const base = `http://localhost:${server.address().port}`;
assertLoopback("API base", base);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const written = [];

try {
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  await mongoose.connection.dropDatabase();

  const superUser = await User.create({ email: SUPER_EMAIL, name: "Design Super Admin", role: "SUPER_ADMIN", accountType: "INDIVIDUAL" });
  const admin = await User.create({ email: "meera@example.com", name: "Meera Iyer", role: "FIRM_ADMIN", accountType: "FIRM_USER" });
  const firm = await Firm.create({
    displayName: "Example & Co. Chartered Accountants",
    handle: "example-co",
    ownerUserId: admin._id,
    kind: "SHARED",
    joinCode: "EXMPL123",
  });
  admin.firmId = firm._id;
  await admin.save();
  const members = await Promise.all(
    [
      ["Rohan Gupta", "rohan@example.com"],
      ["Asha Menon", "asha@example.com"],
    ].map(([name, email]) => User.create({ email, name, role: "USER", accountType: "FIRM_USER", firmId: firm._id })),
  );
  await FirmMembership.create([
    { firmId: firm._id, userId: admin._id, role: "OWNER", status: "ACTIVE" },
    ...members.map((m) => ({ firmId: firm._id, userId: m._id, role: "MEMBER", status: "ACTIVE" })),
  ]);
  const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
  await Task.create(
    [
      ["Asha Traders", "GST", "GSTR-3B for September 2026", -3, members[0]],
      ["Bharat Exports", "TDS", "TDS return 26Q, quarter 2", 0, members[1]],
      ["Chandra Mills", "GST", "GSTR-1 for September 2026", 4, null],
    ].map(([clientName, serviceType, title, offset, assignee]) => ({
      firmId: firm._id,
      createdBy: admin._id,
      clientName,
      serviceType,
      title,
      dueDateISO: day(offset),
      assignedTo: assignee ? assignee._id : undefined,
    })),
  );
  await AppConfig.create({
    _id: "singleton",
    featureFlags: { gstReconciliation: true, tdsHealth: true, filingDashboard: true },
    controlChanges: [
      { at: new Date(Date.now() - 86400000), byUserId: superUser._id, byEmail: SUPER_EMAIL, kind: "featureFlags", summary: "Set tdsHealth on", reason: "TDS health is ready for firms" },
      { at: new Date(Date.now() - 3600000), byUserId: superUser._id, byEmail: SUPER_EMAIL, kind: "maintenance", summary: "Changed the maintenance message", reason: "" },
    ],
  });
  await User.create({ email: "kiran@example.com", name: "Kiran Rao", role: "USER", accountType: "INDIVIDUAL", firmAdminRequestedAt: new Date(Date.now() - 7200000) });

  const tokenFor = (user) =>
    jwt.sign(
      { id: String(user._id), email: user.email, role: user.role, accountType: user.accountType, firmId: user.firmId ? String(user.firmId) : null, isActive: true, tv: 0 },
      process.env.JWT_SECRET,
      { expiresIn: "1h" },
    );

  const pick = option("--sections", "");
  const targets = [
    { name: "super", path: "/admin/super.html", token: tokenFor(superUser), sections: ["overview", "controls", "analytics", "emails", "users", "firms", "approvals", "terms", "review"] },
    { name: "admin", path: "/admin/admin.html", token: tokenFor(admin), sections: ["dashboard", "tasks", "assistant", "firm", "users", "join", "settings"] },
  ]
    .filter((t) => only === "both" || t.name === only)
    .map((t) => ({ ...t, sections: pick ? pick.split(",").filter((s) => t.sections.includes(s)) : t.sections }));

  mkdirSync(outDir, { recursive: true });
  await withBrowser(async (page) => {
    const capture = async (name, size, phone) => {
      const height = Math.min(6000, Math.max(size.height, Number(await page.evaluate("Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)")) || size.height));
      await page.send("Emulation.setDeviceMetricsOverride", { width: size.width, height, deviceScaleFactor: 1, mobile: phone });
      await sleep(400);
      const shot = await page.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: size.width, height, scale: 1 } });
      const file = join(outDir, `${name}.png`);
      writeFileSync(file, Buffer.from(shot.data, "base64"));
      written.push(`${file}  ${size.width}x${height}`);
    };
    for (const target of targets) {
      await page.goto(`${base}${target.path}`, { waitMs: 800 });
      await page.evaluate(`localStorage.setItem("caproadminjwt", ${JSON.stringify(target.token)}); true`);
      for (const section of target.sections) {
        for (const widthName of widthNames) {
          const size = widths[widthName];
          for (const theme of themes) {
            await page.send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: widthName === "phone" });
            await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
            await page.goto(`${base}${target.path}#${section}`, { waitMs: 3000 });
            await capture(`${target.name}-${section}-${widthName}-${theme}`, size, widthName === "phone");
          }
        }
      }
    }
    // The dialogs, at desktop width in the light scheme.
    if (only !== "admin" && (!pick || pick.includes("firms") || pick.includes("controls"))) {
      const size = widths.desktop;
      await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
      await page.send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false });
      // The last panel photographed may have been the firm panel, whose token super.html turns away.
      await page.evaluate(`localStorage.setItem("caproadminjwt", ${JSON.stringify(tokenFor(superUser))}); true`);
      await page.goto(`${base}/admin/super.html#firms`, { waitMs: 3000 });
      await page.evaluate(`document.querySelector(".firm-users-btn") && document.querySelector(".firm-users-btn").click(); true`);
      await sleep(1500);
      const shot = await page.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(outDir, "super-firms-dialog.png"), Buffer.from(shot.data, "base64"));
      written.push(`${join(outDir, "super-firms-dialog.png")}  ${size.width}x${size.height}`);
      await page.goto(`${base}/admin/super.html#controls`, { waitMs: 3000 });
      await page.evaluate(`document.getElementById("maintenanceToggle").click(); true`);
      await sleep(800);
      const ask = await page.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(outDir, "super-controls-ask.png"), Buffer.from(ask.data, "base64"));
      written.push(`${join(outDir, "super-controls-ask.png")}  ${size.width}x${size.height}`);
    }
  });
  console.log(written.join("\n"));
} catch (error) {
  console.error(`snap failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  try {
    if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
  } catch (error) {
    console.error(`WARNING could not drop the scratch database: ${error.message}`);
  }
  try { await mongoose.disconnect(); } catch { /* already closed */ }
  await new Promise((done) => server.close(done));
}
