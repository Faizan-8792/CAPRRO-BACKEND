// src/routes/super.routes.js

import express from "express";
import { authRequired } from "../middleware/auth.middleware.js";
import {
  getUsageStats,
  getSuperDashboardStats,
  listAllUsers,
  listPendingAdmins,
  approveAdmin,
  revokeAdmin,
  listFirms,
  listFirmUsersForSuper,
  updateFirmPlan,
  updateFirmUserForSuper,
  deleteFirmUserForSuper,
  deleteFirmForSuper,
  runSystemSelfTest,
  sendSuperTestEmail,
} from "../controllers/super.controller.js";
import { requireSuperAdmin } from "../middleware/authorization.middleware.js";
import rateLimit from "express-rate-limit";

const router = express.Router();

// Extra-strict limiter for expensive / side-effecting admin diagnostics.
const diagnosticsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many diagnostic requests, please wait a few minutes." },
});

router.use(authRequired);

// One-button full system self-test (super admin only)
router.post("/self-test", diagnosticsLimiter, requireSuperAdmin, runSystemSelfTest);
// Send a real test email to the admin's own address (super admin only)
router.post("/send-test-email", diagnosticsLimiter, requireSuperAdmin, sendSuperTestEmail);

// Super admin dashboard stats
router.get("/dashboard-stats", getSuperDashboardStats);

// Extension usage analytics (DAU/WAU/MAU)
router.get("/usage-stats", getUsageStats);

// Full user directory (search, activity/role filters, pagination)
router.get("/users", listAllUsers);

// Pending firm admins
router.get("/pending-admins", listPendingAdmins);
router.post("/approve-admin/:userId", approveAdmin);
router.post("/revoke-admin/:userId", revokeAdmin);

// Firms + users + operational access (legacy /plan path retained for compatibility)
router.get("/firms", listFirms);
router.get("/firms/:firmId/users", listFirmUsersForSuper);
router.patch("/firms/:firmId/plan", updateFirmPlan);

// Update any user within a firm (role / active)
router.patch("/firms/:firmId/users/:userId", updateFirmUserForSuper);

// Delete user from firm
router.delete("/firms/:firmId/users/:userId", deleteFirmUserForSuper);

// Delete firm completely
router.delete("/firms/:firmId", deleteFirmForSuper);

export default router;
