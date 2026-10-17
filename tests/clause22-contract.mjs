// tests/clause22-contract.mjs
//
// W10 AP23 (2026-10-17). Form 3CD clause 22 with section 43B(h) and the MSMED Act's interest: the engine
// against a hand-worked day book (pure, in paise), eight automated breakages, and - with a scratch MongoDB -
// the same pack through the real routes, the worker and the workbook.
//
// The fixture (FY 2025-26, rupees, bank rate 6.25% = 625 basis points, so three times it is 1875 a year).
// Interest: from the day after the appointed time, each complete 30-day period compounds, a part period
// accrues day-wise. Hand-worked below; the checks quote the arithmetic.
//   Priya (MICRO, no credit period anywhere -> 15 days):
//     01 May buy 50,000 bill PRIYA-01, due 16 May, PAID 16 May exactly on the appointed day   in time
//     12 Sep buy 40,000 bill PRIYA-02, due 27 Sep, never paid                                 FINDING (unpaid)
//       interest to 31 Mar 2026 (185 days = 6 months + 5 days) = 4,013.86 (401,386 paise)
//   Sharma (SMALL, party credit period 30 days):
//     05 Jun buy 1,20,000 bill SHARMA-11, due 05 Jul, paid 04 Aug (30 days late)             FINDING
//       interest = 12,000,000 x 1875 / 120000 = 187,500 paise (one exact month)
//     10 Jul buy 95,000 bill SHARMA-12, due 09 Aug; 15 Jul return 15,000 (journal, not paid)
//       09 Sep pay 30,000 (31 days = 1 month + 1 day): 46,875 + 1,586 = 48,461
//       08 Nov pay 50,000 (91 days = 3 months + 1 day): 78,125+79,345+80,585+2,728 = 240,783
//       FINDING, paid late 80,000, interest 289,244
//     25 Nov pay 5,000 on account (names no bill)                                            gap (unattributed)
//   Atlas (MICRO, party credit period 60 days -> capped at 45):
//     01 Nov buy 90,000 bill ATLAS-7, due 16 Dec (capped), paid 20 Dec (4 days late)         FINDING
//       interest = 9,000,000 x 1875 x 4 / 3,600,000 = 18,750
//   Verma (MEDIUM): buy 2,00,000 10 Oct, paid late 05 Mar                                   left out, named
//   Ghosh (UNKNOWN): buy 70,000 15 Oct                                                       pending input, never guessed
//   Nova (MICRO): buy 30,000 20 Nov with no bill detail                                      gap (unbilled)
//   a cancelled purchase; one purchase voucher with no date                                  gap of 1 unreadable
//
// Run: node tests/clause22-contract.mjs
//      MONGODB_URI=mongodb://127.0.0.1:27117/scratch-gates-clause22 node tests/clause22-contract.mjs

import { mutantChecks, runMutants } from "./lib/mutants.mjs";

const rupees = (value) => Math.round(value * 100);
const FY = "2025-26";

const LEDGERS = [
  { name: "Cash", parent: "Cash-in-Hand", standardGroup: "CASH" },
  { name: "HDFC Bank", parent: "Bank Accounts", standardGroup: "BANK" },
  { name: "Purchases", parent: "Direct Expenses", standardGroup: "DIRECT_EXPENSES" },
  { name: "Priya Micro Parts", parent: "Sundry Creditors", standardGroup: "SUNDRY_CREDITORS", pan: "AAAAA1111A" },
  { name: "Sharma Small Goods", parent: "Sundry Creditors", standardGroup: "SUNDRY_CREDITORS", pan: "BBBBB2222B" },
  { name: "Atlas Tools", parent: "Sundry Creditors", standardGroup: "SUNDRY_CREDITORS", pan: "CCCCC3333C" },
  { name: "Verma Medium Traders", parent: "Sundry Creditors", standardGroup: "SUNDRY_CREDITORS" },
  { name: "Ghosh Traders", parent: "Sundry Creditors", standardGroup: "SUNDRY_CREDITORS" },
  { name: "Nova Retail", parent: "Sundry Creditors", standardGroup: "SUNDRY_CREDITORS" },
  { name: "Silent Traders", parent: "Sundry Creditors", standardGroup: "SUNDRY_CREDITORS" },
];

