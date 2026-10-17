// tests/books-snapshot-contract.mjs
//
// W10 AP18-AP21 (2026-10-17). The Tally books snapshot: group resolution and chunk validation (pure, with
// automated mutants), then - with a scratch MongoDB - chunk upload, sealing, group mapping, the party master
// and the diff of two snapshots through the real app.
//
// The two golden files in tests/fixtures/tally are the canonical records the client readers
// (audit-nlp-extension/tally/tally-xml.js and Core/Books/TallyXmlReader.cs) write from the shared synthetic
// exports. In the monorepo this suite also checks they are still the extension's copies.
//
// Run: node tests/books-snapshot-contract.mjs
//      MONGODB_URI=mongodb://127.0.0.1:27117/scratch-gates-books-snapshot node tests/books-snapshot-contract.mjs

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { mutantChecks, runMutants } from "./lib/mutants.mjs";

const lf = (text) => text.split("\r\n").join("\n");
const read = (name) => lf(readFileSync(new URL(`./fixtures/tally/${name}`, import.meta.url), "utf8"));
const MASTERS = read("masters.golden.ndjson");
const DAYBOOK = read("daybook.golden.ndjson");
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const linesOf = (text) => text.split("\n").filter(Boolean);
const only = (text, type) => linesOf(text).filter((l) => JSON.parse(l).t === type).map((l) => `${l}\n`).join("");

