// tests/clause31-contract.mjs
//
// W10 AP25 (2026-10-17). Form 3CD clause 31, loans, deposits and cash receipts through a bank (sections 269SS,
// 269T, 269ST): the engine against a hand-worked day book (pure, in paise), nine automated breakages, and - with
// a scratch MongoDB - the same pack through the real routes, the worker and the workbook.
//
// The fixture (FY 2025-26, rupees). Mehta Loan opens at 10,000 credit.
//   10 Apr  Mehta +15,000 cash                 25,000 with the 10,000 outstanding: >= 20,000, cash       FINDING (taken)
//   20 Apr  Rao Deposit +15,000 cash           15,000 with nil outstanding: under 20,000                 -
//   25 Apr  Rao Deposit +6,000 cash            21,000 with 15,000 outstanding                            FINDING (taken)
//    1 May  Mehta +50,000 bank e-Fund Transfer electronic: through a bank                                 -
//    5 May  Mehta +30,000 bank cheque/DD       account payee not shown                                    FINDING (taken)
//   10 May  Mehta +20,000 bank, no transaction type    channel not shown                                  FINDING (taken)
//    1 Jun  Mehta -40,000 cash                 125,000 was outstanding                                    FINDING (repaid)
//    5 Jun  Mehta -25,000 bank e-Fund Transfer through a bank                                             -
//   10 Jun  Rao -5,000 set off against Kapoor (no cash, no bank)   21,000 outstanding                    FINDING (repaid)
//    1 Jul  Director Sanjay +10,000 cash       under 20,000                                               -
//    1 Aug  Director Sanjay +10,000 cash       10,000 + 10,000 = exactly 20,000                           FINDING (taken)
//    2 Jul  Kapoor Traders pays 1,50,000 cash  under 2,00,000                                             -
//    3 Jul  Kapoor Traders pays 1,20,000 + 90,000 cash   2,10,000 in a day, no single receipt over        FINDING (receipt, day limb)
//   10 Jul  Sales cash 2,00,000                exactly 2,00,000: both limbs                               FINDING (receipt)
//   11 Jul  Sales cash 1,99,999.99             under                                                      -
//   Bank of India Term Loan +25,000 cash, with a person's answer "not a lender"                           -
//   a cancelled voucher; one cash voucher with no date                                                    gap of 1
//
// Run: node tests/clause31-contract.mjs
//      MONGODB_URI=mongodb://127.0.0.1:27117/scratch-gates-clause31 node tests/clause31-contract.mjs

import { mutantChecks, runMutants } from "./lib/mutants.mjs";
import { readFileSync, rmSync, writeFileSync } from "node:fs";

const rupees = (value) => Math.round(value * 100);
const FY = "2025-26";

const LEDGERS = [
  { name: "Cash", parent: "Cash-in-Hand", standardGroup: "CASH" },
  { name: "State Bank", parent: "Bank Accounts", standardGroup: "BANK" },
  { name: "Mehta Loan", parent: "Unsecured Loans", standardGroup: "LOANS_UNSECURED", openingMinor: rupees(10000), pan: "BBBBB2222B" },
  { name: "Rao Deposit", parent: "Unsecured Loans", standardGroup: "LOANS_UNSECURED" },
  { name: "Director Sanjay", parent: "Unsecured Loans", standardGroup: "LOANS_UNSECURED" },
  { name: "Bank of India Term Loan", parent: "Secured Loans", standardGroup: "LOANS_SECURED" },
  { name: "Kapoor Traders", parent: "Sundry Debtors", standardGroup: "SUNDRY_DEBTORS" },
  { name: "Sales", parent: "Sales Accounts", standardGroup: "SALES" },
];

