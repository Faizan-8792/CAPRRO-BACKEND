// src/routes/task.routes.js
import express from "express";
import { authRequired } from "../middleware/auth.middleware.js";
import {
  createTask,
  getTaskBoard,
  updateTask,
  archiveTask,
  getMyOpenTasks,
  completeTaskFromUser,
  postTaskFollowup,
  postTaskEscalate,
} from "../controllers/task.controller.js";

const router = express.Router();

// All task routes require auth (board, CRUD, My Tasks, complete-from-user)
router.use(authRequired);

// Firm-admin board + CRUD
router.post("/", createTask);
router.get("/board", getTaskBoard);
router.patch("/:id", updateTask);
router.delete("/:id", archiveTask);

// -------- NEW: Follow-up and Escalate routes --------
router.post("/:id/followup", postTaskFollowup);
router.post("/:id/escalate", postTaskEscalate);

// -------- User-side tasks (for Chrome extension) --------

// Logged-in staff ke liye unke open tasks
router.get("/my-open", getMyOpenTasks);

// Chrome extension se "Done" mark karne ke liye
router.patch("/:id/complete-from-user", completeTaskFromUser);

export default router;