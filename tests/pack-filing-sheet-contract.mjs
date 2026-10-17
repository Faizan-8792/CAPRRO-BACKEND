// tests/pack-filing-sheet-contract.mjs
//
// W10 AP26 (2026-10-17). The rule every pack workbook shares, asserted for every registered generic pack:
// the "For filing" sheet carries CONFIRMED rows the person chose to report and nothing else, and while any
// row is undecided or an input is missing it carries the provisional notice and no figures at all.
//
// Pure: the kinds' workbook() is called with fabricated runs and rows; no database.
// Run: node tests/pack-filing-sheet-contract.mjs

import { GENERIC_PACK_KINDS, getPackKind } from "../src/services/audit-pack-kinds/index.js";

const RUN = {
  financialYear: "2025-26",
  ruleVersion: "contract",
  publishedAt: "2026-10-17T00:00:00.000Z",
  sourceBatches: [{ kind: "BOOKS_SNAPSHOT", batchId: "64b0000000000000000000f1", sourceHash: "h".repeat(64), period: "" }],
};

const row = (over = {}) => ({
  section: "S",
  rowKey: "k".repeat(64),
  label: "A row",
  state: "COMPUTED",
  decidable: true,
  choice: "",
  // Every field any pack's filing columns read, so the fixture satisfies each pack's own sheet.
  values: {
    amountMinor: 1_500_000, paidLateMinor: 1_500_000, unpaidMinor: 1_500_000,
    closingMinor: 1_500_000, interestMinor: 1_500_000, feeMinor: 1_500_000,
    choices: [{ value: "REPORT", label: "Report it" }],
  },
  ruleHits: [{ rule: "R", threshold: null, detail: "Why." }],
  stored: { decision: {} },
  ...over,
});

const summary = (over = {}) => ({
  provisional: false,
  reasons: [],
  totals: { reportableMinor: 0, reportableCount: 0, findings: 3, decided: 3, undecided: 0, inputGaps: 0 },
  counts: {},
  ...over,
});

function sheetOf(kind, rows, sum, sheetName = "For filing") {
  const { sheets } = getPackKind(kind).workbook({ run: RUN, clientName: "Contract Client", effectiveRows: rows, summary: sum });
  return sheets.find((s) => s.name === sheetName);
}

const text = (cell) => (cell && typeof cell === "object" ? JSON.stringify(cell) : String(cell ?? ""));