let n = 0;
const entry = (ledger, amount) => ({ ledger, amountMinor: rupees(amount) });
const bank = (transactionType) => ({ ledger: "State Bank", instrumentNumber: "1", instrumentDate: null, transactionType, bankName: "State Bank", amountMinor: 0 });
const voucher = (date, entries, extra = {}) => ({ _id: `v${++n}`, guid: `g${n}`, alterId: n, date, type: "Receipt", number: `${n}`, cancelled: false, optional: false, entries, bills: [], banks: [], warnings: [], ...extra });

function vouchers() {
  n = 0;
  return [
    voucher("2025-04-10", [entry("Mehta Loan", 15000), entry("Cash", -15000)]),
    voucher("2025-04-20", [entry("Rao Deposit", 15000), entry("Cash", -15000)]),
    voucher("2025-04-25", [entry("Rao Deposit", 6000), entry("Cash", -6000)]),
    voucher("2025-05-01", [entry("Mehta Loan", 50000), entry("State Bank", -50000)], { banks: [bank("e-Fund Transfer")] }),
    voucher("2025-05-05", [entry("Mehta Loan", 30000), entry("State Bank", -30000)], { banks: [bank("Cheque/DD")] }),
    voucher("2025-05-10", [entry("Mehta Loan", 20000), entry("State Bank", -20000)]),
    voucher("2025-06-01", [entry("Mehta Loan", -40000), entry("Cash", 40000)], { type: "Payment" }),
    voucher("2025-06-05", [entry("Mehta Loan", -25000), entry("State Bank", 25000)], { type: "Payment", banks: [bank("e-Fund Transfer")] }),
    voucher("2025-06-10", [entry("Rao Deposit", -5000), entry("Kapoor Traders", 5000)], { type: "Journal" }),
    voucher("2025-07-01", [entry("Director Sanjay", 10000), entry("Cash", -10000)]),
    voucher("2025-08-01", [entry("Director Sanjay", 10000), entry("Cash", -10000)]),
    voucher("2025-07-02", [entry("Kapoor Traders", 150000), entry("Cash", -150000)]),
    voucher("2025-07-03", [entry("Kapoor Traders", 120000), entry("Cash", -120000)]),
    voucher("2025-07-03", [entry("Kapoor Traders", 90000), entry("Cash", -90000)]),
    voucher("2025-07-10", [entry("Sales", 200000), entry("Cash", -200000)]),
    voucher("2025-07-11", [entry("Sales", 199999.99), entry("Cash", -199999.99)]),
    voucher("2025-07-12", [entry("Bank of India Term Loan", 25000), entry("Cash", -25000)]),
    voucher("2025-07-13", [entry("Mehta Loan", 90000), entry("Cash", -90000)], { cancelled: true }),
    voucher(null, [entry("Mehta Loan", 90000), entry("Cash", -90000)]),
  ];
}

async function* asAsync(list) {
  for (const item of list) yield item;
}

