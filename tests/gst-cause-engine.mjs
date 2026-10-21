// tests/gst-cause-engine.mjs
//
// W11 IN8-IN10 (2026-10-21): the reconciliation cause rules, pure (no database). One fixture per rule, plus the
// near-misses each rule must NOT fire on. Run: node tests/gst-cause-engine.mjs
//
// Mutations recorded in the ledger's Output lines were made by hand against src/services/gst-cause.service.js
// (e.g. widening R1's distance to 5, dropping R4's taxable-value check) and each made a named fixture below fail.

import {
  explainItems,
  formatRupees,
  gstinChecksumValid,
  gstinDistance,
  invoiceCore,
  invoiceShape,
  residueFacts,
  RULE_CAUSES,
} from "../src/services/gst-cause.service.js";

const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass: Boolean(pass), detail });

let next = 1;
const oid = () => `id${String(next++).padStart(22, "0")}`;
const money = (taxable, igst = 0, cgst = 0, sgst = 0) => ({
  taxableValueMinor: taxable, igstMinor: igst, cgstMinor: cgst, sgstMinor: sgst, cessMinor: 0, totalTaxMinor: igst + cgst + sgst,
});
const zero = money(0);
function item({ status, gstin = "27AAPFU0939F1ZV", number = "INV-457", normalized, books = null, portal = null, date = "2026-07-12", days = null, docType = "INVOICE", candidatePortals = [], portalDocumentType = "" }) {
  return {
    _id: oid(), itemKey: `k${next}`, status, isActive: true, resolutionState: "OPEN", supplierGstin: gstin,
    invoiceNumberOriginal: number, invoiceNumberNormalized: normalized ?? number.toUpperCase().replace(/[^A-Z0-9]/g, ""),
    documentType: docType, documentDate: date, booksRowId: books ? oid() : null, portalRowId: portal ? oid() : null,
    booksAmounts: books || zero, portalAmounts: portal || zero, differences: zero, dateDifferenceDays: days,
    candidatePortals, portalDocumentType,
  };
}
const causeOf = (result, target) => result.causes.find((entry) => entry.itemId === target._id);

// ─── helpers ───
check("GSTIN check digit: a known-good GSTIN passes, one changed character fails", gstinChecksumValid("27AAPFU0939F1ZV") && !gstinChecksumValid("27AAPFU0939F1ZW"));
check("GSTIN distance: one substitution is 1, an adjacent swap is 1, unequal lengths are infinite", gstinDistance("27AAPFU0939F1ZV", "27AAPFU0939F1ZW") === 1 && gstinDistance("27AAPFU0939F1ZV", "27AAPFU9039F1ZV") === 1 && gstinDistance("27AAPFU0939F1ZV", "27AAPFU0939F1Z") === Infinity);
check("invoice core: INV/0457/25-26, FY 2025-26/457 and 457 share a core; INV04572526 keeps its digits", invoiceCore("INV/0457/25-26") === "457" && invoiceCore("FY 2025-26/457") === "457" && invoiceCore("457") === "457" && invoiceCore("INV04572526") === "4572526");
check("invoice core: a lone year-like number is kept as the number", invoiceCore("2526") === "2526");
check("Indian grouping: 1,23,456.78 and a whole-rupee amount without paise", formatRupees(12345678) === "₹1,23,456.78" && formatRupees(11800000) === "₹1,18,000");
check("invoice shape replaces letters and digits", invoiceShape("INV/0457/25-26") === "AAA/9999/99-99");

// ─── R1: GSTIN typo ───
{
  const books = item({ status: "MISSING_IN_2B", gstin: "27AAPFU0939F1ZW", books: money(840000, 0, 75600, 75600) });
  const portal = item({ status: "MISSING_IN_BOOKS", gstin: "27AAPFU0939F1ZV", portal: money(840000, 0, 75600, 75600) });
  const result = explainItems({ items: [books, portal], period: "2026-07" });
  const hit = causeOf(result, books);
  check("R1: a one-character GSTIN typo links the books and 2B items as GSTIN_TYPO, books correction", hit?.ruleId === "R1" && hit.cause === RULE_CAUSES.R1 && hit.suggestedDisposition === "BOOKS_CORRECTION" && hit.relatedItemIds[0] === portal._id && causeOf(result, portal)?.ruleId === "R1", JSON.stringify(hit));
  check("R1: the summary says the books GSTIN fails its check digit", /fails its check digit/.test(hit?.summary || ""));
  const swapped = item({ status: "MISSING_IN_2B", gstin: "27AAPFU9039F1ZV", books: money(840000, 0, 75600, 75600) });
  const r2 = explainItems({ items: [swapped, portal], period: "2026-07" });
  check("R1: a transposed pair of characters is a typo too", causeOf(r2, swapped)?.ruleId === "R1");
  const other = item({ status: "MISSING_IN_2B", gstin: "29BBBBB1111B1ZB", books: money(840000, 0, 75600, 75600) });
  check("R1: two genuinely different suppliers with the same number and amount are NOT linked", !causeOf(explainItems({ items: [other, portal], period: "2026-07" }), other));
  // Valid check digit, three characters away: a different registration, not a typo.
  const threeAway = item({ status: "MISSING_IN_2B", gstin: "27AAQGU0939F1ZS", books: money(840000, 0, 75600, 75600) });
  check("R1: a valid GSTIN three characters away is NOT a typo", !causeOf(explainItems({ items: [threeAway, portal], period: "2026-07" }), threeAway));
  const different = item({ status: "MISSING_IN_2B", gstin: "27AAPFU0939F1ZW", books: money(950000, 0, 85500, 85500) });
  check("R1: a near-miss GSTIN with a different amount is NOT linked", !causeOf(explainItems({ items: [different, portal], period: "2026-07" }), different));
}

