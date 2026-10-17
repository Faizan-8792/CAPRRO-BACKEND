// tests/clause34-contract.mjs
//
// W10 AP26 (2026-10-17). Form 3CD clause 34: TDS not deposited within the allowed time with the interest
// section 201(1A)(ii) charges, and the fee section 234E charges for statements filed late - the engine
// against a hand-worked year (pure, in paise), seven automated breakages, and - with a scratch MongoDB -
// the same pack through the real routes, the worker and the workbook, over imported TDS rows.
//
// The fixture (FY 2025-26, rupees; the monthly deposit rule, 30 April for March).
//   Q1: deducted 05 May 50,000; deposited 10 Jun (due 07 Jun) - 36 days, 2 months or part:
//         interest = 5,000,000 x 2 x 3 / 200 = 150,000 paise. Statement filed 15 Aug (due 31 Jul):
//         15 days x Rs 200 = 3,000 rupees (300,000 paise).
//   Q2: deducted 20 Jul 30,000; deposited 10 Aug (due 07 Aug) - 21 days, 1 month or part:
//         interest = 3,000,000 x 1 x 3 / 200 = 45,000 paise. Statement filed 20 Oct: in time.
//   Q3: deducted 05 Oct 1,000 and 05 Nov 500; both deposited 06 Nov, in time. Statement filed 01 Mar
//         (due 31 Jan): 29 days x Rs 200 = 5,800, capped at the quarter's tax 1,500.
//   Q4: deducted 10 Feb 20,000, never deposited - interest to 31 Mar, 49 days, 2 months or part:
//         2,000,000 x 2 x 3 / 200 = 60,000 paise, still running. Deducted 10 Mar 40,000, deposited
//         15 Apr, in time under the 30 April rule. Statement not recorded as filed (one row NOT_FILED,
//         one FILED with no date): the fee is unknown, never nil.
//
// Run: node tests/clause34-contract.mjs
//      MONGODB_URI=mongodb://127.0.0.1:27117/scratch-gates-clause34 node tests/clause34-contract.mjs

import { mutantChecks, runMutants } from "./lib/mutants.mjs";

const rupees = (value) => Math.round(value * 100);
const FY = "2025-26";

function deductions() {
  return [
    { rowId: "d1", batchId: "B1", sourceRow: 2, quarter: "Q1", transactionDate: "2025-05-05", deductedMinor: rupees(50000), sectionCode: "194C", deducteeName: "Alpha Constructions" },
    { rowId: "d7", batchId: "B1", sourceRow: 8, quarter: "Q1", transactionDate: "2025-06-25", deductedMinor: rupees(20000), sectionCode: "194C", deducteeName: "Alpha Constructions" },
    { rowId: "d2", batchId: "B1", sourceRow: 3, quarter: "Q2", transactionDate: "2025-07-20", deductedMinor: rupees(30000), sectionCode: "194J", deducteeName: "Beta Services" },
    { rowId: "d3", batchId: "B1", sourceRow: 4, quarter: "Q3", transactionDate: "2025-10-05", deductedMinor: rupees(1000), sectionCode: "194C", deducteeName: "Gamma Works" },
    { rowId: "d4", batchId: "B1", sourceRow: 5, quarter: "Q3", transactionDate: "2025-11-05", deductedMinor: rupees(500), sectionCode: "194C", deducteeName: "Gamma Works" },
    { rowId: "d6", batchId: "B1", sourceRow: 7, quarter: "Q4", transactionDate: "2026-03-10", deductedMinor: rupees(40000), sectionCode: "194C", deducteeName: "Delta Supplies" },
  ];
}

function challans() {
  return [
    { rowId: "c1", batchId: "B2", sourceRow: 2, quarter: "Q1", challanDate: "2025-06-10", depositedMinor: rupees(50000) },
    { rowId: "c2", batchId: "B2", sourceRow: 3, quarter: "Q2", challanDate: "2025-08-10", depositedMinor: rupees(30000) },
    { rowId: "c3", batchId: "B2", sourceRow: 4, quarter: "Q3", challanDate: "2025-11-06", depositedMinor: rupees(1500) },
    { rowId: "c4", batchId: "B2", sourceRow: 5, quarter: "Q4", challanDate: "2026-04-15", depositedMinor: rupees(40000) },
  ];
}

