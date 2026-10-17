// tests/lib/gstr9c-routes.mjs
//
// W10 AP13-AP15: the GSTR-9 / 9C pack through the real Express app, the automation worker and the
// workbook writer, against a scratch MongoDB. Called by audit-pack-gstr9c-contract.mjs; the same hand-worked
// year as the engine checks, written into the database as completed imports.

export async function runRouteChecks({ uri, fixture, MONTHS, rupees }) {
  const checks = [];
  const check = (name, pass, detail = "") => checks.push({ name: `route: ${name}`, pass: Boolean(pass), detail });

  process.env.NODE_ENV = "production";
  process.env.JWT_SECRET = process.env.JWT_SECRET || "scratch-only-secret-not-a-real-credential-0000";
  process.env.DEEPSEEK_API_KEY = "";
  process.env.OCR_SPACE_API_KEY = "";

  const mongoose = (await import("mongoose")).default;
  const jwt = (await import("jsonwebtoken")).default;
  const { default: app } = await import("../../src/app.js");
  const { runAutomationWorkerBatch } = await import("../../src/services/automation-worker.service.js");
  const { readWorkbookParts } = await import("../../src/services/workbook.service.js");
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
  await mongoose.connection.dropDatabase();
  const { ensureRequiredIndexes } = await import("../../src/services/index-provisioning.service.js");
  await ensureRequiredIndexes();

  const raw = (name) => mongoose.connection.collection(name);
  const oid = () => new mongoose.Types.ObjectId();
  const now = new Date();

  async function buildFirm(label) {
    const ownerId = oid();
    const firmId = oid();
    await raw("users").insertOne({ _id: ownerId, email: `owner-${label}@scratch.test`, name: `Owner ${label}`, role: "FIRM_ADMIN", accountType: "FIRM_USER", isActive: true, tokenVersion: 0, firmId, createdAt: now, updatedAt: now });
    await raw("firms").insertOne({ _id: firmId, name: `9C Firm ${label}`, displayName: `9C Firm ${label}`, handle: `scratch-9c-${label.toLowerCase()}`, ownerId, ownerUserId: ownerId, type: "FIRM", isActive: true, joinCode: `J9C${label}${Date.now()}`.slice(0, 16), createdAt: now, updatedAt: now });
    await raw("firmmemberships").insertOne({ _id: oid(), firmId, userId: ownerId, status: "ACTIVE", role: "OWNER", memberAccess: "FULL", createdAt: now, updatedAt: now });
    const token = jwt.sign({ id: ownerId, email: `owner-${label}@scratch.test`, role: "FIRM_ADMIN", accountType: "FIRM_USER", firmId, isActive: true, tv: 0 }, process.env.JWT_SECRET, { expiresIn: "30m" });
    return { ownerId, firmId, token };
  }
  const A = await buildFirm("A");
  const B = await buildFirm("B");
  const clientId = oid();
  await raw("clients").insertOne({ _id: clientId, firmId: A.firmId, name: "Nine C Traders", isActive: true, createdAt: now, updatedAt: now });
  await raw("appconfigs").insertOne({ _id: "singleton", featureFlags: { auditPacks: true }, createdAt: now, updatedAt: now });

  // ─── the year's imports, written as completed batches ───────────────────────────
  const input = fixture();
  const batch = async (kind, extra) => {
    const _id = oid();
    await raw("importbatches").insertOne({
      _id, firmId: A.firmId, clientId, kind, status: "COMPLETED", activeImportGeneration: `gen-${_id}`,
      sourceHash: _id.toString().padEnd(64, "a").slice(0, 64), importFingerprint: `fp-${_id}`, mapping: {},
      createdBy: A.ownerId, createdAt: now, updatedAt: now, ...extra,
    });
    return _id;
  };
  const rowDoc = (batchId, kind, source, extra = {}) => ({
    _id: oid(), firmId: A.firmId, clientId, batchId, importGeneration: `gen-${batchId}`, kind,
    sourceHash: "c".repeat(64), sourceRow: source.sourceRow, ...extra,
  });
  const g1 = {};
  const g3 = {};
  const g2 = [];
  for (const month of MONTHS) {
    const b1 = await batch("GSTR1_SUMMARY", { period: month, gstin: "27ZZZZZ9999Z1Z9" });
    g1[month] = b1;
    await raw("importrows").insertMany(input.gstr1ByMonth[month].rows.map((r) => rowDoc(b1, "GSTR1_SUMMARY", r, {
      summaryCategory: r.summaryCategory, taxableValueMinor: r.taxableValueMinor, igstMinor: r.igstMinor, cgstMinor: 0, sgstMinor: 0, cessMinor: 0, totalTaxMinor: r.totalTaxMinor,
    })));
    const b3 = await batch("GSTR3B_SUMMARY", { period: month, gstin: "27ZZZZZ9999Z1Z9" });
    g3[month] = b3;
    await raw("importrows").insertMany(input.gstr3bByMonth[month].rows.map((r) => rowDoc(b3, "GSTR3B_SUMMARY", r, {
      summaryCategory: r.summaryCategory, taxableValueMinor: r.taxableValueMinor, igstMinor: r.igstMinor, cgstMinor: 0, sgstMinor: 0, cessMinor: 0, totalTaxMinor: r.totalTaxMinor,
    })));
    const b2 = await batch("GSTR2B", { period: month, gstin: "27ZZZZZ9999Z1Z9" });
    g2.push(b2);
    await raw("importrows").insertMany(input.gstr2b.filter((d) => d.batchId === `B-2B-${month}`).map((d) => rowDoc(b2, "GSTR2B", d, {
      supplierGstin: d.supplierGstin, documentDate: d.documentDate, documentType: d.documentType, taxableValueMinor: 0, igstMinor: d.igstMinor, cgstMinor: 0, sgstMinor: 0, cessMinor: 0, totalTaxMinor: d.totalTaxMinor,
    })));
  }
  const tbBatch = await batch("TRIAL_BALANCE", { financialYear: "2025-26" });
  await raw("booksimportrows").insertMany(input.trialBalance.map((l) => ({
    _id: oid(), firmId: A.firmId, clientId, batchId: tbBatch, importGeneration: `gen-${tbBatch}`, kind: "TRIAL_BALANCE",
    sourceRow: l.sourceRow, sourceHash: "a".repeat(64), rowFingerprint: "b".repeat(64), normalizationVersion: "books-import-v1",
    sourceLabel: "User-imported trial balance", financialYear: "2025-26", ledgerName: l.ledgerName, groupName: l.groupName,
    openingMinor: 0, hasOpening: false, debitTotalMinor: l.debitTotalMinor, creditTotalMinor: 0, hasTransactionTotals: l.hasTransactionTotals, closingMinor: l.closingMinor,
  })));

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
    if (contentType.includes("spreadsheetml")) return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()), headers: response.headers };
    return { status: response.status, json: await response.json().catch(() => null), headers: response.headers };
  };
  const work = () => runAutomationWorkerBatch({ workerId: "audit-pack-9c-contract", maxJobs: 5 });

  const figures = {
    "4N": { taxableMinor: rupees(22800000) },
    "5N": { taxableMinor: rupees(24000000) },
    "6A": { igstMinor: rupees(1200000) },
    "8A": { igstMinor: rupees(1200000) },
    "8C": { igstMinor: rupees(20000) },
  };
  const body = {
    kind: "GSTR9C",
    clientId: String(clientId),
    financialYear: "2025-26",
    gstr1BatchIds: MONTHS.map((m) => String(g1[m])),
    gstr3bBatchIds: MONTHS.map((m) => String(g3[m])),
    gstr2bBatchIds: g2.map(String),
    trialBalanceBatchId: String(tbBatch),
    gstr9: { figures },
  };

  try {
    const created = await call("POST", "/api/audit-packs", A.token, body);
    const runId = created.json?.run?.id;
    check("create answers 202 with a QUEUED GSTR9C run", created.status === 202 && created.json?.run?.status === "QUEUED" && created.json?.run?.kind === "GSTR9C" && created.json?.run?.ruleVersion === "gstr9c-v1", `status ${created.status} ${JSON.stringify(created.json)?.slice(0, 240)}`);
    const again = await call("POST", "/api/audit-packs", A.token, body);
    check("the same imports and figures give the same run back", again.status === 200 && again.json?.replayed === true && again.json?.run?.id === runId, `status ${again.status}`);
    const changed = await call("POST", "/api/audit-packs", A.token, { ...body, gstr9: { figures: { ...figures, "5N": { taxableMinor: rupees(12000001) } } } });
    check("a changed GSTR-9 figure makes a new pack", changed.status === 202 && changed.json?.run?.id !== runId, `status ${changed.status}`);

    const summary = await work();
    check("the worker processes the packs", summary.succeeded >= 1, JSON.stringify(summary));
    const shown = await call("GET", `/api/audit-packs/${runId}`, A.token);
    const run = shown.json?.run;
    check("published to REVIEW with 19 rows (12 months, 3 turnover, 4 ITC)", run?.status === "REVIEW" && run?.rowCount === 19, JSON.stringify(run)?.slice(0, 300));
    check("the run names its sections for a client that does not know the pack", run?.sections?.map((s) => s.code).join(",") === "MONTHLY,TURNOVER,ITC");
    check("its summary is provisional until rows are decided", run?.summary?.provisional === true && run?.summary?.reasons?.some((r) => r.code === "ROWS_NOT_DECIDED"), JSON.stringify(run?.summary?.reasons));

    const itc = await call("GET", `/api/audit-packs/${runId}/rows?section=ITC&limit=100`, A.token);
    check("rows read by section, each with display lines and its choices", itc.status === 200 && itc.json?.rows?.length === 4 && itc.json.rows.every((r) => Array.isArray(r.lines) && r.lines.length >= 3 && r.choices?.field === "choice"), JSON.stringify(itc.json)?.slice(0, 200));
    const bad = await call("GET", `/api/audit-packs/${runId}/rows?section=LEDGER`, A.token);
    check("a section the pack does not have is refused", bad.status === 400, `status ${bad.status}`);
    const turnover = await call("GET", `/api/audit-packs/${runId}/rows?section=TURNOVER&limit=100`, A.token);
    const books = turnover.json?.rows?.find((r) => r.label.startsWith("Books turnover"));
    check("the books turnover row carries 1,00,000 of unexplained difference in paise", books?.values?.differenceMinor === -rupees(100000), JSON.stringify(books?.values));
    const g1row = turnover.json?.rows?.find((r) => r.label.startsWith("GSTR-1 turnover"));
    check("an amount above Int32 paise survives the database and the API", g1row?.values?.leftMinor === 2_280_000_000, JSON.stringify(g1row?.values));

    // Decisions.
    const noReason = await call("POST", `/api/audit-packs/${runId}/rows/${books.rowKey}/decision`, A.token, { expectedVersion: 0, state: "CONFIRMED" });
    check("a difference cannot be confirmed without a reason (400, public code)", noReason.status === 400 && noReason.json?.code === "AUDIT_PACK_DECISION_REFUSED", `status ${noReason.status} ${JSON.stringify(noReason.json)}`);
    const withTreatment = await call("POST", `/api/audit-packs/${runId}/rows/${books.rowKey}/decision`, A.token, { expectedVersion: 0, state: "CONFIRMED", treatment: "REVENUE_EXPENDITURE" });
    check("a Clause 44 treatment is refused on this pack", withTreatment.status === 400, `status ${withTreatment.status}`);
    const unexplained = await call("POST", `/api/audit-packs/${runId}/rows/${books.rowKey}/decision`, A.token, { expectedVersion: 0, state: "CONFIRMED", choice: "UNEXPLAINED" });
    check("'not explained' is accepted and recorded with who and when", unexplained.status === 200 && unexplained.json?.row?.decision?.choice === "UNEXPLAINED" && unexplained.json.row.decision.decidedBy === String(A.ownerId) && unexplained.json.row.decision.version === 1, `status ${unexplained.status} ${JSON.stringify(unexplained.json)?.slice(0, 200)}`);
    const stale = await call("POST", `/api/audit-packs/${runId}/rows/${books.rowKey}/decision`, A.token, { expectedVersion: 0, state: "CONFIRMED", choice: "ROUNDING" });
    check("a decision against a stale version is refused 409", stale.status === 409 && stale.json?.code === "AUDIT_PACK_ROW_CHANGED", `status ${stale.status}`);

    // Export while provisional.
    const early = await call("GET", `/api/audit-packs/${runId}/export`, A.token);
    const earlyParts = early.bytes ? readWorkbookParts(early.bytes) : new Map();
    const earlySheet = earlyParts.get("xl/worksheets/sheet2.xml")?.toString("utf8") || "";
    check("while rows are undecided the Reconciliation sheet certifies nothing", early.status === 200 && early.headers.get("x-audit-pack-provisional") === "true" && /No reconciliation is certified/.test(earlySheet) && !/ s="2"/.test(earlySheet), `status ${early.status}`);

    // Decide every other decidable row.
    for (const section of ["MONTHLY", "TURNOVER", "ITC"]) {
      const list = (await call("GET", `/api/audit-packs/${runId}/rows?section=${section}&limit=100`, A.token)).json.rows;
      for (const row of list) {
        if (!row.decidable || row.decision.state) continue;
        const differs = row.values.differenceMinor !== 0 && !row.values.withinRounding;
        const answer = await call("POST", `/api/audit-packs/${runId}/rows/${row.rowKey}/decision`, A.token, { expectedVersion: row.decision.version, state: "CONFIRMED", ...(differs ? { choice: "OTHER_EXPLAINED", note: "Worked in the fixture" } : {}) });
        if (answer.status !== 200) check(`deciding ${row.label}`, false, `status ${answer.status} ${JSON.stringify(answer.json)}`);
      }
    }
    const decided = await call("GET", `/api/audit-packs/${runId}`, A.token);
    check("once every row is decided the pack is no longer provisional, and the unexplained residual is still named",
      decided.json?.run?.summary?.provisional === false && decided.json.run.summary.reasons.some((r) => r.code === "UNEXPLAINED_RESIDUALS" && r.blocking === false), JSON.stringify(decided.json?.run?.summary?.reasons));
    const final = await call("GET", `/api/audit-packs/${runId}/export`, A.token);
    const finalParts = final.bytes ? readWorkbookParts(final.bytes) : new Map();
    const reconciliation = finalParts.get("xl/worksheets/sheet2.xml")?.toString("utf8") || "";
    check("the decided Reconciliation sheet carries money cells and the Indian rupee format", final.headers.get("x-audit-pack-provisional") === "false" && (reconciliation.match(/ s="2"/g) || []).length >= 10 && /<v>22800000\.00<\/v>/.test(reconciliation), `${(reconciliation.match(/ s="2"/g) || []).length} money cells`);
    const memberId = oid();
    await raw("users").insertOne({ _id: memberId, email: "member-9c@scratch.test", name: "Member", role: "USER", accountType: "FIRM_USER", isActive: true, tokenVersion: 0, firmId: A.firmId, createdAt: now, updatedAt: now });
    await raw("firmmemberships").insertOne({ _id: oid(), firmId: A.firmId, userId: memberId, status: "ACTIVE", role: "MEMBER", memberAccess: "FULL", createdAt: now, updatedAt: now });
    const memberToken = jwt.sign({ id: memberId, email: "member-9c@scratch.test", role: "USER", accountType: "FIRM_USER", firmId: A.firmId, isActive: true, tv: 0 }, process.env.JWT_SECRET, { expiresIn: "30m" });
    const memberExport = await call("GET", `/api/audit-packs/${runId}/export`, memberToken);
    check("a member who is not a firm admin cannot export", memberExport.status === 403, `status ${memberExport.status}`);

    // Refusals.
    const float = await call("POST", "/api/audit-packs", A.token, { ...body, gstr9: { figures: { "4N": { taxableMinor: 10.5 } } } });
    check("a GSTR-9 figure that is not whole paise is refused", float.status === 400 && /whole number of paise/.test(float.json?.error || float.json?.message || ""), `status ${float.status} ${JSON.stringify(float.json)}`);
    const no4n = await call("POST", "/api/audit-packs", A.token, { ...body, gstr9: { figures: { "5N": { taxableMinor: 1 } } } });
    check("table 4N is required", no4n.status === 400, `status ${no4n.status}`);
    const twice = await call("POST", "/api/audit-packs", A.token, { ...body, gstr1BatchIds: [String(g1["2025-04"]), String(g1["2025-04"])] });
    check("the same GSTR-1 import chosen twice is refused", twice.status === 400, `status ${twice.status}`);
    const wrongKind = await call("POST", "/api/audit-packs", A.token, { ...body, gstr1BatchIds: [String(g3["2025-04"])] });
    check("a GSTR-3B import offered as GSTR-1 is refused", wrongKind.status === 400, `status ${wrongKind.status}`);
    const strangeField = await call("POST", "/api/audit-packs", A.token, { ...body, purchaseBatchIds: [] });
    check("a field only Clause 44 takes is refused on this pack", strangeField.status === 400, `status ${strangeField.status}`);
    const clause44WithFigures = await call("POST", "/api/audit-packs", A.token, { kind: "CLAUSE44", clientId: String(clientId), financialYear: "2025-26", trialBalanceBatchId: String(tbBatch), gstr9: { figures } });
    check("a Clause 44 request carrying GSTR-9 figures is refused", clause44WithFigures.status === 400, `status ${clause44WithFigures.status}`);
    const foreign = await call("GET", `/api/audit-packs/${runId}`, B.token);
    check("another firm reads the pack as 404", foreign.status === 404, `status ${foreign.status}`);
    await raw("appconfigs").updateOne({ _id: "singleton" }, { $set: { "featureFlags.auditPacks": false } });
    const off = await call("GET", "/api/audit-packs", A.token);
    check("with auditPacks off the routes answer 404 naming the flag", off.status === 404 && off.json?.featureFlag === "auditPacks", `status ${off.status}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase().catch(() => {});
    await mongoose.disconnect();
  }
  return checks;
}
