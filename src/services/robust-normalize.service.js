// Robust, DETERMINISTIC adaptive-import primitives shared by the GST and TDS
// normalizers. The goal: accept messy, format-varied, real-world data (any date
// shape, any money shape, aliased labels, aliased column headers) while keeping
// money math exact (integer paise via BigInt) and behaviour fully repeatable.
//
// No LLM / no guessing of financial values lives here — this is a rules engine
// (multi-format parsers + synonym dictionaries). That is what makes it safe for a
// CA tool and testable across thousands of rows.

/* --------------------------------------------------------------- dates */
const MONTHS = Object.freeze({
  JAN: 1, JANUARY: 1, FEB: 2, FEBRUARY: 2, MAR: 3, MARCH: 3, APR: 4, APRIL: 4,
  MAY: 5, JUN: 6, JUNE: 6, JUL: 7, JULY: 7, AUG: 8, AUGUST: 8, SEP: 9, SEPT: 9,
  SEPTEMBER: 9, OCT: 10, OCTOBER: 10, NOV: 11, NOVEMBER: 11, DEC: 12, DECEMBER: 12,
});

function validUtcDay(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isoFrom(year, month, day) {
  if (!validUtcDay(year, month, day)) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// Expand a 2-digit year: 00-79 -> 2000-2079, 80-99 -> 1980-1999.
function expandYear(raw) {
  const n = Number(raw);
  if (raw.length <= 2) return n <= 79 ? 2000 + n : 1900 + n;
  return n;
}

// Whether an ambiguous numeric date (both fields <= 12) is read day-first or
// month-first. There is no third option for an ambiguous row: one file, one order.
const DATE_ORDER = Object.freeze({ DAY_FIRST: "DAY_FIRST", MONTH_FIRST: "MONTH_FIRST" });

// The full outcome space for classifying a whole date COLUMN (not one value).
// AMBIGUOUS: no row disambiguates, but at least one numeric-shaped row exists.
// CONFLICTING: one row proves day-first and another proves month-first in the
// same column -- no single order is coherent for the file.
// NOT_APPLICABLE: no numeric-shaped (DD/MM vs MM/DD) row exists at all -- every
// date is already unambiguous (ISO, month-name, Excel serial, etc).
const DATE_ORDER_STATUS = Object.freeze({
  DAY_FIRST: "DAY_FIRST",
  MONTH_FIRST: "MONTH_FIRST",
  AMBIGUOUS: "AMBIGUOUS",
  CONFLICTING: "CONFLICTING",
  NOT_APPLICABLE: "NOT_APPLICABLE",
});

// The complete set of date fields that reach parseFlexibleDateIso today, verified
// by grep across gst-normalization.service.js:297 and tds-normalization.service.js
// (lines 162, 177, 200, 213). Used to decide which mapped columns to pool into one
// file-level date-order classification, rather than resolving order per column.
const DATE_FIELDS_BY_KIND = Object.freeze({
  CLIENTS: [],
  GST_PURCHASE: ["documentDate"],
  GSTR2B: ["documentDate"],
  GSTR3B_SUMMARY: [],
  TDS_DEDUCTIONS: ["transactionDate"],
  TDS_CHALLANS: ["challanDate"],
  TDS_STATEMENTS: ["filedDate"],
  TDS_26AS: ["creditDate"],
});

// Classifies ONE value's numeric-date shape without deciding an order. Used to
// build file-level evidence before any row is actually parsed.
//   shape: "NUMERIC"      -- matches the DD/MM (or MM/DD) two-numeric-field shape.
//          "UNAMBIGUOUS"  -- matches a shape that states its own order (ISO, a
//                            month NAME, YYYYMMDD, or an Excel serial).
//          "UNPARSEABLE"  -- matches none of the parser's shapes.
//   proves: for a NUMERIC value, which single order this ROW alone proves --
//          DATE_ORDER.DAY_FIRST when field1 > 12 (only day-first can be true),
//          DATE_ORDER.MONTH_FIRST when field2 > 12 (only month-first can be true),
//          "IMPOSSIBLE" when both fields > 12 (not a valid date under either
//          order -- e.g. "13/13/2026"), or null when both fields are <= 12 (this
//          row alone cannot prove an order either way).
function classifyNumericDate(value) {
  let s = String(value ?? "").trim();
  if (!s) return { shape: "UNPARSEABLE", proves: null };
  s = s.replace(/\bT\d{1,2}:\d{2}.*$/i, "").trim();
  s = s.replace(/\s+\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)?$/i, "").trim();

  const numeric = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (numeric) {
    const field1 = Number(numeric[1]);
    const field2 = Number(numeric[2]);
    let proves = null;
    if (field1 > 12 && field2 > 12) proves = "IMPOSSIBLE";
    else if (field1 > 12 && field2 <= 12) proves = DATE_ORDER.DAY_FIRST;
    else if (field2 > 12 && field1 <= 12) proves = DATE_ORDER.MONTH_FIRST;
    return { shape: "NUMERIC", field1, field2, proves };
  }

  const isoLike = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.test(s);
  const monthName = /^(\d{1,2})[-/. ]+([A-Za-z]{3,9})[-/. ]+(\d{2,4})$/.test(s)
    || /^([A-Za-z]{3,9})[-/. ]+(\d{1,2}),?[-/. ]+(\d{2,4})$/.test(s);
  const compact = /^(\d{4})(\d{2})(\d{2})$/.test(s);
  const serial = /^\d{5}$/.test(s);
  if (isoLike || monthName || compact || serial) {
    return { shape: "UNAMBIGUOUS", proves: null };
  }

  return { shape: "UNPARSEABLE", proves: null };
}

// Classifies a whole mapped date COLUMN (every value from every date field in one
// imported file, pooled) into one DATE_ORDER_STATUS with the evidence that
// produced it. This is the file-level decision that replaces the old per-row
// guess: date order is decided ONCE, from everything the file itself proves.
//
// entries: [{ row, value }] -- row is the 1-based data row number the caller
// wants cited back to the person reviewing the file (typically spreadsheet row,
// i.e. header row + 1-based index).
function classifyDateColumn(entries) {
  let dayFirstEvidenceRow = null;
  let monthFirstEvidenceRow = null;
  let ambiguousRows = 0;
  let unambiguousRows = 0;
  let unparseableRows = 0;
  let sawNumeric = false;

  for (const { row, value } of entries ?? []) {
    const classified = classifyNumericDate(value);
    if (classified.shape === "UNAMBIGUOUS") {
      unambiguousRows++;
      continue;
    }
    if (classified.shape === "UNPARSEABLE") {
      unparseableRows++;
      continue;
    }
    // NUMERIC from here.
    sawNumeric = true;
    if (classified.proves === "IMPOSSIBLE") {
      unparseableRows++;
    } else if (classified.proves === DATE_ORDER.DAY_FIRST) {
      if (dayFirstEvidenceRow === null) dayFirstEvidenceRow = row;
    } else if (classified.proves === DATE_ORDER.MONTH_FIRST) {
      if (monthFirstEvidenceRow === null) monthFirstEvidenceRow = row;
    } else {
      ambiguousRows++;
    }
  }

  let status;
  let resolved = null;
  if (dayFirstEvidenceRow !== null && monthFirstEvidenceRow !== null) {
    status = DATE_ORDER_STATUS.CONFLICTING;
  } else if (dayFirstEvidenceRow !== null) {
    status = DATE_ORDER_STATUS.DAY_FIRST;
    resolved = DATE_ORDER.DAY_FIRST;
  } else if (monthFirstEvidenceRow !== null) {
    status = DATE_ORDER_STATUS.MONTH_FIRST;
    resolved = DATE_ORDER.MONTH_FIRST;
  } else if (sawNumeric) {
    status = DATE_ORDER_STATUS.AMBIGUOUS;
  } else {
    status = DATE_ORDER_STATUS.NOT_APPLICABLE;
  }

  return {
    status,
    resolved,
    source: resolved ? "INFERRED" : "NONE",
    ambiguousRows,
    unambiguousRows,
    unparseableRows,
    dayFirstEvidenceRow,
    monthFirstEvidenceRow,
  };
}

// Folds a person's explicitly STATED order into a file's inferred classification.
// A stated order can resolve an AMBIGUOUS file, but can never override a
// CONFLICTING one: if the file itself contains rows proving both orders, no
// single order the person picks can make every row coherent, so the file must
// still be refused and corrected at the source.
function resolveDateOrder({ classification, stated }) {
  if (stated != null && stated !== "" && stated !== DATE_ORDER.DAY_FIRST && stated !== DATE_ORDER.MONTH_FIRST) {
    return { status: "UNSUPPORTED" };
  }

  if (classification.status === DATE_ORDER_STATUS.CONFLICTING) {
    return { ...classification, source: classification.source };
  }
  if (classification.status === DATE_ORDER_STATUS.NOT_APPLICABLE) {
    return { ...classification, resolved: null, source: "NONE" };
  }
  if (!stated) {
    return classification;
  }
  // A stated order wins for AMBIGUOUS, DAY_FIRST and MONTH_FIRST classifications.
  return { ...classification, resolved: stated, source: "STATED" };
}

// Parse a huge range of real-world date shapes into ISO YYYY-MM-DD. `dateOrder`
// decides an AMBIGUOUS row (both numeric fields <= 12); it has no effect on a row
// that proves its own order (one field > 12), which is read the same way under
// either resolution -- see the C1 verification gate for why this matters: a row
// that proves day-first stays day-first even when the file overall resolved
// month-first, because that row was never ambiguous in the first place.
// Returns null when not a real date.
function parseFlexibleDateIso(value, { dateOrder = DATE_ORDER.DAY_FIRST } = {}) {
  let s = String(value ?? "").trim();
  if (!s) return null;
  // strip a leading weekday and any time / timezone portion
  s = s.replace(/\bT\d{1,2}:\d{2}.*$/i, "").trim();
  s = s.replace(/\s+\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)?$/i, "").trim();

  // ISO / YYYY-MM-DD or YYYY/MM/DD or YYYY.MM.DD
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return isoFrom(Number(m[1]), Number(m[2]), Number(m[3]));

  // DD-MM-YYYY / DD/MM/YYYY / DD.MM.YYYY  (also 2-digit year)
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) {
    let day = Number(m[1]);
    let month = Number(m[2]);
    const year = expandYear(m[3]);
    if (day > 12 && month <= 12) {
      // already day-first -- this row proves its own order regardless of dateOrder
    } else if (month > 12 && day <= 12) {
      const t = day; day = month; month = t;
    } else if (day > 12 && month > 12) {
      return null;
    } else if (dateOrder === DATE_ORDER.MONTH_FIRST) {
      const t = day; day = month; month = t;
    }
    // else: both <= 12 and dateOrder is DAY_FIRST (the default) -- day/month as read.
    return isoFrom(year, month, day);
  }

  // DD-Mon-YYYY / DD Mon YYYY / DD-Mon-YY   (e.g. 05-Apr-2026, 5 April 26)
  m = s.match(/^(\d{1,2})[-/. ]+([A-Za-z]{3,9})[-/. ]+(\d{2,4})$/);
  if (m) {
    const month = MONTHS[m[2].toUpperCase()];
    if (month) return isoFrom(expandYear(m[3]), month, Number(m[1]));
  }

  // Mon DD, YYYY  (e.g. Apr 5, 2026 / April 05 2026)
  m = s.match(/^([A-Za-z]{3,9})[-/. ]+(\d{1,2}),?[-/. ]+(\d{2,4})$/);
  if (m) {
    const month = MONTHS[m[1].toUpperCase()];
    if (month) return isoFrom(expandYear(m[3]), month, Number(m[2]));
  }

  // YYYYMMDD (compact, 8 digits)
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return isoFrom(Number(m[1]), Number(m[2]), Number(m[3]));

  // Excel serial date (5-digit integer) -> days since 1899-12-30
  if (/^\d{5}$/.test(s)) {
    const serial = Number(s);
    const ms = Date.UTC(1899, 11, 30) + serial * 86_400_000;
    const d = new Date(ms);
    return isoFrom(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }

  return null;
}

