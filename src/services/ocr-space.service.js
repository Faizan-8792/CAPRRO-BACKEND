import { hashText, httpError, MAX_SOURCE_TEXT } from "./case-validation.service.js";
import ProviderUsage from "../models/ProviderUsage.js";

const OCR_SPACE_URL = "https://api.ocr.space/parse/image";
const OCR_MAX_BYTES = 8 * 1024 * 1024;
const OCR_MIME_TYPES = new Set(["application/pdf", "image/png", "image/jpeg"]);

// O10 spend meter/cap. extractTextWithOcrSpace is the one choke point every caller funnels
// through (there is only one today: POST /api/cases/ocr), so this is where OCR volume is bounded.
//
// OWNER POLICY, 2026-08-28, AUTHORITATIVE: **300 OCR calls per single user per WEEK.**
// Per-user, not per-firm and not shared. The known provider allowance is 3,000 free OCR
// requests. No rupee cost is stated anywhere, because none has been verified.
//
// Why the previous per-user caps were REMOVED rather than kept alongside this one. They were
// 25/day and 300/month, and both silently contradicted the policy:
//   * 25/day allows at most 175 in a week -- a user could never reach 300, so the stated limit
//     would have been a number that never applied.
//   * 300/month allows 300 in the first week and nothing for the rest of the month, so from
//     week two the weekly cap would again never be reachable.
// Keeping either would have meant the documented limit and the enforced limit disagreeing, which
// is the exact defect class this codebase treats as a release blocker. The weekly cap is now the
// single per-user control, and it is the ONLY one, so 300/week means 300/week.
//
// A single user therefore cannot consume unlimited OCR: the weekly tier is checked and
// atomically incremented BEFORE the paid call, on a compound-unique-indexed counter, so
// concurrent requests cannot race past it (proved in tests/provider-quota-contract.mjs).
//
// The global daily ceiling is a separate, provider-wide backstop and is deliberately left
// unchanged -- it bounds total volume regardless of how many accounts sign up, which is a
// different job from bounding one account. See the runbook for the arithmetic relating it to the
// 3,000 free allowance.
const OCR_WEEKLY_CALL_CAP_PER_USER =
  Number(process.env.OCR_SPACE_WEEKLY_CALL_CAP_PER_USER) || 300;
const OCR_GLOBAL_DAILY_CALL_CAP =
  Number(process.env.OCR_SPACE_GLOBAL_DAILY_CALL_CAP) || 600;

async function extractTextWithOcrSpace({ buffer, mimeType, fileName, consent, userId }) {
  if (consent !== true) {
    throw httpError(400, "Explicit consent is required before sending a file to OCR.space", "OCR_CONSENT_REQUIRED");
  }
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw httpError(400, "OCR file is required", "OCR_FILE_REQUIRED");
  }
  if (buffer.length > OCR_MAX_BYTES) {
    throw httpError(413, "OCR file exceeds the 8 MiB limit", "OCR_FILE_TOO_LARGE");
  }
  if (!OCR_MIME_TYPES.has(mimeType)) {
    throw httpError(415, "OCR accepts PDF, PNG, or JPEG files only", "OCR_TYPE_UNSUPPORTED");
  }
  const apiKey = process.env.OCR_SPACE_API_KEY;
  if (!apiKey) {
    throw httpError(503, "OCR provider is not configured", "OCR_PROVIDER_UNAVAILABLE");
  }
  // Required, not optional: a required parameter means a NEW call site added
  // later cannot run without deciding whose usage this call is billed against,
  // so it cannot silently escape metering the way an optional param could. This
  // should never actually trigger from a correct call site, so it deliberately
  // does NOT get its own OCR_* public code (default httpError code applies) --
  // it is an internal assertion, not a real user-reachable scenario.
  if (!userId) {
    throw httpError(500, "extractTextWithOcrSpace requires userId for provider-usage metering");
  }
  // Quota check happens BEFORE the paid call. reserveProviderCall only keeps an
  // increment once every tier (here: per-user weekly, then provider-wide daily)
  // clears, so a refused call is never counted, and an attempted one always is
  // regardless of whether the fetch below ultimately succeeds.
  //
  // No dailyCapPerUser and no monthlyCapPerUser are passed, deliberately: both
  // would bind BEFORE the owner's 300/week could ever be reached (see the policy
  // note at the top of this file). Omitting them is what makes the documented
  // limit and the enforced limit the same number.
  const reservation = await ProviderUsage.reserveProviderCall({
    userId,
    provider: "OCR_SPACE",
    weeklyCapPerUser: OCR_WEEKLY_CALL_CAP_PER_USER,
    globalDailyCap: OCR_GLOBAL_DAILY_CALL_CAP,
  });
  if (!reservation.allowed) {
    throw httpError(429, reservation.reason, "OCR_QUOTA_EXCEEDED");
  }

  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mimeType }), String(fileName || "notice-file").slice(0, 240));
  form.append("language", "eng");
  form.append("isOverlayRequired", "false");
  form.append("detectOrientation", "true");
  form.append("scale", "true");
  form.append("OCREngine", "2");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(OCR_SPACE_URL, {
      method: "POST",
      headers: { apikey: apiKey },
      body: form,
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.text().catch(() => "");
      throw httpError(502, `OCR provider returned HTTP ${response.status}`, "OCR_PROVIDER_ERROR");
    }
    const payload = await response.json().catch(() => null);
    if (!payload || payload.IsErroredOnProcessing === true) {
      throw httpError(502, "OCR provider could not process this file", "OCR_PROCESSING_FAILED");
    }
    const text = (payload.ParsedResults || [])
      .map((item) => (typeof item?.ParsedText === "string" ? item.ParsedText : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
    if (!text) throw httpError(422, "OCR returned no readable text", "OCR_NO_TEXT");
    if (text.length > MAX_SOURCE_TEXT) {
      throw httpError(422, "OCR text exceeds the 250,000 character case limit", "OCR_TEXT_TOO_LARGE");
    }
    return {
      text,
      textHash: hashText(text),
      provider: "OCR_SPACE",
      providerEngine: "2",
      processedAt: new Date().toISOString(),
      binaryStored: false,
    };
  } catch (error) {
    if (error?.statusCode) throw error;
    if (error?.name === "AbortError") {
      throw httpError(504, "OCR provider timed out", "OCR_TIMEOUT");
    }
    throw httpError(502, "OCR provider request failed", "OCR_PROVIDER_ERROR");
  } finally {
    clearTimeout(timer);
  }
}

export { OCR_MAX_BYTES, OCR_MIME_TYPES, extractTextWithOcrSpace };
