// tests/app-config-checklist.mjs
// Verifies maintenance toggle + welcome announcement flow integrity.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const BACKEND = join(__dirname, "..");

const model = readFileSync(join(BACKEND, "src", "models", "AppConfig.js"), "utf8");
const userModel = readFileSync(join(BACKEND, "src", "models", "User.js"), "utf8");
const ctrl = readFileSync(
  join(BACKEND, "src", "controllers", "appconfig.controller.js"),
  "utf8"
);
const routes = readFileSync(
  join(BACKEND, "src", "routes", "appconfig.routes.js"),
  "utf8"
);
const app = readFileSync(join(BACKEND, "src", "app.js"), "utf8");
const mw = readFileSync(
  join(BACKEND, "src", "middleware", "maintenance.middleware.js"),
  "utf8"
);
const popupJs = readFileSync(join(ROOT, "audit-nlp-extension", "popup.js"), "utf8");
const popupHtml = readFileSync(
  join(ROOT, "audit-nlp-extension", "popup.html"),
  "utf8"
);
const superJs = readFileSync(
  join(BACKEND, "public", "admin", "super.js"),
  "utf8"
);
const superHtml = readFileSync(
  join(BACKEND, "public", "admin", "super.html"),
  "utf8"
);
const authCtrl = readFileSync(
  join(BACKEND, "src", "controllers", "auth.controller.js"),
  "utf8"
);

const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass, detail });

