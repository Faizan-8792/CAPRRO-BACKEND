// Portal-style bulk ingestion: convert a GST portal GSTR-2B JSON export into the
// exact canonical rows the existing import pipeline (parseMappedImport +
// normalizeGstImportRow) already accepts. This means a CA can download the 2B
// JSON from the portal and reconcile it directly — no live API / GSP needed.
//
// Deliberately TOLERANT of GSTN shape variation across the offline utility, GSP
// exports, and API payloads: tax amounts are read invoice-level or summed from a
// nested items array, and both key conventions are accepted
// (igst/cgst/sgst/cess and GSTR-1-style iamt/camt/samt/csamt). Money stays exact
// downstream (the normalizer parses to integer paise).

import { DATE_ORDER, parseFlexibleDateIso, parseFlexibleMoneyMinor } from "./robust-normalize.service.js";

const CANONICAL_HEADERS = Object.freeze([
  "Supplier GSTIN",
  "Recipient GSTIN",
  "Invoice Number",
  "Document Date",
  "Document Type",
  "Taxable Value",
  "IGST",
  "CGST",
  "SGST",
  "Cess",
]);

// field -> source header, matching the GSTR2B default mapping used by the app.
const GSTR2B_MAPPING = Object.freeze({
  supplierGstin: "Supplier GSTIN",
  recipientGstin: "Recipient GSTIN",
  invoiceNumber: "Invoice Number",
  documentDate: "Document Date",
  documentType: "Document Type",
  taxableValue: "Taxable Value",
  igst: "IGST",
  cgst: "CGST",
  sgst: "SGST",
  cess: "Cess",
});

function pickKey(obj, keys) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const key of keys) {
    if (obj[key] != null && obj[key] !== "") return obj[key];
  }
  return undefined;
}

