// tests/rule11g-contract.mjs
//
// W10 AP30 (2026-10-17). The Rule 11(g) evidence sheet. Its headline gate is a WORDING CONTRACT: nothing the pack
// says - a label, a line, a rule, a limit, a choice offered, the Read me, the workbook - says the audit trail was
// verified, checked, confirmed or found intact, or that the feature operated; the only sentences about the feature
// are the person's, and every one is worded "My conclusion: ..." and needs their note. Around it: the comparison
// carried faithfully into rows, the limits named, automated breakages of the engine, and - with a scratch MongoDB -
// the whole pack through the real routes with a real earlier and later export of one year.
//
// Run: node tests/rule11g-contract.mjs
//      MONGODB_URI=mongodb://127.0.0.1:27117/scratch-gates-rule11g node tests/rule11g-contract.mjs

import { mutantChecks, runMutants } from "./lib/mutants.mjs";

const diff = (over = {}) => ({
  base: { id: "S0", counts: { vouchers: 40 }, createdAt: "2026-04-10T05:00:00.000Z" },
  other: { id: "S1", counts: { vouchers: 41 }, createdAt: "2026-04-17T05:00:00.000Z" },
  counts: { inserted: 3, deleted: 2, altered: 4, unchanged: 35 },
  alteredFields: { date: 1, type: 0, number: 0, narration: 1, partyLedger: 0, cancelled: 0, amounts: 2, other: 0 },
  changedAfterBaseAlterId: 5,
  samples: {
    inserted: [{ guid: "n1", date: "2026-03-05", type: "Journal", number: "31", alterId: 90 }],
    deleted: [{ guid: "d1", date: "2026-02-01", type: "Payment", number: "12", alterId: 12 }],
    altered: [{ guid: "a1", date: "2026-01-09", type: "Sales", number: "7", alterId: 80, baseAlterId: 20, otherAlterId: 80, changed: ["amounts", "narration"] }],
  },
  truncated: false,
  ...over,
});

// Words the pack must never say in its own voice.
const BANNED = [
  [/\bverif/i, "verified, verify or verification"],
  [/audit[- ]trail[^.]{0,80}\b(was|were|is|has been|have been)\s+(enabled|operat\w*|working|intact|complete|reliable|functioning|switched on|valid|tested|checked|confirmed|established)/i, "a statement that the audit trail was enabled, operated or intact"],
  [/\b(tamper-?proof|not tampered|has not been tampered|no tampering|intact)\b/i, "a statement that nothing was tampered with"],
  [/\b(checked|confirmed|established|certified)\b[^.]{0,40}audit[- ]trail/i, "a statement that the audit trail was checked"],
];
export function bannedIn(text) {
  return BANNED.filter(([pattern]) => pattern.test(text)).map(([, what]) => what);
}

function systemWords(rows) {
  // Every string the engine speaks in its own voice. The choices that are the person's own conclusions ("My conclusion: ...") are
  // checked separately: they may say what a person concludes, never what the system found.
  const strings = [];
  const visit = (value, key = "") => {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) value.forEach((v) => visit(v, key));
    else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) if (k !== "choices") visit(v, k);
  };
  for (const row of rows) {
    visit(row.label);
    visit(row.values);
    visit(row.ruleHits);
  }
  return strings.join("\n");
}

