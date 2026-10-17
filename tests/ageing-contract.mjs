// tests/ageing-contract.mjs
//
// W10 AP27 (2026-10-17). The Schedule III ageing schedules - trade receivables, trade payables (micro, small and
// medium apart from the rest) and capital work in progress: the engine against a hand-worked year (pure, in paise),
// the column edges to the day, automated breakages of the engine and of the bill book it stands on, and - with a
// scratch MongoDB - the same pack through the real routes, with and without the previous year's books.
//
// The year is FY 2025-26; the day aged to is 31 March 2026. Days past a bill's basis date (due date where the books
// give a credit period, the bill date where they do not), counted by hand:
//   Alpha Traders (credit period 30 days on the ledger)
//     INV-1  10 Apr  Rs 1,00,000   due 10 May   325 days   6 months to 1 year
//     INV-2  20 Sep  Rs 60,000     due 20 Oct   162 days   under 6 months      Rs 20,000 received 1 Dec: Rs 40,000 left
//     INV-3  20 Mar  Rs 30,000     due 19 Apr   -19 days   not due
//     INV-0   5 Apr  Rs 50,000     settled in full on 1 Jun: nothing left
//   Beta Stores (no credit period: aged from the bill date)
//     INV-9   1 Apr  Rs 10,000     364 days   6 months to 1 year
//     EDGE-180  2 Oct  Rs 1,000    180 days   6 months to 1 year (exactly on the edge: the later column)
//     EDGE-179  3 Oct  Rs 2,000    179 days   under 6 months
//     an advance of Rs 5,000 on 1 Oct (not a bill): a credit balance not aged
//   Gamma Co: Rs 50,000 brought forward, no bills, nothing in the year: the whole balance is in no bill
//   Micro Supplies (micro)   BILL-1  1 Aug  Rs 80,000  credit period 45 on the bill  197 days  6 months to 1 year
//   Medium Mills (medium)    MM-1    1 Oct  Rs 15,000  181 days  6 months to 1 year
//   Big Vendor (not an MSME) PO-1   10 Jan  Rs 2,00,000  80 days  under 6 months
//   Unknown Vendor (category unanswered)  BILL-9  1 Dec  Rs 5,000: cannot be placed
//   Capital Work in Progress: Rs 10,00,000 brought forward, Rs 3,00,000 added on 10 Nov
//
// Run: node tests/ageing-contract.mjs
//      MONGODB_URI=mongodb://127.0.0.1:27117/scratch-gates-ageing node tests/ageing-contract.mjs

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { mutantChecks, runMutants } from "./lib/mutants.mjs";

const rupees = (value) => Math.round(value * 100);
const FY = "2025-26";

const LEDGERS = [
  { name: "Cash", parent: "Cash-in-Hand", standardGroup: "CASH" },
  { name: "State Bank", parent: "Bank Accounts", standardGroup: "BANK" },
  { name: "Sales", parent: "Sales Accounts", standardGroup: "SALES" },
  { name: "Purchases", parent: "Purchase Accounts", standardGroup: "PURCHASE" },
  { name: "Alpha Traders", parent: "Sundry Debtors", standardGroup: "SUNDRY_DEBTORS", creditPeriodDays: 30, pan: "AAAAA1111A" },
  { name: "Beta Stores", parent: "Sundry Debtors", standardGroup: "SUNDRY_DEBTORS" },
  { name: "Gamma Co", parent: "Sundry Debtors", standardGroup: "SUNDRY_DEBTORS", openingMinor: -rupees(50000) },
  { name: "Micro Supplies", parent: "Sundry Creditors", standardGroup: "SUNDRY_CREDITORS" },
  { name: "Medium Mills", parent: "Sundry Creditors", standardGroup: "SUNDRY_CREDITORS" },
  { name: "Big Vendor", parent: "Sundry Creditors", standardGroup: "SUNDRY_CREDITORS" },
  { name: "Unknown Vendor", parent: "Sundry Creditors", standardGroup: "SUNDRY_CREDITORS" },
  { name: "Capital Work in Progress", parent: "Fixed Assets", standardGroup: "FIXED_ASSETS", openingMinor: -rupees(1000000) },
  { name: "Plant and Machinery", parent: "Fixed Assets", standardGroup: "FIXED_ASSETS", openingMinor: -rupees(500000) },
];

