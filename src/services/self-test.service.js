import { createHash, randomUUID } from "node:crypto";
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
import { callDeepSeek, parseJsonObject } from "./deepseek-provider.service.js";

import AppConfig from "../models/AppConfig.js";
import User from "../models/User.js";
import Firm from "../models/Firm.js";
import FirmMembership from "../models/FirmMembership.js";
import Client from "../models/Client.js";
import Task from "../models/Task.js";
import Reminder from "../models/Reminder.js";
import TaxWorkSession from "../models/TaxWorkSession.js";
import ComplianceRule from "../models/ComplianceRule.js";
import ImportBatch from "../models/ImportBatch.js";
import ReconciliationRun from "../models/ReconciliationRun.js";
import TdsHealthRun from "../models/TdsHealthRun.js";
import Engagement, { ENGAGEMENT_TYPES } from "../models/Engagement.js";
import CaseMatter from "../models/CaseMatter.js";
import SystemTestRun from "../models/SystemTestRun.js";

const R = (rupees) => Math.round(rupees * 100);
const ACTIVE_RUN_KEY = "GLOBAL";
const STALE_RUN_MS = 15 * 60 * 1000;
const CLEANUP_RETRY_MS = 30 * 1000;
const CLEANUP_RETRY_DELAYS_MS = Object.freeze([0, 250, 750]);
const TERMINAL_RUN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_DETAIL_LENGTH = 1200;
const DEEPSEEK_REVIEW_SYSTEM = [
  "You are reviewing synthetic evidence from an accounting software system test.",
  "Use only supplied expected and actual values. Never invent facts.",
  "Identify contradictions, missing coverage, empty outputs, and suspicious passes.",
  "Do not provide tax, legal, audit, or accounting conclusions.",
  "Return one JSON object only.",
].join(" ");

const EXPECTED_SECTION_IDS = Object.freeze([
  "infrastructure",
  "engines",
  "identity",
  "clients",
  "tasks",
  "reminders",
  "tax-work",
  "compliance",
  "gst",
  "tds",
  "engagements",
  "cases",
  "operations",
  "notifications",
  "cleanup",
  "deepseek",
]);

const MODEL_BY_NAME = Object.freeze({
  User,
  Firm,
  FirmMembership,
  Client,
  Task,
  Reminder,
  TaxWorkSession,
  ComplianceRule,
  ImportBatch,
  ReconciliationRun,
  TdsHealthRun,
  Engagement,
  CaseMatter,
});

let systemTestIndexesReady = null;

function terminalRunExpiry() {
  return new Date(Date.now() + TERMINAL_RUN_RETENTION_MS);
}

function executionLostError() {
  const error = new Error("Deep system-test execution ownership was lost");
  error.code = "SYSTEM_TEST_EXECUTION_LOST";
  return error;
}

function executionFilter(runId, executionToken, statuses = ["RUNNING"]) {
  return {
    _id: runId,
    activeKey: ACTIVE_RUN_KEY,
    executionToken,
    status: { $in: statuses },
  };
}

async function updateOwnedRun(runId, executionToken, update, statuses = ["RUNNING"]) {
  const result = await SystemTestRun.updateOne(
    executionFilter(runId, executionToken, statuses),
    update
  );
  if (Number(result?.matchedCount || 0) !== 1) throw executionLostError();
  return result;
}

async function assertExecutionOwned(runId, executionToken) {
  const owned = await SystemTestRun.exists(executionFilter(runId, executionToken));
  if (!owned) throw executionLostError();
}

async function ensureSystemTestIndexes() {
  if (!systemTestIndexesReady) {
    systemTestIndexesReady = SystemTestRun.createIndexes().catch((error) => {
      systemTestIndexesReady = null;
      throw error;
    });
  }
  return systemTestIndexesReady;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function bounded(value, max = MAX_DETAIL_LENGTH) {
  return String(value ?? "").slice(0, max);
}

function serializable(value) {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return bounded(value, 500);
  }
}

function resultStatus(checks) {
  if (checks.some((check) => check.status === "fail")) return "fail";
  if (checks.some((check) => check.status === "warn")) return "warn";
  return "pass";
}

async function runCheck(id, name, fn) {
  const started = Date.now();
  try {
    const output = (await fn()) || {};
    const requestedStatus = String(output.status || "pass").toLowerCase();
    const status = ["pass", "warn", "fail"].includes(requestedStatus)
      ? requestedStatus
      : "fail";
    return {
      id,
      name,
      status,
      ms: Date.now() - started,
      detail: bounded(output.detail || "Expected output received"),
      expected: serializable(output.expected),
      actual: serializable(output.actual),
      evidence: serializable(output.evidence),
    };
  } catch (error) {
    return {
      id,
      name,
      status: "fail",
      ms: Date.now() - started,
      detail: bounded(error?.message || error),
      expected: null,
      actual: null,
      evidence: error?.code ? { code: bounded(error.code, 120) } : null,
    };
  }
}

async function persistRuntime(runId, executionToken, runtime, currentCheck = "") {
  const percent = runtime.total
    ? Math.min(100, Math.round((runtime.completed / runtime.total) * 100))
    : 0;
  await updateOwnedRun(
    runId,
    executionToken,
    {
      $set: {
        phase: runtime.phase,
        progress: {
          completed: runtime.completed,
          total: runtime.total,
          percent,
          currentCheck,
        },
        groups: runtime.groups,
      },
    }
  );
}

async function runGroup(runId, executionToken, runtime, definition) {
  const group = {
    id: definition.id,
    name: definition.name,
    status: "pending",
    checks: [],
  };
  runtime.groups.push(group);
  runtime.phase = definition.name;
  await persistRuntime(runId, executionToken, runtime, definition.checks[0]?.[1] || "");

  for (const [id, name, fn] of definition.checks) {
    await persistRuntime(runId, executionToken, runtime, name);
    const check = await runCheck(id, name, fn);
    group.checks.push(check);
    group.status = resultStatus(group.checks);
    runtime.completed += 1;
    await persistRuntime(runId, executionToken, runtime, "");
  }
  return group;
}

function infrastructureChecks() {
  return [
    ["db-connection", "MongoDB connection and ping", async () => {
      const state = mongoose.connection?.readyState;
      assert(state === 1, `Database not connected (state=${state})`);
      const started = Date.now();
      await mongoose.connection.db.admin().ping();
      const pingMs = Date.now() - started;
      return {
        detail: `Database accepted ping in ${pingMs} ms`,
        expected: { readyState: 1, ping: "accepted" },
        actual: { readyState: state, ping: "accepted", pingMs },
      };
    }],
    ["runtime-config", "Required runtime configuration", async () => {
      const actual = {
        jwtSecret: Boolean(process.env.JWT_SECRET),
        mongoUri: Boolean(process.env.MONGODB_URI),
      };
      assert(actual.jwtSecret, "JWT_SECRET is not set");
      assert(actual.mongoUri, "MONGODB_URI is not set");
      return {
        detail: "Required runtime configuration is present",
        expected: { jwtSecret: true, mongoUri: true },
        actual,
      };
    }],
    ["feature-flags", "Feature flag output", async () => {
      const flags = await AppConfig.getFeatureFlags();
      assert(flags && typeof flags === "object" && !Array.isArray(flags), "Feature flags did not return an object");
      return {
        detail: `${Object.keys(flags).length} feature flags returned`,
        expected: { outputType: "object" },
        actual: { outputType: "object", keys: Object.keys(flags).sort() },
      };
    }],
    ["model-registry", "Deep-test model registry", async () => {
      const modelNames = Object.keys(MODEL_BY_NAME);
      assert(modelNames.length === 13, `Expected 13 seeded models, found ${modelNames.length}`);
      return {
        detail: "All seeded-section models are registered",
        expected: { modelCount: 13 },
        actual: { modelCount: modelNames.length, modelNames },
      };
    }],
  ];
}