function pureChecks(modules) {
  const { createGroupResolver, reservedCodeFor, groupKey, STANDARD_GROUP_CODES } = modules.mapping;
  const { parseChunk, chunkDigest } = modules.canonical;
  const checks = [];
  const check = (name, fn) => {
    try {
      fn();
      checks.push({ name, pass: true });
    } catch (error) {
      checks.push({ name, pass: false, detail: String(error.message).split("\n")[0] });
    }
  };
  const eq = (actual, expected, what = "") => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${what ? `${what}: ` : ""}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };
  const refuses = (fn, pattern) => {
    try {
      fn();
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      if (pattern && !pattern.test(error.message)) throw new Error(`refused for the wrong reason: ${error.message}`);
      return;
    }
    throw new Error("was accepted");
  };

  // ─── group resolution ───────────────────────────────────────────────────
  const groups = [
    { name: "Sundry Creditors", parent: "", reserved: "Sundry Creditors" },
    { name: "Raw Material Suppliers", parent: "Sundry Creditors", reserved: "" },
    { name: "Import Suppliers", parent: "Raw Material Suppliers", reserved: "" },
    { name: "Staff Welfare", parent: "Indirect Expenses", reserved: "" },
    { name: "Orphan", parent: "Nowhere", reserved: "" },
    { name: "Loop A", parent: "Loop B", reserved: "" },
    { name: "Loop B", parent: "Loop A", reserved: "" },
    { name: "Top Custom", parent: "Primary", reserved: "" },
  ];
  const resolver = createGroupResolver({ groups });
  check("a predefined group resolves by its own name", () => eq(resolver.resolve("Sundry Creditors").standardGroup, "SUNDRY_CREDITORS"));
  check("a custom group resolves through its parent", () => {
    const r = resolver.resolve("Raw Material Suppliers");
    eq(r.standardGroup, "SUNDRY_CREDITORS");
    eq(r.source, "PARENT_CHAIN");
  });
  check("a grandchild resolves through two parents and shows the chain", () => {
    const r = resolver.resolve("Import Suppliers");
    eq(r.standardGroup, "SUNDRY_CREDITORS");
    eq(r.chain, ["Import Suppliers", "Raw Material Suppliers", "Sundry Creditors"]);
  });
  check("a parent that is a predefined name but not in the export still resolves", () => eq(resolver.resolve("Staff Welfare").standardGroup, "INDIRECT_EXPENSES"));
  check("a ledger parent that the export never lists resolves by Tally's own name", () => eq(resolver.resolve("Cash-in-Hand").standardGroup, "CASH"));
  check("a chain that ends nowhere is unresolved, with the reason, not defaulted", () => {
    const r = resolver.resolve("Orphan");
    eq(r.standardGroup, null);
    eq(/not a group in this export/.test(r.reason), true, "reason");
  });
  check("a loop is reported, not followed forever", () => {
    const r = resolver.resolve("Loop A");
    eq(r.standardGroup, null);
    eq(/loop/.test(r.reason), true);
  });
  check("a top-level custom group (parent Primary) does not resolve by guessing", () => eq(resolver.resolve("Top Custom").standardGroup, null));
  check("a person's answer for a group wins, and the nearest answer in the chain wins", () => {
    const answered = createGroupResolver({ groups, mappings: new Map([[groupKey("Orphan"), "SUNDRY_DEBTORS"], [groupKey("Raw Material Suppliers"), "LOANS_UNSECURED"]]) });
    eq(answered.resolve("Orphan").standardGroup, "SUNDRY_DEBTORS");
    eq(answered.resolve("Orphan").source, "USER");
    eq(answered.resolve("Import Suppliers").standardGroup, "LOANS_UNSECURED", "the nearest answer, not Sundry Creditors above it");
  });
  check("Tally's 28 predefined groups all resolve; the standard list has 28 entries", () => {
    eq(STANDARD_GROUP_CODES.length, 28);
    for (const name of ["Branch / Divisions", "Capital Account", "Current Assets", "Current Liabilities", "Direct Expenses", "Direct Incomes", "Fixed Assets", "Indirect Expenses", "Indirect Incomes", "Investments", "Loans (Liability)", "Misc. Expenses (ASSET)", "Purchase Accounts", "Sales Accounts", "Suspense A/c", "Bank Accounts", "Bank OD A/c", "Cash-in-Hand", "Deposits (Asset)", "Duties & Taxes", "Loans & Advances (Asset)", "Provisions", "Reserves & Surplus", "Secured Loans", "Stock-in-Hand", "Sundry Creditors", "Sundry Debtors", "Unsecured Loans"]) {
      if (!reservedCodeFor(name)) throw new Error(`"${name}" does not resolve`);
    }
  });
  check("names compare without regard to case or spacing", () => eq(reservedCodeFor("  sundry   CREDITORS "), "SUNDRY_CREDITORS"));

  // ─── chunk validation ───────────────────────────────────────────────────
  check("the golden masters and day book are accepted whole", () => {
    eq(parseChunk("groups", only(MASTERS, "group")).count, 3);
    eq(parseChunk("ledgers", only(MASTERS, "ledger")).count, 4);
    const v = parseChunk("vouchers", only(DAYBOOK, "voucher"));
    eq(v.count, 8);
    eq(v.alterMin, 501);
    eq(v.alterMax, 508);
    eq(v.dateMin, "2025-04-15");
    eq(v.dateMax, "2025-08-01");
    eq(v.amountsUnreadable, 1);
    eq(v.datesUnreadable, 1);
    eq(v.recordsWithWarnings, 2);
  });
  check("an amount above Int32 paise is accepted exactly", () => {
    const v = parseChunk("vouchers", only(DAYBOOK, "voucher")).docs.find((d) => d.guid === "v-0008");
    eq(v.entries[0].amountMinor, -3_000_000_000);
  });
  check("a voucher's line hash is the hash of the line it arrived as", () => {
    const first = linesOf(DAYBOOK)[0];
    eq(parseChunk("vouchers", `${first}\n`).docs[0].lineHash, sha(first));
  });
  const voucherLine = () => JSON.parse(linesOf(DAYBOOK)[0]);
  check("an unknown field is refused, naming the line", () => {
    refuses(() => parseChunk("vouchers", `${JSON.stringify({ ...voucherLine(), secret: "x" })}\n`), /Line 1: unknown field secret/);
  });
  check("a missing field is refused", () => {
    const v = voucherLine();
    delete v.entries;
    refuses(() => parseChunk("vouchers", `${JSON.stringify(v)}\n`), /missing field entries/);
  });
  check("a float where paise belong is refused", () => {
    const v = voucherLine();
    v.entries[0].amountMinor = 12.5;
    refuses(() => parseChunk("vouchers", `${JSON.stringify(v)}\n`), /amountMinor must be a whole number/);
  });
  check("a date that does not exist is refused", () => {
    const v = voucherLine();
    v.date = "2025-02-31";
    refuses(() => parseChunk("vouchers", `${JSON.stringify(v)}\n`), /not a day that exists/);
  });
  check("a record of the wrong type for the chunk is refused", () => refuses(() => parseChunk("groups", only(MASTERS, "ledger")), /expected a group/));
  check("a control character in a name is refused", () => {
    const g = JSON.parse(linesOf(MASTERS)[0]);
    g.name = "Bad\u0004Name";
    refuses(() => parseChunk("groups", `${JSON.stringify(g)}\n`), /control character/);
  });
  check("the same record twice in a chunk is refused", () => {
    const line = linesOf(MASTERS)[0];
    refuses(() => parseChunk("groups", `${line}\n${line}\n`), /appears twice/);
  });
  check("an empty chunk and one past 5,000 records are refused", () => {
    refuses(() => parseChunk("groups", ""), /at least one record/);
    const lines = Array.from({ length: 5001 }, (_, i) => JSON.stringify({ t: "group", guid: `g${i}`, alterId: i, name: `G${i}`, parent: "", reserved: "", warnings: [] })).join("\n");
    refuses(() => parseChunk("groups", `${lines}\n`), /at most 5000/);
  });
  check("a voucher with more than 1,000 entries is refused", () => {
    const v = voucherLine();
    v.entries = Array.from({ length: 1001 }, () => ({ ledger: "A", amountMinor: 1 }));
    refuses(() => parseChunk("vouchers", `${JSON.stringify(v)}\n`), /more than 1000/);
  });
  check("a warning code the server does not know is refused", () => {
    const g = JSON.parse(linesOf(MASTERS)[0]);
    g.warnings = ["NEW_THING"];
    refuses(() => parseChunk("groups", `${JSON.stringify(g)}\n`), /not one this server knows/);
  });
  check("the chunk digest depends on kind, order, hash and count, and not on arrival order", () => {
    const a = [{ kind: "groups", seq: 0, hash: sha("a"), count: 3 }, { kind: "vouchers", seq: 0, hash: sha("b"), count: 8 }, { kind: "vouchers", seq: 1, hash: sha("c"), count: 2 }];
    eq(chunkDigest(a), chunkDigest([...a].reverse()));
    if (chunkDigest(a) === chunkDigest([{ ...a[0], count: 4 }, a[1], a[2]])) throw new Error("count not in the digest");
    if (chunkDigest(a) === chunkDigest([a[0], { ...a[1], hash: sha("x") }, a[2]])) throw new Error("hash not in the digest");
  });
  return checks;
}

