// src/services/workbook.service.js
//
// W10 AP9 (2026-10-15): one dependency-free Office Open XML writer for every workbook the server
// builds - first the audit pack exports. Lifted from bank-statement-xlsx.service.js (stored ZIP,
// inline strings, explicit numeric cells), with what that writer lacked for statutory figures:
//
//   - money in the Indian grouping. The format code is the one the extension's workbooks already
//     use (file-tools.js, numFmt 164), so a figure reads the same in every CA PRO workbook:
//     1,23,45,678.90 above a crore, 12,34,567.89 above a lakh, 1,234.56 below.
//   - money arrives as integer paise and is written by integer arithmetic, never through a float.
//   - text is always an inline string, so a cell that starts with "=", "+", "-" or "@" is stored
//     and shown as text and never evaluated as a formula.
//   - every sheet's header row is frozen and filterable; text is capped at Excel's 32,767 characters.
//
// buildWorkbook() reads its own bytes back (verifyWorkbook) before returning them, so a malformed
// workbook is an error here rather than a broken download.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const INDIAN_RUPEE_FORMAT = "[>=10000000]\"₹\"##\\,##\\,##\\,##0.00;[>=100000]\"₹\"##\\,##\\,##0.00;\"₹\"##,##0.00";
const MAX_CELL_TEXT = 32_767;
const MAX_SHEET_NAME = 31;

const STYLE = Object.freeze({ text: 0, header: 1, money: 2, integer: 3, date: 4, wrap: 5 });

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let value = 0; value < 256; value += 1) {
    let current = value;
    for (let bit = 0; bit < 8; bit += 1) current = current & 1 ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
    table[value] = current >>> 0;
  }
  return table;
})();

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

/** Integer paise as the decimal rupee string a numeric cell holds. Never passes through a float. */
export function paiseToRupeeString(paise) {
  if (!Number.isSafeInteger(paise)) throw new TypeError(`Workbook money must be integer paise, got ${paise}`);
  const negative = paise < 0;
  const absolute = BigInt(Math.abs(paise));
  const whole = absolute / 100n;
  const fraction = String(absolute % 100n).padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

function excelDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso ?? ""))) throw new Error(`Expected an ISO date for the workbook: ${iso}`);
  const timestamp = Date.parse(`${iso}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid date for the workbook: ${iso}`);
  // Excel's 1900 date system counts the non-existent 29-Feb-1900, hence the 1899-12-30 epoch.
  return String(Math.round(timestamp / 86_400_000 + 25569));
}

function textCell(reference, value, style = STYLE.text) {
  const text = String(value ?? "").slice(0, MAX_CELL_TEXT);
  return `<c r="${reference}"${style ? ` s="${style}"` : ""} t="inlineStr"><is><t xml:space="preserve">${xml(text)}</t></is></c>`;
}

function numberCell(reference, value, style) {
  return `<c r="${reference}" s="${style}"><v>${value}</v></c>`;
}

/**
 * A cell is a string, a number of rows/days, null (left blank), or one of:
 *   { money: <integer paise> } { integer: <n> } { date: "YYYY-MM-DD" } { text: <s>, wrap: true }
 * A bare number is refused: an amount must say it is money so it is never written as a float.
 */
function makeCell(reference, cell) {
  if (cell === null || cell === undefined || cell === "") return "";
  if (typeof cell === "string") return textCell(reference, cell);
  if (typeof cell === "number") throw new TypeError(`Workbook cell ${reference}: a bare number; use { money } or { integer }`);
  if ("money" in cell) return cell.money === null ? "" : numberCell(reference, paiseToRupeeString(cell.money), STYLE.money);
  if ("integer" in cell) {
    if (!Number.isSafeInteger(cell.integer)) throw new TypeError(`Workbook cell ${reference}: not an integer`);
    return numberCell(reference, String(cell.integer), STYLE.integer);
  }
  if ("date" in cell) return cell.date ? numberCell(reference, excelDate(cell.date), STYLE.date) : "";
  if ("text" in cell) return textCell(reference, cell.text, cell.wrap ? STYLE.wrap : STYLE.text);
  throw new TypeError(`Workbook cell ${reference}: unknown cell shape`);
}

function rowXml(cells, rowNumber, { header = false } = {}) {
  const body = cells.map((cell, index) => {
    const reference = `${columnName(index)}${rowNumber}`;
    return header ? textCell(reference, cell, STYLE.header) : makeCell(reference, cell);
  }).join("");
  return `<row r="${rowNumber}">${body}</row>`;
}

function worksheetXml({ headers, rows, widths = [] }) {
  const lastColumn = columnName(Math.max(0, headers.length - 1));
  const lastRow = Math.max(1, rows.length + 1);
  const cols = widths.length
    ? `<cols>${widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${Number(width) || 12}" customWidth="1"/>`).join("")}</cols>`
    : "";
  const panes = "<sheetViews><sheetView workbookViewId=\"0\"><pane ySplit=\"1\" topLeftCell=\"A2\" activePane=\"bottomLeft\" state=\"frozen\"/><selection pane=\"bottomLeft\" activeCell=\"A2\" sqref=\"A2\"/></sheetView></sheetViews>";
  const data = `<sheetData>${rowXml(headers, 1, { header: true })}${rows.map((row, index) => rowXml(row, index + 2)).join("")}</sheetData>`;
  const filter = headers.length ? `<autoFilter ref="A1:${lastColumn}${lastRow}"/>` : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${lastColumn}${lastRow}"/>${panes}${cols}${data}${filter}</worksheet>`;
}

