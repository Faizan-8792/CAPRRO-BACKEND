// tests/notice-rules-contract.mjs
//
// W11 IN19-IN21 (2026-10-21): the notice rule reader, the notice catalogue's checks and the case routes that use
// them. The rule-reader and catalogue part is pure; the route part needs MONGODB_URI (scratch, loopback) and is
// skipped, not passed, without it.
//
// Pinned: every recogniser reads two synthetic notices of its form - written in different date and amount styles -
// to the expected form, dates (YYYY-MM-DD, day first), amounts (paise) and section; every proposal's source text is
// an exact excerpt; a date that is not a real date is not proposed; a notice of another form is not read as this
// one. The catalogue refuses a form it does not know, a window out of range and an entry with no source; the
// reply-window check never changes the stated date and computes in UTC days; the Act rule names the Act only from
// a published rule. The routes answer 404 naming `intelligence` while it is off, read a case's notice without a
// model, flag a model value that disagrees, and turn confirmed documents into one task, once.
//
// Run: node tests/notice-rules-contract.mjs   (add MONGODB_URI=mongodb://127.0.0.1:27117/scratch-notice-rules for the routes)

import { NOTICE_RECOGNISERS, readNoticeByRules, readDay, readRupeesToPaise } from "../src/services/notice-rules/index.js";
import { actForPeriod, periodStartDay, replyWindowCheck, validateNoticeCatalogue } from "../src/services/notice-catalogue.service.js";

const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass: Boolean(pass), detail });