function statements() {
  return [
    { rowId: "s1", batchId: "B3", sourceRow: 2, quarter: "Q1", statementType: "24Q", filingStatus: "FILED", filedDate: "2025-08-15", reportedMinor: rupees(50000) },
    { rowId: "s2", batchId: "B3", sourceRow: 3, quarter: "Q1", statementType: "26Q", filingStatus: "FILED", filedDate: "", reportedMinor: 0 },
    { rowId: "s3", batchId: "B3", sourceRow: 4, quarter: "Q2", statementType: "24Q", filingStatus: "FILED", filedDate: "2025-10-20", reportedMinor: rupees(30000) },
    { rowId: "s4", batchId: "B3", sourceRow: 5, quarter: "Q2", statementType: "26Q", filingStatus: "CORRECTED", filedDate: "", reportedMinor: 0 },
    { rowId: "s5", batchId: "B3", sourceRow: 6, quarter: "Q3", statementType: "24Q", filingStatus: "FILED", filedDate: "2026-03-01", reportedMinor: rupees(1500) },
    { rowId: "s6", batchId: "B3", sourceRow: 7, quarter: "Q4", statementType: "24Q", filingStatus: "NOT_FILED", filedDate: "", reportedMinor: 0 },
    { rowId: "s7", batchId: "B3", sourceRow: 8, quarter: "Q4", statementType: "26Q", filingStatus: "FILED", filedDate: "", reportedMinor: 0 },
  ];
}

