// tests/audit-pack-route-contract.mjs
//
// W10 AP6 + AP8 + AP9 (2026-10-15): the Clause 44 pack through the real app and the real
// automation worker, against a scratch database.
//
// Pinned:
//   AP8  create -> 202 QUEUED; the same batches -> the same run (200, replayed); the worker publishes
//        it to REVIEW with every engine row and its evidence; rows read by section; a decision with
//        a stale version is refused 409; another firm reads 404; with auditPacks off every route
//        answers 404 naming the flag.
//   AP6  every supplier the run sees gets a party-master row (seeding the same suppliers twice gives
//        the same parties); a supplier's status moves to COMPOSITION only through a signed-in decision
//        with the user recorded; a stale party version is refused 409; another firm's party is 404.
//   AP9  the export is firm-admin only; while any row is undecided its Clause 44 sheet carries no
//        figures, and once every row is decided it carries columns 2 to 7 in the Indian-grouped
//        rupee format.
//
// The rows here are seeded directly as completed imports (the import path has its own suites); the
// subject is the pack. No AI key is set and no provider is called.
//
// Run: MONGODB_URI=mongodb://127.0.0.1:27117/scratch-audit-pack node tests/audit-pack-route-contract.mjs

const uri = process.env.MONGODB_URI || "";
const scratch = /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(uri) && /scratch/i.test((uri.split("/").pop() || "").split("?")[0]);

if (!scratch) {
  console.error("Refusing to run: MONGODB_URI must be loopback and scratch-marked.");
  process.exitCode = 2;
} else {
  process.exitCode = await runSuite();
}

