// End-to-end proof that the three GST reconciliations work through the REAL server.
//
// Not a unit test: this boots the actual Express app against a scratch MongoDB, seeds a real user,
// firm and client, imports five real files through the real preview+commit routes, creates a real
// reconciliation run, runs the real generation job, and reads the real 3b-control response.
//
// Every expected figure below is computed by hand in the comments, so a wrong answer is visible as
// a wrong answer rather than as "the code agrees with itself".
//
// Safety: refuses to run unless MONGODB_URI is loopback AND the database name carries a scratch
// marker, and drops that database in a finally.

import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// Captured BEFORE .env is read, and .env's own MONGODB_URI is then refused outright below.
// .env points at the production cluster; letting it fill this in would hand a suite that drops
// its database the address of the real one.
const injected = process.env.MONGODB_URI || "";

// ─── environment, from .env, EXCEPT the database ───────────────────────────────────────────
for (const line of readFileSync(join(repoRoot, ".env"), "utf8").split(/\r?\n/)) {
  const eq = line.indexOf("=");
  if (eq < 1 || line.trim().startsWith("#")) continue;
  const key = line.slice(0, eq).trim();
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
  if (key === "MONGODB_URI") continue;
  if (process.env[key] === undefined) {
    process.env[key] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
}

// Follows this repo's existing convention for a Mongo-dependent suite: run-gates.ps1 probes for a
// local Mongo and, when it finds one, injects MONGODB_URI pointing at a scratch database named for
// this suite. With no MONGODB_URI the suite SKIPS rather than fails, so a machine without Docker
// still gets a green gate run and is told plainly which assertions did not execute.
if (!injected) {
  console.log(
    "GST reconciliation end-to-end: SKIPPED - no MONGODB_URI.\n"
      + "This suite boots the real server against a scratch database and drives a full three-way\n"
      + "reconciliation through the real import, run and control routes. Start a local Mongo and\n"
      + "re-run the gates to include it.",
  );
  process.exit(0);
}

// Loopback AND a scratch marker, checked before anything is imported. This suite drops its
// database, so running it against a real one would destroy a firm's data.
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)[:/]/.test(injected) || !/scratch/i.test(injected)) {
  console.error(
    "REFUSED: MONGODB_URI must be loopback and carry a scratch marker. This suite drops its\n"
      + "database and will not run against anything else.",
  );
  process.exit(1);
}

