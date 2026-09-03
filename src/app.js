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
import { clientVersionGate } from "./middleware/client-version.middleware.js";
import { superLimiter } from "./middleware/rate-limit.middleware.js";
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
  // OCR intake. Without these, production replaced every OCR failure with a
  // generic message. A missing consent read "Some submitted information could not
  // be accepted. Review the form and try again." -- misleading, because there is
  // no form field to correct: the requirement is consent to send a client's notice
  // to a third-party OCR provider. OCR_TYPE_UNSUPPORTED fell through to the
  // catch-all default and so never told the user that only PDF, PNG and JPEG are
  // accepted, and OCR_NO_TEXT blamed the form for a file that could not be read.
  //
  // AUDIT_AI_CONSENT_REQUIRED directly above is the same class of consent gate and
  // was already public, which is what makes this an oversight rather than a choice.
  //
  // OCR_PROVIDER_ERROR is deliberately absent: its message embeds
  // `HTTP ${response.status}`, and no user-facing string may contain "HTTP". It
  // stays generic until that message is rewritten.
  //
  // CASE_AI_CONSENT_REQUIRED is the third member of the same family and was
  // missing for the same reason. Its message names the provider, exactly as
  // AUDIT_AI_CONSENT_REQUIRED does ("...sent to DeepSeek",
  // audit-working-paper.service.js:1092), so the two consent gates now read
  // consistently instead of one naming the provider and the other blaming the
  // form. The remaining CASE_* codes -- CASE_NOT_FOUND, INVALID_CASE_CURSOR,
  // INVALID_CASE_SNAPSHOT, CASE_REPLAY_TARGET_MISSING -- are still absent
  // deliberately: their messages are engineer-facing ("case-list-v1 cursor is
  // invalid") and making them public would put that wording in front of a
  // chartered accountant. They need new copy first, which is a product decision,
  // not a code change. See docs/notices-cases-contract.md.
  "CASE_AI_CONSENT_REQUIRED",
  "OCR_CONSENT_REQUIRED",
  "OCR_FILE_REQUIRED",
  "OCR_FILE_TOO_LARGE",
  "OCR_TYPE_UNSUPPORTED",
  "OCR_NO_TEXT",
  "OCR_TEXT_TOO_LARGE",
  "OCR_PROCESSING_FAILED",
  "OCR_PROVIDER_UNAVAILABLE",
  "OCR_TIMEOUT",
  // OCR_QUOTA_EXCEEDED (O10's per-user/monthly/global OCR.space spend cap) is
  // deliberately absent here, unlike its OCR_* siblings above: its message is
  // built at runtime from ProviderUsage.reserveProviderCall's returned
  // `reason` string, not a literal, so tests/error-contract-invariants.mjs
  // and tests/notice-case-contract.mjs cannot statically prove it is safe to
  // show verbatim the way every other entry in this Set is provably safe. It
  // still answers 429 with a perfectly good generic message either way
  // (publicErrorMessage's status===429 branch: "Too many requests were
  // received. Wait briefly and try again."), so nothing user-facing is lost.
  "IMPORT_MAPPING_UNSUPPORTED_FIELDS",
  "IMPORT_MAPPING_MISSING_FIELDS",
  "IMPORT_MAPPING_HEADER_NOT_FOUND",
  "IMPORT_MAPPING_DUPLICATE_SOURCE",
  "GST_IMPORT_CLIENT_NOT_FOUND",
  "GST_IMPORT_PREVIEW_STALE",
  "RECIPIENT_GSTIN_MISMATCH",
  // IMPORT_DATE_ORDER_CONFLICTING is deliberately absent from
  // PUBLIC_IMPORT_ERROR_MESSAGES below. Its thrown message already names the
  // two proving row numbers (see import-preview.service.js), and a public code
  // with no fixed-message entry falls through to `err.message` unchanged
  // (publicErrorMessage() below) -- the CA-facing point of this error is
  // exactly those row numbers, so a generic override here would erase the one
  // thing worth telling them.
  "IMPORT_DATE_ORDER_CONFLICTING",
  "IMPORT_DATE_ORDER_UNSUPPORTED",
]);

