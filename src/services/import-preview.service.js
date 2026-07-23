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

const MAX_TEXT_BYTES = 500_000;
const MAX_ROWS = 500;
const MAX_COLUMNS = 100;
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
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      cell = "";
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      if (rows.length > MAX_ROWS + 1) {
        throw new Error(`Import exceeds ${MAX_ROWS} data rows`);
      }
    } else {
      cell += character;
    }
  }

  if (quoted) throw new Error("Import contains an unclosed quoted value");
  row.push(cell);
  if (row.some((value) => value.trim() !== "")) rows.push(row);
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

function validateRequest({ kind, text, mapping, delimiter }) {
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
  const headers = parsed[0].map((header) => header.trim());
  if (headers.length > MAX_COLUMNS) throw new Error(`Import exceeds ${MAX_COLUMNS} columns`);
  if (headers.some((header) => !header)) throw new Error("Import contains an empty header");
  if (new Set(headers).size !== headers.length) throw new Error("Import headers must be unique");

  const unknownFields = Object.keys(mapping).filter(
    (field) => !spec.allowed.includes(field)
  );
  if (unknownFields.length) {
    throw new Error(`Unsupported mapped fields: ${unknownFields.join(", ")}`);
  }
  const missingRequired = spec.required.filter((field) => !mapping[field]);
  if (missingRequired.length) {
    throw new Error(`Missing required mappings: ${missingRequired.join(", ")}`);
  }
  for (const [field, sourceHeader] of Object.entries(mapping)) {
    if (!headers.includes(sourceHeader)) {
      throw new Error(`Mapped column not found for ${field}: ${sourceHeader}`);
    }
  }

  return { headers, normalizedKind, parsed, selectedDelimiter, spec };
}

export function parseMappedImport({ kind, text, mapping, delimiter = null }) {
  const {
    headers,
    normalizedKind,
    parsed,
    selectedDelimiter,
    spec,
  } = validateRequest({ kind, text, mapping, delimiter });
  const headerIndex = new Map(headers.map((header, index) => [header, index]));
  const errors = [];
  const warnings = [];
  const normalizedRows = [];
  const isTdsImport = TDS_IMPORT_KINDS.includes(normalizedKind);

  parsed.slice(1).forEach((row, rowIndex) => {
    const mapped = {};
    const displayRow = rowIndex + 2;
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
      ? normalizeTdsImportRow(normalizedKind, mapped)
      : normalizeGstImportRow(normalizedKind, mapped);
    normalized.errors.forEach((error) => errors.push({ row: displayRow, ...error }));
    normalized.warnings.forEach((warning) => warnings.push({ row: displayRow, ...warning }));
    normalizedRows.push({ row: displayRow, values: normalized.values });
  });

  let gstr3bControl = null;
  if (normalizedKind === "GSTR3B_SUMMARY" && errors.length === 0) {
    try {
      gstr3bControl = calculateGstr3bClaimed(
        normalizedRows.map((row) => row.values)
      );
    } catch (error) {
      errors.push({
        row: normalizedRows[0]?.row || 2,
        field: "category",
        code: "INVALID_GSTR3B_SUMMARY",
        message: error.message,
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
      financialTotals,
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
