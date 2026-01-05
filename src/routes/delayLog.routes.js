import express from "express";
import { authRequired } from "../middleware/auth.middleware.js";
import { createDelayLog, aggregateDelayReasons, getTaskDelayLogs } from "../controllers/delayLog.controller.js";

const router = express.Router();
router.use(authRequired);

router.post("/delay-logs", createDelayLog);
router.get("/delay-logs/aggregate", aggregateDelayReasons);
router.get("/delay-logs/task/:taskId", getTaskDelayLogs);

export default router;