const PARTIES = new Map([
  ["micro supplies", { udyamCategory: "MICRO" }],
  ["medium mills", { udyamCategory: "MEDIUM" }],
  ["big vendor", { udyamCategory: "NOT_MSME" }],
]);

let n = 0;
const entry = (ledger, amount) => ({ ledger, amountMinor: rupees(amount) });
const bill = (ledger, name, billType, amount, creditPeriodDays = null) => ({ ledger, name, billType, amountMinor: rupees(amount), creditPeriodDays });
const voucher = (date, entries, extra = {}) => ({ _id: `v${++n}`, guid: `g${n}`, alterId: n, date, type: "Sales", number: `${n}`, cancelled: false, optional: false, entries, bills: [], banks: [], warnings: [], ...extra });
// A debtor is debited (Tally: negative) when we sell; a creditor is credited (positive) when we buy.
const sale = (date, party, name, amount) => voucher(date, [entry(party, -amount), entry("Sales", amount)], { bills: [bill(party, name, "New Ref", amount)] });
const receipt = (date, party, against, amount) => voucher(date, [entry(party, amount), entry("State Bank", -amount)], { type: "Receipt", bills: [bill(party, against, "Agst Ref", amount)] });
const purchase = (date, party, name, amount, credit = null) => voucher(date, [entry(party, amount), entry("Purchases", -amount)], { type: "Purchase", bills: [bill(party, name, "New Ref", amount, credit)] });

function vouchers() {
  n = 0;
  return [
    sale("2025-04-05", "Alpha Traders", "INV-0", 50000),
    receipt("2025-06-01", "Alpha Traders", "INV-0", 50000),
    sale("2025-04-10", "Alpha Traders", "INV-1", 100000),
    sale("2025-09-20", "Alpha Traders", "INV-2", 60000),
    receipt("2025-12-01", "Alpha Traders", "INV-2", 20000),
    sale("2026-03-20", "Alpha Traders", "INV-3", 30000),
    sale("2025-04-01", "Beta Stores", "INV-9", 10000),
    voucher("2025-10-01", [entry("Beta Stores", 5000), entry("State Bank", -5000)], { type: "Receipt", bills: [bill("Beta Stores", "ADV-1", "New Ref", 5000)] }),
    sale("2025-10-02", "Beta Stores", "EDGE-180", 1000),
    sale("2025-10-03", "Beta Stores", "EDGE-179", 2000),
    purchase("2025-08-01", "Micro Supplies", "BILL-1", 80000, 45),
    purchase("2025-10-01", "Medium Mills", "MM-1", 15000),
    purchase("2026-01-10", "Big Vendor", "PO-1", 200000),
    purchase("2025-12-01", "Unknown Vendor", "BILL-9", 5000),
    voucher("2025-11-10", [entry("Capital Work in Progress", -300000), entry("State Bank", 300000)], { type: "Payment" }),
    // A cancelled voucher and an optional one are not the books: neither may move a balance.
    { ...sale("2025-07-01", "Alpha Traders", "INV-X", 999999), cancelled: true },
    { ...sale("2025-07-02", "Alpha Traders", "INV-Y", 888888), optional: true },
  ];
}

const buckets = (obj = {}) => ({ NOT_DUE: 0, LT_6M: 0, M6_1Y: 0, Y1_2: 0, Y2_3: 0, GT_3Y: 0, ...Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, rupees(v)])) });