async function runChecks(engine) {
  const { buildClause34Rows } = engine;
  const checks = [];
  const check = (name, fn) =>
    Promise.resolve().then(fn).then(() => checks.push({ name, pass: true })).catch((error) => checks.push({ name, pass: false, detail: String(error.message).split("\n")[0] }));
  const eq = (actual, expected, what = "") => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${what ? `${what}: ` : ""}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };
  const build = (d = deductions(), c = challans(), s = statements()) => buildClause34Rows({ financialYear: FY, deductions: d, challans: c, statements: s });

  const { rows } = await build();
  const of = (section) => rows.filter((r) => r.section === section);
  const deposits = of("DEPOSIT_TIMING");
  const statementRows = of("STATEMENT_TIMING");
  const deposit = (q) => deposits.find((r) => r.values.quarter === q);
  const statement = (q) => statementRows.find((r) => r.values.quarter === q);

  await check("the statutory constants: 1.5% a month as 3/200, Rs 200 a day in paise", async () => {
    const e = await import("../src/services/audit-pack-engine/clause34.engine.js");
    if (e.INTEREST_MONTH_NUMERATOR !== 3n || e.INTEREST_MONTH_DENOMINATOR !== 200n) throw new Error("the interest constants are not 3/200");
    eq(e.FEE_PER_DAY_MINOR, 20_000);
    eq(e.statementDueDay(FY, "Q1"), "2025-07-31");
    eq(e.statementDueDay(FY, "Q4"), "2026-05-31");
    eq(e.depositDueDay("2025-05-05"), "2025-06-07");
    eq(e.depositDueDay("2025-12-15"), "2026-01-07");
    eq(e.depositDueDay("2026-03-10"), "2026-04-30");
    eq(e.monthsOrPart("2025-05-05", "2025-06-10"), 2, "36 days is two months or part");
    eq(e.monthsOrPart("2025-07-20", "2025-08-10"), 1, "21 days is one month or part");
    eq(e.monthsOrPart("2025-07-20", "2025-07-20"), 0);
    eq(e.monthsOrPart("2025-06-25", "2026-03-31"), 10, "279 days is ten months or part");
    eq(e.interest201aMinor(5_000_000, 2), 150_000);
  });
  await check("two quarters have tax not deposited in time; Q3 and Q4 do not", () => {
    eq(deposits.map((r) => r.values.quarter), ["Q1", "Q2"]);
  });
  await check("a deposit 3 days past the seventh is late, 36 days is two months or part, and the quarter's own June deduction is left uncovered", () => {
    const row = deposit("Q1");
    eq([row.values.deductedMinor, row.values.inTimeMinor, row.values.lateDepositedMinor, row.values.undepositedMinor, row.values.amountMinor],
      [rupees(70000), 0, rupees(50000), rupees(20000), rupees(70000)]);
    eq(row.values.lateDepositInterestMinor, 150_000);
    eq(row.values.interestMinor, 450_000);
    eq(row.values.stillAccruing, true);
  });
  await check("a part month counts as a whole: 21 days is one month, 45,000 paise on 30,000", () => {
    const row = deposit("Q2");
    eq(row.values.interestMinor, 45_000);
  });
  await check("tax deducted in March has until 30 April: a 15 April deposit leaves no Q4 finding at all", () => {
    eq(Boolean(deposit("Q4")), false);
  });
  await check("what is not deposited carries interest to 31 March - 279 days is ten months or part - and the row says it keeps running", () => {
    const row = deposit("Q1");
    eq(row.values.runningInterestMinor, 300_000);
    eq(row.ruleHits.some((h) => h.rule === "TDS_NOT_DEPOSITED_IN_TIME" && /keeps running/.test(h.detail)), true);
  });
  await check("a statement filed 15 days late pays Rs 200 a day", () => {
    const row = statement("Q1");
    eq([row.values.dueDay, row.values.filedOn, row.values.daysLate, row.values.feeMinor, row.values.amountMinor], ["2025-07-31", "2025-08-15", 15, 300_000, 300_000]);
    eq(row.values.feeCapped, false);
  });
  await check("the earliest recorded filing date is used when several statement rows exist", () => {
    eq(statement("Q1").values.filedOn, "2025-08-15", "the 26Q row with a blank date is not the earliest");
  });
  await check("a statement filed in time is not a finding: Q2 has none", () => {
    eq(Boolean(statement("Q2")), false);
  });
  await check("the 234E fee is capped at the quarter's tax: 29 days on 1,500 of tax", () => {
    const row = statement("Q3");
    eq([row.values.daysLate, row.values.quarterTaxMinor, row.values.feeMinor, row.values.feeCapped], [29, rupees(1500), 150_000, true]);
  });
  await check("a statement with no filing date: the fee is unknown, never nil, and the row is pending", () => {
    const row = statement("Q4");
    eq([row.state, row.decidable, row.values.feeMinor], ["PENDING_INPUT", true, null]);
    eq(row.ruleHits.some((h) => h.rule === "FILING_DATE_UNKNOWN" && /unknown, not nil/.test(h.detail)), true);
  });
  await check("a deduction with no readable date is a gap, never silently skipped", async () => {
    const withBad = await build([...deductions(), { rowId: "d9", batchId: "B1", sourceRow: 9, quarter: "Q1", transactionDate: "", deductedMinor: rupees(1) }], challans(), statements());
    const gap = withBad.rows.find((r) => r.ruleHits[0]?.rule === "UNREADABLE_DEDUCTIONS");
    eq([gap.values.count, gap.state, gap.decidable], [1, "PENDING_INPUT", false]);
  });
  await check("a quarter with deductions and no statement row at all is a gap", async () => {
    const withoutQ1 = await build(deductions(), challans(), statements().filter((s) => s.quarter !== "Q1"));
    const gap = withoutQ1.rows.find((r) => r.ruleHits[0]?.rule === "NO_STATEMENT_ROW");
    eq([gap.values.quarter, gap.state], ["Q1", "PENDING_INPUT"]);
  });
  await check("with no TDS rows at all the pack says so", async () => {
    const none = await build([], [], []);
    eq(none.rows.some((r) => r.ruleHits[0]?.rule === "NO_TDS_ROWS"), true);
  });
  await check("a quarter with deductions and no challan is an input gap, never tax read as wholly undeposited", async () => {
    const noQ2 = await build(deductions(), challans().filter((c) => c.quarter !== "Q2"), statements());
    eq(noQ2.rows.filter((r) => r.section === "DEPOSIT_TIMING").map((r) => r.values.quarter), ["Q1"], "Q2 has no deposit finding");
    const gap = noQ2.rows.find((r) => r.ruleHits[0]?.rule === "NO_CHALLAN_ROWS");
    eq([gap.values.quarter, gap.state, gap.decidable, gap.values.amountMinor], ["Q2", "PENDING_INPUT", false, null]);
    // A challan that exists but has no readable date is the same gap: nothing can be matched to it.
    const unreadable = await build(deductions(), challans().map((c) => (c.quarter === "Q2" ? { ...c, challanDate: "" } : c)), statements());
    eq(unreadable.rows.some((r) => r.ruleHits[0]?.rule === "NO_CHALLAN_ROWS" && r.values.quarter === "Q2"), true, "unreadable challan");
  });
  await check("every deposit row offers the quarterly-depositor answer; every statement row the in-time answer", () => {
    eq(deposit("Q1").values.choices.map((c) => c.value), ["REPORT", "QUARTERLY_DEPOSITOR", "REGULARISED", "OTHER_EXPLAINED"]);
    eq(statement("Q1").values.choices.map((c) => c.value), ["REPORT", "FILED_IN_TIME", "FEE_KNOWN_ELSEWHERE", "OTHER_EXPLAINED"]);
  });
  await check("building the same inputs twice gives identical rows; row keys are unique", async () => {
    eq(JSON.stringify((await build()).rows), JSON.stringify((await build()).rows));
    eq(new Set(rows.map((r) => r.rowKey)).size, rows.length);
  });
  return checks;
}