async function runChecks(modules) {
  const { engine, kind } = modules;
  const { CHOICES, LIMITS, buildRule11gRows } = engine;
  const checks = [];
  const check = (name, fn) => Promise.resolve().then(fn).then(() => checks.push({ name, pass: true })).catch((error) => checks.push({ name, pass: false, detail: String(error.message).split("\n")[0] }));
  const eq = (actual, expected, what = "") => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${what ? `${what}: ` : ""}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };
  const { rows } = buildRule11gRows({ snapshotId: "S1", earlierSnapshotId: "S0", diff: diff() });
  const row = (identity) => rows.find((r) => r.label === identity || r.label.startsWith(identity));

  await check("WORDING CONTRACT: nothing the pack says in its own voice says the audit trail was verified, checked, confirmed, intact or operating", () => {
    const spoken = `${systemWords(rows)}\n${LIMITS.join("\n")}\n${kind.readMe.map(([a, b]) => `${a}\n${b}`).join("\n")}\n${kind.label}\n${kind.sections.map((s) => s.label).join("\n")}`;
    eq(bannedIn(spoken), []);
    // The same scan over every empty-comparison variant, so a branch that only runs when nothing differs is covered too.
    const nothing = buildRule11gRows({ snapshotId: "S1", earlierSnapshotId: "S0", diff: diff({ counts: { inserted: 0, deleted: 0, altered: 0, unchanged: 40 }, samples: { inserted: [], deleted: [], altered: [] }, changedAfterBaseAlterId: 0 }) }).rows;
    eq(bannedIn(systemWords(nothing)), [], "nothing differs");
  });
  await check("WORDING CONTRACT: the scanner itself catches the sentences it exists to catch", () => {
    for (const bad of ["The audit trail was verified.", "We verified the audit trail.", "The audit trail was enabled throughout the year.", "No tampering was found.", "The audit trail is intact.", "We checked the audit trail for gaps.", "The audit trail has been confirmed as operating."]) {
      eq(bannedIn(bad).length > 0, true, bad);
    }
    for (const good of ["It compares two exports of the books for the same year.", "It does not show who made a change.", "Rule 11(g) asks whether the company used accounting software with a feature of recording an audit trail."]) eq(bannedIn(good), [], good);
  });
  await check("every sentence about the feature itself is the person's: the four conclusions are each worded 'My conclusion' and each needs a note", () => {
    const conclusion = row("Your conclusion");
    eq(conclusion.values.choices.map((c) => c.value), ["OPERATED_NO_INSTANCE", "EXCEPTION", "NOT_AVAILABLE", "CANNOT_CONCLUDE"]);
    for (const c of conclusion.values.choices) {
      eq(c.label.startsWith("My conclusion:"), true, c.value);
      eq(c.needsNote, true, c.value);
    }
    for (const other of Object.values(CHOICES).filter((c) => !conclusion.values.choices.some((x) => x.value === c.value))) eq(/audit trail|feature|operated|tamper/i.test(other.label), false, other.value);
  });
  await check("the conclusion is the person's: the engine selects nothing, offers no default and the row waits to be decided", () => {
    const conclusion = row("Your conclusion");
    eq([conclusion.section, conclusion.state, conclusion.decidable], ["CONCLUSION", "COMPUTED", true]);
    eq(JSON.stringify(conclusion.values).includes('"selected"'), false);
    eq(conclusion.values.lines.map((l) => l.value), ["Yours alone. Nothing in this pack answers it."]);
  });
  await check("the comparison is carried into the first row exactly: dates, voucher counts, what was added, removed, changed and the same", () => {
    const comparison = row("What differs");
    eq([comparison.values.earlierTakenOn, comparison.values.laterTakenOn, comparison.values.earlierVouchers, comparison.values.laterVouchers], ["2026-04-10", "2026-04-17", 40, 41]);
    eq(comparison.values.counts, { inserted: 3, deleted: 2, altered: 4, unchanged: 35 });
    eq(comparison.values.alteredFields.amounts, 2);
    eq(comparison.values.changedAfterBaseAlterId, 5);
    eq(comparison.values.lines.find((l) => /in the later export and not the earlier/.test(l.label)).value, "3");
    eq(comparison.values.lines.find((l) => /in the earlier export and not the later/.test(l.label)).value, "2");
  });
  await check("added, removed and changed vouchers are listed in their own rows with what was found and a follow-up answer; a category with none has no row", () => {
    const added = row("Vouchers in the later export and not the earlier");
    const removed = row("Vouchers in the earlier export and not the later");
    const changed = row("Vouchers in both exports that differ");
    eq([added.values.total, removed.values.total, changed.values.total], [3, 2, 4]);
    eq(changed.values.samples[0].changed, ["amounts", "narration"]);
    eq(added.values.choices.map((c) => c.value), ["NOTED", "FOLLOW_UP"]);
    eq(added.values.choices[1].needsNote, true);
    const none = buildRule11gRows({ snapshotId: "S1", earlierSnapshotId: "S0", diff: diff({ counts: { inserted: 0, deleted: 0, altered: 0, unchanged: 40 }, samples: { inserted: [], deleted: [], altered: [] } }) }).rows;
    eq(none.map((r) => r.label).filter((l) => /^Vouchers in/.test(l)), []);
    eq(none.length, 3, "comparison, limits and conclusion remain");
  });
  await check("a list cut at 200 says so", () => {
    const cut = buildRule11gRows({ snapshotId: "S1", earlierSnapshotId: "S0", diff: diff({ truncated: true }) }).rows;
    eq(cut[0].values.truncated, true);
    eq(cut[0].ruleHits[0].detail.includes("first 200"), true);
  });
  await check("the limits are on the sheet as a row nobody decides: what the comparison cannot show, five of them", () => {
    const limits = row("What this comparison cannot show");
    eq([limits.decidable, limits.state, limits.values.lines.length], [false, "COMPUTED", 5]);
    eq(LIMITS.length, 5);
    for (const needle of ["who made a change", "undone between the two exports", "whether the software has the feature", "two exports of the books for the same year"]) eq(LIMITS.some((l) => l.includes(needle)), true, needle);
  });
  await check("rows read in the order a person reads them: comparison, then the three lists, then the limits, then the conclusion; every decidable row is backed by both exports", () => {
    eq(rows.map((r) => r.section), ["COMPARISON", "COMPARISON", "COMPARISON", "COMPARISON", "COMPARISON", "CONCLUSION"]);
    for (const r of rows.filter((x) => x.decidable)) eq(r.allSources.map((s) => s.batchId), ["S0", "S1"], r.label);
    eq(new Set(rows.map((r) => r.rowKey)).size, rows.length);
    eq(JSON.stringify(buildRule11gRows({ snapshotId: "S1", earlierSnapshotId: "S0", diff: diff() })), JSON.stringify({ rows }));
  });
  return checks;
}

