// tests/clause21d-contract.mjs
//
// W10 AP22 (2026-10-17). Form 3CD clause 21(d), cash payments above the section 40A(3) limit: the engine
// against a hand-worked day book (pure, in paise), six deliberate breakages each caught by a named check, and -
// with a scratch MongoDB - the same pack through the real routes, the worker and the workbook.
//
// The fixture (FY 2025-26; amounts in rupees; every expected figure worked by hand):
//   15 Apr  Asha Fabrics paid 6,000 cash + 6,000 cash the same day           -> 12,000 in a day: OVER 10,000
//   16 Apr  Asha Fabrics 10,000 cash                                          -> exactly the limit: not over
//   16 Apr  Fast Transport (a transporter) 30,000 cash                        -> under 35,000: not over
//   17 Apr  Fast Transport 36,000 cash                                        -> OVER 35,000
//    1 May  Rent 15,000: 5,000 cash + 10,000 bank                              -> cash share 5,000: not over
//    2 May  Rent 24,000: 12,000 cash + 12,000 bank                              -> cash share 12,000: OVER
//    3 May  GST Payable 50,000 cash                                             -> OVER (hint: Government)
//    4 May  Contra: cash 40,000 into the bank                                   -> a contra, not a payment
//    5 May  Mehta Loan repaid 25,000 cash                                       -> OVER (hint: loan)
//    6 May  cancelled voucher, 20,000 cash                                      -> ignored
//    7 May  optional (memorandum) voucher, 20,000 cash                          -> ignored
//   31 Mar 2025  Asha 20,000 cash (the previous year)                           -> ignored
//    1 Jun  Mystery Ledger (group not known) 20,000 cash                         -> OVER (group unknown), and a gap row
//    2 Jun  Asha 8,000 + Rent 8,000 from one 16,000 cash voucher                 -> 8,000 each: not over
//   no date / unreadable amount, both moving cash                                 -> an input gap of 2
//
// Run: node tests/clause21d-contract.mjs
//      MONGODB_URI=mongodb://127.0.0.1:27117/scratch-gates-clause21d node tests/clause21d-contract.mjs

import { mutantChecks, runMutants } from "./lib/mutants.mjs";

const rupees = (value) => Math.round(value * 100);
const FY = "2025-26";

const LEDGERS = [
  { name: "Cash", parent: "Cash-in-Hand", standardGroup: "CASH" },
  { name: "State Bank", parent: "Bank Accounts", standardGroup: "BANK" },
  { name: "Asha Fabrics", parent: "Sundry Creditors", standardGroup: "SUNDRY_CREDITORS", pan: "AAAAA1111A" },
  { name: "Fast Transport", parent: "Sundry Creditors", standardGroup: "SUNDRY_CREDITORS" },
  { name: "Rent", parent: "Indirect Expenses", standardGroup: "INDIRECT_EXPENSES" },
  { name: "GST Payable", parent: "Duties & Taxes", standardGroup: "DUTIES_TAXES" },
  { name: "Mehta Loan", parent: "Unsecured Loans", standardGroup: "LOANS_UNSECURED" },
  { name: "Mystery Ledger", parent: "Nowhere", standardGroup: null },
];

let n = 0;
const entry = (ledger, rupeesAmount) => ({ ledger, amountMinor: rupees(rupeesAmount) });
const voucher = (date, entries, extra = {}) => ({ _id: `v${++n}`, guid: `g${n}`, alterId: n, date, type: "Payment", number: `${n}`, narration: "", cancelled: false, optional: false, entries, bills: [], banks: [], warnings: [], ...extra });

