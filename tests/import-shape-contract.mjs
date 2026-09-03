// tests/import-shape-contract.mjs
//
// Why this exists. The import parser assumed row 1 is the header, rejected any file with an
// empty header cell, and rejected any file with two columns of the same name. Each of those
// is ordinary in a register a chartered accountant actually has - Tally and Busy print a
// title block above the headings, Excel appends trailing empty columns to nearly every
// export, and Tally's own layouts repeat a column name. A file rejected for its shape means
// the user's real question, does my input tax credit reconcile, never gets asked at all.
//
// The contract these checks defend is not "always parse something". It is: a file is either
// read correctly, or the thing that could not be read is REPORTED. Nothing is silently
// reshaped, and no row disappears without being counted.
//
// Pure logic only - no database, no network, no server import.
//
// Run: node tests/import-shape-contract.mjs

import { readFile } from "node:fs/promises";
import {
  classifyNonDataRow,
  findHeaderRow,
  normalizeHeaderRow,
  shapeTable,
} from "../src/services/import-shape.service.js";

const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass, detail });

const GST_HEADERS = [
  "Supplier GSTIN",
  "Invoice No",
  "Invoice Date",
  "Taxable Value",
  "IGST",
  "CGST",
  "SGST",
];

// ─── Header row detection ─────────────────────────────────────────

check(
  "a file whose headings are already row 1 is unchanged",
  findHeaderRow([GST_HEADERS, ["27AABCS1111A1Z5", "INV-1", "05-04-2026", "1000", "180", "0", "0"]]) === 0,
);

const tallyExport = [
  ["ABC ENTERPRISES PRIVATE LIMITED"],
  ["Purchase Register"],
  ["1-Apr-2026 to 30-Apr-2026"],
  [],
  GST_HEADERS,
  ["27AABCS1111A1Z5", "INV-1", "05-04-2026", "1000", "180", "0", "0"],
];
check(
  "a Tally-style title block above the headings is found and skipped",
  findHeaderRow(tallyExport) === 4,
  `header row resolved to index ${findHeaderRow(tallyExport)}`,
);

// The dangerous failure is picking a row of figures as the header, which
// would silently discard a real invoice and name every column after its
// values.
const dataFirst = [
  ["27AABCS1111A1Z5", "INV-1", "05-04-2026", "1000", "180", "0", "0"],
  GST_HEADERS,
];
check(
  "a row of figures never outscores a real heading row",
  findHeaderRow(dataFirst) === 1,
  `resolved to index ${findHeaderRow(dataFirst)}`,
);

check(
  "a file with no recognisable heading falls back to row 1 rather than guessing",
  findHeaderRow([["a", "b"], ["c", "d"]]) === 0,
);

check(
  "an empty file does not throw",
  findHeaderRow([]) === 0 && findHeaderRow(null) === 0,
);

// ─── Header normalisation ─────────────────────────────────────────

const trailing = normalizeHeaderRow([...GST_HEADERS, "", "", ""]);
check(
  "trailing empty columns are dropped and reported, not rejected",
  trailing.headers.length === 7 &&
    trailing.notes.some((note) => note.code === "TRAILING_EMPTY_COLUMNS_DROPPED" && note.count === 3),
  `kept ${trailing.headers.length} columns`,
);

const interior = normalizeHeaderRow(["Supplier GSTIN", "", "Invoice Date"]);
check(
  "an unnamed interior column is named rather than dropped, and the naming is reported",
  interior.headers.length === 3 &&
    interior.headers[1] === "Column 2" &&
    interior.notes.some((note) => note.code === "UNNAMED_COLUMN"),
  `headers: ${interior.headers.join(" | ")}`,
);

const duplicates = normalizeHeaderRow(["Amount", "Rate", "Amount", "Amount"]);
check(
  "duplicate column names are made unique so both stay mappable",
  duplicates.headers.length === 4 &&
    new Set(duplicates.headers).size === 4 &&
    duplicates.headers[0] === "Amount" &&
    duplicates.headers[2] === "Amount (2)" &&
    duplicates.headers[3] === "Amount (3)",
  `headers: ${duplicates.headers.join(" | ")}`,
);

