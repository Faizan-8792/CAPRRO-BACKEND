// tools/verify-provider-usage-card-local.mjs
//
// O10's remaining Verify bullet is "the admin panel's Provider usage card loads and shows non-zero
// counts after a few real calls". This does NOT make real calls - it never could without spending
// real money against DeepSeek/OCR.space, which no agent may do unilaterally, and the outbound
// provider keys are blanked in this process on purpose, same as drive-local-panel.mjs.
//
// What it DOES prove, honestly stated: given real usage data in the database (seeded directly,
// exactly the shape reserveProviderCall itself writes - same schema, same aggregation the card
// reads), the admin panel's Provider Usage card renders it correctly: right totals, right top-user
// ranking, right labels. That is the RENDERING half of the claim. The "real calls correctly
// increment ProviderUsage" half is already covered, far more thoroughly than this script could
// manage, by provider-quota-contract.mjs's own 43/43 suite including live-Mongo concurrency proof.
// Together the two cover everything except "spend real money calling the real external APIs",
// which this project's own rules already forbid an agent from doing.
//
// SAFETY, same pattern as drive-local-panel.mjs and verify-maintenance-drill-local.mjs:
// loopback-only, scratch database, outbound provider keys blanked, dropped on exit.
import { withBrowser } from "./browser-drive.mjs";

const SCRATCH_MARKER = "capro-provider-usage-card-local";
const MONGO_URI = `mongodb://127.0.0.1:27117/${SCRATCH_MARKER}`;
const SUPER_EMAIL = "saifullahfaizan786@gmail.com"; // assertSuper hardcodes this exact email
const SHOW = process.argv.includes("--show");

process.env.NODE_ENV = "development";
process.env.JWT_SECRET = "local-provider-usage-card-only-not-a-real-secret";
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
if (!MONGO_URI.includes(SCRATCH_MARKER)) {
  throw new Error("MONGODB_URI must name the scratch database - refusing to run");
}

const mongoose = (await import("mongoose")).default;
const jwt = (await import("jsonwebtoken")).default;
const { default: app } = await import("../src/app.js");
const { default: User } = await import("../src/models/User.js");
const { default: AppConfig } = await import("../src/models/AppConfig.js");
const { default: ProviderUsage, dailyPeriodKey, monthlyPeriodKey } = await import("../src/models/ProviderUsage.js");

let pass = 0, fail = 0;
const failures = [];
function check(id, ok, detail) {
  if (ok) { pass += 1; console.log(`  PASS ${id}  ${detail}`); }
  else { fail += 1; failures.push(id); console.log(`  FAIL ${id}  ${detail}`); }
}

const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://localhost:${server.address().port}`;
assertLoopback("API base", base);
const panelUrl = `${base}/admin/super.html`;
console.log("LOCAL provider-usage-card rendering drive (seeded data, no real provider calls)");
console.log(`  api   ${base}`);
console.log(`  mongo ${MONGO_URI}`);
console.log("");

async function cleanup() {
  try {
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.dropDatabase();
      console.log(`  scratch database ${SCRATCH_MARKER} dropped`);
    }
  } catch (error) {
    console.log(`  WARNING could not drop the scratch database: ${error.message}`);
  }
  try { await mongoose.disconnect(); } catch { /* already closed */ }
  await new Promise((resolve) => server.close(resolve));
}