function vouchers() {
  n = 0;
  return [
    voucher("2025-04-15", [entry("Asha Fabrics", -6000), entry("Cash", 6000)]),
    voucher("2025-04-15", [entry("Asha Fabrics", -6000), entry("Cash", 6000)]),
    voucher("2025-04-16", [entry("Asha Fabrics", -10000), entry("Cash", 10000)]),
    voucher("2025-04-16", [entry("Fast Transport", -30000), entry("Cash", 30000)]),
    voucher("2025-04-17", [entry("Fast Transport", -36000), entry("Cash", 36000)]),
    voucher("2025-05-01", [entry("Rent", -15000), entry("Cash", 5000), entry("State Bank", 10000)]),
    voucher("2025-05-02", [entry("Rent", -24000), entry("Cash", 12000), entry("State Bank", 12000)]),
    voucher("2025-05-03", [entry("GST Payable", -50000), entry("Cash", 50000)]),
    voucher("2025-05-04", [entry("State Bank", -40000), entry("Cash", 40000)], { type: "Contra" }),
    voucher("2025-05-05", [entry("Mehta Loan", -25000), entry("Cash", 25000)]),
    voucher("2025-05-06", [entry("Asha Fabrics", -20000), entry("Cash", 20000)], { cancelled: true }),
    voucher("2025-05-07", [entry("Asha Fabrics", -20000), entry("Cash", 20000)], { optional: true }),
    voucher("2025-03-31", [entry("Asha Fabrics", -20000), entry("Cash", 20000)]),
    voucher("2025-06-01", [entry("Mystery Ledger", -20000), entry("Cash", 20000)]),
    voucher("2025-06-02", [entry("Asha Fabrics", -8000), entry("Rent", -8000), entry("Cash", 16000)]),
    voucher(null, [entry("Asha Fabrics", -20000), entry("Cash", 20000)]),
    voucher("2025-06-03", [{ ledger: "Asha Fabrics", amountMinor: null }, entry("Cash", 20000)]),
  ];
}

async function* asAsync(list) {
  for (const item of list) yield item;
}

async function runChecks(engine) {
  const { buildClause21dRows, CASH_LIMIT_MINOR, TRANSPORTER_LIMIT_MINOR, formatRupees } = engine;
  const checks = [];
  const check = (name, fn) => {
    return Promise.resolve()
      .then(fn)
      .then(() => checks.push({ name, pass: true }))
      .catch((error) => checks.push({ name, pass: false, detail: String(error.message).split("\n")[0] }));
  };
  const eq = (actual, expected, what = "") => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${what ? `${what}: ` : ""}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };
  const build = (list = vouchers(), params = { transporterLedgers: ["Fast Transport"] }) =>
    buildClause21dRows({ financialYear: FY, snapshotId: "S1", ledgers: LEDGERS, vouchers: asAsync(list), params });

  const result = await build();
  const findings = result.rows.filter((r) => r.section === "CASH_PAYMENTS");
  const gaps = result.rows.filter((r) => r.section === "INPUT_GAPS");
  const byKey = (date, payee) => findings.find((r) => r.values.date === date && r.values.payee === payee);

  await check("the limits are the statute's: Rs 10,000 and Rs 35,000 in paise", () => {
    eq(CASH_LIMIT_MINOR, 1_000_000);
    eq(TRANSPORTER_LIMIT_MINOR, 3_500_000);
  });
  await check("exactly six findings, in date order", () => {
    eq(findings.map((r) => `${r.values.date} ${r.values.payee}`), [
      "2025-04-15 Asha Fabrics", "2025-04-17 Fast Transport", "2025-05-02 Rent", "2025-05-03 GST Payable", "2025-05-05 Mehta Loan", "2025-06-01 Mystery Ledger",
    ]);
  });
  await check("two vouchers of 6,000 on one day to one payee are 12,000, over the limit (payments are added up per payee per day)", () => {
    const row = byKey("2025-04-15", "Asha Fabrics");
    eq(row.values.amountMinor, rupees(12000));
    eq(row.values.voucherCount, 2);
    eq(row.sourceEvidenceCount, 2);
  });
  await check("exactly Rs 10,000 is not over the limit", () => eq(Boolean(byKey("2025-04-16", "Asha Fabrics")), false));
  await check("a transporter has Rs 35,000: 30,000 is not over, 36,000 is", () => {
    eq(Boolean(byKey("2025-04-16", "Fast Transport")), false);
    const row = byKey("2025-04-17", "Fast Transport");
    eq(row.values.amountMinor, rupees(36000));
    eq(row.values.limitMinor, rupees(35000));
    eq(row.values.transporter, true);
  });
  await check("a part-cash voucher counts only its cash share: 5,000 of 15,000 is not over, 12,000 of 24,000 is", () => {
    eq(Boolean(byKey("2025-05-01", "Rent")), false);
    const row = byKey("2025-05-02", "Rent");
    eq(row.values.amountMinor, rupees(12000));
    eq(row.ruleHits.some((h) => h.rule === "PART_CASH_SHARE"), true);
  });
  await check("a contra (cash banked) is not a payment to anyone", () => eq(findings.some((r) => r.values.date === "2025-05-04"), false));
  await check("a cancelled voucher and an optional voucher are not counted", () => {
    eq(findings.some((r) => r.values.date === "2025-05-06" || r.values.date === "2025-05-07"), false);
  });
  await check("a voucher of the previous financial year is not counted", () => eq(findings.some((r) => r.values.date === "2025-03-31"), false));
  await check("one cash voucher split across two payees is judged per payee, not in total", () => {
    eq(findings.some((r) => r.values.date === "2025-06-02"), false);
  });
  await check("a payment to the Government gets the Rule 6DD hint; a loan repayment is sent to clause 31", () => {
    eq(byKey("2025-05-03", "GST Payable").ruleHits.some((h) => h.rule === "HINT_GOVERNMENT_OR_BANK"), true);
    eq(byKey("2025-05-05", "Mehta Loan").ruleHits.some((h) => h.rule === "HINT_LOAN_REPAYMENT"), true);
  });
  await check("a payee whose group is not known is still found, says so, and is listed as an input gap", () => {
    const row = byKey("2025-06-01", "Mystery Ledger");
    eq(row.values.payeeGroup, null);
    eq(row.ruleHits.some((h) => h.rule === "HINT_GROUP_UNKNOWN"), true);
    eq(gaps.some((g) => g.ruleHits[0].rule === "UNMAPPED_PAYEES" && g.state === "PENDING_INPUT" && g.decidable === false), true);
  });
  await check("a cash voucher with no date, and one with an unreadable amount, are two input gaps - never skipped silently", () => {
    const gap = gaps.find((g) => g.ruleHits[0].rule === "UNREADABLE_CASH_VOUCHERS");
    eq(gap.values.count, 2);
  });
  await check("the payee's PAN comes from the ledger", () => eq(byKey("2025-04-15", "Asha Fabrics").values.pan, "AAAAA1111A"));
  await check("every finding offers the five answers, three of them needing a note", () => {
    const row = byKey("2025-04-15", "Asha Fabrics");
    eq(row.values.choices.map((c) => c.value), ["REPORT", "EXCEPTION_6DD", "NOT_EXPENDITURE", "BANK_CHANNEL", "OTHER_EXPLAINED"]);
    eq(row.values.choices.filter((c) => c.needsNote).length, 4);
  });
  await check("with no cash ledger at all the pack says so instead of reporting nothing", async () => {
    const noCash = await buildClause21dRows({ financialYear: FY, snapshotId: "S1", ledgers: LEDGERS.filter((l) => l.name !== "Cash"), vouchers: asAsync(vouchers()), params: {} });
    eq(noCash.rows.some((r) => r.ruleHits[0]?.rule === "NO_CASH_LEDGER"), true);
  });
  await check("building the same inputs twice gives identical rows", async () => {
    eq(JSON.stringify((await build()).rows), JSON.stringify((await build()).rows));
  });
  await check("row keys are unique", () => eq(new Set(result.rows.map((r) => r.rowKey)).size, result.rows.length));
  await check("the rupee text groups in the Indian way", () => {
    eq(formatRupees(123456789), "₹12,34,567.89");
    eq(formatRupees(-500), "-₹5.00");
    eq(formatRupees(100_000_000_00), "₹10,00,00,000.00");
  });
  return checks;
}

