// tests/gst-intelligence-route-contract.mjs
//
// W11 IN8-IN12 (2026-10-21): the reconciliation's likely causes, model leftovers and supplier chase pack through
// the real app, against a scratch database and a loopback stand-in for DeepSeek.
//
// Pinned: the routes answer 404 naming `intelligence` while it is off; causes come from rules across runs; another
// firm's run is 404; the leftovers go to the model only with the firm opted in and consent given, carry no GSTIN,
// supplier name or invoice number, and map a cited item back; an item a rule explains is not sent; the chase
// pack leaves out what is already in a later 2B; a chase message is drafted once per mix of problems from no
// identifying data, filled by the server, labelled NOT SENT, and falls back to the template when the model's
// wording misses a required slot; and nothing any of this does changes a reconciliation item.
//
// Run: MONGODB_URI=mongodb://127.0.0.1:27117/scratch-gst-intelligence node tests/gst-intelligence-route-contract.mjs

const uri = process.env.MONGODB_URI || "";
const scratch = /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(uri) && /scratch/i.test((uri.split("/").pop() || "").split("?")[0]);

if (!scratch) {
  console.error("Refusing to run: MONGODB_URI must be loopback and scratch-marked.");
  process.exitCode = 2;
} else {
  process.exitCode = await runSuite();
}