function engineChecks() {
  return [
    ["gst-reconcile", "GST reconciliation classifications", async () => {
      const makeRow = (id, values) => ({
        _id: id,
        sourceRow: id,
        supplierGstin: values.gstin,
        invoiceNumberNormalized: values.invoice,
        invoiceNumberOriginal: values.invoice,
        documentType: "INVOICE",
        documentDate: values.date,
        taxableValueMinor: R(values.taxable),
        igstMinor: R(values.igst || 0),
        cgstMinor: 0,
        sgstMinor: 0,
        cessMinor: 0,
        totalTaxMinor: R(values.igst || 0),
      });
      const books = [
        makeRow("b1", { gstin: "27AABCS1111A1Z5", invoice: "A1", date: "2026-04-01", taxable: 1000, igst: 180 }),
        makeRow("b2", { gstin: "27AABCS1111A1Z5", invoice: "A2", date: "2026-04-02", taxable: 2000, igst: 360 }),
        makeRow("b3", { gstin: "27AABCS2222A1Z5", invoice: "A3", date: "2026-04-03", taxable: 500, igst: 90 }),
      ];
      const portal = [
        makeRow("p1", { gstin: "27AABCS1111A1Z5", invoice: "A1", date: "2026-04-01", taxable: 1000, igst: 180 }),
        makeRow("p2", { gstin: "27AABCS1111A1Z5", invoice: "A2", date: "2026-04-02", taxable: 2000, igst: 460 }),
      ];
      const summary = summarizeReconciliationItems(
        buildReconciliationItems({ booksRows: books, portalRows: portal })
      );
      const actual = {
        matchedCount: summary.matchedCount,
        mismatchCount: summary.mismatchCount,
        missingIn2bCount: summary.missingIn2bCount,
      };
      const expected = { matchedCount: 1, mismatchCount: 1, missingIn2bCount: 1 };
      assert(JSON.stringify(actual) === JSON.stringify(expected), `Unexpected GST summary: ${JSON.stringify(actual)}`);
      return { detail: "Matched, mismatch, and missing-in-2B outputs are correct", expected, actual };
    }],
    ["gst-normalize", "GST row normalization", async () => {
      const { values, errors } = normalizeGstImportRow("GST_PURCHASE", {
        supplierGstin: "27AABCS1111A1Z5",
        recipientGstin: "27AABCR0000A1Z5",
        invoiceNumber: "INV-1",
        documentDate: "05-04-2026",
        documentType: "Tax Invoice",
        taxableValue: "1,000.00",
        igst: "180",
        cgst: "0",
        sgst: "0",
        cess: "0",
      });
      assert(errors.length === 0, `Unexpected GST errors: ${JSON.stringify(errors)}`);
      assert(values.totalTaxMinor === 18000, `totalTaxMinor=${values.totalTaxMinor}`);
      return {
        detail: "GST row returned expected minor-unit tax total",
        expected: { errors: 0, totalTaxMinor: 18000 },
        actual: { errors: errors.length, totalTaxMinor: values.totalTaxMinor },
      };
    }],
    ["tds-health", "TDS short-deposit detection", async () => {
      const deductions = [{ _id: "d1", sourceRow: 1, sourceLabel: "deduction", deducteePan: "ABCPS1234K", deducteeName: "Synthetic Deductee", sectionCode: "194J", transactionDate: "2026-04-01", amountPaidMinor: R(10000), deductedMinor: R(1000), surchargeMinor: 0, cessMinor: 0 }];
      const challans = [{ _id: "c1", sourceRow: 1, sourceLabel: "challan", sectionCode: "194J", depositedMinor: R(600) }];
      const statements = [{ _id: "s1", sourceRow: 1, sourceLabel: "statement", filingStatus: "FILED", certificateStatus: "ISSUED", reportedMinor: R(1000), correctionStatus: "NONE" }];
      const { checks } = buildTdsHealthChecks({ deductions, challans, statements, credits: [] });
      const short = checks.find((check) => check.status === "SHORT_DEPOSIT_ESTIMATE");
      assert(short, "SHORT_DEPOSIT_ESTIMATE output was not produced");
      assert(short.differenceMinor === R(400), `shortfall=${short.differenceMinor}`);
      return {
        detail: "TDS engine produced expected short-deposit output",
        expected: { status: "SHORT_DEPOSIT_ESTIMATE", differenceMinor: 40000 },
        actual: { status: short.status, differenceMinor: short.differenceMinor },
      };
    }],
    ["tds-normalize", "TDS row normalization", async () => {
      const { values, errors } = normalizeTdsImportRow("TDS_DEDUCTIONS", {
        transactionDate: "05-Apr-2026",
        amountPaid: "1,00,000",
        deductedAmount: "10000",
        deducteePan: "ABCPS1234K",
        sectionCode: "194J",
        surcharge: "0",
        cess: "0",
      });
      assert(errors.length === 0, `Unexpected TDS errors: ${JSON.stringify(errors)}`);
      assert(values.deductedMinor === R(10000), `deductedMinor=${values.deductedMinor}`);
      return {
        detail: "TDS row returned expected minor-unit deduction",
        expected: { errors: 0, deductedMinor: 1000000 },
        actual: { errors: errors.length, deductedMinor: values.deductedMinor },
      };
    }],
    ["adaptive-parsers", "Adaptive date, money, and header parsing", async () => {
      const actual = {
        date: parseFlexibleDateIso("05-Apr-2026"),
        moneyMinor: parseFlexibleMoneyMinor("Rs. 1,18,000.50"),
        header: resolveHeaderField("GSTIN of Supplier", "GST"),
      };
      const expected = { date: "2026-04-05", moneyMinor: 11800050, header: "supplierGstin" };
      assert(JSON.stringify(actual) === JSON.stringify(expected), `Unexpected parser output: ${JSON.stringify(actual)}`);
      return { detail: "Adaptive parsers returned exact expected values", expected, actual };
    }],
    ["compliance-period", "Compliance period boundaries", async () => {
      const window = parseCompliancePeriod("2026-27", "ANNUAL");
      const actual = {
        start: window.start.toISOString().slice(0, 10),
        end: window.end.toISOString().slice(0, 10),
      };
      const expected = { start: "2026-04-01", end: "2027-03-31" };
      assert(JSON.stringify(actual) === JSON.stringify(expected), `Unexpected compliance window: ${JSON.stringify(actual)}`);
      return { detail: "Annual fiscal window boundaries are correct", expected, actual };
    }],
    ["token-jwt", "Authentication token round trip", async () => {
      const token = signAccessToken({ _id: { toString: () => "u1" }, email: "synthetic@example.invalid", accountType: "FIRM_USER", firmId: { toString: () => "f1" }, role: "FIRM_ADMIN", tokenVersion: 0 });
      const decoded = verifyAccessToken(token);
      const actual = { id: decoded.id, role: decoded.role, firmId: decoded.firmId };
      const expected = { id: "u1", role: "FIRM_ADMIN", firmId: "f1" };
      assert(actual.id === expected.id && actual.role === expected.role && actual.firmId === expected.firmId, `Unexpected JWT payload: ${JSON.stringify(actual)}`);
      return { detail: "JWT payload survived signing and verification", expected, actual };
    }],
    ["gstr2b-json", "GSTR-2B JSON conversion and import", async () => {
      const conversion = convertGstr2bJson({ data: { gstin: "27AABCR0000A1Z5", rtnprd: "042026", docdata: { b2b: [{ ctin: "27AABCS1111A1Z5", inv: [{ inum: "INV-1", dt: "05-04-2026", txval: 1000, igst: 180 }] }] } } });
      const parsed = parseMappedImport({ kind: "GSTR2B", text: conversion.csv, mapping: conversion.mapping });
      const actual = {
        documentCount: conversion.meta.documentCount,
        validRows: parsed.summary.validRows,
        invalidRows: parsed.summary.invalidRows,
      };
      const expected = { documentCount: 1, validRows: 1, invalidRows: 0 };
      assert(JSON.stringify(actual) === JSON.stringify(expected), `Unexpected GSTR-2B conversion output: ${JSON.stringify(actual)}`);
      return { detail: "Portal JSON produced one valid import row", expected, actual };
    }],
    ["import-preview", "Delimited import preview", async () => {
      const parsed = parseMappedImport({
        kind: "GST_PURCHASE",
        text: "S,R,Inv,Dt,Ty,Tax,I,C,Sg,Ce\n27AABCS1111A1Z5,27AABCR0000A1Z5,INV1,05/04/2026,Invoice,1000,180,0,0,0\n",
        mapping: { supplierGstin: "S", recipientGstin: "R", invoiceNumber: "Inv", documentDate: "Dt", documentType: "Ty", taxableValue: "Tax", igst: "I", cgst: "C", sgst: "Sg", cess: "Ce" },
      });
      const actual = { validRows: parsed.summary.validRows, invalidRows: parsed.summary.invalidRows };
      const expected = { validRows: 1, invalidRows: 0 };
      assert(JSON.stringify(actual) === JSON.stringify(expected), `Unexpected preview output: ${JSON.stringify(actual)}`);
      return { detail: "Import preview produced one valid row", expected, actual };
    }],
    ["digest-timezone", "Digest timezone calculations", async () => {
      const valid = validTimezone("Asia/Kolkata");
      const invalid = validTimezone("Not/AZone");
      const sample = zonedParts(new Date("2026-04-05T04:00:00Z"), "Asia/Kolkata");
      const beforeMidnight = zonedParts(new Date("2026-04-04T18:29:59Z"), "Asia/Kolkata");
      const atMidnight = zonedParts(new Date("2026-04-04T18:30:00Z"), "Asia/Kolkata");
      const actual = {
        valid,
        invalid,
        sample: {
          year: sample.year,
          month: sample.month,
          day: sample.day,
          hour: sample.hour,
          weekday: sample.weekday,
          dateKey: sample.dateKey,
        },
        beforeMidnightDateKey: beforeMidnight.dateKey,
        atMidnightDateKey: atMidnight.dateKey,
      };
      const expected = {
        valid: true,
        invalid: false,
        sample: { year: 2026, month: 4, day: 5, hour: 9, weekday: 0, dateKey: "2026-04-05" },
        beforeMidnightDateKey: "2026-04-04",
        atMidnightDateKey: "2026-04-05",
      };
      assert(JSON.stringify(actual) === JSON.stringify(expected), `Timezone output mismatch: ${JSON.stringify(actual)}`);
      return {
        detail: "Timezone validation, exact zoned parts, and midnight boundary output are correct",
        expected,
        actual,
      };
    }],
  ];
}