async function runChecks(engine) {
  const { buildAgeingRows, bucketOf, EDGES_DAYS } = engine;
  const checks = [];
  const check = (name, fn) => Promise.resolve().then(fn).then(() => checks.push({ name, pass: true })).catch((error) => checks.push({ name, pass: false, detail: String(error.message).split("\n")[0] }));
  const eq = (actual, expected, what = "") => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${what ? `${what}: ` : ""}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };
  const build = (extra = {}) => buildAgeingRows({ financialYear: FY, snapshotId: "S1", ledgers: LEDGERS, vouchers: vouchers(), parties: PARTIES, ...extra });
  const { rows } = build();
  const of = (section) => rows.filter((r) => r.section === section);
  const party = (section, name) => of(section).find((r) => r.values.party === name || r.values.ledger === name);
  const gap = (rule) => rows.find((r) => r.section === "INPUT_GAPS" && r.ruleHits[0]?.rule === rule);

  await check("the column edges are the Schedule's: 180, 365, 730 and 1,095 days, and a day on an edge is in the later column", () => {
    eq([...EDGES_DAYS], [180, 365, 730, 1095]);
    eq([-19, -1, 0].map(bucketOf), ["NOT_DUE", "NOT_DUE", "NOT_DUE"], "not due");
    eq([1, 100, 179].map(bucketOf), ["LT_6M", "LT_6M", "LT_6M"], "under 6 months");
    eq([180, 300, 364].map(bucketOf), ["M6_1Y", "M6_1Y", "M6_1Y"], "6 months to 1 year");
    eq([365, 500, 729].map(bucketOf), ["Y1_2", "Y1_2", "Y1_2"], "1 to 2 years");
    eq([730, 900, 1094].map(bucketOf), ["Y2_3", "Y2_3", "Y2_3"], "2 to 3 years");
    eq([1095, 5000].map(bucketOf), ["GT_3Y", "GT_3Y"], "over 3 years");
  });
  await check("a debtor with a credit period is aged from the due date: Alpha's three open bills fall in three columns, and the settled bill is gone", () => {
    const alpha = party("RECEIVABLES", "Alpha Traders");
    eq(alpha.values.buckets, buckets({ M6_1Y: 100000, LT_6M: 40000, NOT_DUE: 30000 }));
    eq([alpha.values.billCount, alpha.values.billsAgedFromDueDate, alpha.values.billsAgedFromBillDate, alpha.values.amountMinor], [3, 3, 0, rupees(170000)]);
    eq(alpha.values.unplacedMinor, 0);
  });
  await check("a part-settled bill is aged on what is left: Rs 60,000 less Rs 20,000 received is Rs 40,000", () => {
    eq(party("RECEIVABLES", "Alpha Traders").values.buckets.LT_6M, rupees(40000));
  });
  await check("a debtor with no credit period is aged from the bill date, and a bill exactly 180 days old is in the later column", () => {
    const beta = party("RECEIVABLES", "Beta Stores");
    eq(beta.values.buckets, buckets({ M6_1Y: 11000, LT_6M: 2000 }));
    eq([beta.values.billsAgedFromDueDate, beta.values.billsAgedFromBillDate], [0, 3]);
  });
  await check("an advance is not a bill: it is named, not aged, and the credit balance it leaves is stated", () => {
    const beta = party("RECEIVABLES", "Beta Stores");
    eq([beta.values.advancesMinor, beta.values.unplacedMinor], [rupees(5000), -rupees(5000)]);
    eq(beta.values.lines.some((l) => /Advances not yet adjusted/.test(l.label) && l.value === rupees(5000)), true);
    eq(beta.values.lines.some((l) => /Credit balance not in any bill/.test(l.label) && l.value === rupees(5000)), true);
  });
  await check("a balance brought forward with no bill behind it is a gap, never spread over the columns", () => {
    eq(Boolean(party("RECEIVABLES", "Gamma Co")), false, "no aged row for Gamma");
    const g = rows.find((r) => r.section === "INPUT_GAPS" && r.values.party === "Gamma Co");
    eq([g.state, g.decidable, g.values.unplacedMinor, g.ruleHits[0].rule], ["PENDING_INPUT", false, rupees(50000), "BALANCE_NOT_IN_BILLS"]);
  });
  await check("micro, small and medium suppliers are listed apart from the others: a medium enterprise counts, and so does the edge at 181 days", () => {
    eq(of("PAYABLES_MSME").map((r) => r.values.party), ["Medium Mills", "Micro Supplies"]);
    eq(party("PAYABLES_MSME", "Micro Supplies").values.buckets, buckets({ M6_1Y: 80000 }));
    eq(party("PAYABLES_MSME", "Medium Mills").values.buckets, buckets({ M6_1Y: 15000 }));
    eq(of("PAYABLES_OTHERS").map((r) => r.values.party), ["Big Vendor"]);
    eq(party("PAYABLES_OTHERS", "Big Vendor").values.buckets, buckets({ LT_6M: 200000 }));
  });
  await check("a creditor's closing balance is read on its own side: fully billed suppliers have nothing in no bill, and one with only an opening balance has all of it", () => {
    eq([party("PAYABLES_MSME", "Micro Supplies").values.amountMinor, party("PAYABLES_MSME", "Micro Supplies").values.unplacedMinor], [rupees(80000), 0]);
    eq([party("PAYABLES_OTHERS", "Big Vendor").values.amountMinor, party("PAYABLES_OTHERS", "Big Vendor").values.unplacedMinor], [rupees(200000), 0]);
    eq([party("RECEIVABLES", "Alpha Traders").values.amountMinor, party("RECEIVABLES", "Alpha Traders").values.unplacedMinor], [rupees(170000), 0]);
    const opened = LEDGERS.map((l) => (l.name === "Big Vendor" ? { ...l, openingMinor: rupees(25000) } : l));
    const g = build({ ledgers: opened }).rows.find((r) => r.section === "INPUT_GAPS" && r.values.party === "Big Vendor");
    eq([g.values.unplacedMinor, g.ruleHits[0].rule], [rupees(25000), "BALANCE_NOT_IN_BILLS"]);
  });
  await check("a credit period on the bill itself is used before the ledger's: Micro Supplies' bill carries 45 days", () => {
    eq(party("PAYABLES_MSME", "Micro Supplies").values.billsAgedFromDueDate, 1);
  });
  await check("a supplier whose Udyam category is unanswered cannot be placed: a gap, and no guess in either list", () => {
    eq(Boolean(party("PAYABLES_MSME", "Unknown Vendor") || party("PAYABLES_OTHERS", "Unknown Vendor")), false);
    const g = gap("UDYAM_CATEGORY_UNANSWERED");
    eq([g.state, g.decidable, g.values.party], ["PENDING_INPUT", false, "Unknown Vendor"]);
  });
  await check("capital work in progress shows its movement and asks for the ageing by project: opening, added, closing in paise", () => {
    const cwip = of("CWIP");
    eq(cwip.length, 1, "only the work-in-progress ledger, not Plant and Machinery");
    const row = cwip[0];
    eq([row.values.openingMinor, row.values.additionsMinor, row.values.closingMinor, row.state], [rupees(1000000), rupees(300000), rupees(1300000), "PENDING_INPUT"]);
    eq(row.ruleHits[0].rule, "CWIP_AGEING_BY_PROJECT");
    eq(row.allSources.some((s) => s.kind === "BOOKS_LEDGER") && row.allSources.some((s) => s.kind === "BOOKS_VOUCHER"), true);
  });
  await check("a cancelled voucher and an optional one never move a balance: Alpha's bills are exactly the three above", () => {
    eq(party("RECEIVABLES", "Alpha Traders").values.billCount, 3);
  });
  await check("the previous year's books trace a balance brought forward to its bill: Rs 70,000 raised in January becomes a 1 to 2 year bill and the gap goes", () => {
    const ledgers = LEDGERS.map((l) => (l.name === "Alpha Traders" ? { ...l, openingMinor: -rupees(70000) } : l));
    const priorVouchers = [sale("2025-01-15", "Alpha Traders", "OLD-1", 70000)];
    const withPrior = build({ ledgers, priorVouchers, priorFinancialYear: "2024-25" }).rows;
    const alpha = withPrior.find((r) => r.section === "RECEIVABLES" && r.values.party === "Alpha Traders");
    eq(alpha.values.buckets, buckets({ Y1_2: 70000, M6_1Y: 100000, LT_6M: 40000, NOT_DUE: 30000 }));
    eq(withPrior.some((r) => r.section === "INPUT_GAPS" && r.values.party === "Alpha Traders"), false, "no gap with the prior year");
    const without = build({ ledgers }).rows;
    const g = without.find((r) => r.section === "INPUT_GAPS" && r.values.party === "Alpha Traders");
    eq([g.values.unplacedMinor, g.ruleHits[0].rule], [rupees(70000), "BALANCE_NOT_IN_BILLS"], "the same opening is a gap without it");
  });
  await check("ledgers under a group nobody has mapped are named, because they could be debtors or creditors", () => {
    const withUnmapped = build({ ledgers: [...LEDGERS, { name: "Mystery Ledger", parent: "Mystery", standardGroup: null }] }).rows;
    const g = withUnmapped.find((r) => r.ruleHits[0]?.rule === "GROUPS_NOT_MAPPED");
    eq([g.state, g.values.count], ["PENDING_INPUT", 1]);
  });
  await check("a voucher on a party ledger with no readable date or amount is counted, not skipped silently", () => {
    const withBad = build({ vouchers: [...vouchers(), { ...sale("2025-05-05", "Alpha Traders", "INV-Z", 1), date: null }] }).rows;
    eq(withBad.find((r) => r.ruleHits[0]?.rule === "UNREADABLE_VOUCHERS").values.count, 1);
  });
  await check("every row answers with the choices the schedule needs: four classifications for a debtor, two for a creditor", () => {
    eq(party("RECEIVABLES", "Alpha Traders").values.choices.map((c) => c.value), ["UNDISPUTED_GOOD", "UNDISPUTED_DOUBTFUL", "DISPUTED_GOOD", "DISPUTED_DOUBTFUL"]);
    eq(party("PAYABLES_OTHERS", "Big Vendor").values.choices.map((c) => c.value), ["UNDISPUTED", "DISPUTED"]);
  });
  await check("every aged row can be walked back to its vouchers and the same inputs give the same rows in the same order", () => {
    for (const r of [...of("RECEIVABLES"), ...of("PAYABLES_MSME"), ...of("PAYABLES_OTHERS")]) eq(r.sourceEvidenceCount > 0 && r.decidable, true, r.label);
    eq(JSON.stringify(build().rows), JSON.stringify(build().rows));
    eq(new Set(rows.map((r) => r.rowKey)).size, rows.length);
  });
  return checks;
}

