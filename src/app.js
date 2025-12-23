// src/app.js
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
import taskRoutes from "./routes/task.routes.js"; // NEW

const app = express();

// Resolve __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helmet with CSP allowing Bootstrap CDN (jsDelivr)
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

app.use(
  cors({
    origin: ["http://localhost:5173", "chrome-extension://*"],
    credentials: true,
  })
);

app.use(morgan("dev"));
app.use(express.json());

// Serve static admin files from /public
const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir));

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// API routes
app.use("/api/auth", authRoutes);
app.use("/api/reminders", reminderRoutes);
app.use("/api/firms", firmRoutes);
app.use("/api/stats", statsRoutes);
app.use("/api/super", superRoutes);
app.use("/api/tasks", taskRoutes); // NEW: all /api/tasks/* hit task.routes.js

// Nice fallback: /admin or /admin/anything -> login page
app.get("/admin", (req, res) => {
  res.sendFile(path.join(publicDir, "admin", "index.html"));
});
app.get("/admin/*", (req, res) => {
  res.sendFile(path.join(publicDir, "admin", "index.html"));
});

export default app;