const NOTICES = [
  { form: "GST_DRC01C", text: "FORM GST DRC-01C\n[See rule 88D]\nReference No.: ZD2709260001234 Date: 05/09/2026\nGSTIN: 27AAACE1234F1Z5\nTax Period: July 2026\nIntimation of difference between input tax credit available in GSTR-2B and claimed in GSTR-3B under section 39 of the Central Goods and Services Tax Act, 2017.\nAmount of difference: Rs. 3,24,500\nYou are requested to pay the amount or explain the difference on or before 12/09/2026.", expect: { issueDate: "2026-09-05", responseDueDate: "2026-09-12", demandMinor: "32450000", period: "July 2026" } },
  { form: "GST_DRC01C", text: "Form GST DRC - 01C\nDated: 3rd March, 2027\nTax Period: January 2027\nThe input tax credit availed in FORM GSTR-3B exceeds the credit in FORM GSTR-2B by INR 1,12,000.00 (Amount of difference: INR 1,12,000.00).\nReply latest by 10-Mar-2027 in Part B.", expect: { issueDate: "2027-03-03", responseDueDate: "2027-03-10", demandMinor: "11200000" } },
  { form: "GST_DRC01A", text: "FORM GST DRC-01A\nIntimation of tax ascertained as being payable under section 73(5)\nDate of issue: 14/08/2026\nFinancial Year: 2023-24\nTotal amount payable: Rs. 2,10,450/-\nYou may make the payment or file your submissions not later than 13/09/2026.", expect: { issueDate: "2026-08-14", responseDueDate: "2026-09-13", financialYear: "2023-24", demandMinor: "21045000", sectionReference: "Section 73(5)" } },
  { form: "GST_DRC01A", text: "Form GST DRC-01A (Part A)\nDated 2nd February 2027\nF.Y. 2022-23\nunder section 74A of the Central Goods and Services Tax Act, 2017\nDemand of ₹ 75,000\nSubmit your reply on or before 04.03.2027.", expect: { issueDate: "2027-02-02", responseDueDate: "2027-03-04", financialYear: "2022-23", demandMinor: "7500000", sectionReference: "Section 74A of the Central Goods and Services Tax Act, 2017" } },
  { form: "GST_DRC01", text: "FORM GST DRC-01\nSummary of the show cause notice\nDIN: 20260931ZZ0000123456\nDate of notice: 30/09/2026\nunder section 73 of the CGST Act, 2017\nFinancial Year 2021-22\nTotal demand: Rs. 8,40,000\nYou are required to file a reply on or before 30/10/2026.\nDate of personal hearing: 05/11/2026", expect: { issueDate: "2026-09-30", responseDueDate: "2026-10-30", hearingDate: "2026-11-05", din: "20260931ZZ0000123456", financialYear: "2021-22", demandMinor: "84000000" } },
  { form: "GST_DRC01", text: "Form GST DRC-01\nDated: 11-Jan-2027\nF.Y.: 2020-21\nThe total demand of ₹ 1,05,00,000 is proposed.\nReply by 10-Feb-2027.\nPersonal hearing on 15-Feb-2027 at 11:00.", expect: { issueDate: "2027-01-11", responseDueDate: "2027-02-10", hearingDate: "2027-02-15", demandMinor: "1050000000", financialYear: "2020-21" } },
  { form: "GST_DRC07", text: "FORM GST DRC-07\nSummary of the order\nDate of order: 20/12/2026\nFinancial Year: 2021-22\nunder section 73(9)\nTotal amount payable: Rs. 6,12,300", expect: { issueDate: "2026-12-20", financialYear: "2021-22", demandMinor: "61230000", sectionReference: "Section 73(9)" } },
  { form: "GST_DRC07", text: "Form GST DRC - 07\nDated 7th April, 2027\nF.Y. 2022-23\nNet amount payable: INR 45,000", expect: { issueDate: "2027-04-07", financialYear: "2022-23", demandMinor: "4500000" } },
  { form: "GST_ASMT10", text: "FORM GST ASMT-10\n[See rule 99(1)]\nReference No.: ZD2710260012345    Date: 21/10/2026\nTax Period: April 2024 - March 2025\nNotice for intimating discrepancies in the return after scrutiny under section 61 of the Central Goods and Services Tax Act, 2017\nTotal amount payable: Rs. 4,12,380/-\nYou are directed to explain the discrepancies on or before 20-11-2026.", expect: { issueDate: "2026-10-21", responseDueDate: "2026-11-20", demandMinor: "41238000", period: "April 2024 - March 2025", sectionReference: "Section 61 of the Central Goods and Services Tax Act, 2017" } },
  { form: "GST_ASMT10", text: "Form GST ASMT - 10\nDated: 1st June 2027\nTax Period: From April 2025 to March 2026\nPlease furnish your explanation within thirty days, that is by 01/07/2027.", expect: { issueDate: "2027-06-01", responseDueDate: "2027-07-01" } },
  { form: "GST_REG03", text: "FORM GST REG-03\nNotice for seeking additional information relating to application for registration\nReference No.: AA270926000111X Date: 26/09/2026\nPlease submit the information within seven working days, latest by 06/10/2026.", expect: { issueDate: "2026-09-26", responseDueDate: "2026-10-06" } },
  { form: "GST_REG03", text: "Form GST REG - 03\nDated 9th January, 2027\nThe clarification must be submitted by 16-Jan-2027.", expect: { issueDate: "2027-01-09", responseDueDate: "2027-01-16" } },
  { form: "GST_REG17", text: "FORM GST REG-17\nShow cause notice for cancellation of registration\nDate: 02/11/2026\nunder section 29(2)(c)\nReply on or before 09/11/2026.\nDate of personal hearing: 10/11/2026", expect: { issueDate: "2026-11-02", responseDueDate: "2026-11-09", hearingDate: "2026-11-10", sectionReference: "Section 29(2)(c)" } },
  { form: "GST_REG17", text: "Form GST REG-17\nDated: 15-Mar-2027\nYou are directed to submit a reply within seven working days, latest by 24-Mar-2027.", expect: { issueDate: "2027-03-15", responseDueDate: "2027-03-24" } },
  { form: "IT_143_1", text: "INCOME TAX DEPARTMENT\nIntimation under section 143(1) of the Income-tax Act, 1961\nDocument Identification Number (DIN): CPC/2526/A1/123456789\nAssessment Year: 2025-26\nDate of intimation: 18/09/2026\nNet amount payable: Rs. 24,560", expect: { issueDate: "2026-09-18", assessmentYear: "2025-26", demandMinor: "2456000", din: "CPC/2526/A1/123456789", sectionReference: "Section 143(1) of the Income-tax Act, 1961" } },
  { form: "IT_143_1", text: "Intimation u/s 143(1)\nA.Y. 2024-25\nDated: 2nd December, 2026\nTax payable ₹ 1,18,000", expect: { issueDate: "2026-12-02", assessmentYear: "2024-25", demandMinor: "11800000" } },
  { form: "IT_139_9", text: "Communication of defective return under section 139(9)\nAssessment Year: 2025-26\nDIN: ITBA/DFR/S/139(9)/2026-27/1076543210(1)\nDate: 10/10/2026\nYou are requested to remove the defect within 15 days, latest by 25/10/2026.", expect: { issueDate: "2026-10-10", responseDueDate: "2026-10-25", assessmentYear: "2025-26", din: "ITBA/DFR/S/139(9)/2026-27/1076543210(1)" } },
  { form: "IT_139_9", text: "Notice of defect u/s 139(9)\nA.Y.: 2026-27\nDated 5th January, 2027\nRespond by 20-Jan-2027.", expect: { issueDate: "2027-01-05", responseDueDate: "2027-01-20", assessmentYear: "2026-27" } },
  { form: "IT_142_1", text: "Notice under section 142(1) of the Income-tax Act, 1961\nAssessment Year: 2024-25\nDIN: ITBA/AST/F/142(1)/2026-27/1081234567(1)\nDate of notice: 01/11/2026\nPlease furnish the documents listed below on or before 15/11/2026.", expect: { issueDate: "2026-11-01", responseDueDate: "2026-11-15", assessmentYear: "2024-25" } },
  { form: "IT_142_1", text: "Notice u/s 142(1)\nA.Y. 2025-26\nDated: 20-Dec-2026\nSubmit your reply by 03-Jan-2027.", expect: { issueDate: "2026-12-20", responseDueDate: "2027-01-03", assessmentYear: "2025-26" } },
  { form: "IT_148A", text: "Notice under section 148A of the Income-tax Act, 1961\nAssessment Year: 2022-23\nDate of issue: 28/02/2027\nYou may show cause not later than 07/03/2027.", expect: { issueDate: "2027-02-28", responseDueDate: "2027-03-07", assessmentYear: "2022-23" } },
  { form: "IT_148A", text: "Notice u/s 148A(b)\nA.Y. 2021-22\nDated 15th March, 2027\nReply on or before 25.03.2027.", expect: { issueDate: "2027-03-15", responseDueDate: "2027-03-25", assessmentYear: "2021-22" } },
  { form: "IT_133_6", text: "Notice under section 133(6) of the Income-tax Act, 1961\nFinancial Year: 2025-26\nDate: 12/08/2026\nPlease furnish the information on or before 26/08/2026.", expect: { issueDate: "2026-08-12", responseDueDate: "2026-08-26", financialYear: "2025-26" } },
  { form: "IT_133_6", text: "Notice u/s 133(6)\nF.Y. 2024-25\nDated: 3rd September 2026\nRespond by 17-Sep-2026.", expect: { issueDate: "2026-09-03", responseDueDate: "2026-09-17", financialYear: "2024-25" } },
  { form: "IT_245", text: "Intimation under section 245 of the Income-tax Act, 1961\nAssessment Year: 2023-24\nDate: 09/07/2026\nOutstanding demand of Rs. 56,700 is proposed to be adjusted against the refund.\nRespond within 30 days, latest by 08/08/2026.", expect: { issueDate: "2026-07-09", responseDueDate: "2026-08-08", assessmentYear: "2023-24", demandMinor: "5670000" } },
  { form: "IT_245", text: "Intimation u/s 245\nA.Y. 2024-25\nDated 1st October, 2026\nThe demand of ₹ 9,800 will be adjusted.\nReply by 31-Oct-2026.", expect: { issueDate: "2026-10-01", responseDueDate: "2026-10-31", assessmentYear: "2024-25", demandMinor: "980000" } },
];

