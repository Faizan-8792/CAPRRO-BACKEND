import express from "express";
import auth from "../middleware/auth.middleware.js";
import {
  getTaxWork,
  saveTaxWork
} from "../controllers/taxwork.controller.js";

const router = express.Router();

router.get("/:service", auth, getTaxWork);
router.post("/", auth, saveTaxWork);

export default router;