// null (not 0) for a value that is PRESENT but unreadable -- "no tax head" and "an
// unreadable tax head" are different facts, and collapsing them into 0 is how a portal
// export carrying "1,18,000.00" (Number() can't read the grouping commas) or "n/a"
// silently became a clean-looking row with nil tax instead of a visible problem. 0 stays
// reserved for a genuinely absent/empty value, which really does mean nil.
function num(value) {
  if (value == null || value === "") return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function money2(value) {
  // 2-decimal string; downstream normalizer converts to exact integer paise. Only used
  // where no exactness remains to protect -- see amountsForDocument's summed-items path.
  return (value ?? 0).toFixed(2);
}

// The GSTR-2B JSON schema specifies dd-mm-yyyy for `dt` -- this is the PORTAL'S
// STATED format, not an inference from the data, so day-first is correct here
// and is never a guess. Converting to ISO up front means every 2B-derived CSV
// date is UNAMBIGUOUS (classifyDateColumn scores it NOT_APPLICABLE), so the
// preview never has to ask the CA a question the GSTN spec already answers --
// and critically, it can never be pushed into a wrong reading by a `dateOrder`
// the CA states for the OTHER (books-side) file in the same reconciliation.
function portalDay(value) {
  const iso = parseFlexibleDateIso(String(value ?? "").trim(), { dateOrder: DATE_ORDER.DAY_FIRST });
  return iso || String(value ?? "").trim();
}

function taxOf(node) {
  return {
    txval: num(pickKey(node, ["txval", "taxable_value", "taxableValue", "taxval"])),
    igst: num(pickKey(node, ["igst", "iamt"])),
    cgst: num(pickKey(node, ["cgst", "camt"])),
    sgst: num(pickKey(node, ["sgst", "samt"])),
    cess: num(pickKey(node, ["cess", "csamt"])),
  };
}

const TAX_HEADS = Object.freeze(["txval", "igst", "cgst", "sgst", "cess"]);

// Raw key aliases per head, so the single-document path can find the ORIGINAL string for
// a CSV cell and a readability check, not just a Number()-parsed value.
const TAX_HEAD_KEYS = Object.freeze({
  txval: ["txval", "taxable_value", "taxableValue"],
  igst: ["igst", "iamt"],
  cgst: ["cgst", "camt"],
  sgst: ["sgst", "samt"],
  cess: ["cess", "csamt"],
});

// The downstream exact-paise parser is the actual authority on "is this readable money" --
// it already accepts ₹/Rs/INR, Indian and international grouping, and CR/DR suffixes, so
// re-approximating that with a cruder check here would both under- and over-warn. Reusing
// it means "1,18,000.00" is correctly recognised as readable despite failing plain Number().
function isReadableMoney(raw) {
  if (raw == null || raw === "") return true; // absent is nil, not unreadable
  try {
    parseFlexibleMoneyMinor(raw, { allowBlank: true });
    return true;
  } catch {
    return false;
  }
}

function amountsForDocument(doc) {
  const items = pickKey(doc, ["items", "itms", "det"]);
  if (Array.isArray(items) && items.length) {
    // Summed path: the values were already JSON numbers coming in, so there is no
    // exactness left to protect by keeping a raw string -- an unreadable item's head
    // contributes 0 to the total (unchanged from before) but is flagged, rather than
    // silently vanishing into a clean-looking sum.
    const sum = { txval: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
    let unreadable = false;
    for (const item of items) {
      const detail = (item && (item.itm_det || item.item_det)) || item;
      const t = taxOf(detail);
      for (const head of TAX_HEADS) {
        if (t[head] === null) {
          unreadable = true;
        } else {
          sum[head] += t[head];
        }
      }
    }
    return { summed: true, unreadable, cells: Object.fromEntries(TAX_HEADS.map((head) => [head, money2(sum[head])])) };
  }

  // Single-document path: the raw string is passed straight through to the CSV cell,
  // always, not only on failure -- this is the float round-trip C11 removes. Readability
  // is checked with the real downstream parser, never with plain Number().
  let unreadable = false;
  const cells = {};
  for (const head of TAX_HEADS) {
    const raw = pickKey(doc, TAX_HEAD_KEYS[head]);
    if (raw == null || raw === "") {
      cells[head] = "0.00";
      continue;
    }
    cells[head] = String(raw).trim();
    if (!isReadableMoney(raw)) unreadable = true;
  }
  return { summed: false, unreadable, cells };
}

function resolveDocdata(input) {
  const root = input && typeof input === "object" ? input : {};
  const data = root.data && typeof root.data === "object" ? root.data : root;
  const docdata = data.docdata && typeof data.docdata === "object" ? data.docdata : data;
  return { data, docdata };
}

// MMYYYY -> YYYY-MM (portal return period), best-effort.
function periodToIsoMonth(rtnprd) {
  const s = String(rtnprd || "").trim();
  const m = /^(\d{2})(\d{4})$/.exec(s);
  return m ? `${m[2]}-${m[1]}` : "";
}

function noteType(typ) {
  const t = String(typ || "").trim().toUpperCase();
  if (t === "D" || t === "DR" || t === "DEBIT") return "DEBIT_NOTE";
  return "CREDIT_NOTE";
}

/**
 * Convert a GSTR-2B JSON export into canonical GSTR-2B rows.
 * @returns {{ rows: object[], csv: string, mapping: object, headers: string[], meta: object, warnings: object[] }}
 */
export function convertGstr2bJson(input) {
  const { data, docdata } = resolveDocdata(input);
  const recipientGstin = String(pickKey(data, ["gstin", "recipient_gstin"]) || "").trim().toUpperCase();
  const warnings = [];
  const rows = [];

  if (!recipientGstin) {
    warnings.push({ code: "RECIPIENT_GSTIN_MISSING", message: "GSTR-2B JSON has no recipient GSTIN (data.gstin)" });
  }

  const pushDoc = ({ supplierGstin, invoiceNumber, dt, documentType, doc }) => {
    const supplier = String(supplierGstin || "").trim().toUpperCase();
    const invoice = String(invoiceNumber || "").trim();
    if (!supplier || !invoice) {
      warnings.push({ code: "DOCUMENT_SKIPPED", message: `Missing supplier GSTIN or document number (ctin=${supplier || "?"}, num=${invoice || "?"})` });
      return;
    }
    const a = amountsForDocument(doc);
    const rawDate = pickKey(doc, ["dt", "date"]) || dt;
    const documentDate = portalDay(rawDate);
    if (!parseFlexibleDateIso(String(rawDate ?? "").trim(), { dateOrder: DATE_ORDER.DAY_FIRST })) {
      warnings.push({
        code: "DOCUMENT_DATE_UNREADABLE",
        message: `Document date could not be read (ctin=${supplier}, num=${invoice}, dt=${String(rawDate ?? "").trim() || "?"})`,
      });
    }

    if (a.unreadable) {
      warnings.push({
        code: "AMOUNT_UNREADABLE",
        message: a.summed
          ? `One or more summed line amounts could not be read (ctin=${supplier}, num=${invoice})`
          : `An amount could not be read (ctin=${supplier}, num=${invoice})`,
      });
    }

    rows.push({
      "Supplier GSTIN": supplier,
      "Recipient GSTIN": recipientGstin,
      "Invoice Number": invoice,
      "Document Date": documentDate,
      "Document Type": documentType,
      "Taxable Value": a.cells.txval,
      "IGST": a.cells.igst,
      "CGST": a.cells.cgst,
      "SGST": a.cells.sgst,
      "Cess": a.cells.cess,
    });
  };

  // Invoices: b2b + amended b2b
  for (const section of ["b2b", "b2ba"]) {
    const groups = Array.isArray(docdata[section]) ? docdata[section] : [];
    for (const group of groups) {
      const supplierGstin = pickKey(group, ["ctin", "supplier_gstin", "gstin"]);
      const invoices = Array.isArray(group?.inv) ? group.inv : [];
      for (const inv of invoices) {
        pushDoc({
          supplierGstin,
          invoiceNumber: pickKey(inv, ["inum", "invoice_number", "num"]),
          dt: pickKey(inv, ["dt", "idt"]),
          documentType: "INVOICE",
          doc: inv,
        });
      }
    }
  }

  // Credit / debit notes: cdnr + amended cdnr
  for (const section of ["cdnr", "cdnra"]) {
    const groups = Array.isArray(docdata[section]) ? docdata[section] : [];
    for (const group of groups) {
      const supplierGstin = pickKey(group, ["ctin", "supplier_gstin", "gstin"]);
      const notes = Array.isArray(group?.nt) ? group.nt : Array.isArray(group?.inv) ? group.inv : [];
      for (const note of notes) {
        pushDoc({
          supplierGstin,
          invoiceNumber: pickKey(note, ["ntnum", "nt_num", "inum", "num"]),
          dt: pickKey(note, ["dt", "nt_dt", "ntdt"]),
          documentType: noteType(pickKey(note, ["typ", "ntty", "type"])),
          doc: note,
        });
      }
    }
  }

  const csv = [
    CANONICAL_HEADERS.join(","),
    ...rows.map((row) => CANONICAL_HEADERS.map((h) => csvCell(row[h])).join(",")),
  ].join("\n");

  return {
    rows,
    csv,
    mapping: { ...GSTR2B_MAPPING },
    headers: [...CANONICAL_HEADERS],
    meta: {
      recipientGstin,
      period: periodToIsoMonth(pickKey(data, ["rtnprd", "ret_period"])),
      documentCount: rows.length,
    },
    warnings,
  };
}

function csvCell(value) {
  const s = String(value == null ? "" : value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export { CANONICAL_HEADERS, GSTR2B_MAPPING };
