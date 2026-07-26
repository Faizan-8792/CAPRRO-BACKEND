// src/routes/task.routes.js
import express from "express";
import { authRequired } from "../middleware/auth.middleware.js";
import {
  requireFirmAdmin,
  requireFirmMember,
  requireFirmWriteAccess,
} from "../middleware/authorization.middleware.js";
import { captureOptionalFeatureFlag } from "../middleware/rollout.middleware.js";
import {
  createTask,
  getTaskBoard,
  updateTask,
  archiveTask,
  getTaskSource,
  getMyOpenTasks,
  completeTaskFromUser,
} from "../controllers/task.controller.js";
import {
  commitBulkTaskUpdate,
  previewBulkTaskUpdate,
  readBulkTaskOperation,
} from "../controllers/task-bulk.controller.js";

const router = express.Router();
const captureNoticeCases = captureOptionalFeatureFlag("noticeCases");

router.use(authRequired, requireFirmWriteAccess);

router.post("/", createTask);
router.get(
  "/board",
  requireFirmMember,
  captureNoticeCases,
  getTaskBoard
);
router.post(
  "/bulk/preview",
  requireFirmAdmin,
  previewBulkTaskUpdate
);
router.post(
  "/bulk/:operationId/commit",
  requireFirmAdmin,
  commitBulkTaskUpdate
);
router.get(
  "/bulk/:operationId",
  requireFirmAdmin,
  readBulkTaskOperation
);
router.patch("/:id", updateTask);
router.delete("/:id", archiveTask);

router.get(
  "/my-open",
  requireFirmMember,
  captureNoticeCases,
  getMyOpenTasks
);
router.get(
  "/:id",
  requireFirmMember,
  captureNoticeCases,
  getTaskSource
);
router.patch("/:id/complete-from-user", completeTaskFromUser);

export default router;
