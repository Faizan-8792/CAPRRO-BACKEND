import express from "express";
import { authRequired } from "../middleware/auth.middleware.js";
import {
  createTask,
  getTaskBoard,
  updateTask,
  getMyOpenTasks,
  postTaskFollowup,
  postTaskEscalate,
} from "../controllers/task.controller.js";

const router = express.Router();
router.use(authRequired);

router.post("/", createTask);
router.get("/board", getTaskBoard);
router.patch("/:id", updateTask);

router.post("/:id/followup", postTaskFollowup);
router.post("/:id/escalate", postTaskEscalate);

router.get("/my-open", getMyOpenTasks);

export default router;