function makeFixture(runId, executionToken) {
  const suffix = String(runId).slice(-10).toLowerCase();
  const planned = [
    ["User", "user"],
    ["Firm", "firm"],
    ["FirmMembership", "membership"],
    ["Client", "client"],
    ["ComplianceRule", "complianceRule"],
    ["Task", "task"],
    ["Reminder", "reminder"],
    ["TaxWorkSession", "taxWork"],
    ["ImportBatch", "gstBooksBatch"],
    ["ImportBatch", "gstPortalBatch"],
    ["ImportBatch", "tdsDeductionsBatch"],
    ["ImportBatch", "tdsChallansBatch"],
    ["ImportBatch", "tdsStatementsBatch"],
    ["ReconciliationRun", "reconciliationRun"],
    ["TdsHealthRun", "tdsHealthRun"],
    ["CaseMatter", "caseMatter"],
    ["Engagement", "engagement"],
  ].map(([modelName, key]) => ({
    modelName,
    key,
    id: new mongoose.Types.ObjectId(),
  }));
  return {
    runId,
    executionToken,
    suffix,
    planned,
    ids: Object.fromEntries(planned.map((entry) => [entry.key, entry.id])),
    refs: {},
    seeded: false,
  };
}

async function saveFixtureRecord(fixture, key, data) {
  const plan = fixture.planned.find((entry) => entry.key === key);
  assert(plan, `No fixture plan for ${key}`);
  const Model = MODEL_BY_NAME[plan.modelName];
  await assertExecutionOwned(fixture.runId, fixture.executionToken);
  const document = await new Model({ _id: plan.id, ...data }).save();
  try {
    await assertExecutionOwned(fixture.runId, fixture.executionToken);
  } catch (error) {
    await Model.deleteOne({ _id: plan.id }).catch(() => {});
    throw error;
  }
  fixture.refs[key] = document;
  return document;
}

async function seedFixture(fixture) {
  await updateOwnedRun(
    fixture.runId,
    fixture.executionToken,
    {
      $set: {
        cleanupManifest: fixture.planned.map(({ modelName, id }) => ({ modelName, id })),
      },
    }
  );

  const { ids, suffix } = fixture;
  const syntheticEmail = `system-test-${suffix}@example.invalid`;
  const complianceCode = `SYS_TEST_${suffix.toUpperCase()}`;
  const templateSnapshot = { id: "SYSTEM_TEST", version: 1, checklist: ["Evidence received"] };

  await saveFixtureRecord(fixture, "user", {
    email: syntheticEmail,
    name: "Synthetic System Test User",
    role: "FIRM_ADMIN",
    accountType: "FIRM_USER",
    firmId: ids.firm,
    personalFirmId: ids.firm,
    isActive: false,
    digestPreferences: {
      dailyFrequency: "OFF",
      dailyEnabled: false,
      weeklyEnabled: false,
      emailEnabled: false,
    },
  });
  await saveFixtureRecord(fixture, "firm", {
    displayName: `Synthetic System Test ${suffix}`,
    handle: `system-test-${suffix}`,
    ownerUserId: ids.user,
    kind: "PERSONAL",
    joinCode: hash(fixture.runId).slice(0, 6).toUpperCase(),
    sharingEnabled: false,
    memberAccess: "READ_ONLY",
    timezone: "Asia/Kolkata",
    isActive: false,
  });
  await saveFixtureRecord(fixture, "membership", {
    firmId: ids.firm,
    userId: ids.user,
    role: "OWNER",
    status: "ACTIVE",
    isPersonal: true,
  });
  await saveFixtureRecord(fixture, "client", {
    firmId: ids.firm,
    ownerUserId: ids.user,
    name: "Synthetic Verification Client",
    gstin: "27ABCDE1234F1Z5",
    pan: "ABCDE1234F",
    tan: "ABCD12345E",
    clientCode: `SYS${suffix.slice(-5).toUpperCase()}`,
    entityType: "PRIVATE_LIMITED",
    tags: ["system-test", "synthetic"],
    complianceProfile: [{
      code: complianceCode,
      applicability: "APPLICABLE",
      frequency: "MONTHLY",
      reminderOffsets: [-7, -1, 0],
      updatedBy: ids.user,
    }],
    profileReviewedAt: new Date("2026-04-01T00:00:00.000Z"),
    profileReviewedBy: ids.user,
    onboardingSource: "MANUAL",
    createdBy: ids.user,
  });
  await saveFixtureRecord(fixture, "complianceRule", {
    firmId: ids.firm,
    code: complianceCode,
    version: 1,
    title: "Synthetic Monthly Filing Rule",
    status: "ACTIVE",
    frequency: "MONTHLY",
    entityTypes: ["PRIVATE_LIMITED"],
    dueDatePolicy: { type: "DAY_OF_MONTH", day: 20, monthOffset: 1, offsetDays: 0 },
    generationPolicy: {
      createTask: true,
      createTaxWorkSession: true,
      createReminder: true,
      taskServiceType: "GST",
      taxWorkType: "GST_MONTHLY",
      titleTemplate: "{clientName} - {code} - {period}",
    },
    defaultReminderOffsets: [-7, -1, 0],
    effectiveFrom: new Date("2026-04-01T00:00:00.000Z"),
    sourceReference: "Synthetic system-test rule, not professional guidance",
    reviewedBy: ids.user,
    reviewedAt: new Date("2026-04-01T00:00:00.000Z"),
    createdBy: ids.user,
    updatedBy: ids.user,
  });
  await saveFixtureRecord(fixture, "task", {
    firmId: ids.firm,
    createdBy: ids.user,
    clientName: "Synthetic Verification Client",
    clientId: ids.client,
    serviceType: "GST",
    title: "Synthetic GSTR-3B filing",
    dueDateISO: "2026-05-20",
    assignedTo: ids.user,
    status: "NOT_STARTED",
    documentReadiness: "PARTIAL",
    reviewStatus: "PENDING",
    source: "COMPLIANCE_RULE",
    complianceRuleId: ids.complianceRule,
    complianceRuleVersion: 1,
    complianceCode,
    period: "2026-04",
    generationKey: `system-test-task-${suffix}`,
    isActive: false,
  });
  await saveFixtureRecord(fixture, "reminder", {
    userId: ids.user,
    firmId: ids.firm,
    typeId: complianceCode,
    clientLabel: "Synthetic Verification Client",
    dueDateISO: "2026-05-20T00:00:00.000Z",
    offsets: [-7, -1, 0],
    source: "COMPLIANCE_RULE",
    clientId: ids.client,
    taskId: ids.task,
    complianceRuleId: ids.complianceRule,
    complianceRuleVersion: 1,
    complianceCode,
    period: "2026-04",
    generationKey: `system-test-reminder-${suffix}`,
    isActive: false,
  });
  await saveFixtureRecord(fixture, "taxWork", {
    firmId: ids.firm,
    ownerUserId: ids.user,
    clientId: ids.client,
    taxType: "GST_MONTHLY",
    period: "2026-04",
    dueDate: new Date("2026-05-20T00:00:00.000Z"),
    status: "DRAFT",
    documents: [
      { docKey: "sales-register", name: "Sales register", required: true, received: false },
      { docKey: "bank-statement", name: "Bank statement", required: true, received: true, receivedAt: new Date("2026-05-01T00:00:00.000Z"), receivedByUserId: ids.user },
    ],
    source: "COMPLIANCE_RULE",
    taskId: ids.task,
    reminderId: ids.reminder,
    complianceRuleId: ids.complianceRule,
    complianceRuleVersion: 1,
    complianceCode,
    generationKey: `system-test-tax-work-${suffix}`,
    assignedTo: ids.user,
    createdBy: ids.user,
  });

  const batchBase = {
    firmId: ids.firm,
    clientId: ids.client,
    sourceName: "synthetic-system-test.csv",
    delimiter: ",",
    mapping: { synthetic: "Synthetic" },
    status: "COMPLETED",
    totalRows: 1,
    validRows: 1,
    invalidRows: 0,
    createdBy: ids.user,
    committedAt: new Date("2026-05-01T00:00:00.000Z"),
    completedAt: new Date("2026-05-01T00:00:01.000Z"),
  };
  await saveFixtureRecord(fixture, "gstBooksBatch", {
    ...batchBase,
    kind: "GST_PURCHASE",
    gstin: "27ABCDE1234F1Z5",
    period: "2026-04",
    sourceHash: hash(`gst-books-${fixture.runId}`),
    importFingerprint: hash(`gst-books-fingerprint-${fixture.runId}`),
    totalTaxMinor: 18000,
  });
  await saveFixtureRecord(fixture, "gstPortalBatch", {
    ...batchBase,
    kind: "GSTR2B",
    gstin: "27ABCDE1234F1Z5",
    period: "2026-04",
    sourceHash: hash(`gst-portal-${fixture.runId}`),
    importFingerprint: hash(`gst-portal-fingerprint-${fixture.runId}`),
    totalTaxMinor: 18000,
  });
  for (const [key, kind] of [
    ["tdsDeductionsBatch", "TDS_DEDUCTIONS"],
    ["tdsChallansBatch", "TDS_CHALLANS"],
    ["tdsStatementsBatch", "TDS_STATEMENTS"],
  ]) {
    await saveFixtureRecord(fixture, key, {
      ...batchBase,
      kind,
      tan: "ABCD12345E",
      financialYear: "2026-27",
      quarter: "Q1",
      statementType: "26Q",
      sourceHash: hash(`${kind}-${fixture.runId}`),
      importFingerprint: hash(`${kind}-fingerprint-${fixture.runId}`),
      totalTaxMinor: kind === "TDS_CHALLANS" ? 60000 : 100000,
    });
  }
  await saveFixtureRecord(fixture, "reconciliationRun", {
    firmId: ids.firm,
    clientId: ids.client,
    kind: "GST_ITC",
    gstin: "27ABCDE1234F1Z5",
    period: "2026-04",
    sourceImports: { booksBatchId: ids.gstBooksBatch, portalBatchId: ids.gstPortalBatch },
    sourceFingerprint: hash(`gst-run-${fixture.runId}`),
    revision: 1,
    status: "REVIEW",
    summary: { totalItems: 3, matchedCount: 1, mismatchCount: 1, missingIn2bCount: 1, reviewCount: 2 },
    createdBy: ids.user,
  });
  await saveFixtureRecord(fixture, "tdsHealthRun", {
    firmId: ids.firm,
    clientId: ids.client,
    tan: "ABCD12345E",
    financialYear: "2026-27",
    quarter: "Q1",
    statementType: "26Q",
    sourceImports: {
      deductionsBatchId: ids.tdsDeductionsBatch,
      challansBatchId: ids.tdsChallansBatch,
      statementsBatchId: ids.tdsStatementsBatch,
    },
    sourceFingerprint: hash(`tds-run-${fixture.runId}`),
    revision: 1,
    status: "REVIEW",
    rolloutVersion: 1,
    generationAttempt: `system-test-${suffix}`,
    summary: { deductedMinor: 100000, depositedMinor: 60000, reportedMinor: 100000, estimatedGapMinor: 40000, totalChecks: 1, openChecks: 1 },
    calculationPolicy: {
      version: "system-test-v1",
      sourceLabel: "Synthetic deterministic evidence",
      sourceReference: "Synthetic system test only",
      estimate: true,
      professionalConfirmed: false,
      ratesApplied: false,
    },
    createdBy: ids.user,
  });
  await saveFixtureRecord(fixture, "caseMatter", {
    firmId: ids.firm,
    intakeMutationKey: `system-test-case-${suffix}`,
    intakeRequestHash: hash(`case-request-${fixture.runId}`),
    clientId: ids.client,
    caseType: "INCOME_TAX_NOTICE_INTIMATION",
    title: "Synthetic notice response",
    status: "OPEN",
    priority: "HIGH",
    risk: "MEDIUM",
    ownerUserId: ids.user,
    reviewerUserId: ids.user,
    source: {
      method: "PASTED_TEXT",
      sourceName: "synthetic-notice.txt",
      mimeType: "text/plain",
      sizeBytes: 120,
      extractedText: "Synthetic evidence only. Response due 20 May 2026.",
      textHash: hash(`case-source-${fixture.runId}`),
      extractionProvider: "LOCAL",
      binaryStored: false,
    },
    extractionStatus: "CONFIRMED",
    confirmedFacts: {
      authority: "Synthetic Authority",
      noticeType: "Synthetic Intimation",
      responseDueDate: new Date("2026-05-20T00:00:00.000Z"),
      statedReason: "Deterministic system-test evidence",
    },
    createdBy: ids.user,
    updatedBy: ids.user,
  });
  await saveFixtureRecord(fixture, "engagement", {
    firmId: ids.firm,
    clientId: ids.client,
    engagementType: ENGAGEMENT_TYPES[0],
    title: "Synthetic assurance engagement",
    period: "2026-27",
    scope: "System-test scope using synthetic records only.",
    ownerUserId: ids.user,
    teamUserIds: [ids.user],
    reviewerUserId: ids.user,
    status: "DRAFT",
    stage: "INTAKE",
    startDate: new Date("2026-04-01T00:00:00.000Z"),
    targetDate: new Date("2026-06-30T00:00:00.000Z"),
    linkedTaskIds: [ids.task],
    linkedTaxWorkSessionIds: [ids.taxWork],
    linkedCaseIds: [ids.caseMatter],
    templateSnapshot,
    templateHash: hash(JSON.stringify(templateSnapshot)),
    checklist: [{ templateKey: "evidence", title: "Evidence received", category: "Planning", required: true, status: "OPEN", ownerUserId: ids.user }],
    milestones: [{ templateKey: "planning", title: "Planning complete", category: "Planning", required: true, status: "PENDING", ownerUserId: ids.user }],
    clientRequests: [{ templateKey: "records", title: "Provide records", category: "Evidence", required: true, status: "REQUESTED", ownerUserId: ids.user }],
    deliverables: [{ templateKey: "report", title: "Draft report", category: "Reporting", required: true, status: "NOT_STARTED", ownerUserId: ids.user }],
    creationMutationKey: `system-test-engagement-${suffix}`,
    creationRequestHash: hash(`engagement-request-${fixture.runId}`),
    createdBy: ids.user,
    updatedBy: ids.user,
  });

  fixture.seeded = true;
  return fixture;
}

