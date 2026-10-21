import { Router } from "express";
import {
  commitMappedBooksImport,
  commitMappedGstImport,
  commitMappedTdsImport,
  convertGstr2bImport,
  showBooksImportBatch,
  previewMappedImport,
  suggestImportMappingForFile,
  suggestImportMappingWithModel,
  showGstImportBatch,
  showGstImportErrors,
  showTdsImportBatch,
  showTdsImportErrors,
} from "../controllers/import.controller.js";
import {
  authRequiredWithoutUsageTracking,
} from "../middleware/auth.middleware.js";
import { trackWorkflow } from "../middleware/workflow-usage.middleware.js";
import {
  requireFirmMember,
  requireFirmWriteAccess,
} from "../middleware/authorization.middleware.js";
import { requireFeatureFlag } from "../middleware/rollout.middleware.js";
import { GST_IMPORT_KINDS } from "../models/ImportRow.js";
import { TDS_IMPORT_KINDS } from "../models/TdsImportRow.js";
import { BOOKS_IMPORT_KINDS } from "../models/BooksImportRow.js";

const router = Router();
const requireGstReconciliation = requireFeatureFlag("gstReconciliation");
const requireTdsHealth = requireFeatureFlag("tdsHealth");
// W10 AP5: the trial balance belongs to the audit packs and is switched on with them.
const requireAuditPacks = requireFeatureFlag("auditPacks");

function requireImportPreviewFeature(req, res, next) {
  const kind = String(req.body?.kind || "").toUpperCase();
  if (GST_IMPORT_KINDS.includes(kind)) {
    return requireGstReconciliation(req, res, next);
  }
  if (TDS_IMPORT_KINDS.includes(kind)) {
    return requireTdsHealth(req, res, next);
  }
  if (BOOKS_IMPORT_KINDS.includes(kind)) {
    return requireAuditPacks(req, res, next);
  }
  return next();
}

// Part 3 (IMPROVEMENT-PLAN-V2-2026-09-28): the per-workflow tracker replaces this
// router's blanket usage invisibility — imports record {workflow, client, outcome}
// counters and nothing else; the auth path stays write-free as its contract requires.
router.use(
  authRequiredWithoutUsageTracking,
  requireFirmMember,
  requireFirmWriteAccess,
  trackWorkflow("import"),
);
router.post("/preview", requireImportPreviewFeature, previewMappedImport);
// Same feature gate and the same firm-write authorization as a preview: it reads a file the
// caller supplied and returns nothing about any stored record, but it is still import work.
router.post("/suggest-mapping", requireImportPreviewFeature, suggestImportMappingForFile);
// W11 IN15: suggested mappings for unrecognised headings, from the headings and column types alone.
router.post("/mapping-suggestions", requireImportPreviewFeature, requireFeatureFlag("intelligence"), suggestImportMappingWithModel);
router.post("/gstr2b/convert", requireGstReconciliation, convertGstr2bImport);
router.post("/:sourceHash/books-commit", requireAuditPacks, commitMappedBooksImport);
router.get("/books/:id", requireAuditPacks, showBooksImportBatch);
router.post("/:sourceHash/tds-commit", requireTdsHealth, commitMappedTdsImport);
router.get("/tds/:id/errors", requireTdsHealth, showTdsImportErrors);
router.get("/tds/:id", requireTdsHealth, showTdsImportBatch);
router.post("/:sourceHash/commit", requireGstReconciliation, commitMappedGstImport);
router.get("/:id/errors", requireGstReconciliation, showGstImportErrors);
router.get("/:id", requireGstReconciliation, showGstImportBatch);

export default router;
