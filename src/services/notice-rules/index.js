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
// are written; an amount to paise). Nothing is inferred: a field the text does not state is not proposed, and an
// amount whose magnitude word the reader does not scale (Cr, thousand) is not proposed. A person confirms each
// proposal through the existing
// confirmation route (source SOURCE_TEXT). Which Act governs a period is never decided here.
//
// W11 IN28 (2026-10-21): the rules match on FOLDED text (src/services/text/fold.js): the digits of every Indian
// script read as 0-9, every dash as "-", every Unicode space as a space, zero-width characters dropped. So a
// bilingual or Hindi notice, a Devanagari date (२०/११/२०२६) or an em dash in "DRC—01" is read like its English
// form. Every excerpt is still cut from the ORIGINAL text. Dates are read day-first, as Indian notices write
// them; a month written as a word (English, Hindi or Marathi) settles the order whichever comes first.

import { foldWithMap } from "../text/fold.js";

export const NOTICE_RULES_VERSION = "notice-rules-v2";

const MONTHS = normaliseKeys({
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
  // Hindi (with and without the nukta and the half-letter spellings in use)
  "जनवरी": 1, "फरवरी": 2, "फ़रवरी": 2, "मार्च": 3, "अप्रैल": 4, "अप्रेल": 4, "मई": 5, "जून": 6, "जुलाई": 7,
  "अगस्त": 8, "सितंबर": 9, "सितम्बर": 9, "अक्टूबर": 10, "अक्तूबर": 10, "नवंबर": 11, "नवम्बर": 11, "दिसंबर": 12, "दिसम्बर": 12,
  // Marathi
  "जानेवारी": 1, "फेब्रुवारी": 2, "एप्रिल": 4, "मे": 5, "जुलै": 7, "ऑगस्ट": 8, "सप्टेंबर": 9, "ऑक्टोबर": 10,
  "नोव्हेंबर": 11, "डिसेंबर": 12,
});

// Keys in NFKC form, as the folded text has them (a nukta letter such as the one in फ़रवरी decomposes).
function normaliseKeys(table) {
  return Object.fromEntries(Object.entries(table).map(([word, value]) => [word.normalize("NFKC"), value]));
}

// A month written as a word, in any script (letters and combining marks).
const MONTH_WORD = "[\\p{L}\\p{M}]{3,12}\\.?";
// A day as notices write it, day first: 21/10/2026, 21-10-26, 21.10.2026, 21-Oct-2026, 21 October 2026,
// 21st October, 2026, २१ अक्टूबर २०२६ (digits already folded); or month first with the month as a word:
// October 21, 2026 / Oct 21st 2026.
const DATE_SOURCE =
  `((?:\\d{1,2}(?:st|nd|rd|th)?[\\s./-]+(?:\\d{1,2}|${MONTH_WORD})[,\\s./-]+(?:\\d{4}|\\d{2})(?!\\d))|(?:${MONTH_WORD}\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}))`;

function isoDay(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

function monthNumber(word) {
  const key = String(word || "").replace(/\.$/, "").toLowerCase();
  return MONTHS[key.normalize("NFKC")];
}

function fullYear(raw) {
  return raw.length === 2 ? 2000 + Number(raw) : Number(raw);
}

/**
 * A day as a notice writes it, to YYYY-MM-DD; null when it is not a real date. Day first (Indian notices), or
 * month first only when the month is a word. Any script's digits are read (folded first).
 */
export function readDay(text) {
  const value = foldWithMap(text).text.trim();
  const dayFirst = value.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s./-]+(\d{1,2}|[\p{L}\p{M}]{3,12}\.?)[,\s./-]+(\d{4}|\d{2})$/u);
  if (dayFirst) {
    const month = /^\d+$/.test(dayFirst[2]) ? Number(dayFirst[2]) : monthNumber(dayFirst[2]);
    return isoDay(fullYear(dayFirst[3]), month, Number(dayFirst[1]));
  }
  const monthFirst = value.match(/^([\p{L}\p{M}]{3,12}\.?)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/u);
  if (monthFirst) return isoDay(Number(monthFirst[3]), monthNumber(monthFirst[1]), Number(monthFirst[2]));
  return null;
}