// ─── the reader ───
for (const recogniser of NOTICE_RECOGNISERS) {
  const own = NOTICES.filter((notice) => notice.form === recogniser.id);
  check(`${recogniser.id}: at least two synthetic notices`, own.length >= 2, String(own.length));
}
NOTICES.forEach((notice, index) => {
  const reading = readNoticeByRules(notice.text);
  const got = Object.fromEntries(reading.proposals.map((proposal) => [proposal.field, proposal.value]));
  const wrong = Object.entries(notice.expect).filter(([field, value]) => got[field] !== value);
  check(`${notice.form} #${index + 1}: the form is recognised`, reading.form?.id === notice.form, JSON.stringify(reading.form));
  check(`${notice.form} #${index + 1}: dates, amounts and references read as stated`, wrong.length === 0, wrong.map(([field, value]) => `${field}: want ${value} got ${got[field]}`).join("; "));
  const collapsed = notice.text.replace(/\s+/g, " ").toLowerCase();
  check(`${notice.form} #${index + 1}: every proposal's source text is an exact excerpt`, reading.proposals.every((proposal) => collapsed.includes(proposal.sourceText.replace(/\s+/g, " ").toLowerCase())));
});
check("a date that is not a real date is not proposed", readNoticeByRules("FORM GST ASMT-10\nDate: 31/02/2026\nReply on or before 30/02/2026.").proposals.every((proposal) => !/Date$/.test(proposal.field)));
check("readDay reads day first and refuses an impossible day", readDay("05/03/2026") === "2026-03-05" && readDay("21st October, 2026") === "2026-10-21" && readDay("31/04/2026") === null);
check("rupees read to paise, with paise and Indian grouping", readRupeesToPaise("Rs. 1,05,00,000") === 1050000000 && readRupeesToPaise("₹ 4,12,380.5") === 41238050 && readRupeesToPaise("no amount") === null);
check("text with no recognised form proposes no form, notice type or authority", (() => {
  const reading = readNoticeByRules("Dear Sir, please find enclosed the documents. Date: 01/01/2027");
  return reading.form === null && !reading.proposals.some((proposal) => proposal.field === "noticeType" || proposal.field === "authority");
})());
check("a DRC-01C is not read as a DRC-01 (more specific forms first)", readNoticeByRules("FORM GST DRC-01C").form?.id === "GST_DRC01C" && readNoticeByRules("FORM GST DRC-01A").form?.id === "GST_DRC01A");