const MUTANTS = [
  { name: "a limit claims the comparison verified who made a change", from: "It does not show who made a change, when it was made, or whether the software recorded it.", to: "It verified who made a change, when it was made, and whether the software recorded it." },
  { name: "the comparison row calls itself a check of the audit trail", from: 'label: "What differs between the two exports",', to: 'label: "Audit trail checked: what differs between the two exports",' },
  { name: "an acknowledgement says the audit trail was enabled", from: 'choice("NOTED", "Noted: I have read this part of the comparison")', to: 'choice("NOTED", "Noted: the audit trail was enabled")' },
  { name: "a rule on the conclusion row says the feature operated", from: "Rule 11(g) asks whether the company used accounting software with a feature of recording an audit trail of each change, whether it operated throughout the year for all transactions,", to: "The audit trail was operating throughout the year for all transactions, and Rule 11(g) asks whether the company used accounting software with a feature of recording an audit trail of each change," },
  { name: "a conclusion is worded as the system's finding, not the person's", from: 'choice("CANNOT_CONCLUDE", "My conclusion: I cannot yet conclude", { needsNote: true })', to: 'choice("CANNOT_CONCLUDE", "I cannot yet conclude", { needsNote: true })' },
  { name: "a conclusion can be given without a note", from: 'choice("NOT_AVAILABLE", "My conclusion: the software does not have such a feature", { needsNote: true })', to: 'choice("NOT_AVAILABLE", "My conclusion: the software does not have such a feature")' },
  { name: "the limits row can be decided", from: "    ruleHits: LIMITS.map((l) => hit(\"LIMIT\", l)),\n    state: \"COMPUTED\",\n    derived: true,", to: "    ruleHits: LIMITS.map((l) => hit(\"LIMIT\", l)),\n    state: \"COMPUTED\"," },
  { name: "added and removed are swapped", from: 'count("Vouchers in the later export and not the earlier", c.inserted),', to: 'count("Vouchers in the later export and not the earlier", c.deleted),' },
  { name: "a limit is dropped", from: '  "A voucher that differs is a voucher that differs. Whether the difference is a normal later entry or something else is for your enquiry of the entity.",\n', to: "" },
  { name: "the earlier export is not named as evidence", from: "const sources = [snapshotSource(earlierSnapshotId), snapshotSource(snapshotId)];", to: "const sources = [snapshotSource(snapshotId), snapshotSource(snapshotId)];" },
  { name: "the comparison dates are the wrong way round", from: "earlierTakenOn: DAY(diff.base.createdAt),\n      laterTakenOn: DAY(diff.other.createdAt),", to: "earlierTakenOn: DAY(diff.other.createdAt),\n      laterTakenOn: DAY(diff.base.createdAt)," },
];

