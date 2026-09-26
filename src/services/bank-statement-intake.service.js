// Safe, content-based intake for Phase-1 bank-statement PDFs.
//
// No statement text is persisted or logged here. The caller receives only the content hash,
// document metadata, per-page metrics, and a reason code. Parsing uses PDF.js with JavaScript
// evaluation disabled; route-level work must additionally put this operation in an isolated,
// network-disabled worker before any user-facing upload endpoint is enabled.

import { createHash } from "node:crypto";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";

export const BANK_STATEMENT_INTAKE_CODES = Object.freeze({
  INVALID_PDF: "R-01",
  FILE_LIMIT: "R-02",
  PASSWORD: "R-03",
  SCANNED: "R-04",
  GARBLED: "R-05",
  NOT_STATEMENT: "R-06",
  UNSAFE: "R-07",
});

export const BANK_STATEMENT_INTAKE_LIMITS = Object.freeze({
  maxBytes: 25 * 1024 * 1024,
  maxPages: 300,
  maxProcessingMs: 60_000,
  minTextCharactersPerPage: 20,
  maxGarbledRatio: 0.02,
});

function rejection(code, message, { pages = [], file = null } = {}) {
  return { accepted: false, status: "REJECTED", rejection: { code, message, pages }, file };
}

function safeMetadata(value) {
  return String(value ?? "").replace(/[\u0000-\u001F]/g, " ").slice(0, 500);
}

function remainingMs(startedAt, maxProcessingMs) {
  return maxProcessingMs - (Date.now() - startedAt);
}

function requireTime(startedAt, maxProcessingMs) {
  if (remainingMs(startedAt, maxProcessingMs) <= 0) {
    const error = new Error("PDF processing time limit exceeded");
    error.code = BANK_STATEMENT_INTAKE_CODES.UNSAFE;
    throw error;
  }
}

function hasPdfSignature(bytes) {
  return bytes.length >= 5 && Buffer.from(bytes.subarray(0, 5)).toString("ascii") === "%PDF-";
}

function containsActiveContent(bytes) {
  // These are PDF object names, not user-visible text. Reject rather than attempting to strip
  // active content: a transformed document can be invalid in a way that obscures the source.
  const raw = Buffer.from(bytes).toString("latin1");
  return /\/(?:JavaScript|JS|Launch|EmbeddedFile|RichMedia|XFA)\b/i.test(raw);
}

function isOcrProducer(info) {
  return /(?:\bocr\b|scan(?:ner)?|abbyy|camscanner|adobe scan)/i.test(`${info?.Producer ?? ""} ${info?.Creator ?? ""}`);
}

function countGarbledCharacters(text) {
  const privateUse = /[\uE000-\uF8FF]/g;
  const cidPlaceholders = /\(cid:\d+\)/gi;
  return (text.match(/\uFFFD/g) || []).length
    + (text.match(privateUse) || []).length
    + (text.match(cidPlaceholders) || []).join("").length;
}

function hasInvisibleText(operatorList) {
  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    if (operatorList.fnArray[index] !== OPS.setTextRenderingMode) continue;
    const mode = operatorList.argsArray[index]?.[0];
    if (mode === 3) return true; // PDF text render mode 3 = invisible.
  }
  return false;
}

function hasImagePaintOperation(operatorList) {
  return operatorList.fnArray.some((operation) => (
    operation === OPS.paintImageXObject ||
    operation === OPS.paintInlineImageXObject ||
    operation === OPS.paintJpegXObject
  ));
}

function pageMetrics(pageNumber, text, operatorList) {
  const characters = [...text].length;
  const garbledCharacters = countGarbledCharacters(text);
  return {
    page: pageNumber,
    textCharacters: characters,
    garbledCharacters,
    garbledRatio: characters ? garbledCharacters / characters : 0,
    hasDateLikeToken: /\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b|\b\d{1,2}\s+[A-Za-z]{3,9}\s+\d{2,4}\b/.test(text),
    hasAmountLikeToken: /(?:₹|\b(?:INR|Rs\.?)\s*)?\d[\d,]*(?:\.\d{1,2})?/.test(text),
    hasImage: hasImagePaintOperation(operatorList),
    hasInvisibleText: hasInvisibleText(operatorList),
  };
}