// The party master's answer, by normalised ledger name.
const PARTIES = new Map([
  ["priya micro parts", { udyamCategory: "MICRO", creditPeriodDays: null }],
  ["sharma small goods", { udyamCategory: "SMALL", creditPeriodDays: 30 }],
  ["atlas tools", { udyamCategory: "MICRO", creditPeriodDays: 60 }],
  ["verma medium traders", { udyamCategory: "MEDIUM", creditPeriodDays: null }],
  ["ghosh traders", { udyamCategory: "UNKNOWN", creditPeriodDays: null }],
  ["nova retail", { udyamCategory: "MICRO", creditPeriodDays: null }],
]);

let n = 0;
const entry = (ledger, amount) => ({ ledger, amountMinor: rupees(amount) });
const bill = (ledger, name, billType, amount, creditPeriodDays = null) => ({ ledger, name, billType, amountMinor: rupees(amount), creditPeriodDays });
const bank = (transactionType) => ({ ledger: "HDFC Bank", instrumentNumber: "1", instrumentDate: null, transactionType, bankName: "HDFC", amountMinor: 0 });
const voucher = (date, entries, extra = {}) => ({ _id: `v${++n}`, guid: `g${n}`, alterId: n, date, type: "Payment", number: `${n}`, cancelled: false, optional: false, entries, bills: [], banks: [], warnings: [], ...extra });

function vouchers() {
  n = 0;
  return [
    // Bill A: bought 01 May, paid exactly on the appointed day (16 May).
    voucher("2025-05-01", [entry("Purchases", -50000), entry("Priya Micro Parts", 50000)], { type: "Purchase", bills: [bill("Priya Micro Parts", "PRIYA-01", "New Ref", 50000)] }),
    voucher("2025-05-16", [entry("Priya Micro Parts", -50000), entry("HDFC Bank", 50000)], { bills: [bill("Priya Micro Parts", "PRIYA-01", "Agst Ref", 50000)], banks: [bank("e-Fund Transfer")] }),
    // Bill B: Sharma, 30-day party period, paid 30 days late in one go.
    voucher("2025-06-05", [entry("Purchases", -120000), entry("Sharma Small Goods", 120000)], { type: "Purchase", bills: [bill("Sharma Small Goods", "SHARMA-11", "New Ref", 120000)] }),
    voucher("2025-08-04", [entry("Sharma Small Goods", -120000), entry("HDFC Bank", 120000)], { bills: [bill("Sharma Small Goods", "SHARMA-11", "Agst Ref", 120000)], banks: [bank("e-Fund Transfer")] }),
    // Bill C: bought 95,000, returned 15,000 by journal (not a payment), two late part-payments.
    voucher("2025-07-10", [entry("Purchases", -95000), entry("Sharma Small Goods", 95000)], { type: "Purchase", bills: [bill("Sharma Small Goods", "SHARMA-12", "New Ref", 95000)] }),
    voucher("2025-07-15", [entry("Sharma Small Goods", -15000), entry("Purchases", 15000)], { type: "Journal", bills: [bill("Sharma Small Goods", "SHARMA-12", "Agst Ref", 15000)] }),
    voucher("2025-09-09", [entry("Sharma Small Goods", -30000), entry("HDFC Bank", 30000)], { bills: [bill("Sharma Small Goods", "SHARMA-12", "Agst Ref", 30000)], banks: [bank("e-Fund Transfer")] }),
    voucher("2025-11-08", [entry("Sharma Small Goods", -50000), entry("HDFC Bank", 50000)], { bills: [bill("Sharma Small Goods", "SHARMA-12", "Agst Ref", 50000)], banks: [bank("e-Fund Transfer")] }),
    // An on-account payment that names no bill.
    voucher("2025-11-25", [entry("Sharma Small Goods", -5000), entry("HDFC Bank", 5000)], { banks: [bank("e-Fund Transfer")] }),
    // Bill D: Priya again, never paid.
    voucher("2025-09-12", [entry("Purchases", -40000), entry("Priya Micro Parts", 40000)], { type: "Purchase", bills: [bill("Priya Micro Parts", "PRIYA-02", "New Ref", 40000)] }),
    // Bill E: Atlas, agreed 60 days, capped at 45, paid 4 days late.
    voucher("2025-11-01", [entry("Purchases", -90000), entry("Atlas Tools", 90000)], { type: "Purchase", bills: [bill("Atlas Tools", "ATLAS-7", "New Ref", 90000, 60)] }),
    voucher("2025-12-20", [entry("Atlas Tools", -90000), entry("HDFC Bank", 90000)], { bills: [bill("Atlas Tools", "ATLAS-7", "Agst Ref", 90000)], banks: [bank("e-Fund Transfer")] }),
    // Verma: MEDIUM - paid late but outside the clause.
    voucher("2025-10-10", [entry("Purchases", -200000), entry("Verma Medium Traders", 200000)], { type: "Purchase", bills: [bill("Verma Medium Traders", "VERMA-1", "New Ref", 200000)] }),
    voucher("2026-03-05", [entry("Verma Medium Traders", -200000), entry("HDFC Bank", 200000)], { bills: [bill("Verma Medium Traders", "VERMA-1", "Agst Ref", 200000)], banks: [bank("e-Fund Transfer")] }),
    // Ghosh: category UNKNOWN - never guessed.
    voucher("2025-10-15", [entry("Purchases", -70000), entry("Ghosh Traders", 70000)], { type: "Purchase", bills: [bill("Ghosh Traders", "GHOSH-1", "New Ref", 70000)] }),
    // Silent Traders: no party row at all - the category is unknown, never guessed.
    voucher("2025-12-02", [entry("Purchases", -25000), entry("Silent Traders", 25000)], { type: "Purchase", bills: [bill("Silent Traders", "SILENT-1", "New Ref", 25000)] }),
    // Nova: MICRO but the purchase carries no bill detail.
    voucher("2025-11-20", [entry("Purchases", -30000), entry("Nova Retail", 30000)], { type: "Purchase" }),
    // A cancelled purchase is ignored; a purchase with no date is an input gap.
    voucher("2025-12-05", [entry("Purchases", -60000), entry("Priya Micro Parts", 60000)], { type: "Purchase", cancelled: true, bills: [bill("Priya Micro Parts", "PRIYA-03", "New Ref", 60000)] }),
    voucher(null, [entry("Purchases", -25000), entry("Priya Micro Parts", 25000)], { type: "Purchase" }),
  ];
}

