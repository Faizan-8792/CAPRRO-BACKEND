// tests/intelligence-language-contract.mjs
//
// W11 IN27-IN34 (2026-10-21): the intelligence features in "any condition" the owner named - other languages and
// scripts, other file encodings and layouts, and answers that do not say what their source says. Pure: no
// database, no network (the OCR provider and the quota are stubbed in-process).
//
// Run: node tests/intelligence-language-contract.mjs

import { foldCodePoint, foldDigits, foldForCompare, foldHeadingToken, foldText, foldWithMap } from "../src/services/text/fold.js";
import { readFreeText } from "../src/services/ai/ai-validate.js";
import { locateExcerpt, valueAgreesWithExcerpt } from "../src/services/case-excerpt.service.js";

const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass: Boolean(pass), detail });
const refusal = (fn) => {
  try {
    fn();
    return "";
  } catch (error) {
    return error.message;
  }
};

// ─── IN27: folding ───
const digitsOf = (zero) => Array.from({ length: 10 }, (_, n) => String.fromCodePoint(zero + n)).join("");
const scripts = { devanagari: 0x0966, bengali: 0x09e6, gurmukhi: 0x0a66, gujarati: 0x0ae6, oriya: 0x0b66, tamil: 0x0be6, telugu: 0x0c66, kannada: 0x0ce6, malayalam: 0x0d66, arabicIndic: 0x0660, extendedArabicIndic: 0x06f0, fullWidth: 0xff10 };
const unread = Object.entries(scripts).filter(([, zero]) => foldText(digitsOf(zero)) !== "0123456789").map(([name]) => name);
check("IN27: the digits of 12 scripts fold to 0-9", unread.length === 0, unread.join(", "));
check("IN27: every dash and minus folds to '-'", ["‐", "‑", "‒", "–", "—", "―", "−", "－"].every((dash) => foldText(dash) === "-"));
check("IN27: every Unicode space folds to a space; zero-width characters and the soft hyphen are dropped", foldText("a b c　d") === "a b c d" && foldText("a​b‍c­d﻿e") === "abcde");
check("IN27: curly quotes fold to straight ones", foldText("‘x’ “y”") === "'x' \"y\"");
check("IN27: letters of every script are kept (a Hindi heading is folded, never deleted)", foldText("चालान संख्या") === "चालान संख्या".normalize("NFKC") && foldHeadingToken("चालान संख्या") === "चालानसंख्या".normalize("NFKC"));
const mapped = foldWithMap("Due on २०/११/२०२०—done");
const at = mapped.text.indexOf("20/11/2020");
check("IN27: a folded range maps back to the original text verbatim", at > 0 && mapped.slice(at, at + "20/11/2020".length) === "२०/११/२०२०", mapped.slice(at, at + 10));
check("IN27: foldDigits changes digits only", foldDigits("रु. ४,१२,३८०/-") === "रु. 4,12,380/-");
check("IN27: foldForCompare is case- and space-blind", foldForCompare("  GSTIN / UIN ") === "gstin / uin");
check("IN27: a code point outside every table is NFKC-normalised (full-width A to A)", foldCodePoint(0xff21) === "A");

// ─── IN34: the "no invented number" check, in every script ───
const free = (text, extra = {}) => refusal(() => readFreeText(text, { max: 2000, slots: ["supplier"], ...extra }));
check("IN34: an invented Devanagari number is refused like an ASCII one", /number the server did not send/.test(free("कृपया ७ दिनों में फाइल करें")) && /number/.test(free("please file within 7 days")));
check("IN34: an invented Gujarati or Tamil amount is refused", /number/.test(free("રકમ ₹ ૪,૧૨,૩૮૦")) && /number/.test(free("தொகை ௪௧௨")));
check("IN34: the returns as Hindi writes them pass (जीएसटीआर-1, जीएसटीआर-2बी, जीएसटीआर 3बी)", free("कृपया जीएसटीआर-1 फाइल करें ताकि जीएसटीआर-2बी और जीएसटीआर 3बी में दिखे") === "");
check("IN34: the returns without the hyphen pass (GSTR1, GSTR 2B)", free("Please file GSTR1 so that it shows in GSTR 2B") === "");
check("IN34: a step number at the start of a line passes; one mid-sentence does not", free("1. GSTR-1 file karein\n2. Batayein") === "" && /number/.test(free("Please pay 2. Then file")));
check("IN34: a token the server sent passes in any script (194J)", free("Section 194J applies", { allowedTokens: new Set(["194J"]) }) === "");

