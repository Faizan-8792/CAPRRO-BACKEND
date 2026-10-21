// src/services/gst-cause.service.js
//
// W11 IN8-IN10 (2026-10-21): the likely cause of each open, non-matched reconciliation item, from rules.
//
// Why. Every non-exact item needs a person to choose a disposition and type a reason. The matching engine
// (gst-matching.service.js) says WHAT disagrees; nothing said WHY. Three gaps in particular:
//   - candidateScore pairs only equal GSTINs, so one mistyped GSTIN character shows as two unrelated items
//     (MISSING_IN_2B and MISSING_IN_BOOKS) and the GSTIN_MISMATCH status is never produced;
//   - nothing links runs, so the most common cause - the supplier filed late and the invoice is in next
//     month's 2B - was never detected;
//   - a tax-head swap (IGST against CGST + SGST) and an invoice number differing only by its financial-year
//     token read as plain mismatches.
//
// What this does NOT do: change a match, a status, an amount or any stored figure. The matching engine owns
// pairing (CLAUDE.md section 8); this module only reads items and explains them. A GSTIN typo in particular is
// explained, not matched: the 2B GSTIN decides the credit, so the books are corrected, not paired.
//
// Every rule has an id (R1-R7), a cause code, the evidence it compared and a suggested disposition. Wording that
// carries professional meaning is the owner's to approve before the `intelligence` flag goes on
// (.kiro/OWNER-TODO.md, W11 item 3). Rule order decides which cause an item shows when two fire; the others are
// listed as alsoFired.

export const GST_CAUSE_RULE_VERSION = "gst-cause-v1";

export const RULE_CAUSES = Object.freeze({
  R1: "GSTIN_TYPO",
  R2_LATER_2B: "SUPPLIER_FILED_LATE",
  R2_EARLIER_2B: "IN_EARLIER_2B",
  R2_EARLIER_BOOKS: "BOOKED_IN_EARLIER_PERIOD",
  R2_LATER_BOOKS: "BOOKED_IN_LATER_PERIOD",
  R3: "INVOICE_NUMBER_FORMAT",
  R4: "TAX_HEAD_SWAP",
  R5: "GOODS_RECEIPT_DATE_IN_BOOKS",
  R6: "DOCUMENT_TYPE",
  R7: "DUPLICATE_IN_BOOKS",
});

export const TOLERANCE_MINOR = 100; // the matching engine's rounding tolerance, in paise
export const R5_MIN_DAYS = 4; // the matching engine already tolerates 3 days
export const R5_MAX_DAYS = 45; // owner to confirm (.kiro/OWNER-TODO.md, W11 item 10)
const CROSS_RUN_MAX_MONTHS = 12;

const GSTIN_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** The GSTIN check character (position 15) computed from the first 14, or null when the input is not 15 chars. */
export function gstinCheckChar(gstin) {
  const value = String(gstin || "").toUpperCase();
  if (value.length !== 15) return null;
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const code = GSTIN_CHARS.indexOf(value[i]);
    if (code < 0) return null;
    const product = code * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36];
}

export function gstinChecksumValid(gstin) {
  const value = String(gstin || "").toUpperCase();
  const check = gstinCheckChar(value);
  return check !== null && value[14] === check;
}

/** Characters that differ at the same position, plus one for an adjacent swap; Infinity for unequal lengths. */
export function gstinDistance(left, right) {
  const a = String(left || "").toUpperCase();
  const b = String(right || "").toUpperCase();
  if (a.length !== b.length || !a.length) return Infinity;
  const diffs = [];
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) diffs.push(i);
  if (diffs.length === 2 && diffs[1] === diffs[0] + 1 && a[diffs[0]] === b[diffs[1]] && a[diffs[1]] === b[diffs[0]]) return 1;
  return diffs.length;
}

// A financial-year token a supplier writes as its own part of the number: 2025-26 (two tokens once split),
// 25-26, 2025/26, FY2526, FY 2025-26, 202526. Only a SEPARATE token counts: "INV04572526" is left alone,
// because inside a run of digits a year cannot be told from the number itself.
function isFinancialYearToken(token) {
  if (token === "FY") return true;
  const match = token.match(/^(?:FY)?(?:20)?(\d{2})(?:20)?(\d{2})$/);
  return Boolean(match) && Number(match[2]) === (Number(match[1]) + 1) % 100;
}

