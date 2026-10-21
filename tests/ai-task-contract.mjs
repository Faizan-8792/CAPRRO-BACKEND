// tests/ai-task-contract.mjs
//
// W11 IN1, IN2, IN5 (2026-10-21): the shared intelligence layer through the real app and a loopback stand-in
// for DeepSeek, against a scratch database.
//
// Pinned:
//   IN1  a retired model name (in the environment or sent by a client) is translated to its replacement and
//        never reaches DeepSeek; the defaults are current names.
//   IN2  an answer's token counts land on the caller's daily row under its feature; an answer without counts
//        records none; the admin report returns tokens and an estimate by feature.
//   IN5  nothing is sent with the `intelligence` flag off, with the firm not opted in, or without consent;
//        only a firm owner or admin changes the opt-in; a valid answer is stored as a PENDING draft that
//        expires; the same question again is answered from the store with no second call; an answer that
//        introduces a number, a link, an unknown slot, a cause off the list or an item that was not sent is
//        refused and nothing is stored; a field the model adds is not kept; what a person did with a draft is
//        recorded once, adopted drafts stop expiring, and another firm can neither read nor mark a draft.
//
// Run: MONGODB_URI=mongodb://127.0.0.1:27117/scratch-ai-task node tests/ai-task-contract.mjs

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
  // IN1: a retired name in the environment, as the local .env had on 2026-10-21.
  process.env.DEEPSEEK_MODEL = "deepseek-v4-flash";
  process.env.DEEPSEEK_MODEL_FALLBACK = "deepseek-chat";

  const { ensureMockDeepSeek } = await import("./lib/mock-deepseek.mjs");
  const mock = await ensureMockDeepSeek();

  const mongoose = (await import("mongoose")).default;
  const jwt = (await import("jsonwebtoken")).default;
  const { default: app } = await import("../src/app.js");
  const models = await import("../src/services/ai/deepseek-models.js");
  const provider = await import("../src/services/deepseek-provider.service.js");
  const ai = await import("../src/services/ai/ai-task.service.js");
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
  await mongoose.connection.dropDatabase();
  const { ensureRequiredIndexes } = await import("../src/services/index-provisioning.service.js");
  await ensureRequiredIndexes();
  const AiDraft = (await import("../src/models/AiDraft.js")).default;
  await AiDraft.syncIndexes();
  const AiSuggestionOutcome = (await import("../src/models/AiSuggestionOutcome.js")).default;
  await AiSuggestionOutcome.syncIndexes();

  const raw = (name) => mongoose.connection.collection(name);
  const oid = () => new mongoose.Types.ObjectId();
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  async function buildFirm(label) {
    const ownerId = oid();
    const firmId = oid();
    await raw("users").insertOne({ _id: ownerId, email: `owner-${label}@scratch.test`, name: `Owner ${label}`, role: "FIRM_ADMIN", accountType: "FIRM_USER", isActive: true, tokenVersion: 0, firmId, createdAt: now, updatedAt: now });
    await raw("firms").insertOne({ _id: firmId, displayName: `AI Firm ${label}`, handle: `scratch-ai-${label.toLowerCase()}`, ownerUserId: ownerId, kind: "SHARED", isActive: true, joinCode: `JAI${label}${Date.now()}`.slice(0, 16), createdAt: now, updatedAt: now });
    await raw("firmmemberships").insertOne({ _id: oid(), firmId, userId: ownerId, status: "ACTIVE", role: "OWNER", memberAccess: "FULL", createdAt: now, updatedAt: now });
    const token = jwt.sign({ id: ownerId, email: `owner-${label}@scratch.test`, role: "FIRM_ADMIN", accountType: "FIRM_USER", firmId, isActive: true, tv: 0 }, process.env.JWT_SECRET, { expiresIn: "30m" });
    return { ownerId, firmId, token };
  }
  const A = await buildFirm("A");
  const B = await buildFirm("B");
  const memberId = oid();
  await raw("users").insertOne({ _id: memberId, email: "member-ai@scratch.test", name: "Member", role: "USER", accountType: "FIRM_USER", isActive: true, tokenVersion: 0, firmId: A.firmId, createdAt: now, updatedAt: now });
  await raw("firmmemberships").insertOne({ _id: oid(), firmId: A.firmId, userId: memberId, status: "ACTIVE", role: "MEMBER", memberAccess: "FULL", createdAt: now, updatedAt: now });
  const memberToken = jwt.sign({ id: memberId, email: "member-ai@scratch.test", role: "USER", accountType: "FIRM_USER", firmId: A.firmId, isActive: true, tv: 0 }, process.env.JWT_SECRET, { expiresIn: "30m" });
  const superId = oid();
  const superEmail = "saifullahfaizan786@gmail.com";
  await raw("users").insertOne({ _id: superId, email: superEmail, name: "Super", role: "SUPER_ADMIN", accountType: "FIRM_USER", isActive: true, tokenVersion: 0, firmId: A.firmId, createdAt: now, updatedAt: now });
  const superToken = jwt.sign({ id: superId, email: superEmail, role: "SUPER_ADMIN", accountType: "FIRM_USER", firmId: A.firmId, isActive: true, tv: 0 }, process.env.JWT_SECRET, { expiresIn: "30m" });
  await raw("appconfigs").insertOne({ _id: "singleton", featureFlags: { intelligence: false }, createdAt: now, updatedAt: now });

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, token, body) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  };
  const setFlag = (value) => raw("appconfigs").updateOne({ _id: "singleton" }, { $set: { "featureFlags.intelligence": value } });

  // One residue unit as the GST feature will send it: shapes and rupee figures, no name, GSTIN or number.
  // The unit id is not part of the question: two units with the same facts are the same question (replayed),
  // so each check below that needs a fresh call gives its unit a different day gap.
  const unit = (id, extra = {}) => ({
    id,
    subject: { kind: "ReconciliationItem", id: `B:${id}` },
    facts: {
      status: "MISSING_IN_2B",
      documentType: "INVOICE",
      books: { taxable: 8400, igst: 0, cgst: 756, sgst: 756, cess: 0 },
      portal: null,
      difference: null,
      dateGapDays: null,
      invoiceShape: "999/99-99",
      rulesTried: ["R1", "R2", "R3", "R4", "R5", "R6", "R7"],
      sameSupplier: [{ ref: "n1", status: "MATCHED", documentType: "INVOICE", taxable: 4200, totalTax: 756, dayGap: 0 }],
      ...extra,
    },
  });
  const answer = (items) => JSON.stringify({ items });
  const good = (id, more = {}) => ({ id, cause: "SPLIT_OR_CLUBBED_INVOICE", suggestedDisposition: "BOOKS_CORRECTION", reason: "The books amount is twice a matched invoice from the same supplier on the same day; it may have been entered twice.", factsUsed: ["books", "sameSupplier"], relatedRef: "n1", ...more });
  const run = (firm, units, consent = true, taskName = "gst_cause_residue") =>
    ai.runAiTask({ taskName, firmId: firm.firmId, userId: firm.ownerId, consent, units }).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );

  try {
    // ─── IN1: model names ───
    check("IN1: the default model is deepseek-flash and the fallback deepseek-v4-pro", models.DEFAULT_DEEPSEEK_MODEL === "deepseek-flash" && models.DEFAULT_DEEPSEEK_FALLBACK_MODEL === "deepseek-v4-pro");
    check("IN1: neither default is a retired name", !Object.prototype.hasOwnProperty.call(models.RETIRED_DEEPSEEK_MODELS, models.DEFAULT_DEEPSEEK_MODEL) && !Object.prototype.hasOwnProperty.call(models.RETIRED_DEEPSEEK_MODELS, models.DEFAULT_DEEPSEEK_FALLBACK_MODEL));
    check("IN1: a retired name in DEEPSEEK_MODEL resolves to deepseek-flash", provider.DEEPSEEK_MODEL === "deepseek-flash", provider.DEEPSEEK_MODEL);
    check("IN1: every retired name maps to a current one", Object.values(models.RETIRED_DEEPSEEK_MODELS).every((name) => models.CURRENT_DEEPSEEK_MODELS.includes(name)));
    check("IN1: an unknown new name passes through untouched, a blank one gives the default", models.resolveDeepSeekModel("deepseek-v5-something") === "deepseek-v5-something" && models.resolveDeepSeekModel("  ") === "deepseek-flash");
    mock.reset();
    mock.on(() => "ok");
    const direct = await provider.callDeepSeek({ system: "s", prompt: "p", userId: A.ownerId, operation: "self_test", model: "deepseek-chat" });
    const sentModels = mock.calls.map((c) => c.body?.model);
    check("IN1: a retired name passed by a caller reaches DeepSeek as deepseek-flash, with thinking disabled", direct.ok && sentModels[0] === "deepseek-flash" && mock.calls[0].body?.thinking?.type === "disabled", JSON.stringify(sentModels));
    mock.off();

    // ─── IN5: refusals, before anything is sent ───
    mock.reset();
    mock.on(() => answer([good("u1")]));
    const settingsOff = await call("GET", "/api/ai-drafts/settings", A.token);
    check("IN5: settings answer with the flag off, saying it is off", settingsOff.status === 200 && settingsOff.json?.settings?.intelligence === false && settingsOff.json.settings.firmOptIn.enabled === false && settingsOff.json.settings.canChange === true, JSON.stringify(settingsOff.json));
    const putOff = await call("PUT", "/api/ai-drafts/settings", A.token, { enabled: true });
    check("IN5: the opt-in cannot change while the flag is off (404 naming it)", putOff.status === 404 && putOff.json?.featureFlag === "intelligence", `status ${putOff.status}`);
    const flagOff = await run(A, [unit("u1")]);
    check("IN5: flag off -> AI_FEATURE_OFF and no outbound call", flagOff.error?.code === "AI_FEATURE_OFF" && mock.calls.length === 0, `${flagOff.error?.code} calls ${mock.calls.length}`);
    await setFlag(true);
    const notOpted = await run(A, [unit("u1")]);
    check("IN5: firm not opted in -> AI_DRAFTING_OFF_FOR_FIRM (403) and no outbound call", notOpted.error?.code === "AI_DRAFTING_OFF_FOR_FIRM" && notOpted.error.statusCode === 403 && mock.calls.length === 0, `${notOpted.error?.code} calls ${mock.calls.length}`);
    const memberPut = await call("PUT", "/api/ai-drafts/settings", memberToken, { enabled: true });
    check("IN5: a member who is not a firm admin cannot switch the opt-in on", memberPut.status === 403, `status ${memberPut.status}`);
    const extraPut = await call("PUT", "/api/ai-drafts/settings", A.token, { enabled: true, provider: "x" });
    check("IN5: the settings route refuses a field it does not take", extraPut.status === 400, `status ${extraPut.status}`);
    const ownerPut = await call("PUT", "/api/ai-drafts/settings", A.token, { enabled: true });
    check("IN5: a firm owner switches the opt-in on, recorded with who and when", ownerPut.status === 200 && ownerPut.json?.firmOptIn?.enabled === true && Boolean(ownerPut.json.firmOptIn.changedAt), JSON.stringify(ownerPut.json));
    const activity = await raw("activityevents").findOne({ firmId: A.firmId, action: "FIRM_AI_DRAFTING_ON" });
    check("IN5: switching the opt-in is in the firm's activity log", Boolean(activity));
    const noConsent = await run(A, [unit("u1")], false);
    check("IN5: no consent -> AI_CONSENT_REQUIRED and no outbound call", noConsent.error?.code === "AI_CONSENT_REQUIRED" && mock.calls.length === 0, `${noConsent.error?.code} calls ${mock.calls.length}`);
    const otherFirm = await run(B, [unit("u1")]);
    check("IN5: another firm's opt-in is its own (B is still off)", otherFirm.error?.code === "AI_DRAFTING_OFF_FOR_FIRM" && mock.calls.length === 0);

    // ─── IN5 + IN2: a valid answer, its tokens, its replay ───
    mock.usage({ prompt_tokens: 1200, prompt_cache_hit_tokens: 1000, prompt_cache_miss_tokens: 200, completion_tokens: 150 });
    const first = await run(A, [unit("u1")]);
    const stored = await AiDraft.findOne({ firmId: A.firmId, task: "gst_cause_residue" }).lean();
    check("IN5: a valid answer comes back as a draft labelled DRAFT FOR REVIEW", first.value?.available === true && first.value.results.length === 1 && first.value.results[0].draft.label === "DRAFT FOR REVIEW" && first.value.results[0].draft.output.cause === "SPLIT_OR_CLUBBED_INVOICE", JSON.stringify(first.value || first.error?.message));
    check("IN5: it is stored PENDING with an expiry about 30 days out", stored?.outcome === "PENDING" && stored.expiresAt && Math.abs(new Date(stored.expiresAt) - now - 30 * 86400000) < 3600000, JSON.stringify(stored?.expiresAt));
    const body = mock.calls[0]?.body;
    const system = body?.messages?.[0]?.content || "";
    const user = body?.messages?.[1]?.content || "";
    check("IN5: the fixed rules come first in the system prompt and the facts last in the user prompt", system.startsWith(ai.COMMON_SYSTEM) && /INPUT \(json\):\n\{"items":\[\{"id":"u1"/.test(user) && body?.response_format?.type === "json_object", user.slice(0, 200));
    check("IN5: the outbound body carries no GSTIN- or PAN-shaped text", !/[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]|[A-Z]{5}[0-9]{4}[A-Z]/.test(JSON.stringify(body)));
    const usageRow = await raw("providerusages").findOne({ userId: A.ownerId, provider: "DEEPSEEK", periodKey: today });
    const tokens = usageRow?.operationTokens?.gst_cause_residue;
    check("IN2: the answer's tokens are recorded under its feature on the caller's daily row", tokens?.promptTokens === 1200 && tokens.cacheHitTokens === 1000 && tokens.cacheMissTokens === 200 && tokens.completionTokens === 150 && usageRow.operations?.gst_cause_residue === 1, JSON.stringify(usageRow?.operationTokens));
    const callsBefore = mock.calls.length;
    const again = await run(A, [unit("u1")]);
    check("IN5: the same question again is answered from the store with no second call", again.value?.results?.[0]?.draft?.replayed === true && mock.calls.length === callsBefore && again.value.results[0].draft.id === String(stored._id), `calls ${mock.calls.length} vs ${callsBefore}`);

    mock.usage(null);
    mock.on(() => answer([good("u2")]));
    await run(A, [unit("u2", { dateGapDays: 3 })]);
    const usageAfter = await raw("providerusages").findOne({ userId: A.ownerId, provider: "DEEPSEEK", periodKey: today });
    check("IN2: an answer without token counts records none (no guessed zero)", usageAfter?.operationTokens?.gst_cause_residue?.promptTokens === 1200 && usageAfter.operations?.gst_cause_residue === 2, JSON.stringify(usageAfter?.operationTokens));

    // ─── IN5: answers that must be refused ───
    const refusedCases = [
      ["a number in the reason", good("u3", { reason: "The books show Rs 8,400 against nothing in 2B." })],
      ["a link in the reason", good("u3", { reason: "See https://example.com for the rule." })],
      ["a cause off the list", good("u3", { cause: "FRAUD" })],
      ["a disposition off the list", good("u3", { suggestedDisposition: "ACCEPT_MATCH" })],
      ["a related item that was not sent", good("u3", { relatedRef: "n9" })],
      ["a fact name that was not sent", good("u3", { factsUsed: ["supplierName"] })],
    ];
    for (const [label, item] of refusedCases) {
      mock.on(() => answer([item]));
      const before = await AiDraft.countDocuments({ firmId: A.firmId });
      const result = await run(A, [unit("u3", { dateGapDays: refusedCases.findIndex((c) => c[0] === label) + 10 })]);
      const after = await AiDraft.countDocuments({ firmId: A.firmId });
      check(`IN5: an answer with ${label} is refused and nothing is stored`, result.value?.results?.length === 0 && result.value.failed.length === 1 && after === before, JSON.stringify(result.value || result.error?.message));
    }
    mock.on(() => answer([good("someone-else")]));
    const strayId = await run(A, [unit("u4", { dateGapDays: 40 })]);
    check("IN5: an answer for an item that was not asked is ignored and the asked one reported unanswered", strayId.value?.results?.length === 0 && strayId.value.failed[0]?.unitId === "u4");
    mock.on(() => "not json at all");
    const garbage = await run(A, [unit("u5", { dateGapDays: 41 })]);
    check("IN5: an unreadable answer stores nothing and reports the item", garbage.value?.results?.length === 0 && garbage.value.failed.length === 1);
    mock.on(() => answer([{ ...good("u6"), amount: 999999, status: "MATCHED", disposition: "ACCEPT_MATCH" }]));
    const adversarial = await run(A, [unit("u6", { dateGapDays: 42 })]);
    const keys = Object.keys(adversarial.value?.results?.[0]?.draft?.output || {}).sort().join(",");
    check("IN5: fields the model adds (an amount, a status) are not kept", keys === "cause,factsUsed,reason,relatedRef,suggestedDisposition", keys);
    mock.on(() => answer([{ id: "u7", cause: "CANNOT_TELL", suggestedDisposition: "BOOKS_CORRECTION", reason: "", factsUsed: [] }]));
    const abstain = await run(A, [unit("u7", { dateGapDays: 43 })]);
    check("IN5: CANNOT_TELL is a valid answer, stored as abstained, with no disposition suggested", abstain.value?.results?.[0]?.draft?.abstained === true && abstain.value.results[0].draft.output.suggestedDisposition === "NONE" && abstain.value.results[0].draft.replayed === false, JSON.stringify(abstain.value?.results?.[0]?.draft));
    mock.fail(500);
    const down = await run(A, [unit("u8", { dateGapDays: 44 })]);
    check("IN5: with DeepSeek failing the result says unavailable and stores nothing", down.value?.available === false && down.value.results.length === 0 && /unavailable/i.test(down.value.note));
    mock.reset();
    mock.on(() => answer([good("u9")]));
    const many = await run(A, Array.from({ length: 61 }, (_, i) => unit(`m${i}`)));
    check("IN5: more units than the task allows is refused before any call", many.error?.code === "AI_TOO_MANY_ITEMS" && mock.calls.length === 0);

    // ─── IN5: outcomes ───
    const draftId = String(stored._id);
    const otherRead = await call("GET", `/api/ai-drafts/${draftId}`, B.token);
    check("IN5: another firm cannot read a draft (404)", otherRead.status === 404, `status ${otherRead.status}`);
    const otherMark = await call("PATCH", `/api/ai-drafts/${draftId}/outcome`, B.token, { outcome: "DISCARDED" });
    check("IN5: another firm cannot mark a draft (404)", otherMark.status === 404, `status ${otherMark.status}`);
    const badOutcome = await call("PATCH", `/api/ai-drafts/${draftId}/outcome`, A.token, { outcome: "PENDING" });
    check("IN5: PENDING is not an outcome a person records", badOutcome.status === 400);
    const adopted = await call("PATCH", `/api/ai-drafts/${draftId}/outcome`, A.token, { outcome: "ADOPTED_UNCHANGED" });
    const adoptedRow = await AiDraft.findById(draftId).lean();
    check("IN5: adopting a draft records it and stops its expiry", adopted.status === 200 && adoptedRow.outcome === "ADOPTED_UNCHANGED" && adoptedRow.expiresAt === null && String(adoptedRow.outcomeBy) === String(A.ownerId), JSON.stringify(adopted.json));
    const retried = await call("PATCH", `/api/ai-drafts/${draftId}/outcome`, A.token, { outcome: "ADOPTED_UNCHANGED" });
    const changed = await call("PATCH", `/api/ai-drafts/${draftId}/outcome`, A.token, { outcome: "DISCARDED" });
    check("IN5: the same outcome again is accepted, a different one refused 409", retried.status === 200 && changed.status === 409 && changed.json?.code === "AI_DRAFT_ALREADY_DECIDED", `${retried.status}/${changed.status}`);
    const counted = await raw("aisuggestionoutcomes").findOne({ firmId: A.firmId, surface: "gst_cause", source: "MODEL", key: "gst_cause_residue", day: today });
    check("IN5: the outcome is counted once for the feature", counted?.adoptedUnchanged === 1 && !counted.discarded, JSON.stringify(counted));
    const rule = await call("POST", "/api/ai-drafts/rule-outcomes", A.token, { surface: "gst_cause", ruleId: "R4", outcome: "EDITED" });
    const ruleBad = await call("POST", "/api/ai-drafts/rule-outcomes", A.token, { surface: "somewhere", ruleId: "R4", outcome: "EDITED" });
    const ruleCount = await raw("aisuggestionoutcomes").findOne({ firmId: A.firmId, surface: "gst_cause", source: "RULE", key: "R4", day: today });
    check("IN5: a rule suggestion's outcome is counted, an unknown surface refused", rule.status === 201 && ruleBad.status === 400 && ruleCount?.edited === 1, `${rule.status}/${ruleBad.status}`);

    // ─── IN2: the admin report ───
    const report = await call("GET", "/api/super/provider-usage", superToken);
    const t = report.json?.usage?.deepSeekTokens;
    check("IN2: the admin report returns tokens and an estimate by feature, with its price basis", report.status === 200 && t?.thisMonth?.byOperation?.gst_cause_residue?.promptTokens === 1200 && t.thisMonth.total.estimatedUsd > 0 && t.priceBasis?.model === "deepseek-flash" && report.json.usage.deepSeekByOperation.thisMonth.gst_cause_residue >= 2, JSON.stringify(t?.thisMonth?.total));
    const expected = models.estimateDeepSeekCostUsd({ promptTokens: 1200, cacheHitTokens: 1000, cacheMissTokens: 200, completionTokens: 150 });
    check("IN2: the estimate is hit x 0.006 + miss x 0.30 + out x 1.20 per million", Math.abs(expected - (1000 * 0.006 + 200 * 0.3 + 150 * 1.2) / 1e6) < 1e-9, String(expected));

    // ─── the flag, again ───
    await setFlag(false);
    const offRead = await call("GET", `/api/ai-drafts/${draftId}`, A.token);
    check("IN5: with the flag off a draft route answers 404 naming the flag", offRead.status === 404 && offRead.json?.featureFlag === "intelligence");
  } finally {
    mock.off();
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase().catch(() => {});
    await mongoose.disconnect();
  }

  const failed = checks.filter((c) => !c.pass);
  for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.pass || !c.detail ? "" : ` -- ${c.detail}`}`);
  console.log(`\nai-task-contract: ${checks.length - failed.length}/${checks.length} passed`);
  return failed.length ? 1 : 0;
}