function requireFixture(fixture) {
  assert(fixture.seeded, "Synthetic fixture was not fully seeded");
}

function seededSectionGroups(fixture) {
  return [
    {
      id: "identity",
      name: "Identity graph and scoped model reads",
      checks: [["identity-firm-membership", "Seeded user, firm, membership, and scoped client read", async () => {
        requireFixture(fixture);
        const unrelatedFirmId = new mongoose.Types.ObjectId();
        const [user, firm, membership, firmScopedClient, unrelatedFirmClient] = await Promise.all([
          User.findById(fixture.ids.user).lean(),
          Firm.findById(fixture.ids.firm).lean(),
          FirmMembership.findOne({ firmId: fixture.ids.firm, userId: fixture.ids.user }).lean(),
          Client.findOne({ _id: fixture.ids.client, firmId: fixture.ids.firm }).lean(),
          Client.findOne({ _id: fixture.ids.client, firmId: unrelatedFirmId }).lean(),
        ]);
        const actual = {
          userFirm: String(user?.firmId || ""),
          firmOwner: String(firm?.ownerUserId || ""),
          membershipRole: membership?.role,
          membershipStatus: membership?.status,
          firmScopedClientFound: Boolean(firmScopedClient),
          unrelatedFirmQueryMatched: Boolean(unrelatedFirmClient),
        };
        const expected = {
          userFirm: String(fixture.ids.firm),
          firmOwner: String(fixture.ids.user),
          membershipRole: "OWNER",
          membershipStatus: "ACTIVE",
          firmScopedClientFound: true,
          unrelatedFirmQueryMatched: false,
        };
        assert(JSON.stringify(actual) === JSON.stringify(expected), `Seeded identity model output mismatch: ${JSON.stringify(actual)}`);
        return {
          detail: "Exact-ID model reads returned the seeded identity graph, and the client query required the synthetic firm ID",
          expected,
          actual,
          evidence: {
            verificationScope: "MongoDB model queries only",
            routeAuthorizationExercised: false,
          },
        };
      }]],
    },
    {
      id: "clients",
      name: "Client registry",
      checks: [["client-profile", "Client profile and compliance output", async () => {
        requireFixture(fixture);
        const client = await Client.findById(fixture.ids.client)
          .select("+tan +clientCode +entityType +tags +complianceProfile")
          .lean();
        const actual = {
          name: client?.name,
          entityType: client?.entityType,
          complianceEntries: client?.complianceProfile?.length || 0,
          tags: client?.tags || [],
        };
        const expected = {
          name: "Synthetic Verification Client",
          entityType: "PRIVATE_LIMITED",
          complianceEntries: 1,
          tags: ["system-test", "synthetic"],
        };
        assert(JSON.stringify(actual) === JSON.stringify(expected), `Client output mismatch: ${JSON.stringify(actual)}`);
        return { detail: "Client detail query returned complete seeded profile", expected, actual };
      }]],
    },
    {
      id: "tasks",
      name: "Task management",
      checks: [["task-workflow", "Task read and workflow mutation", async () => {
        requireFixture(fixture);
        const task = await Task.findById(fixture.ids.task);
        const beforeVersion = task?.mutationVersion;
        assert(task, "Seeded task was not found");
        task.status = "IN_PROGRESS";
        task.documentReadiness = "READY";
        await task.save();
        const output = await Task.findOne({ _id: task._id, firmId: fixture.ids.firm }).lean();
        const actual = { status: output?.status, documentReadiness: output?.documentReadiness, mutationVersion: output?.mutationVersion };
        const expected = { status: "IN_PROGRESS", documentReadiness: "READY", mutationVersion: beforeVersion + 1 };
        assert(JSON.stringify(actual) === JSON.stringify(expected), `Task output mismatch: ${JSON.stringify(actual)}`);
        return { detail: "Task mutation persisted and incremented concurrency version", expected, actual };
      }]],
    },
    {
      id: "reminders",
      name: "Reminder scheduling",
      checks: [["reminder-output", "Reminder schedule output", async () => {
        requireFixture(fixture);
        const reminder = await Reminder.findOne({ _id: fixture.ids.reminder, firmId: fixture.ids.firm }).lean();
        const actual = { dueDateISO: reminder?.dueDateISO, offsets: reminder?.offsets, scheduleVersion: reminder?.scheduleVersion };
        const expected = { dueDateISO: "2026-05-20T00:00:00.000Z", offsets: [-7, -1, 0], scheduleVersion: 1 };
        assert(JSON.stringify(actual) === JSON.stringify(expected), `Reminder output mismatch: ${JSON.stringify(actual)}`);
        return { detail: "Reminder query returned exact due date, offsets, and version", expected, actual };
      }]],
    },
    {
      id: "tax-work",
      name: "Tax Work sessions",
      checks: [["tax-work-documents", "Tax Work document lifecycle output", async () => {
        requireFixture(fixture);
        const session = await TaxWorkSession.findById(fixture.ids.taxWork);
        assert(session, "Seeded Tax Work session was not found");
        session.documents[0].received = true;
        session.documents[0].receivedAt = new Date("2026-05-02T00:00:00.000Z");
        session.documents[0].receivedByUserId = fixture.ids.user;
        session.status = "IN_PROGRESS";
        await session.save();
        const output = await TaxWorkSession.findOne({ _id: session._id, firmId: fixture.ids.firm }).lean();
        const required = output?.documents?.filter((document) => document.required) || [];
        const actual = { status: output?.status, required: required.length, received: required.filter((document) => document.received).length };
        const expected = { status: "IN_PROGRESS", required: 2, received: 2 };
        assert(JSON.stringify(actual) === JSON.stringify(expected), `Tax Work output mismatch: ${JSON.stringify(actual)}`);
        return { detail: "Tax Work update returned complete required-document state", expected, actual };
      }]],
    },
    {
      id: "compliance",
      name: "Compliance rules",
      checks: [["compliance-rule-output", "Active compliance rule output", async () => {
        requireFixture(fixture);
        const rule = await ComplianceRule.findOne({ _id: fixture.ids.complianceRule, firmId: fixture.ids.firm, status: "ACTIVE" }).lean();
        const actual = { status: rule?.status, frequency: rule?.frequency, dueDay: rule?.dueDatePolicy?.day, artifacts: [rule?.generationPolicy?.createTask, rule?.generationPolicy?.createTaxWorkSession, rule?.generationPolicy?.createReminder] };
        const expected = { status: "ACTIVE", frequency: "MONTHLY", dueDay: 20, artifacts: [true, true, true] };
        assert(JSON.stringify(actual) === JSON.stringify(expected), `Compliance output mismatch: ${JSON.stringify(actual)}`);
        return { detail: "Active rule returned expected due-date and artifact policy", expected, actual };
      }]],
    },
    {
      id: "gst",
      name: "GST seeded records and reconciliation summary",
      checks: [["gst-persisted-output", "Seeded GST batch and reconciliation model round-trip", async () => {
        requireFixture(fixture);
        const [batchCount, run] = await Promise.all([
          ImportBatch.countDocuments({ _id: { $in: [fixture.ids.gstBooksBatch, fixture.ids.gstPortalBatch] }, firmId: fixture.ids.firm, status: "COMPLETED" }),
          ReconciliationRun.findOne({ _id: fixture.ids.reconciliationRun, firmId: fixture.ids.firm }).lean(),
        ]);
        const actual = { completedBatches: batchCount, status: run?.status, matched: run?.summary?.matchedCount, mismatch: run?.summary?.mismatchCount, missingIn2b: run?.summary?.missingIn2bCount };
        const expected = { completedBatches: 2, status: "REVIEW", matched: 1, mismatch: 1, missingIn2b: 1 };
        assert(JSON.stringify(actual) === JSON.stringify(expected), `GST seeded model round-trip mismatch: ${JSON.stringify(actual)}`);
        return {
          detail: "Exact-ID, firm-scoped model reads returned the seeded GST batch state and reconciliation summary fields",
          expected,
          actual,
          evidence: { verificationScope: "seeded model round-trip; import commit and reconciliation worker not invoked" },
        };
      }]],
    },
    {
      id: "tds",
      name: "TDS seeded records and health summary",
      checks: [["tds-persisted-output", "Seeded TDS batch and health model round-trip", async () => {
        requireFixture(fixture);
        const [batchCount, run] = await Promise.all([
          ImportBatch.countDocuments({ _id: { $in: [fixture.ids.tdsDeductionsBatch, fixture.ids.tdsChallansBatch, fixture.ids.tdsStatementsBatch] }, firmId: fixture.ids.firm, status: "COMPLETED" }),
          TdsHealthRun.findOne({ _id: fixture.ids.tdsHealthRun, firmId: fixture.ids.firm }).lean(),
        ]);
        const actual = { completedBatches: batchCount, status: run?.status, deductedMinor: run?.summary?.deductedMinor, depositedMinor: run?.summary?.depositedMinor, gapMinor: run?.summary?.estimatedGapMinor };
        const expected = { completedBatches: 3, status: "REVIEW", deductedMinor: 100000, depositedMinor: 60000, gapMinor: 40000 };
        assert(JSON.stringify(actual) === JSON.stringify(expected), `TDS seeded model round-trip mismatch: ${JSON.stringify(actual)}`);
        return {
          detail: "Exact-ID, firm-scoped model reads returned the seeded TDS batch state and health summary fields",
          expected,
          actual,
          evidence: { verificationScope: "seeded model round-trip; import commit and health worker not invoked" },
        };
      }]],
    },
    {
      id: "engagements",
      name: "Engagements and audit workspace",
      checks: [["engagement-output", "Engagement workflow output", async () => {
        requireFixture(fixture);
        const engagement = await Engagement.findOne({ _id: fixture.ids.engagement, firmId: fixture.ids.firm }).lean();
        const actual = { status: engagement?.status, checklist: engagement?.checklist?.length || 0, milestones: engagement?.milestones?.length || 0, clientRequests: engagement?.clientRequests?.length || 0, deliverables: engagement?.deliverables?.length || 0, linkedCases: engagement?.linkedCaseIds?.length || 0 };
        const expected = { status: "DRAFT", checklist: 1, milestones: 1, clientRequests: 1, deliverables: 1, linkedCases: 1 };
        assert(JSON.stringify(actual) === JSON.stringify(expected), `Engagement output mismatch: ${JSON.stringify(actual)}`);
        return { detail: "Engagement query returned workflow, evidence, and linkage output", expected, actual };
      }]],
    },
    {
      id: "cases",
      name: "Case management",
      checks: [["case-output", "Case intake and deadline output", async () => {
        requireFixture(fixture);
        const matter = await CaseMatter.findOne({ _id: fixture.ids.caseMatter, firmId: fixture.ids.firm }).lean();
        const actual = { status: matter?.status, risk: matter?.risk, extractionStatus: matter?.extractionStatus, responseDueDate: matter?.confirmedFacts?.responseDueDate?.toISOString() };
        const expected = { status: "OPEN", risk: "MEDIUM", extractionStatus: "CONFIRMED", responseDueDate: "2026-05-20T00:00:00.000Z" };
        assert(JSON.stringify(actual) === JSON.stringify(expected), `Case output mismatch: ${JSON.stringify(actual)}`);
        return { detail: "Case query returned confirmed extraction and deadline output", expected, actual };
      }]],
    },
    {
      id: "operations",
      name: "Seeded cross-section record presence",
      checks: [["operations-output", "Exact-ID, firm-scoped cross-section presence", async () => {
        requireFixture(fixture);
        const [clients, tasks, reminders, taxWork, cases, engagements] = await Promise.all([
          Client.countDocuments({ _id: fixture.ids.client, firmId: fixture.ids.firm }),
          Task.countDocuments({ _id: fixture.ids.task, firmId: fixture.ids.firm }),
          Reminder.countDocuments({ _id: fixture.ids.reminder, firmId: fixture.ids.firm }),
          TaxWorkSession.countDocuments({ _id: fixture.ids.taxWork, firmId: fixture.ids.firm }),
          CaseMatter.countDocuments({ _id: fixture.ids.caseMatter, firmId: fixture.ids.firm }),
          Engagement.countDocuments({ _id: fixture.ids.engagement, firmId: fixture.ids.firm }),
        ]);
        const actual = { clients, tasks, reminders, taxWork, cases, engagements };
        const expected = { clients: 1, tasks: 1, reminders: 1, taxWork: 1, cases: 1, engagements: 1 };
        assert(JSON.stringify(actual) === JSON.stringify(expected), `Cross-section record presence mismatch: ${JSON.stringify(actual)}`);
        return {
          detail: "Exact-ID, firm-scoped reads found every seeded work-section record",
          expected,
          actual,
          evidence: {
            verificationScope: "record presence only",
            dashboardAggregationExercised: false,
          },
        };
      }]],
    },
  ];
}

