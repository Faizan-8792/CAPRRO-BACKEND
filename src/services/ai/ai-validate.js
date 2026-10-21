// src/services/ai/ai-validate.js
//
// W11 IN5 (2026-10-21): the checks every model answer passes before anything is kept. Hand-written, like
// normalizeAuditAiResult in audit-working-paper.service.js, so the rules read as code and add no dependency.
//
// The one rule that matters most here: a model draft never introduces a number. Amounts, dates and counts are
// the server's (CLAUDE.md section 8). Free text may contain a digit only inside a token the server itself sent
// (a section label such as "194J" from the facts) or a return or form name on the fixed list below; every
// other digit fails the answer. So "GSTR-2B" passes and "Rs 6,480" does not.

const FORM_TOKENS = Object.freeze([
  "GSTR-1", "GSTR-1A", "GSTR-2A", "GSTR-2B", "GSTR-3B", "GSTR-9", "GSTR-9C", "IFF", "1A", "2A", "2B", "3B",
  "DRC-01", "DRC-01A", "DRC-01B", "DRC-01C", "DRC-03", "DRC-06", "DRC-07", "ASMT-10", "ASMT-11", "REG-03",
  "REG-17", "26AS", "AIS", "TIS", "16(2)(aa)", "16(2)(c)", "Form 16", "Form 16A", "24Q", "26Q", "27Q", "27EQ",
  "TRACES",
]);

const SLOT_PATTERN = /\{\{\s*([a-zA-Z][a-zA-Z0-9]*)\s*\}\}/g;

export class AiAnswerInvalid extends Error {
  constructor(reason) {
    super(reason);
    this.name = "AiAnswerInvalid";
  }
}

export function fail(reason) {
  throw new AiAnswerInvalid(reason);
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Every word-ish token containing a digit in the string values of `facts` (deep). Numbers themselves are NOT
// collected: an amount the server sent as a number is the server's to render, never the model's to repeat.
export function digitTokensIn(facts) {
  const tokens = new Set();
  const walk = (value) => {
    if (typeof value === "string") {
      for (const token of value.match(/[A-Za-z0-9()/.-]*\d[A-Za-z0-9()/.-]*/g) || []) tokens.add(token);
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (isPlainObject(value)) {
      Object.values(value).forEach(walk);
    }
  };
  walk(facts);
  return tokens;
}

// Free text from the model: a string, trimmed, within `max`, with no link, no slot outside `slots`, and no
// digit outside an allowed token. Returns the trimmed text.
export function readFreeText(value, { max, slots = [], allowedTokens = new Set(), label = "text", required = true } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) fail(`${label} is missing`);
    return "";
  }
  if (typeof value !== "string") fail(`${label} is not text`);
  const text = value.replace(/\r\n/g, "\n").trim();
  if (!text) {
    if (required) fail(`${label} is empty`);
    return "";
  }
  if (text.length > max) fail(`${label} is longer than ${max} characters`);
  if (/https?:\/\/|www\.|\]\(/i.test(text)) fail(`${label} contains a link`);
  for (const match of text.matchAll(SLOT_PATTERN)) {
    if (!slots.includes(match[1])) fail(`${label} uses an unknown slot ${match[1]}`);
  }
  let rest = text.replace(SLOT_PATTERN, " ");
  const allowed = [...FORM_TOKENS, ...allowedTokens].sort((a, b) => b.length - a.length);
  for (const token of allowed) {
    if (token) rest = rest.split(token).join(" ");
  }
  if (/\d/.test(rest)) fail(`${label} contains a number the server did not send`);
  return text;
}

export function readEnum(value, allowed, label) {
  if (typeof value !== "string" || !allowed.includes(value)) fail(`${label} is not one of the allowed values`);
  return value;
}

export function readFieldList(value, allowed, label, max = 12) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(`${label} is not a list`);
  if (value.length > max) fail(`${label} has more than ${max} entries`);
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== "string" || !allowed.includes(entry)) fail(`${label} names a field that was not sent`);
    seen.add(entry);
  }
  return [...seen];
}

// Fills {{slot}} placeholders from `values`; a slot with no value becomes an em dash rather than staying
// visible as a placeholder or being silently dropped.
export function fillSlots(text, values) {
  return String(text || "").replace(SLOT_PATTERN, (_, name) => {
    const value = values?.[name];
    return value === undefined || value === null || value === "" ? "—" : String(value);
  });
}

export function slotsUsed(text) {
  return [...String(text || "").matchAll(SLOT_PATTERN)].map((match) => match[1]);
}
