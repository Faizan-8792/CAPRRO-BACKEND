// tests/audit-pack-catalogue-contract.mjs
//
// W10 AP15 (2026-10-17). The catalogue both clients draw their pack screens from (GET /api/audit-packs/kinds):
// every registered pack declares what it asks for, in the closed vocabulary of inputs.js, and declares exactly
// the fields its create route accepts - so a client can never offer a field the server refuses, or miss one the
// server needs. Also the GSTR-9 row list (its codes are the engine's own), and, with a scratch MongoDB, the route
// itself: signed out, flag off, another firm, and the TDS imports the sources route now lists for clause 34.
//
// The checker is itself tested: each deliberate breakage of a copy of the catalogue must be named.
//
// Run: node tests/audit-pack-catalogue-contract.mjs
//      MONGODB_URI=mongodb://127.0.0.1:27117/scratch-gates-catalogue node tests/audit-pack-catalogue-contract.mjs

import { IMPORT_KINDS } from "../src/models/ImportBatch.js";
import { GSTR9_FIGURE_CODES } from "../src/services/audit-pack-engine/gstr9c.engine.js";
import { GENERIC_PACK_KINDS, allCreateFields, describeKinds, getPackKind } from "../src/services/audit-pack-kinds/index.js";
import { GSTR9_ROWS } from "../src/services/audit-pack-kinds/gstr9c.kind.js";
import { INPUT_TYPES } from "../src/services/audit-pack-kinds/inputs.js";

/** Every way a catalogue can disagree with the server. Returns sentences; empty means consistent. */
export function catalogueProblems(kinds, { createFieldsOf, importKinds = IMPORT_KINDS, types = INPUT_TYPES } = {}) {
  const problems = [];
  const seen = new Set();
  for (const k of kinds) {
    const where = k.kind || "(no kind)";
    if (seen.has(k.kind)) problems.push(`${where}: listed twice`);
    seen.add(k.kind);
    if (!k.label || !k.ruleVersion) problems.push(`${where}: no label or rule version`);
    if (!Array.isArray(k.sections) || k.sections.length === 0 || k.sections.some((s) => !s.code || !s.label)) problems.push(`${where}: sections need a code and a label`);
    if (!Array.isArray(k.inputs) || k.inputs.length === 0) {
      problems.push(`${where}: declares no inputs`);
      continue;
    }
    const fields = k.inputs.map((i) => i.field);
    if (new Set(fields).size !== fields.length) problems.push(`${where}: an input is declared twice`);
    const accepted = createFieldsOf(k.kind);
    for (const field of accepted) if (!fields.includes(field)) problems.push(`${where}: the create route accepts "${field}" but the catalogue never asks for it`);
    for (const field of fields) if (!accepted.includes(field)) problems.push(`${where}: the catalogue asks for "${field}" which the create route refuses`);
    for (const input of k.inputs) {
      const at = `${where}.${input.field}`;
      if (!types.includes(input.type)) problems.push(`${at}: type "${input.type}" is not in the vocabulary`);
      if (!input.label) problems.push(`${at}: no label`);
      if (typeof input.required !== "boolean") problems.push(`${at}: required is not true or false`);
      if (["IMPORT_BATCH", "IMPORT_BATCHES"].includes(input.type) && !importKinds.includes(input.batchKind)) problems.push(`${at}: "${input.batchKind}" is not an import kind`);
      if (input.type === "CHOICE") {
        const values = (input.options || []).map((o) => o.value);
        if (values.length < 2 || !values.includes(input.default)) problems.push(`${at}: a choice needs two options and a default among them`);
      }
      if (input.type === "GSTR9_FIGURES" && (!Array.isArray(input.rows) || input.rows.length === 0)) problems.push(`${at}: no rows`);
    }
  }
  return problems;
}