function hasTransactionTable(text) {
  const hasDateHeader = /\b(?:date|txn\s*date|transaction\s*date|post\s*date)\b/i.test(text);
  const hasFinancialHeader = /\b(?:debit|credit|withdrawal|deposit|amount|balance)\b/i.test(text);
  return hasDateHeader && hasFinancialHeader;
}

function pdfLoadOptions(input, password) {
  return {
    data: new Uint8Array(input),
    password: password || undefined,
    disableFontFace: true,
    useSystemFonts: true,
    isEvalSupported: false,
    stopAtErrors: true,
  };
}

/**
 * Inspect PDF bytes before any profile-specific parsing. The accepted result intentionally contains
 * no page text; the profile parser must re-read the in-memory bytes in its isolated worker.
 */
export async function inspectBankStatementPdf({ bytes, fileName = "", password = null, limits = {} } = {}) {
  const effectiveLimits = { ...BANK_STATEMENT_INTAKE_LIMITS, ...limits };
  const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  const file = {
    name: safeMetadata(fileName),
    size: input.length,
    sha256: createHash("sha256").update(input).digest("hex"),
  };
  if (!hasPdfSignature(input)) {
    return rejection(BANK_STATEMENT_INTAKE_CODES.INVALID_PDF, "This file is not a valid PDF document.", { file });
  }
  if (input.length > effectiveLimits.maxBytes) {
    return rejection(BANK_STATEMENT_INTAKE_CODES.FILE_LIMIT, "This PDF exceeds the supported file-size limit.", { file });
  }
  if (containsActiveContent(input)) {
    return rejection(BANK_STATEMENT_INTAKE_CODES.UNSAFE, "This PDF contains active content and cannot be processed safely.", { file });
  }

  const startedAt = Date.now();
  let loadingTask;
  let document;
  try {
    loadingTask = getDocument(pdfLoadOptions(input, password));
    document = await loadingTask.promise;
    requireTime(startedAt, effectiveLimits.maxProcessingMs);
    if (document.numPages > effectiveLimits.maxPages) {
      return rejection(BANK_STATEMENT_INTAKE_CODES.FILE_LIMIT, "This PDF exceeds the supported page limit.", { file });
    }

    const metadata = await document.getMetadata().catch(() => ({ info: {} }));
    const producer = safeMetadata(metadata.info?.Producer);
    const creator = safeMetadata(metadata.info?.Creator);
    if (isOcrProducer(metadata.info)) {
      return rejection(BANK_STATEMENT_INTAKE_CODES.SCANNED, "This PDF appears to contain OCR-derived text, which is not supported in Phase 1.", { file });
    }

    const pages = [];
    let transactionTableFound = false;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      requireTime(startedAt, effectiveLimits.maxProcessingMs);
      const page = await document.getPage(pageNumber);
      const [content, operatorList] = await Promise.all([page.getTextContent(), page.getOperatorList()]);
      const text = content.items.map((item) => item.str).join(" ");
      const metrics = pageMetrics(pageNumber, text, operatorList);
      pages.push(metrics);
      transactionTableFound ||= hasTransactionTable(text);

      // Without an approved profile we cannot prove an image-only page is a known cover/terms
      // page, so safely reject it rather than silently skipping a possible transaction page.
      if (metrics.textCharacters < effectiveLimits.minTextCharactersPerPage || metrics.hasInvisibleText) {
        return rejection(BANK_STATEMENT_INTAKE_CODES.SCANNED, "A page is image-only or has no usable visible text.", { pages: [pageNumber], file });
      }
      if (metrics.garbledRatio > effectiveLimits.maxGarbledRatio || (metrics.hasDateLikeToken || metrics.hasAmountLikeToken) && metrics.garbledCharacters > 0) {
        return rejection(BANK_STATEMENT_INTAKE_CODES.GARBLED, "A page contains garbled or materially incomplete text.", { pages: [pageNumber], file });
      }
    }
    if (!transactionTableFound) {
      return rejection(BANK_STATEMENT_INTAKE_CODES.NOT_STATEMENT, "No readable transaction table with a Date and financial column was found.", { file });
    }
    return {
      accepted: true,
      status: "READY_FOR_LAYOUT_DETECTION",
      file: { ...file, pageCount: document.numPages, producer, creator },
      pages,
    };
  } catch (error) {
    if (error?.code === BANK_STATEMENT_INTAKE_CODES.UNSAFE) {
      return rejection(BANK_STATEMENT_INTAKE_CODES.UNSAFE, "This PDF could not be processed within the configured safety limits.", { file });
    }
    if (error?.name === "PasswordException") {
      return rejection(BANK_STATEMENT_INTAKE_CODES.PASSWORD, "This PDF needs a valid password before it can be read.", { file });
    }
    return rejection(BANK_STATEMENT_INTAKE_CODES.INVALID_PDF, "This PDF is corrupt, truncated, or cannot be read safely.", { file });
  } finally {
    await document?.destroy?.();
    await loadingTask?.destroy?.();
  }
}