const SCRATCH_DB = new URL(injected).pathname.replace(/^\//, "");
process.env.NODE_ENV = "development";
// No outbound provider calls from a test run.
process.env.DEEPSEEK_API_KEY = "";
process.env.OCR_SPACE_API_KEY = "";
process.env.RESEND_API_KEY = "";

const checks = [];
const check = (name, pass, detail = "") => {
  checks.push({ name, pass, detail });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
};

const toFileUrl = (...segments) => pathToFileURL(join(repoRoot, ...segments)).href;

const GSTIN = "27AAAAA0000A1Z5";
const SUPPLIER = "27BBBBB0000B1Z5";
const PERIOD = "2026-04";

// ─── the files, and the arithmetic they should produce ────────────────────────────────────
//
// Books and portal carry the SAME single invoice, so it matches and its credit is eligible:
//   taxable 1,00,000.00   IGST 18,000.00        -> eligible ITC 18,000.00
//
// GSTR-3B carries BOTH tables in one file:
//   Table 4  ITC_CLAIMED           IGST 18,000.00      -> claimed 18,000.00
//   Table 3.1 OUTWARD_TAXABLE      taxable 5,00,000.00  IGST 90,000.00
//   Table 3.1 OUTWARD_ZERO_RATED   taxable 1,00,000.00  IGST 0
//   Table 3.1 INWARD_REVERSE_CHARGE taxable 50,000.00   IGST 9,000.00  <- must NOT count as outward
//   -> GSTR-3B outward turnover = 5,00,000 + 1,00,000 = 6,00,000.00 ; IGST 90,000.00
//
// GSTR-1:
//   B2B       taxable 5,50,000.00  IGST 99,000.00
//   EXPORT    taxable 1,00,000.00  IGST 0
//   CDNR      taxable   20,000.00  IGST  3,600.00   <- SUBTRACTED (credit note)
//   NIL_RATED taxable   40,000.00  IGST 0           <- EXCLUDED from turnover
//   -> GSTR-1 turnover = 5,50,000 + 1,00,000 - 20,000 = 6,30,000.00 ; IGST 99,000 - 3,600 = 95,400.00
//
// TURNOVER DIFFERENCE = GSTR-1 - GSTR-3B = 6,30,000 - 6,00,000 = +30,000.00  (positive: GSTR-1 more)
//                                   IGST = 95,400 - 90,000     = + 5,400.00
//
// Credit ledger (movements only, no stated closing):
//   OPENING_BALANCE IGST  5,000.00
//   CREDIT          IGST 18,000.00
//   DEBIT           IGST 20,000.00
//   -> closing = 5,000 + 18,000 - 20,000 = 3,000.00, basis COMPUTED_FROM_MOVEMENT
//
// The ledger RECEIVED 18,000 this period, which is what the 18,000 claim is compared against:
//   difference = claimed - received = 18,000 - 18,000 = 0, so they AGREE.
// The closing balance is 3,000, because 20,000 was lawfully utilised and 5,000 carried forward.
// Comparing the claim against that stock instead would invent a 15,000 shortfall.

const M = (rupees) => Math.round(rupees * 100);

const EXPECT = {
  eligibleIgstMinor: M(18000),
  claimedIgstMinor: M(18000),
  gstr3bOutwardTaxableMinor: M(600000),
  gstr3bOutwardIgstMinor: M(90000),
  gstr1TurnoverTaxableMinor: M(630000),
  gstr1TurnoverIgstMinor: M(95400),
  turnoverDiffTaxableMinor: M(30000),
  turnoverDiffIgstMinor: M(5400),
  ledgerClosingIgstMinor: M(3000),
  ledgerCreditedIgstMinor: M(18000),
};

const INVOICE_HEADERS =
  "Supplier GSTIN,Recipient GSTIN,Invoice Number,Document Date,Document Type,Taxable Value,IGST,CGST,SGST,Cess";
const invoiceCsv = (prefix) =>
  `${INVOICE_HEADERS}\n${SUPPLIER},${GSTIN},${prefix}INV-1,2026-04-05,Invoice,100000.00,18000.00,0.00,0.00,0.00`;

const GSTR3B_CSV = [
  "Category,Taxable Value,IGST,CGST,SGST,Cess",
  "ITC_CLAIMED,0.00,18000.00,0.00,0.00,0.00",
  "OUTWARD_TAXABLE,500000.00,90000.00,0.00,0.00,0.00",
  "OUTWARD_ZERO_RATED,100000.00,0.00,0.00,0.00,0.00",
  "INWARD_REVERSE_CHARGE,50000.00,9000.00,0.00,0.00,0.00",
].join("\n");

const GSTR1_CSV = [
  "Category,Taxable Value,IGST,CGST,SGST,Cess",
  "B2B,550000.00,99000.00,0.00,0.00,0.00",
  "EXPORT,100000.00,0.00,0.00,0.00,0.00",
  "CDNR,20000.00,3600.00,0.00,0.00,0.00",
  "NIL_RATED,40000.00,0.00,0.00,0.00,0.00",
].join("\n");

const LEDGER_CSV = [
  "Category,IGST,CGST,SGST,Cess",
  "OPENING_BALANCE,5000.00,0.00,0.00,0.00",
  "CREDIT,18000.00,0.00,0.00,0.00",
  "DEBIT,20000.00,0.00,0.00,0.00",
].join("\n");

const INVOICE_MAPPING = {
  supplierGstin: "Supplier GSTIN",
  recipientGstin: "Recipient GSTIN",
  invoiceNumber: "Invoice Number",
  documentDate: "Document Date",
  documentType: "Document Type",
  taxableValue: "Taxable Value",
  igst: "IGST",
  cgst: "CGST",
  sgst: "SGST",
  cess: "Cess",
};
const SUMMARY_MAPPING = {
  category: "Category",
  taxableValue: "Taxable Value",
  igst: "IGST",
  cgst: "CGST",
  sgst: "SGST",
  cess: "Cess",
};
const LEDGER_MAPPING = {
  category: "Category",
  igst: "IGST",
  cgst: "CGST",
  sgst: "SGST",
  cess: "Cess",
};

let server = null;

try {
  const { connectDB } = await import(toFileUrl("src", "config", "db.js"));
  const { default: app } = await import(toFileUrl("src", "app.js"));
  const { default: User } = await import(toFileUrl("src", "models", "User.js"));
  const { default: AppConfig, DEFAULT_FEATURE_FLAGS } = await import(
    toFileUrl("src", "models", "AppConfig.js"),
  );
  const { ensurePersonalFirm } = await import(
    toFileUrl("src", "services", "firm-provisioning.service.js"),
  );
  const { ensureRequiredIndexes } = await import(
    toFileUrl("src", "services", "index-provisioning.service.js"),
  );
  const { processGstReconciliationJob } = await import(
    toFileUrl("src", "services", "gst-reconciliation.service.js"),
  );

  await connectDB();
  if (mongoose.connection.name !== SCRATCH_DB) {
    throw new Error(`connected to ${mongoose.connection.name}, expected ${SCRATCH_DB}`);
  }
  await mongoose.connection.dropDatabase();

  const indexOutcome = await ensureRequiredIndexes();
  if (indexOutcome.failures?.length) {
    console.log("  index provisioning failures: " + JSON.stringify(indexOutcome.failures).slice(0, 300));
  }

  await AppConfig.create({
    _id: "singleton",
    featureFlags: Object.fromEntries(Object.keys(DEFAULT_FEATURE_FLAGS).map((k) => [k, true])),
  });

  let user = await User.create({
    email: "e2e-gst@example.invalid",
    name: "E2E GST User",
    role: "USER",
    accountType: "INDIVIDUAL",
    isActive: true,
  });
  user = await ensurePersonalFirm(user);

  const token = jwt.sign(
    {
      id: String(user._id),
      email: user.email,
      role: user.role,
      accountType: user.accountType,
      firmId: user.firmId,
      isActive: user.isActive,
      tv: user.tokenVersion || 0,
    },
    process.env.JWT_SECRET,
    { expiresIn: "1h" },
  );

  server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, path, body) {
    const res = await fetch(`${base}/${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text };
  }

  // ─── a client to hang the imports off ───────────────────────────────────────────────────
  const clientRes = await call("POST", "api/taxworker/clients", {
    name: "E2E Traders Pvt Ltd",
    gstin: GSTIN,
    entityType: "COMPANY",
  });
  const clientId = clientRes.json?.client?._id || clientRes.json?.client?.id || clientRes.json?._id;
  check("a client can be created", Boolean(clientId), clientId ? String(clientId) : JSON.stringify(clientRes.json).slice(0, 200));
  if (!clientId) throw new Error("no client");

  // ─── the suggest-mapping endpoint, on a real messy GSTR-1 ───────────────────────────────
  const messyGstr1 = [
    "E2E TRADERS PRIVATE LIMITED",
    "GSTR-1 summary for April 2026",
    "",
    "Nature of Supply;Total Taxable Value;Integrated Tax;Central Tax;State/UT Tax;Cess",
    "B2B;550000.00;99000.00;0.00;0.00;0.00",
  ].join("\n");
  const suggest = await call("POST", "api/imports/suggest-mapping", {
    kind: "GSTR1_SUMMARY",
    text: messyGstr1,
  });
  const s = suggest.json?.suggestion;
  check(
    "suggest-mapping reads a semicolon file with a two-line preamble and the portal's wording",
    suggest.status === 200
      && s?.delimiter === ";"
      && s?.complete === true
      && s?.suggestedMapping?.category === "Nature of Supply"
      && s?.suggestedMapping?.taxableValue === "Total Taxable Value"
      && s?.suggestedMapping?.sgst === "State/UT Tax",
    suggest.status === 200 ? JSON.stringify(s?.suggestedMapping) : JSON.stringify(suggest.json).slice(0, 200),
  );

  // ─── import all five files through the real preview + commit routes ─────────────────────
  async function commitImport(kind, text, mapping) {
    const body = { kind, text, mapping, delimiter: ",", clientId: String(clientId), gstin: GSTIN, period: PERIOD };
    const preview = await call("POST", "api/imports/preview", body);
    const sourceHash = preview.json?.preview?.sourceHash;
    if (!sourceHash) {
      return { error: `preview ${preview.status}: ${JSON.stringify(preview.json).slice(0, 300)}` };
    }
    const previewToken = preview.json?.preview?.commitToken ?? preview.json?.preview?.previewToken ?? preview.json?.previewToken;
    const resolvedOrder = preview.json?.preview?.dateOrder?.resolved ?? null;
    const commit = await call("POST", `api/imports/${encodeURIComponent(sourceHash)}/commit`, {
      ...body,
      ...(resolvedOrder ? { dateOrder: resolvedOrder } : {}),
      ...(previewToken ? { previewToken } : {}),
    });
    const batchId = commit.json?.batch?._id ?? commit.json?.batch?.id ?? commit.json?.batchId;
    if (!batchId) {
      return { error: `commit ${commit.status}: ${JSON.stringify(commit.json).slice(0, 300)}`, preview: preview.json?.preview };
    }
    return { batchId: String(batchId), preview: preview.json?.preview };
  }

  const books = await commitImport("GST_PURCHASE", invoiceCsv("B"), INVOICE_MAPPING);
  check("the purchase register imports", Boolean(books.batchId), books.error || books.batchId);

  const portal = await commitImport("GSTR2B", invoiceCsv("P"), INVOICE_MAPPING);
  check("GSTR-2B imports", Boolean(portal.batchId), portal.error || portal.batchId);

  const gstr3b = await commitImport("GSTR3B_SUMMARY", GSTR3B_CSV, SUMMARY_MAPPING);
  check("a GSTR-3B carrying BOTH Table 4 and Table 3.1 imports", Boolean(gstr3b.batchId), gstr3b.error || gstr3b.batchId);

  const gstr1 = await commitImport("GSTR1_SUMMARY", GSTR1_CSV, SUMMARY_MAPPING);
  check("a GSTR-1 summary imports (new kind)", Boolean(gstr1.batchId), gstr1.error || gstr1.batchId);

  const ledger = await commitImport("ECREDIT_LEDGER", LEDGER_CSV, LEDGER_MAPPING);
  check("an electronic credit ledger imports (new kind)", Boolean(ledger.batchId), ledger.error || ledger.batchId);

  if (!books.batchId || !portal.batchId) throw new Error("cannot continue without books and portal");

  // ─── create the run with all four sources ──────────────────────────────────────────────
  const created = await call("POST", "api/gst-reconciliation/runs", {
    clientId: String(clientId),
    gstin: GSTIN,
    period: PERIOD,
    booksBatchId: books.batchId,
    portalBatchId: portal.batchId,
    gstr3bBatchId: gstr3b.batchId,
    gstr1BatchId: gstr1.batchId,
    creditLedgerBatchId: ledger.batchId,
  });
  const run = created.json?.run;
  const runId = run?._id || run?.id;
  check("a run accepts all four import sources", Boolean(runId), runId ? String(runId) : JSON.stringify(created.json).slice(0, 300));
  if (!runId) throw new Error("no run");

  check(
    "the run echoes back the two NEW sources it was given",
    run.sourceImports?.gstr1BatchId === gstr1.batchId
      && run.sourceImports?.creditLedgerBatchId === ledger.batchId,
    JSON.stringify(run.sourceImports),
  );

  // ─── run the real generation job (no worker daemon in this harness) ────────────────────
  const { default: AutomationJob } = await import(toFileUrl("src", "models", "AutomationJob.js"));
  const job = await AutomationJob.findById(run.jobId);
  check("creating a run enqueued a generation job", Boolean(job), job ? String(job._id) : "none");
  if (job) {
    await processGstReconciliationJob(job);
  }

  // ─── the control response: all three reconciliations, from one run ─────────────────────
  const controlRes = await call("GET", `api/gst-reconciliation/runs/${runId}/3b-control`);
  const c = controlRes.json?.control;
  check("the control comparison is readable", controlRes.status === 200 && Boolean(c),
    controlRes.status === 200 ? "" : `${controlRes.status} ${JSON.stringify(controlRes.json).slice(0, 300)}`);

  if (c) {
    // --- 1. ITC (pre-existing, must be unchanged) ---
    // Nothing is eligible until a person has reviewed it. That is the product's premise, not a
    // gap, so a freshly generated run correctly shows the whole GSTR-3B claim as not yet
    // supported by review, and the difference is the negative of the claim.
    check(
      "ITC: an unreviewed run shows the whole claim as not yet supported by review",
      c.eligible?.igstMinor === 0
        && c.claimedGstr3b?.igstMinor === EXPECT.claimedIgstMinor
        && c.difference?.igstMinor === -EXPECT.claimedIgstMinor,
      `eligible ${c.eligible?.igstMinor} claimed ${c.claimedGstr3b?.igstMinor} diff ${c.difference?.igstMinor}`,
    );
    check(
      "ITC: a file carrying an ITC_CLAIMED row reports the NET_ITC_CLAIMED basis",
      c.claimedBasis === "NET_ITC_CLAIMED",
      String(c.claimedBasis),
    );

    // --- 2. turnover ---
    const t = c.turnover;
    check("turnover: the comparison ran", t?.available === true && t?.hasImportedGstr1 === true && t?.hasImportedGstr3bOutward === true,
      JSON.stringify({ available: t?.available, g1: t?.hasImportedGstr1, g3: t?.hasImportedGstr3bOutward }));
    check(
      "turnover: GSTR-3B Table 3.1 totals 6,00,000 — inward reverse charge is NOT counted as outward",
      t?.gstr3b?.taxableValueMinor === EXPECT.gstr3bOutwardTaxableMinor
        && t?.gstr3b?.igstMinor === EXPECT.gstr3bOutwardIgstMinor,
      `taxable ${t?.gstr3b?.taxableValueMinor} (want ${EXPECT.gstr3bOutwardTaxableMinor}), igst ${t?.gstr3b?.igstMinor}`,
    );
    check(
      "turnover: GSTR-1 totals 6,30,000 — credit notes subtracted, nil-rated excluded",
      t?.gstr1?.taxableValueMinor === EXPECT.gstr1TurnoverTaxableMinor
        && t?.gstr1?.igstMinor === EXPECT.gstr1TurnoverIgstMinor,
      `taxable ${t?.gstr1?.taxableValueMinor} (want ${EXPECT.gstr1TurnoverTaxableMinor}), igst ${t?.gstr1?.igstMinor} (want ${EXPECT.gstr1TurnoverIgstMinor})`,
    );
    check(
      "turnover: the difference is +30,000 — POSITIVE means GSTR-1 declared more",
      t?.difference?.taxableValueMinor === EXPECT.turnoverDiffTaxableMinor
        && t?.difference?.igstMinor === EXPECT.turnoverDiffIgstMinor
        && t?.agrees === false,
      `taxable ${t?.difference?.taxableValueMinor} (want +${EXPECT.turnoverDiffTaxableMinor}), igst ${t?.difference?.igstMinor}, agrees ${t?.agrees}`,
    );

    // --- 3. credit ledger ---
    const l = c.creditLedger;
    check("ledger: the comparison ran", l?.available === true && l?.hasImportedLedger === true,
      JSON.stringify({ available: l?.available, imported: l?.hasImportedLedger }));
    check(
      "ledger: the closing balance 3,000 is still computed from opening + credit - debit",
      l?.ledgerClosing?.igstMinor === EXPECT.ledgerClosingIgstMinor
        && l?.ledgerBasis === "COMPUTED_FROM_MOVEMENT"
        && l?.ledgerStatedDiffersFromMovement === false,
      `closing ${l?.ledgerClosing?.igstMinor} (want ${EXPECT.ledgerClosingIgstMinor}), basis ${l?.ledgerBasis}`,
    );

    // THE POINT OF THIS CASE. The ledger RECEIVED 18,000 and the return claimed 18,000, so they
    // agree - even though the closing balance is 3,000, because 20,000 was lawfully utilised and
    // 5,000 was carried forward. Comparing the claim against the closing balance instead would
    // report a 15,000 shortfall here that does not exist.
    check(
      "ledger: the claim is compared against the credit RECEIVED, not the closing balance",
      l?.ledgerCredited?.igstMinor === EXPECT.ledgerCreditedIgstMinor
        && l?.difference?.igstMinor === 0
        && l?.agrees === true,
      `received ${l?.ledgerCredited?.igstMinor} (want ${EXPECT.ledgerCreditedIgstMinor}), `
        + `diff ${l?.difference?.igstMinor} (want 0), agrees ${l?.agrees} (want true)`,
    );
  }

  // ─── a run WITHOUT the new sources must report unknown, never agreement ────────────────
  const bareRun = await call("POST", "api/gst-reconciliation/runs", {
    clientId: String(clientId),
    gstin: GSTIN,
    period: PERIOD,
    booksBatchId: books.batchId,
    portalBatchId: portal.batchId,
    gstr3bBatchId: gstr3b.batchId,
  });
  const bareId = bareRun.json?.run?._id || bareRun.json?.run?.id;
  check(
    "a run WITHOUT the new sources is a DIFFERENT run, not a replay of the one with them",
    Boolean(bareId) && String(bareId) !== String(runId) && bareRun.json?.replayed !== true,
    `bare ${bareId} vs full ${runId}, replayed=${bareRun.json?.replayed}`,
  );

  if (bareId) {
    const bareJob = await AutomationJob.findById(bareRun.json.run.jobId);
    if (bareJob) await processGstReconciliationJob(bareJob);
    const bareControl = await call("GET", `api/gst-reconciliation/runs/${bareId}/3b-control`);
    const bc = bareControl.json?.control;
    check(
      "with no GSTR-1 and no ledger, both comparisons report UNKNOWN — never agreement, never zero",
      bc?.turnover?.available === false
        && bc?.turnover?.agrees === null
        && bc?.turnover?.difference === null
        && bc?.creditLedger?.available === false
        && bc?.creditLedger?.agrees === null,
      JSON.stringify({
        tAvail: bc?.turnover?.available, tAgrees: bc?.turnover?.agrees, tDiff: bc?.turnover?.difference,
        lAvail: bc?.creditLedger?.available, lAgrees: bc?.creditLedger?.agrees,
      }),
    );
    check(
      "the GSTR-3B outward half is still read for the run that has one",
      bc?.turnover?.hasImportedGstr3bOutward === true && bc?.turnover?.hasImportedGstr1 === false,
      JSON.stringify({ g3: bc?.turnover?.hasImportedGstr3bOutward, g1: bc?.turnover?.hasImportedGstr1 }),
    );
  }
} catch (error) {
  check("the harness ran to completion", false, error?.message || String(error));
  console.error(error?.stack || error);
} finally {
  try { if (server) server.close(); } catch { /* ignore */ }
  try {
    if (mongoose.connection?.readyState === 1 && mongoose.connection.name === SCRATCH_DB) {
      await mongoose.connection.dropDatabase();
    }
  } catch { /* ignore */ }
  try { await mongoose.disconnect(); } catch { /* ignore */ }
}

const passed = checks.filter((c) => c.pass).length;
console.log(`\nGST reconciliation end-to-end: ${passed}/${checks.length}`);
if (passed !== checks.length) {
  console.error(`\n${checks.length - passed} check(s) failed.`);
  process.exit(1);
}
process.exit(0);