const MUTANTS = [
  { name: "a payment of exactly the limit is flagged (> becomes >=)", from: "if (day.cashMinor <= limit) continue;", to: "if (day.cashMinor < limit) continue;" },
  { name: "the transporter limit is ignored", from: "const limit = transporter ? TRANSPORTER_LIMIT_MINOR : CASH_LIMIT_MINOR;", to: "const limit = CASH_LIMIT_MINOR;" },
  { name: "payments are judged per voucher instead of per payee per day", from: "const key = `${voucher.date}|${norm(entry.ledger)}`;", to: "const key = `${voucher.date}|${norm(entry.ledger)}|${voucher._id}`;" },
  { name: "a part-cash voucher counts its whole debit as cash", from: "const shares = proportionalShares(cashOut, debits.map((e) => -e.amountMinor));", to: "const shares = debits.map((e) => -e.amountMinor);" },
  { name: "a cancelled voucher is counted", from: "if (voucher.cancelled || voucher.optional) continue;", to: "if (voucher.optional) continue;" },
  { name: "the previous year's vouchers are counted", from: "if (voucher.date && !dateInYear(voucher.date, financialYear)) continue;", to: "" },
  { name: "a contra into the bank is treated as a payment", from: 'if (group === "BANK") return;', to: "" },
];

