import express from "express";
import { authRequired } from "../middleware/auth.middleware.js";
import { createDelayLog, aggregateDelayReasons, getTaskDelayLogs } from "../controllers/delayLog.controller.js";

const router = express.Router();
router.use(authRequired);

router.post("/", createDelayLog);
router.get("/aggregate", aggregateDelayReasons);
router.get("/task/:taskId", getTaskDelayLogs);

export default router;
