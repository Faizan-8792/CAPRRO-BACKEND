import express from "express";
import { authRequired } from "../middleware/auth.middleware.js";
import {
  getTaxWork,
  saveTaxWork
} from "../controllers/taxwork.controller.js";

const router = express.Router();

router.get("/:service", authRequired, getTaxWork);
router.post("/", authRequired, saveTaxWork);

export default router;
