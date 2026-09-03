import { createHash } from "node:crypto";
import {
  GST_IMPORT_SPECS,
  addSafeIntegers,
  calculateGstr3bClaimed,
  normalizeGstImportRow,
} from "./gst-normalization.service.js";
import {
  TDS_IMPORT_KINDS,
  TDS_IMPORT_SPECS,
  normalizeTdsImportRow,
  summarizeTdsRows,
} from "./tds-normalization.service.js";
import {
  DATE_FIELDS_BY_KIND,
  DATE_ORDER_STATUS,
  classifyDateColumn,
  classifyNumericDate,
  resolveDateOrder,
} from "./robust-normalize.service.js";
import { shapeTable } from "./import-shape.service.js";
import { userFacingMessage } from "../utils/user-facing-error.js";

// Sized for the file a chartered accountant actually has, not for a demo.
// Reconciliation runs for one return period, so the unit is a single month's
// purchase register or GSTR-2B: a few hundred rows for a small client, several
// thousand for a busy one. The previous 500-row / 500 KB ceiling rejected any
// real client's books outright, which made every other robustness improvement
// upstream pointless.
//
// 20,000 rows at ~500 bytes each is ~10 MB of text and a few tens of MB of
// parsed cells - comfortable for the API host, and still a hard bound rather
// than an open door. A register larger than one period's worth is a sign the
// wrong file was picked, so refusing it is the right answer, not a limitation.
const MAX_TEXT_BYTES = 10_000_000;
const MAX_ROWS = 20_000;
const MAX_COLUMNS = 100;
// MAX_ROWS is only tested when a newline is seen and MAX_COLUMNS only after the
// whole file is parsed, so a body with no newline at all was parsed in full
// before any limit applied. This bounds a single row while it is being built.
// Deliberately far above MAX_COLUMNS: a row wider than the header is normal in
// a messy export and is trimmed later, so this is a structural backstop, not a
// column rule.
const MAX_CELLS_PER_ROW = 2_000;
const PREVIEW_ROWS = 100;

const IMPORT_SPECS = Object.freeze({
  CLIENTS: {
    required: ["name"],
    allowed: [
      "name",
      "clientCode",
      "entityType",
      "gstin",
      "pan",
      "tan",
      "contactPerson",
      "phone",
      "email",
      "tags",
      "notes",
    ],
  },
  ...GST_IMPORT_SPECS,
  ...TDS_IMPORT_SPECS,
});

function detectDelimiter(text) {
  const firstLine = String(text).split(/\r?\n/, 1)[0] || "";
  const candidates = ["\t", ",", ";"];
  return candidates.sort(
    (left, right) => firstLine.split(right).length - firstLine.split(left).length
  )[0];
}

function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      row.push(cell);
      cell = "";
      if (row.length > MAX_CELLS_PER_ROW) {
        throw importRequestError(
          `Import has a row with more than ${MAX_CELLS_PER_ROW} values`,
          "IMPORT_ROW_TOO_WIDE",
          { maxCellsPerRow: MAX_CELLS_PER_ROW }
        );
      }
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      cell = "";
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      if (rows.length > MAX_ROWS + 1) {
        throw importRequestError(
          `Import exceeds ${MAX_ROWS} data rows`,
          "IMPORT_ROW_LIMIT_EXCEEDED",
          { maxRows: MAX_ROWS }
        );
      }
    } else {
      cell += character;
    }
  }

  if (quoted) throw new Error("Import contains an unclosed quoted value");
  row.push(cell);
  if (row.some((value) => value.trim() !== "")) rows.push(row);
  if (rows.length > MAX_ROWS + 1) {
    throw importRequestError(
      `Import exceeds ${MAX_ROWS} data rows`,
      "IMPORT_ROW_LIMIT_EXCEEDED",
      { maxRows: MAX_ROWS }
    );
  }
  return rows;
}

function cleanValue(rawValue) {
  return String(rawValue ?? "")
    .trim()
    .replace(/\0/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/javascript:/gi, "")
    .replace(/on\w+\s*=/gi, "");
}

function normalizeClientValue(field, rawValue) {
  const value = cleanValue(rawValue);
  if (["gstin", "pan", "tan", "entityType", "clientCode"].includes(field)) {
    return value.toUpperCase();
  }
  if (field === "email") return value.toLowerCase();
  if (field === "tags") {
    return [...new Set(value.split(/[|,]/).map((tag) => tag.trim()).filter(Boolean))];
  }
  return value;
}

function formulaRisk(value) {
  return /^[\s]*[=+@-]/.test(String(value || ""));
}

function importRequestError(message, code, details = null) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = code;
  if (details) error.details = details;
  return error;
}

