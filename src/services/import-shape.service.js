// Works out the shape of an uploaded table before any value is read from it:
// which row is the header, which columns are real, and what to call a column
// the file did not name.
//
// Why this exists. The parser used to assume row 1 is the header, reject any
// file containing an empty header cell, and reject any file with two columns
// of the same name. Every one of those is normal in a register a chartered
// accountant actually has:
//
//   - Tally, Busy and Zoho all print a title, the client name and the period
//     above the column headings, so the header is rarely row 1.
//   - Excel appends trailing empty columns to almost every export, so
//     "contains an empty header" fired on files that were otherwise perfect.
//   - Tally's own columns repeat: two "Amount" columns, or "Rate" twice.
//
// A file failing for any of those reasons is not a data problem, it is a
// shape problem, and rejecting the whole upload for it means the user's real
// question - does my ITC reconcile - never gets asked.
//
// Nothing here interprets a value. Dates and money stay entirely with
// robust-normalize.service.js; this module only decides which cells are the
// headings and which are the data.

import { HEADER_SYNONYMS } from "./robust-normalize.service.js";

// A heading names a field; a data cell holds a value. The words real files use
// for those fields are already catalogued once, per import kind, in
// robust-normalize.service.js — reused here rather than copied, so a synonym
// added for column mapping is also a synonym this recogniser knows, and the
// two can never drift apart.
//
// Flattened across every kind on purpose: deciding WHICH row is the heading
// row does not need to know whether the file is GST or TDS, and a shared list
// means a TDS challan register gets the same header detection as a GST
// purchase register for free.
const ALL_SYNONYMS = Object.freeze(
  Array.from(
    new Set(
      Object.values(HEADER_SYNONYMS)
        .flatMap((fieldsForKind) => Object.values(fieldsForKind))
        .flat()
        .map((synonym) => String(synonym).toLowerCase()),
    ),
  ),
);

// How far into a file to look for the heading row. A preamble longer than
// this is not a preamble, it is a different document.
const MAX_HEADER_SEARCH_ROWS = 25;