// ─── the catalogue ───
const good = validateNoticeCatalogue({ entries: [{ form: "GST_ASMT10", windowDays: 30, basis: "ISSUE_DATE", sourceReference: "Rule 99(2), CGST Rules" }], actTransition: { effectiveFrom: "2026-04-01", before: "Income-tax Act, 1961", after: "Income-tax Act, 2025", sourceReference: "Income-tax Act, 2025, section 1" } });
check("catalogue: a valid catalogue is accepted", good.ok === true && good.entries.length === 1 && good.actTransition.after === "Income-tax Act, 2025", JSON.stringify(good));
const bad = validateNoticeCatalogue({ entries: [{ form: "GST_XYZ", windowDays: 0, basis: "WHENEVER", sourceReference: "" }, { form: "GST_ASMT10", windowDays: 30, basis: "ISSUE_DATE", sourceReference: "Rule 99" }, { form: "GST_ASMT10", windowDays: 30, basis: "ISSUE_DATE", sourceReference: "Rule 99" }] });
check("catalogue: an unknown form, a zero window, an unknown basis, a missing source and a repeated form are each refused", bad.ok === false && bad.errors.length >= 5, JSON.stringify(bad.errors));
check("catalogue: an Act rule with an impossible date is refused", validateNoticeCatalogue({ entries: [], actTransition: { effectiveFrom: "2026-02-30", before: "Old Act", after: "New Act", sourceReference: "ref" } }).ok === false);
const catalogue = { entries: good.entries, actTransition: good.actTransition };
const consistent = replyWindowCheck({ catalogue, formId: "GST_ASMT10", statedDueDate: "2026-11-20", issueDate: "2026-10-21" });
check("reply window: issue date + 30 days equal to the stated date is consistent", consistent?.consistent === true && consistent.computed === "2026-11-20" && consistent.stated === "2026-11-20");
const differs = replyWindowCheck({ catalogue, formId: "GST_ASMT10", statedDueDate: "2026-11-25", issueDate: "2026-10-21" });
check("reply window: a different stated date is shown beside the computed one, never replaced", differs?.consistent === false && differs.stated === "2026-11-25" && differs.computed === "2026-11-20");
check("reply window: no entry for the form gives nothing to compare", replyWindowCheck({ catalogue, formId: "IT_142_1", statedDueDate: "2026-11-25", issueDate: "2026-10-21" }) === null);
check("reply window: across a month and year end in UTC days", replyWindowCheck({ catalogue, formId: "GST_ASMT10", statedDueDate: "2027-01-30", issueDate: "2026-12-31" })?.computed === "2027-01-30");
check("period start: from a financial year, an assessment year and a written period", periodStartDay({ financialYear: "2025-26" }) === "2025-04-01" && periodStartDay({ assessmentYear: "2026-27" }) === "2025-04-01" && periodStartDay({ period: "April 2026 - March 2027" }) === "2026-04-01");
check("Act rule: a period before the published date falls under the earlier Act, from it under the later", actForPeriod(catalogue, { assessmentYear: "2026-27" })?.act === "Income-tax Act, 1961" && actForPeriod(catalogue, { financialYear: "2026-27" })?.act === "Income-tax Act, 2025");
check("Act rule: nothing is said without a published rule", actForPeriod({ entries: [] }, { financialYear: "2026-27" }) === null);

