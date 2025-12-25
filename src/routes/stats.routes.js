import { Router } from "express";
import { authRequired } from "../middleware/auth.middleware.js";
import { requireRoles } from "../middleware/role.middleware.js";
import {
  getFirmOverviewStats,
  getClientsToChaseToday,
  postChaseComplete,
} from "../controllers/stats.controller.js";

const router = Router();


router.use(authRequired);


router.get(
  "/firm/:firmId/overview",
  requireRoles("FIRM_ADMIN", "SUPER_ADMIN"),
  getFirmOverviewStats
);


router.get(
  "/clients-to-chase-today",
  requireRoles("FIRM_ADMIN", "STAFF", "SUPER_ADMIN"),
  getClientsToChaseToday
);


router.post(
  "/clients-to-chase-today/complete",
  requireRoles("FIRM_ADMIN", "STAFF", "SUPER_ADMIN"),
  postChaseComplete
);

export default router;
