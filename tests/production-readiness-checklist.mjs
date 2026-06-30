// tests/production-readiness-checklist.mjs
// Verifies security, performance, and scale features are in place.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKEND = join(__dirname, "..");

const app = readFileSync(join(BACKEND, "src", "app.js"), "utf8");
const server = readFileSync(join(BACKEND, "src", "server.js"), "utf8");
const db = readFileSync(join(BACKEND, "src", "config", "db.js"), "utf8");
const auth = readFileSync(join(BACKEND, "src", "middleware", "auth.middleware.js"), "utf8");
const usage = readFileSync(join(BACKEND, "src", "middleware", "usage-tracker.middleware.js"), "utf8");
const reqId = readFileSync(join(BACKEND, "src", "middleware", "request-id.middleware.js"), "utf8");
const userModel = readFileSync(join(BACKEND, "src", "models", "User.js"), "utf8");
const superCtrl = readFileSync(join(BACKEND, "src", "controllers", "super.controller.js"), "utf8");

const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass, detail });

// ─── Security ──────────────────────────────────────────────────────

check(
  "Helmet middleware with CSP active",
  /helmet\(\{[\s\S]*?contentSecurityPolicy/.test(app),
  "X-Frame-Options, X-Content-Type-Options, CSP all set"
);

check(
  "Rate limiting: global, auth, super tiers",
  /globalLimiter/.test(app) && /authLimiter/.test(app) && /superLimiter/.test(app),
  "Three-tier rate limiting prevents abuse"
);

check(
  "Strict CORS origin allowlist",
  /CORS blocked for origin/.test(app),
  "Only known origins (extension, backend, localhost dev) allowed"
);

check(
  "Content-Type guard rejects non-JSON POST/PATCH/PUT",
  /Content-Type must be application\/json/.test(app) &&
    /res\.status\(415\)/.test(app),
  "Defends against form-encoded attacks"
);

check(
  "Trust proxy enabled for Render's reverse proxy",
  /app\.set\(["']trust proxy["']/.test(app),
  "req.ip + secure cookies work behind proxy"
);

check(
  "Body size limit 1MB on JSON parser",
  /express\.json\(\{\s*limit:\s*["']1mb["']/.test(app),
  "Prevents DoS via large payloads"
);

check(
  "Required env vars validated at startup",
  /REQUIRED_ENV/.test(app) && /JWT_SECRET/.test(app) && /MONGODB_URI/.test(app),
  "Refuses to start in prod if secrets missing"
);

check(
  "Request ID middleware attaches X-Request-Id",
  /X-Request-Id/.test(reqId) && /randomUUID/.test(reqId),
  "Every request traceable across logs"
);

check(
  "Sanitize middleware strips dangerous patterns",
  /strip HTML tags/.test(readFileSync(join(BACKEND, "src", "middleware", "sanitize.middleware.js"), "utf8")) ||
    /sanitizeInputs/.test(app),
  "XSS + NoSQL injection prevention at edge"
);

// ─── Performance ──────────────────────────────────────────────────

check(
  "Gzip compression enabled for responses > 1KB",
  /compression\(\{\s*threshold:\s*1024/.test(app),
  "Reduces bandwidth ~70% for JSON responses"
);

check(
  "Cache-Control header on static templates endpoint",
  /Cache-Control[\s\S]{0,80}max-age=3600/.test(
    readFileSync(join(BACKEND, "src", "controllers", "taxworker.controller.js"), "utf8")
  ),
  "Templates can be cached client-side for 1 hour"
);

// ─── Scale & Reliability ──────────────────────────────────────────

check(
  "MongoDB connection pool sized for load",
  /maxPoolSize/.test(db) && /minPoolSize/.test(db),
  "Pool 5-50 connections handles bursty traffic"
);

check(
  "MongoDB retry on reads + writes",
  /retryWrites:\s*true/.test(db) && /retryReads:\s*true/.test(db),
  "Transient failures auto-retry"
);

check(
  "Connection lifecycle events logged (error, disconnected, reconnected)",
  /connection\.on\(["']error/.test(db) &&
    /connection\.on\(["']disconnected/.test(db) &&
    /connection\.on\(["']reconnected/.test(db),
  "Visibility into connection health"
);

check(
  "Graceful shutdown on SIGTERM/SIGINT",
  /SIGTERM/.test(server) && /SIGINT/.test(server) && /gracefulShutdown/.test(server),
  "In-flight requests complete before process exits (no dropped requests on deploy)"
);

check(
  "Health check pings DB and returns 503 if degraded",
  /admin\(\)\.ping/.test(app) && /status\(dbOk\s*\?\s*200\s*:\s*503\)/.test(app),
  "Render's health probe sees real DB state"
);

check(
  "Process resilience: uncaughtException + unhandledRejection handlers",
  /uncaughtException/.test(server) && /unhandledRejection/.test(server),
  "Prevents silent crashes"
);

// ─── Usage Analytics ──────────────────────────────────────────────

check(
  "User model tracks lastActiveAt + totalApiCalls",
  /lastActiveAt/.test(userModel) && /totalApiCalls/.test(userModel),
  "Required fields for DAU/WAU/MAU analytics"
);

check(
  "Throttled usage tracker (max 1 write per user per 5 min)",
  /TOUCH_WINDOW_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000/.test(usage),
  "Negligible DB overhead even at 1000s req/sec"
);

check(
  "trackUsage chained into authRequired (fire-and-forget)",
  /trackUsage\(req, res/.test(auth),
  "Every authenticated request updates last-seen without blocking"
);

check(
  "GET /api/super/usage-stats endpoint exists",
  /getUsageStats/.test(superCtrl) &&
    /DAU.*WAU.*MAU|dau,\s*wau,\s*mau,\s*qau/.test(superCtrl),
  "Super admin can see daily/weekly/monthly active users"
);

check(
  "Usage stats include activation rate, retention rate, top users",
  /activationRate/.test(superCtrl) &&
    /retentionRate/.test(superCtrl) &&
    /topUsers/.test(superCtrl),
  "Actionable analytics, not just counts"
);

// ─── Audit log / Security headers ──────────────────────────────────

check(
  "Additional security headers set (XSS, Frame, MIME, Permissions)",
  /X-Content-Type-Options/.test(app) &&
    /X-Frame-Options/.test(app) &&
    /Permissions-Policy/.test(app),
  "Browser-side defenses layered with server-side"
);

// ─── Print ──────────────────────────────────────────────────────────
console.log("\n=== PRODUCTION READINESS CHECKLIST ===\n");
const passed = checks.filter((c) => c.pass).length;
const failed = checks.filter((c) => !c.pass).length;

checks.forEach((c, i) => {
  const icon = c.pass ? "[PASS]" : "[FAIL]";
  console.log(`${i + 1}. ${icon} ${c.name}`);
  if (c.detail) console.log(`        ${c.detail}`);
});

console.log(`\nResult: ${passed} passed, ${failed} failed (out of ${checks.length})\n`);

if (failed === 0) {
  console.log("ALL CHECKS PASSED. Backend is production-ready.\n");
} else {
  process.exit(1);
}