// Keys in NFKC form, as the folded text has them (a nukta letter such as the one in करोड़ decomposes). "Cr" is
// not read as crore: in a ledger line it means credit.
const SCALE = Object.fromEntries(
  Object.entries({ lakh: 100_000, lakhs: 100_000, lac: 100_000, lacs: 100_000, "लाख": 100_000, crore: 10_000_000, crores: 10_000_000, "करोड़": 10_000_000, "करोड": 10_000_000 })
    .map(([word, scale]) => [word.normalize("NFKC"), scale]),
);
// The scale words as a pattern: a Hindi word may carry a combining mark (the nukta) after its base letter.
const SCALE_WORD = "(?:lakhs?|lacs?|crores?|लाख|करोड\\p{M}?)";
// The currency in front of an amount: ₹, Rs, Rs., INR, रु, रु., रुपये.
const CURRENCY = "(?:₹|Rs\\.?|INR|रु\\.?|रुपये)";
// An amount as written after its currency, with an optional lakh or crore after it.
const AMOUNT_SOURCE = `(${CURRENCY}\\s*[\\d,]+(?:\\.\\d{1,3})?(?:\\s*${SCALE_WORD}(?![\\p{L}\\p{M}]))?)`;

// A magnitude word after an amount that the reader does not scale: the amount is not proposed at all.
const UNSCALED_MAGNITUDE = /^\s*(?:cr|thousand|thousands|hazar|हज\p{M}?ार|million|mn|billion|bn|k)(?![\p{L}\p{M}])/iu;

/**
 * Rupees as written (Rs. 4,12,380/-, ₹ 4,12,380.50, INR 412380, ₹ 4.12 lakh, रु. ४,१२,३८०) to paise; null when
 * unreadable. A lakh or crore scales the figure exactly (₹ 4.12 lakh is ₹4,12,000), never truncates it.
 */
