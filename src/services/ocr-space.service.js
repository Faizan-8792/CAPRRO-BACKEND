import { hashText, httpError, MAX_SOURCE_TEXT } from "./case-validation.service.js";

const OCR_SPACE_URL = "https://api.ocr.space/parse/image";
const OCR_MAX_BYTES = 8 * 1024 * 1024;
const OCR_MIME_TYPES = new Set(["application/pdf", "image/png", "image/jpeg"]);

async function extractTextWithOcrSpace({ buffer, mimeType, fileName, consent }) {
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