async function* asAsync(list) {
  for (const item of list) yield item;
}

async function runChecks(engine) {
  const { buildClause22Rows } = engine;
  const checks = [];
  const check = (name, fn) =>
    Promise.resolve().then(fn).then(() => checks.push({ name, pass: true })).catch((error) => checks.push({ name, pass: false, detail: String(error.message).split("\n")[0] }));
  const eq = (actual, expected, what = "") => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${what ? `${what}: ` : ""}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };
  const build = (list = vouchers(), parties = PARTIES, params = { bankRates: { [FY]: 625 } }) =>
    buildClause22Rows({ financialYear: FY, snapshotId: "S1", ledgers: LEDGERS, vouchers: asAsync(list), parties, params });

  const { rows } = await build();
  const of = (section) => rows.filter((r) => r.section === section);
  const findings = of("MSME_LATE");
  const suppliers = of("SUPPLIERS");
  const gaps = of("INPUT_GAPS");
  const finding = (supplier, billName) => findings.find((r) => r.values.supplier === supplier && r.values.billName === billName);
  const supplier = (name) => suppliers.find((r) => r.values.supplier === name);

  await check("the appointed time's outer limits are the statute's: 45 days, and 15 with no agreement", async () => {
    const e = await import("../src/services/audit-pack-engine/clause22.engine.js");
    eq(e.MAX_AGREED_DAYS, 45);
    eq(e.DEFAULT_NO_AGREEMENT_DAYS, 15);
    eq(e.appointedTime(60), { days: 45, basis: "CAPPED_45" });
    eq(e.appointedTime(30), { days: 30, basis: "AGREED" });
    eq(e.appointedTime(null), { days: 15, basis: "DEFAULT_15" });
  });
  await check("four bills are findings, in appointed-time order", () => {
    eq(findings.map((r) => `${r.values.billName}@${r.values.dueDate}`), ["SHARMA-11@2025-07-05", "SHARMA-12@2025-08-09", "PRIYA-02@2025-09-27", "ATLAS-7@2025-12-16"]);
  });
  await check("paid exactly on the appointed day is in time, not a finding", () => {
    eq(Boolean(finding("Priya Micro Parts", "PRIYA-01")), false);
  });
  await check("a bill paid 30 days late carries one exact month's compounded interest", () => {
    const row = finding("Sharma Small Goods", "SHARMA-11");
    eq(row.values.paidLateMinor, rupees(120000));
    eq(row.values.unpaidMinor, 0);
    eq(row.values.interestMinor, 187_500);
    eq(row.values.amountMinor, rupees(120000));
  });
  await check("a journal return reduces the bill without being a payment", () => {
    const row = finding("Sharma Small Goods", "SHARMA-12");
    eq(row.values.billMinor, rupees(95000));
    eq(row.values.adjustmentsMinor, rupees(15000));
    eq(row.values.paidLateMinor, rupees(80000));
  });
  await check("part-period interest is day-wise: 48,461 + 240,783 paise on the two late payments", () => {
    eq(finding("Sharma Small Goods", "SHARMA-12").values.interestMinor, 48_461 + 240_783);
  });
  await check("an unpaid bill is a finding, its interest runs to 31 March and keeps running", () => {
    const row = finding("Priya Micro Parts", "PRIYA-02");
    eq(row.values.unpaidMinor, rupees(40000));
    eq(row.values.paidLateMinor, 0);
    eq(row.values.interestMinor, 401_386);
    eq(row.values.stillAccruing, true);
    eq(row.ruleHits.some((h) => h.rule === "STILL_ACCRUING"), true);
  });
  await check("an agreed 60 days is capped at 45 and the row says so", () => {
    const row = finding("Atlas Tools", "ATLAS-7");
    eq(row.values.dueBasis, "CAPPED_45");
    eq(row.values.creditPeriodDays, 45);
    eq(row.values.interestMinor, 18_750);
    eq(row.ruleHits.some((h) => h.rule === "CAPPED_AT_45"), true);
  });
  await check("with no credit period anywhere the statutory 15 days apply and the row says so", () => {
    const row = finding("Priya Micro Parts", "PRIYA-02");
    eq(row.values.dueBasis, "DEFAULT_15");
    eq(row.values.creditPeriodDays, 15);
    eq(row.values.acceptanceDate, "2025-09-12");
    eq(row.values.dueDate, "2025-09-27");
    eq(row.ruleHits.some((h) => h.rule === "NO_AGREEMENT_15_DAYS"), true);
  });
  await check("a medium supplier paid late is left out and named, not guessed into the clause", () => {
    eq(findings.some((r) => r.values.supplier === "Verma Medium Traders"), false);
    const out = gaps.find((r) => r.ruleHits[0].rule === "NOT_MSME_SUPPLIERS");
    eq(Boolean(out), true);
    eq(out.values.names, ["Verma Medium Traders"]);
  });
  await check("an unknown Udyam category is a pending input per supplier, never a finding and never 'not MSME'", () => {
    eq(findings.some((r) => r.values.supplier === "Ghosh Traders"), false);
    const gap = gaps.find((r) => r.ruleHits[0]?.rule === "UDYAM_UNKNOWN");
    eq([gap.values.supplier, gap.values.purchaseMinor, gap.state, gap.decidable], ["Ghosh Traders", rupees(70000), "PENDING_INPUT", false]);
  });
  await check("a supplier with no party row at all is unknown too: a pending input, never a finding", () => {
    eq(findings.some((r) => r.values.supplier === "Silent Traders"), false);
    eq(Boolean(gaps.find((r) => r.values.supplier === "Silent Traders" && r.ruleHits[0]?.rule === "UDYAM_UNKNOWN")), true);
  });
  await check("purchases without bill detail and payments that name no bill are each named as gaps", () => {
    eq(gaps.find((r) => r.ruleHits[0]?.rule === "PURCHASES_NOT_BILLWISE").values.purchaseMinor, rupees(30000));
    eq(gaps.find((r) => r.ruleHits[0]?.rule === "PAYMENTS_NOT_AGAINST_BILLS").values.paidMinor, rupees(5000));
  });
  await check("a cancelled purchase is ignored; a purchase with no date is an unreadable gap, never silently skipped", () => {
    eq(findings.some((r) => r.values.billName === "PRIYA-03"), false);
    const gap = gaps.find((r) => r.ruleHits[0]?.rule === "UNREADABLE_VOUCHERS");
    eq([gap.values.count, gap.state, gap.decidable], [1, "PENDING_INPUT", false]);
  });
  await check("the party master's credit period wins over the bill's", async () => {
    // Atlas's bill says 60; the party says 60 too. Rebuild with the party saying 20: the due date must move.
    const parties = new Map(PARTIES);
    parties.set("atlas tools", { udyamCategory: "MICRO", creditPeriodDays: 20 });
    const rebuilt = await build(vouchers(), parties);
    const row = rebuilt.rows.find((r) => r.section === "MSME_LATE" && r.values.billName === "ATLAS-7");
    eq(row.values.dueBasis, "AGREED");
    eq(row.values.dueDate, "2025-11-21");
    eq(row.values.paidLateMinor, rupees(90000), "paid 20 Dec against a 21 Nov appointed time: still late");
    eq(Boolean(row), true);
  });
  await check("without a bank rate the interest is unknown - never zero - and the gap says so", async () => {
    const rebuilt = await build(vouchers(), PARTIES, {});
    const late = rebuilt.rows.find((r) => r.section === "MSME_LATE" && r.values.billName === "SHARMA-11");
    eq(late.values.interestMinor, null);
    eq(late.ruleHits.some((h) => h.rule === "INTEREST_UNKNOWN"), true);
    const gap = rebuilt.rows.find((r) => r.ruleHits[0]?.rule === "BANK_RATE_NOT_SUPPLIED");
    eq(gap.values.count, 4);
    eq(rebuilt.rows.find((r) => r.section === "SUPPLIERS" && r.values.supplier === "Sharma Small Goods").values.interestMinor, null);
  });
  await check("a payment dated after the year end never reduces unpaid-at-year-end", async () => {
    const withNextYear = [...vouchers(), voucher("2026-04-10", [entry("Priya Micro Parts", -40000), entry("HDFC Bank", 40000)], { bills: [bill("Priya Micro Parts", "PRIYA-02", "Agst Ref", 40000)], banks: [bank("e-Fund Transfer")] })];
    const rebuilt = await build(withNextYear);
    eq(rebuilt.rows.find((r) => r.section === "MSME_LATE" && r.values.billName === "PRIYA-02").values.unpaidMinor, rupees(40000));
  });
  await check("each supplier has a summary; micro and small only; the numbers add", () => {
    eq(suppliers.map((r) => r.values.supplier), ["Atlas Tools", "Priya Micro Parts", "Sharma Small Goods"]);
    const sharma = supplier("Sharma Small Goods").values;
    eq([sharma.billCount, sharma.purchaseMinor, sharma.paidInTimeMinor, sharma.paidLateMinor, sharma.adjustmentsMinor, sharma.unpaidMinor, sharma.interestMinor],
      [2, rupees(215000), 0, rupees(200000), rupees(15000), 0, 187_500 + 289_244]);
    const priya = supplier("Priya Micro Parts").values;
    eq([priya.billCount, priya.purchaseMinor, priya.paidInTimeMinor, priya.unpaidMinor, priya.interestMinor], [2, rupees(90000), rupees(50000), rupees(40000), 401_386]);
    eq(suppliers.every((r) => r.decidable === false), true);
  });
  await check("every finding offers the four answers, the proviso among them with a note required", () => {
    eq(findings[0].values.choices.map((c) => c.value), ["REPORT", "PAID_BEFORE_RETURN", "NOT_PAYABLE", "OTHER_EXPLAINED"]);
    eq(findings[0].values.choices.find((c) => c.value === "PAID_BEFORE_RETURN").needsNote, true);
  });
  await check("building the same inputs twice gives identical rows; row keys are unique", async () => {
    eq(JSON.stringify((await build()).rows), JSON.stringify((await build()).rows));
    eq(new Set(rows.map((r) => r.rowKey)).size, rows.length);
  });
  return checks;
}

