import express from "express";
import { authRequired } from "../middleware/auth.middleware.js";
import {
  createDocumentRequest,
  listDocumentRequests,
  updateDocumentRequest,
  pendingSummary,
} from "../controllers/documentRequest.controller.js";

const router = express.Router();
router.use(authRequired);

router.post("/", createDocumentRequest);
router.get("/", listDocumentRequests);
router.patch("/:id", updateDocumentRequest);
router.get("/pending-summary", pendingSummary);

export default router;