function validateRequest({ kind, text, mapping, delimiter, dateOrder }) {
  if (dateOrder != null && dateOrder !== "" && dateOrder !== "DAY_FIRST" && dateOrder !== "MONTH_FIRST") {
    throw importRequestError(
      "Date order must be DAY_FIRST, MONTH_FIRST, or left unset to be detected from the file.",
      "IMPORT_DATE_ORDER_UNSUPPORTED"
    );
  }
  const normalizedKind = String(kind || "").toUpperCase();
  if (["GSTR7", "GSTR-7"].includes(normalizedKind)) {
    throw new Error("GSTR-7 is GST TDS and cannot be used as Income-tax TDS evidence");
  }
  const spec = IMPORT_SPECS[normalizedKind];
  if (!spec) throw new Error(`Unsupported preview kind: ${normalizedKind || "missing"}`);
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("Delimited import text is required");
  }
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
    throw new Error(`Import exceeds ${MAX_TEXT_BYTES} bytes`);
  }
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
    throw new Error("Column mapping object is required");
  }

  const selectedDelimiter = delimiter || detectDelimiter(text);
  if (![",", ";", "\t"].includes(selectedDelimiter)) {
    throw new Error("Delimiter must be comma, semicolon, or tab");
  }

  const parsed = parseDelimited(text, selectedDelimiter);
  if (parsed.length < 2) throw new Error("Import requires a header and at least one data row");

  // Where the headings are, which columns are real, and what to call the ones
  // the file did not name. This replaces three assumptions that rejected
  // ordinary accounting exports outright: that the header is row 1, that no
  // header cell is blank (Excel appends empty columns to almost every export),
  // and that no two columns share a name (Tally prints "Amount" twice).
  // Every adjustment it makes is returned to the caller as a note rather than
  // applied silently.
  const shaped = shapeTable(parsed);
  const headers = shaped.headers;
  if (!headers.length) {
    throw new Error("Import requires a header and at least one data row");
  }
  if (headers.length > MAX_COLUMNS) throw new Error(`Import exceeds ${MAX_COLUMNS} columns`);

  const unknownFields = Object.keys(mapping).filter(
    (field) => !spec.allowed.includes(field)
  );
  if (unknownFields.length) {
    throw importRequestError(
      `Unsupported mapped fields: ${unknownFields.join(", ")}`,
      "IMPORT_MAPPING_UNSUPPORTED_FIELDS",
      { fields: unknownFields }
    );
  }
  const missingRequired = spec.required.filter((field) => !mapping[field]);
  if (missingRequired.length) {
    throw importRequestError(
      `Missing required mappings: ${missingRequired.join(", ")}`,
      "IMPORT_MAPPING_MISSING_FIELDS",
      { fields: missingRequired }
    );
  }

  const fieldsBySourceHeader = new Map();
  for (const [field, sourceHeader] of Object.entries(mapping)) {
    if (!headers.includes(sourceHeader)) {
      throw importRequestError(
        `Mapped column not found for ${field}: ${sourceHeader}`,
        "IMPORT_MAPPING_HEADER_NOT_FOUND",
        { fields: [field] }
      );
    }
    const assignedFields = fieldsBySourceHeader.get(sourceHeader) || [];
    assignedFields.push(field);
    fieldsBySourceHeader.set(sourceHeader, assignedFields);
  }
  const duplicateAssignments = [...fieldsBySourceHeader.values()].filter(
    (assignedFields) => assignedFields.length > 1
  );
  if (duplicateAssignments.length) {
    throw importRequestError(
      "Each source column can map to only one import field",
      "IMPORT_MAPPING_DUPLICATE_SOURCE",
      { fields: duplicateAssignments.flat() }
    );
  }

  return { headers, normalizedKind, parsed, shaped, selectedDelimiter, spec };
}