const MUTANTS = [
  { name: "the 45-day outer limit is dropped", from: 'if (creditPeriodDays > MAX_AGREED_DAYS) return { days: MAX_AGREED_DAYS, basis: "CAPPED_45" };', to: 'if (creditPeriodDays > MAX_AGREED_DAYS) return { days: creditPeriodDays, basis: "AGREED" };' },
  { name: "the 15-day no-agreement default is dropped", from: 'return { days: DEFAULT_NO_AGREEMENT_DAYS, basis: "DEFAULT_15" };', to: 'return { days: 0, basis: "AGREED" };' },
  { name: "a payment on the appointed day is counted as late (<= becomes <)", from: "if (reduction.day <= dueDay) paidInTime += reduction.paymentMinor;", to: "if (reduction.day < dueDay) paidInTime += reduction.paymentMinor;" },
  { name: "the interest is at the bank rate, not three times it", from: "const annualBps3 = bankRateKnown ? bankRateBps * 3 : null;", to: "const annualBps3 = bankRateKnown ? bankRateBps : null;" },
  { name: "the interest does not compound", from: "    interest += inc;\n    outstanding += inc;", to: "    interest += inc;" },
  { name: "an unknown Udyam category is guessed as micro or small", from: "const isMsme = MSME_CATEGORIES.has(udyam);", to: 'const isMsme = MSME_CATEGORIES.has(udyam) || udyam === "UNKNOWN";' },
  { name: "medium suppliers are counted as micro or small", from: 'const MSME_CATEGORIES = new Set(["MICRO", "SMALL"]);', to: 'const MSME_CATEGORIES = new Set(["MICRO", "SMALL", "MEDIUM"]);' },
  { name: "an unpaid bill is not treated as late", from: "const late = paidLate > 0 || unpaid > 0;", to: "const late = paidLate > 0;" },
];

