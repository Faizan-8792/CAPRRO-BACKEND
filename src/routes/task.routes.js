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
  markTaskRead,
  getTaskHistory,
} from "../controllers/task.controller.js";
import {
  commitBulkTaskUpdate,
  previewBulkTaskUpdate,
  readBulkTaskOperation,
} from "../controllers/task-bulk.controller.js";

const router = express.Router();
const captureNoticeCases = captureOptionalFeatureFlag("noticeCases");

// requireFirmMember gates every task route, including the mutations, so an
// inactive firm or a removed membership is refused.
router.use(authRequired, requireFirmMember);

// ---------------------------------------------------------------------------
// ONE ROUTE SITS ABOVE THE WRITE GATE, and only this one.
//
// requireFirmWriteAccess refuses every mutating method for a read-only member.
// That is right for changing the firm's data and wrong for this: marking work
// as read is a RECEIPT for an assignment you were handed, not an edit. Any user
// in the firm can be an assignee - createTask validates only that the assignee
// is a User in the same firm, with no write-access requirement - so a read-only
// member can be given work and, under the blanket guard, could never say they
// had seen it.
//
// That was not a theoretical gap. The desktop shows "Mark as read" to the
// assignee without checking write access, on the stated reasoning that
// acknowledging your own work is not a write against the firm. So a read-only
// assignee had a button the server would refuse: an enabled control that does
// nothing, which is the exact defect class this workstream exists to remove.
// The administrator's side was worse - their "has he seen it?" answer would
// have read "Not opened yet" forever for that member, which is the oversight
// feature quietly lying.
//
// What this widens, exactly: markTaskRead finds the task with
// { _id, firmId, assignedTo: user.id }, so a read-only member can set
// assigneeReadAt on a task ALREADY ASSIGNED TO THEM and nothing else. It cannot
// touch status, title, dates, assignment, or another person's task, and it is
// idempotent. requireFirmMember above still refuses an inactive firm or a
// removed membership.
//
// Placed BEFORE the router.use below rather than after it: Express applies
// middleware in declaration order, so this is what exempts it. Route MATCHING
// is unaffected - "/:id" matches a single segment and never swallows
// "/:id/mark-read".
// ---------------------------------------------------------------------------
router.patch("/:id/mark-read", markTaskRead);

// Everything declared from here down also needs write access. Kept as a
// router.use rather than repeated per route so a task route added later
// inherits the guard instead of silently missing it - the failure mode of the
// per-route form is an unguarded mutation, which is the more dangerous way to
// be wrong.
router.use(requireFirmWriteAccess);

router.post("/", createTask);
// requireFirmMember already runs for every route in this router.
router.get("/board", captureNoticeCases, getTaskBoard);
router.post("/bulk/preview", requireFirmAdmin, previewBulkTaskUpdate);
router.post(
  "/bulk/:operationId/commit",
  requireFirmAdmin,
  commitBulkTaskUpdate,
);
router.get("/bulk/:operationId", requireFirmAdmin, readBulkTaskOperation);
router.patch("/:id", updateTask);
router.delete("/:id", archiveTask);

router.get("/my-open", captureNoticeCases, getMyOpenTasks);
router.get("/:id", captureNoticeCases, getTaskSource);
router.patch("/:id/complete-from-user", completeTaskFromUser);

// mark-read used to be declared here. It moved ABOVE the write gate - see the
// block near the top of this file for why. It is still assignee-only; that is
// enforced by the controller's own query, not by its position.

// Any member of the firm may read one task's history. That matches the board they can already
// see, so this exposes nothing that was hidden; the firm scoping is inside the handler.
router.get("/:id/history", getTaskHistory);

export default router;
