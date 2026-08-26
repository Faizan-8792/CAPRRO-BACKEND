// tests/admin-feature-flag-save-safety.mjs
//
// The admin panel must never write feature-flag values it did not load.
//
// WHY THIS EXISTS -- an incident, not a hypothetical. 2026-08-26, against production.
//
// The Feature flags card diffs the checkboxes against `lastFeatureFlags`, the map it captured on
// load, and sends only what changed. The guard on that diff was:
//
//     if (!lastFeatureFlags || lastFeatureFlags[key] !== box.checked) { changed[key] = ...; }
//
// `lastFeatureFlags` starts as null. `loadAppConfigSection()` returns early on `!r.ok` and swallows
// any throw into a console.warn, so a failed load leaves it null AND leaves all nineteen checkboxes
// at their unchecked HTML default. The operator sees a panel that reads "every feature is off",
// flips one flag, and presses Save -- at which point `!lastFeatureFlags` is true for EVERY key, the
// diff sends all nineteen with eighteen of them false, and the backend applies them.
//
// Twelve live features were switched off in production that way: gstReconciliation, tdsHealth,
// noticeCases, auditWorkingPapers, assuranceEngagements, clientComplianceProfile, dailyDigest,
// weeklySummary, filingDashboard, teamWorkload, homeWorkspace and fullTabWorkspace.
//
// The backend was never at fault. updateFeatureFlags builds `featureFlags.<key>` dot-paths only for
// keys present in the body, which is a real partial merge. The panel sent eighteen keys it had
// never read.
//
// These are source assertions rather than a live PATCH on purpose: the failure is a client-side
// decision about what to send, and reproducing it for real would mean writing bad flags to a
// database to prove the panel would write bad flags.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const PANEL = join(here, "..", "public", "admin", "super.js");
const CONTROLLER = join(here, "..", "src", "controllers", "appconfig.controller.js");

const panel = readFileSync(PANEL, "utf8");
const controller = readFileSync(CONTROLLER, "utf8");

const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass, detail });

// ─── The exact defect ─────────────────────────────────────────────

check(
  "the save diff never treats an unloaded state as a licence to send every key",
  !/if\s*\(\s*!lastFeatureFlags\s*\|\|/.test(panel),
  "`!lastFeatureFlags ||` inside the diff makes every key differ, which sends all nineteen",
);

check(
  "saving is refused outright while lastFeatureFlags is null",
  /if\s*\(\s*!lastFeatureFlags\s*\)\s*\{[\s\S]{0,600}?return;/.test(panel),
  "an early return before the diff is what makes 'state unknown' mean stop rather than guess",
);

// ─── The conditions that produced it ──────────────────────────────

check(
  "a config response carrying no flags is treated as a load failure, not as all-off",
  /Object\.keys\(c\.featureFlags\)\.length === 0/.test(panel),
  "an unauthenticated or expired-session GET returns the config with no flags at all",
);

check(
  "a failed load is reported on the card instead of only to the console",
  /function reportFeatureFlagLoadFailure/.test(panel)
    && /catch \(err\)[\s\S]{0,200}reportFeatureFlagLoadFailure/.test(panel),
  "silence is half the defect: 'all off' and 'nothing loaded' look identical in a grid of boxes",
);

check(
  "a failed load disables the checkboxes so they cannot be saved over real state",
  /reportFeatureFlagLoadFailure[\s\S]{0,500}box\.disabled = true/.test(panel),
);

check(
  "a successful load re-enables them",
  /box\.checked = flags\[key\] === true;[\s\S]{0,120}box\.disabled = false/.test(panel),
  "otherwise one transient failure disables the card until a reload, which invites a workaround",
);

// ─── The backend contract the panel relies on ─────────────────────

check(
  "the backend still merges per key rather than replacing the map",
  /update\[`featureFlags\.\$\{key\}`\]/.test(controller),
  "dot-path $set is what leaves unlisted keys untouched; a whole-object $set would reintroduce this",
);

check(
  "the backend only writes keys the request actually carried",
  /hasOwnProperty\.call\(featureFlags, key\)/.test(controller),
);

check(
  "unknown flag names are rejected rather than silently stored",
  /Unknown feature flags/.test(controller),
);

// ─── Report ───────────────────────────────────────────────────────

let passed = 0;
for (const entry of checks) {
  const mark = entry.pass ? "PASS" : "FAIL";
  if (entry.pass) passed += 1;
  console.log(`[${mark}] ${entry.name}${entry.detail ? ` — ${entry.detail}` : ""}`);
}

const total = checks.length;
console.log(`\nAdmin feature-flag save safety: ${passed}/${total}`);

if (passed !== total) {
  console.error(`\n${total - passed} check(s) failed.`);
  process.exit(1);
}
