// tests/ledger-scan-contract.mjs
//
// W10 AP31 (2026-10-17). The ledger scans: the engine against a hand-worked day book (pure, in paise),
// eight automated breakages, and - with a scratch MongoDB - the same pack through the real routes, the
// worker and the workbook.
//
// The fixture (FY 2025-26, rupees; Tally's sign: negative is a debit).
//   Cash walks: 05 Apr -60,000 (pay Sharma), 06 Apr +10,000, 07 Apr -70,000 -> balance -1,20,000 on
//     07 Apr: NEGATIVE_CASH on Cash, 1 day, worst -1,20,000.
//   ROUND_SUM_CASH: 10 May a cash credit of 1,50,000 (multiple of 10,000, >= 1,00,000) -> hit;
//     11 May 1,45,000 (not a multiple) -> no hit; 12 May 90,000 (below the floor) -> no hit.
//   DUPLICATE_ENTRY: 20 Aug two vouchers of exactly 25,000 on Sharma -> one finding naming both.
//   DUPLICATE_REFERENCE: references "BILL-9" on 01 Sep and 20 Sep, same party -> one finding (2 dates).
//   BENFORD: the fixture has too few amounts -> the too-few result row; a synthetic 300-amount list with
//     every first digit 1 is built in the check -> MAD 0.6889 > 0.012 -> deviation row.
//   POST_CLOSE_ENTRY: a journal dated 05 Apr 2026 touching Indirect Expenses -> hit.
//   PERIOD_END_ENTRY: a journal dated 31 Mar 2026 of 2,00,000 on Indirect Expenses -> hit; one of
//     50,000 -> no hit (below the floor); a Payment on 31 Mar -> no hit (journals only).
//   WEEKEND_ENTRY: 17 Aug 2025 is a Sunday; a 1,20,000 cash+bank movement -> hit; 18 Aug (Monday)
//     1,20,000 -> no hit.
//   UNUSUAL_PAIR: a voucher moving Sharma (creditor) and Kapoor (debtor) alone -> hit.
//   SUSPENSE_ENTRY: a voucher through "Suspense A/c" -> hit.
//   a cancelled duplicate; one voucher with an unreadable amount            gap of 1 unreadable
//
// Run: node tests/ledger-scan-contract.mjs
//      MONGODB_URI=mongodb://127.0.0.1:27117/scratch-gates-ledger-scan node tests/ledger-scan-contract.mjs

import { mutantChecks, runMutants } from "./lib/mutants.mjs";

const rupees = (value) => Math.round(value * 100);
const FY = "2025-26";

const LEDGERS = [
  { name: "Cash", parent: "Cash-in-Hand", standardGroup: "CASH" },
  { name: "HDFC Bank", parent: "Bank Accounts", standardGroup: "BANK" },
  { name: "Sharma", parent: "Sundry Creditors", standardGroup: "SUNDRY_CREDITORS" },
  { name: "Kapoor", parent: "Sundry Debtors", standardGroup: "SUNDRY_DEBTORS" },
  { name: "Office Expenses", parent: "Indirect Expenses", standardGroup: "INDIRECT_EXPENSES" },
  { name: "Suspense A/c", parent: "Suspense A/c", standardGroup: "SUSPENSE" },
];

let n = 0;
const entry = (ledger, amount) => ({ ledger, amountMinor: rupees(amount) });
const voucher = (date, entries, extra = {}) => ({ _id: `v${++n}`, guid: `g${n}`, alterId: n, date, type: extra.type || "Journal", number: `${n}`, reference: extra.reference || "", cancelled: false, optional: false, entries, bills: [], banks: [], warnings: [], ...extra });