/**
 * Rebuilds the visual reading order from PDF coordinates instead of trusting the content stream.
 * It returns an in-memory view only; callers must not log or persist this raw statement text outside
 * the approved encrypted statement store and review/audit boundary.
 */
export function orderBankStatementTextItems(items, { lineTolerance = 2 } = {}) {
  const positioned = (items || [])
    .filter((item) => String(item?.text ?? "").trim() !== "")
    .map((item, index) => ({ ...item, text: String(item.text), _index: index }))
    .sort((left, right) => right.y - left.y || left.x - right.x || left._index - right._index);
  const lines = [];
  for (const item of positioned) {
    const line = lines.find((candidate) => Math.abs(candidate.y - item.y) <= lineTolerance);
    if (line) line.items.push(item);
    else lines.push({ y: item.y, items: [item] });
  }
  return lines
    .sort((left, right) => right.y - left.y)
    .flatMap((line, lineIndex) => line.items.sort((left, right) => left.x - right.x || left._index - right._index)
      .map((item, itemIndex) => ({
        text: item.text,
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
        line: lineIndex,
        position: itemIndex,
      })));
}

/**
 * Re-opens an accepted in-memory PDF and exposes positional text only to the next profile parser.
 * This is intentionally not an HTTP endpoint. The final upload route must execute this in the
 * network-disabled process boundary named in PLAN.md before it can call this helper.
 */
export async function extractBankStatementTextPositions({ bytes, fileName = "", password = null, limits = {} } = {}) {
  const intake = await inspectBankStatementPdf({ bytes, fileName, password, limits });
  if (!intake.accepted) return intake;
  const effectiveLimits = { ...BANK_STATEMENT_INTAKE_LIMITS, ...limits };
  const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  const startedAt = Date.now();
  let loadingTask;
  let document;
  try {
    loadingTask = getDocument(pdfLoadOptions(input, password));
    document = await loadingTask.promise;
    const pages = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      requireTime(startedAt, effectiveLimits.maxProcessingMs);
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const items = orderBankStatementTextItems(content.items.map((item) => ({
        text: item.str,
        x: Number(item.transform?.[4] ?? 0),
        y: Number(item.transform?.[5] ?? 0),
        width: Number(item.width ?? 0),
        height: Number(item.height ?? 0),
      })));
      pages.push({ page: pageNumber, items });
    }
    return { ...intake, pages };
  } catch (error) {
    return rejection(BANK_STATEMENT_INTAKE_CODES.INVALID_PDF, "This PDF could not be read safely for layout parsing.", { file: intake.file });
  } finally {
    await document?.destroy?.();
    await loadingTask?.destroy?.();
  }
}
