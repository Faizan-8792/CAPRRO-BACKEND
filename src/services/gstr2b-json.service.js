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

function num(value) {
  if (value == null || value === "") return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function money2(value) {
  // 2-decimal string; downstream normalizer converts to exact integer paise.
  return num(value).toFixed(2);
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

function amountsForDocument(doc) {
  const items = pickKey(doc, ["items", "itms", "det"]);
  if (Array.isArray(items) && items.length) {
    const sum = { txval: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
    for (const item of items) {
      const detail = (item && (item.itm_det || item.item_det)) || item;
      const t = taxOf(detail);
      sum.txval += t.txval; sum.igst += t.igst; sum.cgst += t.cgst; sum.sgst += t.sgst; sum.cess += t.cess;
    }
    return sum;
  }
  return taxOf(doc);
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
    rows.push({
      "Supplier GSTIN": supplier,
      "Recipient GSTIN": recipientGstin,
      "Invoice Number": invoice,
      "Document Date": String(pickKey(doc, ["dt", "date"]) || dt || "").trim(),
      "Document Type": documentType,
      "Taxable Value": money2(a.txval),
      "IGST": money2(a.igst),
      "CGST": money2(a.cgst),
      "SGST": money2(a.sgst),
      "Cess": money2(a.cess),
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
