// tests/control-change-reason.mjs
//
// DS24: a platform-wide switch (maintenance mode, a feature flag) records who moved it, what was
// set and the reason given, and the super panel reads that history back. Rule 25 of the design
// record: "a flag change needs a reason, a confirmation and an audit entry". A reason the panel
// asks for and nothing keeps would be a form that pretends, so this pins the keeping:
//
//   - the reason is optional on the wire (scripts call these routes), text only, trimmed and capped;
//   - a refused request (a reason that is not text, an unknown flag) writes nothing at all;
//   - the entry is pushed in the same update as the change, newest kept, CONTROL_CHANGE_LIMIT at most;
//   - only the super admin reads the history, and the public /api/app-config never carries it.
//
// The source checks always run. The database checks run when MONGODB_URI names a scratch database
// (tools/run-gates.ps1 sets one); without it they are reported as not run, never as passed.
//
// USAGE
//   node tests/control-change-reason.mjs
//   MONGODB_URI=mongodb://127.0.0.1:27117/scratch-control-change node tests/control-change-reason.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const BACKEND = join(here, "..");
const read = (...parts) => readFileSync(join(BACKEND, ...parts), "utf8");

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? ` - ${detail}` : ""}`);
}

// ---- Source: the shape the panel and the route depend on -----------------------------------
const model = read("src", "models", "AppConfig.js");
const controller = read("src", "controllers", "appconfig.controller.js");
const routes = read("src", "routes", "appconfig.routes.js");

check("the model keeps a capped history of control changes",
  /export const CONTROL_CHANGE_LIMIT = 50;/.test(model) && /controlChanges:\s*\{\s*type:\s*\[ControlChangeSchema\]/.test(model));
check("an entry names its kind from a closed list", /kind:\s*\{\s*type:\s*String,\s*enum:\s*CONTROL_CHANGE_KINDS/.test(model));
check("the history route is super-only and throttled like its siblings",
  /router\.get\("\/control-changes", authRequired, superLimiter, getControlChanges\);/.test(routes)
    && /export const getControlChanges = async[\s\S]{0,120}assertSuper\(req\.user\);/.test(controller));
const publicBlock = (/export const getAppConfig = async[\s\S]*?\n};/.exec(controller) || [""])[0];
check("the public config names its keys and not the history",
  publicBlock.length > 0 && /config:\s*\{/.test(publicBlock) && !/controlChanges|reason|byEmail/.test(publicBlock));
check("both switches read the reason before they write",
  (controller.match(/const reasonRead = readControlReason\(req\.body\);/g) || []).length === 2);
check("both switches push their entry in the same update as the change",
  /\$push: controlChangePush\(req, "featureFlags"/.test(controller) && /\$push: controlChangePush\(req, "maintenance"/.test(controller));

// ---- Database: the behaviour -----------------------------------------------------------------
const uri = process.env.MONGODB_URI || "";
const dbName = uri.split("/").pop()?.split("?")[0] || "";
const loopback = /^mongodb:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(uri);

if (!uri) {
  console.log("[NOT RUN] the database checks - no MONGODB_URI (tools/run-gates.ps1 provides a scratch one)");
} else if (!/scratch/i.test(dbName) || !loopback) {
  console.log(`[FAIL] refusing to touch ${dbName || "(no name)"}: the database must be loopback and scratch-named`);
  failed += 1;
} else {
  process.env.NODE_ENV = process.env.NODE_ENV || "development";
  process.env.JWT_SECRET = process.env.JWT_SECRET || "control-change-reason-only";
  const mongoose = (await import("mongoose")).default;
  const { default: AppConfig, CONTROL_CHANGE_LIMIT, CONTROL_REASON_MAX } = await import("../src/models/AppConfig.js");
  const { updateMaintenance, updateFeatureFlags, getControlChanges, getAppConfig } = await import(
    "../src/controllers/appconfig.controller.js"
  );

  const SUPER = { id: new mongoose.Types.ObjectId().toString(), role: "SUPER_ADMIN", email: "saifullahfaizan786@gmail.com" };
  const FIRM_ADMIN = { id: new mongoose.Types.ObjectId().toString(), role: "FIRM_ADMIN", email: "meera@example.com" };

  async function call(handler, { user = SUPER, body = {} } = {}) {
    const res = { statusCode: 200, body: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (payload) => { res.body = payload; return res; };
    let thrown = null;
    await handler({ user, body, params: {}, query: {} }, res, (err) => { thrown = err; });
    if (thrown) { res.statusCode = thrown.statusCode || 500; res.body = { ok: false, error: thrown.message }; }
    return res;
  }
  const stored = async () => (await AppConfig.findById("singleton").lean())?.controlChanges || [];

  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
    await mongoose.connection.dropDatabase();
    await AppConfig.create({ _id: "singleton" });
    AppConfig.invalidateCache();

    const on = await call(updateMaintenance, { body: { maintenanceMode: true, reason: "  Database upgrade, about ten minutes  " } });
    let log = await stored();
    check("turning maintenance on is recorded with the reason, trimmed",
      on.statusCode === 200 && log.length === 1 && log[0].kind === "maintenance" && log[0].summary === "Set maintenance mode on"
        && log[0].reason === "Database upgrade, about ten minutes" && log[0].byEmail === SUPER.email,
      JSON.stringify(log[0] || null));

    const flags = await call(updateFeatureFlags, { body: { featureFlags: { tdsHealth: true, dailyDigest: false }, reason: "TDS health is ready for firms" } });
    log = await stored();
    check("a flag change is recorded with every flag it set, in the server's order",
      flags.statusCode === 200 && log.length === 2 && log[1].kind === "featureFlags" && log[1].summary === "Set tdsHealth on, dailyDigest off",
      JSON.stringify(log[1] || null));

    const silent = await call(updateMaintenance, { body: { maintenanceMessage: "Back by 6 pm" } });
    log = await stored();
    check("a change sent without a reason is still recorded, with the reason empty",
      silent.statusCode === 200 && log.length === 3 && log[2].summary === "Changed the maintenance message" && log[2].reason === "");

    const long = await call(updateMaintenance, { body: { maintenanceMode: false, reason: "x".repeat(CONTROL_REASON_MAX + 40) } });
    log = await stored();
    check(`a reason is capped at ${CONTROL_REASON_MAX} characters`, long.statusCode === 200 && log[3]?.reason.length === CONTROL_REASON_MAX);

    const before = JSON.stringify(await AppConfig.findById("singleton").lean());
    const notText = await call(updateFeatureFlags, { body: { featureFlags: { tdsHealth: false }, reason: 42 } });
    const unknown = await call(updateFeatureFlags, { body: { featureFlags: { notAFlag: true }, reason: "typo" } });
    const notTextMaint = await call(updateMaintenance, { body: { maintenanceMode: true, reason: { text: "x" } } });
    const after = JSON.stringify(await AppConfig.findById("singleton").lean());
    check("a refused request writes nothing - not the change, not an entry",
      notText.statusCode === 400 && unknown.statusCode === 400 && notTextMaint.statusCode === 400 && before === after,
      `${notText.statusCode}/${unknown.statusCode}/${notTextMaint.statusCode}; document ${before === after ? "unchanged" : "CHANGED"}`);

    const forbidden = await call(updateFeatureFlags, { user: FIRM_ADMIN, body: { featureFlags: { tdsHealth: false }, reason: "not mine to change" } });
    check("a firm admin can neither change a flag nor leave an entry",
      forbidden.statusCode === 403 && (await stored()).length === 4);

    for (let i = 0; i < CONTROL_CHANGE_LIMIT + 5; i += 1) {
      await call(updateFeatureFlags, { body: { featureFlags: { teamWorkload: i % 2 === 0 }, reason: `round ${i}` } });
    }
    log = await stored();
    check(`the history keeps the newest ${CONTROL_CHANGE_LIMIT}`,
      log.length === CONTROL_CHANGE_LIMIT && log[log.length - 1].reason === `round ${CONTROL_CHANGE_LIMIT + 4}`,
      `${log.length} kept, newest ${JSON.stringify(log[log.length - 1]?.reason)}`);

    const history = await call(getControlChanges);
    check("the super admin reads it newest first",
      history.statusCode === 200 && history.body.changes.length === CONTROL_CHANGE_LIMIT
        && history.body.changes[0].reason === `round ${CONTROL_CHANGE_LIMIT + 4}` && history.body.limit === CONTROL_CHANGE_LIMIT
        && !("byUserId" in history.body.changes[0]));
    const firmAdminRead = await call(getControlChanges, { user: FIRM_ADMIN });
    check("anyone else is refused the history", firmAdminRead.statusCode === 403);

    AppConfig.invalidateCache();
    const publicRead = await call(getAppConfig, { user: null });
    const publicText = JSON.stringify(publicRead.body);
    check("the public config never carries the history",
      publicRead.statusCode === 200 && !/controlChanges|round \d|byEmail/.test(publicText));
  } catch (error) {
    check("the database checks ran to the end", false, error.message);
  } finally {
    try { if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase(); } catch { /* best effort */ }
    try { await mongoose.disconnect(); } catch { /* already closed */ }
  }
}

console.log(`\ncontrol change reason: ${passed}/${passed + failed} passed`);
process.exitCode = failed ? 1 : 0;