// ─── R2: across runs ───
{
  const books = item({ status: "MISSING_IN_2B", books: money(840000, 151200) });
  const laterPortal = { ...item({ status: "MISSING_IN_BOOKS", portal: money(840000, 151200) }), runId: "runAug", period: "2026-08" };
  const result = explainItems({ items: [books], otherRunItems: [laterPortal], period: "2026-07" });
  const hit = causeOf(result, books);
  check("R2: an invoice missing in July's 2B and present in August's is SUPPLIER_FILED_LATE, defer", hit?.ruleId === "R2" && hit.cause === RULE_CAUSES.R2_LATER_2B && hit.suggestedDisposition === "DEFER" && hit.relatedRun?.period === "2026-08" && /August 2026/.test(hit.summary), JSON.stringify(hit));
  const earlierPortal = { ...laterPortal, period: "2026-06" };
  check("R2: present in an EARLIER 2B instead reads IN_EARLIER_2B", causeOf(explainItems({ items: [books], otherRunItems: [earlierPortal], period: "2026-07" }), books)?.cause === RULE_CAUSES.R2_EARLIER_2B);
  const portalNow = item({ status: "MISSING_IN_BOOKS", portal: money(840000, 151200) });
  const earlierBooks = { ...item({ status: "MISSING_IN_2B", books: money(840000, 151200) }), runId: "runJun", period: "2026-06" };
  check("R2: a 2B invoice booked in an earlier period reads BOOKED_IN_EARLIER_PERIOD", causeOf(explainItems({ items: [portalNow], otherRunItems: [earlierBooks], period: "2026-07" }), portalNow)?.cause === RULE_CAUSES.R2_EARLIER_BOOKS);
  const farAway = { ...laterPortal, period: "2028-01" };
  check("R2: an invoice with the same number more than a year away is NOT linked", !causeOf(explainItems({ items: [books], otherRunItems: [farAway], period: "2026-07" }), books));
  const otherSupplier = { ...laterPortal, supplierGstin: "29BBBBB1111B1ZB" };
  check("R2: another supplier's invoice with the same number is NOT linked", !causeOf(explainItems({ items: [books], otherRunItems: [otherSupplier], period: "2026-07" }), books));
}

// ─── R3: number format ───
{
  const books = item({ status: "MISSING_IN_2B", number: "INV/0457/25-26", books: money(840000, 151200) });
  const portal = item({ status: "MISSING_IN_BOOKS", number: "457", portal: money(840000, 151200) });
  const hit = causeOf(explainItems({ items: [books, portal], period: "2026-07" }), books);
  check("R3: INV/0457/25-26 against 457, same supplier and amounts, is INVOICE_NUMBER_FORMAT", hit?.ruleId === "R3" && hit.cause === RULE_CAUSES.R3 && hit.relatedItemIds[0] === portal._id, JSON.stringify(hit));
  const candidateItem = item({ status: "POSSIBLE_AMENDMENT", number: "INV/0457/25-26", books: money(840000, 151200), portal: money(840000, 151200), candidatePortals: [{ _id: "cand1", invoiceNumberNormalized: "457", invoiceNumberOriginal: "457", amounts: money(840000, 151200) }] });
  const candidateHit = causeOf(explainItems({ items: [candidateItem], period: "2026-07" }), candidateItem);
  check("R3: with one candidate that differs only in format, the suggestion is ACCEPT_MATCH naming that candidate", candidateHit?.suggestedDisposition === "ACCEPT_MATCH" && candidateHit.candidatePortalRowId === "cand1", JSON.stringify(candidateHit));
  const realDifferent = item({ status: "MISSING_IN_BOOKS", number: "458", portal: money(840000, 151200) });
  check("R3: 457 against 458 is NOT a format difference", !causeOf(explainItems({ items: [books, realDifferent], period: "2026-07" }), books));
}

