import crypto from "crypto";
import mongoose from "mongoose";
import { parseStatutoryDayIso } from "./robust-normalize.service.js";

const MAX_SOURCE_TEXT = 250000;
const DATE_FIELDS = new Set([
  "issueDate",
  "receivedDate",
  "responseDueDate",
  "hearingDate",
  "limitationDate",
]);
const AMOUNT_FIELDS = new Set(["demandMinor", "disputedMinor"]);
const ARRAY_FIELDS = new Set(["requestedDocuments"]);
const MUTATION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,119}$/;

function httpError(statusCode, message, code = "CASE_VALIDATION_ERROR") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function boundedText(value, max, { required = false, label = "Value" } = {}) {
  if (value == null) {
    if (required) throw httpError(400, `${label} is required`);
    return "";
  }
  if (typeof value !== "string") throw httpError(400, `${label} must be text`);
  const normalized = value.trim();
  if (required && !normalized) throw httpError(400, `${label} is required`);
  if (normalized.length > max) throw httpError(400, `${label} exceeds ${max} characters`);
  return normalized;
}

function mutationKey(value, { required = true } = {}) {
  const normalized = boundedText(value, 120, {
    required,
    label: "mutationKey",
  });
  if (!normalized) return "";
  if (!MUTATION_KEY_PATTERN.test(normalized)) {
    throw httpError(
      400,
      "mutationKey must be 8-120 characters using letters, numbers, dot, underscore, colon, or hyphen",
      "INVALID_MUTATION_KEY"
    );
  }
  return normalized;
}

function mutationRequestHash(action, input) {
  const payload = input && typeof input === "object" && !Array.isArray(input)
    ? { ...input }
    : {};
  delete payload.mutationKey;
  return hashText(stableJson({ action: String(action || ""), payload }));
}

function assertMutationRequestHash(existingHash, requestHash) {
  if (!existingHash || existingHash !== requestHash) {
    throw httpError(
      409,
      "mutationKey was already used with a different request payload",
      "MUTATION_KEY_REUSED"
    );
  }
}

function objectId(value, label = "ID") {
  const normalized = String(value || "").trim();
  if (!mongoose.isValidObjectId(normalized)) {
    throw httpError(400, `${label} is invalid`);
  }
  return normalized;
}

function parseDateValue(value, label, { required = false } = {}) {
  if (value == null || value === "") {
    if (required) throw httpError(400, `${label} is required`);
    return null;
  }
  // Strict on purpose: new Date('05-03-2026') silently reads as month-first (3 May, not
  // 5 March), and this gates issueDate/receivedDate/responseDueDate/hearingDate/
  // limitationDate -- getting one wrong can mean a missed statutory deadline. See
  // parseStatutoryDayIso's own remarks in robust-normalize.service.js.
  try {
    return parseStatutoryDayIso(value, label);
  } catch (error) {
    throw httpError(error.statusCode || 400, error.message);
  }
}

function parseSafeMinor(value, label) {
  if (value == null || value === "") return null;
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw httpError(400, `${label} must be a non-negative safe integer in minor units`);
  }
  return amount;
}

function boundedStringArray(value, label, { maxItems = 100, maxLength = 500 } = {}) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw httpError(400, `${label} must be an array`);
  if (value.length > maxItems) throw httpError(400, `${label} exceeds ${maxItems} items`);
  return [...new Set(value.map((item) => boundedText(item, maxLength, { label })).filter(Boolean))];
}

function normalizeOffsets(value, fallback = [-15, -7, -2, 0]) {
  const source = value == null ? fallback : value;
  if (!Array.isArray(source)) throw httpError(400, "reminderOffsets must be an array");
  const values = [...new Set(source.map(Number))].sort((a, b) => a - b);
  if (
    !values.length ||
    values.length > 20 ||
    values.some((item) => !Number.isInteger(item) || item < -365 || item > 365)
  ) {
    throw httpError(400, "Reminder offsets must contain 1-20 whole days between -365 and 365");
  }
  return values;
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value instanceof Date ? value.toISOString() : value);
}

function normalizeConfirmedValue(field, value) {
  if (DATE_FIELDS.has(field)) return parseDateValue(value, field, { required: true });
  if (AMOUNT_FIELDS.has(field)) {
    const amount = parseSafeMinor(value, field);
    if (amount == null) throw httpError(400, `${field} is required`);
    return amount;
  }
  if (ARRAY_FIELDS.has(field)) {
    let arrayValue = value;
    if (typeof value === "string") {
      try {
        arrayValue = JSON.parse(value);
      } catch {
        arrayValue = value.split(/\r?\n|;/).map((item) => item.trim()).filter(Boolean);
      }
    }
    return boundedStringArray(arrayValue, field);
  }
  const limits = {
    authority: 300,
    noticeType: 300,
    sectionReference: 160,
    assessmentYear: 20,
    financialYear: 20,
    period: 80,
    din: 200,
    assessingAuthority: 300,
    statedReason: 4000,
  };
  return boundedText(value, limits[field] || 500, { required: true, label: field });
}

function parsePagination(query, { defaultLimit = 25, maxLimit = 100 } = {}) {
  const page = Number(query?.page || 1);
  const limit = Number(query?.limit || defaultLimit);
  if (!Number.isInteger(page) || page < 1) throw httpError(400, "page must be a positive integer");
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
    throw httpError(400, `limit must be between 1 and ${maxLimit}`);
  }
  return { page, limit, skip: (page - 1) * limit };
}

function sourceText(value) {
  return boundedText(value, MAX_SOURCE_TEXT, { label: "sourceText" });
}

export {
  AMOUNT_FIELDS,
  ARRAY_FIELDS,
  DATE_FIELDS,
  MAX_SOURCE_TEXT,
  boundedStringArray,
  boundedText,
  hashText,
  httpError,
  assertMutationRequestHash,
  mutationKey,
  mutationRequestHash,
  normalizeConfirmedValue,
  normalizeOffsets,
  objectId,
  parseDateValue,
  parsePagination,
  parseSafeMinor,
  sourceText,
  stableJson,
};