check(
  "renaming a duplicate column is reported",
  duplicates.notes.some((note) => note.code === "DUPLICATE_COLUMN_RENAMED"),
);

check(
  "headings are trimmed of stray whitespace",
  normalizeHeaderRow(["  Supplier GSTIN  ", "\tIGST\t"]).headers.join("|") === "Supplier GSTIN|IGST",
);

// ─── Non-data rows ────────────────────────────────────────────────

check(
  "a totals line is recognised",
  classifyNonDataRow(["Total", "", "", "1000", "180", "", ""], GST_HEADERS) === "TOTALS",
);

check(
  "a grand total line is recognised",
  classifyNonDataRow(["Grand Total", "", "", "", "", "", ""], GST_HEADERS) === "TOTALS",
);

check(
  "a repeated heading row mid-file is recognised",
  classifyNonDataRow(GST_HEADERS, GST_HEADERS) === "REPEATED_HEADER",
);

check(
  "an empty row is recognised",
  classifyNonDataRow(["", "", ""], GST_HEADERS) === "EMPTY",
);

check(
  "a real invoice row is NOT classified as a non-data row",
  classifyNonDataRow(
    ["27AABCS1111A1Z5", "INV-1", "05-04-2026", "1000", "180", "0", "0"],
    GST_HEADERS,
  ) === null,
);

// The trap: a supplier legitimately named "Total Solutions Pvt Ltd" must not
// have its invoice discarded as a totals line. Dropping a real invoice would
// remove input tax credit the client is entitled to, silently.
check(
  "an invoice from a supplier whose name starts with Total is kept",
  classifyNonDataRow(
    ["Total Solutions Pvt Ltd", "INV-9", "05-04-2026", "1000", "180", "0", "0"],
    ["Supplier Name", ...GST_HEADERS.slice(1)],
  ) === null,
);

// A totals line normally carries the summed amounts - it is not a sparse row.
check(
  "a totals line carrying its summed amounts is still recognised",
  classifyNonDataRow(["Total", "", "", "6000", "720", "180", "180"], GST_HEADERS) === "TOTALS",
);

// Belt and braces: an exact "Total" sitting in a description column cannot
// remove a row that names a supplier GSTIN.
check(
  "a row containing a GSTIN is never treated as a totals line",
  classifyNonDataRow(
    ["Total", "27AABCS1111A1Z5", "INV-9", "05-04-2026", "1000", "180", "0"],
    ["Particulars", ...GST_HEADERS.slice(0, 6)],
  ) === null,
);

// ─── The whole shape, end to end ──────────────────────────────────

const messy = [
  ["ABC ENTERPRISES PRIVATE LIMITED", "", ""],
  ["Purchase Register  1-Apr-2026 to 30-Apr-2026", "", ""],
  [],
  [...GST_HEADERS, "", ""],
  ["27AABCS1111A1Z5", "INV-1", "05-04-2026", "1000", "180", "0", "0", "", ""],
  [],
  ["27AABCS2222A1Z5", "INV-2", "06-04-2026", "2000", "0", "180", "180", "", ""],
  GST_HEADERS,
  ["27AABCS3333A1Z5", "INV-3", "07-04-2026", "3000", "540", "0", "0", "", ""],
  ["Total", "", "", "6000", "720", "180", "180", "", ""],
];
const shaped = shapeTable(messy);

check(
  "a realistically messy register yields exactly its three invoices",
  shaped.dataRows.length === 3,
  `got ${shaped.dataRows.length}: ${shaped.dataRows.map((r) => r.cells[1]).join(", ")}`,
);

check(
  "the header is found beneath the title block",
  shaped.headerRowIndex === 3 && shaped.headers[0] === "Supplier GSTIN",
  `index ${shaped.headerRowIndex}, first heading "${shaped.headers[0]}"`,
);