const PUBLIC_IMPORT_ERROR_MESSAGES = Object.freeze({
  IMPORT_MAPPING_UNSUPPORTED_FIELDS:
    "Column mapping contains unsupported fields.",
  IMPORT_MAPPING_MISSING_FIELDS: "Required column mappings are missing.",
  IMPORT_MAPPING_HEADER_NOT_FOUND:
    "A mapped source heading is not present in this file.",
  IMPORT_MAPPING_DUPLICATE_SOURCE:
    "Each source column can map to only one import field.",
  GST_IMPORT_CLIENT_NOT_FOUND:
    "Selected client is not available in the active firm.",
  GST_IMPORT_PREVIEW_STALE:
    "Import inputs changed after preview. Preview current data again.",
  RECIPIENT_GSTIN_MISMATCH:
    "Recipient GSTIN does not match selected registration.",
  IMPORT_DATE_ORDER_UNSUPPORTED:
    "Date order must be day-first, month-first, or left unset to be detected from the file.",
});

const app = express();

// Importing app must not fabricate bootstrap success. server.js owns background
// initialization and marks readiness true only after indexes and schedulers are ready.
let backgroundInitializationReady = false;
let backgroundInitializationErrorCode = null;
let backgroundInitializationStage = null;
let backgroundInitializationDetail = null;

function setBackgroundReadiness(ready) {
  backgroundInitializationReady = ready === true;
  if (backgroundInitializationReady) {
    backgroundInitializationErrorCode = null;
    backgroundInitializationStage = null;
    backgroundInitializationDetail = null;
  }
}

// Records why background initialization is not finishing, as a stable code and
// the stage it failed in. Never a message, a stack, or any connection detail --
// a driver error can carry the connection string, which is why the payload
// excluded error information entirely before.
//
// Diagnosing a stuck readiness state previously required server filesystem
// access: /health said "initializing" and nothing more, so an instance could
// retry a failing step indefinitely with no external signal beyond a 503 that
// never resolved. The first version of this reported only a string `code`, which
// was not enough -- a MongoDB error carries a *numeric* code, so every driver
// failure collapsed into one indistinguishable value.
function setBackgroundInitializationError(error, stage = null) {
  const rawCode = error?.code;
  if (typeof rawCode === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(rawCode)) {
    backgroundInitializationErrorCode = rawCode;
  } else if (Number.isInteger(rawCode)) {
    // MongoDB server error codes are numeric: 11000 duplicate key, 85 and 86
    // index conflicts. The number alone identifies the failure class.
    backgroundInitializationErrorCode = `MONGO_${rawCode}`;
  } else if (
    typeof error?.name === "string" &&
    /^[A-Za-z][A-Za-z0-9]{2,63}$/.test(error.name)
  ) {
    backgroundInitializationErrorCode = `ERR_${error.name.toUpperCase()}`;
  } else {
    backgroundInitializationErrorCode = "INITIALIZATION_ERROR";
  }
  backgroundInitializationStage =
    typeof stage === "string" && /^[a-z][a-z0-9-]{1,63}$/.test(stage)
      ? stage
      : null;
  backgroundInitializationDetail = redactInitializationDetail(error?.message);
}

// A server-side error message is the one place a connection string can appear,
// which is why the health payload carried no error information at all
// originally. But a code alone was not enough to act on: MONGO_224 is
// QueryFeatureNotAllowed, and only the message names *which* feature the server
// refused. So the message is admitted with every credential-bearing shape removed
// and a hard length cap.
function redactInitializationDetail(message) {
  if (typeof message !== "string" || message.length === 0) return null;
  return message
    .replace(/mongodb(?:\+srv)?:\/\/\S*/gi, "[uri]")
    .replace(/\/\/[^\s/@]*:[^\s/@]*@/g, "//[credentials]@")
    .replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, "[address]")
    .slice(0, 240);
}

function isHealthReady({ dbOk, backgroundReady }) {
  return dbOk === true && backgroundReady === true;
}

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
        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          "https://cdn.jsdelivr.net",
          "https://fonts.googleapis.com",
          "https://cdnjs.cloudflare.com",
        ],
        scriptSrc: ["'self'", "https://cdn.jsdelivr.net"],
        connectSrc: [
          "'self'",
          "https://cdn.jsdelivr.net",
          "https://api.caprotoolkit.in",
        ],
        imgSrc: ["'self'", "data:", "https:"],
        fontSrc: [
          "'self'",
          "https://cdn.jsdelivr.net",
          "https://fonts.gstatic.com",
          "https://cdnjs.cloudflare.com",
        ],
      },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    // Force HTTPS for a year (with subdomains + preload eligibility).
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  }),
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

