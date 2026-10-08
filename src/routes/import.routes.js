import { Router } from "express";
import {
  commitMappedGstImport,
  commitMappedTdsImport,
  convertGstr2bImport,
  previewMappedImport,
  suggestImportMappingForFile,
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

const router = Router();
const requireGstReconciliation = requireFeatureFlag("gstReconciliation");
const requireTdsHealth = requireFeatureFlag("tdsHealth");

function requireImportPreviewFeature(req, res, next) {
  const kind = String(req.body?.kind || "").toUpperCase();
  if (GST_IMPORT_KINDS.includes(kind)) {
    return requireGstReconciliation(req, res, next);
  }
  if (TDS_IMPORT_KINDS.includes(kind)) {
    return requireTdsHealth(req, res, next);
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
router.post("/gstr2b/convert", requireGstReconciliation, convertGstr2bImport);
router.post("/:sourceHash/tds-commit", requireTdsHealth, commitMappedTdsImport);
router.get("/tds/:id/errors", requireTdsHealth, showTdsImportErrors);
router.get("/tds/:id", requireTdsHealth, showTdsImportBatch);
router.post("/:sourceHash/commit", requireGstReconciliation, commitMappedGstImport);
router.get("/:id/errors", requireGstReconciliation, showGstImportErrors);
router.get("/:id", requireGstReconciliation, showGstImportBatch);

export default router;
