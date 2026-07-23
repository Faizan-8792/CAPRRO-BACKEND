import { Router } from "express";
import { authRequired } from "../middleware/auth.middleware.js";
import {
  requireFirmAdmin,
  requireFirmMember,
  requireSuperAdmin,
} from "../middleware/authorization.middleware.js";
import {
  captureOptionalFeatureFlag,
  requireFeatureFlag,
} from "../middleware/rollout.middleware.js";
import {
  confirmComplianceGeneration,
  previewComplianceGeneration,
} from "../controllers/compliance-generation.controller.js";
import { getComplianceCalendar } from "../controllers/workspace.controller.js";
import {
  activateComplianceRule,
  createComplianceRule,
  deleteComplianceOverride,
  getClientComplianceProfile,
  listActiveComplianceRules,
  listComplianceOverrides,
  listManagedComplianceRules,
  retireComplianceRule,
  reviewComplianceRule,
  submitComplianceRuleForReview,
  updateClientComplianceProfile,
  updateComplianceRule,
  upsertComplianceOverride,
} from "../controllers/compliance.controller.js";

const router = Router();
const complianceProfileEnabled = requireFeatureFlag(
  "clientComplianceProfile"
);
const fullTabWorkspaceEnabled = requireFeatureFlag("fullTabWorkspace");
const homeWorkspaceEnabled = requireFeatureFlag("homeWorkspace");
const captureNoticeCases = captureOptionalFeatureFlag("noticeCases");

router.use(authRequired);

router.get(
  "/calendar",
  requireFirmMember,
  fullTabWorkspaceEnabled,
  homeWorkspaceEnabled,
  captureNoticeCases,
  getComplianceCalendar
);

router.get(
  "/rules",
  requireFirmMember,
  complianceProfileEnabled,
  listActiveComplianceRules
);
router.get(
  "/clients/:clientId/profile",
  requireFirmMember,
  complianceProfileEnabled,
  getClientComplianceProfile
);
router.put(
  "/clients/:clientId/profile",
  requireFirmAdmin,
  complianceProfileEnabled,
  updateClientComplianceProfile
);
router.get(
  "/overrides",
  requireFirmMember,
  complianceProfileEnabled,
  listComplianceOverrides
);
router.put(
  "/overrides",
  requireFirmAdmin,
  complianceProfileEnabled,
  upsertComplianceOverride
);
router.delete(
  "/overrides/:overrideId",
  requireFirmAdmin,
  complianceProfileEnabled,
  deleteComplianceOverride
);
router.post(
  "/generation/preview",
  requireFirmAdmin,
  complianceProfileEnabled,
  previewComplianceGeneration
);
router.post(
  "/generation/confirm",
  requireFirmAdmin,
  complianceProfileEnabled,
  confirmComplianceGeneration
);

router.use("/governance", requireSuperAdmin);
router.get("/governance/rules", listManagedComplianceRules);
router.post("/governance/rules", createComplianceRule);
router.patch("/governance/rules/:ruleId", updateComplianceRule);
router.post(
  "/governance/rules/:ruleId/submit-review",
  submitComplianceRuleForReview
);
router.post("/governance/rules/:ruleId/review", reviewComplianceRule);
router.post("/governance/rules/:ruleId/activate", activateComplianceRule);
router.post("/governance/rules/:ruleId/retire", retireComplianceRule);

export default router;