function notificationChecks(fixture) {
  return [
    ["mail-config", "Email provider configuration", async () => {
      const configured = Boolean(process.env.RESEND_API_KEY);
      return {
        status: configured ? "pass" : "warn",
        detail: configured
          ? "Resend is configured; this deep run does not invoke an email provider"
          : "RESEND_API_KEY is not configured; live delivery remains unavailable",
        expected: { configured: true, providerInvocationOwnedBySeparateProbe: true },
        actual: { configured, providerInvocationOwnedBySeparateProbe: true },
      };
    }],
    ["side-effect-policy", "Scheduler and external side-effect isolation", async () => {
      requireFixture(fixture);
      const [user, firm, task, reminder] = await Promise.all([
        User.findById(fixture.ids.user).select("email isActive digestPreferences").lean(),
        Firm.findById(fixture.ids.firm).select("isActive").lean(),
        Task.findById(fixture.ids.task).select("isActive").lean(),
        Reminder.findById(fixture.ids.reminder).select("isActive").lean(),
      ]);
      const actual = {
        syntheticEmailDomain: String(user?.email || "").endsWith("@example.invalid"),
        userActive: user?.isActive,
        firmActive: firm?.isActive,
        taskActive: task?.isActive,
        reminderActive: reminder?.isActive,
        digestEmailEnabled: user?.digestPreferences?.emailEnabled,
        dailyDigestEnabled: user?.digestPreferences?.dailyEnabled,
        weeklyDigestEnabled: user?.digestPreferences?.weeklyEnabled,
      };
      const expected = {
        syntheticEmailDomain: true,
        userActive: false,
        firmActive: false,
        taskActive: false,
        reminderActive: false,
        digestEmailEnabled: false,
        dailyDigestEnabled: false,
        weeklyDigestEnabled: false,
      };
      assert(JSON.stringify(actual) === JSON.stringify(expected), `Scheduler isolation mismatch: ${JSON.stringify(actual)}`);
      return {
        detail: "Database output proves reminder and digest schedulers cannot claim synthetic records",
        expected,
        actual,
        evidence: {
          reminderFence: "Reminder.isActive=false",
          digestFences: ["Firm.isActive=false", "User.isActive=false", "Task.isActive=false", "digestPreferences.emailEnabled=false"],
        },
      };
    }],
  ];
}

