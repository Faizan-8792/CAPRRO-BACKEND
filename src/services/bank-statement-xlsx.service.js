// Dependency-free Office Open XML writer for the bank-statement converter.
// Every text value is written as an inline string (never a formula), while dates and money are
// explicit numeric cells. The self-check reads the generated ZIP/XML back before the caller can
// offer the bytes to a user.

import { paiseToDecimalString } from "./bank-statement-normalization.service.js";
import { exportStatusToken } from "./bank-statement-status.service.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let value = 0; value < 256; value += 1) {
    let current = value;
    for (let bit = 0; bit < 8; bit += 1) current = current & 1 ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
    table[value] = current >>> 0;
  }
  return table;
})();

export const BANK_STATEMENT_SHEETS = Object.freeze(["Summary", "Transactions", "Exceptions", "Checks"]);
export const BANK_STATEMENT_TRANSACTION_HEADERS = Object.freeze([
  "Date", "Narration", "Debit / Withdrawal", "Credit / Deposit", "Balance", "Source Page",
  "Source Seq", "Value Date", "Ref / Cheque No.", "Account Type", "Review Status", "Exception IDs",
]);
export const BANK_STATEMENT_EXCEPTION_HEADERS = Object.freeze([
  "Exception ID", "Severity", "Code", "Source Page", "Source Seq", "Field", "Raw Text", "Issue",
  "Proposed Value", "Evidence / Reason", "User Decision", "Decided By", "Decided At", "Final Value",
]);
export const BANK_STATEMENT_CHECK_HEADERS = Object.freeze([
  "Check ID", "Check", "Scope", "Result", "Rows checked", "Rows failed", "Detail (the values compared)",
]);

function crc32(bytes) {
  let current = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) current = CRC_TABLE[(current ^ bytes[index]) & 0xff] ^ (current >>> 8);
  return (current ^ 0xffffffff) >>> 0;
}

function xml(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function columnName(index) {
  let value = index + 1;
  let name = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function excelDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso ?? ""))) throw new Error(`Expected ISO date for XLSX output: ${iso}`);
  const timestamp = Date.parse(`${iso}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid date for XLSX output: ${iso}`);
  // Excel's 1900 date system deliberately includes its historical 29-Feb-1900 bug, hence
  // 1899-12-30 as the epoch used by Excel-compatible libraries.
  return String(Math.round(timestamp / 86_400_000 + 25569));
}

function textCell(reference, value, style = 0) {
  return `<c r="${reference}"${style ? ` s="${style}"` : ""} t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
}

function numberCell(reference, value, style) {
  return `<c r="${reference}" s="${style}"><v>${value}</v></c>`;
}

function makeCell(reference, cell, column) {
  if (cell === null || cell === undefined || cell === "") return "";
  if (cell.kind === "date") return numberCell(reference, excelDate(cell.value), 4);
  if (cell.kind === "amount") return numberCell(reference, paiseToDecimalString(cell.value), 2);
  if (cell.kind === "integer") return numberCell(reference, String(Number(cell.value)), 3);
  return textCell(reference, cell.value ?? cell, column === 0 ? 0 : 0);
}

function rowXml(cells, rowNumber, { header = false } = {}) {
  const body = cells.map((cell, index) => {
    const reference = `${columnName(index)}${rowNumber}`;
    if (header) return textCell(reference, cell, 1);
    return makeCell(reference, cell, index);
  }).join("");
  return `<row r="${rowNumber}">${body}</row>`;
}

function worksheetXml(headers, rows, { filter = false } = {}) {
  const dimensions = `${headers.length ? "A1" : "A1"}:${headers.length ? `${columnName(headers.length - 1)}${Math.max(1, rows.length + 1)}` : "A1"}`;
  const panes = "<sheetViews><sheetView workbookViewId=\"0\"><pane ySplit=\"1\" topLeftCell=\"A2\" activePane=\"bottomLeft\" state=\"frozen\"/><selection pane=\"bottomLeft\" activeCell=\"A2\" sqref=\"A2\"/></sheetView></sheetViews>";
  const sheetData = `<sheetData>${rowXml(headers, 1, { header: true })}${rows.map((row, index) => rowXml(row, index + 2)).join("")}</sheetData>`;
  const autoFilter = filter && headers.length ? `<autoFilter ref="A1:${columnName(headers.length - 1)}${Math.max(1, rows.length + 1)}"/>` : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="${dimensions}"/>${panes}${sheetData}${autoFilter}</worksheet>`;
}