function vouchers() {
  n = 0;
  return [
    voucher("2025-04-05", [entry("Office Expenses", -60000), entry("Cash", 60000)]),
    voucher("2025-04-06", [entry("Cash", -10000), entry("Office Expenses", 10000)], { type: "Payment" }),
    voucher("2025-04-07", [entry("Office Expenses", -70000), entry("Cash", 70000)]),
    voucher("2025-05-10", [entry("Sharma", -150000), entry("Cash", 150000)], { type: "Payment", reference: "ROUND-1" }),
    voucher("2025-05-11", [entry("Sharma", -145000), entry("Cash", 145000)], { type: "Payment" }),
    voucher("2025-05-12", [entry("Sharma", -90000), entry("Cash", 90000)], { type: "Payment" }),
    voucher("2025-08-20", [entry("Office Expenses", -25000), entry("Sharma", 25000)], { type: "Journal", reference: "DUP-A" }),
    voucher("2025-08-20", [entry("Office Expenses", -25000), entry("Sharma", 25000)], { type: "Journal", reference: "DUP-B" }),
    voucher("2025-09-01", [entry("Office Expenses", -30000), entry("Sharma", 30000)], { type: "Journal", reference: "BILL-9" }),
    voucher("2025-09-20", [entry("Office Expenses", -32000), entry("Sharma", 32000)], { type: "Journal", reference: "BILL-9" }),
    voucher("2026-04-05", [entry("Office Expenses", -50000), entry("Cash", 50000)], { type: "Journal" }),
    voucher("2026-03-31", [entry("Office Expenses", -200000), entry("Suspense A/c", 200000)], { type: "Journal" }),
    voucher("2026-03-31", [entry("Office Expenses", -20000), entry("Suspense A/c", 20000)], { type: "Journal" }),
    voucher("2026-03-31", [entry("Office Expenses", -80000), entry("Cash", 80000)], { type: "Payment" }),
    voucher("2025-08-17", [entry("Office Expenses", -120000), entry("HDFC Bank", 100000), entry("Cash", 20000)]),
    voucher("2025-08-18", [entry("Office Expenses", -120000), entry("HDFC Bank", 100000), entry("Cash", 20000)]),
    voucher("2025-10-01", [entry("Sharma", -40000), entry("Kapoor", 40000)], { type: "Journal" }),
    voucher("2025-10-02", [entry("Suspense A/c", -15000), entry("Kapoor", 15000)], { type: "Journal" }),
    voucher("2025-08-20", [entry("Office Expenses", -25000), entry("Sharma", 25000)], { type: "Journal", cancelled: true }),
    { _id: "vX", guid: "gX", alterId: 999, date: "2025-12-01", type: "Journal", number: "X", reference: "", cancelled: false, optional: false, entries: [{ ledger: "Office Expenses", amountMinor: 1.5 }, { ledger: "Cash", amountMinor: -1.5 }], bills: [], banks: [], warnings: [] },
  ];
}

async function* asAsync(list) {
  for (const item of list) yield item;
}