// ─── R4: tax heads ───
{
  const swapped = item({ status: "TAX_AMOUNT_MISMATCH", books: money(3600000, 648000), portal: money(3600000, 0, 324000, 324000) });
  const hit = causeOf(explainItems({ items: [swapped], period: "2026-07" }), swapped);
  check("R4: IGST in the books against CGST + SGST in 2B, same total, is TAX_HEAD_SWAP with both figures in rupees", hit?.ruleId === "R4" && /IGST ₹6,480/.test(hit.summary) && /CGST ₹3,240/.test(hit.summary), JSON.stringify(hit?.summary));
  const realDifference = item({ status: "TAX_AMOUNT_MISMATCH", books: money(3600000, 648000), portal: money(3600000, 0, 216000, 216000) });
  check("R4: a different total is NOT a head swap", causeOf(explainItems({ items: [realDifference], period: "2026-07" }), realDifference)?.ruleId !== "R4");
  const taxableDiffers = item({ status: "TAX_AMOUNT_MISMATCH", books: money(3700000, 648000), portal: money(3600000, 0, 324000, 324000) });
  check("R4: a different taxable value is NOT a head swap", causeOf(explainItems({ items: [taxableDiffers], period: "2026-07" }), taxableDiffers)?.ruleId !== "R4");
}

// ─── R5: date basis ───
{
  const late = item({ status: "DATE_MISMATCH", books: money(840000, 151200), portal: money(840000, 151200), days: 12 });
  check("R5: books dated 12 days after the supplier, same amounts, is GOODS_RECEIPT_DATE_IN_BOOKS", causeOf(explainItems({ items: [late], period: "2026-07" }), late)?.ruleId === "R5");
  const early = item({ status: "DATE_MISMATCH", books: money(840000, 151200), portal: money(840000, 151200), days: -12 });
  check("R5: books dated BEFORE the supplier is NOT this rule", causeOf(explainItems({ items: [early], period: "2026-07" }), early)?.ruleId !== "R5");
  const tooFar = item({ status: "DATE_MISMATCH", books: money(840000, 151200), portal: money(840000, 151200), days: 90 });
  check("R5: 90 days apart is outside the window", causeOf(explainItems({ items: [tooFar], period: "2026-07" }), tooFar)?.ruleId !== "R5");
}

// ─── R6: document type ───
{
  const amendment = item({ status: "POSSIBLE_AMENDMENT", docType: "INVOICE", portalDocumentType: "CREDIT_NOTE", books: money(840000, 151200), portal: money(840000, 151200) });
  const hit = causeOf(explainItems({ items: [amendment], period: "2026-07" }), amendment);
  check("R6: books record an invoice, 2B a credit note for the same number: DOCUMENT_TYPE, books correction", hit?.ruleId === "R6" && hit.suggestedDisposition === "BOOKS_CORRECTION", JSON.stringify(hit));
  const pairBooks = item({ status: "MISSING_IN_2B", docType: "INVOICE", number: "CN-12", books: money(-500000, -90000) });
  const pairPortal = item({ status: "MISSING_IN_BOOKS", docType: "CREDIT_NOTE", number: "CN-12", portal: money(500000, 90000) });
  check("R6: a negative invoice in the books against a credit note in 2B links as DOCUMENT_TYPE", causeOf(explainItems({ items: [pairBooks, pairPortal], period: "2026-07" }), pairBooks)?.ruleId === "R6");
}

// ─── R7: duplicate ───
{
  const dup = item({ status: "DUPLICATE_IN_BOOKS", books: money(840000, 151200) });
  check("R7: a duplicate in the books is named, with a books correction", causeOf(explainItems({ items: [dup], period: "2026-07" }), dup)?.ruleId === "R7");
}

// ─── the engine as a whole ───
{
  const matched = { ...item({ status: "MATCHED", books: money(1, 1), portal: money(1, 1) }) };
  const resolved = { ...item({ status: "MISSING_IN_2B", books: money(840000, 151200) }), resolutionState: "RESOLVED" };
  const plain = item({ status: "MISSING_IN_2B", number: "X-1", books: money(123400, 22212) });
  const result = explainItems({ items: [matched, resolved, plain], period: "2026-07" });
  check("matched and resolved items are not explained or counted as open", result.counts.open === 1 && !causeOf(result, matched) && !causeOf(result, resolved));
  check("an item no rule explains is listed as unexplained", result.unexplained.includes(plain._id) && result.counts.unexplained === 1);
  const before = JSON.stringify([matched, resolved, plain]);
  explainItems({ items: [matched, resolved, plain], period: "2026-07" });
  check("the engine changes nothing it was given", JSON.stringify([matched, resolved, plain]) === before);
  const { facts } = residueFacts(plain, [plain, item({ status: "MATCHED", number: "X-2", books: money(123400, 22212), portal: money(123400, 22212) })]);
  const outbound = JSON.stringify(facts);
  check("residue facts carry no GSTIN, no invoice number, and amounts in rupees", !/27AAPFU0939F1ZV/.test(outbound) && !/X-1/.test(outbound) && facts.invoiceShape === "A-9" && facts.books.taxable === 1234 && facts.sameSupplier[0].ref === "n1", outbound);
}

const failed = checks.filter((c) => !c.pass);
for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.pass || !c.detail ? "" : ` -- ${c.detail}`}`);
console.log(`\ngst-cause-engine: ${checks.length - failed.length}/${checks.length} passed`);
process.exitCode = failed.length ? 1 : 0;
