import { Router } from "express";
import rateLimit from "express-rate-limit";
import {
  getDigestInbox,
  readAllDigestInboxItems,
  getDigestPreview,
  getDigestUnsubscribePreview,
  patchDigestPreferences,
  patchFirmDigestSettings,
  postDigestUnsubscribe,
  readDigestInboxItem,
  readDigestPreferences,
} from "../controllers/digest.controller.js";
import { authRequired } from "../middleware/auth.middleware.js";
import {
  requireFirmAdmin,
  requireFirmMember,
} from "../middleware/authorization.middleware.js";
import { captureOptionalFeatureFlag } from "../middleware/rollout.middleware.js";

const router = Router();
const captureDaily = captureOptionalFeatureFlag("dailyDigest");
const captureWeekly = captureOptionalFeatureFlag("weeklySummary");
const captureNoticeCases = captureOptionalFeatureFlag("noticeCases");

// Generous but bounded - this is a public, unauthenticated route reachable by
// anyone who has ever received a digest email (or guesses the shape of the
// link), so it needs its own limiter independent of a signed-in caller's
// identity. 30/15min per IP comfortably covers a real recipient clicking a
// link, reloading the confirmation page, and confirming, while still
// bounding a token-guessing attempt (which the HMAC signature itself
// already defeats, but rate limiting slows any attempt down further).
const unsubscribeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many requests. Try again in 15 minutes." },
});

// Public, no-login unsubscribe (RFC 8058 / CAN-SPAM) - mounted ABOVE the
// blanket auth gate below, following the same "public routes first" shape
// auth.routes.js uses for its own pre-login endpoints. The recipient's
// identity and authority to act come entirely from the signed token in the
// request, never from a session.
router.get("/unsubscribe", unsubscribeLimiter, getDigestUnsubscribePreview);
router.post("/unsubscribe", unsubscribeLimiter, postDigestUnsubscribe);

router.use(authRequired, requireFirmMember);
router.get("/preferences", readDigestPreferences);
router.patch("/preferences", patchDigestPreferences);
router.patch("/settings", requireFirmAdmin, patchFirmDigestSettings);
router.get(
  "/preview",
  captureDaily,
  captureWeekly,
  captureNoticeCases,
  getDigestPreview,
);
router.get("/inbox", getDigestInbox);
router.post("/inbox/:deliveryId/read", readDigestInboxItem);

// Mark the whole inbox read in one call. No extra middleware on purpose: a bulk action must not
// be gated more tightly than the per-row action it saves the person repeating, and the service
// applies the same recipient and weekly-authorisation narrowing that the single-row path does.
// "read-all" cannot be captured by :deliveryId - that route ends in /read and this one does not.
router.post("/inbox/read-all", readAllDigestInboxItems);

export default router;