check(
  "trailing empty columns are gone from the headers and the data",
  shaped.headers.length === 7 && shaped.dataRows.every((row) => row.cells.length === 7),
  `headers ${shaped.headers.length}, widths ${shaped.dataRows.map((r) => r.cells.length).join("/")}`,
);

// This is the accounting guarantee: every row of the original file is either
// data, or skipped with a stated reason, or blank. None may simply vanish.
const accountedFor =
  shaped.dataRows.length +
  shaped.skipped.length +
  messy.slice(shaped.headerRowIndex + 1).filter((row) => !row || row.every((cell) => !String(cell ?? "").trim())).length;
check(
  "every row below the header is data, skipped-with-a-reason, or blank - none vanishes",
  accountedFor === messy.length - shaped.headerRowIndex - 1,
  `${accountedFor} accounted for of ${messy.length - shaped.headerRowIndex - 1} rows below the header`,
);

check(
  "the skipped rows say why they were skipped, and where they were",
  shaped.skipped.length === 2 &&
    shaped.skipped.some((entry) => entry.reason === "REPEATED_HEADER") &&
    shaped.skipped.some((entry) => entry.reason === "TOTALS") &&
    shaped.skipped.every((entry) => Number.isInteger(entry.row) && entry.row > 0),
  JSON.stringify(shaped.skipped),
);

check(
  "source row numbers point at the row the user sees in their spreadsheet",
  shaped.dataRows[0].sourceRow === 5 && shaped.dataRows[2].sourceRow === 9,
  `first=${shaped.dataRows[0].sourceRow} third=${shaped.dataRows[2].sourceRow}`,
);

check(
  "the reshaping is described rather than done silently",
  shaped.notes.some((note) => note.code === "PREAMBLE_ROWS_SKIPPED" && note.count === 3) &&
    shaped.notes.some((note) => note.code === "TRAILING_EMPTY_COLUMNS_DROPPED"),
  JSON.stringify(shaped.notes),
);

// A short row must be padded, not left ragged, or a mapped column would read
// undefined for that row alone.
const ragged = shapeTable([GST_HEADERS, ["27AABCS1111A1Z5", "INV-1"]]);
check(
  "a short data row is padded to the header width rather than left ragged",
  ragged.dataRows.length === 1 && ragged.dataRows[0].cells.length === GST_HEADERS.length,
  `width ${ragged.dataRows[0]?.cells.length}`,
);

const overWide = shapeTable([GST_HEADERS, [...GST_HEADERS.map(() => "x"), "extra", "extra2"]]);
check(
  "a row wider than the header is trimmed to the mapped columns",
  overWide.dataRows[0].cells.length === GST_HEADERS.length,
);

check(
  "a file that is only a header produces no data rows and does not throw",
  shapeTable([GST_HEADERS]).dataRows.length === 0,
);

check(
  "an empty grid produces no data rows and does not throw",
  shapeTable([]).dataRows.length === 0 && shapeTable(null).dataRows.length === 0,
);

// ─── The desktop client's ceiling must equal the server's ─────────
//
// Nothing checked this, and the two drifted 20x apart: the parser accepted
// 10,000,000 bytes while the desktop app refused at 500,000 and told the user
// "split it and import each part" - advice that was never true of the server,
// only of a constant nobody had revisited. A register the backend would have
// imported perfectly well was turned away by the client, and no test noticed
// because each side only ever asserted its own number.
//
// Client-side refusal is not the problem: refusing early saves the user a long
// upload that would fail anyway. Refusing at a DIFFERENT number is the problem,
// because then the two disagree about what is importable and only one of them
// is telling the user the truth.

const clientImportSource = await readFile(
  new URL(
    "../../apps/desktop-native/src/CaPro.Desktop.Core/Models/ImportWrites.cs",
    import.meta.url,
  ),
  "utf8",
);