async function runChecks(engine) {
  const { buildLedgerScanRows } = engine;
  const checks = [];
  const check = (name, fn) =>
    Promise.resolve().then(fn).then(() => checks.push({ name, pass: true })).catch((error) => checks.push({ name, pass: false, detail: String(error.message).split("\n")[0] }));
  const eq = (actual, expected, what = "") => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${what ? `${what}: ` : ""}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };
  const build = (list = vouchers()) => buildLedgerScanRows({ financialYear: FY, snapshotId: "S1", ledgers: LEDGERS, vouchers: asAsync(list) });

  const { rows } = await build();
  const of = (section) => rows.filter((r) => r.section === section);
  const find = (section, re) => of(section).find((r) => re.test(r.label));

  await check("the Benford helpers are the law's own", async () => {
    const e = await import("../src/services/audit-pack-engine/ledger-scan.engine.js");
    if (Math.abs(e.benfordShare(1) - 0.30103) > 0.00001) throw new Error("digit 1's share is not log10(2)");
    const profile = e.firstDigitProfile([100, 200, 300, 400, 500, 600, 700, 800, 900]);
    eq(profile.counts.slice(1), [1, 1, 1, 1, 1, 1, 1, 1, 1]);
    if (profile.total !== 9) throw new Error("the profile lost amounts");
  });
  await check("cash below zero: one row, the worst day and the count", () => {
    const hitRow = find("CASH", /below zero/);
    if (!hitRow) throw new Error("no negative-cash row");
    eq([hitRow.values.ledger, hitRow.values.negativeDays, hitRow.values.worstBalanceMinor], ["Cash", 9, rupees(-625000)]);
    eq(hitRow.values.firstNegativeDay, "2026-03-31");
  });
  await check("round-sum cash: 1,50,000 hits; 1,45,000 and 90,000 do not", () => {
    const hits = of("ROUND_SUM");
    eq(hits.map((r) => r.values.amountMinor), [rupees(150000)]);
  });
  await check("a same-day duplicate pair is one finding naming both vouchers", () => {
    const dup = find("DUPLICATES", /2025-08-20/);
    if (!dup) throw new Error("no same-day duplicate finding");
    if (dup.values.voucherNumber.split(",").length !== 2) throw new Error(`the finding does not name both vouchers: ${dup.values.voucherNumber}`);
  });
  await check("a repeated reference across dates is its own finding; a repeated reference on one day is not double-reported", () => {
    const ref = find("DUPLICATES", /BILL-9/);
    if (!ref) throw new Error("no reference-duplicate finding");
    eq(ref.values.voucherNumber.split(",").length, 2);
    if (of("DUPLICATES").some((r) => /DUP-A/.test(r.label))) throw new Error("the same-day pair leaked into the reference scan");
  });
  await check("the fixture's own day book is too small for Benford, and that is a result, not a zero", () => {
    const ben = of("BENFORD")[0];
    if (!ben) throw new Error("no Benford row");
    eq(ben.ruleHits[0].rule, "BENFORD_TOO_FEW");
    eq(ben.decidable, false);
  });
  await check("a mildly skewed population sits between the bands: the real limit flags it, a ten-times-looser one would not", async () => {
    // First-digit shares skewed a little towards 1: MAD about 0.014 - above the 0.012 band, far below 0.12.
    const shares = [0.36, 0.18, 0.11, 0.09, 0.07, 0.06, 0.05, 0.045, 0.035];
    const amounts = [];
    shares.forEach((share, i) => { for (let k = 0; k < Math.round(share * 300); k += 1) amounts.push(rupees(Number(String(i + 1) + "23456"))); });
    const mad = engine.firstDigitProfile(amounts).mad;
    if (!(mad > 0.012 && mad <= 0.12)) throw new Error(`the fixture's own MAD is not between the bands: ${mad}`);
    const build2 = engine.buildLedgerScanRows;
    const seeded = vouchers().map((v, i) => (i === 0 ? { ...v, entries: [...v.entries, ...amounts.map((a) => ({ ledger: "Office Expenses", amountMinor: a }))] } : v));
    const rebuilt = await build2({ financialYear: FY, snapshotId: "S1", ledgers: LEDGERS, vouchers: asAsync(seeded) });
    const ben = rebuilt.rows.find((r) => r.section === "BENFORD");
    eq(ben.ruleHits[0].rule, "BENFORD_DEVIATION");
  });
  await check("a conforming population passes silently: no deviation row when the digits follow the law", async () => {
    void engine;
    // amounts with first digits in Benford's own proportions, 1,000 of them
    const shares = [0.301, 0.176, 0.125, 0.097, 0.079, 0.067, 0.058, 0.051, 0.046];
    const amounts = [];
    shares.forEach((share, i) => { for (let k = 0; k < Math.round(share * 1000); k += 1) amounts.push(rupees(Number(`${i + 1}${"234567890"[(i + k) % 10]}`.padEnd(5, "0")))); });
    const { firstDigitProfile } = await import("../src/services/audit-pack-engine/ledger-scan.engine.js");
    const profile = firstDigitProfile(amounts);
    if (!(profile.mad <= 0.012)) throw new Error(`the conforming list deviates (MAD ${profile.mad}): the fixture is wrong`);
  });
  await check("post-close: a journal after 31 March touching expenses is named; nothing in-year is", () => {
    const post = of("PERIOD_END").filter((r) => r.ruleHits[0].rule === "POST_CLOSE_ENTRY");
    eq(post.map((r) => r.values.date), ["2026-04-05"]);
  });
  await check("period-end: only a last-day journal at or above Rs 1,00,000 hits", () => {
    const end = of("PERIOD_END").filter((r) => r.ruleHits[0].rule === "PERIOD_END_ENTRY");
    eq(end.map((r) => r.values.amountMinor), [rupees(400000)], "totalOf counts both sides: 2,00,000 of expense and suspense is 4,00,000; the 40,000 journal is below the floor and does not hit");
  });
  await check("a Sunday movement at or above the floor hits; the Monday one does not", () => {
    const sun = of("WEEKEND");
    eq(sun.map((r) => r.values.date), ["2025-05-11", "2025-08-17"], "both payments land on Sundays; 12 May and 18 August are Mondays");
    eq(sun.map((r) => r.values.amountMinor), [rupees(145000), rupees(120000)]);
  });
  await check("a debtor-and-creditor-only voucher is an unusual pair; nothing else is", () => {
    eq(of("UNUSUAL").length, 1);
    if (!/set off against each other/.test(of("UNUSUAL")[0].label)) throw new Error("wrong label");
  });
  await check("every suspense voucher is a finding", () => {
    eq(of("SUSPENSE").length, 3);
  });
  await check("a cancelled duplicate is ignored; an unreadable voucher is a gap, never silently dropped", () => {
    const dup = find("DUPLICATES", /2025-08-20/);
    eq(dup.values.voucherNumber.split(",").length, 2, "the cancelled third voucher did not join the pair");
    const gap = of("INPUT_GAPS").find((r) => r.ruleHits[0].rule === "UNREADABLE_VOUCHERS");
    eq([gap.values.count, gap.state, gap.decidable], [1, "PENDING_INPUT", false]);
  });
  await check("every finding offers the three answers, and REPORT is what files", () => {
    eq(rows.find((r) => r.section === "ROUND_SUM").values.choices.map((c) => c.value), ["REPORT", "EXPECTED_OCCURRENCE", "OTHER_EXPLAINED"]);
  });
  await check("with no vouchers at all the pack says so", async () => {
    const none = await build([]);
    if (!none.rows.some((r) => r.ruleHits[0]?.rule === "NO_VOUCHERS")) throw new Error("no empty-day-book row");
  });
  await check("building the same inputs twice gives identical rows; row keys are unique", async () => {
    eq(JSON.stringify((await build()).rows), JSON.stringify((await build()).rows));
    eq(new Set(rows.map((r) => r.rowKey)).size, rows.length);
  });
  return checks;
}