/**
 * The bare core of an invoice number as written (the original, with its separators): financial-year tokens,
 * leading letters-only tokens (INV, BILL, a supplier's own prefix) and leading zeros removed. Two numbers with
 * the same core and different normalised forms differ "only in format". A year-like token is kept when it is
 * the only token with a digit in it - then it may be the number itself.
 */
export function invoiceCore(original) {
  const tokens = String(original || "").toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  const pairs = [];
  for (let i = 0; i < tokens.length; i += 1) {
    // "2025-26" splits into "2025" and "26": rejoin a 4-digit year followed by its next year's two digits.
    if (/^(?:FY)?20\d{2}$/.test(tokens[i]) && /^\d{2}$/.test(tokens[i + 1] || "") && Number(tokens[i + 1]) === (Number(tokens[i].slice(-2)) + 1) % 100) {
      pairs.push(`${tokens[i]}${tokens[i + 1]}`);
      i += 1;
    } else if (/^\d{2}$/.test(tokens[i]) && /^\d{2}$/.test(tokens[i + 1] || "") && i + 2 >= tokens.length && Number(tokens[i + 1]) === (Number(tokens[i]) + 1) % 100 && i > 0) {
      pairs.push(`${tokens[i]}${tokens[i + 1]}`);
      i += 1;
    } else {
      pairs.push(tokens[i]);
    }
  }
  const withDigits = pairs.filter((token) => /\d/.test(token));
  let kept = pairs;
  if (withDigits.filter((token) => !isFinancialYearToken(token)).length >= 1) {
    kept = pairs.filter((token) => !isFinancialYearToken(token));
  }
  while (kept.length > 1 && /^[A-Z]+$/.test(kept[0])) kept = kept.slice(1);
  let value = kept.join("");
  value = value.replace(/^[A-Z]+(?=\d)/, "");
  value = value.replace(/^0+(?=\d)/, "");
  return value;
}

function amountsOf(breakdown) {
  return {
    taxable: Number(breakdown?.taxableValueMinor || 0),
    igst: Number(breakdown?.igstMinor || 0),
    cgst: Number(breakdown?.cgstMinor || 0),
    sgst: Number(breakdown?.sgstMinor || 0),
    cess: Number(breakdown?.cessMinor || 0),
    totalTax: Number(breakdown?.totalTaxMinor || 0),
  };
}

const near = (a, b, tolerance = TOLERANCE_MINOR) => Math.abs(Number(a) - Number(b)) <= tolerance;
const hasBooks = (item) => Boolean(item.booksRowId);
const hasPortal = (item) => Boolean(item.portalRowId);
const booksOnly = (item) => hasBooks(item) && !hasPortal(item);
const portalOnly = (item) => hasPortal(item) && !hasBooks(item);
const sameAmounts = (left, right) => near(left.taxable, right.taxable) && near(left.totalTax, right.totalTax);

/** Indian digit grouping for paise: 12345678 -> "1,23,456.78" (two decimals only when there are paise). */
export function formatRupees(minor) {
  const value = Math.round(Number(minor) || 0);
  const negative = value < 0;
  const abs = Math.abs(value);
  const rupees = Math.floor(abs / 100);
  const paise = abs % 100;
  const digits = String(rupees);
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  const grouped = rest ? `${rest},${last3}` : last3;
  return `${negative ? "-" : ""}₹${grouped}${paise ? `.${String(paise).padStart(2, "0")}` : ""}`;
}

function monthsBetween(left, right) {
  const [ly, lm] = String(left).split("-").map(Number);
  const [ry, rm] = String(right).split("-").map(Number);
  return (ly - ry) * 12 + (lm - rm);
}