const clientLimitMatch = /public const int MaxTextBytes\s*=\s*([\d_]+)\s*;/.exec(clientImportSource);
const clientLimit = clientLimitMatch ? Number(clientLimitMatch[1].replace(/_/g, "")) : null;
check(
  "the desktop client states its own import ceiling",
  clientLimit !== null && clientLimit > 0,
  clientLimitMatch ? `MaxTextBytes ${clientLimitMatch[1]}` : "MaxTextBytes not found in ImportWrites.cs",
);

// ─── The import body limit must clear the parser's own ceiling ────
//
// These two numbers live in different files and must move together. If
// express.json rejects first, the user gets a bare 413 instead of the parser's
// sentence explaining what to do about their file - and the raised row limit
// is unreachable, so the feature looks broken for exactly the large registers
// it was raised for. This was a real defect: MAX_TEXT_BYTES went to 10 MB
// while every route was still capped at 1 MB.

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const previewSource = await readFile(
  new URL("../src/services/import-preview.service.js", import.meta.url),
  "utf8",
);

function megabytes(value) {
  const match = /^(\d+(?:\.\d+)?)\s*mb$/i.exec(String(value || "").trim());
  return match ? Number(match[1]) * 1024 * 1024 : null;
}

const importLimitMatch = /app\.use\(\s*"\/api\/imports"\s*,\s*express\.json\(\{\s*limit:\s*"([^"]+)"/.exec(
  appSource,
);
check(
  "the import routes get their own express.json limit",
  Boolean(importLimitMatch),
  importLimitMatch ? `limit ${importLimitMatch[1]}` : "no route-scoped parser found in app.js",
);

const maxTextMatch = /const MAX_TEXT_BYTES = ([\d_]+);/.exec(previewSource);
check(
  "the parser states its own byte ceiling",
  Boolean(maxTextMatch),
  maxTextMatch ? `MAX_TEXT_BYTES ${maxTextMatch[1]}` : "not found",
);

if (importLimitMatch && maxTextMatch) {
  const routeLimit = megabytes(importLimitMatch[1]);
  const parserLimit = Number(maxTextMatch[1].replace(/_/g, ""));
  check(
    "the route limit clears the parser ceiling with room for JSON escaping, so the parser is what refuses an oversized file",
    // Not merely greater. The body is JSON, and escaping inflates the text it carries - a quote
    // costs two characters, a control character six - so a route limit only slightly above the
    // parser ceiling still 413s a file the parser would have accepted, with a bare status instead
    // of the parser's explanation. Twice the ceiling covers any realistic register.
    routeLimit !== null && routeLimit >= parserLimit * 2,
    `route ${routeLimit} bytes vs parser ${parserLimit} bytes (needs >= ${parserLimit * 2})`,
  );

  // The check this file existed without. See the note above: these two are what the user is
  // told, and if they disagree only one of them is true.
  check(
    "the desktop client refuses at exactly the same size the server does",
    clientLimit !== null && clientLimit === parserLimit,
    `client ${clientLimit} bytes vs server ${parserLimit} bytes`,
  );
}

// The larger ceiling must not leak to every other route.
const globalLimitMatch = /app\.use\(express\.json\(\{\s*limit:\s*"([^"]+)"/.exec(appSource);
check(
  "the rest of the app keeps its small body limit",
  Boolean(globalLimitMatch) && megabytes(globalLimitMatch[1]) <= 1024 * 1024,
  globalLimitMatch ? `global limit ${globalLimitMatch[1]}` : "no global parser found",
);

// ─── Report ───────────────────────────────────────────────────────

let passed = 0;
for (const entry of checks) {
  const mark = entry.pass ? "PASS" : "FAIL";
  if (entry.pass) passed += 1;
  console.log(`[${mark}] ${entry.name}${entry.detail ? ` — ${entry.detail}` : ""}`);
}

const total = checks.length;
console.log(`\nImport shape contract: ${passed}/${total}`);

if (passed !== total) {
  console.error(`\n${total - passed} check(s) failed.`);
  process.exit(1);
}
