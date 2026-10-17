// tests/clause26-contract.mjs
//
// W10 AP24 (2026-10-17). Form 3CD clause 26 with section 43B(a)-(d) and clause 20(b), statutory dues
// payable at the year end: the engine against a hand-worked day book (pure, in paise), seven automated
// breakages, and - with a scratch MongoDB - the same pack through the real routes, the worker and the
// workbook.
//
// The fixture (FY 2025-26, rupees; the return is due 2026-10-31 under section 139(1)).
//   Provident Fund Payable: accrued Apr 12,000, May 12,000, Jun 12,000; paid 12 May (April's, due 15 May,
//     in time), 20 Jun (May's, due 15 Jun, 5 days late); June's never settled. Closing 12,000.
//   ESI Payable: accrued 31 May 3,000, paid 15 Jun exactly on the 15th - in time. Closing 0, no dues row.
//   GST Payable: opening 45,000, accrued 2,00,000, paid 1,80,000. Closing 65,000.
//   TDS Payable: opening 10,000, accrued 50,000, paid 55,000. Closing 5,000.
//   Income Tax Payable: opening 20,000, no movements - the ledger itself is the evidence.
//   Municipal Cess: opening 8,000, no name match - found by the Duties & Taxes group.
//   PF Traders: a creditor that happens to match the provident-fund name rule - flagged, not assumed.
//   Next year: PF paid 2026-11-15 (AFTER the return was due, so it does not count), GST paid 2026-09-20
//     (before it, so it does). Without the typed list, nothing anywhere reads as "not paid".
//   a cancelled ESI accrual; one GST voucher with no date                                    gap of 1 unreadable
//
// Run: node tests/clause26-contract.mjs
//      MONGODB_URI=mongodb://127.0.0.1:27117/scratch-gates-clause26 node tests/clause26-contract.mjs

import { mutantChecks, runMutants } from "./lib/mutants.mjs";

const rupees = (value) => Math.round(value * 100);
const FY = "2025-26";
const DUE = "Duties & Taxes";

const LEDGERS = [
  { name: "Cash", parent: "Cash-in-Hand", standardGroup: "CASH" },
  { name: "HDFC Bank", parent: "Bank Accounts", standardGroup: "BANK" },
  { name: "Salaries", parent: "Direct Expenses", standardGroup: "DIRECT_EXPENSES" },
  { name: "Provident Fund Payable", parent: DUE, standardGroup: "DUTIES_TAXES" },
  { name: "ESI Payable", parent: DUE, standardGroup: "DUTIES_TAXES" },
  { name: "GST Payable", parent: DUE, standardGroup: "DUTIES_TAXES", openingMinor: rupees(45000) },
  { name: "TDS Payable", parent: DUE, standardGroup: "DUTIES_TAXES", openingMinor: rupees(10000) },
  { name: "Income Tax Payable", parent: DUE, standardGroup: "DUTIES_TAXES", openingMinor: rupees(20000) },
  { name: "Municipal Cess", parent: DUE, standardGroup: "DUTIES_TAXES", openingMinor: rupees(8000) },
  { name: "PF Traders", parent: "Sundry Creditors", standardGroup: "SUNDRY_CREDITORS", openingMinor: rupees(30000) },
];

let n = 0;
const entry = (ledger, amount) => ({ ledger, amountMinor: rupees(amount) });
const voucher = (date, entries, extra = {}) => ({ _id: `v${++n}`, guid: `g${n}`, alterId: n, date, type: "Journal", number: `${n}`, cancelled: false, optional: false, entries, bills: [], banks: [], warnings: [], ...extra });

function vouchers() {
  n = 0;
  return [
    voucher("2025-04-30", [entry("Salaries", -12000), entry("Provident Fund Payable", 12000)]),
    voucher("2025-05-31", [entry("Salaries", -12000), entry("Provident Fund Payable", 12000)]),
    voucher("2025-06-30", [entry("Salaries", -12000), entry("Provident Fund Payable", 12000)]),
    voucher("2025-05-12", [entry("Provident Fund Payable", -12000), entry("HDFC Bank", 12000)], { type: "Payment" }),
    voucher("2025-06-20", [entry("Provident Fund Payable", -12000), entry("HDFC Bank", 12000)], { type: "Payment" }),
    voucher("2025-05-31", [entry("Salaries", -3000), entry("ESI Payable", 3000)]),
    voucher("2025-06-15", [entry("ESI Payable", -3000), entry("HDFC Bank", 3000)], { type: "Payment" }),
    voucher("2025-07-05", [entry("Output GST", -200000), entry("GST Payable", 200000)]),
    voucher("2025-07-20", [entry("GST Payable", -180000), entry("HDFC Bank", 180000)], { type: "Payment" }),
    voucher("2026-02-05", [entry("TDS Receivable", -50000), entry("TDS Payable", 50000)]),
    voucher("2026-03-07", [entry("TDS Payable", -55000), entry("HDFC Bank", 55000)], { type: "Payment" }),
    voucher("2025-08-01", [entry("Salaries", -3000), entry("ESI Payable", 3000)], { cancelled: true }),
    voucher(null, [entry("GST Payable", -9000), entry("HDFC Bank", 9000)], { type: "Payment" }),
  ];
}