function periodLabel(period) {
  const [year, month] = String(period || "").split("-").map(Number);
  if (!year || !month) return String(period || "");
  const names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${names[month - 1]} ${year}`;
}

function cause(item, ruleId, causeCode, summary, evidence, suggestedDisposition, extra = {}) {
  return {
    itemId: String(item._id),
    itemKey: item.itemKey,
    source: "RULE",
    ruleId,
    cause: causeCode,
    summary,
    evidence,
    suggestedDisposition,
    reasonDraft: summary,
    candidatePortalRowId: null,
    relatedItemIds: [],
    relatedRun: null,
    ...extra,
  };
}

// ─── the rules ───────────────────────────────────────────────────────────────

// R7: the engine already marks a duplicate; the rule names the cause and the fix.
function ruleR7(item) {
  if (item.status !== "DUPLICATE_IN_BOOKS") return null;
  return cause(item, "R7", RULE_CAUSES.R7,
    "The books carry this invoice more than once from the same supplier with the same amount. Keep one entry and reverse the other.",
    [{ label: "Status", books: "Duplicate in books", portal: "" }],
    "BOOKS_CORRECTION");
}

// R1: a books-only and a 2B-only item for what is plainly the same invoice, with GSTINs a typo apart.
function ruleR1(item, context) {
  if (!booksOnly(item) && !portalOnly(item)) return null;
  const mine = amountsOf(hasBooks(item) ? item.booksAmounts : item.portalAmounts);
  const pool = booksOnly(item) ? context.portalOnly : context.booksOnly;
  for (const other of pool) {
    if (other.supplierGstin === item.supplierGstin) continue;
    const sameNumber = other.invoiceNumberNormalized && (other.invoiceNumberNormalized === item.invoiceNumberNormalized
      || (invoiceCore(other.invoiceNumberOriginal) && invoiceCore(other.invoiceNumberOriginal) === invoiceCore(item.invoiceNumberOriginal)));
    if (!sameNumber) continue;
    const theirs = amountsOf(hasBooks(other) ? other.booksAmounts : other.portalAmounts);
    if (!sameAmounts(mine, theirs)) continue;
    const booksGstin = booksOnly(item) ? item.supplierGstin : other.supplierGstin;
    const portalGstin = booksOnly(item) ? other.supplierGstin : item.supplierGstin;
    const distance = gstinDistance(booksGstin, portalGstin);
    const checksumPoints = !gstinChecksumValid(booksGstin) && gstinChecksumValid(portalGstin);
    if (!(distance <= 2 || (checksumPoints && distance <= 3))) continue;
    const summary = `The same invoice is in the books under GSTIN ${booksGstin} and in GSTR-2B under ${portalGstin}. `
      + (checksumPoints ? "The books GSTIN fails its check digit; " : "The two differ by a character or two; ")
      + "the GSTIN in GSTR-2B decides the credit, so correct the books.";
    return cause(item, "R1", RULE_CAUSES.R1, summary,
      [{ label: "Supplier GSTIN", books: booksGstin, portal: portalGstin }, { label: "Invoice", books: (booksOnly(item) ? item : other).invoiceNumberOriginal, portal: (booksOnly(item) ? other : item).invoiceNumberOriginal }],
      "BOOKS_CORRECTION",
      { relatedItemIds: [String(other._id)] });
  }
  return null;
}

// R2: the same supplier and invoice on the other side in another period's run.
function ruleR2(item, context) {
  if (!booksOnly(item) && !portalOnly(item)) return null;
  const mine = amountsOf(hasBooks(item) ? item.booksAmounts : item.portalAmounts);
  const lookingFor = booksOnly(item) ? "portal" : "books";
  const matches = context.otherRunItems.filter((other) => {
    if (other.supplierGstin !== item.supplierGstin) return false;
    if (!other.invoiceNumberNormalized || other.invoiceNumberNormalized !== item.invoiceNumberNormalized) return false;
    if (lookingFor === "portal" ? !hasPortal(other) : !hasBooks(other)) return false;
    const theirs = amountsOf(lookingFor === "portal" ? other.portalAmounts : other.booksAmounts);
    return sameAmounts(mine, theirs) && Math.abs(monthsBetween(other.period, context.period)) <= CROSS_RUN_MAX_MONTHS;
  });
  if (!matches.length) return null;
  matches.sort((a, b) => Math.abs(monthsBetween(a.period, context.period)) - Math.abs(monthsBetween(b.period, context.period)));
  const other = matches[0];
  const later = monthsBetween(other.period, context.period) > 0;
  const label = periodLabel(other.period);
  const relatedRun = { runId: String(other.runId), period: other.period };
  if (lookingFor === "portal") {
    if (later) {
      return cause(item, "R2", RULE_CAUSES.R2_LATER_2B,
        `This invoice appears in GSTR-2B for ${label}, not in this period's. The supplier reported it late; the credit belongs to the period it appears in.`,
        [{ label: "Seen in GSTR-2B", books: periodLabel(context.period), portal: label }],
        "DEFER", { relatedItemIds: [String(other._id)], relatedRun });
    }
    return cause(item, "R2", RULE_CAUSES.R2_EARLIER_2B,
      `This invoice already appeared in GSTR-2B for ${label}. Check whether its credit was taken in that period before taking it here.`,
      [{ label: "Seen in GSTR-2B", books: periodLabel(context.period), portal: label }],
      "ACCEPT_EXCEPTION", { relatedItemIds: [String(other._id)], relatedRun });
  }
  if (later) {
    return cause(item, "R2", RULE_CAUSES.R2_LATER_BOOKS,
      `This invoice is entered in the books for ${label}, a later period than this GSTR-2B. It was booked after the supplier reported it.`,
      [{ label: "Entered in books", books: label, portal: periodLabel(context.period) }],
      "DEFER", { relatedItemIds: [String(other._id)], relatedRun });
  }
  return cause(item, "R2", RULE_CAUSES.R2_EARLIER_BOOKS,
    `This invoice was entered in the books for ${label} and appears in GSTR-2B only now. The supplier reported it late.`,
    [{ label: "Entered in books", books: label, portal: periodLabel(context.period) }],
    "ACCEPT_EXCEPTION", { relatedItemIds: [String(other._id)], relatedRun });
}