// ─── the routes (scratch Mongo) ───
const uri = process.env.MONGODB_URI || "";
const scratch = /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(uri) && /scratch/i.test((uri.split("/").pop() || "").split("?")[0]);
if (!scratch) {
  console.log("NOTE  MONGODB_URI is not a scratch loopback database: the route checks are skipped, not passed.");
} else {
  await runRoutes();
}

async function runRoutes() {
  process.env.NODE_ENV = "production";
  process.env.JWT_SECRET = process.env.JWT_SECRET || "scratch-only-secret-not-a-real-credential-0000";
  process.env.DEEPSEEK_API_KEY = "";
  process.env.OCR_SPACE_API_KEY = "";
  const mongoose = (await import("mongoose")).default;
  const jwt = (await import("jsonwebtoken")).default;
  // The provider reads DEEPSEEK_URL when first imported, so the stand-in starts before the app.
  const { ensureMockDeepSeek } = await import("./lib/mock-deepseek.mjs");
  const mock = await ensureMockDeepSeek();
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
  await raw("users").insertOne({ _id: ownerId, email: "owner-notice@scratch.test", name: "Owner", role: "FIRM_ADMIN", accountType: "FIRM_USER", isActive: true, tokenVersion: 0, firmId, createdAt: now, updatedAt: now });
  await raw("firms").insertOne({ _id: firmId, displayName: "Notice Firm", handle: "scratch-notice", ownerUserId: ownerId, kind: "SHARED", isActive: true, joinCode: `JNR${Date.now()}`.slice(0, 16), createdAt: now, updatedAt: now });
  await raw("firmmemberships").insertOne({ _id: oid(), firmId, userId: ownerId, status: "ACTIVE", role: "OWNER", memberAccess: "FULL", createdAt: now, updatedAt: now });
  await raw("clients").insertOne({ _id: clientId, firmId, name: "Patil Fabrics", isActive: true, createdAt: now, updatedAt: now });
  await raw("appconfigs").insertOne({ _id: "singleton", featureFlags: { noticeCases: true, intelligence: false }, noticeCatalogue: { version: 1, publishedAt: now, entries: [{ form: "GST_ASMT10", windowDays: 30, basis: "ISSUE_DATE", sourceReference: "Rule 99(2)" }], actTransition: { effectiveFrom: "", before: "", after: "", sourceReference: "" } }, createdAt: now, updatedAt: now });
  const caseId = oid();
  await raw("casematters").insertOne({
    _id: caseId, firmId, clientId, caseType: "GST_SCRUTINY", title: "ASMT-10 for FY 2024-25", status: "EXTRACTION_NEEDS_REVIEW", priority: "NORMAL", revision: 1, ownerUserId: ownerId,
    source: { extractedText: NOTICES.find((n) => n.form === "GST_ASMT10").text },
    extractionProposals: [{ _id: oid(), field: "responseDueDate", value: "2026-11-21", sourceText: "on or before 20-11-2026", confidence: 0.8, provider: "DEEPSEEK", model: "deepseek-flash", proposedAt: now }],
    confirmedFacts: { requestedDocuments: ["Purchase register for FY 2024-25", "GSTR-2B for all months"], responseDueDate: new Date("2026-11-20T00:00:00Z") },
    createdAt: now, updatedAt: now,
  });
  const token = jwt.sign({ id: ownerId, email: "owner-notice@scratch.test", role: "FIRM_ADMIN", accountType: "FIRM_USER", firmId, isActive: true, tv: 0 }, process.env.JWT_SECRET, { expiresIn: "30m" });
  const superId = oid();
  await raw("users").insertOne({ _id: superId, email: "saifullahfaizan786@gmail.com", name: "Super", role: "SUPER_ADMIN", accountType: "FIRM_USER", isActive: true, tokenVersion: 0, firmId, createdAt: now, updatedAt: now });
  const superToken = jwt.sign({ id: superId, email: "saifullahfaizan786@gmail.com", role: "SUPER_ADMIN", accountType: "FIRM_USER", firmId, isActive: true, tv: 0 }, process.env.JWT_SECRET, { expiresIn: "30m" });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, auth = token) => {
    const response = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, json: await response.json().catch(() => null) };
  };
  try {
    const off = await call("GET", `/api/cases/${caseId}/rule-reading`);
    check("routes: with intelligence off the rule reading answers 404 naming the flag", off.status === 404 && off.json?.featureFlag === "intelligence");
    await raw("appconfigs").updateOne({ _id: "singleton" }, { $set: { "featureFlags.intelligence": true } });
    const reading = (await call("GET", `/api/cases/${caseId}/rule-reading`)).json?.reading;
    check("routes: the case's notice is read by rule with no model, each value with its source", reading?.form?.id === "GST_ASMT10" && reading.proposals.some((p) => p.field === "responseDueDate" && p.value === "2026-11-20" && p.source === "RULE"), JSON.stringify(reading)?.slice(0, 300));
    check("routes: the model's different reply-by date is flagged, the confirmed one agrees", reading?.disagreements?.some((d) => d.field === "responseDueDate" && d.other === "MODEL" && d.otherValue === "2026-11-21") && !reading.disagreements.some((d) => d.other === "CONFIRMED"), JSON.stringify(reading?.disagreements));
    check("routes: the published ASMT-10 window agrees with the stated date", reading?.replyWindow?.consistent === true && reading.replyWindow.computed === "2026-11-20");
    check("routes: a GST notice gets no Act label", reading?.act === null);
    const task = await call("POST", `/api/cases/${caseId}/document-requests`, {});
    const again = await call("POST", `/api/cases/${caseId}/document-requests`, {});
    check("routes: confirmed documents become one task due on the reply-by date, once", task.status === 201 && task.json?.task?.dueDateISO === "2026-11-20" && again.status === 200 && again.json?.created === false && (await raw("tasks").countDocuments({ firmId, caseId })) === 1, JSON.stringify(task.json));
    const stored = await raw("tasks").findOne({ firmId, caseId });
    check("routes: the task lists the documents and is linked to the case as source CASE", stored?.source === "CASE" && /Purchase register/.test(stored.remarks) && /GSTR-2B/.test(stored.remarks));
    const publish = await call("PATCH", "/api/app-config/notice-catalogue", { entries: [{ form: "IT_142_1", windowDays: 15, basis: "RECEIPT_DATE", sourceReference: "As stated in the notice template" }], actTransition: null, reason: "Test publish", expectedVersion: 1 }, superToken);
    check("routes: the owner publishes a catalogue, versioned and recorded", publish.status === 200 && publish.json?.noticeCatalogue?.version === 2, JSON.stringify(publish.json));
    const stale = await call("PATCH", "/api/app-config/notice-catalogue", { entries: [], reason: "Stale", expectedVersion: 1 }, superToken);
    check("routes: a publish from an older copy is refused 409", stale.status === 409 && stale.json?.code === "NOTICE_CATALOGUE_CHANGED");
    const notSuper = await call("PATCH", "/api/app-config/notice-catalogue", { entries: [], reason: "Nope" });
    check("routes: a firm admin who is not the super admin cannot publish", notSuper.status === 403);
    const noReason = await call("PATCH", "/api/app-config/notice-catalogue", { entries: [], actTransition: null, expectedVersion: 2 }, superToken);
    check("routes: a publish without a reason is refused 400 and changes nothing", noReason.status === 400 && (await raw("appconfigs").findOne({ _id: "singleton" })).noticeCatalogue.version === 2, JSON.stringify(noReason.json));
    const config = await fetch(`${base}/api/app-config`).then((r) => r.json());
    check("routes: the public config carries the published catalogue", config?.config?.noticeCatalogue?.version === 2 && config.config.noticeCatalogue.entries[0].form === "IT_142_1");
    const history = await raw("appconfigs").findOne({ _id: "singleton" });
    check("routes: the publish is in the control-change history with its reason", (history.controlChanges || []).some((entry) => entry.kind === "noticeCatalogue" && entry.reason === "Test publish"));
    // IN21 as built: with intelligence on, the model is still asked for every field (the rules' fields included,
    // so the rule reading has a second reading to cross-check), and only the model's own proposals are returned.
    const asmt = NOTICES.find((n) => n.form === "GST_ASMT10").text;
    mock.on(() => JSON.stringify({ fields: [{ field: "responseDueDate", value: "2026-11-20", sourceText: asmt.slice(0, 40), confidence: 0.7 }] }));
    const { proposeCaseExtraction } = await import("../src/services/case-ai.service.js");
    const extracted = await proposeCaseExtraction({ source: { extractedText: asmt } }, ownerId);
    const asked = JSON.stringify(mock.calls.at(-1)?.body || {});
    check("extraction: the model is asked for the fields the rules read too", /responseDueDate/.test(asked) && /requestedDocuments/.test(asked), asked.slice(0, 200));
    check("extraction: no rule reading is returned as the model's proposal", extracted.proposals.length === 1 && extracted.proposals.every((p) => p.provider !== "RULES" && p.confidence === 0.7), JSON.stringify(extracted.proposals));
  } finally {
    mock.off();
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase().catch(() => {});
    await mongoose.disconnect();
  }
}

const failed = checks.filter((c) => !c.pass);
for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.pass || !c.detail ? "" : ` -- ${c.detail}`}`);
console.log(`\nnotice-rules-contract: ${checks.length - failed.length}/${checks.length} passed`);
process.exitCode = failed.length ? 1 : 0;
