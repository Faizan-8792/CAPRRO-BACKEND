// ─── CaProFiles: shared, dependency-free file read/export helpers ───────────
// Reads CSV/TSV/TXT, native Excel (.xlsx), and Word (.docx) entirely in the
// browser (no external libraries), and writes clean CSV and Excel (.xlsx)
// downloads. Excel/Word are Open XML ZIP packages, unzipped with the browser's
// built-in DecompressionStream. This keeps everything offline and CSP-safe for
// the extension. PDF text extraction is delegated to CaProNoticeFiles when it
// is loaded on the page.
(() => {
  const MAX_TEXT = 250000;

  // ── CRC32 (for ZIP writing) ──────────────────────────────────────────────
  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  // ── XML text helpers ──────────────────────────────────────────────────────
  function xmlEscape(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function xmlUnescape(value) {
    return String(value)
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
      .replace(/&amp;/g, "&");
  }

  // ── ZIP reading (STORED + raw DEFLATE) ────────────────────────────────────
  async function inflateRaw(bytes) {
    if (typeof DecompressionStream !== "function") {
      throw new Error("This browser cannot read Excel/Word files. Please update your browser or upload a CSV.");
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  async function parseZip(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    const minStart = Math.max(0, bytes.length - 22 - 65536);
    for (let i = bytes.length - 22; i >= minStart; i -= 1) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("This file is not a valid Excel or Word file.");
    const count = view.getUint16(eocd + 10, true);
    let pointer = view.getUint32(eocd + 16, true);
    const raw = [];
    for (let i = 0; i < count; i += 1) {
      if (view.getUint32(pointer, true) !== 0x02014b50) break;
      const method = view.getUint16(pointer + 10, true);
      const compSize = view.getUint32(pointer + 20, true);
      const nameLen = view.getUint16(pointer + 28, true);
      const extraLen = view.getUint16(pointer + 30, true);
      const commentLen = view.getUint16(pointer + 32, true);
      const localOffset = view.getUint32(pointer + 42, true);
      const name = new TextDecoder().decode(bytes.subarray(pointer + 46, pointer + 46 + nameLen));
      const localNameLen = view.getUint16(localOffset + 26, true);
      const localExtraLen = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + localNameLen + localExtraLen;
      raw.push({ name, method, comp: bytes.subarray(dataStart, dataStart + compSize) });
      pointer += 46 + nameLen + extraLen + commentLen;
    }
    const out = new Map();
    for (const entry of raw) {
      if (entry.method === 0) out.set(entry.name, entry.comp);
      else if (entry.method === 8) out.set(entry.name, await inflateRaw(entry.comp));
    }
    return out;
  }

  // ── ZIP writing (STORED, no compression — always valid) ───────────────────
  function buildZip(files) {
    const encoder = new TextEncoder();
    const local = [];
    const central = [];
    let offset = 0;
    for (const file of files) {
      const nameBytes = encoder.encode(file.name);
      const data = file.data;
      const crc = crc32(data);
      const size = data.length;
      const header = new Uint8Array(30 + nameBytes.length);
      const dv = new DataView(header.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(8, 0, true);
      dv.setUint16(12, 0x21, true);
      dv.setUint32(14, crc, true);
      dv.setUint32(18, size, true);
      dv.setUint32(22, size, true);
      dv.setUint16(26, nameBytes.length, true);
      header.set(nameBytes, 30);
      local.push(header, data);

      const cd = new Uint8Array(46 + nameBytes.length);
      const cdv = new DataView(cd.buffer);
      cdv.setUint32(0, 0x02014b50, true);
      cdv.setUint16(4, 20, true);
      cdv.setUint16(6, 20, true);
      cdv.setUint16(14, 0x21, true);
      cdv.setUint32(16, crc, true);
      cdv.setUint32(20, size, true);
      cdv.setUint32(24, size, true);
      cdv.setUint16(28, nameBytes.length, true);
      cdv.setUint32(42, offset, true);
      cd.set(nameBytes, 46);
      central.push(cd);
      offset += header.length + data.length;
    }
    const centralSize = central.reduce((sum, c) => sum + c.length, 0);
    const eocd = new Uint8Array(22);
    const edv = new DataView(eocd.buffer);
    edv.setUint32(0, 0x06054b50, true);
    edv.setUint16(8, files.length, true);
    edv.setUint16(10, files.length, true);
    edv.setUint32(12, centralSize, true);
    edv.setUint32(16, offset, true);
    const parts = [...local, ...central, eocd];
    const total = parts.reduce((sum, p) => sum + p.length, 0);
    const out = new Uint8Array(total);
    let cursor = 0;
    for (const part of parts) { out.set(part, cursor); cursor += part.length; }
    return out;
  }

  // ── Delimited (CSV/TSV) parsing ───────────────────────────────────────────
  function detectDelimiter(headerLine) {
    const line = String(headerLine || "");
    const tabs = (line.match(/\t/g) || []).length;
    const semis = (line.match(/;/g) || []).length;
    const commas = (line.match(/,/g) || []).length;
    if (tabs > 0 && tabs >= commas && tabs >= semis) return "\t";
    if (semis > commas && semis > 0) return ";";
    return ",";
  }
  function parseDelimited(text, delimiter) {
    const source = String(text || "");
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    const pushField = () => { row.push(field); field = ""; };
    const pushRow = () => { if (row.some((cell) => String(cell).trim() !== "")) rows.push(row); row = []; };
    for (let i = 0; i < source.length; i += 1) {
      const ch = source[i];
      if (inQuotes) {
        if (ch === '"') { if (source[i + 1] === '"') { field += '"'; i += 1; } else inQuotes = false; }
        else field += ch;
      } else if (ch === '"') inQuotes = true;
      else if (ch === delimiter) pushField();
      else if (ch === "\n" || ch === "\r") { if (ch === "\r" && source[i + 1] === "\n") i += 1; pushField(); pushRow(); }
      else field += ch;
    }
    pushField();
    pushRow();
    return rows;
  }
  function tableFromText(text) {
    const clean = String(text || "").replace(/^\uFEFF/, "");
    const firstBreak = clean.search(/\r?\n/);
    const headerLine = firstBreak === -1 ? clean : clean.slice(0, firstBreak);
    const rows = parseDelimited(clean, detectDelimiter(headerLine));
    return { headers: rows.length ? rows[0].map((h) => String(h).trim()) : [], rows: rows.slice(1) };
  }

  // ── Excel (.xlsx) reading ─────────────────────────────────────────────────
  function columnToIndex(ref) {
    let n = 0;
    for (let i = 0; i < ref.length; i += 1) n = n * 26 + (ref.charCodeAt(i) - 64);
    return n - 1;
  }
  function parseSharedStrings(xml) {
    const out = [];
    const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = siRe.exec(xml)) !== null) {
      const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
      let t;
      let value = "";
      while ((t = tRe.exec(m[1])) !== null) value += xmlUnescape(t[1]);
      out.push(value);
    }
    return out;
  }
  function parseSheet(xml, shared) {
    const rows = [];
    const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    let rm;
    while ((rm = rowRe.exec(xml)) !== null) {
      const cells = [];
      const cRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      let cm;
      let autoIndex = 0;
      while ((cm = cRe.exec(rm[1])) !== null) {
        const attrs = cm[1] || "";
        const body = cm[2] || "";
        const refMatch = /r="([A-Z]+)\d+"/.exec(attrs);
        const type = /t="([^"]+)"/.exec(attrs)?.[1];
        let value = "";
        if (type === "s") {
          const vi = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
          value = shared[Number(vi)] ?? "";
        } else if (type === "inlineStr") {
          const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
          let t;
          while ((t = tRe.exec(body)) !== null) value += xmlUnescape(t[1]);
        } else {
          const vi = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
          value = vi != null ? xmlUnescape(vi) : "";
        }
        const index = refMatch ? columnToIndex(refMatch[1]) : autoIndex;
        cells[index] = value;
        autoIndex = index + 1;
      }
      for (let i = 0; i < cells.length; i += 1) if (cells[i] == null) cells[i] = "";
      rows.push(cells);
    }
    return rows;
  }
  async function readXlsx(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const zip = await parseZip(bytes);
    let sheet = zip.get("xl/worksheets/sheet1.xml");
    if (!sheet) {
      for (const [name, data] of zip) {
        if (/^xl\/worksheets\/.+\.xml$/.test(name)) { sheet = data; break; }
      }
    }
    if (!sheet) throw new Error("No sheet was found in this Excel file.");
    const decoder = new TextDecoder();
    const shared = zip.has("xl/sharedStrings.xml")
      ? parseSharedStrings(decoder.decode(zip.get("xl/sharedStrings.xml")))
      : [];
    const rows = parseSheet(decoder.decode(sheet), shared);
    return { headers: rows.length ? rows[0] : [], rows: rows.slice(1) };
  }

  // ── Word (.docx) reading (text only) ──────────────────────────────────────
  async function readDocxText(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const zip = await parseZip(bytes);
    const doc = zip.get("word/document.xml");
    if (!doc) throw new Error("This Word file could not be read.");
    const xml = new TextDecoder().decode(doc);
    const paragraphs = xml.split(/<\/w:p>/).map((chunk) => {
      const tRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
      let t;
      let line = "";
      while ((t = tRe.exec(chunk)) !== null) line += xmlUnescape(t[1]);
      return line;
    });
    return paragraphs.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_TEXT);
  }

  // ── Excel (.xlsx) writing ─────────────────────────────────────────────────
  function columnName(index) {
    let n = index + 1;
    let name = "";
    while (n > 0) { const rem = (n - 1) % 26; name = String.fromCharCode(65 + rem) + name; n = Math.floor((n - 1) / 26); }
    return name;
  }
  function sanitizeSheetName(name) {
    return (String(name || "Sheet1").replace(/[\\/?*[\]:]/g, " ").trim() || "Sheet1").slice(0, 31);
  }
  function buildSheetXml(matrix) {
    const rowsXml = matrix.map((cells, r) => {
      const cellsXml = cells.map((value, c) => {
        const ref = columnName(c) + (r + 1);
        return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
      }).join("");
      return `<row r="${r + 1}">${cellsXml}</row>`;
    }).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml}</sheetData></worksheet>`;
  }
  function buildXlsx(headers, rows, sheetName) {
    const matrix = [Array.isArray(headers) ? headers : [], ...(Array.isArray(rows) ? rows : [])];
    const encoder = new TextEncoder();
    const name = sanitizeSheetName(sheetName);
    const files = [
      { name: "[Content_Types].xml", data: encoder.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>') },
      { name: "_rels/.rels", data: encoder.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>') },
      { name: "xl/workbook.xml", data: encoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEscape(name)}" sheetId="1" r:id="rId1"/></sheets></workbook>`) },
      { name: "xl/_rels/workbook.xml.rels", data: encoder.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>') },
      { name: "xl/worksheets/sheet1.xml", data: encoder.encode(buildSheetXml(matrix)) },
    ];
    return buildZip(files);
  }

  // ── CSV writing ───────────────────────────────────────────────────────────
  function csvCell(value) {
    const text = String(value == null ? "" : value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }
  function toCsv(headers, rows) {
    const lines = [];
    if (Array.isArray(headers) && headers.length) lines.push(headers.map(csvCell).join(","));
    (rows || []).forEach((row) => lines.push((row || []).map(csvCell).join(",")));
    return lines.join("\r\n");
  }

  // ── Download helpers ──────────────────────────────────────────────────────
  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function downloadCsv(filename, headers, rows) {
    triggerDownload(new Blob(["\uFEFF" + toCsv(headers, rows)], { type: "text/csv;charset=utf-8" }), filename);
  }
  function downloadXlsx(filename, headers, rows, sheetName) {
    const bytes = buildXlsx(headers, rows, sheetName);
    triggerDownload(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), filename);
  }

  // ── Public high-level readers ─────────────────────────────────────────────
  function extensionOf(file) {
    return String(file?.name || "").toLowerCase().match(/\.[^.]+$/)?.[0] || "";
  }
  async function readTable(file) {
    if (!(file instanceof File)) throw new Error("Select a file first.");
    if (file.size > 15 * 1024 * 1024) throw new Error("This file is larger than 15 MB. Split it and upload smaller files.");
    const ext = extensionOf(file);
    if (ext === ".xlsx") return readXlsx(file);
    if (ext === ".xls") throw new Error("The old .xls format is not supported. In Excel, use Save As and choose .xlsx or CSV.");
    if (ext === ".csv" || ext === ".tsv" || ext === ".txt" || (file.type || "").startsWith("text/")) {
      return tableFromText((await file.text()).replace(/^\uFEFF/, ""));
    }
    throw new Error("Unsupported file. Upload a CSV, TSV, or Excel (.xlsx) file.");
  }
  async function readText(file) {
    if (!(file instanceof File)) throw new Error("Select a file first.");
    if (file.size > 25 * 1024 * 1024) throw new Error("This file is larger than 25 MB. Choose a smaller file.");
    const ext = extensionOf(file);
    if (ext === ".pdf" || file.type === "application/pdf") {
      if (globalThis.CaProNoticeFiles?.extractLocalFile) {
        return (await globalThis.CaProNoticeFiles.extractLocalFile(file)).text;
      }
      throw new Error("PDF reading is not available here. Paste the text instead.");
    }
    if (ext === ".docx") return readDocxText(file);
    if (ext === ".xlsx") {
      const { headers, rows } = await readXlsx(file);
      return [headers, ...rows].map((row) => (row || []).join("\t")).join("\n").slice(0, MAX_TEXT);
    }
    return (await file.text()).replace(/^\uFEFF/, "").slice(0, MAX_TEXT);
  }

  const api = Object.freeze({
    readTable,
    readText,
    tableFromText,
    toCsv,
    buildXlsx,
    downloadCsv,
    downloadXlsx,
    // low-level, exposed for tests
    _parseZip: parseZip,
    _buildZip: buildZip,
    _crc32: crc32,
  });
  if (typeof globalThis !== "undefined") globalThis.CaProFiles = api;

  // ── Money: rupee-facing input, integer-paise storage ──────────────────────
  // CAs think in rupees ("12,500.50"), the backend stores integer paise.
  // This keeps the visible field friendly while the payload stays exact.
  const RUPEE_SYMBOL = "\u20B9";

  // Parse a rupee string (or number) into integer paise using integer-only math
  // so 12500.50 never turns into 1250049 via float error. Empty is allowed and
  // returns paise:null so optional fields stay optional.
  function parseRupeesToPaise(input, options) {
    const opts = options || {};
    const allowNegative = opts.allowNegative === true;
    if (input == null) return { ok: true, paise: null, empty: true };
    let text = String(input).trim();
    if (text === "") return { ok: true, paise: null, empty: true };
    text = text.replace(new RegExp(RUPEE_SYMBOL, "g"), "").replace(/INR/gi, "").replace(/\s+/g, "").replace(/,/g, "");
    if (text === "") return { ok: false, paise: null, error: "Enter an amount like 12,500.50." };
    let negative = false;
    if (text[0] === "+") text = text.slice(1);
    else if (text[0] === "-") {
      if (!allowNegative) return { ok: false, paise: null, error: "Amount cannot be negative." };
      negative = true;
      text = text.slice(1);
    }
    if (/\.\d{3,}$/.test(text)) return { ok: false, paise: null, error: "Use at most two decimal places (paise)." };
    if (!/^\d+(\.\d{1,2})?$/.test(text)) return { ok: false, paise: null, error: "Enter a valid amount like 12,500.50." };
    const [wholePart, fractionPart = ""] = text.split(".");
    if (wholePart.length > 15) return { ok: false, paise: null, error: "Amount is too large." };
    const whole = Number(wholePart);
    const fractionPaise = Number((fractionPart + "00").slice(0, 2));
    const paiseAbs = whole * 100 + fractionPaise;
    if (!Number.isSafeInteger(paiseAbs)) return { ok: false, paise: null, error: "Amount is too large." };
    return { ok: true, paise: negative ? -paiseAbs : paiseAbs, empty: false };
  }

  // Format integer paise back into a grouped rupee string for display or for
  // pre-filling an edit field. { symbol:true } prefixes the rupee sign.
  function formatPaiseToRupees(paise, options) {
    const opts = options || {};
    const minor = Number(paise);
    if (!Number.isSafeInteger(minor)) return opts.fallback == null ? "" : opts.fallback;
    const negative = minor < 0;
    const absolute = Math.abs(minor);
    const whole = Math.floor(absolute / 100).toLocaleString("en-IN");
    const fraction = String(absolute % 100).padStart(2, "0");
    return `${negative ? "-" : ""}${opts.symbol ? RUPEE_SYMBOL : ""}${whole}.${fraction}`;
  }

  // Turn a plain text input into a rupee-facing field: decimal keypad, a rupee
  // affix, and a friendly placeholder. Non-destructive and idempotent so it is
  // safe to call on every re-render. Conversion still happens at submit time.
  function enhanceMoneyInput(inputEl, options) {
    if (!inputEl || inputEl.dataset.caproMoney === "true") return inputEl;
    const opts = options || {};
    inputEl.type = "text";
    inputEl.inputMode = "decimal";
    inputEl.autocomplete = "off";
    inputEl.dataset.caproMoney = "true";
    if (opts.allowNegative) inputEl.dataset.caproMoneyNegative = "true";
    if (!inputEl.getAttribute("placeholder")) inputEl.placeholder = "e.g. 12,500.50";
    const parent = inputEl.parentNode;
    if (parent && typeof document !== "undefined" && !(parent.classList && parent.classList.contains("capro-money"))) {
      const wrap = document.createElement("span");
      wrap.className = "capro-money";
      const symbol = document.createElement("span");
      symbol.className = "capro-money-symbol";
      symbol.setAttribute("aria-hidden", "true");
      symbol.textContent = RUPEE_SYMBOL;
      parent.insertBefore(wrap, inputEl);
      wrap.append(symbol, inputEl);
    }
    return inputEl;
  }

  const money = Object.freeze({
    parseRupeesToPaise,
    formatPaiseToRupees,
    enhanceInput: enhanceMoneyInput,
    symbol: RUPEE_SYMBOL,
  });
  // ── Validate: GSTIN / PAN / TAN format with a calm inline hint ────────────
  // CAs know these codes; we only confirm the shape and nudge gently, never block.
  const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
  const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
  const TAN_RE = /^[A-Z]{4}[0-9]{5}[A-Z]$/;

  function checkCode(re, cleaned, label, length) {
    if (cleaned === "") return { ok: true, empty: true, error: "" };
    if (re.test(cleaned)) return { ok: true, empty: false, error: "" };
    return { ok: false, empty: false, error: `Check the ${label} format (${length} characters, like the sample).` };
  }
  const gstin = (value) => checkCode(GSTIN_RE, String(value || "").toUpperCase().replace(/\s+/g, ""), "GSTIN", 15);
  const pan = (value) => checkCode(PAN_RE, String(value || "").toUpperCase().replace(/\s+/g, ""), "PAN", 10);
  const tan = (value) => checkCode(TAN_RE, String(value || "").toUpperCase().replace(/\s+/g, ""), "TAN", 10);

  const CODE_VALIDATORS = { gstin, pan, tan };

  // Attach a live, calm format hint to a GSTIN/PAN/TAN input. Uppercases as the
  // CA types, shows a quiet confirmation or a gentle correction, and never
  // blocks submission. Idempotent.
  function attachFormatHint(inputEl, kind) {
    if (!inputEl || typeof document === "undefined") return inputEl;
    const validator = CODE_VALIDATORS[kind];
    if (!validator || inputEl.dataset.caproCode === "true") return inputEl;
    inputEl.dataset.caproCode = kind;
    inputEl.autocapitalize = "characters";
    inputEl.spellcheck = false;
    const hint = document.createElement("span");
    hint.className = "capro-code-hint";
    hint.setAttribute("aria-live", "polite");
    const hintId = `${inputEl.id || `code-${Math.random().toString(16).slice(2)}`}-hint`;
    hint.id = hintId;
    inputEl.setAttribute("aria-describedby", `${inputEl.getAttribute("aria-describedby") || ""} ${hintId}`.trim());
    if (inputEl.parentNode) inputEl.parentNode.insertBefore(hint, inputEl.nextSibling);
    const paint = () => {
      const upper = inputEl.value.toUpperCase();
      if (inputEl.value !== upper) {
        const pos = inputEl.selectionStart;
        inputEl.value = upper;
        try { inputEl.setSelectionRange(pos, pos); } catch (_) { /* ignore */ }
      }
      const result = validator(inputEl.value);
      if (result.empty) { hint.textContent = ""; hint.dataset.state = ""; return; }
      if (result.ok) { hint.textContent = "Format looks right."; hint.dataset.state = "ok"; }
      else { hint.textContent = result.error; hint.dataset.state = "warn"; }
    };
    inputEl.addEventListener("input", paint);
    inputEl.addEventListener("blur", paint);
    paint();
    return inputEl;
  }

  const validate = Object.freeze({ gstin, pan, tan, attachFormatHint });

  if (typeof globalThis !== "undefined") {
    globalThis.CaProMoney = money;
    globalThis.CaProValidate = validate;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = Object.freeze(Object.assign({}, api, { money, validate }));
  }
})();