// R6: an invoice on one side, a credit or debit note on the other, same supplier, number and amount.
function ruleR6(item, context) {
  const describe = (type) => String(type || "INVOICE").replace(/_/g, " ").toLowerCase();
  if (hasBooks(item) && hasPortal(item)) {
    if (item.status !== "POSSIBLE_AMENDMENT" || !item.portalDocumentType || item.portalDocumentType === item.documentType) return null;
    return cause(item, "R6", RULE_CAUSES.R6,
      `The books record a ${describe(item.documentType)} and GSTR-2B a ${describe(item.portalDocumentType)} for this number. Enter it in the books as the supplier reported it.`,
      [{ label: "Document type", books: describe(item.documentType), portal: describe(item.portalDocumentType) }],
      "BOOKS_CORRECTION");
  }
  if (!booksOnly(item) && !portalOnly(item)) return null;
  const pool = booksOnly(item) ? context.portalOnly : context.booksOnly;
  const mine = amountsOf(hasBooks(item) ? item.booksAmounts : item.portalAmounts);
  for (const other of pool) {
    if (other.supplierGstin !== item.supplierGstin || other.documentType === item.documentType) continue;
    if (!other.invoiceNumberNormalized || other.invoiceNumberNormalized !== item.invoiceNumberNormalized) continue;
    const theirs = amountsOf(hasBooks(other) ? other.booksAmounts : other.portalAmounts);
    if (!near(Math.abs(mine.taxable), Math.abs(theirs.taxable)) || !near(Math.abs(mine.totalTax), Math.abs(theirs.totalTax))) continue;
    const booksType = booksOnly(item) ? item.documentType : other.documentType;
    const portalType = booksOnly(item) ? other.documentType : item.documentType;
    return cause(item, "R6", RULE_CAUSES.R6,
      `The books record a ${describe(booksType)} and GSTR-2B a ${describe(portalType)} with the same number and amount. Enter it in the books as the supplier reported it.`,
      [{ label: "Document type", books: describe(booksType), portal: describe(portalType) }],
      "BOOKS_CORRECTION", { relatedItemIds: [String(other._id)] });
  }
  return null;
}

