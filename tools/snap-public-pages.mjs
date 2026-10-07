// tools/snap-public-pages.mjs
//
// Photographs the REAL public pages - the admin sign-in, the digest unsubscribe page and the daily
// digest activation page - served by the REAL backend on a loopback port against a scratch database,
// in the states a person meets them: the sign-in before and after "I already have an OTP", the
// unsubscribe page with a valid link and with a broken one, the activation page with a valid link and
// with none. At a desktop and a phone width, in the light and the dark scheme (DS25).
//
// SAFETY, asserted rather than intended (the same guards as tools/drive-local-panel.mjs):
//   1. The API base must be a loopback address.
//   2. MONGODB_URI must be a loopback address, and its database name must carry the scratch marker.
//   3. The outbound provider keys are blanked in this process, so no email or paid call can leave.
// The scratch database is dropped at the end, including when something fails. Nothing is submitted:
// the pages are opened and photographed, never confirmed.
//
// USAGE
//   node tools/snap-public-pages.mjs --out <dir> [--theme light|dark|both] [--width desktop|phone|both]
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { withBrowser } from "./browser-drive.mjs";

const SCRATCH_MARKER = "capro-public-pages-snap";
const MONGO_URI = `mongodb://127.0.0.1:27117/${SCRATCH_MARKER}`;

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const outDir = resolve(option("--out", "public-page-snaps"));
const themes = option("--theme", "both") === "both" ? ["light", "dark"] : [option("--theme")];
const widths = { desktop: { width: 1280, height: 800 }, phone: { width: 390, height: 844 } };
const widthNames = option("--width", "both") === "both" ? ["desktop", "phone"] : [option("--width")];

process.env.NODE_ENV = "development";
process.env.JWT_SECRET = "public-pages-snap-only-not-a-real-secret";
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
const { default: app } = await import("../src/app.js");
const { default: User } = await import("../src/models/User.js");
const { buildDigestUnsubscribeLinks, buildDailyDigestActivationLink, DAILY_KIND } = await import("../src/services/digest.service.js");

const server = app.listen(0);
await new Promise((done) => server.once("listening", done));
const base = `http://localhost:${server.address().port}`;
assertLoopback("API base", base);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const written = [];
// The links name the production host; the query is what the pages read, so it is moved to this server.
const local = (url) => `${base}${new URL(url).pathname}${new URL(url).search}`;

try {
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  await mongoose.connection.dropDatabase();
  const user = await User.create({ email: "asha.menon@example.com", name: "Asha Menon", role: "USER", accountType: "FIRM_USER" });
  const { pageUrl } = buildDigestUnsubscribeLinks({ recipientUserId: String(user._id), kind: DAILY_KIND });
  const activation = buildDailyDigestActivationLink(String(user._id));

  const shots = [
    { name: "signin", url: `${base}/index.html` },
    { name: "signin-otp", url: `${base}/index.html`, then: `document.getElementById("goVerify").click(); true` },
    { name: "unsubscribe", url: local(pageUrl) },
    { name: "unsubscribe-broken", url: `${base}/unsubscribe.html?u=000000000000000000000000&k=${DAILY_KIND}&t=not-a-token` },
    { name: "activate", url: local(activation) },
    { name: "activate-incomplete", url: `${base}/daily-digest-activate.html` },
  ];

  mkdirSync(outDir, { recursive: true });
  await withBrowser(async (page) => {
    for (const shot of shots) {
      for (const widthName of widthNames) {
        const size = widths[widthName];
        for (const theme of themes) {
          await page.send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: widthName === "phone" });
          await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
          await page.goto(shot.url, { waitMs: 2000 });
          if (shot.then) {
            await page.evaluate(shot.then);
            await sleep(400);
          }
          const png = await page.send("Page.captureScreenshot", { format: "png" });
          const file = join(outDir, `${shot.name}-${widthName}-${theme}.png`);
          writeFileSync(file, Buffer.from(png.data, "base64"));
          written.push(`${file}  ${size.width}x${size.height}`);
        }
      }
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