function stylesXml() {
  return "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>" +
    "<styleSheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\">" +
    `<numFmts count="2"><numFmt numFmtId="164" formatCode="${xml(INDIAN_RUPEE_FORMAT)}"/><numFmt numFmtId="165" formatCode="dd-mm-yyyy"/></numFmts>` +
    "<fonts count=\"2\"><font><sz val=\"11\"/><name val=\"Calibri\"/></font><font><b/><sz val=\"11\"/><name val=\"Calibri\"/></font></fonts>" +
    "<fills count=\"2\"><fill><patternFill patternType=\"none\"/></fill><fill><patternFill patternType=\"gray125\"/></fill></fills>" +
    "<borders count=\"1\"><border/></borders>" +
    "<cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs>" +
    "<cellXfs count=\"6\">" +
    "<xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/>" +
    "<xf numFmtId=\"0\" fontId=\"1\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyFont=\"1\"/>" +
    "<xf numFmtId=\"164\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyNumberFormat=\"1\"/>" +
    "<xf numFmtId=\"1\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyNumberFormat=\"1\"/>" +
    "<xf numFmtId=\"165\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyNumberFormat=\"1\"/>" +
    "<xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyAlignment=\"1\"><alignment wrapText=\"1\" vertical=\"top\"/></xf>" +
    "</cellXfs></styleSheet>";
}

function buildStoredZip(files) {
  if (files.length > 0xffff) throw new Error("Too many workbook parts");
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = typeof file.data === "string" ? encoder.encode(file.data) : file.data;
    if (data.length > 0xffffffff) throw new Error(`Workbook part is too large: ${file.name}`);
    const crc = crc32(data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
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

/** The parts of a stored (uncompressed) ZIP, by name. Used to verify our own bytes. */
export function readWorkbookParts(bytes) {
  const buffer = Buffer.from(bytes);
  const start = Math.max(0, buffer.length - 22 - 65535);
  let end = -1;
  for (let index = buffer.length - 22; index >= start; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) { end = index; break; }
  }
  if (end < 0) throw new Error("Workbook round-trip failed: missing ZIP end record");
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("Workbook round-trip failed: invalid central directory");
    const method = buffer.readUInt16LE(offset + 10);
    const size = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = decoder.decode(buffer.subarray(offset + 46, offset + 46 + nameLength));
    if (method !== 0 || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("Workbook round-trip failed: unsupported ZIP part");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    entries.set(name, buffer.subarray(dataStart, dataStart + size));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export function verifyWorkbook(bytes, sheetNames) {
  const entries = readWorkbookParts(bytes);
  const required = ["[Content_Types].xml", "xl/workbook.xml", "xl/styles.xml", ...sheetNames.map((_, i) => `xl/worksheets/sheet${i + 1}.xml`)];
  for (const name of required) if (!entries.has(name)) throw new Error(`Workbook round-trip failed: missing ${name}`);
  const workbook = decoder.decode(entries.get("xl/workbook.xml"));
  const names = [...workbook.matchAll(/<sheet name="([^"]+)"/g)].map((match) => match[1]);
  if (JSON.stringify(names) !== JSON.stringify(sheetNames.map(xml))) throw new Error("Workbook round-trip failed: sheet names or order differ");
  for (let i = 0; i < sheetNames.length; i += 1) {
    const sheet = decoder.decode(entries.get(`xl/worksheets/sheet${i + 1}.xml`));
    if (/<f[\s>]/.test(sheet)) throw new Error(`Workbook round-trip failed: a formula in ${sheetNames[i]}`);
  }
  return { passed: true, sheetNames: names };
}

/**
 * @param {{ sheets: { name: string, headers: string[], rows: any[][], widths?: number[] }[] }} input
 * @returns {Buffer} the .xlsx bytes, already read back and verified
 */
export function buildWorkbook({ sheets }) {
  if (!Array.isArray(sheets) || sheets.length === 0) throw new Error("A workbook needs at least one sheet");
  const names = sheets.map((sheet) => String(sheet.name || "").slice(0, MAX_SHEET_NAME));
  if (new Set(names).size !== names.length || names.some((n) => !n || /[\\/?*[\]:]/.test(n))) {
    throw new Error("Workbook sheet names must be unique, non-empty and free of \\ / ? * [ ] :");
  }
  const styleRel = sheets.length + 1;
  const files = [
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`,
    },
    {
      name: "_rels/.rels",
      data: "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/></Relationships>",
    },
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((name, i) => `<sheet name="${xml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${styleRel}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
    { name: "xl/styles.xml", data: stylesXml() },
    ...sheets.map((sheet, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: worksheetXml(sheet) })),
  ];
  const bytes = buildStoredZip(files);
  verifyWorkbook(bytes, names);
  return bytes;
}
