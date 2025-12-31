import express from "express";

import authRoutes from "./auth.routes.js";
import reminderRoutes from "./reminder.routes.js";
import firmRoutes from "./firm.routes.js";
import statsRoutes from "./stats.routes.js";
import superRoutes from "./super.routes.js";
import taskRoutes from "./task.routes.js";
import accountingRoutes from "./accounting.routes.js";

const router = express.Router();

/* ===============================
   API ROUTES
================================ */
router.use("/api/auth", authRoutes);
router.use("/api/reminders", reminderRoutes);
router.use("/api/firms", firmRoutes);
router.use("/api/stats", statsRoutes);
router.use("/api/super", superRoutes);
router.use("/api/tasks", taskRoutes);
router.use("/api/accounting", accountingRoutes);
router.use("/tax-work", require("./taxwork.routes"));

export default router;
