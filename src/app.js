import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import path from "path";
import { fileURLToPath } from "url";

import authRoutes from "./routes/auth.routes.js";
import reminderRoutes from "./routes/reminder.routes.js";
import firmRoutes from "./routes/firm.routes.js";
import statsRoutes from "./routes/stats.routes.js";
import superRoutes from "./routes/super.routes.js";
import taskRoutes from "./routes/task.routes.js";
import { sanitizeInputs } from "./middleware/sanitize.middleware.js";

const app = express();

// Resolve __dirname in ES modules
const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);

const isProd = process.env.NODE_ENV === "production";

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
app.use(express.json({ limit: "1mb" }));
app.use(sanitizeInputs);

/* ===============================
   HEALTH
================================ */
app.get("/health", (req, res) =>
  res.json({ status: "ok", uptime: process.uptime() })
);

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
app.use("/api/super", superLimiter, superRoutes);
app.use("/api/tasks", taskRoutes);

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