async function cleanupManifest(manifest = []) {
  const failures = [];
  let deleted = 0;
  for (const entry of [...manifest].reverse()) {
    const Model = MODEL_BY_NAME[entry.modelName];
    if (!Model) {
      failures.push(`Unknown cleanup model ${entry.modelName}`);
      continue;
    }
    try {
      const result = await Model.deleteOne({ _id: entry.id });
      deleted += Number(result?.deletedCount || 0);
    } catch (error) {
      failures.push(`${entry.modelName}:${entry.id} ${bounded(error?.message || error, 240)}`);
    }
  }

  const residualRecords = [];
  for (const entry of manifest) {
    const Model = MODEL_BY_NAME[entry.modelName];
    if (!Model) continue;
    try {
      if (await Model.exists({ _id: entry.id })) {
        residualRecords.push(`${entry.modelName}:${entry.id}`);
      }
    } catch (error) {
      failures.push(`Verify ${entry.modelName}:${entry.id} ${bounded(error?.message || error, 240)}`);
    }
  }

  return {
    ok: residualRecords.length === 0 && failures.length === 0,
    planned: manifest.length,
    deleted,
    residualCount: residualRecords.length,
    residualRecords,
    failures,
  };
}

async function cleanupManifestWithRetry(manifest = []) {
  let result = null;
  let deleted = 0;
  for (let index = 0; index < CLEANUP_RETRY_DELAYS_MS.length; index += 1) {
    const delayMs = CLEANUP_RETRY_DELAYS_MS[index];
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    result = await cleanupManifest(manifest);
    deleted += result.deleted;
    if (result.ok) {
      return { ...result, deleted, attempts: index + 1 };
    }
  }
  return {
    ...result,
    deleted,
    attempts: CLEANUP_RETRY_DELAYS_MS.length,
  };
}

function cleanupGroup(fixture, runtime) {
  return {
    id: "cleanup",
    name: "Synthetic data cleanup",
    checks: [["fixture-cleanup", "Delete and verify every synthetic record", async () => {
      const cleanup = await cleanupManifestWithRetry(fixture.planned);
      runtime.cleanup = cleanup;
      assert(cleanup.ok, `Cleanup incomplete: ${JSON.stringify(cleanup)}`);
      return {
        detail: `Verified zero residual records after deleting ${cleanup.deleted} seeded records`,
        expected: { residualCount: 0 },
        actual: { deleted: cleanup.deleted, residualCount: cleanup.residualCount },
        evidence: cleanup,
      };
    }]],
  };
}

function aiSafeEvidence(value, depth = 0) {
  if (depth > 5) return "[depth-limited]";
  if (value == null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    return bounded(value, 300)
      .replace(/[a-f\d]{24}/gi, "[synthetic-id]")
      .replace(/[a-z\d._%+-]+@example\.invalid/gi, "[synthetic-email]");
  }
  if (Array.isArray(value)) {
    return value.slice(0, 30).map((entry) => aiSafeEvidence(entry, depth + 1));
  }
  if (typeof value === "object") {
    const safe = {};
    const omittedOperationalKeys = new Set(["keys", "modelNames", "pingMs"]);
    for (const [key, entry] of Object.entries(value).slice(0, 50)) {
      if (omittedOperationalKeys.has(key)) continue;
      if (/(password|secret|token|authorization|cookie|uri|url|stack|error|message|path)/i.test(key)) continue;
      safe[bounded(key, 80)] = aiSafeEvidence(entry, depth + 1);
    }
    return safe;
  }
  return null;
}

function compactEvidence(groups) {
  const reviewSectionIds = new Set(EXPECTED_SECTION_IDS.filter((id) => id !== "deepseek"));
  return groups
    .filter((group) => reviewSectionIds.has(group.id))
    .map((group) => ({
      sectionId: group.id,
      status: group.status,
      checks: group.checks.map((check) => ({
        checkId: check.id,
        status: check.status,
        expected: aiSafeEvidence(check.expected),
        actual: aiSafeEvidence(check.actual),
      })),
    }));
}

function normalizeDeepSeekReview(payload, response, deterministicStatuses) {
  const expectedIds = EXPECTED_SECTION_IDS.filter((id) => id !== "deepseek");
  if (!deterministicStatuses || typeof deterministicStatuses !== "object") return null;
  const normalizedDeterministicStatuses = Object.fromEntries(
    expectedIds.map((sectionId) => [
      sectionId,
      String(deterministicStatuses[sectionId] || "").toUpperCase(),
    ])
  );
  if (expectedIds.some((sectionId) =>
    !["PASS", "WARN", "FAIL"].includes(normalizedDeterministicStatuses[sectionId])
  )) return null;

  const verdict = String(payload?.verdict || "").toUpperCase();
  const confidence = Number(payload?.confidence);
  if (!["PASS", "WARN", "FAIL"].includes(verdict)) return null;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  if (typeof payload?.summary !== "string" || !payload.summary.trim()) return null;

  const normalizeStringList = (value) => {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return null;
    return value.map((entry) => bounded(entry, 600)).filter(Boolean).slice(0, 20);
  };
  const contradictions = normalizeStringList(payload.contradictions);
  const coverageGaps = normalizeStringList(payload.coverageGaps);
  const findings = normalizeStringList(payload.findings);
  if (!contradictions || !coverageGaps || !findings) return null;
  if (!Array.isArray(payload.sectionAssessments) || payload.sectionAssessments.length !== expectedIds.length) {
    return null;
  }

  const assessmentsById = new Map();
  for (const entry of payload.sectionAssessments) {
    const sectionId = String(entry?.sectionId || "");
    const status = String(entry?.status || "").toUpperCase();
    const rationale = typeof entry?.rationale === "string" ? bounded(entry.rationale, 600) : "";
    if (!expectedIds.includes(sectionId) || assessmentsById.has(sectionId)) return null;
    if (!["PASS", "WARN", "FAIL"].includes(status) || !rationale.trim()) return null;
    assessmentsById.set(sectionId, {
      sectionId,
      status,
      deterministicStatus: normalizedDeterministicStatuses[sectionId],
      rationale,
    });
  }
  if (expectedIds.some((sectionId) => !assessmentsById.has(sectionId))) return null;

  const sectionAssessments = expectedIds.map((sectionId) => assessmentsById.get(sectionId));
  const consistencyIssues = sectionAssessments
    .filter((entry) => entry.status !== entry.deterministicStatus)
    .map((entry) =>
      `${entry.sectionId} assessment ${entry.status} conflicts with deterministic ${entry.deterministicStatus}`
    );
  if (verdict === "PASS" && contradictions.length) {
    consistencyIssues.push("PASS verdict conflicts with reported contradictions");
  }
  if (verdict === "PASS" && coverageGaps.length) {
    consistencyIssues.push("PASS verdict conflicts with reported coverage gaps");
  }
  if (verdict === "PASS" && sectionAssessments.some((entry) => entry.status !== "PASS")) {
    consistencyIssues.push("PASS verdict conflicts with non-passing section assessments");
  }
  const advisoryStatus = verdict === "FAIL"
    ? "FAIL"
    : verdict === "WARN" || consistencyIssues.length
      ? "WARN"
      : "PASS";

  return {
    completed: true,
    provider: bounded(response.provider || "DEEPSEEK", 80),
    model: bounded(response.model || "", 120),
    verdict,
    advisoryStatus,
    confidence,
    summary: bounded(payload.summary, 1200),
    contradictions,
    coverageGaps,
    findings,
    consistencyIssues,
    sectionAssessments,
  };
}

