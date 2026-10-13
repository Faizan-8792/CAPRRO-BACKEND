// Shared CSV cell serialization. There was one copy per exporting service and
// they had drifted (different dangerous-prefix sets, different quoting), so the
// guard a spreadsheet needs depended on which export produced the file.
//
// csvCell — user-facing exports opened in Excel/Sheets. Always quotes, doubles
// embedded quotes, and prefixes a single quote to any STRING cell a spreadsheet
// would read as a formula (= + - @ after optional whitespace). Numbers are left
// alone: a pure numeric cell cannot evaluate as a formula, and quoting it into
// text corrupts downstream arithmetic.
//
// csvCellMachine — CSV consumed by our own parser (e.g. the GSTR-2B JSON →
// canonical-CSV converter, round-tripped through parseMappedImport). No formula
// guard: a portal invoice number that genuinely starts with "-" must survive
// the round-trip byte-exact, and a leading apostrophe would be reimported as
// part of the value. Quotes only when the field requires it.

export function csvCell(value) {
  const isText = typeof value === "string";
  let text = value == null ? "" : String(value);
  if (isText && /^\s*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function csvCellMachine(value) {
  const s = String(value == null ? "" : value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