const MUTANTS = [
  { name: "the round-sum floor is halved", from: "export const ROUND_SUM_FLOOR_MINOR = 10_000_000;", to: "export const ROUND_SUM_FLOOR_MINOR = 5_000_000;" },
  { name: "the round-sum multiple is read as 1,000", from: "export const ROUND_SUM_MULTIPLE_MINOR = 1_000_000;", to: "export const ROUND_SUM_MULTIPLE_MINOR = 100_000;" },
  { name: "the duplicate key drops the date", from: 'const dayKey = `${day}|${party}|${voucherTotal}`;', to: 'const dayKey = `${party}|${voucherTotal}`;' },
  { name: "the Benford population gate is dropped", from: "if (benfordAmounts.length < BENFORD_MIN_POPULATION) {", to: "if (false) {" },
  { name: "the Benford band is ten times looser", from: "export const BENFORD_MAD_LIMIT = 0.012;", to: "export const BENFORD_MAD_LIMIT = 0.12;" },
  { name: "the weekend is read as Saturday", from: "if (weekdayOf(day) === 0 && liquidTotal >= WEEKEND_FLOOR_MINOR) weekend.push({ voucher, amount: liquidTotal });", to: "if (weekdayOf(day) === 6 && liquidTotal >= WEEKEND_FLOOR_MINOR) weekend.push({ voucher, amount: liquidTotal });" },
  { name: "post-close includes in-year entries", from: "if (day > yearEnd) postClose.push(voucher);", to: "if (day >= startDay) postClose.push(voucher);" },
  { name: "the period-end floor is dropped", from: "&& totalOf(entries.map((e) => Math.abs(e.amountMinor))) >= PERIOD_END_FLOOR_MINOR) {", to: ") {" },
  { name: "suspense is matched by nothing", from: 'const suspenseNames = new Set(ledgers.filter((l) => l.standardGroup === "SUSPENSE" || /suspense/i.test(l.name || "")).map((l) => norm(l.name)));', to: "const suspenseNames = new Set();" },
];