/* --------------------------------------------------------------- money */
// Parse a messy money string into EXACT integer paise. Handles ₹/Rs/INR prefixes,
// Indian & international comma grouping, spaces/NBSP, parentheses or trailing CR as
// negative, trailing DR/DB and "/-", unicode minus/dashes. Throws on genuine junk.
function parseFlexibleMoneyMinor(value, { allowBlank = true, nonNegative = false, field = "amount" } = {}) {
  let raw = String(value ?? "").replace(/\u00a0/g, " ").trim();
  if (!raw) {
    if (allowBlank) return 0;
    throw new Error(`${field} is required`);
  }

  let s = raw.toUpperCase();
  let negative = false;

  // currency words / symbols
  s = s.replace(/₹/g, "").replace(/\bINR\b/g, "").replace(/\bRS\.?/g, "").trim();
  // unicode minus / dashes -> ascii hyphen
  s = s.replace(/[\u2212\u2013\u2014]/g, "-");
  // accounting suffixes
  if (/CR$/.test(s)) { negative = true; s = s.replace(/CR$/, "").trim(); }
  else if (/(DR|DB)$/.test(s)) { s = s.replace(/(DR|DB)$/, "").trim(); }
  // trailing "/-" (e.g. 1000/-)
  s = s.replace(/\/-$/, "").trim();
  // parentheses negative
  if (/^\(.*\)$/.test(s)) { negative = !negative; s = s.slice(1, -1).trim(); }
  // leading sign
  if (s.startsWith("-")) { negative = !negative; s = s.slice(1).trim(); }
  else if (s.startsWith("+")) { s = s.slice(1).trim(); }
  // strip grouping separators and inner spaces and apostrophes
  s = s.replace(/[,\s']/g, "");

  if (!/^\d+(\.\d{1,2})?$/.test(s)) {
    throw new Error(`${field} must be a decimal amount with at most two fraction digits`);
  }
  const [whole, fraction = ""] = s.split(".");
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  const signed = negative ? -minor : minor;
  if (nonNegative && signed < 0n) throw new Error(`${field} cannot be negative`);
  if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(`${field} exceeds safe currency range`);
  }
  return Number(signed);
}

/* --------------------------------------------------------------- labels */
// Uppercase + collapse any run of non-alphanumerics to nothing (for alias lookup).
function labelKey(value) {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function aliasLookup(value, table, fallback = null) {
  const key = labelKey(value);
  if (!key) return fallback;
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : fallback;
}

/* --------------------------------------------------- header synonym resolver */
function headerToken(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// canonical field -> list of accepted header synonyms (as loose phrases)
const HEADER_SYNONYMS = Object.freeze({
  GST: {
    supplierGstin: ["supplier gstin", "gstin of supplier", "supplier gst", "seller gstin", "vendor gstin", "supplier gstn", "gstin supplier", "from gstin"],
    recipientGstin: ["recipient gstin", "buyer gstin", "gstin of recipient", "our gstin", "purchaser gstin", "receiver gstin", "to gstin", "customer gstin"],
    invoiceNumber: ["invoice number", "invoice no", "inv no", "inv number", "bill no", "bill number", "document number", "doc no", "invoice", "voucher no"],
    documentDate: ["document date", "invoice date", "bill date", "doc date", "date", "dated", "invoice dt"],
    documentType: ["document type", "doc type", "invoice type", "type", "voucher type"],
    taxableValue: ["taxable value", "taxable amount", "taxable", "assessable value", "base amount", "net amount", "taxable val"],
    igst: ["igst", "igst amount", "integrated tax", "igst amt", "i gst"],
    cgst: ["cgst", "cgst amount", "central tax", "cgst amt", "c gst"],
    sgst: ["sgst", "sgst amount", "state tax", "sgst utgst", "sgst amt", "s gst", "utgst"],
    cess: ["cess", "cess amount", "cess amt", "gst cess"],
    totalTax: ["total tax", "tax amount", "total gst", "gst amount", "tax total"],
  },
  TDS_DEDUCTIONS: {
    transactionDate: ["transaction date", "date of payment", "payment date", "date", "txn date", "date of credit", "credit date"],
    amountPaid: ["amount paid", "paid amount", "amount", "gross amount", "payment", "amount credited", "amount of payment"],
    deductedAmount: ["deducted amount", "tds amount", "tds deducted", "tax deducted", "deducted", "tds", "amount deducted"],
    deducteeName: ["deductee name", "name", "party name", "vendor name", "deductee", "name of deductee"],
    deducteePan: ["deductee pan", "pan", "pan number", "pan no", "pan of deductee"],
    sectionCode: ["section code", "section", "tds section", "sec", "section no"],
    surcharge: ["surcharge", "surcharge amount"],
    cess: ["cess", "education cess", "health cess", "cess amount"],
  },
  TDS_CHALLANS: {
    bsrCode: ["bsr code", "bsr", "bsr no", "bank bsr code"],
    challanSerial: ["challan serial", "challan no", "serial no", "challan serial number", "challan serial no", "cin serial"],
    challanDate: ["challan date", "deposit date", "date", "date of deposit", "payment date"],
    depositedAmount: ["deposited amount", "amount deposited", "deposit", "amount", "challan amount", "tax deposited"],
    sectionCode: ["section code", "section", "tds section", "sec"],
  },
  TDS_STATEMENTS: {
    filingStatus: ["filing status", "status", "return status", "statement status"],
    reportedAmount: ["reported amount", "amount reported", "reported", "tds reported", "amount"],
    statementReference: ["statement reference", "reference", "statement ref", "token number", "token no", "rrr number", "provisional receipt"],
    filedDate: ["filed date", "date of filing", "filing date", "filed on"],
    deducteePan: ["deductee pan", "pan", "pan number", "pan no"],
    sectionCode: ["section code", "section", "tds section", "sec"],
    correctionStatus: ["correction status", "correction", "revision status"],
    correctionReference: ["correction reference", "correction ref", "revised token"],
    certificateStatus: ["certificate status", "cert status", "form 16 status", "certificate"],
    certificateType: ["certificate type", "cert type", "form type", "form"],
  },
  TDS_26AS: {
    deducteePan: ["deductee pan", "pan", "pan number", "pan no"],
    creditDate: ["credit date", "date of credit", "date", "booking date"],
    creditedAmount: ["credited amount", "amount credited", "credit", "amount", "tax credit"],
    sourceReference: ["source reference", "reference", "source", "transaction reference"],
    deducteeName: ["deductee name", "name", "deductor name"],
    sectionCode: ["section code", "section", "tds section", "sec"],
  },
});

function levenshtein(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// Resolve a raw column header to a canonical field for a given import kind.
// Exact synonym match first, then token-subset containment, then near (<=1 edit).
function resolveHeaderField(header, kind) {
  const dict = HEADER_SYNONYMS[kind];
  if (!dict) return null;
  const tok = headerToken(header);
  if (!tok) return null;

  let best = null;
  let bestScore = -1;
  for (const [field, synonyms] of Object.entries(dict)) {
    for (const syn of synonyms) {
      let score = -1;
      if (tok === syn) score = 1000 + syn.length;
      else {
        const t = ` ${tok} `;
        const s = ` ${syn} `;
        if (t.includes(s)) score = 500 + syn.length; // header contains the whole synonym
        else if (s.includes(t)) score = 400 + tok.length; // synonym contains the header
        else if (levenshtein(tok, syn, 1) <= 1) score = 100 + syn.length;
      }
      if (score > bestScore) { bestScore = score; best = field; }
    }
  }
  return best;
}

// Build a field->sourceHeader mapping object from a header row for a kind.
function buildMappingFromHeaders(headers, kind) {
  const mapping = {};
  for (const header of headers) {
    const field = resolveHeaderField(header, kind);
    if (field && !mapping[field]) mapping[field] = header;
  }
  return mapping;
}

/* --------------------------------------------------------------- statutory dates */
// Strict date parsing for anything that decides a statutory outcome (a hearing date, a
// limitation date, a compliance due date, a reminder). Deliberately separate from the
// tolerant parseFlexibleDateIso above: an IMPORTED FILE's dates get every reasonable
// benefit of the doubt with an explicit, reviewable date-order decision (see
// classifyDateColumn), but a value typed or posted directly into one API field gets none.
// The reason is `new Date(string)`, which this function replaces at every site that used
// to call it on a request-supplied value:
//   new Date('05-03-2026').getUTCMonth()  === 4   -- reads as May, not 5 March
//   new Date('03/05/2026').toISOString()  starts '2026-03-04' -- reads as 5 March, one
//                                                                 day early once shifted to UTC
// Both are silent, and there is no per-file classification pass to catch a single posted
// value the way there is for a whole imported column, so guessing here is not an option:
// this function accepts ONLY an unambiguous shape and refuses everything else.
function parseStatutoryDayIso(value, label) {
  const raw = String(value ?? "").trim();
  const dayOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (dayOnly) {
    const [, y, mo, d] = dayOnly;
    const iso = isoFrom(Number(y), Number(mo), Number(d));
    if (!iso) {
      throw new StatutoryDateError(`${label} is not a real calendar date`);
    }
    return new Date(`${iso}T00:00:00.000Z`);
  }

  // A full ISO 8601 instant, constructed via Date.UTC from the CAPTURED parts rather than
  // handed to the Date constructor, so this function never itself relies on the ambiguous
  // parsing it exists to refuse.
  const instant = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})$/.exec(raw);
  if (instant) {
    const [, y, mo, d, h, mi, s, ms, offset] = instant;
    if (!isoFrom(Number(y), Number(mo), Number(d))) {
      throw new StatutoryDateError(`${label} is not a real calendar date`);
    }
    let ms1 = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s || 0), Number((ms || "0").padEnd(3, "0")));
    if (offset !== "Z") {
      const sign = offset[0] === "-" ? 1 : -1;
      const [oh, om] = offset.slice(1).replace(":", "").match(/^(\d{2})(\d{2})$/).slice(1).map(Number);
      ms1 += sign * ((oh * 60 + om) * 60_000);
    }
    const date = new Date(ms1);
    if (Number.isNaN(date.getTime())) {
      throw new StatutoryDateError(`${label} is not a real calendar date`);
    }
    return date;
  }

  throw new StatutoryDateError(`${label} must be an ISO date (YYYY-MM-DD) or a full ISO timestamp with a timezone`);
}

class StatutoryDateError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 400;
  }
}

export {
  DATE_FIELDS_BY_KIND,
  DATE_ORDER,
  DATE_ORDER_STATUS,
  HEADER_SYNONYMS,
  aliasLookup,
  buildMappingFromHeaders,
  classifyDateColumn,
  classifyNumericDate,
  labelKey,
  parseFlexibleDateIso,
  parseFlexibleMoneyMinor,
  parseStatutoryDayIso,
  resolveDateOrder,
  resolveHeaderField,
};