// R4: IGST on one side, CGST + SGST on the other, same taxable value and total tax.
function ruleR4(item) {
  if (!hasBooks(item) || !hasPortal(item)) return null;
  const b = amountsOf(item.booksAmounts);
  const p = amountsOf(item.portalAmounts);
  if (!near(b.taxable, p.taxable)) return null;
  const bCs = b.cgst + b.sgst;
  const pCs = p.cgst + p.sgst;
  const booksIgst = b.igst > 0 && bCs === 0 && p.igst === 0 && pCs > 0 && near(b.igst, pCs);
  const booksCs = bCs > 0 && b.igst === 0 && p.igst > 0 && pCs === 0 && near(bCs, p.igst);
  if (!booksIgst && !booksCs) return null;
  const summary = booksIgst
    ? `The books show IGST ${formatRupees(b.igst)}; GSTR-2B shows CGST ${formatRupees(p.cgst)} and SGST ${formatRupees(p.sgst)}. Same total, different tax heads. Check the supplier's invoice: if it charged CGST and SGST, correct the books; if it charged IGST, the supplier must amend.`
    : `The books show CGST ${formatRupees(b.cgst)} and SGST ${formatRupees(b.sgst)}; GSTR-2B shows IGST ${formatRupees(p.igst)}. Same total, different tax heads. Check the supplier's invoice: if it charged IGST, correct the books; if it charged CGST and SGST, the supplier must amend.`;
  return cause(item, "R4", RULE_CAUSES.R4, summary,
    [
      { label: "IGST", books: formatRupees(b.igst), portal: formatRupees(p.igst) },
      { label: "CGST + SGST", books: formatRupees(bCs), portal: formatRupees(pCs) },
    ],
    "BOOKS_CORRECTION");
}

// R3: numbers that differ only by a financial-year token, a letters-only prefix or leading zeros.
function ruleR3(item, context) {
  const core = invoiceCore(item.invoiceNumberOriginal);
  if (!core) return null;
  if (hasBooks(item) && item.candidatePortals?.length === 1) {
    const candidate = item.candidatePortals[0];
    if (candidate.invoiceNumberNormalized !== item.invoiceNumberNormalized && invoiceCore(candidate.invoiceNumberOriginal) === core
      && sameAmounts(amountsOf(item.booksAmounts), amountsOf(candidate.amounts))) {
      return cause(item, "R3", RULE_CAUSES.R3,
        `"${item.invoiceNumberOriginal}" in the books and "${candidate.invoiceNumberOriginal}" in GSTR-2B differ only in how the number is written; the supplier and amounts agree.`,
        [{ label: "Invoice number", books: item.invoiceNumberOriginal, portal: candidate.invoiceNumberOriginal }],
        "ACCEPT_MATCH", { candidatePortalRowId: String(candidate._id) });
    }
  }
  if (!booksOnly(item) && !portalOnly(item)) return null;
  const pool = booksOnly(item) ? context.portalOnly : context.booksOnly;
  const mine = amountsOf(hasBooks(item) ? item.booksAmounts : item.portalAmounts);
  for (const other of pool) {
    if (other.supplierGstin !== item.supplierGstin || other.invoiceNumberNormalized === item.invoiceNumberNormalized) continue;
    if (invoiceCore(other.invoiceNumberOriginal) !== core) continue;
    if (!sameAmounts(mine, amountsOf(hasBooks(other) ? other.booksAmounts : other.portalAmounts))) continue;
    const booksNumber = booksOnly(item) ? item.invoiceNumberOriginal : other.invoiceNumberOriginal;
    const portalNumber = booksOnly(item) ? other.invoiceNumberOriginal : item.invoiceNumberOriginal;
    return cause(item, "R3", RULE_CAUSES.R3,
      `"${booksNumber}" in the books and "${portalNumber}" in GSTR-2B differ only in how the number is written; the supplier and amounts agree. Correct the number in the books so the two match.`,
      [{ label: "Invoice number", books: booksNumber, portal: portalNumber }],
      "BOOKS_CORRECTION", { relatedItemIds: [String(other._id)] });
  }
  return null;
}

// R5: the same invoice, books dated 4-45 days after the supplier's date - a goods-receipt or entry date.
function ruleR5(item) {
  if (!hasBooks(item) || !hasPortal(item)) return null;
  const days = item.dateDifferenceDays;
  if (!Number.isInteger(days) || days < R5_MIN_DAYS || days > R5_MAX_DAYS) return null;
  if (!sameAmounts(amountsOf(item.booksAmounts), amountsOf(item.portalAmounts))) return null;
  return cause(item, "R5", RULE_CAUSES.R5,
    "The books date this invoice later than the supplier did, with the same amounts: usually the date goods were received or the entry was made. The invoice date in GSTR-2B is the one the return uses.",
    [{ label: "Days books date is later", books: `${days} days`, portal: "" }],
    "ACCEPT_EXCEPTION");
}