export function readRupeesToPaise(text) {
  const folded = foldWithMap(text).text.replace(/\s+/g, " ");
  const match = folded.match(new RegExp(`${CURRENCY}\\s*([\\d,]+)(?:\\.(\\d{1,3}))?(?:\\s*(${SCALE_WORD})(?![\\p{L}\\p{M}]))?`, "iu"));
  if (!match) return null;
  // A magnitude this does not scale (Cr - crore or credit -, thousand, million, हज़ार) would be read a thousand or
  // a crore times too small: nothing is proposed instead.
  if (!match[3] && UNSCALED_MAGNITUDE.test(folded.slice(match.index + match[0].length))) return null;
  const whole = match[1].replace(/,/g, "");
  if (!/^\d{1,13}$/.test(whole)) return null;
  const fraction = match[2] || "";
  const scale = match[3] ? SCALE[match[3].toLowerCase().normalize("NFKC")] : 1;
  if (!scale) return null;
  if (scale === 1 && fraction.length > 2) return null;
  // paise = (whole.fraction) x scale x 100, in integers: (whole * 10^f + fraction) * scale * 100 / 10^f.
  const digits = BigInt(whole + fraction || "0");
  const numerator = digits * BigInt(scale) * 100n;
  const denominator = 10n ** BigInt(fraction.length);
  if (numerator % denominator !== 0n) return null;
  const paise = Number(numerator / denominator);
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

// The words a form's heading is printed with, in English and Hindi (प्ररूप / प्रपत्र / फॉर्म = Form).
const FORM = "(?:FORM|प्ररूप|प्रपत्र|फॉर्म|फार्म)";
const GST_WORD = "(?:GST|जीएसटी)";
const AFTER = "(?![\\p{L}\\p{M}\\p{N}])";
function gstForm(code, number, suffix = "") {
  const tail = suffix ? `\\s*${suffix}${AFTER}` : "(?![\\p{L}\\p{M}\\p{N}])";
  return new RegExp(`${FORM}\\s+${GST_WORD}\\s+${code}\\s*-\\s*${number}${tail}`, "iu");
}
// "under section" and its Hindi (धारा ... के अधीन / अंतर्गत), and the abbreviations: u/s, u/s., sec., section.
const UNDER = "(?:u(?:nder)?\\s*(?:\\/\\s*s\\.?|section|sec\\.)|धारा)";
const NOTICE_WORD = "(?:notice|सूचना|नोटिस)";
const INTIMATION_WORD = "(?:intimation|order|सूचना|आसूचना|आदेश)";
function itNotice(words, section, { before = 80 } = {}) {
  // Either "<word> ... u/s 143(1)" or the Hindi order "धारा 143(1) ... <word>".
  return new RegExp(`(?:${words}[^.]{0,${before}}?${UNDER}\\s*${section})|(?:धारा\\s*${section}[^.]{0,60}?${words})`, "iu");
}

export const NOTICE_RECOGNISERS = Object.freeze([
  { id: "GST_DRC01C", family: "GST", noticeType: "FORM GST DRC-01C", authority: GST, detect: gstForm("(?:DRC|डीआरसी)", "01", "(?:C|सी)") },
  { id: "GST_DRC01A", family: "GST", noticeType: "FORM GST DRC-01A", authority: GST, detect: gstForm("(?:DRC|डीआरसी)", "01", "(?:A|ए)") },
  { id: "GST_DRC07", family: "GST", noticeType: "FORM GST DRC-07", authority: GST, detect: gstForm("(?:DRC|डीआरसी)", "07") },
  { id: "GST_DRC01", family: "GST", noticeType: "FORM GST DRC-01", authority: GST, detect: gstForm("(?:DRC|डीआरसी)", "01") },
  { id: "GST_ASMT10", family: "GST", noticeType: "FORM GST ASMT-10", authority: GST, detect: gstForm("(?:ASMT|एएसएमटी)", "10") },
  { id: "GST_REG03", family: "GST", noticeType: "FORM GST REG-03", authority: GST, detect: gstForm("(?:REG|आरईजी)", "03") },
  { id: "GST_REG17", family: "GST", noticeType: "FORM GST REG-17", authority: GST, detect: gstForm("(?:REG|आरईजी)", "17") },
  { id: "IT_143_1", family: "IT", noticeType: "Intimation under section 143(1)", authority: INCOME_TAX, detect: itNotice(INTIMATION_WORD, "143\\s*\\(\\s*1\\s*\\)", { before: 20 }) },
  { id: "IT_139_9", family: "IT", noticeType: "Notice under section 139(9)", authority: INCOME_TAX, detect: itNotice("(?:notice|communication|सूचना|नोटिस)", "139\\s*\\(\\s*9\\s*\\)") },
  { id: "IT_142_1", family: "IT", noticeType: "Notice under section 142(1)", authority: INCOME_TAX, detect: itNotice(NOTICE_WORD, "142\\s*\\(\\s*1\\s*\\)", { before: 20 }) },
  { id: "IT_148A", family: "IT", noticeType: "Notice under section 148A", authority: INCOME_TAX, detect: itNotice(NOTICE_WORD, "148\\s*A", { before: 20 }) },
  { id: "IT_133_6", family: "IT", noticeType: "Notice under section 133(6)", authority: INCOME_TAX, detect: itNotice(NOTICE_WORD, "133\\s*\\(\\s*6\\s*\\)", { before: 20 }) },
  { id: "IT_245", family: "IT", noticeType: "Intimation under section 245", authority: INCOME_TAX, detect: itNotice("(?:intimation|notice|सूचना|आसूचना)", "245(?![\\p{N}])", { before: 20 }) },
]);

// ─── field rules: each returns { value, sourceText } or null ───────────────

// The folded text being read, so an excerpt can be cut from the original behind it (set per call).
let reading = null;

function excerpt(text, match) {
  const raw = reading && reading.text === text ? reading.slice(match.index, match.index + match[0].length) : text.slice(match.index, match.index + match[0].length);
  return raw.replace(/\s+/g, " ").trim().slice(0, 1200);
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
    const match = /(?:\bu\/\s*s\.?|\bunder\s+section|\bsection|\bsec\.|धारा)\s*(\d{1,3}[A-Z]{0,2}(?:\s*\(\s*[0-9A-Za-z]{1,4}\s*\))*)(?:\s+of\s+the\s+((?:Central\s+Goods\s+and\s+Services\s+Tax|CGST|Income[-\s]tax)\s+Act,?\s*\d{4}))?/i.exec(text);
    if (!match) return null;
    const section = match[1].replace(/\s+/g, "");
    return { value: match[2] ? `Section ${section} of the ${match[2].replace(/\s+/g, " ")}` : `Section ${section}`, sourceText: excerpt(text, match), ruleId: "SECTION" };
  },
  financialYear(text) {
    const match = /(?:Financial\s+Year|F\.\s*Y\.?|\bFY|वित्तीय\s+वर्ष|वित्त\s+वर्ष)\s*[:\-]?\s*(20\d{2}\s*[-–/]\s*\d{2,4})/i.exec(text);
    const value = match ? financialYearValue(match[1]) : null;
    return value ? { value, sourceText: excerpt(text, match), ruleId: "FY" } : null;
  },
  assessmentYear(text) {
    const match = /(?:Assessment\s+Year|A\.\s*Y\.?|\bAY|निर्धारण\s+वर्ष)\s*[:\-]?\s*(20\d{2}\s*[-–/]\s*\d{2,4})/i.exec(text);
    const value = match ? financialYearValue(match[1]) : null;
    return value ? { value, sourceText: excerpt(text, match), ruleId: "AY" } : null;
  },
  period(text) {
    const match = /(?:Tax\s+Period|Return\s+Period|Period)\s*[:\-]?\s*((?:From\s+)?[A-Za-z]{3,9}[,\s]+20\d{2}(?:\s*(?:to|-|–)\s*[A-Za-z]{3,9}[,\s]+20\d{2})?)/i.exec(text);
    return match ? { value: match[1].replace(/\s+/g, " ").trim(), sourceText: excerpt(text, match), ruleId: "PERIOD" } : null;
  },
  issueDate(text) {
    const match = firstMatch(text, [
      new RegExp(`(?:Date\\s+of\\s+(?:issue|notice|intimation|order|communication)|जारी\\s+करने\\s+की\\s+(?:तिथि|तारीख|दिनांक))\\s*[:\\-]?\\s*${DATE_SOURCE}`, "iu"),
      new RegExp(`(?:^|\\n)\\s*(?:Dated?|दिनांक|दिनांकित|तारीख)\\s*[:\\-]?\\s*${DATE_SOURCE}`, "iu"),
      // "Reference No.: ... Date: 21/10/2026" - a bare "Date:" that is not a due, hearing or other named date.
      new RegExp(`(?<!(?:due|by|of|hearing)\\s)(?:\\bDate|दिनांक)\\s*[:\\-]\\s*${DATE_SOURCE}`, "iu"),
    ]);
    const value = match ? readDay(match[1]) : null;
    return value ? { value, sourceText: excerpt(text, match), ruleId: "ISSUE_DATE" } : null;
  },
  responseDueDate(text) {
    const match = firstMatch(text, [
      new RegExp(`(?:on\\s+or\\s+before|not\\s+later\\s+than|latest\\s+by|reply\\s+by|respond\\s+by|submitted\\s+by|furnish(?:ed)?[^.\\n]{0,60}?\\s+by)\\s*[:\\-]?\\s*${DATE_SOURCE}`, "iu"),
      new RegExp(`(?:Date\\s+by\\s+which\\s+(?:the\\s+)?(?:reply|response|explanation)[^:\\n]{0,40}|Due\\s+date\\s+(?:for|of)\\s+(?:reply|response|submission)|उत्तर\\s+(?:देने|प्रस्तुत\\s+करने)\\s+की\\s+(?:अंतिम\\s+)?(?:तिथि|तारीख|दिनांक))\\s*[:\\-]?\\s*${DATE_SOURCE}`, "iu"),
      // Hindi puts "by" after the date: "२०/११/२०२६ तक उत्तर" / "20.11.2026 तक".
      new RegExp(`${DATE_SOURCE}\\s*(?:को\\s*)?तक`, "u"),
    ]);
    const value = match ? readDay(match[1]) : null;
    return value ? { value, sourceText: excerpt(text, match), ruleId: "REPLY_BY" } : null;
  },
  hearingDate(text) {
    const match = firstMatch(text, [
      new RegExp(`(?:Date\\s+of\\s+(?:personal\\s+)?hearing|सुनवाई\\s+की\\s+(?:तिथि|तारीख|दिनांक))\\s*[:\\-]?\\s*${DATE_SOURCE}`, "iu"),
      new RegExp(`(?:personal\\s+hearing|hearing)[^.]{0,60}?(?:on|date)\\s*[:\\-]?\\s*${DATE_SOURCE}`, "iu"),
    ]);
    const value = match ? readDay(match[1]) : null;
    return value ? { value, sourceText: excerpt(text, match), ruleId: "HEARING" } : null;
  },
  demandMinor(text) {
    const match = firstMatch(text, [
      // The label and its amount may sit on adjacent lines (a table cell under its heading).
      new RegExp(`(?:Total\\s+(?:amount\\s+)?(?:demand|payable|tax\\s+payable|amount\\s+payable)|Amount\\s+(?:of\\s+)?(?:demand|difference|tax\\s+payable|payable)|demand\\s+of|कुल\\s+(?:मांग|माँग|देय(?:\\s+राशि)?)|देय\\s+राशि|मांग\\s+की\\s+राशि)[^₹]{0,60}?${AMOUNT_SOURCE}`, "iu"),
      new RegExp(`(?:Net\\s+(?:amount\\s+)?payable|Tax\\s+payable|कर\\s+देय)[^₹]{0,40}?${AMOUNT_SOURCE}`, "iu"),
    ]);
    if (!match || UNSCALED_MAGNITUDE.test(text.slice(match.index + match[0].length))) return null;
    const value = readRupeesToPaise(match[1]);
    return value !== null && value !== undefined ? { value: String(value), sourceText: excerpt(text, match), ruleId: "DEMAND" } : null;
  },
};

