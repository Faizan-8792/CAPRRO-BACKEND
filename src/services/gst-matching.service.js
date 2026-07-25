import {
  addSafeIntegers,
  dateDifferenceDays,
} from "./gst-normalization.service.js";

const REVIEW_STATUSES = new Set([
  "MISSING_IN_2B",
  "MISSING_IN_BOOKS",
  "TAX_AMOUNT_MISMATCH",
  "TAXABLE_VALUE_MISMATCH",
  "DATE_MISMATCH",
  "GSTIN_MISMATCH",
  "DUPLICATE_IN_BOOKS",
  "DUPLICATE_IN_2B",
  "POSSIBLE_AMENDMENT",
  "AMBIGUOUS_MATCH",
  "NEEDS_REVIEW",
]);

const MISMATCH_STATUSES = new Set([
  "TAX_AMOUNT_MISMATCH",
  "TAXABLE_VALUE_MISMATCH",
  "DATE_MISMATCH",
  "GSTIN_MISMATCH",
  "DUPLICATE_IN_BOOKS",
  "DUPLICATE_IN_2B",
  "POSSIBLE_AMENDMENT",
  "AMBIGUOUS_MATCH",
  "NEEDS_REVIEW",
]);

const TAX_HEAD_FIELDS = Object.freeze([
  "igstMinor",
  "cgstMinor",
  "sgstMinor",
  "cessMinor",
  "totalTaxMinor",
]);

const AMOUNT_FIELDS = Object.freeze(["taxableValueMinor", ...TAX_HEAD_FIELDS]);

function plain(row) {
  return typeof row?.toObject === "function" ? row.toObject() : row;
}

function idOf(row) {
  return String(plain(row)?._id || "");
}

function compareRows(left, right) {
  const rowDelta = Number(left.sourceRow || 0) - Number(right.sourceRow || 0);
  return rowDelta || idOf(left).localeCompare(idOf(right));
}

function exactKey(row) {
  const value = plain(row);
  return [
    value.supplierGstin || "",
    value.invoiceNumberNormalized || "",
    value.documentType || "",
  ].join("|");
}

function groupByExactKey(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = exactKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

function safeDifference(left, right) {
  const value = Number(left || 0) - Number(right || 0);
  if (!Number.isSafeInteger(value)) throw new Error("Money difference exceeds safe integer range");
  return value;
}

function amountsFromRow(row) {
  const value = plain(row) || {};
  return Object.fromEntries(
    AMOUNT_FIELDS.map((field) => [field, Number(value[field] || 0)])
  );
}

function amountDifferences(books, portal) {
  const left = amountsFromRow(books);
  const right = amountsFromRow(portal);
  return Object.fromEntries(
    AMOUNT_FIELDS.map((field) => [field, safeDifference(left[field], right[field])])
  );
}

function taxWithinTolerance(differences, toleranceMinor) {
  return TAX_HEAD_FIELDS.every(
    (field) => Math.abs(differences[field]) <= toleranceMinor
  );
}

function levenshteinDistance(left, right, maximum = 2) {
  if (Math.abs(left.length - right.length) > maximum) return maximum + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    let rowMinimum = current[0];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + cost
      );
      rowMinimum = Math.min(rowMinimum, current[rightIndex]);
    }
    if (rowMinimum > maximum) return maximum + 1;
    previous = current;
  }
  return previous[right.length];
}

function invoiceNumbersSimilar(left, right) {
  const leftValue = String(left || "");
  const rightValue = String(right || "");
  if (!leftValue || !rightValue) return false;
  if (leftValue === rightValue) return true;
  if (Math.min(leftValue.length, rightValue.length) >= 5) {
    if (leftValue.includes(rightValue) || rightValue.includes(leftValue)) return true;
  }
  return levenshteinDistance(leftValue, rightValue, 2) <= 2;
}

function candidateScore(books, portal, toleranceMinor, dateToleranceDays) {
  if (books.supplierGstin !== portal.supplierGstin) return null;
  const differences = amountDifferences(books, portal);
  const taxClose = taxWithinTolerance(differences, toleranceMinor);
  const invoiceClose = invoiceNumbersSimilar(
    books.invoiceNumberNormalized,
    portal.invoiceNumberNormalized
  );
  if (!taxClose && !invoiceClose) return null;
  const days = dateDifferenceDays(books.documentDate, portal.documentDate);
  const dateClose = days != null && Math.abs(days) <= dateToleranceDays;
  return {
    portal,
    score: (invoiceClose ? 4 : 0) + (taxClose ? 3 : 0) + (dateClose ? 1 : 0),
    possibleAmendment:
      books.documentType !== portal.documentType ||
      (invoiceClose && books.invoiceNumberNormalized !== portal.invoiceNumberNormalized),
  };
}

