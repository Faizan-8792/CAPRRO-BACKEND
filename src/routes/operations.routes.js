import { Router } from "express";
import {
  listActivityEvents,
  listAutomationJobs,
  retryAutomationJob,
} from "../controllers/operations.controller.js";
import { authRequired } from "../middleware/auth.middleware.js";
import { requireFirmAdmin } from "../middleware/authorization.middleware.js";

const router = Router();

router.use(authRequired, requireFirmAdmin);
router.get("/activity", listActivityEvents);
router.get("/jobs", listAutomationJobs);
router.post("/jobs/:jobId/retry", retryAutomationJob);

export default router;