/**
 * Pure: reads a notice's text by rule. Returns the form recognised (or null), and one proposal per field the
 * text states, each { field, value, sourceText, ruleId }. A field is proposed only when its sourceText is an
 * exact excerpt of `text` (after collapsing runs of whitespace, as the case extraction check does).
 */
export function readNoticeByRules(text) {
  const original = String(text || "");
  // Every rule reads the folded text; every excerpt is cut from the original behind it.
  reading = foldWithMap(original);
  const source = reading.text;
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
  reading = null;
  const collapsed = original.replace(/\s+/g, " ").toLowerCase();
  const verified = proposals.filter((proposal) => proposal.sourceText && collapsed.includes(proposal.sourceText.replace(/\s+/g, " ").toLowerCase()));
  return {
    version: NOTICE_RULES_VERSION,
    form: recogniser ? { id: recogniser.id, family: recogniser.family, noticeType: recogniser.noticeType } : null,
    proposals: verified,
  };
}

export const RULE_FIELDS = Object.freeze(["noticeType", "authority", ...Object.keys(FIELD_RULES)]);

/** Every day `text` writes (any script, day first or with a month word), as YYYY-MM-DD, in order. */
export function datesIn(text) {
  const folded = foldWithMap(text).text;
  const days = [];
  for (const match of folded.matchAll(new RegExp(DATE_SOURCE, "giu"))) {
    const day = readDay(match[1]);
    if (day) days.push(day);
  }
  return days;
}

/** Every rupee amount `text` writes after a currency mark, in paise; one followed by an unscaled magnitude is left out. */
export function amountsIn(text) {
  const folded = foldWithMap(text).text;
  const amounts = [];
  for (const match of folded.matchAll(new RegExp(AMOUNT_SOURCE, "giu"))) {
    if (UNSCALED_MAGNITUDE.test(folded.slice(match.index + match[0].length))) continue;
    const paise = readRupeesToPaise(match[1]);
    if (paise !== null) amounts.push(paise);
  }
  return amounts;
}
