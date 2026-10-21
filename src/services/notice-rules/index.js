// src/services/notice-rules/index.js
//
// W11 IN19 + IN20 (2026-10-21): reads the facts a GST or income-tax notice states about itself, by rule, with no
// model and no consent prompt.
//
// Why: notice windows are short (DRC-01C: 7 days; ASMT-10: 30 days) and until now every field came only from a
// DeepSeek call that needs consent - with AI off or consent refused, nothing was filled in. These rules read the
// text the clients already extract locally (the extension's notice-pdf.js, the desktop's PdfPig extractor).
//
// The contract every proposal keeps: `sourceText` is an exact excerpt of the notice, and `value` is only what
// that excerpt says, converted to the case's stored form (a date to YYYY-MM-DD, read day-first as Indian notices
// are written; an amount to paise). Nothing is inferred: a field the text does not state is not proposed, and a
// date the text writes ambiguously is not proposed. A person confirms each proposal through the existing
// confirmation route (source SOURCE_TEXT). Which Act governs a period is never decided here.

export const NOTICE_RULES_VERSION = "notice-rules-v1";

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

// A day as notices write it: 21/10/2026, 21-10-2026, 21.10.2026, 21-Oct-2026, 21 October 2026, 21st October, 2026.
const DATE_SOURCE =
  "(\\d{1,2}(?:st|nd|rd|th)?[\\s./-]+(?:\\d{1,2}|[A-Za-z]{3,9})[,\\s./-]+\\d{4})";

function isoDay(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

/** A day written day-first, to YYYY-MM-DD; null when it is not a real date. */
export function readDay(text) {
  const match = String(text || "").trim().match(/^(\d{1,2})(?:st|nd|rd|th)?[\s./-]+(\d{1,2}|[A-Za-z]{3,9})[,\s./-]+(\d{4})$/);
  if (!match) return null;
  const day = Number(match[1]);
  const month = /^\d+$/.test(match[2]) ? Number(match[2]) : MONTHS[match[2].toLowerCase()];
  return isoDay(Number(match[3]), month, day);
}

/** Rupees as written (Rs. 4,12,380/-, ₹ 4,12,380.50, INR 412380) to paise; null when unreadable. */
export function readRupeesToPaise(text) {
  const match = String(text || "").replace(/\s+/g, " ").match(/(?:₹|Rs\.?|INR)\s*([\d,]+)(?:\.(\d{1,2}))?/i);
  if (!match) return null;
  const rupees = match[1].replace(/,/g, "");
  if (!/^\d{1,13}$/.test(rupees)) return null;
  const paise = Number(rupees) * 100 + Number((match[2] || "0").padEnd(2, "0"));
  return Number.isSafeInteger(paise) ? paise : null;
}

function financialYearValue(raw) {
  const match = String(raw).match(/(20\d{2})\s*[-–/]\s*(\d{2,4})/);
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2].length === 4 ? Number(match[2]) : 2000 + Number(match[2]);
  return end === start + 1 ? `${start}-${String(end).slice(2)}` : null;
}

// ─── the recognisers: one per form ─────────────────────────────────────────

const GST = "Goods and Services Tax";
const INCOME_TAX = "Income Tax Department";

