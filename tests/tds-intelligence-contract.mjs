// tests/tds-intelligence-contract.mjs
//
// W11 IN17 + IN18 (2026-10-21): per-status correction checklists, and drafted reviewer notes and chase messages
// that a person keeps by sending them with the existing action-plan preview and commit.
//
// Pinned: every check status the model knows has a checklist; with `intelligence` off the plan keeps its earlier
// family list, with it on the per-status list; drafting needs the flag, the firm's opt-in and consent, sends no
// PAN, name or amount, and stores nothing on the check; per-check messages change the plan (and its preview token)
// and are stored by the commit; a message for a check outside the plan is refused.
// The commit runs in a transaction, so this suite needs the replica set (run-gates registers it there).
//
// Run: MONGODB_URI="mongodb://127.0.0.1:27118/scratch-tds-intelligence?replicaSet=rs0" node tests/tds-intelligence-contract.mjs

// The replica-set suites run with the runner's default URI, like the other transaction suites.
const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27118/scratch-tds-intelligence?replicaSet=rs0";
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
  // The app's startup check reads MONGODB_URI; the replica-set runner leaves it unset and uses the default.
  process.env.MONGODB_URI = uri;
  process.env.JWT_SECRET = process.env.JWT_SECRET || "scratch-only-secret-not-a-real-credential-0000";
  process.env.DEEPSEEK_API_KEY = "";
  process.env.OCR_SPACE_API_KEY = "";
  const { ensureMockDeepSeek } = await import("./lib/mock-deepseek.mjs");
  const mock = await ensureMockDeepSeek();
  const mongoose = (await import("mongoose")).default;
  const jwt = (await import("jsonwebtoken")).default;
  const { default: app } = await import("../src/app.js");
  const { TDS_ACTION_CHECKLISTS } = await import("../src/services/tds-action-checklists.js");
  const { TDS_CHECK_STATUSES } = await import("../src/models/TdsHealthCheck.js");

  // ─── pure: every status has its steps ───
  const missing = TDS_CHECK_STATUSES.filter((status) => !Array.isArray(TDS_ACTION_CHECKLISTS[status]) || !TDS_ACTION_CHECKLISTS[status].length);
  check("every TDS check status has a per-status correction checklist", missing.length === 0, missing.join(", "));
  const allSteps = Object.values(TDS_ACTION_CHECKLISTS).flat().join(" ");
  check("no checklist states a rate, an interest figure or a fee amount", !/\d+(?:\.\d+)?\s*%|\brate of\b|interest of|fee of/i.test(allSteps));

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
  await mongoose.connection.dropDatabase();
  const { ensureRequiredIndexes } = await import("../src/services/index-provisioning.service.js");
  await ensureRequiredIndexes();
  for (const name of ["AiDraft", "AiSuggestionOutcome"]) await (await import(`../src/models/${name}.js`)).default.syncIndexes();

  const raw = (name) => mongoose.connection.collection(name);
  const oid = () => new mongoose.Types.ObjectId();
  const now = new Date();
  const ownerId = oid();
  const firmId = oid();
  const clientId = oid();
  await raw("users").insertOne({ _id: ownerId, email: "owner-tds-intel@scratch.test", name: "Owner TDS", role: "FIRM_ADMIN", accountType: "FIRM_USER", isActive: true, tokenVersion: 0, firmId, createdAt: now, updatedAt: now });
  await raw("firms").insertOne({ _id: firmId, displayName: "Mehta Associates", handle: "scratch-tds-intel", ownerUserId: ownerId, kind: "SHARED", isActive: true, joinCode: `JTI${Date.now()}`.slice(0, 16), aiDrafting: { enabled: true, changedBy: ownerId, changedAt: now }, createdAt: now, updatedAt: now });
  await raw("firmmemberships").insertOne({ _id: oid(), firmId, userId: ownerId, status: "ACTIVE", role: "OWNER", memberAccess: "FULL", createdAt: now, updatedAt: now });
  await raw("clients").insertOne({ _id: clientId, firmId, name: "Ranade Engineering", isActive: true, createdAt: now, updatedAt: now });
  await raw("appconfigs").insertOne({ _id: "singleton", featureFlags: { tdsHealth: true, intelligence: false }, createdAt: now, updatedAt: now });
  const token = jwt.sign({ id: ownerId, email: "owner-tds-intel@scratch.test", role: "FIRM_ADMIN", accountType: "FIRM_USER", firmId, isActive: true, tv: 0 }, process.env.JWT_SECRET, { expiresIn: "30m" });

  const runId = oid();
  const attempt = "gen-1";
  // A run as the worker publishes it: every field the TDS storage readiness check requires before a write.
  await raw("tdshealthruns").insertOne({
    _id: runId, firmId, clientId, tan: "PNER12345F", financialYear: "2025-26", quarter: "Q2", statementType: "26Q",
    sourceImports: { deductionsBatchId: oid(), challansBatchId: oid(), statementsBatchId: oid(), creditBatchId: null },
    sourceFingerprint: "b".repeat(64), revision: 1, rolloutVersion: 0, generationAttempt: attempt, activeGenerationAttempt: attempt,
    status: "REVIEW", checkVersion: 1, jobId: oid(),
    summary: { deductedMinor: 0, depositedMinor: 0, reportedMinor: 0, importedCreditMinor: 0, estimatedGapMinor: 0, totalChecks: 2, openChecks: 2, actionPlannedChecks: 0, resolvedChecks: 0 },
    calculationPolicy: { version: "tds-health-v1-no-rate-engine", sourceLabel: "Imported register", sourceReference: "Arithmetic comparison", estimate: true, professionalConfirmed: false, ratesApplied: false },
    createdAt: now, updatedAt: now,
  });
  const source = [{ rowId: oid(), batchId: oid(), kind: "TDS_DEDUCTIONS", sourceRow: 2, label: "Row 2" }];
  const meta = { ruleVersion: "tds-health-v1-no-rate-engine", sourceLabel: "Imported register", sourceReference: "Arithmetic comparison" };
  const PAN = "ABCPR1234K";
  async function seedCheck(status, extra = {}) {
    const doc = {
      _id: oid(), firmId, runId, clientId, generationAttempt: attempt, itemKey: `${status}-${Math.random()}`, checkVersion: 1, status,
      dimension: status.startsWith("PAN") ? "PAN" : "DEPOSIT", severity: "ERROR", state: "OPEN", title: `Check ${status}`, explanation: "Computed from the imported rows.",
      recommendedAction: "Review.", deducteePan: PAN, sectionCode: "194J", expectedMinor: 1000000, actualMinor: 800000, differenceMinor: 200000,
      sourceRows: source, sourceEvidenceCount: 1, sourceEvidenceHash: "a".repeat(64), resolution: { version: 0 }, ...meta, ...extra, createdAt: now, updatedAt: now,
    };
    await raw("tdshealthchecks").insertOne(doc);
    return doc;
  }
  const challan = await seedCheck("CHALLAN_UNMAPPED");
  const pan = await seedCheck("PAN_MISSING");

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, json: await response.json().catch(() => null) };
  };
  const planBody = (extra = {}) => ({ checkIds: [String(challan._id)], ownerUserId: String(ownerId), dueDateISO: "2026-11-15", priority: "HIGH", reviewerNote: "Shared note.", ...extra });

  try {
    const offPreview = await call("POST", `/api/tds-health/runs/${runId}/action-plan/preview`, planBody());
    const offSteps = offPreview.json?.result?.plan?.[0]?.correctionChecklist || [];
    check("with intelligence off the plan keeps the earlier family checklist", offPreview.status === 200 && offSteps[0] === "Review ITNS 281 source row", JSON.stringify(offSteps));
    const offDraft = await call("POST", `/api/tds-health/runs/${runId}/action-drafts`, { checkIds: [String(challan._id)], consent: true });
    check("with intelligence off the draft route answers 404 naming the flag", offDraft.status === 404 && offDraft.json?.featureFlag === "intelligence");

    await raw("appconfigs").updateOne({ _id: "singleton" }, { $set: { "featureFlags.intelligence": true } });
    const onPreview = await call("POST", `/api/tds-health/runs/${runId}/action-plan/preview`, planBody());
    const onSteps = onPreview.json?.result?.plan?.[0]?.correctionChecklist || [];
    check("with intelligence on the plan carries the per-status checklist for a challan not mapped", onSteps.length === TDS_ACTION_CHECKLISTS.CHALLAN_UNMAPPED.length && onSteps[0] === TDS_ACTION_CHECKLISTS.CHALLAN_UNMAPPED[0], JSON.stringify(onSteps));
    const listed = await call("GET", `/api/tds-health/runs/${runId}/action-plan`);
    check("the action-plan list suggests the same per-status checklist", (listed.json?.result?.items || listed.json?.items || []).some((entry) => entry.suggestedChecklist?.[0] === TDS_ACTION_CHECKLISTS.CHALLAN_UNMAPPED[0] || entry.suggestedChecklist?.[0] === TDS_ACTION_CHECKLISTS.PAN_MISSING[0]), JSON.stringify(listed.json)?.slice(0, 300));

    // ─── drafting ───
    mock.reset();
    mock.on((body) => {
      const ids = [...String(body.messages[1].content).matchAll(/"id":"([a-f0-9]{24})"/g)].map((m) => m[1]);
      return JSON.stringify({ items: ids.map((id) => ({ id, cannotTell: false, reviewerNote: "Map the challan to section 194J for the quarter before any correction statement is prepared.", chaseMessage: "Dear {{client}}, please share the challan counterfoil for {{deductee}} for {{period}} (section {{section}}, difference {{amount}}). Regards, {{sender}}" })) });
    });
    const noConsent = await call("POST", `/api/tds-health/runs/${runId}/action-drafts`, { checkIds: [String(challan._id)] });
    check("drafting without consent is refused and nothing is sent", noConsent.status === 400 && noConsent.json?.code === "AI_CONSENT_REQUIRED" && mock.calls.length === 0);
    const before = JSON.stringify(await raw("tdshealthchecks").find({}).sort({ _id: 1 }).toArray());
    const drafted = await call("POST", `/api/tds-health/runs/${runId}/action-drafts`, { checkIds: [String(challan._id), String(pan._id)], consent: true });
    const first = drafted.json?.drafts?.find((d) => d.checkId === String(challan._id));
    check("drafts come back per check, labelled DRAFT FOR REVIEW, with the chase message filled by the server", drafted.status === 200 && drafted.json.drafts.length === 2 && first?.label === "DRAFT FOR REVIEW" && /Ranade Engineering/.test(first.clientChaseMessage) && /ABCPR1234K/.test(first.clientChaseMessage) && /₹2,000/.test(first.clientChaseMessage) && /Mehta Associates/.test(first.clientChaseMessage), JSON.stringify(drafted.json));
    const outbound = JSON.stringify(mock.calls[0]?.body || {});
    check("the model saw no PAN, client name or amount (194J and the checklist only)", !outbound.includes(PAN) && !outbound.includes("Ranade") && !outbound.includes("200000") && /194J/.test(outbound) && /BSR code/.test(outbound), outbound.slice(0, 300));
    check("drafting stored nothing on the checks", JSON.stringify(await raw("tdshealthchecks").find({}).sort({ _id: 1 }).toArray()) === before);

    // ─── keeping a draft: preview and commit with messages ───
    const keep = { [String(challan._id)]: { clientChaseMessage: first.clientChaseMessage, reviewerNote: first.reviewerNote } };
    const withMessages = await call("POST", `/api/tds-health/runs/${runId}/action-plan/preview`, planBody({ messages: keep }));
    const planned = withMessages.json?.result?.plan?.[0];
    check("a kept draft replaces the plan's chase message and reviewer note for that check", planned?.clientChaseMessage === first.clientChaseMessage && planned.reviewerNote === first.reviewerNote, JSON.stringify(planned)?.slice(0, 300));
    check("a different message is a different plan (a new preview token)", withMessages.json?.result?.planFingerprint !== onPreview.json?.result?.planFingerprint);
    const stray = await call("POST", `/api/tds-health/runs/${runId}/action-plan/preview`, planBody({ messages: { [String(pan._id)]: { reviewerNote: "x" } } }));
    check("a message for a check outside the plan is refused", stray.status === 400, `status ${stray.status}`);
    const extraKey = await call("POST", `/api/tds-health/runs/${runId}/action-plan/preview`, planBody({ messages: { [String(challan._id)]: { reviewerNote: "x", taskTitle: "y" } } }));
    check("a message field the plan does not take is refused", extraKey.status === 400);
    const committed = await call("POST", `/api/tds-health/runs/${runId}/action-plan/commit`, planBody({ messages: keep, previewToken: withMessages.json?.result?.commitToken }));
    const stored = await raw("tdshealthchecks").findOne({ _id: challan._id });
    check("the commit stores the kept chase message and reviewer note on the check", committed.status === 200 || committed.status === 201 ? stored?.actionPlan?.clientChaseMessage === first.clientChaseMessage && stored.actionPlan.reviewerNote === first.reviewerNote : false, `status ${committed.status} ${JSON.stringify(committed.json)?.slice(0, 200)}`);
    const tampered = await call("POST", `/api/tds-health/runs/${runId}/action-plan/commit`, planBody({ messages: { [String(challan._id)]: { reviewerNote: "Changed after preview." } }, previewToken: withMessages.json?.result?.commitToken }));
    check("changing a message after the preview is refused at commit", tampered.status === 409, `status ${tampered.status}`);
  } finally {
    mock.off();
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase().catch(() => {});
    await mongoose.disconnect();
  }

  const failed = checks.filter((c) => !c.pass);
  for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.pass || !c.detail ? "" : ` -- ${c.detail}`}`);
  console.log(`\ntds-intelligence-contract: ${checks.length - failed.length}/${checks.length} passed`);
  return failed.length ? 1 : 0;
}
