import { Router } from "express";
import { sendOtp, verifyOtpAndLogin, getMe } from "../controllers/auth.controller.js";
import { authRequired } from "../middleware/auth.middleware.js";

const router = Router();

router.post("/send-otp", sendOtp);
router.post("/verify-otp", verifyOtpAndLogin);
router.get("/me", authRequired, getMe);

export default router;
