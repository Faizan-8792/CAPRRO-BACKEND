// One-button system self-test. Runs infrastructure, core engine/API-logic,
// database-model, and notification checks IN-PROCESS and returns a structured,
// per-check report (pass/fail/warn + timing + detail). Each check is isolated:
// one failure never aborts the others, and failures carry full detail.
//
// Engine/model/infra checks are read-only. The notification group performs a
// REAL email deliverability probe: it actually sends a test email via Resend
// (to the caller-supplied recipient) and verifies the SMTP reminder transport.
// This is deliberate — a green mail check must mean email genuinely works, not
// merely that an API key env var is present.
import mongoose from "mongoose";

import { buildReconciliationItems, summarizeReconciliationItems } from "./gst-matching.service.js";
import { normalizeGstImportRow } from "./gst-normalization.service.js";
import { buildTdsHealthChecks } from "./tds-health-engine.service.js";
import { normalizeTdsImportRow } from "./tds-normalization.service.js";
import { parseFlexibleDateIso, parseFlexibleMoneyMinor, resolveHeaderField } from "./robust-normalize.service.js";
import { parseCompliancePeriod } from "./compliance-period.service.js";
import { signAccessToken, verifyAccessToken } from "./token.service.js";
import { convertGstr2bJson } from "./gstr2b-json.service.js";
import { parseMappedImport } from "./import-preview.service.js";
import { validTimezone, zonedParts } from "./digest.service.js";
import { sendTestEmail } from "./email.service.js";

import AppConfig from "../models/AppConfig.js";
import User from "../models/User.js";
import Firm from "../models/Firm.js";
import FirmMembership from "../models/FirmMembership.js";
import Client from "../models/Client.js";
import Task from "../models/Task.js";
import Reminder from "../models/Reminder.js";
import ImportBatch from "../models/ImportBatch.js";
import ReconciliationRun from "../models/ReconciliationRun.js";
import TdsHealthRun from "../models/TdsHealthRun.js";
import Engagement from "../models/Engagement.js";
import CaseMatter from "../models/CaseMatter.js";
import ComplianceRule from "../models/ComplianceRule.js";
import DigestDelivery from "../models/DigestDelivery.js";
import ActivityEvent from "../models/ActivityEvent.js";

const R = (rupees) => Math.round(rupees * 100);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function runCheck(id, name, fn) {
  const started = Date.now();
  try {
    const out = await fn();
    const ms = Date.now() - started;
    if (out && typeof out === "object" && out.status) {
      return { id, name, status: out.status, ms, detail: String(out.detail || "") };
    }
    return { id, name, status: "pass", ms, detail: String(out || "OK") };
  } catch (error) {
    return { id, name, status: "fail", ms: Date.now() - started, detail: String(error?.message || error) };
  }
}

/* ------------------------------------------------ check definitions */
function infrastructureChecks() {
  return [
    ["db-connection", "MongoDB connection", async () => {
      const state = mongoose.connection?.readyState;
      assert(state === 1, `Database not connected (state=${state})`);
      const t = Date.now();
      await mongoose.connection.db.admin().ping();
      return `Connected, ping ${Date.now() - t} ms`;
    }],
    ["env-jwt", "JWT secret configured", async () => {
      assert(Boolean(process.env.JWT_SECRET), "JWT_SECRET is not set");
      return "JWT_SECRET present";
    }],
    ["env-mongo", "Mongo URI configured", async () => {
      assert(Boolean(process.env.MONGODB_URI), "MONGODB_URI is not set");
      return "MONGODB_URI present";
    }],
    ["feature-flags", "Feature flags load", async () => {
      const flags = await AppConfig.getFeatureFlags();
      assert(flags && typeof flags === "object", "Feature flags did not load");
      return `${Object.keys(flags).length} flags loaded`;
    }],
  ];
}

