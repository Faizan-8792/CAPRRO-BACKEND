// src/services/case-excerpt.service.js
//
// W11 IN30 (2026-10-21): ties each field the model proposes from a notice back to the notice itself.
//
// Two things went wrong before. First, a correct field was dropped: the model reads the notice after PII redaction
// (a GSTIN as [GSTIN], a DIN's long digit run as [NUM] or [PHONE]), so its "exact excerpt" never appeared in the
// original; and an em dash, a Devanagari digit or a no-break space the model normalised made the plain `includes`
// fail. Second, a wrong field could pass: the value was never checked against its excerpt, so an answer (or a
// line planted in the notice) could pair a real excerpt with a different date or amount.
//
// Now an excerpt is matched on folded text (src/services/text/fold.js), with each redaction token standing for
// the shape it replaced; the excerpt kept is the ORIGINAL text it matched, real identifiers and all. And a value
// must agree with that excerpt: a date must be a date the excerpt writes, an amount an amount it writes, and any
// other value may only use numbers the excerpt has. A person still confirms every field.

import { foldWithMap, foldText } from "./text/fold.js";
import { amountsIn, datesIn } from "./notice-rules/index.js";

// Each token the outbound redaction writes (deepseek-provider.service.js redactPII), as the shape it stood for.
const REDACTION_SHAPES = Object.freeze({
  "[GSTIN]": "\\d{2}[A-Za-z]{5}\\d{4}[A-Za-z][0-9A-Za-z]{3}",
  "[PAN]": "[A-Za-z]{5}\\d{4}[A-Za-z]",
  "[EMAIL]": "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}",
  "[AADHAAR]": "\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4}",
  "[PHONE]": "(?:\\+91[\\s-]?|0)?[6-9]\\d{9}",
  "[NUM]": "\\d{11,18}",
});
const TOKEN_PATTERN = /\[(?:GSTIN|PAN|EMAIL|AADHAAR|PHONE|NUM)\]/g;

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The original text a model's excerpt stands for, whitespace collapsed; null when the excerpt is not in the
 * source. Matching is on folded text, case-insensitive, with any run of space matching any run of space and each
 * redaction token matching the shape it replaced.
 */
export function locateExcerpt(excerpt, source) {
  const folded = foldText(excerpt).replace(/\s+/g, " ").trim();
  const meaningful = folded.replace(TOKEN_PATTERN, "").replace(/[\s\p{P}]/gu, "");
  if (meaningful.length < 3) return null;
  let pattern = "";
  let last = 0;
  for (const match of folded.matchAll(TOKEN_PATTERN)) {
    pattern += escapeRegex(folded.slice(last, match.index)).replace(/ /g, "\\s+");
    pattern += REDACTION_SHAPES[match[0]];
    last = match.index + match[0].length;
  }
  pattern += escapeRegex(folded.slice(last)).replace(/ /g, "\\s+");
  const reading = foldWithMap(source);
  let found;
  try {
    found = new RegExp(pattern, "iu").exec(reading.text);
  } catch {
    return null;
  }
  if (!found) return null;
  return reading.slice(found.index, found.index + found[0].length).replace(/\s+/g, " ").trim();
}

// Numbers as written, folded, commas dropped, leading zeros dropped (05 and 5 are one number).
function numberTokens(text) {
  return (foldText(text).match(/\d[\d,]*(?:\.\d+)?/g) || [])
    .map((token) => token.replace(/,/g, "").replace(/^0+(?=\d)/, ""));
}

/**
 * Whether a proposed value says what its excerpt says. Dates: the value (YYYY-MM-DD) is a day the excerpt writes.
 * Amounts: the value's sum is a sum the excerpt writes. Anything else: every number in the value is in the excerpt.
 */
export function valueAgreesWithExcerpt(field, value, excerpt, { dateFields, amountFields }) {
  const text = String(value ?? "").trim();
  if (!text) return false;
  if (dateFields.has(field)) {
    const iso = foldText(text).trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(iso) && (datesIn(excerpt).includes(iso) || foldText(excerpt).includes(iso));
  }
  if (amountFields.has(field)) {
    const written = amountsIn(text);
    const stated = amountsIn(excerpt);
    if (written.length) return written.every((paise) => stated.includes(paise));
  }
  const inExcerpt = new Set(numberTokens(excerpt));
  return numberTokens(text).every((token) => inExcerpt.has(token));
}
