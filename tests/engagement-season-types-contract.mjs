// tests/engagement-season-types-contract.mjs
//
// W10 AP2 (2026-10-15). WHY THIS EXISTS
// -------------------------------------
// The audit season of a small Indian CA practice is three engagements: the statutory audit, the
// tax audit (Form 3CD) and the GST annual return (GSTR-9/9C). Only the first existed as an
// engagement type; GST_AUDIT is support for a departmental GST audit, a different job. AP2 adds
// TAX_AUDIT and GST_ANNUAL_RETURN and puts the three first, in the server's order, which both
// clients show as they are.
//
// Pinned here:
//   1. the order: the three season types first, in ENGAGEMENT_TYPES and in the templates route;
//   2. both new templates keep the product's ceiling in their own words - a person signs, uploads
//      and files; nothing is generated as an opinion; a difference is never forced to zero;
//   3. the Windows app's EngagementVocabulary.Types equals the server's list, in order (the
//      desktop validates a type before sending, so a type missing there could never be created);
//   4. (Mongo, scratch-marked) one engagement of each new type is created through the real app and
//      listed back by its type filter.
//
// Run: node tests/engagement-season-types-contract.mjs
//      MONGODB_URI=mongodb://127.0.0.1:27117/scratch-season-types node tests/engagement-season-types-contract.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass: Boolean(pass), detail });

const { ENGAGEMENT_TYPES, getEngagementTemplate, listEngagementTemplates } =
  await import("../src/config/engagement-templates.js");

const SEASON = ["STATUTORY_AUDIT", "TAX_AUDIT", "GST_ANNUAL_RETURN"];

// 1. Order.
check("the three season types come first in ENGAGEMENT_TYPES",
  JSON.stringify(ENGAGEMENT_TYPES.slice(0, 3)) === JSON.stringify(SEASON), ENGAGEMENT_TYPES.slice(0, 3).join(", "));
check("13 types, none repeated", ENGAGEMENT_TYPES.length === 13 && new Set(ENGAGEMENT_TYPES).size === 13,
  `${ENGAGEMENT_TYPES.length}`);
check("the templates route lists every type, in the same order",
  JSON.stringify(listEngagementTemplates().map((t) => t.engagementType)) === JSON.stringify([...ENGAGEMENT_TYPES]));
check("GST_AUDIT stays: departmental audit support is a different engagement",
  ENGAGEMENT_TYPES.includes("GST_AUDIT") && getEngagementTemplate("GST_AUDIT").title === "GST Audit Support");

// 2. The new templates, in their own words.
const tax = getEngagementTemplate("TAX_AUDIT");
const gst = getEngagementTemplate("GST_ANNUAL_RETURN");
check("TAX_AUDIT has a template titled for Form 3CD", tax?.title === "Tax Audit (Form 3CD)", tax?.title);
check("GST_ANNUAL_RETURN has a template titled for GSTR-9/9C", gst?.title === "GST Annual Return (GSTR-9/9C)", gst?.title);
const texts = (template) => [
  template.purpose,
  ...template.checklist.map((i) => i.title),
  ...template.milestones.map((i) => i.title),
  ...template.clientRequests.map((i) => i.title),
  ...template.deliverables.map((i) => i.title),
  ...template.safetyBoundaries,
].join("\n");
for (const [label, template] of [["TAX_AUDIT", tax], ["GST_ANNUAL_RETURN", gst]]) {
  const all = texts(template);
  check(`${label}: keeps the three shared safety boundaries`,
    template.safetyBoundaries.includes("No professional opinion or conclusion is generated automatically.") &&
    template.safetyBoundaries.includes("No portal filing or submission is performed automatically."));
  check(`${label}: never says CA PRO files, uploads, signs or concludes`,
    !/\bCA PRO (files|uploads|signs|submits|concludes|approves)\b/i.test(all) &&
    !/\b(automatically (file|upload|submit)s?)\b/i.test(all.replace(/nothing is (filed|uploaded) automatically/gi, "")));
  check(`${label}: its closing milestone is a person's act`,
    /by (a person|the auditor)/.test(template.milestones.at(-1).title), template.milestones.at(-1).title);
  check(`${label}: every deliverable a client relies on is human-approved`,
    template.deliverables.filter((d) => d.required).every((d) => /Human-approved|workings? file/i.test(d.title)));
  check(`${label}: every item key is unique within its list`,
    ["checklist", "milestones", "clientRequests", "deliverables"].every((list) =>
      new Set(template[list].map((i) => i.key)).size === template[list].length));
  check(`${label}: item categories are the shared stage keys`,
    ["checklist", "milestones", "clientRequests", "deliverables"].every((list) =>
      template[list].every((i) => ["INTAKE", "SCOPE", "PLANNING", "FIELDWORK", "RESPONSE", "REVIEW", "DELIVERY", "CLOSURE"].includes(i.category))));
}
check("TAX_AUDIT names the clauses the season's work is spent on",
  ["Clause 44", "Clause 22", "Clause 26", "Clause 31", "Clause 34"].every((c) => tax.checklist.some((i) => i.title.startsWith(c))));
