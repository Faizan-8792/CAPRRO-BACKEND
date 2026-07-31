import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import hpp from "hpp";
import compression from "compression";
import path from "path";
import { fileURLToPath } from "url";

import authRoutes from "./routes/auth.routes.js";
import reminderRoutes from "./routes/reminder.routes.js";
import firmRoutes from "./routes/firm.routes.js";
import statsRoutes from "./routes/stats.routes.js";
import superRoutes from "./routes/super.routes.js";
import taskRoutes from "./routes/task.routes.js";
import auditRoutes from "./routes/audit.routes.js";
import taxworkerRoutes from "./routes/taxworker.routes.js";
import appConfigRoutes from "./routes/appconfig.routes.js";
import complianceRoutes from "./routes/compliance.routes.js";
import homeRoutes from "./routes/home.routes.js";
import importRoutes from "./routes/import.routes.js";
import gstReconciliationRoutes from "./routes/gst-reconciliation.routes.js";
import tdsHealthRoutes from "./routes/tds-health.routes.js";
import operationsRoutes from "./routes/operations.routes.js";
import caseRoutes from "./routes/case.routes.js";
import engagementRoutes from "./routes/engagement.routes.js";
import firmOperationsRoutes from "./routes/firm-operations.routes.js";
import digestRoutes from "./routes/digest.routes.js";
import { sanitizeInputs } from "./middleware/sanitize.middleware.js";
import { trackUsage } from "./middleware/usage-tracker.middleware.js";
import { requestId } from "./middleware/request-id.middleware.js";
import { maintenanceGate } from "./middleware/maintenance.middleware.js";
import { DEFAULT_FEATURE_FLAGS } from "./models/AppConfig.js";

const PUBLIC_ERROR_CODES = new Set([
  "INVALID_MUTATION_KEY",
  "MUTATION_KEY_REUSED",
  "MUTATION_RECEIPT_LIMIT",
  "ENGAGEMENT_REVISION_CONFLICT",
  "ENGAGEMENT_SNAPSHOT_CHANGED",
  "ENGAGEMENT_COMPLETE_READ_ONLY",
  "ENGAGEMENT_REVIEWER_REQUIRED",
  "ENGAGEMENT_REVIEWER_ROLE_REQUIRED",
  "ENGAGEMENT_REVIEWER_REASSIGNMENT_CONFLICT",
  "ENGAGEMENT_TEMPLATE_REVIEW_REQUIRED",
  "ENGAGEMENT_TEMPLATE_REVIEW_DRAFT_ONLY",
  "ENGAGEMENT_FINDING_REVIEW_CONFLICT",
  "ENGAGEMENT_CLOSURE_INCOMPLETE",
  "INVALID_ENGAGEMENT_TRANSITION",
  "INVALID_FINDING_TRANSITION",
  "AUDIT_WORKING_PAPER_REVISION_CONFLICT",
  "AUDIT_ANALYSIS_REVISION_CONFLICT",
  "AUDIT_WORKING_PAPER_ROW_KEY_EXISTS",
  "AUDIT_PROPOSAL_ALREADY_DECIDED",
  "AUDIT_SOURCE_ROW_CHANGED",
  "AUDIT_AI_CONSENT_REQUIRED",
  "IMPORT_MAPPING_UNSUPPORTED_FIELDS",
  "IMPORT_MAPPING_MISSING_FIELDS",
  "IMPORT_MAPPING_HEADER_NOT_FOUND",
  "IMPORT_MAPPING_DUPLICATE_SOURCE",
  "GST_IMPORT_CLIENT_NOT_FOUND",
  "GST_IMPORT_PREVIEW_STALE",
  "RECIPIENT_GSTIN_MISMATCH",
]);

const PUBLIC_IMPORT_ERROR_MESSAGES = Object.freeze({
  IMPORT_MAPPING_UNSUPPORTED_FIELDS: "Column mapping contains unsupported fields.",
  IMPORT_MAPPING_MISSING_FIELDS: "Required column mappings are missing.",
  IMPORT_MAPPING_HEADER_NOT_FOUND: "A mapped source heading is not present in this file.",
  IMPORT_MAPPING_DUPLICATE_SOURCE: "Each source column can map to only one import field.",
  GST_IMPORT_CLIENT_NOT_FOUND: "Selected client is not available in the active firm.",
  GST_IMPORT_PREVIEW_STALE: "Import inputs changed after preview. Preview current data again.",
  RECIPIENT_GSTIN_MISMATCH: "Recipient GSTIN does not match selected registration.",
});

const app = express();

// Trust Render's reverse proxy so req.ip + secure cookies work correctly
app.set("trust proxy", 1);

// Resolve __dirname in ES modules
const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);

const isProd = process.env.NODE_ENV === "production";

