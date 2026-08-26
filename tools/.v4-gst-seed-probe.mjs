// V4 investigation: can a real GST reconciliation run be created through the real API at all?
// Boots the real Express app in-process against the LOCAL scratch replica set (never production),
// seeds a user + personal firm + client, then drives the real import chain
// preview -> commit (GST_PURCHASE) -> preview -> commit (GSTR2B) -> POST gst-reconciliation/runs
// and prints the verbatim status + body of every step.
//
// Mirrors tools/capture-desktop-fixtures.mjs's boot sequence exactly (index provisioning, all
// feature flags on) so a refusal here is a real domain refusal, not a missing-index artefact.
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = "D:/CA-PRO-Toolkit/CA-PRO-Toolkit/capro-backend";
const toFileUrl = (...segments) => pathToFileURL(join(repoRoot, ...segments)).href;

process.env.NODE_ENV = "production";
process.env.MONGODB_URI = "mongodb://127.0.0.1:27118/scratch-capro-v4-gst?replicaSet=rs0";
process.env.JWT_SECRET = "scratch-only-secret-not-a-real-credential-0000";
mongoose.set("bufferTimeoutMS", 5000);

const { connectDB } = await import(toFileUrl("src", "config", "db.js"));
const { default: app } = await import(toFileUrl("src", "app.js"));
const { default: User } = await import(toFileUrl("src", "models", "User.js"));
const { default: AppConfig, DEFAULT_FEATURE_FLAGS } = await import(toFileUrl("src", "models", "AppConfig.js"));
const { ensurePersonalFirm } = await import(toFileUrl("src", "services", "firm-provisioning.service.js"));

await connectDB();
await mongoose.connection.dropDatabase();

const { ensureRequiredIndexes } = await import(toFileUrl("src", "services", "index-provisioning.service.js"));
const indexOutcome = await ensureRequiredIndexes();
console.log("index provisioning failures:", JSON.stringify(indexOutcome.failures || []).slice(0, 400));

await AppConfig.create({
  _id: "singleton",
  featureFlags: Object.fromEntries(Object.keys(DEFAULT_FEATURE_FLAGS).map((k) => [k, true])),
});

const server = app.listen(0);
await new Promise((res, rej) => { server.once("listening", res); server.once("error", rej); });
const base = `http://127.0.0.1:${server.address().port}`;

let user = await User.create({
  email: "v4-gst-probe@example.invalid",
  name: "V4 GST Probe",
  role: "USER",
  accountType: "INDIVIDUAL",
  isActive: true,
});
user = await ensurePersonalFirm(user);
const token = jwt.sign(
  { id: String(user._id), email: user.email, role: user.role, accountType: user.accountType, firmId: user.firmId, isActive: true, tv: 0 },
  process.env.JWT_SECRET,
  { expiresIn: "1h" }
);

async function call(method, path, body) {
  const r = await fetch(base + "/" + path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  return { status: r.status, json, text };
}

const clientRes = await call("POST", "api/taxworker/clients", { name: "V4 Probe Client", entityType: "INDIVIDUAL" });
console.log("POST api/clients ->", clientRes.status, clientRes.text.slice(0, 300));
const clientId = clientRes.json?.client?._id ?? clientRes.json?._id ?? clientRes.json?.client?.id ?? null;
console.log("clientId:", clientId);

const GSTIN = "27AAQCV9182K1ZQ";
const PERIOD = "2026-07";
const MAPPING = {
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
const CSV = [
  "Supplier GSTIN,Recipient GSTIN,Invoice Number,Document Date,Document Type,Taxable Value,IGST,CGST,SGST,Cess",
  `29AAQCV1234K1ZP,${GSTIN},INV-0001,2026-07-05,INVOICE,100000.00,18000.00,0.00,0.00,0.00`,
  `29AAQCV1234K1ZP,${GSTIN},INV-0002,2026-07-18,INVOICE,50000.00,0.00,4500.00,4500.00,0.00`,
  "",
].join("\n");

async function commitBatch(kind) {
  const text = CSV.replaceAll("INV-", kind === "GSTR2B" ? "PINV-" : "BINV-");
  const body = { kind, text, mapping: MAPPING, delimiter: ",", clientId: String(clientId), gstin: GSTIN, period: PERIOD };
  const preview = await call("POST", "api/imports/preview", body);
  console.log(`\nPOST api/imports/preview (${kind}) ->`, preview.status, preview.text.slice(0, 400));
  const sourceHash = preview.json?.preview?.sourceHash ?? null;
  const previewToken = preview.json?.preview?.commitToken ?? preview.json?.preview?.previewToken ?? preview.json?.previewToken ?? null;
  if (!sourceHash) return null;
  const commit = await call("POST", `api/imports/${encodeURIComponent(sourceHash)}/commit`, { ...body, ...(previewToken ? { previewToken } : {}) });
  console.log(`POST api/imports/{hash}/commit (${kind}) ->`, commit.status, commit.text.slice(0, 600));
  return commit.json?.batch?._id ?? commit.json?.batch?.id ?? commit.json?.batchId ?? null;
}

const booksBatchId = await commitBatch("GST_PURCHASE");
console.log("booksBatchId:", booksBatchId);
const portalBatchId = await commitBatch("GSTR2B");
console.log("portalBatchId:", portalBatchId);

if (booksBatchId && portalBatchId) {
  const run = await call("POST", "api/gst-reconciliation/runs", {
    clientId: String(clientId),
    gstin: GSTIN,
    period: PERIOD,
    booksBatchId: String(booksBatchId),
    portalBatchId: String(portalBatchId),
  });
  console.log("\nPOST api/gst-reconciliation/runs ->", run.status, run.text.slice(0, 800));
} else {
  console.log("\nPOST api/gst-reconciliation/runs -> NOT ATTEMPTED (a batch commit did not return an id)");
}

const list = await call("GET", "api/gst-reconciliation/runs");
console.log("\nGET api/gst-reconciliation/runs ->", list.status, list.text.slice(0, 500));

server.close();
await mongoose.connection.close();
process.exit(0);
