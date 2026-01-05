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

router.post("/document-requests", createDocumentRequest);
router.get("/document-requests", listDocumentRequests);
router.patch("/document-requests/:id", updateDocumentRequest);
router.get("/document-requests/pending-summary", pendingSummary);

export default router;