// Validate required env vars at boot
const REQUIRED_ENV = ["JWT_SECRET", "MONGODB_URI"];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[STARTUP] Missing required env var: ${key}`);
    if (isProd) {
      process.exit(1);
    }
  }
}

// Request ID + compression (very early in the chain)
app.use(requestId);
app.use(compression({ threshold: 1024 })); // gzip responses larger than 1KB

/* ===============================
   HELMET (CSP – admin pages)
================================ */
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
        scriptSrc: ["'self'", "https://cdn.jsdelivr.net"],
        connectSrc: [
          "'self'",
          "https://cdn.jsdelivr.net",
          "https://api.caprotoolkit.in"
        ],
        imgSrc: ["'self'", "data:", "https:"],
        fontSrc: ["'self'", "https://cdn.jsdelivr.net", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
      },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    // Force HTTPS for a year (with subdomains + preload eligibility).
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  })
);

/* ===============================
   RATE LIMITING
================================ */
// Global: 200 requests per 15 minutes per IP
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many requests, please try again later." },
});
app.use(globalLimiter);

// Super admin endpoints: moderate - 50 requests per 15 minutes
const superLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Rate limit exceeded for admin operations." },
});

/* ===============================
   ADDITIONAL SECURITY HEADERS
================================ */
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
  next();
});

/* ===============================
   CORS — FINAL FIX (IMPORTANT)
   - Allows backend same-origin
   - Allows chrome-extension
   - Allows localhost dev
================================ */
app.use(
  cors({
    origin: (origin, callback) => {
      // ✅ Allow same-origin / server calls
      if (!origin) return callback(null, true);

      // ✅ Allow backend itself
      if (origin === "https://api.caprotoolkit.in") {
        return callback(null, true);
      }

      // ✅ Allow localhost dev
      if (!isProd && origin.startsWith("http://localhost")) {
        return callback(null, true);
      }

      // ✅ Allow ALL chrome extensions
      if (origin.startsWith("chrome-extension://")) {
        return callback(null, true);
      }

      // ❌ Block everything else
      return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
  })
);

app.use(morgan(isProd ? "combined" : "dev"));

// Content-Type guard: reject non-JSON POST/PATCH/PUT bodies on /api/*
app.use((req, res, next) => {
  if (!req.path.startsWith("/api/")) return next();
  const method = req.method.toUpperCase();
  if (!["POST", "PATCH", "PUT"].includes(method)) return next();
  // Empty bodies are fine for some routes
  const len = Number(req.headers["content-length"] || 0);
  if (len === 0) return next();
  const ct = String(req.headers["content-type"] || "").toLowerCase();
  const isCaseOcrMultipart =
    req.path === "/api/cases/ocr" && ct.includes("multipart/form-data");
  if (!ct.includes("application/json") && !isCaseOcrMultipart) {
    return res.status(415).json({
      ok: false,
      error: "Unsupported Media Type — Content-Type must be application/json",
    });
  }
  next();
});

app.use(express.json({ limit: "1mb" }));
app.use(sanitizeInputs);
// HTTP Parameter Pollution protection: collapse duplicated query/body params
// to a single value so `?role=user&role=admin` cannot smuggle unexpected arrays.
app.use(hpp());
// trackUsage is wired AFTER authRequired in each route; this comment marks the chain.

/* ===============================
   HEALTH (with DB ping)
================================ */
import mongoose from "mongoose";

app.get("/health", async (req, res) => {
  const dbState = mongoose.connection?.readyState; // 0=disconnected,1=connected,2=connecting,3=disconnecting
  const dbStateName =
    { 0: "disconnected", 1: "connected", 2: "connecting", 3: "disconnecting" }[
      dbState
    ] || "unknown";

  let dbOk = dbState === 1;
  let dbPingMs = null;
  if (dbOk) {
    try {
      const start = Date.now();
      await mongoose.connection.db.admin().ping();
      dbPingMs = Date.now() - start;
    } catch {
      dbOk = false;
    }
  }

  // Keep the public health payload minimal (no process memory internals).
  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? "ok" : "degraded",
    uptime: Math.round(process.uptime()),
    db: { state: dbStateName, ping_ms: dbPingMs },
  });
});

/* ===============================
   ROOT
================================ */
app.get("/", (req, res) =>
  res.json({ message: "CA-PRO-TOOLKIT backend running", health: "/health" })
);

/* ===============================
   STATIC FILES
================================ */
const publicDir = path.join(dirname, "..", "public");

// Do NOT auto-serve index.html on "/"
app.use(express.static(publicDir, { index: false }));

// Admin static files
app.use(
  "/admin",
  express.static(path.join(publicDir, "admin"), { index: false })
);

// Admin entry
app.get("/admin", (req, res) =>
  res.sendFile(path.join(publicDir, "admin", "admin.html"))
);

/* ===============================
   API ROUTES
================================ */
// NOTE: per-route limiters (send-otp/verify-otp/google) live in auth.routes.js.
// The whole group must NOT carry the strict 10/15min limiter, or /api/auth/me
// (called on every workspace refresh/switch) 429s and bounces users to sign-in.
app.use("/api/auth", authRoutes);
app.use("/api/reminders", reminderRoutes);
app.use("/api/firms", firmRoutes);
app.use("/api/stats", statsRoutes);
// App-config (maintenance/welcome) — registered FIRST so maintenance check runs before others
app.use("/api/app-config", appConfigRoutes);

// Maintenance gate — applies to all subsequent /api/* routes except the allowlist
app.use(maintenanceGate);

app.use("/api/super", superLimiter, superRoutes);
app.use("/api/tasks", taskRoutes);
app.use("/api/audit", auditRoutes);
app.use("/api/taxworker", taxworkerRoutes);
app.use("/api/home", homeRoutes);
app.use("/api/compliance", complianceRoutes);
app.use("/api/imports", importRoutes);
app.use("/api/gst-reconciliation", gstReconciliationRoutes);
app.use("/api/tds-health", tdsHealthRoutes);
app.use("/api/operations", operationsRoutes);
app.use("/api/cases", caseRoutes);
app.use("/api/engagements", engagementRoutes);
app.use("/api/digests", digestRoutes);
app.use("/api", firmOperationsRoutes);

/* ===============================
   GLOBAL ERROR HANDLER
================================ */
function errorCategory(status) {
  if (status === 401) return "AUTHENTICATION_REQUIRED";
  if (status === 403) return "ACCESS_DENIED";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status === 413) return "FILE_TOO_LARGE";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "SERVICE_ERROR";
  if (status === 400 || status === 422) return "INPUT_ERROR";
  return "REQUEST_ERROR";
}

function publicErrorMessage({ err, status, multerStatus, publicCode }) {
  if (!isProd) return err?.message || "Internal server error";
  const fixedImportMessage = PUBLIC_IMPORT_ERROR_MESSAGES[err?.code];
  if (fixedImportMessage) return fixedImportMessage;
  if (publicCode && err?.message) return err.message;
  if (multerStatus === 413) return "The selected file exceeds the permitted size.";
  if (multerStatus === 400) return "The selected file could not be processed. Review it and try again.";

  if (status === 400 || status === 422) {
    return "Some submitted information could not be accepted. Review the form and try again.";
  }
  if (status === 401) return "Your session has expired. Sign in again.";
  if (status === 403) return "You do not have permission to complete this action.";
  if (status === 404) return "The requested item could not be found.";
  if (status === 409) return "This information changed while you were working. Refresh and try again.";
  if (status === 413) return "The selected file exceeds the permitted size.";
  if (status === 429) return "Too many requests were received. Wait briefly and try again.";
  if (status >= 500) {
    return "We could not complete your request. Try again, or contact support with the request ID if the issue continues.";
  }
  return "The request could not be completed. Review the information and try again.";
}

function publicErrorDetails(err) {
  if (err?.code === "RECIPIENT_GSTIN_MISMATCH") {
    const rows = Array.isArray(err?.details?.rows)
      ? err.details.rows.filter((row) => Number.isInteger(row) && row >= 2 && row <= 501).slice(0, 100)
      : [];
    return rows.length ? { rows } : null;
  }
  if (/^IMPORT_MAPPING_/.test(String(err?.code || ""))) {
    const fields = Array.isArray(err?.details?.fields)
      ? err.details.fields
        .filter((field) => /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(String(field)))
        .map(String)
        .slice(0, 100)
      : [];
    return fields.length ? { fields } : null;
  }
  return null;
}

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const multerStatus = err?.name === "MulterError"
    ? err.code === "LIMIT_FILE_SIZE" ? 413 : 400
    : null;
  const candidateStatus = Number(multerStatus || err?.status || err?.statusCode || 500);
  const status = Number.isInteger(candidateStatus) && candidateStatus >= 400 && candidateStatus <= 599
    ? candidateStatus
    : 500;
  console.error(`[ERROR] ${req.method} ${req.path} →`, err?.message, err?.stack);
  const rolloutChanged =
    err?.code === "FEATURE_ROLLOUT_CHANGED" &&
    Object.prototype.hasOwnProperty.call(DEFAULT_FEATURE_FLAGS, err?.featureFlag);
  const publicCode = rolloutChanged || PUBLIC_ERROR_CODES.has(err?.code);
  const publicDetails = publicCode ? publicErrorDetails(err) : null;
  res.status(status).json({
    ok: false,
    error: publicErrorMessage({ err, status, multerStatus, publicCode }),
    category: errorCategory(status),
    requestId: req.id || "",
    ...(publicCode ? { code: err.code } : {}),
    ...(publicDetails ? { details: publicDetails } : {}),
    ...(rolloutChanged ? { featureFlag: err.featureFlag } : {}),
    ...(!isProd && { stack: err?.stack }),
  });
});

export default app;
