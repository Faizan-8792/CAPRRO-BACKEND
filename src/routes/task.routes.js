import express from "express";
import { authRequired } from "../middleware/auth.middleware.js";
import {
  createClient,
  listClients,
  getChecklist,
  saveChecklist,
  deleteClient
} from "../controllers/taxwork.controller.js";

const router = express.Router();

router.post("/client", authRequired, createClient);
router.get("/client/:service", authRequired, listClients);
router.get("/:clientId/checklist", authRequired, getChecklist);
router.post("/:clientId/save", authRequired, saveChecklist);
router.delete("/client/:clientId", authRequired, deleteClient);

export default router;