async function* asAsync(list) {
  for (const item of list) yield item;
}

async function runChecks(engine) {
  const { buildClause26Rows } = engine;
  const checks = [];
  const check = (name, fn) =>
    Promise.resolve().then(fn).then(() => checks.push({ name, pass: true })).catch((error) => checks.push({ name, pass: false, detail: String(error.message).split("\n")[0] }));
  const eq = (actual, expected, what = "") => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${what ? `${what}: ` : ""}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };
  const NEXT_YEAR = { returnDueDay: "2026-10-31", nextYearPayments: [
    { ledger: "Provident Fund Payable", date: "2026-11-15", amountMinor: rupees(12000) },
    { ledger: "GST Payable", date: "2026-09-20", amountMinor: rupees(65000) },
  ] };
  const build = (list = vouchers(), params = NEXT_YEAR) =>
    buildClause26Rows({ financialYear: FY, snapshotId: "S1", ledgers: LEDGERS, vouchers: asAsync(list), params });

  const { rows } = await build();
  const of = (section) => rows.filter((r) => r.section === section);
  const dues = of("DUES_OUTSTANDING").filter((r) => r.decidable);
  const months = of("PF_ESI_MONTHS");
  const gaps = of("INPUT_GAPS");
  const due = (name) => dues.find((r) => r.values.ledger === name);
  const month = (ledger, m) => months.find((r) => r.values.ledger === ledger && r.values.month === m);

  await check("a provident fund or ESI month's due day is the 15th of the next month", async () => {
    const e = await import("../src/services/audit-pack-engine/clause26.engine.js");
    eq(e.pfEsiDueDay("2025-04"), "2025-05-15");
    eq(e.pfEsiDueDay("2025-12"), "2026-01-15");
  });
  await check("six dues are outstanding, in name order, each naming the rule that found it", () => {
    eq(dues.map((r) => r.values.ledger), ["GST Payable", "Income Tax Payable", "Municipal Cess", "PF Traders", "Provident Fund Payable", "TDS Payable"]);
    eq(dues.map((r) => r.values.matchedRule), ["GST", "INCOME_TAX", "DUTIES_TAXES_GROUP", "PROVIDENT_FUND", "PROVIDENT_FUND", "TDS"]);
  });
  await check("the closing balance counts the opening: GST owes 45,000 + 2,00,000 - 1,80,000", () => {
    const row = due("GST Payable");
    eq([row.values.openingMinor, row.values.accruedMinor, row.values.paidInYearMinor, row.values.closingMinor, row.values.amountMinor],
      [rupees(45000), rupees(200000), rupees(180000), rupees(65000), rupees(65000)]);
  });
  await check("provident fund owes only June's contribution: 36,000 accrued less 24,000 paid", () => {
    const row = due("Provident Fund Payable");
    eq([row.values.accruedMinor, row.values.paidInYearMinor, row.values.closingMinor], [rupees(36000), rupees(24000), rupees(12000)]);
  });
  await check("ESI squared up in the year: no dues row at all", () => {
    eq(Boolean(due("ESI Payable")), false);
  });
  await check("a due that exists only through its opening balance stands on the ledger as evidence", () => {
    const row = due("Income Tax Payable");
    eq(row.values.closingMinor, rupees(20000));
    eq(row.sourceRows[0].kind, "BOOKS_LEDGER");
  });
  await check("a ledger found only by the Duties-and-Taxes group is included and says so", () => {
    eq(due("Municipal Cess").values.matchedRule, "DUTIES_TAXES_GROUP");
  });
  await check("a creditor whose name matches a dues rule is flagged, not assumed to be a due", () => {
    const row = due("PF Traders");
    eq(row.values.closingMinor, rupees(30000));
    eq(row.ruleHits.some((h) => h.rule === "MATCHED_BY" && /group is SUNDRY_CREDITORS/.test(h.detail)), true);
  });
  await check("provident fund months: April in time, May five days late, June not settled", () => {
    eq([month("Provident Fund Payable", "2025-04").values.settledOn, month("Provident Fund Payable", "2025-04").values.late, month("Provident Fund Payable", "2025-04").values.delayDays], ["2025-05-12", false, 0]);
    eq([month("Provident Fund Payable", "2025-05").values.settledOn, month("Provident Fund Payable", "2025-05").values.late, month("Provident Fund Payable", "2025-05").values.delayDays], ["2025-06-20", true, 5]);
    eq(month("Provident Fund Payable", "2025-06").values.settledOn, "");
  });
  await check("an ESI challan paid exactly on the 15th is in time, and every month row states the FIFO order", () => {
    eq([month("ESI Payable", "2025-05").values.settledOn, month("ESI Payable", "2025-05").values.late], ["2025-06-15", false]);
    eq(months.every((r) => r.ruleHits.some((h) => h.rule === "FIFO_APPLIED")), true);
    eq(months.length, 4);
  });
  await check("a payment made after the return was due does not reduce the balance on that date; one before it does", () => {
    eq(due("Provident Fund Payable").values.carriedForwardMinor, rupees(12000));
    eq(due("GST Payable").values.carriedForwardMinor, 0);
    eq(due("TDS Payable").values.carriedForwardMinor, rupees(5000));
  });
  await check("until the next-year payments are typed in, the balance on the return date is unknown - never 'not paid'", async () => {
    const unloaded = await build(vouchers(), {});
    const gst = unloaded.rows.find((r) => r.section === "DUES_OUTSTANDING" && r.values.ledger === "GST Payable");
    eq(gst.values.carriedForwardMinor, null);
    eq(gst.values.nextYearUnknown, true);
    eq(gst.ruleHits.some((h) => h.rule === "NEXT_YEAR_NOT_LOADED"), true);
    const gap = unloaded.rows.find((r) => r.ruleHits[0]?.rule === "NEXT_YEAR_PAYMENTS_NOT_LOADED");
    eq([gap.label, gap.values.count, gap.state], ["PENDING_INPUT: next-year payments not loaded", 6, "PENDING_INPUT"]);
    eq(Boolean(unloaded.rows.find((r) => r.ruleHits[0]?.rule === "NEXT_YEAR_PAYMENTS_NOT_LOADED" && r.section === "INPUT_GAPS")), true);
  });
  await check("with the payments typed in there is no next-year gap", () => {
    eq(Boolean(gaps.find((r) => r.ruleHits[0]?.rule === "NEXT_YEAR_PAYMENTS_NOT_LOADED")), false);
  });
  await check("a cancelled accrual is ignored; a voucher with no date is an unreadable gap, never silently skipped", () => {
    eq(due("ESI Payable"), undefined);
    eq(months.some((r) => r.values.month === "2025-08"), false);
    const gap = gaps.find((r) => r.ruleHits[0]?.rule === "UNREADABLE_VOUCHERS");
    eq([gap.values.count, gap.state, gap.decidable], [1, "PENDING_INPUT", false]);
  });
  await check("with no dues ledger at all the pack says so", async () => {
    const none = await buildClause26Rows({ financialYear: FY, snapshotId: "S1", ledgers: LEDGERS.slice(0, 3), vouchers: asAsync([]), params: {} });
    eq(none.rows.some((r) => r.ruleHits[0]?.rule === "NO_DUES_LEDGERS"), true);
  });
  await check("every due offers four answers, the section 43B proviso among them with a note required", () => {
    eq(dues[0].values.choices.map((c) => c.value), ["REPORT", "PAID_BEFORE_RETURN", "NOT_A_DUE", "OTHER_EXPLAINED"]);
    eq(dues[0].values.choices.find((c) => c.value === "PAID_BEFORE_RETURN").needsNote, true);
  });
  await check("building the same inputs twice gives identical rows; row keys are unique", async () => {
    eq(JSON.stringify((await build()).rows), JSON.stringify((await build()).rows));
    eq(new Set(rows.map((r) => r.rowKey)).size, rows.length);
  });
  return checks;
}