function buildStoredZip(files) {
  if (files.length > 0xffff) throw new Error("Too many XLSX parts");
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = typeof file.data === "string" ? encoder.encode(file.data) : file.data;
    if (data.length > 0xffffffff) throw new Error(`XLSX part is too large: ${file.name}`);
    const crc = crc32(data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    Buffer.from(name).copy(local, 30);
    localParts.push(local, Buffer.from(data));

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    Buffer.from(name).copy(central, 46);
    centralParts.push(central);
    offset += local.length + data.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function storedZipEntries(bytes) {
  const buffer = Buffer.from(bytes);
  const start = Math.max(0, buffer.length - 22 - 65535);
  let end = -1;
  for (let index = buffer.length - 22; index >= start; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) { end = index; break; }
  }
  if (end < 0) throw new Error("XLSX round-trip failed: missing ZIP end record");
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("XLSX round-trip failed: invalid central directory");
    const method = buffer.readUInt16LE(offset + 10);
    const size = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = decoder.decode(buffer.subarray(offset + 46, offset + 46 + nameLength));
    if (method !== 0 || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("XLSX round-trip failed: unsupported ZIP part");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    entries.set(name, buffer.subarray(dataStart, dataStart + size));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function fileStem(fileName) {
  const trimmed = String(fileName || "statement.pdf").replace(/[\\/:*?"<>|\u0000-\u001F]/g, "_").trim() || "statement.pdf";
  return trimmed.replace(/\.pdf$/i, "") || "statement";
}

function reviewStatus(row) {
  if (row.reviewStatus) return row.reviewStatus;
  if ((row.issues || []).some((item) => String(item.code).startsWith("E-"))) return "Exception";
  if ((row.issues || []).some((item) => String(item.code).startsWith("W-"))) return "Warning";
  return "OK";
}

function exceptionIds(row) {
  return (row.exceptionIds || []).join(", ");
}

function transactionRows(rows) {
  return rows.map((row) => {
    const values = row.values || row;
    return [
      values.date ? { kind: "date", value: values.date } : null,
      { value: values.narration ?? "" },
      values.debit === null || values.debit === undefined ? null : { kind: "amount", value: values.debit },
      values.credit === null || values.credit === undefined ? null : { kind: "amount", value: values.credit },
      values.balance === null || values.balance === undefined ? null : { kind: "amount", value: values.balance },
      row.source?.page === null || row.source?.page === undefined ? null : { kind: "integer", value: row.source.page },
      row.source?.sequence === null || row.source?.sequence === undefined ? null : { kind: "integer", value: row.source.sequence },
      values.valueDate ? { kind: "date", value: values.valueDate } : null,
      values.reference ? { value: values.reference } : null,
      values.accountType ? { value: values.accountType } : null,
      { value: reviewStatus(row) },
      exceptionIds(row) ? { value: exceptionIds(row) } : null,
    ];
  });
}

function exceptionRows(exceptions) {
  return exceptions.map((item) => [
    { value: item.id }, { value: item.severity }, { value: item.code },
    item.page === null || item.page === undefined ? null : { kind: "integer", value: item.page },
    item.sequence === null || item.sequence === undefined ? null : { kind: "integer", value: item.sequence },
    { value: item.field ?? "" }, { value: item.rawText ?? "" }, { value: item.issue ?? "" },
    { value: item.proposedValue ?? "" }, { value: item.evidence ?? "" }, { value: item.userDecision ?? "Not decided" },
    { value: item.decidedBy ?? "" }, { value: item.decidedAt ?? "" }, { value: item.finalValue ?? "" },
  ]);
}

function checkRows(checks) {
  return checks.map((item) => [
    { value: item.id ?? "" }, { value: item.name ?? "" }, { value: item.scope ?? "Statement" }, { value: item.result ?? "Not available" },
    item.rowsChecked === null || item.rowsChecked === undefined ? null : { kind: "integer", value: item.rowsChecked },
    item.rowsFailed === null || item.rowsFailed === undefined ? null : { kind: "integer", value: item.rowsFailed }, { value: item.detail ?? "" },
  ]);
}

function summaryRows({ fileName, metadata, statusResult, profile }) {
  return [
    [{ value: "Source file name" }, { value: fileName }],
    [{ value: "SHA-256 hash" }, { value: metadata.sha256 ?? "" }],
    [{ value: "Page count" }, metadata.pageCount == null ? null : { kind: "integer", value: metadata.pageCount }],
    [{ value: "Converter version" }, { value: metadata.converterVersion ?? "development" }],
    [{ value: "Layout profile ID" }, { value: profile?.id ?? "Not detected" }],
    [{ value: "Layout profile version" }, { value: profile?.version ?? "" }],
    [{ value: "Result" }, { value: statusResult.status }],
    [{ value: "Errors" }, { kind: "integer", value: statusResult.errorCount ?? 0 }],
    [{ value: "Warnings" }, { kind: "integer", value: statusResult.warningCount ?? 0 }],
    [{ value: "Info" }, { kind: "integer", value: statusResult.infoCount ?? 0 }],
  ];
}

/** Build and verify the prescribed four-sheet .xlsx workbook entirely in memory. */
export function buildBankStatementWorkbook({ fileName, metadata = {}, profile = null, rows = [], exceptions = [], checks = [], statusResult } = {}) {
  if (!statusResult?.status) throw new Error("A calculated bank-statement status is required before export.");
  const sheets = [
    { name: "Summary", xml: worksheetXml(["Label", "Value"], summaryRows({ fileName, metadata, statusResult, profile })) },
    { name: "Transactions", xml: worksheetXml(BANK_STATEMENT_TRANSACTION_HEADERS, transactionRows(rows), { filter: true }) },
    { name: "Exceptions", xml: worksheetXml(BANK_STATEMENT_EXCEPTION_HEADERS, exceptionRows(exceptions), { filter: true }) },
    { name: "Checks", xml: worksheetXml(BANK_STATEMENT_CHECK_HEADERS, checkRows(checks), { filter: true }) },
  ];
  const files = [
    { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((sheet, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>` },
    { name: "_rels/.rels", data: "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" Target=\"xl/workbook.xml\"/></Relationships>" },
    { name: "xl/workbook.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sheet, index) => `<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((sheet, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("")}<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", data: "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><styleSheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><numFmts count=\"2\"><numFmt numFmtId=\"164\" formatCode=\"dd-mm-yyyy\"/><numFmt numFmtId=\"165\" formatCode=\"#,##0.00;[Red]-#,##0.00\"/></numFmts><fonts count=\"2\"><font><sz val=\"11\"/><name val=\"Calibri\"/></font><font><b/><sz val=\"11\"/><name val=\"Calibri\"/></font></fonts><fills count=\"2\"><fill><patternFill patternType=\"none\"/></fill><fill><patternFill patternType=\"gray125\"/></fill></fills><borders count=\"1\"><border/></borders><cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs><cellXfs count=\"5\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/><xf numFmtId=\"0\" fontId=\"1\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyFont=\"1\"/><xf numFmtId=\"165\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyNumberFormat=\"1\"/><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/><xf numFmtId=\"164\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyNumberFormat=\"1\"/></cellXfs></styleSheet>" },
    ...sheets.map((sheet, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, data: sheet.xml })),
  ];
  const bytes = buildStoredZip(files);
  const verification = verifyBankStatementWorkbook(bytes, { transactionRows: rows.length });
  return { bytes, filename: `${fileStem(fileName)}_converted_${exportStatusToken(statusResult.status)}.xlsx`, verification };
}

/** V-F1 self-check for bytes generated by buildBankStatementWorkbook. */
export function verifyBankStatementWorkbook(bytes, { transactionRows: expectedTransactionRows } = {}) {
  const entries = storedZipEntries(bytes);
  const required = ["[Content_Types].xml", "xl/workbook.xml", "xl/styles.xml", ...BANK_STATEMENT_SHEETS.map((_, index) => `xl/worksheets/sheet${index + 1}.xml`)];
  for (const name of required) if (!entries.has(name)) throw new Error(`XLSX round-trip failed: missing ${name}`);
  const workbook = decoder.decode(entries.get("xl/workbook.xml"));
  const names = [...workbook.matchAll(/<sheet name="([^"]+)"/g)].map((match) => match[1]);
  if (JSON.stringify(names) !== JSON.stringify(BANK_STATEMENT_SHEETS)) throw new Error("XLSX round-trip failed: sheet names or order differ");
  const transactions = decoder.decode(entries.get("xl/worksheets/sheet2.xml"));
  const headers = [...transactions.matchAll(/<row r="1">([\s\S]*?)<\/row>/g)][0]?.[1] ?? "";
  for (const header of BANK_STATEMENT_TRANSACTION_HEADERS) if (!headers.includes(`>${xml(header)}<`)) throw new Error(`XLSX round-trip failed: missing Transactions header ${header}`);
  if (/<f[\s>]/.test(transactions) || /<mergeCells\b/.test(transactions)) throw new Error("XLSX round-trip failed: formulas or merged cells found in Transactions");
  const rows = (transactions.match(/<row r="\d+">/g) || []).length - 1;
  if (expectedTransactionRows !== undefined && rows !== expectedTransactionRows) throw new Error("XLSX round-trip failed: transaction row count differs");
  if (!/<autoFilter\b/.test(transactions) || !/<pane ySplit="1"/.test(transactions)) throw new Error("XLSX round-trip failed: Transactions filter or frozen header missing");
  return { passed: true, sheetNames: names, transactionRows: rows };
}
