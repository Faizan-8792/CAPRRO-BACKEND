// src/routes/super.routes.js

import express from "express";
import { authRequired } from "../middleware/auth.middleware.js";
import {
  listPendingAdmins,
  approveAdmin,
  revokeAdmin,
  listFirms,
  listFirmUsersForSuper,
  updateFirmPlan,
  updateFirmUserForSuper,
  deleteFirmUserForSuper,
  deleteFirmForSuper,
} from "../controllers/super.controller.js";

const router = express.Router();

router.use(authRequired);

// Pending firm admins
router.get("/pending-admins", listPendingAdmins);
router.post("/approve-admin/:userId", approveAdmin);
router.post("/revoke-admin/:userId", revokeAdmin);

// Firms + users + plan control
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