async function runChecks(engine) {
  const { buildClause31Rows } = engine;
  const checks = [];
  const check = (name, fn) =>
    Promise.resolve().then(fn).then(() => checks.push({ name, pass: true })).catch((error) => checks.push({ name, pass: false, detail: String(error.message).split("\n")[0] }));
  const eq = (actual, expected, what = "") => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${what ? `${what}: ` : ""}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };
  const flags = new Map([["bank of india term loan", { lenderOrDepositor: false }]]);
  const build = (list = vouchers(), partyFlags = flags) => buildClause31Rows({ financialYear: FY, snapshotId: "S1", ledgers: LEDGERS, vouchers: asAsync(list), partyFlags });

  const { rows } = await build();
  const of = (section) => rows.filter((r) => r.section === section);
  const taken = of("LOANS_RECEIVED");
  const repaid = of("LOANS_REPAID");
  const receipts = of("RECEIPTS_269ST");
  const lenders = of("LENDERS");
  const find = (list, date, party) => list.find((r) => r.values.date === date && r.values.party === party);

  await check("the limits are the statute's: Rs 20,000 and Rs 2,00,000 in paise", async () => {
    const e = await import("../src/services/audit-pack-engine/clause31.engine.js");
    eq(e.LOAN_LIMIT_MINOR, 2_000_000);
    eq(e.RECEIPT_LIMIT_MINOR, 20_000_000);
  });
  await check("five loans or deposits taken outside a bank, in date order", () => {
    eq(taken.map((r) => `${r.values.date} ${r.values.party}`), [
      "2025-04-10 Mehta Loan", "2025-04-25 Rao Deposit", "2025-05-05 Mehta Loan", "2025-05-10 Mehta Loan", "2025-08-01 Director Sanjay",
    ]);
  });
  await check("a first loan of 15,000 on an account already owing 10,000 is over: the limit counts what is outstanding", () => {
    const row = find(taken, "2025-04-10", "Mehta Loan");
    eq(row.values.amountMinor, rupees(15000));
    eq(row.values.outstandingBeforeMinor, rupees(10000));
    eq(row.values.mode, "CASH");
  });
  await check("15,000 on a nil balance is under the limit; the next 6,000 takes it to 21,000 and is flagged", () => {
    eq(Boolean(find(taken, "2025-04-20", "Rao Deposit")), false);
    eq(find(taken, "2025-04-25", "Rao Deposit").values.outstandingBeforeMinor, rupees(15000));
  });
  await check("exactly 20,000 in all is at the limit: flagged (>=)", () => {
    const row = find(taken, "2025-08-01", "Director Sanjay");
    eq(row.values.outstandingBeforeMinor, rupees(10000));
    eq(Boolean(find(taken, "2025-07-01", "Director Sanjay")), false, "10,000 alone");
  });
  await check("an electronic transfer through the bank is not a finding", () => eq(Boolean(find(taken, "2025-05-01", "Mehta Loan")), false));
  await check("a cheque is a finding that puts the account-payee question; a bank voucher with no channel says so", () => {
    eq(find(taken, "2025-05-05", "Mehta Loan").values.mode, "INSTRUMENT");
    eq(find(taken, "2025-05-05", "Mehta Loan").ruleHits.some((h) => h.rule === "ACCOUNT_PAYEE_UNKNOWN"), true);
    eq(find(taken, "2025-05-10", "Mehta Loan").values.mode, "UNKNOWN_BANK");
    eq(find(taken, "2025-05-10", "Mehta Loan").ruleHits.some((h) => h.rule === "CHANNEL_UNKNOWN"), true);
  });
  await check("two repayments are findings: 40,000 in cash against 125,000 outstanding, and a 5,000 set-off against 21,000", () => {
    eq(repaid.map((r) => `${r.values.date} ${r.values.party} ${r.values.mode}`), ["2025-06-01 Mehta Loan CASH", "2025-06-10 Rao Deposit NON_BANKING"]);
    eq(find(repaid, "2025-06-01", "Mehta Loan").values.outstandingBeforeMinor, rupees(125000));
    eq(find(repaid, "2025-06-10", "Rao Deposit").values.outstandingBeforeMinor, rupees(21000));
  });
  await check("a repayment by e-fund transfer is not a finding", () => eq(Boolean(find(repaid, "2025-06-05", "Mehta Loan")), false));
  await check("a person's answer 'not a lender' leaves a bank loan out", () => {
    eq(taken.some((r) => r.values.party === "Bank of India Term Loan"), false);
    eq(lenders.some((r) => r.values.party === "Bank of India Term Loan"), false);
  });
  await check("without that answer the bank loan is flagged, with the hint that a bank is exempt", async () => {
    const without = await build(vouchers(), new Map());
    const row = without.rows.find((r) => r.section === "LOANS_RECEIVED" && r.values.party === "Bank of India Term Loan");
    eq(Boolean(row), true);
    eq(row.ruleHits.some((h) => h.rule === "HINT_BANK_LENDER"), true);
  });
  await check("cash receipts: 2,10,000 in a day from one payer (no single receipt over) is a day-limb finding", () => {
    const row = find(receipts, "2025-07-03", "Kapoor Traders");
    eq(row.values.amountMinor, rupees(210000));
    eq([row.values.dayLimb, row.values.singleLimb], [true, false]);
    eq(row.values.voucherCount, 2);
  });
  await check("exactly 2,00,000 in one receipt trips both limbs; 1,99,999.99 and 1,50,000 trip neither", () => {
    const row = find(receipts, "2025-07-10", "Sales");
    eq([row.values.dayLimb, row.values.singleLimb], [true, true]);
    eq(Boolean(find(receipts, "2025-07-11", "Sales")), false);
    eq(Boolean(find(receipts, "2025-07-02", "Kapoor Traders")), false);
    eq(receipts.length, 2);
  });
  await check("the one-event limb is stated as the person's to say, not computed", () => {
    eq(find(receipts, "2025-07-03", "Kapoor Traders").ruleHits.some((h) => h.rule === "LIMBS" && /One event or occasion: for you to say/.test(h.detail)), true);
    eq(find(receipts, "2025-07-03", "Kapoor Traders").values.choices.some((c) => c.value === "ONE_EVENT_AGGREGATE"), true);
  });
  await check("each lender account has a summary: opening, taken, repaid, closing, highest, squared up", () => {
    const mehta = lenders.find((r) => r.values.party === "Mehta Loan").values;
    eq([mehta.openingMinor, mehta.takenMinor, mehta.repaidMinor, mehta.closingMinor, mehta.highestMinor, mehta.squaredUp], [rupees(10000), rupees(115000), rupees(65000), rupees(60000), rupees(125000), false]);
    const rao = lenders.find((r) => r.values.party === "Rao Deposit").values;
    eq([rao.openingMinor, rao.takenMinor, rao.repaidMinor, rao.closingMinor, rao.highestMinor], [null, rupees(21000), rupees(5000), rupees(16000), rupees(21000)]);
    eq(lenders.find((r) => r.values.party === "Rao Deposit").ruleHits[0].rule, "OPENING_NOT_GIVEN");
    eq(lenders.map((r) => r.values.party), ["Director Sanjay", "Mehta Loan", "Rao Deposit"]);
  });
  await check("a lender account squared up in the year says so", async () => {
    const squared = await buildClause31Rows({
      financialYear: FY, snapshotId: "S1", ledgers: LEDGERS, partyFlags: new Map(),
      vouchers: asAsync([voucher("2025-04-10", [entry("Rao Deposit", 8000), entry("State Bank", -8000)], { banks: [bank("e-Fund Transfer")] }), voucher("2025-04-12", [entry("Rao Deposit", -8000), entry("State Bank", 8000)], { banks: [bank("e-Fund Transfer")] })]),
    });
    eq(squared.rows.find((r) => r.section === "LENDERS" && r.values.party === "Rao Deposit").values.squaredUp, true);
  });
  await check("a cancelled voucher is ignored; a cash voucher with no date is an input gap, never skipped silently", () => {
    eq(taken.some((r) => r.values.amountMinor === rupees(90000)), false);
    const gap = of("INPUT_GAPS").find((r) => r.ruleHits[0].rule === "UNREADABLE_VOUCHERS");
    eq([gap.values.count, gap.state, gap.decidable], [1, "PENDING_INPUT", false]);
  });
  await check("with no lender account at all the pack says so", async () => {
    const none = await buildClause31Rows({ financialYear: FY, snapshotId: "S1", ledgers: LEDGERS.filter((l) => !String(l.standardGroup).startsWith("LOANS")), vouchers: asAsync([]), partyFlags: new Map() });
    eq(none.rows.some((r) => r.ruleHits[0]?.rule === "NO_LENDER_ACCOUNTS"), true);
  });
  await check("every loan finding offers five answers; a receipt offers six, including one event", () => {
    eq(taken[0].values.choices.map((c) => c.value), ["REPORT", "EXEMPT_LENDER", "ACCOUNT_PAYEE", "NOT_A_LOAN", "OTHER_EXPLAINED"]);
    eq(receipts[0].values.choices.length, 6);
  });
  await check("building the same inputs twice gives identical rows; row keys are unique", async () => {
    eq(JSON.stringify((await build()).rows), JSON.stringify((await build()).rows));
    eq(new Set(rows.map((r) => r.rowKey)).size, rows.length);
  });
  return checks;
}

