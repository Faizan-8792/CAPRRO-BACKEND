import { Router } from "express";
import multer from "multer";
import {
  confirmFields,
  createCase,
  createResponseDraft,
  createSubmissionRecord,
  createTimelineEntry,
  decideDraftReview,
  exportCase,
  finalizeResponseDraft,
  generateAnalysis,
  listCases,
  patchCase,
  previewCaseOcr,
  proposeCaseFields,
  sendDraftForReview,
  showCase,
  verifyReference,
} from "../controllers/case.controller.js";
import {
  authRequired,
  authRequiredWithoutUsageTracking,
} from "../middleware/auth.middleware.js";
import {
  requireFirmMember,
  requireFirmWriteAccess,
} from "../middleware/authorization.middleware.js";
import { requireFeatureFlag } from "../middleware/rollout.middleware.js";
import {
  OCR_MAX_BYTES,
  OCR_MIME_TYPES,
} from "../services/ocr-space.service.js";

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: OCR_MAX_BYTES, files: 1, fields: 5 },
  fileFilter: (_req, file, callback) => {
    if (!OCR_MIME_TYPES.has(file.mimetype)) {
      const error = new Error("OCR accepts PDF, PNG, or JPEG files only");
      error.statusCode = 415;
      // multer passes a fileFilter error through unwrapped (make-middleware.js
      // abortWithError -> next(err)), so this is a plain Error with no `code`.
      // Without a code the global handler cannot treat the message as public and
      // production answered the catch-all "The request could not be completed."
      // -- which never tells the user that only PDF, PNG and JPEG are accepted.
      // The same rejection inside ocr-space.service.js is unreachable over HTTP
      // because this filter runs first, so the code has to be set here.
      error.code = "OCR_TYPE_UNSUPPORTED";
      return callback(error);
    }
    return callback(null, true);
  },
});

router.post(
  "/ocr",
  authRequiredWithoutUsageTracking,
  requireFirmMember,
  requireFeatureFlag("noticeCases"),
  upload.single("file"),
  previewCaseOcr,
);

router.use(
  authRequired,
  requireFirmMember,
  requireFirmWriteAccess,
  requireFeatureFlag("noticeCases"),
);
router.post("/", createCase);
router.get("/", listCases);
router.get("/:id/export", exportCase);
router.get("/:id", showCase);
router.patch("/:id", patchCase);
router.post("/:id/extraction", proposeCaseFields);
router.patch("/:id/confirmations", confirmFields);
router.post("/:id/timeline", createTimelineEntry);
router.post("/:id/references", verifyReference);
router.post("/:id/analyses", generateAnalysis);
router.post("/:id/drafts", createResponseDraft);
router.post("/:id/drafts/:draftId/submit-review", sendDraftForReview);
router.post("/:id/drafts/:draftId/review", decideDraftReview);
router.post("/:id/drafts/:draftId/finalize", finalizeResponseDraft);
router.post("/:id/submissions", createSubmissionRecord);

export default router;