async function runSuite() {
  const checks = [];
  const check = (name, pass, detail = "") => checks.push({ name, pass: Boolean(pass), detail });

  process.env.NODE_ENV = "production";
  process.env.JWT_SECRET = process.env.JWT_SECRET || "scratch-only-secret-not-a-real-credential-0000";
  process.env.DEEPSEEK_API_KEY = "";
  process.env.OCR_SPACE_API_KEY = "";

  const mongoose = (await import("mongoose")).default;
  const jwt = (await import("jsonwebtoken")).default;
  const { default: app } = await import("../src/app.js");
  const { runAutomationWorkerBatch } = await import("../src/services/automation-worker.service.js");
  const { readWorkbookParts, INDIAN_RUPEE_FORMAT } = await import("../src/services/workbook.service.js");
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
  await mongoose.connection.dropDatabase();
  const { ensureRequiredIndexes } = await import("../src/services/index-provisioning.service.js");
  await ensureRequiredIndexes();

  const raw = (name) => mongoose.connection.collection(name);
  const oid = () => new mongoose.Types.ObjectId();
  const now = new Date();
  const rupees = (value) => Math.round(value * 100);

  async function buildFirm(label) {
    const ownerId = oid();
    const firmId = oid();
    await raw("users").insertOne({ _id: ownerId, email: `owner-${label}@scratch.test`, name: `Owner ${label}`, role: "FIRM_ADMIN", accountType: "FIRM_USER", isActive: true, tokenVersion: 0, firmId, createdAt: now, updatedAt: now });
    await raw("firms").insertOne({ _id: firmId, name: `Pack Firm ${label}`, displayName: `Pack Firm ${label}`, handle: `scratch-pack-${label.toLowerCase()}`, ownerId, ownerUserId: ownerId, type: "FIRM", isActive: true, joinCode: `SCRATCHPACK${label}${Date.now().toString(36).toUpperCase()}`, createdAt: now, updatedAt: now });
    await raw("firmmemberships").insertOne({ _id: oid(), firmId, userId: ownerId, status: "ACTIVE", role: "OWNER", memberAccess: "FULL", createdAt: now, updatedAt: now });
    const token = jwt.sign({ id: ownerId, email: `owner-${label}@scratch.test`, role: "FIRM_ADMIN", accountType: "FIRM_USER", firmId, isActive: true, tv: 0 }, process.env.JWT_SECRET, { expiresIn: "30m" });
    return { ownerId, firmId, token };
  }
  const A = await buildFirm("A");
  const B = await buildFirm("B");
  const clientId = oid();
  await raw("clients").insertOne({ _id: clientId, firmId: A.firmId, name: "ABC Traders Pvt Ltd", isActive: true, createdAt: now, updatedAt: now });
  await raw("appconfigs").insertOne({ _id: "singleton", featureFlags: { auditPacks: true }, createdAt: now, updatedAt: now });

  // ─── completed imports, seeded ────────────────────────────────────────────
  const S1 = "27AAAAA1111A1Z1";
  const S2 = "27BBBBB2222B1Z2";
  const S3 = "27CCCCC3333C1Z3";
  const S4 = "27DDDDD4444D1Z4";
  const batch = async (kind, extra) => {
    const _id = oid();
    await raw("importbatches").insertOne({
      _id, firmId: A.firmId, clientId, kind, status: "COMPLETED", activeImportGeneration: `gen-${_id}`,
      sourceHash: _id.toString().padEnd(64, "a").slice(0, 64), importFingerprint: `fp-${_id}`, mapping: {},
      createdBy: A.ownerId, createdAt: now, updatedAt: now, ...extra,
    });
    return _id;
  };
  const tbBatch = await batch("TRIAL_BALANCE", { financialYear: "2025-26" });
  let sourceRow = 1;
  const ledger = (ledgerName, groupName, closing, extra = {}) => ({
    _id: oid(), firmId: A.firmId, clientId, batchId: tbBatch, importGeneration: `gen-${tbBatch}`, kind: "TRIAL_BALANCE",
    sourceRow: ++sourceRow, sourceHash: "a".repeat(64), rowFingerprint: "b".repeat(64), normalizationVersion: "books-import-v1",
    sourceLabel: "User-imported trial balance", financialYear: "2025-26", ledgerName, groupName,
    openingMinor: 0, hasOpening: false, debitTotalMinor: 0, creditTotalMinor: 0, hasTransactionTotals: false,
    closingMinor: rupees(closing), ...extra,
  });
  await raw("booksimportrows").insertMany([
    ledger("Purchase of Goods", "Purchase Accounts", 5000000),
    ledger("Rent", "Indirect Expenses", 600000),
    ledger("Salaries", "Indirect Expenses", 1200000),
    ledger("Depreciation", "Indirect Expenses", 300000),
    ledger("Sales", "Sales Accounts", -9000000),
  ]);
  const purchaseBatch = await batch("GST_PURCHASE", { period: "2025-05", gstin: "27ZZZZZ9999Z1Z9" });
  const purchase = (gstin, date, taxable, tax, documentType = "INVOICE") => ({
    _id: oid(), firmId: A.firmId, clientId, batchId: purchaseBatch, importGeneration: `gen-${purchaseBatch}`, kind: "GST_PURCHASE",
    sourceHash: "c".repeat(64), sourceRow: ++sourceRow, supplierGstin: gstin, recipientGstin: "27ZZZZZ9999Z1Z9",
    invoiceNumberOriginal: `INV-${sourceRow}`, invoiceNumberNormalized: `INV-${sourceRow}`, documentDate: date, documentType,
    taxableValueMinor: rupees(taxable), igstMinor: rupees(tax), cgstMinor: 0, sgstMinor: 0, cessMinor: 0, totalTaxMinor: rupees(tax),
    reverseCharge: false,
  });
  await raw("importrows").insertMany([
    purchase(S1, "2025-05-10", 2000000, 360000),
    purchase(S2, "2025-07-01", 200000, 0),
    purchase(S3, "2025-08-01", 100000, 0),
    purchase(S4, "2025-12-12", 50000, 9000),
  ]);
  const months = ["2025-04", "2025-05", "2025-06", "2025-07", "2025-08", "2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03"];
  const gstr2bBatches = [];
  for (const period of months) {
    const id = await batch("GSTR2B", { period, gstin: "27ZZZZZ9999Z1Z9" });
    gstr2bBatches.push(id);
    const rows = [];
    if (period === "2025-05") rows.push({ ...purchase(S1, "2025-05-10", 2000000, 360000), batchId: id, importGeneration: `gen-${id}`, kind: "GSTR2B" });
    if (period === "2025-08") rows.push({ ...purchase(S3, "2025-08-01", 100000, 0), batchId: id, importGeneration: `gen-${id}`, kind: "GSTR2B" });
    if (rows.length) await raw("importrows").insertMany(rows);
  }

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, token, body) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("spreadsheetml")) {
      return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()), headers: response.headers };
    }
    return { status: response.status, json: await response.json().catch(() => null), headers: response.headers };
  };
  const work = () => runAutomationWorkerBatch({ workerId: "audit-pack-contract", maxJobs: 5 });

  try {
    const createBody = {
      kind: "CLAUSE44",
      clientId: String(clientId),
      financialYear: "2025-26",
      trialBalanceBatchId: String(tbBatch),
      purchaseBatchIds: [String(purchaseBatch)],
      gstr2bBatchIds: gstr2bBatches.map(String),
    };
    const created = await call("POST", "/api/audit-packs", A.token, createBody);
    const runId = created.json?.run?.id;
    check("AP8: create answers 202 with a QUEUED run", created.status === 202 && created.json?.run?.status === "QUEUED", `status ${created.status} ${JSON.stringify(created.json)?.slice(0, 200)}`);
    const again = await call("POST", "/api/audit-packs", A.token, createBody);
    check("AP8: the same batches give the same run back (200, replayed)", again.status === 200 && again.json?.replayed === true && again.json?.run?.id === runId, `status ${again.status}`);

    const summary = await work();
    check("AP8: the worker processes the pack", summary.succeeded >= 1, JSON.stringify(summary));
    const shown = await call("GET", `/api/audit-packs/${runId}`, A.token);
    const run = shown.json?.run;
    check("AP8: the run is published to REVIEW with every month of 2B loaded",
      shown.status === 200 && run?.status === "REVIEW" && run?.monthsMissing?.length === 0 && run?.rowCount > 0, JSON.stringify(run)?.slice(0, 300));
    check("AP8: its figures are provisional until people decide the rows",
      run?.summary?.provisional === true && run?.summary?.columns?.col2 === rupees(5600000), JSON.stringify(run?.summary)?.slice(0, 300));

    const ledgers = await call("GET", `/api/audit-packs/${runId}/rows?section=LEDGER&limit=100`, A.token);
    const suppliers = await call("GET", `/api/audit-packs/${runId}/rows?section=SUPPLIER&limit=100`, A.token);
    const tieouts = await call("GET", `/api/audit-packs/${runId}/rows?section=TIEOUT&limit=100`, A.token);
    check("AP8: rows read by section (5 ledgers, 4 suppliers, 2 tie-outs)",
      ledgers.json?.rows?.length === 5 && suppliers.json?.rows?.length === 4 && tieouts.json?.rows?.length === 2,
      `${ledgers.json?.rows?.length}/${suppliers.json?.rows?.length}/${tieouts.json?.rows?.length}`);
    const evidence = await raw("auditpackevidencelinks").countDocuments({ runId: new mongoose.Types.ObjectId(runId) });
    check("AP8: every source row behind every pack row is linked (5 ledgers + 4 purchases)", evidence === 9, `${evidence}`);

    // AP6: the suppliers seen are in the party master, UNKNOWN until a person answers.
    const parties = await call("GET", `/api/audit-packs/parties?clientId=${clientId}`, A.token);
    check("AP6: every supplier the run saw has a party row, UNKNOWN until a person answers",
      parties.json?.parties?.length === 4 && parties.json.parties.every((p) => p.gstStatus === "UNKNOWN"), JSON.stringify(parties.json)?.slice(0, 200));

    const s4 = suppliers.json.rows.find((r) => r.party.gstin === S4);
    const noStatus = await call("POST", `/api/audit-packs/${runId}/rows/${s4.rowKey}/decision`, A.token, { expectedVersion: 0, state: "CONFIRMED" });
    check("AP8: a supplier not in GSTR-2B cannot be confirmed without a status", noStatus.status === 400, `status ${noStatus.status}`);
    const decided = await call("POST", `/api/audit-packs/${runId}/rows/${s4.rowKey}/decision`, A.token, { expectedVersion: 0, state: "CONFIRMED", status: "COMPOSITION", note: "Checked on the GST portal" });
    // AUDIT_PACK_DUMP_DIR: write the real responses so the desktop and extension tests can pin them
    // (W10 AP11). Not a check: it only runs when a person asks for the payloads.
    if (process.env.AUDIT_PACK_DUMP_DIR) {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(process.env.AUDIT_PACK_DUMP_DIR, { recursive: true });
      const sources = await call("GET", `/api/audit-packs/sources?clientId=${clientId}&financialYear=2025-26`, A.token);
      const runs = await call("GET", `/api/audit-packs?clientId=${clientId}&financialYear=2025-26`, A.token);
      const dump = { sources: sources.json, runs: runs.json, run: shown.json, ledgers: ledgers.json, suppliers: suppliers.json, tieouts: tieouts.json, decided: decided.json, created: created.json };
      for (const [name, body] of Object.entries(dump)) writeFileSync(`${process.env.AUDIT_PACK_DUMP_DIR}/${name}.json`, JSON.stringify(body, null, 2));
    }
    check("AP8: a decision sets the status and records who decided",
      decided.status === 200 && decided.json?.row?.values?.status === "COMPOSITION" && decided.json?.row?.decision?.decidedBy === String(A.ownerId) && decided.json?.row?.decision?.version === 1,
      `status ${decided.status} ${JSON.stringify(decided.json)?.slice(0, 200)}`);
    const stale = await call("POST", `/api/audit-packs/${runId}/rows/${s4.rowKey}/decision`, A.token, { expectedVersion: 0, state: "CONFIRMED", status: "REGISTERED" });
    check("AP8: a decision made against a stale version is refused 409", stale.status === 409, `status ${stale.status}`);
    const s4Party = await raw("partymasters").findOne({ firmId: A.firmId, gstin: S4 });
    check("AP6: the status reached the party master through the signed-in decision, with the user recorded",
      s4Party?.gstStatus === "COMPOSITION" && String(s4Party?.confirmedBy) === String(A.ownerId));

    const partyRow = (await call("GET", `/api/audit-packs/parties?clientId=${clientId}`, A.token)).json.parties.find((p) => p.gstin === S2);
    const partySet = await call("PATCH", `/api/audit-packs/parties/${partyRow.id}`, A.token, { expectedVersion: partyRow.version, gstStatus: "COMPOSITION" });
    check("AP6: a supplier's status can be set directly, with the user recorded", partySet.status === 200 && partySet.json?.party?.confirmedBy === String(A.ownerId), `status ${partySet.status}`);
    const partyStale = await call("PATCH", `/api/audit-packs/parties/${partyRow.id}`, A.token, { expectedVersion: partyRow.version, gstStatus: "EXEMPT_SUPPLIER" });
    check("AP6: a stale party version is refused 409", partyStale.status === 409, `status ${partyStale.status}`);
    const partyOther = await call("PATCH", `/api/audit-packs/parties/${partyRow.id}`, B.token, { expectedVersion: 1, gstStatus: "EXEMPT_SUPPLIER" });
    check("AP6: another firm's party reads 404", partyOther.status === 404, `status ${partyOther.status}`);

    // AP6: seeding the same suppliers again leaves the same parties, and a person's answer stands.
    const subset = await call("POST", "/api/audit-packs", A.token, { ...createBody, gstr2bBatchIds: gstr2bBatches.slice(0, 11).map(String) });
    await work();
    const partiesAfter = await call("GET", `/api/audit-packs/parties?clientId=${clientId}`, A.token);
    check("AP6: seeding the same suppliers twice gives the same parties, and the answers stand",
      subset.status === 202 && partiesAfter.json?.parties?.length === 4 &&
      partiesAfter.json.parties.find((p) => p.gstin === S4)?.gstStatus === "COMPOSITION",
      JSON.stringify(partiesAfter.json?.parties?.map((p) => [p.gstin, p.gstStatus])));
    const second = await call("GET", `/api/audit-packs/${subset.json?.run?.id}`, A.token);
    check("AP8: a run missing a month of 2B names the month and stays provisional",
      second.json?.run?.monthsMissing?.join(",") === "2026-03" &&
      second.json?.run?.summary?.reasons?.some((r) => r.code === "GSTR2B_MONTHS_MISSING"),
      JSON.stringify(second.json?.run?.summary?.reasons));

    // Firm isolation and the flag.
    const otherFirm = await call("GET", `/api/audit-packs/${runId}`, B.token);
    check("AP8: another firm reads the run as 404", otherFirm.status === 404, `status ${otherFirm.status}`);

    // AP9: the export.
    const provisionalExport = await call("GET", `/api/audit-packs/${runId}/export`, A.token);
    const provisionalParts = provisionalExport.bytes ? readWorkbookParts(provisionalExport.bytes) : new Map();
    const clauseSheet = provisionalParts.get("xl/worksheets/sheet2.xml")?.toString("utf8") || "";
    check("AP9: while rows are undecided, the Clause 44 sheet carries no figures",
      provisionalExport.status === 200 && provisionalExport.headers.get("x-audit-pack-provisional") === "true" &&
      /Provisional/.test(clauseSheet) && !/ s="2"/.test(clauseSheet),
      `status ${provisionalExport.status}`);

    // Decide every row, then export again.
    const allRows = [...ledgers.json.rows, ...suppliers.json.rows];
    for (const row of allRows) {
      const current = (await call("GET", `/api/audit-packs/${runId}/rows?section=${row.section}&limit=100`, A.token)).json.rows.find((r) => r.rowKey === row.rowKey);
      if (current.decision.state) continue;
      const body = { expectedVersion: current.decision.version, state: "CONFIRMED" };
      if (row.section === "SUPPLIER" && current.values.status === "NOT_IN_2B") body.status = "COMPOSITION";
      if (row.section === "SUPPLIER" && current.values.status === "REGISTERED") body.status = "REGISTERED";
      const answer = await call("POST", `/api/audit-packs/${runId}/rows/${row.rowKey}/decision`, A.token, body);
      if (answer.status !== 200) check(`AP8: deciding ${row.label}`, false, `status ${answer.status} ${JSON.stringify(answer.json)}`);
    }
    const decidedRun = await call("GET", `/api/audit-packs/${runId}`, A.token);
    check("AP8: once every row is decided, the figures stand",
      decidedRun.json?.run?.summary?.provisional === false, JSON.stringify(decidedRun.json?.run?.summary?.reasons));
    const finalExport = await call("GET", `/api/audit-packs/${runId}/export`, A.token);
    const finalParts = finalExport.bytes ? readWorkbookParts(finalExport.bytes) : new Map();
    const finalClause = finalParts.get("xl/worksheets/sheet2.xml")?.toString("utf8") || "";
    const styles = finalParts.get("xl/styles.xml")?.toString("utf8") || "";
    check("AP9: the decided Clause 44 sheet carries columns 2 to 7 as money cells",
      finalExport.headers.get("x-audit-pack-provisional") === "false" && (finalClause.match(/ s="2"/g) || []).length === 6,
      `${(finalClause.match(/ s="2"/g) || []).length} money cells`);
    // Escaped exactly as an XML attribute value holds it: & < > " ' are all entities there.
    const escapedFormat = INDIAN_RUPEE_FORMAT
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
    check("AP9: money cells use the Indian-grouped rupee format",
      styles.includes(`<numFmt numFmtId="164" formatCode="${escapedFormat}"/>`) &&
      /<xf numFmtId="164"[^>]*applyNumberFormat="1"\/>/.test(styles));
    check("AP9: column 2 is written exactly (56,00,000.00 = 50,00,000 purchases + 6,00,000 rent)",
      /<v>5600000\.00<\/v>/.test(finalClause));

    // Export needs a firm admin: a plain member is refused.
    const memberId = oid();
    await raw("users").insertOne({ _id: memberId, email: "member-pack@scratch.test", name: "Member", role: "USER", accountType: "FIRM_USER", isActive: true, tokenVersion: 0, firmId: A.firmId, createdAt: now, updatedAt: now });
    await raw("firmmemberships").insertOne({ _id: oid(), firmId: A.firmId, userId: memberId, status: "ACTIVE", role: "MEMBER", memberAccess: "FULL", createdAt: now, updatedAt: now });
    const memberToken = jwt.sign({ id: memberId, email: "member-pack@scratch.test", role: "USER", accountType: "FIRM_USER", firmId: A.firmId, isActive: true, tv: 0 }, process.env.JWT_SECRET, { expiresIn: "30m" });
    const memberExport = await call("GET", `/api/audit-packs/${runId}/export`, memberToken);
    check("AP9: a member who is not a firm admin cannot export", memberExport.status === 403, `status ${memberExport.status}`);

    // Usage counted under its own name.
    const usage = await raw("workflowusages").findOne({ workflow: "audit_pack", userId: A.ownerId });
    check("AP8: requests count as audit_pack usage", (usage?.count || 0) > 0);

    // The flag.
    await raw("appconfigs").updateOne({ _id: "singleton" }, { $set: { "featureFlags.auditPacks": false } });
    const off = await call("GET", "/api/audit-packs", A.token);
    check("AP8: with auditPacks off every route answers 404 naming the flag",
      off.status === 404 && off.json?.featureFlag === "auditPacks", `status ${off.status} ${JSON.stringify(off.json)}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase().catch(() => {});
    await mongoose.disconnect();
  }

  const failed = checks.filter((c) => !c.pass);
  for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.pass || !c.detail ? "" : ` -- ${c.detail}`}`);
  console.log(`\naudit-pack-route-contract: ${checks.length - failed.length}/${checks.length} passed`);
  return failed.length ? 1 : 0;
}
