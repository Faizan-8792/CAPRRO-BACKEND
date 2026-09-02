// tools/apply-plan-flag-decisions.mjs
//
// Applies exactly the three feature-flag decisions recorded in .kiro/PLAN.md
// (T4/T5/T6) against the live production AppConfig -- nothing else. This is
// deliberately NOT a generic "flip any flag" tool: complianceGenerationLive is
// hardcoded as a flag this script will never touch, because turning it on is a
// business decision (the app starts acting on real clients) the owner has
// explicitly not made, not an engineering gap this batch of work closes.
//
//   CAPRO_SUPER_ADMIN_JWT=<token> node tools/apply-plan-flag-decisions.mjs --dry-run
//   CAPRO_SUPER_ADMIN_JWT=<token> node tools/apply-plan-flag-decisions.mjs --only T4
//   CAPRO_SUPER_ADMIN_JWT=<token> node tools/apply-plan-flag-decisions.mjs --only T4,T5,T6 --t1-t3-verified
//
// --only: comma-separated subset of T4,T5,T6 to apply (default: T4 alone --
//   T5/T6 are refused unless --t1-t3-verified is also passed, see below).
// --t1-t3-verified: required to apply T5 (reliableReminderDelivery) or T6
//   (complianceGenerationShadow). This script CAN and DOES independently probe
//   that T1's monitoring endpoint is live and responding (a real check, not
//   trust), but it has no way to confirm T2 (the admin panel actually renders
//   it) or T3 (the alert email actually fires and rate-limits) -- those need a
//   human or agent to have actually looked. Passing this flag is your
//   attestation that they have. The script refuses to guess.
// --dry-run: print exactly what would change, make no network write.

const BASE = process.env.CAPRO_API_BASE || "https://api.caprotoolkit.in";
const TOKEN = process.env.CAPRO_SUPER_ADMIN_JWT;

const NEVER_TOUCH = new Set(["complianceGenerationLive"]);

const PLAN = {
  T4: {
    flag: "fullReminderOffsets",
    value: true,
    requiresVerification: false,
    why: "Already built and tested; safe independently of reliableReminderDelivery. No prerequisite.",
  },
  T5: {
    flag: "reliableReminderDelivery",
    value: true,
    requiresVerification: true,
    why: "Retry logic already exists; was withheld only because a failed delivery was previously invisible. T1-T3 close that gap.",
  },
  T6: {
    flag: "complianceGenerationShadow",
    value: true,
    requiresVerification: true,
    why: "Dry-run only -- writes nothing, sends nothing. complianceGenerationLive stays off regardless; that is a separate, not-yet-made owner decision.",
  },
};

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return null;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : true;
}

const dryRun = process.argv.includes("--dry-run");
const t1t3Verified = process.argv.includes("--t1-t3-verified");
const only = (arg("only") || "T4").split(",").map((s) => s.trim());

if (!TOKEN) {
  console.error("CAPRO_SUPER_ADMIN_JWT is not set. Set it for this one command; it is never stored.");
  process.exit(2);
}

for (const key of only) {
  if (!PLAN[key]) {
    console.error(`Unknown task '${key}'. Valid: ${Object.keys(PLAN).join(", ")}.`);
    process.exit(2);
  }
}

const toApply = only.map((key) => ({ key, ...PLAN[key] }));

console.log("=== plan-flag-decisions: what this run will do ===");
for (const t of toApply) {
  const skip = t.requiresVerification && !t1t3Verified;
  console.log(
    `  ${t.key}: ${t.flag} -> ${t.value}${skip ? "  [SKIPPED -- needs --t1-t3-verified]" : ""}`
  );
  console.log(`       ${t.why}`);
}
if (dryRun) {
  console.log("\n--dry-run: stopping before any network call.");
  process.exit(0);
}

const authed = {
  Authorization: `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
};

function fail(step, detail) {
  console.error(`\nFAILED at ${step}: ${detail}`);
  process.exit(1);
}

async function getConfig() {
  const res = await fetch(`${BASE}/api/app-config`);
  if (!res.ok) fail("getConfig", `HTTP ${res.status}`);
  return res.json();
}

console.log("\n=== 1. current production feature-flag state ===");
const before = await getConfig();
console.log(JSON.stringify(before.config.featureFlags, null, 2));

const applicable = toApply.filter((t) => !t.requiresVerification || t1t3Verified);
const skipped = toApply.filter((t) => t.requiresVerification && !t1t3Verified);
if (skipped.length) {
  console.log(
    `\nSkipping (needs --t1-t3-verified, an explicit attestation T2/T3 were actually checked): ${skipped
      .map((t) => t.key)
      .join(", ")}`
  );
}

if (applicable.length && applicable.some((t) => t.requiresVerification)) {
  console.log("\n=== 2. independently probing T1's monitoring endpoint before trusting the attestation ===");
  const probe = await fetch(`${BASE}/api/super/reminder-delivery-health`, { headers: authed });
  if (!probe.ok) {
    fail(
      "probeT1",
      `T1's endpoint returned HTTP ${probe.status} -- refusing to turn on reliableReminderDelivery/complianceGenerationShadow with no working monitoring behind them.`
    );
  }
  const probeBody = await probe.json();
  if (!probeBody?.ok || typeof probeBody?.delivery?.issueCount !== "number") {
    fail("probeT1", `T1's endpoint responded but with an unexpected shape: ${JSON.stringify(probeBody).slice(0, 300)}`);
  }
  console.log(`  T1 live and responding. Current fleet-wide issueCount: ${probeBody.delivery.issueCount}`);
}

if (!applicable.length) {
  console.log("\nNothing to apply. Exiting.");
  process.exit(0);
}

console.log("\n=== 3. applying ===");
const featureFlags = {};
for (const t of applicable) {
  if (NEVER_TOUCH.has(t.flag)) fail("safety", `${t.flag} is hardcoded as never-touch. This should be unreachable.`);
  featureFlags[t.flag] = t.value;
}

const patchRes = await fetch(`${BASE}/api/app-config/features`, {
  method: "PATCH",
  headers: authed,
  body: JSON.stringify({ featureFlags }),
});
if (!patchRes.ok) {
  fail("patch", `HTTP ${patchRes.status} ${(await patchRes.text()).slice(0, 300)}`);
}
console.log(`  PATCH accepted: ${JSON.stringify(featureFlags)}`);

console.log("\n=== 4. reading back to confirm the write actually landed ===");
const after = await getConfig();
let allMatch = true;
for (const t of applicable) {
  const got = after.config.featureFlags[t.flag];
  const ok = got === t.value;
  allMatch = allMatch && ok;
  console.log(`  ${t.flag}: expected ${t.value}, got ${got} -- ${ok ? "PASS" : "FAIL"}`);
}
if (NEVER_TOUCH.has("complianceGenerationLive")) {
  const stillOff = after.config.featureFlags.complianceGenerationLive === false;
  console.log(`  complianceGenerationLive still false (never touched): ${stillOff ? "PASS" : "FAIL -- INVESTIGATE IMMEDIATELY"}`);
  allMatch = allMatch && stillOff;
}

console.log(`\n=== ${allMatch ? "ALL CONFIRMED" : "MISMATCH -- DO NOT REPORT SUCCESS"} ===`);
process.exit(allMatch ? 0 : 1);
