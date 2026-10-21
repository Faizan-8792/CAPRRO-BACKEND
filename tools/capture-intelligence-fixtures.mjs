// tools/capture-intelligence-fixtures.mjs
//
// W11 (2026-10-21): captures the real responses of every intelligence route, from the real app against a scratch
// database and the loopback DeepSeek stand-in, into the Windows app's test fixtures - so the desktop's readers are
// tested on what the server actually sends, fields it does not use included (CLAUDE.md section 9), and a renamed
// server field fails a desktop test instead of emptying a screen.
//
//   MONGODB_URI=mongodb://127.0.0.1:27117/scratch-capture-intel node tools/capture-intelligence-fixtures.mjs
//
// Writes apps/desktop-native/tests/CaPro.Desktop.Core.Tests/Fixtures/intelligence/*.json. Ends with exitCode.

import { mkdirSync, writeFileSync } from "node:fs";

const uri = process.env.MONGODB_URI || "";
const scratch = /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(uri) && /scratch/i.test((uri.split("/").pop() || "").split("?")[0]);
if (!scratch) {
  console.error("Refusing to run: MONGODB_URI must be loopback and scratch-marked.");
  process.exitCode = 2;
} else {
  process.exitCode = await capture();
}

async function capture() {
  process.env.NODE_ENV = "production";
  process.env.JWT_SECRET = process.env.JWT_SECRET || "scratch-only-secret-not-a-real-credential-0000";
  process.env.DEEPSEEK_API_KEY = "";
  const { ensureMockDeepSeek } = await import("../tests/lib/mock-deepseek.mjs");
  const mock = await ensureMockDeepSeek();
  const mongoose = (await import("mongoose")).default;
  const jwt = (await import("jsonwebtoken")).default;
  const { default: app } = await import("../src/app.js");
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
  await mongoose.connection.dropDatabase();
  const { ensureRequiredIndexes } = await import("../src/services/index-provisioning.service.js");
  await ensureRequiredIndexes();
  const raw = (name) => mongoose.connection.collection(name);
  const oid = () => new mongoose.Types.ObjectId();
  const now = new Date();
  const ownerId = oid();
  const firmId = oid();
  const clientId = oid();
  await raw("users").insertOne({ _id: ownerId, email: "owner-capture@scratch.test", name: "Owner", role: "FIRM_ADMIN", accountType: "FIRM_USER", isActive: true, tokenVersion: 0, firmId, createdAt: now, updatedAt: now });
  await raw("firms").insertOne({ _id: firmId, displayName: "Sharma & Co", handle: "scratch-capture", ownerUserId: ownerId, kind: "SHARED", isActive: true, joinCode: `JCP${Date.now()}`.slice(0, 16), createdAt: now, updatedAt: now });
  await raw("firmmemberships").insertOne({ _id: oid(), firmId, userId: ownerId, status: "ACTIVE", role: "OWNER", memberAccess: "FULL", createdAt: now, updatedAt: now });
  await raw("clients").insertOne({ _id: clientId, firmId, name: "Evergreen Textiles", isActive: true, createdAt: now, updatedAt: now });
  await raw("appconfigs").insertOne({ _id: "singleton", featureFlags: { gstReconciliation: true, tdsHealth: true, noticeCases: true, auditPacks: true, intelligence: true }, noticeCatalogue: { version: 1, publishedAt: now, entries: [{ form: "GST_ASMT10", windowDays: 30, basis: "ISSUE_DATE", sourceReference: "Rule 99(2)" }], actTransition: { effectiveFrom: "", before: "", after: "", sourceReference: "" } }, createdAt: now, updatedAt: now });
  const token = jwt.sign({ id: ownerId, email: "owner-capture@scratch.test", role: "FIRM_ADMIN", accountType: "FIRM_USER", firmId, isActive: true, tv: 0 }, process.env.JWT_SECRET, { expiresIn: "30m" });

  // A reconciliation in two months.
  const money = (taxable, igst = 0, cgst = 0, sgst = 0) => ({ taxableValueMinor: taxable, igstMinor: igst, cgstMinor: cgst, sgstMinor: sgst, cessMinor: 0, totalTaxMinor: igst + cgst + sgst });
  const zero = money(0);
  const run = async (period) => {
    const id = oid();
    await raw("reconciliationruns").insertOne({ _id: id, firmId, clientId, kind: "GST_ITC", gstin: "27AAACE1234F1Z5", period, sourceFingerprint: `fp-${period}`, status: "REVIEW", activeGenerationAttempt: 1, createdAt: now, updatedAt: now });
    return id;
  };
  let n = 0;
  const item = async (runId, f) => {
    const doc = { _id: oid(), firmId, runId, clientId, generationAttempt: 1, itemKey: `k${n++}`, isActive: true, booksRowId: f.books ? oid() : null, portalRowId: f.portal ? oid() : null, candidatePortalRowIds: [], supplierGstin: f.gstin || "27AAPFU0939F1ZV", invoiceNumberOriginal: f.number, invoiceNumberNormalized: f.number.toUpperCase().replace(/[^A-Z0-9]/g, ""), documentType: "INVOICE", documentDate: "2026-07-10", booksAmounts: f.books || zero, portalAmounts: f.portal || zero, differences: zero, dateDifferenceDays: null, status: f.status, originalStatus: f.status, matchRule: "NONE", resolutionState: "OPEN", chase: { required: false, state: "NONE", lastActionAt: null }, createdAt: now, updatedAt: now };
    await raw("reconciliationitems").insertOne(doc);
    return doc;
  };
  const july = await run("2026-07");
  const august = await run("2026-08");
  await item(july, { status: "MISSING_IN_2B", number: "INV/101/26-27", books: money(1000000, 180000) });
  await item(august, { status: "MISSING_IN_BOOKS", number: "INV/101/26-27", portal: money(1000000, 180000) });
  await item(july, { status: "TAX_AMOUNT_MISMATCH", number: "INV-202", books: money(3600000, 648000), portal: money(3600000, 0, 324000, 324000) });
  const leftover = await item(july, { status: "MISSING_IN_2B", gstin: "24AABCU9603R1ZM", number: "KY/2231", books: money(1680000, 302400) });
  await item(july, { status: "MATCHED", gstin: "24AABCU9603R1ZM", number: "KY/2213", books: money(840000, 151200), portal: money(840000, 151200) });

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return response.json();
  };
  const out = new URL("../../apps/desktop-native/tests/CaPro.Desktop.Core.Tests/Fixtures/intelligence/", import.meta.url);
  mkdirSync(out, { recursive: true });
  const save = (name, body) => writeFileSync(new URL(`${name}.json`, out), `${JSON.stringify(body, null, 2)}\n`);
  try {
    save("settings-before-opt-in", await call("GET", "/api/ai-drafts/settings"));
    save("settings-opt-in", await call("PUT", "/api/ai-drafts/settings", { enabled: true }));
    save("settings", await call("GET", "/api/ai-drafts/settings"));
    save("gst-causes", await call("GET", `/api/gst-reconciliation/runs/${july}/causes`));
    mock.on((body) => {
      const ids = [...String(body.messages[1].content).matchAll(/"id":"([a-f0-9]{24})"/g)].map((m) => m[1]);
      return JSON.stringify({ items: ids.map((id) => ({ id, cause: "DUPLICATE_IN_BOOKS", suggestedDisposition: "BOOKS_CORRECTION", reason: "The books amount is twice a matched invoice of the same supplier on the same day.", factsUsed: ["books", "sameSupplier"], relatedRef: "n1" })) });
    });
    save("gst-residue", await call("POST", `/api/gst-reconciliation/runs/${july}/causes/residue`, { itemIds: [String(leftover._id)], consent: true }));
    save("gst-chase-pack", await call("GET", `/api/gst-reconciliation/runs/${july}/chase-pack`));
    mock.on((body) => {
      const ids = [...String(body.messages[1].content).matchAll(/"id":"(mix-[01]{3})"/g)].map((m) => m[1]);
      return JSON.stringify({ items: ids.map((id) => ({ id, subject: "", message: "Namaste {{supplier}} ji, ye invoices abhi GSTR-2B mein nahi dikh rahe:\n{{invoiceTable}}\nKripya GSTR-1 file karein. - {{sender}}" })) });
    });
    save("gst-chase-draft", await call("POST", `/api/gst-reconciliation/runs/${july}/chase-pack/draft`, { language: "hinglish", channel: "whatsapp", consent: true }));
    save("gst-chase-template", await call("POST", `/api/gst-reconciliation/runs/${july}/chase-pack/draft`, { language: "en", channel: "email", useTemplate: true }));
    const tb = ["ABC Traders Pvt Ltd,,", "Trial Balance,,", "Acct Head,Closing Dr,Closing Cr", "Capital Account,,\"25,00,000.00\"", "Purchase of Goods,\"25,00,000.00\","].join("\n");
    save("import-suggest-headings", await call("POST", "/api/imports/suggest-mapping", { kind: "TRIAL_BALANCE", text: tb, clientId: String(clientId) }));
    mock.on((body) => {
      const input = JSON.parse(String(body.messages[1].content).split("INPUT (json):\n")[1]);
      const ref = input.items[0].headings.find((h) => h.text === "Acct Head")?.ref;
      return JSON.stringify({ items: [{ id: "file", mappings: [{ field: "ledgerName", headingRef: ref }] }] });
    });
    save("import-model-suggestion", await call("POST", "/api/imports/mapping-suggestions", { kind: "TRIAL_BALANCE", text: tb, consent: true }));
    // A remembered layout: one person-confirmed mapping saved through the service, then the same file again.
    const { rememberConfirmedMapping } = await import("../src/services/import-intelligence.service.js");
    await rememberConfirmedMapping({ firmId, userId: ownerId, clientId: String(clientId), kind: "TRIAL_BALANCE", text: tb, delimiter: null, mapping: { ledgerName: "Acct Head", closingDebit: "Closing Dr", closingCredit: "Closing Cr" } });
    save("import-suggest-remembered", await call("POST", "/api/imports/suggest-mapping", { kind: "TRIAL_BALANCE", text: tb, clientId: String(clientId) }));

    // A case with an ASMT-10.
    const caseId = oid();
    await raw("casematters").insertOne({ _id: caseId, firmId, clientId, caseType: "GST_SCRUTINY", title: "ASMT-10 for FY 2024-25", status: "OPEN", priority: "HIGH", revision: 1, ownerUserId: ownerId, source: { extractedText: "FORM GST ASMT-10\nReference No.: ZD2710260012345    Date: 21/10/2026\nTax Period: April 2024 - March 2025\nunder section 61 of the Central Goods and Services Tax Act, 2017\nTotal amount payable: Rs. 4,12,380/-\nYou are directed to explain the discrepancies on or before 20-11-2026." }, extractionProposals: [{ _id: oid(), field: "responseDueDate", value: "2026-11-21", sourceText: "on or before 20-11-2026", confidence: 0.8, provider: "DEEPSEEK", model: "deepseek-flash", proposedAt: now }], confirmedFacts: { requestedDocuments: ["Purchase register for FY 2024-25"], responseDueDate: new Date("2026-11-20T00:00:00Z"), noticeType: "FORM GST ASMT-10", demandMinor: 41238000 }, createdAt: now, updatedAt: now });
    save("case-rule-reading", await call("GET", `/api/cases/${caseId}/rule-reading`));
    save("case-document-task", await call("POST", `/api/cases/${caseId}/document-requests`, {}));
    await raw("tasks").insertOne({ _id: oid(), firmId, title: "GSTR-3B Sep 2026", clientName: "Evergreen Textiles", dueDateISO: new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10), status: "WAITING_DOCS", isActive: true, assignedTo: ownerId, createdAt: now, updatedAt: now });
    save("priorities", await call("GET", "/api/home/priorities"));
    console.log("captured into", out.pathname);
    return 0;
  } finally {
    mock.off();
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase().catch(() => {});
    await mongoose.disconnect();
  }
}
