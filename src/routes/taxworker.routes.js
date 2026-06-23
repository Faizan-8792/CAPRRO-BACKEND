// src/routes/taxworker.routes.js
import { Router } from "express";
import { authRequired } from "../middleware/auth.middleware.js";
import {
  getTemplates,
  listClients,
  createClient,
  updateClient,
  deleteClient,
  listSessions,
  getSession,
  createSession,
  updateSession,
  updateDocument,
  addCustomDocument,
  removeCustomDocument,
  deleteSession,
  getStats,
} from "../controllers/taxworker.controller.js";

const router = Router();

router.use(authRequired);

// Templates catalog
router.get("/templates", getTemplates);

// Clients
router.get("/clients", listClients);
router.post("/clients", createClient);
router.patch("/clients/:id", updateClient);
router.delete("/clients/:id", deleteClient);

// Sessions
router.get("/sessions", listSessions);
router.get("/sessions/:id", getSession);
router.post("/sessions", createSession);
router.patch("/sessions/:id", updateSession);
router.delete("/sessions/:id", deleteSession);

// Documents inside session
router.patch("/sessions/:id/documents/:docKey", updateDocument);
router.post("/sessions/:id/documents", addCustomDocument);
router.delete("/sessions/:id/documents/:docKey", removeCustomDocument);

// Stats
router.get("/stats", getStats);

export default router;
