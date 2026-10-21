// tests/ai-consent-pin-contract.mjs
//
// W11 IN4 (2026-10-21): which AI routes refuse without explicit consent on the SERVER, pinned as they are today,
// so a change to any of them is deliberate and visible.
//
// Why: privacy.html section 10a says "the server ... refuses an AI audit request without explicit consent, ...
// before any outbound call is made". That is true of the working-paper analysis and the notice-case routes; it
// is NOT true of /api/audit/* (refine, insights, reminder-message, standard-guidance), the audit-pack row draft
// or the Tally group suggestion, which rely on the terms (section 7A) and the clients' own switch or prompt.
// The owner chooses the fix (.kiro/OWNER-TODO.md, W11 item 1): enforce consent on /api/audit once a client
// version sends it, or correct the sentence. Until then this suite fails the moment either side moves:
//   - if /api/audit/insights starts refusing without consent, the pin below fails (update the pin AND the page);
//   - if a consent guard disappears from the working-paper or case services, the static pin fails.
// The W11 routes refuse without consent; that is pinned in ai-task-contract.
//
// Run: MONGODB_URI=mongodb://127.0.0.1:27117/scratch-ai-consent node tests/ai-consent-pin-contract.mjs

import { existsSync, readFileSync } from "node:fs";

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
  const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

  // ─── static pins: the consent guards that make the page's sentence true where it is true ───
  const workingPaper = source("src/services/audit-working-paper.service.js");
  check("working-paper analysis refuses without consentToExternalProcessing (AUDIT_AI_CONSENT_REQUIRED)", /consentToExternalProcessing/.test(workingPaper) && /AUDIT_AI_CONSENT_REQUIRED/.test(workingPaper));
  const caseRecord = source("src/services/case-record.service.js");
  const caseContent = source("src/services/case-content.service.js");
  check("notice extraction, analysis and AI-assisted drafts refuse without consent (CASE_AI_CONSENT_REQUIRED)", /CASE_AI_CONSENT_REQUIRED/.test(caseRecord) && (caseContent.match(/CASE_AI_CONSENT_REQUIRED/g) || []).length >= 2);
  const ocr = source("src/services/ocr-space.service.js");
  check("OCR refuses without consent (OCR_CONSENT_REQUIRED)", /OCR_CONSENT_REQUIRED/.test(ocr));
  const audit = source("src/controllers/audit.controller.js");
  check("PIN: /api/audit/* has no server consent check today (the privacy sentence overstates this; owner decision W11 item 1)", !/consent/i.test(audit));
  const packDraft = source("src/services/audit-pack.service.js");
  const books = source("src/services/books/books-ai.service.js");
  check("PIN: the audit-pack row draft and the Tally group suggestion have no server consent check today", !/consent/i.test(packDraft.slice(packDraft.indexOf("export async function draftAuditPackRow"), packDraft.indexOf("// ─── party master"))) && !/consent/i.test(books));
  // The website lives in the parent repository; a checkout of the backend alone has no page to read.
  const pageUrl = new URL("../../ca-pro-website/privacy.html", import.meta.url);
  if (existsSync(pageUrl)) {
    const page = readFileSync(pageUrl, "utf8");
    check("the privacy page still carries the sentence this suite pins against (change both together)", /refuses an AI audit request without explicit consent/.test(page));
  } else {
    console.log("NOTE  privacy.html is not in this checkout (backend alone); the page pin is skipped, not passed.");
  }

  // ─── behavioural pin: /api/audit/insights calls the model with no consent field ───
  process.env.NODE_ENV = "production";
  process.env.JWT_SECRET = process.env.JWT_SECRET || "scratch-only-secret-not-a-real-credential-0000";
  process.env.DEEPSEEK_API_KEY = "";
  process.env.OCR_SPACE_API_KEY = "";
  const { ensureMockDeepSeek } = await import("./lib/mock-deepseek.mjs");
  const mock = await ensureMockDeepSeek();
  const mongoose = (await import("mongoose")).default;
  const jwt = (await import("jsonwebtoken")).default;
  const { default: app } = await import("../src/app.js");
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
  await mongoose.connection.dropDatabase();
  const raw = (name) => mongoose.connection.collection(name);
  const oid = () => new mongoose.Types.ObjectId();
  const now = new Date();
  const userId = oid();
  const firmId = oid();
  await raw("users").insertOne({ _id: userId, email: "consent-pin@scratch.test", name: "Pin", role: "FIRM_ADMIN", accountType: "FIRM_USER", isActive: true, tokenVersion: 0, firmId, createdAt: now, updatedAt: now });
  const token = jwt.sign({ id: userId, email: "consent-pin@scratch.test", role: "FIRM_ADMIN", accountType: "FIRM_USER", firmId, isActive: true, tv: 0 }, process.env.JWT_SECRET, { expiresIn: "30m" });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    mock.reset();
    mock.on(() => JSON.stringify({ findings: [] }));
    const response = await fetch(`${base}/api/audit/insights`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ rawText: "Sundry creditors include an unreconciled balance with a related party carried forward for three years without confirmation.", topicId: "related_parties" }),
    });
    check("PIN: POST /api/audit/insights with no consent field reaches the model", response.status !== 400 && mock.calls.length >= 1, `status ${response.status}, calls ${mock.calls.length}`);
  } finally {
    mock.off();
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase().catch(() => {});
    await mongoose.disconnect();
  }

  const failed = checks.filter((c) => !c.pass);
  for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.pass || !c.detail ? "" : ` -- ${c.detail}`}`);
  console.log(`\nai-consent-pin-contract: ${checks.length - failed.length}/${checks.length} passed`);
  return failed.length ? 1 : 0;
}