async function runSuite() {
  const checks = [];
  const check = (name, pass, detail = "") => checks.push({ name, pass: Boolean(pass), detail });

  process.env.NODE_ENV = "production";
  process.env.JWT_SECRET = process.env.JWT_SECRET || "scratch-only-secret-not-a-real-credential-0000";
  process.env.DEEPSEEK_API_KEY = "";
  process.env.OCR_SPACE_API_KEY = "";
  const { ensureMockDeepSeek } = await import("./lib/mock-deepseek.mjs");
  const mock = await ensureMockDeepSeek();
  const mongoose = (await import("mongoose")).default;
  const jwt = (await import("jsonwebtoken")).default;
  const { default: app } = await import("../src/app.js");
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
  await mongoose.connection.dropDatabase();
  const { ensureRequiredIndexes } = await import("../src/services/index-provisioning.service.js");
  await ensureRequiredIndexes();
  for (const name of ["AiDraft", "AiSuggestionOutcome"]) await (await import(`../src/models/${name}.js`)).default.syncIndexes();

  const raw = (name) => mongoose.connection.collection(name);
  const oid = () => new mongoose.Types.ObjectId();
  const now = new Date();

  async function buildFirm(label) {
    const ownerId = oid();
    const firmId = oid();
    await raw("users").insertOne({ _id: ownerId, email: `owner-${label}@scratch.test`, name: `Owner ${label}`, role: "FIRM_ADMIN", accountType: "FIRM_USER", isActive: true, tokenVersion: 0, firmId, createdAt: now, updatedAt: now });
    await raw("firms").insertOne({ _id: firmId, displayName: `Sharma & Co ${label}`, handle: `scratch-gsti-${label.toLowerCase()}`, ownerUserId: ownerId, kind: "SHARED", isActive: true, joinCode: `JGI${label}${Date.now()}`.slice(0, 16), createdAt: now, updatedAt: now });
    await raw("firmmemberships").insertOne({ _id: oid(), firmId, userId: ownerId, status: "ACTIVE", role: "OWNER", memberAccess: "FULL", createdAt: now, updatedAt: now });
    const token = jwt.sign({ id: ownerId, email: `owner-${label}@scratch.test`, role: "FIRM_ADMIN", accountType: "FIRM_USER", firmId, isActive: true, tv: 0 }, process.env.JWT_SECRET, { expiresIn: "30m" });
    return { ownerId, firmId, token };
  }
  const A = await buildFirm("A");
  const B = await buildFirm("B");
  const clientId = oid();
  await raw("clients").insertOne({ _id: clientId, firmId: A.firmId, name: "Evergreen Textiles", isActive: true, createdAt: now, updatedAt: now });
  await raw("appconfigs").insertOne({ _id: "singleton", featureFlags: { gstReconciliation: true, intelligence: false }, createdAt: now, updatedAt: now });
  const SUPPLIER = "27AAPFU0939F1ZV";
  const SUPPLIER_TYPO = "27AAPFU0939F1ZW";
  const OTHER = "24AABCU9603R1ZM";
  await raw("partymasters").insertOne({ _id: oid(), firmId: A.firmId, clientId, gstin: OTHER, name: "Kothari Yarns", gstStatus: "UNKNOWN", createdAt: now, updatedAt: now });

  const money = (taxable, igst = 0, cgst = 0, sgst = 0) => ({ taxableValueMinor: taxable, igstMinor: igst, cgstMinor: cgst, sgstMinor: sgst, cessMinor: 0, totalTaxMinor: igst + cgst + sgst });
  const zero = money(0);
  async function seedRun(period) {
    const runId = oid();
    await raw("reconciliationruns").insertOne({ _id: runId, firmId: A.firmId, clientId, kind: "GST_ITC", gstin: "27AAACE1234F1Z5", period, sourceFingerprint: `fp-${period}`, status: "REVIEW", activeGenerationAttempt: 1, createdAt: now, updatedAt: now });
    return runId;
  }
  let key = 0;
  async function seedItem(runId, fields) {
    const doc = {
      _id: oid(), firmId: A.firmId, runId, clientId, generationAttempt: 1, itemKey: `k${key++}`, isActive: true,
      booksRowId: fields.books ? oid() : null, portalRowId: fields.portal ? oid() : null, candidatePortalRowIds: [],
      supplierGstin: fields.gstin || SUPPLIER, invoiceNumberOriginal: fields.number, invoiceNumberNormalized: fields.number.toUpperCase().replace(/[^A-Z0-9]/g, ""),
      documentType: "INVOICE", documentDate: fields.date || "2026-07-10", booksAmounts: fields.books || zero, portalAmounts: fields.portal || zero,
      differences: zero, dateDifferenceDays: fields.days ?? null, status: fields.status, originalStatus: fields.status, matchRule: "NONE",
      resolutionState: "OPEN", chase: { required: false, state: "NONE", lastActionAt: null }, createdAt: now, updatedAt: now,
    };
    await raw("reconciliationitems").insertOne(doc);
    return doc;
  }
  const july = await seedRun("2026-07");
  const august = await seedRun("2026-08");
  const late = await seedItem(july, { status: "MISSING_IN_2B", number: "INV/101/26-27", books: money(1000000, 180000) });
  await seedItem(august, { status: "MISSING_IN_BOOKS", number: "INV/101/26-27", portal: money(1000000, 180000) });
  const swap = await seedItem(july, { status: "TAX_AMOUNT_MISMATCH", number: "INV-202", books: money(3600000, 648000), portal: money(3600000, 0, 324000, 324000) });
  const typoBooks = await seedItem(july, { status: "MISSING_IN_2B", gstin: SUPPLIER_TYPO, number: "INV-303", books: money(840000, 0, 75600, 75600) });
  await seedItem(july, { status: "MISSING_IN_BOOKS", gstin: SUPPLIER, number: "INV-303", portal: money(840000, 0, 75600, 75600) });
  const leftover = await seedItem(july, { status: "MISSING_IN_2B", gstin: OTHER, number: "KY/2231", books: money(1680000, 302400) });
  const leftover2 = await seedItem(july, { status: "MISSING_IN_2B", gstin: OTHER, number: "KY/2232", books: money(50000, 9000) });
  await seedItem(july, { status: "MATCHED", gstin: OTHER, number: "KY/2213", books: money(840000, 151200), portal: money(840000, 151200) });
  // R2 must look only at this firm's runs for this client's same registration: the same invoice in another firm's
  // run, or in this client's run for another GSTIN, is no reason.
  const october = await seedRun("2026-10");
  const isolated = await seedItem(october, { status: "MISSING_IN_2B", number: "INV-909", books: money(500000, 90000) });
  for (const [firmId, gstin] of [[B.firmId, "27AAACE1234F1Z5"], [A.firmId, "29AAACE1234F1Z1"]]) {
    const otherRun = oid();
    await raw("reconciliationruns").insertOne({ _id: otherRun, firmId, clientId, kind: "GST_ITC", gstin, period: "2026-11", sourceFingerprint: `fp-iso-${gstin}`, status: "REVIEW", activeGenerationAttempt: 1, createdAt: now, updatedAt: now });
    await raw("reconciliationitems").insertOne({ ...isolated, _id: oid(), firmId, runId: otherRun, itemKey: `k${key++}`, booksRowId: null, portalRowId: oid(), booksAmounts: zero, portalAmounts: money(500000, 90000), status: "MISSING_IN_BOOKS", originalStatus: "MISSING_IN_BOOKS" });
  }

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, token, body) => {
    const response = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, json: await response.json().catch(() => null) };
  };
  const itemsSnapshot = async () => JSON.stringify(await raw("reconciliationitems").find({}).sort({ _id: 1 }).toArray());
  const before = await itemsSnapshot();

  try {
    const off = await call("GET", `/api/gst-reconciliation/runs/${july}/causes`, A.token);
    check("with intelligence off the causes route answers 404 naming the flag", off.status === 404 && off.json?.featureFlag === "intelligence", `status ${off.status}`);
    await raw("appconfigs").updateOne({ _id: "singleton" }, { $set: { "featureFlags.intelligence": true } });

    const causes = await call("GET", `/api/gst-reconciliation/runs/${july}/causes`, A.token);
    const byItem = new Map((causes.json?.causes || []).map((entry) => [entry.itemId, entry]));
    check("causes: the late invoice is linked to August's 2B (R2), defer", byItem.get(String(late._id))?.ruleId === "R2" && byItem.get(String(late._id)).relatedRun?.period === "2026-08", JSON.stringify(byItem.get(String(late._id))));
    check("causes: the tax-head swap is named (R4)", byItem.get(String(swap._id))?.ruleId === "R4");
    check("causes: the GSTIN typo pair is named (R1) with a books correction", byItem.get(String(typoBooks._id))?.ruleId === "R1" && byItem.get(String(typoBooks._id)).suggestedDisposition === "BOOKS_CORRECTION");
    check("causes: an item no rule explains is listed as unexplained, with no earlier draft", (causes.json?.unexplained || []).some((entry) => entry.itemId === String(leftover._id) && entry.draft === null));
    check("causes: counts are reported and nothing was truncated", causes.json?.counts?.explained === 4 && causes.json.truncated === false, JSON.stringify(causes.json?.counts));
    const foreign = await call("GET", `/api/gst-reconciliation/runs/${july}/causes`, B.token);
    check("another firm's run is 404", foreign.status === 404, `status ${foreign.status}`);
    const octCauses = await call("GET", `/api/gst-reconciliation/runs/${october}/causes`, A.token);
    const isolatedCause = (octCauses.json?.causes || []).find((entry) => entry.itemId === String(isolated._id));
    check("R2 never links another firm's run or the client's run for another GSTIN", octCauses.status === 200 && isolatedCause?.ruleId !== "R2" && !isolatedCause?.relatedRun, JSON.stringify(isolatedCause));

    // ─── leftovers to the model ───
    mock.reset();
    mock.on(() => JSON.stringify({ items: [
      { id: String(leftover._id), cause: "DUPLICATE_IN_BOOKS", suggestedDisposition: "BOOKS_CORRECTION", reason: "The books amount is twice a matched invoice of the same supplier on the same day.", factsUsed: ["books", "sameSupplier"], relatedRef: "n2" },
    ] }));
    const notOpted = await call("POST", `/api/gst-reconciliation/runs/${july}/causes/residue`, A.token, { itemIds: [String(leftover._id)], consent: true });
    check("leftovers: refused 403 until the firm opts in, nothing sent", notOpted.status === 403 && notOpted.json?.code === "AI_DRAFTING_OFF_FOR_FIRM" && mock.calls.length === 0, `status ${notOpted.status}`);
    await raw("firms").updateOne({ _id: A.firmId }, { $set: { aiDrafting: { enabled: true, changedBy: A.ownerId, changedAt: now } } });
    const noConsent = await call("POST", `/api/gst-reconciliation/runs/${july}/causes/residue`, A.token, { itemIds: [String(leftover._id)] });
    check("leftovers: refused 400 without consent, nothing sent", noConsent.status === 400 && noConsent.json?.code === "AI_CONSENT_REQUIRED" && mock.calls.length === 0);
    const residue = await call("POST", `/api/gst-reconciliation/runs/${july}/causes/residue`, A.token, { itemIds: [String(leftover._id), String(swap._id)], consent: true });
    const drafted = residue.json?.drafts?.[0];
    check("leftovers: the unexplained item comes back as a DRAFT FOR REVIEW cause", residue.status === 200 && drafted?.itemId === String(leftover._id) && drafted.draft.label === "DRAFT FOR REVIEW" && drafted.draft.output.cause === "DUPLICATE_IN_BOOKS", JSON.stringify(residue.json));
    check("leftovers: an item a rule explains is skipped, not sent", residue.json?.skipped?.some((entry) => entry.itemId === String(swap._id)) && !JSON.stringify(mock.calls[0]?.body || {}).includes(String(swap._id)));
    const outbound = JSON.stringify(mock.calls[0]?.body || {});
    check("leftovers: the outbound body carries no GSTIN, supplier name or invoice number", !outbound.includes(OTHER) && !outbound.includes("Kothari") && !outbound.includes("KY/2231") && !outbound.includes("Evergreen"), outbound.slice(0, 300));
    check("leftovers: the cited item ref comes back as that item's id", typeof drafted?.draft?.relatedItemId === "string" && drafted.draft.relatedItemId.length === 24);
    const again = await call("GET", `/api/gst-reconciliation/runs/${july}/causes`, A.token);
    check("causes: the stored draft is shown with its unexplained item afterwards", (again.json?.unexplained || []).find((entry) => entry.itemId === String(leftover._id))?.draft?.output?.cause === "DUPLICATE_IN_BOOKS");

    // ─── chase pack ───
    const pack = await call("GET", `/api/gst-reconciliation/runs/${july}/chase-pack`, A.token);
    const suppliers = pack.json?.suppliers || [];
    const kothari = suppliers.find((group) => group.supplierGstin === OTHER);
    check("chase pack: the supplier with missing invoices is listed with its name and ITC at stake in paise", kothari?.supplierName === "Kothari Yarns" && kothari.itcAtStakeMinor === 302400 + 9000 && kothari.invoices.length === 2, JSON.stringify(kothari));
    check("chase pack: an invoice already in a later 2B and a GSTIN typo are not chased", pack.json?.notChased?.some((entry) => entry.itemId === String(late._id)) && pack.json.notChased.some((entry) => entry.itemId === String(typoBooks._id)));
    const foreignPack = await call("GET", `/api/gst-reconciliation/runs/${july}/chase-pack`, B.token);
    const foreignDraft = await call("POST", `/api/gst-reconciliation/runs/${july}/chase-pack/draft`, B.token, { language: "en", channel: "email", useTemplate: true });
    check("chase pack: another firm's run is 404, for the pack and its drafts", foreignPack.status === 404 && foreignDraft.status === 404, `${foreignPack.status} ${foreignDraft.status}`);
    check("chase pack: largest ITC at stake first", suppliers.length >= 1 && suppliers.every((group, i) => i === 0 || suppliers[i - 1].itcAtStakeMinor >= group.itcAtStakeMinor));

    const template = await call("POST", `/api/gst-reconciliation/runs/${july}/chase-pack/draft`, A.token, { language: "en", channel: "email", useTemplate: true });
    const tmsg = template.json?.messages?.find((m) => m.supplierGstin === OTHER);
    check("chase draft (template): filled by the server with the supplier, client, invoices and amount, labelled NOT SENT", template.json?.source === "TEMPLATE" && /Kothari Yarns/.test(tmsg?.message) && /KY\/2231/.test(tmsg.message) && /Evergreen Textiles/.test(tmsg.message) && /₹3,114/.test(tmsg.message) && tmsg.label === "DRAFT FOR REVIEW - NOT SENT" && !/\{\{/.test(tmsg.message), tmsg?.message);

    // ─── IN33: languages ───
    const languages = pack.json?.languages || [];
    check("IN33: the pack lists 13 languages, each with a label and whether a fixed template exists", languages.length === 13 && languages.find((l) => l.code === "hi")?.template === true && languages.find((l) => l.code === "ta")?.template === false && languages.every((l) => l.label), JSON.stringify(languages.map((l) => l.code)));
    const hindiTemplate = await call("POST", `/api/gst-reconciliation/runs/${july}/chase-pack/draft`, A.token, { language: "hi", channel: "whatsapp", useTemplate: true });
    const hmsg = hindiTemplate.json?.messages?.find((m) => m.supplierGstin === OTHER);
    check("IN33: Hindi gets the Hindi template, filled, and says it is Hindi", hmsg?.language === "hi" && /प्रिय Kothari Yarns/.test(hmsg.message) && /KY\/2231/.test(hmsg.message) && !/\{\{/.test(hmsg.message), hmsg?.message);
    const marathiTemplate = await call("POST", `/api/gst-reconciliation/runs/${july}/chase-pack/draft`, A.token, { language: "mr", channel: "email", useTemplate: true });
    const mmsg = marathiTemplate.json?.messages?.find((m) => m.supplierGstin === OTHER);
    check("IN33: Marathi has no fixed template yet: the English one is used, and the message and note say so", mmsg?.language === "en" && /^Dear Kothari Yarns/.test(mmsg.message) && /no fixed template in Marathi/.test(marathiTemplate.json?.note || ""), JSON.stringify({ language: mmsg?.language, note: marathiTemplate.json?.note }));
    const unknownLanguage = await call("POST", `/api/gst-reconciliation/runs/${july}/chase-pack/draft`, A.token, { language: "xx", channel: "email", useTemplate: true });
    check("IN33: a language CA PRO does not draft in is refused 400", unknownLanguage.status === 400);

    mock.reset();
    // The stand-in answers every mix the request asks for (one unit per mix of problems).
    const askedIds = (body) => [...String(body?.messages?.[1]?.content || "").matchAll(/"id":"(mix-[01]{3})"/g)].map((m) => m[1]);
    mock.on((body) => JSON.stringify({ items: askedIds(body).map((id) => ({ id, subject: "", message: "Namaste {{supplier}} ji, {{client}} ke records mein ye invoices abhi GSTR-2B mein nahi dikh rahe:\n{{invoiceTable}}\nKripya GSTR-1 file karke batayein. - {{sender}}" })) }));
    const drafted1 = await call("POST", `/api/gst-reconciliation/runs/${july}/chase-pack/draft`, A.token, { language: "hinglish", channel: "whatsapp", consent: true });
    const msg = drafted1.json?.messages?.find((m) => m.supplierGstin === OTHER);
    const chaseOut = JSON.stringify(mock.calls[0]?.body || {});
    check("chase draft (model): the message is the model's wording, filled by the server", drafted1.json?.source === "MODEL" && msg?.source === "MODEL" && /Namaste Kothari Yarns ji/.test(msg.message) && /KY\/2232/.test(msg.message) && /Sharma & Co A/.test(msg.message), JSON.stringify(drafted1.json));
    check("chase draft (model): the model saw no name, invoice number or amount", !chaseOut.includes("Kothari") && !chaseOut.includes("KY/2231") && !chaseOut.includes("302400") && !chaseOut.includes("Evergreen") && /Hinglish/.test(chaseOut), chaseOut.slice(0, 300));
    const callsAfterFirst = mock.calls.length;
    await call("POST", `/api/gst-reconciliation/runs/${july}/chase-pack/draft`, A.token, { language: "hinglish", channel: "whatsapp", consent: true });
    check("chase draft (model): the same mix again is answered from the stored draft, no second call", mock.calls.length === callsAfterFirst, `${mock.calls.length} vs ${callsAfterFirst}`);
    mock.on((body) => JSON.stringify({ items: askedIds(body).map((id) => ({ id, subject: "Pending invoices", message: "Dear {{supplier}}, please file your returns." })) }));
    const noTable = await call("POST", `/api/gst-reconciliation/runs/${july}/chase-pack/draft`, A.token, { language: "en", channel: "email", consent: true });
    check("chase draft (model): wording without the invoice table is refused and the template is used", noTable.json?.messages?.every((m) => m.source === "TEMPLATE") && /KY\/2231/.test(noTable.json.messages.find((m) => m.supplierGstin === OTHER)?.message || ""), JSON.stringify(noTable.json?.messages?.map((m) => m.source)));

    // ─── nothing changed ───
    check("nothing any of these routes did changed a reconciliation item", (await itemsSnapshot()) === before);
  } finally {
    mock.off();
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase().catch(() => {});
    await mongoose.disconnect();
  }

  const failed = checks.filter((c) => !c.pass);
  for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.pass || !c.detail ? "" : ` -- ${c.detail}`}`);
  console.log(`\ngst-intelligence-route-contract: ${checks.length - failed.length}/${checks.length} passed`);
  return failed.length ? 1 : 0;
}