const MUTANTS = [
  { name: "the opening balance is ignored", from: "const closing = (opening ?? 0) + record.credits - record.debits;", to: "const closing = record.credits - record.debits;" },
  { name: "the balance is computed debits-minus-credits", from: "const closing = (opening ?? 0) + record.credits - record.debits;", to: "const closing = (opening ?? 0) + record.debits - record.credits;" },
  { name: "a payment after the return was due still reduces the balance on that date", from: "if (returnDueDay && payment.date > returnDueDay) continue;", to: "if (returnDueDay && payment.date < returnDueDay) continue;" },
  { name: "the 15th of the next month is read as the 1st", from: 'return `${next.y}-${String(next.m).padStart(2, "0")}-15`;', to: 'return `${next.y}-${String(next.m).padStart(2, "0")}-01`;' },
  { name: "a challan paid exactly on the 15th is counted late (> becomes >=)", from: "const late = Boolean(m.settledOn && m.settledOn > m.dueDay);", to: "const late = Boolean(m.settledOn && m.settledOn >= m.dueDay);" },
  { name: "a Duties-and-Taxes ledger with no name match is left out", from: 'if (!rule && ledger.standardGroup === "DUTIES_TAXES") rule = "DUTIES_TAXES_GROUP";', to: 'if (!rule && ledger.standardGroup === "NOTHING") rule = "DUTIES_TAXES_GROUP";' },
  { name: "the balance on the return date ignores the typed payments", from: "const carriedForward = nextYearLoaded ? closing - paidByReturnDay : null;", to: "const carriedForward = nextYearLoaded ? closing : null;" },
];