const MUTANTS = [
  { name: "the interest is at 1% a month, not one and a half", from: "export const INTEREST_MONTH_NUMERATOR = 3n;", to: "export const INTEREST_MONTH_NUMERATOR = 2n;" },
  { name: "a part month stops counting as a whole (ceil becomes floor)", from: "return Math.ceil(days / 30);", to: "return Math.floor(days / 30);" },
  { name: "the seventh day is read as the fifteenth", from: 'return m === 12 ? `${y + 1}-01-07` : `${y}-${String(m + 1).padStart(2, "0")}-07`;', to: 'return m === 12 ? `${y + 1}-01-15` : `${y}-${String(m + 1).padStart(2, "0")}-15`;' },
  { name: "March tax is due on 7 April, not 30 April", from: 'if (m === 3) return `${y}-04-30`;', to: 'if (m === 3) return `${y}-04-07`;' },
  { name: "the fee is Rs 100 a day", from: "export const FEE_PER_DAY_MINOR = 20_000;", to: "export const FEE_PER_DAY_MINOR = 10_000;" },
  { name: "the fee is not capped at the quarter's tax", from: "const feeMinor = Math.min(uncapped, quarterTaxMinor);", to: "const feeMinor = uncapped;" },
  { name: "a quarter with no challan is read as wholly undeposited", from: "const depositsKnown = purse.length > 0;", to: "const depositsKnown = true;" },
  { name: "the Q1 statement due date is read as 31 August", from: 'if (quarter === "Q1") return `${startYear}-${QUARTER_STATEMENT_DUE.Q1}`;', to: 'if (quarter === "Q1") return `${startYear}-08-31`;' },
];

