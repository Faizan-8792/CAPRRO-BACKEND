import express from "express";
import { authRequired } from "../middleware/auth.middleware.js";
import {
  createAccountingRecord,
  listAccountingRecords,
  getAccountingRecord,
  deleteAccountingRecord,
} from "../controllers/accounting.controller.js";

const router = express.Router();

router.use(authRequired);

router.post("/", createAccountingRecord);
router.get("/", listAccountingRecords);
router.get("/:id", getAccountingRecord);
router.delete("/:id", deleteAccountingRecord);

export default router;