const MUTANTS = [
  { name: "the limit ignores what is already outstanding", from: 'const aggregate = credit ? sumMinor([outstandingBefore, absolute], "loan with outstanding") : outstandingBefore;', to: "const aggregate = credit ? absolute : outstandingBefore;" },
  { name: "an electronic transfer is treated as not through a bank", from: 'const nonBanking = move.mode !== "ELECTRONIC";', to: "const nonBanking = true;" },
  { name: "cash receipts are judged per voucher, not per payer per day", from: "const key = `${voucher.date}|${norm(entry.ledger)}`;", to: "const key = `${voucher.date}|${norm(entry.ledger)}|${voucher._id}`;" },
  { name: "the day limb needs more than the limit (>= becomes >)", from: "const dayLimb = day.cashMinor >= RECEIPT_LIMIT_MINOR;", to: "const dayLimb = day.cashMinor > RECEIPT_LIMIT_MINOR;" },
  { name: "the single-transaction limb needs more than the limit", from: "const singleLimb = day.largestMinor >= RECEIPT_LIMIT_MINOR;", to: "const singleLimb = day.largestMinor > RECEIPT_LIMIT_MINOR;" },
  { name: "a person's 'not a lender' is ignored", from: "if (flag === false) return false;", to: "" },
  { name: "the loan limit needs more than Rs 20,000 (>= becomes >)", from: "const overLimit = credit ? aggregate >= LOAN_LIMIT_MINOR : outstandingBefore >= LOAN_LIMIT_MINOR;", to: "const overLimit = credit ? aggregate > LOAN_LIMIT_MINOR : outstandingBefore > LOAN_LIMIT_MINOR;" },
  { name: "the running balance adds a repayment instead of taking it off", from: 'balance = sumMinor([balance, amount], "lender balance");', to: 'balance = sumMinor([balance, Math.abs(amount)], "lender balance");' },
];

