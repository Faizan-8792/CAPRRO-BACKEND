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
export const gstr9FiguresInput = (field, label, rows, help = "") => describe(field, "GSTR9_FIGURES", label, { required: true, rows, help });