async function main() {
  const checks = [];
  const check = (name, fn) =>
    Promise.resolve().then(fn).then(() => checks.push({ name, pass: true })).catch((error) => checks.push({ name, pass: false, detail: String(error.message).split("\n")[0] }));

  // Per-kind fixture tweaks: GSTR9C files on a "Reconciliation" sheet of comparison rows; CLAUSE34's
  // filing columns read the row's section, so its fixture row is a deposit finding.
  const FIXTURE = {
    GSTR9C: { sheetName: "Reconciliation", values: { leftMinor: 1_500_000, rightMinor: 1_400_000, differenceMinor: 100_000, leftLabel: "Books", rightLabel: "Returns" } },
    CLAUSE34: { section: "DEPOSIT_TIMING" },
  };

  for (const kind of ["CLAUSE21D", "CLAUSE22", "CLAUSE26", "CLAUSE31", "CLAUSE34", "GSTR9C"]) {
    const fx = FIXTURE[kind] || {};
    const sheetName = fx.sheetName || "For filing";
    const mk = (over = {}) => row({ ...(fx.section ? { section: fx.section } : {}), ...(fx.values ? { values: fx.values } : {}), ...over });
    const FALLBACK_VALUES = { amountMinor: 1_500_000, paidLateMinor: 1_500_000, unpaidMinor: 1_500_000, closingMinor: 1_500_000, interestMinor: 1_500_000, feeMinor: 1_500_000 };
    const withValues = (over = {}) => mk({ ...over, values: { ...(fx.values || FALLBACK_VALUES), ...(over.values || {}) } });

    await check(`${kind}: the pack is registered and declares a workbook`, async () => {
      if (!getPackKind(kind)) throw new Error(`${kind} is not in the pack registry`);
      if (typeof getPackKind(kind).workbook !== "function") throw new Error(`${kind} has no workbook()`);
    });
    await check(`${kind}: a decided "report it" row alone reaches the For filing sheet`, async () => {
      const confirmed = withValues({ state: "CONFIRMED", choice: "REPORT", stored: { decision: { state: "CONFIRMED", choice: "REPORT" } } });
      const computed = mk({ rowKey: "c".repeat(64), label: "Still computed" });
      const excluded = mk({ rowKey: "e".repeat(64), label: "Excluded", state: "EXCLUDED", stored: { decision: { state: "EXCLUDED", reason: "Not a due" } } });
      const pendingGap = mk({ rowKey: "g".repeat(64), label: "A gap", decidable: false, state: "PENDING_INPUT", values: { amountMinor: null } });
      const sheet = sheetOf(kind, [confirmed, computed, excluded, pendingGap], summary(), sheetName);
      const body = (sheet.rows || []).map((r) => r.map(text).join(" | ")).join("\n");
      if ((sheet.rows || []).length !== 1) throw new Error(`the filing sheet holds ${sheet.rows.length} row(s), expected 1:\n${body}`);
      if (!body.includes("1500000")) throw new Error(`the confirmed row's amount (1,500,000 paise) is not on the sheet:\n${body}`);
      for (const absent of ["Still computed", "Excluded", "A gap"]) {
        if (body.includes(absent)) throw new Error(`"${absent}" leaked onto the filing sheet:\n${body}`);
      }
    });
    await check(`${kind}: with a row undecided the sheet certifies nothing and shows no figure`, async () => {
      const undecided = mk({ rowKey: "u".repeat(64) });
      const sheet = sheetOf(kind, [undecided], summary({ provisional: true, reasons: [{ code: "ROWS_NOT_DECIDED", count: 1, blocking: true }] }), sheetName);
      const body = (sheet.rows || []).map((r) => r.map(text).join(" | ")).join("\n");
      if (!/provisional|nothing is offered|not offered|certif/i.test(body)) throw new Error(`no provisional notice on the sheet:\n${body}`);
      if (body.includes("1500000")) throw new Error(`a figure reached the provisional sheet:\n${body}`);
      if ((sheet.rows || []).length !== 1) throw new Error(`the provisional sheet carries ${sheet.rows.length} row(s) of data`);
    });
    await check(`${kind}: a confirmed answer that is not for filing stays off the sheet`, async () => {
      const kindDef = getPackKind(kind);
      const options = kindDef.choicesFor ? kindDef.choicesFor(withValues()) : null;
      const all = options?.options || [];
      const offList = all.filter((o) => !(kindDef.reportChoices || ["REPORT"]).includes(o.value));
      if (!offList.length) return; // every answer of this pack reports; nothing to assert
      const answer = offList[0].value;
      const adopted = withValues({ state: "CONFIRMED", choice: answer, stored: { decision: { state: "CONFIRMED", choice: answer } } });
      const computed = mk({ rowKey: "u".repeat(64), label: "Still computed" });
      const sheet = sheetOf(kind, [adopted, computed], summary(), sheetName);
      const body = (sheet.rows || []).map((r) => r.map(text).join(" | ")).join("\n");
      if (kind === "GSTR9C") {
        // The 9C reconciliation files every CONFIRMED residual with its chosen explanation - there is no
        // report/no-report split. The invariant here is that nothing unconfirmed reaches it.
        if (!body.includes("1500000")) throw new Error(`a confirmed residual vanished from the reconciliation sheet:\n${body}`);
        if (body.includes("Still computed")) throw new Error(`an undecided row reached the reconciliation sheet:\n${body}`);
        return;
      }
      if (body.includes("1500000") || body.includes("100000")) throw new Error(`a confirmed-but-not-reported answer (${answer}) reached the filing sheet:\n${body}`);
    });
  }

  // The pack's headline "amount to report" is the same rule as the filing sheet, in a second place
  // (summarize()). Added 2026-10-17 after a deliberate weakening of that filter survived this whole file and
  // most kind suites: the sheet was pinned, the number people quote from the summary was not.
  for (const kind of GENERIC_PACK_KINDS) {
    const def = getPackKind(kind);
    if (typeof def?.summarize !== "function") continue;
    const probe = def.summarize([]);
    if (typeof probe?.totals?.reportableMinor !== "number") continue; // a pack whose summary is not a reportable total (it files differently)
    const mk = (n, over) => ({ rowKey: String(n).padStart(64, "0"), section: (def.sections[0] || {}).code, label: `row ${n}`, decidable: true, state: "COMPUTED", values: { amountMinor: n }, decision: { version: 0 }, ...over });
    await check(`${kind}: the summary's reportable total counts only CONFIRMED rows with a report answer`, async () => {
      // The answer that reports, asked of the pack (the ageing, CARO and Rule 11(g) packs name their own).
      // A pack that builds its own summary (CLAUSE34) does not expose the list and reports with REPORT.
      const report = def.reportChoices?.[0] ?? "REPORT";
      const rows = [
        mk(700, { state: "CONFIRMED", decision: { state: "CONFIRMED", choice: report } }),
        mk(800, { state: "CONFIRMED", decision: { state: "CONFIRMED", choice: "NOT_A_REPORT_ANSWER" } }),
        mk(900),
        mk(1100, { state: "EXCLUDED", decision: { state: "EXCLUDED", reason: "Not a due" } }),
        mk(1300, { decidable: false, state: "PENDING_INPUT" }),
        mk(1500, { state: "COMPUTED", decision: { choice: report } }),
      ];
      const { totals } = def.summarize(rows);
      if (totals.reportableMinor !== 700) throw new Error(`reportableMinor is ${totals.reportableMinor}, expected 700 (only the confirmed report row)`);
      if (totals.reportableCount !== 1) throw new Error(`reportableCount is ${totals.reportableCount}, expected 1`);
    });
  }

  let failed = 0;
  for (const c of checks) {
    if (c.pass) console.log(`PASS  ${c.name}`);
    else {
      failed += 1;
      console.error(`FAIL  ${c.name}${c.detail ? `\n      ${c.detail}` : ""}`);
    }
  }
  console.log(`\npack-filing-sheet-contract: ${checks.length - failed}/${checks.length} passed`);
  process.exitCode = failed ? 1 : 0;
}

await main();
