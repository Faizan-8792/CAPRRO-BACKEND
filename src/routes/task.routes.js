import express from "express";
import { authRequired } from "../middleware/auth.middleware.js";
import taskController from "../controllers/task.controller.js";

const {
  createTask,
  getTaskBoard,
  updateTask,
  getMyOpenTasks,
  postTaskFollowup,
  postTaskEscalate,
} = taskController;

const router = express.Router();
router.use(authRequired);

// Admin board
router.post("/", createTask);
router.get("/board", getTaskBoard);
router.patch("/:id", updateTask);

// Follow-up / escalate
router.post("/:id/followup", postTaskFollowup);
router.post("/:id/escalate", postTaskEscalate);

// User tasks
router.get("/my-open", getMyOpenTasks);

export default router;
