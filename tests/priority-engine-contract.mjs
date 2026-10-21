// tests/priority-engine-contract.mjs
//
// W11 IN22 (2026-10-21): today's priorities. The ranking is pure; the route part needs MONGODB_URI (scratch,
// loopback) and is skipped, not passed, without it.
//
// Pinned: overdue outranks due today outranks later; more at stake and higher severity break ties upward; days are
// whole UTC days whatever the time of day; every line carries its reason; every source is read (tasks, reminders,
// notices with a confirmed reply-by date, ITC at stake in a reconciliation in review, a supplier chase quiet for a
// week, open TDS errors, client requests awaited); another firm's work never appears; the route answers 404 naming
// `intelligence` while it is off.
//
// Run: node tests/priority-engine-contract.mjs   (add MONGODB_URI=mongodb://127.0.0.1:27117/scratch-priorities for the route)

import { rankPriorities, stakePoints, urgencyPoints } from "../src/services/priority-engine.service.js";

const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass: Boolean(pass), detail });

const today = new Date("2026-10-21T23:30:00Z");
const entry = (id, dueDateISO, extra = {}) => ({ kind: "TASK", id, title: id, clientName: "", dueDateISO, stakeMinor: 0, severity: "", reasonParts: [], link: {}, ...extra });
const ranked = rankPriorities([
  entry("later", "2026-11-30"),
  entry("today", "2026-10-21"),
  entry("overdue", "2026-10-18"),
  entry("none", null),
  entry("soon", "2026-10-23"),
], { today }).items.map((item) => item.id);
check("overdue, then today, then within 3 days, then later, then no date", ranked.join(",") === "overdue,today,soon,later,none", ranked.join(","));
const lateNight = rankPriorities([entry("x", "2026-10-22")], { today: new Date("2026-10-21T23:59:59Z") }).items[0];
check("days left are whole UTC days, whatever the hour", lateNight.daysLeft === 1 && /due in 1 day/.test(lateNight.reason), JSON.stringify(lateNight));
const stakeTie = rankPriorities([entry("small", "2026-10-25"), entry("big", "2026-10-25", { stakeMinor: 15_00_000_00 })], { today }).items.map((item) => item.id);
check("at equal urgency, more at stake ranks higher", stakeTie[0] === "big");
const severityTie = rankPriorities([entry("warn", "2026-10-25", { severity: "WARNING" }), entry("error", "2026-10-25", { severity: "ERROR" })], { today }).items.map((item) => item.id);
check("at equal urgency, an error ranks above a warning", severityTie[0] === "error");
const overdue = rankPriorities([entry("o", "2026-10-11", { reasonParts: ["waiting for documents"] })], { today }).items[0];
check("the reason says how overdue and why", overdue.reason === "10 days overdue; waiting for documents", overdue.reason);
check("points: urgency and stake scales", urgencyPoints(-3) === 103 && urgencyPoints(0) === 90 && urgencyPoints(null) === 10 && stakePoints(10_00_000_00) === 20 && stakePoints(99) === 0);
const many = rankPriorities(Array.from({ length: 70 }, (_, i) => entry(`t${i}`, "2026-11-01")), { today });
check("the list is capped and says it was", many.items.length === 50 && many.truncated === true && many.total === 70);

const uri = process.env.MONGODB_URI || "";
const scratch = /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(uri) && /scratch/i.test((uri.split("/").pop() || "").split("?")[0]);
if (!scratch) console.log("NOTE  MONGODB_URI is not a scratch loopback database: the route checks are skipped, not passed.");
else await runRoute();