const MAPPING_MUTANTS = [
  { name: "a person's answer no longer wins over Tally's chain", from: 'if (userMap.has(cursorKey)) {', to: 'if (false && userMap.has(cursorKey)) {' },
  { name: "a loop in the group tree is followed to the hop limit instead of reported", from: 'if (seen.has(cursorKey)) {', to: 'if (false && seen.has(cursorKey)) {' },
  { name: "a group that leads nowhere is defaulted to current assets", from: 'result = { standardGroup: null, source: null, reason: `"${cursor}" is not a group in this export and is not one of Tally\'s predefined groups.` };', to: 'result = { standardGroup: "CURRENT_ASSETS", source: "PARENT_CHAIN", reason: "" };' },
];
const CANONICAL_MUTANTS = [
  { name: "a float amount is accepted", from: 'if (!Number.isSafeInteger(value)) fail(lineNumber, `${key} must be a whole number or null`);', to: "" },
  { name: "an unknown field is tolerated", from: 'if (extra.length) fail(lineNumber, `unknown field ${extra.slice(0, 3).join(", ")}`);', to: "" },
  { name: "the same record twice in a chunk is stored twice", from: 'if (seen.has(doc.recordKey)) fail(n, "the same record appears twice in this chunk");', to: "" },
];

async function main() {
  const mapping = await import("../src/services/books/group-mapping.js");
  const canonical = await import("../src/services/books/tally-canonical.js");
  const ai = await import("../src/services/books/books-ai.service.js");
  const checks = pureChecks({ mapping, canonical });

  // The AI half: a suggestion is read only if it names a real code and a real group.
  checks.push({
    name: "ai: a suggestion naming an invalid code or a group that was not asked about is dropped",
    pass: (() => {
      const groups = [{ name: "Staff Welfare", chain: ["Staff Welfare"] }, { name: "Odd Group", chain: ["Odd Group"] }];
      const answer = JSON.stringify({ suggestions: [{ index: 1, standardGroup: "indirect_expenses", why: "welfare is an expense" }, { index: 2, standardGroup: "MADE_UP" }, { index: 9, standardGroup: "CASH" }] });
      const out = ai.readSuggestions(answer, groups);
      return out.length === 1 && out[0].groupName === "Staff Welfare" && out[0].standardGroup === "INDIRECT_EXPENSES" && out[0].status === "AI_DRAFT";
    })(),
  });
  checks.push({ name: "ai: unreadable model output gives no suggestions rather than an error", pass: ai.readSuggestions("not json at all", [{ name: "x" }]).length === 0 });
  checks.push({ name: "ai: the prompt carries group names and the code list, and nothing else", pass: (() => {
    const prompt = ai.buildSuggestionPrompt([{ name: "Staff Welfare", chain: ["Staff Welfare", "Indirect Expenses"] }]);
    return /Staff Welfare/.test(prompt) && /INDIRECT_EXPENSES/.test(prompt) && !/gstin|amount|ledger/i.test(prompt.replace(/ledgers? /gi, ""));
  })() });

  checks.push(...mutantChecks(await runMutants({
    enginePath: new URL("../src/services/books/group-mapping.js", import.meta.url),
    mutants: MAPPING_MUTANTS,
    runChecks: async (m) => pureChecks({ mapping: m, canonical }),
  })));
  checks.push(...mutantChecks(await runMutants({
    enginePath: new URL("../src/services/books/tally-canonical.js", import.meta.url),
    mutants: CANONICAL_MUTANTS,
    runChecks: async (m) => pureChecks({ mapping, canonical: m }),
  })));

  // The goldens are the extension's own, when the monorepo is here to say.
  const extensionDir = new URL("../../audit-nlp-extension/tests/fixtures/tally/", import.meta.url);
  if (existsSync(new URL("masters.golden.ndjson", extensionDir))) {
    for (const name of ["masters.golden.ndjson", "daybook.golden.ndjson"]) {
      const theirs = lf(readFileSync(new URL(name, extensionDir), "utf8"));
      checks.push({ name: `fixtures: ${name} is still the extension's copy`, pass: theirs === read(name) });
    }
  }

  const uri = process.env.MONGODB_URI || "";
  const scratch = /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(uri) && /scratch/i.test((uri.split("/").pop() || "").split("?")[0]);
  let note = "pure checks only (no scratch MONGODB_URI)";
  if (scratch) {
    const { runBooksRouteChecks } = await import("./lib/books-routes.mjs");
    checks.push(...(await runBooksRouteChecks({ uri, MASTERS, DAYBOOK, only, linesOf, sha })));
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
  console.log(`\nbooks-snapshot-contract: ${checks.length - failed}/${checks.length} passed (${note})`);
  process.exitCode = failed ? 1 : 0;
}

await main();
