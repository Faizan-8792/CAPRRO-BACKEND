import { Router } from "express";
import { authRequired } from "../middleware/auth.middleware.js";
import { requireRoles } from "../middleware/role.middleware.js";
import {
  getFirmOverviewStats,
  getClientsToChaseToday,
  postChaseComplete,
} from "../controllers/stats.controller.js";

const router = Router();

// ✅ Login required sab ke liye
router.use(authRequired);

// ✅ Firm overview: sirf admins/super
router.get(
  "/firm/:firmId/overview",
  requireRoles("FIRM_ADMIN", "SUPER_ADMIN"),
  getFirmOverviewStats
);

// ✅ Clients to Chase Today: GET - admin + staff + super
router.get(
  "/clients-to-chase-today",
  requireRoles("FIRM_ADMIN", "STAFF", "SUPER_ADMIN"),
  getClientsToChaseToday
);

// ✅ FIXED: Clients to Chase Today: POST complete - admin + staff + super
router.post(
  "/clients-to-chase-today/complete",
  requireRoles("FIRM_ADMIN", "STAFF", "SUPER_ADMIN"),
  postChaseComplete
);

export default router;