// Super admin endpoints: moderate - 50 requests per 15 minutes.
// Defined in rate-limit.middleware.js (not inline) so every super-admin write route -- on
// /api/super below and on /api/app-config's five super-only routes -- shares one definition.

/* ===============================
   ADDITIONAL SECURITY HEADERS
================================ */
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
  next();
});

/* ===============================
   CORS — FINAL FIX (IMPORTANT)
   - Allows backend same-origin
   - Allows chrome-extension
   - Allows localhost dev
   - Allows the marketing site (read-only, public routes only)
================================ */
// Exact-string allowlist for the marketing site — never .startsWith() and
// never a regex here, or "https://caprotoolkit.in.evil.com" would also match.
const MARKETING_SITE_ORIGINS = Object.freeze([
  "https://caprotoolkit.in",
  "https://www.caprotoolkit.in",
]);

app.use(
  // Per-request options delegate: the same-origin rule below needs the request's own
  // origin, which the plain `origin: (origin, cb)` form never sees.
  cors((req, callback) => {
    // The request's own origin, derived from the request rather than a constant.
    // `trust proxy` is set (app.js:213), so req.protocol honours X-Forwarded-Proto.
    const requestOrigin = `${req.protocol}://${req.get("host")}`;
    callback(null, {
    origin: (origin, callback) => {
      // ✅ Allow same-origin / server calls
      if (!origin) return callback(null, true);

      // ✅ Allow backend itself
      if (origin === "https://api.caprotoolkit.in") {
        return callback(null, true);
      }

      // ✅ Allow an Origin equal to the request's own origin (O19, owner-accepted
      //    2026-08-27). This adds NO cross-origin capability: a page on evil.com
      //    sends Origin: https://evil.com against Host: api.caprotoolkit.in, and a
      //    browser always sets Host from the URL it is fetching, so the two can only
      //    match when the request genuinely is same-origin. It exists so the admin
      //    panel works when the whole backend is served from a staging or local
      //    host, instead of being CORS-refused on every write.
      if (origin === requestOrigin) {
        return callback(null, true);
      }

      // ✅ Allow the marketing site (caprotoolkit.in / www.caprotoolkit.in) to
      //    read the public GET /api/app-config route — the download page
      //    (U12) needs this so the website and the desktop app quote one
      //    shared source of truth for version, SHA-256 and size, instead of
      //    the website hardcoding a stale copy.
      //    NOTE: this only widens what a BROWSER on that origin may READ over
      //    CORS. Every authenticated route is still gated by its own auth
      //    middleware — credentials:true is safe here only because we match
      //    an exact-string allowlist, never a wildcard and never a prefix
      //    match (a .startsWith() check would also let
      //    "https://caprotoolkit.in.evil.com" through).
      if (MARKETING_SITE_ORIGINS.includes(origin)) {
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
    });
  }),
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
  // A compliant mail client's automatic RFC 8058 one-click unsubscribe
  // handler POSTs application/x-www-form-urlencoded with a fixed body
  // ("List-Unsubscribe=One-Click") that it does not let the sender
  // customize - it cannot be made to send application/json instead. This is
  // the one other place, alongside the OCR multipart exemption above, this
  // guard has to recognise a second real content type.
  const isDigestUnsubscribeForm =
    req.path === "/api/digests/unsubscribe" &&
    ct.includes("application/x-www-form-urlencoded");
  if (
    !ct.includes("application/json") &&
    !isCaseOcrMultipart &&
    !isDigestUnsubscribeForm
  ) {
    return res.status(415).json({
      ok: false,
      error: "Unsupported Media Type — Content-Type must be application/json",
    });
  }
  next();
});

// An import posts a whole spreadsheet as a JSON string, and a real client's
// monthly purchase register runs to several megabytes - far past anything
// another route has business sending. This parser is mounted first and only
// on the import paths, so a register can be large without every endpoint in
// the app also accepting a 10 MB body.
//
// Deliberately kept above MAX_TEXT_BYTES in import-preview.service.js: if
// Express rejects the body first, the user gets an opaque 413 instead of that
// service's own sentence telling them what to do about their file. The two
// limits have to move together.
app.use("/api/imports", express.json({ limit: "12mb" }));
app.use(express.json({ limit: "1mb" }));
// A mail client's automatic RFC 8058 one-click unsubscribe POST sends
// Content-Type: application/x-www-form-urlencoded with a fixed body of
// "List-Unsubscribe=One-Click" - express.json() alone does not parse that
// content type, which would leave req.body undefined for that one request
// shape. Kept small: this route is the only form-urlencoded consumer.
app.use(express.urlencoded({ extended: false, limit: "10kb" }));
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

  const background = backgroundInitializationReady ? "ready" : "initializing";
  dbOk = isHealthReady({
    dbOk,
    backgroundReady: backgroundInitializationReady,
  });

  // Keep the public health payload minimal: no process memory internals, and no
  // initialization error message, stack or connection detail. The error *code* is
  // included when degraded because without it a stuck readiness state is not
  // diagnosable without server filesystem access.
  const payload = {
    status: dbOk ? "ok" : "degraded",
    uptime: Math.round(process.uptime()),
    db: { state: dbStateName, ping_ms: dbPingMs },
    background,
  };
  if (!dbOk && backgroundInitializationErrorCode) {
    payload.backgroundError = backgroundInitializationErrorCode;
    if (backgroundInitializationStage) {
      payload.backgroundStage = backgroundInitializationStage;
    }
    if (backgroundInitializationDetail) {
      payload.backgroundDetail = backgroundInitializationDetail;
    }
  }
  res.status(dbOk ? 200 : 503).json(payload);
});