function baseItem({ books = null, portal = null, candidates = [], status, matchRule, autoAccepted }) {
  const primary = books || portal;
  const differences = books && portal
    ? amountDifferences(books, portal)
    : amountDifferences(books || {}, portal || {});
  return {
    itemKey: books ? `B:${idOf(books)}` : `P:${idOf(portal)}`,
    booksRowId: books?._id || null,
    portalRowId: portal?._id || null,
    candidatePortalRowIds: candidates.map((candidate) => candidate._id),
    candidateHistoryPortalRowIds: [],
    booksSourceRow: books?.sourceRow || null,
    portalSourceRow: portal?.sourceRow || null,
    supplierGstin: primary?.supplierGstin || "",
    invoiceNumberOriginal: primary?.invoiceNumberOriginal || "",
    invoiceNumberNormalized: primary?.invoiceNumberNormalized || "",
    documentType: primary?.documentType || "",
    documentDate: primary?.documentDate || null,
    booksAmounts: amountsFromRow(books),
    portalAmounts: amountsFromRow(portal),
    differences,
    dateDifferenceDays: books && portal
      ? dateDifferenceDays(books.documentDate, portal.documentDate)
      : null,
    status,
    originalStatus: status,
    matchRule,
    autoAccepted,
    resolutionState: autoAccepted && status === "MATCHED" ? "RESOLVED" : "OPEN",
    decisionVersion: 0,
    userDisposition: {},
    chase: { required: false, state: "NONE", lastActionAt: null },
    reviewedAt: null,
  };
}

function pairedStatus(books, portal) {
  const differences = amountDifferences(books, portal);
  if (TAX_HEAD_FIELDS.some((field) => differences[field] !== 0)) {
    return "TAX_AMOUNT_MISMATCH";
  }
  if (differences.taxableValueMinor !== 0) {
    return "TAXABLE_VALUE_MISMATCH";
  }
  if (dateDifferenceDays(books.documentDate, portal.documentDate) !== 0) {
    return "DATE_MISMATCH";
  }
  return "MATCHED";
}

export function buildReconciliationItems({
  booksRows,
  portalRows,
  roundingToleranceMinor = 100,
  dateToleranceDays = 3,
}) {
  if (!Number.isSafeInteger(roundingToleranceMinor) || roundingToleranceMinor < 0) {
    throw new Error("Rounding tolerance must be a non-negative safe integer");
  }
  const books = [...booksRows].map(plain).sort(compareRows);
  const portal = [...portalRows].map(plain).sort(compareRows);
  const booksGroups = groupByExactKey(books);
  const portalGroups = groupByExactKey(portal);
  const duplicateBooks = new Set(
    [...booksGroups.values()].filter((group) => group.length > 1).flat().map(idOf)
  );
  const duplicatePortal = new Set(
    [...portalGroups.values()].filter((group) => group.length > 1).flat().map(idOf)
  );
  const consumedPortal = new Set();
  const referencedCandidatePortal = new Set();
  const items = [];

  // Index portal rows by supplier GSTIN. The fuzzy candidate search below can
  // only ever match a portal row with the SAME supplier (candidateScore returns
  // null otherwise), so scanning just this bucket is behaviour-identical to
  // scanning all portal rows — but turns an O(unmatched x portal) hotspot into
  // O(unmatched x same-supplier), which is what makes large imports viable.
  const portalBySupplier = new Map();
  for (const row of portal) {
    const supplier = row.supplierGstin || "";
    if (!portalBySupplier.has(supplier)) portalBySupplier.set(supplier, []);
    portalBySupplier.get(supplier).push(row);
  }

  for (const booksRow of books) {
    const key = exactKey(booksRow);
    const exactPortal = (portalGroups.get(key) || []).filter(
      (row) =>
        !consumedPortal.has(idOf(row)) &&
        !referencedCandidatePortal.has(idOf(row))
    );

    if (duplicateBooks.has(idOf(booksRow))) {
      exactPortal.forEach((row) => referencedCandidatePortal.add(idOf(row)));
      items.push(baseItem({
        books: booksRow,
        candidates: exactPortal,
        status: "DUPLICATE_IN_BOOKS",
        matchRule: "NONE",
        autoAccepted: false,
      }));
      continue;
    }

    if (exactPortal.length === 1 && !duplicatePortal.has(idOf(exactPortal[0]))) {
      const portalRow = exactPortal[0];
      const status = pairedStatus(booksRow, portalRow);
      consumedPortal.add(idOf(portalRow));
      items.push(baseItem({
        books: booksRow,
        portal: portalRow,
        status,
        matchRule: status === "MATCHED" ? "EXACT" : "TOLERANT",
        autoAccepted: status === "MATCHED",
      }));
      continue;
    }

    if (exactPortal.length > 1 || exactPortal.some((row) => duplicatePortal.has(idOf(row)))) {
      exactPortal.forEach((row) => referencedCandidatePortal.add(idOf(row)));
      items.push(baseItem({
        books: booksRow,
        candidates: exactPortal,
        status: "AMBIGUOUS_MATCH",
        matchRule: "CANDIDATE",
        autoAccepted: false,
      }));
      continue;
    }

    const candidates = (portalBySupplier.get(booksRow.supplierGstin) || [])
      .filter(
        (row) =>
          !consumedPortal.has(idOf(row)) &&
          !referencedCandidatePortal.has(idOf(row)) &&
          !duplicatePortal.has(idOf(row))
      )
      .map((row) => candidateScore(
        booksRow,
        row,
        roundingToleranceMinor,
        dateToleranceDays
      ))
      .filter(Boolean)
      .sort((left, right) => right.score - left.score || compareRows(left.portal, right.portal));

    if (candidates.length) {
      const bestScore = candidates[0].score;
      const best = candidates.filter((candidate) => candidate.score === bestScore);
      best.forEach((candidate) => referencedCandidatePortal.add(idOf(candidate.portal)));
      items.push(baseItem({
        books: booksRow,
        candidates: best.map((candidate) => candidate.portal),
        status: best.some((candidate) => candidate.possibleAmendment)
          ? "POSSIBLE_AMENDMENT"
          : "AMBIGUOUS_MATCH",
        matchRule: "CANDIDATE",
        autoAccepted: false,
      }));
      continue;
    }

    items.push(baseItem({
      books: booksRow,
      status: "MISSING_IN_2B",
      matchRule: "NONE",
      autoAccepted: false,
    }));
  }

  for (const portalRow of portal) {
    if (
      consumedPortal.has(idOf(portalRow)) ||
      referencedCandidatePortal.has(idOf(portalRow))
    ) continue;
    items.push(baseItem({
      portal: portalRow,
      status: duplicatePortal.has(idOf(portalRow))
        ? "DUPLICATE_IN_2B"
        : "MISSING_IN_BOOKS",
      matchRule: "NONE",
      autoAccepted: false,
    }));
  }

  return items;
}