function engineChecks() {
  return [
    ["gst-reconcile", "GST reconciliation engine", async () => {
      const mk = (id, o) => ({
        _id: id, sourceRow: id, supplierGstin: o.g, invoiceNumberNormalized: o.i, invoiceNumberOriginal: o.i,
        documentType: "INVOICE", documentDate: o.d, taxableValueMinor: R(o.t),
        igstMinor: R(o.ig || 0), cgstMinor: 0, sgstMinor: 0, cessMinor: 0, totalTaxMinor: R(o.ig || 0),
      });
      const books = [
        mk("b1", { g: "27AABCS1111A1Z5", i: "A1", d: "2026-04-01", t: 1000, ig: 180 }),
        mk("b2", { g: "27AABCS1111A1Z5", i: "A2", d: "2026-04-02", t: 2000, ig: 360 }),
        mk("b3", { g: "27AABCS2222A1Z5", i: "A3", d: "2026-04-03", t: 500, ig: 90 }),
      ];
      const portal = [
        mk("p1", { g: "27AABCS1111A1Z5", i: "A1", d: "2026-04-01", t: 1000, ig: 180 }),
        mk("p2", { g: "27AABCS1111A1Z5", i: "A2", d: "2026-04-02", t: 2000, ig: 460 }),
      ];
      const summary = summarizeReconciliationItems(buildReconciliationItems({ booksRows: books, portalRows: portal }));
      assert(summary.matchedCount === 1, `matchedCount=${summary.matchedCount}, expected 1`);
      assert(summary.mismatchCount === 1, `mismatchCount=${summary.mismatchCount}, expected 1`);
      assert(summary.missingIn2bCount === 1, `missingIn2bCount=${summary.missingIn2bCount}, expected 1`);
      return "matched 1, mismatch 1, missing-in-2B 1";
    }],
    ["gst-normalize", "GST import normalization", async () => {
      const { values, errors } = normalizeGstImportRow("GST_PURCHASE", {
        supplierGstin: "27AABCS1111A1Z5", recipientGstin: "27AABCR0000A1Z5", invoiceNumber: "INV-1",
        documentDate: "05-04-2026", documentType: "Tax Invoice", taxableValue: "1,000.00", igst: "180", cgst: "0", sgst: "0", cess: "0",
      });
      assert(errors.length === 0, `unexpected errors: ${JSON.stringify(errors)}`);
      assert(values.totalTaxMinor === 18000, `totalTaxMinor=${values.totalTaxMinor}, expected 18000`);
      return "row normalized, totalTax 180.00";
    }],
    ["tds-health", "TDS health engine (short-deposit detection)", async () => {
      const deductions = [{ _id: "d1", sourceRow: 1, sourceLabel: "d", deducteePan: "ABCPS1234K", deducteeName: "X", sectionCode: "194J", transactionDate: "2026-04-01", amountPaidMinor: R(10000), deductedMinor: R(1000), surchargeMinor: 0, cessMinor: 0 }];
      const challans = [{ _id: "c1", sourceRow: 1, sourceLabel: "c", sectionCode: "194J", depositedMinor: R(600) }];
      const statements = [{ _id: "s1", sourceRow: 1, sourceLabel: "s", filingStatus: "FILED", certificateStatus: "ISSUED", reportedMinor: R(1000), correctionStatus: "NONE" }];
      const { checks } = buildTdsHealthChecks({ deductions, challans, statements, credits: [] });
      const short = checks.find((c) => c.status === "SHORT_DEPOSIT_ESTIMATE");
      assert(short, "expected a SHORT_DEPOSIT_ESTIMATE check");
      assert(short.differenceMinor === R(400), `shortfall=${short.differenceMinor}, expected 40000`);
      return "short deposit detected, shortfall 400.00";
    }],
    ["tds-normalize", "TDS import normalization", async () => {
      const { values, errors } = normalizeTdsImportRow("TDS_DEDUCTIONS", {
        transactionDate: "05-Apr-2026", amountPaid: "1,00,000", deductedAmount: "10000", deducteePan: "ABCPS1234K", sectionCode: "194J", surcharge: "0", cess: "0",
      });
      assert(errors.length === 0, `unexpected errors: ${JSON.stringify(errors)}`);
      assert(values.deductedMinor === R(10000), `deductedMinor=${values.deductedMinor}`);
      return "row normalized, deducted 10,000.00";
    }],
    ["robust-parse", "Adaptive date/money/header parsing", async () => {
      assert(parseFlexibleDateIso("05-Apr-2026") === "2026-04-05", "date parse failed");
      assert(parseFlexibleMoneyMinor("Rs. 1,18,000.50") === 11800050, "money parse failed");
      assert(resolveHeaderField("GSTIN of Supplier", "GST") === "supplierGstin", "header resolve failed");
      return "date, money, header all parsed";
    }],
    ["compliance-period", "Compliance period engine", async () => {
      const w = parseCompliancePeriod("2026-27", "ANNUAL");
      assert(w.start.toISOString().slice(0, 10) === "2026-04-01", "fiscal start wrong");
      assert(w.end.toISOString().slice(0, 10) === "2027-03-31", "fiscal end wrong");
      return "fiscal year 2026-27 window correct";
    }],
    ["token-jwt", "Auth token sign/verify", async () => {
      const token = signAccessToken({ _id: { toString: () => "u1" }, email: "x@y.z", accountType: "FIRM", firmId: { toString: () => "f1" }, role: "FIRM_ADMIN" });
      const decoded = verifyAccessToken(token);
      assert(decoded.id === "u1" && decoded.role === "FIRM_ADMIN", "token roundtrip failed");
      return "signed + verified";
    }],
    ["gstr2b-json", "GSTR-2B portal JSON ingestion", async () => {
      const conv = convertGstr2bJson({ data: { gstin: "27AABCR0000A1Z5", rtnprd: "042026", docdata: { b2b: [{ ctin: "27AABCS1111A1Z5", inv: [{ inum: "INV-1", dt: "05-04-2026", txval: 1000, igst: 180 }] }] } } });
      assert(conv.meta.documentCount === 1, `documentCount=${conv.meta.documentCount}`);
      const parsed = parseMappedImport({ kind: "GSTR2B", text: conv.csv, mapping: conv.mapping });
      assert(parsed.summary.validRows === 1 && parsed.summary.invalidRows === 0, "converted 2B not valid");
      return "portal JSON converted + accepted by import pipeline";
    }],
    ["import-preview", "Import preview pipeline", async () => {
      const parsed = parseMappedImport({
        kind: "GST_PURCHASE",
        text: "S,R,Inv,Dt,Ty,Tax,I,C,Sg,Ce\n27AABCS1111A1Z5,27AABCR0000A1Z5,INV1,05/04/2026,Invoice,1000,180,0,0,0\n",
        mapping: { supplierGstin: "S", recipientGstin: "R", invoiceNumber: "Inv", documentDate: "Dt", documentType: "Ty", taxableValue: "Tax", igst: "I", cgst: "C", sgst: "Sg", cess: "Ce" },
      });
      assert(parsed.summary.validRows === 1 && parsed.summary.invalidRows === 0, "preview did not validate row");
      return "delimited import previewed";
    }],
    ["digest-helpers", "Digest scheduling helpers", async () => {
      assert(validTimezone("Asia/Kolkata") === true, "valid tz rejected");
      assert(validTimezone("Not/AZone") === false, "invalid tz accepted");
      const parts = zonedParts(new Date("2026-04-05T04:00:00Z"), "Asia/Kolkata");
      assert(/^\d{4}-\d{1,2}-\d{1,2}$/.test(parts.dateKey), "dateKey malformed");
      return "timezone math OK";
    }],
  ];
}

