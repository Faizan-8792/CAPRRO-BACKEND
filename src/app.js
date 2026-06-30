import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
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
import { sanitizeInputs } from "./middleware/sanitize.middleware.js";
import { trackUsage } from "./middleware/usage-tracker.middleware.js";
import { requestId } from "./middleware/request-id.middleware.js";
import { maintenanceGate } from "./middleware/maintenance.middleware.js";

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
          "https://caprro-backend-1.onrender.com"
        ],
        imgSrc: ["'self'", "data:", "https:"],
        fontSrc: ["'self'", "https://cdn.jsdelivr.net", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
      },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
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

// Auth endpoints: stricter - 10 requests per 15 minutes per IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many auth attempts, please try again later." },
});

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
      if (origin === "https://caprro-backend-1.onrender.com") {
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
  if (!ct.includes("application/json")) {
    return res.status(415).json({
      ok: false,
      error: "Unsupported Media Type — Content-Type must be application/json",
    });
  }
  next();
});

app.use(express.json({ limit: "1mb" }));
app.use(sanitizeInputs);
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

  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? "ok" : "degraded",
    uptime: Math.round(process.uptime()),
    db: { state: dbStateName, ping_ms: dbPingMs },
    memory: {
      rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      heap_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    },
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
app.use("/api/auth", authLimiter, authRoutes);
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

/* ===============================
   GLOBAL ERROR HANDLER
================================ */
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  console.error(`[ERROR] ${req.method} ${req.path} →`, err.message, err.stack);
  res.status(status).json({
    ok: false,
    error: err.message || "Internal server error",
    ...(process.env.NODE_ENV !== "production" && { stack: err.stack }),
  });
});

export default app;
