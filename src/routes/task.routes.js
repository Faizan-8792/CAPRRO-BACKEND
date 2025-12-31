import express from "express";
import { authRequired } from "../middleware/auth.middleware.js";
import {
  createTask,
  getTaskBoard,
  updateTask,
  getMyOpenTasks,
  postTaskFollowup,
  postTaskEscalate,
  deleteTask,          // ✅ ADD THIS
} from "../controllers/task.controller.js";

const router = express.Router();
router.use(authRequired);

router.post("/", createTask);
router.get("/board", getTaskBoard);
router.patch("/:id", updateTask);

router.post("/:id/followup", postTaskFollowup);
router.post("/:id/escalate", postTaskEscalate);

router.get("/my-open", getMyOpenTasks);

// ✅ ADD DELETE ROUTE (at the bottom)
router.delete("/:id", deleteTask);

export default router;