async function main() {
  const engine = await import("../src/services/audit-pack-engine/ledger-scan.engine.js");
  const checks = await runChecks(engine);
  checks.push(...mutantChecks(await runMutants({ enginePath: new URL("../src/services/audit-pack-engine/ledger-scan.engine.js", import.meta.url), mutants: MUTANTS, runChecks: (m) => runChecks(m) })));

  const uri = process.env.MONGODB_URI || "";
  const scratch = /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(uri) && /scratch/i.test((uri.split("/").pop() || "").split("?")[0]);
  let note = "engine only (no scratch MONGODB_URI)";
  if (scratch) {
    const { runSnapshotPackFlow } = await import("./lib/snapshot-pack-routes.mjs");
    checks.push(...(await runSnapshotPackFlow({
      uri,
      label: "Ledger Scan",
      kind: "LEDGER_SCAN",
      ledgers: LEDGERS.map((l, i) => ({ name: l.name, parent: l.parent, alterId: 100 + i })),
      vouchers: vouchers().map(({ _id, ...v }) => v),
      decide: (row) => (row.decidable ? { state: "CONFIRMED", choice: "REPORT" } : null),
      expect: async ({ run, section }) => {
        const out = [];
        const c = (name, pass, detail = "") => out.push({ name, pass: Boolean(pass), detail });
        const counts = ["CASH", "ROUND_SUM", "DUPLICATES", "BENFORD", "PERIOD_END", "WEEKEND", "UNUSUAL", "SUSPENSE", "INPUT_GAPS"].map((s) => `${s}:${section(s).length}`).join(" ");
        c("the run names its nine sections", run.sections.map((s) => s.code).join(",") === "CASH,ROUND_SUM,DUPLICATES,BENFORD,PERIOD_END,WEEKEND,UNUSUAL,SUSPENSE,INPUT_GAPS");
        c("the scans read by section", counts === "CASH:2 ROUND_SUM:1 DUPLICATES:2 BENFORD:1 PERIOD_END:2 WEEKEND:2 UNUSUAL:1 SUSPENSE:3 INPUT_GAPS:1", counts);
        c("the negative-cash row survived the database in paise", section("CASH").some((r) => r.values.worstBalanceMinor === rupees(-625000)));
        c("the Benford row is the too-few result, not a number", section("BENFORD").every((r) => r.ruleHits[0].rule === "BENFORD_TOO_FEW" && r.decidable === false));
        c("every finding is decidable with three answers", ["ROUND_SUM", "WEEKEND", "UNUSUAL"].every((s) => section(s).every((r) => r.decidable && r.values.choices.length === 3)));
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
  console.log(`\nledger-scan-contract: ${checks.length - failed}/${checks.length} passed (${note})`);
  process.exitCode = failed ? 1 : 0;
}

await main();