export const NOTICE_RECOGNISERS = Object.freeze([
  { id: "GST_DRC01C", family: "GST", noticeType: "FORM GST DRC-01C", authority: GST, detect: /FORM\s+GST\s+DRC\s*[-–]\s*01\s*C\b/i },
  { id: "GST_DRC01A", family: "GST", noticeType: "FORM GST DRC-01A", authority: GST, detect: /FORM\s+GST\s+DRC\s*[-–]\s*01\s*A\b/i },
  { id: "GST_DRC07", family: "GST", noticeType: "FORM GST DRC-07", authority: GST, detect: /FORM\s+GST\s+DRC\s*[-–]\s*07\b/i },
  { id: "GST_DRC01", family: "GST", noticeType: "FORM GST DRC-01", authority: GST, detect: /FORM\s+GST\s+DRC\s*[-–]\s*01(?![A-Z0-9])/i },
  { id: "GST_ASMT10", family: "GST", noticeType: "FORM GST ASMT-10", authority: GST, detect: /FORM\s+GST\s+ASMT\s*[-–]\s*10\b/i },
  { id: "GST_REG03", family: "GST", noticeType: "FORM GST REG-03", authority: GST, detect: /FORM\s+GST\s+REG\s*[-–]\s*03\b/i },
  { id: "GST_REG17", family: "GST", noticeType: "FORM GST REG-17", authority: GST, detect: /FORM\s+GST\s+REG\s*[-–]\s*17\b/i },
  { id: "IT_143_1", family: "IT", noticeType: "Intimation under section 143(1)", authority: INCOME_TAX, detect: /(?:intimation|order)\s+u(?:nder)?\s*(?:\/s|section)\s*143\s*\(\s*1\s*\)/i },
  { id: "IT_139_9", family: "IT", noticeType: "Notice under section 139(9)", authority: INCOME_TAX, detect: /(?:notice|communication)[^.]{0,80}?u(?:nder)?\s*(?:\/s|section)\s*139\s*\(\s*9\s*\)/i },
  { id: "IT_142_1", family: "IT", noticeType: "Notice under section 142(1)", authority: INCOME_TAX, detect: /notice\s+u(?:nder)?\s*(?:\/s|section)\s*142\s*\(\s*1\s*\)/i },
  { id: "IT_148A", family: "IT", noticeType: "Notice under section 148A", authority: INCOME_TAX, detect: /notice\s+u(?:nder)?\s*(?:\/s|section)\s*148\s*A/i },
  { id: "IT_133_6", family: "IT", noticeType: "Notice under section 133(6)", authority: INCOME_TAX, detect: /notice\s+u(?:nder)?\s*(?:\/s|section)\s*133\s*\(\s*6\s*\)/i },
  { id: "IT_245", family: "IT", noticeType: "Intimation under section 245", authority: INCOME_TAX, detect: /(?:intimation|notice)\s+u(?:nder)?\s*(?:\/s|section)\s*245\b/i },
]);

// ─── field rules: each returns { value, sourceText } or null ───────────────

function excerpt(text, match) {
  return text.slice(match.index, match.index + match[0].length).replace(/\s+/g, " ").trim().slice(0, 1200);
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return match;
  }
  return null;
}