async function main() {
  const engine = await import("../src/services/audit-pack-engine/clause22.engine.js");
  const checks = await runChecks(engine);
  checks.push(...mutantChecks(await runMutants({ enginePath: new URL("../src/services/audit-pack-engine/clause22.engine.js", import.meta.url), mutants: MUTANTS, runChecks: (m) => runChecks(m) })));

  const uri = process.env.MONGODB_URI || "";
  const scratch = /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(uri) && /scratch/i.test((uri.split("/").pop() || "").split("?")[0]);
  let note = "engine only (no scratch MONGODB_URI)";
  if (scratch) {
    const { runSnapshotPackFlow } = await import("./lib/snapshot-pack-routes.mjs");
    checks.push(...(await runSnapshotPackFlow({
      uri,
      label: "Clause 22",
      kind: "CLAUSE22",
      ledgers: LEDGERS.map((l, i) => ({ name: l.name, parent: l.parent, pan: l.pan || "", alterId: 100 + i })),
      vouchers: vouchers().map(({ _id, ...v }) => v),
      body: { bankRates: { [FY]: 625 } },
      beforeCreate: async ({ raw, A, clientId, oid, now }) => {
        for (const [key, party] of PARTIES) {
          await raw("booksparties").insertOne({
            _id: oid(), firmId: A.firmId, clientId, nameKey: key, name: key, standardGroup: "SUNDRY_CREDITORS",
            udyamCategory: party.udyamCategory, creditPeriodDays: party.creditPeriodDays, lenderOrDepositor: null, relatedPerson: null,
            blanks: [], version: 1, confirmedBy: A.ownerId, confirmedAt: now, createdAt: now, updatedAt: now,
          });
        }
      },
      decide: (row) => (row.decidable ? { state: "CONFIRMED", choice: "REPORT" } : null),
      expect: async ({ run, section }) => {
        const out = [];
        const c = (name, pass, detail = "") => out.push({ name, pass: Boolean(pass), detail });
        c("the run names its three sections", run.sections.map((s) => s.code).join(",") === "MSME_LATE,SUPPLIERS,INPUT_GAPS");
        c("four findings, three supplier summaries, six gaps are read by section",
          ["MSME_LATE", "SUPPLIERS", "INPUT_GAPS"].map((s) => `${s}:${section(s).length}`).join(" ") === "MSME_LATE:4 SUPPLIERS:3 INPUT_GAPS:6",
          ["MSME_LATE", "SUPPLIERS", "INPUT_GAPS"].map((s) => `${s}:${section(s).length}`).join(" "));
        c("the Udyam categories were read from the party master", section("MSME_LATE").every((r) => ["MICRO", "SMALL"].includes(r.values.udyamCategory)));
        c("the bank rate travelled through the create request: interest is present in paise", section("MSME_LATE").some((r) => r.values.interestMinor === 187_500));
        c("the unpaid bill carries interest accrued to the year end", section("MSME_LATE").some((r) => r.values.unpaidMinor === 4_000_000 && r.values.interestMinor === 401_386));
        c("a supplier summary is not decidable; a bill finding is", section("SUPPLIERS").every((r) => r.decidable === false) && section("MSME_LATE").every((r) => r.decidable));
        return out;
      },
    })));
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
  console.log(`\nclause22-contract: ${checks.length - failed}/${checks.length} passed (${note})`);
  process.exitCode = failed ? 1 : 0;
}

await main();
