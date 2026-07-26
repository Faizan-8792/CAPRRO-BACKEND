import { Router } from "express";
import {
  commitMappedGstImport,
  commitMappedTdsImport,
  convertGstr2bImport,
  previewMappedImport,
  showGstImportBatch,
  showGstImportErrors,
  showTdsImportBatch,
  showTdsImportErrors,
} from "../controllers/import.controller.js";
import {
  authRequiredWithoutUsageTracking,
} from "../middleware/auth.middleware.js";
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

router.use(authRequiredWithoutUsageTracking, requireFirmMember, requireFirmWriteAccess);
router.post("/preview", requireImportPreviewFeature, previewMappedImport);
router.post("/gstr2b/convert", requireGstReconciliation, convertGstr2bImport);
router.post("/:sourceHash/tds-commit", requireTdsHealth, commitMappedTdsImport);
router.get("/tds/:id/errors", requireTdsHealth, showTdsImportErrors);
router.get("/tds/:id", requireTdsHealth, showTdsImportBatch);
router.post("/:sourceHash/commit", requireGstReconciliation, commitMappedGstImport);
router.get("/:id/errors", requireGstReconciliation, showGstImportErrors);
router.get("/:id", requireGstReconciliation, showGstImportBatch);

export default router;