const FIELD_RULES = {
  din(text) {
    const match = /(?:Document\s+Identification\s+Number|\bDIN\b)\s*(?:\(\s*DIN\s*\))?\s*(?:No\.?)?\s*[:\-]?\s*([A-Z0-9][A-Z0-9/().\-]{9,60}[A-Z0-9)])/i.exec(text);
    return match ? { value: match[1], sourceText: excerpt(text, match), ruleId: "DIN" } : null;
  },
  sectionReference(text) {
    const match = /\b(?:u\/s|under\s+section|section|sec\.)\s*(\d{1,3}[A-Z]{0,2}(?:\s*\(\s*[0-9A-Za-z]{1,4}\s*\))*)(?:\s+of\s+the\s+((?:Central\s+Goods\s+and\s+Services\s+Tax|CGST|Income[-\s]tax)\s+Act,?\s*\d{4}))?/i.exec(text);
    if (!match) return null;
    const section = match[1].replace(/\s+/g, "");
    return { value: match[2] ? `Section ${section} of the ${match[2].replace(/\s+/g, " ")}` : `Section ${section}`, sourceText: excerpt(text, match), ruleId: "SECTION" };
  },
  financialYear(text) {
    const match = /(?:Financial\s+Year|F\.\s*Y\.?|\bFY)\s*[:\-]?\s*(20\d{2}\s*[-–/]\s*\d{2,4})/i.exec(text);
    const value = match ? financialYearValue(match[1]) : null;
    return value ? { value, sourceText: excerpt(text, match), ruleId: "FY" } : null;
  },
  assessmentYear(text) {
    const match = /(?:Assessment\s+Year|A\.\s*Y\.?|\bAY)\s*[:\-]?\s*(20\d{2}\s*[-–/]\s*\d{2,4})/i.exec(text);
    const value = match ? financialYearValue(match[1]) : null;
    return value ? { value, sourceText: excerpt(text, match), ruleId: "AY" } : null;
  },
  period(text) {
    const match = /(?:Tax\s+Period|Return\s+Period|Period)\s*[:\-]?\s*((?:From\s+)?[A-Za-z]{3,9}[,\s]+20\d{2}(?:\s*(?:to|-|–)\s*[A-Za-z]{3,9}[,\s]+20\d{2})?)/i.exec(text);
    return match ? { value: match[1].replace(/\s+/g, " ").trim(), sourceText: excerpt(text, match), ruleId: "PERIOD" } : null;
  },
  issueDate(text) {
    const match = firstMatch(text, [
      new RegExp(`(?:Date\\s+of\\s+(?:issue|notice|intimation|order|communication))\\s*[:\\-]?\\s*${DATE_SOURCE}`, "i"),
      new RegExp(`(?:^|\\n)\\s*Dated?\\s*[:\\-]?\\s*${DATE_SOURCE}`, "i"),
      // "Reference No.: ... Date: 21/10/2026" - a bare "Date:" that is not a due, hearing or other named date.
      new RegExp(`(?<!(?:Due|due|by|of|hearing|Hearing)\\s)\\bDate\\s*[:\\-]\\s*${DATE_SOURCE}`),
    ]);
    const value = match ? readDay(match[1]) : null;
    return value ? { value, sourceText: excerpt(text, match), ruleId: "ISSUE_DATE" } : null;
  },
  responseDueDate(text) {
    const match = firstMatch(text, [
      new RegExp(`(?:on\\s+or\\s+before|not\\s+later\\s+than|latest\\s+by|reply\\s+by|respond\\s+by|submitted\\s+by|furnish(?:ed)?[^.\\n]{0,60}?\\s+by)\\s*[:\\-]?\\s*${DATE_SOURCE}`, "i"),
      new RegExp(`(?:Date\\s+by\\s+which\\s+(?:the\\s+)?(?:reply|response|explanation)[^:\\n]{0,40}|Due\\s+date\\s+(?:for|of)\\s+(?:reply|response|submission))\\s*[:\\-]?\\s*${DATE_SOURCE}`, "i"),
    ]);
    const value = match ? readDay(match[1]) : null;
    return value ? { value, sourceText: excerpt(text, match), ruleId: "REPLY_BY" } : null;
  },
  hearingDate(text) {
    const match = firstMatch(text, [
      new RegExp(`Date\\s+of\\s+(?:personal\\s+)?hearing\\s*[:\\-]?\\s*${DATE_SOURCE}`, "i"),
      new RegExp(`(?:personal\\s+hearing|hearing)[^.\\n]{0,60}?(?:on|date)\\s*[:\\-]?\\s*${DATE_SOURCE}`, "i"),
    ]);
    const value = match ? readDay(match[1]) : null;
    return value ? { value, sourceText: excerpt(text, match), ruleId: "HEARING" } : null;
  },
  demandMinor(text) {
    const match = firstMatch(text, [
      /(?:Total\s+(?:amount\s+)?(?:demand|payable|tax\s+payable|amount\s+payable)|Amount\s+(?:of\s+)?(?:demand|difference|tax\s+payable|payable)|demand\s+of)[^₹\n]{0,60}?((?:₹|Rs\.?|INR)\s*[\d,]+(?:\.\d{1,2})?)/i,
      /(?:Net\s+(?:amount\s+)?payable|Tax\s+payable)[^₹\n]{0,40}?((?:₹|Rs\.?|INR)\s*[\d,]+(?:\.\d{1,2})?)/i,
    ]);
    const value = match ? readRupeesToPaise(match[1]) : null;
    return value !== null && value !== undefined ? { value: String(value), sourceText: excerpt(text, match), ruleId: "DEMAND" } : null;
  },
};

/**
 * Pure: reads a notice's text by rule. Returns the form recognised (or null), and one proposal per field the
 * text states, each { field, value, sourceText, ruleId }. A field is proposed only when its sourceText is an
 * exact excerpt of `text` (after collapsing runs of whitespace, as the case extraction check does).
 */
export function readNoticeByRules(text) {
  const source = String(text || "");
  const recogniser = NOTICE_RECOGNISERS.find((entry) => entry.detect.test(source)) || null;
  const proposals = [];
  if (recogniser) {
    const formMatch = recogniser.detect.exec(source);
    const formExcerpt = excerpt(source, formMatch);
    proposals.push({ field: "noticeType", value: recogniser.noticeType, sourceText: formExcerpt, ruleId: recogniser.id });
    proposals.push({ field: "authority", value: recogniser.authority, sourceText: formExcerpt, ruleId: recogniser.id });
  }
  for (const [field, rule] of Object.entries(FIELD_RULES)) {
    const hit = rule(source);
    if (hit) proposals.push({ field, value: hit.value, sourceText: hit.sourceText, ruleId: hit.ruleId });
  }
  const collapsed = source.replace(/\s+/g, " ").toLowerCase();
  const verified = proposals.filter((proposal) => proposal.sourceText && collapsed.includes(proposal.sourceText.replace(/\s+/g, " ").toLowerCase()));
  return {
    version: NOTICE_RULES_VERSION,
    form: recogniser ? { id: recogniser.id, family: recogniser.family, noticeType: recogniser.noticeType } : null,
    proposals: verified,
  };
}

export const RULE_FIELDS = Object.freeze(["noticeType", "authority", ...Object.keys(FIELD_RULES)]);
