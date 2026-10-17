// src/services/audit-pack-kinds/inputs.js
//
// W10 AP15 (2026-10-17): what a pack asks a person for, declared once on the server so the extension and the
// Windows app draw the same form from it and neither carries its own copy of a pack's inputs. A client that does
// not know an input type shows the pack as "update the app" rather than guessing a control.
//
// Every descriptor is { field, type, label, required, help, ...type-specific }. `field` is the request field the
// pack's create route takes, so a client puts the person's answer under that name and nowhere else.
//
//   BOOKS_SNAPSHOT  a sealed snapshot of the client's books (Tally export) for this year, or the year before
//   IMPORT_BATCHES  the client's completed imports of one kind, any number (a month each, or a quarter each)
//   IMPORT_BATCH    exactly one completed import of one kind
//   CHOICE          one of a short list of words
//   GSTR9_FIGURES   typed amounts for the GSTR-9 rows listed in `rows`; each takes taxable value and four tax heads
//   BANK_RATES      the bank rate in basis points for up to four financial years
//   DATE_DAY        a calendar day, yyyy-mm-dd
//   NAME_LIST       a list of ledger names, one per line
//   PAYMENTS_LIST   payments after the year end: ledger, date, amount
//   AMOUNTS         typed amounts for the rows listed in `rows`, one cell per column in `columns` (a blank cell is
//                   not entered - never read as nil; a row marked `signed` may be negative)
//
// The vocabulary is closed: audit-pack-catalogue-contract fails if a pack declares a type outside it, or accepts
// a create field it never declared.

export const INPUT_TYPES = Object.freeze([
  "BOOKS_SNAPSHOT",
  "IMPORT_BATCHES",
  "IMPORT_BATCH",
  "CHOICE",
  "GSTR9_FIGURES",
  "BANK_RATES",
  "DATE_DAY",
  "NAME_LIST",
  "PAYMENTS_LIST",
  "AMOUNTS",
]);

const describe = (field, type, label, extra = {}) => Object.freeze({ field, type, label, required: false, help: "", ...extra });

export const booksSnapshotInput = (field, label, help = "") => describe(field, "BOOKS_SNAPSHOT", label, { required: true, help });
export const importBatchesInput = (field, batchKind, label, extra = {}) => describe(field, "IMPORT_BATCHES", label, { batchKind, ...extra });
export const importBatchInput = (field, batchKind, label, extra = {}) => describe(field, "IMPORT_BATCH", label, { batchKind, ...extra });
export const choiceInput = (field, label, options, defaultValue, help = "") =>
  describe(field, "CHOICE", label, { options: options.map(([value, text]) => ({ value, label: text })), default: defaultValue, help });
export const bankRatesInput = (field, label, help = "") => describe(field, "BANK_RATES", label, { help });
export const dateDayInput = (field, label, help = "") => describe(field, "DATE_DAY", label, { help });
export const nameListInput = (field, label, help = "") => describe(field, "NAME_LIST", label, { help });
export const paymentsListInput = (field, label, help = "") => describe(field, "PAYMENTS_LIST", label, { help });
/**
 * @param {string} field
 * @param {string} label
 * @param {{key:string,label:string,help?:string,signed?:boolean}[]} rows
 * @param {{key:string,label:string}[]} columns   e.g. this year and the year before
 */
export const amountsInput = (field, label, rows, columns, help = "") =>
  describe(field, "AMOUNTS", label, { rows: rows.map((r) => ({ key: r.key, label: r.label, help: r.help || "", signed: Boolean(r.signed) })), columns, help });

/**
 * Checks what a client sent for an AMOUNTS input against the descriptor: only the rows and columns it declared,
 * every amount a whole number of paise (a float, a string or a number outside the safe range is refused, not
 * coerced), a negative amount only on a row marked signed. Returns { rowKey: { columnKey: paise } } holding only the
 * cells that were entered. Throws RangeError naming the cell.
 */
export function readAmounts(descriptor, value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new RangeError(`${descriptor.label} must be an object of rows`);
  const rows = new Map(descriptor.rows.map((r) => [r.key, r]));
  const columns = new Set(descriptor.columns.map((c) => c.key));
  const clean = {};
  for (const [rowKey, cells] of Object.entries(value)) {
    const row = rows.get(rowKey);
    if (!row) throw new RangeError(`${descriptor.label}: "${rowKey}" is not a row this pack asks for`);
    if (!cells || typeof cells !== "object" || Array.isArray(cells)) throw new RangeError(`${row.label} must be an object of columns`);
    for (const [columnKey, amount] of Object.entries(cells)) {
      if (!columns.has(columnKey)) throw new RangeError(`${row.label}: "${columnKey}" is not a column this pack asks for`);
      if (amount === null || amount === undefined) continue;
      if (!Number.isSafeInteger(amount)) throw new RangeError(`${row.label} (${columnKey}) must be a whole number of paise`);
      if (amount < 0 && !row.signed) throw new RangeError(`${row.label} (${columnKey}) cannot be negative`);
      (clean[rowKey] ??= {})[columnKey] = amount;
    }
  }
  return clean;
}

export const gstr9FiguresInput = (field, label, rows, help = "") => describe(field, "GSTR9_FIGURES", label, { required: true, rows, help });
