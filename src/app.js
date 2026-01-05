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
import routes from "./routes/index.js";

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
        // Allow Google Fonts stylesheet and CDN for styles
  styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://fonts.googleapis.com"],
  // Explicitly allow style elements from Google Fonts (some browsers check style-src-elem)
  styleSrcElem: ["'self'", "https://fonts.googleapis.com"],
        scriptSrc: ["'self'"],
        connectSrc: [
          "'self'",
          "https://cdn.jsdelivr.net",
          "https://caprro-backend-1.onrender.com"
        ],
        imgSrc: ["'self'", "data:", "https:"],
        // Allow Google Fonts font files
        fontSrc: ["'self'", "https://cdn.jsdelivr.net", "https://fonts.gstatic.com"],
      },
    },
  })
);

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
app.use(express.json());

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
app.use("/api/auth", authRoutes);
app.use("/api/reminders", reminderRoutes);
app.use("/api/firms", firmRoutes);
app.use("/api/stats", statsRoutes);
app.use("/api/super", superRoutes);
app.use("/api/tasks", taskRoutes);
app.use(routes);
export default app;