check("GST_ANNUAL_RETURN never forces a difference to zero, in its own words",
  gst.safetyBoundaries.some((s) => /never forced to zero/.test(s)));

// 3. The Windows app's list.
const desktop = readFileSync(join(here, "..", "..", "apps", "desktop-native", "src", "CaPro.Desktop.Core", "Models", "Engagement.cs"), "utf8");
const block = desktop.match(/IReadOnlyList<string> Types =\s*\[([\s\S]*?)\];/);
const desktopTypes = block ? [...block[1].matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]) : [];
check("the Windows app's EngagementVocabulary.Types equals the server's list, in order",
  JSON.stringify(desktopTypes) === JSON.stringify([...ENGAGEMENT_TYPES]), desktopTypes.join(", "));

// 4. Through the real app, when a scratch database is named.
const uri = process.env.MONGODB_URI || "";
const loopbackScratch = /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(uri) && /scratch/i.test((uri.split("/").pop() || "").split("?")[0]);
let mongoRan = false;
if (loopbackScratch) {
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
  const ownerId = oid();
  const firmId = oid();
  const clientId = oid();
  await raw("users").insertOne({ _id: ownerId, email: "owner-season@scratch.test", name: "Owner Season", role: "FIRM_ADMIN", accountType: "FIRM_USER", isActive: true, tokenVersion: 0, firmId, createdAt: now, updatedAt: now });
  await raw("firms").insertOne({ _id: firmId, name: "Scratch Season Firm", displayName: "Scratch Season Firm", handle: "scratch-season", ownerId, ownerUserId: ownerId, type: "FIRM", isActive: true, joinCode: `SCRATCHSEASON${Date.now().toString(36).toUpperCase()}`, createdAt: now, updatedAt: now });
  await raw("firmmemberships").insertOne({ _id: oid(), firmId, userId: ownerId, status: "ACTIVE", role: "OWNER", memberAccess: "FULL", createdAt: now, updatedAt: now });
  // Every engagement names a reviewer who is an administrator of the firm.
  const reviewerId = oid();
  await raw("users").insertOne({ _id: reviewerId, email: "reviewer-season@scratch.test", name: "Reviewer Season", role: "USER", accountType: "FIRM_USER", isActive: true, tokenVersion: 0, firmId, createdAt: now, updatedAt: now });
  await raw("firmmemberships").insertOne({ _id: oid(), firmId, userId: reviewerId, status: "ACTIVE", role: "ADMIN", memberAccess: "FULL", createdAt: now, updatedAt: now });
  await raw("clients").insertOne({ _id: clientId, firmId, name: "Season Client Pvt Ltd", isActive: true, createdAt: now, updatedAt: now });
  await raw("appconfigs").insertOne({ _id: "singleton", featureFlags: { assuranceEngagements: true, fullTabWorkspace: true }, createdAt: now, updatedAt: now });
  const token = jwt.sign({ id: ownerId, email: "owner-season@scratch.test", role: "FIRM_ADMIN", accountType: "FIRM_USER", firmId, isActive: true, tv: 0 }, process.env.JWT_SECRET, { expiresIn: "30m" });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  };
  try {
    const templates = await call("GET", "/api/engagements/templates");
    check("live: the templates route answers the season types first",
      templates.status === 200 && JSON.stringify((templates.json?.templates || []).slice(0, 3).map((t) => t.engagementType)) === JSON.stringify(SEASON),
      `status ${templates.status}`);
    const targetDate = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    for (const type of ["TAX_AUDIT", "GST_ANNUAL_RETURN"]) {
      const created = await call("POST", "/api/engagements", {
        mutationKey: `season-${type.toLowerCase()}`,
        clientId: String(clientId),
        engagementType: type,
        scope: "FY 2025-26.",
        reviewerUserId: String(reviewerId),
        targetDate,
      });
      const engagement = created.json?.engagement;
      check(`live: a ${type} engagement is created from its template`,
        created.status === 201 && engagement?.engagementType === type &&
        engagement?.title === getEngagementTemplate(type).title &&
        engagement?.checklist?.length === getEngagementTemplate(type).checklist.length,
        `status ${created.status} ${JSON.stringify(created.json)?.slice(0, 200)}`);
      const listed = await call("GET", `/api/engagements?engagementType=${type}`);
      const items = listed.json?.engagements || listed.json?.items || [];
      check(`live: the ${type} engagement is listed back by its type filter`,
        listed.status === 200 && items.length === 1 && items[0].engagementType === type, `status ${listed.status}, ${items.length} listed`);
    }
    mongoRan = true;
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase().catch(() => {});
    await mongoose.disconnect();
  }
}

const failed = checks.filter((c) => !c.pass);
for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.pass || !c.detail ? "" : ` -- ${c.detail}`}`);
console.log(`\nengagement-season-types-contract: ${checks.length - failed.length}/${checks.length} passed${mongoRan ? " (scratch Mongo included)" : " (pure subset; no scratch MONGODB_URI)"}`);
process.exitCode = failed.length ? 1 : 0;
