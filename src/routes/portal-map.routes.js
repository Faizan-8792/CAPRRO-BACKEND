import express from "express";
import { authRequired } from "../middleware/auth.middleware.js";
import { getLatestPortalMap, getPortalMapVersion } from "../controllers/portal-map.controller.js";

// The GST downloader's signed portal map (GD28): signed-in reads only (OD8). Publishing is
// POST /api/super/gst-portal-map, behind the super-admin guards.
const router = express.Router();

router.get("/latest", authRequired, getLatestPortalMap);
router.get("/:version", authRequired, getPortalMapVersion);

export default router;
