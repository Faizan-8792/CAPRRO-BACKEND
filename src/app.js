import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import path from "path";
import { fileURLToPath } from "url";

import authRoutes from "./routes/auth.routes.js";
import reminderRoutes from "./routes/reminder.routes.js";
import firmRoutes from "./routes/firm.routes.js";
import statsRoutes from "./routes/stats.routes.js";
import superRoutes from "./routes/super.routes.js";
import taskRoutes from "./routes/task.routes.js";

const app = express();

// Resolve __dirname in ES modules
const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);

// Helmet with CSP (mainly affects pages served by backend: /admin)
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'", "https://cdn.jsdelivr.net"],
        imgSrc: ["'self'", "data:", "https:"],
        fontSrc: ["'self'", "https://cdn.jsdelivr.net"],
      },
    },
  })
);

// ---------- CORS (UPDATED for local + live + chrome-extension) ----------
const isProd = process.env.NODE_ENV === "production";

const allowedOrigins = new Set(
  [
    // Dev frontend
    !isProd ? "http://localhost:5173" : null,

    // If you host any separate frontend/admin elsewhere, add it here as exact origin:
    // "https://your-frontend-domain.com"
  ].filter(Boolean)
);

// Optional: restrict chrome extension IDs via env (comma-separated)
const allowedExtensionIds = (process.env.CORS_EXTENSION_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow same-origin / curl / server-to-server calls where Origin is absent
      if (!origin) return callback(null, true);

      // Allow known web origins
      if (allowedOrigins.has(origin)) return callback(null, true);

      // Allow chrome extension origins
      if (origin.startsWith("chrome-extension://")) {
        // If no IDs specified, allow any chrome-extension origin (easy mode)
        if (allowedExtensionIds.length === 0) return callback(null, true);

        // Else allow only the listed extension IDs
        const id = origin.replace("chrome-extension://", "").replaceAll("/", "");
        if (allowedExtensionIds.includes(id)) return callback(null, true);
      }

      return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
  })
);

app.use(morgan(isProd ? "combined" : "dev"));
app.use(express.json());

// ------- HEALTH -------
app.get("/health", (req, res) =>
  res.json({ status: "ok", uptime: process.uptime() })
);

// ------- ROOT override (prevents serving public/index.html automatically on /) -------
app.get("/", (req, res) =>
  res.json({ message: "CA-PRO-TOOLKIT backend running", health: "/health" })
);

// ------- STATIC root/admin -------
const publicDir = path.join(dirname, "..", "public");

// IMPORTANT: index:false won't auto-serve public/index.html on "/"
app.use(express.static(publicDir, { index: false }));

// Admin static under /admin (CSS/JS inside public/admin)
app.use("/admin", express.static(path.join(publicDir, "admin"), { index: false }));

// Admin main page
app.get("/admin", (req, res) =>
  res.sendFile(path.join(publicDir, "admin", "admin.html"))
);

// ------- APIs -------
app.use("/api/auth", authRoutes);
app.use("/api/reminders", reminderRoutes);
app.use("/api/firms", firmRoutes);
app.use("/api/stats", statsRoutes);
app.use("/api/super", superRoutes);
app.use("/api/tasks", taskRoutes);

export default app;