async function runRouteChecks(uri) {
  const checks = [];
  const check = (name, pass, detail = "") => checks.push({ name: `route: ${name}`, pass: Boolean(pass), detail });
  process.env.NODE_ENV = "production";
  process.env.JWT_SECRET = process.env.JWT_SECRET || "scratch-only-secret-not-a-real-credential-0000";
  process.env.DEEPSEEK_API_KEY = "";
  process.env.OCR_SPACE_API_KEY = "";
  const mongoose = (await import("mongoose")).default;
  const jwt = (await import("jsonwebtoken")).default;
  const { default: app } = await import("../src/app.js");
  const { runAutomationWorkerBatch } = await import("../src/services/automation-worker.service.js");
  const { readWorkbookParts } = await import("../src/services/workbook.service.js");
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
  await mongoose.connection.dropDatabase();
  const { ensureRequiredIndexes } = await import("../src/services/index-provisioning.service.js");
  await ensureRequiredIndexes();
  const raw = (name) => mongoose.connection.collection(name);
  const oid = () => new mongoose.Types.ObjectId();
  const now = new Date();
  const ownerId = oid();
  const firmId = oid();
  await raw("users").insertOne({ _id: ownerId, email: "owner-c34@scratch.test", name: "Owner", role: "FIRM_ADMIN", accountType: "FIRM_USER", isActive: true, tokenVersion: 0, firmId, createdAt: now, updatedAt: now });
  await raw("firms").insertOne({ _id: firmId, name: "C34 Firm", displayName: "C34 Firm", handle: "scratch-c34-firm", ownerId, ownerUserId: ownerId, type: "FIRM", isActive: true, joinCode: "JC34XYZ", createdAt: now, updatedAt: now });
  await raw("firmmemberships").insertOne({ _id: oid(), firmId, userId: ownerId, status: "ACTIVE", role: "OWNER", memberAccess: "FULL", createdAt: now, updatedAt: now });
  const token = jwt.sign({ id: ownerId, email: "owner-c34@scratch.test", role: "FIRM_ADMIN", accountType: "FIRM_USER", firmId, isActive: true, tv: 0 }, process.env.JWT_SECRET, { expiresIn: "30m" });
  const otherOwnerId = oid();
  await raw("users").insertOne({ _id: otherOwnerId, email: "other-c34@scratch.test", name: "Other", role: "FIRM_ADMIN", accountType: "FIRM_USER", isActive: true, tokenVersion: 0, firmId: otherOwnerId, createdAt: now, updatedAt: now });
  await raw("firms").insertOne({ _id: otherOwnerId, name: "Other Firm", displayName: "Other Firm", handle: "scratch-c34-other", ownerId: otherOwnerId, ownerUserId: otherOwnerId, type: "FIRM", isActive: true, joinCode: "JC34OTH", createdAt: now, updatedAt: now });
  await raw("firmmemberships").insertOne({ _id: oid(), firmId: otherOwnerId, userId: otherOwnerId, status: "ACTIVE", role: "OWNER", memberAccess: "FULL", createdAt: now, updatedAt: now });
  const otherToken = jwt.sign({ id: otherOwnerId, email: "other-c34@scratch.test", role: "FIRM_ADMIN", accountType: "FIRM_USER", firmId: otherOwnerId, isActive: true, tv: 0 }, process.env.JWT_SECRET, { expiresIn: "30m" });
  const clientId = oid();
  await raw("clients").insertOne({ _id: clientId, firmId, name: "Clause 34 Traders", isActive: true, createdAt: now, updatedAt: now });
  await raw("appconfigs").insertOne({ _id: "singleton", featureFlags: { auditPacks: true }, createdAt: now, updatedAt: now });

  const batch = async (kind) => {
    const _id = oid();
    await raw("importbatches").insertOne({
      _id, firmId, clientId, kind, status: "COMPLETED", activeImportGeneration: `gen-${_id}`,
      sourceHash: _id.toString().padEnd(64, "a").slice(0, 64), importFingerprint: `fp-${_id}`, mapping: {}, createdBy: ownerId, createdAt: now, updatedAt: now,
    });
    return _id;
  };
  const tdsRow = (batchId, kind, row, extra) => ({
    _id: oid(), firmId, clientId, batchId, importGeneration: `gen-${batchId}`, kind,
    sourceRow: row.sourceRow, sourceHash: "c".repeat(64), rowFingerprint: `f${row.rowId}`.padEnd(64, "0").slice(0, 64),
    normalizationVersion: "tds-import-v1", sourceLabel: "Scratch TDS import",
    tan: "ABCD12345E", financialYear: FY, quarter: row.quarter, statementType: "24Q", ...extra,
  });
  const dedBatch = await batch("TDS_DEDUCTIONS");
  const chalBatch = await batch("TDS_CHALLANS");
  const statBatch = await batch("TDS_STATEMENTS");
  await raw("tdsimportrows").insertMany(deductions().map((d) => tdsRow(dedBatch, "TDS_DEDUCTIONS", d, {
    transactionDate: d.transactionDate, deductedMinor: d.deductedMinor, deducteeName: d.deducteeName, sectionCode: d.sectionCode,
  })));
  await raw("tdsimportrows").insertMany(challans().map((c) => tdsRow(chalBatch, "TDS_CHALLANS", c, {
    challanDate: c.challanDate, depositedMinor: c.depositedMinor,
  })));
  await raw("tdsimportrows").insertMany(statements().map((s) => tdsRow(statBatch, "TDS_STATEMENTS", s, {
    filingStatus: s.filingStatus, filedDate: s.filedDate || null, reportedMinor: s.reportedMinor, statementType: s.statementType,
  })));

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, tok, body) => {
    const response = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("spreadsheetml")) return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()), headers: response.headers };
    return { status: response.status, json: await response.json().catch(() => null), headers: response.headers };
  };
  const work = () => runAutomationWorkerBatch({ workerId: "clause34-contract", maxJobs: 5 });
  const body = {
    kind: "CLAUSE34", clientId: String(clientId), financialYear: FY,
    deductionBatchIds: [String(dedBatch)], challanBatchIds: [String(chalBatch)], statementBatchIds: [String(statBatch)],
  };
  try {
    const created = await call("POST", "/api/audit-packs", token, body);
    const runId = created.json?.run?.id;
    check("create answers 202 with a QUEUED CLAUSE34 run", created.status === 202 && created.json?.run?.status === "QUEUED" && created.json?.run?.kind === "CLAUSE34" && created.json?.run?.ruleVersion === "clause34-v1", `status ${created.status} ${JSON.stringify(created.json)?.slice(0, 240)}`);
    const again = await call("POST", "/api/audit-packs", token, body);
    check("the same imports give the same run back", again.status === 200 && again.json?.replayed === true, `status ${again.status}`);
    const summary = await work();
    check("the worker processes the pack", summary.succeeded >= 1, JSON.stringify(summary));
    const shown = await call("GET", `/api/audit-packs/${runId}`, token);
    const run = shown.json?.run;
    check("published to REVIEW naming its sections", run?.status === "REVIEW" && run?.sections?.map((s) => s.code).join(",") === "DEPOSIT_TIMING,STATEMENT_TIMING,INPUT_GAPS", JSON.stringify(run)?.slice(0, 300));
    const reasons = run?.summary?.reasons || [];
    check("a generic pack's summary carries each reason as a sentence from its own table, so a client carries no words of its own", reasons.length >= 1 && reasons.every((r) => typeof r.text === "string" && r.text.length > 0) && reasons.some((r) => r.code === "ROWS_NOT_DECIDED" && /not yet confirmed or excluded/.test(r.text)), JSON.stringify(reasons));
    const depositsPage = (await call("GET", `/api/audit-packs/${runId}/rows?section=DEPOSIT_TIMING&limit=100`, token)).json;
    const deposits = depositsPage?.rows || [];
    const statementsPage = (await call("GET", `/api/audit-packs/${runId}/rows?section=STATEMENT_TIMING&limit=100`, token)).json;
    const statementRows = statementsPage?.rows || [];
    check("two deposit rows and three statement rows are read by section, Q4 absent", deposits.length === 2 && statementRows.length === 3 && !deposits.some((r) => r.values.quarter === "Q4"), `${deposits.length}/${statementRows.length}`);
    check("the Q1 interest survives the database in paise: 450,000 with 300,000 running", deposits.some((r) => r.values.quarter === "Q1" && r.values.interestMinor === 450_000 && r.values.runningInterestMinor === 300_000));
    check("the Q3 fee is capped at the quarter's tax: 150,000", statementRows.some((r) => r.values.quarter === "Q3" && r.values.feeMinor === 150_000 && r.values.feeCapped === true));
    check("the Q4 statement row is pending with an unknown fee", statementRows.some((r) => r.values.quarter === "Q4" && r.state === "PENDING_INPUT" && r.values.feeMinor === null));
    const early = await call("GET", `/api/audit-packs/${runId}/export`, token);
    check("while rows are undecided the export carries the provisional header", early.status === 200 && early.headers.get("x-audit-pack-provisional") === "true", `status ${early.status}`);
    let firstDecision = null;
    for (const row of [...deposits, ...statementRows]) {
      if (!row.decidable || row.decision.state) continue;
      const answer = await call("POST", `/api/audit-packs/${runId}/rows/${row.rowKey}/decision`, token, { expectedVersion: row.decision.version, state: "CONFIRMED", choice: "REPORT" });
      firstDecision ??= answer.json;
      if (answer.status !== 200) check(`deciding ${row.label}`, false, `status ${answer.status} ${JSON.stringify(answer.json)?.slice(0, 200)}`);
    }
    const decided = await call("GET", `/api/audit-packs/${runId}`, token);
    // AUDIT_PACK_DUMP_DIR: write the real responses so the desktop tests can pin them (see audit-pack-route-contract).
    if (process.env.AUDIT_PACK_DUMP_DIR) {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(process.env.AUDIT_PACK_DUMP_DIR, { recursive: true });
      const dump = { "generic-run": shown.json, "generic-run-decided": decided.json, "generic-rows-deposits": depositsPage, "generic-rows-statements": statementsPage, "generic-decided-row": firstDecision };
      for (const [name, body] of Object.entries(dump)) writeFileSync(`${process.env.AUDIT_PACK_DUMP_DIR}/${name}.json`, JSON.stringify(body, null, 2));
    }
    check("once every row is decided the pack is no longer provisional", decided.json?.run?.summary?.provisional === false, JSON.stringify(decided.json?.run?.summary?.reasons));
    const final = await call("GET", `/api/audit-packs/${runId}/export`, token);
    const finalParts = final.bytes ? readWorkbookParts(final.bytes) : new Map();
    const sheetNames = [...(finalParts.get("xl/workbook.xml")?.toString("utf8") || "").matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]);
    check("the workbook has Read me, For filing, All findings, Pending and Decisions", ["Read me", "For filing", "All findings", "Pending", "Decisions"].every((n) => sheetNames.includes(n)), sheetNames.join(","));
    check("with no gaps the export is no longer provisional", final.headers.get("x-audit-pack-provisional") === "false");
    const foreign = await call("GET", `/api/audit-packs/${runId}`, otherToken);
    check("another firm reads the pack as 404", foreign.status === 404, `status ${foreign.status}`);
    const wrongKind = await call("POST", "/api/audit-packs", token, { ...body, deductionBatchIds: [String(statBatch)] });
    check("a statement import offered as the deduction register is refused", wrongKind.status === 400, `status ${wrongKind.status}`);
    const strangeField = await call("POST", "/api/audit-packs", token, { ...body, snapshotId: "x" });
    check("a field only snapshot packs take is refused on this pack", strangeField.status === 400, `status ${strangeField.status}`);
    await raw("appconfigs").updateOne({ _id: "singleton" }, { $set: { "featureFlags.auditPacks": false } });
    const off = await call("GET", "/api/audit-packs", token);
    check("with auditPacks off the routes answer 404 naming the flag", off.status === 404 && off.json?.featureFlag === "auditPacks");
  } catch (error) {
    check("the flow ran to its end without throwing", false, String(error?.stack || error).split("\n").slice(0, 3).join(" | "));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase().catch(() => {});
    await mongoose.disconnect();
  }
  return checks;
}

async function main() {
  const engine = await import("../src/services/audit-pack-engine/clause34.engine.js");
  const checks = await runChecks(engine);
  checks.push(...mutantChecks(await runMutants({ enginePath: new URL("../src/services/audit-pack-engine/clause34.engine.js", import.meta.url), mutants: MUTANTS, runChecks: (m) => runChecks(m) })));

  const uri = process.env.MONGODB_URI || "";
  const scratch = /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(uri) && /scratch/i.test((uri.split("/").pop() || "").split("?")[0]);
  let note = "engine only (no scratch MONGODB_URI)";
  if (scratch) {
    checks.push(...(await runRouteChecks(uri)));
    note = "scratch Mongo included";
  }

  let failed = 0;
  for (const c of checks) {
    if (c.pass) console.log(`PASS  ${c.name}`);
    else {
      failed += 1;
      console.error(`FAIL  ${c.name}${c.detail ? `\n      ${c.detail}` : ""}`);
    }
  }
  console.log(`\nclause34-contract: ${checks.length - failed}/${checks.length} passed (${note})`);
  process.exitCode = failed ? 1 : 0;
}

await main();