function deepSeekGroup(runtime) {
  return {
    id: "deepseek",
    name: "DeepSeek semantic evidence review",
    checks: [["deepseek-review", "DeepSeek cross-check of section evidence", async () => {
      const expectedSectionIds = EXPECTED_SECTION_IDS.filter((id) => id !== "deepseek");
      const deterministicSourceGroups = runtime.groups.filter((group) =>
        expectedSectionIds.includes(group.id)
      );
      const evidenceGroups = compactEvidence(deterministicSourceGroups);
      assert(
        evidenceGroups.length === expectedSectionIds.length
          && expectedSectionIds.every((sectionId) =>
            evidenceGroups.some((group) => group.sectionId === sectionId)
          ),
        "DeepSeek evidence packet does not cover every deterministic section"
      );
      const deterministicStatuses = Object.fromEntries(
        evidenceGroups.map((group) => [group.sectionId, String(group.status || "").toUpperCase()])
      );
      const deterministicSummary = {
        ...summarizeGroups(deterministicSourceGroups),
        sectionsCovered: evidenceGroups.length,
        sectionsExpected: expectedSectionIds.length,
      };
      const cleanupSummary = {
        ok: runtime.cleanup?.ok === true,
        planned: Number(runtime.cleanup?.planned || 0),
        deleted: Number(runtime.cleanup?.deleted || 0),
        residualCount: Number.isFinite(runtime.cleanup?.residualCount)
          ? runtime.cleanup.residualCount
          : null,
        failureCount: Array.isArray(runtime.cleanup?.failures)
          ? runtime.cleanup.failures.length
          : 0,
      };
      const packet = {
        purpose: "Synthetic full-system verification",
        expectedSectionIds,
        deterministicSummary,
        cleanup: cleanupSummary,
        groups: evidenceGroups,
        requiredResponse: {
          verdict: "PASS | WARN | FAIL",
          confidence: "number from 0 to 1",
          summary: "non-empty evidence-grounded summary",
          contradictions: ["string"],
          coverageGaps: ["string"],
          findings: ["string"],
          sectionAssessmentRequirement: `Return exactly one assessment for each expectedSectionId (${expectedSectionIds.length} total), with no duplicates or extra IDs`,
          sectionAssessments: [{ sectionId: "one expectedSectionId", status: "PASS | WARN | FAIL", rationale: "non-empty string" }],
        },
      };
      let response;
      try {
        response = await callDeepSeek({
          system: DEEPSEEK_REVIEW_SYSTEM,
          prompt: JSON.stringify(packet),
          jsonResponse: true,
          maxTokens: 2400,
          timeoutMs: 45000,
          temperature: 0,
        });
      } catch {
        runtime.deepSeekReview = {
          completed: false,
          provider: "DEEPSEEK",
          verdict: "WARN",
          advisoryStatus: "WARN",
          reason: "DeepSeek provider request failed",
        };
        return {
          status: "warn",
          detail: runtime.deepSeekReview.reason,
          expected: { completed: true },
          actual: { completed: false },
          evidence: runtime.deepSeekReview,
        };
      }
      if (!response.ok) {
        runtime.deepSeekReview = {
          completed: false,
          provider: "DEEPSEEK",
          verdict: "WARN",
          advisoryStatus: "WARN",
          reason: "DeepSeek provider did not return a review",
        };
        return {
          status: "warn",
          detail: runtime.deepSeekReview.reason,
          expected: { completed: true },
          actual: { completed: false },
          evidence: runtime.deepSeekReview,
        };
      }
      let review = null;
      try {
        const parsed = parseJsonObject(response.content);
        review = normalizeDeepSeekReview(parsed, response, deterministicStatuses);
      } catch {
        review = null;
      }
      if (!review) {
        runtime.deepSeekReview = {
          completed: false,
          provider: bounded(response.provider || "DEEPSEEK", 80),
          model: bounded(response.model || "", 120),
          verdict: "WARN",
          advisoryStatus: "WARN",
          reason: "DeepSeek returned an invalid review schema",
        };
        return {
          status: "warn",
          detail: runtime.deepSeekReview.reason,
          expected: { validSchema: true },
          actual: { validSchema: false },
          evidence: runtime.deepSeekReview,
        };
      }
      runtime.deepSeekReview = review;
      const status = review.advisoryStatus === "PASS" ? "pass" : "warn";
      return {
        status,
        detail: review.consistencyIssues[0] || review.summary,
        expected: { completed: true, advisoryStatus: "PASS" },
        actual: {
          completed: true,
          verdict: review.verdict,
          advisoryStatus: review.advisoryStatus,
          confidence: review.confidence,
        },
        evidence: review,
      };
    }]],
  };
}

function summarizeGroups(groups) {
  const checks = groups.flatMap((group) => group.checks || []);
  const passed = checks.filter((check) => check.status === "pass").length;
  const failed = checks.filter((check) => check.status === "fail").length;
  const warned = checks.filter((check) => check.status === "warn").length;
  const coveredIds = new Set(
    groups
      .filter((group) => group.checks?.length && EXPECTED_SECTION_IDS.includes(group.id))
      .map((group) => group.id)
  );
  return {
    total: checks.length,
    passed,
    failed,
    warned,
    sectionsCovered: coveredIds.size,
    sectionsExpected: EXPECTED_SECTION_IDS.length,
    overall: failed > 0 ? "FAIL" : warned > 0 ? "WARN" : "PASS",
  };
}

function totalCheckCount(fixture) {
  const seeded = seededSectionGroups(fixture).reduce((sum, group) => sum + group.checks.length, 0);
  return infrastructureChecks().length
    + engineChecks().length
    + 1
    + seeded
    + notificationChecks(fixture).length
    + 1
    + 1;
}

function cleanupResultGroup(cleanup) {
  const verified = cleanup?.ok === true;
  return {
    id: "cleanup",
    name: "Synthetic data cleanup",
    status: verified ? "pass" : "fail",
    checks: [{
      id: "fixture-cleanup",
      name: "Delete and verify every synthetic record",
      status: verified ? "pass" : "fail",
      ms: 0,
      detail: verified
        ? `Verified zero residual records after deleting ${Number(cleanup.deleted || 0)} seeded records`
        : "Cleanup could not prove that every synthetic record was removed",
      expected: { residualCount: 0, verified: true },
      actual: {
        residualCount: cleanup?.residualCount ?? null,
        verified,
      },
      evidence: serializable(cleanup),
    }],
  };
}

function crashReport(existing, error, cleanup) {
  const groups = (existing?.groups || []).filter((group) => group.id !== "cleanup");
  groups.push(cleanupResultGroup(cleanup));
  const summary = summarizeGroups(groups);
  summary.overall = "FAIL";
  const total = Math.max(Number(existing?.progress?.total || 0), summary.total);
  const completed = Math.min(summary.total, total);
  return {
    phase: "Crashed",
    error: bounded(error?.message || error || "System test crashed"),
    cleanup,
    groups,
    summary,
    progress: {
      completed,
      total,
      percent: total ? Math.min(99, Math.round((completed / total) * 100)) : 0,
      currentCheck: "",
    },
    completedAt: new Date(),
  };
}

function cleanupPendingReport(existing, error, cleanup) {
  const report = crashReport(existing, error, cleanup);
  return {
    ...report,
    phase: "Cleanup failed; automatic recovery pending",
    error: bounded(`${report.error}; synthetic cleanup remains unverified`),
    completedAt: null,
  };
}

function unknownCleanup(planned, error) {
  return {
    ok: false,
    verified: false,
    planned,
    deleted: 0,
    residualCount: null,
    residualRecords: [],
    failures: [bounded(error?.message || error || "Cleanup verification unavailable", 600)],
  };
}

