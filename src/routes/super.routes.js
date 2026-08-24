// src/routes/super.routes.js

import express from "express";
import { authRequired } from "../middleware/auth.middleware.js";
import {
  getUsageStats,
  getProviderUsageStats,
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
  listErasureRequestsForSuper,
  getErasureReceiptForSuper,
  runSystemSelfTest,
  getSystemSelfTestRun,
  getLatestSystemSelfTestRun,
  sendSuperTestEmail,
  sendTestDigest,
  forceLogoutUser,
} from "../controllers/super.controller.js";
import { listTermsAcceptances } from "../controllers/terms.controller.js";
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

// Immutable, server-timestamped Terms & Conditions acceptance audit.
router.get(
  "/terms-acceptances",
  requireSuperAdmin,
  listTermsAcceptances
);

// Isolated deep system review (super admin only). POST starts an asynchronous
// run; GET endpoints provide real progress and the latest retained report.
router.post("/self-test", diagnosticsLimiter, requireSuperAdmin, runSystemSelfTest);
router.get("/self-test/latest", requireSuperAdmin, getLatestSystemSelfTestRun);
router.get("/self-test/:runId", requireSuperAdmin, getSystemSelfTestRun);
// Send a real test email to the admin's own address (super admin only)
router.post("/send-test-email", diagnosticsLimiter, requireSuperAdmin, sendSuperTestEmail);
// Send a real digest email (weekly/daily) to the admin to verify digest delivery (super admin only)
router.post("/send-test-digest", diagnosticsLimiter, requireSuperAdmin, sendTestDigest);

// Super admin dashboard stats
router.get("/dashboard-stats", getSuperDashboardStats);

// Extension usage analytics (DAU/WAU/MAU)
router.get("/usage-stats", getUsageStats);

// O10: paid-provider (DeepSeek / OCR.space) call-volume meter -- backs the
// "Provider usage" admin panel card.
router.get("/provider-usage", requireSuperAdmin, getProviderUsageStats);

// Full user directory (search, activity/role filters, pagination)
router.get("/users", listAllUsers);

// Pending firm admins
router.get("/pending-admins", listPendingAdmins);
router.post("/approve-admin/:userId", approveAdmin);
router.post("/revoke-admin/:userId", revokeAdmin);

// Force-logout a user everywhere (revoke all their JWTs) — super admin only
router.post("/users/:userId/force-logout", requireSuperAdmin, forceLogoutUser);

// Firms + users + operational access (legacy /plan path retained for compatibility)
router.get("/firms", listFirms);
router.get("/firms/:firmId/users", listFirmUsersForSuper);
router.patch("/firms/:firmId/plan", updateFirmPlan);

// Update any user within a firm (role / active)
router.patch("/firms/:firmId/users/:userId", updateFirmUserForSuper);

// Delete user from firm
router.delete("/firms/:firmId/users/:userId", deleteFirmUserForSuper);

// Erase a firm and everything scoped to it. Requires an explicit confirmation in the body;
// see deleteFirmForSuper for why.
router.delete("/firms/:firmId", deleteFirmForSuper);

// Outstanding erasure requests, and the receipts produced by honouring them.
router.get("/erasure-requests", listErasureRequestsForSuper);
router.get("/erasure-receipts/:operationId", getErasureReceiptForSuper);

export default router;