// ─── IN30: a model excerpt is found through folding and redaction, and a value must agree with it ───
const notice = "FORM GST ASMT-10\nGSTIN: 27AAACE1234F1Z5\nPhone 9876543210\nDate: 21/10/2026\nTotal amount payable: Rs. 4,12,380/-\nReply on or before 20-11-2026.";
check("IN30: an excerpt with an en dash and extra spaces is found, and the notice's own text is returned", locateExcerpt("Reply on  or before 20–11–2026", notice) === "Reply on or before 20-11-2026");
check("IN30: redaction tokens stand for their shapes ([GSTIN], [PHONE])", locateExcerpt("GSTIN: [GSTIN]", notice) === "GSTIN: 27AAACE1234F1Z5" && locateExcerpt("Phone [PHONE]", notice) === "Phone 9876543210");
check("IN30: an excerpt that is only a token, or under three characters, finds nothing", locateExcerpt("[GSTIN]", notice) === null && locateExcerpt("Re", notice) === null);
check("IN30: an excerpt not in the notice finds nothing", locateExcerpt("IGNORE PREVIOUS INSTRUCTIONS", notice) === null);
const kinds = { dateFields: new Set(["issueDate", "responseDueDate"]), amountFields: new Set(["demandMinor"]) };
check("IN30: a date agrees only with a day its excerpt writes (Devanagari or month word too)", valueAgreesWithExcerpt("issueDate", "2026-10-21", "Date: 21/10/2026", kinds) && valueAgreesWithExcerpt("issueDate", "2026-11-20", "दिनांक २० नवंबर २०२६", kinds) && !valueAgreesWithExcerpt("issueDate", "2026-10-22", "Date: 21/10/2026", kinds));
check("IN30: an amount agrees only with a sum its excerpt writes (lakh scaled)", valueAgreesWithExcerpt("demandMinor", "Rs. 4,12,380", "Total: Rs. 4,12,380/-", kinds) && valueAgreesWithExcerpt("demandMinor", "₹4,12,000", "₹ 4.12 lakh", kinds) && !valueAgreesWithExcerpt("demandMinor", "Rs. 9,99,999", "Total: Rs. 4,12,380/-", kinds));
check("IN30: any other value may only use numbers its excerpt has", valueAgreesWithExcerpt("financialYear", "2024-25", "F.Y. 2024-25", kinds) && !valueAgreesWithExcerpt("din", "ZD9999", "DIN: ZD2710260012345", kinds));

