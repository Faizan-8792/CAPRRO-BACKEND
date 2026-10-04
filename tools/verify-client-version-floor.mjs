// tools/verify-client-version-floor.mjs
//
// O11's regression bullet against the REAL app, on a LOCAL backend and a scratch database: with a
// minimum supported desktop version of 1.0.0 set, a signed-in request that carries NO
// X-CaPro-Client-Version header must still be answered (the installed base sends none), while one
// that says 0.0.9 is refused 426 and one that says 1.0.0 passes. If the headerless request were
// refused, the fail-open rule would be broken and every installed desktop and the extension would be
// locked out the moment a floor was set.
//
// Same safety shape as tools/drive-local-panel.mjs: the database and the API must both be loopback,
// the database name must carry the scratch marker, outbound provider keys are blanked in this
// process, and the scratch database is dropped in a finally. Nothing here touches production.
//
//   node tools/verify-client-version-floor.mjs

const SCRATCH_MARKER = "scratch-client-version-floor";
const MONGO_URI = `mongodb://127.0.0.1:27117/${SCRATCH_MARKER}`;
const FLOOR = "1.0.0";
// A firm read mounted AFTER the gate (app.js), so the gate is really in its path; /api/auth/* is on the
// gate's allow-list by design and would prove nothing about the floor.
const PROBE_PATH = "/api/gst-downloads/settings";

process.env.NODE_ENV = "development";
process.env.JWT_SECRET = "client-version-floor-check-only-not-a-real-secret";
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
if (!MONGO_URI.includes("scratch")) throw new Error("MONGODB_URI must name a scratch database - refusing to run");

const mongoose = (await import("mongoose")).default;
const jwt = (await import("jsonwebtoken")).default;
const { default: app } = await import("../src/app.js");
const { default: User } = await import("../src/models/User.js");
const { default: AppConfig } = await import("../src/models/AppConfig.js");
const { default: Firm } = await import("../src/models/Firm.js");
const { default: FirmMembership } = await import("../src/models/FirmMembership.js");

let pass = 0;
let fail = 0;
function check(id, ok, detail) {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"} ${id}  ${detail}`);
}

const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://localhost:${server.address().port}`;
assertLoopback("API base", base);
console.log(`client-version floor check against ${base}${PROBE_PATH} (scratch database ${SCRATCH_MARKER})`);

try {
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  await mongoose.connection.dropDatabase();
  const user = await User.create({ email: "floor-check@example.invalid", name: "Floor check", role: "USER", accountType: "INDIVIDUAL" });
  const firm = await Firm.create({ displayName: "Scratch floor firm", handle: `scratch-floor-${user._id}`, ownerUserId: user._id, joinCode: `F${String(user._id).slice(-5)}`, isActive: true });
  await FirmMembership.create({ firmId: firm._id, userId: user._id, role: "OWNER", status: "ACTIVE" });
  user.firmId = firm._id;
  await user.save();
  // Set before the first request: AppConfig.getInstance caches for 30 s.
  await AppConfig.create({ _id: "singleton", desktopRelease: { minSupportedVersion: FLOOR } });
  const token = jwt.sign(
    { id: String(user._id), email: user.email, role: user.role, accountType: user.accountType, firmId: String(firm._id), isActive: true, tv: 0 },
    process.env.JWT_SECRET,
    { expiresIn: "10m" },
  );

  async function me(version, path = PROBE_PATH) {
    const headers = { Authorization: `Bearer ${token}` };
    if (version !== undefined) headers["X-CaPro-Client-Version"] = version;
    const response = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(15000) });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body };
  }

  const stored = await AppConfig.findById("singleton").lean();
  check("floor-set", stored?.desktopRelease?.minSupportedVersion === FLOOR, `the stored minimum supported version is ${stored?.desktopRelease?.minSupportedVersion}`);

  const none = await me(undefined);
  check("no-header-is-answered", none.status === 200, `signed in, no X-CaPro-Client-Version, floor ${FLOOR} -> ${none.status} (the installed base sends no header)`);
  const old = await me("0.0.9");
  check("below-floor-is-refused", old.status === 426 && old.body?.code === "CLIENT_UPDATE_REQUIRED", `X-CaPro-Client-Version 0.0.9 -> ${old.status} ${old.body?.code ?? ""}`);
  const equal = await me(FLOOR);
  check("at-floor-is-answered", equal.status === 200, `X-CaPro-Client-Version ${FLOOR} -> ${equal.status} (the floor is inclusive)`);
  const authBelow = await me("0.0.9", "/api/auth/me");
  check("auth-stays-open", authBelow.status === 200, `X-CaPro-Client-Version 0.0.9 on /api/auth/me -> ${authBelow.status} (sign-in is on the gate's allow-list, so an old client is never locked out before it is told)`);
} catch (error) {
  fail += 1;
  console.log(`  ERROR ${error.message}`);
} finally {
  try {
    if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
  } catch {
    /* already gone */
  }
  try {
    await mongoose.disconnect();
  } catch {
    /* already closed */
  }
  await new Promise((resolve) => server.close(resolve));
}

console.log(`=== client-version floor: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