async function runChecks() {
  const checks = [];
  const check = (name, pass, detail = "") => checks.push({ name, pass: Boolean(pass), detail });
  const createFieldsOf = (kind) => getPackKind(kind).createFields;
  const kinds = describeKinds();

  check("every registered generic pack is in the catalogue, once", JSON.stringify(kinds.map((k) => k.kind).sort()) === JSON.stringify([...GENERIC_PACK_KINDS].sort()) && kinds.length >= 6, kinds.map((k) => k.kind).join(","));
  const problems = catalogueProblems(kinds, { createFieldsOf });
  check("the catalogue matches the create routes field for field, in the closed vocabulary", problems.length === 0, problems.join(" | "));
  check("the catalogue survives JSON (no function or undefined leaks to a client)", JSON.stringify(JSON.parse(JSON.stringify(kinds))) === JSON.stringify(kinds));
  check("every create field any pack takes belongs to some catalogued pack", [...allCreateFields()].every((f) => kinds.some((k) => k.inputs.some((i) => i.field === f))));

  const codes = GSTR9_ROWS.map((r) => r.code);
  check("the GSTR-9 row list is exactly the engine's figure codes, each named", JSON.stringify([...codes].sort()) === JSON.stringify([...GSTR9_FIGURE_CODES].sort()) && GSTR9_ROWS.every((r) => r.label.length > 3), codes.join(","));
  const primary = GSTR9_ROWS.filter((r) => r.primary).map((r) => r.code).sort();
  check("the rows the comparisons read are marked, and 4N (required) is one of them", primary.includes("4N") && primary.length === 10, primary.join(","));

  const nine = kinds.find((k) => k.kind === "GSTR9C");
  check("GSTR-9C asks for GSTR-1, GSTR-3B and GSTR-2B imports, the figures, and offers the trial balance as optional", ["gstr1BatchIds", "gstr3bBatchIds", "gstr2bBatchIds"].every((f) => nine.inputs.find((i) => i.field === f)?.required === true) && nine.inputs.find((i) => i.field === "trialBalanceBatchId")?.required === false && nine.inputs.find((i) => i.field === "gstr9")?.type === "GSTR9_FIGURES");
  const snapshotKinds = kinds.filter((k) => k.inputs.some((i) => i.type === "BOOKS_SNAPSHOT"));
  check("every books pack asks for a sealed snapshot first", snapshotKinds.length >= 4 && snapshotKinds.every((k) => k.inputs[0].field === "snapshotId" && k.inputs[0].required === true), snapshotKinds.map((k) => k.kind).join(","));
  check("clause 34 reads the three TDS registers", ["deductionBatchIds:TDS_DEDUCTIONS", "challanBatchIds:TDS_CHALLANS", "statementBatchIds:TDS_STATEMENTS"].every((p) => { const [f, b] = p.split(":"); return kinds.find((k) => k.kind === "CLAUSE34").inputs.find((i) => i.field === f)?.batchKind === b; }));

  // The checker must catch each kind of drift, or a green catalogue proves nothing.
  const copy = () => JSON.parse(JSON.stringify(kinds));
  const caught = (name, mutate, expect) => {
    const broken = copy();
    mutate(broken);
    const found = catalogueProblems(broken, { createFieldsOf });
    check(`breakage caught: ${name}`, found.some((p) => expect.test(p)), found.join(" | ") || "nothing was reported");
  };
  caught("an input the create route accepts is dropped", (b) => b.find((k) => k.kind === "CLAUSE22").inputs.pop(), /accepts "bankRates" but the catalogue never asks/);
  caught("an input the create route refuses is invented", (b) => b[0].inputs.push({ field: "invented", type: "DATE_DAY", label: "x", required: false }), /asks for "invented" which the create route refuses/);
  caught("a type outside the vocabulary", (b) => { b[0].inputs[0].type = "SPREADSHEET"; }, /not in the vocabulary/);
  caught("an import kind that does not exist", (b) => { b.find((k) => k.kind === "CLAUSE34").inputs[0].batchKind = "TDS_DEDUCTION"; }, /is not an import kind/);
  caught("a choice whose default is not an option", (b) => { b.find((k) => k.kind === "GSTR9C").inputs.find((i) => i.type === "CHOICE").default = "WEEKLY"; }, /default among them/);
  caught("a pack listed twice", (b) => b.push(JSON.parse(JSON.stringify(b[0]))), /listed twice/);
  caught("a pack with no sections", (b) => { b[0].sections = []; }, /sections need/);

  return checks;
}