// A change in the shared voucher kit is checked against this engine too: the mutant kit is written beside the
// kit and a mutant copy of the engine is pointed at it.
const KIT_MUTANTS = [
  { name: "a cheque is treated as an electronic transfer", from: 'if (/cheque|check|\\bdd\\b|draft|demand/.test(type)) kinds.add("INSTRUMENT");', to: 'if (/cheque|check|\\bdd\\b|draft|demand/.test(type)) kinds.add("ELECTRONIC");' },
];

async function main() {
  const engine = await import("../src/services/audit-pack-engine/clause31.engine.js");
  const checks = await runChecks(engine);
  checks.push(...mutantChecks(await runMutants({ enginePath: new URL("../src/services/audit-pack-engine/clause31.engine.js", import.meta.url), mutants: MUTANTS, runChecks: (m) => runChecks(m) })));

  const kitPath = new URL("../src/services/audit-pack-engine/voucher-kit.js", import.meta.url);
  const enginePath = new URL("../src/services/audit-pack-engine/clause31.engine.js", import.meta.url);
  for (const [i, m] of KIT_MUTANTS.entries()) {
    const kitSource = readFileSync(kitPath, "utf8");
    const engineSource = readFileSync(enginePath, "utf8");
    const occurrences = kitSource.split(m.from).length - 1;
    const stamp = `${process.pid}_${i}`;
    const kitMutant = new URL(`../src/services/audit-pack-engine/__mutant_${stamp}_voucher-kit.js`, import.meta.url);
    const engineMutant = new URL(`../src/services/audit-pack-engine/__mutant_${stamp}_clause31.engine.js`, import.meta.url);
    let killedBy = [];
    try {
      if (occurrences !== 1) throw new Error(`the replaced text occurs ${occurrences} times`);
      writeFileSync(kitMutant, kitSource.replace(m.from, () => m.to));
      writeFileSync(engineMutant, engineSource.replace('"./voucher-kit.js"', `"./__mutant_${stamp}_voucher-kit.js"`));
      const module = await import(`${engineMutant.href}?m=${i}`);
      killedBy = (await runChecks(module)).filter((c) => !c.pass).map((c) => c.name);
    } catch (error) {
      killedBy = [`threw: ${String(error.message).split("\n")[0]}`];
    } finally {
      rmSync(kitMutant, { force: true });
      rmSync(engineMutant, { force: true });
    }
    checks.push(...mutantChecks([{ name: m.name, applied: true, killedBy, detail: killedBy.length ? "" : "every check passed with this rule broken" }]));
  }

  const uri = process.env.MONGODB_URI || "";
  const scratch = /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(uri) && /scratch/i.test((uri.split("/").pop() || "").split("?")[0]);
  let note = "engine only (no scratch MONGODB_URI)";
  if (scratch) {
    const { runSnapshotPackFlow } = await import("./lib/snapshot-pack-routes.mjs");
    checks.push(...(await runSnapshotPackFlow({
      uri,
      label: "Clause 31",
      kind: "CLAUSE31",
      ledgers: LEDGERS.map((l, i) => ({ name: l.name, parent: l.parent, openingMinor: l.openingMinor, pan: l.pan || "", alterId: 100 + i })),
      vouchers: vouchers().map(({ _id, ...v }) => v),
      beforeCreate: async ({ raw, A, clientId, oid, now }) => {
        await raw("booksparties").insertOne({
          _id: oid(), firmId: A.firmId, clientId, nameKey: "bank of india term loan", name: "Bank of India Term Loan", standardGroup: "LOANS_SECURED",
          lenderOrDepositor: false, udyamCategory: "UNKNOWN", relatedPerson: null, blanks: [], version: 1, confirmedBy: A.ownerId, confirmedAt: now, createdAt: now, updatedAt: now,
        });
      },
      decide: (row) => (row.decidable ? { state: "CONFIRMED", choice: "REPORT" } : null),
      expect: async ({ run, section }) => {
        const out = [];
        const c = (name, pass, detail = "") => out.push({ name, pass: Boolean(pass), detail });
        const counts = ["LOANS_RECEIVED", "LOANS_REPAID", "RECEIPTS_269ST", "LENDERS"].map((s) => `${s}:${section(s).length}`).join(" ");
        c("the run names its five sections", run.sections.map((s) => s.code).join(",") === "LOANS_RECEIVED,LOANS_REPAID,RECEIPTS_269ST,LENDERS,INPUT_GAPS");
        c("five loans, two repayments, two receipts and three lender summaries are read by section", counts === "LOANS_RECEIVED:5 LOANS_REPAID:2 RECEIPTS_269ST:2 LENDERS:3", counts);
        c("the person's 'not a lender' answer, read from the party master, leaves the bank loan out", !section("LOANS_RECEIVED").some((r) => r.label.includes("Bank of India")));
        c("a lender summary row is not decidable; a finding is", section("LENDERS").every((r) => r.decidable === false) && section("LOANS_RECEIVED").every((r) => r.decidable));
        c("amounts survive in paise: 2,00,000 rupees of receipt is 20,000,000", section("RECEIPTS_269ST").some((r) => r.values.amountMinor === 20_000_000));
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
  console.log(`\nclause31-contract: ${checks.length - failed}/${checks.length} passed (${note})`);
  process.exitCode = failed ? 1 : 0;
}

await main();