async function main() {
  const engine = await import("../src/services/audit-pack-engine/clause26.engine.js");
  const checks = await runChecks(engine);
  checks.push(...mutantChecks(await runMutants({ enginePath: new URL("../src/services/audit-pack-engine/clause26.engine.js", import.meta.url), mutants: MUTANTS, runChecks: (m) => runChecks(m) })));

  const uri = process.env.MONGODB_URI || "";
  const scratch = /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(uri) && /scratch/i.test((uri.split("/").pop() || "").split("?")[0]);
  let note = "engine only (no scratch MONGODB_URI)";
  if (scratch) {
    const { runSnapshotPackFlow } = await import("./lib/snapshot-pack-routes.mjs");
    checks.push(...(await runSnapshotPackFlow({
      uri,
      label: "Clause 26",
      kind: "CLAUSE26",
      ledgers: LEDGERS.map((l, i) => ({ name: l.name, parent: l.parent, openingMinor: l.openingMinor, alterId: 100 + i })),
      vouchers: vouchers().map(({ _id, ...v }) => v),
      body: {
        returnDueDay: "2026-10-31",
        nextYearPayments: [
          { ledger: "Provident Fund Payable", date: "2026-11-15", amountMinor: rupees(12000) },
          { ledger: "GST Payable", date: "2026-09-20", amountMinor: rupees(65000) },
        ],
      },
      decide: (row) => (row.decidable ? { state: "CONFIRMED", choice: "REPORT" } : null),
      expect: async ({ run, section }) => {
        const out = [];
        const c = (name, pass, detail = "") => out.push({ name, pass: Boolean(pass), detail });
        c("the run names its three sections", run.sections.map((s) => s.code).join(",") === "DUES_OUTSTANDING,PF_ESI_MONTHS,INPUT_GAPS");
        c("six dues, four provident-fund-and-ESI months and one gap are read by section",
          ["DUES_OUTSTANDING", "PF_ESI_MONTHS", "INPUT_GAPS"].map((s) => `${s}:${section(s).length}`).join(" ") === "DUES_OUTSTANDING:6 PF_ESI_MONTHS:4 INPUT_GAPS:1",
          ["DUES_OUTSTANDING", "PF_ESI_MONTHS", "INPUT_GAPS"].map((s) => `${s}:${section(s).length}`).join(" "));
        c("the typed next-year payments travelled through the create request", section("DUES_OUTSTANDING").some((r) => r.values.ledger === "GST Payable" && r.values.carriedForwardMinor === 0));
        c("a payment after the return date did not reduce its ledger", section("DUES_OUTSTANDING").some((r) => r.values.ledger === "Provident Fund Payable" && r.values.carriedForwardMinor === rupees(12000)));
        c("every due names the rule that found it", section("DUES_OUTSTANDING").every((r) => Boolean(r.values.matchedRule)));
        c("a dues row is decidable; a month row is worked out from the vouchers", section("PF_ESI_MONTHS").every((r) => r.decidable === false) && section("DUES_OUTSTANDING").some((r) => r.decidable));
        c("amounts survive in paise: 65,000 rupees of GST is 6,500,000", section("DUES_OUTSTANDING").some((r) => r.values.closingMinor === 6_500_000));
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
  console.log(`\nclause26-contract: ${checks.length - failed}/${checks.length} passed (${note})`);
  process.exitCode = failed ? 1 : 0;
}

await main();
