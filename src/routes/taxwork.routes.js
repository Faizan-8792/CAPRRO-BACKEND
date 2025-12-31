import express from "express";
import { authRequired } from "../middleware/auth.middleware.js";
import {
  getTaxWork,
  saveTaxWork,
  createClient,
  listClients,
  deleteClient,
  saveClientChecklist
} from "../controllers/taxwork.controller.js";

const router = express.Router();

// Existing routes
router.get("/:service", authRequired, getTaxWork);
router.post("/", authRequired, saveTaxWork);

// ADD NEW ROUTES
router.post("/client", authRequired, createClient);
router.get("/clients/:service", authRequired, listClients);
router.delete("/client/:id", authRequired, deleteClient);
router.post("/client/:id", authRequired, saveClientChecklist);

export default router;