async function main() {
  const enginePath = new URL("../src/services/audit-pack-engine/rule11g.engine.js", import.meta.url);
  const engine = await import(enginePath.href);
  const { rule11gKind: kind } = await import("../src/services/audit-pack-kinds/rule11g.kind.js");
  const checks = await runChecks({ engine, kind });
  checks.push(...mutantChecks(await runMutants({ enginePath, mutants: MUTANTS, runChecks: (m) => runChecks({ engine: m, kind }) })));

  const uri = process.env.MONGODB_URI || "";
  const scratch = /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(uri) && /scratch/i.test((uri.split("/").pop() || "").split("?")[0]);
  let note = "engine only (no scratch MONGODB_URI)";
  if (scratch) {
    const { runSnapshotPackFlow } = await import("./lib/snapshot-pack-routes.mjs");
    const ledgers = [
      { name: "Cash", parent: "Cash-in-Hand", openingMinor: -100_000, alterId: 1 },
      { name: "Sales", parent: "Sales Accounts", openingMinor: null, alterId: 2 },
      { name: "Capital", parent: "Capital Account", openingMinor: 100_000, alterId: 3 },
    ];
    const v = (guid, date, number, amount, narration = "") => ({ guid, date, type: "Journal", number, alterId: Number(number), narration, entries: [{ ledger: "Cash", amountMinor: -amount }, { ledger: "Sales", amountMinor: amount }], bills: [], banks: [], warnings: [] });
    const earlier = [v("g1", "2025-05-01", "1", 1000), v("g2", "2025-05-02", "2", 2000), v("g3", "2025-05-03", "3", 3000), v("g4", "2025-05-04", "4", 4000)];
    // later: g2 amount changed (altered), g3 gone (removed), g5 new (added), g1 and g4 untouched
    const later = [v("g1", "2025-05-01", "1", 1000), v("g2", "2025-05-02", "2", 2500), v("g4", "2025-05-04", "4", 4000), v("g5", "2025-05-05", "5", 500)];
    let otherYearId = null;
    const decide = (row) => {
      if (row.section === "CONCLUSION") return { state: "CONFIRMED", choice: "CANNOT_CONCLUDE", note: "More enquiry of the entity is needed before I can conclude." };
      const option = row.choices?.options?.[0];
      return option ? { state: "CONFIRMED", choice: option.value } : null;
    };
    checks.push(...(await runSnapshotPackFlow({
      uri,
      label: "Rule11g",
      kind: "RULE11G",
      ledgers,
      vouchers: later,
      earlierSnapshot: { ledgers, vouchers: earlier },
      // A sealed export of another year of the same client, written beside the others, for the refusal below.
      beforeCreate: async ({ raw, A, clientId, oid, now }) => {
        otherYearId = oid();
        await raw("bookssnapshots").insertOne({ _id: otherYearId, firmId: A.firmId, clientId, financialYear: "2024-25", source: "TALLY_XML", label: "other-year", schemaVersion: "tally-canonical-v1", status: "SEALED", chunkCounts: { groups: 1, ledgers: 1, vouchers: 1 }, chunkLog: [], counts: { groups: 0, ledgers: 0, vouchers: 0 }, alterId: { min: null, max: null }, voucherDates: { min: null, max: null }, warnings: { recordsWithWarnings: 0, amountsUnreadable: 0, datesUnreadable: 0 }, contentHash: "f".repeat(64), createdBy: A.ownerId, sealedBy: A.ownerId, sealedAt: new Date(now.getTime() - 86_400_000), createdAt: new Date(now.getTime() - 86_400_000), updatedAt: now });
      },
      decide,
      expectedWorkbookSheets: ["For filing"],
      expect: async ({ run, section, call, A, snapshotId, earlierSnapshotId, clientId, readWorkbookParts, runId }) => {
        const out = [];
        const c = (name, pass, detail = "") => out.push({ name, pass: Boolean(pass), detail });
        const comparison = section("COMPARISON");
        c("the run names its two sections", run.sections.map((s) => s.code).join(",") === "COMPARISON,CONCLUSION", run.sections.map((s) => s.code).join(","));
        const first = comparison.find((r) => r.label.startsWith("What differs"));
        c("the real comparison is carried in: one added, one removed, one changed in amounts, two the same", JSON.stringify(first?.values.counts) === JSON.stringify({ inserted: 1, deleted: 1, altered: 1, unchanged: 2 }) && first.values.alteredFields.amounts === 1, JSON.stringify(first?.values.counts));
        c("the earlier export is dated before the later one", first.values.earlierTakenOn < first.values.laterTakenOn, `${first.values.earlierTakenOn} / ${first.values.laterTakenOn}`);
        c("the changed voucher is listed with what changed", comparison.find((r) => r.label.startsWith("Vouchers in both exports that differ"))?.values.samples?.[0]?.changed?.includes("amounts"));
        c("the limits row is there and cannot be decided; the conclusion row waits for the person", comparison.find((r) => r.label.startsWith("What this comparison cannot show"))?.decidable === false && section("CONCLUSION")[0].decidable === true && section("CONCLUSION")[0].choices.options.length === 4);
        const wording = bannedIn(JSON.stringify([run, ...comparison, ...section("CONCLUSION")].map((r) => ({ label: r.label, lines: r.lines, rules: r.ruleHits })))
          .replace(/My conclusion: [^"]*/g, ""));
        c("WORDING CONTRACT over the real routes: no banned sentence in the run or any row as served", wording.length === 0, wording.join(" | "));

        const create = (extra) => call("POST", "/api/audit-packs", A.token, { kind: "RULE11G", clientId: String(clientId), financialYear: "2025-26", snapshotId, ...extra });
        c("a request without an earlier export is refused", (await create({})).status === 400);
        c("the same export as its own comparison is refused", (await create({ earlierSnapshotId: snapshotId })).status === 400);
        c("an earlier export of another year is refused", (await create({ earlierSnapshotId: String(otherYearId) })).status === 400);
        c("an 'earlier' export that was taken after the later one is refused", (await call("POST", "/api/audit-packs", A.token, { kind: "RULE11G", clientId: String(clientId), financialYear: "2025-26", snapshotId: earlierSnapshotId, earlierSnapshotId: snapshotId })).status === 400);
        c("a previous-year field is refused on this pack", (await create({ earlierSnapshotId, priorSnapshotId: String(otherYearId) })).status === 400);
        void readWorkbookParts; void runId;
        return out;
      },
      after: async ({ call, A, runId, readWorkbookParts }) => {
        const out = [];
        const exported = await call("GET", `/api/audit-packs/${runId}/export`, A.token);
        const parts = exported.bytes ? readWorkbookParts(exported.bytes) : new Map();
        const everything = [...parts.values()].map((b) => b.toString("utf8")).join("\n");
        out.push({ name: "WORDING CONTRACT over the workbook: no banned sentence in any sheet of the exported file", pass: exported.status === 200 && bannedIn(everything.replace(/My conclusion: [^<]*/g, "")).length === 0, detail: bannedIn(everything).join(" | ") });
        out.push({ name: "the filing sheet carries the person's conclusion and their note, and says it is theirs", pass: /My conclusion: I cannot yet conclude/.test(everything) && /More enquiry of the entity is needed/.test(everything) });
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
  console.log(`\nrule11g-contract: ${checks.length - failed}/${checks.length} passed (${note})`);
  process.exitCode = failed ? 1 : 0;
}

await main();