async function main() {
  const engine = await import("../src/services/audit-pack-engine/clause21d.engine.js");
  const checks = await runChecks(engine);
  checks.push(...mutantChecks(await runMutants({
    enginePath: new URL("../src/services/audit-pack-engine/clause21d.engine.js", import.meta.url),
    mutants: MUTANTS,
    runChecks: (module) => runChecks(module),
  })));

  const uri = process.env.MONGODB_URI || "";
  const scratch = /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(uri) && /scratch/i.test((uri.split("/").pop() || "").split("?")[0]);
  let note = "engine only (no scratch MONGODB_URI)";
  if (scratch) {
    const { runSnapshotPackFlow } = await import("./lib/snapshot-pack-routes.mjs");
    const ledgerDocs = LEDGERS.map((l, i) => ({ name: l.name, parent: l.parent, pan: l.pan || "", alterId: 100 + i }));
    checks.push(...(await runSnapshotPackFlow({
      uri,
      label: "Clause 21d",
      kind: "CLAUSE21D",
      ledgers: ledgerDocs,
      vouchers: vouchers().map(({ _id, ...v }) => v),
      body: { transporterLedgers: ["Fast Transport"] },
      expectedWorkbookSheets: [],
      decide: (row) => (row.decidable ? { state: "CONFIRMED", choice: "REPORT" } : null),
      expect: async ({ call, A, runId, run, section }) => {
        const out = [];
        const c = (name, pass, detail = "") => out.push({ name, pass: Boolean(pass), detail });
        const payments = section("CASH_PAYMENTS");
        c("six cash findings and the input gaps are read by section", payments.length === 6 && section("INPUT_GAPS").length === 2, `${payments.length}/${section("INPUT_GAPS").length}`);
        c("the run names its two sections", run.sections.map((s) => s.code).join(",") === "CASH_PAYMENTS,INPUT_GAPS");
        c("a finding carries display lines and its five choices", payments[0].lines.length >= 4 && payments[0].choices.options.length === 5, JSON.stringify(payments[0].choices));
        c("the amounts are paise: 12,000 rupees is 1,200,000", payments[0].values.amountMinor === 1_200_000, `${payments[0].values.amountMinor}`);
        c("a transporter named in the request is stored with the run", run.params.transporterLedgers?.join() === "Fast Transport", JSON.stringify(run.params));
        const first = payments[0];
        const noNote = await call("POST", `/api/audit-packs/${runId}/rows/${first.rowKey}/decision`, A.token, { expectedVersion: 0, state: "CONFIRMED", choice: "EXCEPTION_6DD" });
        c("an answer that needs a note is refused without one", noNote.status === 400 && noNote.json?.code === "AUDIT_PACK_DECISION_REFUSED", `status ${noNote.status}`);
        const wrong = await call("POST", `/api/audit-packs/${runId}/rows/${first.rowKey}/decision`, A.token, { expectedVersion: 0, state: "CONFIRMED", choice: "UNEXPLAINED" });
        c("an answer the row did not offer is refused", wrong.status === 400, `status ${wrong.status}`);
        const gap = section("INPUT_GAPS")[0];
        const onGap = await call("POST", `/api/audit-packs/${runId}/rows/${gap.rowKey}/decision`, A.token, { expectedVersion: 0, state: "CONFIRMED", choice: "REPORT" });
        c("an input gap cannot be decided", onGap.status === 400, `status ${onGap.status}`);
        const ok = await call("POST", `/api/audit-packs/${runId}/rows/${first.rowKey}/decision`, A.token, { expectedVersion: 0, state: "CONFIRMED", choice: "EXCEPTION_6DD", note: "Rule 6DD: paid to a bank" });
        c("an answer with its note is recorded with who and when", ok.status === 200 && ok.json?.row?.decision?.choice === "EXCEPTION_6DD" && ok.json.row.decision.version === 1 && ok.json.row.decision.decidedBy === String(A.ownerId), `status ${ok.status}`);
        const stale = await call("POST", `/api/audit-packs/${runId}/rows/${first.rowKey}/decision`, A.token, { expectedVersion: 0, state: "CONFIRMED", choice: "REPORT" });
        c("a stale version is refused 409", stale.status === 409);
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
  console.log(`\nclause21d-contract: ${checks.length - failed}/${checks.length} passed (${note})`);
  process.exitCode = failed ? 1 : 0;
}

await main();