async function runRoute() {
  process.env.NODE_ENV = "production";
  process.env.JWT_SECRET = process.env.JWT_SECRET || "scratch-only-secret-not-a-real-credential-0000";
  process.env.DEEPSEEK_API_KEY = "";
  const mongoose = (await import("mongoose")).default;
  const jwt = (await import("jsonwebtoken")).default;
  const { default: app } = await import("../src/app.js");
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
  await mongoose.connection.dropDatabase();
  const raw = (name) => mongoose.connection.collection(name);
  const oid = () => new mongoose.Types.ObjectId();
  const now = new Date();
  const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
  async function firm(label) {
    const ownerId = oid();
    const firmId = oid();
    await raw("users").insertOne({ _id: ownerId, email: `owner-${label}@scratch.test`, name: label, role: "FIRM_ADMIN", accountType: "FIRM_USER", isActive: true, tokenVersion: 0, firmId, createdAt: now, updatedAt: now });
    await raw("firms").insertOne({ _id: firmId, displayName: `Priority ${label}`, handle: `scratch-prio-${label.toLowerCase()}`, ownerUserId: ownerId, kind: "SHARED", isActive: true, joinCode: `JPR${label}${Date.now()}`.slice(0, 16), createdAt: now, updatedAt: now });
    await raw("firmmemberships").insertOne({ _id: oid(), firmId, userId: ownerId, status: "ACTIVE", role: "OWNER", memberAccess: "FULL", createdAt: now, updatedAt: now });
    return { ownerId, firmId, token: jwt.sign({ id: ownerId, email: `owner-${label}@scratch.test`, role: "FIRM_ADMIN", accountType: "FIRM_USER", firmId, isActive: true, tv: 0 }, process.env.JWT_SECRET, { expiresIn: "30m" }) };
  }
  const A = await firm("A");
  const B = await firm("B");
  const clientId = oid();
  await raw("clients").insertOne({ _id: clientId, firmId: A.firmId, name: "Joshi Exports", isActive: true, createdAt: now, updatedAt: now });
  await raw("appconfigs").insertOne({ _id: "singleton", featureFlags: { intelligence: false }, createdAt: now, updatedAt: now });
  await raw("tasks").insertMany([
    { _id: oid(), firmId: A.firmId, title: "GSTR-3B Sep 2026", clientName: "Joshi Exports", dueDateISO: day(-2), status: "WAITING_DOCS", isActive: true, assignedTo: A.ownerId, createdAt: now, updatedAt: now },
    { _id: oid(), firmId: A.firmId, title: "Filed already", clientName: "Joshi Exports", dueDateISO: day(-5), status: "FILED", isActive: true, createdAt: now, updatedAt: now },
    { _id: oid(), firmId: B.firmId, title: "Firm B task", clientName: "B client", dueDateISO: day(-9), status: "NOT_STARTED", isActive: true, createdAt: now, updatedAt: now },
  ]);
  await raw("reminders").insertOne({ _id: oid(), firmId: A.firmId, userId: A.ownerId, typeId: "TDS payment", clientLabel: "Joshi Exports", dueDateISO: day(3), isActive: true, createdAt: now, updatedAt: now });
  await raw("casematters").insertOne({ _id: oid(), firmId: A.firmId, clientId, caseType: "GST_SCRUTINY", title: "ASMT-10 FY 2024-25", status: "OPEN", priority: "HIGH", revision: 1, confirmedFacts: { responseDueDate: new Date(`${day(5)}T00:00:00Z`), noticeType: "FORM GST ASMT-10", demandMinor: 41238000 }, createdAt: now, updatedAt: now });
  const runId = oid();
  await raw("reconciliationruns").insertOne({ _id: runId, firmId: A.firmId, clientId, kind: "GST_ITC", gstin: "27AAACE1234F1Z5", period: "2026-09", status: "REVIEW", activeGenerationAttempt: 1, sourceFingerprint: "fp", createdAt: now, updatedAt: now });
  const item = (extra) => ({ _id: oid(), firmId: A.firmId, runId, clientId, generationAttempt: 1, isActive: true, resolutionState: "OPEN", booksAmounts: { totalTaxMinor: 0 }, ...extra, createdAt: now, updatedAt: now });
  await raw("reconciliationitems").insertMany([
    item({ status: "MISSING_IN_2B", booksAmounts: { totalTaxMinor: 1_20_000_00 } }),
    item({ status: "MISSING_IN_2B", booksAmounts: { totalTaxMinor: 30_000_00 } }),
    item({ status: "TAX_AMOUNT_MISMATCH", chase: { required: true, state: "COPIED", lastActionAt: new Date(Date.now() - 12 * 86400000) } }),
  ]);
  const tdsRun = oid();
  await raw("tdshealthruns").insertOne({ _id: tdsRun, firmId: A.firmId, clientId, financialYear: "2025-26", quarter: "Q2", statementType: "26Q", status: "REVIEW", activeGenerationAttempt: "gen-1", createdAt: now, updatedAt: now });
  await raw("tdshealthchecks").insertOne({ _id: oid(), firmId: A.firmId, runId: tdsRun, clientId, generationAttempt: "gen-1", state: "OPEN", severity: "ERROR", status: "DEPOSIT_MISSING", differenceMinor: 50_000_00, createdAt: now, updatedAt: now });
  await raw("engagements").insertOne({ _id: oid(), firmId: A.firmId, clientId, title: "Tax audit FY 2025-26", status: "IN_PROGRESS", clientRequests: [{ _id: oid(), templateKey: "tb", title: "Trial balance", status: "REQUESTED", requestedAt: new Date(Date.now() - 6 * 86400000), dueAt: null }], createdAt: now, updatedAt: now });

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (token) => {
    const response = await fetch(`${base}/api/home/priorities`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: response.status, json: await response.json().catch(() => null) };
  };
  try {
    const off = await get(A.token);
    check("route: with intelligence off it answers 404 naming the flag", off.status === 404 && off.json?.featureFlag === "intelligence");
    await raw("appconfigs").updateOne({ _id: "singleton" }, { $set: { "featureFlags.intelligence": true } });
    const on = await get(A.token);
    const items = on.json?.items || [];
    const kinds = new Set(items.map((i) => i.kind));
    check("route: every source is read", ["TASK", "REMINDER", "NOTICE", "GST_ITC", "SUPPLIER_CHASE", "TDS", "CLIENT_REQUEST"].every((k) => kinds.has(k)), [...kinds].join(","));
    check("route: the overdue task comes first, with its reason", items[0]?.kind === "TASK" && /2 days overdue; waiting for documents/.test(items[0].reason), JSON.stringify(items[0]));
    const itc = items.find((i) => i.kind === "GST_ITC");
    check("route: ITC at stake is the books tax of open invoices missing in 2B, in rupees", itc?.stakeMinor === 1_50_000_00 && /ITC at stake ₹1,50,000/.test(itc.reason), JSON.stringify(itc));
    check("route: a chase quiet for twelve days is listed with how long", /no movement for 12 days/.test(items.find((i) => i.kind === "SUPPLIER_CHASE")?.reason || ""));
    check("route: a notice shows its demand and links to the case", /demand ₹4,12,380/.test(items.find((i) => i.kind === "NOTICE")?.reason || "") && items.find((i) => i.kind === "NOTICE").link.surface === "case");
    check("route: a filed task is not listed", !items.some((i) => i.title === "Filed already"));
    check("route: another firm's work never appears", !items.some((i) => i.title === "Firm B task") && (await get(B.token)).json.items.every((i) => i.title === "Firm B task"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase().catch(() => {});
    await mongoose.disconnect();
  }
}

const failed = checks.filter((c) => !c.pass);
for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.pass || !c.detail ? "" : ` -- ${c.detail}`}`);
console.log(`\npriority-engine-contract: ${checks.length - failed.length}/${checks.length} passed`);
process.exitCode = failed.length ? 1 : 0;