/* ===============================
   ROOT
================================ */
app.get("/", (req, res) =>
  res.json({ message: "CA-PRO-TOOLKIT backend running", health: "/health" }),
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
  express.static(path.join(publicDir, "admin"), { index: false }),
);

// Admin entry
app.get("/admin", (req, res) =>
  res.sendFile(path.join(publicDir, "admin", "admin.html")),
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

// O11: minimum-supported-client-version gate — same "applies to all subsequent
// /api/* routes except the allowlist" placement as maintenanceGate immediately
// above, for the same reason (routes mounted earlier, like /api/auth and
// /api/app-config, already never reach either gate; this is defense-in-depth
// plus the one true guarantee for /api/super and everything below). Fails
// open on a missing/unparseable header or an unset floor — see
// client-version.middleware.js's own header comment for why that must never
// be softened.
app.use(clientVersionGate);

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
  if (multerStatus === 413)
    return "The selected file exceeds the permitted size.";
  if (multerStatus === 400)
    return "The selected file could not be processed. Review it and try again.";

  if (status === 400 || status === 422) {
    return "Some submitted information could not be accepted. Review the form and try again.";
  }
  if (status === 401) return "Your session has expired. Sign in again.";
  if (status === 403)
    return "You do not have permission to complete this action.";
  if (status === 404) return "The requested item could not be found.";
  if (status === 409)
    return "This information changed while you were working. Refresh and try again.";
  if (status === 413) return "The selected file exceeds the permitted size.";
  if (status === 429)
    return "Too many requests were received. Wait briefly and try again.";
  if (status >= 500) {
    return "We could not complete your request. Try again, or contact support with the request ID if the issue continues.";
  }
  return "The request could not be completed. Review the information and try again.";
}

function publicErrorDetails(err) {
  if (err?.code === "RECIPIENT_GSTIN_MISMATCH") {
    const rows = Array.isArray(err?.details?.rows)
      ? err.details.rows
          .filter((row) => Number.isInteger(row) && row >= 2 && row <= 501)
          .slice(0, 100)
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
  const multerStatus =
    err?.name === "MulterError"
      ? err.code === "LIMIT_FILE_SIZE"
        ? 413
        : 400
      : null;
  const candidateStatus = Number(
    multerStatus || err?.status || err?.statusCode || 500,
  );
  const status =
    Number.isInteger(candidateStatus) &&
    candidateStatus >= 400 &&
    candidateStatus <= 599
      ? candidateStatus
      : 500;
  console.error(
    `[ERROR] ${req.method} ${req.path} →`,
    err?.message,
    err?.stack,
  );
  const rolloutChanged =
    err?.code === "FEATURE_ROLLOUT_CHANGED" &&
    Object.prototype.hasOwnProperty.call(
      DEFAULT_FEATURE_FLAGS,
      err?.featureFlag,
    );
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

export {
  isHealthReady,
  setBackgroundInitializationError,
  setBackgroundReadiness,
};
export default app;