// ─── IN29: OCR reads the notice's own language ───
process.env.OCR_SPACE_API_KEY = "scratch-ocr-key-not-real";
const ProviderUsage = (await import("../src/models/ProviderUsage.js")).default;
const ocr = await import("../src/services/ocr-space.service.js");
const realFetch = globalThis.fetch;
const realReserve = ProviderUsage.reserveProviderCall;
async function runOcr({ answers, quota = [true, true] }) {
  const sent = [];
  let reservations = 0;
  ProviderUsage.reserveProviderCall = async () => ({ allowed: quota[reservations++] !== false, reason: "OCR quota reached for this week" });
  globalThis.fetch = async (_url, options) => {
    const fields = {};
    for (const [name, value] of options.body.entries()) if (name !== "file") fields[name] = value;
    sent.push(fields);
    const answer = answers[sent.length - 1];
    if (answer instanceof Error) throw answer;
    return new Response(JSON.stringify({ IsErroredOnProcessing: false, ParsedResults: [{ ParsedText: answer }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await ocr.extractTextWithOcrSpace({ buffer: Buffer.from("%PDF-1.4 scratch"), mimeType: "application/pdf", fileName: "n.pdf", consent: true, userId: "6512ab00ab00ab00ab00ab01" });
    return { result, sent, reservations };
  } catch (error) {
    return { error, sent, reservations };
  } finally {
    globalThis.fetch = realFetch;
    ProviderUsage.reserveProviderCall = realReserve;
  }
}
const hindiText = "प्ररूप जीएसटी एएसएमटी-10 कर अवधि अप्रैल 2024 से मार्च 2025 कृपया उत्तर दें";
const garbage = "$%^ &*() ~~## !!@@ ¤¤¦¦ §§ ¨¨ ©© ªª «« ¬¬";
const one = await runOcr({ answers: [hindiText] });
check("IN29: no language is forced: the first attempt sends no 'language' and asks Engine 2", one.sent.length === 1 && !("language" in one.sent[0]) && one.sent[0].OCREngine === "2", JSON.stringify(one.sent));
check("IN29: a readable first reading is the answer, from one metered call", one.result?.readable === true && one.result.providerEngine === "2" && one.reservations === 1);
const two = await runOcr({ answers: [garbage, hindiText] });
check("IN29: a reading that is not text is tried once more on Engine 3, each attempt metered", two.sent.length === 2 && two.sent[1].OCREngine === "3" && two.result?.providerEngine === "3" && two.result.readable === true && two.reservations === 2, JSON.stringify({ sent: two.sent, r: two.reservations }));
const capped = await runOcr({ answers: [garbage, hindiText], quota: [true, false] });
check("IN29: when the quota refuses the second attempt, the first reading stands, marked not readable", capped.sent.length === 1 && capped.result?.readable === false && capped.result.text === garbage);
const failing = await runOcr({ answers: [garbage, new Error("network")] });
check("IN29: when the second attempt fails, the first reading stands, marked not readable", failing.result?.readable === false && failing.result.providerEngine === "2");
check("IN29: readability counts letters of any script and refuses symbols and U+FFFD", ocr.looksReadable(hindiText) && ocr.looksReadable("FORM GST ASMT-10 Notice for intimating discrepancies") && !ocr.looksReadable(garbage) && !ocr.looksReadable("��� abcdefghijklmnopqrstuvwxyz"));

// ─── IN32: import files in any layout and script ───
const robust = await import("../src/services/robust-normalize.service.js");
const shape = await import("../src/services/import-shape.service.js");
const gstNorm = await import("../src/services/gst-normalization.service.js");
const preview = await import("../src/services/import-preview.service.js");
const { headerSignature } = await import("../src/services/import-intelligence.service.js");
const money = (value) => {
  try {
    return robust.parseFlexibleMoneyMinor(value);
  } catch (error) {
    return `refused: ${error.message}`;
  }
};
check("IN32: Excel's Accounting zero (\" - \", \"-\", \"--\") is 0 paise", money(" - ") === 0 && money("-") === 0 && money("--") === 0);
check("IN32: an amount in Devanagari digits, with रु., reads", money("रु. ४,१२,३८०.००") === 41238000 && money("₹ ४,१२,३८०") === 41238000);
check("IN32: a formula's float tail is the two-decimal amount it stands for", money("1234.5600000001") === 123456 && money("99.98999999999") === 9999);
check("IN32: a real third decimal is still refused", /at most two fraction digits/.test(String(money("10.505"))));
check("IN32: Excel's scientific notation is refused, saying it lost digits", /scientific notation/.test(String(money("1.23457E+11"))));
check("IN32: Dr and Cr, brackets and the Indian grouping still read as before", money("1,23,456.00 Dr") === 12345600 && money("1,234.00 Cr") === -123400 && money("(1,234.00)") === -123400);
const day = (value) => robust.parseFlexibleDateIso(value);
check("IN32: a weekday in front, an ordinal day, Devanagari digits and Hindi months are read", day("Tue, 01 Apr 2025") === "2025-04-01" && day("1st Apr 2025") === "2025-04-01" && day("२०/११/२०२६") === "2026-11-20" && day("20 नवंबर 2026") === "2026-11-20" && day("April 1st, 2025") === "2025-04-01" && day("Apr 1, 2025") === "2025-04-01");
check("IN32: an Excel serial with a time of day is that day (45383.5 = 2024-04-01)", day("45383.5") === "2024-04-01" && day("45383") === "2024-04-01");
check("IN32: the date-order classifier reads Devanagari digits (२०/११/२०२६ proves day first)", robust.classifyNumericDate("२०/११/२०२६").proves === "DAY_FIRST" && robust.classifyNumericDate("20 नवंबर 2026").shape === "UNAMBIGUOUS");
const tally = robust.buildMappingFromHeaders(["Date", "Particulars", "Voucher Type", "Voucher No.", "Supplier Invoice No.", "Supplier Invoice Date", "GSTIN/UIN", "Taxable Value", "IGST", "CGST", "SGST"], "GST_PURCHASE");
check("IN32: in a Tally register the supplier's invoice number and date beat the voucher's, and GSTIN/UIN maps", tally.invoiceNumber === "Supplier Invoice No." && tally.documentDate === "Supplier Invoice Date" && tally.supplierGstin === "GSTIN/UIN", JSON.stringify(tally));
const hindiHeadings = robust.buildMappingFromHeaders(["दिनांक", "बीजक संख्या", "आपूर्तिकर्ता जीएसटीआईएन", "कर योग्य मूल्य", "आईजीएसटी", "सीजीएसटी", "एसजीएसटी"], "GST_PURCHASE");
check("IN32: Hindi headings map by rule", hindiHeadings.documentDate === "दिनांक" && hindiHeadings.invoiceNumber === "बीजक संख्या" && hindiHeadings.supplierGstin === "आपूर्तिकर्ता जीएसटीआईएन" && hindiHeadings.taxableValue === "कर योग्य मूल्य" && hindiHeadings.igst === "आईजीएसटी", JSON.stringify(hindiHeadings));
const rowKind = (row, headers = ["Date", "Particulars", "GSTIN", "Amount"]) => shape.classifyNonDataRow(row, headers);
check("IN32: totals lines with a qualifier, Hindi totals and page lines are not records", rowKind(["Grand Total (A+B)", "", "", "100"]) === "TOTALS" && rowKind(["Total c/f", "", "", "5"]) === "TOTALS" && rowKind(["कुल", "", "", "9"]) === "TOTALS" && rowKind(["Page 2 of 5"]) === "PAGE_LINE");
check("IN32: a supplier called Total Solutions Pvt Ltd stays a record", rowKind(["Total Solutions Pvt Ltd", "x", "", "5"]) === null);
check("IN32: a repeated Hindi heading row is recognised", rowKind(["दिनांक", "विवरण", "जीएसटीआईएन", "राशि"], ["दिनांक", "विवरण", "जीएसटीआईएन", "राशि"]) === "REPEATED_HEADER");
const scientific = gstNorm.normalizeInvoiceNumber("1.23457E+11");
check("IN32: an invoice number in scientific notation is flagged, not turned into a matching key", scientific.scientific === true && gstNorm.normalizeInvoiceNumber("INV-0457").scientific === false);
check("IN32: invoice keys keep letters of every script and fold digits (बी/१२३ is not 123)", gstNorm.normalizeInvoiceNumber("बी/१२३").normalized !== gstNorm.normalizeInvoiceNumber("123").normalized && gstNorm.normalizeInvoiceNumber("INV/४५७").normalized === "INV457");
const piped = preview.describeImportColumns({ kind: "TRIAL_BALANCE", text: "Acme Ltd|||\nTrial Balance|||\nParticulars|Group|Debit|Credit\nCash|Assets|1,000.00|\nCapital|Liabilities||1,000.00" });
check("IN32: a pipe-delimited file is read with its columns", piped.delimiter === "|" && piped.headers.length === 4, JSON.stringify({ d: piped.delimiter, h: piped.headers }));
const quoted = preview.describeImportColumns({ kind: "TRIAL_BALANCE", text: "Particulars,Group,Debit,Credit\n12\" Pipe Fittings,Stock,500.00,\n\"Shah, Mehta & Co\",Creditors,,500.00" });
check("IN32: a quote inside a value is a character (12\" Pipe), a quoted value keeps its comma", quoted.headers.length === 4 && quoted.sampledRows === 2, JSON.stringify({ h: quoted.headers, rows: quoted.sampledRows }));
check("IN32: a layout's signature ignores no-break spaces, zero-width characters and dash variants", headerSignature(["Invoice\u00a0No", "Tax\u2014Amount"]) === headerSignature(["Invoice No", "Tax-Amount"]) && headerSignature(["Invoice\u200bNo"]) === headerSignature(["InvoiceNo"]));

const failed = checks.filter((c) => !c.pass);
for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.pass || !c.detail ? "" : ` -- ${c.detail}`}`);
console.log(`\nintelligence-language-contract: ${checks.length - failed.length}/${checks.length} passed`);
process.exitCode = failed.length ? 1 : 0;
