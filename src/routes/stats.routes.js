import { Router } from "express";
import { authRequired } from "../middleware/auth.middleware.js";
import {
  requireFirmAdmin,
  requireFirmMember,
  requireFirmWriteAccess,
} from "../middleware/authorization.middleware.js";
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
  requireFirmAdmin,
  getFirmOverviewStats,
);

router.get(
  "/clients-to-chase-today",
  requireRoles("FIRM_ADMIN", "USER", "SUPER_ADMIN"),
  requireFirmMember,
  getClientsToChaseToday,
);

router.post(
  "/clients-to-chase-today/complete",
  requireRoles("FIRM_ADMIN", "USER", "SUPER_ADMIN"),
  requireFirmMember,
  requireFirmWriteAccess,
  postChaseComplete,
);

export default router;