async function runRouteChecks(uri) {
  const checks = [];
  const check = (name, pass, detail = "") => checks.push({ name: `route: ${name}`, pass: Boolean(pass), detail });
  process.env.NODE_ENV = "production";
  process.env.JWT_SECRET = process.env.JWT_SECRET || "scratch-only-secret-not-a-real-credential-0000";
  process.env.DEEPSEEK_API_KEY = "";
  process.env.OCR_SPACE_API_KEY = "";
  const mongoose = (await import("mongoose")).default;
  const jwt = (await import("jsonwebtoken")).default;
  const { default: app } = await import("../src/app.js");
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
  await mongoose.connection.dropDatabase();
  const { ensureRequiredIndexes } = await import("../src/services/index-provisioning.service.js");
  await ensureRequiredIndexes();
  const raw = (name) => mongoose.connection.collection(name);
  const oid = () => new mongoose.Types.ObjectId();
  const now = new Date();

  async function firm(label) {
    const ownerId = oid();
    const firmId = oid();
    await raw("users").insertOne({ _id: ownerId, email: `owner-${label}@scratch.test`, name: `Owner ${label}`, role: "FIRM_ADMIN", accountType: "FIRM_USER", isActive: true, tokenVersion: 0, firmId, createdAt: now, updatedAt: now });
    await raw("firms").insertOne({ _id: firmId, name: `Catalogue ${label}`, displayName: `Catalogue ${label}`, handle: `scratch-cat-${label.toLowerCase()}`, ownerId, ownerUserId: ownerId, type: "FIRM", isActive: true, joinCode: `JCAT${label}${Date.now()}`.slice(0, 16), createdAt: now, updatedAt: now });
    await raw("firmmemberships").insertOne({ _id: oid(), firmId, userId: ownerId, status: "ACTIVE", role: "OWNER", memberAccess: "FULL", createdAt: now, updatedAt: now });
    const token = jwt.sign({ id: ownerId, email: `owner-${label}@scratch.test`, role: "FIRM_ADMIN", accountType: "FIRM_USER", firmId, isActive: true, tv: 0 }, process.env.JWT_SECRET, { expiresIn: "30m" });
    return { ownerId, firmId, token };
  }
  const A = await firm("A");
  const B = await firm("B");
  const clientId = oid();
  await raw("clients").insertOne({ _id: clientId, firmId: A.firmId, name: "Catalogue Traders", isActive: true, createdAt: now, updatedAt: now });
  await raw("appconfigs").insertOne({ _id: "singleton", featureFlags: { auditPacks: true }, createdAt: now, updatedAt: now });
  const batch = (kind, extra) => raw("importbatches").insertOne({
    _id: oid(), firmId: A.firmId, clientId, kind, status: "COMPLETED", activeImportGeneration: "gen-x", sourceHash: "a".repeat(64), importFingerprint: `fp-${oid()}`,
    mapping: {}, createdBy: A.ownerId, createdAt: now, updatedAt: now, completedAt: now, validRows: 3, totalRows: 3, ...extra,
  });
  await batch("TDS_DEDUCTIONS", { financialYear: "2025-26", quarter: "Q1", statementType: "24Q", sourceName: "q1-deductions.csv" });
  await batch("TDS_CHALLANS", { financialYear: "2025-26", quarter: "Q2", statementType: "24Q", sourceName: "q2-challans.csv" });
  await batch("TDS_STATEMENTS", { financialYear: "2024-25", quarter: "Q1", statementType: "24Q", sourceName: "last-year.csv" });

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, token) => {
    const response = await fetch(`${base}${path}`, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} });
    return { status: response.status, json: await response.json().catch(() => null) };
  };

  try {
    const signedOut = await call("GET", "/api/audit-packs/kinds", null);
    check("signed out the catalogue is refused", signedOut.status === 401, `status ${signedOut.status}`);
    const listed = await call("GET", "/api/audit-packs/kinds", A.token);
    check("a firm member reads the catalogue, the same kinds the registry holds", listed.status === 200 && JSON.stringify(listed.json?.kinds) === JSON.stringify(describeKinds()), `status ${listed.status}`);
    check("the route's catalogue is consistent with the create routes", catalogueProblems(listed.json?.kinds || [], { createFieldsOf: (k) => getPackKind(k).createFields }).length === 0);
    check("'kinds' is a path, not a pack id (it never reaches the by-id route)", listed.status === 200 && Array.isArray(listed.json?.kinds));

    const sources = await call("GET", `/api/audit-packs/sources?clientId=${clientId}&financialYear=2025-26`, A.token);
    const byKind = Object.fromEntries((sources.json?.batches || []).map((b) => [b.kind, b]));
    check("the sources route lists the year's TDS imports with their quarter", sources.status === 200 && byKind.TDS_DEDUCTIONS?.quarter === "Q1" && byKind.TDS_CHALLANS?.quarter === "Q2" && byKind.TDS_DEDUCTIONS?.statementType === "24Q", JSON.stringify(sources.json?.batches));
    check("a TDS import of another financial year is not listed", !byKind.TDS_STATEMENTS, JSON.stringify(Object.keys(byKind)));
    // AUDIT_PACK_DUMP_DIR: write the real responses so the desktop tests can pin them (see audit-pack-route-contract).
    if (process.env.AUDIT_PACK_DUMP_DIR) {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(process.env.AUDIT_PACK_DUMP_DIR, { recursive: true });
      writeFileSync(`${process.env.AUDIT_PACK_DUMP_DIR}/kinds.json`, JSON.stringify(listed.json, null, 2));
      writeFileSync(`${process.env.AUDIT_PACK_DUMP_DIR}/sources-tds.json`, JSON.stringify(sources.json, null, 2));
    }
    const other = await call("GET", `/api/audit-packs/sources?clientId=${clientId}&financialYear=2025-26`, B.token);
    check("another firm cannot read this client's sources", other.status === 404, `status ${other.status}`);

    await raw("appconfigs").updateOne({ _id: "singleton" }, { $set: { "featureFlags.auditPacks": false } });
    const off = await call("GET", "/api/audit-packs/kinds", A.token);
    check("with auditPacks off the catalogue answers 404 naming the flag", off.status === 404 && off.json?.featureFlag === "auditPacks", `status ${off.status}`);
  } catch (error) {
    check("the flow ran to its end without throwing", false, String(error?.stack || error).split("\n").slice(0, 3).join(" | "));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase().catch(() => {});
    await mongoose.disconnect();
  }
  return checks;
}

async function main() {
  const checks = await runChecks();
  const uri = process.env.MONGODB_URI || "";
  const scratch = /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(uri) && /scratch/i.test((uri.split("/").pop() || "").split("?")[0]);
  let note = "engine only (no scratch MONGODB_URI)";
  if (scratch) {
    checks.push(...(await runRouteChecks(uri)));
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
  console.log(`\naudit-pack-catalogue-contract: ${checks.length - failed}/${checks.length} passed (${note})`);
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) await main();