const MUTANTS = [
  { name: "the six-month edge is read as 'up to and including 180 days'", from: "if (days < EDGES_DAYS[0]) return \"LT_6M\";", to: "if (days <= EDGES_DAYS[0]) return \"LT_6M\";" },
  { name: "the one-year edge moves a day", from: "export const EDGES_DAYS = Object.freeze([180, 365, 730, 1_095]);", to: "export const EDGES_DAYS = Object.freeze([180, 366, 730, 1_095]);" },
  { name: "a bill due today counts as overdue", from: "if (days <= 0) return \"NOT_DUE\";", to: "if (days < 0) return \"NOT_DUE\";" },
  { name: "the credit period is ignored and every bill is aged from its date", from: "const basisDay = creditDays === null ? bill.day : addDays(bill.day, creditDays);", to: "const basisDay = bill.day;" },
  { name: "a medium enterprise is not counted as one", from: 'const MSME_CATEGORIES = new Set(["MICRO", "SMALL", "MEDIUM"]);', to: 'const MSME_CATEGORIES = new Set(["MICRO", "SMALL"]);' },
  { name: "an unanswered category is aged as 'others' instead of being a gap", from: 'const classified = isReceivable || msme || udyam === "NOT_MSME";', to: "const classified = true;" },
  { name: "the part of a balance in no bill is added instead of taken off", from: 'const unplaced = sumMinor([naturalClosing, -placed], "unplaced");', to: 'const unplaced = sumMinor([naturalClosing, placed], "unplaced");' },
  { name: "a ledger on the credit side is read with the debit side's sign", from: 'const naturalClosing = side === "CREDIT" ? signedClosing : -signedClosing;', to: "const naturalClosing = -signedClosing;" },
  { name: "the previous year's vouchers are not read even when supplied", from: "const prior = priorVouchers && priorFinancialYear ? live(priorVouchers, priorFinancialYear) : [];", to: "const prior = [];" },
  { name: "a cancelled voucher counts", from: "const live = (list, year) => [...list].filter((v) => countsInYear(v, year));", to: "const live = (list, year) => [...list];" },
];