const RULES = Object.freeze([ruleR7, ruleR1, ruleR2, ruleR6, ruleR4, ruleR3, ruleR5]);
export const RULE_IDS = Object.freeze(["R1", "R2", "R3", "R4", "R5", "R6", "R7"]);

/**
 * Pure: explains open, non-matched items.
 *   items          this run's active items, each with candidatePortals [{_id, invoiceNumberNormalized,
 *                  invoiceNumberOriginal, amounts}] and portalDocumentType filled in by the caller
 *   otherRunItems  items from the same client's other runs (same recipient GSTIN), each with runId and period
 *   period         this run's "YYYY-MM"
 */
export function explainItems({ items = [], otherRunItems = [], period }) {
  const open = items.filter((item) => item.status !== "MATCHED" && item.resolutionState !== "RESOLVED" && item.isActive !== false);
  const context = {
    period,
    booksOnly: open.filter(booksOnly),
    portalOnly: open.filter(portalOnly),
    otherRunItems,
  };
  const causes = [];
  const unexplained = [];
  const byRule = Object.fromEntries(RULE_IDS.map((id) => [id, 0]));
  for (const item of open) {
    const fired = [];
    for (const rule of RULES) {
      const hit = rule(item, context);
      if (hit) fired.push(hit);
    }
    if (!fired.length) {
      unexplained.push(String(item._id));
      continue;
    }
    const [primary, ...rest] = fired;
    byRule[primary.ruleId] += 1;
    causes.push({ ...primary, alsoFired: rest.map((hit) => ({ ruleId: hit.ruleId, cause: hit.cause })) });
  }
  return {
    ruleVersion: GST_CAUSE_RULE_VERSION,
    causes,
    unexplained,
    counts: { open: open.length, explained: causes.length, unexplained: unexplained.length, byRule },
  };
}

/** The invoice number's shape for the model: letters as A, digits as 9, separators kept, never the number. */
export function invoiceShape(original) {
  return String(original || "").toUpperCase().replace(/[A-Z]/g, "A").replace(/[0-9]/g, "9").replace(/\s+/g, " ").slice(0, 30);
}

const rupeesOf = (breakdown) => {
  const a = amountsOf(breakdown);
  return { taxable: a.taxable / 100, igst: a.igst / 100, cgst: a.cgst / 100, sgst: a.sgst / 100, cess: a.cess / 100 };
};

/**
 * Pure: the facts the model sees for one unexplained item (gst_cause_residue). No GSTIN, name or invoice
 * number: amounts in rupees, the number's shape, and up to five other items of the same supplier described
 * the same way with a ref the answer may cite.
 */
export function residueFacts(item, runItems) {
  const books = hasBooks(item) ? rupeesOf(item.booksAmounts) : null;
  const portal = hasPortal(item) ? rupeesOf(item.portalAmounts) : null;
  const difference = books && portal ? rupeesOf(item.differences) : null;
  const sameSupplier = runItems
    .filter((other) => String(other._id) !== String(item._id) && other.supplierGstin === item.supplierGstin)
    .slice(0, 5)
    .map((other, index) => {
      const a = amountsOf(hasBooks(other) ? other.booksAmounts : other.portalAmounts);
      const gap = item.documentDate && other.documentDate
        ? Math.round((Date.parse(`${other.documentDate}T00:00:00Z`) - Date.parse(`${item.documentDate}T00:00:00Z`)) / 86400000)
        : null;
      return { ref: `n${index + 1}`, status: other.status, documentType: other.documentType || "INVOICE", side: hasBooks(other) && hasPortal(other) ? "both" : hasBooks(other) ? "books" : "2B", taxable: a.taxable / 100, totalTax: a.totalTax / 100, dayGap: gap, itemId: String(other._id) };
    });
  return {
    facts: {
      status: item.status,
      documentType: item.documentType || "INVOICE",
      books,
      portal,
      difference,
      dateGapDays: Number.isInteger(item.dateDifferenceDays) ? item.dateDifferenceDays : null,
      invoiceShape: invoiceShape(item.invoiceNumberOriginal),
      rulesTried: [...RULE_IDS],
      sameSupplier: sameSupplier.map(({ itemId, ...rest }) => rest),
    },
    refs: Object.fromEntries(sameSupplier.map((entry) => [entry.ref, entry.itemId])),
  };
}