function addTaxHeads(target, amounts) {
  for (const field of TAX_HEAD_FIELDS) {
    target[field] = addSafeIntegers([target[field], Number(amounts?.[field] || 0)]);
  }
}

function emptyTaxHeads() {
  return Object.fromEntries(TAX_HEAD_FIELDS.map((field) => [field, 0]));
}

function itemIsResolved(item) {
  if (item.resolutionState === "RESOLVED") return true;
  if (item.resolutionState === "OPEN") return false;
  if (item.status === "MATCHED") {
    return Boolean(
      item.autoAccepted ||
      item.userDisposition?.action === "ACCEPT_MATCH"
    );
  }
  return [
    "USER_ACCEPTED_EXCEPTION",
    "INELIGIBLE_OR_BLOCKED",
    "DEFERRED_TO_NEXT_PERIOD",
  ].includes(item.status);
}

export function summarizeReconciliationItems(inputItems) {
  const items = inputItems.map(plain);
  const summary = {
    totalItems: items.length,
    matchedCount: 0,
    missingIn2bCount: 0,
    missingInBooksCount: 0,
    mismatchCount: 0,
    reviewCount: 0,
    reviewedCount: 0,
    eligible: emptyTaxHeads(),
    ineligible: emptyTaxHeads(),
    deferred: emptyTaxHeads(),
    reviewValueMinor: 0,
  };

  for (const item of items) {
    if (item.status === "MATCHED") summary.matchedCount += 1;
    if (item.status === "MISSING_IN_2B") summary.missingIn2bCount += 1;
    if (item.status === "MISSING_IN_BOOKS") summary.missingInBooksCount += 1;
    if (MISMATCH_STATUSES.has(item.status)) summary.mismatchCount += 1;

    const resolved = itemIsResolved(item);
    if (resolved) summary.reviewedCount += 1;
    else summary.reviewCount += 1;

    if (resolved && ["MATCHED", "USER_ACCEPTED_EXCEPTION"].includes(item.status)) {
      addTaxHeads(summary.eligible, item.booksAmounts);
    } else if (resolved && item.status === "INELIGIBLE_OR_BLOCKED") {
      addTaxHeads(summary.ineligible, item.booksAmounts);
    } else if (resolved && item.status === "DEFERRED_TO_NEXT_PERIOD") {
      addTaxHeads(summary.deferred, item.booksAmounts);
    }

    if (!resolved) {
      const amount = item.booksRowId
        ? Number(item.booksAmounts?.totalTaxMinor || 0)
        : Number(item.portalAmounts?.totalTaxMinor || 0);
      summary.reviewValueMinor = addSafeIntegers([
        summary.reviewValueMinor,
        Math.abs(amount),
      ]);
    }
  }

  return summary;
}

export {
  AMOUNT_FIELDS,
  MISMATCH_STATUSES,
  REVIEW_STATUSES,
  TAX_HEAD_FIELDS,
  amountDifferences,
  invoiceNumbersSimilar,
  taxWithinTolerance,
};