function modelChecks() {
  const models = [
    ["User", User], ["Firm", Firm], ["FirmMembership", FirmMembership], ["Client", Client],
    ["Task", Task], ["Reminder", Reminder], ["ImportBatch", ImportBatch],
    ["ReconciliationRun", ReconciliationRun], ["TdsHealthRun", TdsHealthRun],
    ["Engagement", Engagement], ["CaseMatter", CaseMatter], ["ComplianceRule", ComplianceRule],
    ["DigestDelivery", DigestDelivery], ["ActivityEvent", ActivityEvent], ["AppConfig", AppConfig],
  ];
  return models.map(([name, Model]) => [
    `model-${name}`,
    `${name} model`,
    async () => {
      const count = await Model.estimatedDocumentCount();
      return `readable (${count} docs)`;
    },
  ]);
}

function notificationChecks({ mailProbeTo } = {}) {
  return [
    ["mail-config", "Email provider configuration", async () => {
      if (!process.env.RESEND_API_KEY) {
        return { status: "warn", detail: "RESEND_API_KEY not set — email delivery unavailable." };
      }
      return "Resend configured (all email: OTP, reminders, digests)";
    }],
    // REAL deliverability probe: actually send a test email through Resend.
    // sendTestEmail throws on any Resend soft-error (unverified domain, invalid
    // key, rate limit), so this check turns RED whenever email is truly broken.
    // Resend is now the single provider for every email the app sends.
    ["mail-resend-send", "Resend live delivery (sends a real email)", async () => {
      if (!process.env.RESEND_API_KEY) {
        return { status: "warn", detail: "RESEND_API_KEY not set — Resend live send skipped." };
      }
      if (!mailProbeTo) {
        return { status: "warn", detail: "No probe recipient available — Resend live send skipped." };
      }
      const res = await sendTestEmail(mailProbeTo);
      const id = res?.data?.id || res?.id || "";
      return `Real email accepted by Resend for ${mailProbeTo}${id ? ` (id ${id})` : ""}`;
    }],
  ];
}

export async function runSelfTest(options = {}) {
  const groupsDef = [
    ["Infrastructure & configuration", infrastructureChecks],
    ["Core engines & API logic", engineChecks],
    ["Data models (database)", modelChecks],
    ["Notifications", () => notificationChecks(options)],
  ];

  const startedAt = new Date();
  const groups = [];
  let passed = 0;
  let failed = 0;
  let warned = 0;

  for (const [groupName, builder] of groupsDef) {
    const defs = builder();
    // Run a group's checks in parallel; each is isolated.
    const checks = await Promise.all(defs.map(([id, name, fn]) => runCheck(id, name, fn)));
    for (const c of checks) {
      if (c.status === "pass") passed += 1;
      else if (c.status === "warn") warned += 1;
      else failed += 1;
    }
    groups.push({ name: groupName, checks });
  }

  const finishedAt = new Date();
  const total = passed + failed + warned;
  return {
    ok: failed === 0,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt - startedAt,
    summary: { total, passed, failed, warned },
    groups,
  };
}