try {
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  await mongoose.connection.dropDatabase();

  const superUser = await User.create({
    email: SUPER_EMAIL, name: "Local Drive Super Admin", role: "SUPER_ADMIN", accountType: "INDIVIDUAL",
  });
  const userA = await User.create({ email: "provider-usage-user-a@example.invalid", name: "Provider Usage User A", role: "USER", accountType: "INDIVIDUAL" });
  const userB = await User.create({ email: "provider-usage-user-b@example.invalid", name: "Provider Usage User B", role: "USER", accountType: "INDIVIDUAL" });
  await AppConfig.create({ _id: "singleton" });

  const today = dailyPeriodKey();
  const thisMonth = monthlyPeriodKey();
  // Seed directly at the schema level - the exact documents reserveProviderCall itself would have
  // written for real calls, not a shortcut around the schema.
  await ProviderUsage.create([
    { userId: userA._id, provider: "DEEPSEEK", periodKey: today, calls: 37 },
    { userId: userB._id, provider: "DEEPSEEK", periodKey: today, calls: 12 },
    { userId: userA._id, provider: "DEEPSEEK", periodKey: thisMonth, calls: 310 },
    { userId: userB._id, provider: "DEEPSEEK", periodKey: thisMonth, calls: 88 },
    { userId: userA._id, provider: "OCR_SPACE", periodKey: today, calls: 4 },
    { userId: userA._id, provider: "OCR_SPACE", periodKey: thisMonth, calls: 19 },
  ]);

  const superToken = jwt.sign(
    { id: String(superUser._id), email: superUser.email, role: superUser.role,
      accountType: superUser.accountType, firmId: null, isActive: true, tv: 0 },
    process.env.JWT_SECRET,
    { expiresIn: "1h" },
  );

  // --- API-level check first: confirm the aggregation itself reads back exactly what was seeded ---
  const apiResponse = await fetch(`${base}/api/super/provider-usage`, { headers: { Authorization: `Bearer ${superToken}` } });
  const apiBody = await apiResponse.json();
  check("api-status-200", apiResponse.status === 200, `GET /api/super/provider-usage -> ${apiResponse.status}`);
  check("api-deepseek-today-total", apiBody?.usage?.today?.DEEPSEEK === 49, `today.DEEPSEEK = ${apiBody?.usage?.today?.DEEPSEEK} (expected 37+12=49)`);
  check("api-deepseek-month-total", apiBody?.usage?.thisMonth?.DEEPSEEK === 398, `thisMonth.DEEPSEEK = ${apiBody?.usage?.thisMonth?.DEEPSEEK} (expected 310+88=398)`);
  check("api-ocr-today-total", apiBody?.usage?.today?.OCR_SPACE === 4, `today.OCR_SPACE = ${apiBody?.usage?.today?.OCR_SPACE} (expected 4)`);
  const topDeepseek = apiBody?.usage?.topUsersToday?.DEEPSEEK || [];
  check("api-top-user-ranking", topDeepseek[0]?.email === userA.email && topDeepseek[0]?.calls === 37, `top DeepSeek user today: ${topDeepseek[0]?.email} with ${topDeepseek[0]?.calls} calls (expected ${userA.email} with 37, ranked above userB's 12)`);

  // --- now drive the REAL admin panel in a real browser and read the rendered card ---
  // withBrowser's page API is a small custom CDP driver (browser-drive.mjs), not Puppeteer:
  // goto(url, {waitMs}) and evaluate(expressionString) -> value, matching drive-local-panel.mjs's
  // own usage exactly (localStorage is origin-scoped, so the origin must load before planting the
  // token - same two-goto shape that script already uses).
  await withBrowser(async (page) => {
    await page.goto(panelUrl, { waitMs: 1200 });
    await page.evaluate(`localStorage.setItem("caproadminjwt", ${JSON.stringify(superToken)}); true`);
    await page.goto(panelUrl, { waitMs: 3500 });

    const origin = await page.evaluate(`location.origin`);
    check("panel-is-local", origin === base, `the page under test is ${origin} (expected ${base})`);

    // Trigger whichever tab/section hosts the Provider Usage card, then give it a moment to fetch.
    await page.evaluate(`(() => {
      const candidates = Array.from(document.querySelectorAll("a, button, [role='tab']"));
      const target = candidates.find((el) => /provider usage/i.test(el.textContent || ""));
      if (target) { target.click(); return true; }
      return false;
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const rendered = await page.evaluate(`document.getElementById("providerUsageGrid")?.innerText || ""`);
    check("card-renders-at-all", rendered.length > 0, `providerUsageGrid text length = ${rendered.length}`);
    check("card-shows-deepseek-today-count", rendered.includes("49"), `card text includes "49" (today's DeepSeek total)`);
    check("card-shows-deepseek-month-count", rendered.includes("398"), `card text includes "398" (this month's DeepSeek total)`);
    check("card-shows-top-user-email", rendered.includes(userA.email), `card text includes top user's email "${userA.email}"`);
    check("card-shows-provider-label", /DeepSeek/i.test(rendered) && /OCR\.space/i.test(rendered), `card text names both provider labels`);
    if (!rendered.length) {
      console.log("  --- full page text for debugging ---");
      console.log(await page.evaluate(`document.body.innerText.slice(0, 2000)`));
    }
  }, { headless: !SHOW });

  console.log("");
  console.log(`passed: ${pass}  failed: ${fail}`);
  if (fail > 0) console.log(`failing: ${failures.join(", ")}`);
  console.log(fail === 0 ? "LOCAL PROVIDER-USAGE CARD DRIVE OK (seeded data, not real provider calls)" : "LOCAL PROVIDER-USAGE CARD DRIVE FAILED");
  await cleanup();
  process.exit(fail === 0 ? 0 : 1);
} catch (error) {
  console.error("FATAL", error);
  await cleanup();
  process.exit(1);
}