// The bill book is shared; a change in it is checked against this engine too (the mutant copy is written beside it
// and a mutant copy of the engine is pointed at it).
const BOOK_MUTANTS = [
  { name: "what a bill has been settled by is ignored", from: "export const outstandingOf = (bill) => Math.max(0, bill.principalMinor - bill.settledMinor);", to: "export const outstandingOf = (bill) => bill.principalMinor;" },
  { name: "a settlement is recorded but never reduces the bill", from: 'bill.settledMinor = sumMinor([bill.settledMinor, applied], "settled");', to: "bill.settledMinor = bill.settledMinor;" },
  { name: "vouchers are applied newest first, so a settlement is seen before its bill", from: "String(a.date).localeCompare(String(b.date))", to: "String(b.date).localeCompare(String(a.date))" },
];

async function main() {
  const enginePath = new URL("../src/services/audit-pack-engine/ageing.engine.js", import.meta.url);
  const engine = await import(enginePath.href);
  const checks = await runChecks(engine);
  checks.push(...mutantChecks(await runMutants({ enginePath, mutants: MUTANTS, runChecks: (m) => runChecks(m) })));

  const bookPath = new URL("../src/services/audit-pack-engine/bill-book.js", import.meta.url);
  for (const [i, m] of BOOK_MUTANTS.entries()) {
    const bookSource = readFileSync(bookPath, "utf8");
    const engineSource = readFileSync(enginePath, "utf8");
    const occurrences = bookSource.split(m.from).length - 1;
    const stamp = `${process.pid}_${i}`;
    const bookMutant = new URL(`../src/services/audit-pack-engine/__mutant_${stamp}_bill-book.js`, import.meta.url);
    const engineMutant = new URL(`../src/services/audit-pack-engine/__mutant_${stamp}_ageing.engine.js`, import.meta.url);
    let killedBy = [];
    try {
      if (occurrences !== 1) throw new Error(`the replaced text occurs ${occurrences} times`);
      writeFileSync(bookMutant, bookSource.replace(m.from, () => m.to));
      writeFileSync(engineMutant, engineSource.replace('"./bill-book.js"', `"./__mutant_${stamp}_bill-book.js"`));
      const module = await import(`${engineMutant.href}?m=${i}`);
      killedBy = (await runChecks(module)).filter((c) => !c.pass).map((c) => c.name);
    } catch (error) {
      killedBy = [`threw: ${String(error.message).split("\n")[0]}`];
    } finally {
      rmSync(bookMutant, { force: true });
      rmSync(engineMutant, { force: true });
    }
    checks.push(...mutantChecks([{ name: `bill book: ${m.name}`, applied: true, killedBy, detail: killedBy.length ? "" : "every check passed with this rule broken" }]));
  }

  const uri = process.env.MONGODB_URI || "";
  const scratch = /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(uri) && /scratch/i.test((uri.split("/").pop() || "").split("?")[0]);
  let note = "engine only (no scratch MONGODB_URI)";
  if (scratch) {
    const { runSnapshotPackFlow } = await import("./lib/snapshot-pack-routes.mjs");
    const plain = (l, i) => ({ name: l.name, parent: l.parent, openingMinor: l.openingMinor, pan: l.pan || "", creditPeriodDays: l.creditPeriodDays ?? null, alterId: 100 + i });
    const parties = async ({ raw, A, clientId, oid, now }) => {
      for (const [key, p] of PARTIES) {
        await raw("booksparties").insertOne({
          _id: oid(), firmId: A.firmId, clientId, nameKey: key, name: key, standardGroup: "SUNDRY_CREDITORS", lenderOrDepositor: null,
          udyamCategory: p.udyamCategory, relatedPerson: null, blanks: [], version: 1, confirmedBy: A.ownerId, confirmedAt: now, createdAt: now, updatedAt: now,
        });
      }
    };
    const decide = (row) => {
      if (row.section === "CWIP") return { state: "EXCLUDED", reason: "The ageing by project is given in the notes to the accounts" };
      if (!row.decidable) return null;
      return { state: "CONFIRMED", choice: row.section === "RECEIVABLES" ? "UNDISPUTED_GOOD" : "UNDISPUTED" };
    };
    checks.push(...(await runSnapshotPackFlow({
      uri,
      label: "Ageing",
      kind: "SCHEDULE3_AGEING",
      ledgers: LEDGERS.map(plain),
      vouchers: vouchers().map(({ _id, ...v }) => v),
      beforeCreate: parties,
      decide,
      expectedWorkbookSheets: ["For filing"],
      expect: async ({ run, section, call, A, snapshotId, clientId, readWorkbookParts, runId }) => {
        const out = [];
        const c = (name, pass, detail = "") => out.push({ name, pass: Boolean(pass), detail });
        const counts = ["RECEIVABLES", "PAYABLES_MSME", "PAYABLES_OTHERS", "CWIP", "INPUT_GAPS"].map((s) => `${s}:${section(s).length}`).join(" ");
        c("the run names its five sections", run.sections.map((s) => s.code).join(",") === "RECEIVABLES,PAYABLES_MSME,PAYABLES_OTHERS,CWIP,INPUT_GAPS", run.sections.map((s) => s.code).join(","));
        c("two debtors, two MSME creditors, one other creditor, one work-in-progress row and two gaps are read by section", counts === "RECEIVABLES:2 PAYABLES_MSME:2 PAYABLES_OTHERS:1 CWIP:1 INPUT_GAPS:2", counts);
        c("the parties' Udyam answers are read from the party master, not guessed", section("PAYABLES_MSME").map((r) => r.values.party).join(",") === "Medium Mills,Micro Supplies");
        c("amounts survive the database in paise: Big Vendor's Rs 2,00,000 is 20,000,000", section("PAYABLES_OTHERS")[0]?.values.buckets?.LT_6M === 20_000_000);
        c("a gap row is not decidable and a party row is", section("INPUT_GAPS").every((r) => r.decidable === false) && section("RECEIVABLES").every((r) => r.decidable));
        const same = await call("POST", "/api/audit-packs", A.token, { kind: "SCHEDULE3_AGEING", clientId: String(clientId), financialYear: FY, snapshotId, priorSnapshotId: snapshotId });
        c("a prior-year snapshot that is the same export is refused", same.status === 400, `status ${same.status} ${JSON.stringify(same.json)?.slice(0, 160)}`);
        void readWorkbookParts; void runId;
        return out;
      },
    })));
    // The previous year's books, as a second snapshot of the year before: the balance brought forward gets its bill.
    const priorLedgers = LEDGERS.map((l) => (l.name === "Alpha Traders" ? { ...l, openingMinor: -rupees(70000) } : l));
    checks.push(...(await runSnapshotPackFlow({
      uri,
      label: "Ageing prior",
      kind: "SCHEDULE3_AGEING",
      ledgers: priorLedgers.map(plain),
      vouchers: vouchers().map(({ _id, ...v }) => v),
      priorSnapshot: { financialYear: "2024-25", ledgers: LEDGERS.map(plain), vouchers: [sale("2025-01-15", "Alpha Traders", "OLD-1", 70000)].map(({ _id, ...v }) => v) },
      beforeCreate: parties,
      decide,
      expect: async ({ section }) => {
        const out = [];
        const alpha = section("RECEIVABLES").find((r) => r.values.party === "Alpha Traders");
        out.push({ name: "with the year before read too, the balance brought forward is a 1 to 2 year bill and Alpha has no gap", pass: alpha?.values.buckets?.Y1_2 === 7_000_000 && !section("INPUT_GAPS").some((r) => r.values.party === "Alpha Traders"), detail: JSON.stringify(alpha?.values.buckets) });
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
  console.log(`\nageing-contract: ${checks.length - failed}/${checks.length} passed (${note})`);
  process.exitCode = failed ? 1 : 0;
}

await main();
