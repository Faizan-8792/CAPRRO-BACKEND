// tests/lib/snapshot-pack-routes.mjs
//
// W10 (2026-10-17): one harness that runs any pack built over a books snapshot through the real app - firm,
// client, flag, a sealed snapshot written straight into the collections, the create request, the worker, the
// rows, a decision on every decidable row, the workbook, firm isolation and the flag - so each phase's contract
// only supplies its fixture and what it expects to see.
//
//   const checks = await runSnapshotPackFlow({ uri, label, kind, financialYear, ledgers, vouchers, body, expect });
//
// `body` is merged into the create request (snapshotId is supplied). `expect(ctx)` returns more checks over the
// computed pack; `after(ctx)` does the same once the harness has decided every row and exported; ctx = { call, A, B, run, runId, rows, section(code), raw, snapshotId, clientId }.

import { createHash } from "node:crypto";
import { ensureMockDeepSeek } from "./mock-deepseek.mjs";

export async function runSnapshotPackFlow({
  uri,
  label,
  kind,
  financialYear = "2025-26",
  ledgers,
  vouchers,
  groups = [],
  body = {},
  priorSnapshot = null,
  expect = async () => [],
  decide = null,
  expectedWorkbookSheets = null,
  beforeCreate = null,
  after = null,
}) {
  const checks = [];
  const check = (name, pass, detail = "") => checks.push({ name: `route: ${name}`, pass: Boolean(pass), detail });

  process.env.NODE_ENV = "production";
  process.env.JWT_SECRET = process.env.JWT_SECRET || "scratch-only-secret-not-a-real-credential-0000";
  process.env.DEEPSEEK_API_KEY = "";
  process.env.OCR_SPACE_API_KEY = "";
  // The AI provider is a loopback stand-in with its key blank; a contract that drafts switches it on (ctx.mock.on).
  const mock = await ensureMockDeepSeek();
  mock.reset();

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

  async function buildFirm(tag) {
    const ownerId = oid();
    const firmId = oid();
    await raw("users").insertOne({ _id: ownerId, email: `owner-${tag}@scratch.test`, name: `Owner ${tag}`, role: "FIRM_ADMIN", accountType: "FIRM_USER", isActive: true, tokenVersion: 0, firmId, createdAt: now, updatedAt: now });
    await raw("firms").insertOne({ _id: firmId, name: `${label} ${tag}`, displayName: `${label} ${tag}`, handle: `scratch-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${tag.toLowerCase()}`.slice(0, 40), ownerId, ownerUserId: ownerId, type: "FIRM", isActive: true, joinCode: `J${tag}${Date.now()}`.slice(0, 16), createdAt: now, updatedAt: now });
    await raw("firmmemberships").insertOne({ _id: oid(), firmId, userId: ownerId, status: "ACTIVE", role: "OWNER", memberAccess: "FULL", createdAt: now, updatedAt: now });
    const token = jwt.sign({ id: ownerId, email: `owner-${tag}@scratch.test`, role: "FIRM_ADMIN", accountType: "FIRM_USER", firmId, isActive: true, tv: 0 }, process.env.JWT_SECRET, { expiresIn: "30m" });
    return { ownerId, firmId, token };
  }
  const A = await buildFirm("A");
  const B = await buildFirm("B");
  const clientId = oid();
  await raw("clients").insertOne({ _id: clientId, firmId: A.firmId, name: `${label} Client`, isActive: true, createdAt: now, updatedAt: now });
  await raw("appconfigs").insertOne({ _id: "singleton", featureFlags: { auditPacks: true }, createdAt: now, updatedAt: now });

  async function writeSnapshot({ ledgerDocs, voucherDocs, groupDocs, fy, tag }) {
    const snapshotId = oid();
    const contentHash = createHash("sha256").update(`${tag}:${snapshotId}`).digest("hex");
    const alterIds = [...ledgerDocs, ...voucherDocs].map((d) => d.alterId).filter((n) => Number.isSafeInteger(n));
    await raw("bookssnapshots").insertOne({
      _id: snapshotId, firmId: A.firmId, clientId, financialYear: fy, source: "TALLY_XML", label: tag, schemaVersion: "tally-canonical-v1",
      status: "SEALED", chunkCounts: { groups: 1, ledgers: 1, vouchers: 1 }, chunkLog: [],
      counts: { groups: groupDocs.length, ledgers: ledgerDocs.length, vouchers: voucherDocs.length },
      alterId: { min: alterIds.length ? Math.min(...alterIds) : null, max: alterIds.length ? Math.max(...alterIds) : null },
      voucherDates: { min: null, max: null }, warnings: { recordsWithWarnings: 0, amountsUnreadable: 0, datesUnreadable: 0 },
      contentHash, createdBy: A.ownerId, sealedBy: A.ownerId, sealedAt: now, createdAt: now, updatedAt: now,
    });
    let n = 0;
    if (groupDocs.length) {
      await raw("booksgroups").insertMany(groupDocs.map((g) => ({
        _id: oid(), firmId: A.firmId, snapshotId, chunkToken: "t", recordKey: g.name.toLowerCase(), guid: "", alterId: g.alterId ?? null, name: g.name, parent: g.parent || "", reserved: g.reserved || "",
      })));
    }
    if (ledgerDocs.length) {
      await raw("booksledgers").insertMany(ledgerDocs.map((l) => ({
        _id: oid(), firmId: A.firmId, snapshotId, chunkToken: "t", recordKey: l.name.toLowerCase(), guid: "", alterId: l.alterId ?? null,
        name: l.name, parent: l.parent || "", openingMinor: l.openingMinor ?? null, gstin: l.gstin || "", pan: l.pan || "", gstRegistrationType: l.gstRegistrationType || "",
        isBillwise: l.isBillwise ?? null, creditPeriodDays: l.creditPeriodDays ?? null, udyam: l.udyam || "", warnings: [],
      })));
    }
    if (voucherDocs.length) {
      await raw("booksvouchers").insertMany(voucherDocs.map((v) => {
        n += 1;
        return {
          _id: oid(), firmId: A.firmId, snapshotId, chunkToken: "t", recordKey: v.guid || `k${n}`,
          lineHash: createHash("sha256").update(JSON.stringify(v)).digest("hex"),
          guid: v.guid || `g${n}`, alterId: v.alterId ?? n, date: v.date ?? null, type: v.type || "Journal", number: v.number || String(n),
          narration: v.narration || "", partyLedger: v.partyLedger || "", reference: v.reference || "", cancelled: Boolean(v.cancelled), optional: Boolean(v.optional),
          entries: v.entries || [], bills: v.bills || [], banks: v.banks || [], warnings: v.warnings || [],
        };
      }));
    }
    return String(snapshotId);
  }

  const snapshotId = await writeSnapshot({ ledgerDocs: ledgers, voucherDocs: vouchers, groupDocs: groups, fy: financialYear, tag: "current" });
  const priorSnapshotId = priorSnapshot
    ? await writeSnapshot({ ledgerDocs: priorSnapshot.ledgers, voucherDocs: priorSnapshot.vouchers || [], groupDocs: priorSnapshot.groups || [], fy: priorSnapshot.financialYear, tag: "prior" })
    : null;

  // A pack may read things beside the snapshot (a person's answers); the caller writes them here.
  if (beforeCreate) await beforeCreate({ raw, A, clientId, oid, now, snapshotId });

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, token, payload) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("spreadsheetml")) return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()), headers: response.headers };
    return { status: response.status, json: await response.json().catch(() => null), headers: response.headers };
  };
  const work = () => runAutomationWorkerBatch({ workerId: "snapshot-pack-contract", maxJobs: 5 });

  try {
    const createBody = { kind, clientId: String(clientId), financialYear, snapshotId, ...(priorSnapshotId ? { priorSnapshotId } : {}), ...body };
    const created = await call("POST", "/api/audit-packs", A.token, createBody);
    const runId = created.json?.run?.id;
    check(`${kind}: create answers 202 with a QUEUED run`, created.status === 202 && created.json?.run?.status === "QUEUED" && created.json?.run?.kind === kind, `status ${created.status} ${JSON.stringify(created.json)?.slice(0, 260)}`);
    const again = await call("POST", "/api/audit-packs", A.token, createBody);
    check(`${kind}: the same snapshot and request give the same run back`, again.status === 200 && again.json?.replayed === true && again.json?.run?.id === runId, `status ${again.status}`);
    const summary = await work();
    check(`${kind}: the worker processes the pack`, summary.succeeded >= 1, JSON.stringify(summary));
    const shown = await call("GET", `/api/audit-packs/${runId}`, A.token);
    const run = shown.json?.run;
    check(`${kind}: published to REVIEW with rows`, run?.status === "REVIEW" && run?.rowCount >= 0, JSON.stringify(run)?.slice(0, 300));

    const rows = {};
    for (const section of run?.sections || []) {
      const page = await call("GET", `/api/audit-packs/${runId}/rows?section=${section.code}&limit=100`, A.token);
      rows[section.code] = page.json?.rows || [];
    }
    const ctx = { call, A, B, run, runId, rows, section: (code) => rows[code] || [], raw, snapshotId, priorSnapshotId, clientId, readWorkbookParts, mongoose, work, mock };
    checks.push(...(await expect(ctx)).map((c) => ({ ...c, name: c.name.startsWith("route:") ? c.name : `route: ${c.name}` })));

    // Firm isolation and the snapshot's own boundaries.
    check(`${kind}: another firm reads the pack as 404`, (await call("GET", `/api/audit-packs/${runId}`, B.token)).status === 404);
    check(`${kind}: another firm cannot create a pack from this snapshot`, (await call("POST", "/api/audit-packs", B.token, createBody)).status === 404);
    const noSnapshot = await call("POST", "/api/audit-packs", A.token, { ...createBody, snapshotId: undefined });
    check(`${kind}: a request without a snapshot is refused`, noSnapshot.status === 400, `status ${noSnapshot.status}`);
    await raw("bookssnapshots").updateOne({ _id: new mongoose.Types.ObjectId(snapshotId) }, { $set: { status: "DRAFT" } });
    const draft = await call("POST", "/api/audit-packs", A.token, createBody);
    check(`${kind}: a snapshot that is not sealed is refused 409, even for a request that would replay`, draft.status === 409 && draft.json?.code === "AUDIT_PACK_SOURCE_NOT_READY", `status ${draft.status} ${JSON.stringify(draft.json)?.slice(0, 160)}`);
    await raw("bookssnapshots").updateOne({ _id: new mongoose.Types.ObjectId(snapshotId) }, { $set: { status: "SEALED" } });
    const wrongYear = await call("POST", "/api/audit-packs", A.token, { ...createBody, financialYear: "2024-25" });
    check(`${kind}: a snapshot of another financial year is refused`, wrongYear.status === 400, `status ${wrongYear.status}`);

    // Decide every decidable row, then export.
    const early = await call("GET", `/api/audit-packs/${runId}/export`, A.token);
    const earlyParts = early.bytes ? readWorkbookParts(early.bytes) : new Map();
    check(`${kind}: while rows are undecided the export carries the provisional header`, early.status === 200 && early.headers.get("x-audit-pack-provisional") === "true", `status ${early.status}`);
    let decidedAny = 0;
    for (const section of Object.keys(rows)) {
      // Read again: the pack's own checks may already have decided some rows.
      const current = (await call("GET", `/api/audit-packs/${runId}/rows?section=${section}&limit=100`, A.token)).json?.rows || [];
      for (const row of current) {
        if (!row.decidable || row.decision.state) continue;
        const answer = decide ? decide(row) : row.choices?.options?.[0] ? { state: "CONFIRMED", choice: row.choices.options[0].value, note: "Decided in the contract" } : null;
        if (!answer) continue;
        const res = await call("POST", `/api/audit-packs/${runId}/rows/${row.rowKey}/decision`, A.token, { expectedVersion: row.decision.version, ...answer });
        if (res.status !== 200) check(`${kind}: deciding ${row.label}`, false, `status ${res.status} ${JSON.stringify(res.json)?.slice(0, 200)}`);
        else decidedAny += 1;
      }
    }
    const decidedRun = await call("GET", `/api/audit-packs/${runId}`, A.token);
    const gaps = decidedRun.json?.run?.summary?.totals?.inputGaps ?? 0;
    check(`${kind}: ${decidedAny} row(s) decided; with ${gaps} input gap(s) the pack ${gaps ? "stays provisional" : "is no longer provisional"}`,
      decidedRun.json?.run?.summary?.provisional === (gaps > 0), JSON.stringify(decidedRun.json?.run?.summary?.reasons));
    const final = await call("GET", `/api/audit-packs/${runId}/export`, A.token);
    const finalParts = final.bytes ? readWorkbookParts(final.bytes) : new Map();
    const sheetNames = [...(finalParts.get("xl/workbook.xml")?.toString("utf8") || "").matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]);
    check(`${kind}: the workbook has Read me, For filing, All findings, Pending and Decisions`, ["Read me", "For filing", "All findings", "Pending", "Decisions"].every((n) => sheetNames.includes(n)), sheetNames.join(","));
    if (expectedWorkbookSheets) check(`${kind}: the pack's own sheets are present`, expectedWorkbookSheets.every((n) => sheetNames.includes(n)), sheetNames.join(","));
    if (after) checks.push(...(await after({ ...ctx, rows: undefined })).map((c) => ({ ...c, name: c.name.startsWith("route:") ? c.name : `route: ${c.name}` })));
    const memberId = oid();
    await raw("users").insertOne({ _id: memberId, email: `member-${kind}@scratch.test`, name: "Member", role: "USER", accountType: "FIRM_USER", isActive: true, tokenVersion: 0, firmId: A.firmId, createdAt: now, updatedAt: now });
    await raw("firmmemberships").insertOne({ _id: oid(), firmId: A.firmId, userId: memberId, status: "ACTIVE", role: "MEMBER", memberAccess: "FULL", createdAt: now, updatedAt: now });
    const memberToken = jwt.sign({ id: memberId, email: `member-${kind}@scratch.test`, role: "USER", accountType: "FIRM_USER", firmId: A.firmId, isActive: true, tv: 0 }, process.env.JWT_SECRET, { expiresIn: "30m" });
    check(`${kind}: a member who is not a firm admin cannot export`, (await call("GET", `/api/audit-packs/${runId}/export`, memberToken)).status === 403);
    await raw("appconfigs").updateOne({ _id: "singleton" }, { $set: { "featureFlags.auditPacks": false } });
    const off = await call("GET", "/api/audit-packs", A.token);
    check(`${kind}: with auditPacks off the routes answer 404 naming the flag`, off.status === 404 && off.json?.featureFlag === "auditPacks");
    void earlyParts;
  } catch (error) {
    check("the flow ran to its end without throwing", false, String(error?.stack || error).split("\n").slice(0, 3).join(" | "));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase().catch(() => {});
    await mongoose.disconnect();
  }
  return checks;
}