function compare(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isBlank(value) {
  return String(value ?? "").trim() === "";
}

// A cell that reads as a number, a date or a currency amount is data, not a
// heading. Used to stop a row of figures being mistaken for the header when
// the real header is further down.
function looksLikeData(value) {
  const text = String(value ?? "").trim();
  if (!text) return false;
  if (/^[-+(]?\s*(?:rs\.?|inr|₹)?\s*[\d,][\d,.\s]*\)?\s*(?:cr|dr)?$/i.test(text)) return true;
  if (/^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$/.test(text)) return true;
  if (/^\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/i.test(text)) return true;
  return false;
}

function headerScore(row) {
  const cells = row.map((cell) => String(cell ?? "").trim());
  const filled = cells.filter((cell) => cell !== "");
  if (filled.length < 2) return -1;

  let recognised = 0;
  let dataLike = 0;
  for (const cell of filled) {
    const normalized = compare(cell);
    if (!normalized) continue;
    if (
      ALL_SYNONYMS.includes(normalized) ||
      ALL_SYNONYMS.some(
        (synonym) => normalized.includes(synonym) && synonym.length >= 4,
      )
    ) {
      recognised += 1;
    }
    if (looksLikeData(cell)) dataLike += 1;
  }

  // Recognised headings dominate; a row of figures is pushed below zero so a
  // data row can never outscore a genuine header.
  return recognised * 10 + filled.length - dataLike * 12;
}

// Finds the heading row. Returns 0 when nothing scores better, so a file that
// really does start with its headings behaves exactly as it always did.
export function findHeaderRow(rows) {
  if (!Array.isArray(rows) || !rows.length) return 0;
  const limit = Math.min(rows.length, MAX_HEADER_SEARCH_ROWS);
  let bestIndex = 0;
  let bestScore = -Infinity;
  for (let index = 0; index < limit; index += 1) {
    const score = headerScore(rows[index] || []);
    // Strictly greater keeps the earliest of equally good candidates, which
    // matters when a register repeats its headings on every printed page.
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return bestScore <= 0 ? 0 : bestIndex;
}

// Turns a raw heading row into usable column names, and reports what it had
// to change. Every adjustment is returned as a note so the caller can show
// the user what was assumed rather than silently reshaping their file.
export function normalizeHeaderRow(rawHeaders) {
  const cells = (Array.isArray(rawHeaders) ? rawHeaders : []).map((cell) =>
    String(cell ?? "").trim(),
  );

  // Trailing empty columns are Excel's doing, not the user's, and carry no
  // data. Interior blanks are kept and named, because a column with values
  // under an unnamed heading is still a column somebody may want to map.
  let end = cells.length;
  while (end > 0 && isBlank(cells[end - 1])) end -= 1;
  const trailingDropped = cells.length - end;
  const kept = cells.slice(0, end);

  const notes = [];
  if (trailingDropped > 0) {
    notes.push({
      code: "TRAILING_EMPTY_COLUMNS_DROPPED",
      count: trailingDropped,
    });
  }

  const seen = new Map();
  const headers = kept.map((cell, index) => {
    let name = cell;
    if (!name) {
      name = `Column ${index + 1}`;
      notes.push({ code: "UNNAMED_COLUMN", column: index + 1, name });
    }
    // Two columns of the same name are common in accounting exports. Renaming
    // the later one keeps both mappable instead of failing the whole file.
    const count = seen.get(name) || 0;
    seen.set(name, count + 1);
    if (count > 0) {
      const unique = `${name} (${count + 1})`;
      notes.push({ code: "DUPLICATE_COLUMN_RENAMED", from: name, to: unique });
      seen.set(unique, 1);
      return unique;
    }
    return name;
  });

  return { headers, keptColumns: end, notes };
}

// A row that repeats the headings, or that is a printed page's "Total" line,
// is not a record. It is reported rather than dropped in silence: a register
// whose totals row vanished without mention is one a reviewer cannot tie back
// to the source document.
export function classifyNonDataRow(row, headers, dataRowLabels = new Set()) {
  const cells = (Array.isArray(row) ? row : []).map((cell) => String(cell ?? "").trim());
  const filled = cells.filter((cell) => cell !== "");
  if (!filled.length) return "EMPTY";

  const headerish = headers.map(compare);
  const matches = cells.filter(
    (cell, index) => cell && headerish[index] && compare(cell) === headerish[index],
  ).length;
  if (matches >= 2 && matches >= Math.ceil(filled.length / 2)) return "REPEATED_HEADER";

  // A totals line labels itself and carries no supplier. Both halves matter:
  //
  //   - The label is matched EXACTLY, not as a prefix. A supplier really can
  //     be called "Total Solutions Pvt Ltd", and discarding its invoice as a
  //     totals line would drop real input tax credit from the reconciliation.
  //   - A totals line has no GSTIN, because it is a sum rather than a supply.
  //     Requiring that as well means even an exact "Total" in a description
  //     column cannot take an invoice row out of the file.
  //
  // Counting filled cells was tried and is wrong: a totals line normally does
  // carry the summed amounts, so it looks as populated as a real row.
  const TOTALS_LABELS = new Set([
    "total",
    "totals",
    "grand total",
    "sub total",
    "subtotal",
    "closing balance",
    "opening balance",
    "net total",
  ]);
  const hasGstin = cells.some((cell) =>
    /^\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/i.test(cell),
  );
  const label = compare(filled[0]);

  // A label that IS this kind's own data must never be read as a totals footer.
  //
  // An electronic credit ledger's rows are literally "Opening Balance", "Credit", "Debit" and
  // "Closing Balance" - and two of those are in TOTALS_LABELS above, because in an invoice
  // register they really are a footer. Stripping them from a LEDGER silently removed the opening
  // balance from every ledger import: the closing balance then came out as credits minus debits,
  // and the credit reconciliation reported a wrong difference against the ITC claimed, with
  // nothing on screen to say a row had been dropped.
  //
  // The caller supplies this set because only the caller knows the kind. The default empty set
  // leaves the invoice-register behaviour exactly as it was.
  if (dataRowLabels.has(label)) return null;

  if (!hasGstin && TOTALS_LABELS.has(label)) return "TOTALS";
  return null;
}

// Applies the shape decisions to a parsed grid. Returns the header names, the
// data rows padded to the header width, and the notes describing every
// adjustment made.
export function shapeTable(rows, { dataRowLabels = new Set() } = {}) {
  const grid = Array.isArray(rows) ? rows : [];
  const headerRowIndex = findHeaderRow(grid);
  const { headers, keptColumns, notes } = normalizeHeaderRow(grid[headerRowIndex] || []);

  if (headerRowIndex > 0) {
    notes.unshift({ code: "PREAMBLE_ROWS_SKIPPED", count: headerRowIndex });
  }

  const dataRows = [];
  const skipped = [];
  for (let index = headerRowIndex + 1; index < grid.length; index += 1) {
    const row = (grid[index] || []).slice(0, keptColumns);
    while (row.length < keptColumns) row.push("");
    const nonData = classifyNonDataRow(row, headers, dataRowLabels);
    if (nonData) {
      // Source row numbers stay 1-based against the original file so a
      // message about "row 42" means row 42 in the user's spreadsheet.
      if (nonData !== "EMPTY") skipped.push({ row: index + 1, reason: nonData });
      continue;
    }
    dataRows.push({ sourceRow: index + 1, cells: row });
  }

  return { headerRowIndex, headers, dataRows, skipped, notes };
}

// compare is exported so callers build their label sets with the SAME normalisation this file
// compares against. A caller that lower-cased by hand would silently fail to match.
export { ALL_SYNONYMS, MAX_HEADER_SEARCH_ROWS, compare as normalizeRowLabel };