async function executeDeepSelfTest(runId, executionToken, fixture) {
  const runtime = {
    groups: [],
    completed: 0,
    total: totalCheckCount(fixture),
    phase: "Starting deep system review",
    cleanup: null,
    deepSeekReview: null,
  };

  await updateOwnedRun(
    runId,
    executionToken,
    {
      $set: {
        status: "RUNNING",
        expiresAt: null,
        startedAt: new Date(),
        phase: runtime.phase,
        progress: { completed: 0, total: runtime.total, percent: 0, currentCheck: "" },
      },
    },
    ["QUEUED"]
  );

  try {
    await runGroup(runId, executionToken, runtime, {
      id: "infrastructure",
      name: "Infrastructure and configuration",
      checks: infrastructureChecks(),
    });
    await runGroup(runId, executionToken, runtime, {
      id: "engines",
      name: "Core parsers and deterministic engines",
      checks: engineChecks(),
    });
    await runGroup(runId, executionToken, runtime, {
      id: "seed-lifecycle",
      name: "Isolated synthetic fixture",
      checks: [["fixture-seed", "Create isolated synthetic data graph", async () => {
        await seedFixture(fixture);
        return {
          detail: `Created ${fixture.planned.length} synthetic records with a pre-registered cleanup manifest`,
          expected: { planned: fixture.planned.length, seeded: true },
          actual: { planned: fixture.planned.length, seeded: fixture.seeded },
          evidence: { syntheticEmailDomain: "example.invalid", productionTenantSeeded: false },
        };
      }]],
    });
    for (const group of seededSectionGroups(fixture)) {
      await runGroup(runId, executionToken, runtime, group);
    }
    await runGroup(runId, executionToken, runtime, {
      id: "notifications",
      name: "Notifications and side-effect policy",
      checks: notificationChecks(fixture),
    });
  } finally {
    await runGroup(runId, executionToken, runtime, cleanupGroup(fixture, runtime));
  }

  if (!runtime.cleanup?.ok) {
    const report = cleanupPendingReport(
      { groups: runtime.groups, progress: { total: runtime.total } },
      "Synthetic cleanup could not prove zero residue",
      runtime.cleanup
    );
    await updateOwnedRun(
      runId,
      executionToken,
      {
        $set: {
          status: "CLEANUP_FAILED",
          activeKey: ACTIVE_RUN_KEY,
          expiresAt: null,
          ...report,
          deepSeekReview: null,
        },
      },
      ["RUNNING"]
    );
    return;
  }

  await runGroup(runId, executionToken, runtime, deepSeekGroup(runtime));
  const summary = summarizeGroups(runtime.groups);
  runtime.phase = "Completed";
  await updateOwnedRun(runId, executionToken, {
    $set: {
      status: "COMPLETED",
      activeKey: null,
      expiresAt: terminalRunExpiry(),
      phase: runtime.phase,
      progress: {
        completed: runtime.completed,
        total: runtime.total,
        percent: 100,
        currentCheck: "",
      },
      summary,
      groups: runtime.groups,
      deepSeekReview: runtime.deepSeekReview,
      cleanup: runtime.cleanup,
      completedAt: new Date(),
    },
    $unset: { executionToken: 1 },
  });
}

async function markCrashed(runId, executionToken, error, cleanup) {
  const ownedStatuses = ["QUEUED", "RUNNING"];
  const existing = await SystemTestRun.findOne(
    executionFilter(runId, executionToken, ownedStatuses)
  ).select("groups progress").lean();
  if (!existing) return false;

  const cleanupVerified = cleanup?.ok === true;
  const report = cleanupVerified
    ? crashReport(existing, error, cleanup)
    : cleanupPendingReport(existing, error, cleanup);
  const update = {
    $set: {
      status: cleanupVerified ? "CRASHED" : "CLEANUP_FAILED",
      activeKey: cleanupVerified ? null : ACTIVE_RUN_KEY,
      expiresAt: cleanupVerified ? terminalRunExpiry() : null,
      ...report,
    },
  };
  if (cleanupVerified) update.$unset = { executionToken: 1 };

  const result = await SystemTestRun.updateOne(
    executionFilter(runId, executionToken, ownedStatuses),
    update
  );
  return Number(result?.matchedCount || 0) === 1;
}

async function recoverStaleRuns(runId = null) {
  const staleBefore = new Date(Date.now() - STALE_RUN_MS);
  const cleanupRetryBefore = new Date(Date.now() - CLEANUP_RETRY_MS);
  let recovered = 0;
  while (true) {
    const recoveryToken = randomUUID();
    const stale = await SystemTestRun.findOneAndUpdate(
      {
        ...(runId ? { _id: runId } : {}),
        activeKey: ACTIVE_RUN_KEY,
        executionToken: { $type: "string" },
        $or: [
          {
            status: { $in: ["QUEUED", "RUNNING", "RECOVERING"] },
            updatedAt: { $lt: staleBefore },
          },
          {
            status: "CLEANUP_FAILED",
            updatedAt: { $lt: cleanupRetryBefore },
          },
        ],
      },
      {
        $set: {
          status: "RECOVERING",
          executionToken: recoveryToken,
          expiresAt: null,
          phase: "Recovering stale run and verifying cleanup",
          error: "Recovered stale deep-system-test run",
          completedAt: null,
        },
      },
      { new: false }
    ).select("_id groups progress cleanupManifest").lean();
    if (!stale) break;

    const cleanup = await cleanupManifestWithRetry(stale.cleanupManifest || []).catch((error) =>
      unknownCleanup(stale.cleanupManifest?.length || 0, error)
    );
    const cleanupVerified = cleanup?.ok === true;
    const report = cleanupVerified
      ? crashReport(stale, "Recovered stale deep-system-test run", cleanup)
      : cleanupPendingReport(stale, "Recovered stale deep-system-test run", cleanup);
    const update = {
      $set: {
        status: cleanupVerified ? "CRASHED" : "CLEANUP_FAILED",
        activeKey: cleanupVerified ? null : ACTIVE_RUN_KEY,
        expiresAt: cleanupVerified ? terminalRunExpiry() : null,
        ...report,
      },
    };
    if (cleanupVerified) update.$unset = { executionToken: 1 };
    await updateOwnedRun(stale._id, recoveryToken, update, ["RECOVERING"]);

    recovered += 1;
    if (runId) break;
  }
  return recovered;
}

function isStaleActiveRun(run) {
  if (!run || run.activeKey !== ACTIVE_RUN_KEY) return false;
  if (!["QUEUED", "RUNNING", "RECOVERING", "CLEANUP_FAILED"].includes(run.status)) return false;
  if (!run.executionToken || !run.updatedAt) return false;
  const retryAfterMs = run.status === "CLEANUP_FAILED" ? CLEANUP_RETRY_MS : STALE_RUN_MS;
  return Date.now() - new Date(run.updatedAt).getTime() > retryAfterMs;
}

function publicRun(run) {
  if (!run) return null;
  const value = typeof run.toObject === "function" ? run.toObject() : { ...run };
  delete value.cleanupManifest;
  delete value.executionToken;
  value.id = String(value._id);
  delete value._id;
  delete value.__v;
  value.ok = value.status === "COMPLETED" && value.summary?.overall === "PASS";
  return value;
}

export async function startDeepSelfTest({ requestedBy }) {
  assert(requestedBy, "requestedBy is required");
  await ensureSystemTestIndexes();
  await recoverStaleRuns();
  const executionToken = randomUUID();
  let run;
  try {
    run = await SystemTestRun.create({
      requestedBy,
      status: "QUEUED",
      activeKey: ACTIVE_RUN_KEY,
      executionToken,
      expiresAt: null,
      phase: "Queued",
      summary: { sectionsExpected: EXPECTED_SECTION_IDS.length },
    });
  } catch (error) {
    if (error?.code === 11000) {
      const active = await SystemTestRun.findOne({ activeKey: ACTIVE_RUN_KEY }).lean();
      const conflict = new Error("A deep system review is already running");
      conflict.statusCode = 409;
      conflict.code = "SYSTEM_TEST_ALREADY_RUNNING";
      conflict.runId = active?._id ? String(active._id) : null;
      throw conflict;
    }
    throw error;
  }

  const fixture = makeFixture(run._id, executionToken);
  setImmediate(() => {
    executeDeepSelfTest(run._id, executionToken, fixture).catch(async (error) => {
      const cleanup = await cleanupManifestWithRetry(fixture.planned).catch((cleanupError) =>
        unknownCleanup(fixture.planned.length, cleanupError)
      );
      await markCrashed(run._id, executionToken, error, cleanup).catch(() => {});
    });
  });

  return publicRun(run);
}

export async function getDeepSelfTestRun(runId) {
  if (!mongoose.isValidObjectId(runId)) {
    const error = new Error("Invalid system-test run ID");
    error.statusCode = 400;
    throw error;
  }
  let run = await SystemTestRun.findById(runId).lean();
  if (!run) {
    const error = new Error("System-test run not found");
    error.statusCode = 404;
    throw error;
  }
  if (isStaleActiveRun(run)) {
    await recoverStaleRuns(runId);
    run = await SystemTestRun.findById(runId).lean();
  }
  return publicRun(run);
}

export async function getLatestDeepSelfTestRun() {
  let run = await SystemTestRun.findOne({}).sort({ createdAt: -1, _id: -1 }).lean();
  if (isStaleActiveRun(run)) {
    await recoverStaleRuns(run._id);
    run = await SystemTestRun.findById(run._id).lean();
  }
  return publicRun(run);
}

export { EXPECTED_SECTION_IDS };