export function parseMappedImport({ kind, text, mapping, delimiter = null, dateOrder = null }) {
  const {
    headers,
    normalizedKind,
    shaped,
    selectedDelimiter,
    spec,
  } = validateRequest({ kind, text, mapping, delimiter, dateOrder });
  const headerIndex = new Map(headers.map((header, index) => [header, index]));
  const errors = [];
  const warnings = [];
  const normalizedRows = [];
  const isTdsImport = TDS_IMPORT_KINDS.includes(normalizedKind);

  // Resolve the date order ONCE for the whole file, before parsing a single row.
  // This is the root fix: the old per-row guess in parseFlexibleDateIso is
  // replaced by one file-level decision, inferred from every mapped date column
  // pooled together, or explicitly stated by the caller.
  const dateFields = (DATE_FIELDS_BY_KIND[normalizedKind] || []).filter(
    (field) => mapping[field]
  );
  const dateEntries = [];
  for (const field of dateFields) {
    const sourceHeader = mapping[field];
    const columnIndex = headerIndex.get(sourceHeader);
    // Row numbers are the ones in the user's own file, so "row 42 reads as
    // day-first" points at row 42 of their spreadsheet even when the header
    // sat below a title block.
    shaped.dataRows.forEach((entry) => {
      dateEntries.push({ row: entry.sourceRow, value: cleanValue(entry.cells[columnIndex] ?? "") });
    });
  }
  const dateClassification = classifyDateColumn(dateEntries);
  const resolvedDateOrder = resolveDateOrder({ classification: dateClassification, stated: dateOrder || null });

  if (resolvedDateOrder.status === DATE_ORDER_STATUS.CONFLICTING) {
    // A single template literal, not a concatenation of several -- kept that
    // way on purpose so tests/error-contract-invariants.mjs's static scan
    // (which matches one literal message per throw call) can see this code is
    // actually thrown. A `+`-joined message is invisible to that scan.
    throw importRequestError(
      `This file mixes day-first and month-first dates (row ${resolvedDateOrder.dayFirstEvidenceRow} reads as day-first, row ${resolvedDateOrder.monthFirstEvidenceRow} reads as month-first), so CA PRO cannot tell what any ambiguous row means. Fix the date column in the source file and read it again.`,
      "IMPORT_DATE_ORDER_CONFLICTING",
      {
        dayFirstEvidenceRow: resolvedDateOrder.dayFirstEvidenceRow,
        monthFirstEvidenceRow: resolvedDateOrder.monthFirstEvidenceRow,
      }
    );
  }

  // A single order for the whole file. AMBIGUOUS with no stated answer parses
  // internally as day-first so every row still renders for review, but the
  // caller is told below (via warnings + the dateOrder block) that nothing was
  // actually resolved, and import.controller.js withholds the commit token.
  const rowDateOrder = resolvedDateOrder.resolved || "DAY_FIRST";
  const ambiguousUnanswered = resolvedDateOrder.status === DATE_ORDER_STATUS.AMBIGUOUS && !resolvedDateOrder.resolved;

  // Which specific rows are themselves ambiguous (both numeric fields <= 12) --
  // used below to warn on exactly the affected rows, not every row that merely
  // has a date value in a file where SOME row happens to be ambiguous.
  const ambiguousRowNumbers = ambiguousUnanswered
    ? new Set(
        dateEntries
          .filter((entry) => classifyNumericDate(entry.value).proves === null
            && classifyNumericDate(entry.value).shape === "NUMERIC")
          .map((entry) => entry.row)
      )
    : null;

  shaped.dataRows.forEach((entry) => {
    const row = entry.cells;
    const mapped = {};
    const displayRow = entry.sourceRow;
    for (const [field, sourceHeader] of Object.entries(mapping)) {
      const rawValue = row[headerIndex.get(sourceHeader)] ?? "";
      if (formulaRisk(rawValue)) {
        warnings.push({ row: displayRow, field, code: "FORMULA_PREFIX" });
      }
      mapped[field] = cleanValue(rawValue);
    }

    if (normalizedKind === "CLIENTS") {
      const output = {};
      for (const [field, value] of Object.entries(mapped)) {
        output[field] = normalizeClientValue(field, value);
      }
      for (const requiredField of spec.required) {
        if (!output[requiredField]) {
          errors.push({ row: displayRow, field: requiredField, code: "REQUIRED" });
        }
      }
      normalizedRows.push({ row: displayRow, values: output });
      return;
    }

    const normalized = isTdsImport
      ? normalizeTdsImportRow(normalizedKind, mapped, { dateOrder: rowDateOrder })
      : normalizeGstImportRow(normalizedKind, mapped, { dateOrder: rowDateOrder });
    normalized.errors.forEach((error) => errors.push({ row: displayRow, ...error }));
    normalized.warnings.forEach((warning) => warnings.push({ row: displayRow, ...warning }));
    normalizedRows.push({ row: displayRow, values: normalized.values });

    // AMBIGUOUS-and-unanswered is surfaced as a WARNING, never an error and
    // never counted against validRows/previewRows -- see TRAP 1 in the C1-C12
    // workstream notes: a file-level error, or one pinned to row 0, makes the
    // desktop mapper discard the whole preview. Withholding the commit token
    // (done in import.controller.js) is what actually blocks the commit.
    if (ambiguousUnanswered && ambiguousRowNumbers.has(displayRow)) {
      for (const field of dateFields) {
        if (mapped[field]) {
          warnings.push({ row: displayRow, field, code: "DATE_ORDER_REQUIRED" });
        }
      }
    }
  });

  let gstr3bControl = null;
  if (normalizedKind === "GSTR3B_SUMMARY" && errors.length === 0) {
    try {
      gstr3bControl = calculateGstr3bClaimed(
        normalizedRows.map((row) => row.values)
      );
    } catch (error) {
      // V13-P12-F2. This catch is broad on purpose - a malformed GSTR-3B must produce a field
      // error rather than a 500 - but the MESSAGE may only be forwarded when it was written for a
      // user. calculateGstr3bClaimed throws four authored sentences about the file itself, and
      // those are exactly what a firm needs to see. Anything else reaching here is a bug in our
      // code, and its text would arrive looking like a statement about their return.
      errors.push({
        row: normalizedRows[0]?.row || 2,
        field: "category",
        code: "INVALID_GSTR3B_SUMMARY",
        message: userFacingMessage(
          error,
          "This GSTR-3B summary could not be read. Check the category and amount columns, then try again.",
        ),
      });
    }
  }

  const invalidRows = new Set(errors.map((error) => error.row));
  const validRows = normalizedRows.filter((row) => !invalidRows.has(row.row));
  const financialTotals = normalizedKind === "CLIENTS"
    ? null
    : isTdsImport
      ? summarizeTdsRows(normalizedKind, validRows)
      : normalizedKind === "GSTR3B_SUMMARY" && gstr3bControl
        ? {
            taxableValueMinor: 0,
            ...gstr3bControl.claimed,
          }
        : {
            taxableValueMinor: addSafeIntegers(validRows.map((row) => row.values.taxableValueMinor || 0)),
            igstMinor: addSafeIntegers(validRows.map((row) => row.values.igstMinor || 0)),
            cgstMinor: addSafeIntegers(validRows.map((row) => row.values.cgstMinor || 0)),
            sgstMinor: addSafeIntegers(validRows.map((row) => row.values.sgstMinor || 0)),
            cessMinor: addSafeIntegers(validRows.map((row) => row.values.cessMinor || 0)),
            totalTaxMinor: addSafeIntegers(validRows.map((row) => row.values.totalTaxMinor || 0)),
          };

  return {
    kind: normalizedKind,
    delimiter: selectedDelimiter === "\t" ? "TAB" : selectedDelimiter,
    sourceHash: createHash("sha256").update(text, "utf8").digest("hex"),
    mapping: { ...mapping },
    headers,
    summary: {
      totalRows: normalizedRows.length,
      validRows: normalizedRows.length - invalidRows.size,
      invalidRows: invalidRows.size,
      warningCount: warnings.length,
      previewRows: Math.min(normalizedRows.length, PREVIEW_ROWS),
      // Rows that were never records: a repeated heading, a printed totals
      // line. Counted separately from invalidRows because they are not the
      // user's mistake, and reported rather than dropped in silence so the
      // figures here can be tied back to the source document.
      skippedRows: shaped.skipped.length,
      financialTotals,
    },
    // What had to be assumed about the file's shape before a value was read:
    // a title block skipped, empty columns dropped, a duplicate column
    // renamed. Additive, so an older client that ignores it is unaffected.
    shape: {
      headerRow: shaped.headerRowIndex + 1,
      notes: shaped.notes,
      skipped: shaped.skipped.slice(0, 200),
    },
    // Additive response key -- the app-config pattern this codebase already
    // relies on. An older client that does not read it keeps working exactly
    // as before; resolved is null for AMBIGUOUS-unanswered and CONFLICTING
    // never reaches here (it threw above).
    dateOrder: {
      status: resolvedDateOrder.status,
      resolved: resolvedDateOrder.resolved,
      source: resolvedDateOrder.source,
      fields: dateFields,
      ambiguousRows: resolvedDateOrder.ambiguousRows,
      unambiguousRows: resolvedDateOrder.unambiguousRows,
      unparseableRows: resolvedDateOrder.unparseableRows,
      dayFirstEvidenceRow: resolvedDateOrder.dayFirstEvidenceRow,
      monthFirstEvidenceRow: resolvedDateOrder.monthFirstEvidenceRow,
    },
    rows: normalizedRows,
    errors: errors.slice(0, 200),
    warnings: warnings.slice(0, 200),
  };
}

export function previewImport(input) {
  const parsed = parseMappedImport(input);
  return {
    ...parsed,
    rows: parsed.rows.slice(0, PREVIEW_ROWS),
  };
}

export { IMPORT_SPECS, MAX_TEXT_BYTES, MAX_ROWS, MAX_COLUMNS, PREVIEW_ROWS };