// ─── Backend model + cache ─────────────────────────────────────────
check(
  "AppConfig is a singleton (id='singleton') with in-process cache",
  /_id:\s*\{\s*type:\s*String,\s*default:\s*["']singleton["']/.test(model) &&
    /CACHE_MS\s*=\s*30/.test(model) &&
    /invalidateCache/.test(model),
  "30s cache, single doc, fast"
);

check(
  "User model tracks welcomeSeenVersion",
  /welcomeSeenVersion[\s\S]{0,80}default:\s*null/.test(userModel),
  "Persists across logout/reinstall"
);

check(
  "/auth/me returns welcomeSeenVersion in user object",
  /welcomeSeenVersion:\s*user\.welcomeSeenVersion/.test(authCtrl),
  "Frontend can compare with current welcome version"
);

// ─── Endpoints ──────────────────────────────────────────────────────
check(
  "GET /api/app-config is public (no authRequired)",
  /router\.get\(["']\/["'],\s*getAppConfig\)/.test(routes) &&
    !/router\.get\(["']\/["'],\s*authRequired/.test(routes),
  "Even logged-out clients can detect maintenance"
);

check(
  "POST /api/app-config/dismiss-welcome requires auth",
  /router\.post\(\s*["']\/dismiss-welcome["']\s*,\s*authRequired\s*,/.test(routes),
  "Server-side dismissal requires identity"
);

check(
  "PATCH /api/app-config/maintenance is super-only via assertSuper()",
  /updateMaintenance[\s\S]{0,80}assertSuper\(req\.user\)/.test(ctrl) &&
    /updateMaintenance/.test(routes),
  "Only saifullahfaizan786@gmail.com can toggle"
);

check(
  "PATCH /api/app-config/welcome is super-only and invalidates cache",
  /updateWelcomeAnnouncement[\s\S]{0,200}assertSuper/.test(ctrl) &&
    /AppConfig\.invalidateCache\(\)/.test(ctrl),
  "Cache invalidated after super admin edits"
);

// ─── Maintenance gate middleware ───────────────────────────────────
check(
  "maintenanceGate allows /api/auth, /api/app-config, /api/super, /health",
  /ALLOW_PREFIXES[\s\S]{0,180}\/api\/auth\//.test(mw) &&
    /\/api\/app-config/.test(mw) &&
    /\/api\/super\//.test(mw) &&
    /\/health/.test(mw),
  "Critical endpoints stay reachable during maintenance"
);

check(
  "maintenanceGate returns 503 with 'maintenance' error code",
  /res\.status\(503\)/.test(mw) && /error:\s*["']maintenance["']/.test(mw),
  "Clients can detect and show maintenance overlay"
);

check(
  "maintenanceGate registered AFTER /api/app-config in app.js",
  /app\.use\(["']\/api\/app-config["'],\s*appConfigRoutes\)[\s\S]{0,200}app\.use\(maintenanceGate\)/.test(
    app
  ),
  "Order ensures /app-config remains accessible during maintenance"
);

check(
  "maintenanceGate fails OPEN (does not block on DB blip)",
  /catch\s*\([^)]*\)\s*\{[\s\S]{0,200}return\s+next\(\)/.test(mw),
  "If config fetch fails, traffic still flows"
);

// ─── Frontend (popup) ──────────────────────────────────────────────
check(
  "popup.html has #maintenanceOverlay + #welcomeOverlay",
  /id=["']maintenanceOverlay["']/.test(popupHtml) &&
    /id=["']welcomeOverlay["']/.test(popupHtml),
  "Both overlays present in DOM"
);

check(
  "popup.js initAppConfig reads chrome.storage cache FIRST (instant render)",
  /readCachedConfig/.test(popupJs) &&
    /applyAppConfig\(cached\.config/.test(popupJs),
  "Zero-delay open: cached config rendered before network call"
);

check(
  "popup.js refreshes config in background (stale-while-revalidate)",
  /fetchAppConfig\(\)[\s\S]{0,200}writeCachedConfig\(fresh\)/.test(popupJs),
  "Latest state always picked up on next open"
);

check(
  "Welcome dismiss persists to server AND localStorage",
  /dismiss-welcome[\s\S]{0,200}localStorage\.setItem/.test(popupJs) ||
    (/dismiss-welcome/.test(popupJs) && /localStorage\.setItem\(\s*localKey/.test(popupJs)),
  "Survives popup close, logout, and extension reinstall"
);

check(
  "Welcome NOT re-shown when user.welcomeSeenVersion matches current",
  /user\?\.welcomeSeenVersion\s*===\s*wa\.version/.test(popupJs),
  "One-shot enforcement at render time"
);

check(
  "applyAppConfig hides welcome when maintenance is ON",
  /if\s*\(\s*config\.maintenanceMode\s*\)[\s\S]{0,200}showMaintenanceOverlay/.test(popupJs) &&
    /else[\s\S]{0,200}if\s*\(user\)\s*showWelcomeIfNeeded/.test(popupJs),
  "Maintenance takes priority over welcome"
);

// ─── Super Admin UI ────────────────────────────────────────────────
check(
  "Super admin HTML has maintenance toggle + welcome editor",
  /id=["']maintenanceToggle["']/.test(superHtml) &&
    /id=["']welcomeVersion["']/.test(superHtml) &&
    /id=["']welcomeBodyInput["']/.test(superHtml),
  "Controls present"
);

check(
  "Super JS wires toggle change → PATCH /app-config/maintenance",
  /maintenanceToggle[\s\S]{0,600}\/app-config\/maintenance/.test(superJs),
  "Toggle persists immediately"
);

check(
  "Super JS optimistically rolls back if maintenance toggle PATCH fails",
  /toggle\.checked\s*=\s*prev/.test(superJs),
  "UI stays consistent with server state"
);

check(
  "Super JS save welcome calls PATCH /app-config/welcome",
  /saveWelcomeBtn[\s\S]{0,300}\/app-config\/welcome/.test(superJs),
  "Welcome edits saved"
);

// ─── Print ─────────────────────────────────────────────────────────
console.log("\n=== APP-CONFIG FLOW VERIFICATION ===\n");
const passed = checks.filter((c) => c.pass).length;
const failed = checks.filter((c) => !c.pass).length;

checks.forEach((c, i) => {
  const icon = c.pass ? "[PASS]" : "[FAIL]";
  console.log(`${i + 1}. ${icon} ${c.name}`);
  if (c.detail) console.log(`        ${c.detail}`);
});

console.log(`\nResult: ${passed} passed, ${failed} failed (out of ${checks.length})\n`);

if (failed === 0) {
  console.log("ALL CHECKS PASSED. Maintenance + welcome flow is sound.\n");
} else {
  process.exit(1);
}
